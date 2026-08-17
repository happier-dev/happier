import {
    resolveLiveActivityRemoteUpdateMode,
    type LiveActivityDirectApnsConfigurationDiagnostic,
    type LiveActivityRemoteUpdateCapabilityDiagnostics,
    type LiveActivityRemoteUpdateCapabilityReason,
    type LiveActivityRemoteUpdateMode,
    type LiveActivityRemoteUpdateModeResolutionReason,
} from '@happier-dev/protocol';

import type { TranslationKey } from '@/text';

export type LiveActivityRemoteUpdateDiagnosticsRowId =
    | 'effective_mode'
    | 'hosted_relay'
    | 'direct_apns'
    | 'background_wake'
    | 'local_only';

export type LiveActivityRemoteUpdateDiagnosticsRow = Readonly<{
    id: LiveActivityRemoteUpdateDiagnosticsRowId;
    titleKey: TranslationKey;
    subtitleKey: TranslationKey;
    detailKey: TranslationKey;
    icon: string;
    diagnosticKeys?: readonly LiveActivityDirectApnsConfigurationDiagnostic[];
}>;

export type BuildLiveActivityRemoteUpdateDiagnosticsRowsParams = Readonly<{
    preferredMode: LiveActivityRemoteUpdateMode;
    allowBackgroundWakeFallback: boolean;
    deviceModeOverride: 'account' | 'local_only' | 'disabled';
    diagnostics: LiveActivityRemoteUpdateCapabilityDiagnostics;
}>;

function hasReason(
    reasons: readonly LiveActivityRemoteUpdateCapabilityReason[],
    reason: LiveActivityRemoteUpdateCapabilityReason,
): boolean {
    return reasons.includes(reason);
}

function buildHostedRelayRow(
    diagnostics: LiveActivityRemoteUpdateCapabilityDiagnostics,
): LiveActivityRemoteUpdateDiagnosticsRow {
    const mode = diagnostics.modes.hosted_happier_relay;
    if (mode.available) {
        return {
            id: 'hosted_relay',
            titleKey: 'settingsNotifications.activitySurfaces.liveActivities.remoteUpdates.hostedRelayTitle',
            subtitleKey: 'settingsNotifications.activitySurfaces.liveActivities.remoteUpdates.hostedRelayAvailableSubtitle',
            detailKey: 'settingsNotifications.activitySurfaces.liveActivities.remoteUpdates.details.available',
            icon: 'cloud-check',
        };
    }
    if (hasReason(mode.reasons, 'hosted_relay_not_allowed')) {
        return {
            id: 'hosted_relay',
            titleKey: 'settingsNotifications.activitySurfaces.liveActivities.remoteUpdates.hostedRelayTitle',
            subtitleKey: 'settingsNotifications.activitySurfaces.liveActivities.remoteUpdates.hostedRelayDisabledSubtitle',
            detailKey: 'settingsNotifications.activitySurfaces.liveActivities.remoteUpdates.details.unavailable',
            icon: 'cloud-slash',
        };
    }
    if (hasReason(mode.reasons, 'hosted_relay_provider_blocked')) {
        return {
            id: 'hosted_relay',
            titleKey: 'settingsNotifications.activitySurfaces.liveActivities.remoteUpdates.hostedRelayTitle',
            subtitleKey: 'settingsNotifications.activitySurfaces.liveActivities.remoteUpdates.hostedRelayBlockedSubtitle',
            detailKey: 'settingsNotifications.activitySurfaces.liveActivities.remoteUpdates.details.blocked',
            icon: 'cloud-slash',
        };
    }
    return {
        id: 'hosted_relay',
        titleKey: 'settingsNotifications.activitySurfaces.liveActivities.remoteUpdates.hostedRelayTitle',
        subtitleKey: 'settingsNotifications.activitySurfaces.liveActivities.remoteUpdates.hostedRelayUnavailableSubtitle',
        detailKey: 'settingsNotifications.activitySurfaces.liveActivities.remoteUpdates.details.unavailable',
        icon: 'cloud-slash',
    };
}

function buildDirectApnsRow(
    diagnostics: LiveActivityRemoteUpdateCapabilityDiagnostics,
): LiveActivityRemoteUpdateDiagnosticsRow {
    const mode = diagnostics.modes.direct_apns;
    const diagnosticKeys = mode.configurationDiagnostics;
    if (mode.available) {
        return {
            id: 'direct_apns',
            titleKey: 'settingsNotifications.activitySurfaces.liveActivities.remoteUpdates.directApnsTitle',
            subtitleKey: 'settingsNotifications.activitySurfaces.liveActivities.remoteUpdates.directApnsConfiguredSubtitle',
            detailKey: 'settingsNotifications.activitySurfaces.liveActivities.remoteUpdates.details.available',
            icon: 'key',
            diagnosticKeys,
        };
    }
    if (diagnosticKeys.length > 0) {
        return {
            id: 'direct_apns',
            titleKey: 'settingsNotifications.activitySurfaces.liveActivities.remoteUpdates.directApnsTitle',
            subtitleKey: 'settingsNotifications.activitySurfaces.liveActivities.remoteUpdates.directApnsMissingCredentialsSubtitle',
            detailKey: 'settingsNotifications.activitySurfaces.liveActivities.remoteUpdates.details.missingCredentials',
            icon: 'key',
            diagnosticKeys,
        };
    }
    return {
        id: 'direct_apns',
        titleKey: 'settingsNotifications.activitySurfaces.liveActivities.remoteUpdates.directApnsTitle',
        subtitleKey: 'settingsNotifications.activitySurfaces.liveActivities.remoteUpdates.directApnsUnavailableSubtitle',
        detailKey: 'settingsNotifications.activitySurfaces.liveActivities.remoteUpdates.details.unavailable',
        icon: 'key',
        diagnosticKeys,
    };
}

