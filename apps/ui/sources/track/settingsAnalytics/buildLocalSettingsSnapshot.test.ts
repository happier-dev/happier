import { describe, expect, it } from 'vitest';

import { localSettingsDefaults } from '@/sync/domains/settings/localSettings';

import { buildLocalSettingsSnapshot } from './buildLocalSettingsSnapshot';

describe('buildLocalSettingsSnapshot', () => {
    it('tracks local theme preference, layout preferences, and ui font scale bucket', () => {
        const snapshot = buildLocalSettingsSnapshot({
            ...localSettingsDefaults,
            themePreference: 'dark',
            uiFontScale: 1.24,
            uiMultiPanePanelsEnabled: false,
            sessionsRightPaneDefaultOpen: true,
            detailsPaneTabsBehavior: 'persistent',
            embeddedTerminalDockLocation: 'details',
        });

        expect(snapshot.properties.local_setting__themePreference).toBe('dark');
        expect(snapshot.properties.local_setting__uiMultiPanePanelsEnabled).toBe(false);
        expect(snapshot.properties.local_setting__sessionsRightPaneDefaultOpen).toBe(true);
        expect(snapshot.properties.local_setting__detailsPaneTabsBehavior).toBe('persistent');
        expect(snapshot.properties).not.toHaveProperty('local_setting__editorFocusModeEnabled');
        expect(snapshot.properties.local_setting__embeddedTerminalDockLocation).toBe('details');
        expect(snapshot.properties.local_derived__uiFontScaleBucket).toBe('large');
    });
});
