import type { BrowserSurfaceUnavailableReason } from '@/components/browser/surfaces/BrowserSurfaceFallback';
import type { BrowserAdapterUnavailableReasonCode } from '@/sync/domains/browser/adapters/availability';
import { t } from '@/text';

/**
 * The surface family a reason code is rendered into. Each kind selects the
 * vocabulary and the generic fallback so a surface never borrows another
 * surface's copy.
 */
export type ReasonCopyKind =
    | 'browserFrame' // BrowserAdapterUnavailableReasonCode (frame content)
    | 'browserStatus' // same vocabulary, status-bar surface
    | 'browserSurface' // BrowserSurfaceUnavailableReason (surface-state tokens)
    | 'browserLaunchpad' // launchpad-card disabledReason/detail tokens
    | 'localServiceLauncher' // local-service launcher reason/state tokens
    | 'localServiceInventory' // local-service inventory scan diagnostic codes
    | 'simulatorPreview' // simulator preview availability reason codes
    | 'streamPlayer' // live-stream player error/diagnostic reason codes
    | 'pluginRuntime'; // plugin runtime load/fallback diagnostic codes

export type ResolvedReasonCopy = Readonly<{
    /** Localized card title for terminal-state surfaces. */
    title: string;
    /** Localized, user-facing body. Never the raw reason code. */
    body: string;
    /** Optional localized next step. */
    nextStep?: string;
    /** Back-compat alias for body while existing inline/status callers migrate. */
    message: string;
    /** The raw input code, preserved for diagnostics-only surfaces (test-ids, logs). */
    diagnosticCode: string | null;
}>;

/**
 * Known browser frame / status reason codes → a localized message key.
 *
 * The full `BrowserAdapterUnavailableReasonCode` enum is covered, plus the
 * in-frame caller codes (`browser_profile_missing`,
 * `hosted_plugin_security_policy_blocked`, `invalid_url`, `owner_disconnected`)
 * that are interpolated at the frame chokepoint but are not part of the adapter
 * enum. Adjacent desktop-webview codes that carry no user-meaningful distinction
 * share one message while keeping their raw code on `diagnosticCode`.
 */
const BROWSER_REASON_KEYS = {
    desktop_engine_unavailable: 'browserShell.unavailable.desktopEngineUnavailable',
    desktop_webview_child_view_unimplemented: 'browserShell.unavailable.desktopWebView',
    desktop_webview_linux_display_unavailable: 'browserShell.unavailable.desktopWebView',
    desktop_webview_native_command_unavailable: 'browserShell.unavailable.desktopWebView',
    desktop_webview_native_contract_invalid: 'browserShell.unavailable.desktopWebView',
    desktop_webview_unsupported_platform: 'browserShell.unavailable.desktopWebViewUnsupportedPlatform',
    desktop_webview_wayland_gtk_unimplemented: 'browserShell.unavailable.desktopWebView',
    desktop_webview_x11_child_unimplemented: 'browserShell.unavailable.desktopWebView',
    electron_engine_unavailable: 'browserShell.unavailable.desktopEngineUnavailable',
    external_url_policy_denied: 'browserShell.unavailable.externalUrlPolicyDenied',
    external_url_unavailable: 'browserShell.unavailable.externalUrlUnavailable',
    simulator_preview_unavailable: 'browserShell.unavailable.simulatorPreviewUnavailable',
    sidecar_runtime_unavailable: 'browserShell.unavailable.sidecarRuntimeUnavailable',
    streamed_browser_unavailable: 'browserShell.unavailable.streamedBrowserUnavailable',
    tauri_host_unavailable: 'browserShell.unavailable.hostUnavailable',
    target_kind_unavailable: 'browserShell.unavailable.targetKindUnavailable',
    browser_profile_missing: 'browserShell.unavailable.browserProfileMissing',
    hosted_plugin_security_policy_blocked: 'browserShell.unavailable.hostedPluginBlocked',
    invalid_url: 'browserShell.unavailable.invalidUrl',
    owner_disconnected: 'browserShell.unavailable.ownerDisconnected',
} as const satisfies Record<
    BrowserAdapterUnavailableReasonCode | 'browser_profile_missing' | 'hosted_plugin_security_policy_blocked' | 'invalid_url' | 'owner_disconnected',
    BrowserMessageKey
>;

const BROWSER_SURFACE_KEYS = {
    disabled: 'browserShell.unavailable.surface.disabled',
    view_targets_disabled: 'browserShell.unavailable.surface.viewTargetsDisabled',
    host_lost: 'browserShell.unavailable.surface.hostLost',
    adapter_recovering: 'browserShell.unavailable.surface.adapterRecovering',
    live_state_lost: 'browserShell.unavailable.surface.liveStateLost',
    unsupported_target: 'browserShell.unavailable.surface.unsupportedTarget',
} as const satisfies Record<BrowserSurfaceUnavailableReason, BrowserSurfaceMessageKey>;

