import { describe, expect, it } from 'vitest';

import { localSettingsDefaults } from '@/sync/domains/settings/localSettings';

import { buildLocalSettingsSnapshot } from './buildLocalSettingsSnapshot';

describe('buildLocalSettingsSnapshot', () => {
    it('tracks local theme preference, pane size buckets, acknowledged CLI counts, and ui font scale bucket', () => {
        const snapshot = buildLocalSettingsSnapshot({
            ...localSettingsDefaults,
            themePreference: 'dark',
            uiFontScale: 1.24,
            sidebarCollapsed: true,
            sidebarWidthPx: 220,
            sidebarWidthBasisPx: 1_200,
            uiMultiPanePanelsEnabled: false,
            sessionsRightPaneDefaultOpen: true,
            detailsPaneTabsBehavior: 'persistent',
            activitySurfacesEnabled: false,
            liveActivitiesEnabled: false,
            liveActivitiesStrategy: 'pinned_primary',
            iosLiveActivitiesEnabled: false,
            widgetsEnabled: true,
            liveActivitiesMode: 'running',
            liveActivitiesMaxConcurrent: 4,
            liveActivitiesShowPreviewText: false,
            liveActivitiesAllowActionButtons: false,
            liveActivitiesIncludeReady: false,
            liveActivitiesIncludeThinking: true,
            widgetsPresetMode: 'attention',
            widgetsShowPreviewText: false,
            widgetsShowMachinePath: false,
            homeScreenWidgetsMode: 'attention',
            homeScreenWidgetsShowPreviewText: false,
            homeScreenWidgetsShowMachinePath: false,
            activitySurfaceTapTarget: 'open_sessions',
            activitySurfacePrivacyMode: 'include_preview',
            desktopOverlayEnabled: true,
            desktopOverlayVisibilityMode: 'always_when_enabled',
            desktopOverlayShowWhenRunning: false,
            desktopOverlayShowWhenAttentionRequired: false,
            desktopOverlayShowWhenReady: false,
            desktopOverlayAlwaysOnTop: false,
            desktopOverlayAutoHideEnabled: false,
            desktopOverlayAutoHideDelayMs: 10_000,
            desktopOverlayExpandedBehavior: 'hover',
            desktopOverlayInteractiveCollapsed: false,
            desktopOverlayPresentationMode: 'notch_integrated',
            desktopOverlayEnableDragReposition: true,
            desktopOverlayLockPosition: false,
            desktopOverlayPlacementMode: 'custom',
            desktopOverlayAnchor: 'bottom_right',
            desktopOverlayOffsetX: 16,
            desktopOverlayOffsetY: -12,
            desktopOverlayClickAction: 'open_primary_session',
            desktopOverlayDensity: 'comfortable',
            desktopOverlayShowSessionCount: false,
            desktopOverlayShowPreviewText: true,
            desktopOverlayCompactStyle: 'panel',
            rightPaneWidthPx: 360,
            rightPaneWidthBasisPx: 800,
            detailsPaneWidthPx: 420,
            detailsPaneWidthBasisPx: 1_400,
            bottomPaneHeightPx: 180,
            bottomPaneHeightBasisPx: 900,
            embeddedTerminalDockLocation: 'details',
            sessionsListStorageFilter: 'direct',
            acknowledgedCliVersions: {
                'machine-a': '1.2.3',
                'machine-b': '2.0.0',
            },
        });
        expect(snapshot.properties.local_setting__themePreference).toBe('dark');
        expect(snapshot.properties.local_setting__sidebarCollapsed).toBe(true);
        expect(snapshot.properties.local_setting__sidebarWidthPx).toBe('small');
        expect(snapshot.properties.local_setting__uiMultiPanePanelsEnabled).toBe(false);
        expect(snapshot.properties.local_setting__sessionsRightPaneDefaultOpen).toBe(true);
        expect(snapshot.properties.local_setting__detailsPaneTabsBehavior).toBe('persistent');
        expect(snapshot.properties.local_setting__editorFocusModeEnabled).toBeUndefined();
        expect(snapshot.properties.local_setting__activitySurfacesEnabled).toBe(false);
        expect(snapshot.properties.local_setting__liveActivitiesEnabled).toBe(false);
        expect(snapshot.properties.local_setting__liveActivitiesStrategy).toBe('pinned_primary');
        expect(snapshot.properties.local_setting__widgetsEnabled).toBe(true);
        expect(snapshot.properties.local_setting__liveActivitiesMode).toBe('running');
        expect(snapshot.properties.local_setting__liveActivitiesMaxConcurrent).toBe(4);
        expect(snapshot.properties.local_setting__liveActivitiesShowPreviewText).toBe(false);
        expect(snapshot.properties.local_setting__liveActivitiesAllowActionButtons).toBe(false);
        expect(snapshot.properties.local_setting__liveActivitiesIncludeReady).toBe(false);
        expect(snapshot.properties.local_setting__liveActivitiesIncludeThinking).toBe(true);
        expect(snapshot.properties.local_setting__widgetsPresetMode).toBe('attention');
        expect(snapshot.properties.local_setting__widgetsShowPreviewText).toBe(false);
        expect(snapshot.properties.local_setting__widgetsShowMachinePath).toBe(false);
        expect(snapshot.properties.local_setting__activitySurfaceTapTarget).toBe('open_sessions');
        expect(snapshot.properties.local_setting__activitySurfacePrivacyMode).toBe('include_preview');
        expect(snapshot.properties.local_setting__desktopOverlayEnabled).toBe(true);
        expect(snapshot.properties.local_setting__desktopOverlayVisibilityMode).toBe('always_when_enabled');
        expect(snapshot.properties.local_setting__desktopOverlayShowWhenRunning).toBe(false);
        expect(snapshot.properties.local_setting__desktopOverlayShowWhenAttentionRequired).toBe(false);
        expect(snapshot.properties.local_setting__desktopOverlayShowWhenReady).toBe(false);
        expect(snapshot.properties.local_setting__desktopOverlayAlwaysOnTop).toBe(false);
        expect(snapshot.properties.local_setting__desktopOverlayAutoHideEnabled).toBe(false);
        expect(snapshot.properties.local_setting__desktopOverlayAutoHideDelayMs).toBe('10s');
        expect(snapshot.properties.local_setting__desktopOverlayExpandedBehavior).toBe('hover');
        expect(snapshot.properties.local_setting__desktopOverlayInteractiveCollapsed).toBe(false);
        expect(snapshot.properties.local_setting__desktopOverlayPresentationMode).toBe('notch_integrated');
        expect(snapshot.properties.local_setting__desktopOverlayEnableDragReposition).toBe(true);
        expect(snapshot.properties.local_setting__desktopOverlayLockPosition).toBe(false);
        expect(snapshot.properties.local_setting__desktopOverlayPlacementMode).toBe('custom');
        expect(snapshot.properties.local_setting__desktopOverlayAnchor).toBe('bottom_right');
        expect(snapshot.properties.local_setting__desktopOverlayClickAction).toBe('open_primary_session');
        expect(snapshot.properties.local_setting__desktopOverlayDensity).toBe('comfortable');
        expect(snapshot.properties.local_setting__desktopOverlayShowSessionCount).toBe(false);
        expect(snapshot.properties.local_setting__desktopOverlayShowPreviewText).toBe(true);
        expect(snapshot.properties.local_setting__desktopOverlayCompactStyle).toBe('panel');
        expect(snapshot.properties.local_setting__iosLiveActivitiesEnabled).toBeUndefined();
        expect(snapshot.properties.local_setting__iosWidgetsEnabled).toBeUndefined();
        expect(snapshot.properties.local_setting__homeScreenWidgetsMode).toBeUndefined();
        expect(snapshot.properties.local_setting__homeScreenWidgetsShowPreviewText).toBeUndefined();
        expect(snapshot.properties.local_setting__homeScreenWidgetsShowMachinePath).toBeUndefined();
        expect(snapshot.properties.local_setting__rightPaneWidthPx).toBe('large');
        expect(snapshot.properties.local_setting__detailsPaneWidthPx).toBe('medium');
        expect(snapshot.properties.local_setting__bottomPaneHeightPx).toBe('small');
        expect(snapshot.properties.local_setting__embeddedTerminalDockLocation).toBe('details');
        expect(snapshot.properties.local_setting__sessionsListStorageFilter).toBe('direct');
        expect(snapshot.properties.local_setting__acknowledgedCliVersions).toBe(2);
        expect(snapshot.properties.local_derived__uiFontScaleBucket).toBe('large');
    });
});
