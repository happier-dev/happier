/**
 * Host compatibility export for the internal bundled voice runtime contract.
 * The dependency-neutral package is the sole type owner shared by the app and
 * first-party bundled provider packages.
 */
export type {
  VoiceAdapterContextChannel,
  VoiceAdapterController,
  VoiceAdapterEngineKind,
  VoiceAdapterId,
  VoiceAdapterRuntimeActionResult,
  VoiceAdapterSurfaceCapabilities,
  VoiceAdapterTranscriptMode,
  VoiceConversationTargeting,
  VoiceInterruptionPolicy,
  VoiceSessionMode,
  VoiceSessionPresentationState,
  VoiceSessionSnapshot,
  VoiceSessionStatus,
} from '@happier-dev/bundled-voice-runtime-contract';
