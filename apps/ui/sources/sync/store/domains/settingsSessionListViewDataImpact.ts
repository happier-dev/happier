import type { Settings } from '../../domains/settings/settings';

export type SessionListViewDataSettingsImpact = Readonly<{
    shouldRebuildSessionListViewData: boolean;
}>;

export function resolveSessionListViewDataSettingsImpact(
    previousSettings: Settings,
    nextSettings: Settings,
): SessionListViewDataSettingsImpact {
    return {
        shouldRebuildSessionListViewData:
            nextSettings.groupInactiveSessionsByProject !== previousSettings.groupInactiveSessionsByProject
            || nextSettings.sessionListActiveGroupingV1 !== previousSettings.sessionListActiveGroupingV1
            || nextSettings.sessionListInactiveGroupingV1 !== previousSettings.sessionListInactiveGroupingV1,
    };
}