function buildBackgroundWakeRow(
    diagnostics: LiveActivityRemoteUpdateCapabilityDiagnostics,
): LiveActivityRemoteUpdateDiagnosticsRow {
    const mode = diagnostics.modes.background_wake_best_effort;
    return {
        id: 'background_wake',
        titleKey: 'settingsNotifications.activitySurfaces.liveActivities.remoteUpdates.backgroundWakeTitle',
        subtitleKey: mode.available
            ? 'settingsNotifications.activitySurfaces.liveActivities.remoteUpdates.backgroundWakeBestEffortSubtitle'
            : 'settingsNotifications.activitySurfaces.liveActivities.remoteUpdates.backgroundWakeDisabledSubtitle',
        detailKey: mode.available
            ? 'settingsNotifications.activitySurfaces.liveActivities.remoteUpdates.details.bestEffort'
            : 'settingsNotifications.activitySurfaces.liveActivities.remoteUpdates.details.unavailable',
        icon: 'device-mobile',
    };
}

const EFFECTIVE_MODE_SUBTITLE_KEYS: Readonly<Record<LiveActivityRemoteUpdateMode, TranslationKey>> = {
    hosted_happier_relay: 'settingsNotifications.activitySurfaces.liveActivities.remoteUpdates.effectiveMode.hosted_happier_relay',
    direct_apns: 'settingsNotifications.activitySurfaces.liveActivities.remoteUpdates.effectiveMode.direct_apns',
    background_wake_best_effort: 'settingsNotifications.activitySurfaces.liveActivities.remoteUpdates.effectiveMode.background_wake_best_effort',
    local_only: 'settingsNotifications.activitySurfaces.liveActivities.remoteUpdates.effectiveMode.local_only',
    disabled: 'settingsNotifications.activitySurfaces.liveActivities.remoteUpdates.effectiveMode.disabled',
};

const MODE_RESOLUTION_DETAIL_KEYS: Readonly<Record<LiveActivityRemoteUpdateModeResolutionReason, TranslationKey>> = {
    selected: 'settingsNotifications.activitySurfaces.liveActivities.remoteUpdates.details.selected',
    fallback: 'settingsNotifications.activitySurfaces.liveActivities.remoteUpdates.details.fallback',
    preferred_unavailable: 'settingsNotifications.activitySurfaces.liveActivities.remoteUpdates.details.preferred_unavailable',
    local_only: 'settingsNotifications.activitySurfaces.liveActivities.remoteUpdates.details.local_only',
    disabled: 'settingsNotifications.activitySurfaces.liveActivities.remoteUpdates.details.disabled',
};

export function buildLiveActivityRemoteUpdateDiagnosticsRows(
    params: BuildLiveActivityRemoteUpdateDiagnosticsRowsParams,
): LiveActivityRemoteUpdateDiagnosticsRow[] {
    const selectedMode = params.deviceModeOverride === 'account'
        ? params.preferredMode
        : params.deviceModeOverride;
    const modeResolution = resolveLiveActivityRemoteUpdateMode({
        preferredMode: selectedMode,
        diagnostics: params.diagnostics,
        allowFallback: params.allowBackgroundWakeFallback,
    });

    return [
        {
            id: 'effective_mode',
            titleKey: 'settingsNotifications.activitySurfaces.liveActivities.remoteUpdates.effectiveModeTitle',
            subtitleKey: EFFECTIVE_MODE_SUBTITLE_KEYS[modeResolution.mode],
            detailKey: MODE_RESOLUTION_DETAIL_KEYS[modeResolution.reason],
            icon: 'arrows-left-right',
        },
        buildHostedRelayRow(params.diagnostics),
        buildDirectApnsRow(params.diagnostics),
        buildBackgroundWakeRow(params.diagnostics),
        {
            id: 'local_only',
            titleKey: 'settingsNotifications.activitySurfaces.liveActivities.remoteUpdates.localOnlyTitle',
            subtitleKey: 'settingsNotifications.activitySurfaces.liveActivities.remoteUpdates.localOnlyRuntimeSubtitle',
            detailKey: 'settingsNotifications.activitySurfaces.liveActivities.remoteUpdates.details.runtimeOnly',
            icon: 'device-mobile',
        },
    ];
}
