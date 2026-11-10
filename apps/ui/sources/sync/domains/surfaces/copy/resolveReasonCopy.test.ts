import { describe, expect, it } from 'vitest';

import type { BrowserAdapterUnavailableReasonCode } from '@/sync/domains/browser/adapters/availability';
import type { BrowserSurfaceUnavailableReason } from '@/components/browser/surfaces/BrowserSurfaceFallback';
import { preloadTranslations, setPreferredLanguageFromSettings, SUPPORTED_LANGUAGE_CODES, t } from '@/text';

import {
  isLocalServiceActionRefusedByPolicy,
  resolvePluginSurfaceStatePresentation,
  resolveReasonCopy,
} from './resolveReasonCopy';

it('explains a local native artifact failure through the runtime reason owner', () => {
  const copy = resolveReasonCopy({ kind: 'pluginRuntime', reasonCode: 'local_artifact_failure' });
  expect(copy.body).toBe(t('pluginRuntime.localArtifactFailure'));
  expect(copy.diagnosticCode).toBe('local_artifact_failure');
  expect(resolvePluginSurfaceStatePresentation({ state: 'failedRetry', reasonCode: 'local_artifact_failure' }).recoveryAction?.kind).toBe('retry');
});

describe('Preview sharing policy refusal copy', () => {
  it.each(SUPPORTED_LANGUAGE_CODES)('names only the refused port in %s', async language => {
    await preloadTranslations(language);
    setPreferredLanguageFromSettings(language);
    try {
      const copy = resolveReasonCopy({ kind: 'browserFrame', reasonCode: 'destination_port_not_allowed', port: 5173 });
      expect(copy.body).toContain('5173');
      expect(copy.body).not.toContain('destination_port_not_allowed');
      expect(copy.body).not.toBe(resolveReasonCopy({ kind: 'browserFrame', reasonCode: 'preview_transport_unavailable' }).body);
      expect(copy.diagnosticCode).toBe('destination_port_not_allowed');
    } finally { setPreferredLanguageFromSettings('en'); }
  });
});

describe('Service refusal recovery copy', () => {
  it('presents an ineligible people audience as a refusal rather than a retryable failure', () => {
    const copy = resolveReasonCopy({ kind: 'localServiceAction', reasonCode: 'audience_not_eligible' });
    expect(copy.body).toBe(t('localServices.actions.failure.unavailable'));
    expect(copy.diagnosticCode).toBe('audience_not_eligible');
  });
  it.each(SUPPORTED_LANGUAGE_CODES)('presents a named start failure without repeating recovery in %s', async language => {
    await preloadTranslations(language);
    setPreferredLanguageFromSettings(language);
    try {
      const copy = resolveReasonCopy({ kind: 'localServiceAction', reasonCode: 'plugin_managed_service_establishment_failed',
        serviceName: 'Lumen web', servicesActionOffered: true });
      const withDetails = resolveReasonCopy({ kind: 'localServiceAction', reasonCode: 'plugin_managed_service_establishment_failed',
        serviceName: 'Lumen web', servicesActionOffered: true,
        establishmentFailure: { cause: 'process_exited', exitCode: 1 } });
      expect(withDetails.body).toBe(copy.body);
      expect(copy.body).toContain('Lumen web');
      expect(copy.body).not.toContain(t('localServices.row.reviewOutput'));
      expect(copy.body).not.toContain('plugin_managed_service_establishment_failed');
      expect(copy.body).not.toContain(':');
      expect(copy.title).not.toBe(resolveReasonCopy({ kind: 'browserFrame', reasonCode: 'preview_ended' }).title);
      expect(copy.title).not.toBe(resolveReasonCopy({ kind: 'localServiceAction', reasonCode: null }).title);
      if (language === 'en') {
        expect(copy.title).toBe('Service couldn’t start');
        expect(copy.body).toBe('Lumen web stopped before it was ready.');
      }
    } finally { setPreferredLanguageFromSettings('en'); }
  });
  it.each(SUPPORTED_LANGUAGE_CODES)('keeps guidance only without a Services action (%s)', async language => {
    await preloadTranslations(language);
    setPreferredLanguageFromSettings(language);
    try {
      for (const reasonCode of [
        'service_not_listening', 'unknown_managed_service', 'preview_target_unresolved',
        'preview_registration_failed', 'preview_hostname_collision', 'preview_server_unavailable',
        'permission_denied', 'action_outcome_unknown', 'unmapped_preview_failure',
      ]) {
        const input = { kind: 'localServiceAction' as const, reasonCode, serviceName: 'Reading desk' };
        const guided = resolveReasonCopy(input);
        const card = resolveReasonCopy({ ...input, servicesActionOffered: true });
        expect(card.body, reasonCode).toContain(input.serviceName);
        expect(card.body, reasonCode).not.toBe(guided.body);
        expect(card.body.length, reasonCode).toBeLessThan(guided.body.length);
        expect(card.diagnosticCode).toBe(reasonCode);
        expect(resolveReasonCopy({ ...input, servicesActionOffered: false }).body).toBe(guided.body);
        if (language === 'en') expect(card.body).not.toMatch(/check Services|try again|permissions and/iu);
      }
      if (language === 'en') {
        expect(resolveReasonCopy({ kind: 'localServiceAction', reasonCode: 'service_not_listening',
          serviceName: 'Reading desk', servicesActionOffered: true }).body).toBe('Reading desk isn’t running anymore.');
      }
    } finally {
      setPreferredLanguageFromSettings('en');
    }
  });
});

