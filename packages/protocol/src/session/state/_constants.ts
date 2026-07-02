export const SESSION_STATE_FIELD_IDS = [
  'identity.runtimeDescriptor',
  'identity.providerSessionId',
  'intent.model',
  'intent.permissionMode',
  'intent.acpSessionMode',
  'intent.acpConfigOption',
  'display.title',
  'runtime.workState',
  'runtime.usageLimitRecovery',
  'view.readState',
  'view.attention',
] as const;

export const SESSION_STATE_FIELD_CLASSES = [
  'identity',
  'intent',
  'display',
  'runtime',
  'view',
] as const;
