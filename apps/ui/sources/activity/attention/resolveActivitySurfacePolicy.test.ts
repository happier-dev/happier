import { describe, expect, it } from 'vitest';

import { resolveActivitySurfacePolicy } from './resolveActivitySurfacePolicy';

describe('resolveActivitySurfacePolicy', () => {
    it('returns the default focused policy when settings are absent', () => {
        expect(resolveActivitySurfacePolicy({})).toEqual({
            activitySurfacesEnabled: true,
            liveActivities: {
                enabled: true,
                mode: 'focused',
                strategy: 'dynamic_primary',
                maxConcurrent: 1,
                showPreviewText: true,
                allowActionButtons: true,
                includeReady: true,
                includeThinking: true,
            },
            widgets: {
                enabled: true,
                mode: 'summary',
                showPreviewText: true,
                showMachinePath: true,
            },
            tapTarget: 'open_session',
            privacyMode: 'title_only',
        });
    });

    it('disables child surfaces when the master switch is off', () => {
        expect(resolveActivitySurfacePolicy({
            activitySurfacesEnabled: false,
            iosLiveActivitiesEnabled: true,
            iosWidgetsEnabled: true,
        })).toMatchObject({
            activitySurfacesEnabled: false,
            liveActivities: {
                enabled: false,
            },
            widgets: {
                enabled: false,
            },
        });
    });

    it('applies explicit live activity and widget preferences', () => {
        expect(resolveActivitySurfacePolicy({
            activitySurfacesEnabled: true,
            iosLiveActivitiesEnabled: true,
            iosWidgetsEnabled: false,
            liveActivitiesMode: 'attention',
            liveActivitiesStrategy: 'session_specific',
            liveActivitiesMaxConcurrent: 4,
            liveActivitiesShowPreviewText: false,
            liveActivitiesAllowActionButtons: false,
            liveActivitiesIncludeReady: false,
            liveActivitiesIncludeThinking: false,
            homeScreenWidgetsMode: 'running',
            homeScreenWidgetsShowPreviewText: false,
            homeScreenWidgetsShowMachinePath: false,
            activitySurfaceTapTarget: 'open_sessions',
            activitySurfacePrivacyMode: 'title_only',
        })).toEqual({
            activitySurfacesEnabled: true,
            liveActivities: {
                enabled: true,
                mode: 'attention',
                strategy: 'session_specific',
                maxConcurrent: 4,
                showPreviewText: false,
                allowActionButtons: false,
                includeReady: false,
                includeThinking: false,
            },
            widgets: {
                enabled: false,
                mode: 'running',
                showPreviewText: false,
                showMachinePath: false,
            },
            tapTarget: 'open_sessions',
            privacyMode: 'title_only',
        });
    });

    it('preserves legacy multi-session live activity behavior when max-concurrent is greater than one', () => {
        expect(resolveActivitySurfacePolicy({
            liveActivitiesMode: 'attention',
            liveActivitiesMaxConcurrent: 2,
        }).liveActivities.strategy).toBe('session_specific');
    });

    it('preserves an explicit live-activity strategy even when the legacy multi-session fallback would differ', () => {
        expect(resolveActivitySurfacePolicy({
            liveActivitiesMode: 'attention',
            liveActivitiesMaxConcurrent: 4,
            liveActivitiesStrategy: 'dynamic_primary',
        }).liveActivities.strategy).toBe('dynamic_primary');
    });

    it('prefers normalized settings keys while still honoring legacy aliases', () => {
        expect(resolveActivitySurfacePolicy({
            activitySurfacesEnabled: true,
            liveActivitiesEnabled: false,
            iosLiveActivitiesEnabled: true,
            widgetsEnabled: false,
            iosWidgetsEnabled: true,
            widgetsPresetMode: 'attention',
            homeScreenWidgetsMode: 'running',
            widgetsShowPreviewText: false,
            homeScreenWidgetsShowPreviewText: true,
            widgetsShowMachinePath: false,
            homeScreenWidgetsShowMachinePath: true,
        })).toMatchObject({
            liveActivities: {
                enabled: false,
            },
            widgets: {
                enabled: false,
                mode: 'attention',
                showPreviewText: false,
                showMachinePath: false,
            },
        });
    });
});
