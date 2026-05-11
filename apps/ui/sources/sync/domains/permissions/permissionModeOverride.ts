import type { PermissionMode } from '@/sync/domains/permissions/permissionTypes';
import type { Session } from '../state/storageTypes';
import { resolveAgentIdFromFlavor } from '@/agents/catalog/catalog';
import { readSessionPermissionModeField } from '@/sync/state/selectors';
import { normalizePermissionModeForAgentType } from './permissionModeOptions';
import { parsePermissionIntentAlias } from '@happier-dev/agents';

export type PermissionModeOverrideForSpawn = {
    permissionMode: PermissionMode;
    permissionModeUpdatedAt: number;
};

export function getPermissionModeOverrideForSpawn(session: Session): PermissionModeOverrideForSpawn | null {
    const localPermissionMode = readSessionPermissionModeField(session);
    const localUpdatedAt = localPermissionMode.updatedAt;
    if (localUpdatedAt === null) return null;

    const metadataUpdatedAt = session.metadata?.permissionModeUpdatedAt ?? null;
    const metadataUpdatedAtNumber = typeof metadataUpdatedAt === 'number' ? metadataUpdatedAt : 0;
    if (localUpdatedAt <= metadataUpdatedAtNumber) return null;

    const parsed =
        typeof localPermissionMode.value === 'string' ? parsePermissionIntentAlias(localPermissionMode.value) : null;
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
