import { describe, expect, it } from 'vitest';

import { resolveAgentExecutionTargetForBackendTarget } from './resolveAgentExecutionTargetForBackendTarget';

describe('resolveAgentExecutionTargetForBackendTarget', () => {
    it('retains the selected definition of the declared Custom ACP Agent', () => {
        expect(resolveAgentExecutionTargetForBackendTarget({
            backendTarget: { kind: 'backend', backendId: 'review-a', configuredBackendId: 'review-a' },
        })).toEqual({ kind: 'agent',
            identity: { pluginId: 'happier.agent.custom-acp', localId: 'custom-acp' }, definitionId: 'review-a' });
    });
    it('preserves an already-qualified external Agent identity without a backend alias', () => {
        expect(resolveAgentExecutionTargetForBackendTarget({
            backendTarget: {
                kind: 'agent',
                identity: { pluginId: 'acme.review', localId: 'reviewer' },
            },
        })).toEqual({
            kind: 'agent',
            identity: { pluginId: 'acme.review', localId: 'reviewer' },
        });
    });

    it('uses the bundled qualified identity for a built-in backend', () => {
        expect(resolveAgentExecutionTargetForBackendTarget({
            backendTarget: { kind: 'backend', backendId: 'codex' },
        })).toEqual({
            kind: 'agent',
            identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
        });
    });

    it('retains configured definition identity even with a stale unrelated daemon backend projection', () => {
        expect(resolveAgentExecutionTargetForBackendTarget({
            backendTarget: {
                kind: 'backend',
                backendId: 'review-bot',
                configuredBackendId: 'review-bot',
            },
            daemonMergedProjectionInputs: {
                mergedBackendProjectionById: {
                    'review-bot': { backendId: 'review-bot', agentId: 'review-agent' },
                },
                mergedProviderProjectionById: {
                    'review-agent': {
                        agentId: 'review-agent',
                        identity: { pluginId: 'example.review', localId: 'review-agent' },
                    },
                },
            },
        })).toEqual({
            kind: 'agent',
            identity: { pluginId: 'happier.agent.custom-acp', localId: 'custom-acp' },
            definitionId: 'review-bot',
        });
    });

    it('uses a daemon projection identity for a non-configured plugin backend', () => {
        expect(resolveAgentExecutionTargetForBackendTarget({
            backendTarget: {
                kind: 'backend',
                backendId: 'review-agent',
            },
            daemonMergedProjectionInputs: {
                mergedBackendProjectionById: {
                    'review-agent': { backendId: 'review-agent', agentId: 'review-agent' },
                },
                mergedProviderProjectionById: {
                    'review-agent': {
                        agentId: 'review-agent',
                        identity: { pluginId: 'example.review', localId: 'review-agent' },
                    },
                },
            },
        })).toEqual({
            kind: 'agent',
            identity: { pluginId: 'example.review', localId: 'review-agent' },
        });
    });

    it('fails closed when a non-bundled backend lacks a projection identity', () => {
        expect(resolveAgentExecutionTargetForBackendTarget({
            backendTarget: { kind: 'backend', backendId: 'review-bot' },
        })).toBeNull();
    });

    it('refuses an unqualified Custom ACP container even when projected by the daemon', () => {
        expect(resolveAgentExecutionTargetForBackendTarget({
            backendTarget: { kind: 'backend', backendId: 'custom-acp' },
            daemonMergedProjectionInputs: {
                mergedProviderProjectionById: {
                    'custom-acp': { agentId: 'custom-acp',
                        identity: { pluginId: 'happier.agent.custom-acp', localId: 'custom-acp' } },
                },
            },
        })).toBeNull();
    });
});
