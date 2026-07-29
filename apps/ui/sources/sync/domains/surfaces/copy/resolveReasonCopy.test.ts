import { describe, expect, it } from 'vitest';

import type { BrowserAdapterUnavailableReasonCode } from '@/sync/domains/browser/adapters/availability';
import type { BrowserSurfaceUnavailableReason } from '@/components/browser/surfaces/BrowserSurfaceFallback';
import { t } from '@/text';

import { resolveReasonCopy } from './resolveReasonCopy';

// The full BrowserAdapterUnavailableReasonCode enum, restated as a const tuple so
// this test breaks (typecheck) if the source enum grows and the mapper does not.
const BROWSER_ADAPTER_REASON_CODES = [
    'desktop_engine_unavailable',
    'desktop_webview_child_view_unimplemented',
    'desktop_webview_linux_display_unavailable',
    'desktop_webview_native_command_unavailable',
    'desktop_webview_native_contract_invalid',
    'desktop_webview_unsupported_platform',
    'desktop_webview_wayland_gtk_unimplemented',
    'desktop_webview_x11_child_unimplemented',
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
    { code: 'missing_native_capability', expected: () => t('pluginRuntime.missingRequirement') },
    { code: 'required_permission_missing', expected: () => t('pluginRuntime.missingRequirement') },
    { code: 'entry_missing', expected: () => t('pluginRuntime.missingRequirement') },
    { code: 'runtime_mismatch', expected: () => t('pluginRuntime.missingRequirement') },
    { code: 'repack_script_manager_unavailable', expected: () => t('pluginRuntime.missingRequirement') },
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

    it('maps known plugin runtime codes to grouped human copy', () => {
        for (const { code, expected } of PLUGIN_RUNTIME_CODES) {
            const copy = resolveReasonCopy({ reasonCode: code, kind: 'pluginRuntime' });
            expect(copy.message).toBe(expected());
            expect(copy.message).not.toContain(code);
            expect(copy.diagnosticCode).toBe(code);
        }
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
