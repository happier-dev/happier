import { readFile } from 'node:fs/promises';

import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SPAWN_SESSION_ERROR_CODES } from '@/session/shared/spawnSessionContract';
import { describe, expect, it, vi } from 'vitest';

import type { RpcActionExecutor } from './_actionDispatchAdapter';
import type { RpcHandler, RpcHandlerRegistrar } from '@/api/rpc/types';
import {
    createSessionLifecycleRpcActionExecutor,
    registerPrivateSpawnSessionRpcHandlers,
    registerSessionLifecycleRpcHandlers,
} from './sessionLifecycle';

function createRpcHarness() {
    const handlers = new Map<string, RpcHandler>();
    const rpcHandlerManager: RpcHandlerRegistrar = {
        registerHandler(method, handler) {
            handlers.set(method, handler);
        },
    };
    return {
        handlers,
        rpcHandlerManager,
    };
}

function readExpectedDefaultSessionId(input: unknown): string | undefined {
    if (!input || typeof input !== 'object') {
        return undefined;
    }
    const parentSessionId = Reflect.get(input, 'parentSessionId');
    const sessionId = Reflect.get(input, 'sessionId');
    const value = parentSessionId ?? sessionId;
    return typeof value === 'string' ? value : undefined;
}

const SESSION_LIFECYCLE_RPC_CASES = [
    [RPC_METHODS.STOP_SESSION, 'session.stop', { sessionId: 'session-1' }],
    [RPC_METHODS.SESSION_FORK, 'session.fork', { parentSessionId: 'session-1', forkPoint: { type: 'latest' } }],
    [RPC_METHODS.SESSION_FORK_PROVIDER_SAFE, 'session.fork', { parentSessionId: 'session-1', forkPoint: { type: 'latest' } }],
    [RPC_METHODS.SESSION_CONTINUE_WITH_REPLAY, 'session.continue_with_replay', { directory: '/tmp/project', backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' }, replay: { seedDraft: 'continue' } }],
    [SESSION_RPC_METHODS.SESSION_ROLLBACK, 'session.rollback', { sessionId: 'session-1', targetMessageId: 'message-1' }],
    [SESSION_RPC_METHODS.SESSION_CHECKPOINT_CODE_ROLLBACK, 'session.checkpoint_code_rollback', {
        v: 1,
        sessionId: 'session-1',
        turnId: 'turn-1',
        cwd: '/tmp/project',
        codeMode: 'conversation_and_code_without_stash',
        backupMode: 'happier_checkpoint_only',
        expectedStartRef: 'refs/happier/checkpoints/c2Vzc2lvbi0x/turn-start/turn-1',
        expectedFinalRef: 'refs/happier/checkpoints/c2Vzc2lvbi0x/turn-final/turn-1',
    }],
    [SESSION_RPC_METHODS.SESSION_CHECKPOINT, 'session.checkpoint', {
        v: 1,
        sessionId: 'session-1',
        scopes: ['workspace'],
        candidate: {
            source: 'happier_scm',
        },
    }],
    [SESSION_RPC_METHODS.SESSION_RESTORE, 'session.restore', {
        v: 1,
        sessionId: 'session-1',
        scopes: ['workspace'],
        candidate: {
            source: 'happier_scm',
            checkpointRef: 'refs/happier/checkpoints/scope/turn-final/turn-1',
        },
        confirmation: { sourceChoiceConfirmed: true },
    }],
    [RPC_METHODS.DAEMON_SESSION_HANDOFF_START, 'session.handoff', { sessionId: 'session-1', sourceMachineId: 'machine-1', targetMachineId: 'machine-2', preferredTransportStrategies: ['server_routed_stream'] }],
    [RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET, 'session.handoff.prepare_target', { handoffId: 'handoff-1', sessionId: 'session-1', sourceMachineId: 'machine-1', targetMachineId: 'machine-2' }],
    [RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESUME_V3, 'session.handoff.prepare_target.resume', { handoffId: 'handoff-1', jobId: 'prepare_handoff-1', expectedRevision: 2, attemptId: 'attempt-1' }],
    [RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET, 'session.handoff.prepare_target_result.get', { handoffId: 'handoff-1' }],
    [RPC_METHODS.DAEMON_SESSION_HANDOFF_COMMIT, 'session.handoff.commit', { handoffId: 'handoff-1' }],
    [RPC_METHODS.DAEMON_SESSION_HANDOFF_ABORT, 'session.handoff.abort', { handoffId: 'handoff-1' }],
    [RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET, 'session.handoff.status.get', { handoffId: 'handoff-1' }],
] as const;

describe('session lifecycle RPC handlers', () => {
    it('forwards the transport cancellation context to the handoff action handler', async () => {
        const handoff = vi.fn(async () => ({ ok: false, errorCode: 'cancelled' }));
        const executor = createSessionLifecycleRpcActionExecutor({
            'session.handoff': handoff,
        });
        const controller = new AbortController();
        const input = { sessionId: 'session-1' };

        await executor.execute(
            'session.handoff',
            input,
            { surface: 'rpc', signal: controller.signal },
        );

        expect(handoff).toHaveBeenCalledWith(input, {
            signal: controller.signal,
        });
    });

    it('does not own a static RPC binding table', async () => {
        const source = await readFile(new URL('./sessionLifecycle.ts', import.meta.url), 'utf8');

        expect(source).not.toContain('SESSION_LIFECYCLE_RPC_BINDINGS');
    });

    it('dispatches lifecycle RPC methods through the ActionSpec adapter', async () => {
        const module = await import('./sessionLifecycle').catch(() => null);
        expect(module).not.toBeNull();
        if (!module) return;
        const calls: unknown[] = [];
        const actionExecutor: RpcActionExecutor = {
            execute: async (actionId, input, context) => {
                calls.push({ actionId, input, context });
                return { ok: true, result: { ok: true, actionId } };
            },
        };
        const { handlers, rpcHandlerManager } = createRpcHarness();

        module.registerSessionLifecycleRpcHandlers({
            rpcHandlerManager,
            actionExecutor,
        });

        for (const [method, actionId, input] of SESSION_LIFECYCLE_RPC_CASES) {
            await expect(handlers.get(method)?.(input)).resolves.toEqual({ ok: true, actionId });
        }

        expect(calls).toEqual(SESSION_LIFECYCLE_RPC_CASES.map(([, actionId, input]) => {
            const defaultSessionId = readExpectedDefaultSessionId(input);
            return {
                actionId,
                input,
                context: {
                    ...(typeof defaultSessionId === 'string' ? { defaultSessionId } : {}),
                    surface: 'rpc',
                },
            };
        }));
        expect(handlers.has(RPC_METHODS.SPAWN_HAPPY_SESSION)).toBe(false);
        expect(handlers.has(RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE)).toBe(false);
    });

    it('routes strict public Session creation through the ActionSpec bridge and preserves cancellation', async () => {
        const { handlers, rpcHandlerManager } = createRpcHarness();
        const rawSpawnLifecycleHandler = vi.fn(async () => ({ type: 'success' as const, sessionId: 'private-session-1' }));
        const execute = vi.fn<RpcActionExecutor['execute']>(async () => ({
                ok: true,
                result: {
                    type: 'success' as const,
                    disposition: 'created' as const,
                    sessionId: 'session-1',
                    executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
                    organizationPlacement: { folderId: null, tagIds: [] },
                    initialInput: { status: 'notRequested' as const },
                },
            }));
        const actionExecutor: RpcActionExecutor = {
            execute,
        };
        const input = {
            creationKey: 'manual:create-1',
            executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
            directory: '/tmp/project',
            organizationPlacement: { folderId: null, tagIds: [] },
            agentTarget: {
                kind: 'agent' as const,
                identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
            },
        };
        const controller = new AbortController();

        registerPrivateSpawnSessionRpcHandlers({
            rpcHandlerManager,
            spawnLifecycleHandler: rawSpawnLifecycleHandler,
        });
        registerSessionLifecycleRpcHandlers({
            rpcHandlerManager,
            actionExecutor,
            scopes: [{ id: 'session.spawn_new', methods: [RPC_METHODS.SESSION_SPAWN_NEW] }],
        });

        const handler = handlers.get(RPC_METHODS.SESSION_SPAWN_NEW);
        expect(handler).toEqual(expect.any(Function));
        if (!handler) return;

        await expect(handler(input, { signal: controller.signal })).resolves.toEqual({
            type: 'success',
            disposition: 'created',
            sessionId: 'session-1',
            executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
            organizationPlacement: { folderId: null, tagIds: [] },
            initialInput: { status: 'notRequested' },
        });
        expect(actionExecutor.execute).toHaveBeenCalledWith(
            'session.spawn_new',
            input,
            { surface: 'rpc', signal: controller.signal },
        );
        expect(rawSpawnLifecycleHandler).not.toHaveBeenCalled();

        await expect(handler({ ...input, tag: 'legacy-label' }, { signal: controller.signal })).resolves.toEqual({
            ok: false,
            errorCode: 'invalid_action_transport_input',
            error: 'invalid_action_transport_input',
        });
        expect(actionExecutor.execute).toHaveBeenCalledTimes(1);
        expect(rawSpawnLifecycleHandler).not.toHaveBeenCalled();
    });

  it('maps action dispatch failures to the legacy RPC error envelope', async () => {
        const module = await import('./sessionLifecycle').catch(() => null);
        expect(module).not.toBeNull();
        if (!module) return;
        const { handlers, rpcHandlerManager } = createRpcHarness();

        module.registerSessionLifecycleRpcHandlers({
            rpcHandlerManager,
            actionExecutor: {
                execute: async () => ({
                    ok: false,
                    errorCode: 'invalid_parameters',
                    error: 'invalid_parameters',
                }),
            },
        });

        await expect(handlers.get(RPC_METHODS.STOP_SESSION)?.({ sessionId: 'session-1' })).resolves.toEqual({
            ok: false,
            errorCode: 'invalid_parameters',
            error: 'invalid_parameters',
    });
  });

  it('routes fresh raw machine spawn through its lifecycle owner and settles only the primary transport', async () => {
    const { handlers, rpcHandlerManager } = createRpcHarness();
    const spawnLifecycleHandler = vi.fn(async () => ({
      type: 'success' as const,
      spawnNonce: 'spawn-nonce-1',
      sessionIdStatus: 'pending' as const,
    }));
    const resolveSpawnSessionByNonce = vi.fn(async () => ({
      status: 'success' as const,
      sessionId: 'session-1',
    }));

    registerPrivateSpawnSessionRpcHandlers({
      rpcHandlerManager,
      spawnLifecycleHandler,
      resolveSpawnSessionByNonce,
    });

    const input = {
      type: 'spawn-in-directory' as const,
      directory: '/tmp/project',
      spawnNonce: 'spawn-nonce-1',
      backendTarget: { kind: 'backend' as const, backendId: 'codex', sourceKind: 'built_in' as const },
    };
    await expect(
      handlers.get(RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE)?.(input),
    ).resolves.toEqual({
      type: 'success',
      spawnNonce: 'spawn-nonce-1',
      sessionIdStatus: 'pending',
    });
    await expect(
      handlers.get(RPC_METHODS.SPAWN_HAPPY_SESSION)?.(input),
    ).resolves.toEqual({
      type: 'success',
      sessionId: 'session-1',
    });
    expect(spawnLifecycleHandler).toHaveBeenCalledWith(expect.objectContaining({
      type: 'spawn-in-directory',
      directory: '/tmp/project',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
    }));
    expect(resolveSpawnSessionByNonce).toHaveBeenCalledWith('spawn-nonce-1');
  });

  it('preserves raw resume success on both private spawn transports without nonce settlement', async () => {
    const { handlers, rpcHandlerManager } = createRpcHarness();
    const spawnLifecycleHandler = vi.fn(async () => ({ type: 'success' as const }));
    const resolveSpawnSessionByNonce = vi.fn(async () => ({
      status: 'success' as const,
      sessionId: 'unexpected-session-id',
    }));

    registerPrivateSpawnSessionRpcHandlers({
      rpcHandlerManager,
      spawnLifecycleHandler,
      resolveSpawnSessionByNonce,
    });

    const input = {
      type: 'resume-session' as const,
      sessionId: 'session-1',
      directory: '/tmp/project',
      backendTarget: { kind: 'backend' as const, backendId: 'codex', sourceKind: 'built_in' as const },
    };
    await expect(handlers.get(RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE)?.(input)).resolves.toEqual({
      type: 'success',
    });
    await expect(handlers.get(RPC_METHODS.SPAWN_HAPPY_SESSION)?.(input)).resolves.toEqual({
      type: 'success',
    });
    expect(spawnLifecycleHandler).toHaveBeenCalledWith(expect.objectContaining({
      type: 'resume-session',
      sessionId: 'session-1',
    }));
    expect(resolveSpawnSessionByNonce).not.toHaveBeenCalled();
  });

  it('rejects malformed raw private spawn input before it reaches the lifecycle owner', async () => {
    const { handlers, rpcHandlerManager } = createRpcHarness();
    const spawnLifecycleHandler = vi.fn(async () => ({ type: 'success' as const }));

    registerPrivateSpawnSessionRpcHandlers({
      rpcHandlerManager,
      spawnLifecycleHandler,
    });

    await expect(handlers.get(RPC_METHODS.SPAWN_HAPPY_SESSION)?.({
      type: 'not-a-real-spawn',
      directory: '/tmp/project',
    })).resolves.toEqual({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
      errorMessage: 'Invalid session spawn request',
    });
    expect(spawnLifecycleHandler).not.toHaveBeenCalled();
  });

  it('rejects tag-only and synthetic V2 private spawn input before it reaches the lifecycle owner', async () => {
    const { handlers, rpcHandlerManager } = createRpcHarness();
    const spawnLifecycleHandler = vi.fn(async () => ({ type: 'success' as const }));

    registerPrivateSpawnSessionRpcHandlers({
      rpcHandlerManager,
      spawnLifecycleHandler,
    });

    const privateSpawn = {
      type: 'spawn-in-directory' as const,
      directory: '/tmp/project',
      backendTarget: { kind: 'backend' as const, backendId: 'codex', sourceKind: 'built_in' as const },
    };
    const handler = handlers.get(RPC_METHODS.SPAWN_HAPPY_SESSION);

    await expect(handler?.({ ...privateSpawn, tag: 'legacy-label' })).resolves.toEqual({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
      errorMessage: 'Invalid session spawn request',
    });
    await expect(handler?.({
      ...privateSpawn,
      tag: 'legacy-label',
      creationKey: 'create:feature-1',
      executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
      agentTarget: { kind: 'agent', agentId: 'codex' },
    })).resolves.toEqual({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
      errorMessage: 'Invalid session spawn request',
    });

    expect(spawnLifecycleHandler).not.toHaveBeenCalled();
  });

  it('keeps lifecycle RPC direct registration out of legacy machine registrar files', async () => {
        const sources = await Promise.all([
            readFile(new URL('../../api/machine/rpcHandlers.ts', import.meta.url), 'utf8'),
            readFile(new URL('../../api/machine/rpcHandlers.sessions.ts', import.meta.url), 'utf8'),
            readFile(new URL('../../api/machine/sessionHandoff/handlers.ts', import.meta.url), 'utf8'),
            readFile(new URL('../../api/machine/sessionHandoff/start.ts', import.meta.url), 'utf8'),
            readFile(new URL('../../api/machine/sessionHandoff/prepareTarget.ts', import.meta.url), 'utf8'),
            readFile(new URL('../../api/machine/sessionHandoff/prepareTargetResultGet.ts', import.meta.url), 'utf8'),
            readFile(new URL('../../api/machine/sessionHandoff/commit.ts', import.meta.url), 'utf8'),
            readFile(new URL('../../api/machine/sessionHandoff/abort.ts', import.meta.url), 'utf8'),
            readFile(new URL('../../api/machine/sessionHandoff/statusGet.ts', import.meta.url), 'utf8'),
        ]);
        const directLifecycleRegistration = /registerHandler\(RPC_METHODS\.(SPAWN_HAPPY_SESSION|STOP_SESSION|SESSION_FORK|SESSION_CONTINUE_WITH_REPLAY|SESSION_ROLLBACK|SESSION_CHECKPOINT_CODE_ROLLBACK|DAEMON_SESSION_HANDOFF_START|DAEMON_SESSION_HANDOFF_PREPARE_TARGET|DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET|DAEMON_SESSION_HANDOFF_COMMIT|DAEMON_SESSION_HANDOFF_ABORT|DAEMON_SESSION_HANDOFF_STATUS_GET)/;

        expect(sources.some((source) => directLifecycleRegistration.test(source))).toBe(false);
    });
});
