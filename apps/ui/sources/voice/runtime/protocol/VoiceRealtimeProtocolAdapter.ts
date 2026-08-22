/**
 * Executable provider wire semantics. This is bundled first-party runtime code,
 * never a serializable/public plugin contribution.
 */
import type {
  VoiceRealtimeCanonicalEvent,
  VoiceRealtimePreflight,
  VoiceRealtimePreparation,
  VoiceTurnControlAction,
} from '@happier-dev/plugin-sdk/voice/client';
import type {
  VoiceConversationToolEffectCalls,
  VoiceRealtimeJsonValue,
} from '@happier-dev/protocol';
import type { VoiceConnectionCloseReason } from '@/voice/runtime/connection/VoiceRealtimeConnection';
import type { VoiceTurnControlCapabilities } from './VoiceTurnControlCapabilities';

export type VoiceRealtimePreparedSession = Extract<
  VoiceRealtimePreparation,
  Readonly<{ kind: 'prepared' }>
>['session'];

export type VoiceRealtimeProtocolAdapter = Readonly<{
  id: string;
  turnControls: VoiceTurnControlCapabilities;
  /** Omission stays fail-closed for legacy/internal adapter fixtures. */
  toolEffectCalls?: VoiceConversationToolEffectCalls;
  preflight?(input: Readonly<{
    controlSessionId: string;
    attemptId: number;
    request: VoiceRealtimeJsonValue;
    signal: AbortSignal;
  }>): Promise<VoiceRealtimePreflight>;
  prepare(input: Readonly<{
    controlSessionId: string;
    attemptId: number;
    reason: 'initial' | 'reconnect' | 'auth_refresh';
    request: VoiceRealtimeJsonValue;
    signal: AbortSignal;
  }>): Promise<VoiceRealtimePreparation>;
  decodeControl(event: VoiceRealtimeJsonValue): readonly VoiceRealtimeCanonicalEvent[];
  encodeTurnControl(
    action: VoiceTurnControlAction,
    payload?: VoiceRealtimeJsonValue,
  ): VoiceRealtimeJsonValue | null;
  refreshAuth?(signal: AbortSignal): Promise<boolean>;
  releasePrepared?(input: Readonly<{
    controlSessionId: string;
    attemptId: number;
    reason: VoiceConnectionCloseReason;
  }>): Promise<void> | void;
}>;

export type {
  VoiceRealtimeCanonicalEvent,
  VoiceRealtimePreflight,
  VoiceRealtimePreparation,
};
