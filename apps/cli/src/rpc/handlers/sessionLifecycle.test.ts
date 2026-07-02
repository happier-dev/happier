import { readFile } from 'node:fs/promises';

import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { describe, expect, it } from 'vitest';

import type { RpcActionExecutor } from './_actionDispatchAdapter';

function createRpcHarness() {
    const handlers = new Map<string, (input: unknown) => Promise<unknown>>();
    return {
        handlers,
        rpcHandlerManager: {
            registerHandler(method: string, handler: (input: unknown) => Promise<unknown>) {
                handlers.set(method, handler);
            },
        },
    };
}

function readExpectedDefaultSessionId(input: unknown): string | undefined {
    if (!input || typeof input !== 'object') {
        return undefined;
    }
    const record = input as Record<string, unknown>;
    const value = record.parentSessionId ?? record.sessionId;
    return typeof value === 'string' ? value : undefined;
}

const SESSION_LIFECYCLE_RPC_CASES = [
    [RPC_METHODS.SPAWN_HAPPY_SESSION, 'session.spawn_new', { directory: '/tmp/project', backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' } }],
    [RPC_METHODS.STOP_SESSION, 'session.stop', { sessionId: 'session-1' }],
    [RPC_METHODS.SESSION_FORK, 'session.fork', { parentSessionId: 'session-1', forkPoint: { type: 'latest' } }],
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
    [RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET, 'session.handoff.prepare_target_result.get', { handoffId: 'handoff-1' }],
    [RPC_METHODS.DAEMON_SESSION_HANDOFF_COMMIT, 'session.handoff.commit', { handoffId: 'handoff-1' }],
    [RPC_METHODS.DAEMON_SESSION_HANDOFF_ABORT, 'session.handoff.abort', { handoffId: 'handoff-1' }],
    [RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET, 'session.handoff.status.get', { handoffId: 'handoff-1' }],
] as const;

describe('session lifecycle RPC handlers', () => {
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
