/** Ordinary Artifact Action wire epoch V1. Kept independent of schema initialization. */
export const ARTIFACT_CREATE_ACTION_ID_V1 = 'artifact.create';
export const ARTIFACT_PUBLIC_LINK_CREATE_ACTION_ID_V1 = 'artifact.public_link.create';
export const ARTIFACT_REVISIONS_TRIM_ACTION_ID_V1 = 'artifact.revisions.trim';
export const STORAGE_INVENTORY_READ_ACTION_ID_V1 = 'storage.inventory.read';

export const ARTIFACT_ACTION_IDS_V1 = [
  ARTIFACT_CREATE_ACTION_ID_V1, 'artifact.get', 'artifact.export', 'artifact.list', 'artifact.update', 'artifact.delete',
  'artifact.publish_from_file', 'artifact.revisions.list', 'artifact.revisions.restore', ARTIFACT_REVISIONS_TRIM_ACTION_ID_V1, STORAGE_INVENTORY_READ_ACTION_ID_V1,
  ARTIFACT_PUBLIC_LINK_CREATE_ACTION_ID_V1, 'artifact.public_link.list', 'artifact.public_link.revoke', 'artifact.public_link.audit', 'artifact.public_link.join',
] as const;
