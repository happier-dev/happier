import type { PendingDeliveryBlockedReason } from '@happier-dev/protocol';

export type VoiceAdapterId = string;
export type VoiceAdapterEngineKind = 'local' | 'realtime';
export type VoiceSessionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';
export type VoiceSessionMode = 'idle' | 'listening' | 'transcribing' | 'thinking' | 'speaking';
export type VoiceSessionPresentationState = 'reconnecting' | 'interrupted';
export type VoiceAdapterTranscriptMode = 'native_session' | 'synthetic';
export type VoiceInterruptionPolicy = 'disabled' | 'client_two_stage' | 'provider_immediate';
export type VoiceConversationTargeting = 'route_target' | 'bound_conversation';

export type VoiceAdapterSurfaceCapabilities = Readonly<{
  allowsGlobalStart: boolean;
  controlSessionScope: 'surface' | 'global';
  requiresVoiceAgentFeature: boolean;
  bargeInEnabled: boolean;
  /** Omission is treated as unsupported by the host projection. */
  cancelResponse?: 'unsupported' | 'immediate';
  interruptionPolicy?: VoiceInterruptionPolicy;
  /** Qualified Agent runtime required by runtime-install recovery, when applicable. */
  agentRuntime?: Readonly<{ pluginId: string; localId: string }>;
}>;

export type VoiceAdapterContextChannel = Readonly<{
  sendContextualUpdate(update: string): void;
  sendTextMessage(text: string): void;
  announceAssistantText?(text: string): void;
}>;

export type VoiceAdapterRuntimeActionResult =
  | Readonly<{ status: 'completed' }>
  | Readonly<{ status: 'unsupported' }>
  | Readonly<{ status: 'failed'; code: string }>;

export type VoiceAdapterConversationBinding = Readonly<{
  conversationSessionId: string;
  transcriptMode: VoiceAdapterTranscriptMode;
  targetSessionId: string | null;
}>;

export type VoiceSessionSnapshot = Readonly<{
  adapterId: VoiceAdapterId | null;
  sessionId: string | null;
  status: VoiceSessionStatus;
  mode: VoiceSessionMode;
  canStop: boolean;
  micMuted?: boolean;
  errorCode?: string;
  errorMessage?: string;
  errorRecoveryAction?: import('@/voice/runtime/machine/voiceConversationRuntimeTypes').VoiceMachineRecoveryAction;
  errorPresentation?: import('@/voice/runtime/machine/voiceConversationRuntimeTypes').VoiceMachineErrorPresentation;
  presentationState?: VoiceSessionPresentationState;
}>;

export type VoiceAdapterController = Readonly<{
  id: VoiceAdapterId;
  engineKind: VoiceAdapterEngineKind;
  /** Exact provider contribution persisted on synthetic realtime turns. */
  transcriptSource?: Readonly<{ pluginId: string; contributionId: string }>;
  /**
   * Normalized execution-owned navigation semantics. Agent-session attachments
   * open their exact bound conversation; route-target providers may re-resolve
   * when the visible target changes. Omission preserves legacy route targeting.
   */
  conversationTargeting?: VoiceConversationTargeting;
  start(input: Readonly<{ sessionId: string; initialContext?: string; textOnly?: boolean }>): Promise<void>;
  stop(input: Readonly<{ sessionId: string }>): Promise<void>;
  toggle(input: Readonly<{ sessionId: string }>): Promise<void>;
  interrupt(input: Readonly<{ sessionId: string }>): Promise<void>;
  bargeIn?(input: Readonly<{ sessionId: string }>): Promise<void>;
  setMuted(input: Readonly<{ sessionId: string; muted: boolean }>): Promise<void>;
  sendContextUpdate(input: Readonly<{ sessionId: string; update: string }>): void;
  sendContextText?(input: Readonly<{ sessionId: string; text: string }>): void;
  sendTextTurn?(input: Readonly<{
    controlSessionId: string;
    conversationSessionId: string;
    text: string;
    localId: string;
    deliveryCommand: 'interrupt_and_send';
    onAccepted(): Promise<void>;
  }>): Promise<void>;
  getSnapshot(): VoiceSessionSnapshot;
  subscribe?(listener: () => void): () => void;
  resolveConversationBinding?(input: Readonly<{
    controlSessionId: string;
    requestedTargetSessionId: string | null;
    settings: unknown;
  }>): Promise<VoiceAdapterConversationBinding | null>;
  resolveBindingTranscriptMode?(settings: unknown): VoiceAdapterTranscriptMode | null;
  resolveSurfaceCapabilities?(voiceSettings: unknown): VoiceAdapterSurfaceCapabilities | null;
  resolveContextChannel?(voiceSettings: unknown): VoiceAdapterContextChannel | null;
  performRuntimeAction?(actionId: string): Promise<VoiceAdapterRuntimeActionResult>;
}>;

export type BundledVoiceRuntimeContribution = Readonly<{
  adapter: VoiceAdapterController;
  dispose(): Promise<void>;
}>;

/**
 * A provider may name a turn rejection only while it can still prove that no
 * provider text event was sent. The durable pending owner consumes this marker
 * to settle that exact row terminally; all unmarked errors remain uncertain.
 */
export const VOICE_TEXT_TURN_REJECTED_BEFORE_EFFECT = 'VOICE_TEXT_TURN_REJECTED_BEFORE_EFFECT' as const;

export type VoiceTextTurnRejectedBeforeEffectReason = Extract<
  PendingDeliveryBlockedReason,
  | 'provider_unavailable_before_acceptance'
  | 'runtime_disposed_before_delivery'
  | 'provider_rejected_before_acceptance'
  | 'unsupported_action'
>;

export type VoiceTextTurnRejectedBeforeEffectError = Error & Readonly<{
  code: typeof VOICE_TEXT_TURN_REJECTED_BEFORE_EFFECT;
  pendingDeliveryBlockedReason: VoiceTextTurnRejectedBeforeEffectReason;
}>;

export function createVoiceTextTurnRejectedBeforeEffectError(
  error: unknown,
  pendingDeliveryBlockedReason: VoiceTextTurnRejectedBeforeEffectReason,
): VoiceTextTurnRejectedBeforeEffectError {
  const rejection = error instanceof Error
    ? error
    : new Error(typeof error === 'string' && error.trim() ? error : 'voice_text_turn_rejected_before_effect');
  return Object.assign(rejection, {
    code: VOICE_TEXT_TURN_REJECTED_BEFORE_EFFECT,
    pendingDeliveryBlockedReason,
  });
}

export function isVoiceTextTurnRejectedBeforeEffectError(
  error: unknown,
): error is VoiceTextTurnRejectedBeforeEffectError {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as Readonly<{
    code?: unknown;
    pendingDeliveryBlockedReason?: unknown;
  }>;
  return candidate.code === VOICE_TEXT_TURN_REJECTED_BEFORE_EFFECT
    && (
      candidate.pendingDeliveryBlockedReason === 'provider_unavailable_before_acceptance'
      || candidate.pendingDeliveryBlockedReason === 'runtime_disposed_before_delivery'
      || candidate.pendingDeliveryBlockedReason === 'provider_rejected_before_acceptance'
      || candidate.pendingDeliveryBlockedReason === 'unsupported_action'
    );
}
