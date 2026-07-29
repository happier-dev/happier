import type { VoiceRealtimeJsonValue } from '@happier-dev/protocol';

export type VoicePlaybackInterruptionMode = 'retained' | 'ducked' | 'unsupported';
export type VoicePlaybackInterruptionResolution = 'false_alarm' | 'confirmed';

export type VoiceRealtimeConnectionKind = 'websocket_pcm' | 'webrtc' | 'sdk_handle';
export type VoiceRealtimeConnectionState = 'idle' | 'connecting' | 'open' | 'closed';

export type VoiceConnectionCloseReason = Readonly<{
  code: 'user_stop' | 'aborted' | 'remote_close' | 'replaced' | 'error';
  detail?: string;
}>;

export type VoiceRealtimeTransportEvent =
  | Readonly<{ type: 'session_identity'; sessionId: string }>
  | Readonly<{
      type: 'webrtc_remote_track';
      track: unknown;
      streams: readonly unknown[];
      replacesTrackId?: string;
    }>
  | Readonly<{
      type: 'webrtc_ice_state';
      state: 'new' | 'checking' | 'connected' | 'completed' | 'disconnected' | 'failed' | 'closed';
    }>
  | Readonly<{
      type: 'webrtc_data_channel_state';
      state: 'connecting' | 'open' | 'closing' | 'closed';
    }>;

export type VoiceRealtimeConnection = Readonly<{
  readonly kind: VoiceRealtimeConnectionKind;
  connect(signal: AbortSignal): Promise<void>;
  sendControl(event: VoiceRealtimeJsonValue): Promise<void>;
  controlEvents(signal: AbortSignal): AsyncIterable<VoiceRealtimeJsonValue>;
  transportEvents(signal: AbortSignal): AsyncIterable<VoiceRealtimeTransportEvent>;
  close(reason: VoiceConnectionCloseReason): Promise<void>;
  state(): VoiceRealtimeConnectionState;
  currentProviderSessionId(): string | null;
  playbackCursorMs(): number | null;
  beginOutputInterruptionCandidate(): VoicePlaybackInterruptionMode;
  resolveOutputInterruptionCandidate(resolution: VoicePlaybackInterruptionResolution): void;
}>;

export type VoiceConnectionDriver = Readonly<{
  open(input: Readonly<{
    signal: AbortSignal;
    onControl(event: unknown): void;
    onTransport(event: VoiceRealtimeTransportEvent): void;
    onRemoteClose(reason: string): void;
  }>): Promise<void>;
  sendControl(event: VoiceRealtimeJsonValue): Promise<void>;
  beginOutputInterruptionCandidate?(): VoicePlaybackInterruptionMode;
  resolveOutputInterruptionCandidate?(resolution: VoicePlaybackInterruptionResolution): void;
  close(reason: VoiceConnectionCloseReason): Promise<void>;
}>;

export type VoiceNegotiatedWebRtcInput = Readonly<{
  signaling: Readonly<{
    exchangeOffer(input: Readonly<{
      offerSdp: string;
      signal: AbortSignal;
    }>): Promise<Readonly<{
      answerSdp: string;
    }>>;
  }>;
  control: Readonly<{
    label: string;
    onOpen(input: Readonly<{
      sendJson(value: VoiceRealtimeJsonValue): Promise<void>;
    }>): void | Promise<void>;
  }>;
}>;

export type VoiceHostNegotiatedWebRtcInput = VoiceNegotiatedWebRtcInput & Readonly<{
  micStream: MediaStream;
  duckGain: number;
  onClosed?(reason: VoiceConnectionCloseReason): void | Promise<void>;
}>;

export type VoicePcmConnectionMedia = Readonly<{
  start(signal: AbortSignal): Promise<void>;
  stop(): Promise<void>;
  playbackCursorMs?(): number;
  beginOutputInterruptionCandidate?(): VoicePlaybackInterruptionMode;
  resolveOutputInterruptionCandidate?(resolution: VoicePlaybackInterruptionResolution): void;
}>;
