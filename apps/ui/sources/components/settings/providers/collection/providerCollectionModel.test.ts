import { describe, expect, it } from 'vitest';

import {
  createProviderConnectionViewFixture,
  createProviderConnectionsDescribeFixture,
} from '@/dev/testkit/harness/providerSettingsHarness';

import { ProviderConnectionV1Schema } from '@happier-dev/protocol/providers/connections/v1';
import {
  PROVIDER_GATEWAY_ICON,
  buildProviderCollection,
  buildProviderGatewayCollection,
  providerConnectionDetailRoute,
  resolveProviderCollectionLandingId,
  resolveProviderConnectionIcon,
} from './providerCollectionModel';

function candidate(overrides: Record<string, unknown>) {
  return {
    v: 1,
    machineId: 'machine-a',
    contributionKey: 'plugin/ollama',
    providerName: 'Ollama',
    endpointTemplateId: 'native',
    normalizedEndpointUrl: 'http://127.0.0.1:11434',
    candidateId: 'discovery-candidate:v1:a',
    evidence: { kind: 'attributed_listener' },
    ownership: 'adopted',
    connection: { status: 'enable_default' },
    ...overrides,
  } as never;
}

describe('buildProviderCollection', () => {
  it('uses Account catalog shown and total counts independently of machine runtime counts', () => {
    const data = createProviderConnectionsDescribeFixture({
      connections: [
        createProviderConnectionViewFixture({
          connectionId: 'pc_count',
          runtime: {
            health: 'available',
            modelCount: 99,
            checkedAt: 1,
            endpoints: [],
          },
        }),
        createProviderConnectionViewFixture({
          connectionId: 'pc_unknown',
          runtime: {
            health: 'available',
            modelCount: 42,
            checkedAt: 1,
            endpoints: [],
          },
        }),
      ],
    });
    const rows = buildProviderCollection({ declarationContext: { kind: 'account' },
      data,
      query: '',
      localDiscoveryEnabled: false,
      catalogCounts: { pc_count: { shown: 1, total: 2 } },
    }).connections;
    expect(rows.map((row) => row.catalogCount)).toEqual([
      { shown: 1, total: 2 },
      null,
    ]);
  });
  it('marks a gateway from its admitted source even without runtime declarations, excluding other managed and external sources', () => {
    const purposes = [
      {
        purpose: 'openai-upstream',
        service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
        required: false,
      },
    ];
    const data = createProviderConnectionsDescribeFixture({
      connections: [
        createProviderConnectionViewFixture({
          connectionId: 'pc_gateway',
          contributionKey: 'happier.provider.cliproxyapi/cliproxyapi',
          deployment: {
            kind: 'managedLocal',
            targetMachineId: 'machine-a',
            effects: null,
          },
          sourceStatus: 'unavailable',
          managedLocalOption: null,
        }),
        createProviderConnectionViewFixture({
          connectionId: 'pc_ollama',
          contributionKey: 'happier.provider.ollama/ollama',
          deployment: {
            kind: 'managedLocal',
            targetMachineId: 'machine-a',
            effects: null,
          },
          managedLocalOption: {
            targetMachineId: 'machine-a',
            connectedAccountPurposes: [],
          },
        }),
        // An external endpoint that could become managed is not a gateway yet.
        createProviderConnectionViewFixture({
          connectionId: 'pc_external',
          contributionKey: 'happier.provider.cliproxyapi/cliproxyapi',
          managedLocalOption: {
            targetMachineId: 'machine-a',
            connectedAccountPurposes: purposes,
          },
        }),
      ],
    });
    const rows = buildProviderCollection({ declarationContext: { kind: 'account' },
      data: data as never,
      query: '',
      localDiscoveryEnabled: false,
    }).connections;
    expect(rows.map((row) => [row.connectionId, row.gateway])).toEqual([
      ['pc_gateway', true],
      ['pc_ollama', false],
      ['pc_external', false],
    ]);
    // A gateway row carries the shared gateway glyph; a bundled provider the machine described
    // without an icon keeps its own mark; a source with neither stays unmarked.
    expect(rows.map((row) => row.icon)).toEqual([
      PROVIDER_GATEWAY_ICON,
      null,
      null,
    ]);
  });
  it('gives a gateway no saved-model count: it serves its Connected accounts, not models saved to the Account', () => {
    const data = createProviderConnectionsDescribeFixture({
      connections: [
        createProviderConnectionViewFixture({
          connectionId: 'pc_gateway',
          contributionKey: 'happier.provider.cliproxyapi/cliproxyapi',
          deployment: { kind: 'managedLocal', targetMachineId: 'machine-a', effects: null },
          managedLocalOption: null,
        }),
        createProviderConnectionViewFixture({ connectionId: 'pc_direct' }),
      ],
    });
    const rows = buildProviderCollection({ declarationContext: { kind: 'account' },
      data: data as never,
      query: '',
      localDiscoveryEnabled: false,
      catalogCounts: { pc_gateway: { shown: 0, total: 0 }, pc_direct: { shown: 2, total: 2 } },
    }).connections;
    expect(rows.map((row) => [row.connectionId, row.gateway, row.catalogCount])).toEqual([
      ['pc_gateway', true, null],
      ['pc_direct', false, { shown: 2, total: 2 }],
    ]);
  });
  it('draws a found local server with its bundled source mark', () => {
    const data = createProviderConnectionsDescribeFixture({
      discoveryCandidates: [
        candidate({ contributionKey: 'happier.provider.ollama/ollama' }),
      ],
      localInstallations: [
        {
          v: 1,
          machineId: 'machine-a',
          contributionKey: 'plugin/lmstudio',
          providerName: 'LM Studio',
          status: 'installed_not_running',
          managedStartAvailable: true,
        },
      ],
    } as never);
    const found = buildProviderCollection({ declarationContext: { kind: 'account' },
      data: data as never,
      query: '',
      localDiscoveryEnabled: true,
    }).found;
    expect(found.map((row) => [row.title, row.icon])).toEqual([
      ['Ollama', null],
      ['LM Studio', null],
    ]);
  });
  it('projects admitted vendor gateways to the same connection detail and excludes other managed Providers', () => {
    const managed = ProviderConnectionV1Schema.parse({
      v: 1,
      id: 'pc_gateway',
      source: {
        kind: 'contribution',
        contributionKey: 'happier.provider.cliproxyapi/cliproxyapi',
      },
      role: 'named',
      displayName: 'Subscriptions',
      displayNameMode: 'custom',
      deployment: { kind: 'managedLocal' },
      revision: 4,
      createdAt: 1,
      updatedAt: 1,
    });
    const external = ProviderConnectionV1Schema.parse({
      ...managed,
      id: 'pc_external',
      deployment: { kind: 'external' },
    });
    const ollama = ProviderConnectionV1Schema.parse({
      ...managed,
      id: 'pc_ollama',
      displayName: 'Local Ollama',
      source: {
        kind: 'contribution',
        contributionKey: 'happier.provider.ollama/ollama',
      },
    });
    const rows = buildProviderGatewayCollection({ declarationContext: { kind: 'account' },
      connections: [managed, external, ollama],
    });
    expect(resolveProviderConnectionIcon(managed, { kind: 'account' })).toBe(PROVIDER_GATEWAY_ICON);
    expect(resolveProviderConnectionIcon(managed, { kind: 'machine', projection: null })).toBeNull();
    expect(buildProviderGatewayCollection({ declarationContext: { kind: 'machine', projection: null },
      connections: [managed],
    })).toEqual([]);
    expect(rows).toEqual([
      expect.objectContaining({
        connectionId: managed.id,
        title: 'Subscriptions',
        detailRoute: providerConnectionDetailRoute(managed.id),
        revision: 4,
      }),
    ]);
    const providers = buildProviderCollection({ declarationContext: { kind: 'account' },
      data: createProviderConnectionsDescribeFixture({
        connections: [
          createProviderConnectionViewFixture({
            connectionId: managed.id,
            displayName: managed.displayName,
            displayNameMode: 'custom',
            role: 'named',
          }),
        ],
      }),
      query: '',
      localDiscoveryEnabled: false,
    });
    expect(rows[0].detailRoute).toBe(providers.connections[0].detailRoute);
  });
  it('says which vendor services a gateway draws on: its set slots, in the contribution order', () => {
    const codex = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
    const gateway = ProviderConnectionV1Schema.parse({
      v: 1,
      id: 'pc_gateway',
      source: {
        kind: 'contribution',
        contributionKey: 'happier.provider.cliproxyapi/cliproxyapi',
      },
      role: 'named',
      displayName: 'Main gateway',
      displayNameMode: 'custom',
      deployment: { kind: 'managedLocal' },
      purposeBindingDefaults: {
        'openai-upstream': {
          kind: 'group',
          service: codex,
          groupId: 'codex-pool',
        },
      },
      revision: 2,
      createdAt: 1,
      updatedAt: 1,
    });
    const unset = ProviderConnectionV1Schema.parse({
      ...gateway,
      id: 'pc_unset',
      purposeBindingDefaults: {},
    });

    const rows = buildProviderGatewayCollection({ declarationContext: { kind: 'account' },
      connections: [gateway, unset],
    });
    expect(rows.map((row) => [row.connectionId, row.slotServices])).toEqual([
      ['pc_gateway', [codex]],
      ['pc_unset', []],
    ]);
  });
  it('lists found servers that are not connections yet, once per contribution', () => {
    const data = createProviderConnectionsDescribeFixture({
      connections: [
        createProviderConnectionViewFixture({
          connectionId: 'pc_a',
          displayName: 'Acme',
          providerName: 'Acme',
        }),
      ],
      discoveryCandidates: [
        candidate({
          contributionKey: 'plugin/acme',
          providerName: 'Acme',
          connection: { status: 'matched', connectionId: 'pc_a' },
        }),
        candidate({}),
      ],
      localInstallations: [
        {
          v: 1,
          machineId: 'machine-a',
          contributionKey: 'plugin/ollama',
          providerName: 'Ollama',
          status: 'installed_not_running',
          managedStartAvailable: false,
        },
        {
          v: 1,
          machineId: 'machine-a',
          contributionKey: 'plugin/lmstudio',
          providerName: 'LM Studio',
          status: 'installed_not_running',
          managedStartAvailable: true,
        },
      ] as never,
    });
    const collection = buildProviderCollection({ declarationContext: { kind: 'account' },
      data,
      query: '',
      localDiscoveryEnabled: true,
    });

    expect(collection.connections.map((row) => row.connectionId)).toEqual([
      'pc_a',
    ]);
    // The matched Acme server is the Acme connection; the running Ollama stands for its installation.
    expect(collection.found.map((row) => `${row.kind}:${row.title}`)).toEqual([
      'candidate:Ollama',
      'installation:LM Studio',
    ]);
    expect(collection.total).toBe(3);
    expect(
      buildProviderCollection({ declarationContext: { kind: 'account' }, data, query: '', localDiscoveryEnabled: false })
        .found,
    ).toEqual([]);
  });

  it('filters by name while keeping the unfiltered total', () => {
    const data = createProviderConnectionsDescribeFixture({
      connections: [
        createProviderConnectionViewFixture({
          connectionId: 'pc_a',
          displayName: 'Acme',
          providerName: 'Acme',
        }),
        createProviderConnectionViewFixture({
          connectionId: 'pc_b',
          displayName: 'Beta',
          providerName: 'Beta',
        }),
      ],
    });
    const collection = buildProviderCollection({ declarationContext: { kind: 'account' },
      data,
      query: 'bet',
      localDiscoveryEnabled: true,
    });
    expect(collection.connections.map((row) => row.connectionId)).toEqual([
      'pc_b',
    ]);
    expect(collection.total).toBe(2);
  });
});

describe('resolveProviderCollectionLandingId', () => {
  it('prefers the last visited connection that still exists, else the first, else none', () => {
    const rows = [{ connectionId: 'pc_a' }, { connectionId: 'pc_b' }];
    expect(resolveProviderCollectionLandingId(rows, 'pc_b')).toBe('pc_b');
    expect(resolveProviderCollectionLandingId(rows, 'pc_gone')).toBe('pc_a');
    expect(resolveProviderCollectionLandingId([], 'pc_a')).toBeNull();
  });
});
