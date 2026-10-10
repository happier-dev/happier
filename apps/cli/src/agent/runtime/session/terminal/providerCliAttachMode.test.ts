import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import axios from 'axios';
import { SessionMetadataTuplePatchV1Schema, V2SessionByIdResponseSchema, SessionProviderCliAttachPrepareRequestV1Schema } from '@happier-dev/protocol';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS } from '@happier-dev/protocol/rpc';
import { applyProviderSessionIdSessionMetadata } from '@happier-dev/agents/session/state/metadataWriters';
import { getSessionHostBridge } from '@/agent/runtime/bridges/session/SessionHostBridge';
import { handleAttachCommand } from '@/cli/commands/attach';
import { acquireSessionRunnerLock } from '@/daemon/sessionRunnerLock';
import { reportSessionToDaemonIfRunning } from '@/agent/runtime/startupSideEffects';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { createDaemonPluginDevelopmentRootsOwner } from '@/plugins/daemon/developmentRoots';

import { createApiSessionSocketStub, bindApiSessionSocketPairMock } from '@/testkit/backends/apiSessionSocketHarness';
import { createAccountEncryptionCurrentnessFixture, createPlainSessionFixture, createSessionNotificationContextFixture } from '@/testkit/backends/sessionFixtures';
import { createTestApiSessionClient } from '@/testkit/backends/createTestApiSessionClient';

const transport = vi.hoisted(() => ({ io: vi.fn() }));
// Network and stored credentials are external boundaries; the real Session,
// RPC registration, presentation mode and process owners remain in use.
vi.mock('socket.io-client', async importOriginal => ({
    ...await importOriginal<typeof import('socket.io-client')>(), io: transport.io,
}));
vi.mock('@/persistence', async importOriginal => ({
    ...await importOriginal<typeof import('@/persistence')>(), readStoredCredentials: async () => null,
}));

import { ApiSessionClient } from '@/api/session/sessionClient';
import { createProviderCliAttachSurface, attachObservedNativeClient } from '@/session/attach/providerCliAttach';
import type { HostProviderCliAttachSurface } from '@/session/attach/providerCliAttach';
import type { RuntimeTurnOperations } from '@/agent/runtime/turns/runtimeTurnOperations';
import { createNativeAgentProviderAttachModeBinding } from './providerCliAttachMode';
import { withHerdrApi } from '@/integrations/herdr/herdrApi.testkit';
import { configuration } from '@/configuration';
import { SUPPORTED_SCHEMA_VERSION } from '@/persistence';
import { createTerminalAttachmentId, readTerminalHostAttachmentInfo } from '@/terminal/attachment/terminalAttachmentInfo';

