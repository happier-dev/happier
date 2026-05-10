import { parsePermissionIntentAlias } from '@happier-dev/agents';

import type { Session } from '@/sync/domains/state/storageTypes';
import type { PermissionMode } from '@/sync/domains/permissions/permissionTypes';

type SessionModelMode = NonNullable<Session['modelMode']>;

export function mutateSessionPermissionModeField(params: Readonly<{
    session: Session;
    mode: PermissionMode;
    updatedAt: number;
}>): Session {
    const canonicalMode = (typeof params.mode === 'string'
        ? (parsePermissionIntentAlias(params.mode) as PermissionMode | null)
        : null) ?? 'default';

    return {
        ...params.session,
        permissionMode: canonicalMode,
        permissionModeUpdatedAt: params.updatedAt,
    };
}

export function mutateSessionModelModeField(params: Readonly<{
    session: Session;
    modelMode: SessionModelMode;
    updatedAt: number;
}>): Session {
    return {
        ...params.session,
        modelMode: params.modelMode,
        modelModeUpdatedAt: params.updatedAt,
    };
}
