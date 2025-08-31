<script setup>
import { ref, onMounted } from 'vue';
import { SkyWayContext, SkyWayRoom, SkyWayStreamFactory, uuidV4 } from '@skyway-sdk/room';
import GetToken from './SkywayToken.js';

// 環境変数 (vite)
const appId = import.meta.env.VITE_SKYWAY_APP_ID;
const secret = import.meta.env.VITE_SKYWAY_SECRET_KEY;

const tokenString = GetToken(appId, secret);// トークン生成 (GetToken の実装が同期か非同期かで await 必要か確認)
const context = { ctx: null, room: null };// SkyWay context & room
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
const Leaving = ref(false);// 退出中フラグ（追加：leave 完了前の再 join を防止）
// ミュート状態管理（新規追加）
const IsAudioMuted = ref(false);
const IsVideoMuted = ref(false);
const baseUrl = window.location.href.split('?')[0];
// Publication を保持（publish の戻り値として得られるオブジェクト）
const LocalVideoPublication = ref(null);
const LocalAudioPublication = ref(null);

// ヘルパ: SkyWay stream オブジェクトから MediaStreamTrack を取り出す
const extractTrack = (stream, kind = 'video') => {
  if (!stream) return null;
  // SDK が .track を提供している場合
  if (stream.track && stream.track.kind === kind) return stream.track;
  // SDK が .mediaStream を持つ場合
  if (stream.mediaStream) {
    const tracks = kind === 'audio'
      ? stream.mediaStream.getAudioTracks()
      : stream.mediaStream.getVideoTracks();
    if (tracks && tracks.length) return tracks[0];
  }
  // もし渡されるのが生の MediaStream の場合
  if (typeof stream.getTracks === 'function') {
    const tracks = kind === 'audio' ? stream.getAudioTracks() : stream.getVideoTracks();
    if (tracks && tracks.length) return tracks[0];
  }
  return null;
};

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
// track の onmute/onunmute で動画の見た目（暗転）を制御
const attachRemoteStream = (stream) => {
  try {
    if (!StreamArea.value) return;

    const hasVideo = !!(stream?.track?.kind === 'video' || (stream.mediaStream && stream.mediaStream.getVideoTracks?.().length));
    const hasAudio = !!(stream?.track?.kind === 'audio' || (stream.mediaStream && stream.mediaStream.getAudioTracks?.().length));

    if (hasVideo) {
      const el = document.createElement('video');
      el.autoplay = true;
      el.playsInline = true;
      el.className = 'w-64 h-48 object-cover rounded border';
      StreamArea.value.appendChild(el);
      stream.attach(el);
      el.play?.().catch(() => {});

      const track = extractTrack(stream, 'video');
      if (track) {
        // 初期表示（無効なら暗く）
        if (track.enabled === false) {
          el.style.filter = 'brightness(30%)';
        }
        // mute/unmute イベントで見た目を制御
        track.onmute = () => {
          el.style.filter = 'brightness(30%)';
        };
        track.onunmute = () => {
          el.style.filter = 'none';
        };
      }

      RemoteVideos.value.push(el);
    } else if (hasAudio) {
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


// Publication.disable/enable を使ってミュートする関数（優先）
const togglePublicationMute = async (pubRef, isMutedRef) => {
  const pub = pubRef.value;
  if (!pub) return false;
  try {
    const willMute = !isMutedRef.value;
    if (willMute) {
      // mute
      if (typeof pub.disable === 'function') {
        await pub.disable();
        isMutedRef.value = true;
        return true;
      }
    } else {
      // unmute
      if (typeof pub.enable === 'function') {
        await pub.enable();
        isMutedRef.value = false;
        return true;
      }
    }
  } catch (e) {
    console.error('togglePublicationMute error:', e);
    return false;
  }
  return false;
};

// 代替: MediaStreamTrack.enabled を切り替えるフォールバック
const setStreamMutedFallback = (skywayStream, kind, muted) => {
  const track = extractTrack(skywayStream, kind);
  if (!track) {
    console.warn('No track found for fallback mute:', kind, skywayStream);
    return false;
  }
  try {
    track.enabled = !muted;
    return true;
  } catch (e) {
    console.error('setStreamMutedFallback error:', e);
    return false;
  }
};

// 音声ミュート切り替え
const toggleAudioMute = async () => {
  // まず Publication API を試す
  let ok = await togglePublicationMute(LocalAudioPublication, IsAudioMuted);
  if (!ok) {
    // フォールバック: track.enabled を切り替える
    const newMuted = !IsAudioMuted.value;
    const fOk = setStreamMutedFallback(LocalAudioStream.value, 'audio', newMuted);
    if (fOk) IsAudioMuted.value = newMuted;
    ok = fOk;
  }
  if (!ok) console.warn('Audio mute/unmute failed (no publication & no track)');
};

// 映像ミュート切り替え（修正版）
const toggleVideoMute = async () => {
  // まず Publication API を試す（togglePublicationMute は isMutedRef を更新する）
  let ok = await togglePublicationMute(LocalVideoPublication, IsVideoMuted);

  // Publication API が使えずフォールバックした場合はここでフラグを反転して更新する
  if (!ok) {
    const newMuted = !IsVideoMuted.value;
    const fOk = setStreamMutedFallback(LocalVideoStream.value, 'video', newMuted);
    if (fOk) {
      IsVideoMuted.value = newMuted;
      ok = true;
    }
  }

  // 最終的なフラグ IsVideoMuted.value を参照してローカルの見た目を更新（反転や ! を使わない）
  if (LocalVideoEl.value) {
    LocalVideoEl.value.style.filter = IsVideoMuted.value ? 'brightness(30%)' : 'none';
  }

  if (!ok) console.warn('Video mute/unmute failed (no publication & no track)');
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

// publish と Publication を保持（戻り値を受け取る）
const videoPub = await member.publish(videoStream);
const audioPub = await member.publish(audioStream);
LocalVideoPublication.value = videoPub;
LocalAudioPublication.value = audioPub;

// デバッグ出力（Join 後に Console で確認しやすくする）
console.log('LocalVideoPublication:', LocalVideoPublication.value);
console.log('LocalAudioPublication:', LocalAudioPublication.value);
// 開発時だけ window に展開して手動確認できるようにする（終了時に削除してOK）
try {
  window.__localVideoPublication = LocalVideoPublication.value;
  window.__localAudioPublication = LocalAudioPublication.value;
} catch (e) {}

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
      if (pub.publisher.id === member.id) continue;
      try {
        const { stream } = await member.subscribe(pub.id);
        attachRemoteStream(stream);
      } catch (err) {
        console.warn('subscribe existing pub failed:', err);
      }
    }

    // 以後新規公開にもsubscribe（重要）
    context.room.onStreamPublished.add(async (e) => {
      if (e.publication.publisher.id === member.id) return;
      try {
        const { stream } = await member.subscribe(e.publication.id);
        attachRemoteStream(stream);
      } catch (err) {
        console.warn('subscribe new pub failed:', err);
      }
    });

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

    // ミュート状態初期化（新規追加）
    IsAudioMuted.value = false;
    IsVideoMuted.value = false;

    // 重要: 同じ Room インスタンスでの再 join を避けるため破棄（追加）
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
    <h1 class="text-2xl font-bold">会議</h1>

    <div class="flex gap-4 flex-wrap">
      <!-- ボタンエリア -->
      <div class="space-x-2">
        <button
          v-if="!RoomCreated"
          @click="createRoom"
          class="inline-flex items-center px-4 py-2 rounded bg-blue-600 text-white font-medium hover:bg-blue-700 active:bg-blue-800 focus:outline-none focus:ring-2 focus:ring-blue-400"
        >
          ルーム作成
        </button>

        <button
          v-if="RoomId && !Joined"
          :disabled="Joining || Leaving"  
          @click="joinRoom"
          class="inline-flex items-center px-4 py-2 rounded bg-green-600 text-white font-medium hover:bg-green-700 active:bg-green-800 focus:outline-none focus:ring-2 focus:ring-green-400 disabled:opacity-50"
        >
          {{ Joining ? 'Joining...' : 'ルーム参加' }}
        </button>

         <button
          v-if="Joined"
          :disabled="Leaving"            
          @click="leaveRoom"
          class="inline-flex items-center px-4 py-2 rounded bg-gray-600 text-white font-medium hover:bg-gray-700 active:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-gray-400 disabled:opacity-50"
        >
          {{ Leaving ? 'Leaving...' : 'ルーム退出' }}
        </button>
      </div>

      <div v-if="ErrorMessage" class="text-sm text-red-600 font-medium">
        {{ ErrorMessage }}
      </div>
    </div>

     <!-- ミュートボタン（新規追加） -->
      <div v-if="Joined" class="space-x-2">
        <!-- 音声ミュートボタン -->
        <button
          @click="toggleAudioMute"
          :class="[
            'inline-flex items-center px-4 py-2 rounded font-medium focus:outline-none focus:ring-2',
            IsAudioMuted 
              ? 'bg-red-600 text-white hover:bg-red-700 focus:ring-red-400' 
              : 'bg-blue-600 text-white hover:bg-blue-700 focus:ring-blue-400'
          ]"
        >
          {{ IsAudioMuted ? '🔇 ミュート中' : '🎤 音声ON' }}
        </button>

        <!-- 映像ミュートボタン -->
        <button
          @click="toggleVideoMute"
          :class="[
            'inline-flex items-center px-4 py-2 rounded font-medium focus:outline-none focus:ring-2',
            IsVideoMuted 
              ? 'bg-red-600 text-white hover:bg-red-700 focus:ring-red-400' 
              : 'bg-blue-600 text-white hover:bg-blue-700 focus:ring-blue-400'
          ]"
        >
          {{ IsVideoMuted ? '📹 映像OFF' : '📹 映像ON' }}
        </button>
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