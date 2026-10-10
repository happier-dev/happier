/** Ordinary Artifact Action wire epoch V1. Kept independent of schema initialization. */
export const ARTIFACT_ACTION_IDS_V1 = [
  'artifact.create', 'artifact.get', 'artifact.list', 'artifact.update', 'artifact.delete',
  'artifact.publish_from_file', 'artifact.revisions.list', 'artifact.revisions.restore', 'artifact.storage.usage',
  'artifact.public_link.create', 'artifact.public_link.list', 'artifact.public_link.revoke', 'artifact.public_link.audit',
] as const;
