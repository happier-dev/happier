import { describe, expect, it } from 'vitest';

import type { Settings } from '../../domains/settings/settings';
import { resolveSessionListIndexSettingsImpact } from './settingsSessionListIndexImpact';

const baseSettings: Settings = {
    groupInactiveSessionsByProject: false,
    sessionListActiveGroupingV1: 'date',
    sessionListInactiveGroupingV1: 'date',
    sessionListSectionModeV1: 'activity',
    preferredLanguage: 'en',
} as Settings;

describe('resolveSessionListIndexSettingsImpact', () => {
    it('does not rebuild when the grouping settings stay the same', () => {
        expect(resolveSessionListIndexSettingsImpact(baseSettings, baseSettings)).toBe(false);
    });

    it('rebuilds when inactive grouping changes', () => {
        const nextSettings = {
            ...baseSettings,
            sessionListInactiveGroupingV1: 'project' as const,
        };

        expect(resolveSessionListIndexSettingsImpact(baseSettings, nextSettings)).toBe(true);
    });

    it('rebuilds when session section mode changes', () => {
        const nextSettings = {
            ...baseSettings,
            sessionListSectionModeV1: 'single' as const,
        };

        expect(resolveSessionListIndexSettingsImpact(baseSettings, nextSettings)).toBe(true);
    });
});