it.skipIf(process.platform === 'win32').for([false, true, 'client', 'command', 'concurrent', 'concurrent-detach', 'unbound'] as const)('keeps one private native presentation owner through real Session attach and Detach (restored preparation: %s)', async (restoredPreparation, { task }) => {
  await withHerdrApi(async api => {
    const root = await mkdtemp(join(tmpdir(), 'native-attach-mode-'));
    const previousHome = configuration.happyHomeDir;
    Object.assign(configuration, { happyHomeDir: root });
    const marker = join(root, 'native.json');
    let sessionFixture = createPlainSessionFixture({ id: 'native-presentation-session' });
    const hasExternalClient = restoredPreparation === 'client' || restoredPreparation === 'command' || restoredPreparation === 'concurrent' || restoredPreparation === 'concurrent-detach' || restoredPreparation === 'unbound';
    if (hasExternalClient) {
        sessionFixture = { ...sessionFixture, metadata: { ...sessionFixture.metadata, terminal: { mode: 'herdr',
            herdr: { sessionName: 'work', socketPath: api.socketPath, terminalId: 'terminal_before_restart', paneId: 'managed' },
            controlServiceabilityV1: { v: 1, ...(restoredPreparation === 'unbound' ? {} : { attachmentId: createTerminalAttachmentId() }), state: 'unknown',
                observedAt: Date.now(), retired: true, reason: 'attachment_retired' } } } };
        api.panes.add('managed');
    }
    if (restoredPreparation === 'command') sessionFixture = { ...sessionFixture, metadata: applyProviderSessionIdSessionMetadata({ ...sessionFixture.metadata,
        flavor: 'opencode', machineId: 'machine-local', path: root, startedBy: 'daemon',
        runtimeDescriptorV1: { v: 1, agentId: 'opencode', agent: { providerSessionId: 'native-one',
            backendMode: 'server', serverBaseUrl: 'http://127.0.0.1:4096/' } },
        agentRuntimeCapabilitiesV1: { localControl: { supported: true, topology: 'shared',
            attachStrategy: 'provider_attach', remoteWritable: true } },
    }, { metadataKey: 'opencodeSessionId', value: 'native-one' }) };
    // This owner-server fixture always carries the version committed by its
    // real Session producer; the general recipient schema also permits omission.
    let serverRow: ReturnType<typeof V2SessionByIdResponseSchema.parse>['session'] & { agentStateVersion: number } = { ...createSessionNotificationContextFixture(sessionFixture.id),
        active: true,
        metadata: JSON.stringify(sessionFixture.metadata),
        metadataVersion: sessionFixture.metadataVersion, agentState: null,
        agentStateVersion: sessionFixture.agentStateVersion,
        encryptionMode: 'plain', metadataLayoutVersion: 0, share: null,
    };
    const sessionSocket = createApiSessionSocketStub({ connected: true, emitWithAck: async (event, payload) => {
        if (event !== 'update-state') throw new Error(`Unexpected socket event: ${event}`);
        const request = payload as { expectedVersion: number; agentState: string };
        serverRow = { ...serverRow, agentState: request.agentState, agentStateVersion: request.expectedVersion + 1 };
        return { result: 'success', version: serverRow.agentStateVersion, agentState: request.agentState };
    } });
    bindApiSessionSocketPairMock(transport.io, { sessionSocket, userSocket: createApiSessionSocketStub({ connected: true }) });
    // Supported predecessor HTTP negotiation stays real against an absent feature endpoint.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })));
    // Substitute only HTTP; the real Account currentness parser and Session
    // mutation admission still decide whether publication is permitted.
    vi.spyOn(axios, 'get').mockImplementation(async (url) => {
        const pathname = new URL(String(url)).pathname;
        if (pathname === '/v1/account/encryption/currentness') {
            return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
        }
        if (pathname === `/v2/sessions/${sessionFixture.id}`) {
            return { status: 200, data: V2SessionByIdResponseSchema.parse({ session: serverRow }) };
        }
        throw new Error(`Unexpected HTTP request: ${pathname}`);
    });
    vi.spyOn(axios, 'patch').mockImplementation(async (url, body) => {
        if (new URL(String(url)).pathname !== `/v2/sessions/${sessionFixture.id}`) {
            throw new Error('Unexpected tuple HTTP target');
        }
        const patch = SessionMetadataTuplePatchV1Schema.parse(body);
        if (patch.mode === 'shared_editor') throw new Error('Unexpected shared-editor mutation');
        const target = patch.mode === 'owner_migration' ? patch.target : patch;
        serverRow = { ...serverRow, metadataLayoutVersion: 1,
            metadata: target.sharedMetadata.ciphertext, metadataVersion: serverRow.metadataVersion + 1,
            ownerMetadata: target.ownerMetadata, agentState: target.agentState.ciphertext,
            agentStateVersion: serverRow.agentStateVersion + 1 };
        return { status: 200, data: { success: true, metadataLayoutVersion: 1,
            sharedMetadata: { version: serverRow.metadataVersion },
            agentState: { version: serverRow.agentStateVersion } } };
    });
    let session: ApiSessionClient | undefined;
    let binding: ReturnType<typeof createNativeAgentProviderAttachModeBinding> | undefined;
    let terminal: ReturnType<NonNullable<typeof binding>['terminalRemoteModeLoop']['runTerminal']> | undefined;
    let externalAttach: Promise<Awaited<ReturnType<HostProviderCliAttachSurface['attachManaged']>>> | undefined;
    const externalAbort = new AbortController();
    let externalNativePid: number | undefined;
    let runnerLock: Awaited<ReturnType<typeof acquireSessionRunnerLock>> | undefined;
    let restoreExitBoundary: (() => void) | undefined;
    try {
        session = createTestApiSessionClient(ApiSessionClient, 'fixture-token', sessionFixture, {
            metadataAuthority: { kind: 'owner', credentials: { token: 'fixture-token', encryption: null } },
        });
        // This synthetic third-party Agent boundary supplies native identity and
        // presentation only. Any accidental turn submission fails, not a model call.
        const noTurn = () => { throw new Error('Unexpected turn in zero-turn presentation'); };
        const runtime: RuntimeTurnOperations = {
            beginTurnLifecycle: noTurn, sendTurnPrompt: async () => noTurn(),
            steerInFlightTurn: async () => noTurn(), waitForTurnCompletion: async () => noTurn(),
            subscribeRuntimeEvents: () => () => {}, cancelTurn: async () => {},
            readSessionIdentity: () => ({ sessionId: 'native-one' }),
            updateSessionRuntimeConfig: async () => {}, resetOrDisposeRuntime: async () => {},
            prepareTerminalPresentation: async () => ({ kind: 'provider_attach', metadata: { path: root } }),
        };
        const attach = createProviderCliAttachSurface({
            agentId: 'opencode', resolveTarget: () => ({ ok: true, value: { nativeId: 'native-one' } }),
            createArgs: target => [target.nativeId],
            resolveLaunchSpec: () => ({ source: 'managed', resolvedPath: process.execPath, command: process.execPath,
                args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid,args:process.argv.slice(1)}));setInterval(()=>{},1000)`] }),
        });
        binding = createNativeAgentProviderAttachModeBinding({ runtime, attach, session,
            agentId: 'opencode', topology: 'shared', remoteWritable: true, startingMode: 'remote',
            // Only the daemon HTTP notification is substituted; the real report
            // owner still receives and settles the published metadata.
            reportSessionMetadataToDaemon: opts => reportSessionToDaemonIfRunning(opts, {
                notifyDaemonSessionStartedFn: async () => ({ status: 'ok' }),
            }),
        });
        if (restoredPreparation === false) {
            let remoteEnded = false;
            const remote = binding.terminalRemoteModeLoop.runRemote().then(() => { remoteEnded = true; });
            try {
                await binding.runtime.resetOrDisposeRuntime('session_closed', { kind: 'create' });
                await new Promise<void>(resolve => setImmediate(resolve));
                expect(remoteEnded).toBe(false);
            } finally {
                await binding.runtime.resetOrDisposeRuntime('session_closed');
                await remote;
            }
            // This binding was finally disposed; subsequent presentation checks
            // belong to a fresh Session-scoped binding.
            binding = createNativeAgentProviderAttachModeBinding({ runtime, attach, session,
                agentId: 'opencode', topology: 'shared', remoteWritable: true, startingMode: 'remote',
                reportSessionMetadataToDaemon: opts => reportSessionToDaemonIfRunning(opts, {
                    notifyDaemonSessionStartedFn: async () => ({ status: 'ok' }),
                }),
            });
        }
        if (restoredPreparation) {
            await expect(session.rpcHandlerManager.invokeLocal('session.providerCliAttach.prepare.v1', {
                providerSessionId: 'native-one',
            })).resolves.toMatchObject({ ok: true, providerSessionId: 'native-one' });
            await expect(session.rpcHandlerManager.invokeLocal('session.providerCliAttach.prepare.v1', {
                providerSessionId: 'native-one', terminalClient: { attached: true },
            })).resolves.toMatchObject({ ok: false });
            await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
            expect(session.getAgentStateSnapshot()?.localControl?.attached).not.toBe(true);
        }
        if (hasExternalClient) {
            // This native process already occupies the restored foreground. The
            // real mode must admit it rather than launch a second presentation.
            const prepared = await attach.prepareInvocation({ sessionId: session.sessionId, metadata: { path: root } });
            expect(prepared.ok).toBe(true);
            if (!prepared.ok) throw new Error(prepared.message);
            let enterTerminal!: () => void;
            const terminalEntered = new Promise<void>(resolve => { enterTerminal = resolve; });
            terminal = binding.terminalRemoteModeLoop.runRemote().then(async disposition => {
                if (disposition !== 'switch') return { type: 'exit' as const, code: 0 };
                enterTerminal();
                return await binding!.terminalRemoteModeLoop.runTerminal({ entry: 'switch' });
            });
            let resolveObserved!: (observed: boolean) => void;
            const observed = new Promise<boolean>(resolve => { resolveObserved = resolve; });
            const observe = async (request: ReturnType<typeof SessionProviderCliAttachPrepareRequestV1Schema.parse>) => {
                let enterProof!: () => void;
                let releaseProof!: () => void;
                const proofEntered = new Promise<void>(resolve => { enterProof = resolve; });
                const proofReleased = new Promise<void>(resolve => { releaseProof = resolve; });
                if (request.terminalClient?.attached) {
                    const launcher = request.terminalClient.launcher;
                    let native!: { pid: number; args: string[] };
                    await vi.waitFor(async () => { native = JSON.parse(await readFile(marker, 'utf8')); }, { timeout: task.timeout });
                    externalNativePid = native.pid;
                    if (restoredPreparation === 'concurrent' || restoredPreparation === 'concurrent-detach') api.beforeResponse.set('pane.process_info', async () => {
                        enterProof(); await proofReleased;
                    });
                    api.responses.set('pane.process_info', () => ({ process_info: { shell_pid: process.pid,
                        foreground_processes: [
                            { pid: launcher.pid, argv: [process.execPath, 'terminal_launch_spec_runner.cjs'] },
                            { pid: native.pid, argv: [prepared.value.invocation.command, ...prepared.value.invocation.args] },
                        ] } }));
                }
                const admission = session!.rpcHandlerManager.invokeLocal('session.providerCliAttach.prepare.v1', request);
                let concurrentSwitch: Promise<unknown> | undefined;
                let concurrentDetach: Promise<unknown> | undefined;
                if ((restoredPreparation === 'concurrent' || restoredPreparation === 'concurrent-detach') && request.terminalClient?.attached) {
                    await proofEntered;
                    concurrentSwitch = session!.rpcHandlerManager.invokeLocal('switch', { to: 'local' });
                    await terminalEntered;
                    if (restoredPreparation === 'concurrent-detach') {
                        concurrentDetach = session!.rpcHandlerManager.invokeLocal('switch', { to: 'remote' });
                    }
                    releaseProof();
                }
                const result = await admission;
                if (concurrentSwitch) await expect(concurrentSwitch).resolves.toBe(restoredPreparation !== 'concurrent-detach');
                if (concurrentDetach) {
                    await expect(concurrentDetach).resolves.toBe(true);
                    resolveObserved(false);
                    return result;
                }
                if (restoredPreparation === 'unbound' && request.terminalClient?.attached) {
                    expect(result).toMatchObject({ ok: false, errorCode: 'retired_placement_unavailable' });
                    resolveObserved(false);
                    return result;
                }
                expect(result).toMatchObject({ ok: true, providerSessionId: 'native-one' });
                if (request.terminalClient?.attached) resolveObserved(true);
                return result;
            };
            if (restoredPreparation === 'command') {
                const developmentRoots = createDaemonPluginDevelopmentRootsOwner({ happyHomeDir: root,
                    submitObservation: async () => { throw new Error('Unexpected source observation during registry admission'); } });
                const registry = await resolveExecutablePluginRuntimeRegistry({ happyHomeDir: root, generation: 1,
                    resolveDevelopmentSourceAuthority: developmentRoots.resolveDevelopmentSourceAuthority });
                const admission = await pluginReloadController.adoptPreparedRuntimeRegistry({ registry,
                    changedPluginIds: [], durableRevision: 1, runningSessionDisposition: 'retainRunningSessions' });
                expect(admission.ok).toBe(true);
                await expect(getSessionHostBridge().evaluateAttachEligibility({
                    credentials: { token: 'fixture-token', encryption: null },
                    rawSession: V2SessionByIdResponseSchema.parse({ session: serverRow }).session,
                    accountEncryptionMode: 'plain', currentMachineId: 'machine-local',
                    localAttachmentInfo: null, insideTmux: false,
                })).resolves.toMatchObject({ eligible: true, attachStrategy: 'managed_provider_attach', attachScope: 'local' });
                runnerLock = await acquireSessionRunnerLock({ sessionId: session.sessionId });
                expect(runnerLock.ok).toBe(true);
                // The relay/socket is external. The public command still encodes
                // its canonical session-control authorization and strict input.
                transport.io.mockImplementation(() => createApiSessionSocketStub({
                    emitWithAck: async (event, payload) => {
                        expect(event).toBe(SOCKET_RPC_EVENTS.CALL);
                        const call = payload as { method: string; params: unknown; authorization: { kind: string; sessionId: string } };
                        expect(call.method).toBe(`${session!.sessionId}:session.providerCliAttach.prepare.v1`);
                        expect(call.authorization).toMatchObject({ kind: SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_WRITE, sessionId: session!.sessionId });
                        return { ok: true, result: await observe(SessionProviderCliAttachPrepareRequestV1Schema.parse(call.params)) };
                    },
                }));
                let nativeExitCode: number | undefined;
                const publicExit = Object.assign(new Error('Public Attach exited'), { code: 0 });
                const exitBoundary = vi.spyOn(process, 'exit').mockImplementation(code => {
                    publicExit.code = typeof code === 'number' ? code : Number(code);
                    throw publicExit;
                });
                restoreExitBoundary = () => exitBoundary.mockRestore();
                const command = handleAttachCommand([session.sessionId], {
                    readCredentialsFn: async () => ({ token: 'fixture-token', encryption: null }),
                    readSettingsFn: async () => ({ schemaVersion: SUPPORTED_SCHEMA_VERSION, onboardingCompleted: true, machineId: 'machine-local' }),
                    fetchSessionByIdFn: async () => V2SessionByIdResponseSchema.parse({ session: serverRow }).session,
                    getAccountEncryptionCurrentnessFn: async () => createAccountEncryptionCurrentnessFixture(),
                    terminalRuntime: { mode: 'herdr', herdrSessionName: 'work', herdrSocketPath: api.socketPath,
                        herdrPaneId: 'managed', herdrTerminalId: 'terminal_1' },
                    // This synthetic executable is an external Agent boundary,
                    // not a replacement for first-party catalog/policy selection.
                    runProviderAttachFn: async request => {
                        expect(request.managedObservation).toBeDefined();
                        if (!request.managedObservation) throw new Error('Managed observation was lost at public Attach');
                        const result = await attachObservedNativeClient({ surface: attach,
                            request: { sessionId: request.sessionId, metadata: request.metadata, signal: externalAbort.signal },
                            ...request.managedObservation });
                        nativeExitCode = result.ok && typeof result.value.exitCode === 'number' ? result.value.exitCode : 1;
                        return nativeExitCode;
                    },
                });
                externalAttach = command.then(() => ({ ok: true as const, value: { exitCode: 0 } }), error => {
                    if (error !== publicExit) throw error;
                    expect(publicExit.code).toBe(nativeExitCode);
                    return { ok: true as const, value: { exitCode: publicExit.code } };
                });
            } else externalAttach = attachObservedNativeClient({ surface: attach,
                request: { sessionId: session.sessionId, metadata: { path: root }, signal: externalAbort.signal },
                providerSessionId: 'native-one',
                herdr: { sessionName: 'work', socketPath: api.socketPath, paneId: 'managed', terminalId: 'terminal_1' },
                observe,
            });
            if (restoredPreparation === 'unbound' || restoredPreparation === 'concurrent-detach') {
                await expect(Promise.race([observed, externalAttach.then(() => false)])).resolves.toBe(false);
                expect(session.getAgentStateSnapshot()?.localControl?.attached).not.toBe(true);
                await expect(externalAttach).resolves.toMatchObject({ ok: false });
                expect(await readTerminalHostAttachmentInfo({ happyHomeDir: root, sessionId: session.sessionId })).toBeNull();
                expect(() => process.kill(externalNativePid!, 0)).toThrow();
                expect(api.panes.has('managed')).toBe(true);
                return;
            }
            await expect(Promise.race([observed, externalAttach.then(() => false)])).resolves.toBe(true);
        } else terminal = binding.terminalRemoteModeLoop.runTerminal({ entry: 'initial' });
        let child!: { pid: number; args: string[] };
        await vi.waitFor(async () => {
            child = JSON.parse(await readFile(marker, 'utf8'));
            expect(session!.getAgentStateSnapshot()?.localControl).toMatchObject({ attached: true, canDetach: true, remoteWritable: true });
        }, { timeout: task.timeout });
        expect(child.args).toEqual(['native-one']);
        if (hasExternalClient) {
            expect(externalNativePid).toBe(child.pid);
            expect(await readTerminalHostAttachmentInfo({ happyHomeDir: root, sessionId: session.sessionId })).toMatchObject({
                version: 3, lifecycle: 'borrowed', nativeClientProcess: { pid: expect.any(Number) },
                handle: { terminalId: 'terminal_1', paneId: 'managed' },
            });
        }
        expect(await session.rpcHandlerManager.invokeLocal('switch', { to: 'remote' })).toBe(true);
        await expect(terminal).resolves.toMatchObject({ type: 'switch' });
        if (externalAttach) await expect(externalAttach).resolves.toMatchObject({ ok: true });
        expect(session.getAgentStateSnapshot()?.localControl).toMatchObject({ attached: false, canDetach: false, remoteWritable: true });
        expect(() => process.kill(child.pid, 0)).toThrow();
        expect(session.sessionId).toBe('native-presentation-session');
        expect(runtime.readSessionIdentity().sessionId).toBe('native-one');
        if (hasExternalClient) {
            expect(api.panes.has('managed')).toBe(true);
            expect(api.requests.some(request => request.method === 'pane.close')).toBe(false);
            expect(await readTerminalHostAttachmentInfo({ happyHomeDir: root, sessionId: session.sessionId })).toBeNull();
        }
    } finally {
        await binding?.runtime.resetOrDisposeRuntime();
        externalAbort.abort();
        await Promise.allSettled([externalAttach, terminal]);
        await session?.close();
        if (runnerLock?.ok) await runnerLock.release();
        if (restoredPreparation === 'command') await pluginReloadController.shutdown();
        restoreExitBoundary?.();
        vi.unstubAllGlobals(); vi.restoreAllMocks(); transport.io.mockReset();
        Object.assign(configuration, { happyHomeDir: previousHome });
        await rm(root, { recursive: true, force: true });
    }
  });
});
