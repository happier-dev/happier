import { describe, expect, it } from 'vitest';

import {
  coerceBugReportsCapabilitiesFromFeaturesPayload,
  DEFAULT_BUG_REPORTS_CAPABILITIES,
  DEFAULT_MACHINE_TRANSFER_CAPABILITIES,
  DEFAULT_SHARING_CAPABILITIES,
  FeaturesResponseSchema,
  MACHINE_TRANSFER_SERVER_ROUTED_MAX_BYTES_ENV_KEY,
  normalizeMachineTransferServerRoutedMaxBytes,
  readMachineTransferServerRoutedMaxBytes,
} from './features.js';
import { FEATURE_CATALOG } from './features/catalog.js';
import { FEATURE_IDS } from './features/featureIds.js';
import { resolveServerEnabledBitPath } from './features/serverEnabledBit.js';

function readRequiredPath(root: unknown, path: ReadonlyArray<string>): unknown {
  let current: unknown = root;
  for (const segment of path) {
    if (typeof current !== 'object' || current === null) {
      throw new Error(`Expected object at "${segment}" while reading "${path.join('.')}"`);
    }
    if (!Object.prototype.hasOwnProperty.call(current, segment)) {
      throw new Error(`Missing "${segment}" while reading "${path.join('.')}"`);
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function readOptionalPath(root: unknown, path: ReadonlyArray<string>): unknown {
  try {
    return readRequiredPath(root, path);
  } catch {
    return undefined;
  }
}

describe('FeaturesResponseSchema', () => {
  it('degrades malformed optional live-stream relay diagnostics without losing Home identity', () => {
    const parsed = FeaturesResponseSchema.parse({
      features: { voice: { enabled: true } },
      capabilities: {
        serverIdentity: { serverIdentityId: 'srv_qa-voice' },
        machines: {
          liveStream: { serverRouted: { caps: { maxBitrateBps: 'invalid' }, disabledReason: null } },
        },
      },
    });

    expect(parsed.capabilities.serverIdentity.serverIdentityId).toBe('srv_qa-voice');
    expect(parsed.features.voice.enabled).toBe(true);
    expect(parsed.capabilities.machines.liveStream.serverRouted).toEqual({
      caps: null,
      disabledReason: 'relay_caps_missing',
    });
  });

  it('accepts uncapped and partially capped relay policy without inventing limits', () => {
    for (const caps of [{}, { maxBitrateBps: 64_000 }]) {
      const parsed = FeaturesResponseSchema.parse({
        features: {},
        capabilities: { machines: { liveStream: { serverRouted: { caps, disabledReason: null } } } },
      });
      expect(parsed.capabilities.machines.liveStream.serverRouted).toEqual({ caps, disabledReason: null });
    }
  });

  it('keeps an optional Home host fact and treats malformed facts as unknown', () => {
    const known = { kind: 'known', machineName: 'Studio', platform: 'darwin', mobility: 'stationary' };
    expect(FeaturesResponseSchema.parse({ features: {}, capabilities: {}, homeHostFact: known }).homeHostFact).toEqual(known);
    expect(FeaturesResponseSchema.parse({ features: {}, capabilities: {} }).homeHostFact).toBeUndefined();
    expect(FeaturesResponseSchema.parse({
      features: {}, capabilities: {}, homeHostFact: { ...known, mobility: 'portable', trusted: true },
    }).homeHostFact).toBeUndefined();
    expect(FeaturesResponseSchema.parse({
      features: {}, capabilities: {}, homeHostFact: { kind: 'known', machineName: 'Studio', platform: 'linux' },
    }).homeHostFact).toBeUndefined();
  });
  it('accepts an optional strict Home search capability and keeps old-server omission safe', () => {
    const oldServer = FeaturesResponseSchema.parse({ features: {}, capabilities: {} });
    expect(oldServer.capabilities.homeSearch).toBeUndefined();

    const current = FeaturesResponseSchema.parse({
      features: {},
      capabilities: {
        homeSearch: { enabled: false, reason: 'indexing' },
      },
    });
    expect(current.capabilities.homeSearch).toEqual({ enabled: false, reason: 'indexing' });
    expect(FeaturesResponseSchema.safeParse({
      features: {},
      capabilities: {
        homeSearch: { enabled: true, provider: 'home' },
      },
    }).success).toBe(false);
  });

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
    expect(readOptionalPath(parsed, ['features', 'sessions', 'folders', 'enabled'])).toBe(false);
    expect((parsed as any).features.machines.transfer.directPeer.enabled).toBe(false);
    expect((parsed as any).features.machines.transfer.serverRouted.enabled).toBe(false);
    expect(parsed.features.auth.recovery.providerReset.enabled).toBe(false);
    expect((parsed as any).features.auth.mtls.enabled).toBe(false);
    // Backward compatibility: older servers predate this gate but still support `POST /v1/auth`.
    // Default to enabled unless a server explicitly disables it.
    expect(parsed.features.auth.login.keyChallenge.enabled).toBe(true);
    expect((parsed as any).features.auth.pairing.desktopQrMobileScan.enabled).toBe(false);
    expect((parsed as any).features.auth.pairing.boundQrV2.enabled).toBe(false);
    expect(parsed.features.auth.ui.recoveryKeyReminder.enabled).toBe(false);
    expect((parsed as any).features.e2ee.keylessAccounts.enabled).toBe(false);

    expect(readOptionalPath(parsed, ['features', 'setup', 'relay', 'allowRelaySelection', 'enabled'])).toBe(false);
    expect(readOptionalPath(parsed, ['features', 'setup', 'relay', 'allowHappierCloud', 'enabled'])).toBe(false);
    expect(readOptionalPath(parsed, ['features', 'setup', 'relay', 'allowCustomRelayUrl', 'enabled'])).toBe(false);
    expect(readOptionalPath(parsed, ['features', 'setup', 'relay', 'allowLocalRelayHost', 'enabled'])).toBe(false);
    expect(readOptionalPath(parsed, ['features', 'setup', 'relay', 'allowRemoteSshRelayHost', 'enabled'])).toBe(false);
    expect(readOptionalPath(parsed, ['features', 'setup', 'relayAccess', 'allowTailscale', 'enabled'])).toBe(false);
    expect(readOptionalPath(parsed, ['features', 'setup', 'relayAccess', 'allowCloudflareTunnel', 'enabled'])).toBe(false);

    expect(readOptionalPath(parsed, ['features', 'remoteHosts', 'management', 'enabled'])).toBe(false);
    expect(readOptionalPath(parsed, ['features', 'remoteHosts', 'secretMaterial', 'enabled'])).toBe(false);

    expect(parsed.capabilities.bugReports).toEqual(DEFAULT_BUG_REPORTS_CAPABILITIES);
    expect(parsed.capabilities.voice).toEqual({
      configured: false,
      provider: null,
      requested: false,
      disabledByBuildPolicy: false,
    });
    expect(parsed.capabilities.machines.transfer).toEqual(DEFAULT_MACHINE_TRANSFER_CAPABILITIES);
    expect(readOptionalPath(parsed, ['capabilities', 'localServices', 'preview', 'enabled'])).toBe(false);
    expect(readOptionalPath(parsed, ['capabilities', 'localServices', 'publicPreview', 'enabled'])).toBe(false);
    expect(readOptionalPath(parsed, ['capabilities', 'browser', 'viewTargets', 'enabled'])).toBe(false);
    expect(parsed.capabilities.sharing).toEqual(DEFAULT_SHARING_CAPABILITIES);
    expect(parsed.capabilities.connectedServices.credentialDelete.revisionGuard).toBe(false);
    expect(parsed.capabilities.oauth.providers).toEqual({});
    expect(parsed.capabilities.encryption).toEqual({
      storagePolicy: 'required_e2ee',
      allowAccountOptOut: false,
      defaultAccountMode: 'e2ee',
      plainAccountSettingsAtRest: 'server_sealed',
      plainAccountCredentialsAtRest: 'server_sealed',
    });
    expect(parsed.capabilities.auth.methods).toBeUndefined();
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

  it('parses an additive optional Home connection descriptor and invalidates malformed ones', () => {
    // Old servers predate the field entirely and must remain valid.
    const oldServer = FeaturesResponseSchema.parse({ features: {}, capabilities: {} });
    expect(oldServer.homeConnectionDescriptor).toBeUndefined();

    const descriptor = {
      v: 1 as const,
      homeServerIdentityId: 'srv_features_home',
      canonicalServerUrl: 'http://127.0.0.1:3005',
      revision: 3,
      endpoints: [
        { kind: 'iroh' as const, endpointId: 'a'.repeat(64), relayUrls: ['https://relay.example.test'] },
      ],
    };
    const current = FeaturesResponseSchema.parse({
      features: {},
      capabilities: {},
      homeConnectionDescriptor: descriptor,
    });
    expect(current.homeConnectionDescriptor).toEqual(descriptor);

    // The canonical outer descriptor schema owns validation: a present but
    // malformed field invalidates the response instead of being dropped.
    expect(FeaturesResponseSchema.safeParse({
      features: {},
      capabilities: {},
      homeConnectionDescriptor: { ...descriptor, revision: 0 },
    }).success).toBe(false);
    expect(FeaturesResponseSchema.safeParse({
      features: {},
      capabilities: {},
      homeConnectionDescriptor: { ...descriptor, endpoints: [] },
    }).success).toBe(false);
  });

  it('accepts an advertised revision-guarded connected-service delete capability', () => {
    const parsed = FeaturesResponseSchema.parse({
      features: {},
      capabilities: {
        connectedServices: { credentialDelete: { revisionGuard: true } },
      },
    });

    expect(parsed.capabilities.connectedServices.credentialDelete.revisionGuard).toBe(true);
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
    expect(parsed.capabilities.auth.methods).toBeUndefined();
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

  it('does not reject the whole payload when voice capabilities are malformed', () => {
    const parsed = FeaturesResponseSchema.parse({
      features: {
        voice: { enabled: true },
      },
      capabilities: {
        voice: {
          configured: 'not-a-boolean',
          provider: 'future-provider',
          requested: true,
          disabledByBuildPolicy: true,
        },
      },
    });

    expect(parsed.features.voice.enabled).toBe(true);
    expect(parsed.capabilities.voice).toEqual({
      configured: false,
      provider: null,
      requested: true,
      disabledByBuildPolicy: true,
    });
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

  it('defaults fail-closed for all gates except auth.login.keyChallenge', () => {
    const parsed = FeaturesResponseSchema.parse({
      features: {},
      capabilities: {},
    });

    for (const featureId of FEATURE_IDS) {
      const entry = FEATURE_CATALOG[featureId];
      if (entry.representation !== 'server') continue;

      const path = resolveServerEnabledBitPath(featureId);
      const enabled = readRequiredPath(parsed, path);

      if (featureId === 'auth.login.keyChallenge') {
        expect(enabled).toBe(true);
      } else {
        expect(enabled).toBe(false);
      }
    }
  });

  it('includes a gate leaf for every server-represented FeatureId', () => {
    const parsed = FeaturesResponseSchema.parse({
      features: {},
      capabilities: {},
    });

    for (const featureId of FEATURE_IDS) {
      const entry = FEATURE_CATALOG[featureId];
      if (entry.representation !== 'server') continue;

      const path = resolveServerEnabledBitPath(featureId);
      const enabled = readRequiredPath(parsed, path);
      expect(typeof enabled).toBe('boolean');
    }
  });
});
