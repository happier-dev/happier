import { describe, expect, it } from 'vitest';
import {
  createProviderEndpointSetFingerprintV1,
  DEFAULT_PROVIDER_SETTINGS_V1,
  ProviderContributionV1Schema,
  type ProviderSettingsV1,
} from '@happier-dev/protocol';

import type { ResolvedProviderContribution } from '@/plugins/projection/registry/types';
import {
  resolveProviderConnectionForMachine,
} from './index';
import type { ProviderContributionRegistryView } from './types';

const contributionKey = 'acme.gateway/gateway';
const canonicalContributionKey = 'acme.gateway/gateway';

function providerDefinition(baseUrl = 'https://gateway.example/v1') {
  return ProviderContributionV1Schema.parse({
    v: 1,
    id: 'gateway',
    name: 'Gateway',
    kind: 'cloud',
    endpointTemplates: [{
      id: 'responses',
      protocol: 'openai-responses',
      baseUrl,
      publicHeaders: { 'X-Provider-Client': 'happier' },
      capabilities: {
        streaming: 'supported',
        toolRoundTrips: 'unknown',
        statefulResponses: 'unknown',
        reasoningControls: 'unknown',
      },
    }],
    credential: {
      kind: 'apiKey',
      required: true,
      transports: [{
        id: 'runtime-bearer',
        protocols: ['openai-responses'],
        uses: ['runtime'],
        destination: { kind: 'httpHeader', name: 'Authorization', format: 'bearer' },
      }],
    },
    catalog: {
      source: 'probe',
      manualModelPolicy: 'allowed',
      probes: [{ endpointTemplateId: 'responses', path: '/models', parser: 'openai-models' }],
    },
  });
}

function contribution(baseUrl?: string): ResolvedProviderContribution {
  return {
    provenance: 'external',
    source: { kind: 'path' },
    pluginId: 'acme.gateway',
    identity: { pluginId: 'acme.gateway', localId: 'gateway' },
    definition: providerDefinition(baseUrl),
  };
}

function managedContribution(
  dependency = 'gateway-managed',
): ResolvedProviderContribution {
  const definition = ProviderContributionV1Schema.parse({
    ...providerDefinition(),
    managedRuntime: {
      kind: 'managed',
      dependencies: [dependency],
      endpointTemplateIds: ['responses'],
      connectedAccounts: [{
        purpose: 'upstream',
        service: {
          pluginId: 'happier.connected-account.example',
          localId: 'example',
        },
        required: true,
        materializationKinds: ['httpHeaders'],
      }],
      requestAuthUses: [{
        purpose: 'upstream',
        materialization: {
          kind: 'httpHeaders',
          origin: 'https://api.example.test',
          headerNames: ['authorization'],
        },
      }],
    },
  });
  return {
    ...contribution(),
    provenance: 'first_party',
    source: { kind: 'bundled' },
    definition,
  };
}

function externalManagedContribution(
  source: 'path' | 'package',
): ResolvedProviderContribution {
  const bundled = managedContribution();
  return {
    ...bundled,
    provenance: 'external',
    source: source === 'path'
      ? { kind: 'path' }
      : { kind: 'package' },
  };
}

function localContribution(): ResolvedProviderContribution {
  return {
    ...contribution(),
    definition: ProviderContributionV1Schema.parse({
      v: 1,
      id: 'gateway',
      name: 'Local Gateway',
      kind: 'local',
      endpointTemplates: [{
        id: 'responses',
        protocol: 'openai-responses',
        localUrlCandidates: ['http://localhost:4545/v1', 'http://127.0.0.1:4545/v1'],
        capabilities: {
          streaming: 'unknown', toolRoundTrips: 'unknown',
          statefulResponses: 'unknown', reasoningControls: 'unknown',
        },
      }],
      catalog: { source: 'manual', manualModelPolicy: 'allowed' },
    }),
  };
}

function registry(value: ResolvedProviderContribution = contribution()): ProviderContributionRegistryView {
  return { providersByContributionKey: new Map([[canonicalContributionKey, value]]) };
}

