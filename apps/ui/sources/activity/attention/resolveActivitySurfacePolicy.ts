export type ActivitySurfaceMode = 'focused' | 'attention' | 'running';
export type WidgetSurfaceMode = 'summary' | 'attention' | 'running';
export type ActivitySurfaceTapTarget = 'open_session' | 'open_sessions';
export type ActivitySurfacePrivacyMode = 'status_only' | 'title_only' | 'include_preview';
export type LiveActivityStrategy = 'dynamic_primary' | 'pinned_primary' | 'session_specific';

export type ActivitySurfacePolicy = Readonly<{
    activitySurfacesEnabled: boolean;
    liveActivities: Readonly<{
        enabled: boolean;
        mode: ActivitySurfaceMode;
        strategy: LiveActivityStrategy;
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

function readBooleanAlias(primary: unknown, legacy: unknown, fallback: boolean): boolean {
    if (typeof primary === 'boolean') return primary;
    if (typeof legacy === 'boolean') return legacy;
    return fallback;
}

function readEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
    return typeof value === 'string' && allowed.includes(value as T) ? value as T : fallback;
}

function readEnumAlias<T extends string>(
    primary: unknown,
    legacy: unknown,
    allowed: readonly T[],
    fallback: T,
): T {
    if (typeof primary === 'string' && allowed.includes(primary as T)) {
        return primary as T;
    }
    if (typeof legacy === 'string' && allowed.includes(legacy as T)) {
        return legacy as T;
    }
    return fallback;
}

function readMaxConcurrent(value: unknown): 1 | 2 | 4 {
    return value === 2 || value === 4 ? value : 1;
}

function resolveLiveActivityStrategy(settings: ActivitySurfaceSettingsInput, params: Readonly<{
    mode: ActivitySurfaceMode;
    maxConcurrent: 1 | 2 | 4;
}>): LiveActivityStrategy {
    if (typeof settings.liveActivitiesStrategy === 'string') {
        return readEnum(
            settings.liveActivitiesStrategy,
            ['dynamic_primary', 'pinned_primary', 'session_specific'],
            'dynamic_primary',
        );
    }

    if (params.mode !== 'focused' && params.maxConcurrent > 1) {
        return 'session_specific';
    }

    return 'dynamic_primary';
}

export function resolveActivitySurfacePolicy(settings: ActivitySurfaceSettingsInput): ActivitySurfacePolicy {
    const activitySurfacesEnabled = readBoolean(settings.activitySurfacesEnabled, true);
    const liveActivitiesMode = readEnum(settings.liveActivitiesMode, ['focused', 'attention', 'running'], 'focused');
    const liveActivitiesMaxConcurrent = readMaxConcurrent(settings.liveActivitiesMaxConcurrent);
    const liveActivitiesEnabled = readBooleanAlias(
        settings.liveActivitiesEnabled,
        settings.iosLiveActivitiesEnabled,
        true,
    );
    const widgetsEnabled = readBooleanAlias(
        settings.widgetsEnabled,
        settings.iosWidgetsEnabled,
        true,
    );
    const widgetsMode = readEnumAlias(
        settings.widgetsPresetMode,
        settings.homeScreenWidgetsMode,
        ['summary', 'attention', 'running'],
        'summary',
    );
    const widgetsShowPreviewText = readBooleanAlias(
        settings.widgetsShowPreviewText,
        settings.homeScreenWidgetsShowPreviewText,
        true,
    );
    const widgetsShowMachinePath = readBooleanAlias(
        settings.widgetsShowMachinePath,
        settings.homeScreenWidgetsShowMachinePath,
        true,
    );

    return {
        activitySurfacesEnabled,
        liveActivities: {
            enabled: activitySurfacesEnabled && liveActivitiesEnabled,
            mode: liveActivitiesMode,
            strategy: resolveLiveActivityStrategy(settings, {
                mode: liveActivitiesMode,
                maxConcurrent: liveActivitiesMaxConcurrent,
            }),
            maxConcurrent: liveActivitiesMaxConcurrent,
            showPreviewText: readBoolean(settings.liveActivitiesShowPreviewText, true),
            allowActionButtons: readBoolean(settings.liveActivitiesAllowActionButtons, true),
            includeReady: readBoolean(settings.liveActivitiesIncludeReady, true),
            includeThinking: readBoolean(settings.liveActivitiesIncludeThinking, true),
        },
        widgets: {
            enabled: activitySurfacesEnabled && widgetsEnabled,
            mode: widgetsMode,
            showPreviewText: widgetsShowPreviewText,
            showMachinePath: widgetsShowMachinePath,
        },
        tapTarget: readEnum(settings.activitySurfaceTapTarget, ['open_session', 'open_sessions'], 'open_session'),
        privacyMode: readEnum(settings.activitySurfacePrivacyMode, ['status_only', 'title_only', 'include_preview'], 'title_only'),
    };
}
