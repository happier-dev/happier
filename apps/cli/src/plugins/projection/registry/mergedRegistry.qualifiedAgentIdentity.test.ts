import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createPluginStateStore } from '@/plugins/store/state.testkit';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import {
    resolveEngineBackendIdForCatalogAgent,
    resolveEngineRuntimeContribution,
} from '@/agent/runtime/registry/engineRegistry/contributions';
import {
    createTargetAgentRuntimeRegistry,
    type AgentRuntimeOwnerDuplicate,
} from '@/plugins/runtime/lifecycle/contributions/targetAgents';
import type { ActivationTarget } from '@/plugins/runtime/lifecycle/activation/targets';

import { readAgentRoutingIdForContributionIdentity, indexAgentRoutingIdsByContributionIdentity } from './agentRoutingIdentity';
import { resolveMergedContributionRegistry } from './createResolvedContributionRegistry';

const LOCAL_AGENT_ID = 'assistant';

async function writeAssistantPlugin(rootDir: string, pluginId: string, title: string): Promise<void> {
    const manifestDir = join(rootDir, '.happier-plugin');
    await mkdir(manifestDir, { recursive: true });
    await writeFile(join(rootDir, 'daemon.js'), 'export async function launch() { return null; }\n', 'utf8');
    await writeFile(
        join(manifestDir, 'plugin.json'),
        JSON.stringify(createPluginManifestV2Fixture({
            schemaVersion: 2,
            id: pluginId,
            version: '1.0.0',
            displayName: title,
            engines: { happier: '^0.2.0' },
            entrypoints: { daemon: './daemon.js' },
            activation: { events: [{ kind: 'startup' }] },
            hostAccess: { required: [], optional: [] },
            contributes: {
                agents: [{
                    id: LOCAL_AGENT_ID,
                    title,
                    runtime: { kind: 'custom' },
                    primary: 'sessions',
                    capabilities: {
                        surfaces: ['terminal'],
                        sessions: { open: ['create'], delivery: ['newTurn'], cancel: true },
                    },
                }],
            },
        }), null, 2),
        'utf8',
    );
}

function activationTarget(pluginId: string): ActivationTarget {
    // Boundary fixture: the runtime registry only consumes manifest.version here.
    return {
        provenance: 'external',
        source: { kind: 'path' },
        pluginId,
        manifestPath: `/plugins/${pluginId}/plugin.json`,
        daemonEntryPath: `/plugins/${pluginId}/daemon.js`,
        devDaemonEntryPath: null,
        sourceSpec: {
            kind: 'path',
            locator: `/plugins/${pluginId}`,
            trustPolicy: 'local_trusted',
            installPolicy: 'link',
        },
        manifest: { version: '1.0.0' },
    } as unknown as ActivationTarget;
}

function agentRuntimeRegistration(pluginId: string) {
    return {
        pluginId,
        generation: `generation-${pluginId}`,
        registration: {
            family: 'agents' as const,
            localId: LOCAL_AGENT_ID,
            value: {
                factory: async () => ({
                    executionRuns: {
                        open: async () => ({
                            send: async () => ({ status: 'admitted' as const, owner: pluginId }),
                            stop: async () => ({ status: 'requested' as const }),
                            watch: () => ({ dispose: () => undefined }),
                            dispose: async () => undefined,
                        }),
                    },
                }),
            },
        },
    } as unknown as Parameters<typeof createTargetAgentRuntimeRegistry>[0]['targetRegistrations'][number];
}

async function resolveTwoAssistantPluginRegistry() {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-qai-home-'));
    const alphaRoot = await mkdtemp(join(tmpdir(), 'happier-qai-alpha-'));
    const betaRoot = await mkdtemp(join(tmpdir(), 'happier-qai-beta-'));
    await writeAssistantPlugin(alphaRoot, 'acme.alpha', 'Alpha Assistant');
    await writeAssistantPlugin(betaRoot, 'acme.beta', 'Beta Assistant');

    const store = createPluginStateStore({ happyHomeDir });
    await store.write({
        t: 'happier_plugin_state_v1',
        schemaVersion: 1,
        plugins: Object.fromEntries([['acme.alpha', alphaRoot], ['acme.beta', betaRoot]].map(([id, root]) => [id, {
            source: {
                kind: 'path' as const,
                locator: root!,
                trustPolicy: 'local_trusted' as const,
                installPolicy: 'link' as const,
                resolvedPath: root!,
                manifestPath: join(root!, '.happier-plugin', 'plugin.json'),
            },
            compatibility: { status: 'unknown' as const, diagnostics: [] },
            install: { mode: 'link' as const, manifestVersion: '1.0.0', installedPath: null },
            state: { enabled: true },
        }])),
    });

    return await resolveMergedContributionRegistry({ happyHomeDir });
}

