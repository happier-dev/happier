import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());

import type { ResolvedAgentCatalogEntry } from '@/agents/backendCatalog/agentCatalogProjection';
import type { MachineAgent } from '@/agents/machineAgents/machineAgentTypes';
import { projectMachineAgent } from '@/agents/machineAgents/machineAgentModel';
import { CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1 } from '@happier-dev/protocol/agents/executionTargetV1';

import { AcpBackendDefinitionV1Schema } from '@happier-dev/protocol/acp/catalog/settingsV1';
import { agentColumnFacts } from './agentColumnAdapter';

import {
    buildAgentCollection,
    isCommandAgentDefinition,
    resolveAgentCollectionLandingId,
    resolveSelectedAgentCollectionId,
} from './agentCollectionModel';

function entry(agentId: string, overrides: Partial<ResolvedAgentCatalogEntry> = {}): ResolvedAgentCatalogEntry {
    return {
        agentId,
        qualifiedId: agentId,
        identity: null,
        installedPackage: null,
        projectionGeneration: null,
        catalogAgentId: null,
        iconAgentId: null,
        backendTargetKey: null,
        title: agentId.charAt(0).toUpperCase() + agentId.slice(1),
        subtitle: null,
        iconName: 'code',
        channel: 'stable',
        enabled: true,
        isBuiltIn: true,
        descriptor: null,
        behavior: null,
        authPlugin: null,
        cli: { executable: { binaryName: agentId, sourcePreference: 'system-first' } } as ResolvedAgentCatalogEntry['cli'],
        cliAuthBackgroundCheckSafe: true,
        connectedAccounts: [],
        ...overrides,
    };
}

function agent(agentId: string, state: MachineAgent['state'], overrides: Partial<MachineAgent> = {}): MachineAgent {
    return {
        ...projectMachineAgent({ agentId, title: agentId, facts: null, checking: false, stale: false, connectedServices: [], job: null }),
        installed: state !== 'notInstalled' && state !== 'unsupported',
        state,
        ...overrides,
    };
}

