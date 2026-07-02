import type { ModelMode } from '@/sync/domains/permissions/permissionTypes';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { Session } from '../../domains/state/storageTypes';
import {
    saveSessionModelModeUpdatedAts,
    saveSessionModelModes,
} from '../../domains/state/sessionPersistence';
import { persistTimestampedLocalSessionData } from './sessionTimestampedLocalPersistence';

export function persistSessionModelData(
    sessions: Record<string, Session>,
    scope?: ServerAccountScope | null,
    previous: Readonly<{
        modes: Record<string, ModelMode>;
        updatedAts: Record<string, number>;
    }> = { modes: {}, updatedAts: {} },
): {
    modes: Record<string, ModelMode>;
    updatedAts: Record<string, number>;
} | null {
    const persisted = persistTimestampedLocalSessionData({
        sessions,
        previousValues: previous.modes,
        previousUpdatedAts: previous.updatedAts,
        readValue: (session) => session.modelMode ?? null,
        readUpdatedAt: (session) => session.modelModeUpdatedAt,
        shouldPersistValue: (mode) => mode !== 'default',
        saveValues: saveSessionModelModes,
        saveUpdatedAts: saveSessionModelModeUpdatedAts,
        scope,
        errorMessage: 'Failed to persist session model data:',
    });
    return persisted ? { modes: persisted.values, updatedAts: persisted.updatedAts } : null;
}
