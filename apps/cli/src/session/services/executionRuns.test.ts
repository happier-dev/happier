import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { callSessionRpc, listExecutionRunMarkers, readRawSessionHistoryRows } = vi.hoisted(() => ({
    callSessionRpc: vi.fn(),
    listExecutionRunMarkers: vi.fn(),
    readRawSessionHistoryRows: vi.fn(),
}));

vi.mock('@/session/transport/rpc/sessionRpc', () => ({
    callSessionRpc,
}));

vi.mock('@/daemon/executionRunRegistry', () => ({
    listExecutionRunMarkers,
}));

vi.mock('./getSessionHistory', () => ({
    readRawSessionHistoryRows,
}));

import {
    getExecutionRun,
    listExecutionRuns,
    normalizeExecutionRunRpcPayload,
    executeExecutionRunAction,
    cancelExecutionRunStream,
    sendExecutionRunMessage,
    startExecutionRun,
    startExecutionRunStream,
    startExecutionRunV2,
    stopExecutionRun,
    waitForExecutionRun,
} from './executionRuns';
import { fingerprintExecutionRunStartRequest } from '@/agent/executionRuns/executionRunStartFingerprint';
import { createRpcAcknowledgementError, markRpcRequestDisposition } from '@/session/transport/rpc/rpcRequestDisposition';
import { SocketRpcDisconnectBeforeAcknowledgementError } from '@/session/transport/rpc/socketRpcDisconnectGuard';

function createRun(params: Readonly<{
    runId: string;
    status: 'running' | 'succeeded';
    startedAtMs: number;
}>) {
    return {
        runId: params.runId,
        callId: `${params.runId}-call`,
        sidechainId: `${params.runId}-sidechain`,
        intent: 'plan',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' as const },
        permissionMode: 'workspace_write',
        retentionPolicy: 'ephemeral' as const,
        runClass: 'bounded' as const,
        ioMode: 'request_response' as const,
        status: params.status,
        startedAtMs: params.startedAtMs,
        ...(params.status === 'succeeded' ? { finishedAtMs: params.startedAtMs + 1 } : {}),
    };
}

function createMarker(params: Readonly<{
    runId: string;
    status: 'running' | 'succeeded';
    startedAtMs: number;
    agentId?: 'claude' | 'opencode';
    startRequestId?: string;
    startRequestFingerprint?: string;
}>) {
    return {
        happySessionId: 'sess-1',
        runId: params.runId,
        callId: `${params.runId}-call`,
        sidechainId: `${params.runId}-sidechain`,
        intent: 'plan',
        backendTarget: { kind: 'builtInAgent', agentId: params.agentId ?? 'claude' },
        permissionMode: 'workspace_write',
        retentionPolicy: 'ephemeral',
        runClass: 'bounded',
        ioMode: 'request_response',
        status: params.status,
        startedAtMs: params.startedAtMs,
        ...(params.startRequestId ? { startRequestId: params.startRequestId } : {}),
        ...(params.startRequestFingerprint ? { startRequestFingerprint: params.startRequestFingerprint } : {}),
        ...(params.status === 'succeeded' ? { finishedAtMs: params.startedAtMs + 1 } : {}),
    };
}

function createTranscriptRows(params: Readonly<{
    runId: string;
    callId?: string;
    status: 'running' | 'succeeded';
    startedAtMs: number;
}>) {
    const callId = params.callId ?? `${params.runId}-call`;
    return [
        {
            id: `${params.runId}-call-row`,
            createdAt: params.startedAtMs,
            role: 'agent',
            raw: {
                role: 'agent',
                content: {
                    type: 'acp',
                    provider: 'claude',
                    data: {
                        type: 'tool-call',
                        callId,
                        name: 'SubAgentRun',
                        input: {
                            runId: params.runId,
                            callId,
                            sidechainId: callId,
                            intent: 'plan',
                            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
                            permissionMode: 'workspace_write',
                            retentionPolicy: 'ephemeral',
                            runClass: 'bounded',
                            ioMode: 'request_response',
                        },
                    },
                },
            },
        },
        {
            id: `${params.runId}-result-row`,
            createdAt: params.startedAtMs + 10,
            role: 'agent',
            raw: {
                role: 'agent',
                content: {
                    type: 'acp',
                    provider: 'claude',
                    data: {
                        type: 'tool-result',
                        callId,
                        output: {
                            _happier: {
                                canonicalToolName: 'SubAgentRun',
                            },
                            runId: params.runId,
                            callId,
                            sidechainId: callId,
                            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
                            intent: 'plan',
                            permissionMode: 'workspace_write',
                            retentionPolicy: 'ephemeral',
                            runClass: 'bounded',
                            ioMode: 'request_response',
                            status: params.status,
                            startedAtMs: params.startedAtMs,
                            ...(params.status === 'succeeded' ? { finishedAtMs: params.startedAtMs + 10 } : {}),
                        },
                    },
                },
            },
        },
    ];
}