const LOCAL_SERVICE_LAUNCHER_KEYS = {
    launch_unavailable: 'localServices.launcher.unavailableReason.launchUnavailable',
    preview_registration_unavailable: 'localServices.launcher.unavailableReason.previewRegistrationUnavailable',
    browser_target_unavailable: 'localServices.launcher.unavailableReason.browserTargetUnavailable',
    starting: 'localServices.launcher.unavailableReason.starting',
    stale: 'localServices.launcher.unavailableReason.stale',
    unavailable: 'localServices.launcher.unavailableReason.unavailable',
} as const satisfies Record<string, LocalServiceLauncherMessageKey>;

type BrowserMessageKey =
    | 'browserShell.unavailable.desktopEngineUnavailable'
    | 'browserShell.unavailable.desktopWebView'
    | 'browserShell.unavailable.desktopWebViewUnsupportedPlatform'
    | 'browserShell.unavailable.externalUrlPolicyDenied'
    | 'browserShell.unavailable.externalUrlUnavailable'
    | 'browserShell.unavailable.simulatorPreviewUnavailable'
    | 'browserShell.unavailable.sidecarRuntimeUnavailable'
    | 'browserShell.unavailable.streamedBrowserUnavailable'
    | 'browserShell.unavailable.hostUnavailable'
    | 'browserShell.unavailable.targetKindUnavailable'
    | 'browserShell.unavailable.browserProfileMissing'
    | 'browserShell.unavailable.hostedPluginBlocked'
    | 'browserShell.unavailable.invalidUrl'
    | 'browserShell.unavailable.ownerDisconnected';

type BrowserSurfaceMessageKey =
    | 'browserShell.unavailable.surface.disabled'
    | 'browserShell.unavailable.surface.viewTargetsDisabled'
    | 'browserShell.unavailable.surface.hostLost'
    | 'browserShell.unavailable.surface.adapterRecovering'
    | 'browserShell.unavailable.surface.liveStateLost'
    | 'browserShell.unavailable.surface.unsupportedTarget';

const SIMULATOR_PREVIEW_KEYS = {
    no_simulator_devices: 'simulatorPreview.availability.noDevices',
    capture_unavailable: 'simulatorPreview.availability.captureUnavailable',
    capture_degraded: 'simulatorPreview.availability.captureDegraded',
    stream_degraded: 'simulatorPreview.availability.streamDegraded',
    stream_error: 'simulatorPreview.availability.streamUnavailable',
} as const satisfies Record<string, SimulatorPreviewMessageKey>;

const STREAM_PLAYER_KEYS = {
    permission_expired: 'streamPlayer.status.permissionExpired',
    lease_expired: 'streamPlayer.status.leaseExpired',
    low_bandwidth: 'streamPlayer.status.lowBandwidth',
    webcodecs_decoder_unavailable: 'streamPlayer.status.decoderUnavailable',
} as const satisfies Record<string, StreamPlayerMessageKey>;

/**
 * Plugin runtime load/fallback diagnostics grouped into three user-meaningful
 * families: crash-looped, disabled by policy/compatibility, and a missing
 * requirement on this device. The raw per-code distinction stays on
 * `diagnosticCode` for QA channels.
 */
const PLUGIN_RUNTIME_KEYS = {
    crash_threshold_reached: 'pluginRuntime.crashLoop',
    crash_disabled: 'pluginRuntime.crashLoop',
    feature_disabled: 'pluginRuntime.disabledByPolicy',
    feature_gate_disabled: 'pluginRuntime.disabledByPolicy',
    required_feature_disabled: 'pluginRuntime.disabledByPolicy',
    channel_policy_denied: 'pluginRuntime.disabledByPolicy',
    channel_denied: 'pluginRuntime.disabledByPolicy',
    platform_denied: 'pluginRuntime.disabledByPolicy',
    compatibility_platform_unsupported: 'pluginRuntime.disabledByPolicy',
    compatibility_channel_unsupported: 'pluginRuntime.disabledByPolicy',
    compatibility_feature_disabled: 'pluginRuntime.disabledByPolicy',
    profile_mode_unsupported: 'pluginRuntime.disabledByPolicy',
    missing_native_capability: 'pluginRuntime.missingRequirement',
    required_permission_missing: 'pluginRuntime.missingRequirement',
    entry_missing: 'pluginRuntime.missingRequirement',
    runtime_mismatch: 'pluginRuntime.missingRequirement',
    repack_script_manager_unavailable: 'pluginRuntime.missingRequirement',
} as const satisfies Record<string, PluginRuntimeMessageKey>;

type SimulatorPreviewMessageKey =
    | 'simulatorPreview.availability.noDevices'
    | 'simulatorPreview.availability.captureUnavailable'
    | 'simulatorPreview.availability.captureDegraded'
    | 'simulatorPreview.availability.streamDegraded'
    | 'simulatorPreview.availability.streamUnavailable';

type StreamPlayerMessageKey =
    | 'streamPlayer.status.permissionExpired'
    | 'streamPlayer.status.leaseExpired'
    | 'streamPlayer.status.lowBandwidth'
    | 'streamPlayer.status.decoderUnavailable';

