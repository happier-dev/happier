import type { PermissionMode } from '@/sync/domains/permissions/permissionTypes';
import type { Session } from '../state/storageTypes';

import { readSessionPermissionModeField } from '@/sync/state/selectors';
import { normalizePermissionModeForAgentType } from './permissionModeOptions';
import {
    parsePermissionIntentAlias,
    resolveAgentIdFromSessionMetadata,
} from '@happier-dev/agents';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';

export type PermissionModeOverrideForSpawn = {
    permissionMode: PermissionMode;
    permissionModeUpdatedAt: number;
};

export function getPermissionModeOverrideForSpawn(session: Session): PermissionModeOverrideForSpawn | null {
    const metadata = readSessionOwnerMetadataView(session);
    const localPermissionMode = readSessionPermissionModeField(session);
    const localUpdatedAt = localPermissionMode.updatedAt;
    if (localUpdatedAt === null) return null;

    const metadataUpdatedAt = metadata?.permissionModeUpdatedAt ?? null;
    const metadataUpdatedAtNumber = typeof metadataUpdatedAt === 'number' ? metadataUpdatedAt : 0;
    if (localUpdatedAt <= metadataUpdatedAtNumber) return null;

    const parsed =
        typeof localPermissionMode.value === 'string' ? parsePermissionIntentAlias(localPermissionMode.value) : null;
    const agentId = resolveAgentIdFromSessionMetadata(metadata);
    const normalized = agentId
        ? normalizePermissionModeForAgentType((parsed ?? 'default') as PermissionMode, agentId)
        : ((parsed ?? 'default') as PermissionMode);

    return {
        permissionMode: normalized,
        permissionModeUpdatedAt: localUpdatedAt,
    };
}