describe('listExecutionRuns', () => {
    beforeEach(() => {
        callSessionRpc.mockReset();
        listExecutionRunMarkers.mockReset();
        readRawSessionHistoryRows.mockReset();
    });

    it('returns an invalid response error when a successful rpc list payload does not match the contract', async () => {
        callSessionRpc.mockResolvedValueOnce({
            runs: [{ runId: 'missing-required-fields' }],
        });
        listExecutionRunMarkers.mockResolvedValueOnce([]);

        const result = await listExecutionRuns({
            token: 'token',
            sessionId: 'sess-1',
            ctx: { encryptionKey: new Uint8Array([1, 2, 3, 4]), encryptionVariant: 'legacy' },
            request: {},
        });

        expect(result).toEqual({
            ok: false,
            code: 'execution_run_invalid_response',
            message: 'Invalid execution run list response',
        });
    });

    it('applies canonical startedAt ordering before limit on rpc-backed execution run lists', async () => {
        callSessionRpc.mockResolvedValueOnce({
            runs: [
                createRun({ runId: 'run-later', status: 'running', startedAtMs: 30 }),
                createRun({ runId: 'run-earlier', status: 'running', startedAtMs: 10 }),
            ],
        });
        listExecutionRunMarkers.mockResolvedValueOnce([]);

        const result = await listExecutionRuns({
            token: 'token',
            sessionId: 'sess-1',
            ctx: { encryptionKey: new Uint8Array([1, 2, 3, 4]), encryptionVariant: 'legacy' },
            request: { limit: 1 },
        });

        expect(result).toEqual({
            ok: true,
            data: {
                runs: [createRun({ runId: 'run-earlier', status: 'running', startedAtMs: 10 })],
            },
        });
    });

    it('reapplies request filters after merging marker-backed runs into rpc results', async () => {
        callSessionRpc.mockResolvedValueOnce({
            runs: [createRun({ runId: 'run-primary-succeeded', status: 'succeeded', startedAtMs: 10 })],
        });
        listExecutionRunMarkers.mockResolvedValueOnce([
            createMarker({ runId: 'run-marker-running', status: 'running', startedAtMs: 20 }),
            createMarker({ runId: 'run-marker-succeeded', status: 'succeeded', startedAtMs: 30 }),
        ]);

        const result = await listExecutionRuns({
            token: 'token',
            sessionId: 'sess-1',
            ctx: { encryptionKey: new Uint8Array([1, 2, 3, 4]), encryptionVariant: 'legacy' },
            request: { status: 'running', limit: 1 },
        });

        expect(result).toEqual({
            ok: true,
            data: {
                runs: [createRun({ runId: 'run-marker-running', status: 'running', startedAtMs: 20 })],
            },
        });
    });

    it('reapplies backend filters when falling back to marker-backed runs after rpc unavailability', async () => {
        callSessionRpc.mockRejectedValueOnce(new Error('RPC method not available'));
        listExecutionRunMarkers.mockResolvedValueOnce([
            createMarker({ runId: 'run-marker-running', status: 'running', startedAtMs: 20, agentId: 'opencode' }),
            createMarker({ runId: 'run-marker-succeeded', status: 'succeeded', startedAtMs: 30 }),
        ]);

        const result = await listExecutionRuns({
            token: 'token',
            sessionId: 'sess-1',
            ctx: { encryptionKey: new Uint8Array([1, 2, 3, 4]), encryptionVariant: 'legacy' },
            request: { backendId: 'claude', limit: 1 },
        });

        expect(result).toEqual({
            ok: true,
            data: {
                runs: [createRun({ runId: 'run-marker-succeeded', status: 'succeeded', startedAtMs: 30 })],
            },
        });
    });

    it('falls back to transcript-backed execution runs when rpc is unavailable and no markers remain', async () => {
        callSessionRpc.mockRejectedValueOnce(new Error('RPC method not available'));
        listExecutionRunMarkers.mockResolvedValueOnce([]);
        readRawSessionHistoryRows.mockResolvedValueOnce(createTranscriptRows({
            runId: 'run_hist_1',
            callId: 'call_hist_1',
            status: 'succeeded',
            startedAtMs: 10,
        }));

        const result = await listExecutionRuns({
            token: 'token',
            sessionId: 'sess-1',
            ctx: { encryptionKey: new Uint8Array([1, 2, 3, 4]), encryptionVariant: 'legacy' },
            request: { status: 'succeeded' },
        });

        expect(result).toEqual({
            ok: true,
            data: {
                runs: [
                    {
                        runId: 'run_hist_1',
                        callId: 'call_hist_1',
                        sidechainId: 'call_hist_1',
                        intent: 'plan',
                        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
                        permissionMode: 'workspace_write',
                        retentionPolicy: 'ephemeral',
                        runClass: 'bounded',
                        ioMode: 'request_response',
                        status: 'succeeded',
                        startedAtMs: 10,
                        finishedAtMs: 20,
                    },
                ],
            },
        });
    });

    it('reports protocol unsupported when the rpc method is unavailable and bounded recovery finds no runs', async () => {
        callSessionRpc.mockRejectedValueOnce(new Error('RPC method not available'));
        listExecutionRunMarkers.mockResolvedValueOnce([]);
        readRawSessionHistoryRows.mockResolvedValueOnce([]);

        const result = await listExecutionRuns({
            token: 'token',
            sessionId: 'sess-1',
            ctx: { encryptionKey: new Uint8Array([1, 2, 3, 4]), encryptionVariant: 'legacy' },
            request: {},
        });

        expect(result).toEqual({
            ok: false,
            code: 'execution_run_protocol_unsupported',
            message: 'RPC method not available',
        });
    });

    it('merges marker-backed and transcript-backed runs during app-level fallback instead of hiding transcript history', async () => {
        callSessionRpc.mockResolvedValueOnce({
            ok: false,
            errorCode: 'execution_run_not_found',
            error: 'Not found',
        });
        listExecutionRunMarkers.mockResolvedValueOnce([
            createMarker({ runId: 'run-marker-running', status: 'running', startedAtMs: 20 }),
        ]);
        readRawSessionHistoryRows.mockResolvedValueOnce(createTranscriptRows({
            runId: 'run-transcript-succeeded',
            callId: 'call_hist_merged',
            status: 'succeeded',
            startedAtMs: 10,
        }));

        const result = await listExecutionRuns({
            token: 'token',
            sessionId: 'sess-1',
            ctx: { encryptionKey: new Uint8Array([1, 2, 3, 4]), encryptionVariant: 'legacy' },
            request: {},
        });

        expect(result).toEqual({
            ok: true,
            data: {
                runs: [
                    {
                        runId: 'run-transcript-succeeded',
                        callId: 'call_hist_merged',
                        sidechainId: 'call_hist_merged',
                        intent: 'plan',
                        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
                        permissionMode: 'workspace_write',
                        retentionPolicy: 'ephemeral',
                        runClass: 'bounded',
                        ioMode: 'request_response',
                        status: 'succeeded',
                        startedAtMs: 10,
                        finishedAtMs: 20,
                    },
                    createRun({ runId: 'run-marker-running', status: 'running', startedAtMs: 20 }),
                ],
            },
        });
    });

    it('merges marker-backed and transcript-backed runs during transport fallback instead of hiding transcript history', async () => {
        callSessionRpc.mockRejectedValueOnce(new Error('RPC method not available'));
        listExecutionRunMarkers.mockResolvedValueOnce([
            createMarker({ runId: 'run-marker-running', status: 'running', startedAtMs: 20 }),
        ]);
        readRawSessionHistoryRows.mockResolvedValueOnce(createTranscriptRows({
            runId: 'run-transcript-succeeded',
            callId: 'call_hist_transport',
            status: 'succeeded',
            startedAtMs: 10,
        }));

        const result = await listExecutionRuns({
            token: 'token',
            sessionId: 'sess-1',
            ctx: { encryptionKey: new Uint8Array([1, 2, 3, 4]), encryptionVariant: 'legacy' },
            request: {},
        });

        expect(result).toEqual({
            ok: true,
            data: {
                runs: [
                    {
                        runId: 'run-transcript-succeeded',
                        callId: 'call_hist_transport',
                        sidechainId: 'call_hist_transport',
                        intent: 'plan',
                        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
                        permissionMode: 'workspace_write',
                        retentionPolicy: 'ephemeral',
                        runClass: 'bounded',
                        ioMode: 'request_response',
                        status: 'succeeded',
                        startedAtMs: 10,
                        finishedAtMs: 20,
                    },
                    createRun({ runId: 'run-marker-running', status: 'running', startedAtMs: 20 }),
                ],
            },
        });
    });

    it('preserves canonical startedAt ordering when transcript fallback rows arrive out of order', async () => {
        callSessionRpc.mockRejectedValueOnce(new Error('RPC method not available'));
        listExecutionRunMarkers.mockResolvedValueOnce([]);
        readRawSessionHistoryRows.mockResolvedValueOnce([
            {
                id: '2',
                createdAt: 20,
                role: 'agent',
                raw: {
                    role: 'agent',
                    content: {
                        type: 'acp',
                        provider: 'claude',
                        data: {
                            type: 'tool-result',
                            callId: 'call_hist_2',
                            output: {
                                _happier: {
                                    canonicalToolName: 'SubAgentRun',
                                },
                                runId: 'run_hist_2',
                                callId: 'call_hist_2',
                                sidechainId: 'call_hist_2',
                                backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
                                intent: 'plan',
                                permissionMode: 'workspace_write',
                                retentionPolicy: 'ephemeral',
                                runClass: 'bounded',
                                ioMode: 'request_response',
                                status: 'succeeded',
                                startedAtMs: 10,
                                finishedAtMs: 20,
                            },
                        },
                    },
                },
            },
            {
                id: '1',
                createdAt: 10,
                role: 'agent',
                raw: {
                    role: 'agent',
                    content: {
                        type: 'acp',
                        provider: 'claude',
                        data: {
                            type: 'tool-call',
                            callId: 'call_hist_2',
                            name: 'SubAgentRun',
                            input: {
                                runId: 'run_hist_2',
                                callId: 'call_hist_2',
                                sidechainId: 'call_hist_2',
                                intent: 'plan',
                                backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
                                permissionMode: 'workspace_write',
                                retentionPolicy: 'ephemeral',
                                runClass: 'bounded',
                                ioMode: 'request_response',
                            },
                        },
                    },
                },
            },
        ]);

        const result = await listExecutionRuns({
            token: 'token',
            sessionId: 'sess-1',
            ctx: { encryptionKey: new Uint8Array([1, 2, 3, 4]), encryptionVariant: 'legacy' },
            request: { status: 'succeeded' },
        });

        expect(result).toEqual({
            ok: true,
            data: {
                runs: [
                    {
                        runId: 'run_hist_2',
                        callId: 'call_hist_2',
                        sidechainId: 'call_hist_2',
                        intent: 'plan',
                        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
                        permissionMode: 'workspace_write',
                        retentionPolicy: 'ephemeral',
                        runClass: 'bounded',
                        ioMode: 'request_response',
                        status: 'succeeded',
                        startedAtMs: 10,
                        finishedAtMs: 20,
                    },
                ],
            },
        });
    });

    it('preserves authoritative not found when bounded recovery finds no list records', async () => {
        callSessionRpc.mockResolvedValueOnce({
            ok: false,
            errorCode: 'execution_run_not_found',
            error: 'Not found',
        });
        listExecutionRunMarkers.mockResolvedValueOnce([]);
        readRawSessionHistoryRows.mockResolvedValueOnce([]);

        const result = await listExecutionRuns({
            token: 'token',
            sessionId: 'sess-1',
            ctx: { encryptionKey: new Uint8Array([1, 2, 3, 4]), encryptionVariant: 'legacy' },
            request: {},
        });

        expect(result).toEqual({
            ok: false,
            code: 'execution_run_not_found',
            message: 'Not found',
        });
    });

    it('reports target unavailable when the rpc target and transcript recovery are unavailable', async () => {
        callSessionRpc.mockRejectedValueOnce(new Error('Socket connect timeout'));
        listExecutionRunMarkers.mockResolvedValueOnce([]);
        readRawSessionHistoryRows.mockResolvedValueOnce([]);

        const result = await listExecutionRuns({
            token: 'token',
            sessionId: 'sess-1',
            ctx: { encryptionKey: new Uint8Array([1, 2, 3, 4]), encryptionVariant: 'legacy' },
            request: {},
        });

        expect(result).toEqual({
            ok: false,
            code: 'execution_run_target_unavailable',
            message: 'Socket connect timeout',
        });
    });
});

