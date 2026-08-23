import { describe, expect, it } from 'vitest';

import type { BrowserAdapterUnavailableReasonCode } from '@/sync/domains/browser/adapters/availability';
import type { BrowserSurfaceUnavailableReason } from '@/components/browser/surfaces/BrowserSurfaceFallback';
import { t } from '@/text';

import {
    resolvePluginSurfaceStatePresentation,
    resolveReasonCopy,
} from './resolveReasonCopy';

// The full BrowserAdapterUnavailableReasonCode enum, restated as a const tuple so
// this test breaks (typecheck) if the source enum grows and the mapper does not.
const BROWSER_ADAPTER_REASON_CODES = [
    'desktop_engine_unavailable',
    'desktop_webview_child_view_unverified',
    'desktop_webview_linux_display_unavailable',
    'desktop_webview_native_command_unavailable',
    'desktop_webview_native_contract_invalid',
    'desktop_webview_unsupported_platform',
    'desktop_webview_wayland_gtk_unimplemented',
    'desktop_webview_x11_child_unverified',
    'electron_engine_unavailable',
    'external_url_policy_denied',
    'external_url_unavailable',
    'simulator_preview_unavailable',
    'sidecar_runtime_unavailable',
    'streamed_browser_unavailable',
    'tauri_host_unavailable',
    'target_kind_unavailable',
] as const satisfies readonly BrowserAdapterUnavailableReasonCode[];

// Caller codes that are interpolated at frame chokepoints but are not part of the
// adapter enum (BrowserFrameUnavailable callers).
const BROWSER_FRAME_CALLER_CODES = [
    'browser_profile_missing',
    'hosted_plugin_security_policy_blocked',
    'invalid_url',
    'owner_disconnected',
] as const;

const BROWSER_SURFACE_CODES = [
    'disabled',
    'view_targets_disabled',
    'host_lost',
    'adapter_recovering',
    'live_state_lost',
    'unsupported_target',
] as const satisfies readonly BrowserSurfaceUnavailableReason[];

// Launcher codes paired with the dedicated localized key they must resolve to.
// Word-ish state tokens (`starting`, `stale`, `unavailable`) can legitimately appear
// as a substring of their human copy, so we assert exact-key equality (never the raw
// `Unavailable: <token>` form) rather than a substring check.
const LOCAL_SERVICE_LAUNCHER_CODES = [
    { code: 'launch_unavailable', key: 'localServices.launcher.unavailableReason.launchUnavailable' },
    { code: 'preview_registration_unavailable', key: 'localServices.launcher.unavailableReason.previewRegistrationUnavailable' },
    { code: 'browser_target_unavailable', key: 'localServices.launcher.unavailableReason.browserTargetUnavailable' },
    { code: 'starting', key: 'localServices.launcher.unavailableReason.starting' },
    { code: 'stale', key: 'localServices.launcher.unavailableReason.stale' },
    { code: 'unavailable', key: 'localServices.launcher.unavailableReason.unavailable' },
] as const;

