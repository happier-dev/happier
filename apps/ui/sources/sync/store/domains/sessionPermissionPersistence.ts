import type { Session } from '../../domains/state/storageTypes';
import type { PermissionMode } from '@/sync/domains/permissions/permissionTypes';
import {
    saveSessionPermissionModeUpdatedAts,
    saveSessionPermissionModes,
} from '../../domains/state/sessionPersistence';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { persistTimestampedLocalSessionData } from './sessionTimestampedLocalPersistence';

export function persistSessionPermissionData(
    sessions: Record<string, Session>,
    scope?: ServerAccountScope | null,
    previous: Readonly<{
        modes: Record<string, PermissionMode>;
        updatedAts: Record<string, number>;
    }> = { modes: {}, updatedAts: {} },
): {
    modes: Record<string, PermissionMode>;
    updatedAts: Record<string, number>;
} | null {
    const persisted = persistTimestampedLocalSessionData({
        sessions,
        previousValues: previous.modes,
        previousUpdatedAts: previous.updatedAts,
        readValue: (session) => session.permissionMode ?? null,
        readUpdatedAt: (session) => session.permissionModeUpdatedAt,
        shouldPersistValue: (mode) => Boolean(mode),
        saveValues: saveSessionPermissionModes,
        saveUpdatedAts: saveSessionPermissionModeUpdatedAts,
        scope,
        errorMessage: 'Failed to persist session permission data:',
    });
    return persisted ? { modes: persisted.values, updatedAts: persisted.updatedAts } : null;
}
