import { copyFileSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, onTestFailed, vi } from 'vitest';
import fastify from 'fastify';
import { serializerCompiler } from 'fastify-type-provider-zod';
import { SessionSpawnNewResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { SpawnSessionControlErrorResponseSchema, projectSpawnSessionControlErrorResponse } from '@/session/shared/spawnSessionContract';
import { projectSessionSpawnFailure } from '@/session/creation/projectSessionSpawnFailure';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';

import { withTempDir } from '@/testkit/fs/tempDir';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { writeExecutableShim } from '@/testkit/fs/executableShim';
import { createSpawnHappyCliEnvScope, publishPinnedRunnerSnapshotFixture } from '@/testkit/process/spawnHappyCliHarness';
import { routeSpawnModeAndWaitForWebhook } from './routeSpawnModeAndWaitForWebhook';
import { createSpawnLifecycleCallbacks } from './createSpawnLifecycleCallbacks';
import { persistAcceptedSpawnMarker } from './persistAcceptedSpawnMarker';
import { createOnHappySessionWebhook } from '../sessions/onHappySessionWebhook';
import { createOnChildExited } from '../sessions/onChildExited';
import { listSessionMarkers } from '../sessionRegistry';
import { readOrCreateDeviceLocalSecretStorage } from '../deviceLocalSecretStorage';
import type { TrackedSession } from '../types';
import type { SpawnSessionResult } from '@/session/shared/spawnSessionContract';
import { reloadConfiguration } from '@/configuration';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { buildSpawnSessionOptionsFromRespawnDescriptorV1 } from '../processSupervision/sessionRunnerRespawnDescriptor';
import { readCliNodeWorkspaceRuntimeIdentityFromRuntimeRoot } from '@happier-dev/cli-common/componentArtifacts/copyCliNodeRuntimePayload';
import { resolveProcessCustodySupportExecutable } from '@/subprocess/supervision/processCustody';
import { partitionProviderSessionArgs } from '@/cli/providerSessionArgPartition';
import { buildPluginSessionBindingInput } from '@/plugins/runtime/runtimeCore/plugin/sessionLaunch';
import { resolveCodexCliSessionExtraOptions } from '../../../../../packages/plugins/codex/src/agent/cli/command';

const envScope = createSpawnHappyCliEnvScope();
afterEach(() => { envScope.restore(); vi.unstubAllEnvs(); reloadConfiguration(); vi.unstubAllGlobals(); });

it.each(['opencode', 'codex'] as const)('requires managed runtime bootstrap before admitting a %s runner through native launch, marker custody and canonical readiness', async agentId => {
    let phase = 'prepare pinned runner and native support fixture';
    let acceptedMarkerFailure: unknown;
    onTestFailed(() => console.error('Native runner admission fixture failed', { phase, acceptedMarkerFailure }));
    await withTempDir('happier-route-native-admission-', async root => {
        const stagingRoot = join(root, '.runner-snapshots', '.staging');
        const stagingEntrypoint = join(stagingRoot, 'package-dist', 'index.mjs');
        mkdirSync(dirname(stagingEntrypoint), { recursive: true });
        // The external native receiver consumes its own physical package; this is not a Happier domain replacement.
        const packageNames = ['@happier-dev/route-native-fixture'];
        const nativePackageRoot = join(stagingRoot, 'node_modules', '@happier-dev', 'route-native-fixture');
        mkdirSync(nativePackageRoot, { recursive: true });
        writeFileSync(join(nativePackageRoot, 'package.json'), JSON.stringify({ name: packageNames[0], type: 'module', main: 'index.js' }));
        writeFileSync(join(nativePackageRoot, 'index.js'), 'export const keepAlive = () => setInterval(() => {}, 1000);\n');
        const workspaceRuntime = readCliNodeWorkspaceRuntimeIdentityFromRuntimeRoot({ runtimeRoot: stagingRoot, packageNames });
        // A genuine child process exposes its received invocation and remains alive until its owning test closes it.
        writeFileSync(stagingEntrypoint, `import { writeFileSync } from 'node:fs';\nimport { keepAlive } from '@happier-dev/route-native-fixture';\nwriteFileSync(process.env.ROUTE_FIXTURE_READY, JSON.stringify({ pid: process.pid, args: process.argv.slice(2) }));\nkeepAlive();\n`);
        const closure = publishPinnedRunnerSnapshotFixture({
            stagingRoot, workspaceRuntimeIdentity: workspaceRuntime.fingerprint,
            workspaceRuntimePackages: workspaceRuntime.packageNames,
        });
        const runtimeStatePath = join(root, 'stack.runtime.json');
        writeFileSync(runtimeStatePath, JSON.stringify({ version: 1, stackName: 'session-spawn-test', daemon: {} }));
        const homeDir = join(root, 'home');
        const directory = join(root, 'project');
        mkdirSync(directory);
        const readyPath = join(root, 'native-ready.json');
        const originalExecPath = process.execPath;
        const custodyExecutable = resolveProcessCustodySupportExecutable();
        if (!custodyExecutable) throw new Error('Expected the test setup native custody runtime');
        const custodyDir = join(root, 'tools', 'unpacked');
        mkdirSync(custodyDir, { recursive: true });
        copyFileSync(custodyExecutable, join(custodyDir, basename(custodyExecutable)));
        envScope.patch({
            HAPPIER_HOME_DIR: homeDir,
            HAPPIER_MANAGED_NODE_BIN: undefined,
            HAPPIER_CLI_SUBPROCESS_ENTRYPOINT: undefined,
            HAPPIER_STACK_REPO_DIR: undefined,
            HAPPIER_STACK_CLI_ROOT_DIR: undefined,
            HAPPIER_STACK_STACK: 'session-spawn-test',
            HAPPIER_CLI_SUBPROCESS_RUNTIME: 'node',
            HAPPIER_CLI_SUBPROCESS_RUNTIME_BACKED: '1',
            HAPPIER_CLI_SUBPROCESS_PREFER_TSX: '0',
            HAPPIER_CLI_SUBPROCESS_DIST_ENTRYPOINT: closure.snapshotEntrypoint,
            HAPPIER_CLI_SUBPROCESS_DAEMON_DIST_CLOSURE_FINGERPRINT: closure.fingerprint,
            HAPPIER_CLI_SUBPROCESS_STACK_RUNTIME_STATE_PATH: runtimeStatePath,
        });
        vi.stubEnv('ROUTE_FIXTURE_READY', readyPath);
        reloadConfiguration();
        phase = 'admit the Agent plugin runtime';
        const runtime = await createAdmittedPluginRuntimeFixture({
            happyHomeDir: homeDir, controller: pluginReloadController,
            runtimeOptions: { pluginIds: [`happier.agent.${agentId}`] },
        });
        vi.stubEnv('PATH', '');
        const pidToTrackedSession = new Map<number, TrackedSession>();
        const pidToAwaiter = new Map<number, (session: TrackedSession) => void>();
        const pidToSpawnResultResolver = new Map<number, (result: SpawnSessionResult) => void>();
        const pidToSpawnWebhookTimeout = new Map<number, NodeJS.Timeout>();
        const spawnResourceCleanupByPid = new Map<number, () => void | Promise<void>>();
        const sessionAttachCleanupByPid = new Map<number, () => Promise<void>>();
        const deviceLocalSecretStorage = await readOrCreateDeviceLocalSecretStorage({ path: join(root, 'device-key.json') });
        const lifecycle = createSpawnLifecycleCallbacks({
            connectedServicesBindingsRaw: null, catalogAgentId: null, materializationKey: 'fixture',
            hasConnectedServiceAuth: () => false,
            getSpawnResourceCleanupOnExit: () => null, onSpawnResourceCleanupArmed: () => {},
            spawnResourceCleanupByPid, getSessionAttachCleanup: () => null, setSessionAttachCleanup: () => {},
            sessionAttachCleanupByPid,
            persistAcceptedSpawnMarker: async (trackedSession, options) => {
                try {
                    await persistAcceptedSpawnMarker({ trackedSession, deviceLocalSecretStorage, ...options });
                } catch (error) {
                    acceptedMarkerFailure = error;
                    throw error;
                }
            },
        });
        const backendTarget = { kind: 'backend' as const, sourceKind: 'built_in' as const, backendId: agentId };
        const spawnOptions = { directory, backendTarget };
        const onChildExited = createOnChildExited({
            pidToTrackedSession, spawnResourceCleanupByPid, sessionAttachCleanupByPid,
            getApiMachineForSessions: () => null,
        });
        const childExitObservations: Promise<void>[] = [];
        const params = {
            terminalPresentation: agentId === 'codex'
                ? { kind: 'provider_attach' as const, startingMode: 'remote' as const }
                : { kind: 'runner' as const, startingMode: 'remote' as const },
            terminalRequest: { requested: 'plain' as const },
            directory, options: spawnOptions, trackedSpawnOptions: spawnOptions,
            normalizedExistingSessionId: '', effectiveResume: '',
            effectiveBackendTargetV2: backendTarget,
            directoryCreated: false, extraEnvForChildWithMessage: {}, processEnv: { ...process.env }, happyHomeDir: homeDir,
            pidToTrackedSession, pidToAwaiter, pidToSpawnResultResolver, pidToSpawnWebhookTimeout,
            // Plain launch readiness comes from the canonical webhook owner, never a fixture Session resolver.
            resolveCanonicalTrackedSessionId: () => { throw new Error('Plain routing must not consult the terminal-host Session resolver'); },
            onChildExited: (...args: Parameters<typeof onChildExited>) => {
                const observation = onChildExited(...args);
                childExitObservations.push(observation);
                return observation;
            },
            spawnLifecycleCallbacks: lifecycle, cleanupSpawnResources: () => {},
            onUntrackedHostedChild: () => { throw new Error('Plain routing unexpectedly created a hosted child'); },
            logDebug: () => {}, warn: () => {},
        };
        const offline = new Error('Node release service unavailable');
        let bootstrapFetches = 0;
        vi.stubGlobal('fetch', async () => { bootstrapFetches += 1; throw offline; });
        let launching: Promise<SpawnSessionResult> | undefined;
        try {
            phase = 'refuse stale source dependencies before runtime bootstrap or child launch';
            const sourceRoot = join(root, 'source-bundle');
            const sourceEntrypoint = join(sourceRoot, 'apps/cli/src/index.mjs');
            const markerPath = join(root, 'installed-dependencies');
            const generationPath = join(root, 'dependency-generation');
            mkdirSync(dirname(sourceEntrypoint), { recursive: true });
            writeFileSync(sourceEntrypoint, 'import "./removed-dependency.mjs";');
            writeFileSync(markerPath, JSON.stringify({ identity: 'after-refresh' }));
            writeFileSync(join(sourceRoot, 'source-bundle.json'), JSON.stringify({
                identity: 'captured-source-fixture', entrypoint: sourceEntrypoint,
                dependencyPublication: { identity: 'before-refresh', generation: null, writerActive: false, markerPath, generationPath },
            }));
            // Match Stack's source launch provenance in both the process and
            // the request environment; a native snapshot flag cannot stand in
            // for the actual source-runtime contract.
            const sourceEnv = {
                HAPPIER_CLI_SUBPROCESS_ENTRYPOINT: sourceEntrypoint,
                HAPPIER_STACK_CLI_ROOT_DIR: dirname(dirname(sourceEntrypoint)),
                HAPPIER_CLI_ROOT_DIR: dirname(dirname(sourceEntrypoint)),
                HAPPIER_CLI_SUBPROCESS_RUNTIME_BACKED: '0',
                HAPPIER_CLI_SUBPROCESS_DIST_ENTRYPOINT: undefined,
                HAPPIER_CLI_SUBPROCESS_DAEMON_DIST_CLOSURE_FINGERPRINT: undefined,
                HAPPIER_MANAGED_NODE_BIN: originalExecPath,
            };
            let stale: SpawnSessionResult;
            const sourceEnvScope = createEnvKeyScope(Object.keys(sourceEnv));
            sourceEnvScope.patch(sourceEnv);
            try {
                stale = await routeSpawnModeAndWaitForWebhook({ ...params, processEnv: { ...process.env } });
            } finally {
                sourceEnvScope.restore();
            }
            expect(stale).toMatchObject({ type: 'error', errorCode: 'SPAWN_FAILED',
                errorDetail: { kind: 'launch_error', code: 'SOURCE_RUNTIME_RELOAD_REQUIRED', subtype: 'no_closure' } });

            phase = 'preserve an unfinished writer refusal through the serialized operation result';
            const installRoot = join(root, 'installation');
            const installMarker = join(installRoot, 'node_modules', 'publication.json');
            const ownerPath = join(installRoot, 'apps', 'stack');
            mkdirSync(dirname(installMarker), { recursive: true });
            mkdirSync(dirname(ownerPath), { recursive: true });
            symlinkSync(fileURLToPath(new URL('../../../../stack', import.meta.url)), ownerPath,
                process.platform === 'win32' ? 'junction' : 'dir');
            writeFileSync(installMarker, JSON.stringify({ identity: 'before-refresh' }));
            writeFileSync(generationPath, JSON.stringify({ generation: 2, completedGeneration: 1 }));
            writeFileSync(join(sourceRoot, 'source-bundle.json'), JSON.stringify({
                dependencyPublication: { identity: 'before-refresh', generation: 1, writerActive: false,
                    markerPath: installMarker, generationPath },
            }));
            const writerRefusal = await routeSpawnModeAndWaitForWebhook({ ...params,
                processEnv: { ...process.env, ...sourceEnv, HAPPIER_DEV_TARGET_EXECUTION: undefined,
                    HAPPIER_STACK_HOME_DIR: join(root, 'dependency-home') } });
            if (writerRefusal.type !== 'error') throw new Error('Expected writer refusal');
            const app = fastify().setSerializerCompiler(serializerCompiler);
            app.post('/spawn-session', { schema: { response: { 500: SpawnSessionControlErrorResponseSchema } } },
                (_request, reply) => reply.code(500).send(projectSpawnSessionControlErrorResponse(writerRefusal)));
            try {
                const serialized = await app.inject({ method: 'POST', url: '/spawn-session' });
                const response = SpawnSessionControlErrorResponseSchema.parse(serialized.json());
                const result = SessionSpawnNewResultV1Schema.parse(projectSessionSpawnFailure({
                    errorCode: response.errorCode!, errorMessage: response.error, errorDetail: response.errorDetail,
                }));
                const operations = createHostActionOperationRuntime({ machineId: 'source-worker',
                    resolveAccountId: async () => 'source-owner', generateOperationId: () => 'source-refusal' });
                await operations.observeExecution({ actionId: 'session.spawn_new',
                    input: { creationKey: 'source-refusal', executionTarget: { serverId: 'fixture-home', machineId: 'source-worker' },
                        directory: { kind: 'managed' }, agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } },
                    execute: async () => ({ ok: true, result }),
                });
                expect(await operations.handlers.getV2({ operationId: 'source-refusal', waitForTerminal: true }))
                    .toMatchObject({ kind: 'found', operation: { result: { type: 'error',
                        launchError: { code: 'SOURCE_RUNTIME_RELOAD_REQUIRED', subtype: 'writer_active' } } } });
            } finally { await app.close(); }
            expect(bootstrapFetches).toBe(0);
            expect(pidToTrackedSession.size).toBe(0);
            expect(pidToSpawnWebhookTimeout.size).toBe(0);
            await expect(listSessionMarkers()).resolves.toEqual([]);

            phase = 'reject managed JavaScript runtime bootstrap while offline';
            Object.defineProperty(process, 'execPath', { configurable: true, value: join(root, 'happier') });
            await expect(routeSpawnModeAndWaitForWebhook(params)).rejects.toMatchObject({
                message: 'Managed JavaScript runtime is unavailable: bootstrap failed', cause: offline,
            });
            expect(pidToTrackedSession.size).toBe(0);
            await expect(listSessionMarkers()).resolves.toEqual([]);

            const managedRoot = join(homeDir, 'tools', 'js-runtime', 'current');
            const nodePath = process.platform === 'win32' ? join(managedRoot, 'runtime', 'node.exe') : join(managedRoot, 'runtime', 'bin', 'node');
            mkdirSync(dirname(nodePath), { recursive: true });
            if (process.platform === 'win32') copyFileSync(originalExecPath, nodePath);
            else symlinkSync(originalExecPath, nodePath);
            await writeExecutableShim({
                dir: join(managedRoot, 'bin'),
                fileName: process.platform === 'win32' ? 'happier-js-runtime.cmd' : 'happier-js-runtime',
                contents: process.platform === 'win32'
                    ? `@echo off\r\n"${nodePath}" %*\r\n`
                    : `#!/bin/sh\nexec "${nodePath}" "$@"\n`,
            });
            phase = 'launch the native runner with the managed JavaScript runtime';
            launching = routeSpawnModeAndWaitForWebhook(params);
            let launchFailure: unknown;
            void launching.catch(error => { launchFailure = error; });
            let native: { pid: number; args: string[] } | undefined;
            await vi.waitFor(() => {
                if (launchFailure) throw launchFailure;
                const parsed: unknown = JSON.parse(readFileSync(readyPath, 'utf8'));
                if (!parsed || typeof parsed !== 'object' || !('pid' in parsed) || typeof parsed.pid !== 'number'
                    || !('args' in parsed) || !Array.isArray(parsed.args) || !parsed.args.every(arg => typeof arg === 'string')) {
                    throw new Error('Invalid native runner receipt');
                }
                native = { pid: parsed.pid, args: parsed.args };
                expect(pidToTrackedSession.size).toBe(1);
            });
            if (!native) throw new Error('Missing native runner receipt');
            const tracked = [...pidToTrackedSession.values()][0]!;
            phase = 'persist accepted runner marker custody';
            await tracked.acceptedSpawnMarkerGate;
            expect(native.args).toEqual([agentId, '--happy-starting-mode', 'remote', '--started-by', 'daemon']);
            // Exercise the runner's actual argument parser and Session binding,
            // not a separately reconstructed Workflow/daemon starting mode.
            const parsed = partitionProviderSessionArgs({ args: native.args, providerSubcommand: agentId });
            const codexOptions = agentId === 'codex'
                ? resolveCodexCliSessionExtraOptions({
                    startingMode: parsed.startingMode, directory: parsed.directory, agentArgs: parsed.providerArgs,
                }) : null;
            if (codexOptions && !codexOptions.ok) throw new Error(codexOptions.errorMessage);
            const binding = buildPluginSessionBindingInput({
                credentials: { token: 'fixture-token', encryption: null }, directory,
                startedBy: parsed.startedBy, startingMode: parsed.startingMode,
                backendTarget,
                ...(codexOptions?.ok ? codexOptions.options : {}),
            });
            expect(binding.bootstrap.source).toBe('daemon');
            expect(binding.runtimePreferences.startingMode).toBe('remote');
            const acceptedMarkers = await listSessionMarkers();
            expect(acceptedMarkers).toEqual(expect.arrayContaining([expect.objectContaining({
                pid: tracked.pid, happySessionId: `PID-${tracked.pid}`, cwd: directory,
                processStartTimeMs: tracked.processStartTimeMs,
            })]));
            const marker = acceptedMarkers.find(candidate => candidate.pid === tracked.pid);
            if (!marker?.respawn) throw new Error('Missing accepted runner recovery custody');
            expect(buildSpawnSessionOptionsFromRespawnDescriptorV1(marker.respawn, { deviceLocalSecretStorage }))
                .toMatchObject({ directory, backendTarget });
            const onWebhook = createOnHappySessionWebhook({
                pidToTrackedSession, pidToAwaiter, spawnResourceCleanupByPid, sessionAttachCleanupByPid,
                deviceLocalSecretStorage,
            });
            phase = 'admit the canonical Session webhook';
            await onWebhook('session-native-admission', {
                path: directory, host: 'native-fixture', homeDir: root, happyHomeDir: homeDir,
                happyLibDir: closure.snapshotRoot, happyToolsDir: join(closure.snapshotRoot, 'tools'),
                hostPid: native.pid, startedBy: 'daemon', machineId: 'machine-native-fixture',
            });
            await expect(launching).resolves.toMatchObject({ type: 'success', sessionId: 'session-native-admission' });
            expect(tracked.happySessionId).toBe('session-native-admission');
            // A plain receiver has no Agent-runtime authority gate: its real webhook owner
            // publishes the marker asynchronously and exposes that write's settlement.
            phase = 'persist canonical Session marker custody';
            await tracked.reportMarkerCustody?.pending;
            expect(await listSessionMarkers()).toEqual(expect.arrayContaining([expect.objectContaining({
                pid: native.pid, happySessionId: 'session-native-admission',
            })]));
            expect(pidToAwaiter.size).toBe(0);
            expect(pidToSpawnWebhookTimeout.size).toBe(0);
        } finally {
            for (const tracked of pidToTrackedSession.values()) {
                const child = tracked.childProcess;
                if (child && child.exitCode === null && child.signalCode === null) {
                    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
                    child.kill('SIGTERM');
                    await exited;
                }
            }
            for (const timeout of pidToSpawnWebhookTimeout.values()) clearTimeout(timeout);
            // Exit retirement still owns files beneath this temporary home.
            await Promise.all(childExitObservations);
            await runtime.dispose();
            Object.defineProperty(process, 'execPath', { configurable: true, value: originalExecPath });
        }
    });
});
