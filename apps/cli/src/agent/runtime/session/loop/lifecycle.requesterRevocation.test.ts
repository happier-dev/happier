import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { AgentSessionRuntime, AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';
import { AgentSessionRuntimeEventSchema } from '@happier-dev/protocol/runtime/agentSessionV1';
import { createNativeAgentSessionOperations } from '@/agent/runtime/registry/engineRegistry/nativeAgentSession';
import { createAcpSessionRuntimeContextFixture } from '@/agent/acp/testkit/runtimeContextFixture';
import { createPublicAcpRuntimeProtocols } from '@/agent/acp/runtime/publicSession/createPublicAcpRuntimeProtocols';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import { readAgentCatalogSnapshot } from '@/agent/catalog/snapshot';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { getResolvedContributionRegistry } from '@/plugins/projection/registry/builtIn/snapshot';
import { runPermissionModePromptLoop } from '@/agent/runtime/runPermissionModePromptLoop';
import { cleanupBackendRunResources } from '@/agent/runtime/cleanupBackendRunResources';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { combinePermissionModeQueuedPrompts, type PermissionModeQueuedPrompt, type PermissionModeQueuedPromptMode } from '@/agent/runtime/permissions/queuedPrompt';
import { installEmptyProjectAccountRowsHttpBoundary } from '@/testkit/http/projectAccountRows';
import { registerRunnerTerminationHandlers } from '@/agent/runtime/lifecycle/runnerTerminationHandlers';
import { bindRequesterSessionCredentialScope } from '@/persistence';
import { createRequesterSessionCredentialCustody } from '@/daemon/sessionEncryption/requesterSessionCredentials';
import { createOnChildExited } from '@/daemon/sessions/onChildExited';
import type { TrackedSession } from '@/daemon/types';
import { reloadConfiguration } from '@/configuration';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createLifecycleParams } from './lifecycle.testkit';
import { runSessionLoopLifecycle } from './lifecycle';
import { legacyPidSessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';

it('finishes the admitted requester turn, then exits and retires its credential after a refused reconnect', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-requester-revocation-'));
    const environment = createEnvKeyScope(['HAPPIER_HOME_DIR']);
    environment.patch({ HAPPIER_HOME_DIR: directory });
    reloadConfiguration();
    const restoreHttp = installEmptyProjectAccountRowsHttpBoundary();
    const registry = await pluginReloadController.acquireRuntimeRegistry({ resolveRuntimeRegistry: async () =>
        resolveExecutablePluginRuntimeRegistry({ contributes: getResolvedContributionRegistry(), pluginIds: [] }) });
    const base = createLifecycleParams({ runPermissionModePromptLoopFn: runPermissionModePromptLoop });
    const attribution = { serverId: 'home', accountId: 'bob', machineId: 'machine', installationId: 'installation' };
    const credentials = bindRequesterSessionCredentialScope({ token: 'requester-fixture', encryption: null }, {
        serverId: 'home', serverHttpBaseUrl: 'https://home.test', requesterSession: { sessionId: 'session-1', attribution },
    });
    const custody = await createRequesterSessionCredentialCustody({ happyHomeDir: directory, sessionId: 'session-1', attribution, credentials });
    const queue = new MessageQueue2<PermissionModeQueuedPromptMode, PermissionModeQueuedPrompt>(
        mode => JSON.stringify(mode), { batcher: combinePermissionModeQueuedPrompts });
    queue.push({ text: 'Finish this turn', localId: 'admitted-input', userMessageSeq: 1 }, { permissionMode: 'default' });
    // The Home's socket state and the native Agent are the substituted external
    // boundaries; the prompt loop, runtime adapter and private custody stay real.
    const connection = new EventEmitter();
    const session = Object.assign(base.session, {
        subscribeToSessionConnectionState(listener: (state: { phase: string }) => void) {
            connection.on('state', listener);
            return () => { connection.off('state', listener); };
        },
    });
    const declaration = readAgentCatalogSnapshot().agentDefinitionsById.get('codex');
    if (!declaration?.richDefinition || !declaration.pluginId) throw new Error('Missing Agent declaration');
    const scope = new AbortController();
    const services = createUnavailablePluginServices();
    const context = createAcpSessionRuntimeContextFixture({ agent: declaration.richDefinition.definition,
        pluginId: declaration.pluginId, sessionId: 'session-1', directory, signal: scope.signal, session, services,
        protocols: createPublicAcpRuntimeProtocols({ pluginId: declaration.pluginId, agentId: 'codex',
            signal: scope.signal, isCurrent: () => !scope.signal.aborted, services }) });
    let listener: ((event: AgentSessionRuntimeEvent) => void) | undefined;
    let turnId = '';
    let sequence = 0;
    let disposed = false;
    const emit = (event: Record<string, unknown>) => listener!(AgentSessionRuntimeEventSchema.parse({
        sequence: ++sequence, sessionId: 'session-1', emittedAtMs: Date.now(), ...event }));
    const native: AgentSessionRuntime = {
        async send(request) {
            turnId = request.delivery.turnId;
            emit({ kind: 'input-accepted', inputIds: request.inputIds, delivery: request.delivery });
            emit({ kind: 'turn-start', turnId, startedBy: 'host' });
            return { status: 'admitted' };
        },
        watch(value) { listener = value; return { dispose() { listener = undefined; } }; },
        dispose() { disposed = true; },
    };
    const runtime = createNativeAgentSessionOperations(native, 'session-1', undefined, undefined, undefined, undefined, undefined, {
        context: context.context, cwd: directory, connectedAccounts: [],
        capabilities: { open: ['create'], delivery: ['newTurn'], cancel: false },
        cancellation: { declared: false }, configuration: { declared: false }, compaction: { capability: null },
    });
    let termination: ReturnType<typeof registerRunnerTerminationHandlers> | undefined;
    let finished = false;
    const running = runSessionLoopLifecycle({ ...base, session, runtime, hookRuntime: runtime,
        opts: { ...base.opts, credentials }, runtimeMetadata: { ...base.runtimeMetadata, happyHomeDir: directory },
        permissionModeState: { ...base.permissionModeState, messageQueue: queue },
        config: { ...base.config, startRuntimeBeforeFirstPrompt: true },
        deps: { ...base.deps, cleanupBackendRunResourcesFn: cleanupBackendRunResources,
            registerRunnerTerminationHandlersFn: options => {
                termination = registerRunnerTerminationHandlers({ ...options, process: new EventEmitter(),
                    processLifecycleOwnership: 'caller', sessionExitReport: null, exit() {} });
                return termination;
            } },
    }).then(() => { finished = true; });
    try {
        await vi.waitFor(() => expect(turnId).not.toBe(''));
        connection.emit('state', { phase: 'offline' });
        expect(disposed).toBe(false);
        connection.emit('state', { phase: 'auth_failed' });
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(finished).toBe(false);
        expect(disposed).toBe(false);
        await expect(access(custody.path)).resolves.toBeUndefined();
        emit({ kind: 'turn-complete', turnId });
        await vi.waitFor(() => expect(finished).toBe(true));
        await running;
        expect(disposed).toBe(true);
        expect(base.session.close).toHaveBeenCalled();
        // The daemon receives the runner's clean OS exit only after the host
        // loop settles. It owns private-file retirement and replacement custody.
        const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
        const pid = child.pid;
        if (pid === undefined) throw new Error('Missing runner process fixture');
        const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
            child.once('error', reject);
            child.once('exit', (code, signal) => resolve({ code, signal }));
        });
        const tracked: TrackedSession = { trackingKey: legacyPidSessionTrackingKey(pid), pid, happySessionId: 'session-1', startedBy: 'daemon', requesterWorkAttributionV1: attribution };
        const onChildExited = createOnChildExited({ trackedSessionsByKey: new Map([[tracked.trackingKey, tracked]]),
            spawnResourceCleanupByKey: new Map(), sessionAttachCleanupByKey: new Map(), getApiMachineForSessions: () => null });
        await onChildExited(pid, { reason: 'process-exited', ...exit });
        await expect(access(custody.path)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(connection.listenerCount('state')).toBe(0);
    } finally {
        if (!finished) termination?.requestTermination({ kind: 'signal', signal: 'SIGTERM' });
        await running;
        scope.abort();
        await context.dispose();
        registry.release();
        restoreHttp();
        vi.restoreAllMocks();
        environment.restore();
        reloadConfiguration();
        await rm(directory, { recursive: true, force: true });
    }
});
