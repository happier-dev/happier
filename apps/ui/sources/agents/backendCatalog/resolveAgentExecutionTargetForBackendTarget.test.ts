import { describe, expect, it } from 'vitest';

import { resolveAgentExecutionTargetForBackendTarget } from './resolveAgentExecutionTargetForBackendTarget';

describe('resolveAgentExecutionTargetForBackendTarget', () => {
    it('uses the bundled qualified identity for a built-in backend', () => {
        expect(resolveAgentExecutionTargetForBackendTarget({
            backendTarget: { kind: 'backend', backendId: 'codex' },
        })).toEqual({
            kind: 'agent',
            identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
        });
    });

    it('fails closed for a configured backend even when its daemon projection resolves an Agent identity', () => {
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
        })).toBeNull();
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
});