describe('resolveReasonCopy', () => {
    it('maps every browser-frame adapter code to a non-empty message that never leaks the raw code', () => {
        for (const reasonCode of BROWSER_ADAPTER_REASON_CODES) {
            const copy = resolveReasonCopy({ reasonCode, kind: 'browserFrame' });
            expect(copy.message.length).toBeGreaterThan(0);
            expect(copy.message).not.toContain(reasonCode);
            expect(copy.diagnosticCode).toBe(reasonCode);
        }
    });

    it('maps the in-frame caller codes (not in the adapter enum) without leaking the raw code', () => {
        for (const reasonCode of BROWSER_FRAME_CALLER_CODES) {
            const copy = resolveReasonCopy({ reasonCode, kind: 'browserFrame' });
            expect(copy.message.length).toBeGreaterThan(0);
            expect(copy.message).not.toContain(reasonCode);
            expect(copy.diagnosticCode).toBe(reasonCode);
        }
    });

    it('maps browser-status codes the same as browser-frame codes', () => {
        for (const reasonCode of BROWSER_ADAPTER_REASON_CODES) {
            const copy = resolveReasonCopy({ reasonCode, kind: 'browserStatus' });
            expect(copy.message.length).toBeGreaterThan(0);
            expect(copy.message).not.toContain(reasonCode);
            expect(copy.diagnosticCode).toBe(reasonCode);
        }
    });

    it('maps every browser-surface state token to a non-empty message without leaking the raw token', () => {
        for (const reasonCode of BROWSER_SURFACE_CODES) {
            const copy = resolveReasonCopy({ reasonCode, kind: 'browserSurface' });
            expect(copy.message.length).toBeGreaterThan(0);
            expect(copy.message).not.toContain(reasonCode);
            expect(copy.diagnosticCode).toBe(reasonCode);
        }
    });

    it('maps every local-service launcher code to its dedicated localized message (never the raw token)', () => {
        for (const { code, key } of LOCAL_SERVICE_LAUNCHER_CODES) {
            const copy = resolveReasonCopy({ reasonCode: code, kind: 'localServiceLauncher' });
            expect(copy.message.length).toBeGreaterThan(0);
            // routes through the dedicated key, never the raw `Unavailable: <token>` form or bare token.
            expect(copy.message).toBe(t(key));
            expect(copy.message).not.toBe(code);
            expect(copy.message).not.toBe(`Unavailable: ${code}`);
            expect(copy.diagnosticCode).toBe(code);
        }
    });

    it('falls back to the per-kind generic message for an unknown code and stamps the raw code on diagnosticCode', () => {
        const browserFrame = resolveReasonCopy({ reasonCode: 'totally_unknown_code', kind: 'browserFrame' });
        expect(browserFrame.message.length).toBeGreaterThan(0);
        expect(browserFrame.message).not.toContain('totally_unknown_code');
        expect(browserFrame.diagnosticCode).toBe('totally_unknown_code');

        const browserStatus = resolveReasonCopy({ reasonCode: 'totally_unknown_code', kind: 'browserStatus' });
        expect(browserStatus.message).toBe(browserFrame.message);

        const browserSurface = resolveReasonCopy({ reasonCode: 'totally_unknown_code', kind: 'browserSurface' });
        expect(browserSurface.message).toBe(browserFrame.message);

        const launchpad = resolveReasonCopy({ reasonCode: 'totally_unknown_code', kind: 'browserLaunchpad' });
        expect(launchpad.message.length).toBeGreaterThan(0);
        expect(launchpad.message).not.toContain('totally_unknown_code');
        expect(launchpad.diagnosticCode).toBe('totally_unknown_code');

        const launcher = resolveReasonCopy({ reasonCode: 'totally_unknown_code', kind: 'localServiceLauncher' });
        expect(launcher.message.length).toBeGreaterThan(0);
        expect(launcher.message).not.toContain('totally_unknown_code');
        expect(launcher.diagnosticCode).toBe('totally_unknown_code');
    });

    it('the per-kind generic messages are distinct where the packet requires distinct keys', () => {
        const browserFrame = resolveReasonCopy({ reasonCode: null, kind: 'browserFrame' });
        const launchpad = resolveReasonCopy({ reasonCode: null, kind: 'browserLaunchpad' });
        const launcher = resolveReasonCopy({ reasonCode: null, kind: 'localServiceLauncher' });
        expect(launchpad.message).not.toBe(browserFrame.message);
        expect(launcher.message).not.toBe(browserFrame.message);
        expect(launcher.message).not.toBe(launchpad.message);
    });

    it('returns the per-kind generic message and a null diagnosticCode for a null or undefined reason', () => {
        const fromNull = resolveReasonCopy({ reasonCode: null, kind: 'browserFrame' });
        const fromUndefined = resolveReasonCopy({ reasonCode: undefined, kind: 'browserFrame' });
        expect(fromNull.message.length).toBeGreaterThan(0);
        expect(fromNull.diagnosticCode).toBeNull();
        expect(fromUndefined.message).toBe(fromNull.message);
        expect(fromUndefined.diagnosticCode).toBeNull();
    });

    it('maps inventory scan diagnostic codes to a neutral message, keeping the raw code only on diagnosticCode', () => {
        for (const reasonCode of ['scanner_permission_denied', 'launcher_snapshot_unavailable']) {
            const copy = resolveReasonCopy({ reasonCode, kind: 'localServiceInventory' });
            expect(copy.message.length).toBeGreaterThan(0);
            expect(copy.message).not.toContain(reasonCode);
            expect(copy.diagnosticCode).toBe(reasonCode);
        }
    });

    it('never returns the raw code as the message for any kind', () => {
        const unknownByKind = [
            resolveReasonCopy({ reasonCode: 'raw_leak_probe', kind: 'browserFrame' }),
            resolveReasonCopy({ reasonCode: 'raw_leak_probe', kind: 'browserStatus' }),
            resolveReasonCopy({ reasonCode: 'raw_leak_probe', kind: 'browserSurface' }),
            resolveReasonCopy({ reasonCode: 'raw_leak_probe', kind: 'browserLaunchpad' }),
            resolveReasonCopy({ reasonCode: 'raw_leak_probe', kind: 'localServiceLauncher' }),
            resolveReasonCopy({ reasonCode: 'raw_leak_probe', kind: 'localServiceInventory' }),
        ];
        for (const copy of unknownByKind) {
            expect(copy.message).not.toBe('raw_leak_probe');
            expect(copy.message).not.toContain('raw_leak_probe');
        }
    });
});