describe('normalizeExecutionRunRpcPayload', () => {
    it('unwraps successful service envelopes without adding another data layer', () => {
        expect(
            normalizeExecutionRunRpcPayload({
                ok: true,
                data: {
                    runId: 'run_1',
                    callId: 'call_1',
                    sidechainId: 'side_1',
                },
            }),
        ).toEqual({
            ok: true,
            data: {
                runId: 'run_1',
                callId: 'call_1',
                sidechainId: 'side_1',
            },
        });
    });

    it('treats raw rpc error payloads as failures even when ok is absent', () => {
        expect(
            normalizeExecutionRunRpcPayload({
                error: 'RPC method not available',
                errorCode: 'RPC_METHOD_NOT_AVAILABLE',
            }),
        ).toEqual({
            ok: false,
            code: 'RPC_METHOD_NOT_AVAILABLE',
            message: 'RPC method not available',
        });
    });
});

describe('startExecutionRun', () => {
    beforeEach(() => {
        callSessionRpc.mockReset();
        listExecutionRunMarkers.mockReset();
    });

    it('keeps the effectful start request under execution-run lifecycle ownership', async () => {
        callSessionRpc.mockResolvedValueOnce({ ok: true, data: { runId: 'run-1' } });

        await startExecutionRun({
            token: 'token',
            sessionId: 'sess-1',
            ctx: { encryptionKey: new Uint8Array([1, 2, 3, 4]), encryptionVariant: 'legacy' },
            request: { intent: 'review' },
        });

        expect(callSessionRpc).toHaveBeenCalledWith(expect.objectContaining({
            method: 'sess-1:execution.run.start',
            timeoutMs: null,
        }));
    });

    it('reports protocol unsupported when a live runtime lacks the start method', async () => {
        callSessionRpc.mockRejectedValueOnce(new Error('RPC method not available'));

        await expect(startExecutionRun({
            token: 'token',
            sessionId: 'sess-1',
            ctx: { encryptionKey: new Uint8Array([1, 2, 3, 4]), encryptionVariant: 'legacy' },
            request: { intent: 'review' },
        })).resolves.toEqual({
            ok: false,
            code: 'execution_run_protocol_unsupported',
            message: 'RPC method not available',
        });
    });

    it.each([
        ['acknowledgement timeout', () => markRpcRequestDisposition(new Error('RPC call timeout'), 'outcomeUnknown')],
        ['post-emission disconnect', () => markRpcRequestDisposition(new SocketRpcDisconnectBeforeAcknowledgementError(), 'outcomeUnknown')],
    ] as const)('recovers the exact accepted start from its correlated marker after an %s', async (_case, createError) => {
        const request = {
            intent: 'plan',
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            permissionMode: 'workspace_write',
            retentionPolicy: 'ephemeral',
            runClass: 'bounded',
            ioMode: 'request_response',
            startRequestId: 'action-request-1',
        } as const;
        callSessionRpc.mockRejectedValueOnce(createError());
        listExecutionRunMarkers.mockResolvedValueOnce([
            createMarker({
                runId: 'run-correlated',
                status: 'running',
                startedAtMs: 20,
                startRequestId: 'action-request-1',
                startRequestFingerprint: fingerprintExecutionRunStartRequest(request),
            }),
        ]);

        await expect(startExecutionRun({
            token: 'token',
            sessionId: 'sess-1',
            ctx: { encryptionKey: new Uint8Array([1, 2, 3, 4]), encryptionVariant: 'legacy' },
            request,
        })).resolves.toEqual({
            ok: true,
            data: {
                runId: 'run-correlated',
                callId: 'run-correlated-call',
                sidechainId: 'run-correlated-sidechain',
                intent: 'plan',
                backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
                permissionMode: 'workspace_write',
                retentionPolicy: 'ephemeral',
                runClass: 'bounded',
                ioMode: 'request_response',
                startDisposition: 'recovered_after_observation_timeout',
            },
        });
    });

    it('does not recover a marker when the request id matches but its fingerprint differs', async () => {
        const request = {
            intent: 'plan',
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            permissionMode: 'workspace_write',
            retentionPolicy: 'ephemeral',
            runClass: 'bounded',
            ioMode: 'request_response',
            startRequestId: 'action-request-1',
        } as const;
        callSessionRpc.mockRejectedValueOnce(new Error('RPC call timeout'));
        listExecutionRunMarkers.mockResolvedValueOnce([
            createMarker({
                runId: 'run-conflicting',
                status: 'running',
                startedAtMs: 20,
                startRequestId: 'action-request-1',
                startRequestFingerprint: fingerprintExecutionRunStartRequest({
                    ...request,
                    instructions: 'A different start request',
                }),
            }),
        ]);

        await expect(startExecutionRun({
            token: 'token',
            sessionId: 'sess-1',
            ctx: { encryptionKey: new Uint8Array([1, 2, 3, 4]), encryptionVariant: 'legacy' },
            request,
        })).resolves.toEqual({
            ok: false,
            code: 'execution_run_start_ambiguous',
            message: 'RPC call timeout',
            details: {
                startRequestId: 'action-request-1',
                retrySafe: true,
                reconcileVia: 'retry_execution_run_start',
            },
        });
    });

    it.each([
        ['RPC call timeout', () => markRpcRequestDisposition(new Error('RPC call timeout'), 'outcomeUnknown')],
        ['RPC socket disconnected before acknowledgement', () => markRpcRequestDisposition(new SocketRpcDisconnectBeforeAcknowledgementError(), 'outcomeUnknown')],
    ] as const)('reports an uncorrelated %s as ambiguous rather than target unavailable', async (message, createError) => {
        callSessionRpc.mockRejectedValueOnce(createError());

        await expect(startExecutionRun({
            token: 'token',
            sessionId: 'sess-1',
            ctx: { encryptionKey: new Uint8Array([1, 2, 3, 4]), encryptionVariant: 'legacy' },
            request: { intent: 'review' },
        })).resolves.toEqual({
            ok: false,
            code: 'execution_run_start_ambiguous',
            message,
        });
        expect(listExecutionRunMarkers).not.toHaveBeenCalled();
    });

    it.each([
        ['Socket connect timeout', () => new Error('Socket connect timeout')],
        ['RPC socket disconnected before acknowledgement', () => markRpcRequestDisposition(new SocketRpcDisconnectBeforeAcknowledgementError(), 'notSent')],
    ] as const)('keeps pre-acceptance %s distinct from ambiguous observation failures', async (message, createError) => {
        callSessionRpc.mockRejectedValueOnce(createError());

        await expect(startExecutionRun({
            token: 'token',
            sessionId: 'sess-1',
            ctx: { encryptionKey: new Uint8Array([1, 2, 3, 4]), encryptionVariant: 'legacy' },
            request: { intent: 'review', startRequestId: 'action-request-2' },
        })).resolves.toEqual({
            ok: false,
            code: 'execution_run_target_unavailable',
            message,
        });
        expect(listExecutionRunMarkers).not.toHaveBeenCalled();
    });
});

