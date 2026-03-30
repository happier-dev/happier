import { describe, expect, it } from 'vitest';

import { localSettingsDefaults } from '@/sync/domains/settings/localSettings';

import { buildLocalSettingsSnapshot } from './buildLocalSettingsSnapshot';

describe('buildLocalSettingsSnapshot', () => {
    it('tracks local theme preference, pane size buckets, acknowledged CLI counts, and ui font scale bucket', () => {
        const snapshot = buildLocalSettingsSnapshot({
            ...localSettingsDefaults,
            commandPaletteEnabled: true,
            themePreference: 'dark',
            uiFontScale: 1.24,
            sidebarCollapsed: true,
            sidebarWidthPx: 220,
            sidebarWidthBasisPx: 1_200,
            uiMultiPanePanelsEnabled: false,
            sessionsRightPaneDefaultOpen: true,
            detailsPaneTabsBehavior: 'persistent',
            editorFocusModeEnabled: true,
            rightPaneWidthPx: 360,
            rightPaneWidthBasisPx: 800,
            detailsPaneWidthPx: 420,
            detailsPaneWidthBasisPx: 1_400,
            bottomPaneHeightPx: 180,
            bottomPaneHeightBasisPx: 900,
            embeddedTerminalDockLocation: 'details',
            sessionsListStorageTab: 'direct',
            acknowledgedCliVersions: {
                'machine-a': '1.2.3',
                'machine-b': '2.0.0',
            },
        });

        expect(snapshot.properties.local_setting__commandPaletteEnabled).toBe(true);
        expect(snapshot.properties.local_setting__themePreference).toBe('dark');
        expect(snapshot.properties.local_setting__sidebarCollapsed).toBe(true);
        expect(snapshot.properties.local_setting__sidebarWidthPx).toBe('small');
        expect(snapshot.properties.local_setting__uiMultiPanePanelsEnabled).toBe(false);
        expect(snapshot.properties.local_setting__sessionsRightPaneDefaultOpen).toBe(true);
        expect(snapshot.properties.local_setting__detailsPaneTabsBehavior).toBe('persistent');
        expect(snapshot.properties.local_setting__editorFocusModeEnabled).toBe(true);
        expect(snapshot.properties.local_setting__rightPaneWidthPx).toBe('large');
        expect(snapshot.properties.local_setting__detailsPaneWidthPx).toBe('medium');
        expect(snapshot.properties.local_setting__bottomPaneHeightPx).toBe('small');
        expect(snapshot.properties.local_setting__embeddedTerminalDockLocation).toBe('details');
        expect(snapshot.properties.local_setting__sessionsListStorageTab).toBe('direct');
        expect(snapshot.properties.local_setting__acknowledgedCliVersions).toBe(2);
        expect(snapshot.properties.local_derived__uiFontScaleBucket).toBe('large');
    });
});

