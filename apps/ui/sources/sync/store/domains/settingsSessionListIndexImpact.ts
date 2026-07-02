import type { Settings } from '../../domains/settings/settings';

export function resolveSessionListIndexSettingsImpact(
    previousSettings: Settings,
    nextSettings: Settings,
): boolean {
    return nextSettings.groupInactiveSessionsByProject !== previousSettings.groupInactiveSessionsByProject
        || nextSettings.sessionListActiveGroupingV1 !== previousSettings.sessionListActiveGroupingV1
        || nextSettings.sessionListInactiveGroupingV1 !== previousSettings.sessionListInactiveGroupingV1
        || nextSettings.sessionListSectionModeV1 !== previousSettings.sessionListSectionModeV1;
}