describe('buildAgentCollection', () => {
    it('supplies held Machine counts and versions to the shared column context without inventing unknown facts', () => {
        const row = buildAgentCollection({ entries: [entry('claude')], agents: [], query: '' }).onMachine[0]!;
        const input = { context: null, machineId: 'active', heldSummary: {
            machineCount: 4, versions: ['2.1.4'], unknownVersionCount: 0, complete: true,
        } };
        expect(agentColumnFacts(row, input).context).toBe('projects.identity.machineCount(count=4) · 2.1.4');
        expect(agentColumnFacts(row, { ...input, heldSummary: { ...input.heldSummary, unknownVersionCount: 1 } }).context)
            .toBe('projects.identity.machineCount(count=4)');
        expect(agentColumnFacts(row, { ...input, context: 'fallback', heldSummary: { ...input.heldSummary, complete: false } }).context)
            .toBe('settingsAgents.collection.machineCountAtLeast(count=4)');
        expect(agentColumnFacts(row, { ...input, context: 'fallback', heldSummary: { ...input.heldSummary, machineCount: 0, complete: false } }).context)
            .toBe('fallback');
        expect(agentColumnFacts(row, { ...input, heldSummary: { ...input.heldSummary, versions: ['2.1.4', '2.2.0'] } }).context)
            .toBe('projects.identity.machineCount(count=4) · 2.1.4, 2.2.0');
    });

    it('groups agents by what the selected machine reports: detected CLIs on the machine, missing ones available to install', () => {
        const collection = buildAgentCollection({
            entries: [entry('claude'), entry('cursor'), entry('codex'), entry('helper', { cli: null })],
            agents: [agent('claude', 'ready'), agent('cursor', 'notInstalled'), agent('codex', 'checking')],
            query: '',
        });

        // An agent whose CLI is still being detected, or that has no CLI at all, is not "missing".
        expect(collection.onMachine.map((row) => row.entry.agentId)).toEqual(['claude', 'codex', 'helper']);
        expect(collection.available.map((row) => row.entry.agentId)).toEqual(['cursor']);
        expect(collection.available[0]?.status).toBe('notInstalled');
        expect(collection.total).toBe(4);
    });

    it('flags only a signed-out installed agent as trouble and keeps healthy and disabled rows quiet', () => {
        const collection = buildAgentCollection({
            entries: [entry('claude'), entry('opencode'), entry('codex', { enabled: false }), entry('gemini')],
            agents: [agent('claude', 'ready'), agent('opencode', 'needsSignIn'), agent('codex', 'needsSignIn'), agent('gemini', 'updateAvailable')],
            query: '',
        });

        const byId = Object.fromEntries(collection.onMachine.map((row) => [row.entry.agentId, row]));
        expect(byId.claude).toMatchObject({ status: 'ready', trouble: false });
        expect(byId.opencode).toMatchObject({ status: 'needsSignIn', trouble: true });
        // Turning an agent off is a choice, not a problem to fix.
        expect(byId.codex).toMatchObject({ status: 'disabled', trouble: false });
        expect(byId.gemini).toMatchObject({ status: 'updateAvailable', trouble: false });
    });

    it('claims no status for an agent the machine has not reported on yet, instead of a guessed one', () => {
        const collection = buildAgentCollection({
            entries: [entry('codex'), entry('helper', { cli: null })],
            agents: [],
            query: '',
        });

        expect(collection.onMachine.map((row) => row.status)).toEqual(['unknown', 'unknown']);
    });

    it('filters both groups by name without changing the total', () => {
        const collection = buildAgentCollection({
            entries: [entry('claude'), entry('cursor'), entry('codex')],
            agents: [agent('claude', 'ready'), agent('cursor', 'notInstalled'), agent('codex', 'ready')],
            query: '  CU ',
        });

        expect(collection.onMachine).toEqual([]);
        expect(collection.available.map((row) => row.entry.agentId)).toEqual(['cursor']);
        expect(collection.total).toBe(3);
    });

    it('leaves configured custom ACP agents to their own group instead of listing them twice', () => {
        const custom = { pluginId: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1.pluginId, localId: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1.localId };
        const collection = buildAgentCollection({
            entries: [
                entry('claude'),
                entry('custom-acp', { identity: custom, title: 'Reviewer bot', isBuiltIn: false, cli: null }),
                entry('custom-acp', { identity: custom, title: 'Local Qwen', isBuiltIn: false, cli: null, enabled: false }),
            ],
            agents: [agent('claude', 'ready')],
            query: '',
        });

        expect([...collection.onMachine, ...collection.available].map((row) => row.entry.title)).toEqual(['Claude']);
        expect(collection.total).toBe(1);
    });

    it('retains canonical unsupported and job states, and does not flag stale sign-in facts as trouble', () => {
        const collection = buildAgentCollection({
            entries: [entry('antigravity'), entry('claude'), entry('codex'), entry('gemini')],
            agents: [agent('antigravity', 'unsupported'), agent('claude', 'installing'), agent('codex', 'failed'), agent('gemini', 'needsSignIn', { stale: true })],
            query: '',
        });
        expect(collection.available.map((row) => row.status)).toEqual(['unsupported']);
        expect(collection.onMachine.map((row) => [row.status, row.trouble])).toEqual([
            ['installing', false], ['failed', false], ['needsSignIn', false],
        ]);
    });
});

