import type { Session } from '../../domains/state/storageTypes';
import type { PermissionMode } from '@/sync/domains/permissions/permissionTypes';
import {
    saveSessionPermissionModeUpdatedAts,
    saveSessionPermissionModes,
} from '../../domains/state/persistence';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

function extractSessionPermissionData(sessions: Record<string, Session>): {
    modes: Record<string, PermissionMode>;
    updatedAts: Record<string, number>;
} {
    const modes: Record<string, PermissionMode> = {};
    const updatedAts: Record<string, number> = {};

    Object.entries(sessions).forEach(([id, sess]) => {
        const updatedAt = sess.permissionModeUpdatedAt;
        if (typeof updatedAt === 'number' && Number.isFinite(updatedAt)) {
            updatedAts[id] = updatedAt;
            // Persist the mode whenever we have a timestamp (including explicit resets to default).
            if (sess.permissionMode) {
                modes[id] = sess.permissionMode;
            }
        }
    });

    return { modes, updatedAts };
}

export function persistSessionPermissionData(
    sessions: Record<string, Session>,
    scope?: ServerAccountScope | null,
): {
    modes: Record<string, PermissionMode>;
    updatedAts: Record<string, number>;
} | null {
    const { modes, updatedAts } = extractSessionPermissionData(sessions);

    try {
        saveSessionPermissionModes(modes, scope);
        saveSessionPermissionModeUpdatedAts(updatedAts, scope);
        return { modes, updatedAts };
    } catch (e) {
        console.error('Failed to persist session permission data:', e);
        return null;
    }
}
