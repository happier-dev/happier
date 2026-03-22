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
});