describe('getExecutionRun', () => {
    beforeEach(() => {
        callSessionRpc.mockReset();
        listExecutionRunMarkers.mockReset();
        readRawSessionHistoryRows.mockReset();
    });

    it('returns an invalid response error when a successful rpc get payload does not match the contract', async () => {
        callSessionRpc.mockResolvedValueOnce({
            run: { runId: 'missing-required-fields' },
        });
        listExecutionRunMarkers.mockResolvedValueOnce([]);

        const result = await getExecutionRun({
            token: 'token',
            sessionId: 'sess-1',
            ctx: { encryptionKey: new Uint8Array([1, 2, 3, 4]), encryptionVariant: 'legacy' },
            request: { runId: 'run-invalid' },
        });

        expect(result).toEqual({
            ok: false,
            code: 'execution_run_invalid_response',
            message: 'Invalid execution run get response',
        });
    });

    it('preserves the original rpc app-level error when transcript fallback lookup fails', async () => {
        callSessionRpc.mockResolvedValueOnce({
            ok: false,
            errorCode: 'execution_run_not_found',
            error: 'Not found',
        });
        listExecutionRunMarkers.mockResolvedValueOnce([]);
        readRawSessionHistoryRows.mockResolvedValueOnce([]);

        const result = await getExecutionRun({
            token: 'token',
            sessionId: 'sess-1',
            ctx: { encryptionKey: new Uint8Array([1, 2, 3, 4]), encryptionVariant: 'legacy' },
            request: { runId: 'run-missing' },
        });

        expect(result).toEqual({
            ok: false,
            code: 'execution_run_not_found',
            message: 'Not found',
        });
    });

    it('falls back to transcript-backed execution run state when rpc is unavailable and no markers remain', async () => {
        callSessionRpc.mockRejectedValueOnce(new Error('RPC method not available'));
        listExecutionRunMarkers.mockResolvedValueOnce([]);
        readRawSessionHistoryRows.mockResolvedValueOnce([
            {
                id: '1',
                createdAt: 10,
                role: 'agent',
                raw: {
                    role: 'agent',
                    content: {
                        type: 'acp',
                        provider: 'claude',
                        data: {
                            type: 'tool-call',
                            callId: 'call_hist_1',
                            name: 'SubAgentRun',
                            input: {
                                runId: 'run_hist_1',
                                callId: 'call_hist_1',
                                sidechainId: 'call_hist_1',
                                intent: 'plan',
                                backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
                                permissionMode: 'workspace_write',
                                retentionPolicy: 'ephemeral',
                                runClass: 'bounded',
                                ioMode: 'request_response',
                            },
                        },
                    },
                },
            },
            {
                id: '2',
                createdAt: 20,
                role: 'agent',
                raw: {
                    role: 'agent',
                    content: {
                        type: 'acp',
                        provider: 'claude',
                        data: {
                            type: 'tool-result',
                            callId: 'call_hist_1',
                            output: {
                                _happier: {
                                    canonicalToolName: 'SubAgentRun',
                                },
                                runId: 'run_hist_1',
                                callId: 'call_hist_1',
                                sidechainId: 'call_hist_1',
                                backendId: 'claude',
                                intent: 'plan',
                                permissionMode: 'workspace_write',
                                retentionPolicy: 'ephemeral',
                                runClass: 'bounded',
                                ioMode: 'request_response',
                                status: 'succeeded',
                                startedAtMs: 10,
                                finishedAtMs: 20,
                            },
                        },
                    },
                },
            },
        ]);

        const result = await getExecutionRun({
            token: 'token',
            sessionId: 'sess-1',
            ctx: { encryptionKey: new Uint8Array([1, 2, 3, 4]), encryptionVariant: 'legacy' },
            request: { runId: 'run_hist_1' },
        });

        expect(result).toEqual({
            ok: true,
            data: {
                run: {
                    runId: 'run_hist_1',
                    callId: 'call_hist_1',
                    sidechainId: 'call_hist_1',
                    intent: 'plan',
                    backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
                    permissionMode: 'workspace_write',
                    retentionPolicy: 'ephemeral',
                    runClass: 'bounded',
                    ioMode: 'request_response',
                    status: 'succeeded',
                    startedAtMs: 10,
                    finishedAtMs: 20,
                },
            },
        });
    });

    it('prefers transcript-backed execution run state over stale marker state during get fallback', async () => {
        callSessionRpc.mockResolvedValueOnce({
            ok: false,
            errorCode: 'execution_run_not_found',
            error: 'Not found',
        });
        listExecutionRunMarkers.mockResolvedValueOnce([
            createMarker({ runId: 'run_hist_1', status: 'running', startedAtMs: 10 }),
        ]);
        readRawSessionHistoryRows.mockResolvedValueOnce(createTranscriptRows({
            runId: 'run_hist_1',
            callId: 'call_hist_1',
            status: 'succeeded',
            startedAtMs: 10,
        }));

        const result = await getExecutionRun({
            token: 'token',
            sessionId: 'sess-1',
            ctx: { encryptionKey: new Uint8Array([1, 2, 3, 4]), encryptionVariant: 'legacy' },
            request: { runId: 'run_hist_1' },
        });

        expect(result).toEqual({
            ok: true,
            data: {
                run: {
                    runId: 'run_hist_1',
                    callId: 'call_hist_1',
                    sidechainId: 'call_hist_1',
                    intent: 'plan',
                    backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
                    permissionMode: 'workspace_write',
                    retentionPolicy: 'ephemeral',
                    runClass: 'bounded',
                    ioMode: 'request_response',
                    status: 'succeeded',
                    startedAtMs: 10,
                    finishedAtMs: 20,
                },
            },
        });
    });

    it('reports target unavailable when the rpc target and get recovery are unavailable', async () => {
        callSessionRpc.mockRejectedValueOnce(new Error('Socket connect timeout'));
        listExecutionRunMarkers.mockResolvedValueOnce([]);
        readRawSessionHistoryRows.mockRejectedValueOnce(new Error('transcript fetch failed'));

        const result = await getExecutionRun({
            token: 'token',
            sessionId: 'sess-1',
            ctx: { encryptionKey: new Uint8Array([1, 2, 3, 4]), encryptionVariant: 'legacy' },
            request: { runId: 'run-missing' },
        });

        expect(result).toEqual({
            ok: false,
            code: 'execution_run_target_unavailable',
            message: 'Socket connect timeout',
        });
    });

    it('reports protocol unsupported when the get rpc method is unavailable and bounded recovery finds no run', async () => {
        callSessionRpc.mockRejectedValueOnce(new Error('Method not found'));
        listExecutionRunMarkers.mockResolvedValueOnce([]);
        readRawSessionHistoryRows.mockResolvedValueOnce([]);

        const result = await getExecutionRun({
            token: 'token',
            sessionId: 'sess-1',
            ctx: { encryptionKey: new Uint8Array([1, 2, 3, 4]), encryptionVariant: 'legacy' },
            request: { runId: 'run-missing' },
        });

        expect(result).toEqual({
            ok: false,
            code: 'execution_run_protocol_unsupported',
            message: 'Method not found',
        });
    });
});

