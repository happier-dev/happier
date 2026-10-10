import { describe, expect, it } from 'vitest';

import {
    createProviderConnectionViewFixture,
    createProviderConnectionsDescribeFixture,
} from '@/dev/testkit';

import { ProviderConnectionV1Schema } from '@happier-dev/protocol/providers/connections/v1';
import { buildProviderCollection, buildProviderGatewayCollection, providerConnectionDetailRoute, resolveProviderCollectionLandingId } from './providerCollectionModel';

function candidate(overrides: Record<string, unknown>) {
    return {
        v: 1, machineId: 'machine-a', contributionKey: 'plugin/ollama',
        providerName: 'Ollama', endpointTemplateId: 'native',
        normalizedEndpointUrl: 'http://127.0.0.1:11434',
        candidateId: 'discovery-candidate:v1:a',
        evidence: { kind: 'attributed_listener' }, ownership: 'adopted',
        connection: { status: 'enable_default' },
        ...overrides,
    } as never;
}

describe('buildProviderCollection', () => {
    it('marks a gateway row from the machine view alone, and not another managed or an external connection', () => {
        const purposes = [{ purpose: 'openai-upstream', service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, required: false }];
        const data = createProviderConnectionsDescribeFixture({ connections: [
            createProviderConnectionViewFixture({ connectionId: 'pc_gateway', contributionKey: 'happier.provider.cliproxyapi/cliproxyapi',
                deployment: { kind: 'managedLocal', targetMachineId: 'machine-a', effects: null },
                managedLocalOption: { targetMachineId: 'machine-a', connectedAccountPurposes: purposes } }),
            createProviderConnectionViewFixture({ connectionId: 'pc_ollama', contributionKey: 'happier.provider.ollama/ollama',
                deployment: { kind: 'managedLocal', targetMachineId: 'machine-a', effects: null },
                managedLocalOption: { targetMachineId: 'machine-a', connectedAccountPurposes: [] } }),
            // An external endpoint that could become managed is not a gateway yet.
            createProviderConnectionViewFixture({ connectionId: 'pc_external', contributionKey: 'happier.provider.cliproxyapi/cliproxyapi',
                managedLocalOption: { targetMachineId: 'machine-a', connectedAccountPurposes: purposes } }),
        ] });
        const rows = buildProviderCollection({ data: data as never, query: '', localDiscoveryEnabled: false }).connections;
        expect(rows.map((row) => [row.connectionId, row.gateway])).toEqual([
            ['pc_gateway', true], ['pc_ollama', false], ['pc_external', false],
        ]);
    });
    it('projects admitted vendor gateways to the same connection detail and excludes other managed Providers', () => {
        const managed = ProviderConnectionV1Schema.parse({ v: 1, id: 'pc_gateway',
            source: { kind: 'contribution', contributionKey: 'happier.provider.cliproxyapi/cliproxyapi' },
            role: 'named', displayName: 'Subscriptions', displayNameMode: 'custom',
            deployment: { kind: 'managedLocal' }, revision: 4, createdAt: 1, updatedAt: 1 });
        const external = ProviderConnectionV1Schema.parse({ ...managed, id: 'pc_external', deployment: { kind: 'external' } });
        const ollama = ProviderConnectionV1Schema.parse({ ...managed, id: 'pc_ollama', displayName: 'Local Ollama',
            source: { kind: 'contribution', contributionKey: 'happier.provider.ollama/ollama' } });
        const rows = buildProviderGatewayCollection({ connections: [managed, external, ollama], views: [
            createProviderConnectionViewFixture({ connectionId: managed.id, revision: 3,
                contributionKey: 'happier.provider.cliproxyapi/cliproxyapi',
                deployment: { kind: 'managedLocal', targetMachineId: 'machine-a', effects: null },
                managedLocalOption: { targetMachineId: 'machine-a', connectedAccountPurposes: [
                    { purpose: 'openai-upstream', service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, required: false },
                ] } }),
            createProviderConnectionViewFixture({ connectionId: ollama.id, revision: ollama.revision,
                contributionKey: 'happier.provider.ollama/ollama',
                deployment: { kind: 'managedLocal', targetMachineId: 'machine-a', effects: null },
                managedLocalOption: { targetMachineId: 'machine-a', connectedAccountPurposes: [] } }),
        ] });
        expect(rows).toEqual([expect.objectContaining({ connectionId: managed.id, title: 'Subscriptions',
            detailRoute: providerConnectionDetailRoute(managed.id), revision: 4 })]);
        const providers = buildProviderCollection({ data: createProviderConnectionsDescribeFixture({
            connections: [createProviderConnectionViewFixture({ connectionId: managed.id, displayName: managed.displayName,
                displayNameMode: 'custom', role: 'named' })],
        }), query: '', localDiscoveryEnabled: false });
        expect(rows[0].detailRoute).toBe(providers.connections[0].detailRoute);
    });
    it('lists found servers that are not connections yet, once per contribution', () => {
        const data = createProviderConnectionsDescribeFixture({
            connections: [createProviderConnectionViewFixture({ connectionId: 'pc_a', displayName: 'Acme', providerName: 'Acme' })],
            discoveryCandidates: [
                candidate({ contributionKey: 'plugin/acme', providerName: 'Acme', connection: { status: 'matched', connectionId: 'pc_a' } }),
                candidate({}),
            ],
            localInstallations: [
                { v: 1, machineId: 'machine-a', contributionKey: 'plugin/ollama', providerName: 'Ollama', status: 'installed_not_running', managedStartAvailable: false },
                { v: 1, machineId: 'machine-a', contributionKey: 'plugin/lmstudio', providerName: 'LM Studio', status: 'installed_not_running', managedStartAvailable: true },
            ] as never,
        });
        const collection = buildProviderCollection({ data, query: '', localDiscoveryEnabled: true });

        expect(collection.connections.map((row) => row.connectionId)).toEqual(['pc_a']);
        // The matched Acme server is the Acme connection; the running Ollama stands for its installation.
        expect(collection.found.map((row) => `${row.kind}:${row.title}`)).toEqual([
            'candidate:Ollama',
            'installation:LM Studio',
        ]);
        expect(collection.total).toBe(3);
        expect(buildProviderCollection({ data, query: '', localDiscoveryEnabled: false }).found).toEqual([]);
    });

    it('filters by name while keeping the unfiltered total', () => {
        const data = createProviderConnectionsDescribeFixture({
            connections: [
                createProviderConnectionViewFixture({ connectionId: 'pc_a', displayName: 'Acme', providerName: 'Acme' }),
                createProviderConnectionViewFixture({ connectionId: 'pc_b', displayName: 'Beta', providerName: 'Beta' }),
            ],
        });
        const collection = buildProviderCollection({ data, query: 'bet', localDiscoveryEnabled: true });
        expect(collection.connections.map((row) => row.connectionId)).toEqual(['pc_b']);
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
