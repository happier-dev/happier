/**
 * Executable provider wire semantics. This is bundled first-party runtime code,
 * never a serializable/public plugin contribution.
 */
import type {
  VoiceRealtimeCanonicalEvent,
  VoiceRealtimePreflight,
  VoiceRealtimePreparation as ProviderVoiceRealtimePreparation,
  VoiceTurnControlAction,
} from '@happier-dev/plugin-sdk/voice/client';
import type {
  VoiceRealtimeJsonValue,
} from '@happier-dev/protocol/voice/realtime/events';
import type { VoiceConnectionCloseReason } from '@/voice/runtime/connection/VoiceRealtimeConnection';
import type { VoiceTurnControlCapabilities } from './VoiceTurnControlCapabilities';
import type { VoiceConversationInUseVoice } from '@happier-dev/protocol/actions/voiceConversationActionFamily';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';

/** Host application facts stay local, separate from provider wire/session configuration. */
export type VoiceRealtimePreparation = ProviderVoiceRealtimePreparation extends infer T
  ? T extends Readonly<{ kind: 'prepared' }>
    ? T & Readonly<{ inUseVoice?: VoiceConversationInUseVoice; preparedInstructionsFor?: SessionAddress }>
    : T
  : never;

export type VoiceRealtimePreparedSession = Extract<
  VoiceRealtimePreparation,
  Readonly<{ kind: 'prepared' }>
>['session'];

export type VoiceRealtimeProtocolAdapter = Readonly<{
  id: string;
  turnControls: VoiceTurnControlCapabilities;
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
  encodePostInputCommitControls?(): readonly VoiceRealtimeJsonValue[];
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
};
