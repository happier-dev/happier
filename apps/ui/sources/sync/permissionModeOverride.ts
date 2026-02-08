import type { PermissionMode } from '@/sync/permissionTypes';
import type { Session } from './storageTypes';
import { resolveAgentIdFromFlavor } from '@/agents/catalog';
import { normalizePermissionModeForAgentType } from './permissionModeOptions';
import { parsePermissionIntentAlias } from '@happier-dev/agents';

export type PermissionModeOverrideForSpawn = {
    permissionMode: PermissionMode;
    permissionModeUpdatedAt: number;
};

export function getPermissionModeOverrideForSpawn(session: Session): PermissionModeOverrideForSpawn | null {
    const localUpdatedAt = session.permissionModeUpdatedAt;
    if (typeof localUpdatedAt !== 'number') return null;

    const metadataUpdatedAt = session.metadata?.permissionModeUpdatedAt ?? null;
    const metadataUpdatedAtNumber = typeof metadataUpdatedAt === 'number' ? metadataUpdatedAt : 0;
    if (localUpdatedAt <= metadataUpdatedAtNumber) return null;

    const parsed =
        typeof session.permissionMode === 'string' ? parsePermissionIntentAlias(session.permissionMode) : null;
    const flavor = typeof session.metadata?.flavor === 'string' ? session.metadata.flavor : null;
    const agentId = resolveAgentIdFromFlavor(flavor);
    const normalized = agentId
        ? normalizePermissionModeForAgentType((parsed ?? 'default') as PermissionMode, agentId)
        : ((parsed ?? 'default') as PermissionMode);

    return {
        permissionMode: normalized,
        permissionModeUpdatedAt: localUpdatedAt,
    };
}
