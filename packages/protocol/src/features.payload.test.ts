import { describe, expect, it } from 'vitest';

import {
  coerceBugReportsCapabilitiesFromFeaturesPayload,
  DEFAULT_BUG_REPORTS_CAPABILITIES,
  DEFAULT_MACHINE_TRANSFER_CAPABILITIES,
  FeaturesResponseSchema,
  MACHINE_TRANSFER_SERVER_ROUTED_MAX_BYTES_ENV_KEY,
  normalizeMachineTransferServerRoutedMaxBytes,
  readMachineTransferServerRoutedMaxBytes,
} from './features.js';

describe('FeaturesResponseSchema', () => {
  it('applies safe defaults for missing subtrees', () => {
    const parsed = FeaturesResponseSchema.parse({
      features: {},
      capabilities: {},
    });

    expect(parsed.features.bugReports.enabled).toBe(false);
    expect(parsed.features.automations.enabled).toBe(false);
    expect('existingSessionTarget' in (parsed.features.automations as any)).toBe(false);
    expect(parsed.features.connectedServices.enabled).toBe(false);
    expect(parsed.features.connectedServices.quotas.enabled).toBe(false);
    expect(parsed.features.updates.ota.enabled).toBe(false);
    expect(parsed.features.attachments.uploads.enabled).toBe(false);
    expect(parsed.features.sharing.session.enabled).toBe(false);
    expect(parsed.features.voice.enabled).toBe(false);
    expect(parsed.features.voice.happierVoice.enabled).toBe(false);
    expect((parsed as any).features.terminal.embeddedPty.enabled).toBe(false);
    expect(parsed.features.social.friends.enabled).toBe(false);
    expect(parsed.features.encryption.plaintextStorage.enabled).toBe(false);
    expect(parsed.features.encryption.accountOptOut.enabled).toBe(false);
    expect((parsed as any).features.machines.transfer.directPeer.enabled).toBe(false);
    expect((parsed as any).features.machines.transfer.serverRouted.enabled).toBe(false);
    expect(parsed.features.auth.recovery.providerReset.enabled).toBe(false);
    expect((parsed as any).features.auth.mtls.enabled).toBe(false);
    // Backward compatibility: older servers predate this gate but still support `POST /v1/auth`.
    // Default to enabled unless a server explicitly disables it.
    expect(parsed.features.auth.login.keyChallenge.enabled).toBe(true);
    expect((parsed as any).features.auth.pairing.desktopQrMobileScan.enabled).toBe(false);
    expect(parsed.features.auth.ui.recoveryKeyReminder.enabled).toBe(false);
    expect((parsed as any).features.e2ee.keylessAccounts.enabled).toBe(false);

    expect(parsed.capabilities.bugReports).toEqual(DEFAULT_BUG_REPORTS_CAPABILITIES);
    expect(parsed.capabilities.voice).toEqual({
      configured: false,
      provider: null,
      requested: false,
      disabledByBuildPolicy: false,
    });
    expect(parsed.capabilities.machines.transfer).toEqual(DEFAULT_MACHINE_TRANSFER_CAPABILITIES);
    expect(parsed.capabilities.oauth.providers).toEqual({});
    expect(parsed.capabilities.encryption).toEqual({
      storagePolicy: 'required_e2ee',
      allowAccountOptOut: false,
      defaultAccountMode: 'e2ee',
      plainAccountSettingsAtRest: 'server_sealed',
      plainAccountCredentialsAtRest: 'server_sealed',
    });
    expect((parsed as any).capabilities.auth.methods).toEqual([]);
    expect(parsed.capabilities.auth.login.methods).toEqual([]);
    expect(parsed.capabilities.auth.mtls).toEqual({
      mode: 'forwarded',
      autoProvision: false,
      identitySource: 'san_email',
      policy: {
        trustForwardedHeaders: false,
        issuerAllowlist: { enabled: false, count: 0 },
        emailDomainAllowlist: { enabled: false, count: 0 },
      },
    });
    expect(parsed.capabilities.auth.misconfig).toEqual([]);
  });

  it('accepts direct-peer nested transfer gates', () => {
    const parsed = FeaturesResponseSchema.parse({
      features: {
        machines: {
          enabled: true,
          transfer: {
            enabled: true,
            directPeer: {
              enabled: true,
            },
            serverRouted: {
              enabled: true,
            },
          },
        },
      },
      capabilities: {},
    });

    expect(parsed.features.machines.transfer.directPeer.enabled).toBe(true);
    expect(parsed.features.machines.transfer.serverRouted.enabled).toBe(true);
  });

  it('accepts machine transfer capabilities for server-routed size policy', () => {
    const parsed = FeaturesResponseSchema.parse({
      features: {
        machines: {
          enabled: true,
          transfer: {
            enabled: true,
            serverRouted: {
              enabled: true,
            },
          },
        },
      },
      capabilities: {
        machines: {
          transfer: {
            serverRouted: {
              maxBytes: '2048',
            },
          },
        },
      },
    });

    expect(readMachineTransferServerRoutedMaxBytes(parsed)).toBe(2048);
  });

  it('accepts legacy payloads that omit auth.login.methods', () => {
    const parsed = FeaturesResponseSchema.parse({
      features: {},
      capabilities: {
        auth: {
          signup: { methods: [{ id: 'anonymous', enabled: true }] },
          login: { requiredProviders: [] },
          recovery: { providerReset: { providers: [] } },
          ui: { autoRedirect: { enabled: false, providerId: null } },
          providers: {},
          misconfig: [],
        },
      },
    });

    expect(parsed.capabilities.auth.login.methods).toEqual([]);
    expect((parsed as any).capabilities.auth.methods).toEqual([]);
  });

  it('coerces bug reports capabilities from sparse payloads', () => {
    const coerced = coerceBugReportsCapabilitiesFromFeaturesPayload({
      capabilities: {
        bugReports: {
          providerUrl: 'https://reports.happier.dev/',
          acceptedArtifactKinds: ['cli', '', 'daemon'],
          uploadTimeoutMs: 9000,
          contextWindowMs: 45000,
        },
      },
    });

    expect(coerced.providerUrl).toBe('https://reports.happier.dev');
    expect(coerced.defaultIncludeDiagnostics).toBe(DEFAULT_BUG_REPORTS_CAPABILITIES.defaultIncludeDiagnostics);
    expect(coerced.maxArtifactBytes).toBe(DEFAULT_BUG_REPORTS_CAPABILITIES.maxArtifactBytes);
    expect(coerced.acceptedArtifactKinds).toEqual(['cli', 'daemon']);
    expect(coerced.uploadTimeoutMs).toBe(9000);
    expect(coerced.contextWindowMs).toBe(45000);
  });

  it('returns safe default bug reports capabilities when payload is missing or invalid', () => {
    expect(coerceBugReportsCapabilitiesFromFeaturesPayload({ capabilities: {} })).toEqual(DEFAULT_BUG_REPORTS_CAPABILITIES);
    expect(
      coerceBugReportsCapabilitiesFromFeaturesPayload({
        capabilities: {
          bugReports: {
            providerUrl: 'not-a-url',
          },
        },
      }),
    ).toEqual(DEFAULT_BUG_REPORTS_CAPABILITIES);
    expect(
      coerceBugReportsCapabilitiesFromFeaturesPayload({
        capabilities: {
          bugReports: {
            providerUrl: 'ftp://reports.happier.dev',
          },
        },
      }),
    ).toEqual(DEFAULT_BUG_REPORTS_CAPABILITIES);
  });

  it('does not reject the whole payload when bugReports capabilities are malformed', () => {
    const parsed = FeaturesResponseSchema.parse({
      features: {
        voice: { enabled: true },
      },
      capabilities: {
        bugReports: {
          providerUrl: 'not-a-url',
        },
      },
    });

    expect(parsed.features.voice.enabled).toBe(true);
    // Fail closed: Happier Voice must be explicitly reported by the server via `features.voice.happierVoice.enabled`.
    expect(parsed.features.voice.happierVoice.enabled).toBe(false);
    expect(parsed.capabilities.bugReports).toEqual(DEFAULT_BUG_REPORTS_CAPABILITIES);
  });

  it('normalizes machine transfer server-routed max-bytes env/config values', () => {
    expect(MACHINE_TRANSFER_SERVER_ROUTED_MAX_BYTES_ENV_KEY).toBe(
      'HAPPIER_FEATURE_MACHINES_TRANSFER_SERVER_ROUTED__MAX_BYTES',
    );
    expect(normalizeMachineTransferServerRoutedMaxBytes(undefined)).toBeNull();
    expect(normalizeMachineTransferServerRoutedMaxBytes('')).toBeNull();
    expect(normalizeMachineTransferServerRoutedMaxBytes('1024')).toBe(1024);
    expect(normalizeMachineTransferServerRoutedMaxBytes(2048.9)).toBe(2048);
    expect(normalizeMachineTransferServerRoutedMaxBytes(0)).toBeNull();
    expect(normalizeMachineTransferServerRoutedMaxBytes(-1)).toBeNull();
    expect(normalizeMachineTransferServerRoutedMaxBytes('invalid')).toBeNull();
  });
});
