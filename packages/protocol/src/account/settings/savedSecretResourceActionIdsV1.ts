export const SHARED_SAVED_SECRET_ACTION_IDS_V1 = [
  'secrets.shared.list',
  'secrets.shared.create',
  'secrets.shared.promote',
  'secrets.shared.grants.set',
  'secrets.shared.update',
  'secrets.shared.delete',
] as const;

export type SharedSavedSecretActionIdV1 = typeof SHARED_SAVED_SECRET_ACTION_IDS_V1[number];
