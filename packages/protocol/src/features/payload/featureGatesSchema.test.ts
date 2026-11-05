import { describe, expect, it } from 'vitest';

import { DEFAULT_BUG_REPORTS_CAPABILITIES } from './capabilities/bugReportsCapabilities.js';
import { readServerEnabledBit } from '../serverEnabledBit.js';
import { FeaturesResponseSchema } from './featuresResponseSchema.js';

describe('FeatureGatesSchema', () => {
  it('negotiates compact Usage delivery only on an explicit valid Home bit', () => {
    const parse = (features: unknown) => FeaturesResponseSchema.parse({ features, capabilities: {} });
    expect(readServerEnabledBit(parse({ usage: { compactBatch: { enabled: true } } }), 'usage.compactBatch')).toBe(true);
    for (const features of [{}, { usage: { compactBatch: { enabled: false } } },
      { usage: { compactBatch: { enabled: 'yes' } } }, { usage: false }]) {
      expect(readServerEnabledBit(parse(features), 'usage.compactBatch')).toBe(false);
    }
  });

  it('negotiates Artifact query hints only on an explicit valid support bit', () => {
    const parse = (features: unknown) => FeaturesResponseSchema.parse({ features, capabilities: {} });
    expect(readServerEnabledBit(parse({ artifacts: { queryHints: { enabled: true } } }), 'artifacts.queryHints')).toBe(true);
    for (const features of [{}, { artifacts: { queryHints: { enabled: 'yes' } } }, { artifacts: false }]) {
      expect(readServerEnabledBit(parse(features), 'artifacts.queryHints')).toBe(false);
    }
  });
  it('preserves the operation-scoped external Provider API deployment projection', () => {
    const parsed = FeaturesResponseSchema.parse({
      features: {
        teams: {
          enabled: true,
          credentialResources: { enabled: true, externalApi: { enabled: true } },
        },
      },
      capabilities: {
        teams: {
          credentialResources: {
            externalApi: {
              available: true,
              baseUrl: 'https://home.example.test/prefix/api/provider-broker/v1',
              protocols: ['openai_responses', 'openai_chat_completions', 'anthropic_messages'],
            },
          },
        },
      },
    });

    expect(parsed.capabilities.teams?.credentialResources.externalApi).toEqual({
      available: true,
      baseUrl: 'https://home.example.test/prefix/api/provider-broker/v1',
      protocols: ['openai_responses', 'openai_chat_completions', 'anthropic_messages'],
    });
  });

  it('preserves Workflow activation and defaults a missing or malformed bit fail-closed', () => {
    const enabled = FeaturesResponseSchema.parse({
      features: { automations: { enabled: true }, workflows: { enabled: true } },
      capabilities: {},
    });
    expect(readServerEnabledBit(enabled, 'workflows')).toBe(true);

    const missing = FeaturesResponseSchema.parse({
      features: { automations: { enabled: true } },
      capabilities: {},
    });
    expect(readServerEnabledBit(missing, 'workflows')).toBe(false);

    const malformed = FeaturesResponseSchema.parse({
      features: { automations: { enabled: true }, workflows: { enabled: 'yes' } },
      capabilities: {},
    });
    expect(readServerEnabledBit(malformed, 'workflows')).toBe(false);
  });
  it('preserves pets companion and sync gates', () => {
    const parsed = FeaturesResponseSchema.parse({
      features: {
        pets: {
          companion: { enabled: true },
          sync: { enabled: true },
        },
      },
      capabilities: {},
    });

    expect(readServerEnabledBit(parsed, 'pets.companion' as never)).toBe(true);
    expect(readServerEnabledBit(parsed, 'pets.sync' as never)).toBe(true);
  });

  it('accepts and discards retired channel bridge gates from predecessor payloads', () => {
    const parsed = FeaturesResponseSchema.parse({
      features: {
        channelBridges: {
          enabled: true,
          telegram: { enabled: true },
        },
      },
      capabilities: {},
    });

    expect(parsed.features).not.toHaveProperty('channelBridges');
  });

  it('keeps current gate reads stable when the payload carries newer unknown feature fields and malformed bug report capabilities', () => {
    const parsed = FeaturesResponseSchema.parse({
      features: {
        connectedServices: {
          enabled: true,
          quotas: { enabled: true },
        },
        futureBridge: {
          enabled: true,
          experimental: { enabled: true },
        },
      },
      capabilities: {
        bugReports: {
          providerUrl: 'not-a-url',
          defaultIncludeDiagnostics: false,
          maxArtifactBytes: 0,
          acceptedArtifactKinds: [],
          uploadTimeoutMs: 0,
          contextWindowMs: 0,
        },
        futureCapability: {
          enabled: true,
        },
      },
    });

    // Compatibility-only wire bit for clients released before Connected Accounts became core.
    expect(parsed.features.connectedServices.enabled).toBe(true);
    expect(readServerEnabledBit(parsed, 'connectedServices.quotas')).toBe(true);
    expect(parsed.capabilities.bugReports).toEqual(DEFAULT_BUG_REPORTS_CAPABILITIES);
    expect((parsed as any).features.futureBridge).toBeUndefined();
    expect((parsed as any).capabilities.futureCapability).toBeUndefined();
  });

  it('preserves connected-service account group and usage-limit recovery gates', () => {
    const parsed = FeaturesResponseSchema.parse({
      features: {
        connectedServices: {
          enabled: true,
          accountGroups: { enabled: true },
          accountFallback: { enabled: true },
          autoQuotaReset: { enabled: true },
          autoDisablePlanInvalid: { enabled: true },
          poolQuotaLimitSelection: { enabled: true },
        },
        sessions: {
          enabled: true,
          usageLimitRecovery: { enabled: true },
        },
      },
      capabilities: {},
    });

    expect(readServerEnabledBit(parsed, 'connectedServices.accountGroups')).toBe(true);
    expect(readServerEnabledBit(parsed, 'connectedServices.accountFallback')).toBe(true);
    expect(readServerEnabledBit(parsed, 'connectedServices.autoQuotaReset')).toBe(true);
    expect(readServerEnabledBit(parsed, 'connectedServices.autoDisablePlanInvalid')).toBe(true);
    expect(readServerEnabledBit(parsed, 'connectedServices.poolQuotaLimitSelection')).toBe(true);
    expect(readServerEnabledBit(parsed, 'sessions.usageLimitRecovery')).toBe(true);
  });

  it('defaults connected-service account group and usage-limit recovery gates fail-closed', () => {
    const parsed = FeaturesResponseSchema.parse({
      features: {
        connectedServices: {
          enabled: true,
        },
        sessions: {
          enabled: true,
        },
      },
      capabilities: {},
    });

    expect(readServerEnabledBit(parsed, 'connectedServices.accountGroups')).toBe(false);
    expect(readServerEnabledBit(parsed, 'connectedServices.accountFallback')).toBe(false);
    expect(readServerEnabledBit(parsed, 'connectedServices.autoQuotaReset')).toBe(false);
    expect(readServerEnabledBit(parsed, 'connectedServices.autoDisablePlanInvalid')).toBe(false);
    expect(readServerEnabledBit(parsed, 'connectedServices.poolQuotaLimitSelection')).toBe(false);
    expect(readServerEnabledBit(parsed, 'sessions.usageLimitRecovery')).toBe(false);
  });

  it('preserves terminal byte-stream transport gates and defaults them fail-closed', () => {
    const parsed = FeaturesResponseSchema.parse({
      features: {
        terminal: {
          embeddedPty: { enabled: true },
          transport: {
            byteStream: { enabled: true },
          },
        },
      },
      capabilities: {},
    });

    expect(readServerEnabledBit(parsed, 'terminal.embeddedPty')).toBe(true);
    expect(readServerEnabledBit(parsed, 'terminal.transport.byteStream')).toBe(true);

    const defaulted = FeaturesResponseSchema.parse({
      features: {
        terminal: {
          embeddedPty: { enabled: true },
        },
      },
      capabilities: {},
    });
    expect(readServerEnabledBit(defaulted, 'terminal.transport.byteStream')).toBe(false);
  });

  it('preserves peer mediation gate namespace and keeps rpc server-routed absent', () => {
    const parsed = FeaturesResponseSchema.parse({
      features: {
        machines: {
          enabled: true,
          tunnel: {
            enabled: true,
            directPeer: { enabled: true },
            serverRouted: { enabled: false },
          },
          liveStream: {
            enabled: true,
            directPeer: { enabled: true },
            serverRouted: { enabled: false },
          },
          peerMediation: {
            enabled: true,
            observability: { enabled: true },
          },
          rpc: {
            enabled: true,
            directPeer: { enabled: true },
            serverRouted: { enabled: true },
          },
        },
      },
      capabilities: {},
    });

    expect(readServerEnabledBit(parsed, 'machines.tunnel.directPeer' as never)).toBe(true);
    expect(readServerEnabledBit(parsed, 'machines.tunnel.serverRouted' as never)).toBe(false);
    expect(readServerEnabledBit(parsed, 'machines.liveStream.directPeer' as never)).toBe(true);
    expect(readServerEnabledBit(parsed, 'machines.liveStream.serverRouted' as never)).toBe(false);
    expect(readServerEnabledBit(parsed, 'machines.peerMediation.observability' as never)).toBe(true);
    expect(readServerEnabledBit(parsed, 'machines.rpc.directPeer' as never)).toBe(true);
    expect((parsed.features.machines as unknown as { rpc?: { serverRouted?: unknown } }).rpc?.serverRouted).toBeUndefined();
  });

  it('preserves device and simulator preview gates', () => {
    const parsed = FeaturesResponseSchema.parse({
      features: {
        devices: {
          enabled: true,
          simulatorPreview: { enabled: true },
        },
      },
      capabilities: {},
    });

    expect(readServerEnabledBit(parsed, 'devices' as never)).toBe(true);
    expect(readServerEnabledBit(parsed, 'devices.simulatorPreview' as never)).toBe(true);
  });

  it('preserves provider gates and defaults every omitted provider bit fail-closed', () => {
    const parsed = FeaturesResponseSchema.parse({
      features: {
        providers: {
          enabled: true,
          localDiscovery: { enabled: true },
          localModelManagement: { enabled: true },
        },
      },
      capabilities: {},
    });
    expect(readServerEnabledBit(parsed, 'providers')).toBe(true);
    expect(readServerEnabledBit(parsed, 'providers.localDiscovery')).toBe(true);
    expect(readServerEnabledBit(parsed, 'providers.localModelManagement')).toBe(true);

    const defaulted = FeaturesResponseSchema.parse({ features: {}, capabilities: {} });
    expect(readServerEnabledBit(defaulted, 'providers')).toBe(false);
    expect(readServerEnabledBit(defaulted, 'providers.localDiscovery')).toBe(false);
    expect(readServerEnabledBit(defaulted, 'providers.localModelManagement')).toBe(false);
  });

  it('preserves supported plugin UI tier gates while dropping deferred structured-message input', () => {
    const parsed = FeaturesResponseSchema.parse({
      features: {
        plugins: {
          enabled: true,
          webhooks: { enabled: true },
          ui: {
            enabled: true,
            hostedWeb: { enabled: true },
            structuredMessages: { enabled: true },
            reactNativeBundles: {
              enabled: true,
              devHotReload: { enabled: true },
            },
          },
        },
      },
      capabilities: {},
    });

    expect(readServerEnabledBit(parsed, 'plugins' as never)).toBe(true);
    expect(readServerEnabledBit(parsed, 'plugins.webhooks' as never)).toBe(true);
    expect(readServerEnabledBit(parsed, 'plugins.ui' as never)).toBe(true);
    expect(readServerEnabledBit(parsed, 'plugins.ui.hostedWeb' as never)).toBe(true);
    expect(parsed.features.plugins?.ui).not.toHaveProperty('structuredMessages');
    expect(readServerEnabledBit(parsed, 'plugins.ui.structuredMessages' as never)).toBeNull();
    expect(readServerEnabledBit(parsed, 'plugins.ui.reactNativeBundles' as never)).toBe(true);
    expect(parsed.features.plugins?.ui?.reactNativeBundles).not.toHaveProperty('devHotReload');
    expect(readServerEnabledBit(parsed, 'plugins.ui.reactNativeBundles.devHotReload' as never)).toBeNull();

    const defaulted = FeaturesResponseSchema.parse({
      features: {
        plugins: {
          enabled: true,
          ui: { enabled: true },
        },
      },
      capabilities: {},
    });
    // Fail-closed: a payload that omits the tier bits reads as disabled.
    expect(readServerEnabledBit(defaulted, 'plugins.ui.hostedWeb' as never)).toBe(false);
    expect(readServerEnabledBit(defaulted, 'plugins.webhooks' as never)).toBe(false);
    expect(readServerEnabledBit(defaulted, 'plugins.ui.structuredMessages' as never)).toBeNull();
    expect(readServerEnabledBit(defaulted, 'plugins.ui.reactNativeBundles' as never)).toBe(false);
    expect(defaulted.features.plugins?.ui?.reactNativeBundles).not.toHaveProperty('devHotReload');
  });

  it('preserves setup machine and ssh gate namespaces', () => {
    const parsed = FeaturesResponseSchema.parse({
      features: {
        setup: {
          machine: {
            allowLocalMachineSetup: { enabled: true },
            allowRemoteSshMachineSetup: { enabled: true },
          },
          ssh: {
            nativeTransport: { enabled: true },
          },
        },
      },
      capabilities: {},
    });

    expect(readServerEnabledBit(parsed, 'setup.machine.allowLocalMachineSetup' as never)).toBe(true);
    expect(readServerEnabledBit(parsed, 'setup.machine.allowRemoteSshMachineSetup' as never)).toBe(true);
    expect(readServerEnabledBit(parsed, 'setup.ssh.nativeTransport' as never)).toBe(true);
  });

  it('preserves browser recording gates and defaults attachment recording fail-closed', () => {
    const parsed = FeaturesResponseSchema.parse({
      features: {
        browser: {
          enabled: true,
          internal: { enabled: true },
          recording: {
            enabled: true,
          },
        },
      },
      capabilities: {},
    });

    expect(readServerEnabledBit(parsed, 'browser.recording' as never)).toBe(true);
    expect(readServerEnabledBit(parsed, 'browser.recording.attachments' as never)).toBe(false);

    const withAttachments = FeaturesResponseSchema.parse({
      features: {
        browser: {
          enabled: true,
          internal: { enabled: true },
          recording: {
            enabled: true,
            attachments: { enabled: true },
          },
        },
      },
      capabilities: {},
    });

    expect(readServerEnabledBit(withAttachments, 'browser.recording.attachments' as never)).toBe(true);
  });

  it('preserves pending delivery-state support separately from the basic pending queue gate', () => {
    const parsed = FeaturesResponseSchema.parse({
      features: {
        sharing: {
          pendingQueueV2: { enabled: true },
          pendingDeliveryState: { enabled: true },
        },
      },
      capabilities: {},
    });

    expect(readServerEnabledBit(parsed, 'sharing.pendingQueueV2')).toBe(true);
    expect(readServerEnabledBit(parsed, 'sharing.pendingDeliveryState')).toBe(true);
  });

  it('defaults pending delivery-state support disabled when old servers omit it', () => {
    const parsed = FeaturesResponseSchema.parse({
      features: {
        sharing: {
          pendingQueueV2: { enabled: true },
        },
      },
      capabilities: {},
    });

    expect(readServerEnabledBit(parsed, 'sharing.pendingQueueV2')).toBe(true);
    expect(readServerEnabledBit(parsed, 'sharing.pendingDeliveryState')).toBe(false);
  });

  it('treats missing voice enabled bits as disabled (and does not crash parsing)', () => {
    const parsed = FeaturesResponseSchema.parse({
      features: {
        voice: {
          happierVoice: {},
        },
      },
      capabilities: {},
    });

    expect(parsed.features.voice.enabled).toBe(false);
    expect(parsed.features.voice.happierVoice.enabled).toBe(false);
    expect(readServerEnabledBit(parsed, 'voice')).toBe(false);
    expect(readServerEnabledBit(parsed, 'voice.happierVoice')).toBe(false);
  });
});
