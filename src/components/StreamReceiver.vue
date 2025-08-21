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
      type: 'p2p',
      name: RoomId.value
    });
    RoomCreated.value = true;
  } catch (e) {
    ErrorMessage.value = 'Room 作成失敗: ' + e;
    console.error(e);
  }
};

// ルーム参加
const joinRoom = async () => {
  if (Joining.value || Joined.value) return;
  if (!RoomId.value) {
    alert('No Room ID');
    return;
  }
  try {
    Joining.value = true;

    // まだルームが作成されていない場合は作る
    if (!RoomCreated.value) {
      await createRoom();
    }

    // join
    const member = await context.room.join({ name: uuidV4() });
    LocalMember.value = member;

    // ローカルカメラ映像 (音声含めたければ別メソッドも可)
    const videoStream = await SkyWayStreamFactory.createCameraVideoStream();

    // 映像を publish
    await member.publish(videoStream);

    // ローカル video 要素
    const localVideoEl = document.createElement('video');
    localVideoEl.muted = true;
    localVideoEl.playsInline = true;
    localVideoEl.autoplay = true;
    localVideoEl.className = 'w-64 h-48 object-cover rounded border';
    StreamArea.value.appendChild(localVideoEl);

    // SkyWay の stream を video に接続
    videoStream.attach(localVideoEl);

    // Remote 受信ハンドラ
    member.onPublicationSubscribed.add(({ stream }) => {
      // リモートストリームが映像か判定
      if (stream.track && stream.track.kind === 'video') {
        const remoteVideo = document.createElement('video');
        remoteVideo.autoplay = true;
        remoteVideo.playsInline = true;
        remoteVideo.className = 'w-64 h-48 object-cover rounded border';
        StreamArea.value.appendChild(remoteVideo);
        stream.attach(remoteVideo);
        RemoteVideos.value.push(remoteVideo);
      }
    });

    Joined.value = true;
  } catch (e) {
    ErrorMessage.value = 'Join 失敗: ' + e;
    console.error(e);
  } finally {
    Joining.value = false;
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
          :disabled="Joining"
          @click="joinRoom"
          class="inline-flex items-center px-4 py-2 rounded bg-green-600 text-white font-medium hover:bg-green-700 active:bg-green-800 focus:outline-none focus:ring-2 focus:ring-green-400 disabled:opacity-50"
        >
          {{ Joining ? 'Joining...' : 'Join Room' }}
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