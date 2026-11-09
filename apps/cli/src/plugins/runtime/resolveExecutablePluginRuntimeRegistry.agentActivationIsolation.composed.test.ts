import { getResolvedContributionRegistry } from '@/plugins/projection/registry/builtIn/snapshot';
import { mkdtemp, rm } from 'node:fs/promises';
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
                for (const agentId of ['claude', 'codex']) {
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