describe('Service action failure naming', () => {
  it.each(SUPPORTED_LANGUAGE_CODES)('says the in-app browser view is missing, not the Service or the Machine (%s)', async language => {
    await preloadTranslations(language);
    setPreferredLanguageFromSettings(language);
    try {
      const view = resolveReasonCopy({ kind: 'localServiceAction', reasonCode: 'browser_view_unavailable' });
      expect(view.body).not.toBe(resolveReasonCopy({ kind: 'localServiceAction', reasonCode: 'browser_adapter_unavailable' }).body);
      expect(view.body).not.toBe(resolveReasonCopy({ kind: 'localServiceAction', reasonCode: null }).body);
      expect(view.diagnosticCode).toBe('browser_view_unavailable');
    } finally { setPreferredLanguageFromSettings('en'); }
  });
  it('does not repeat the Service as a prefix under a title that already names it', () => {
    const input = { kind: 'localServiceAction' as const, reasonCode: 'preview_registration_failed', serviceName: 'Lumen web' };
    expect(resolveReasonCopy(input).body.startsWith('Lumen web: ')).toBe(true);
    expect(resolveReasonCopy({ ...input, serviceNamedByTitle: true }).body.startsWith('Lumen web')).toBe(false);
  });
  it('treats only a policy the person can change as a refusal', () => {
    expect(isLocalServiceActionRefusedByPolicy('permission_denied')).toBe(true);
    expect(isLocalServiceActionRefusedByPolicy('browser_view_unavailable')).toBe(false);
    expect(isLocalServiceActionRefusedByPolicy(null)).toBe(false);
  });
});

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
  {
    code: 'launch_unavailable',
    key: 'localServices.launcher.unavailableReason.launchUnavailable',
  },
  {
    code: 'preview_registration_unavailable',
    key: 'localServices.launcher.unavailableReason.previewRegistrationUnavailable',
  },
  {
    code: 'browser_target_unavailable',
    key: 'localServices.launcher.unavailableReason.browserTargetUnavailable',
  },
  {
    code: 'starting',
    key: 'localServices.launcher.unavailableReason.starting',
  },
  { code: 'stale', key: 'localServices.launcher.unavailableReason.stale' },
  {
    code: 'unavailable',
    key: 'localServices.launcher.unavailableReason.unavailable',
  },
] as const;

