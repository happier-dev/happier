import axios from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTHORITY_CEILING_HEADER_V1, type SessionTurnMutationV1 } from '@happier-dev/protocol';

import { configuration } from '@/configuration';
import { deliverSessionTurnMutation } from './deliverSessionTurnMutation';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';

vi.mock('axios');

it('keeps a delayed turn mutation pending past a control timeout and retires its transport on cancellation', async () => {
    vi.useFakeTimers();
    try {
        vi.mocked(axios.post).mockResolvedValue({ data: { success: false } } as never);
        const controller = new AbortController();
        const socket = { connected: true, emit: vi.fn(), emitWithAck: () => new Promise(() => {}),
            timeout: (ms: number) => ({ connected: true, emit: vi.fn(), emitWithAck: () =>
                new Promise((_, reject) => { setTimeout(() => reject(new Error('operation has timed out')), ms); }) }) };
        let settled = false;
        const result = deliverSessionTurnMutation({ token: 'token', socket, mutation, signal: controller.signal })
            .then(value => { settled = true; return value; });
        await vi.advanceTimersByTimeAsync(10_001);
        expect(settled).toBe(false);
        controller.abort();
        expect(await result).toMatchObject({ delivered: false });
        expect(axios.post).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
});

const mutation = {
    v: 1,
    sessionId: 'session-1',
    mutationId: 'mutation-1',
    action: 'end_session',
    turnId: 'turn-1',
    observedAt: 200,
} as const;

it('keeps admitted requester headers on host startup failure publication', async () => {
    vi.mocked(axios.post).mockResolvedValue({ data: { receipt: receipt() } } as never);
    const result = await deliverSessionTurnMutation({ token: 'installed-account-token', socket: null, mutation,
        resolveAuthorizationHeaders: () => ({ Authorization: 'Bearer requester-token', [AUTHORITY_CEILING_HEADER_V1]: 'account_automation' }),
    });
    expect(result).toEqual({ delivered: true, path: 'http' });
    expect(axios.post).toHaveBeenLastCalledWith(expect.any(String), mutation, expect.objectContaining({ headers: expect.objectContaining({
        Authorization: 'Bearer requester-token', [AUTHORITY_CEILING_HEADER_V1]: 'account_automation',
    }) }));
});

it('does not substitute an installed Account when admitted requester headers are unavailable', async () => {
    vi.mocked(axios.post).mockClear();
    const result = await deliverSessionTurnMutation({ token: 'installed-account-token', socket: null, mutation,
        resolveAuthorizationHeaders: () => null,
    });
    expect(result).toMatchObject({ delivered: false });
    expect(axios.post).not.toHaveBeenCalled();
});

function receipt(overrides: Record<string, unknown> = {}) {
    return {
        ...mutation,
        decision: 'applied',
        appliedAt: 250,
        ...overrides,
    };
}

const ordinaryMutations = [
    {
        v: 1,
        sessionId: 'session-1',
        mutationId: 'begin-1',
        action: 'begin',
        turnId: 'turn-1',
        observedAt: 201,
    },
    {
        v: 1,
        sessionId: 'session-1',
        mutationId: 'touch-1',
        action: 'touch_active',
        turnId: 'turn-1',
        observedAt: 202,
    },
    {
        v: 1,
        sessionId: 'session-1',
        mutationId: 'attach-1',
        action: 'attach_agent_turn_id',
        turnId: 'turn-1',
        agentTurnId: 'agent-turn-1',
        observedAt: 203,
    },
    {
        v: 1,
        sessionId: 'session-1',
        mutationId: 'anchors-1',
        action: 'append_transcript_anchors',
        turnId: 'turn-1',
        transcriptAnchors: { startUserMessageSeq: 1 },
        observedAt: 204,
    },
    {
        v: 1,
        sessionId: 'session-1',
        mutationId: 'complete-1',
        action: 'complete',
        turnId: 'turn-1',
        observedAt: 205,
    },
    {
        v: 1,
        sessionId: 'session-1',
        mutationId: 'fail-1',
        action: 'fail',
        turnId: 'turn-1',
        issue: {
            v: 1,
            scope: 'primary_session',
            status: 'failed',
            code: 'test_failure',
            source: 'unknown',
            occurredAt: 206,
        },
        observedAt: 206,
    },
    {
        v: 1,
        sessionId: 'session-1',
        mutationId: 'cancel-1',
        action: 'cancel',
        turnId: 'turn-1',
        observedAt: 207,
    },
    {
        v: 1,
        sessionId: 'session-1',
        mutationId: 'rollback-eligible-1',
        action: 'mark_rollback_eligible',
        turnId: 'turn-1',
        observedAt: 208,
    },
    {
        v: 1,
        sessionId: 'session-1',
        mutationId: 'rolled-back-1',
        action: 'mark_rolled_back',
        turnId: 'turn-1',
        observedAt: 209,
    },
] as const satisfies readonly SessionTurnMutationV1[];

function ordinaryReceipt(mutation: SessionTurnMutationV1, overrides: Record<string, unknown> = {}) {
    return {
        v: mutation.v,
        sessionId: mutation.sessionId,
        mutationId: mutation.mutationId,
        ...('turnId' in mutation && mutation.turnId ? { turnId: mutation.turnId } : {}),
        action: mutation.action,
        decision: 'applied',
        observedAt: mutation.observedAt,
        appliedAt: mutation.observedAt + 1,
        ...overrides,
    };
}

describe('deliverSessionTurnMutation Account diagnostic privacy', () => {
    const nativeMessage = 'stage=exec errno=EACCES: cannot open /private/member/project/CODEX_HOME';
    const failure = {
        v: 1, sessionId: 'session-1', mutationId: 'private-fail', action: 'fail', turnId: 'turn-1', observedAt: 100,
        issue: { v: 1, scope: 'primary_session', status: 'failed', code: 'agent_startup_rpc_rejected',
            source: 'agent_session_error', occurredAt: 100, sanitizedPreview: nativeMessage,
            failureCause: { code: 'agent_startup_rpc_rejected', phase: 'client_start',
                failureReason: 'unclassified_provider_error', providerErrorCode: -32603,
                providerErrorMessage: nativeMessage } },
    } as const satisfies SessionTurnMutationV1;

    beforeEach(() => {
        vi.mocked(axios.get).mockReset();
        vi.mocked(axios.post).mockReset();
    });

    it.each([
        { mode: 'e2ee', transport: 'socket' }, { mode: 'e2ee', transport: 'http' },
        { mode: 'plain', transport: 'socket' }, { mode: 'plain', transport: 'http' },
    ] as const)('projects $mode diagnostics once before $transport delivery or replay', async ({ mode, transport }) => {
        vi.mocked(axios.get).mockResolvedValue({ status: 200, data: createAccountEncryptionCurrentnessFixture({ mode }) });
        const sent: unknown[] = [];
        const socket = {
            connected: true, emit: vi.fn(),
            emitWithAck: async (_event: string, payload: unknown) => {
                sent.push(payload);
                return transport === 'socket' ? { ok: true, receipt: ordinaryReceipt(failure) } : { ok: false };
            },
        };
        vi.mocked(axios.post).mockImplementation(async (_url, payload) => {
            sent.push(payload);
            return { status: 200, data: { success: true, receipt: ordinaryReceipt(failure) } };
        });

        await expect(deliverSessionTurnMutation({ token: 'privacy-token', socket, mutation: failure }))
            .resolves.toEqual({ delivered: true, path: transport });
        expect(axios.get).toHaveBeenCalledTimes(1);
        expect(sent).toHaveLength(transport === 'socket' ? 1 : 2);
        for (const payload of sent) {
            if (mode === 'plain') expect(payload).toEqual(failure);
            else {
                expect(JSON.stringify(payload)).not.toContain(nativeMessage);
                expect(JSON.stringify(payload)).not.toContain('/private/member');
                expect(payload).toMatchObject({ issue: { code: failure.issue.code,
                    failureCause: { phase: 'client_start', providerErrorCode: -32603 },
                    sanitizedPreview: 'Agent startup was rejected by its native API' } });
            }
        }
        expect(failure.issue.failureCause.providerErrorMessage).toBe(nativeMessage);
    });

    it('never sends native diagnostics while Account mode is unavailable', async () => {
        vi.mocked(axios.get).mockRejectedValue(new Error('Home unavailable'));
        const socket = { connected: true, emit: vi.fn(), emitWithAck: vi.fn() };
        await expect(deliverSessionTurnMutation({ token: 'privacy-token', socket, mutation: failure }))
            .rejects.toMatchObject({ code: 'account_encryption_currentness_unavailable' });
        expect(socket.emitWithAck).not.toHaveBeenCalled();
        expect(axios.post).not.toHaveBeenCalled();
    });

    it('keeps native exit stderr and materialization paths out of E2EE Account Home state', async () => {
        vi.mocked(axios.get).mockResolvedValue({ status: 200, data: createAccountEncryptionCurrentnessFixture({ mode: 'e2ee' }) });
        const exitFailure = { ...failure, issue: { v: 1, scope: 'primary_session', status: 'failed',
            code: 'agent_process_exit_after_switch', source: 'agent_process_exit_after_switch', occurredAt: 100,
            agentProcessExitAfterSwitch: { exitCode: 1, signal: null, lastStderrLine: nativeMessage,
                vendorResumeId: null, materializationRoot: '/private/member/project', effectiveStateMode: 'isolated' },
        } } as const satisfies SessionTurnMutationV1;
        const sent: unknown[] = [];
        const socket = { connected: true, emit: vi.fn(), emitWithAck: async (_event: string, payload: unknown) => {
            sent.push(payload);
            return { ok: true, receipt: ordinaryReceipt(exitFailure) };
        } };
        await expect(deliverSessionTurnMutation({ token: 'privacy-token', socket, mutation: exitFailure }))
            .resolves.toEqual({ delivered: true, path: 'socket' });
        expect(JSON.stringify(sent)).not.toContain('/private/member');
        expect(sent).toEqual([expect.objectContaining({ issue: {
            v: 1, scope: 'primary_session', status: 'failed', code: exitFailure.issue.code,
            source: exitFailure.issue.source, occurredAt: 100,
        } })]);
    });
});

describe('deliverSessionTurnMutation exact end', () => {
    beforeEach(() => {
        vi.mocked(axios.post).mockReset();
    });

    it.each([400, 422])('reports a deterministic HTTP %s refusal as terminal', async (status) => {
        vi.mocked(axios.post).mockRejectedValue({ response: { status } });
        await expect(deliverSessionTurnMutation({ token: 'token', socket: null, mutation: ordinaryMutations[4] }))
            .resolves.toMatchObject({ delivered: false, reason: 'session_turn_mutation_rejected', httpStatus: status });
    });

    it.each(['applied', 'duplicate-terminal'] as const)(
        'releases exact custody for the positive %s socket receipt',
        async (decision) => {
            const socket = {
                connected: true,
                emit: vi.fn(),
                timeout: () => socket,
                emitWithAck: vi.fn(async () => ({ result: 'success', receipt: receipt({ decision }) })),
            };

            await expect(deliverSessionTurnMutation({ token: 'token', socket, mutation })).resolves.toEqual({
                delivered: true,
                path: 'socket',
            });
            expect(axios.post).not.toHaveBeenCalled();
        },
    );

    it('does not treat generic socket or HTTP success as exact delivery', async () => {
        const socket = {
            connected: true,
            emit: vi.fn(),
            timeout: () => socket,
            emitWithAck: vi.fn(async () => ({ result: 'success' })),
        };
        vi.mocked(axios.post).mockResolvedValue({ status: 200, data: { success: true } } as never);

        await expect(deliverSessionTurnMutation({ token: 'token', socket, mutation })).resolves.toMatchObject({
            delivered: false,
            reason: 'exact_session_turn_mutation_not_delivered',
            diagnostic: { classification: 'receipt_mismatch' },
        });
    });

    it.each(['duplicate-mutation', 'missing-turn', 'stale-in-progress', 'stale-terminal'] as const)(
        'retains exact custody for non-positive decision %s',
        async (decision) => {
            const socket = {
                connected: true,
                emit: vi.fn(),
                timeout: () => socket,
                emitWithAck: vi.fn(async () => ({ result: 'success', receipt: receipt({ decision }) })),
            };
            vi.mocked(axios.post).mockResolvedValue({
                status: 200,
                data: { success: true, receipt: receipt({ decision }) },
            } as never);

            await expect(deliverSessionTurnMutation({ token: 'token', socket, mutation })).resolves.toMatchObject({
                delivered: false,
                reason: 'exact_session_turn_mutation_not_delivered',
                diagnostic: { classification: 'semantic_non_positive', decision },
            });
        },
    );

    it.each(ordinaryMutations)('releases ordinary $action custody only for a matching socket receipt', async (ordinaryMutation) => {
        const socket = {
            connected: true,
            emit: vi.fn(),
            timeout: () => socket,
            emitWithAck: vi.fn(async () => ({
                result: 'success',
                receipt: ordinaryReceipt(ordinaryMutation),
            })),
        };

        await expect(deliverSessionTurnMutation({
            token: 'token',
            socket,
            mutation: ordinaryMutation,
        })).resolves.toEqual({ delivered: true, path: 'socket' });
        expect(axios.post).not.toHaveBeenCalled();
    });

    it('does not treat generic socket or HTTP success as ordinary mutation delivery', async () => {
        const ordinaryMutation = ordinaryMutations[0];
        const socket = {
            connected: true,
            emit: vi.fn(),
            timeout: () => socket,
            emitWithAck: vi.fn(async () => ({ result: 'success' })),
        };
        vi.mocked(axios.post).mockResolvedValue({ status: 200, data: { success: true } } as never);

        await expect(deliverSessionTurnMutation({
            token: 'token',
            socket,
            mutation: ordinaryMutation,
        })).resolves.toMatchObject({
            delivered: false,
            reason: 'session_turn_mutation_receipt_mismatch',
        });
        expect(axios.post).toHaveBeenCalledOnce();
    });

    it('falls back from anonymous socket success to a matching HTTP receipt', async () => {
        const ordinaryMutation = ordinaryMutations[2];
        const socket = {
            connected: true,
            emit: vi.fn(),
            timeout: () => socket,
            emitWithAck: vi.fn(async () => ({ result: 'success' })),
        };
        vi.mocked(axios.post).mockResolvedValue({
            status: 200,
            data: {
                success: true,
                receipt: ordinaryReceipt(ordinaryMutation),
            },
        } as never);

        await expect(deliverSessionTurnMutation({
            token: 'token',
            socket,
            mutation: ordinaryMutation,
        })).resolves.toEqual({ delivered: true, path: 'http' });
        expect(axios.post).toHaveBeenCalledWith(
            expect.any(String),
            ordinaryMutation,
            expect.objectContaining({ timeout: configuration.sessionControlHttpTimeoutMs }),
        );
    });

    it('treats a matching ordinary rejection receipt as deterministic server settlement', async () => {
        const ordinaryMutation = ordinaryMutations[0];
        const socket = {
            connected: true,
            emit: vi.fn(),
            timeout: () => socket,
            emitWithAck: vi.fn(async () => ({
                result: 'success',
                applied: false,
                receipt: ordinaryReceipt(ordinaryMutation, { decision: 'missing-turn' }),
            })),
        };

        await expect(deliverSessionTurnMutation({
            token: 'token',
            socket,
            mutation: ordinaryMutation,
        })).resolves.toEqual({ delivered: true, path: 'socket' });
        expect(axios.post).not.toHaveBeenCalled();
    });

    it('does not settle ordinary custody from another mutation receipt', async () => {
        const ordinaryMutation = ordinaryMutations[1];
        const socket = {
            connected: true,
            emit: vi.fn(),
            timeout: () => socket,
            emitWithAck: vi.fn(async () => ({
                result: 'success',
                receipt: ordinaryReceipt(ordinaryMutation, { mutationId: 'different-socket-mutation' }),
            })),
        };
        vi.mocked(axios.post).mockResolvedValue({
            status: 200,
            data: {
                success: true,
                receipt: ordinaryReceipt(ordinaryMutation, { observedAt: ordinaryMutation.observedAt + 100 }),
            },
        } as never);

        await expect(deliverSessionTurnMutation({
            token: 'token',
            socket,
            mutation: ordinaryMutation,
        })).resolves.toMatchObject({
            delivered: false,
            reason: 'session_turn_mutation_receipt_mismatch',
        });
        expect(axios.post).toHaveBeenCalledOnce();
    });
});