describe('two plugins declaring the same local Agent id', () => {
    it('projects, selects and routes each Agent through its own qualified identity', async () => {
        const registry = await resolveTwoAssistantPluginRegistry();

        // Both Agents survive projection under distinct qualified routing ids,
        // and neither claims the bare local id.
        const alpha = registry.agentDefinitionsById.get('acme.alpha/assistant');
        const beta = registry.agentDefinitionsById.get('acme.beta/assistant');
        expect(alpha?.pluginId).toBe('acme.alpha');
        expect(beta?.pluginId).toBe('acme.beta');
        expect(alpha?.identity).toEqual({ pluginId: 'acme.alpha', localId: LOCAL_AGENT_ID });
        expect(beta?.identity).toEqual({ pluginId: 'acme.beta', localId: LOCAL_AGENT_ID });
        expect(registry.agentDefinitionsById.get(LOCAL_AGENT_ID)).toBeUndefined();

        // Neither plugin was dropped as a collision.
        const diagnosticMessages = Object.values(registry.pluginDiagnosticsByPluginId)
            .flat()
            .map((diagnostic) => diagnostic.message);
        expect(diagnosticMessages.filter((message) => message.includes('collides'))).toEqual([]);

        // Released built-in Agent identifiers stay unqualified at the boundary.
        expect(registry.agentDefinitionsById.get('claude')?.id).toBe('claude');

        // Exact selection by durable `{pluginId, localId}` identity never
        // returns the other plugin's Agent.
        const routingIds = indexAgentRoutingIdsByContributionIdentity(
            [...registry.agentDefinitionsById.values()],
        );
        expect(readAgentRoutingIdForContributionIdentity(routingIds, {
            pluginId: 'acme.alpha',
            localId: LOCAL_AGENT_ID,
        })).toBe('acme.alpha/assistant');
        expect(readAgentRoutingIdForContributionIdentity(routingIds, {
            pluginId: 'acme.beta',
            localId: LOCAL_AGENT_ID,
        })).toBe('acme.beta/assistant');

        // Engine routing resolves each Agent to its own plugin, and the bare
        // local id resolves to nothing rather than defaulting to either Agent
        // or to Claude.
        expect(resolveEngineRuntimeContribution(registry, 'acme.alpha/assistant')?.pluginId).toBe('acme.alpha');
        expect(resolveEngineRuntimeContribution(registry, 'acme.beta/assistant')?.pluginId).toBe('acme.beta');
        expect(resolveEngineRuntimeContribution(registry, LOCAL_AGENT_ID)).toBeNull();
        expect(resolveEngineBackendIdForCatalogAgent(registry, 'acme.alpha/assistant')).toBe('acme.alpha/assistant');
        expect(resolveEngineBackendIdForCatalogAgent(registry, 'acme.beta/assistant')).toBe('acme.beta/assistant');
        expect(resolveEngineBackendIdForCatalogAgent(registry, LOCAL_AGENT_ID)).toBeNull();
    });

    it('activates both Agent runtimes without either plugin displacing the other', async () => {
        const registry = await resolveTwoAssistantPluginRegistry();
        const onDuplicate = vi.fn<(duplicate: AgentRuntimeOwnerDuplicate) => void>();

        const runtimes = createTargetAgentRuntimeRegistry({
            agents: [...registry.agentDefinitionsById.values()],
            activationTargets: [activationTarget('acme.alpha'), activationTarget('acme.beta')],
            targetRegistrations: [
                agentRuntimeRegistration('acme.alpha'),
                agentRuntimeRegistration('acme.beta'),
            ],
            isGenerationActive: () => true,
            retirementSignal: new AbortController().signal,
            onDuplicate,
        });

        expect(onDuplicate).not.toHaveBeenCalled();
        const alphaLease = runtimes.get('acme.alpha/assistant');
        const betaLease = runtimes.get('acme.beta/assistant');
        expect(alphaLease?.pluginId).toBe('acme.alpha');
        expect(betaLease?.pluginId).toBe('acme.beta');
        expect(runtimes.get(LOCAL_AGENT_ID)).toBeUndefined();

        // Each lease builds its own plugin's runtime, not the other plugin's.
        const alphaRun = await (await alphaLease!.createRuntime!({ signal: new AbortController().signal }))
            .executionRuns!.open({} as never, {} as never);
        const betaRun = await (await betaLease!.createRuntime!({ signal: new AbortController().signal }))
            .executionRuns!.open({} as never, {} as never);
        expect(await alphaRun.send({} as never)).toMatchObject({ owner: 'acme.alpha' });
        expect(await betaRun.send({} as never)).toMatchObject({ owner: 'acme.beta' });
    });
});
