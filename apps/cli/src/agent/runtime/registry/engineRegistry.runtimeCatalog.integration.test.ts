import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import * as childProcess from 'node:child_process';
import { createServer } from 'node:http';
import { constants as fsConstants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PluginReloadController } from '../../../plugins/runtime/reload/controller';
import type { DaemonPluginDevelopmentRootsOwner } from '../../../plugins/daemon/developmentRoots';
import { seedCurrentLocalPathPluginFixture } from '../../../plugins/store/registry/currentState.testkit';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createAccountEncryptionCurrentnessFixture, createMutableApiSessionClientFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { writeExecutableShimSync } from '@/testkit/fs/executableShim';
import { createAgentRuntimeSwitchState } from '@/agent/runtime/mode/switching/createSwitchState';
import type { AgentState, Metadata } from '@/api/types';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { accountSettingsParse, SessionMetadataTuplePatchV1Schema } from '@happier-dev/protocol';
import '../../../plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import '../../../plugins/daemon/developmentRoots';
import '../bridges/session/SessionHostBridge';
import '@/cli/commands/attach';
import '@/cli/commands/resume';

// Warm cold transformation during collection; cases still reload owners after selecting their home.

const { socketIoFactory, spawnBoundary } = vi.hoisted(() => ({ socketIoFactory: vi.fn(), spawnBoundary: vi.fn() }));
// Socket.IO is the genuine relay transport boundary; catalog, command and metadata writers stay real.
vi.mock('socket.io-client', () => ({ io: socketIoFactory }));
vi.mock('node:child_process', async (importOriginal) => ({
    ...await importOriginal<typeof import('node:child_process')>(),
    spawn: spawnBoundary,
}));

let activePluginReloadController: PluginReloadController | null = null;
let activeDevelopmentRootsOwner: DaemonPluginDevelopmentRootsOwner | null = null;

async function publishCurrentRuntimeRegistry(params: Readonly<{
    happyHomeDir: string;
    generation: number;
    changedPluginIds: readonly string[];
}>) {
    const [
        { pluginReloadController },
        { resolveExecutablePluginRuntimeRegistry },
        { createDaemonPluginDevelopmentRootsOwner },
    ] = await Promise.all([
        import('../../../plugins/runtime/reload/singleton'),
        import('../../../plugins/runtime/resolveExecutablePluginRuntimeRegistry'),
        import('../../../plugins/daemon/developmentRoots'),
    ]);
    const developmentRootsOwner = createDaemonPluginDevelopmentRootsOwner({
        happyHomeDir: params.happyHomeDir,
        submitObservation: async () => {
            throw new Error('Unexpected source observation during fresh registry admission');
        },
    });
    activeDevelopmentRootsOwner = developmentRootsOwner;
    const registry = await resolveExecutablePluginRuntimeRegistry({
        happyHomeDir: params.happyHomeDir,
        generation: params.generation,
        resolveDevelopmentSourceAuthority: developmentRootsOwner.resolveDevelopmentSourceAuthority,
    });
    const adoption = await pluginReloadController.adoptPreparedRuntimeRegistry({
        registry,
        changedPluginIds: params.changedPluginIds,
        durableRevision: params.generation,
        runningSessionDisposition: 'retainRunningSessions',
    });
    if (!adoption.ok) {
        throw new Error(`Failed to publish plugin runtime registry generation ${params.generation}`);
    }
    activePluginReloadController = pluginReloadController;
    return registry;
}

