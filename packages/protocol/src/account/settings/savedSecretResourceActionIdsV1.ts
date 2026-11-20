export const SHARED_SAVED_SECRET_ACTION_IDS_V1 = [
  'secrets.shared.list',
  'secrets.shared.create',
  'secrets.shared.promote',
  'secrets.shared.grants.set',
  'secrets.shared.update',
  'secrets.shared.delete',
  'secrets.shared.reveal',
  'secrets.shared.repair',
  'secrets.shared.disclosures.list',
  'secrets.shared.recipients.list',
] as const;

export type SharedSavedSecretActionIdV1 = typeof SHARED_SAVED_SECRET_ACTION_IDS_V1[number];

/** Value-free reads the answering app performs with the person's own Home request authority. */
export const SHARED_SAVED_SECRET_CLIENT_READ_ACTION_IDS_V1 = ['secrets.shared.disclosures.list', 'secrets.shared.recipients.list'] as const;
export type SharedSavedSecretClientReadActionIdV1 = typeof SHARED_SAVED_SECRET_CLIENT_READ_ACTION_IDS_V1[number];

/** Client-placed: disclosure, envelope custody and the answering app's reads never travel as Home transport rows. */
export type SharedSavedSecretClientActionIdV1 = 'secrets.shared.reveal' | 'secrets.shared.repair' | SharedSavedSecretClientReadActionIdV1;
export type SharedSavedSecretHomeActionIdV1 = Exclude<SharedSavedSecretActionIdV1, SharedSavedSecretClientActionIdV1>;

export function isSharedSavedSecretClientReadActionIdV1(id: string): id is SharedSavedSecretClientReadActionIdV1 {
  return (SHARED_SAVED_SECRET_CLIENT_READ_ACTION_IDS_V1 as readonly string[]).includes(id);
}

export function isSharedSavedSecretHomeActionIdV1(id: SharedSavedSecretActionIdV1): id is SharedSavedSecretHomeActionIdV1 {
  return id !== 'secrets.shared.reveal' && id !== 'secrets.shared.repair' && !isSharedSavedSecretClientReadActionIdV1(id);
}
