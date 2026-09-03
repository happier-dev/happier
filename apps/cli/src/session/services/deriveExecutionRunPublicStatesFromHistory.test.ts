import { describe, expect, it } from 'vitest';

import { listExecutionRunPublicStatesFromHistoryRows } from './deriveExecutionRunPublicStatesFromHistory';

describe('listExecutionRunPublicStatesFromHistoryRows', () => {
    it('reconstructs canonical timestamps when a tool result row arrives before an older tool call row', () => {
        const runs = listExecutionRunPublicStatesFromHistoryRows([
            {
                id: 'result-row',
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
                    },
                },
            },
            {
                id: 'call-row',
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
                                launchOrigin: { kind: 'external' },
                            },
                        },
                    },
                },
            },
        ]);

        expect(runs).toEqual([
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
                launchOrigin: { kind: 'external' },
                status: 'succeeded',
                startedAtMs: 10,
                finishedAtMs: 20,
            },
        ]);
    });

    it('reconstructs backendTarget from a legacy built-in backendId when only a tool-result row is available', () => {
        const runs = listExecutionRunPublicStatesFromHistoryRows([
            {
                id: 'result-row',
                createdAt: 20,
                role: 'agent',
                raw: {
                    role: 'agent',
                    content: {
                        type: 'acp',
                        provider: 'claude',
                        data: {
                            type: 'tool-result',
                            callId: 'call_hist_legacy_builtin',
                            output: {
                                _happier: {
                                    canonicalToolName: 'SubAgentRun',
                                },
                                runId: 'run_hist_legacy_builtin',
                                callId: 'call_hist_legacy_builtin',
                                sidechainId: 'call_hist_legacy_builtin',
                                intent: 'plan',
                                backendId: 'claude',
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

        expect(runs).toEqual([
            {
                runId: 'run_hist_legacy_builtin',
                callId: 'call_hist_legacy_builtin',
                sidechainId: 'call_hist_legacy_builtin',
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
        ]);
    });

    it('reconstructs backendTarget from a legacy configured ACP backendId when only a tool-result row is available', () => {
        const runs = listExecutionRunPublicStatesFromHistoryRows([
            {
                id: 'result-row',
                createdAt: 20,
                role: 'agent',
                raw: {
                    role: 'agent',
                    content: {
                        type: 'acp',
                        provider: 'claude',
                        data: {
                            type: 'tool-result',
                            callId: 'call_hist_legacy_acp',
                            output: {
                                _happier: {
                                    canonicalToolName: 'SubAgentRun',
                                },
                                runId: 'run_hist_legacy_acp',
                                callId: 'call_hist_legacy_acp',
                                sidechainId: 'call_hist_legacy_acp',
                                intent: 'review',
                                backendId: 'review-bot',
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

        expect(runs).toEqual([
            {
                runId: 'run_hist_legacy_acp',
                callId: 'call_hist_legacy_acp',
                sidechainId: 'call_hist_legacy_acp',
                intent: 'review',
                backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
                permissionMode: 'workspace_write',
                retentionPolicy: 'ephemeral',
                runClass: 'bounded',
                ioMode: 'request_response',
                status: 'succeeded',
                startedAtMs: 10,
                finishedAtMs: 20,
            },
        ]);
    });

    it('never borrows the finish instant for a run whose start was never recorded (D-8)', () => {
        const runs = listExecutionRunPublicStatesFromHistoryRows([
            {
                id: 'result-row',
                createdAt: Number.NaN,
                role: 'agent',
                raw: {
                    role: 'agent',
                    content: {
                        type: 'acp',
                        provider: 'claude',
                        data: {
                            type: 'tool-result',
                            callId: 'call_hist_no_start',
                            output: {
                                _happier: { canonicalToolName: 'SubAgentRun' },
                                runId: 'run_hist_no_start',
                                callId: 'call_hist_no_start',
                                sidechainId: 'call_hist_no_start',
                                intent: 'plan',
                                backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
                                permissionMode: 'workspace_write',
                                retentionPolicy: 'ephemeral',
                                runClass: 'bounded',
                                ioMode: 'request_response',
                                status: 'succeeded',
                                finishedAtMs: 16_000,
                            },
                        },
                    },
                },
            },
        ]);

        expect(runs).toHaveLength(1);
        expect(runs[0]?.finishedAtMs).toBe(16_000);
        // A start taken from the finish reports the run as having taken zero time. The wire field is
        // required, so 0 is the unknown sentinel and readers must not print it as an instant.
        expect(runs[0]?.startedAtMs).toBe(0);
    });
});
