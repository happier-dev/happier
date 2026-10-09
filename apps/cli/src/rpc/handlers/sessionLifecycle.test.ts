import { readFile } from 'node:fs/promises';

import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SessionActionRpcOriginV1Schema } from '@happier-dev/protocol/socketRpc';
import { SPAWN_SESSION_ERROR_CODES } from '@/session/shared/spawnSessionContract';
import { resolveSessionStartupTimeoutMs } from '@/daemon/spawn/waitForSessionWebhook';
import { getSessionHostBridge } from '@/agent/runtime/bridges/session/SessionHostBridge';
import { createForkSessionLifecycleActionHandler } from '@/session/actions/lifecycle/createForkSessionLifecycleActionHandler';
import { createSpawnNewSessionLifecycleActionHandler } from '@/session/actions/lifecycle/createSpawnNewSessionLifecycleActionHandler';
import { createSessionHandoffPrepareTargetJobStore } from '@/session/handoff/prepare/sessionHandoffPrepareTargetJobStore';
import { withTempDir } from '@/testkit/fs/tempDir';
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
    it('admits only the prepared native handoff identity and persists resume custody before physical launch', async () => {
        await withTempDir('handoff-native-resume-custody-', async activeServerDir => {
            const sessionId = `c${'a'.repeat(24)}`;
            const prepareJobStore = createSessionHandoffPrepareTargetJobStore({ activeServerDir });
            const status = { handoffId: 'exact-handoff', jobId: 'prepare_exact-handoff', status: 'ready_for_cutover' as const,
                phase: 'staging_target' as const, recoveryActions: [] };
            await prepareJobStore.write({ jobId: status.jobId, handoffId: status.handoffId, createdAtMs: 1, updatedAtMs: 1, status,
                prepareTargetResult: { handoffId: status.handoffId, status, remoteSessionId: 'native-original',
                    directSource: { kind: 'claudeConfig', configDir: null, projectId: null }, resume: { directory: '/target',
                        agent: 'claude', resume: 'native-original', transcriptStorage: 'persisted', approvedNewDirectoryCreation: true } } });
            const authorization = { v: 1 as const, token: 'verified-native-child', binding: {
                accountId: 'bob', authentication: { kind: 'account' as const, tokenEpoch: 7 }, serverIdentityId: 'srv_home',
                machineId: 'target', custodianAccountId: 'alice', installationId: 'target-installation',
                actionId: 'session.spawn_new', requestId: 'original-request', requestEnvelopeDigest: 'a'.repeat(43),
                target: { kind: 'machine' as const, machineId: 'target' },
                handoffAdmission: { sessionId, sourceMachineId: 'source', targetMachineId: 'target',
                    sourceInstallationId: 'source-installation', targetInstallationId: 'target-installation' },
                handoffContinuation: { handoffId: status.handoffId, rootRequestId: 'original-request', rootRequestEnvelopeDigest: 'b'.repeat(43) },
            } };
            const launches: string[] = [];
            const { handlers, rpcHandlerManager } = createRpcHarness();
            registerPrivateSpawnSessionRpcHandlers({ rpcHandlerManager, handoffTargetResume: { prepareJobStore },
                spawnLifecycleHandler: createSpawnNewSessionLifecycleActionHandler({ spawnSession: async options => {
                    const before = Reflect.get(options, 'beforeSessionRunnerLaunch');
                    if (typeof before === 'function' && !await before()) return { type: 'error',
                        errorCode: SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE, errorMessage: 'Resume custody unavailable' };
                    if (options.resume === 'native-original') {
                        expect(await prepareJobStore.findByHandoffId(status.handoffId)).toMatchObject({ schemaVersion: 2,
                            resume: { status: 'attempted', attemptId: 'admitted-spawn-nonce' } });
                    }
                    launches.push(options.resume ?? 'missing-native');
                    return { type: 'success', sessionId };
                } }) });
            const input = { type: 'resume-session' as const, sessionId, directory: '/target', spawnNonce: 'admitted-spawn-nonce',
                backendTarget: { kind: 'backend' as const, backendId: 'claude', sourceKind: 'built_in' as const },
                resume: 'native-original', transcriptStorage: 'persisted' };
            const context = { signal: new AbortController().signal, callerInputAuthorization: authorization };
            await expect(handlers.get(RPC_METHODS.SPAWN_HAPPY_SESSION)?.({ ...input, resume: 'swapped-native' }, context))
                .resolves.toMatchObject({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST });
            expect(launches).toEqual([]);
            await expect(handlers.get(RPC_METHODS.SPAWN_HAPPY_SESSION)?.(input, context)).resolves.toMatchObject({ type: 'success' });
            expect(launches).toEqual(['native-original']);
            expect(await prepareJobStore.findByHandoffId(status.handoffId)).toMatchObject({ schemaVersion: 2,
                recordKind: 'prepared_target', sessionId, resume: { status: 'attempted', attemptId: input.spawnNonce } });
        });
    });
    it('rejects a handoff child that names another Session before raw resume effects', async () => {
        const { handlers, rpcHandlerManager } = createRpcHarness();
        registerPrivateSpawnSessionRpcHandlers({ rpcHandlerManager,
            spawnLifecycleHandler: createSpawnNewSessionLifecycleActionHandler({
                // Physical runner launch is the system boundary; the lifecycle owner stays real.
                spawnSession: async () => ({ type: 'success', sessionId: `c${'b'.repeat(24)}` }),
            }) });
        const authorization = { v: 1 as const, token: 'verified-child', binding: {
            accountId: 'bob', authentication: { kind: 'account' as const, tokenEpoch: 7 }, serverIdentityId: 'srv_home',
            machineId: 'target', custodianAccountId: 'alice', installationId: 'target-installation',
            actionId: 'session.spawn_new', requestId: 'original-request', requestEnvelopeDigest: 'a'.repeat(43),
            target: { kind: 'machine' as const, machineId: 'target' },
            handoffAdmission: { sessionId: `c${'a'.repeat(24)}`, sourceMachineId: 'source', targetMachineId: 'target',
                sourceInstallationId: 'source-installation', targetInstallationId: 'target-installation' },
            handoffContinuation: { handoffId: 'exact-handoff', rootRequestId: 'original-request',
                rootRequestEnvelopeDigest: 'b'.repeat(43) },
        } };
        await expect(handlers.get(RPC_METHODS.SPAWN_HAPPY_SESSION)?.({ type: 'resume-session',
            sessionId: `c${'b'.repeat(24)}`, directory: '/target',
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } }, resume: 'native-session' },
            { signal: new AbortController().signal, callerInputAuthorization: authorization }))
            .resolves.toMatchObject({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST });
    });
    it('retains the validated source Session origin through both lifecycle adapters without trusting author input', async () => {
        const origin = SessionActionRpcOriginV1Schema.parse({ v: 1,
            requestId: 'request-1', sourceTurnId: 'turn-1', callerPermissionMode: 'read-only',
            caller: { kind: 'session', sessionId: 'source', starterDepth: 1, turnDepth: 2 },
            causalPermissionAuthority: null, workspaceWrites: 'deny' });
        const authorization = { v: 1 as const, token: 'verified-home-root', binding: {
            accountId: 'bob', authentication: { kind: 'account' as const, tokenEpoch: 7 }, serverIdentityId: 'srv_home',
            machineId: 'machine-1', custodianAccountId: 'alice', installationId: 'source-installation',
            actionId: 'session.handoff', requestId: origin.requestId, requestEnvelopeDigest: 'a'.repeat(43),
            target: { kind: 'machine' as const, machineId: 'machine-1' }, sessionActionOrigin: origin,
            sessionActionSource: { machineId: 'machine-1', installationId: 'source-installation' },
        } };
        const { handlers, rpcHandlerManager } = createRpcHarness();
        registerSessionLifecycleRpcHandlers({ rpcHandlerManager,
            actionExecutor: createSessionLifecycleRpcActionExecutor({ 'session.handoff': async (_input, context) => ({
                ok: false,
                errorCode: context?.sessionActionOrigin?.caller.sessionId === 'source'
                    && context.sessionActionOrigin.callerPermissionMode === 'read-only'
                    && context.sessionActionOrigin.workspaceWrites === 'deny'
                    && context.callerInputAuthorization === authorization
                    ? 'origin_preserved' : 'origin_unavailable',
            }) }), actionIds: ['session.handoff'] });
        const input = { sessionId: 'session-1', sourceMachineId: 'machine-1', targetMachineId: 'machine-2',
            preferredTransportStrategies: ['server_routed_stream'] };
        await expect(handlers.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START)?.(input,
            { signal: new AbortController().signal, sessionActionOrigin: origin,
                callerInputAuthorization: authorization })).resolves.toMatchObject({ ok: false, errorCode: 'origin_preserved' });
        await expect(handlers.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START)?.({ ...input,
            sessionActionOrigin: origin }, { signal: new AbortController().signal })).resolves.not.toMatchObject({ errorCode: 'origin_preserved' });
    });

    it('refuses an invalid fork sequence with an explicit context lacking cancellation without OS effects', async () => {
        // The real handler and bridge validate admission; only OS process effects are boundaries.
        const spawnSession = vi.fn(async () => { throw new Error('Invalid forks must not spawn'); });
        const stopSession = vi.fn(async () => { throw new Error('Invalid forks must not stop'); });
        const handler = createForkSessionLifecycleActionHandler({
            sessionHostBridge: getSessionHostBridge(),
            handlers: { spawnSession, stopSession },
        });

        await expect(handler({
            parentSessionId: 'session-1',
            forkPoint: { type: 'seq', upToSeqInclusive: 0 },
        }, {})).resolves.toMatchObject({
            ok: false,
            errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
        });
        expect(spawnSession).not.toHaveBeenCalled();
        expect(stopSession).not.toHaveBeenCalled();
    });

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
            { surface: 'rpc', authority: 'present_user', signal: controller.signal },
        );

        expect(handoff).toHaveBeenCalledWith(input, {
            signal: controller.signal,
            callerAuthority: 'present_user',
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
                    authority: 'account_automation',
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
            directory: { kind: 'path' as const, path: '/tmp/project' },
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
            { surface: 'rpc', authority: 'account_automation', signal: controller.signal },
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
    // The resolver receives a remaining budget, so this exact-budget
    // assertion must control the real clock boundary, not elapsed wall time.
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    try {
      await expect(
        handlers.get(RPC_METHODS.SPAWN_HAPPY_SESSION)?.(input),
      ).resolves.toEqual({
        type: 'success',
        sessionId: 'session-1',
      });
    } finally {
      clock.mockRestore();
    }
    // The registrar forwards the RPC handler context (the cancellation carrier)
    // as the handler's second argument; invoking the handler without one leaves
    // it undefined (sessionLifecycle.ts:232-245).
    expect(spawnLifecycleHandler).toHaveBeenCalledWith(expect.objectContaining({
      type: 'spawn-in-directory',
      directory: '/tmp/project',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
    }), undefined);
    // Settlement consumes the canonical startup owner's budget and cancellation.
    expect(resolveSpawnSessionByNonce).toHaveBeenCalledWith('spawn-nonce-1', resolveSessionStartupTimeoutMs(), expect.objectContaining({
      signal: expect.any(AbortSignal),
      readRemainingTimeoutMs: expect.any(Function),
    }));
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
    }), undefined);
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
