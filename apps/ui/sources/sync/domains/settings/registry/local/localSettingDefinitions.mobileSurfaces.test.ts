import { describe, expect, it } from 'vitest';

import { localSettingsParse } from '@/sync/domains/settings/localSettings';

describe('LOCAL_SETTING_DEFINITIONS mobile surfaces', () => {
    it('stores shared placements with tolerant reads while preserving all known surface preferences', () => {
        const stored = localSettingsParse({ navigationSurfacePlacementsV1: { appRail: { orderedIds: ['plugin:removed'], placements: { 'plugin:removed': 'hidden' }, future: true }, futureSurface: {} } });
        expect(stored.navigationSurfacePlacementsV1).toEqual({ appRail: { orderedIds: ['plugin:removed'], placements: { 'plugin:removed': 'hidden' } } });
    });
});
