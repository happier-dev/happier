import { describe, expect, it } from 'vitest';

async function loadRemoteUpdateCapabilitiesModule() {
  return import('./remoteUpdateCapabilities.js').catch(() => null);
}

describe('Live Activity remote update capability diagnostics', () => {
  it('fails closed when remote update prerequisites are missing', async () => {
    const capabilities = await loadRemoteUpdateCapabilitiesModule();
    expect(capabilities).not.toBeNull();
    if (!capabilities) return;

        const diagnostics = capabilities.buildLiveActivityRemoteUpdateCapabilityDiagnostics({
      expoWidgetsPushNotificationsEnabled: false,
        hostedRelay: {
          allowed: true,
          capabilityAvailable: false,
        },
      directApns: {
        configured: false,
      },
      backgroundWake: {
        enabled: false,
      },
    });

    expect(diagnostics.modes.hosted_happier_relay).toMatchObject({
      available: false,
      reasons: [
        'expo_widgets_push_notifications_disabled',
        'hosted_relay_capability_missing',
      ],
    });
    expect(diagnostics.modes.direct_apns).toMatchObject({
      available: false,
      reasons: [
        'expo_widgets_push_notifications_disabled',
        'direct_apns_not_configured',
      ],
    });
    expect(diagnostics.modes.background_wake_best_effort).toMatchObject({
      available: false,
      reasons: ['background_wake_disabled'],
    });
    expect(diagnostics.capabilities.perActivityUpdate.availableModes).toEqual([]);
  });

  it('does not model future hosted relay identity hardening as a v1 capability input', async () => {
    const capabilities = await loadRemoteUpdateCapabilitiesModule();
    expect(capabilities).not.toBeNull();
    if (!capabilities) return;

    const diagnostics = capabilities.buildLiveActivityRemoteUpdateCapabilityDiagnostics({
      expoWidgetsPushNotificationsEnabled: true,
      hostedRelay: {
        allowed: true,
        capabilityAvailable: true,
      },
      directApns: {
        configured: false,
      },
      backgroundWake: {
        enabled: false,
      },
    });

    expect(diagnostics.modes.hosted_happier_relay).toEqual({
      available: true,
      reasons: [],
      configurationDiagnostics: [],
    });
    expect(capabilities.resolveLiveActivityRemoteUpdateMode({
      preferredMode: 'hosted_happier_relay',
      diagnostics,
      allowFallback: false,
    })).toEqual({
      mode: 'hosted_happier_relay',
      reason: 'selected',
    });
  });

  it('reports configured update/end transports without enabling future capabilities', async () => {
    const capabilities = await loadRemoteUpdateCapabilitiesModule();
    expect(capabilities).not.toBeNull();
    if (!capabilities) return;

    const diagnostics = capabilities.buildLiveActivityRemoteUpdateCapabilityDiagnostics({
      expoWidgetsPushNotificationsEnabled: true,
        hostedRelay: {
        allowed: true,
        capabilityAvailable: true,
      },
      directApns: {
        configured: true,
      },
      backgroundWake: {
        enabled: true,
      },
    });

    expect(diagnostics.capabilities.perActivityUpdate).toEqual({
      id: 'per_activity_update',
      status: 'supported_when_configured',
      events: ['update', 'end'],
      targetKinds: ['activitykit_update_token'],
      availableModes: ['hosted_happier_relay', 'direct_apns', 'background_wake_best_effort'],
      reasons: [],
    });
    expect(diagnostics.capabilities.pushToStart).toMatchObject({
      id: 'push_to_start',
      status: 'future_unsupported',
      events: ['start'],
      targetKinds: ['activitykit_push_to_start_token'],
      availableModes: [],
      reasons: ['not_in_phase_9_5'],
    });
    expect(diagnostics.capabilities.broadcastChannel).toMatchObject({
      id: 'broadcast_channel',
      status: 'future_unsupported',
      events: [],
      targetKinds: [],
      availableModes: [],
      reasons: ['private_per_session_surface_not_broadcast'],
    });
  });

  it('resolves the preferred remote mode through available transports and fails closed', async () => {
    const capabilities = await loadRemoteUpdateCapabilitiesModule();
    expect(capabilities).not.toBeNull();
    if (!capabilities) return;

    const diagnostics = capabilities.buildLiveActivityRemoteUpdateCapabilityDiagnostics({
      expoWidgetsPushNotificationsEnabled: true,
      hostedRelay: {
        allowed: true,
        capabilityAvailable: false,
      },
      directApns: {
        configured: true,
      },
      backgroundWake: {
        enabled: true,
      },
    });

    expect(capabilities.resolveLiveActivityRemoteUpdateMode({
      preferredMode: 'hosted_happier_relay',
      diagnostics,
      allowFallback: true,
    })).toEqual({
      mode: 'direct_apns',
      reason: 'fallback',
    });

    expect(capabilities.resolveLiveActivityRemoteUpdateMode({
      preferredMode: 'hosted_happier_relay',
      diagnostics,
      allowFallback: false,
    })).toEqual({
      mode: 'local_only',
      reason: 'preferred_unavailable',
    });

    expect(capabilities.resolveLiveActivityRemoteUpdateMode({
      preferredMode: 'disabled',
      diagnostics,
      allowFallback: true,
    })).toEqual({
      mode: 'disabled',
      reason: 'disabled',
    });
  });

  it('carries sanitized direct APNs configuration diagnostics without credential material', async () => {
    const capabilities = await loadRemoteUpdateCapabilitiesModule();
    expect(capabilities).not.toBeNull();
    if (!capabilities) return;

    const diagnostics = capabilities.buildLiveActivityRemoteUpdateCapabilityDiagnostics({
      expoWidgetsPushNotificationsEnabled: true,
      hostedRelay: {
        allowed: false,
        capabilityAvailable: false,
      },
      directApns: {
        configured: false,
        configurationDiagnostics: [
          'apns_private_key_missing',
          'apns_bundle_id_allowlist_missing',
        ],
      },
      backgroundWake: {
        enabled: false,
      },
    });

    expect(diagnostics.modes.direct_apns).toMatchObject({
      available: false,
      reasons: ['direct_apns_not_configured'],
      configurationDiagnostics: [
        'apns_private_key_missing',
        'apns_bundle_id_allowlist_missing',
      ],
    });
    expect(JSON.stringify(diagnostics)).not.toContain('PRIVATE KEY');
    expect(JSON.stringify(diagnostics)).not.toContain('.p8');
  });
});
