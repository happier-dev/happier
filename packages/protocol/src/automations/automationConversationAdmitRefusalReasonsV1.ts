// Shared by the native admission result and Channels terminal attention.
export const AUTOMATION_CONVERSATION_ADMIT_REFUSAL_REASONS_V1 = [
  'repositoryWriteAccessUnknown',
  'repositoryWriteAccessDenied',
  'scopedTriggerIdentityMismatch',
  'watchCompleted',
  'bot_paused',
] as const;
