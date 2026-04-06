import { describe, expect, it } from 'vitest';

import type { Settings } from '../../domains/settings/settings';
import { resolveSessionListViewDataSettingsImpact } from './settingsSessionListViewDataImpact';

const baseSettings: Settings = {
    groupInactiveSessionsByProject: false,
    sessionListActiveGroupingV1: 'date',
    sessionListInactiveGroupingV1: 'date',
    preferredLanguage: 'en',
} as Settings;

describe('resolveSessionListViewDataSettingsImpact', () => {
    it('does not rebuild when the grouping settings stay the same', () => {
        expect(resolveSessionListViewDataSettingsImpact(baseSettings, baseSettings)).toEqual({
            shouldRebuildSessionListViewData: false,
        });
    });

    it('rebuilds when inactive grouping changes', () => {
        const nextSettings = {
            ...baseSettings,
            sessionListInactiveGroupingV1: 'project' as const,
        };

        expect(resolveSessionListViewDataSettingsImpact(baseSettings, nextSettings)).toEqual({
            shouldRebuildSessionListViewData: true,
        });
    });
});
