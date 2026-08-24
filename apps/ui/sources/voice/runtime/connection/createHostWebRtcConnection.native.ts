import {
  createWebRtcConnection,
  type VoiceWebRtcRemoteOutputAttachment,
} from './VoiceRealtimeConnection';
import { getVoiceNativeWebRtcRuntime } from '@/voice/runtime/nativeWebRtcRuntime';

type NativeVolumeTrack = Readonly<{
  _setVolume?: (volume: number) => void;
}>;

export function attachNativeRemoteStream(
  stream: MediaStream | null,
  duckGain: number,
): VoiceWebRtcRemoteOutputAttachment {
  const audioTracks = ((stream?.getAudioTracks() ?? []) as unknown as NativeVolumeTrack[])
    .filter((track): track is Required<NativeVolumeTrack> => typeof track._setVolume === 'function');
  let candidateActive = false;

  const setVolume = (volume: number): void => {
    for (const track of audioTracks) track._setVolume(volume);
  };

  return Object.freeze({
    dispose() {
      if (!candidateActive) return;
      candidateActive = false;
      setVolume(1);
    },
    beginOutputInterruptionCandidate() {
      if (audioTracks.length === 0) return 'unsupported' as const;
      candidateActive = true;
      setVolume(Math.max(0, Math.min(1, duckGain)));
      return 'ducked' as const;
    },
    resolveOutputInterruptionCandidate() {
      if (!candidateActive) return;
      candidateActive = false;
      setVolume(1);
    },
  });
}

export const createHostWebRtcConnection: typeof createWebRtcConnection = (input) => (
  createWebRtcConnection({
    ...input,
    createPeerConnection: () => {
      const { RTCPeerConnection } = getVoiceNativeWebRtcRuntime();
      return new RTCPeerConnection() as RTCPeerConnection;
    },
    createMediaStream: (tracks) => {
      const { MediaStream } = getVoiceNativeWebRtcRuntime();
      return new MediaStream(tracks as unknown[]) as MediaStream;
    },
    attachRemoteStream: (stream) => attachNativeRemoteStream(stream, input.duckGain),
  })
);
