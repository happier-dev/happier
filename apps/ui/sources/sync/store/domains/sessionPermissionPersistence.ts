import type { Session } from '../../domains/state/storageTypes';
import type { PermissionMode } from '@/sync/domains/permissions/permissionTypes';
import { saveSessionPermissionModeUpdatedAts, saveSessionPermissionModes } from '../../domains/state/persistence';

function extractSessionPermissionData(sessions: Record<string, Session>): {
    modes: Record<string, PermissionMode>;
    updatedAts: Record<string, number>;
} {
    const modes: Record<string, PermissionMode> = {};
    const updatedAts: Record<string, number> = {};

    Object.entries(sessions).forEach(([id, sess]) => {
        if (sess.permissionMode && sess.permissionMode !== 'default') {
            modes[id] = sess.permissionMode;
        }
        if (typeof sess.permissionModeUpdatedAt === 'number') {
            updatedAts[id] = sess.permissionModeUpdatedAt;
        }
    });

    return { modes, updatedAts };
}

export function persistSessionPermissionData(sessions: Record<string, Session>): {
    modes: Record<string, PermissionMode>;
    updatedAts: Record<string, number>;
} | null {
    const { modes, updatedAts } = extractSessionPermissionData(sessions);

    try {
        saveSessionPermissionModes(modes);
        saveSessionPermissionModeUpdatedAts(updatedAts);
        return { modes, updatedAts };
    } catch (e) {
        console.error('Failed to persist session permission data:', e);
        return null;
    }
}