describe('resolveReasonCopy', () => {
  it('explains a launchpad catalog refresh failure with its specific recovery copy', () => {
    const copy = resolveReasonCopy({ reasonCode: 'local_service_preview_refresh_failed', kind: 'browserLaunchpad' });
    expect(copy.body).not.toBe(t('browserLaunchpad.status.unavailableGeneric'));
    expect(copy.body).not.toContain('local_service_preview_refresh_failed');
    expect(copy.diagnosticCode).toBe('local_service_preview_refresh_failed');
  });
  it('gives withdrawn plugin views a configuration recovery instead of a startup diagnosis', () => {
    for (const reasonCode of ['artifact_not_current', 'artifact_lease_revoked'] as const) {
      const presentation = resolvePluginSurfaceStatePresentation({ state: 'unavailable', reasonCode });
      expect(presentation.card?.reason).not.toBe(t('pluginRuntime.unavailableGeneric'));
      expect(presentation.card?.reason).not.toBe(t('pluginRuntime.sourceUnavailable'));
      expect(presentation.recoveryAction?.kind).toBe('managePlugin');
      expect(presentation.diagnosticCode).toBe(reasonCode);
    }
  });

  it('uses a bounded Resource diagnostic under a generic transport envelope for copy and recovery', () => {
    const presentation = resolvePluginSurfaceStatePresentation({
      state: 'unavailable',
      reasonCode: 'unavailable',
      diagnostics: [
        'private detail must not render',
        'plugin_collection_contract_conflict',
      ],
    });
    expect(presentation.card?.reason).not.toBe(
      t('pluginRuntime.unavailableGeneric'),
    );
    expect(presentation.card?.reason).not.toContain('private detail');
    expect(presentation.diagnosticCode).toBe(
      'plugin_collection_contract_conflict',
    );
    expect(presentation.recoveryAction?.kind).toBe('managePlugin');
  });

  it('keeps host widget failures in widget vocabulary without changing pending state', () => {
    const unavailable = resolvePluginSurfaceStatePresentation({
      state: 'unavailable',
      reasonKind: 'widget',
      reasonCode: 'widget_scope_unavailable',
    });
    expect(unavailable.card).toMatchObject({
      kind: 'unavailable',
      title: t('widgetAdd.areaUnavailableTitle'),
      reason: t('common.unavailable'),
    });
    const pending = resolvePluginSurfaceStatePresentation({
      state: 'loading',
      reasonKind: 'widget',
      reasonCode: 'widget_input_options_loading',
    });
    expect(pending.card).toMatchObject({
      kind: 'loading',
      accessibilitySemantics: 'status',
    });
    expect(pending.recoveryAction).toBeNull();
  });
  it('says a private widget definition is unavailable as one durable sentence, never as a start-up state', () => {
    for (const reasonCode of ['widget_definition_unavailable', 'widget_definition_account_mismatch']) {
      const presentation = resolvePluginSurfaceStatePresentation({ state: 'unavailable', reasonKind: 'widget', reasonCode });
      expect(presentation.card).toMatchObject({ kind: 'unavailable', title: t('projects.widgets.definitionUnavailable') });
      expect(presentation.card?.reason).toBeUndefined();
      expect(presentation.diagnosticCode).toBe(reasonCode);
    }
    const missingPlugin = resolvePluginSurfaceStatePresentation({ state: 'unavailable', reasonKind: 'widget', reasonCode: 'widget_type_unavailable' });
    expect(missingPlugin.card?.title).not.toBe(t('projects.widgets.definitionUnavailable'));
  });

  it('explains a policy-disabled plugin details destination with the shared reason copy', () => {
    const copy = resolveReasonCopy({
      reasonCode: 'details_destination_policy_unavailable',
      kind: 'pluginRuntime',
    });
    expect(copy.message).toBe(t('pluginRuntime.disabledByPolicy'));
    expect(copy.diagnosticCode).toBe('details_destination_policy_unavailable');
  });

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
      const copy = resolveReasonCopy({
        reasonCode: code,
        kind: 'localServiceLauncher',
      });
      expect(copy.message.length).toBeGreaterThan(0);
      // routes through the dedicated key, never the raw `Unavailable: <token>` form or bare token.
      expect(copy.message).toBe(t(key));
      expect(copy.message).not.toBe(code);
      expect(copy.message).not.toBe(`Unavailable: ${code}`);
      expect(copy.diagnosticCode).toBe(code);
    }
  });

  it('falls back to the per-kind generic message for an unknown code and stamps the raw code on diagnosticCode', () => {
    const browserFrame = resolveReasonCopy({
      reasonCode: 'totally_unknown_code',
      kind: 'browserFrame',
    });
    expect(browserFrame.message.length).toBeGreaterThan(0);
    expect(browserFrame.message).not.toContain('totally_unknown_code');
    expect(browserFrame.diagnosticCode).toBe('totally_unknown_code');

    const browserStatus = resolveReasonCopy({
      reasonCode: 'totally_unknown_code',
      kind: 'browserStatus',
    });
    expect(browserStatus.message).toBe(browserFrame.message);

    const browserSurface = resolveReasonCopy({
      reasonCode: 'totally_unknown_code',
      kind: 'browserSurface',
    });
    expect(browserSurface.message).toBe(browserFrame.message);

    const launchpad = resolveReasonCopy({
      reasonCode: 'totally_unknown_code',
      kind: 'browserLaunchpad',
    });
    expect(launchpad.message.length).toBeGreaterThan(0);
    expect(launchpad.message).not.toContain('totally_unknown_code');
    expect(launchpad.diagnosticCode).toBe('totally_unknown_code');

    const launcher = resolveReasonCopy({
      reasonCode: 'totally_unknown_code',
      kind: 'localServiceLauncher',
    });
    expect(launcher.message.length).toBeGreaterThan(0);
    expect(launcher.message).not.toContain('totally_unknown_code');
    expect(launcher.diagnosticCode).toBe('totally_unknown_code');
  });

  it('says a missing managed Chromium in its own sentence on the launchpad and keeps the code for diagnostics', () => {
    const missing = resolveReasonCopy({ reasonCode: 'managed_package_missing', kind: 'browserLaunchpad' });
    const generic = resolveReasonCopy({ reasonCode: null, kind: 'browserLaunchpad' });
    expect(missing.body).not.toBe(generic.body);
    expect(missing.body).not.toContain('managed_package_missing');
    expect(missing.diagnosticCode).toBe('managed_package_missing');
  });

  it('the per-kind generic messages are distinct where the packet requires distinct keys', () => {
    const browserFrame = resolveReasonCopy({
      reasonCode: null,
      kind: 'browserFrame',
    });
    const launchpad = resolveReasonCopy({
      reasonCode: null,
      kind: 'browserLaunchpad',
    });
    const launcher = resolveReasonCopy({
      reasonCode: null,
      kind: 'localServiceLauncher',
    });
    expect(launchpad.message).not.toBe(browserFrame.message);
    expect(launcher.message).not.toBe(browserFrame.message);
    expect(launcher.message).not.toBe(launchpad.message);
  });

  it('returns the per-kind generic message and a null diagnosticCode for a null or undefined reason', () => {
    const fromNull = resolveReasonCopy({
      reasonCode: null,
      kind: 'browserFrame',
    });
    const fromUndefined = resolveReasonCopy({
      reasonCode: undefined,
      kind: 'browserFrame',
    });
    expect(fromNull.message.length).toBeGreaterThan(0);
    expect(fromNull.diagnosticCode).toBeNull();
    expect(fromUndefined.message).toBe(fromNull.message);
    expect(fromUndefined.diagnosticCode).toBeNull();
  });

  it('maps inventory scan diagnostic codes to a neutral message, keeping the raw code only on diagnosticCode', () => {
    for (const reasonCode of [
      'scanner_permission_denied',
      'launcher_snapshot_unavailable',
    ]) {
      const copy = resolveReasonCopy({
        reasonCode,
        kind: 'localServiceInventory',
      });
      expect(copy.message.length).toBeGreaterThan(0);
      expect(copy.message).not.toContain(reasonCode);
      expect(copy.diagnosticCode).toBe(reasonCode);
    }
  });

  it('names the cause of each inventory scan diagnostic family, never only the title', () => {
    const title = t('localServices.inventory.errorTitle');
    const workspaces = resolveReasonCopy({
      reasonCode: 'local_services_accepted_workspaces_unavailable',
      kind: 'localServiceInventory',
    });
    const partial = resolveReasonCopy({
      reasonCode: 'linux_procfs_scan_deadline_exceeded',
      kind: 'localServiceInventory',
    });
    const failed = resolveReasonCopy({
      reasonCode: 'linux_procfs_scan_failed',
      kind: 'localServiceInventory',
    });
    expect(workspaces.title).toBe(title);
    for (const copy of [workspaces, partial, failed])
      expect(copy.body).not.toBe(title);
    expect(new Set([workspaces.body, partial.body, failed.body]).size).toBe(3);
    expect(
      resolveReasonCopy({
        reasonCode: 'darwin_lsof_scan_partial',
        kind: 'localServiceInventory',
      }).body,
    ).toBe(partial.body);
    expect(
      resolveReasonCopy({
        reasonCode: 'windows_netstat_scan_failed',
        kind: 'localServiceInventory',
      }).body,
    ).toBe(failed.body);
  });

  it('never returns the raw code as the message for any kind', () => {
    const unknownByKind = [
      resolveReasonCopy({ reasonCode: 'raw_leak_probe', kind: 'browserFrame' }),
      resolveReasonCopy({
        reasonCode: 'raw_leak_probe',
        kind: 'browserStatus',
      }),
      resolveReasonCopy({
        reasonCode: 'raw_leak_probe',
        kind: 'browserSurface',
      }),
      resolveReasonCopy({
        reasonCode: 'raw_leak_probe',
        kind: 'browserLaunchpad',
      }),
      resolveReasonCopy({
        reasonCode: 'raw_leak_probe',
        kind: 'localServiceLauncher',
      }),
      resolveReasonCopy({
        reasonCode: 'raw_leak_probe',
        kind: 'localServiceInventory',
      }),
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
  {
    code: 'no_simulator_devices',
    expected: () => t('simulatorPreview.availability.noDevices'),
  },
  {
    code: 'capture_unavailable',
    expected: () => t('simulatorPreview.availability.captureUnavailable'),
  },
  {
    code: 'capture_degraded',
    expected: () => t('simulatorPreview.availability.captureDegraded'),
  },
  {
    code: 'stream_degraded',
    expected: () => t('simulatorPreview.availability.streamDegraded'),
  },
  {
    code: 'stream_error',
    expected: () => t('simulatorPreview.availability.streamUnavailable'),
  },
] as const;

const STREAM_PLAYER_CODES = [
  {
    code: 'permission_expired',
    expected: () => t('streamPlayer.status.permissionExpired'),
  },
  {
    code: 'lease_expired',
    expected: () => t('streamPlayer.status.leaseExpired'),
  },
  {
    code: 'low_bandwidth',
    expected: () => t('streamPlayer.status.lowBandwidth'),
  },
  {
    code: 'webcodecs_decoder_unavailable',
    expected: () => t('streamPlayer.status.decoderUnavailable'),
  },
] as const;

const PLUGIN_RUNTIME_CODES = [
  {
    code: 'crash_threshold_reached',
    expected: () => t('pluginRuntime.crashLoop'),
  },
  {
    code: 'feature_disabled',
    expected: () => t('pluginRuntime.disabledByPolicy'),
  },
  {
    code: 'feature_gate_disabled',
    expected: () => t('pluginRuntime.disabledByPolicy'),
  },
  {
    code: 'required_feature_disabled',
    expected: () => t('pluginRuntime.disabledByPolicy'),
  },
  {
    code: 'channel_policy_denied',
    expected: () => t('pluginRuntime.disabledByPolicy'),
  },
  {
    code: 'channel_denied',
    expected: () => t('pluginRuntime.disabledByPolicy'),
  },
  {
    code: 'platform_denied',
    expected: () => t('pluginRuntime.disabledByPolicy'),
  },
  {
    code: 'compatibility_platform_unsupported',
    expected: () => t('pluginRuntime.disabledByPolicy'),
  },
  {
    code: 'compatibility_channel_unsupported',
    expected: () => t('pluginRuntime.disabledByPolicy'),
  },
  {
    code: 'compatibility_feature_disabled',
    expected: () => t('pluginRuntime.disabledByPolicy'),
  },
  {
    code: 'profile_mode_unsupported',
    expected: () => t('pluginRuntime.disabledByPolicy'),
  },
  {
    code: 'hosted_web_policy_denied',
    expected: () => t('pluginRuntime.hostedWebPolicyDenied'),
  },
  {
    code: 'hosted_web_endpoint_policy_denied',
    expected: () => t('pluginRuntime.hostedWebEndpointPolicyDenied'),
  },
  {
    code: 'e2ee_unavailable',
    expected: () => t('pluginRuntime.missingRequirement'),
  },
  {
    code: 'artifact_hosting_unsupported',
    expected: () => t('pluginRuntime.missingRequirement'),
  },
  {
    code: 'artifact_hosting_not_opted_in',
    expected: () => t('pluginRuntime.disabledByPolicy'),
  },
  {
    code: 'hosted_web_static_artifact_missing',
    expected: () => t('pluginRuntime.missingRequirement'),
  },
  {
    code: 'hosted_web_frame_adapter_unavailable',
    expected: () => t('pluginRuntime.missingRequirement'),
  },
  {
    code: 'missing_native_capability',
    expected: () => t('pluginRuntime.missingRequirement'),
  },
  {
    code: 'required_permission_missing',
    expected: () => t('pluginRuntime.missingRequirement'),
  },
  {
    code: 'entry_missing',
    expected: () => t('pluginRuntime.missingRequirement'),
  },
  {
    code: 'runtime_mismatch',
    expected: () => t('pluginRuntime.missingRequirement'),
  },
  {
    code: 'transport_unavailable',
    expected: () => t('pluginRuntime.transportUnavailable'),
  },
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
  it.each(['timeout', 'plugin_action_outcome_unknown'])('preserves the unsettled Action outcome for %s', reasonCode => {
    const copy = resolveReasonCopy({ kind: 'pluginRuntime', reasonCode });
    expect(copy.body).toBe(t('ui.pluginUi.actionNoAnswer'));
    expect(copy.diagnosticCode).toBe(reasonCode);
  });

  it('tells the user to choose a machine when installed copies of a plugin disagree', () => {
    // The projection blocks a page whose machines carry different plugin versions until
    // one is chosen; the generic "unavailable right now" hides that one press fixes it.
    const copy = resolveReasonCopy({
      reasonCode: 'installationConflict',
      kind: 'pluginRuntime',
    });
    expect(copy.body).not.toBe(t('pluginRuntime.unavailableGeneric'));
    expect(copy.body).not.toContain('installationConflict');
    expect(copy.diagnosticCode).toBe('installationConflict');
  });

  it('returns the canonical remediation-copy shape for surface state cards', () => {
    const copy = resolveReasonCopy({
      reasonCode: 'no_simulator_devices',
      kind: 'simulatorPreview',
    });
    expect(copy.title).toBe(t('streamPlayer.status.unavailable'));
    expect(copy.body).toBe(t('simulatorPreview.availability.noDevices'));
    expect(copy.message).toBe(copy.body);
    expect(copy.nextStep).toBeUndefined();
    expect(copy.diagnosticCode).toBe('no_simulator_devices');
  });

  it('maps known simulator preview codes to their availability copy', () => {
    for (const { code, expected } of SIMULATOR_PREVIEW_CODES) {
      const copy = resolveReasonCopy({
        reasonCode: code,
        kind: 'simulatorPreview',
      });
      expect(copy.body).toBe(expected());
      expect(copy.message).toBe(copy.body);
      expect(copy.body).not.toContain(code);
      expect(copy.diagnosticCode).toBe(code);
    }
  });

  it('maps known stream player codes to human copy and never leaks the raw code', () => {
    for (const { code, expected } of STREAM_PLAYER_CODES) {
      const copy = resolveReasonCopy({
        reasonCode: code,
        kind: 'streamPlayer',
      });
      expect(copy.message).toBe(expected());
      expect(copy.message).not.toContain(code);
      expect(copy.diagnosticCode).toBe(code);
    }
  });

  it('maps known plugin runtime codes to their intended human copy', () => {
    for (const { code, expected } of PLUGIN_RUNTIME_CODES) {
      const copy = resolveReasonCopy({
        reasonCode: code,
        kind: 'pluginRuntime',
      });
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

    expect(new Set(copies)).toHaveLength(
      HOSTED_WEB_LOCAL_TERMINAL_CODES.length,
    );
  });

  it('falls back to a per-kind generic for unknown codes on the new kinds', () => {
    for (const kind of [
      'simulatorPreview',
      'streamPlayer',
      'pluginRuntime',
    ] as const) {
      const copy = resolveReasonCopy({ reasonCode: 'raw_leak_probe', kind });
      expect(copy.message.length).toBeGreaterThan(0);
      expect(copy.message).not.toContain('raw_leak_probe');
      expect(copy.diagnosticCode).toBe('raw_leak_probe');
    }
  });

  it('the new per-kind generics are meaningful and distinct from the raw badge label', () => {
    const simulator = resolveReasonCopy({
      reasonCode: null,
      kind: 'simulatorPreview',
    });
    const stream = resolveReasonCopy({
      reasonCode: null,
      kind: 'streamPlayer',
    });
    const plugin = resolveReasonCopy({
      reasonCode: null,
      kind: 'pluginRuntime',
    });
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

    for (const state of [
      'loading',
      'refreshing',
      'stale',
      'offline',
      'unavailable',
      'failedRetry',
    ] as const) {
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
      expect(retained.contentNotice?.reason, state).not.toContain(
        'raw_machine_probe',
      );
    }
    for (const state of [
      'loading',
      'refreshing',
      'stale',
      'offline',
    ] as const) {
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

  it('maps recovery semantics without exposing raw failure codes', () => {
    const cases = [
      ['artifact_source_integrity_invalid', 'repair'],
      ['artifact_incompatible', 'updateCompatible'],
      ['module_instantiation_failed', 'managePlugin'],
      ['unknown_host_module', 'managePlugin'],
      ['invalid_executable_export', 'managePlugin'],
      ['local_artifact_failure', 'retry'],
      ['feature_disabled', 'enable'],
      ['disabled', 'enable'],
      ['plugin_revoked', 'managePlugin'],
      ['plugin_uninstalled', 'managePlugin'],
      ['revoked', 'managePlugin'],
      ['uninstalled', 'managePlugin'],
    ] as const;

    for (const [reasonCode, actionKind] of cases) {
      const presentation = resolvePluginSurfaceStatePresentation({
        state: 'unavailable',
        reasonCode,
      });
      expect(presentation.recoveryAction?.kind, reasonCode).toBe(actionKind);
      expect(presentation.card?.reason, reasonCode).not.toBe(reasonCode);
      if (reasonCode.includes('_')) {
        expect(presentation.card?.reason, reasonCode).not.toContain(reasonCode);
      }
    }

    expect(
      resolvePluginSurfaceStatePresentation({
        state: 'unavailable',
        reasonCode: 'artifact_source_unavailable',
      }).recoveryAction?.kind,
    ).toBe('retry');
  });

  it('explains a plugin whose generated UI is missing or invalid as an author fix, never a transient start-up', () => {
    // The daemon's generated-UI artifact owner reports these when the
    // installed plugin carries no usable built view. Waiting never changes
    // the answer, so "it may still be starting" and a bare card are wrong.
    const codes = [
      'generated_react_native_artifact_missing',
      'generated_react_native_artifact_graph_invalid',
      'generated_react_native_export_missing',
      'generated_hosted_web_artifact_missing',
    ] as const;
    for (const reasonCode of codes) {
      const presentation = resolvePluginSurfaceStatePresentation({
        state: 'unavailable',
        reasonCode,
      });
      expect(presentation.card?.reason, reasonCode).toBe(
        t('pluginRuntime.authorFailure'),
      );
      expect(presentation.recoveryAction?.kind, reasonCode).toBe(
        'managePlugin',
      );
    }
  });

  it('names the plugin in a terminal card so a whole-page failure says which plugin failed', () => {
    const unavailable = resolvePluginSurfaceStatePresentation({
      state: 'unavailable',
      reasonCode: 'generated_react_native_artifact_missing',
      subjectName: 'Review collection',
    });
    expect(unavailable.card?.title).toBe(
      t('pluginSurfaces.state.namedUnavailable', { name: 'Review collection' }),
    );
    expect(unavailable.card?.title).toContain('Review collection');
    const failed = resolvePluginSurfaceStatePresentation({
      state: 'failedRetry',
      reasonCode: 'load_timeout',
      subjectName: 'Review collection',
    });
    expect(failed.card?.title).toContain('Review collection');
    // Loading is not a failure and keeps its own quiet title.
    const loading = resolvePluginSurfaceStatePresentation({
      state: 'loading',
      subjectName: 'Review collection',
    });
    expect(loading.card?.title).not.toContain('Review collection');
  });

  it('classifies transient host failures as Retry and configuration failures as Manage plugin', () => {
    const cases = [
      // Transient: asking again can change the answer.
      ['targeted_contributions_error', 'retry'],
      ['hosted_web_bridge_timeout', 'retry'],
      ['load_timeout', 'retry'],
      // Configuration: the plugin's own page is where the fix lives.
      ['required_permission_missing', 'managePlugin'],
      ['plugin_app_page_unavailable', 'managePlugin'],
      ['plugin_disabled', 'enable'],
    ] as const;
    for (const [reasonCode, actionKind] of cases) {
      expect(
        resolvePluginSurfaceStatePresentation({
          state: 'unavailable',
          reasonCode,
        }).recoveryAction?.kind,
        reasonCode,
      ).toBe(actionKind);
    }
    // Neither a retry nor plugin management fixes these; no action is offered.
    for (const reasonCode of [
      'targeted_contributions_unsupported',
      'plugin_surface_open_sub_path_invalid',
      'platform_denied',
    ]) {
      expect(
        resolvePluginSurfaceStatePresentation({
          state: 'unavailable',
          reasonCode,
        }).recoveryAction,
        reasonCode,
      ).toBeNull();
    }
  });

  it('offers no recovery action while content is merely loading', () => {
    for (const state of ['loading', 'refreshing'] as const) {
      expect(
        resolvePluginSurfaceStatePresentation({
          state,
          reasonCode: 'load_timeout',
        }).recoveryAction,
        state,
      ).toBeNull();
    }
  });
});
