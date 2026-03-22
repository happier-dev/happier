export const SESSION_AUTHORING_CONTEXT_KINDS = [
  'newSession',
  'liveSession',
  'automationNewSession',
  'automationExistingSession',
] as const;

export type SessionAuthoringContextKind = (typeof SESSION_AUTHORING_CONTEXT_KINDS)[number];
