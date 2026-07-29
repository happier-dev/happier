import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PROVIDER_SETTINGS_V1,
  ProviderConnectionIdSchema,
  ProviderContributionV1Schema,
  ProviderConnectionV1Schema,
  ProviderProbeObservationIdentityV1Schema,
  ProviderSettingsV1Schema,
  SavedSecretSchema,
  createProviderDiscoveryCandidateIdV1,
  readOwnRecordValue,
  readProviderSettingsFromAccountSettingsV1,
  type ProviderDiscoveryCandidateV1,
} from '@happier-dev/protocol';
import type { DaemonProviderAgentCompatibilitySummaryV1 } from '@happier-dev/protocol/rpc';

import type { ResolvedProviderContribution } from '@/plugins/projection/registry/types';
import { resolveProviderConnectionForMachine, type ProviderContributionRegistryView } from '@/providers/registry';
import { createProviderConnectionRpcAdapter } from './rpcAdapter';
import { createProviderConnectionService } from './service';

const contributionKey = 'acme.gateway/gateway';

function contribution(): ResolvedProviderContribution {
  return {
    provenance: 'external', source: { kind: 'path' }, pluginId: 'acme.gateway',
    identity: { pluginId: 'acme.gateway', localId: 'gateway' },
    definition: ProviderContributionV1Schema.parse({
      v: 1, id: 'gateway', name: 'Gateway', icon: 'sparkles-outline', kind: 'cloud',
      websiteUrl: 'https://gateway.example',
      endpointTemplates: [{
        id: 'responses', protocol: 'openai-responses', baseUrl: 'https://gateway.example/v1',
        capabilities: { streaming: 'unknown', toolRoundTrips: 'unknown', statefulResponses: 'unknown', reasoningControls: 'unknown' },
      }],
      credential: {
        kind: 'apiKey', required: true,
        keyUrl: 'https://gateway.example/keys',
        transports: [{
          id: 'runtime-bearer', protocols: ['openai-responses'], uses: ['runtime'],
          destination: { kind: 'httpHeader', name: 'Authorization', format: 'bearer' },
        }],
      },
      catalog: { source: 'manual', manualModelPolicy: 'allowed' },
    }),
  };
}

function noAuthContribution(identity: Readonly<{ id?: string; name?: string }> = {}): ResolvedProviderContribution {
  const value = contribution();
  const { credential: _credential, ...definition } = value.definition;
  return {
    ...value,
    definition: ProviderContributionV1Schema.parse({
      ...definition,
      id: identity.id ?? 'public',
      name: identity.name ?? 'Public',
    }),
  };
}

function localContribution(): ResolvedProviderContribution {
  const value = noAuthContribution();
  return {
    ...value,
    definition: ProviderContributionV1Schema.parse({
      ...value.definition, id: 'local', name: 'Local', kind: 'local',
      endpointTemplates: [{
        id: 'chat', protocol: 'openai-chat',
        localUrlCandidates: ['http://127.0.0.1:11434/v1', 'http://127.0.0.1:1234/v1'],
        capabilities: { streaming: 'unknown', toolRoundTrips: 'unknown', statefulResponses: 'unknown', reasoningControls: 'unknown' },
      }],
      catalog: { source: 'probe', manualModelPolicy: 'allowed', probes: [{ endpointTemplateId: 'chat', path: '/v1/models', parser: 'openai-models' }] },
      discovery: {
        v: 1,
        listener: { executableBasenames: ['local-server'], defaultPorts: [11434] },
        availabilityProbe: { endpointTemplateId: 'chat', path: '/v1/models', parser: 'openai-models' },
      },
    }),
  };
}

function adoptedAggregatorContribution(): ResolvedProviderContribution {
  const value = localContribution();
  return {
    ...value,
    definition: ProviderContributionV1Schema.parse({
      ...value.definition,
      id: 'adopted-aggregator',
      name: 'Adopted aggregator',
      kind: 'aggregator',
    }),
  };
}

function managedContribution(): Extract<
  ResolvedProviderContribution,
  { provenance: 'first_party' }
> {
  const value = noAuthContribution({ id: 'gateway', name: 'Managed Gateway' });
  return {
    ...value,
    provenance: 'first_party',
    source: { kind: 'bundled' },
    managed: {
      managedEndpoint: {
        localService: {
          id: 'gateway',
          launch: {
            kind: 'packaged-runtime-binary',
            directorySegments: ['cliproxyapi', 'unpacked'],
            executableBaseName: 'cliproxyapi',
            privateConfigPathFlag: '--config',
          },
          launchMode: {
            kind: 'assignAndInject',
            portPolicy: { kind: 'allocated' },
          },
          hostPolicy: { kind: 'loopback' },
          name: { strategy: 'fixed', name: 'Managed Gateway' },
          healthCheck: { kind: 'http', path: '/healthz' },
          restart: { kind: 'never' },
          cleanup: { staleAfterMs: 60_000 },
        },
        protocols: ['openai-chat', 'openai-responses'],
      },
      connectedAccounts: [{
        purpose: 'upstream',
        service: {
          pluginId: 'happier.connected-account.openai',
          localId: 'openai',
        },
        required: true,
        materializationKinds: ['httpHeaders'],
      }],
      requestAuthUses: [{
        purpose: 'upstream',
        materialization: {
          kind: 'httpHeaders',
          origin: 'https://api.openai.com',
          headerNames: ['authorization'],
        },
      }],
    },
  };
}

function harness(options: Readonly<{
  enabled?: boolean;
  includeSecret?: boolean;
  dnsEvidence?: ReadonlyMap<string, readonly string[]>;
  localDiscoveryEnabled?: boolean;
  managedEnabled?: boolean;
}> = {}) {
  let raw: Readonly<Record<string, unknown>> = {
    providerSettingsV1: DEFAULT_PROVIDER_SETTINGS_V1,
    secrets: options.includeSecret === false
      ? []
      : [{
          id: 'secret_api',
          name: 'Gateway key',
          kind: 'apiKey',
          encryptedValue: { _isSecretValue: true, value: 'sealed' },
        }],
  };
  let beforeNextUpdate: ((
    current: Readonly<Record<string, unknown>>,
  ) => Readonly<Record<string, unknown>>) | null = null;
  const providersByContributionKey = new Map([[contributionKey, contribution()]]);
  const registry: ProviderContributionRegistryView = { providersByContributionKey };
  const loadSnapshot = vi.fn(async () => ({ accountSettings: raw, registry }));
  const mutationApplications: Array<Readonly<{
    input: Readonly<Record<string, unknown>>;
    output: Readonly<Record<string, unknown>>;
  }>> = [];
  const updateAccountSettings = vi.fn(async (mutate: (
    current: Readonly<Record<string, unknown>>,
  ) => Readonly<Record<string, unknown>>) => {
    if (beforeNextUpdate) {
      const concurrent = beforeNextUpdate;
      beforeNextUpdate = null;
      raw = concurrent(raw);
    }
    const input = raw;
    raw = mutate(input);
    mutationApplications.push({ input, output: raw });
    return raw;
  });
  const collectDnsEvidence = vi.fn(async () => options.dnsEvidence ?? new Map([
    ['https://gateway.example/v1', ['1.1.1.1']],
    ['http://127.0.0.1:8080/v1', ['127.0.0.1']],
  ]));
  const runtimeSummary = vi.fn(async () => ({
    summary: {
      health: 'available' as const,
      modelCount: 3,
      checkedAt: 100,
      endpoints: [],
    },
    probeObservationIdentity: ProviderProbeObservationIdentityV1Schema.parse(
      'probe-observation:v1:fixture-current-facts',
    ),
  }));
  const discoveryCandidates = vi.fn(async (): Promise<readonly ProviderDiscoveryCandidateV1[]> => [{
    v: 1 as const,
    machineId: 'machine-a',
    contributionKey,
    providerName: 'Gateway',
    endpointTemplateId: 'responses',
    normalizedEndpointUrl: 'http://127.0.0.1:1234/v1',
    evidence: { kind: 'attributed_listener' as const },
    ownership: 'adopted' as const,
    connection: { status: 'enable_default' as const },
  }]);
  const localInstallations = vi.fn(async () => [{
    v: 1 as const,
    machineId: 'machine-a',
    contributionKey,
    providerName: 'Gateway',
    status: 'installed_not_running' as const,
    managedStartAvailable: true,
  }]);
  const refreshOnEnable = vi.fn(async () => undefined);
  const startManaged = vi.fn(async () => ({ status: 'running' as const }));
  const compatibilitySummary = vi.fn((): DaemonProviderAgentCompatibilitySummaryV1[] => [{
      agentTargetKey: 'backend:codex', agentName: 'Codex', status: 'experimental' as const,
      reasons: ['compatibility_evidence_missing'],
  }]);
  const acquireCompatibilityProjection = vi.fn(() => ({
    project: compatibilitySummary,
    release: vi.fn(async () => undefined),
  }));
  const service = createProviderConnectionService({
    machineId: 'machine-a',
    featureGate: { isEnabled: (featureId) => featureId === 'providers'
      ? options.enabled !== false
      : featureId === 'providers.localDiscovery'
        ? options.localDiscoveryEnabled !== false
        : options.managedEnabled !== false },
    loadSnapshot,
    updateAccountSettings,
    collectDnsEvidence,
    resolveConnection: ({ accountSettings, connectionId, machineId, registry: currentRegistry, dnsEvidence }) =>
      resolveProviderConnectionForMachine({
        accountSettings, connectionId, machineId, registry: currentRegistry,
        dnsEvidenceByEndpointUrl: dnsEvidence,
      }),
    runtimeSummary,
    acquireCompatibilityProjection,
    discoveryCandidates,
    localInstallations,
    refreshOnEnable,
    startManaged,
    now: () => 100,
  });
  return {
    service, loadSnapshot, updateAccountSettings, collectDnsEvidence, runtimeSummary, compatibilitySummary,
    acquireCompatibilityProjection, discoveryCandidates, localInstallations, refreshOnEnable, startManaged,
    providersByContributionKey,
    getRaw: () => raw,
    mutationApplications,
    setRaw: (next: Record<string, unknown>) => { raw = next; },
    beforeNextUpdate: (mutate: (
      current: Readonly<Record<string, unknown>>,
    ) => Readonly<Record<string, unknown>>) => {
      beforeNextUpdate = mutate;
    },
  };
}