describe('buildAgentCollection · registry definitions', () => {
    const capabilities = { supportsLoadSession: false, supportsModes: 'unknown', supportsModels: 'unknown', supportsConfigOptions: 'unknown', promptImageSupport: 'unknown' } as const;
    const provenance = (itemId: string, version: string) => ({ sourceId: 'builtin:acp-registry', format: 'acp-registry' as const,
        sourceUrl: 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json', itemId, ref: { kind: 'version' as const, version }, importedAt: 1 });
    const registry = (id: string, title: string) => AcpBackendDefinitionV1Schema.parse({
        id, name: id, title, env: {}, capabilities, createdAt: 1, updatedAt: 1,
        launch: { kind: 'npm', package: `@acme/${id}`, version: '1.0.0', args: [] },
        origin: { kind: 'registry', provenance: provenance(id, '1.0.0') },
    });
    const command = AcpBackendDefinitionV1Schema.parse({ id: 'kiro', name: 'kiro', title: 'Kiro', env: {}, capabilities, createdAt: 1, updatedAt: 1,
        launch: { kind: 'command', command: 'kiro-cli', args: ['acp'] } });
    const custom = { pluginId: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1.pluginId, localId: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1.localId };
    const definitionEntry = (title: string) => entry('custom-acp', { identity: custom, title, isBuiltIn: false, cli: null });

    it('lists a registry agent with the agents by its detected state; one not installed says it installs on first use', () => {
        const goose = registry('goose', 'goose');
        const vibe = registry('mistral-vibe', 'Mistral Vibe');
        const collection = buildAgentCollection({
            entries: [entry('claude')],
            agents: [agent('claude', 'ready'), agent('custom-acp', 'needsSignIn', { definitionId: goose.id })],
            definitions: [{ definition: goose, entry: definitionEntry('goose') }, { definition: vibe, entry: definitionEntry('Mistral Vibe') }],
            query: '',
        });
        expect(collection.onMachine.map((row) => [row.key, row.status])).toEqual([['claude', 'ready'], [`definition:${goose.id}`, 'needsSignIn']]);
        expect(collection.available.map((row) => [row.entry.title, row.status, row.definition?.id])).toEqual([['Mistral Vibe', 'installsOnFirstUse', vibe.id]]);
        expect(collection.total).toBe(3);
    });

    it('keeps "Custom agents" to agents started from a command', () => {
        expect(isCommandAgentDefinition(command)).toBe(true);
        expect(isCommandAgentDefinition(registry('goose', 'goose'))).toBe(false);
    });
});

describe('resolveSelectedAgentCollectionId', () => {
    const entries = [
        entry('codex'),
        entry('acme.review/provider', { identity: { pluginId: 'acme.review', localId: 'provider' } }),
        entry('provider'),
    ];

    it('selects the agent the detail route addresses, keeping a plugin agent distinct from a same-named built-in', () => {
        expect(resolveSelectedAgentCollectionId(entries, { agentId: 'codex', pluginId: null })).toBe('codex');
        expect(resolveSelectedAgentCollectionId(entries, { agentId: 'provider', pluginId: 'acme.review' }))
            .toBe('acme.review/provider');
        expect(resolveSelectedAgentCollectionId(entries, { agentId: 'provider', pluginId: null })).toBe('provider');
    });

    it('selects nothing on the collection index or for an unknown agent', () => {
        expect(resolveSelectedAgentCollectionId(entries, { agentId: null, pluginId: null })).toBeNull();
        expect(resolveSelectedAgentCollectionId(entries, { agentId: 'missing', pluginId: null })).toBeNull();
        expect(resolveSelectedAgentCollectionId(entries, { agentId: 'provider', pluginId: 'other.plugin' })).toBeNull();
    });
});

describe('resolveAgentCollectionLandingId', () => {
    const collection = buildAgentCollection({
        entries: [entry('cursor'), entry('claude'), entry('codex')],
        agents: [agent('cursor', 'notInstalled'), agent('claude', 'ready'), agent('codex', 'ready')],
        query: '',
    });

    it('returns to the agent visited last while it is still listed', () => {
        expect(resolveAgentCollectionLandingId(collection, 'codex')).toBe('codex');
        expect(resolveAgentCollectionLandingId(collection, 'cursor')).toBe('cursor');
    });

    it('otherwise opens the first agent on the machine, then the first listed', () => {
        expect(resolveAgentCollectionLandingId(collection, 'gone')).toBe('claude');
        expect(resolveAgentCollectionLandingId(collection, null)).toBe('claude');
        const nothingInstalled = buildAgentCollection({
            entries: [entry('cursor')],
            agents: [agent('cursor', 'notInstalled')],
            query: '',
        });
        expect(resolveAgentCollectionLandingId(nothingInstalled, null)).toBe('cursor');
        expect(resolveAgentCollectionLandingId(buildAgentCollection({ entries: [], agents: [], query: '' }), null)).toBeNull();
    });
});
