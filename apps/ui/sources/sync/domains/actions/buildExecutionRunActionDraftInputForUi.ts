import type { ActionId, BackendTargetRefV1 } from '@happier-dev/protocol';

import { buildActionDraftInput } from './buildActionDraftInput';
import { resolveExecutionRunActionDefaultPermissionMode } from './resolveExecutionRunActionDefaultPermissionMode';

function hasExplicitPermissionMode(extra: Record<string, unknown> | null): boolean {
    return Boolean(extra) && Object.prototype.hasOwnProperty.call(extra, 'permissionMode');
}

export function buildExecutionRunActionDraftInputForUi(args: Readonly<{
    actionId: ActionId;
    sessionId?: string | null;
    defaultBackendTarget?: BackendTargetRefV1 | null;
    defaultBackendId?: string | null;
    instructions?: string | null;
    extra?: Record<string, unknown> | null;
}>): Record<string, unknown> {
    const extra = args.extra && typeof args.extra === 'object' ? args.extra : null;
    const defaultPermissionMode = resolveExecutionRunActionDefaultPermissionMode(args.actionId);

    // UI launch surfaces must seed canonical UI permission tokens here so new
    // entrypoints cannot drift back to protocol-only aliases.
    const mergedExtra = hasExplicitPermissionMode(extra) || !defaultPermissionMode
        ? extra
        : {
            ...(extra ?? {}),
            permissionMode: defaultPermissionMode,
        };

    return buildActionDraftInput({
        actionId: args.actionId,
        sessionId: args.sessionId,
        defaultBackendTarget: args.defaultBackendTarget,
        defaultBackendId: args.defaultBackendId,
        instructions: args.instructions,
        extra: mergedExtra,
    });
}
