import type { VoiceRealtimeJsonValue } from '@happier-dev/protocol';
import type { VoiceMachineError } from '@happier-dev/bundled-voice-runtime-contract';

export type ElevenLabsSessionState = Readonly<{
  billingMode: 'happier' | 'byo';
  expiresAtMs: number | null;
  leaseId: string | null;
}>;

export type ElevenLabsPreparedSession = Readonly<{
  sessionConfig: VoiceRealtimeJsonValue;
  sessionState: ElevenLabsSessionState;
}>;

export type ElevenLabsSessionPreparation =
  | Readonly<{ kind: 'prepared'; session: ElevenLabsPreparedSession }>
  | Readonly<{ kind: 'declined'; error: VoiceMachineError }>
  | Readonly<{ kind: 'aborted' }>;
