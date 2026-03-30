import { beforeEach, describe, expect, it, vi } from 'vitest';

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

import { getExecutionRun, listExecutionRuns, normalizeExecutionRunRpcPayload } from './executionRuns';

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

    it('returns an empty list when rpc is unavailable and no markers or transcript runs exist', async () => {
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
            ok: true,
            data: {
                runs: [],
            },
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

    it('preserves the original rpc app-level list error when transcript fallback lookup fails', async () => {
        callSessionRpc.mockResolvedValueOnce({
            ok: false,
            errorCode: 'execution_run_not_found',
            error: 'Not found',
        });
        listExecutionRunMarkers.mockResolvedValueOnce([]);
        readRawSessionHistoryRows.mockRejectedValueOnce(new Error('transcript fetch failed'));

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

    it('preserves the original rpc transport error when transcript list fallback lookup fails', async () => {
        callSessionRpc.mockRejectedValueOnce(new Error('Socket connect timeout'));
        listExecutionRunMarkers.mockResolvedValueOnce([]);
        readRawSessionHistoryRows.mockRejectedValueOnce(new Error('transcript fetch failed'));

        const result = await listExecutionRuns({
            token: 'token',
            sessionId: 'sess-1',
            ctx: { encryptionKey: new Uint8Array([1, 2, 3, 4]), encryptionVariant: 'legacy' },
            request: {},
        });

        expect(result).toEqual({
            ok: false,
            code: 'unknown_error',
            message: 'Socket connect timeout',
        });
    });
});

describe('normalizeExecutionRunRpcPayload', () => {
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
        readRawSessionHistoryRows.mockRejectedValueOnce(new Error('transcript fetch failed'));

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

    it('preserves the original rpc transport error when transcript get fallback lookup fails', async () => {
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
            code: 'unknown_error',
            message: 'Socket connect timeout',
        });
    });
});
