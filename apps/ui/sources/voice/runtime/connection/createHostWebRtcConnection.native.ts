import {
  createWebRtcConnection,
  type VoiceWebRtcRemoteOutputAttachment,
  type VoiceWebRtcRemoteStreamOwnership,
} from './VoiceRealtimeConnection';
import type { VoiceOutputFocusState } from '@happier-dev/plugin-sdk/voice/client';
import { getVoiceNativeWebRtcRuntime } from '@/voice/runtime/nativeWebRtcRuntime';

type NativeVolumeTrack = Readonly<{
  _setVolume?: (volume: number) => void;
  stop?: () => void;
}> & {
  enabled?: boolean;
};

type NativeRemoteMediaStream = MediaStream & Readonly<{
  release?: () => void;
}>;

type NativeControllableVolumeTrack = NativeVolumeTrack & Readonly<{
  _setVolume(volume: number): void;
}>;

export function attachNativeRemoteStream(
  stream: MediaStream | null,
  duckGain: number,
  ownership: VoiceWebRtcRemoteStreamOwnership,
): VoiceWebRtcRemoteOutputAttachment {
  const streamAudioTracks = (stream?.getAudioTracks() ?? []) as unknown as NativeVolumeTrack[];
  const audioTracks = streamAudioTracks
    .filter((track): track is NativeControllableVolumeTrack => (
      typeof track._setVolume === 'function'
    ));
  let candidateActive = false;
  let focusState: VoiceOutputFocusState = 'active';
  let disposed = false;

  const setVolume = (volume: number): void => {
    for (const track of audioTracks) track._setVolume(volume);
  };
  const applyVolume = (): void => {
    setVolume(
      focusState === 'suspended'
        ? 0
        : focusState === 'ducked' || candidateActive
          ? Math.max(0, Math.min(1, duckGain))
          : 1,
    );
  };

  return Object.freeze({
    dispose() {
      if (disposed) return;
      disposed = true;
      candidateActive = false;
      setVolume(0);
      for (const track of streamAudioTracks) {
        try {
          track.enabled = false;
        } catch {
          // A retired native receiver that cannot be disabled is still muted
          // through its native volume hook when that hook is available.
        }
      }
      if (ownership === 'host_fallback') {
        (stream as NativeRemoteMediaStream | null)?.release?.();
      }
    },
    beginOutputInterruptionCandidate() {
      if (audioTracks.length === 0) return 'unsupported' as const;
      candidateActive = true;
      applyVolume();
      return 'ducked' as const;
    },
    resolveOutputInterruptionCandidate() {
      if (!candidateActive) return;
      candidateActive = false;
      applyVolume();
    },
    setOutputFocusState(next: VoiceOutputFocusState) {
      focusState = next;
      // A track without a controllable volume may still be audible. Active is
      // harmless; a non-active focus fact must fail closed through the host
      // lifecycle bridge rather than pretending it was applied.
      if (next !== 'active' && audioTracks.length !== streamAudioTracks.length) {
        return 'unsupported' as const;
      }
      applyVolume();
      return 'applied' as const;
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
    attachRemoteStream: (stream, ownership) => (
      attachNativeRemoteStream(stream, input.duckGain, ownership)
    ),
  })
);