// ---------------------------------------------------------------------------
// L0-3 (RU2 capstone) — simulator / stream-player / plugin-runtime kinds.
// ---------------------------------------------------------------------------

const SIMULATOR_PREVIEW_CODES = [
    { code: 'no_simulator_devices', expected: () => t('simulatorPreview.availability.noDevices') },
    { code: 'capture_unavailable', expected: () => t('simulatorPreview.availability.captureUnavailable') },
    { code: 'capture_degraded', expected: () => t('simulatorPreview.availability.captureDegraded') },
    { code: 'stream_degraded', expected: () => t('simulatorPreview.availability.streamDegraded') },
    { code: 'stream_error', expected: () => t('simulatorPreview.availability.streamUnavailable') },
] as const;

const STREAM_PLAYER_CODES = [
    { code: 'permission_expired', expected: () => t('streamPlayer.status.permissionExpired') },
    { code: 'lease_expired', expected: () => t('streamPlayer.status.leaseExpired') },
    { code: 'low_bandwidth', expected: () => t('streamPlayer.status.lowBandwidth') },
    { code: 'webcodecs_decoder_unavailable', expected: () => t('streamPlayer.status.decoderUnavailable') },
] as const;

const PLUGIN_RUNTIME_CODES = [
    { code: 'crash_threshold_reached', expected: () => t('pluginRuntime.crashLoop') },
    { code: 'crash_disabled', expected: () => t('pluginRuntime.crashLoop') },
    { code: 'feature_disabled', expected: () => t('pluginRuntime.disabledByPolicy') },
    { code: 'feature_gate_disabled', expected: () => t('pluginRuntime.disabledByPolicy') },
    { code: 'required_feature_disabled', expected: () => t('pluginRuntime.disabledByPolicy') },
    { code: 'channel_policy_denied', expected: () => t('pluginRuntime.disabledByPolicy') },
    { code: 'channel_denied', expected: () => t('pluginRuntime.disabledByPolicy') },
    { code: 'platform_denied', expected: () => t('pluginRuntime.disabledByPolicy') },
    { code: 'compatibility_platform_unsupported', expected: () => t('pluginRuntime.disabledByPolicy') },
    { code: 'compatibility_channel_unsupported', expected: () => t('pluginRuntime.disabledByPolicy') },
    { code: 'compatibility_feature_disabled', expected: () => t('pluginRuntime.disabledByPolicy') },
    { code: 'profile_mode_unsupported', expected: () => t('pluginRuntime.disabledByPolicy') },
    { code: 'hosted_web_policy_denied', expected: () => t('pluginRuntime.hostedWebPolicyDenied') },
    { code: 'hosted_web_endpoint_policy_denied', expected: () => t('pluginRuntime.hostedWebEndpointPolicyDenied') },
    { code: 'e2ee_unavailable', expected: () => t('pluginRuntime.missingRequirement') },
    { code: 'artifact_hosting_unsupported', expected: () => t('pluginRuntime.missingRequirement') },
    { code: 'artifact_hosting_not_opted_in', expected: () => t('pluginRuntime.disabledByPolicy') },
    { code: 'hosted_web_static_artifact_missing', expected: () => t('pluginRuntime.missingRequirement') },
    { code: 'hosted_web_frame_adapter_unavailable', expected: () => t('pluginRuntime.missingRequirement') },
    { code: 'missing_native_capability', expected: () => t('pluginRuntime.missingRequirement') },
    { code: 'required_permission_missing', expected: () => t('pluginRuntime.missingRequirement') },
    { code: 'entry_missing', expected: () => t('pluginRuntime.missingRequirement') },
    { code: 'runtime_mismatch', expected: () => t('pluginRuntime.missingRequirement') },
    { code: 'repack_script_manager_unavailable', expected: () => t('pluginRuntime.missingRequirement') },
    { code: 'transport_unavailable', expected: () => t('pluginRuntime.unavailableGeneric') },
] as const;

