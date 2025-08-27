<script setup>
import { ref, onMounted } from 'vue';
import { SkyWayContext, SkyWayRoom, SkyWayStreamFactory, uuidV4 } from '@skyway-sdk/room';
import GetToken from './SkywayToken.js';

// 環境変数 (vite)
const appId = import.meta.env.VITE_SKYWAY_APP_ID;
const secret = import.meta.env.VITE_SKYWAY_SECRET_KEY;

// トークン生成 (GetToken の実装が同期か非同期かで await 必要か確認)
const tokenString = GetToken(appId, secret);

// SkyWay context & room
const context = { ctx: null, room: null };

// refs / state
const StreamArea = ref(null);
const RoomCreated = ref(false);
const RoomId = ref(null);
const Joining = ref(false);
const Joined = ref(false);
const LocalMember = ref(null);
const ErrorMessage = ref('');
const RemoteVideos = ref([]); // 受信した remote streams 用

// 退出時に解放するために保持（追加）
const LocalVideoStream = ref(null);
const LocalAudioStream = ref(null);
const LocalVideoEl = ref(null);

// 退出中フラグ（追加：leave 完了前の再 join を防止）
const Leaving = ref(false);

// 購読済みpublicationのID集合（重複subscribe防止） // 追加
const subscribedPubIds = new Set();

// 追加されたイベントハンドラの参照（remove用） // 追加
let onStreamPublishedHandler = null;

const baseUrl = window.location.href.split('?')[0];

// SkyWay Context 作成
const getContext = async () => {
  try {
    context.ctx = await SkyWayContext.Create(tokenString);
    // トークン更新リマインダ (必要ならここで新規トークンを fetch して差し替える)
    context.ctx.onTokenUpdateReminder.add(async () => {
      // const newToken = await fetchNewToken();
      context.ctx.updateAuthToken(tokenString);
    });
    return context.ctx;
  } catch (e) {
    ErrorMessage.value = 'Context 作成失敗: ' + e;
    console.error(e);
  }
};