describe('provider connection service', () => {
  it('projects managed process, dependency, protocol, and selected purpose effects without endpoints', async () => {
    const managed = harness();
    managed.providersByContributionKey.set(contributionKey, managedContribution());
    managed.setRaw({
      providerSettingsV1: ProviderSettingsV1Schema.parse({
        ...DEFAULT_PROVIDER_SETTINGS_V1,
        connections: [ProviderConnectionV1Schema.parse({
          v: 1,
          id: 'pc_managed',
          source: { kind: 'contribution', contributionKey },
          role: 'default',
          displayName: 'Managed Gateway',
          displayNameMode: 'automatic',
          deployment: { kind: 'managedLocal' },
          purposeBindingDefaults: {
            upstream: {
              kind: 'account',
              account: {
                service: {
                  pluginId: 'happier.connected-account.openai',
                  localId: 'openai',
                },
                accountId: 'work',
              },
            },
          },
          revision: 0,
          createdAt: 1,
          updatedAt: 1,
        })],
      }),
      secrets: [],
    });

    await expect(managed.service.describe({
      machineId: 'machine-a',
      connectionId: ProviderConnectionIdSchema.parse('pc_managed'),
    })).resolves.toMatchObject({
      status: 'success',
      connections: [{
        connectionId: 'pc_managed',
        deployment: {
          kind: 'managedLocal',
          targetMachineId: 'machine-a',
          effects: {
            implementationIdentity: {
              pluginId: 'acme.gateway',
              localId: 'gateway',
            },
            process: {
              localServiceId: 'gateway',
              manager: 'happier',
              lifetime: 'session',
              network: 'loopback',
              restart: 'never',
            },
            dependency: {
              kind: 'packaged-runtime-binary',
              directorySegments: ['cliproxyapi', 'unpacked'],
              executableBaseName: 'cliproxyapi',
            },
            protocols: ['openai-chat', 'openai-responses'],
            connectedAccountPurposes: [{
              purpose: 'upstream',
              service: {
                pluginId: 'happier.connected-account.openai',
                localId: 'openai',
              },
              required: true,
              target: {
                kind: 'account',
                account: {
                  service: {
                    pluginId: 'happier.connected-account.openai',
                    localId: 'openai',
                  },
                  accountId: 'work',
                },
              },
            }],
          },
        },
        managedLocalOption: {
          targetMachineId: 'machine-a',
          connectedAccountPurposes: [{
            purpose: 'upstream',
            service: {
              pluginId: 'happier.connected-account.openai',
              localId: 'openai',
            },
            required: true,
          }],
        },
        endpoints: [],
      }],
    });
    const beforePreview = structuredClone(managed.getRaw());
    await expect(managed.service.describe({
      machineId: 'machine-a',
      authoringPreview: {
        connectionId: ProviderConnectionIdSchema.parse('pc_unused'),
        contributionKey,
        displayName: null,
        selectedCandidateId: null,
      },
    })).resolves.toMatchObject({
      status: 'error',
      error: { code: 'provider_connection_invalid' },
    });
    expect(managed.getRaw()).toEqual(beforePreview);
  });

  it('CAS-authors managed deployment defaults, preserves group-only intent, and contracts back to external', async () => {
    const managed = harness();
    managed.providersByContributionKey.set(contributionKey, managedContribution());
    managed.setRaw({
      providerSettingsV1: ProviderSettingsV1Schema.parse({
        ...DEFAULT_PROVIDER_SETTINGS_V1,
        connections: [ProviderConnectionV1Schema.parse({
          v: 1,
          id: 'pc_managed',
          source: { kind: 'contribution', contributionKey },
          role: 'default',
          displayName: 'Managed Gateway',
          displayNameMode: 'automatic',
          endpointOverrides: [{
            endpointTemplateId: 'responses',
            baseUrl: 'https://external.example/v1',
          }],
          revision: 0,
          createdAt: 1,
          updatedAt: 1,
        })],
        accountGrants: [{
          v: 1,
          connectionId: 'pc_managed',
          connectionSecurityFingerprint: 'connection-security:v1:external',
          confirmedAt: 1,
        }],
        machineGrants: [{
          v: 1,
          machineId: 'machine-a',
          connectionId: 'pc_managed',
          endpointSetFingerprint: 'endpoint-set:v1:external',
          connectionSecurityFingerprint: 'connection-security:v1:external',
          confirmedAt: 1,
        }],
        secretBindingsByConnectionId: {
          pc_managed: { account: { apiKey: 'secret_api' } },
        },
      }),
      secrets: [{
        id: 'secret_api',
        name: 'Gateway key',
        kind: 'apiKey',
        encryptedValue: 'sealed',
      }],
    });
    const groupTarget = {
      kind: 'group' as const,
      service: {
        pluginId: 'happier.connected-account.openai',
        localId: 'openai',
      },
      groupId: 'team',
    };

    await expect(managed.service.update({
      action: 'update',
      machineId: 'machine-a',
      connectionId: 'pc_managed',
      expectedRevision: 0,
      deployment: {
        kind: 'managedLocal',
        purposeBindingDefaults: { upstream: groupTarget },
      },
    })).resolves.toMatchObject({
      status: 'success',
      revision: 1,
      deployment: {
        kind: 'managedLocal',
        targetMachineId: 'machine-a',
        effects: {
          connectedAccountPurposes: [{
            purpose: 'upstream',
            target: groupTarget,
          }],
        },
      },
      endpoints: [],
      credential: null,
    });
    const managedSettings = readProviderSettingsFromAccountSettingsV1(
      managed.getRaw(),
    ).settings;
    expect(managedSettings.connections[0]).toMatchObject({
      deployment: { kind: 'managedLocal' },
      purposeBindingDefaults: { upstream: groupTarget },
    });
    expect(managedSettings.connections[0]?.endpointOverrides).toBeUndefined();
    expect(
      managedSettings.connections[0]?.endpointOverridesByMachineId,
    ).toBeUndefined();
    expect(readOwnRecordValue(
      managedSettings.secretBindingsByConnectionId,
      'pc_managed',
    ))
      .toBeUndefined();
    expect(managedSettings.accountGrants).toEqual([]);
    expect(managedSettings.machineGrants).toEqual([]);
    expect(JSON.stringify(managedSettings.connections[0]))
      .not.toMatch(/profileId|generation|credential|activeMember/u);
    const beforeManagedExternalAuthoring = structuredClone(managed.getRaw());
    await expect(managed.service.setEndpointOverride({
      action: 'setEndpointOverride',
      machineId: 'machine-a',
      connectionId: 'pc_managed',
      expectedRevision: 1,
      scope: 'account',
      endpointTemplateId: 'responses',
      baseUrl: 'https://forbidden.example/v1',
    })).resolves.toMatchObject({
      status: 'error',
      error: { code: 'provider_connection_invalid' },
    });
    await expect(managed.service.bindSecret({
      action: 'bindSecret',
      machineId: 'machine-a',
      connectionId: 'pc_managed',
      credentialSlotId: 'apiKey',
      savedSecretId: 'secret_api',
      scope: 'account',
    })).resolves.toMatchObject({
      status: 'error',
      error: { code: 'provider_connection_invalid' },
    });
    expect(managed.getRaw()).toEqual(beforeManagedExternalAuthoring);

    const beforeStaleEdit = structuredClone(managed.getRaw());
    await expect(managed.service.update({
      action: 'update',
      machineId: 'machine-a',
      connectionId: 'pc_managed',
      expectedRevision: 0,
      deployment: {
        kind: 'managedLocal',
        purposeBindingDefaults: {
          upstream: { ...groupTarget, groupId: 'stale-team' },
        },
      },
    })).resolves.toMatchObject({
      status: 'error',
      error: { code: 'provider_connection_changed' },
    });
    expect(managed.getRaw()).toEqual(beforeStaleEdit);

    const managedResolution = resolveProviderConnectionForMachine({
      accountSettings: managed.getRaw(),
      connectionId: 'pc_managed',
      machineId: 'machine-a',
      registry: {
        providersByContributionKey:
          managed.providersByContributionKey,
      },
      dnsEvidenceByEndpointUrl: new Map(),
    });
    if (managedResolution.status !== 'resolved') {
      throw new Error('Expected managed connection to resolve');
    }
    managed.setRaw({
      ...managed.getRaw(),
      providerSettingsV1: ProviderSettingsV1Schema.parse({
        ...managedSettings,
        machineGrants: [{
          v: 1,
          machineId: 'machine-a',
          connectionId: 'pc_managed',
          endpointSetFingerprint:
            managedResolution.record.endpointSetFingerprint,
          connectionSecurityFingerprint:
            managedResolution.record.connectionSecurityFingerprint,
          confirmedAt: 2,
        }],
      }),
    });
    await expect(managed.service.update({
      action: 'update',
      machineId: 'machine-a',
      connectionId: 'pc_managed',
      expectedRevision: 1,
      deployment: {
        kind: 'managedLocal',
        purposeBindingDefaults: {
          upstream: { ...groupTarget, groupId: 'future-team' },
        },
      },
    })).resolves.toMatchObject({
      status: 'success',
      revision: 2,
      authorized: true,
      deployment: {
        kind: 'managedLocal',
        effects: {
          connectedAccountPurposes: [{
            target: { kind: 'group', groupId: 'future-team' },
          }],
        },
      },
    });
    expect(
      readProviderSettingsFromAccountSettingsV1(managed.getRaw())
        .settings.machineGrants,
    ).toHaveLength(1);

    await expect(managed.service.update({
      action: 'update',
      machineId: 'machine-a',
      connectionId: 'pc_managed',
      expectedRevision: 2,
      deployment: { kind: 'external' },
    })).resolves.toMatchObject({
      status: 'success',
      revision: 3,
      deployment: { kind: 'external' },
    });
    const externalSettings = readProviderSettingsFromAccountSettingsV1(
      managed.getRaw(),
    ).settings;
    expect(externalSettings.connections[0]?.purposeBindingDefaults)
      .toBeUndefined();
    expect(externalSettings.accountGrants).toEqual([]);
    expect(externalSettings.machineGrants).toEqual([]);
  });

  it('rejects stale connection edits without rewriting legacy external settings bytes', async () => {
    const legacy = harness();
    legacy.setRaw({
      providerSettingsV1: {
        ...DEFAULT_PROVIDER_SETTINGS_V1,
        connections: [{
          v: 1,
          id: 'pc_legacy',
          source: { kind: 'contribution', contributionKey },
          role: 'default',
          displayName: 'Gateway',
          displayNameMode: 'automatic',
          revision: 3,
          createdAt: 1,
          updatedAt: 1,
        }],
      },
      secrets: [],
    });
    const before = structuredClone(legacy.getRaw());

    await expect(legacy.service.update({
      action: 'update',
      machineId: 'machine-a',
      connectionId: 'pc_legacy',
      expectedRevision: 2,
      displayName: 'Stale',
      displayNameMode: 'custom',
    })).resolves.toMatchObject({
      status: 'error',
      error: { code: 'provider_connection_changed' },
    });
    expect(legacy.getRaw()).toEqual(before);
    expect(legacy.mutationApplications.at(-1)?.output)
      .toBe(legacy.mutationApplications.at(-1)?.input);

    await expect(legacy.service.setEndpointOverride({
      action: 'setEndpointOverride',
      machineId: 'machine-a',
      connectionId: 'pc_legacy',
      expectedRevision: 2,
      scope: 'account',
      endpointTemplateId: 'responses',
      baseUrl: 'https://stale.example/v1',
    })).resolves.toMatchObject({
      status: 'error',
      error: { code: 'provider_connection_changed' },
    });
    expect(legacy.getRaw()).toEqual(before);
    expect(legacy.mutationApplications.at(-1)?.output)
      .toBe(legacy.mutationApplications.at(-1)?.input);
  });

  it('contracts managed deployment to external when its contribution source is unavailable', async () => {
    const managed = harness();
    managed.providersByContributionKey.set(
      contributionKey,
      managedContribution(),
    );
    managed.setRaw({
      providerSettingsV1: ProviderSettingsV1Schema.parse({
        ...DEFAULT_PROVIDER_SETTINGS_V1,
        connections: [ProviderConnectionV1Schema.parse({
          v: 1,
          id: 'pc_managed',
          source: { kind: 'contribution', contributionKey },
          role: 'default',
          displayName: 'Managed Gateway',
          displayNameMode: 'automatic',
          deployment: { kind: 'managedLocal' },
          purposeBindingDefaults: {
            upstream: {
              kind: 'group',
              service: {
                pluginId: 'happier.connected-account.openai',
                localId: 'openai',
              },
              groupId: 'team',
            },
          },
          revision: 0,
          createdAt: 1,
          updatedAt: 1,
        })],
      }),
      secrets: [],
    });
    managed.providersByContributionKey.delete(contributionKey);

    await expect(managed.service.update({
      action: 'update',
      machineId: 'machine-a',
      connectionId: 'pc_managed',
      expectedRevision: 0,
      deployment: { kind: 'external' },
    })).resolves.toMatchObject({
      status: 'success',
      revision: 1,
      sourceStatus: 'unavailable',
      deployment: { kind: 'external' },
    });
    expect(
      readProviderSettingsFromAccountSettingsV1(managed.getRaw())
        .settings.connections[0],
    ).toMatchObject({
      deployment: { kind: 'external' },
      revision: 1,
    });
    expect(
      readProviderSettingsFromAccountSettingsV1(managed.getRaw())
        .settings.connections[0]?.purposeBindingDefaults,
    ).toBeUndefined();
  });

  it('rejects forged or undeclared managed deployment defaults before settings write', async () => {
    const managed = harness();
    const externalConnection = ProviderConnectionV1Schema.parse({
      v: 1,
      id: 'pc_managed',
      source: { kind: 'contribution', contributionKey },
      role: 'default',
      displayName: 'Gateway',
      displayNameMode: 'automatic',
      revision: 0,
      createdAt: 1,
      updatedAt: 1,
    });
    managed.setRaw({
      providerSettingsV1: ProviderSettingsV1Schema.parse({
        ...DEFAULT_PROVIDER_SETTINGS_V1,
        connections: [externalConnection],
      }),
      secrets: [],
    });
    const before = structuredClone(managed.getRaw());
    const request = {
      action: 'update' as const,
      machineId: 'machine-a',
      connectionId: 'pc_managed',
      expectedRevision: 0,
      deployment: {
        kind: 'managedLocal' as const,
        purposeBindingDefaults: {
          upstream: {
            kind: 'group' as const,
            service: {
              pluginId: 'happier.connected-account.openai',
              localId: 'openai',
            },
            groupId: 'team',
          },
        },
      },
    };

    await expect(managed.service.update(request)).resolves.toMatchObject({
      status: 'error',
      error: { code: 'provider_connection_invalid' },
    });
    expect(managed.getRaw()).toEqual(before);

    managed.providersByContributionKey.set(
      contributionKey,
      managedContribution(),
    );
    await expect(managed.service.update({
      ...request,
      deployment: {
        kind: 'managedLocal',
        purposeBindingDefaults: {
          upstream: {
            ...request.deployment.purposeBindingDefaults.upstream,
            service: { pluginId: 'acme.foreign', localId: 'foreign' },
          },
        },
      },
    })).resolves.toMatchObject({
      status: 'error',
      error: { code: 'provider_connection_invalid' },
    });
    expect(managed.getRaw()).toEqual(before);

    await expect(managed.service.update({
      ...request,
      deployment: {
        kind: 'managedLocal',
        purposeBindingDefaults: {
          other: request.deployment.purposeBindingDefaults.upstream,
        },
      },
    })).resolves.toMatchObject({
      status: 'error',
      error: { code: 'provider_connection_invalid' },
    });
    expect(managed.getRaw()).toEqual(before);

    const managedWithRequiredPurpose = managedContribution();
    managed.providersByContributionKey.set(contributionKey, {
      ...managedWithRequiredPurpose,
      managed: {
        ...managedWithRequiredPurpose.managed!,
        connectedAccounts: [
          ...managedWithRequiredPurpose.managed!.connectedAccounts,
          {
            purpose: 'optional',
            service: {
              pluginId: 'happier.connected-account.openai',
              localId: 'openai',
            },
            required: false,
          },
        ],
        requestAuthUses: [
          ...managedWithRequiredPurpose.managed!.requestAuthUses,
          {
            purpose: 'optional',
            materialization: {
              kind: 'httpHeaders',
              origin: 'https://api.openai.com',
              headerNames: ['authorization'],
            },
          },
        ],
      },
    });
    await expect(managed.service.update({
      ...request,
      deployment: {
        kind: 'managedLocal',
        purposeBindingDefaults: {
          optional: request.deployment.purposeBindingDefaults.upstream,
        },
      },
    })).resolves.toMatchObject({
      status: 'error',
      error: { code: 'provider_connection_invalid' },
    });
    expect(managed.getRaw()).toEqual(before);
    expect(managed.updateAccountSettings).not.toHaveBeenCalled();
  });

  it('projects every flat connection-mutation service success into the strict RPC connection shape', async () => {
    const h = harness();
    await h.service.create({
      action: 'createContribution', machineId: 'machine-a', connectionId: 'pc_gateway',
      contributionKey, displayName: null, savedSecretId: 'secret_api', enable: false,
    });
    const adapter = createProviderConnectionRpcAdapter(h.service);

    const local = harness({
      dnsEvidence: new Map([['http://127.0.0.1:22434/v1', ['127.0.0.1']]]),
    });
    local.providersByContributionKey.set(contributionKey, localContribution());
    const localCandidate = {
      v: 1 as const,
      machineId: 'machine-a',
      contributionKey,
      providerName: 'Local',
      endpointTemplateId: 'chat',
      normalizedEndpointUrl: 'http://127.0.0.1:22434/v1',
      candidateId: createProviderDiscoveryCandidateIdV1({
        machineId: 'machine-a',
        contributionKey,
        endpointTemplateId: 'chat',
        normalizedEndpointUrl: 'http://127.0.0.1:22434/v1',
      }),
      evidence: { kind: 'attributed_listener' as const },
      ownership: 'adopted' as const,
      connection: { status: 'enable_default' as const },
    };
    local.discoveryCandidates.mockResolvedValue([localCandidate]);
    const localAdapter = createProviderConnectionRpcAdapter(local.service);
    const gatewayConnectionId = ProviderConnectionIdSchema.parse('pc_gateway');
    const workConnectionId = ProviderConnectionIdSchema.parse('pc_work');
    const localConnectionId = ProviderConnectionIdSchema.parse('pc_local');

    const cases = [
      {
        action: 'update', expectedConnectionId: 'pc_gateway', run: () => adapter.mutateConnection({
          action: 'update', machineId: 'machine-a', connectionId: gatewayConnectionId, expectedRevision: 0,
          displayName: 'Primary', displayNameMode: 'custom',
        }),
      },
      {
        action: 'setEndpointOverride', expectedConnectionId: 'pc_gateway', run: () => adapter.mutateConnection({
          action: 'setEndpointOverride', machineId: 'machine-a', connectionId: gatewayConnectionId, expectedRevision: 1,
          scope: 'account', endpointTemplateId: 'responses', baseUrl: 'https://gateway.example/v1',
        }),
      },
      {
        action: 'duplicate', expectedConnectionId: 'pc_work', run: () => adapter.mutateConnection({
          action: 'duplicate', machineId: 'machine-a', connectionId: gatewayConnectionId,
          newConnectionId: workConnectionId, displayName: 'Work', mode: 'sameSource',
        }),
      },
      {
        action: 'bindSecret', expectedConnectionId: 'pc_work', run: () => adapter.mutateConnection({
          action: 'bindSecret', machineId: 'machine-a', connectionId: workConnectionId,
          credentialSlotId: 'apiKey', savedSecretId: 'secret_api', scope: 'account',
        }),
      },
      {
        action: 'setEnabled', expectedConnectionId: 'pc_gateway', run: () => adapter.mutateConnection({
          action: 'setEnabled', machineId: 'machine-a', connectionId: gatewayConnectionId, enabled: true,
        }),
      },
      {
        action: 'enableDetected', expectedConnectionId: 'pc_local', run: () => localAdapter.mutateConnection({
          action: 'enableDetected', machineId: 'machine-a', connectionId: localConnectionId,
          candidateId: localCandidate.candidateId, displayName: null, savedSecretId: null,
        }),
      },
    ] as const;

    for (const mutationCase of cases) {
      const response = await mutationCase.run();
      expect(response).toMatchObject({
        status: 'success',
        action: mutationCase.action,
        connection: { connectionId: mutationCase.expectedConnectionId },
      });
      expect(response).not.toHaveProperty('connection.status');
    }
  });

  it('previews exact normalized cloud destinations without writing settings', async () => {
    const cloud = harness();
    const cloudBefore = structuredClone(cloud.getRaw());
    await expect(cloud.service.describe({
      machineId: 'machine-a',
      authoringPreview: {
        connectionId: ProviderConnectionIdSchema.parse('pc_cloud_preview'), contributionKey, displayName: null,
        selectedCandidateId: null,
      },
    })).resolves.toMatchObject({
      status: 'success',
      authoringPreview: {
        status: 'resolved', connectionId: 'pc_cloud_preview', created: true,
        candidateId: null,
        scope: 'account',
        machineId: null,
        endpoints: [{
          endpointTemplateId: 'responses', normalizedUrl: 'https://gateway.example/v1',
          locality: 'public', scope: 'account',
        }],
        credential: { slotId: 'apiKey', label: 'api_key', required: true },
        fingerprint: expect.stringMatching(/^authoring-review:v1:/u),
        revision: 0,
      },
    });
    expect(cloud.getRaw()).toEqual(cloudBefore);
    expect(cloud.updateAccountSettings).not.toHaveBeenCalled();
  });

  it('requires an exact local candidate, persists its daemon-resolved endpoints, and rejects an expired selection', async () => {
    const local = harness({
      dnsEvidence: new Map([
        ['http://127.0.0.1:22434/v1', ['127.0.0.1']],
        ['http://127.0.0.1:22435/v1', ['127.0.0.1']],
      ]),
    });
    const localKey = 'acme.gateway/local-preview';
    const localDefinition = localContribution();
    local.providersByContributionKey.set(localKey, localDefinition);
    const candidate = (port: number) => {
      const normalizedEndpointUrl = `http://127.0.0.1:${port}/v1`;
      return {
        v: 1 as const,
        machineId: 'machine-a', contributionKey: localKey, providerName: 'Local',
        endpointTemplateId: 'chat', normalizedEndpointUrl,
        evidence: { kind: 'attributed_listener' as const }, ownership: 'adopted' as const,
        connection: { status: 'enable_default' as const },
      };
    };
    const first = candidate(22434);
    const second = candidate(22435);
    local.discoveryCandidates.mockResolvedValue([first, second]);

    const choices = await local.service.describe({
      machineId: 'machine-a',
      authoringPreview: {
        connectionId: ProviderConnectionIdSchema.parse('pc_local_preview'), contributionKey: localKey, displayName: null,
        selectedCandidateId: null,
      },
    });
    expect(choices).toMatchObject({
      status: 'success',
      authoringPreview: {
        status: 'selection_required',
        candidates: expect.arrayContaining([
          expect.objectContaining({ endpoints: [expect.objectContaining({ normalizedUrl: first.normalizedEndpointUrl })] }),
          expect.objectContaining({ endpoints: [expect.objectContaining({ normalizedUrl: second.normalizedEndpointUrl })] }),
        ]),
      },
    });
    if (choices.status !== 'success' || choices.authoringPreview?.status !== 'selection_required') {
      throw new TypeError('Expected local authoring candidate selection');
    }
    const firstChoice = choices.authoringPreview.candidates.find((entry) =>
      entry.endpoints.some((endpoint) => endpoint.normalizedUrl === first.normalizedEndpointUrl));
    if (!firstChoice) throw new TypeError('Expected first local authoring candidate');

    const selected = await local.service.describe({
      machineId: 'machine-a',
      authoringPreview: {
        connectionId: ProviderConnectionIdSchema.parse('pc_local_preview'), contributionKey: localKey, displayName: null,
        selectedCandidateId: firstChoice.candidateId,
      },
    });
    expect(selected).toMatchObject({
      status: 'success',
      authoringPreview: {
        status: 'resolved', candidateId: firstChoice.candidateId, scope: 'machine', machineId: 'machine-a',
        endpoints: [{ normalizedUrl: first.normalizedEndpointUrl, locality: 'loopback', scope: 'machine' }],
        fingerprint: expect.stringMatching(/^authoring-review:v1:/u), revision: 1,
      },
    });
    if (selected.status !== 'success' || selected.authoringPreview?.status !== 'resolved') {
      throw new TypeError('Expected a resolved local authoring review');
    }
    expect(local.updateAccountSettings).not.toHaveBeenCalled();

    const beforeExpiredCreate = structuredClone(local.getRaw());
    local.discoveryCandidates.mockResolvedValue([second]);
    await expect(local.service.create({
      action: 'createContribution', machineId: 'machine-a', connectionId: 'pc_local_preview',
      contributionKey: localKey, displayName: null, savedSecretId: null, enable: true,
      authoringReview: {
        candidateId: firstChoice.candidateId,
        fingerprint: selected.authoringPreview.fingerprint,
        revision: selected.authoringPreview.revision,
      },
    })).resolves.toMatchObject({ status: 'error', error: { code: 'provider_authorization_changed' } });
    expect(local.getRaw()).toEqual(beforeExpiredCreate);

    local.discoveryCandidates.mockResolvedValue([first, second]);
    await expect(local.service.create({
      action: 'createContribution', machineId: 'machine-a', connectionId: 'pc_local_preview',
      contributionKey: localKey, displayName: null, savedSecretId: null, enable: true,
      authoringReview: {
        candidateId: firstChoice.candidateId,
        fingerprint: selected.authoringPreview.fingerprint,
        revision: selected.authoringPreview.revision,
      },
    })).resolves.toMatchObject({ status: 'success', created: true, connection: { authorized: true } });
    const persisted = readProviderSettingsFromAccountSettingsV1(local.getRaw()).settings.connections
      .find((connection) => connection.id === 'pc_local_preview');
    expect(readOwnRecordValue(persisted?.endpointOverridesByMachineId, 'machine-a')).toEqual([
      { endpointTemplateId: 'chat', baseUrl: first.normalizedEndpointUrl },
    ]);
    expect(local.updateAccountSettings).toHaveBeenCalledTimes(1);
  });

  it('authorizes an aggregator discovery candidate through the ordinary endpoint review without persisting the preview', async () => {
    const adopted = harness({
      dnsEvidence: new Map([['http://127.0.0.1:22434/v1', ['127.0.0.1']]]),
    });
    const aggregatorKey = 'acme.gateway/adopted-aggregator';
    adopted.providersByContributionKey.set(aggregatorKey, adoptedAggregatorContribution());
    adopted.discoveryCandidates.mockResolvedValue([{
      v: 1,
      machineId: 'machine-a',
      contributionKey: aggregatorKey,
      providerName: 'Adopted aggregator',
      endpointTemplateId: 'chat',
      normalizedEndpointUrl: 'http://127.0.0.1:22434/v1',
      evidence: { kind: 'attributed_listener' },
      ownership: 'adopted',
      connection: { status: 'enable_default' },
    }]);

    await expect(adopted.service.describe({
      machineId: 'machine-a',
      authoringPreview: {
        connectionId: ProviderConnectionIdSchema.parse('pc_adopted_aggregator'),
        contributionKey: aggregatorKey,
        displayName: null,
        selectedCandidateId: null,
      },
    })).resolves.toMatchObject({
      status: 'success',
      authoringPreview: {
        status: 'resolved',
        candidateId: expect.stringMatching(/^discovery-candidate:v1:/u),
        scope: 'machine',
        machineId: 'machine-a',
        endpoints: [{
          endpointTemplateId: 'chat',
          normalizedUrl: 'http://127.0.0.1:22434/v1',
          locality: 'loopback',
          scope: 'machine',
        }],
      },
    });
    expect(adopted.discoveryCandidates).toHaveBeenCalled();
    expect(adopted.collectDnsEvidence).toHaveBeenCalled();
    expect(adopted.updateAccountSettings).not.toHaveBeenCalled();
  });

  it('authors an explicit remote endpoint on the same aggregator contribution through ordinary review', async () => {
    const remote = harness({
      dnsEvidence: new Map([['https://remote.gateway.example/v1', ['8.8.8.8']]]),
    });
    const aggregatorKey = 'acme.gateway/adopted-aggregator-remote';
    remote.providersByContributionKey.set(aggregatorKey, adoptedAggregatorContribution());
    const endpointOverrides = [{
      endpointTemplateId: 'chat',
      baseUrl: 'https://remote.gateway.example/v1',
    }];

    const reviewed = await remote.service.describe({
      machineId: 'machine-a',
      authoringPreview: {
        connectionId: ProviderConnectionIdSchema.parse('pc_aggregator_remote'),
        contributionKey: aggregatorKey,
        displayName: 'Remote',
        selectedCandidateId: null,
        endpointOverrides,
      },
    });
    expect(reviewed).toMatchObject({
      status: 'success',
      authoringPreview: {
        status: 'resolved',
        candidateId: null,
        scope: 'account',
        machineId: null,
        endpoints: [{
          endpointTemplateId: 'chat',
          normalizedUrl: 'https://remote.gateway.example/v1',
          locality: 'public',
          scope: 'account',
        }],
      },
    });
    if (reviewed.status !== 'success' || reviewed.authoringPreview?.status !== 'resolved') {
      throw new TypeError('Expected a resolved explicit remote authoring review');
    }
    expect(remote.updateAccountSettings).not.toHaveBeenCalled();

    await expect(remote.service.create({
      action: 'createContribution',
      machineId: 'machine-a',
      connectionId: 'pc_aggregator_remote',
      contributionKey: aggregatorKey,
      displayName: 'Remote',
      savedSecretId: null,
      enable: true,
      authoringReview: {
        candidateId: null,
        fingerprint: reviewed.authoringPreview.fingerprint,
        revision: reviewed.authoringPreview.revision,
        endpointOverrides,
      },
    })).resolves.toMatchObject({
      status: 'success',
      created: true,
      connection: { authorized: true, scope: 'account' },
    });
    const persisted = readProviderSettingsFromAccountSettingsV1(remote.getRaw()).settings.connections
      .find((connection) => connection.id === 'pc_aggregator_remote');
    expect(persisted?.endpointOverrides).toEqual(endpointOverrides);
    expect(persisted?.endpointOverridesByMachineId).toBeUndefined();
  });

  it('fails local authoring preview closed when authoritative discovery is unavailable', async () => {
    const local = harness();
    const localKey = 'acme.gateway/local-preview-unavailable';
    local.providersByContributionKey.set(localKey, localContribution());
    local.discoveryCandidates.mockRejectedValue(new Error('inventory snapshot unavailable'));
    const beforePreview = structuredClone(local.getRaw());

    await expect(local.service.describe({
      machineId: 'machine-a',
      authoringPreview: {
        connectionId: ProviderConnectionIdSchema.parse('pc_local_preview_unavailable'),
        contributionKey: localKey,
        displayName: null,
        selectedCandidateId: null,
      },
    })).resolves.toMatchObject({
      status: 'error',
      error: {
        code: 'provider_endpoint_unavailable',
        connectionId: 'pc_local_preview_unavailable',
        machineId: 'machine-a',
        retryable: true,
        action: 'retry',
      },
    });
    expect(local.getRaw()).toEqual(beforePreview);
    expect(local.updateAccountSettings).not.toHaveBeenCalled();
  });

  it('describes a canonical-key connection with endpoint, credential, and compatibility facts', async () => {
    const h = harness();
    await h.service.create({
      action: 'createContribution', machineId: 'machine-a', connectionId: 'pc_gateway',
      contributionKey, displayName: null, savedSecretId: 'secret_api', enable: false,
    });

    await expect(h.service.describe({ machineId: 'machine-a', connectionId: ProviderConnectionIdSchema.parse('pc_gateway') }))
      .resolves.toMatchObject({
        status: 'success',
        available: [],
        connections: [{
          contributionKey,
          provenance: 'external',
          sourceStatus: 'available',
          websiteUrl: 'https://gateway.example',
          credential: {
            required: true,
            accountBound: true,
            keyUrl: 'https://gateway.example/keys',
          },
          compatibility: [{ agentTargetKey: 'backend:codex', status: 'experimental' }],
          endpoints: [{ defaultBaseUrl: 'https://gateway.example/v1' }],
        }],
      });
  });

  it('projects the probe runtime owner identity without deriving it from connection revision or display fields', async () => {
    const h = harness();
    await expect(h.service.create({
      action: 'createContribution', machineId: 'machine-a', connectionId: 'pc_gateway',
      contributionKey, displayName: 'Work gateway', savedSecretId: 'secret_api', enable: true,
    })).resolves.toMatchObject({
      status: 'success',
      connection: {
        displayName: 'Work gateway',
        probeObservationIdentity: 'probe-observation:v1:fixture-current-facts',
        runtime: { health: 'available', modelCount: 3 },
      },
    });
    expect(h.runtimeSummary).toHaveBeenCalledWith(expect.objectContaining({
      connectionId: 'pc_gateway',
      machineId: 'machine-a',
    }));
    h.runtimeSummary.mockClear();
    await h.service.setEnabled({
      action: 'setEnabled', machineId: 'machine-a', connectionId: 'pc_gateway',
      enabled: false, scope: 'connection',
    });
    await expect(h.service.describe({
      machineId: 'machine-a',
      connectionId: ProviderConnectionIdSchema.parse('pc_gateway'),
    })).resolves.toMatchObject({
      status: 'success',
      connections: [{
        authorized: false,
        probeObservationIdentity: null,
        runtime: { health: 'not_checked' },
      }],
    });
    expect(h.runtimeSummary).not.toHaveBeenCalled();
  });

  it('projects external provenance for an available contribution before authoring', async () => {
    const h = harness();
    await expect(h.service.describe({ machineId: 'machine-a' })).resolves.toMatchObject({
      status: 'success',
      available: [{
        contributionKey,
        provenance: 'external',
        endpointTemplates: [{ id: 'responses', protocol: 'openai-responses' }],
      }],
    });
  });

  it('keeps connection authoring available when compatibility runtime projection is unavailable', async () => {
    const h = harness();
    h.acquireCompatibilityProjection.mockImplementationOnce(() => {
      throw new Error('Plugin runtime registry unavailable');
    });

    await expect(h.service.create({
      action: 'createContribution', machineId: 'machine-a', connectionId: 'pc_gateway',
      contributionKey, displayName: null, savedSecretId: 'secret_api', enable: false,
    })).resolves.toMatchObject({
      status: 'success',
      connection: { connectionId: 'pc_gateway', compatibility: [] },
    });
  });

  it('schedules one exact post-commit demand refresh only after a connection is enabled', async () => {
    const h = harness();
    await h.service.create({
      action: 'createContribution', machineId: 'machine-a', connectionId: 'pc_gateway',
      contributionKey, displayName: null, savedSecretId: 'secret_api', enable: false,
    });
    expect(h.refreshOnEnable).not.toHaveBeenCalled();
    await h.service.setEnabled({
      action: 'setEnabled', machineId: 'machine-a', connectionId: 'pc_gateway', enabled: true,
    });
    expect(h.refreshOnEnable).toHaveBeenCalledTimes(1);
    expect(h.refreshOnEnable).toHaveBeenCalledWith(
      { connectionId: 'pc_gateway', machineId: 'machine-a' },
      'enable',
    );
    await h.service.setEnabled({
      action: 'setEnabled', machineId: 'machine-a', connectionId: 'pc_gateway', enabled: false, scope: 'account',
    });
    expect(h.refreshOnEnable).toHaveBeenCalledTimes(1);
  });

  it('fails closed before reading account settings, registry, DNS, or runtime state', async () => {
    const h = harness({ enabled: false });
    await expect(h.service.describe({ machineId: 'machine-a' })).resolves.toMatchObject({
      status: 'error', error: { code: 'provider_feature_disabled' },
    });
    await expect(h.service.create({
      action: 'createContribution', machineId: 'machine-a', connectionId: 'pc_gateway',
      contributionKey, displayName: null, savedSecretId: 'secret_api', enable: true,
    })).resolves.toMatchObject({ status: 'error', error: { code: 'provider_feature_disabled' } });
    expect(h.loadSnapshot).not.toHaveBeenCalled();
    expect(h.updateAccountSettings).not.toHaveBeenCalled();
    expect(h.collectDnsEvidence).not.toHaveBeenCalled();
    expect(h.runtimeSummary).not.toHaveBeenCalled();
    expect(h.discoveryCandidates).not.toHaveBeenCalled();
    expect(h.localInstallations).not.toHaveBeenCalled();
  });

  it('returns redacted local discovery candidates only when the dependent feature gate is enabled', async () => {
    const enabled = harness();
    await expect(enabled.service.describe({ machineId: 'machine-a' })).resolves.toMatchObject({
      status: 'success',
      discoveryCandidates: [{ contributionKey, evidence: { kind: 'attributed_listener' } }],
      localInstallations: [{ contributionKey, status: 'installed_not_running' }],
    });
    expect(enabled.discoveryCandidates).toHaveBeenCalledOnce();
    expect(enabled.localInstallations).toHaveBeenCalledOnce();

    const disabled = harness({ localDiscoveryEnabled: false });
    await expect(disabled.service.describe({ machineId: 'machine-a' })).resolves.toMatchObject({
      status: 'success', discoveryCandidates: [],
      localInstallations: [],
    });
    expect(disabled.discoveryCandidates).not.toHaveBeenCalled();
    expect(disabled.localInstallations).not.toHaveBeenCalled();

    const managedDisabled = harness({ managedEnabled: false });
    await expect(managedDisabled.service.describe({ machineId: 'machine-a' })).resolves.toMatchObject({
      status: 'success', localInstallations: [{ managedStartAvailable: false }],
    });
  });

  it('preserves configured connections when advisory local installation projection rejects', async () => {
    const h = harness();
    await h.service.create({
      action: 'createContribution', machineId: 'machine-a', connectionId: 'pc_gateway',
      contributionKey, displayName: null, savedSecretId: 'secret_api', enable: false,
    });
    const beforeDescribe = structuredClone(h.getRaw());
    h.localInstallations.mockRejectedValueOnce(new Error('installation projection unavailable'));

    await expect(h.service.describe({ machineId: 'machine-a' })).resolves.toMatchObject({
      status: 'success',
      connections: [{ connectionId: 'pc_gateway' }],
      localInstallations: [],
    });
    expect(h.getRaw()).toEqual(beforeDescribe);
  });

  it('preserves configured connections when advisory discovery projection rejects', async () => {
    const h = harness();
    await h.service.create({
      action: 'createContribution', machineId: 'machine-a', connectionId: 'pc_gateway',
      contributionKey, displayName: null, savedSecretId: 'secret_api', enable: false,
    });
    const beforeDescribe = structuredClone(h.getRaw());
    h.discoveryCandidates.mockRejectedValueOnce(new Error('inventory snapshot unavailable'));

    await expect(h.service.describe({ machineId: 'machine-a' })).resolves.toMatchObject({
      status: 'success',
      connections: [{ connectionId: 'pc_gateway' }],
      discoveryCandidates: [],
    });
    expect(h.getRaw()).toEqual(beforeDescribe);
  });

  it('bounds discovery summaries and reports truncation instead of overflowing the RPC contract', async () => {
    const h = harness();
    const candidate = (await h.discoveryCandidates())[0];
    if (!candidate) throw new Error('expected discovery fixture');
    h.discoveryCandidates.mockResolvedValue(Array.from({ length: 257 }, (_, index) => ({
      ...candidate,
      normalizedEndpointUrl: `http://127.0.0.1:${10_000 + index}/`,
    })));
    await expect(h.service.describe({ machineId: 'machine-a' })).resolves.toMatchObject({
      status: 'success', discoveryCandidatesTruncated: true,
      discoveryCandidates: expect.any(Array),
    });
    const result = await h.service.describe({ machineId: 'machine-a' });
    expect(result.status === 'success' ? result.discoveryCandidates : []).toHaveLength(256);
  });

  it('atomically creates, machine-overrides, and grants a revalidated detected listener', async () => {
    const h = harness({ dnsEvidence: new Map([['http://127.0.0.1:22434/v1', ['127.0.0.1']]]) });
    h.providersByContributionKey.set(contributionKey, localContribution());
    const currentCandidate = {
      v: 1,
      machineId: 'machine-a',
      contributionKey,
      providerName: 'Local',
      endpointTemplateId: 'chat',
      normalizedEndpointUrl: 'http://127.0.0.1:22434/v1',
      candidateId: createProviderDiscoveryCandidateIdV1({
        machineId: 'machine-a',
        contributionKey,
        endpointTemplateId: 'chat',
        normalizedEndpointUrl: 'http://127.0.0.1:22434/v1',
      }),
      evidence: { kind: 'attributed_listener' },
      ownership: 'adopted',
      connection: { status: 'enable_default' },
    } as const;
    h.discoveryCandidates.mockResolvedValue([currentCandidate]);

    const result = await h.service.enableDetected({
      action: 'enableDetected', machineId: 'machine-a', connectionId: 'pc_local',
      candidateId: currentCandidate.candidateId,
      displayName: null, savedSecretId: null,
    });
    expect(result).toMatchObject({
      status: 'success', connectionId: 'pc_local', authorized: true, scope: 'machine',
    });
    const settings = readProviderSettingsFromAccountSettingsV1(h.getRaw()).settings;
    expect(settings.connections[0]?.endpointOverridesByMachineId?.['machine-a']).toEqual([
      { endpointTemplateId: 'chat', baseUrl: 'http://127.0.0.1:22434/v1' },
    ]);
    expect(settings.machineGrants).toHaveLength(1);
    expect(settings.accountGrants).toHaveLength(0);
    expect(h.updateAccountSettings).toHaveBeenCalledTimes(1);
  });

  it('never starts or mutates an adopted aggregator process while enabling and deleting its connection', async () => {
    const h = harness({ dnsEvidence: new Map([['http://127.0.0.1:22434/v1', ['127.0.0.1']]]) });
    h.providersByContributionKey.set(contributionKey, adoptedAggregatorContribution());
    const normalizedEndpointUrl = 'http://127.0.0.1:22434/v1';
    const candidateId = createProviderDiscoveryCandidateIdV1({
      machineId: 'machine-a',
      contributionKey,
      endpointTemplateId: 'chat',
      normalizedEndpointUrl,
    });
    h.discoveryCandidates.mockResolvedValue([{
      v: 1,
      machineId: 'machine-a',
      contributionKey,
      providerName: 'Adopted aggregator',
      endpointTemplateId: 'chat',
      normalizedEndpointUrl,
      candidateId,
      evidence: { kind: 'attributed_listener' },
      ownership: 'adopted',
      connection: { status: 'enable_default' },
    }]);

    await expect(h.service.enableDetected({
      action: 'enableDetected',
      machineId: 'machine-a',
      connectionId: 'pc_adopted',
      candidateId,
      displayName: null,
      savedSecretId: null,
    })).resolves.toMatchObject({ status: 'success', authorized: true });
    await expect(h.service.delete({
      action: 'delete',
      machineId: 'machine-a',
      connectionId: 'pc_adopted',
    })).resolves.toMatchObject({ status: 'success', connectionId: 'pc_adopted' });
    expect(h.startManaged).not.toHaveBeenCalled();
    expect(readProviderSettingsFromAccountSettingsV1(h.getRaw()).settings.connections).toEqual([]);
  });

  it('rejects a detected-listener candidate whose opaque id does not describe its current facts', async () => {
    const h = harness({ dnsEvidence: new Map([['http://127.0.0.1:22434/v1', ['127.0.0.1']]]) });
    h.providersByContributionKey.set(contributionKey, localContribution());
    h.discoveryCandidates.mockResolvedValue([{
      v: 1,
      machineId: 'machine-a',
      contributionKey,
      providerName: 'Local',
      endpointTemplateId: 'chat',
      normalizedEndpointUrl: 'http://127.0.0.1:22434/v1',
      candidateId: 'discovery-candidate:v1:not-the-current-facts',
      evidence: { kind: 'attributed_listener' },
      ownership: 'adopted',
      connection: { status: 'enable_default' },
    }]);
    const before = structuredClone(h.getRaw());

    await expect(h.service.enableDetected({
      action: 'enableDetected', machineId: 'machine-a', connectionId: 'pc_local',
      candidateId: 'discovery-candidate:v1:not-the-current-facts',
      displayName: null, savedSecretId: null,
    })).resolves.toMatchObject({
      status: 'error', error: { code: 'provider_authorization_changed' },
    });
    expect(h.getRaw()).toEqual(before);
    expect(h.updateAccountSettings).not.toHaveBeenCalled();
  });

  it('rejects an expired detected-listener candidate without writing settings', async () => {
    const h = harness({ dnsEvidence: new Map([['http://127.0.0.1:22434/v1', ['127.0.0.1']]]) });
    h.providersByContributionKey.set(contributionKey, localContribution());
    h.discoveryCandidates.mockResolvedValue([{
      v: 1,
      machineId: 'machine-a',
      contributionKey,
      providerName: 'Local',
      endpointTemplateId: 'chat',
      normalizedEndpointUrl: 'http://127.0.0.1:22435/v1',
      candidateId: 'discovery-candidate:v1:replacement-listener',
      evidence: { kind: 'attributed_listener' },
      ownership: 'adopted',
      connection: { status: 'enable_default' },
    }]);
    const before = structuredClone(h.getRaw());

    await expect(h.service.enableDetected({
      action: 'enableDetected', machineId: 'machine-a', connectionId: 'pc_local',
      candidateId: 'discovery-candidate:v1:expired-listener',
      displayName: null, savedSecretId: null,
    })).resolves.toMatchObject({
      status: 'error', error: { code: 'provider_authorization_changed' },
    });
    expect(h.getRaw()).toEqual(before);
    expect(h.updateAccountSettings).not.toHaveBeenCalled();
  });

  it('starts only a declared managed local provider behind both dependent feature gates', async () => {
    const h = harness();
    h.discoveryCandidates.mockResolvedValue([]);
    const managed = localContribution();
    const withManaged = {
      ...managed,
      definition: ProviderContributionV1Schema.parse({
        ...managed.definition,
        discovery: {
          ...managed.definition.discovery,
          managedStart: { lookupNames: ['local-server'], fixedArgs: ['serve'] },
        },
      }),
    };
    h.providersByContributionKey.set(contributionKey, withManaged);
    await expect(h.service.startLocal({
      action: 'startLocal', machineId: 'machine-a', connectionId: 'pc_local', contributionKey,
    })).resolves.toMatchObject({ status: 'success', contributionKey, phase: 'running' });

    const disabled = harness({ managedEnabled: false });
    disabled.providersByContributionKey.set(contributionKey, withManaged);
    await expect(disabled.service.startLocal({
      action: 'startLocal', machineId: 'machine-a', connectionId: 'pc_local', contributionKey,
    })).resolves.toMatchObject({ status: 'error', error: { code: 'provider_feature_disabled' } });
  });

  it('atomically creates, binds, and grants a contribution connection using daemon-derived fingerprints', async () => {
    const h = harness();
    const result = await h.service.create({
      action: 'createContribution', machineId: 'machine-a', connectionId: 'pc_gateway',
      contributionKey, displayName: null, savedSecretId: 'secret_api', enable: true,
    });
    expect(result).toMatchObject({
      status: 'success', connection: {
        connectionId: 'pc_gateway', contributionKey, authorized: true, scope: 'account',
      },
    });
    const settings = readProviderSettingsFromAccountSettingsV1(h.getRaw()).settings;
    expect(settings.connections).toHaveLength(1);
    expect(readOwnRecordValue(settings.secretBindingsByConnectionId, 'pc_gateway')?.account).toEqual({ apiKey: 'secret_api' });
    expect(settings.accountGrants).toHaveLength(1);
    expect(settings.machineGrants).toHaveLength(0);
    expect(h.updateAccountSettings).toHaveBeenCalledTimes(1);
    expect(h.collectDnsEvidence).toHaveBeenCalledTimes(2);
    expect(h.collectDnsEvidence.mock.invocationCallOrder[0]!)
      .toBeLessThan(h.updateAccountSettings.mock.invocationCallOrder[0]!);
  });

  it('treats an existing default as an exact no-op without persisting or binding a prepared secret', async () => {
    const h = harness();
    await h.service.create({
      action: 'createContribution', machineId: 'machine-a', connectionId: 'pc_gateway',
      contributionKey, displayName: null, savedSecretId: 'secret_api', enable: false,
    });
    const before = structuredClone(h.getRaw());
    h.updateAccountSettings.mockClear();

    await expect(h.service.create({
      action: 'createContribution', machineId: 'machine-a', connectionId: 'pc_unused',
      contributionKey, displayName: null, savedSecretId: 'secret_replacement', enable: false,
      preparedSavedSecret: {
        id: 'secret_replacement',
        record: SavedSecretSchema.parse({
          id: 'secret_replacement', name: 'Replacement', kind: 'apiKey',
          encryptedValue: { _isSecretValue: true, value: 'replacement-secret' },
          createdAt: 100, updatedAt: 100,
        }),
      },
    })).resolves.toMatchObject({
      status: 'success',
      created: false,
      connection: { connectionId: 'pc_gateway' },
    });

    expect(h.getRaw()).toEqual(before);
    expect(h.updateAccountSettings).not.toHaveBeenCalled();
  });

  it('refuses authorization when endpoint fingerprints change between preview and the winning CAS', async () => {
    const h = harness();
    await h.service.create({
      action: 'createContribution', machineId: 'machine-a', connectionId: 'pc_gateway',
      contributionKey, displayName: null, savedSecretId: 'secret_api', enable: false,
    });
    await h.service.setEndpointOverride({
      action: 'setEndpointOverride', machineId: 'machine-a', connectionId: 'pc_gateway', expectedRevision: 0,
      scope: 'account', endpointTemplateId: 'responses', baseUrl: 'https://1.1.1.1/v1',
    });
    h.beforeNextUpdate((raw) => {
      const current = readProviderSettingsFromAccountSettingsV1(raw).settings;
      return {
        ...raw,
        providerSettingsV1: ProviderSettingsV1Schema.parse({
          ...current,
          connections: current.connections.map((connection) => connection.id === 'pc_gateway'
            ? ProviderConnectionV1Schema.parse({
                ...connection,
                endpointOverrides: [{ endpointTemplateId: 'responses', baseUrl: 'https://8.8.8.8/v1' }],
                revision: connection.revision + 1,
                updatedAt: 101,
              })
            : connection),
        }),
      };
    });
    await expect(h.service.setEnabled({
      action: 'setEnabled', machineId: 'machine-a', connectionId: 'pc_gateway', enabled: true,
    })).resolves.toMatchObject({ status: 'error', error: { code: 'provider_authorization_changed' } });
    const settings = readProviderSettingsFromAccountSettingsV1(h.getRaw()).settings;
    expect(settings.accountGrants).toEqual([]);
    expect(settings.connections[0]?.endpointOverrides?.[0]?.baseUrl).toBe('https://8.8.8.8/v1');
  });

  it('treats concurrent default reuse as a no-op without authorizing or rebinding it', async () => {
    const h = harness();
    h.beforeNextUpdate((raw) => ({
      ...raw,
      providerSettingsV1: ProviderSettingsV1Schema.parse({
        ...DEFAULT_PROVIDER_SETTINGS_V1,
        connections: [ProviderConnectionV1Schema.parse({
          v: 1, id: 'pc_concurrent', source: { kind: 'contribution', contributionKey }, role: 'default',
          displayName: 'Gateway', displayNameMode: 'automatic', revision: 1, createdAt: 99, updatedAt: 101,
          endpointOverrides: [{ endpointTemplateId: 'responses', baseUrl: 'https://8.8.8.8/v1' }],
        })],
      }),
    }));
    await expect(h.service.create({
      action: 'createContribution', machineId: 'machine-a', connectionId: 'pc_allocated',
      contributionKey, displayName: null, savedSecretId: 'secret_race', enable: true,
      preparedSavedSecret: {
        id: 'secret_race',
        record: SavedSecretSchema.parse({
          id: 'secret_race', name: 'Race loser', kind: 'apiKey',
          encryptedValue: { _isSecretValue: true, value: 'race-loser-secret' },
          createdAt: 100, updatedAt: 100,
        }),
      },
    })).resolves.toMatchObject({
      status: 'success',
      created: false,
      connection: { connectionId: 'pc_concurrent', authorized: false },
    });
    const settings = readProviderSettingsFromAccountSettingsV1(h.getRaw()).settings;
    expect(settings.connections.map((entry) => entry.id)).toEqual(['pc_concurrent']);
    expect(settings.accountGrants).toEqual([]);
    expect(settings.secretBindingsByConnectionId).toEqual({});
    expect((h.getRaw().secrets as Array<{ id: string }>).map((secret) => secret.id)).toEqual(['secret_api']);
    expect(h.refreshOnEnable).not.toHaveBeenCalled();
  });

  it('rejects enabling a required-credential connection without resolving DNS or committing settings', async () => {
    const h = harness({ includeSecret: false });
    await expect(h.service.create({
      action: 'createContribution', machineId: 'machine-a', connectionId: 'pc_gateway',
      contributionKey, displayName: null, savedSecretId: null, enable: true,
    })).resolves.toMatchObject({ status: 'error', error: { code: 'provider_secret_missing' } });
    expect(h.collectDnsEvidence).not.toHaveBeenCalled();
    expect(h.updateAccountSettings).not.toHaveBeenCalled();
  });

  it('maps DNS-required and local-candidate endpoint refusals to actionable stable errors without writes', async () => {
    const dnsMissing = harness({ dnsEvidence: new Map() });
    await dnsMissing.service.create({
      action: 'createContribution', machineId: 'machine-a', connectionId: 'pc_saved',
      contributionKey, displayName: null, savedSecretId: 'secret_api', enable: false,
    });
    await expect(dnsMissing.service.setEnabled({
      action: 'setEnabled', machineId: 'machine-a', connectionId: 'pc_saved', enabled: true,
    })).resolves.toMatchObject({ status: 'error', error: { code: 'provider_endpoint_unreachable', action: 'retry' } });
    await expect(dnsMissing.service.create({
      action: 'createContribution', machineId: 'machine-a', connectionId: 'pc_gateway',
      contributionKey, displayName: 'Named', savedSecretId: 'secret_api', enable: true,
    })).resolves.toMatchObject({ status: 'error', error: { code: 'provider_endpoint_unreachable', action: 'retry' } });
    expect(readProviderSettingsFromAccountSettingsV1(dnsMissing.getRaw()).settings.accountGrants).toEqual([]);

    const local = harness();
    const localKey = 'acme.gateway/local';
    local.providersByContributionKey.set(localKey, localContribution());
    await expect(local.service.create({
      action: 'createContribution', machineId: 'machine-a', connectionId: 'pc_local',
      contributionKey: localKey, displayName: null, savedSecretId: null, enable: true,
    })).resolves.toMatchObject({ status: 'error', error: { code: 'provider_connection_invalid', action: 'review_connection' } });
    expect(local.updateAccountSettings).not.toHaveBeenCalled();
  });

  it('rejects latent SavedSecret bindings for no-auth custom and contribution connections', async () => {
    const h = harness();
    const publicKey = 'acme.gateway/public';
    h.providersByContributionKey.set(publicKey, noAuthContribution());
    await expect(h.service.create({
      action: 'createContribution', machineId: 'machine-a', connectionId: 'pc_public',
      contributionKey: publicKey, displayName: null, savedSecretId: 'secret_api', enable: false,
    })).resolves.toMatchObject({ status: 'error', error: { code: 'provider_credential_transport_unavailable' } });
    await expect(h.service.create({
      action: 'createCustom', machineId: 'machine-a', connectionId: 'pc_custom_public',
      template: {
        v: 1, name: 'Public custom',
        endpointTemplates: [{
          id: 'chat', protocol: 'openai-chat', baseUrl: 'https://public.example/v1',
          capabilities: { streaming: 'unknown', toolRoundTrips: 'unknown', statefulResponses: 'unknown', reasoningControls: 'unknown' },
        }],
        catalog: { source: 'manual', manualModelPolicy: 'allowed' },
      },
      savedSecretId: 'secret_api', enable: false,
    })).resolves.toMatchObject({ status: 'error', error: { code: 'provider_credential_transport_unavailable' } });
    expect(readProviderSettingsFromAccountSettingsV1(h.getRaw()).settings.connections).toEqual([]);
    expect(h.updateAccountSettings).not.toHaveBeenCalled();
  });

  it('rejects a SavedSecret when reusing an existing no-auth contribution default', async () => {
    const h = harness();
    const publicKey = 'acme.gateway/public';
    h.providersByContributionKey.set(publicKey, noAuthContribution());
    await expect(h.service.create({
      action: 'createContribution', machineId: 'machine-a', connectionId: 'pc_public',
      contributionKey: publicKey, displayName: null, savedSecretId: null, enable: false,
    })).resolves.toMatchObject({ status: 'success', created: true });
    const before = structuredClone(h.getRaw());
    h.updateAccountSettings.mockClear();

    await expect(h.service.create({
      action: 'createContribution', machineId: 'machine-a', connectionId: 'pc_unused',
      contributionKey: publicKey, displayName: null, savedSecretId: 'secret_api', enable: false,
    })).resolves.toMatchObject({
      status: 'error', error: { code: 'provider_credential_transport_unavailable' },
    });

    expect(h.getRaw()).toEqual(before);
    expect(h.updateAccountSettings).not.toHaveBeenCalled();
  });

  it('reports credential transport, not contribution availability, when binding a no-auth contribution', async () => {
    const h = harness();
    const publicKey = 'acme.gateway/public';
    h.providersByContributionKey.set(publicKey, noAuthContribution());
    await expect(h.service.create({
      action: 'createContribution', machineId: 'machine-a', connectionId: 'pc_public',
      contributionKey: publicKey, displayName: null, savedSecretId: null, enable: false,
    })).resolves.toMatchObject({ status: 'success', created: true });
    const before = structuredClone(h.getRaw());

    await expect(h.service.bindSecret({
      action: 'bindSecret', machineId: 'machine-a', connectionId: 'pc_public',
      credentialSlotId: 'apiKey', savedSecretId: 'secret_api', scope: 'account',
    })).resolves.toMatchObject({
      status: 'error',
      error: {
        code: 'provider_credential_transport_unavailable',
        action: 'review_credential_transport',
      },
    });

    expect(h.getRaw()).toEqual(before);

    h.providersByContributionKey.delete(publicKey);
    await expect(h.service.bindSecret({
      action: 'bindSecret', machineId: 'machine-a', connectionId: 'pc_public',
      credentialSlotId: 'apiKey', savedSecretId: 'secret_api', scope: 'account',
    })).resolves.toMatchObject({
      status: 'error',
      error: {
        code: 'provider_contribution_unavailable',
        action: 'restore_plugin',
      },
    });

    expect(h.getRaw()).toEqual(before);
  });

  it('still removes existing bindings when a contribution becomes no-auth or unavailable', async () => {
    for (const sourceState of ['no-auth', 'unavailable'] as const) {
      const h = harness();
      await expect(h.service.create({
        action: 'createContribution', machineId: 'machine-a', connectionId: 'pc_gateway',
        contributionKey, displayName: null, savedSecretId: 'secret_api', enable: false,
      })).resolves.toMatchObject({ status: 'success', created: true });
      expect(readOwnRecordValue(
        readProviderSettingsFromAccountSettingsV1(h.getRaw()).settings.secretBindingsByConnectionId,
        'pc_gateway',
      )?.account).toEqual({ apiKey: 'secret_api' });

      if (sourceState === 'no-auth') {
        h.providersByContributionKey.set(contributionKey, noAuthContribution({ id: 'gateway', name: 'Gateway' }));
      }
      else h.providersByContributionKey.delete(contributionKey);

      await expect(h.service.bindSecret({
        action: 'bindSecret', machineId: 'machine-a', connectionId: 'pc_gateway',
        credentialSlotId: 'apiKey', savedSecretId: null, scope: 'account',
      })).resolves.toMatchObject({ status: 'success', connectionId: 'pc_gateway' });
      expect(readOwnRecordValue(
        readProviderSettingsFromAccountSettingsV1(h.getRaw()).settings.secretBindingsByConnectionId,
        'pc_gateway',
      )).toBeUndefined();
    }
  });

  it('persists initial manual models atomically with a custom connection', async () => {
    const h = harness();
    const connectionId = ProviderConnectionIdSchema.parse('pc_anthropic_manual');
    await expect(h.service.create({
      action: 'createCustom', machineId: 'machine-a', connectionId,
      template: {
        v: 1, name: 'Anthropic bridge',
        endpointTemplates: [{
          id: 'anthropic', protocol: 'anthropic', baseUrl: 'https://anthropic.example/v1',
          capabilities: { streaming: 'unknown', toolRoundTrips: 'unknown', statefulResponses: 'unknown', reasoningControls: 'unknown' },
        }],
        catalog: { source: 'manual', manualModelPolicy: 'allowed' },
      },
      manualModels: [{ id: 'claude-custom', name: 'Custom Claude' }, { id: 'claude-second' }],
      savedSecretId: null, enable: false,
    })).resolves.toMatchObject({ status: 'success', created: true });
    expect(readProviderSettingsFromAccountSettingsV1(h.getRaw()).settings.manualModelsByConnectionId[connectionId])
      .toMatchObject([{ id: 'claude-custom', name: 'Custom Claude' }, { id: 'claude-second' }]);
    expect(h.updateAccountSettings).toHaveBeenCalledTimes(1);
  });

  it('rejects mismatched prepared-secret identity before committing an orphan secret', async () => {
    const h = harness();
    await expect(h.service.create({
      action: 'createContribution', machineId: 'machine-a', connectionId: 'pc_gateway',
      contributionKey, displayName: null, savedSecretId: 'secret_api', enable: false,
      preparedSavedSecret: {
        id: 'secret_prepared',
        record: SavedSecretSchema.parse({
          id: 'secret_prepared', name: 'Prepared', kind: 'apiKey',
          encryptedValue: { _isSecretValue: true, value: 'secret' }, createdAt: 100, updatedAt: 100,
        }),
      },
    })).resolves.toMatchObject({ status: 'error', error: { code: 'provider_connection_invalid' } });
    expect(h.updateAccountSettings).not.toHaveBeenCalled();
  });

  it('rejects a prepared secret when the existing SavedSecret collection is malformed', async () => {
    const h = harness({ includeSecret: false });
    h.setRaw({
      ...h.getRaw(),
      secrets: { malformed: true },
    });
    const before = structuredClone(h.getRaw());
    const prepared = SavedSecretSchema.parse({
      id: 'secret_prepared',
      name: 'Prepared',
      kind: 'apiKey',
      encryptedValue: { _isSecretValue: true, value: 'secret' },
      createdAt: 100,
      updatedAt: 100,
    });

    await expect(h.service.create({
      action: 'createContribution',
      machineId: 'machine-a',
      connectionId: 'pc_gateway',
      contributionKey,
      displayName: null,
      savedSecretId: prepared.id,
      enable: false,
      preparedSavedSecret: { id: prepared.id, record: prepared },
    })).resolves.toMatchObject({
      status: 'error',
      error: { code: 'provider_connection_invalid' },
    });

    expect(h.getRaw()).toEqual(before);
    expect(h.updateAccountSettings).not.toHaveBeenCalled();
  });

  it('normalizes mutation callback domain errors into stable service results', async () => {
    const h = harness();
    await expect(h.service.update({
      action: 'update', machineId: 'machine-a', connectionId: 'pc_missing', expectedRevision: 0,
      displayName: 'Missing',
    })).resolves.toMatchObject({ status: 'error', error: { code: 'provider_connection_not_found' } });
  });

  it('describes configured and available contributions without exposing secret ids or header values', async () => {
    const h = harness();
    await h.service.create({
      action: 'createContribution', machineId: 'machine-a', connectionId: 'pc_gateway',
      contributionKey, displayName: 'Work', savedSecretId: 'secret_api', enable: true,
    });
    const result = await h.service.describe({ machineId: 'machine-a' });
    expect(result).toMatchObject({
      status: 'success',
      available: [],
      connections: [{
        connectionId: 'pc_gateway', displayName: 'Work', contributionKey,
        probeCapability: 'none', manualModelPolicy: 'allowed', icon: 'sparkles-outline',
        compatibility: [{ agentTargetKey: 'backend:codex', status: 'experimental' }],
        authorized: true, credential: { required: true, accountBound: true, boundMachineIds: [] },
        endpoints: [{
          endpointTemplateId: 'responses', protocol: 'openai-responses',
          baseUrl: 'https://gateway.example/v1', effectiveSource: 'template',
        }],
        runtime: { health: 'available', modelCount: 3 },
      }],
    });
    expect(JSON.stringify(result)).not.toContain('secret_api');
    expect(JSON.stringify(result)).not.toContain('encryptedValue');
    expect(JSON.stringify(result)).not.toContain('Authorization');
  });

  it('projects only declared safe probe capability and never implies a guessed request', async () => {
    const h = harness();
    await h.service.create({
      action: 'createContribution', machineId: 'machine-a', connectionId: 'pc_gateway',
      contributionKey, displayName: null, savedSecretId: 'secret_api', enable: false,
    });
    await expect(h.service.describe({ machineId: 'machine-a', connectionId: ProviderConnectionIdSchema.parse('pc_gateway') }))
      .resolves.toMatchObject({ status: 'success', connections: [{ probeCapability: 'none' }] });

    h.providersByContributionKey.set(contributionKey, localContribution());
    await expect(h.service.describe({ machineId: 'machine-a', connectionId: ProviderConnectionIdSchema.parse('pc_gateway') }))
      .resolves.toMatchObject({ status: 'success', connections: [{ probeCapability: 'catalog' }] });
  });

  it('projects contribution credential requirements so no-auth providers never render a fake key field', async () => {
    const h = harness();
    h.providersByContributionKey.set('acme.public/public', noAuthContribution());
    const result = await h.service.describe({ machineId: 'machine-a' });
    expect(result).toMatchObject({
      status: 'success',
      available: expect.arrayContaining([
        expect.objectContaining({
          contributionKey,
          websiteUrl: 'https://gateway.example',
          credential: { required: true, keyUrl: 'https://gateway.example/keys' },
        }),
        expect.objectContaining({ contributionKey: 'acme.public/public', credential: null }),
      ]),
    });
  });

  it('re-derives the exact machine scope when enabling and removes only that grant when disabling', async () => {
    const h = harness();
    await h.service.create({
      action: 'createCustom', machineId: 'machine-a', connectionId: 'pc_local',
      template: {
        v: 1, name: 'Local',
        endpointTemplates: [{
          id: 'chat', protocol: 'openai-chat', baseUrl: 'http://127.0.0.1:8080/v1',
          capabilities: { streaming: 'unknown', toolRoundTrips: 'unknown', statefulResponses: 'unknown', reasoningControls: 'unknown' },
        }],
        catalog: { source: 'manual', manualModelPolicy: 'allowed' },
      },
      savedSecretId: null, enable: true,
    });
    let settings = readProviderSettingsFromAccountSettingsV1(h.getRaw()).settings;
    expect(settings.machineGrants).toHaveLength(1);
    expect(settings.accountGrants).toHaveLength(0);
    await h.service.setEnabled({
      action: 'setEnabled', machineId: 'machine-a', connectionId: 'pc_local', enabled: false, scope: 'machine',
    });
    settings = readProviderSettingsFromAccountSettingsV1(h.getRaw()).settings;
    expect(settings.machineGrants).toHaveLength(0);
  });

  it('atomically disables every grant for an effective connection toggle while preserving concurrent settings', async () => {
    const h = harness();
    await h.service.create({
      action: 'createContribution', machineId: 'machine-a', connectionId: 'pc_gateway',
      contributionKey, displayName: null, savedSecretId: 'secret_api', enable: true,
    });
    await h.service.setEndpointOverride({
      action: 'setEndpointOverride', machineId: 'machine-a', connectionId: 'pc_gateway', expectedRevision: 0,
      scope: 'machine', endpointTemplateId: 'responses', baseUrl: 'http://127.0.0.1:8080/v1',
    });
    await h.service.setEnabled({
      action: 'setEnabled', machineId: 'machine-a', connectionId: 'pc_gateway', enabled: true,
    });
    let settings = readProviderSettingsFromAccountSettingsV1(h.getRaw()).settings;
    expect(settings.accountGrants).toHaveLength(1);
    expect(settings.machineGrants).toHaveLength(1);
    await expect(h.service.describe({ machineId: 'machine-a', connectionId: ProviderConnectionIdSchema.parse('pc_gateway') }))
      .resolves.toMatchObject({
        status: 'success',
        connections: [{ grants: {
          accountState: 'valid', machineState: 'valid', effectiveState: 'valid',
        } }],
      });
    h.beforeNextUpdate((current) => {
      const latest = readProviderSettingsFromAccountSettingsV1(current).settings;
      return {
        ...current,
        providerSettingsV1: ProviderSettingsV1Schema.parse({
          ...latest,
          manualModelsByConnectionId: {
            ...latest.manualModelsByConnectionId,
            pc_gateway: [{ id: 'concurrent/model', addedAt: 99 }],
          },
        }),
      };
    });
    const disableResult = await h.service.setEnabled({
      action: 'setEnabled', machineId: 'machine-a', connectionId: 'pc_gateway', enabled: false, scope: 'connection',
    });
    expect(disableResult).toMatchObject({ status: 'success' });

    settings = readProviderSettingsFromAccountSettingsV1(h.getRaw()).settings;
    expect(settings.accountGrants).toEqual([]);
    expect(settings.machineGrants).toEqual([]);
    expect(readOwnRecordValue(
      settings.manualModelsByConnectionId,
      ProviderConnectionIdSchema.parse('pc_gateway'),
    )).toEqual([{ id: 'concurrent/model', addedAt: 99 }]);
  });

  it('projects the effective endpoint together with its default, account, and machine hierarchy', async () => {
    const h = harness();
    await h.service.create({
      action: 'createContribution', machineId: 'machine-a', connectionId: 'pc_gateway',
      contributionKey, displayName: null, savedSecretId: 'secret_api', enable: false,
    });
    await h.service.setEndpointOverride({
      action: 'setEndpointOverride', machineId: 'machine-a', connectionId: 'pc_gateway', expectedRevision: 0,
      scope: 'account', endpointTemplateId: 'responses', baseUrl: 'https://account.example/v1',
    });
    await h.service.setEndpointOverride({
      action: 'setEndpointOverride', machineId: 'machine-a', connectionId: 'pc_gateway', expectedRevision: 1,
      scope: 'machine', endpointTemplateId: 'responses', baseUrl: 'http://127.0.0.1:8080/v1',
    });

    await expect(h.service.describe({ machineId: 'machine-a', connectionId: ProviderConnectionIdSchema.parse('pc_gateway') }))
      .resolves.toMatchObject({
        status: 'success',
        connections: [{
          endpoints: [{
            endpointTemplateId: 'responses',
            baseUrl: 'http://127.0.0.1:8080/v1',
            effectiveSource: 'machineOverride',
            defaultBaseUrl: 'https://gateway.example/v1',
            accountOverrideBaseUrl: 'https://account.example/v1',
            machineOverrideBaseUrl: 'http://127.0.0.1:8080/v1',
          }],
        }],
      });
    await h.service.setEndpointOverride({
      action: 'setEndpointOverride', machineId: 'machine-a', connectionId: 'pc_gateway', expectedRevision: 2,
      scope: 'machine', endpointTemplateId: 'responses', baseUrl: null,
    });
    await expect(h.service.describe({ machineId: 'machine-a', connectionId: ProviderConnectionIdSchema.parse('pc_gateway') }))
      .resolves.toMatchObject({
        status: 'success',
        connections: [{ endpoints: [{
          baseUrl: 'https://account.example/v1',
          effectiveSource: 'accountOverride',
          defaultBaseUrl: 'https://gateway.example/v1',
          accountOverrideBaseUrl: 'https://account.example/v1',
          machineOverrideBaseUrl: null,
        }] }],
      });
    await h.service.setEndpointOverride({
      action: 'setEndpointOverride', machineId: 'machine-a', connectionId: 'pc_gateway', expectedRevision: 3,
      scope: 'account', endpointTemplateId: 'responses', baseUrl: null,
    });
    await expect(h.service.describe({ machineId: 'machine-a', connectionId: ProviderConnectionIdSchema.parse('pc_gateway') }))
      .resolves.toMatchObject({
        status: 'success',
        connections: [{ endpoints: [{
          baseUrl: 'https://gateway.example/v1',
          effectiveSource: 'template',
          defaultBaseUrl: 'https://gateway.example/v1',
          accountOverrideBaseUrl: null,
          machineOverrideBaseUrl: null,
        }] }],
      });
  });

  it('projects only effective grants and never renders a stale account grant as enabled', async () => {
    const h = harness();
    await h.service.create({
      action: 'createContribution', machineId: 'machine-a', connectionId: 'pc_gateway',
      contributionKey, displayName: null, savedSecretId: 'secret_api', enable: true,
    });
    await h.service.setEndpointOverride({
      action: 'setEndpointOverride', machineId: 'machine-a', connectionId: 'pc_gateway', expectedRevision: 0,
      scope: 'account', endpointTemplateId: 'responses', baseUrl: 'http://127.0.0.1:8080/v1',
    });
    await h.service.setEnabled({
      action: 'setEnabled', machineId: 'machine-a', connectionId: 'pc_gateway', enabled: true,
    });
    const described = await h.service.describe({ machineId: 'machine-a', connectionId: ProviderConnectionIdSchema.parse('pc_gateway') });
    expect(described).toMatchObject({
      status: 'success',
      connections: [{ grants: {
        accountEnabled: false,
        enabledMachineIds: ['machine-a'],
        accountState: 'stale',
        machineState: 'valid',
        effectiveState: 'valid',
      } }],
    });
    expect(JSON.stringify(described)).not.toContain('Fingerprint');
  });

  it('upserts and removes one endpoint override without replacing siblings', async () => {
    const h = harness();
    await h.service.create({
      action: 'createCustom', machineId: 'machine-a', connectionId: 'pc_multi',
      template: {
        v: 1, name: 'Multi',
        endpointTemplates: [
          {
            id: 'responses', protocol: 'openai-responses', baseUrl: 'https://gateway.example/v1',
            capabilities: { streaming: 'unknown', toolRoundTrips: 'unknown', statefulResponses: 'unknown', reasoningControls: 'unknown' },
          },
          {
            id: 'anthropic', protocol: 'anthropic', baseUrl: 'https://gateway.example/anthropic',
            capabilities: { streaming: 'unknown', toolRoundTrips: 'unknown', statefulResponses: 'unknown', reasoningControls: 'unknown' },
          },
        ],
        catalog: { source: 'manual', manualModelPolicy: 'allowed' },
      },
      savedSecretId: null, enable: false,
    });
    await h.service.setEndpointOverride({
      action: 'setEndpointOverride', machineId: 'machine-a', connectionId: 'pc_multi', expectedRevision: 0,
      scope: 'account', endpointTemplateId: 'responses', baseUrl: 'https://1.1.1.1/v1',
    });
    await h.service.setEndpointOverride({
      action: 'setEndpointOverride', machineId: 'machine-a', connectionId: 'pc_multi', expectedRevision: 1,
      scope: 'account', endpointTemplateId: 'anthropic', baseUrl: 'https://1.1.1.1/anthropic',
    });
    await h.service.setEndpointOverride({
      action: 'setEndpointOverride', machineId: 'machine-a', connectionId: 'pc_multi', expectedRevision: 2,
      scope: 'account', endpointTemplateId: 'responses', baseUrl: null,
    });
    const settings = readProviderSettingsFromAccountSettingsV1(h.getRaw()).settings;
    expect(settings.connections[0]?.endpointOverrides).toEqual([
      { endpointTemplateId: 'anthropic', baseUrl: 'https://1.1.1.1/anthropic' },
    ]);
  });

  it('stores endpoint override identities in locale-independent canonical order', async () => {
    const h = harness();
    await h.service.create({
      action: 'createCustom', machineId: 'machine-a', connectionId: 'pc_order',
      template: {
        v: 1, name: 'Ordered',
        endpointTemplates: [
          {
            id: 'Z', protocol: 'openai-responses', baseUrl: 'https://gateway.example/z',
            capabilities: { streaming: 'unknown', toolRoundTrips: 'unknown', statefulResponses: 'unknown', reasoningControls: 'unknown' },
          },
          {
            id: 'a', protocol: 'anthropic', baseUrl: 'https://gateway.example/a',
            capabilities: { streaming: 'unknown', toolRoundTrips: 'unknown', statefulResponses: 'unknown', reasoningControls: 'unknown' },
          },
        ],
        catalog: { source: 'manual', manualModelPolicy: 'allowed' },
      },
      savedSecretId: null, enable: false,
    });
    await h.service.setEndpointOverride({
      action: 'setEndpointOverride', machineId: 'machine-a', connectionId: 'pc_order', expectedRevision: 0,
      scope: 'account', endpointTemplateId: 'a', baseUrl: 'https://1.1.1.1/a',
    });
    await h.service.setEndpointOverride({
      action: 'setEndpointOverride', machineId: 'machine-a', connectionId: 'pc_order', expectedRevision: 1,
      scope: 'account', endpointTemplateId: 'Z', baseUrl: 'https://1.1.1.1/z',
    });
    expect(readProviderSettingsFromAccountSettingsV1(h.getRaw()).settings.connections[0]?.endpointOverrides
      ?.map((entry) => entry.endpointTemplateId)).toEqual(['Z', 'a']);
  });

  it('deletes every executable reference but retains a redacted display tombstone', async () => {
    const h = harness();
    await h.service.create({
      action: 'createContribution', machineId: 'machine-a', connectionId: 'pc_gateway',
      contributionKey, displayName: null, savedSecretId: 'secret_api', enable: true,
    });
    await h.service.delete({ action: 'delete', machineId: 'machine-a', connectionId: 'pc_gateway' });
    const settings = readProviderSettingsFromAccountSettingsV1(h.getRaw()).settings;
    expect(settings.connections).toEqual([]);
    expect(settings.accountGrants).toEqual([]);
    expect(settings.secretBindingsByConnectionId).toEqual({});
    expect(settings.connectionTombstones).toMatchObject([{ id: 'pc_gateway', lastDisplayName: 'Gateway' }]);
    await expect(h.service.describe({ machineId: 'machine-a', connectionId: ProviderConnectionIdSchema.parse('pc_gateway') }))
      .resolves.toMatchObject({
        status: 'success', connections: [], diagnostics: [],
        deletedConnection: {
          connectionId: 'pc_gateway', contributionKey, lastDisplayName: 'Gateway', deletedAt: 100,
        },
      });
    await expect(h.service.describe({ machineId: 'machine-a', connectionId: ProviderConnectionIdSchema.parse('pc_never') }))
      .resolves.toMatchObject({ status: 'success', connections: [], diagnostics: [], deletedConnection: null });
    const deletedDescription = await h.service.describe({ machineId: 'machine-a', connectionId: ProviderConnectionIdSchema.parse('pc_gateway') });
    expect(JSON.stringify(deletedDescription)).not.toContain('secret_api');
    expect(JSON.stringify(deletedDescription.status === 'success'
      ? deletedDescription.deletedConnection
      : null)).not.toContain('endpointTemplates');
  });

  it('recovers valid read siblings with redacted diagnostics but refuses mutations on malformed or future settings', async () => {
    const h = harness();
    await h.service.create({
      action: 'createContribution', machineId: 'machine-a', connectionId: 'pc_gateway',
      contributionKey, displayName: null, savedSecretId: null, enable: false,
    });
    const beforeMalformed = h.getRaw();
    const providerSettings = beforeMalformed.providerSettingsV1 as Record<string, unknown>;
    h.setRaw({ ...beforeMalformed, providerSettingsV1: {
      ...providerSettings,
      connections: [...(providerSettings.connections as unknown[]), { invalid: true }],
    } });
    await expect(h.service.describe({ machineId: 'machine-a' })).resolves.toMatchObject({
      status: 'success', connections: [{ connectionId: 'pc_gateway' }],
      diagnostics: [{ path: 'connections[1]', reason: 'invalid_record' }],
    });
    const malformedSnapshot = structuredClone(h.getRaw());
    await expect(h.service.update({
      action: 'update', machineId: 'machine-a', connectionId: 'pc_gateway', expectedRevision: 0,
      displayName: 'No write', displayNameMode: 'custom',
    })).resolves.toMatchObject({ status: 'error', error: { code: 'provider_settings_invalid' } });
    expect(h.getRaw()).toEqual(malformedSnapshot);

    h.setRaw({ providerSettingsV1: { v: 2, future: { keep: true } } });
    await expect(h.service.describe({ machineId: 'machine-a' })).resolves.toMatchObject({
      status: 'error', error: { code: 'provider_settings_invalid' },
    });
    const futureSnapshot = structuredClone(h.getRaw());
    await expect(h.service.delete({ action: 'delete', machineId: 'machine-a', connectionId: 'pc_gateway' }))
      .resolves.toMatchObject({ status: 'error', error: { code: 'provider_settings_invalid' } });
    expect(h.getRaw()).toEqual(futureSnapshot);
  });

  it('bounds redacted read diagnostics and marks truncation', async () => {
    const h = harness();
    h.setRaw({
      providerSettingsV1: {
        ...DEFAULT_PROVIDER_SETTINGS_V1,
        modelVisibilityByRef: Object.fromEntries(
          Array.from({ length: 300 }, (_, index) => [
            index === 0 ? `SECRET_SHOULD_NOT_LEAK_${'x'.repeat(800)}` : `invalid-${index}`,
            'hidden',
          ]),
        ),
      },
    });
    const result = await h.service.describe({ machineId: 'machine-a' });
    expect(result).toMatchObject({ status: 'success', diagnosticsTruncated: true });
    if (result.status === 'success') expect(result.diagnostics).toHaveLength(256);
    expect(JSON.stringify(result)).not.toContain('SECRET_SHOULD_NOT_LEAK');
  });

  it('bounds the extensible available contribution catalog and marks truncation', async () => {
    const h = harness();
    for (let index = 0; index < 257; index += 1) {
      const entry = noAuthContribution();
      h.providersByContributionKey.set(`acme.plugin-${index}/public`, {
        ...entry,
        pluginId: `acme.plugin-${index}`,
        identity: {
          ...entry.identity,
          pluginId: `acme.plugin-${index}`,
        },
        definition: ProviderContributionV1Schema.parse({
          ...entry.definition,
          name: `Provider ${String(index).padStart(3, '0')}`,
        }),
      });
    }
    const result = await h.service.describe({ machineId: 'machine-a' });
    expect(result).toMatchObject({ status: 'success', availableTruncated: true });
    if (result.status === 'success') expect(result.available).toHaveLength(256);
  });

  it('returns stable validation errors for schema-valid mutations and preserves settings', async () => {
    const h = harness();
    await h.service.create({
      action: 'createContribution', machineId: 'machine-a', connectionId: 'pc_gateway',
      contributionKey, displayName: 'Named', savedSecretId: null, enable: false,
    });
    const before = structuredClone(h.getRaw());
    await expect(h.service.update({
      action: 'update', machineId: 'machine-a', connectionId: 'pc_gateway', expectedRevision: 0,
      displayNameMode: 'automatic',
    })).resolves.toMatchObject({ status: 'error', error: { code: 'provider_connection_invalid' } });
    expect(h.getRaw()).toEqual(before);
  });

  it('updates by exact revision, duplicates as a distinct named connection, and binds only existing SavedSecret ids', async () => {
    const h = harness();
    await h.service.create({
      action: 'createContribution', machineId: 'machine-a', connectionId: 'pc_gateway',
      contributionKey, displayName: null, savedSecretId: null, enable: false,
    });
    const updated = await h.service.update({
      action: 'update', machineId: 'machine-a', connectionId: 'pc_gateway', expectedRevision: 0,
      displayName: 'Primary', displayNameMode: 'custom',
    });
    expect(updated).toMatchObject({ status: 'success', connectionId: 'pc_gateway', displayName: 'Primary', revision: 1 });
    await expect(h.service.update({
      action: 'update', machineId: 'machine-a', connectionId: 'pc_gateway', expectedRevision: 0,
      displayName: 'Stale write', displayNameMode: 'custom',
    })).resolves.toMatchObject({ status: 'error', error: { code: 'provider_connection_changed' } });
    await expect(h.service.setEndpointOverride({
      action: 'setEndpointOverride', machineId: 'machine-a', connectionId: 'pc_gateway', expectedRevision: 0,
      scope: 'account', endpointTemplateId: 'responses', baseUrl: 'https://stale.example/v1',
    })).resolves.toMatchObject({ status: 'error', error: { code: 'provider_connection_changed' } });
    const duplicate = await h.service.duplicate({
      action: 'duplicate', machineId: 'machine-a', connectionId: 'pc_gateway',
      newConnectionId: 'pc_work', displayName: 'Work', mode: 'sameSource',
    });
    expect(duplicate).toMatchObject({ status: 'success', connectionId: 'pc_work', displayName: 'Work', role: 'named' });
    expect(await h.service.bindSecret({
      action: 'bindSecret', machineId: 'machine-a', connectionId: 'pc_work',
      credentialSlotId: 'apiKey', savedSecretId: 'missing', scope: 'account',
    })).toMatchObject({ status: 'error', error: { code: 'provider_secret_missing' } });
    expect(await h.service.bindSecret({
      action: 'bindSecret', machineId: 'machine-a', connectionId: 'pc_work',
      credentialSlotId: 'apiKey', savedSecretId: 'secret_api', scope: 'account',
    })).toMatchObject({ status: 'success', connectionId: 'pc_work' });
    expect(await h.service.bindSecret({
      action: 'bindSecret', machineId: 'machine-a', connectionId: 'pc_work',
      credentialSlotId: 'otherKey', savedSecretId: 'secret_api', scope: 'account',
    })).toMatchObject({ status: 'error', error: { code: 'provider_credential_transport_unavailable' } });
  });

  it('atomically persists a prepared replacement secret with its binding', async () => {
    const h = harness();
    await h.service.create({
      action: 'createContribution', machineId: 'machine-a', connectionId: 'pc_gateway',
      contributionKey, displayName: null, savedSecretId: 'secret_api', enable: false,
    });
    const replacement = SavedSecretSchema.parse({
      id: 'secret_replacement', name: 'Replacement', kind: 'apiKey',
      encryptedValue: { _isSecretValue: true, value: 'sealed replacement' }, createdAt: 100, updatedAt: 100,
    });
    await expect(h.service.bindSecret({
      action: 'bindSecret', machineId: 'machine-a', connectionId: 'pc_gateway', credentialSlotId: 'apiKey',
      savedSecretId: replacement.id, scope: 'account',
      preparedSavedSecret: { id: replacement.id, record: replacement },
    })).resolves.toMatchObject({ status: 'success' });
    const raw = h.getRaw();
    expect((raw.secrets as readonly { id: string }[]).map((secret) => secret.id)).toContain(replacement.id);
    expect(readOwnRecordValue(
      readProviderSettingsFromAccountSettingsV1(raw).settings.secretBindingsByConnectionId,
      'pc_gateway',
    )?.account)
      .toEqual({ apiKey: replacement.id });
    expect(h.updateAccountSettings).toHaveBeenCalledTimes(2);
  });

  it('permits disable and delete when the contribution source is unavailable', async () => {
    const h = harness();
    await h.service.create({
      action: 'createContribution', machineId: 'machine-a', connectionId: 'pc_gateway',
      contributionKey, displayName: null, savedSecretId: 'secret_api', enable: true,
    });
    const snapshot = await h.service.describe({ machineId: 'machine-a' });
    expect(snapshot.status).toBe('success');
    h.providersByContributionKey.delete(contributionKey);
    await expect(h.service.describe({
      machineId: 'machine-a',
      connectionId: ProviderConnectionIdSchema.parse('pc_gateway'),
    }))
      .resolves.toMatchObject({
        status: 'success',
        connections: [{
          sourceStatus: 'unavailable',
          grants: {
            accountEnabled: false,
            enabledMachineIds: [],
            accountState: 'stale',
            machineState: 'absent',
            effectiveState: 'absent',
          },
        }],
      });
    expect(await h.service.setEnabled({
      action: 'setEnabled', machineId: 'machine-a', connectionId: 'pc_gateway', enabled: false, scope: 'account',
    })).toMatchObject({ status: 'success', authorized: false, sourceStatus: 'unavailable' });
    expect(await h.service.delete({
      action: 'delete', machineId: 'machine-a', connectionId: 'pc_gateway',
    })).toEqual({ status: 'success', connectionId: 'pc_gateway' });
  });

  it('revalidates the manual-model connection revision against the CAS winner', async () => {
    const h = harness();
    const connectionId = ProviderConnectionIdSchema.parse('pc_gateway');
    await h.service.create({
      action: 'createContribution',
      machineId: 'machine-a',
      connectionId: 'pc_gateway',
      contributionKey,
      displayName: null,
      savedSecretId: 'secret_api',
      enable: false,
    });
    h.beforeNextUpdate((raw) => {
      const settings = readProviderSettingsFromAccountSettingsV1(raw).settings;
      return {
        ...raw,
        providerSettingsV1: ProviderSettingsV1Schema.parse({
          ...settings,
          connections: settings.connections.map((connection) =>
            connection.id === 'pc_gateway'
              ? ProviderConnectionV1Schema.parse({
                  ...connection,
                  revision: connection.revision + 1,
                  updatedAt: 101,
                })
              : connection),
        }),
      };
    });

    await expect(h.service.mutateModelSettings({
      action: 'manualAdd',
      machineId: 'machine-a',
      connectionId,
      expectedConnectionRevision: 0,
      expectedManualSource: { kind: 'contribution', contributionKey },
      models: [{ id: 'vendor/model' }],
    })).resolves.toMatchObject({
      status: 'error',
      error: { code: 'provider_connection_changed' },
    });
    expect(
      readProviderSettingsFromAccountSettingsV1(h.getRaw())
        .settings.manualModelsByConnectionId[connectionId],
    ).toBeUndefined();
  });

  it('revalidates the manual-model source against the CAS winner', async () => {
    const h = harness();
    const connectionId = ProviderConnectionIdSchema.parse('pc_gateway');
    await h.service.create({
      action: 'createContribution',
      machineId: 'machine-a',
      connectionId: 'pc_gateway',
      contributionKey,
      displayName: null,
      savedSecretId: 'secret_api',
      enable: false,
    });
    h.beforeNextUpdate((raw) => {
      const settings = readProviderSettingsFromAccountSettingsV1(raw).settings;
      return {
        ...raw,
        providerSettingsV1: ProviderSettingsV1Schema.parse({
          ...settings,
          connections: settings.connections.map((connection) =>
            connection.id === 'pc_gateway'
              ? ProviderConnectionV1Schema.parse({
                  ...connection,
                  source: { kind: 'contribution', contributionKey: 'other.gateway/main' },
                })
              : connection),
        }),
      };
    });

    await expect(h.service.mutateModelSettings({
      action: 'manualAdd',
      machineId: 'machine-a',
      connectionId,
      expectedConnectionRevision: 0,
      expectedManualSource: { kind: 'contribution', contributionKey },
      models: [{ id: 'vendor/model' }],
    })).resolves.toMatchObject({
      status: 'error',
      error: { code: 'provider_authorization_changed' },
    });
    expect(
      readProviderSettingsFromAccountSettingsV1(h.getRaw())
        .settings.manualModelsByConnectionId[connectionId],
    ).toBeUndefined();
  });
});