// These are pane-local terminal facts produced after the projection and
// capability owners have already decided admission. Each one needs distinct
// recovery copy: grouping them behind the generic plugin-runtime fallback
// hides whether a refresh, a policy update, or an author-side fix is needed.
const HOSTED_WEB_LOCAL_TERMINAL_CODES = [
    'hosted_web_policy_denied',
    'hosted_web_sandbox_unavailable',
    'hosted_web_security_unavailable',
    'hosted_web_frame_origin_unavailable',
    'hosted_web_bridge_nonce_unavailable',
    'hosted_web_bridge_timeout',
    'hosted_web_endpoint_policy_denied',
] as const;

describe('resolveReasonCopy — simulator / stream / plugin-runtime kinds (L0-3)', () => {
    it('returns the canonical remediation-copy shape for surface state cards', () => {
        const copy = resolveReasonCopy({ reasonCode: 'no_simulator_devices', kind: 'simulatorPreview' });
        expect(copy.title).toBe(t('streamPlayer.status.unavailable'));
        expect(copy.body).toBe(t('simulatorPreview.availability.noDevices'));
        expect(copy.message).toBe(copy.body);
        expect(copy.nextStep).toBeUndefined();
        expect(copy.diagnosticCode).toBe('no_simulator_devices');
    });

    it('maps known simulator preview codes to their availability copy', () => {
        for (const { code, expected } of SIMULATOR_PREVIEW_CODES) {
            const copy = resolveReasonCopy({ reasonCode: code, kind: 'simulatorPreview' });
            expect(copy.body).toBe(expected());
            expect(copy.message).toBe(copy.body);
            expect(copy.body).not.toContain(code);
            expect(copy.diagnosticCode).toBe(code);
        }
    });

    it('maps known stream player codes to human copy and never leaks the raw code', () => {
        for (const { code, expected } of STREAM_PLAYER_CODES) {
            const copy = resolveReasonCopy({ reasonCode: code, kind: 'streamPlayer' });
            expect(copy.message).toBe(expected());
            expect(copy.message).not.toContain(code);
            expect(copy.diagnosticCode).toBe(code);
        }
    });

    it('maps known plugin runtime codes to their intended human copy', () => {
        for (const { code, expected } of PLUGIN_RUNTIME_CODES) {
            const copy = resolveReasonCopy({ reasonCode: code, kind: 'pluginRuntime' });
            expect(copy.message).toBe(expected());
            expect(copy.message).not.toContain(code);
            expect(copy.diagnosticCode).toBe(code);
        }
    });

    it('maps local hosted-web terminal facts to distinct recovery copy instead of a generic runtime fallback', () => {
        const genericRuntimeCopy = new Set([
            t('pluginRuntime.unavailableGeneric'),
            t('pluginRuntime.disabledByPolicy'),
            t('pluginRuntime.missingRequirement'),
        ]);
        const copies = HOSTED_WEB_LOCAL_TERMINAL_CODES.map((reasonCode) => {
            const copy = resolveReasonCopy({ reasonCode, kind: 'pluginRuntime' });
            expect(copy.body.length).toBeGreaterThan(0);
            expect(copy.body).not.toContain(reasonCode);
            expect(copy.body).not.toBe(t('pluginRuntime.unavailableGeneric'));
            expect(genericRuntimeCopy.has(copy.body)).toBe(false);
            expect(copy.diagnosticCode).toBe(reasonCode);
            return copy.body;
        });

        expect(new Set(copies)).toHaveLength(HOSTED_WEB_LOCAL_TERMINAL_CODES.length);
    });

    it('falls back to a per-kind generic for unknown codes on the new kinds', () => {
        for (const kind of ['simulatorPreview', 'streamPlayer', 'pluginRuntime'] as const) {
            const copy = resolveReasonCopy({ reasonCode: 'raw_leak_probe', kind });
            expect(copy.message.length).toBeGreaterThan(0);
            expect(copy.message).not.toContain('raw_leak_probe');
            expect(copy.diagnosticCode).toBe('raw_leak_probe');
        }
    });

    it('the new per-kind generics are meaningful and distinct from the raw badge label', () => {
        const simulator = resolveReasonCopy({ reasonCode: null, kind: 'simulatorPreview' });
        const stream = resolveReasonCopy({ reasonCode: null, kind: 'streamPlayer' });
        const plugin = resolveReasonCopy({ reasonCode: null, kind: 'pluginRuntime' });
        expect(simulator.message.length).toBeGreaterThan(3);
        expect(stream.message.length).toBeGreaterThan(3);
        expect(plugin.message.length).toBeGreaterThan(3);
        expect(simulator.message).not.toBe(plugin.message);
    });
});

