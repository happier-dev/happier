export const SESSION_STATE_FIELD_IDS = [
  'identity.runtimeDescriptor',
  'identity.vendorSessionId',
  'intent.model',
  'intent.permissionMode',
  'intent.acpSessionMode',
  'intent.acpConfigOption',
  'display.title',
  'view.readState',
  'view.attention',
] as const;

export const SESSION_STATE_FIELD_CLASSES = [
  'identity',
  'intent',
  'display',
  'view',
] as const;