async function writePlugin(params: Readonly<{
    rootDir: string;
    sentinelPath: string;
}>): Promise<void> {
    const manifestDir = join(params.rootDir, '.happier-plugin');
    await mkdir(manifestDir, { recursive: true });

    await writeFile(
        join(params.rootDir, 'agentRuntime.mjs'),
        [
            'export const acmeRuntimeFactory = async () => ({',
            '  sessions: {',
            '    open: async () => ({',
            '      send: async () => ({ status: "admitted" }),',
            '      stop: async () => ({ status: "requested" }),',
            '      watch: () => ({ dispose() {} }),',
            '      dispose: async () => {},',
            '    }),',
            '  },',
            '});',
            '',
        ].join('\n'),
        'utf8',
    );

    await writeFile(
        join(params.rootDir, 'daemon.mjs'),
        [
            "import { appendFileSync } from 'node:fs';",
            "import { acmeRuntimeFactory } from './agentRuntime.mjs';",
            `appendFileSync(${JSON.stringify(params.sentinelPath)}, 'loaded');`,
            'export async function activate(api) {',
            '  api.agents.register("acme-runtime", acmeRuntimeFactory, {',
            '    sessionRunnerFactory: {',
            '      module: "./agentRuntime.mjs",',
            '      export: "acmeRuntimeFactory",',
            '      runtimeApiVersion: 1,',
            '    },',
            '  });',
            '}',
            '',
        ].join('\n'),
        'utf8',
    );

    await writeFile(
        join(manifestDir, 'plugin.json'),
        JSON.stringify(
            {
                schemaVersion: 2,
                id: 'acme.runtime',
                version: '1.0.0',
                displayName: 'Acme Runtime',
                description: 'Runtime hook plugin',
                engines: {
                    happier: '^0.3.0',
                },
                runtime: {
                    apiVersion: 1,
                },
                entrypoints: {
                    daemon: './daemon.mjs',
                },
                hostAccess: {
                    required: [],
                    optional: [],
                },
                contributes: {
                    agents: [
                        {
                            id: 'acme-runtime',
                            title: 'Acme Runtime',
                            runtime: {
                                kind: 'custom',
                            },
                            primary: 'sessions',
                            capabilities: {
                                sessions: {
                                    open: ['create', 'resume'],
                                    delivery: ['newTurn', 'steer', 'followUp'],
                                    cancel: true,
                                },
                            },
                        },
                    ],
                },
            },
            null,
            2,
        ),
        'utf8',
    );
}

async function writeManifestOnlyAcpPlugin(rootDir: string): Promise<void> {
    const manifestDir = join(rootDir, '.happier-plugin');
    await mkdir(manifestDir, { recursive: true });
    await writeFile(
        join(manifestDir, 'plugin.json'),
        JSON.stringify({
            schemaVersion: 2,
            id: 'acme.runtime',
            version: '1.0.0',
            displayName: 'Acme ACP Runtime',
            engines: { happier: '^0.3.0' }, runtime: { apiVersion: 1 },
            hostAccess: {
                required: [{
                    id: 'agent-process',
                    capability: 'process',
                    reason: 'Launch the declared ACP agent.',
                    scope: { executables: [{ kind: 'systemTool', id: 'acme-agent' }] },
                }],
                optional: [],
            },
            contributes: {
                agents: [{
                    id: 'acme-acp',
                    title: 'Acme ACP',
                    runtime: {
                        kind: 'acp',
                        transport: {
                            kind: 'stdio',
                            executable: { kind: 'systemTool', id: 'acme-agent' },
                        },
                    },
                    primary: 'sessions',
                    capabilities: {
                        sessions: {
                            open: ['create', 'resume'],
                            delivery: ['newTurn'],
                            cancel: true,
                        },
                    },
                }],
                systemTools: [{
                    id: 'acme-agent',
                    title: 'Acme Agent',
                    executableNames: ['acme-agent'],
                }],
            },
        }, null, 2),
        'utf8',
    );
}

