import type { ActionId, BackendTargetRefV2Input } from '@happier-dev/protocol';

import { buildActionDraftInput } from './buildActionDraftInput';
import { normalizeExecutionRunActionPermissionMode } from './executionRunActionPermissionMode';
import { resolveExecutionRunActionDefaultPermissionMode } from './resolveExecutionRunActionDefaultPermissionMode';

function hasExplicitPermissionMode(extra: Record<string, unknown> | null): boolean {
    return Boolean(extra) && Object.prototype.hasOwnProperty.call(extra, 'permissionMode');
}

export function buildExecutionRunActionDraftInputForUi(args: Readonly<{
    actionId: ActionId;
    sessionId?: string | null;
    defaultBackendTarget?: BackendTargetRefV2Input | null;
    defaultBackendId?: string | null;
    instructions?: string | null;
    extra?: Record<string, unknown> | null;
}>): Record<string, unknown> {
    const extra = args.extra && typeof args.extra === 'object' ? args.extra : null;
    const defaultPermissionMode = resolveExecutionRunActionDefaultPermissionMode(args.actionId);

    // Action inputs use protocol permission tokens even when the UI surface uses
    // the equivalent session-facing vocabulary.
    const mergedExtra = hasExplicitPermissionMode(extra)
        ? {
            ...(extra ?? {}),
            permissionMode: normalizeExecutionRunActionPermissionMode(extra?.permissionMode),
        }
        : !defaultPermissionMode
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
