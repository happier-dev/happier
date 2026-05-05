import Constants from 'expo-constants';

export type LiveActivityPushSupportReason =
    | 'expo_widgets_push_notifications_disabled'
    | 'expo_widgets_token_api_missing';

export type LiveActivityPushSupport = Readonly<{
    expoWidgetsPushNotificationsEnabled: boolean;
    tokenApisAvailable: boolean;
    canRegisterRemoteTargets: boolean;
    reasons: readonly LiveActivityPushSupportReason[];
}>;

type ExpoConfigLike = Readonly<{
    plugins?: unknown;
    extra?: unknown;
}>;

type ResolveLiveActivityPushSupportParams = Readonly<{
    expoConfig?: ExpoConfigLike | null;
    tokenApisAvailable: boolean;
}>;

function isExpoWidgetsPluginEntry(entry: unknown): entry is readonly [unknown, Record<string, unknown>] {
    return Array.isArray(entry)
        && entry[0] === 'expo-widgets'
        && entry[1] !== null
        && typeof entry[1] === 'object'
        && !Array.isArray(entry[1]);
}

export function readExpoWidgetsPushNotificationsEnabled(expoConfig: ExpoConfigLike | null | undefined): boolean {
    const extra = expoConfig?.extra;
    if (extra && typeof extra === 'object' && !Array.isArray(extra)) {
        const app = (extra as Readonly<Record<string, unknown>>).app;
        if (app && typeof app === 'object' && !Array.isArray(app)) {
            const configured = (app as Readonly<Record<string, unknown>>).iosLiveActivityPushNotificationsEnabled;
            if (typeof configured === 'boolean') {
                return configured;
            }
        }
    }

    const plugins = Array.isArray(expoConfig?.plugins) ? expoConfig.plugins : [];
    for (const entry of plugins) {
        if (!isExpoWidgetsPluginEntry(entry)) continue;
        return entry[1].enablePushNotifications === true;
    }
    return false;
}

export function resolveLiveActivityPushSupport(
    params: ResolveLiveActivityPushSupportParams,
): LiveActivityPushSupport {
    const expoWidgetsPushNotificationsEnabled = readExpoWidgetsPushNotificationsEnabled(params.expoConfig);
    const reasons: LiveActivityPushSupportReason[] = [];

    if (!expoWidgetsPushNotificationsEnabled) {
        reasons.push('expo_widgets_push_notifications_disabled');
    }
    if (!params.tokenApisAvailable) {
        reasons.push('expo_widgets_token_api_missing');
    }

    return {
        expoWidgetsPushNotificationsEnabled,
        tokenApisAvailable: params.tokenApisAvailable,
        canRegisterRemoteTargets: reasons.length === 0,
        reasons,
    };
}

export function resolveCurrentLiveActivityPushSupport(params: Readonly<{
    tokenApisAvailable: boolean;
}>): LiveActivityPushSupport {
    return resolveLiveActivityPushSupport({
        expoConfig: Constants.expoConfig ?? null,
        tokenApisAvailable: params.tokenApisAvailable,
    });
}
