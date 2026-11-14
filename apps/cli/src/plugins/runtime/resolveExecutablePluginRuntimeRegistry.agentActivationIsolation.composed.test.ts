import { getResolvedContributionRegistry } from '@/plugins/projection/registry/builtIn/snapshot';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    PluginManifestV2Schema,
    type PluginAgentContributionV2,
} from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import { resolveRunnerAgentSessionDescriptorForLease } from '@/daemon/spawn/prepareAgentRuntimeSessionBridge';
import { createMergedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { projectManifestAgentContribution } from '@/plugins/projection/registry/projectManifestAgentContribution';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { loadBundledPluginLocators } from '@/plugins/projection/registry/builtIn/locators';
import { BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS } from '@/plugins/projection/registry/sources/generatedBundledPluginManifests';
import { seedCurrentLocalPathPluginFixture } from '@/plugins/store/registry/currentState.testkit';

import { createPluginReloadController } from './reload/controller';
import { acquireAuthoritativePluginRuntimeRegistryLease } from './reload/runtimeLease';
import { resolveExecutablePluginRuntimeRegistry } from './resolveExecutablePluginRuntimeRegistry';

// Source dependency preparation is an external repository-build boundary. The
// registry, activation source, module load, controller publication and Agent
// runtime projection remain real beneath it.
vi.mock('@/subprocess/sourceDevSharedDepsPreflight', async (importOriginal) => {
    const actual = await importOriginal<
        typeof import('@/subprocess/sourceDevSharedDepsPreflight')
    >();
    return {
        ...actual,
        prepareSourceDevSharedDepsForBundledPluginRuntimeLoad: async () => ({
            type: 'ready' as const,
            checked: false,
            reason: 'not-source-dev' as const,
        }),
    };
});

describe('Agent runtime activation isolation', () => {
    it('preserves the activation owner diagnostic when an installed Agent cannot publish its runtime', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-agent-activation-failure-'));
        const pluginRoot = join(happyHomeDir, 'agent-plugin');
        const pluginId = 'acme.activation-failure';
        const agentId = `${pluginId}/agent`;
        const manifest = PluginManifestV2Schema.parse(createPluginManifestV2Fixture({
            id: pluginId,
            contributes: { agents: [{
                id: 'agent', title: 'Agent', runtime: { kind: 'custom' }, primary: 'sessions',
                capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
            }] },
        }));
        await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
        await writeFile(join(pluginRoot, '.happier-plugin', 'plugin.json'), JSON.stringify(manifest));
        await writeFile(join(pluginRoot, 'daemon.mjs'), 'export const activate = 1;\n');
        await seedCurrentLocalPathPluginFixture({ happyHomeDir, pluginRoot, pluginId, manifestVersion: manifest.version });
        const controller = createPluginReloadController({
            resolveRuntimeRegistry: () => resolveExecutablePluginRuntimeRegistry({ happyHomeDir, pluginIds: [pluginId] }),
        });
        try {
            const publicationLease = await controller.acquireRuntimeRegistry();
            await publicationLease.release();
            const lease = await acquireAuthoritativePluginRuntimeRegistryLease({ controller });
            try {
                expect(lease.registry.contributes.agentDefinitionsById.has(agentId)).toBe(true);
                const activation = await lease.registry.activateContributionsOnDemand([{ pluginId, family: 'agents', localId: 'agent' }]);
                const diagnostic = activation.find(result => result.pluginId === pluginId)?.diagnostics[0];
                expect(diagnostic).toMatchObject({
                    code: 'plugin_activation_failed',
                    details: { cause: { phase: 'activate', code: 'PLUGIN_ACTIVATION_EXPORT_INVALID', retryable: false } },
                });
                await expect(resolveRunnerAgentSessionDescriptorForLease({
                    target: { kind: 'backend', backendId: agentId },
                    lease,
                })).rejects.toMatchObject(diagnostic!);
            } finally { await lease.release(); }
        } finally {
            await controller.shutdown();
            await rm(happyHomeDir, { recursive: true, force: true });
        }
    });

    it('publishes demanded first-party runtimes from the authoritative registry when an unrelated Agent lacks source custody', async () => {
        const happyHomeDir = await mkdtemp(
            join(tmpdir(), 'happier-agent-activation-isolation-home-'),
        );
        const badPluginId = 'acme.bad-custody-agent';
        const badLocalAgentId = 'bad-custody-agent';
        const badAgentDefinition: PluginAgentContributionV2 = {
            id: badLocalAgentId,
            title: 'Bad custody Agent',
            runtime: {
                kind: 'acp',
                transport: { kind: 'tcp', host: '127.0.0.1', port: 4242 },
            },
            primary: 'sessions',
            capabilities: {
                sessions: {
                    open: ['create'],
                    delivery: ['newTurn'],
                    cancel: true,
                },
            },
        };
        const badManifest = PluginManifestV2Schema.parse(
            createPluginManifestV2Fixture({
                id: badPluginId,
                contributes: { agents: [badAgentDefinition] },
            }),
        );
        const badPluginRoot = join(
            happyHomeDir,
            'unadmitted-bad-custody-plugin',
        );
        const badManifestPath = join(
            badPluginRoot,
            '.happier-plugin',
            'plugin.json',
        );
        const badDaemonEntryPath = join(badPluginRoot, 'daemon.mjs');
        const badSourceSpec = {
            kind: 'path' as const,
            locator: badPluginRoot,
            trustPolicy: 'local_trusted' as const,
            installPolicy: 'link' as const,
            resolvedVersion: badManifest.version,
        };
        const contributes = createMergedContributionRegistry({
            agents: [projectManifestAgentContribution({
                definition: badAgentDefinition,
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: badPluginId,
                sourceSpec: badSourceSpec,
                hostAccess: badManifest.hostAccess,
                manifestPath: badManifestPath,
                daemonEntryPath: badDaemonEntryPath,
                devDaemonEntryPath: null,
            })],
            activationTargets: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: badPluginId,
                manifestPath: badManifestPath,
                daemonEntryPath: badDaemonEntryPath,
                devDaemonEntryPath: null,
                sourceSpec: badSourceSpec,
                activationEvents: [],
                manifest: badManifest,
            }],
        }, getResolvedContributionRegistry());
        const controller = createPluginReloadController({
            resolveRuntimeRegistry: async () => await resolveExecutablePluginRuntimeRegistry({
                happyHomeDir,
                contributes,
                generation: 1,
                resolveDevelopmentSourceAuthority: ({ pluginId, rootPath }) => ({
                    kind: 'development',
                    registeredRootId: `activation-isolation:${pluginId}`,
                    canonicalRoot: rootPath,
                    observedRevision: 1,
                }),
            }),
        });
        try {
            const publicationLease = await controller.acquireRuntimeRegistry();
            await publicationLease.release();
            const lease = await acquireAuthoritativePluginRuntimeRegistryLease({ controller });
            try {
                expect(lease.registry.readPluginOccurrenceId?.(badPluginId)).toBeNull();
                expect(lease.registry.agentRuntimesByAgentId.has('codex')).toBe(false);
                expect(lease.registry.agentRuntimesByAgentId.has('claude')).toBe(false);

                const claudeDescriptor = await resolveRunnerAgentSessionDescriptorForLease({
                    target: { kind: 'backend', sourceKind: 'built_in', backendId: 'claude' },
                    lease,
                });
                expect(claudeDescriptor).toMatchObject({ pluginId: 'happier.agent.claude', agentId: 'claude' });

                const claude = lease.registry.agentRuntimesByAgentId.get('claude');
                expect(claude).toMatchObject({
                    pluginId: 'happier.agent.claude',
                    agentId: 'claude',
                    hasPrimaryRuntime: true,
                });
                const claudeRuntime = await claude?.createRuntime({
                    signal: new AbortController().signal,
                });
                expect(claudeRuntime?.sessions).toBeDefined();

                const codexDescriptor = await resolveRunnerAgentSessionDescriptorForLease({
                    target: { kind: 'backend', sourceKind: 'built_in', backendId: 'codex' },
                    lease,
                });
                expect(codexDescriptor).toMatchObject({ pluginId: 'happier.agent.codex', agentId: 'codex' });

                expect(lease.registry.agentRuntimesByAgentId.get('codex')).toMatchObject({
                    pluginId: 'happier.agent.codex',
                    agentId: 'codex',
                    hasPrimaryRuntime: true,
                });
                const museDescriptor = await resolveRunnerAgentSessionDescriptorForLease({
                    target: { kind: 'backend', sourceKind: 'built_in', backendId: 'muse' },
                    lease,
                });
                expect(museDescriptor).toMatchObject({ pluginId: 'happier.agent.muse', agentId: 'muse' });
                const muse = lease.registry.agentRuntimesByAgentId.get('muse');
                expect(muse).toMatchObject({
                    pluginId: 'happier.agent.muse',
                    agentId: 'muse',
                    hasPrimaryRuntime: true,
                });
                const museRuntime = await muse?.createRuntime({
                    signal: new AbortController().signal,
                });
                expect(museRuntime?.sessions).toBeDefined();

                for (const agentId of ['claude', 'codex', 'muse']) {
                    const pluginId = `happier.agent.${agentId}`;
                    const bundled = loadBundledPluginLocators(BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS.filter(
                        locator => locator.pluginId === pluginId,
                    ))[0];
                    const declaredFactory = bundled?.manifest.runtime.agentFactories?.find(
                        factory => factory.localAgentId === agentId,
                    );
                    expect(declaredFactory).toBeDefined();
                    expect(lease.registry.agentRuntimesByAgentId.get(agentId)?.sessionRunnerFactoryBinding?.locator)
                        .toEqual(declaredFactory?.locator);
                }
            } finally {
                await lease.release();
            }
        } finally {
            await controller.shutdown();
            await rm(happyHomeDir, { recursive: true, force: true });
        }
    });
});