// ルーム作成
const createRoom = async () => {
  try {
    if (!RoomId.value) {
      RoomId.value = uuidV4();
    }
    context.room = await SkyWayRoom.FindOrCreate(context.ctx, {
      type: 'sfu',
      name: RoomId.value
    });
    RoomCreated.value = true;
  } catch (e) {
    ErrorMessage.value = 'Room 作成失敗: ' + e;
    console.error(e);
  }
};
// 受信ストリームをDOMへattach（映像/音声対応）
const attachRemoteStream = (stream) => {
  try {
    if (stream?.track?.kind === 'video') {
      const el = document.createElement('video');
      el.autoplay = true;
      el.playsInline = true;
      el.className = 'w-64 h-48 object-cover rounded border';
      StreamArea.value.appendChild(el);
      stream.attach(el);
      // autoplayポリシー対策
      el.play?.().catch(() => {});
      RemoteVideos.value.push(el);
    } else if (stream?.track?.kind === 'audio') {
      const el = document.createElement('audio');
      el.autoplay = true;
      el.controls = false;
      el.style.display = 'none';
      StreamArea.value.appendChild(el);
      stream.attach(el);
      el.play?.().catch(() => {});
      RemoteVideos.value.push(el);
    }
  } catch (err) {
    console.error('attachRemoteStream failed:', err);
  }
};
// ルーム参加
const joinRoom = async () => {
  if (Joining.value || Joined.value || Leaving.value) return; // Leaving 中は不可（追加）
  if (!RoomId.value) {
    alert('No Room ID');
    return;
  }
  try {
    Joining.value = true;

    // まだルームが作成されていない場合は作る
    if (!RoomCreated.value || !context.room) { // room を破棄するので null チェック追加
      await createRoom();
    }

    // 既存のonStreamPublishedハンドラを外してから再設定（二重add防止） // 追加
    if (onStreamPublishedHandler && context.room?.onStreamPublished) {
      try { context.room.onStreamPublished.remove(onStreamPublishedHandler); } catch {}
      onStreamPublishedHandler = null;
    }

    // join
    const member = await context.room.join({ name: uuidV4() });
    LocalMember.value = member;

    // ローカルカメラ映像 (音声含めたければ別メソッドも可)
    const videoStream = await SkyWayStreamFactory.createCameraVideoStream();
    // ローカルの映像・音声ストリームを作成して publish（重要）
    const audioStream = await SkyWayStreamFactory.createMicrophoneAudioStream();

    // 退出時に解放するため保持（追加）
    LocalVideoStream.value = videoStream;
    LocalAudioStream.value = audioStream;

    // 映像を publish
    await member.publish(videoStream);
    // 音声を publish (必要なら)
    await member.publish(audioStream);

    // ローカル video 要素
    const localVideoEl = document.createElement('video');
    localVideoEl.muted = true;
    localVideoEl.playsInline = true;
    localVideoEl.autoplay = true;
    localVideoEl.className = 'w-64 h-48 object-cover rounded border';
    StreamArea.value.appendChild(localVideoEl);
    // SkyWay の stream を video に接続
    videoStream.attach(localVideoEl);
    // 退出時に解放するため保持（追加）
    LocalVideoEl.value = localVideoEl;

    // 既存の公開中ストリームにsubscribe（重要）
    for (const pub of context.room.publications ?? []) {
      // 自分自身のpublication／自分起点のSFU転送publicationは購読しない // 追加
      if (pub.publisher?.id === member.id) continue;
      if (pub.origin?.publisher?.id === member.id || pub.originPublisher?.id === member.id) continue;
      if (subscribedPubIds.has(pub.id)) continue; // 二重購読防止（追加）
      try {
        const { stream } = await member.subscribe(pub.id);
        subscribedPubIds.add(pub.id); // 追加
        attachRemoteStream(stream);
      } catch (err) {
        console.warn('subscribe existing pub failed:', err);
      }
    }

    // 以後新規公開にもsubscribe（重要）
    onStreamPublishedHandler = async (e) => {
      const pub = e.publication;
      // 自分自身/自分起点の転送publicationは購読しない // 追加
      if (pub.publisher?.id === member.id) return;
      if (pub.origin?.publisher?.id === member.id || pub.originPublisher?.id === member.id) return;
      if (subscribedPubIds.has(pub.id)) return; // 追加
      try {
        const { stream } = await member.subscribe(pub.id);
        subscribedPubIds.add(pub.id); // 追加
        attachRemoteStream(stream);
      } catch (err) {
        console.warn('subscribe new pub failed:', err);
      }
    };
    context.room.onStreamPublished.add(onStreamPublishedHandler);

    // 参考: すでに用意済みのイベントハンドラを拡張したい場合はこれでもOK
    // member.onPublicationSubscribed.add(({ stream }) => {
    //   attachRemoteStream(stream);
    // });

    Joined.value = true;
  } catch (e) {
    ErrorMessage.value = 'Join 失敗: ' + e;
    console.error(e);
  } finally {
    Joining.value = false;
  }
};

