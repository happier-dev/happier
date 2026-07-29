import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';

import { resolveExecutablePluginRuntimeRegistry } from './resolveExecutablePluginRuntimeRegistry';

describe('resolveExecutablePluginRuntimeRegistry declarative ACP admission', () => {
    it('admits invocation services for an entrypoint-free Agent from the normalized catalog', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-declarative-agent-services-home-'));
        const agentId = 'novel-declarative-acp-agent';
        const pluginId = 'acme.declarative-acp-proof';
        const runtimeRegistry = await resolveExecutablePluginRuntimeRegistry({
            happyHomeDir,
            contributes: createResolvedContributionRegistry({
                agents: [{
                    id: agentId,
                    provenance: 'external',
                    source: { kind: 'path' },
                    definition: { kindVersion: 1, id: agentId, ownedBackendIds: [] },
                    richDefinition: {
                        provenance: 'external',
                        definition: {
                            id: agentId,
                            title: 'Novel Declarative ACP Agent',
                            runtime: {
                                kind: 'acp',
                                transport: {
                                    kind: 'stdio',
                                    executable: { kind: 'systemTool', id: 'fixture-acp' },
                                },
                            },
                            primary: 'sessions',
                            capabilities: {
                                sessions: { open: ['create'], delivery: ['newTurn'], cancel: true },
                            },
                        },
                    },
                    pluginId,
                    hostAccess: {
                        required: [{
                            id: 'agent-process',
                            capability: 'process',
                            reason: 'Run the declared Agent executable',
                            scope: { executables: [{ kind: 'systemTool', id: 'fixture-acp' }] },
                        }],
                        optional: [],
                    },
                    sourceSpec: {
                        kind: 'path',
                        locator: '/plugins/acme.declarative-acp-proof',
                        trustPolicy: 'local_trusted',
                        installPolicy: 'link',
                        resolvedVersion: '1.0.0',
                    },
                }],
                activationTargets: [],
            }),
            generation: 17,
            generationAuthority: {
                commit: null,
                generations: new Map(),
                rejectedGenerations: new Map(),
                unavailableBundledPackageNames: new Set(),
                isCurrent: async () => true,
            },
        });

        try {
            const lease = runtimeRegistry.agentRuntimesByAgentId.get(agentId);
            expect(lease).toMatchObject({ pluginId, agentId, generation: '17' });
            const services = runtimeRegistry.createAgentInvocationServices({
                pluginId,
                pluginVersion: '1.0.0',
                agentId,
                generation: '17',
                correlationId: 'declarative-agent-services',
                cwd: happyHomeDir,
                signal: new AbortController().signal,
                isGenerationCurrent: () => true,
            });
            await expect(services.storage.local.set('proof', 'catalog-owned')).resolves.toBeUndefined();
            await expect(services.storage.local.get('proof')).resolves.toBe('catalog-owned');
        } finally {
            await runtimeRegistry.dispose();
            await rm(happyHomeDir, { recursive: true, force: true });
        }
    });
});
