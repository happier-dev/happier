import { normalizeStoredServerSelectionGroups } from './serverSelectionMutations';
import type { ServerSelectionSettingsLike } from './serverSelectionTypes';

function normalizeTargetKind(raw: unknown): 'server' | 'group' | null {
    return raw === 'server' || raw === 'group' ? raw : null;
}

export function toServerSelectionSettings(
    settings: Readonly<{
        serverSelectionGroups: unknown;
        serverSelectionActiveTargetKind: unknown;
        serverSelectionActiveTargetId: unknown;
    }>,
): ServerSelectionSettingsLike {
    return {
        serverSelectionGroups: normalizeStoredServerSelectionGroups(settings.serverSelectionGroups),
        serverSelectionActiveTargetKind: normalizeTargetKind(settings.serverSelectionActiveTargetKind),
        serverSelectionActiveTargetId:
            typeof settings.serverSelectionActiveTargetId === 'string' ? settings.serverSelectionActiveTargetId : null,
    };
}
