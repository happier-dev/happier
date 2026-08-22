import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { resolveCliEngineRegistry } from '@/agent/runtime/registry/engineRegistry';
import { readPluginManifest } from '@/plugins/manifest/read';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { projectManifestAgentContribution } from '@/plugins/projection/registry/projectManifestAgentContribution';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import { readCurrentCommittedPluginGenerations } from '@/plugins/store/registry/generationStore';
import { seedCurrentLocalPathPluginFixture } from '@/plugins/store/registry/currentState.testkit';

import { loadRetainedAgentRuntimeLeaf } from './runner/loadRetainedAgentRuntimeLeaf';
import { resolveExecutablePluginRuntimeRegistry } from './resolveExecutablePluginRuntimeRegistry';

const AGENT_ID = 'runner-agent';

type PublicRunnerFixtureState = {
    activationCalls: number;
    factoryCalls: number;
    sessionOpenCalls: number;
    sessionDisposeCalls: number;
};

function readPublicRunnerFixtureState(counterKey: string): PublicRunnerFixtureState {
    const state = (
        globalThis as typeof globalThis &
            Record<string, PublicRunnerFixtureState | undefined>
    )[counterKey];
    if (!state) {
        throw new Error(`Missing public runner fixture state '${counterKey}'`);
    }
    return state;
}

function createRuntimePlacementSessionClient(sessionId: string) {
    let metadata: Record<string, unknown> = {
        path: '/tmp/public-external-runner',
        host: 'test',
        homeDir: '/tmp',
        happyHomeDir: '/tmp/.happier',
        happyLibDir: '/tmp/.happier/lib',
        happyToolsDir: '/tmp/.happier/tools',
    };
    return {
        sessionId,
        rpcHandlerManager: { registerHandler: () => {} },
        updateAgentState: async () => {},
        updateMetadata: async (
            updater: (state: Record<string, unknown>) => Record<string, unknown>,
        ) => {
            metadata = updater(metadata);
        },
        getMetadataSnapshot: () => metadata,
        getAgentStateSnapshot: () => ({}),
        readSessionTurnsProjection: async () => null,
        on: () => {},
        off: () => {},
    };
}

async function createDevelopmentRunnerFixture(input: Readonly<{
    pluginId: string;
    locatorModule: string;
    locatorExport: string;
}>): Promise<Readonly<{
    happyHomeDir: string;
    pluginRoot: string;
    counterKey: string;
}>> {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-runner-resolver-home-'));
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-runner-resolver-plugin-'));
    const counterKey = `__happier_public_runner_${input.pluginId.replace(/[^a-z0-9]/giu, '_')}`;
    await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
    await mkdir(join(pluginRoot, 'dist'), { recursive: true });
    await mkdir(join(pluginRoot, 'src', 'runner'), { recursive: true });
    await writeFile(
        join(pluginRoot, '.happier-plugin', 'plugin.json'),
        JSON.stringify({
            schemaVersion: 2,
            id: input.pluginId,
            version: '1.0.0',
            displayName: 'Runner resolver fixture',
            engines: { happier: '^0.2.0' },
            runtime: { apiVersion: 1 },
            entrypoints: {
                daemon: './dist/daemon.mjs',
                development: './src/dev-daemon.mjs',
            },
            activation: { events: [{ kind: 'startup' }] },
            hostAccess: { required: [], optional: [] },
            contributes: {
                agents: [{
                    id: AGENT_ID,
                    title: 'Runner Agent',
                    runtime: { kind: 'custom' },
                    primary: 'sessions',
                    capabilities: {
                        sessions: {
                            open: ['create'],
                            delivery: ['newTurn'],
                            cancel: true,
                        },
                    },
                }],
            },
        }),
        'utf8',
    );
    await writeFile(
        join(pluginRoot, 'dist', 'daemon.mjs'),
        'throw new Error("production entry must not load for devWatch");\n',
        'utf8',
    );
    await writeFile(
        join(pluginRoot, 'src', 'runner', 'index.mjs'),
        [
            `export const runnerState = globalThis[${JSON.stringify(counterKey)}] ??= {`,
            '  activationCalls: 0,',
            '  factoryCalls: 0,',
            '  sessionOpenCalls: 0,',
            '  sessionDisposeCalls: 0',
            '};',
            'export function runnerFactory() {',
            '  runnerState.factoryCalls += 1;',
            '  return {',
            '    sessions: {',
            '      open() {',
            '        runnerState.sessionOpenCalls += 1;',
            '        return {',
            '          async send() { return { status: "admitted" }; },',
            '          async cancel() {},',
            '          watch() {',
            '            return { dispose() {} };',
            '          },',
            '          async dispose() { runnerState.sessionDisposeCalls += 1; }',
            '        };',
            '      }',
            '    }',
            '  };',
            '}',
            '',
        ].join('\n'),
        'utf8',
    );
    await writeFile(
        join(pluginRoot, 'src', 'dev-daemon.mjs'),
        [
            'import { runnerFactory, runnerState } from "./runner/index.mjs";',
            'export function activate(api) {',
            '  runnerState.activationCalls += 1;',
            `  api.agents.register("${AGENT_ID}", runnerFactory, {`,
            '    sessionRunnerFactory: {',
            `      module: ${JSON.stringify(input.locatorModule)},`,
            `      export: ${JSON.stringify(input.locatorExport)},`,
            '      runtimeApiVersion: 1',
            '    }',
            '  });',
            '}',
            '',
        ].join('\n'),
        'utf8',
    );
    await seedCurrentLocalPathPluginFixture({
        happyHomeDir,
        pluginRoot,
        pluginId: input.pluginId,
        manifestVersion: '1.0.0',
        devWatch: true,
    });
    return Object.freeze({ happyHomeDir, pluginRoot, counterKey });
}

