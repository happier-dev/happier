import {
    chmod,
    copyFile,
    mkdir,
    mkdtemp,
    readFile,
    realpath,
    rm,
    stat,
    symlink,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import type {
    ConnectedAccountMaterialization as PluginConnectedAccountMaterialization,
} from '@happier-dev/plugin-sdk/connected-accounts';

import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import type {
    StablePluginConnectedAccountsOwner,
} from './invocation/services/connectedAccounts';
import { resolvePluginStorePaths } from '../store/paths';
import { loadInstalledPlugins } from '../discovery/load/installed';
import { projectLoadedPluginContributes } from '../projection/registry/resolvePluginContributions';
import { seedCurrentLocalPathPluginFixture } from '../store/registry/currentState.testkit';
import { readCurrentCommittedPluginGenerations } from '../store/registry/generationStore';
import {
    createNativeAgentCurrentSessionUiServices,
} from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionInteractions';

import {
    resolveExecutablePluginRuntimeRegistry,
} from './resolveExecutablePluginRuntimeRegistry';
import {
    resolveCurrentInstalledPluginGenerationRuntimeExecutable,
} from './installedGenerationRuntimeExecutable';
import { createPluginReloadController } from './reload/controller';
import {
    authorizeResolvedProjectExecLaunchForHost,
    createProjectNativeEnvironmentIoForHost,
} from './invocation/services/exec';
import type { ProjectManagedServiceSupervisionInput } from './invocation/services/managedServicesOwner';

async function loadInstalledManagedServiceFixture(input: Readonly<{
    happyHomeDir: string;
    pluginId: string;
    manifest: Readonly<Record<string, unknown>>;
}>) {
    // The on-disk external plugin is the boundary. Loading, trust, current
    // generation, activation and invocation ownership stay real.
    const pluginRoot = join(input.happyHomeDir, 'plugin');
    await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
    await writeFile(join(pluginRoot, '.happier-plugin', 'plugin.json'), JSON.stringify(input.manifest));
    await writeFile(join(pluginRoot, 'daemon.mjs'), 'export function activate() {}');
    await seedCurrentLocalPathPluginFixture({
        happyHomeDir: input.happyHomeDir,
        pluginRoot,
        pluginId: input.pluginId,
        manifestVersion: '1.0.0',
    });
    const loaded = await loadInstalledPlugins({ happyHomeDir: input.happyHomeDir });
    expect(loaded.diagnosticsByPluginId[input.pluginId] ?? []).toEqual([]);
    const contributes = createResolvedContributionRegistry(projectLoadedPluginContributes({
        loadResult: loaded,
        provenance: 'external',
        existingAgentIds: new Set(),
    }));
    const generationAuthority = await readCurrentCommittedPluginGenerations(
        resolvePluginStorePaths({ happyHomeDir: input.happyHomeDir }), {},
    );
    if (!generationAuthority) throw new Error('Expected current installed fixture generation');
    return { contributes, generationAuthority };
}

describe('resolveExecutablePluginRuntimeRegistry managed-services production owner', () => {
    it('keeps Project instance control and access-loss cleanup at the same owner after registry replacement', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-project-service-reload-'));
        const first = await resolveExecutablePluginRuntimeRegistry({
            happyHomeDir, contributes: createResolvedContributionRegistry({}), generation: 1,
        });
        const controller = createPluginReloadController({ resolveRuntimeRegistry: async () => first });
        const firstLease = await controller.acquireRuntimeRegistry();
        let stoppable = false;
        const input: ProjectManagedServiceSupervisionInput = {
            workspace: { id: 'workspace-a', serverId: 'home', machineId: 'machine-a', rootPath: happyHomeDir, createdAtMs: 1 },
            declaration: { workspaceRefId: 'workspace-a', selection: { kind: 'manifest', name: 'worker' } },
            requester: { serverId: 'home', accountId: 'bob', machineId: 'machine-a', installationId: 'installation-a' },
            cwd: happyHomeDir, serviceId: 'project:workspace-a:manifest:worker', specIdentity: 'reviewed-native-effect',
            isCurrent: () => true,
            processSpec: {
                mode: {
                    kind: 'native',
                    instance: { adapter: { pluginId: 'acme.native', localId: 'compose' }, nativeResourceId: 'exact-native-project' },
                    // Only the external native resource is replaced; controller,
                    // registry, custody, admission and OS dispatch remain real.
                    lifecycle: {
                        inspect: async () => ({ phase: 'running', readiness: 'not_reported', endpoint: null }),
                        stop: async () => ({ status: stoppable ? 'stopped' : 'unsupported' }),
                    },
                },
                startupTimeoutMs: 1_000,
            },
            authorizeLaunch: ({ signal }) => authorizeResolvedProjectExecLaunchForHost({
                signal, assertCurrent() {},
                projectLaunch: {
                    status: 'ready', reviewedEffectDigest: 'reviewed-native-effect',
                    environment: { selection: { kind: 'host' }, root: happyHomeDir, platform: process.platform,
                        io: createProjectNativeEnvironmentIoForHost({ resolveTool: async () => null }) },
                },
                launch: { command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], cwd: happyHomeDir, env: {}, release() {} },
            }),
        };
        const service = await firstLease.registry.projectManagedServices.superviseProject(input);
        let second: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>> | null = null;
        try {
            second = await resolveExecutablePluginRuntimeRegistry({
                happyHomeDir, contributes: createResolvedContributionRegistry({}), generation: 2,
            });
            await controller.adoptPreparedRuntimeRegistry({
                registry: second, changedPluginIds: [], runningSessionDisposition: 'retainRunningSessions',
            });
            await firstLease.release();
            await first.dispose();
            const currentLease = controller.tryAcquireRuntimeRegistry();
            if (!currentLease) throw new Error('Expected current published registry');
            try {
                expect(currentLease.registry.projectManagedServices.listProjectServices()).toEqual([service]);
                expect(currentLease.registry.projectManagedServices.resolveProjectService({
                    kind: 'managed_service', managedServiceId: service.instanceId,
                    machineId: input.workspace.machineId, cwd: input.cwd, declaration: input.declaration,
                })).toEqual({ status: 'found', handle: service });
                expect(await currentLease.registry.projectManagedServices.superviseProject(input)).toBe(service);
                const result = await currentLease.registry.projectManagedServices.stopForAccessLoss(input.requester);
                expect(['unsupported', 'termination_incomplete']).toContain(result[0]?.status);
                expect(service.retirementSignal.aborted).toBe(true);
                expect(service.snapshot().state).toBe('running');
                expect(currentLease.registry.projectManagedServices.listProjectServices()).toEqual([service]);
                stoppable = true;
                expect(await currentLease.registry.projectManagedServices.stopForAccessLoss(input.requester))
                    .toMatchObject([{ status: 'stopped', instanceId: service.instanceId }]);
                const next = await currentLease.registry.projectManagedServices.superviseProject(input);
                await currentLease.release();
                await controller.shutdown();
                expect(next.snapshot().state).toBe('stopped');
            } finally {
                await currentLease.release();
            }
        } finally {
            stoppable = true;
            await firstLease.release();
            await service.stop();
            await controller.shutdown();
            await first.dispose();
            await second?.dispose();
            await rm(happyHomeDir, { recursive: true, force: true });
        }
    });

    it('supervises an exact native instance through its admitted adapter after its starter exits', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-native-service-home-'));
        const pluginRoot = join(happyHomeDir, 'plugin');
        const toolRoot = join(happyHomeDir, 'tools');
        const pluginId = 'acme.native-service';
        const agentId = 'native-agent';
        const toolId = 'native-launcher';
        const toolName = process.platform === 'win32' ? 'native-launcher.exe' : 'native-launcher';
        const starterReceipt = join(happyHomeDir, 'starter-exited');
        const stopReceipt = join(happyHomeDir, 'native-stopped.json');
        const previousPath = process.env.PATH;
        let runtime: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>> | null = null;
        try {
            await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
            await mkdir(toolRoot);
            if (process.platform === 'win32') {
                await copyFile(process.execPath, join(toolRoot, toolName));
            } else {
                await symlink(process.execPath, join(toolRoot, toolName));
            }
            process.env.PATH = `${toolRoot}${delimiter}${previousPath ?? ''}`;
            await writeFile(join(pluginRoot, '.happier-plugin', 'plugin.json'), JSON.stringify({
                schemaVersion: 2,
                id: pluginId,
                version: '1.0.0',
                displayName: 'Native service fixture',
                engines: { happier: '^0.2.0' },
                runtime: { apiVersion: 1 },
                entrypoints: { daemon: './daemon.mjs' },
                hostAccess: {
                    required: [{ id: 'launch', capability: 'process', reason: 'Launch the native fixture', scope: { executables: [{ kind: 'systemTool', id: toolId }], envKeys: ['PATH'] } }],
                    optional: [],
                },
                contributes: {
                    agents: [{
                        id: agentId,
                        title: 'Native fixture Agent',
                        runtime: { kind: 'acp', transport: { kind: 'stdio', executable: { kind: 'systemTool', id: toolId } } },
                        primary: 'sessions',
                        capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
                    }],
                    systemTools: [{ id: toolId, title: 'Native fixture launcher', executableNames: [toolName] }],
                    projectNativeAdapters: [{ id: 'compose', files: ['compose.yaml'], roles: ['nativeServiceLifecycle'] }],
                },
            }));
            // This external plugin is the native-system boundary; activation,
            // admission, Exec, and managed-service ownership remain real.
            await writeFile(join(pluginRoot, 'daemon.mjs'), [
                "import { writeFile } from 'node:fs/promises';",
                'export function activate(api) {',
                "  api.projectNativeAdapters.register('compose', { nativeServiceLifecycle: {",
                "    async inspect() { return { phase: 'running', readiness: 'not_reported', endpoint: null }; },",
                `    async stop(instance) { await writeFile(${JSON.stringify(stopReceipt)}, JSON.stringify(instance)); return { status: 'stopped' }; },`,
                '  } });',
                '}',
            ].join('\n'));
            await seedCurrentLocalPathPluginFixture({ happyHomeDir, pluginRoot, pluginId, manifestVersion: '1.0.0' });
            const loaded = await loadInstalledPlugins({ happyHomeDir });
            expect(loaded.diagnosticsByPluginId[pluginId] ?? []).toEqual([]);
            const contributes = createResolvedContributionRegistry(projectLoadedPluginContributes({
                loadResult: loaded,
                provenance: 'external',
                existingAgentIds: new Set(),
            }));
            const declaredAgent = contributes.agents.find(candidate => candidate.pluginId === pluginId);
            if (!declaredAgent) throw new Error('Expected declared native fixture Agent');
            const generationAuthority = await readCurrentCommittedPluginGenerations(resolvePluginStorePaths({ happyHomeDir }), {});
            if (!generationAuthority) throw new Error('Expected current native fixture generation');
            runtime = await resolveExecutablePluginRuntimeRegistry({ happyHomeDir, contributes, generation: 52, generationAuthority });
            const occurrenceId = runtime.contributes.occurrenceIdsByPluginId?.[pluginId];
            if (!occurrenceId) throw new Error('Expected admitted native fixture occurrence');
            const services = await runtime.createAgentInvocationServices({
                pluginId,
                pluginVersion: '1.0.0',
                agentId: declaredAgent.id,
                occurrenceId,
                correlationId: 'native-service',
                cwd: happyHomeDir,
                signal: new AbortController().signal,
                isOccurrenceCurrent: () => true,
            });
            const instance = { adapter: { pluginId, localId: 'compose' }, nativeResourceId: 'exact-native-project' };
            const handle = await services.managedServices.supervise({
                id: 'native-project',
                mode: {
                    kind: 'native',
                    instance,
                    launch: {
                        executable: { kind: 'systemTool', id: toolId },
                        args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(starterReceipt)}, 'exited')`],
                    },
                },
            });
            await vi.waitFor(async () => expect(await readFile(starterReceipt, 'utf8')).toBe('exited'));
            expect(handle.snapshot()).toMatchObject({ mode: 'native', state: 'running', nativePhase: 'running', baseUrl: null });
            // Retirement removes admission for new work, not custody of this
            // exact native resource. The captured stop must still settle it.
            await runtime.dispose();
            runtime = null;
            await expect(handle.stop()).resolves.toEqual({ status: 'stopped' });
            expect(handle.snapshot().state).toBe('stopped');
            expect(JSON.parse(await readFile(stopReceipt, 'utf8'))).toEqual(instance);
        } finally {
            await runtime?.dispose();
            if (previousPath === undefined) delete process.env.PATH;
            else process.env.PATH = previousPath;
            await rm(happyHomeDir, { recursive: true, force: true });
        }
    });

    it('resolves only the current declared binary in the installed generation root', async () => {
        const root = await mkdtemp(join(
            tmpdir(),
            'happier-installed-generation-runtime-',
        ));
        const generationRoot = join(root, 'provider-p');
        const binaryName = process.platform === 'win32'
            ? 'provider-runtime.exe'
            : 'provider-runtime';
        const relativePath = ['tools', 'unpacked', binaryName].join('/');
        const binaryPath = join(
            generationRoot,
            ...relativePath.split('/'),
        );
        const binaryBytes = '#!/bin/sh\nexit 0\n';
        let current = true;
        try {
            await mkdir(join(generationRoot, 'tools', 'unpacked'), {
                recursive: true,
            });
            await writeFile(binaryPath, binaryBytes, 'utf8');
            if (process.platform !== 'win32') {
                await chmod(binaryPath, 0o755);
            }

            const input = {
                executable: {
                    kind: 'packaged-runtime-binary' as const,
                    directorySegments: ['tools', 'unpacked'] as const,
                    executableBaseName: 'provider-runtime',
                },
                rootPath: generationRoot,
                files: [{
                    relativePath,
                    byteLength: Buffer.byteLength(binaryBytes),
                }],
                isCurrent: async () => current,
            };

            await expect(
                resolveCurrentInstalledPluginGenerationRuntimeExecutable(input),
            ).resolves.toBe(await realpath(binaryPath));

            current = false;
            await expect(
                resolveCurrentInstalledPluginGenerationRuntimeExecutable(input),
            ).resolves.toBeNull();
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('materializes private Connected Account files for daemon custody and removes them with the registry lifecycle', async () => {
        const happyHomeDir = await mkdtemp(
            join(tmpdir(), 'happier-daemon-managed-service-files-home-'),
        );
        const toolRoot = join(happyHomeDir, 'fixture-tools');
        await mkdir(toolRoot, { recursive: true });
        const pluginId = 'acme.daemon-managed-service-files';
        const agentId = 'credential-file-agent';
        const systemToolId = 'credential-file-runtime';
        const toolName = process.platform === 'win32'
            ? 'credential-file-runtime.exe'
            : 'credential-file-runtime';
        const toolPath = join(toolRoot, toolName);
        if (process.platform === 'win32') {
            await copyFile(process.execPath, toolPath);
        } else {
            await symlink(process.execPath, toolPath);
        }
        const credentialBytes = new Uint8Array([
            0x00, 0xff, 0x41, 0x0a, 0x7b, 0x7d,
        ]);
        const receiptPath = join(happyHomeDir, 'child-receipt.json');
        const previousPath = process.env.PATH;
        process.env.PATH = `${toolRoot}${delimiter}${previousPath ?? ''}`;
        const materialize = vi.fn<
            StablePluginConnectedAccountsOwner['materialize']
        >(async (input): Promise<PluginConnectedAccountMaterialization> => {
            expect(input.request).toEqual({
                kind: 'files',
                fileIds: ['upstream-credential'],
            });
            return Object.freeze({
                kind: 'files' as const,
                files: Object.freeze({
                    'upstream-credential': credentialBytes,
                }),
            });
        });
        const connectedAccounts = Object.freeze({
            getBinding: vi.fn(async () => null),
            requestSelection: vi.fn(async () => {
                throw new Error('Unexpected Connected Account selection');
            }),
            materialize,
            listAccounts: async () => {
                throw new Error('Connected Account listing is outside this fixture');
            },
            materializeListedAccount: async () => {
                throw new Error('Exact-listed Connected Account materialization is outside this fixture');
            },
            watch: vi.fn(() => Object.freeze({ dispose() {} })),
        }) satisfies StablePluginConnectedAccountsOwner;
        const fixture = await loadInstalledManagedServiceFixture({
            happyHomeDir,
            pluginId,
            manifest: {
                schemaVersion: 2, id: pluginId, version: '1.0.0', displayName: 'Credential-file fixture',
                engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 }, entrypoints: { daemon: './daemon.mjs' },
                hostAccess: {
                    required: [{
                        id: 'managed-process', capability: 'process', reason: 'Run the credential-file fixture',
                        scope: { executables: [{ kind: 'systemTool', id: systemToolId }], envKeys: ['PATH', 'UPSTREAM_CREDENTIAL_PATH'] },
                    }],
                    optional: [],
                },
                contributes: {
                    agents: [{
                        id: agentId, title: 'Credential-file Agent',
                        runtime: { kind: 'acp', transport: { kind: 'stdio', executable: { kind: 'systemTool', id: systemToolId } } },
                        primary: 'sessions', capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
                        connectedAccounts: [{ purpose: 'provider.inference', service: 'upstream-account', required: true, materializationKinds: ['files'] }],
                    }],
                    systemTools: [{ id: systemToolId, title: 'Credential-file runtime', executableNames: [toolName] }],
                    connectedAccountDescriptors: [{
                        id: 'upstream-account',
                        title: 'Fixture upstream account',
                        authentication: {
                            defaultModeId: 'device',
                            modes: [{ id: 'device', kind: 'oauthDeviceCode', outcomeReconciliation: 'none' }],
                        },
                    }],
                },
            },
        });
        const runtime = await resolveExecutablePluginRuntimeRegistry({
            happyHomeDir,
            connectedAccounts,
            contributes: fixture.contributes,
            generation: 29,
            generationAuthority: fixture.generationAuthority,
        });
        try {
            const occurrenceId = runtime.readPluginOccurrenceId(pluginId);
            const declaredAgent = runtime.contributes.agents.find(candidate => candidate.pluginId === pluginId);
            if (!occurrenceId || !declaredAgent) throw new Error('Expected admitted credential-file Agent');
            const services = await runtime.createAgentInvocationServices({
                pluginId,
                pluginVersion: '1.0.0',
                agentId: declaredAgent.id,
                occurrenceId,
                correlationId: 'daemon-managed-service-files',
                cwd: happyHomeDir,
                signal: new AbortController().signal,
                isOccurrenceCurrent: () => true,
                session: {
                    id: 'daemon-managed-service-session',
                    current: createNativeAgentCurrentSessionUiServices({
                        permissionHandler: null,
                        pluginId,
                        contributionId: agentId,
                        runtimeId: agentId,
                        sessionId: 'daemon-managed-service-session',
                        occurrenceId,
                        isCurrent: () => true,
                    }),
                },
            });
            const handle = await services.managedServices.supervise({
                id: 'credential-file-fixture',
                credentialBindings: [{
                    purpose: 'provider.inference',
                    request: {
                        kind: 'files',
                        fileIds: ['upstream-credential'],
                    },
                    injection: {
                        kind: 'files',
                        pathsByFileId: {
                            'upstream-credential': {
                                environmentKey:
                                    'UPSTREAM_CREDENTIAL_PATH',
                            },
                        },
                    },
                }],
                mode: {
                    kind: 'spawn',
                    launch: {
                        executable: {
                            kind: 'systemTool',
                            id: systemToolId,
                        },
                        args: [
                            '-e',
                            [
                                "const fs = require('node:fs');",
                                'const credentialPath = process.env.UPSTREAM_CREDENTIAL_PATH;',
                                'const contents = fs.readFileSync(credentialPath);',
                                'fs.writeFileSync(process.argv[1], JSON.stringify({',
                                '  credentialPath,',
                                "  base64: contents.toString('base64'),",
                                '  mode: fs.statSync(credentialPath).mode & 0o777,',
                                '}));',
                                'setInterval(() => {}, 1_000);',
                            ].join('\n'),
                            receiptPath,
                        ],
                    },
                    endpoint: {
                        kind: 'assignAndInject',
                        port: { kind: 'allocated' },
                    },
                },
                healthCheck: { kind: 'none' },
            });
            await expect(handle.waitUntilHealthy()).resolves.toMatchObject({
                id: 'credential-file-fixture',
                state: 'healthy',
                mode: 'spawn',
            });
            type ChildReceipt = Readonly<{
                credentialPath: string;
                base64: string;
                mode: number;
            }>;
            const receipt = await vi.waitFor(async (): Promise<ChildReceipt> => {
                const parsed = JSON.parse(
                    await readFile(receiptPath, 'utf8'),
                ) as ChildReceipt;
                expect(parsed.base64).toBe(
                    Buffer.from(credentialBytes).toString('base64'),
                );
                return parsed;
            });
            const credentialPath = receipt.credentialPath;
            const credentialRoot = join(
                resolvePluginStorePaths({ happyHomeDir }).secretsDir,
                'managed-services',
            );
            const confined = relative(
                resolve(credentialRoot),
                resolve(credentialPath),
            );
            expect(
                confined === '..'
                || confined.startsWith(`..${sep}`)
                || isAbsolute(confined),
            ).toBe(false);
            await expect(readFile(credentialPath)).resolves.toEqual(
                Buffer.from(credentialBytes),
            );
            if (process.platform !== 'win32') {
                expect(receipt.mode).toBe(0o600);
            }

            await runtime.dispose();
            await expect(stat(credentialPath)).rejects.toMatchObject({
                code: 'ENOENT',
            });
            expect(handle.snapshot().state).toBe('stopped');
            expect(materialize).toHaveBeenCalledTimes(1);
        } finally {
            await runtime.dispose();
            if (previousPath === undefined) delete process.env.PATH;
            else process.env.PATH = previousPath;
            await rm(happyHomeDir, { recursive: true, force: true });
        }
    });

    it('supervises and retires a daemon-scoped service through the sole invocation assembly', async () => {
        const happyHomeDir = await mkdtemp(
            join(tmpdir(), 'happier-daemon-managed-services-home-'),
        );
        const pluginId = 'acme.daemon-managed-services';
        const agentId = 'bounded-agent';
        const fixture = await loadInstalledManagedServiceFixture({
            happyHomeDir,
            pluginId,
            manifest: {
                schemaVersion: 2, id: pluginId, version: '1.0.0', displayName: 'Bounded service fixture',
                engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 }, entrypoints: { daemon: './daemon.mjs' },
                hostAccess: { required: [], optional: [] },
                contributes: {
                    agents: [{
                        id: agentId, title: 'Bounded managed-services Agent',
                        runtime: { kind: 'acp', transport: { kind: 'stdio', executable: { kind: 'systemTool', id: 'unused-fixture-tool' } } },
                        primary: 'sessions', capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
                    }],
                    systemTools: [{ id: 'unused-fixture-tool', title: 'Unused Agent launcher', executableNames: ['unused-fixture-tool'] }],
                },
            },
        });
        const runtime = await resolveExecutablePluginRuntimeRegistry({
            happyHomeDir,
            contributes: fixture.contributes,
            generation: 23,
            generationAuthority: fixture.generationAuthority,
        });
        let handle: Awaited<ReturnType<
            Awaited<ReturnType<typeof runtime.createAgentInvocationServices>>[
                'managedServices'
            ]['supervise']
        >> | null = null;

        try {
            const occurrenceId = runtime.readPluginOccurrenceId(pluginId);
            const declaredAgent = runtime.contributes.agents.find(candidate => candidate.pluginId === pluginId);
            if (!occurrenceId || !declaredAgent) throw new Error('Expected admitted bounded Agent');
            const services = await runtime.createAgentInvocationServices({
                pluginId,
                pluginVersion: '1.0.0',
                agentId: declaredAgent.id,
                occurrenceId,
                correlationId: 'daemon-managed-services-production',
                cwd: happyHomeDir,
                signal: new AbortController().signal,
                isOccurrenceCurrent: () => true,
            });

            expect(services.availability('managedServices')).toEqual({
                status: 'available',
            });
            handle = await services.managedServices.supervise({
                id: 'fixture-endpoint',
                mode: {
                    kind: 'attach',
                    baseUrl: 'http://127.0.0.1:4312',
                },
                healthCheck: { kind: 'none' },
            });
            await expect(handle.waitUntilHealthy()).resolves.toMatchObject({
                id: 'fixture-endpoint',
                state: 'healthy',
                mode: 'attach',
                baseUrl: 'http://127.0.0.1:4312',
            });

            await runtime.dispose();
            expect(handle.snapshot().state).toBe('stopped');
        } finally {
            await runtime.dispose();
            await rm(happyHomeDir, { recursive: true, force: true });
        }
    });
});