describe('sendExecutionRunMessage', () => {
    beforeEach(() => {
        callSessionRpc.mockReset();
    });

    it('keeps effectful provider admission under execution-run lifecycle ownership', async () => {
        callSessionRpc.mockResolvedValueOnce({ ok: true });

        await sendExecutionRunMessage({
            token: 'token',
            sessionId: 'sess-1',
            ctx: { encryptionKey: new Uint8Array([1, 2, 3, 4]), encryptionVariant: 'legacy' },
            request: { runId: 'run-1', message: 'continue', delivery: 'steer_if_supported' },
        });

        expect(callSessionRpc).toHaveBeenCalledWith(expect.objectContaining({
            method: 'sess-1:execution.run.send',
            timeoutMs: null,
        }));
    });

    it('returns outcome unknown when transport fails after the send request was emitted', async () => {
        callSessionRpc.mockRejectedValueOnce(markRpcRequestDisposition(
            new Error('socket disconnected before acknowledgement'),
            'outcomeUnknown',
        ));

        const result = await sendExecutionRunMessage({
            token: 'token',
            sessionId: 'sess-1',
            ctx: { encryptionKey: new Uint8Array([1, 2, 3, 4]), encryptionVariant: 'legacy' },
            request: { runId: 'run-1', message: 'continue', delivery: 'steer_if_supported' },
        });

        expect(result).toEqual({
            ok: false,
            code: 'execution_run_send_outcome_unknown',
            message: 'The input may have been accepted before the provider request failed',
        });
    });

    it('returns target unavailable when transport proves the send request was not emitted', async () => {
        callSessionRpc.mockRejectedValueOnce(markRpcRequestDisposition(
            new Error('socket disconnected before request emission'),
            'notSent',
        ));

        const result = await sendExecutionRunMessage({
            token: 'token',
            sessionId: 'sess-1',
            ctx: { encryptionKey: new Uint8Array([1, 2, 3, 4]), encryptionVariant: 'legacy' },
            request: { runId: 'run-1', message: 'continue', delivery: 'steer_if_supported' },
        });

        expect(result).toEqual({
            ok: false,
            code: 'execution_run_target_unavailable',
            message: 'socket disconnected before request emission',
        });
    });
});

