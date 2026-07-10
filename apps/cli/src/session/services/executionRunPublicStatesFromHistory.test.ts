import { describe, expect, it } from 'vitest';

import { listExecutionRunPublicStatesFromHistoryRows } from './executionRunPublicStatesFromHistory';

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
                        agentId: 'claude',
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
                        agentId: 'claude',
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
                        agentId: 'claude',
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

    it('prefers configured legacy provenance fields when reconstructing backendTarget from legacy ids', () => {
        const runs = listExecutionRunPublicStatesFromHistoryRows([
            {
                id: 'result-row',
                createdAt: 20,
                role: 'agent',
                raw: {
                    role: 'agent',
                    content: {
                        type: 'acp',
                        agentId: 'claude',
                        data: {
                            type: 'tool-result',
                            callId: 'call_hist_legacy_configured_hint',
                            output: {
                                _happier: {
                                    canonicalToolName: 'SubAgentRun',
                                },
                                runId: 'run_hist_legacy_configured_hint',
                                callId: 'call_hist_legacy_configured_hint',
                                sidechainId: 'call_hist_legacy_configured_hint',
                                intent: 'plan',
                                backendId: 'claude',
                                sourceKind: 'configured',
                                configuredBackendId: 'review-bot',
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
                runId: 'run_hist_legacy_configured_hint',
                callId: 'call_hist_legacy_configured_hint',
                sidechainId: 'call_hist_legacy_configured_hint',
                intent: 'plan',
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
                        agentId: 'claude',
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

    it('normalizes BackendTargetRefV2 payloads back into the public V1 history contract', () => {
        const runs = listExecutionRunPublicStatesFromHistoryRows([
            {
                id: 'result-row',
                createdAt: 20,
                role: 'agent',
                raw: {
                    role: 'agent',
                    content: {
                        type: 'acp',
                        agentId: 'claude',
                        data: {
                            type: 'tool-result',
                            callId: 'call_hist_v2_acp',
                            output: {
                                _happier: {
                                    canonicalToolName: 'SubAgentRun',
                                },
                                runId: 'run_hist_v2_acp',
                                callId: 'call_hist_v2_acp',
                                sidechainId: 'call_hist_v2_acp',
                                intent: 'review',
                                backendTarget: {
                                    kind: 'backend',
                                    backendId: 'review-bot',
                                    configuredBackendId: 'review-bot',
                                    sourceKind: 'configured',
                                },
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
                runId: 'run_hist_v2_acp',
                callId: 'call_hist_v2_acp',
                sidechainId: 'call_hist_v2_acp',
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

    it('does not reconstruct backendTarget from an ambiguous legacy customAcp backendId', () => {
        const runs = listExecutionRunPublicStatesFromHistoryRows([
            {
                id: 'result-row',
                createdAt: 20,
                role: 'agent',
                raw: {
                    role: 'agent',
                    content: {
                        type: 'acp',
                        agentId: 'claude',
                        data: {
                            type: 'tool-result',
                            callId: 'call_hist_legacy_custom_acp',
                            output: {
                                _happier: {
                                    canonicalToolName: 'SubAgentRun',
                                },
                                runId: 'run_hist_legacy_custom_acp',
                                callId: 'call_hist_legacy_custom_acp',
                                sidechainId: 'call_hist_legacy_custom_acp',
                                intent: 'review',
                                backendId: 'customAcp',
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

        expect(runs).toEqual([]);
    });

    it('does not accept an explicit builtIn customAcp backendTarget from history rows', () => {
        const runs = listExecutionRunPublicStatesFromHistoryRows([
            {
                id: 'result-row',
                createdAt: 20,
                role: 'agent',
                raw: {
                    role: 'agent',
                    content: {
                        type: 'acp',
                        agentId: 'claude',
                        data: {
                            type: 'tool-result',
                            callId: 'call_hist_explicit_custom_acp',
                            output: {
                                _happier: {
                                    canonicalToolName: 'SubAgentRun',
                                },
                                runId: 'run_hist_explicit_custom_acp',
                                callId: 'call_hist_explicit_custom_acp',
                                sidechainId: 'call_hist_explicit_custom_acp',
                                intent: 'review',
                                backendTarget: { kind: 'builtInAgent', agentId: 'customAcp' },
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

        expect(runs).toEqual([]);
    });
});
