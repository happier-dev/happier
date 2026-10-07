import type { ArtifactSharingKindAdapterV1, ArtifactSharingResourceV1 } from '../../artifacts/artifactSharingV1.js';
import { RoleArtifactV1Schema } from './roleArtifactV1.js';
import type { RoleActionEntryV1 } from './roleActionsV1.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';

function readRole(resource: ArtifactSharingResourceV1) {
  if (resource.header.kind !== 'role.v1' || typeof resource.body !== 'string') return null;
  try {
    const parsed = createStoredReadSchema(RoleArtifactV1Schema).safeParse(JSON.parse(resource.body));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export const roleArtifactSharingAdapterV1 = {
  kind: 'role.v1',
  canShare: (resource: ArtifactSharingResourceV1) => readRole(resource) !== null,
} as const satisfies ArtifactSharingKindAdapterV1;

/** Input is opened through FIN's authorized grant listing, never a foreign Artifact scan. */
export function listSharedRoleArtifactsV1(resources: readonly ArtifactSharingResourceV1[]): RoleActionEntryV1[] {
  return resources.flatMap((resource) => {
    if (resource.access !== 'view' && resource.access !== 'edit' && resource.access !== 'admin') return [];
    const role = readRole(resource);
    if (!role || !resource.revision) return [];
    return [{ roleId: resource.artifactId, role, revision: resource.revision,
      shared: true, viewOnly: resource.access === 'view', migratedFromV0_2: false }];
  });
}