describe('effectful execution-run controls', () => {
    beforeEach(() => {
        callSessionRpc.mockReset();
        callSessionRpc.mockResolvedValue({ ok: true });
    });

    it.each([
        ['execution.run.action', executeExecutionRunAction],
        ['execution.run.stop', stopExecutionRun],
        ['execution.run.stream.start', startExecutionRunStream],
        ['execution.run.stream.cancel', cancelExecutionRunStream],
    ] as const)('keeps %s under execution-run lifecycle ownership', async (method, invoke) => {
        await invoke({
            token: 'token',
            sessionId: 'sess-1',
            ctx: { encryptionKey: new Uint8Array([1, 2, 3, 4]), encryptionVariant: 'legacy' },
            request: { runId: 'run-1' },
        });

        expect(callSessionRpc).toHaveBeenCalledWith(expect.objectContaining({
            method: `sess-1:${method}`,
            timeoutMs: null,
        }));
    });
});

describe('waitForExecutionRun', () => {
    beforeEach(() => {
        callSessionRpc.mockReset();
        listExecutionRunMarkers.mockReset();
        readRawSessionHistoryRows.mockReset();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('waits through one event-driven daemon RPC when timeoutMs is null', async () => {
        const succeededRun = createRun({ runId: 'run_1', status: 'succeeded', startedAtMs: 1 });
        callSessionRpc.mockResolvedValueOnce({
            ok: true,
            status: 'succeeded',
            result: { run: succeededRun },
        });

        const waitPromise = waitForExecutionRun({
            token: 'token',
            sessionId: 'sess-1',
            ctx: { encryptionKey: new Uint8Array([1, 2, 3, 4]), encryptionVariant: 'legacy' },
            runId: 'run_1',
            timeoutMs: null,
        });

        await expect(waitPromise).resolves.toEqual({
            ok: true,
            status: 'succeeded',
            result: { run: succeededRun },
        });
        expect(callSessionRpc).toHaveBeenCalledOnce();
        expect(callSessionRpc).toHaveBeenCalledWith(expect.objectContaining({
            method: 'sess-1:execution.run.wait',
            request: { runId: 'run_1' },
            timeoutMs: null,
        }));
    });

    it('uses the daemon observation timeout without polling get repeatedly', async () => {
        callSessionRpc.mockResolvedValueOnce({
            ok: true,
            status: 'running',
            disposition: 'observation_timeout',
            runId: 'run_1',
            timeoutMs: 1_000,
            observedAtMs: 1_200,
            deadlineAtMs: 1_200,
        });

        const waitPromise = waitForExecutionRun({
            token: 'token',
            sessionId: 'sess-1',
            ctx: { encryptionKey: new Uint8Array([1, 2, 3, 4]), encryptionVariant: 'legacy' },
            runId: 'run_1',
            timeoutMs: 100,
        });

        await expect(waitPromise).resolves.toMatchObject({
            ok: true,
            status: 'running',
            disposition: 'observation_timeout',
            runId: 'run_1',
            timeoutMs: 1_000,
        });
        expect(callSessionRpc).toHaveBeenCalledOnce();
        expect(callSessionRpc).toHaveBeenCalledWith(expect.objectContaining({
            method: 'sess-1:execution.run.wait',
            request: { runId: 'run_1', timeoutSeconds: 1 },
        }));
    });

    it('takes one compatibility snapshot then reports unsupported when an older daemon still has a running run', async () => {
        const runningRun = createRun({ runId: 'run_1', status: 'running', startedAtMs: 1 });
        callSessionRpc
            .mockRejectedValueOnce(new Error('Method not found'))
            .mockResolvedValueOnce({ run: runningRun });
        listExecutionRunMarkers.mockResolvedValueOnce([]);

        const result = await waitForExecutionRun({
            token: 'token',
            sessionId: 'sess-1',
            ctx: { encryptionKey: new Uint8Array([1, 2, 3, 4]), encryptionVariant: 'legacy' },
            runId: 'run_1',
            timeoutMs: null,
        });

        expect(result).toEqual({
            ok: false,
            code: 'execution_run_protocol_unsupported',
            message: 'Method not found',
        });
        expect(callSessionRpc).toHaveBeenCalledTimes(2);
        expect(callSessionRpc.mock.calls.map(([call]) => call.method)).toEqual([
            'sess-1:execution.run.wait',
            'sess-1:execution.run.get',
        ]);
    });
});

describe('startExecutionRunV2', () => {
    beforeEach(() => {
        callSessionRpc.mockReset();
        listExecutionRunMarkers.mockReset();
    });

    const ctx = { encryptionKey: new Uint8Array([1, 2, 3, 4]), encryptionVariant: 'legacy' } as const;

    it('calls only the exact execution.run.start.v2 method under caller lifecycle ownership', async () => {
        callSessionRpc.mockResolvedValueOnce({ ok: true, data: { runId: 'run-1' } });
        await startExecutionRunV2({ token: 'token', sessionId: 'sess-1', ctx, request: { intent: 'review', visibility: 'session' } });
        expect(callSessionRpc).toHaveBeenCalledTimes(1);
        expect(callSessionRpc).toHaveBeenCalledWith(expect.objectContaining({ method: 'sess-1:execution.run.start.v2', timeoutMs: null }));
    });

    it('reports a server forward timeout after the request was sent as ambiguous, with its start request id for the resume', async () => {
        // A server that cuts the forward acknowledges { ok: false, error: 'operation has timed out' } (socket.io ack timeout).
        callSessionRpc.mockRejectedValueOnce(markRpcRequestDisposition(createRpcAcknowledgementError({ error: 'operation has timed out' }), 'outcomeUnknown'));
        await expect(startExecutionRunV2({
            token: 'token',
            sessionId: 'sess-1',
            ctx,
            request: { intent: 'review', visibility: 'session', startRequestId: 'action-request-9' },
        })).resolves.toEqual({
            ok: false,
            code: 'execution_run_start_ambiguous',
            message: 'operation has timed out',
            details: { startRequestId: 'action-request-9', retrySafe: true, reconcileVia: 'retry_execution_run_start' },
        });
    });

    it.each([
        ['visible', { intent: 'review', visibility: 'session' }, 'execution_run_visibility_unsupported'],
        ['role-bearing', { intent: 'review', visibility: 'hidden', role: 'reviewer', roleSource: 'explicit' }, 'execution_run_role_unsupported'],
    ] as const)('fails closed with a typed error when the runner lacks the method (%s), never falling back', async (_case, request, code) => {
        callSessionRpc.mockRejectedValueOnce(new Error('RPC method not available'));
        await expect(startExecutionRunV2({ token: 'token', sessionId: 'sess-1', ctx, request })).resolves.toEqual(expect.objectContaining({ ok: false, code }));
        callSessionRpc.mockResolvedValueOnce({ ok: false, error: 'Method not found', errorCode: 'RPC_METHOD_NOT_FOUND' });
        await expect(startExecutionRunV2({ token: 'token', sessionId: 'sess-1', ctx, request })).resolves.toEqual(expect.objectContaining({ ok: false, code }));
        expect(callSessionRpc).toHaveBeenCalledTimes(2);
        for (const call of callSessionRpc.mock.calls) expect(call[0].method).toBe('sess-1:execution.run.start.v2');
    });
});

describe('startExecutionRun rejects v2-only fields', () => {
    beforeEach(() => callSessionRpc.mockReset());

    it.each(['visibility', 'role', 'roleSource', 'targetSessionId'] as const)('never sends %s through execution.run.start', async (field) => {
        await expect(startExecutionRun({
            token: 'token',
            sessionId: 'sess-1',
            ctx: { encryptionKey: new Uint8Array([1, 2, 3, 4]), encryptionVariant: 'legacy' },
            request: { intent: 'review', [field]: field === 'visibility' ? 'session' : 'x' },
        })).resolves.toEqual(expect.objectContaining({ ok: false }));
        expect(callSessionRpc).not.toHaveBeenCalled();
    });
});
