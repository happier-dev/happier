import { readSessionRoleIdV1, readSessionRolesV1, writeSessionRoleIdV1ToMetadata, writeSessionRoleConfigurationV1ToMetadata } from '@happier-dev/protocol/prompts/roles/sessionRolesSnapshot';
import type { SessionStateBinding } from './_types.js';

/** Host-owned role intent; providers never publish the selected role. */
export const sessionRoleBinding: SessionStateBinding<'intent.role'> = {
  read: (metadata) => ({ value: readSessionRoleIdV1(metadata), updatedAt: null }),
  write: (metadata, update) => writeSessionRoleIdV1ToMetadata(metadata, update.value),
};

export const sessionRoleConfigurationBinding: SessionStateBinding<'intent.sessionRoles'> = {
  read: (metadata) => {
    const snapshot = readSessionRolesV1(metadata);
    if (!snapshot) return { value: null, updatedAt: null };
    const { roleId: _roleId, ...configuration } = snapshot;
    return { value: configuration, updatedAt: null };
  },
  write: (metadata, update) => writeSessionRoleConfigurationV1ToMetadata(metadata, update.value),
};