describe('resolveCliEngineRegistry', () => {
    const originalHappyHomeDir = process.env.HAPPIER_HOME_DIR;

    beforeEach(() => {
        vi.resetModules();
    });

    afterEach(async () => {
        await activePluginReloadController?.shutdown();
        activePluginReloadController = null;
        await activeDevelopmentRootsOwner?.stop();
        activeDevelopmentRootsOwner = null;
        socketIoFactory.mockReset();
        spawnBoundary.mockReset();
        vi.restoreAllMocks();
        if (originalHappyHomeDir === undefined) {
            delete process.env.HAPPIER_HOME_DIR;
        } else {
            process.env.HAPPIER_HOME_DIR = originalHappyHomeDir;
        }
    });

    it.each(['codex', 'opencode'] as const)('admits the installed bundled native attach surface through the session bridge (%s)', async (agentId) => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-native-attach-registry-home-'));
        process.env.HAPPIER_HOME_DIR = happyHomeDir;
        const { configuration } = await import('../../../configuration');
        expect(configuration.happyHomeDir).toBe(happyHomeDir);
        const registry = await publishCurrentRuntimeRegistry({ happyHomeDir, generation: 1, changedPluginIds: [] });
        const { getSessionHostBridge } = await import('@/agent/runtime/bridges/session/SessionHostBridge');
        const surfaces = await getSessionHostBridge().resolveExecutionSurfaces(agentId);
        const registration = [...registry.agentRuntimesByAgentId.values()]
            .find((entry) => entry.pluginId === `happier.agent.${agentId}`);
        expect(surfaces.attach?.attach, JSON.stringify({
            nativeAttachDeclared: Boolean(registration?.providerCliAttach),
            primaryRuntime: registration?.hasPrimaryRuntime,
            current: registration?.isCurrent(),
        })).toEqual(expect.any(Function));
        expect(surfaces.attach?.attachManaged).toEqual(expect.any(Function));
    });

    it.each(['owned_attached', 'headless', 'spawn_failed'] as const)(
        'keeps runner custody unchanged through the public standalone native attach command (%s)', async (scenario) => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-native-attach-custody-home-'));
        const originalPath = process.env.PATH;
        const originalServerUrl = process.env.HAPPIER_SERVER_URL;
        const originalLocalServerUrl = process.env.HAPPIER_LOCAL_SERVER_URL;
        process.env.HAPPIER_HOME_DIR = happyHomeDir;
        const argvLog = join(happyHomeDir, 'native-argv.log');
        writeExecutableShimSync({
            dir: happyHomeDir,
            fileName: process.platform === 'win32' ? 'codex.cmd' : 'codex',
            contents: process.platform === 'win32'
                ? `@echo off\necho %*>>"${argvLog}"\nexit /b 0\n`
                : `#!/bin/sh\nprintf '%s\\n' "$*" >> '${argvLog}'\nexit 0\n`,
        });
        process.env.PATH = `${happyHomeDir}${process.platform === 'win32' ? ';' : ':'}${originalPath ?? ''}`;
        const sessionId = 'session-public-native-attach-custody';
        const runner = createMutableApiSessionClientFixture({ sessionId });
        runner.updateAgentState((current) => ({
            ...current,
            controlledByUser: false,
            localControl: createAgentRuntimeSwitchState({
                attached: scenario !== 'headless', topology: 'shared', canAttach: true,
                canDetach: scenario !== 'headless', remoteWritable: true,
            }),
        }));
        const ownedState = structuredClone(runner.__getAgentState());
        let stateVersion = 0;
        let metadataVersion = 0;
        let boundaryFailure: unknown = null;
        // Owner publication uses the real tuple writer and genuine HTTP CAS boundary,
        // including its layout-0 migration; an unhandled HTTP route would hang that write.
        const http = createServer(async (request, response) => {
            response.setHeader('content-type', 'application/json');
            if (request.method !== 'PATCH' || request.url !== `/v2/sessions/${sessionId}`) {
                response.writeHead(404).end(JSON.stringify({ error: 'Not found' }));
                return;
            }
            try {
                const chunks: Buffer[] = [];
                for await (const chunk of request) chunks.push(Buffer.from(chunk));
                const patch = SessionMetadataTuplePatchV1Schema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
                if (patch.mode !== 'owner' && patch.mode !== 'owner_migration') {
                    throw new Error('Expected owner tuple publication');
                }
                const expectedStateVersion = patch.mode === 'owner_migration'
                    ? patch.source.agentState.version : patch.agentState.expectedVersion;
                expect(expectedStateVersion).toBe(stateVersion);
                const ciphertext = patch.mode === 'owner_migration'
                    ? patch.target.agentState.ciphertext : patch.agentState.ciphertext;
                if (ciphertext === null) throw new Error('Expected plain owner state');
                const next: AgentState = JSON.parse(ciphertext);
                runner.updateAgentState(() => next);
                stateVersion += 1;
                metadataVersion += 1;
                response.end(JSON.stringify({ success: true, metadataLayoutVersion: 1,
                    sharedMetadata: { version: metadataVersion }, agentState: { version: stateVersion } }));
            } catch (error) {
                boundaryFailure = error;
                response.writeHead(400).end(JSON.stringify({ error: 'Invalid fixture tuple' }));
            }
        });
        await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
        const address = http.address();
        if (!address || typeof address === 'string') throw new Error('Missing fixture relay address');
        process.env.HAPPIER_SERVER_URL = `http://127.0.0.1:${address.port}`;
        process.env.HAPPIER_LOCAL_SERVER_URL = process.env.HAPPIER_SERVER_URL;
        const { io: actualIo } = await vi.importActual<typeof import('socket.io-client')>('socket.io-client');
        socketIoFactory.mockImplementation(actualIo);
        const { spawn: actualSpawn } = await vi.importActual<typeof import('node:child_process')>('node:child_process');
        const statesAtSpawn: AgentState[] = [];
        spawnBoundary.mockImplementation((...args: Parameters<typeof childProcess.spawn>) => {
            statesAtSpawn.push(structuredClone(runner.__getAgentState()));
            if (scenario !== 'spawn_failed') return actualSpawn(...args);
            const failed = new childProcess.ChildProcess();
            queueMicrotask(() => failed.emit('error', new Error('native process failed to spawn')));
            return failed;
        });
        const exit = vi.spyOn(process, 'exit').mockImplementation((code) => {
            throw new Error(`fixture_process_exit:${code}`);
        });
        try {
            await publishCurrentRuntimeRegistry({ happyHomeDir, generation: 1, changedPluginIds: [] });
            const { resolveServerHttpBaseUrl } = await import('@/api/client/serverHttpBaseUrl');
            expect(resolveServerHttpBaseUrl()).toBe(process.env.HAPPIER_SERVER_URL);
            const { resolveCliRuntimeAssetPath } = await import('@/packagedRuntime/assets/resolveCliRuntimeAssetPath');
            const launcherPath = resolveCliRuntimeAssetPath('scripts', 'terminal_launch_spec_runner.cjs');
            expect(launcherPath).toBe(join(process.cwd(), 'scripts', 'terminal_launch_spec_runner.cjs'));
            expect(await readFile(launcherPath, 'utf8')).toContain("type: 'terminal-native-spawned'");
            const { handleAttachCommand } = await import('@/cli/commands/attach');
            const rawSession = createSessionRecordFixture({
                id: sessionId, active: true, encryptionMode: 'plain',
                metadata: JSON.stringify({
                    path: happyHomeDir, machineId: 'machine-native-custody', flavor: 'codex',
                    runtimeDescriptorV1: {
                        v: 1, agentId: 'codex', agent: {
                            backendMode: 'appServer', providerSessionId: 'thread-native-custody',
                            appServerEndpoint: 'unix:///tmp/native-custody.sock',
                        },
                    },
                }),
                agentState: JSON.stringify(ownedState), agentStateVersion: stateVersion,
            });
            const command = handleAttachCommand([sessionId], {
                readCredentialsFn: async () => ({ token: 'fixture-token', encryption: null }),
                readSettingsFn: async () => ({ schemaVersion: 6, onboardingCompleted: true, machineId: 'machine-native-custody' }),
                fetchSessionByIdFn: async () => rawSession,
                readTerminalAttachmentInfoFn: async () => null,
                getAccountEncryptionCurrentnessFn: async () => ({
                    mode: 'plain', version: 1, signingKeyFingerprint: null,
                    contentKeyFingerprint: null, updatedAt: 1,
                    recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' },
                }),
            });
            if (scenario === 'spawn_failed') await expect(command).rejects.toThrow('fixture_process_exit:1');
            else await command;
            expect(boundaryFailure).toBeNull();
            expect(statesAtSpawn).toEqual([ownedState]);
            expect(runner.__getAgentState()).toEqual(ownedState);
            if (scenario !== 'spawn_failed') {
                expect(await readFile(argvLog, 'utf8')).toContain('--remote unix:///tmp/native-custody.sock');
                expect(await readFile(argvLog, 'utf8')).toContain('resume thread-native-custody');
                expect(exit).not.toHaveBeenCalled();
            }
        } finally {
            await new Promise<void>((resolve) => http.close(() => resolve()));
            if (originalPath === undefined) delete process.env.PATH;
            else process.env.PATH = originalPath;
            if (originalServerUrl === undefined) delete process.env.HAPPIER_SERVER_URL;
            else process.env.HAPPIER_SERVER_URL = originalServerUrl;
            if (originalLocalServerUrl === undefined) delete process.env.HAPPIER_LOCAL_SERVER_URL;
            else process.env.HAPPIER_LOCAL_SERVER_URL = originalLocalServerUrl;
        }
    });

    it.each([
        ['herdr', 'ready', 'attach'], ['tmux', 'ready', 'attach'], ['zellij', 'ready', 'attach'],
        ['windows_terminal', 'ready', 'attach'], ['windows_console', 'ready', 'attach'],
        ['herdr', 'rejected', 'attach'], ['herdr', 'malformed', 'attach'], ['herdr', 'transport_failed', 'attach'],
        ['herdr', 'ready', 'resume'],
    ] as const)('restores the managed shared TUI before public host focus (%s/%s/%s)', async (host, outcome, entrypoint) => {
        const terminals = {
            herdr: { mode: 'herdr', herdr: { sessionName: 'test-host', socketPath: '/tmp/attach-host.sock', terminalId: 'term-attach' } },
            tmux: { mode: 'tmux', tmux: { target: 'happier:1' } },
            zellij: { mode: 'zellij', zellij: { sessionName: 'test-host', paneId: '1' } },
            windows_terminal: { mode: 'windows_terminal', windows: { host: 'windows_terminal', windowId: 'attach-window' } },
            windows_console: { mode: 'windows_console', windows: { host: 'console', pid: 1234 } },
        } satisfies Record<string, NonNullable<Metadata['terminal']>>;
        const terminal = terminals[host];
        const sessionId = 'session-managed-host-restore';
        const calls: unknown[] = [];
        const socket = createApiSessionSocketStub({ emitWithAck: (event, payload) => {
            if (event !== SOCKET_RPC_EVENTS.CALL) throw new Error('Unexpected host restoration transport');
            calls.push(payload);
            if (outcome === 'transport_failed') throw new Error('fixture_native_restore_transport_failed');
            return { ok: true, result: outcome === 'ready' ? true : outcome === 'rejected' ? false : { accepted: true } };
        } });
        socketIoFactory.mockImplementation(() => socket);
        const focusedAfter: number[] = [];
        const focus = async () => { focusedAfter.push(calls.length); return 0; };
        const exit = vi.spyOn(process, 'exit').mockImplementation((code) => { throw new Error(`fixture_process_exit:${code}`); });
        const { handleAttachCommand } = await import('@/cli/commands/attach');
        // The canonical owner publishes this capability; external RPC startup is the boundary here.
        const rawSession = createSessionRecordFixture({
            id: sessionId, active: true, encryptionMode: 'plain',
            metadata: JSON.stringify({
                path: '/tmp/shared-host', machineId: 'machine-host', flavor: host === 'tmux' ? 'codex' : 'opencode',
                agentRuntimeCapabilitiesV1: { localControl: { supported: true, topology: 'shared', attachStrategy: 'provider_attach', remoteWritable: true } },
            }),
        });
        const attachDeps = {
            readCredentialsFn: async () => ({ token: 'fixture-token', encryption: null }),
            readSettingsFn: async () => ({ schemaVersion: 6 as const, onboardingCompleted: true, machineId: 'machine-host' }),
            fetchSessionByIdFn: async () => rawSession,
            readTerminalAttachmentInfoFn: async () => ({ version: 1 as const, sessionId, terminal, updatedAt: 1 }),
            getAccountEncryptionCurrentnessFn: async () => createAccountEncryptionCurrentnessFixture(),
            runHerdrAttachFn: focus, runTmuxAttachFn: focus, runZellijAttachFn: focus,
            runWindowsTerminalAttachFn: focus, runWindowsConsoleAttachFn: focus,
        };
        const command = entrypoint === 'resume'
            ? (await import('@/cli/commands/resume')).handleResumeCommand([sessionId], {
                readCredentialsFn: attachDeps.readCredentialsFn,
                readAccountSettingsFn: async () => accountSettingsParse({}),
                getAccountEncryptionCurrentnessFn: attachDeps.getAccountEncryptionCurrentnessFn,
                fetchSessionByIdFn: attachDeps.fetchSessionByIdFn,
                resolveAgentHandlerFn: async () => { throw new Error('Active resume must not vendor-resume'); },
                attachDeps,
            })
            : handleAttachCommand([sessionId], attachDeps);
        if (outcome === 'ready') {
            await command;
            expect(calls).toEqual([expect.objectContaining({ method: `${sessionId}:switch`, params: { to: 'local' } })]);
            expect(focusedAfter).toEqual([1]);
            expect(exit).not.toHaveBeenCalled();
        } else {
            await expect(command).rejects.toThrow(outcome === 'transport_failed' ? 'fixture_native_restore_transport_failed' : 'fixture_process_exit:1');
            expect(focusedAfter).toEqual([]);
        }
    });

    it('does not eagerly load plugin daemon modules until a plugin backend actually needs them', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-engine-registry-home-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-engine-registry-plugin-'));
        const sentinelPath = join(pluginRoot, 'daemon-loaded.txt');
        process.env.HAPPIER_HOME_DIR = happyHomeDir;

        await writePlugin({
            rootDir: pluginRoot,
            sentinelPath,
        });

        await seedCurrentLocalPathPluginFixture({
            happyHomeDir,
            pluginRoot,
            pluginId: 'acme.runtime',
            manifestVersion: '1.0.0',
        });

        await expect(access(sentinelPath, fsConstants.F_OK)).rejects.toMatchObject({
            code: 'ENOENT',
        });

        await publishCurrentRuntimeRegistry({
            happyHomeDir,
            generation: 1,
            changedPluginIds: ['acme.runtime'],
        });
        const { resolveCliEngineRegistry } = await import('./engineRegistry');
        const registry = await resolveCliEngineRegistry();
        const resolution = await registry.resolveForBackendId('pi');

        expect(resolution?.backendId).toBe('pi');
        expect(resolution?.engineAdapter.runtimeCore.createSessionRuntime).toEqual(expect.any(Function));
        expect(resolution?.engineAdapter.runtimeCore.createExecutionRunBackend).toEqual(expect.any(Function));
        await expect(access(sentinelPath, fsConstants.F_OK)).rejects.toMatchObject({
            code: 'ENOENT',
        });
    });

    it('observes newly enabled plugin backends on a subsequent resolve with the same home dir', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-engine-registry-home-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-engine-registry-plugin-refresh-'));
        const sentinelPath = join(pluginRoot, 'daemon-loaded.txt');
        process.env.HAPPIER_HOME_DIR = happyHomeDir;

        await writePlugin({
            rootDir: pluginRoot,
            sentinelPath,
        });

        await publishCurrentRuntimeRegistry({
            happyHomeDir,
            generation: 1,
            changedPluginIds: [],
        });
        const { resolveCliEngineRegistry } = await import('./engineRegistry');
        const initialRegistry = await resolveCliEngineRegistry();
        expect(await initialRegistry.resolveForBackendId('acme.runtime/acme-runtime')).toBeNull();

        await seedCurrentLocalPathPluginFixture({
            happyHomeDir,
            pluginRoot,
            pluginId: 'acme.runtime',
            manifestVersion: '1.0.0',
        });

        const runtimeRegistry = await publishCurrentRuntimeRegistry({
            happyHomeDir,
            generation: 2,
            changedPluginIds: ['acme.runtime'],
        });
        const refreshedRegistry = await resolveCliEngineRegistry();
        const resolution = await refreshedRegistry.resolveForBackendId('acme.runtime/acme-runtime');

        expect(runtimeRegistry.pluginDiagnosticsByPluginId['acme.runtime'] ?? []).toEqual([]);
        expect(runtimeRegistry.contributes.agentDefinitionsById.has('acme.runtime/acme-runtime')).toBe(true);
        expect(runtimeRegistry.contributes).not.toHaveProperty('agentRuntimeDefinitionsById');
        expect(resolution?.backendId).toBe('acme.runtime/acme-runtime');
        expect(resolution?.engineAdapter.runtimeCore.createSessionRuntime).toEqual(expect.any(Function));
        expect(resolution?.engineAdapter.runtimeCore.createExecutionRunBackend).toEqual(expect.any(Function));
        await expect(access(sentinelPath, fsConstants.F_OK)).resolves.toBeUndefined();
    });

    it('resolves a current manifest-only ACP Agent without reviving a runtime-definition registry', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-engine-registry-home-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-engine-registry-acp-plugin-'));
        process.env.HAPPIER_HOME_DIR = happyHomeDir;
        await writeManifestOnlyAcpPlugin(pluginRoot);
        await seedCurrentLocalPathPluginFixture({
            happyHomeDir,
            pluginRoot,
            pluginId: 'acme.runtime',
            manifestVersion: '1.0.0',
        });

        await publishCurrentRuntimeRegistry({
            happyHomeDir,
            generation: 1,
            changedPluginIds: ['acme.runtime'],
        });
        const { resolveCliEngineRegistry } = await import('./engineRegistry');
        const registry = await resolveCliEngineRegistry();
        expect(registry.contributions.agentDefinitionsById.has('acme.runtime/acme-acp')).toBe(true);
        expect(registry.contributions).not.toHaveProperty('agentRuntimeDefinitionsById');
        const resolution = await registry.resolveForBackendId('acme.runtime/acme-acp');

        expect(resolution).toMatchObject({
            backendId: 'acme.runtime/acme-acp',
            agentId: 'acme.runtime/acme-acp',
            runtimeOwner: { selected: { kind: 'plugin_engine', pluginId: 'acme.runtime' } },
            engineAdapter: { runtimeCore: expect.any(Object) },
        });
        // Native Session admission does not grant an undeclared detached execution-run protocol.
        expect(() => resolution!.engineAdapter.runtimeCore.createExecutionRunBackend({
            scope: 'detached',
            cwd: pluginRoot,
            backendId: 'acme.runtime/acme-acp',
            permissionMode: 'read_only',
            runId: 'manifest-only-acp-derived-run',
            start: { intent: 'review', profileId: 'review' },
        })).toThrow(expect.objectContaining({ executionRunErrorCode: 'execution_run_protocol_unsupported' }));
    });

});
