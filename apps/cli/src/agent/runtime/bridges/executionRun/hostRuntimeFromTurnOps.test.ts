import { describe, expect, it, vi } from 'vitest';

import type { RuntimeTurnOperations } from '@/agent/runtime/turns/runtimeTurnOperations';

import { createExecutionRunHostRuntimeFromRuntimeTurnOperations } from './hostRuntimeFromTurnOps';

describe('createExecutionRunHostRuntimeFromRuntimeTurnOperations', () => {
    it('provisions resumed sessions without importing provider history', async () => {
        const startOrLoadSession = vi.fn(async () => undefined);
        const operations: RuntimeTurnOperations = {
            beginTurnLifecycle: vi.fn(),
            startOrLoadSession,
            sendTurnPrompt: vi.fn(async () => undefined),
            steerInFlightTurn: vi.fn(async () => undefined),
            waitForTurnCompletion: vi.fn(async () => undefined),
            subscribeRuntimeEvents: vi.fn(() => () => undefined),
            cancelTurn: vi.fn(async () => undefined),
            readSessionIdentity: () => ({ sessionId: 'resume-123' }),
            updateSessionRuntimeConfig: vi.fn(async () => undefined),
            resetOrDisposeRuntime: vi.fn(async () => undefined),
        };

        const runtime = createExecutionRunHostRuntimeFromRuntimeTurnOperations(operations);

        await expect(runtime.provisionSession({ resumeSessionId: ' resume-123 ' })).resolves.toEqual({
            sessionId: 'resume-123',
        });

        expect(startOrLoadSession).toHaveBeenCalledWith({
            resumeId: 'resume-123',
            importHistory: false,
        });
    });

    it('preserves permission capability that becomes available after session startup', async () => {
        let started = false;
        const respondToPermission = vi.fn(async () => ({ delivered: true as const }));
        const operations: RuntimeTurnOperations = {
            get permissionCapability() {
                return started ? 'responds' : undefined;
            },
            beginTurnLifecycle: vi.fn(),
            startOrLoadSession: vi.fn(async () => {
                started = true;
                return { sessionId: 'dynamic-session-1' };
            }),
            sendTurnPrompt: vi.fn(async () => undefined),
            steerInFlightTurn: vi.fn(async () => undefined),
            waitForTurnCompletion: vi.fn(async () => undefined),
            subscribeRuntimeEvents: vi.fn(() => () => undefined),
            respondToPermission,
            cancelTurn: vi.fn(async () => undefined),
            readSessionIdentity: () => ({ sessionId: started ? 'dynamic-session-1' : null }),
            updateSessionRuntimeConfig: vi.fn(async () => undefined),
            resetOrDisposeRuntime: vi.fn(async () => undefined),
        };

        const runtime = createExecutionRunHostRuntimeFromRuntimeTurnOperations(operations);

        expect(runtime.permissionCapability).toBeUndefined();
        expect(runtime.respondToPermission).toBeUndefined();
        await expect(runtime.provisionSession()).resolves.toEqual({ sessionId: 'dynamic-session-1' });
        expect(runtime.permissionCapability).toBe('responds');
        await expect(runtime.respondToPermission?.('permission-1', true)).resolves.toEqual({
            delivered: true,
        });
        expect(respondToPermission).toHaveBeenCalledWith('permission-1', true);
    });

    it('registers turn lifecycle before awaiting the first prompt send', async () => {
        const calls: string[] = [];
        let resolvePrompt!: () => void;
        const operations: RuntimeTurnOperations = {
            beginTurnLifecycle: vi.fn(() => {
                calls.push('beginTurnLifecycle');
            }),
            startOrLoadSession: vi.fn(async () => ({ sessionId: 'turn-session-1' })),
            sendTurnPrompt: vi.fn(async () => {
                calls.push('sendTurnPrompt:entered');
                await new Promise<void>((resolve) => {
                    resolvePrompt = resolve;
                });
                calls.push('sendTurnPrompt:resolved');
            }),
            steerInFlightTurn: vi.fn(async () => undefined),
            waitForTurnCompletion: vi.fn(async () => undefined),
            subscribeRuntimeEvents: vi.fn(() => () => undefined),
            cancelTurn: vi.fn(async () => undefined),
            readSessionIdentity: () => ({ sessionId: 'turn-session-1' }),
            updateSessionRuntimeConfig: vi.fn(async () => undefined),
            resetOrDisposeRuntime: vi.fn(async () => undefined),
        };
        const runtime = createExecutionRunHostRuntimeFromRuntimeTurnOperations(operations);

        await runtime.provisionSession();
        const send = runtime.sendPrompt('turn-session-1', 'inspect');

        await vi.waitFor(() => {
            expect(operations.sendTurnPrompt).toHaveBeenCalledTimes(1);
        });
        expect(calls).toEqual(['beginTurnLifecycle', 'sendTurnPrompt:entered']);

        resolvePrompt();
        await expect(send).resolves.toBeUndefined();
        expect(calls).toEqual(['beginTurnLifecycle', 'sendTurnPrompt:entered', 'sendTurnPrompt:resolved']);
    });

    it('passes full pending identity through steer prompts', async () => {
        const steerInFlightTurn = vi.fn(async () => undefined);
        const operations: RuntimeTurnOperations = {
            beginTurnLifecycle: vi.fn(),
            startOrLoadSession: vi.fn(async () => ({ sessionId: 'turn-session-2' })),
            sendTurnPrompt: vi.fn(async () => undefined),
            steerInFlightTurn,
            waitForTurnCompletion: vi.fn(async () => undefined),
            subscribeRuntimeEvents: vi.fn(() => () => undefined),
            cancelTurn: vi.fn(async () => undefined),
            readSessionIdentity: () => ({ sessionId: 'turn-session-2' }),
            updateSessionRuntimeConfig: vi.fn(async () => undefined),
            resetOrDisposeRuntime: vi.fn(async () => undefined),
        };
        const runtime = createExecutionRunHostRuntimeFromRuntimeTurnOperations(operations);

        await runtime.provisionSession();
        await runtime.sendSteerPrompt?.('turn-session-2', 'steer text', {
            localInputId: 'local-steer',
            localInputIds: ['local-steer', 'local-steer-extra'],
            providerClaimedPendingLocalIds: ['provider-claimed-steer'],
            userMessageSeq: 55,
            userMessageSeqs: [55, 56],
        });

        expect(steerInFlightTurn).toHaveBeenCalledWith('steer text', {
            localId: 'local-steer',
            localIds: ['local-steer', 'local-steer-extra'],
            providerClaimedPendingLocalIds: ['provider-claimed-steer'],
            userMessageSeq: 55,
            userMessageSeqs: [55, 56],
        });
    });

    it('passes full pending identity through normal prompts', async () => {
        const sendTurnPrompt = vi.fn(async () => undefined);
        const operations: RuntimeTurnOperations = {
            beginTurnLifecycle: vi.fn(),
            startOrLoadSession: vi.fn(async () => ({ sessionId: 'turn-session-3' })),
            sendTurnPrompt,
            steerInFlightTurn: vi.fn(async () => undefined),
            waitForTurnCompletion: vi.fn(async () => undefined),
            subscribeRuntimeEvents: vi.fn(() => () => undefined),
            cancelTurn: vi.fn(async () => undefined),
            readSessionIdentity: () => ({ sessionId: 'turn-session-3' }),
            updateSessionRuntimeConfig: vi.fn(async () => undefined),
            resetOrDisposeRuntime: vi.fn(async () => undefined),
        };
        const runtime = createExecutionRunHostRuntimeFromRuntimeTurnOperations(operations);

        await runtime.provisionSession();
        await runtime.sendPrompt('turn-session-3', 'normal text', {
            localInputId: 'local-normal',
            localInputIds: ['local-normal', 'local-normal-extra'],
            providerClaimedPendingLocalIds: ['provider-claimed-normal'],
            userMessageSeq: 56,
            userMessageSeqs: [56, 57],
        });

        expect(sendTurnPrompt).toHaveBeenCalledWith('normal text', {
            localId: 'local-normal',
            localIds: ['local-normal', 'local-normal-extra'],
            providerClaimedPendingLocalIds: ['provider-claimed-normal'],
            userMessageSeq: 56,
            userMessageSeqs: [56, 57],
        });
    });
});
