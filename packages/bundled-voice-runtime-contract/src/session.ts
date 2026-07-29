export type VoiceMachineErrorKind =
  | 'mic_permission_denied'
  | 'mic_permission_revoked'
  | 'mic_ended'
  | 'mic_plateau'
  | 'transport_disconnect'
  | 'provider_error'
  | 'provider_auth_invalid'
  | 'provider_setup_required'
  | 'reconnect_exhausted'
  | 'audio_context_suspended'
  | 'stt_timeout'
  | 'tts_failed'
  | 'turn_aborted'
  | 'authentication_required'
  | 'session_unavailable'
  | 'unsupported_runtime'
  | 'update_required'
  | 'feature_unavailable';

export type VoiceMachineErrorPhase = 'preflight' | 'active_session' | 'turn' | 'runtime';
export type VoiceMachineRetryPolicy = 'never' | 'user_action' | 'immediate_once' | 'backoff';
export type VoiceMachineRecoveryAction =
  | 'retry'
  | 'reconnect'
  | 'open_settings'
  | 'open_settings_then_reconnect'
  | 'review_credentials'
  | 'connect_agent'
  | 'install_agent_runtime'
  | 'update_agent_runtime'
  | 'none';
export type VoiceMachineErrorPresentation = 'permission_required' | 'notice' | 'error' | 'interrupted';

export type VoiceMachineError = Readonly<{
  kind: VoiceMachineErrorKind;
  reason: string;
  phase: VoiceMachineErrorPhase;
  retryPolicy: VoiceMachineRetryPolicy;
  recoveryAction: VoiceMachineRecoveryAction;
  presentation: VoiceMachineErrorPresentation;
  recoverable: boolean;
}>;

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
  errorRecoveryAction?: VoiceMachineRecoveryAction;
  errorPresentation?: VoiceMachineErrorPresentation;
  presentationState?: VoiceSessionPresentationState;
}>;

export type VoiceAdapterController = Readonly<{
  id: VoiceAdapterId;
  engineKind: VoiceAdapterEngineKind;
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
  }>): Promise<void>;
  getSnapshot(): VoiceSessionSnapshot;
  subscribe?(listener: () => void): () => void;
  /**
   * Optional provider-owned exact binding. Native Agent realtime providers use
   * this to attach to an already-selected Agent session (or to an exactly
   * scoped hidden session) without the generic hidden-conversation creator
   * inventing a shadow session.
   */
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