type PluginRuntimeMessageKey =
    | 'pluginRuntime.crashLoop'
    | 'pluginRuntime.disabledByPolicy'
    | 'pluginRuntime.missingRequirement';

type LocalServiceLauncherMessageKey =
    | 'localServices.launcher.unavailableReason.launchUnavailable'
    | 'localServices.launcher.unavailableReason.previewRegistrationUnavailable'
    | 'localServices.launcher.unavailableReason.browserTargetUnavailable'
    | 'localServices.launcher.unavailableReason.starting'
    | 'localServices.launcher.unavailableReason.stale'
    | 'localServices.launcher.unavailableReason.unavailable';

function resolveGenericMessage(kind: ReasonCopyKind): string {
    switch (kind) {
        case 'browserLaunchpad':
            return t('browserLaunchpad.status.unavailableGeneric');
        case 'localServiceLauncher':
            return t('localServices.launcher.status.unavailableGeneric');
        case 'localServiceInventory':
            // Inventory scan diagnostics are scan-level facts, not per-service failures:
            // a neutral "scan needs attention" line, raw code kept on diagnosticCode only.
            return t('localServices.inventory.errorTitle');
        case 'simulatorPreview':
            return t('simulatorPreview.availability.unavailableGeneric');
        case 'streamPlayer':
            return t('streamPlayer.status.errorGeneric');
        case 'pluginRuntime':
            return t('pluginRuntime.unavailableGeneric');
        case 'browserFrame':
        case 'browserStatus':
        case 'browserSurface':
            return t('browserShell.unavailable.generic');
    }
}

function resolveTitle(kind: ReasonCopyKind): string {
    switch (kind) {
        case 'localServiceInventory':
            return t('localServices.inventory.errorTitle');
        case 'simulatorPreview':
        case 'streamPlayer':
            return t('streamPlayer.status.unavailable');
        case 'pluginRuntime':
        case 'browserFrame':
        case 'browserStatus':
        case 'browserSurface':
        case 'browserLaunchpad':
        case 'localServiceLauncher':
            return t('common.unavailable');
    }
}

function resolveKnownMessage(kind: ReasonCopyKind, reasonCode: string): string | null {
    switch (kind) {
        case 'browserFrame':
        case 'browserStatus': {
            const key = BROWSER_REASON_KEYS[reasonCode as keyof typeof BROWSER_REASON_KEYS];
            return key ? t(key) : null;
        }
        case 'browserSurface': {
            const key = BROWSER_SURFACE_KEYS[reasonCode as keyof typeof BROWSER_SURFACE_KEYS];
            return key ? t(key) : null;
        }
        case 'localServiceLauncher': {
            const key = LOCAL_SERVICE_LAUNCHER_KEYS[reasonCode as keyof typeof LOCAL_SERVICE_LAUNCHER_KEYS];
            return key ? t(key) : null;
        }
        case 'localServiceInventory':
            // No per-code inventory copy today: every scan diagnostic resolves to the
            // neutral generic, keeping the raw code on diagnosticCode for diagnostics.
            return null;
        case 'simulatorPreview': {
            const key = SIMULATOR_PREVIEW_KEYS[reasonCode as keyof typeof SIMULATOR_PREVIEW_KEYS];
            return key ? t(key) : null;
        }
        case 'streamPlayer': {
            const key = STREAM_PLAYER_KEYS[reasonCode as keyof typeof STREAM_PLAYER_KEYS];
            return key ? t(key) : null;
        }
        case 'pluginRuntime': {
            const key = PLUGIN_RUNTIME_KEYS[reasonCode as keyof typeof PLUGIN_RUNTIME_KEYS];
            return key ? t(key) : null;
        }
        case 'browserLaunchpad': {
            // Launchpad disabledReason/detail are free-form strings; a known browser
            // adapter code still maps cleanly, anything else uses the generic fallback.
            const key = BROWSER_REASON_KEYS[reasonCode as keyof typeof BROWSER_REASON_KEYS];
            return key ? t(key) : null;
        }
    }
}

/**
 * The ONE reason-code → product-copy mapper. Maps a known internal reason code
 * to a localized, user-facing message. Unknown codes fall back to a generic
 * localized "unavailable" message — the raw code is NEVER returned for primary
 * UI. The raw code is preserved on `diagnosticCode` for diagnostics-only
 * surfaces (test-ids, logs).
 */
export function resolveReasonCopy(input: Readonly<{
    reasonCode: string | null | undefined;
    kind: ReasonCopyKind;
}>): ResolvedReasonCopy {
    const rawCode = input.reasonCode ?? null;
    const title = resolveTitle(input.kind);
    if (rawCode === null || rawCode === '') {
        const body = resolveGenericMessage(input.kind);
        return {
            title,
            body,
            message: body,
            diagnosticCode: rawCode === '' ? '' : null,
        };
    }
    const known = resolveKnownMessage(input.kind, rawCode);
    const body = known ?? resolveGenericMessage(input.kind);
    return {
        title,
        body,
        message: body,
        diagnosticCode: rawCode,
    };
}