function connection(
  id: string,
  overrides: Partial<ProviderSettingsV1['connections'][number]> = {},
): ProviderSettingsV1['connections'][number] {
  return {
    v: 1,
    id: id as ProviderSettingsV1['connections'][number]['id'],
    source: { kind: 'contribution', contributionKey },
    role: 'default',
    displayName: 'Gateway',
    displayNameMode: 'automatic',
    deployment: { kind: 'external' },
    revision: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function settingsWith(
  connections: ProviderSettingsV1['connections'],
  overrides: Partial<ProviderSettingsV1> = {},
): ProviderSettingsV1 {
  return {
    ...DEFAULT_PROVIDER_SETTINGS_V1,
    connections,
    ...overrides,
  };
}

const publicDns = new Map([
  ['https://gateway.example/v1', ['1.1.1.1']],
  ['https://gateway-v2.example/v1', ['8.8.8.8']],
]);

describe('machine-aware provider connection resolver', () => {
  it('resolves managed deployment as machine-scoped logical authority with an empty endpoint set', () => {
    const configured = connection('pc_managed', {
      deployment: { kind: 'managedLocal' },
      purposeBindingDefaults: {
        upstream: {
          kind: 'account',
          account: {
            service: {
              pluginId: 'happier.connected-account.example',
              localId: 'example',
            },
            accountId: 'account-a',
          },
        },
      },
    });
    const baseSettings = settingsWith([configured]);
    const first = resolveProviderConnectionForMachine({
      connectionId: configured.id,
      machineId: 'machine-a',
      accountSettings: { providerSettingsV1: baseSettings },
      registry: registry(managedContribution()),
      dnsEvidenceByEndpointUrl: new Map(),
    });
    if (first.status !== 'resolved') throw new Error('Expected managed connection to resolve');

    expect(first.record).toMatchObject({
      deployment: {
        kind: 'managedLocal',
        implementationIdentity: {
          pluginId: 'acme.gateway',
          localId: 'gateway',
        },
        purposeBindingIntents: {
          v: 1,
          bindings: [{
            purpose: {
              consumer: {
                pluginId: 'acme.gateway',
                localId: 'gateway',
              },
              purpose: 'upstream',
            },
            target: {
              kind: 'account',
              account: {
                service: {
                  pluginId: 'happier.connected-account.example',
                  localId: 'example',
                },
                accountId: 'account-a',
              },
            },
          }],
        },
      },
      endpoints: [],
      scope: 'machine',
      authorization: {
        authorized: false,
        errorCode: 'provider_not_enabled_on_machine',
      },
    });
    expect(first.record.endpointSetFingerprint).toBe(
      createProviderEndpointSetFingerprintV1({ endpoints: [] }),
    );

    const grantedSettings = settingsWith([configured], {
      machineGrants: [{
        v: 1,
        machineId: 'machine-a',
        connectionId: configured.id,
        connectionSecurityFingerprint: first.record.connectionSecurityFingerprint,
        endpointSetFingerprint: first.record.endpointSetFingerprint,
        confirmedAt: 2,
      }],
    });
    expect(resolveProviderConnectionForMachine({
      connectionId: configured.id,
      machineId: 'machine-a',
      accountSettings: { providerSettingsV1: grantedSettings },
      registry: registry(managedContribution()),
      dnsEvidenceByEndpointUrl: new Map(),
    })).toMatchObject({
      status: 'resolved',
      record: {
        endpoints: [],
        authorization: { authorized: true, grantKind: 'machine' },
      },
    });

    const changedContribution = managedContribution('gateway-managed-v2');
    const changed = resolveProviderConnectionForMachine({
      connectionId: configured.id,
      machineId: 'machine-a',
      accountSettings: { providerSettingsV1: grantedSettings },
      registry: registry({
        ...changedContribution,
        definition: ProviderContributionV1Schema.parse({
          ...changedContribution.definition,
          managedRuntime: {
            ...changedContribution.definition.managedRuntime,
            dependencies: ['gateway-managed-v2'],
          },
        }),
      }),
      dnsEvidenceByEndpointUrl: new Map(),
    });
    expect(changed).toMatchObject({
      status: 'resolved',
      record: {
        authorization: {
          authorized: false,
          errorCode: 'provider_machine_grant_stale',
        },
      },
    });
    if (changed.status !== 'resolved') throw new Error('Expected changed managed connection to resolve');
    expect(changed.record.connectionSecurityFingerprint).not.toBe(
      first.record.connectionSecurityFingerprint,
    );

    const defaultsEdited = {
      ...configured,
      revision: configured.revision + 1,
      updatedAt: configured.updatedAt + 1,
      purposeBindingDefaults: {
        upstream: {
          kind: 'account' as const,
          account: {
            service: {
              pluginId: 'happier.connected-account.example',
              localId: 'example',
            },
            accountId: 'account-b',
          },
        },
      },
    };
    const futureDefaultEdit = resolveProviderConnectionForMachine({
      connectionId: configured.id,
      machineId: 'machine-a',
      accountSettings: {
        providerSettingsV1: settingsWith([defaultsEdited], {
          machineGrants: grantedSettings.machineGrants,
        }),
      },
      registry: registry(managedContribution()),
      dnsEvidenceByEndpointUrl: new Map(),
    });
    expect(futureDefaultEdit).toMatchObject({
      status: 'resolved',
      record: {
        authorization: { authorized: true },
        deployment: {
          kind: 'managedLocal',
          purposeBindingIntents: {
            bindings: [{
              target: {
                kind: 'account',
                account: { accountId: 'account-b' },
              },
            }],
          },
        },
      },
    });
    if (futureDefaultEdit.status !== 'resolved') throw new Error('Expected edited defaults to resolve');
    expect(futureDefaultEdit.record.connectionSecurityFingerprint).toBe(
      first.record.connectionSecurityFingerprint,
    );
  });

  it('stales a managed machine grant when the declared endpoint public headers change', () => {
    const configured = connection('pc_managed_headers', {
      deployment: { kind: 'managedLocal' },
      purposeBindingDefaults: {
        upstream: {
          kind: 'account',
          account: {
            service: {
              pluginId: 'happier.connected-account.example',
              localId: 'example',
            },
            accountId: 'account-a',
          },
        },
      },
    });
    const withHeaders = (headers: Readonly<Record<string, string>>): ResolvedProviderContribution => {
      const base = managedContribution();
      return {
        ...base,
        definition: ProviderContributionV1Schema.parse({
          ...base.definition,
          endpointTemplates: base.definition.endpointTemplates.map((template) => ({
            ...template,
            publicHeaders: headers,
          })),
        }),
      };
    };
    const first = resolveProviderConnectionForMachine({
      connectionId: configured.id,
      machineId: 'machine-a',
      accountSettings: { providerSettingsV1: settingsWith([configured]) },
      registry: registry(withHeaders({ 'X-Route': 'one' })),
      dnsEvidenceByEndpointUrl: new Map(),
    });
    if (first.status !== 'resolved') throw new Error('Expected managed connection to resolve');
    const grantedSettings = settingsWith([configured], {
      machineGrants: [{
        v: 1,
        machineId: 'machine-a',
        connectionId: configured.id,
        connectionSecurityFingerprint: first.record.connectionSecurityFingerprint,
        endpointSetFingerprint: first.record.endpointSetFingerprint,
        confirmedAt: 2,
      }],
    });
    expect(resolveProviderConnectionForMachine({
      connectionId: configured.id,
      machineId: 'machine-a',
      accountSettings: { providerSettingsV1: grantedSettings },
      registry: registry(withHeaders({ 'X-Route': 'one' })),
      dnsEvidenceByEndpointUrl: new Map(),
    })).toMatchObject({
      status: 'resolved',
      record: { authorization: { authorized: true, grantKind: 'machine' } },
    });

    const changed = resolveProviderConnectionForMachine({
      connectionId: configured.id,
      machineId: 'machine-a',
      accountSettings: { providerSettingsV1: grantedSettings },
      registry: registry(withHeaders({ 'X-Route': 'two' })),
      dnsEvidenceByEndpointUrl: new Map(),
    });
    if (changed.status !== 'resolved') throw new Error('Expected changed managed connection to resolve');
    expect(changed.record.connectionSecurityFingerprint).not.toBe(
      first.record.connectionSecurityFingerprint,
    );
    expect(changed.record.authorization).toMatchObject({
      authorized: false,
      errorCode: 'provider_machine_grant_stale',
    });
  });

  it('resolves one public managed declaration across bundled, development, and installed provenance', () => {
    const configured = connection('pc_managed_invalid', {
      deployment: { kind: 'managedLocal' },
      purposeBindingDefaults: {
        upstream: {
          kind: 'account',
          account: {
            service: {
              pluginId: 'happier.connected-account.example',
              localId: 'example',
            },
            accountId: 'account-a',
          },
        },
      },
    });
    const input = {
      connectionId: configured.id,
      machineId: 'machine-a',
      accountSettings: { providerSettingsV1: settingsWith([configured]) },
      dnsEvidenceByEndpointUrl: new Map(),
    } as const;

    expect(resolveProviderConnectionForMachine({
      ...input,
      registry: registry(contribution()),
    })).toMatchObject({
      status: 'invalid',
      reason: 'managed_deployment_unavailable',
    });
    for (const candidate of [
      managedContribution(),
      externalManagedContribution('path'),
      externalManagedContribution('package'),
    ]) {
      const resolution = resolveProviderConnectionForMachine({
        ...input,
        registry: registry(candidate),
      });
      expect(resolution).toMatchObject({
        status: 'resolved',
        record: {
          source: { provenance: candidate.provenance },
          deployment: {
            kind: 'managedLocal',
            managedRuntime: {
              kind: 'managed',
              endpointTemplateIds: ['responses'],
            },
          },
        },
      });
      if (resolution.status !== 'resolved') {
        throw new Error('Expected public managed declaration to resolve');
      }
      expect(resolution.record.deployment).not.toHaveProperty('facet');
    }
  });

  it('rejects managed purpose defaults outside the declared facet purpose and service', () => {
    const defaults = {
      upstream: {
        kind: 'account' as const,
        account: {
          service: {
            pluginId: 'happier.connected-account.other',
            localId: 'other',
          },
          accountId: 'account-a',
        },
      },
    };
    const configured = connection('pc_managed_purpose_invalid', {
      deployment: { kind: 'managedLocal' },
      purposeBindingDefaults: defaults,
    });

    expect(resolveProviderConnectionForMachine({
      connectionId: configured.id,
      machineId: 'machine-a',
      accountSettings: { providerSettingsV1: settingsWith([configured]) },
      registry: registry(managedContribution()),
      dnsEvidenceByEndpointUrl: new Map(),
    })).toMatchObject({
      status: 'invalid',
      reason: 'managed_purpose_bindings_invalid',
    });
  });

  it('resolves the exact canonical contribution identity through the registry', () => {
    const configured = connection('pc_gateway');

    expect(resolveProviderConnectionForMachine({
      connectionId: configured.id,
      machineId: 'machine-a',
      accountSettings: { providerSettingsV1: settingsWith([configured]) },
      registry: {
        providersByContributionKey: new Map([[canonicalContributionKey, contribution()]]),
      },
      dnsEvidenceByEndpointUrl: publicDns,
    })).toMatchObject({
      status: 'resolved',
      record: {
        source: {
          kind: 'contribution',
          contributionKey: canonicalContributionKey,
          pluginId: 'acme.gateway',
        },
      },
    });
  });

  it('authorizes a public connection only while its account grant matches current contribution security facts', () => {
    const configured = connection('pc_gateway');
    const providerEntries = new Map([[canonicalContributionKey, contribution()]]);
    const mutableRegistry: ProviderContributionRegistryView = {
      providersByContributionKey: providerEntries,
    };
    const first = resolveProviderConnectionForMachine({
      connectionId: configured.id,
      machineId: 'machine-a',
      accountSettings: { providerSettingsV1: settingsWith([configured]) },
      registry: mutableRegistry,
      dnsEvidenceByEndpointUrl: publicDns,
    });
    expect(first).toMatchObject({
      status: 'resolved',
      record: {
        scope: 'account',
        authorization: { authorized: false, errorCode: 'provider_connection_disabled' },
      },
    });
    if (first.status !== 'resolved') throw new Error('Expected resolved connection');

    const grantedSettings = settingsWith([configured], {
      accountGrants: [{
        v: 1,
        connectionId: configured.id,
        connectionSecurityFingerprint: first.record.connectionSecurityFingerprint,
        confirmedAt: 2,
      }],
    });
    expect(resolveProviderConnectionForMachine({
      connectionId: configured.id,
      machineId: 'machine-a',
      accountSettings: { providerSettingsV1: grantedSettings },
      registry: mutableRegistry,
      dnsEvidenceByEndpointUrl: publicDns,
    })).toMatchObject({
      status: 'resolved',
      record: { authorization: { authorized: true, grantKind: 'account' } },
    });

    providerEntries.set(canonicalContributionKey, contribution('https://gateway-v2.example/v1'));
    expect(resolveProviderConnectionForMachine({
      connectionId: configured.id,
      machineId: 'machine-a',
      accountSettings: { providerSettingsV1: grantedSettings },
      registry: mutableRegistry,
      dnsEvidenceByEndpointUrl: publicDns,
    })).toMatchObject({
      status: 'resolved',
      record: { authorization: { authorized: false, errorCode: 'provider_account_grant_stale' } },
    });
  });

  it('uses account authorization on the public machine view and an exact machine grant for an override', () => {
    const configured = connection('pc_mixed', {
      endpointOverridesByMachineId: {
        'machine-b': [{ endpointTemplateId: 'responses', baseUrl: 'http://localhost:4242/v1' }],
      },
    });
    const baseSettings = settingsWith([configured]);
    const machineA = resolveProviderConnectionForMachine({
      connectionId: configured.id,
      machineId: 'machine-a',
      accountSettings: { providerSettingsV1: baseSettings },
      registry: registry(),
      dnsEvidenceByEndpointUrl: publicDns,
    });
    const machineB = resolveProviderConnectionForMachine({
      connectionId: configured.id,
      machineId: 'machine-b',
      accountSettings: { providerSettingsV1: baseSettings },
      registry: registry(),
      dnsEvidenceByEndpointUrl: new Map([['http://localhost:4242/v1', ['127.0.0.1', '::1']]]),
    });
    if (machineA.status !== 'resolved' || machineB.status !== 'resolved') throw new Error('Expected both machine views');
    expect(machineA.record).toMatchObject({ scope: 'account', endpoints: [{ source: 'contribution' }] });
    expect(machineB.record).toMatchObject({
      scope: 'machine',
      endpoints: [{ source: 'machine_override', locality: 'loopback' }],
      authorization: { authorized: false, errorCode: 'provider_not_enabled_on_machine' },
    });

    const grants = settingsWith([configured], {
      accountGrants: [{
        v: 1,
        connectionId: configured.id,
        connectionSecurityFingerprint: machineA.record.connectionSecurityFingerprint,
        confirmedAt: 2,
      }],
      machineGrants: [{
        v: 1,
        machineId: 'machine-b',
        connectionId: configured.id,
        endpointSetFingerprint: machineB.record.endpointSetFingerprint,
        connectionSecurityFingerprint: machineB.record.connectionSecurityFingerprint,
        confirmedAt: 2,
      }],
    });
    expect(resolveProviderConnectionForMachine({
      connectionId: configured.id,
      machineId: 'machine-a',
      accountSettings: { providerSettingsV1: grants },
      registry: registry(),
      dnsEvidenceByEndpointUrl: publicDns,
    })).toMatchObject({ status: 'resolved', record: { authorization: { authorized: true, grantKind: 'account' } } });
    expect(resolveProviderConnectionForMachine({
      connectionId: configured.id,
      machineId: 'machine-b',
      accountSettings: { providerSettingsV1: grants },
      registry: registry(),
      dnsEvidenceByEndpointUrl: new Map([['http://localhost:4242/v1', ['127.0.0.1', '::1']]]),
    })).toMatchObject({ status: 'resolved', record: { authorization: { authorized: true, grantKind: 'machine' } } });
    expect(resolveProviderConnectionForMachine({
      connectionId: configured.id,
      machineId: 'machine-b',
      accountSettings: { providerSettingsV1: grants },
      registry: registry(),
      dnsEvidenceByEndpointUrl: new Map([['http://localhost:4242/v1', ['127.0.0.1']]]),
    })).toMatchObject({
      status: 'resolved',
      record: { authorization: { authorized: false, errorCode: 'provider_machine_grant_stale' } },
    });
  });

  it('uses account overrides before contribution defaults without turning a public account view into machine scope', () => {
    const configured = connection('pc_account_override', {
      endpointOverrides: [{ endpointTemplateId: 'responses', baseUrl: 'https://override.example/v1' }],
    });
    expect(resolveProviderConnectionForMachine({
      connectionId: configured.id,
      machineId: 'machine-a',
      accountSettings: { providerSettingsV1: settingsWith([configured]) },
      registry: registry(),
      dnsEvidenceByEndpointUrl: new Map([
        ['https://gateway.example/v1', ['1.1.1.1']],
        ['https://override.example/v1', ['8.8.4.4']],
      ]),
    })).toMatchObject({
      status: 'resolved',
      record: {
        scope: 'account',
        endpoints: [{ source: 'account_override', normalizedUrl: 'https://override.example/v1' }],
      },
    });
  });

  it('does not reuse an account grant after an override edit or public-to-private DNS change', () => {
    const configured = connection('pc_account_reauthorization', {
      endpointOverrides: [{ endpointTemplateId: 'responses', baseUrl: 'https://override.example/v1' }],
    });
    const initial = resolveProviderConnectionForMachine({
      connectionId: configured.id,
      machineId: 'machine-a',
      accountSettings: { providerSettingsV1: settingsWith([configured]) },
      registry: registry(),
      dnsEvidenceByEndpointUrl: new Map([['https://override.example/v1', ['8.8.4.4']]]),
    });
    if (initial.status !== 'resolved') throw new Error('Expected initial public resolution');
    const accountGrant = {
      v: 1 as const,
      connectionId: configured.id,
      connectionSecurityFingerprint: initial.record.connectionSecurityFingerprint,
      confirmedAt: 2,
    };

    const edited = connection(configured.id, {
      endpointOverrides: [{ endpointTemplateId: 'responses', baseUrl: 'https://override-v2.example/v1' }],
      revision: 1,
      updatedAt: 2,
    });
    expect(resolveProviderConnectionForMachine({
      connectionId: edited.id,
      machineId: 'machine-a',
      accountSettings: { providerSettingsV1: settingsWith([edited], { accountGrants: [accountGrant] }) },
      registry: registry(),
      dnsEvidenceByEndpointUrl: new Map([['https://override-v2.example/v1', ['8.8.8.8']]]),
    })).toMatchObject({
      status: 'resolved',
      record: { authorization: { authorized: false, errorCode: 'provider_account_grant_stale' } },
    });

    expect(resolveProviderConnectionForMachine({
      connectionId: configured.id,
      machineId: 'machine-a',
      accountSettings: { providerSettingsV1: settingsWith([configured], { accountGrants: [accountGrant] }) },
      registry: registry(),
      dnsEvidenceByEndpointUrl: new Map([['https://override.example/v1', ['192.168.1.50']]]),
    })).toMatchObject({
      status: 'resolved',
      record: {
        scope: 'machine',
        authorization: { authorized: false, errorCode: 'provider_not_enabled_on_machine' },
      },
    });
  });

  it('uses the explicitly selected declared local URL candidate when no override exists', () => {
    const configured = connection('pc_local');
    expect(resolveProviderConnectionForMachine({
      connectionId: configured.id,
      machineId: 'machine-a',
      accountSettings: { providerSettingsV1: settingsWith([configured]) },
      registry: registry(localContribution()),
      dnsEvidenceByEndpointUrl: new Map([['http://localhost:4545/v1', ['127.0.0.1']]]),
      localCandidateUrlsByConnectionId: new Map([
        [configured.id, new Map([['responses', 'http://localhost:4545/v1']])],
      ]),
    })).toMatchObject({
      status: 'resolved',
      record: {
        displayName: 'Local Gateway',
        scope: 'machine',
        endpoints: [{
          source: 'contribution_local_candidate',
          normalizedUrl: 'http://localhost:4545/v1',
        }],
      },
    });
  });

  it('scopes same-template local endpoint candidates by exact connection identity', () => {
    const secondContributionKey = 'acme.second-local/gateway';
    const first = connection('pc_local_first');
    const second = connection('pc_local_second', {
      source: { kind: 'contribution', contributionKey: secondContributionKey },
    });
    const secondLocalContribution: ResolvedProviderContribution = {
      ...localContribution(),
      pluginId: 'acme.second-local',
      identity: { pluginId: 'acme.second-local', localId: 'gateway' },
      definition: ProviderContributionV1Schema.parse({
        ...localContribution().definition,
        endpointTemplates: [{
          ...localContribution().definition.endpointTemplates[0],
          localUrlCandidates: ['http://localhost:5656/v1', 'http://127.0.0.1:5656/v1'],
        }],
      }),
    };
    const sharedInput = {
      machineId: 'machine-a',
      accountSettings: { providerSettingsV1: settingsWith([second, first]) },
      registry: {
        providersByContributionKey: new Map([
          [canonicalContributionKey, localContribution()],
          ['acme.second-local/gateway', secondLocalContribution],
        ]),
      },
      dnsEvidenceByEndpointUrl: new Map([
        ['http://localhost:4545/v1', ['127.0.0.1']],
        ['http://localhost:5656/v1', ['127.0.0.1']],
      ]),
      localCandidateUrlsByConnectionId: new Map([
        [first.id, new Map([['responses', 'http://localhost:4545/v1']])],
        [second.id, new Map([['responses', 'http://localhost:5656/v1']])],
      ]),
    };

    expect(resolveProviderConnectionForMachine({
      ...sharedInput,
      connectionId: first.id,
    })).toMatchObject({
      status: 'resolved',
      connectionId: first.id,
      record: { endpoints: [{ normalizedUrl: 'http://localhost:4545/v1' }] },
    });
    expect(resolveProviderConnectionForMachine({
      ...sharedInput,
      connectionId: second.id,
    })).toMatchObject({
      status: 'resolved',
      connectionId: second.id,
      record: { endpoints: [{ normalizedUrl: 'http://localhost:5656/v1' }] },
    });
  });

  it('does not hide a multi-candidate local endpoint choice behind contribution array order', () => {
    const configured = connection('pc_local_choice');
    expect(resolveProviderConnectionForMachine({
      connectionId: configured.id,
      machineId: 'machine-a',
      accountSettings: { providerSettingsV1: settingsWith([configured]) },
      registry: registry(localContribution()),
      dnsEvidenceByEndpointUrl: new Map([['http://localhost:4545/v1', ['127.0.0.1']]]),
    })).toMatchObject({ status: 'endpoint_unresolved', reason: 'local_candidate_required' });
  });

  it('requires a machine grant for a machine override even when that override resolves publicly', () => {
    const configured = connection('pc_public_machine_override', {
      endpointOverridesByMachineId: {
        'machine-a': [{ endpointTemplateId: 'responses', baseUrl: 'https://machine.example/v1' }],
      },
    });
    expect(resolveProviderConnectionForMachine({
      connectionId: configured.id,
      machineId: 'machine-a',
      accountSettings: { providerSettingsV1: settingsWith([configured]) },
      registry: registry(),
      dnsEvidenceByEndpointUrl: new Map([['https://machine.example/v1', ['1.1.1.1']]]),
    })).toMatchObject({
      status: 'resolved',
      record: {
        scope: 'machine',
        endpoints: [{ source: 'machine_override', endpointScope: 'account' }],
        authorization: { authorized: false, errorCode: 'provider_not_enabled_on_machine' },
      },
    });
  });

  it('distinguishes missing, deleted, and contribution-unavailable connections without reinterpretation', () => {
    const configured = connection('pc_missing_plugin');
    const accountSettings = {
      providerSettingsV1: settingsWith([configured], {
        connectionTombstones: [{
          v: 1,
          id: 'pc_deleted' as ProviderSettingsV1['connectionTombstones'][number]['id'],
          contributionKey,
          lastDisplayName: 'Old Gateway',
          deletedAt: 9,
        }],
      }),
    };
    const emptyRegistry: ProviderContributionRegistryView = { providersByContributionKey: new Map() };
    expect(resolveProviderConnectionForMachine({
      connectionId: 'pc_unknown', machineId: 'machine-a', accountSettings, registry: emptyRegistry,
      dnsEvidenceByEndpointUrl: new Map(),
    })).toEqual({ status: 'missing', connectionId: 'pc_unknown', diagnostics: [] });
    expect(resolveProviderConnectionForMachine({
      connectionId: 'pc_deleted', machineId: 'machine-a', accountSettings, registry: emptyRegistry,
      dnsEvidenceByEndpointUrl: new Map(),
    })).toMatchObject({ status: 'deleted', connectionId: 'pc_deleted', tombstone: { lastDisplayName: 'Old Gateway' } });
    expect(resolveProviderConnectionForMachine({
      connectionId: configured.id, machineId: 'machine-a', accountSettings, registry: emptyRegistry,
      dnsEvidenceByEndpointUrl: new Map(),
    })).toMatchObject({
      status: 'source_unavailable',
      connectionId: configured.id,
      contributionKey: canonicalContributionKey,
      connection: { source: { kind: 'contribution' } },
    });
  });

  it('normalizes a custom connection into the same non-secret resolved record', () => {
    const custom = connection('pc_custom', {
      role: 'named',
      displayName: 'Company Gateway',
      displayNameMode: 'custom',
      source: {
        kind: 'custom',
        template: {
          v: 1,
          name: 'Company Gateway',
          endpointTemplates: [{
            id: 'chat',
            protocol: 'openai-chat',
            baseUrl: 'https://company.example/v1',
            capabilities: {
              streaming: 'unknown', toolRoundTrips: 'unknown',
              statefulResponses: 'unknown', reasoningControls: 'unknown',
            },
          }],
          catalog: { source: 'manual', manualModelPolicy: 'allowed' },
        },
      },
    });
    const result = resolveProviderConnectionForMachine({
      connectionId: custom.id,
      machineId: 'machine-a',
      accountSettings: {
        providerSettingsV1: settingsWith([custom], {
          secretBindingsByConnectionId: {
            [custom.id]: { account: { apiKey: 'secret-binding-canary' } },
          },
        }),
      },
      registry: registry(),
      dnsEvidenceByEndpointUrl: new Map([['https://company.example/v1', ['9.9.9.9']]]),
    });
    expect(result).toMatchObject({
      status: 'resolved',
      record: {
        source: { kind: 'custom' },
        displayName: 'Company Gateway',
        endpoints: [{ endpointTemplateId: 'chat', protocol: 'openai-chat' }],
      },
    });
    expect(JSON.stringify(result)).not.toContain('secret-binding-canary');
  });

  it('fails closed on unknown contribution override ids and missing DNS evidence', () => {
    const invalidOverride = connection('pc_invalid_override', {
      endpointOverrides: [{ endpointTemplateId: 'unknown', baseUrl: 'https://other.example/v1' }],
    });
    expect(resolveProviderConnectionForMachine({
      connectionId: invalidOverride.id,
      machineId: 'machine-a',
      accountSettings: { providerSettingsV1: settingsWith([invalidOverride]) },
      registry: registry(),
      dnsEvidenceByEndpointUrl: new Map([['https://other.example/v1', ['1.0.0.1']]]),
    })).toMatchObject({ status: 'invalid', reason: 'unknown_endpoint_override' });

    const configured = connection('pc_dns');
    expect(resolveProviderConnectionForMachine({
      connectionId: configured.id,
      machineId: 'machine-a',
      accountSettings: { providerSettingsV1: settingsWith([configured]) },
      registry: registry(),
      dnsEvidenceByEndpointUrl: new Map(),
    })).toMatchObject({ status: 'endpoint_unresolved', reason: 'endpoint_resolution_required' });
  });

  it('rejects a contribution override for an unknown endpoint even when it belongs to another machine branch', () => {
    const invalidOtherMachine = connection('pc_invalid_other_machine', {
      endpointOverridesByMachineId: {
        'machine-b': [{ endpointTemplateId: 'unknown', baseUrl: 'https://other.example/v1' }],
      },
    });
    expect(resolveProviderConnectionForMachine({
      connectionId: invalidOtherMachine.id,
      machineId: 'machine-a',
      accountSettings: { providerSettingsV1: settingsWith([invalidOtherMachine]) },
      registry: registry(),
      dnsEvidenceByEndpointUrl: publicDns,
    })).toMatchObject({ status: 'invalid', reason: 'unknown_endpoint_override' });
  });

  it('lets the canonical settings reader reject poison identifiers before registry lookup', () => {
    const result = resolveProviderConnectionForMachine({
      connectionId: '__proto__',
      machineId: 'machine-a',
      accountSettings: { providerSettingsV1: settingsWith([]) },
      registry: registry(),
      dnsEvidenceByEndpointUrl: new Map(),
    });
    expect(result).toMatchObject({ status: 'invalid', reason: 'invalid_connection_id' });
  });

  it('uses own-property lookup for legal machine ids that overlap Object.prototype names', () => {
    const configured = connection('pc_own_machine_key', {
      endpointOverridesByMachineId: {
        toString: [{ endpointTemplateId: 'responses', baseUrl: 'http://localhost:4343/v1' }],
      },
    });
    expect(resolveProviderConnectionForMachine({
      connectionId: configured.id,
      machineId: 'toString',
      accountSettings: { providerSettingsV1: settingsWith([configured]) },
      registry: registry(),
      dnsEvidenceByEndpointUrl: new Map([['http://localhost:4343/v1', ['127.0.0.1']]]),
    })).toMatchObject({
      status: 'resolved',
      record: { scope: 'machine', endpoints: [{ source: 'machine_override' }] },
    });
  });
});
