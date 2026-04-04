import { describe, expect, it } from 'vitest';

import { resolveActivitySurfacePolicy } from './resolveActivitySurfacePolicy';

describe('resolveActivitySurfacePolicy', () => {
    it('returns the default focused policy when settings are absent', () => {
        expect(resolveActivitySurfacePolicy({})).toEqual({
            activitySurfacesEnabled: true,
            liveActivities: {
                enabled: true,
                mode: 'focused',
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
});
