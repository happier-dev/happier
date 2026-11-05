import { describe, expect, it } from 'vitest';

import { localSettingsDefaults, localSettingsParse } from '@/sync/domains/settings/localSettings';

import { buildLocalSettingsSnapshot } from './buildLocalSettingsSnapshot';

describe('buildLocalSettingsSnapshot', () => {
    it('buckets pane pixels independently of retired window bases', () => {
        const smallBasis = buildLocalSettingsSnapshot(localSettingsParse({ sidebarWidthPx: 420, sidebarWidthBasisPx: 600 }));
        const largeBasis = buildLocalSettingsSnapshot(localSettingsParse({ sidebarWidthPx: 420, sidebarWidthBasisPx: 2560 }));
        expect(smallBasis.properties.local_setting__sidebarWidthPx).toBe(largeBasis.properties.local_setting__sidebarWidthPx);
        expect(typeof smallBasis.properties.local_setting__sidebarWidthPx).toBe('string');
    });
    it('tracks local theme preference, pane size buckets, acknowledged CLI counts, and ui font scale bucket', () => {
        const snapshot = buildLocalSettingsSnapshot(localSettingsParse({
            ...localSettingsDefaults,
            themePreference: 'dark',
            uiFontScale: 1.24,
            sidebarCollapsed: true,
            sidebarWidthPx: 220,
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
            detailsPaneWidthPx: 420,
            bottomPaneHeightPx: 180,
            sessionsListStorageFilter: 'direct',
            acknowledgedCliVersions: {
                'machine-a': '1.2.3',
                'machine-b': '2.0.0',
            },
        }));
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
        expect(snapshot.properties.local_setting__desktopOverlayShowWhenRunning).toBeUndefined();
        expect(snapshot.properties.local_setting__desktopOverlayShowWhenAttentionRequired).toBeUndefined();
        expect(snapshot.properties.local_setting__desktopOverlayShowWhenReady).toBeUndefined();
        expect(snapshot.properties.local_setting__desktopOverlayAlwaysOnTop).toBe(false);
        expect(snapshot.properties.local_setting__desktopOverlayAutoHideEnabled).toBeUndefined();
        expect(snapshot.properties.local_setting__desktopOverlayAutoHideDelayMs).toBeUndefined();
        expect(snapshot.properties.local_setting__desktopOverlayExpandedBehavior).toBeUndefined();
        expect(snapshot.properties.local_setting__desktopOverlayInteractiveCollapsed).toBeUndefined();
        expect(snapshot.properties.local_setting__desktopOverlayPresentationMode).toBeUndefined();
        expect(snapshot.properties.local_setting__desktopOverlayEnableDragReposition).toBeUndefined();
        expect(snapshot.properties.local_setting__desktopOverlayLockPosition).toBeUndefined();
        expect(snapshot.properties.local_setting__desktopOverlayPlacementMode).toBeUndefined();
        expect(snapshot.properties.local_setting__desktopOverlayAnchor).toBeUndefined();
        expect(snapshot.properties.local_setting__desktopOverlayClickAction).toBeUndefined();
        expect(snapshot.properties.local_setting__desktopOverlayDensity).toBeUndefined();
        expect(snapshot.properties.local_setting__desktopOverlayShowSessionCount).toBeUndefined();
        expect(snapshot.properties.local_setting__desktopOverlayShowPreviewText).toBeUndefined();
        expect(snapshot.properties.local_setting__desktopOverlayCompactStyle).toBeUndefined();
        expect(snapshot.properties.local_setting__iosLiveActivitiesEnabled).toBeUndefined();
        expect(snapshot.properties.local_setting__iosWidgetsEnabled).toBeUndefined();
        expect(snapshot.properties.local_setting__homeScreenWidgetsMode).toBeUndefined();
        expect(snapshot.properties.local_setting__homeScreenWidgetsShowPreviewText).toBeUndefined();
        expect(snapshot.properties.local_setting__homeScreenWidgetsShowMachinePath).toBeUndefined();
        expect(snapshot.properties.local_setting__rightPaneWidthPx).toBe('medium');
        expect(snapshot.properties.local_setting__detailsPaneWidthPx).toBe('medium');
        expect(snapshot.properties.local_setting__bottomPaneHeightPx).toBe('small');
        expect(snapshot.properties.local_setting__sessionsListStorageFilter).toBe('direct');
        expect(snapshot.properties.local_setting__acknowledgedCliVersions).toBe(2);
        expect(snapshot.properties.local_derived__uiFontScaleBucket).toBe('large');
    });
});