// 退出（Leave）
const leaveRoom = async () => {
  if (Leaving.value) return; // 二重押下防止（追加）
  Leaving.value = true;
  try {
    // 購読済みIDをクリア（再入室時のダブり防止） // 追加
    subscribedPubIds.clear();

    // 退出前にonStreamPublishedハンドラを外す // 追加
    if (onStreamPublishedHandler && context.room?.onStreamPublished) {
      try { context.room.onStreamPublished.remove(onStreamPublishedHandler); } catch {}
      onStreamPublishedHandler = null;
    }

    // 自分の配信を明示的に unpublish（残留防止） // 追加
    for (const pub of LocalMember.value?.publications ?? []) {
      try { await LocalMember.value.unpublish(pub.id); } catch {}
    }

    // ルーム離脱（チャンネルに居るときのみ実行：ガード）
    if (LocalMember.value?.leave && LocalMember.value.channel) {
      await LocalMember.value.leave();
    }

    // ローカルメディアの解放
    if (LocalVideoStream.value) {
      try {
        LocalVideoStream.value.detach?.();
        LocalVideoStream.value.track?.stop?.();
      } catch {}
    }
    if (LocalAudioStream.value) {
      try {
        LocalAudioStream.value.detach?.();
        LocalAudioStream.value.track?.stop?.();
      } catch {}
    }

    // ローカル要素の削除
    if (LocalVideoEl.value && LocalVideoEl.value.parentNode) {
      LocalVideoEl.value.pause?.();
      LocalVideoEl.value.srcObject = null;
      LocalVideoEl.value.parentNode.removeChild(LocalVideoEl.value);
    }
    LocalVideoEl.value = null;

    // リモート要素の削除
    for (const el of RemoteVideos.value) {
      try {
        el.pause?.();
        el.srcObject = null;
        el.remove();
      } catch {}
    }
    RemoteVideos.value = [];

    // 状態初期化（RoomIdは残す＝再参加しやすくする）
    Joined.value = false;
    Joining.value = false;
    LocalMember.value = null;
    LocalVideoStream.value = null;
    LocalAudioStream.value = null;

    // 重要: 同じ Room インスタンスでの再 join を避けるため破棄
    RoomCreated.value = false;
    context.room = null;
  } catch (e) {
    console.error('leave failed:', e);
  } finally {
    Leaving.value = false;
  }
};
// onMounted: URL に room=xxx があれば利用
onMounted(async () => {
  await getContext();
  const qRoom = new URLSearchParams(window.location.search).get('room');
  if (qRoom) {
    RoomId.value = qRoom;
  }
});
</script>

<template>
  <div class="p-4 space-y-6">
    <h1 class="text-2xl font-bold">Kaigi</h1>

    <div class="flex gap-4 flex-wrap">
      <!-- ボタンエリア -->
      <div class="space-x-2">
        <button
          v-if="!RoomCreated"
          @click="createRoom"
          class="inline-flex items-center px-4 py-2 rounded bg-blue-600 text-white font-medium hover:bg-blue-700 active:bg-blue-800 focus:outline-none focus:ring-2 focus:ring-blue-400"
        >
          Create Room
        </button>

        <button
          v-if="RoomId && !Joined"
          :disabled="Joining || Leaving"   
          @click="joinRoom"
          class="inline-flex items-center px-4 py-2 rounded bg-green-600 text-white font-medium hover:bg-green-700 active:bg-green-800 focus:outline-none focus:ring-2 focus:ring-green-400 disabled:opacity-50"
        >
          {{ Joining ? 'Joining...' : 'Join Room' }}
        </button>

         <button
          v-if="Joined"
          :disabled="Leaving"            
          @click="leaveRoom"
          class="inline-flex items-center px-4 py-2 rounded bg-gray-600 text-white font-medium hover:bg-gray-700 active:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-gray-400 disabled:opacity-50"
        >
          {{ Leaving ? 'Leaving...' : 'Leave Room' }}
        </button>
      </div>

      <div v-if="ErrorMessage" class="text-sm text-red-600 font-medium">
        {{ ErrorMessage }}
      </div>
    </div>

    <!-- ルーム情報表示 -->
    <div v-if="RoomId" class="space-y-2 text-sm">
      <p>以下のURLを相手と共有:</p>
      <p class="break-all font-mono bg-gray-100 px-2 py-1 rounded">
        {{ baseUrl }}?room={{ RoomId }}
      </p>
      <p>またはルームID:</p>
      <p class="font-mono bg-gray-100 px-2 py-1 inline-block rounded">{{ RoomId }}</p>
    </div>

    <!-- 映像表示エリア -->
    <div
      ref="StreamArea"
      v-if="RoomCreated"
      class="flex gap-4 flex-wrap border rounded p-3 min-h-[200px]"
    ></div>

    <div v-else class="text-gray-500 italic">
      まだルームは作成されていません。
    </div>
  </div>
</template>