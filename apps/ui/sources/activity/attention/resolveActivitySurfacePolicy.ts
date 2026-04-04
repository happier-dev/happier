export type ActivitySurfaceMode = 'focused' | 'attention' | 'running';
export type WidgetSurfaceMode = 'summary' | 'attention' | 'running';
export type ActivitySurfaceTapTarget = 'open_session' | 'open_sessions';
export type ActivitySurfacePrivacyMode = 'status_only' | 'title_only' | 'include_preview';

export type ActivitySurfacePolicy = Readonly<{
    activitySurfacesEnabled: boolean;
    liveActivities: Readonly<{
        enabled: boolean;
        mode: ActivitySurfaceMode;
        maxConcurrent: 1 | 2 | 4;
        showPreviewText: boolean;
        allowActionButtons: boolean;
        includeReady: boolean;
        includeThinking: boolean;
    }>;
    widgets: Readonly<{
        enabled: boolean;
        mode: WidgetSurfaceMode;
        showPreviewText: boolean;
        showMachinePath: boolean;
    }>;
    tapTarget: ActivitySurfaceTapTarget;
    privacyMode: ActivitySurfacePrivacyMode;
}>;

type ActivitySurfaceSettingsInput = Readonly<Record<string, unknown>>;

function readBoolean(value: unknown, fallback: boolean): boolean {
    return typeof value === 'boolean' ? value : fallback;
}

function readEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
    return typeof value === 'string' && allowed.includes(value as T) ? value as T : fallback;
}

function readMaxConcurrent(value: unknown): 1 | 2 | 4 {
    return value === 2 || value === 4 ? value : 1;
}

export function resolveActivitySurfacePolicy(settings: ActivitySurfaceSettingsInput): ActivitySurfacePolicy {
    const activitySurfacesEnabled = readBoolean(settings.activitySurfacesEnabled, true);

    return {
        activitySurfacesEnabled,
        liveActivities: {
            enabled: activitySurfacesEnabled && readBoolean(settings.iosLiveActivitiesEnabled, true),
            mode: readEnum(settings.liveActivitiesMode, ['focused', 'attention', 'running'], 'focused'),
            maxConcurrent: readMaxConcurrent(settings.liveActivitiesMaxConcurrent),
            showPreviewText: readBoolean(settings.liveActivitiesShowPreviewText, true),
            allowActionButtons: readBoolean(settings.liveActivitiesAllowActionButtons, true),
            includeReady: readBoolean(settings.liveActivitiesIncludeReady, true),
            includeThinking: readBoolean(settings.liveActivitiesIncludeThinking, true),
        },
        widgets: {
            enabled: activitySurfacesEnabled && readBoolean(settings.iosWidgetsEnabled, true),
            mode: readEnum(settings.homeScreenWidgetsMode, ['summary', 'attention', 'running'], 'summary'),
            showPreviewText: readBoolean(settings.homeScreenWidgetsShowPreviewText, true),
            showMachinePath: readBoolean(settings.homeScreenWidgetsShowMachinePath, true),
        },
        tapTarget: readEnum(settings.activitySurfaceTapTarget, ['open_session', 'open_sessions'], 'open_session'),
        privacyMode: readEnum(settings.activitySurfacePrivacyMode, ['status_only', 'title_only', 'include_preview'], 'title_only'),
    };
}
