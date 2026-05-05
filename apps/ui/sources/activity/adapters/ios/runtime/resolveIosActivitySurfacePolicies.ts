import {
    resolveActivitySurfacePolicy,
    type ActivitySurfacePolicy,
    type ActivitySurfacePrivacyMode,
} from '@/activity/attention/resolveActivitySurfacePolicy';
import { AttentionDeviceOverridesV1Schema } from '@/sync/domains/settings/attentionDeviceOverridesV1';

type IosActivitySurfacePrivacyOverride = ActivitySurfacePrivacyMode | 'account';

export type IosActivitySurfacePolicies = Readonly<{
    liveActivityPolicy: ActivitySurfacePolicy;
    widgetPolicy: ActivitySurfacePolicy;
}>;

type LocalSettingsLike = Readonly<Record<string, unknown>>;

function resolvePrivacyMode(
    override: IosActivitySurfacePrivacyOverride,
    defaultMode: ActivitySurfacePrivacyMode,
): ActivitySurfacePrivacyMode {
    return override === 'account' ? defaultMode : override;
}

function applyLiveActivityPrivacy(
    basePolicy: ActivitySurfacePolicy,
    privacyMode: ActivitySurfacePrivacyMode,
): ActivitySurfacePolicy {
    return {
        ...basePolicy,
        privacyMode,
        liveActivities: {
            ...basePolicy.liveActivities,
            showPreviewText: privacyMode === 'include_preview',
        },
    };
}

function applyWidgetPrivacy(
    basePolicy: ActivitySurfacePolicy,
    privacyMode: ActivitySurfacePrivacyMode,
): ActivitySurfacePolicy {
    return {
        ...basePolicy,
        privacyMode,
        widgets: {
            ...basePolicy.widgets,
            showPreviewText: privacyMode === 'include_preview',
        },
    };
}

export function resolveIosActivitySurfacePolicies(params: Readonly<{
    localSettings: LocalSettingsLike;
}>): IosActivitySurfacePolicies {
    const basePolicy = resolveActivitySurfacePolicy(params.localSettings);
    const deviceOverrides = AttentionDeviceOverridesV1Schema.parse(
        params.localSettings.attentionDeviceOverridesV1,
    );

    const liveActivityPrivacyMode = resolvePrivacyMode(
        deviceOverrides.liveActivities.privacyMode,
        'status_only',
    );
    const widgetPrivacyMode = resolvePrivacyMode(
        deviceOverrides.widgets.privacyMode,
        'title_only',
    );

    return {
        liveActivityPolicy: applyLiveActivityPrivacy(basePolicy, liveActivityPrivacyMode),
        widgetPolicy: applyWidgetPrivacy(basePolicy, widgetPrivacyMode),
    };
}