async function removeFixture(fixture: Readonly<{
    happyHomeDir: string;
    pluginRoot: string;
    counterKey: string;
}>): Promise<void> {
    await rm(fixture.happyHomeDir, { recursive: true, force: true });
    await rm(fixture.pluginRoot, { recursive: true, force: true });
    delete (
        globalThis as typeof globalThis &
            Record<string, PublicRunnerFixtureState | undefined>
    )[fixture.counterKey];
}

describe('production registry session runner factory resolution', () => {
    it('keeps strict factory identity for a devWatch .mjs entry and an extensionless directory-index .mjs leaf', async () => {
        const fixture = await createDevelopmentRunnerFixture({
            pluginId: 'acme.runner-resolver.success',
            locatorModule: './runner',
            locatorExport: 'runnerFactory',
        });
        const registry = await resolveExecutablePluginRuntimeRegistry({
            happyHomeDir: fixture.happyHomeDir,
            pluginIds: ['acme.runner-resolver.success'],
        });
        try {
            expect(registry.targetActivationFacts).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    pluginId: 'acme.runner-resolver.success',
                    status: 'active',
                    diagnostics: [],
                }),
            ]));
            const binding = registry.agentRuntimesByAgentId
                .get(AGENT_ID)
                ?.sessionRunnerFactoryBinding;
            if (!binding || 'kind' in binding) {
                throw new Error('Expected an attested plugin factory binding');
            }
            expect(binding).toMatchObject({
                locator: {
                    module: './runner',
                    export: 'runnerFactory',
                    runtimeApiVersion: 1,
                },
                normalizedModulePath: 'src/runner/index.mjs',
                loadMode: 'immutable-js',
            });
        } finally {
            await registry.dispose();
            await removeFixture(fixture);
        }
    });

    it('opens and disposes a public external Session Agent through its attested runner leaf without a daemon runtime lease', async () => {
        const pluginId = 'acme.public-runner-session';
        const fixture = await createDevelopmentRunnerFixture({
            pluginId,
            locatorModule: './runner',
            locatorExport: 'runnerFactory',
        });
        const sessionId = 'session-public-runner';
        const paths = resolvePluginStorePaths({
            happyHomeDir: fixture.happyHomeDir,
        });
        const generationAuthority = await readCurrentCommittedPluginGenerations(
            paths,
            {
                bundledArtifacts: [],
                isolateInvalidInstalledGenerations: false,
            },
        );
        const admitted = generationAuthority?.generations.get(pluginId);
        if (!generationAuthority || !admitted) {
            throw new Error('Expected the installed immutable external generation');
        }
        const manifestPath = join(
            admitted.rootPath,
            ...admitted.record.manifestRelativePath.split('/'),
        );
        const immutableManifest = await readPluginManifest({
            manifestPath,
            manifestAuthority: 'external',
            enforceEngineCompatibility: true,
        });
        if (!immutableManifest.ok) {
            throw new Error(immutableManifest.diagnostics.map(
                (diagnostic) => diagnostic.message,
            ).join('\n'));
        }
        const agentDefinition = immutableManifest.manifest.contributes.agents
            .find((candidate) => candidate.id === AGENT_ID);
        if (!agentDefinition) {
            throw new Error('Expected the public external Agent declaration');
        }
        const sourceSpec = {
            kind: 'path' as const,
            locator: fixture.pluginRoot,
            trustPolicy: 'local_trusted' as const,
            installPolicy: 'link' as const,
            resolvedVersion: '1.0.0',
            devWatch: true,
        };
        const agent = projectManifestAgentContribution({
            definition: agentDefinition,
            provenance: 'external',
            source: { kind: 'path' },
            pluginId,
            sourceSpec,
            hostAccess: immutableManifest.manifest.hostAccess,
            manifestPath,
            daemonEntryPath: join(admitted.rootPath, 'dist', 'daemon.mjs'),
            devDaemonEntryPath: join(
                admitted.rootPath,
                'src',
                'dev-daemon.mjs',
            ),
        });
        const contributes = createResolvedContributionRegistry({
            agents: [agent],
            activationTargets: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId,
                manifestPath,
                daemonEntryPath: join(
                    admitted.rootPath,
                    'dist',
                    'daemon.mjs',
                ),
                devDaemonEntryPath: join(
                    admitted.rootPath,
                    'src',
                    'dev-daemon.mjs',
                ),
                sourceSpec,
                activationEvents: ['startup'],
                manifest: immutableManifest.manifest,
            }],
        });
        const registry = await resolveExecutablePluginRuntimeRegistry({
            happyHomeDir: fixture.happyHomeDir,
            contributes,
            generation: 1,
            generationAuthority,
        });
        try {
            const state = readPublicRunnerFixtureState(fixture.counterKey);
            expect(state).toMatchObject({
                activationCalls: 1,
                factoryCalls: 0,
                sessionOpenCalls: 0,
            });
            const registeredAgent = registry.contributes.agentDefinitionsById
                .get(AGENT_ID);
            if (!registeredAgent) {
                throw new Error('Expected the public external Agent contribution');
            }
            const binding = registry.agentRuntimesByAgentId
                .get(AGENT_ID)
                ?.sessionRunnerFactoryBinding;
            if (!binding || 'kind' in binding) {
                throw new Error('Expected an attested plugin factory binding');
            }
            const activationTarget = contributes.activationTargets.find(
                (target) => target.pluginId === pluginId,
            );
            expect(activationTarget).toMatchObject({
                pluginId,
                source: { kind: 'path' },
                manifest: {
                    id: pluginId,
                    version: '1.0.0',
                },
            });
            expect(activationTarget?.manifest.contributes.agents.some(
                (candidate) => candidate.id === AGENT_ID,
            )).toBe(true);
            expect(registeredAgent).toMatchObject({
                pluginId,
                identity: {
                    pluginId,
                    localId: AGENT_ID,
                },
                definition: {
                    kindVersion: 1,
                    id: AGENT_ID,
                    ownedBackendIds: [],
                },
            });
            expect(registry.targetActivationFacts).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    pluginId,
                    generation: '1',
                    status: 'active',
                }),
            ]));
            expect(binding).toMatchObject({
                pluginId,
                pluginVersion: immutableManifest.manifest.version,
                localAgentId: AGENT_ID,
                immutableGenerationId: admitted.immutableGenerationId,
            });
            expect(binding).not.toHaveProperty('manifestDigest');
            let retainedLeafPromise:
                ReturnType<typeof loadRetainedAgentRuntimeLeaf> | null = null;
            const runnerCreateRuntime = vi.fn(async ({ signal }: Readonly<{
                signal: AbortSignal;
            }>) => {
                retainedLeafPromise ??= loadRetainedAgentRuntimeLeaf({
                    paths,
                    binding,
                });
                const leaf = await retainedLeafPromise;
                return await leaf.factory({
                    plugin: { id: pluginId, version: '1.0.0' },
                    agent: { id: AGENT_ID },
                    signal,
                });
            });
            const engineRegistry = await resolveCliEngineRegistry({
                contributes: registry.contributes,
                runtimeRegistry: registry,
                requireRunnerAgentSessionRuntimeSource: true,
                runnerAgentSessionRuntimeSource: {
                    agentContribution: registeredAgent,
                    identity: {
                        pluginId,
                        pluginVersion: '1.0.0',
                        agentId: AGENT_ID,
                        backendId: AGENT_ID,
                        generation: binding.immutableGenerationId,
                        immutableGenerationId:
                            binding.immutableGenerationId,
                        isCurrent: () => true,
                    },
                    createRuntime: runnerCreateRuntime,
                    createInvocationServices: () => ({}) as never,
                    authorizeNewTurn: async () => ({
                        status: 'admitted' as const,
                    }),
                },
            });

            const resolution = await engineRegistry.resolveForBackendId(AGENT_ID);
            expect(resolution?.agent).toBe(registeredAgent);
            expect(runnerCreateRuntime).not.toHaveBeenCalled();
            expect(state.factoryCalls).toBe(0);

            const plan = await resolution?.engineAdapter.runtimeCore
                .createSessionRuntime({
                    credentials: {
                        token: 'test-token',
                        encryption: {
                            type: 'legacy',
                            secret: new Uint8Array(32).fill(1),
                        },
                    },
                    directory: '/tmp/public-external-runner',
                    backendTarget: {
                        kind: 'backend',
                        backendId: AGENT_ID,
                    },
                } as never) as Readonly<{
                    config: Readonly<{
                        createSessionRuntime(input: unknown): Promise<unknown>;
                    }>;
                }> | undefined;
            if (!plan?.config.createSessionRuntime) {
                throw new Error('Expected a runner-owned Session runtime plan');
            }
            expect(state.factoryCalls).toBe(0);

            const created = await plan.config.createSessionRuntime({
                directory: '/tmp/public-external-runner',
                metadata: {},
                machineId: 'machine-public-runner',
                agentTargetKey: `plugin:${pluginId}:${AGENT_ID}`,
                session: createRuntimePlacementSessionClient(sessionId),
                transcriptSession: {},
                messageBuffer: {},
                mcpServers: {},
                permissionHandler: {},
                getPermissionMode: () => 'default',
                setThinking: () => {},
                memoryRecallGuidanceEnabled: false,
                runnerProcessIdentity: null,
                startupModelSelection: null,
            } as never) as Readonly<{
                operations: Readonly<{
                    resetOrDisposeRuntime(): Promise<void>;
                }>;
            }>;

            expect(runnerCreateRuntime).toHaveBeenCalledOnce();
            expect(state).toMatchObject({
                activationCalls: 1,
                factoryCalls: 1,
                sessionOpenCalls: 1,
                sessionDisposeCalls: 0,
            });

            await created.operations.resetOrDisposeRuntime();
            expect(state.sessionDisposeCalls).toBe(1);
        } finally {
            await registry.dispose();
            await removeFixture(fixture);
        }
    });

    it('rejects a locator export that is not the registered factory', async () => {
        const fixture = await createDevelopmentRunnerFixture({
            pluginId: 'acme.runner-resolver.wrong-export',
            locatorModule: './runner/index.mjs',
            locatorExport: 'missingFactory',
        });
        const registry = await resolveExecutablePluginRuntimeRegistry({
            happyHomeDir: fixture.happyHomeDir,
            pluginIds: ['acme.runner-resolver.wrong-export'],
        });
        try {
            expect(registry.targetActivationFacts).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    pluginId: 'acme.runner-resolver.wrong-export',
                    status: 'unavailable',
                    diagnostics: [expect.objectContaining({
                        code: 'plugin_activation_failed',
                        message: expect.stringMatching(/does not match the factory registered/iu),
                    })],
                }),
            ]));
            expect(registry.agentRuntimesByAgentId.has(AGENT_ID)).toBe(false);
        } finally {
            await registry.dispose();
            await removeFixture(fixture);
        }
    });

    it('rejects the activation entry as its own runner leaf', async () => {
        const fixture = await createDevelopmentRunnerFixture({
            pluginId: 'acme.runner-resolver.entry-leaf',
            locatorModule: './dev-daemon.mjs',
            locatorExport: 'activate',
        });
        const registry = await resolveExecutablePluginRuntimeRegistry({
            happyHomeDir: fixture.happyHomeDir,
            pluginIds: ['acme.runner-resolver.entry-leaf'],
        });
        try {
            expect(registry.targetActivationFacts).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    pluginId: 'acme.runner-resolver.entry-leaf',
                    status: 'unavailable',
                    diagnostics: [expect.objectContaining({
                        code: 'plugin_activation_failed',
                        message: expect.stringMatching(/leaf distinct from the plugin activation entry/iu),
                    })],
                }),
            ]));
            expect(registry.agentRuntimesByAgentId.has(AGENT_ID)).toBe(false);
        } finally {
            await registry.dispose();
            await removeFixture(fixture);
        }
    });
});