describe('resolvePluginSurfaceStatePresentation', () => {
    it('keeps last-known-good content distinct from an initial or terminal replacement state', () => {
        const available = resolvePluginSurfaceStatePresentation({
            state: 'available',
            reasonCode: 'raw_machine_probe',
        });
        expect(available).toMatchObject({
            disposition: 'content',
            diagnosticCode: 'raw_machine_probe',
            card: null,
        });

        for (const state of ['loading', 'refreshing', 'stale', 'offline', 'unavailable', 'failedRetry'] as const) {
            const retained = resolvePluginSurfaceStatePresentation({
                state,
                reasonCode: 'raw_machine_probe',
                hasRetainedContent: true,
            });
            expect(retained, state).toMatchObject({
                disposition: 'retain',
                diagnosticCode: 'raw_machine_probe',
                card: null,
                contentNotice: {
                    accessibilitySemantics: 'status',
                },
            });
            expect(retained.contentNotice?.title.length, state).toBeGreaterThan(0);
            expect(retained.contentNotice?.reason.length, state).toBeGreaterThan(0);
            expect(retained.contentNotice?.reason, state).not.toContain('raw_machine_probe');
        }
        for (const state of ['loading', 'refreshing', 'stale', 'offline'] as const) {
            const retained = resolvePluginSurfaceStatePresentation({
                state,
                reasonCode: 'raw_machine_probe',
                hasRetainedContent: true,
            });
            expect(retained.contentNotice).toEqual({
                title: t(`pluginSurfaces.state.${state}.title`),
                reason: t(`pluginSurfaces.state.${state}.reason`),
                accessibilitySemantics: 'status',
            });
        }

        const initialLoading = resolvePluginSurfaceStatePresentation({
            state: 'loading',
            reasonCode: 'raw_machine_probe',
        });
        const refreshWithoutLkg = resolvePluginSurfaceStatePresentation({
            state: 'refreshing',
            reasonCode: 'raw_machine_probe',
        });
        expect(initialLoading).toMatchObject({
            disposition: 'replace',
            card: { kind: 'loading', accessibilitySemantics: 'status' },
        });
        expect(refreshWithoutLkg).toMatchObject({
            disposition: 'replace',
            card: { kind: 'loading', accessibilitySemantics: 'status' },
        });

        for (const state of ['stale', 'offline', 'unavailable'] as const) {
            const terminal = resolvePluginSurfaceStatePresentation({
                state,
                reasonCode: 'raw_machine_probe',
            });
            expect(terminal, state).toMatchObject({
                disposition: 'replace',
                card: { kind: 'unavailable', accessibilitySemantics: 'status' },
            });
            expect(terminal.card?.reason).not.toContain('raw_machine_probe');
        }

        const failedRetry = resolvePluginSurfaceStatePresentation({
            state: 'failedRetry',
            reasonCode: 'raw_machine_probe',
        });
        expect(failedRetry).toMatchObject({
            disposition: 'replace',
            card: { kind: 'error', accessibilitySemantics: 'alert' },
        });
        expect(failedRetry.card?.reason).not.toContain('raw_machine_probe');
    });

    it('maps each daemon-issued RN reset state to its localized card or content notice', () => {
        const requested = resolvePluginSurfaceStatePresentation({
            state: 'loading',
            copyVariant: 'pluginReactNativeResetRequested',
        });
        expect(requested).toMatchObject({
            disposition: 'replace',
            card: {
                kind: 'loading',
                title: t('pluginReactNative.reset.requested.title'),
                reason: t('pluginReactNative.reset.requested.reason'),
                accessibilitySemantics: 'status',
            },
            contentNotice: null,
        });

        const awaitingProjection = resolvePluginSurfaceStatePresentation({
            state: 'loading',
            copyVariant: 'pluginReactNativeResetAwaitingProjection',
        });
        expect(awaitingProjection).toMatchObject({
            disposition: 'replace',
            card: {
                kind: 'loading',
                title: t('pluginReactNative.reset.awaitingProjection.title'),
                reason: t('pluginReactNative.reset.awaitingProjection.reason'),
                accessibilitySemantics: 'status',
            },
            contentNotice: null,
        });
        expect(awaitingProjection.card?.title).not.toBe(requested.card?.title);

        const failed = resolvePluginSurfaceStatePresentation({
            state: 'failedRetry',
            copyVariant: 'pluginReactNativeResetFailed',
        });
        expect(failed).toMatchObject({
            disposition: 'replace',
            card: {
                kind: 'error',
                title: t('pluginReactNative.reset.failed.title'),
                reason: t('pluginReactNative.reset.failed.reason'),
                accessibilitySemantics: 'alert',
            },
            contentNotice: null,
        });

        const completed = resolvePluginSurfaceStatePresentation({
            state: 'available',
            copyVariant: 'pluginReactNativeResetComplete',
        });

        expect(completed).toMatchObject({
            disposition: 'content',
            card: null,
            contentNotice: {
                title: t('pluginReactNative.reset.complete.title'),
                reason: t('pluginReactNative.reset.complete.reason'),
                accessibilitySemantics: 'status',
            },
        });
    });
});
