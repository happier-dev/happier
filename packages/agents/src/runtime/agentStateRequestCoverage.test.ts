import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
    isAgentStateRequestCoveredByCompletedRequests,
    resolveAgentStateRequestCoverageOptions,
} from './agentStateRequestCoverage';

const bridgeCoverageOptions = resolveAgentStateRequestCoverageOptions({ kind: 'localPermissionBridge' });
const LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE = bridgeCoverageOptions.equivalentSources?.[0] ?? '';
const LOCAL_PERMISSION_BRIDGE_STOPPED_REASON = bridgeCoverageOptions.equivalentCompletedReasons?.[0] ?? '';

describe('isAgentStateRequestCoveredByCompletedRequests', () => {
    it('resolves local permission bridge coverage options without a provider-specific caller import', () => {
        expect(bridgeCoverageOptions).toEqual({
            equivalentSources: ['claude_local_permission_bridge'],
            equivalentCompletedStatuses: ['canceled'],
            equivalentCompletedReasons: ['Local permission bridge stopped'],
        });
    });

    it('keeps generic CLI and UI request coverage callers out of Claude plugin leaves', () => {
        const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
        const genericCallerPaths = [
            'apps/cli/src/agent/permissions/agentStateRequestStore.ts',
            'apps/cli/src/api/session/deriveActivitySummaryFromAgentState.ts',
            'apps/ui/sources/sync/domains/session/pending/listPendingSessionRequests.ts',
        ] as const;

        for (const relativePath of genericCallerPaths) {
            const source = readFileSync(resolve(repoRoot, relativePath), 'utf8');
            expect(source).not.toContain('@happier-dev/plugins-claude/agent/permissions/requestSource');
            expect(source).not.toContain('CLAUDE_LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE');
            expect(source).not.toContain('CLAUDE_LOCAL_PERMISSION_BRIDGE_STOPPED_REASON');
        }
    });

    it('does not cover generic same-id requests just because the completed entry is newer', () => {
        expect(isAgentStateRequestCoveredByCompletedRequests({
            requestId: 'req-1',
            request: { tool: 'Write', arguments: {}, createdAt: 10 },
            completedRequests: {
                'req-1': { tool: 'Write', arguments: {}, completedAt: 20 },
            },
        })).toBe(false);
    });

    it('covers matching same-id requests when the completed entry has a terminal status', () => {
        expect(isAgentStateRequestCoveredByCompletedRequests({
            requestId: 'req-1',
            request: { tool: 'Write', arguments: { path: 'next.txt' }, createdAt: 10 },
            completedRequests: {
                'req-1': {
                    tool: 'Write',
                    arguments: { path: 'next.txt' },
                    completedAt: 20,
                    status: 'approved',
                },
            },
        })).toBe(true);
    });

    it('covers equivalent same-id bridge requests when a canonical cancellation is newer', () => {
        expect(isAgentStateRequestCoveredByCompletedRequests({
            requestId: 'req-1',
            request: {
                tool: 'AskUserQuestion',
                kind: 'user_action',
                arguments: { questions: [{ question: 'Proceed?' }] },
                createdAt: 10_400,
                source: LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE,
            },
            completedRequests: {
                'req-1': {
                    tool: 'AskUserQuestion',
                    kind: 'user_action',
                    arguments: { questions: [{ question: 'Proceed?' }] },
                    completedAt: 10_000,
                    status: 'canceled',
                    reason: LOCAL_PERMISSION_BRIDGE_STOPPED_REASON,
                    source: LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE,
                },
            },
            options: bridgeCoverageOptions,
        })).toBe(true);
    });

    it('does not cover same-id requests with different arguments', () => {
        expect(isAgentStateRequestCoveredByCompletedRequests({
            requestId: 'req-1',
            request: { tool: 'Write', arguments: { path: 'next.txt' }, createdAt: 10 },
            completedRequests: {
                'req-1': { tool: 'Write', arguments: { path: 'previous.txt' }, completedAt: 20 },
            },
        })).toBe(false);
    });

    it('does not cover terminal same-id requests when the completed entry carries different arguments', () => {
        expect(isAgentStateRequestCoveredByCompletedRequests({
            requestId: 'req-1',
            request: { tool: 'Write', arguments: { path: 'next.txt' }, createdAt: 10 },
            completedRequests: {
                'req-1': {
                    tool: 'Write',
                    arguments: { path: 'previous.txt' },
                    completedAt: 20,
                    status: 'approved',
                },
            },
        })).toBe(false);
    });

    it('does not cover same-id requests from a different owner', () => {
        expect(isAgentStateRequestCoveredByCompletedRequests({
            requestId: 'req-1',
            request: {
                tool: 'Write',
                arguments: {},
                createdAt: 10,
                owner: { kind: 'plugin', pluginId: 'plugin-b', runtimeId: 'runtime-b' },
            },
            completedRequests: {
                'req-1': {
                    tool: 'Write',
                    arguments: {},
                    completedAt: 20,
                    owner: { kind: 'plugin', pluginId: 'plugin-a', runtimeId: 'runtime-a' },
                },
            },
        })).toBe(false);
    });

    it('covers fresh generated bridge requests when a canonical cancellation has the same payload', () => {
        const question = { questions: [{ question: 'Proceed?', options: [{ label: 'Yes' }] }] };

        expect(isAgentStateRequestCoveredByCompletedRequests({
            requestId: 'perm_generated',
            request: {
                tool: 'AskUserQuestion',
                kind: 'user_action',
                arguments: question,
                createdAt: 10_400,
                source: LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE,
            },
            completedRequests: {
                toolu_canonical: {
                    tool: 'AskUserQuestion',
                    kind: 'user_action',
                    arguments: question,
                    createdAt: 1_000,
                    completedAt: 10_000,
                    status: 'canceled',
                    reason: LOCAL_PERMISSION_BRIDGE_STOPPED_REASON,
                    source: LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE,
                },
            },
            options: bridgeCoverageOptions,
        })).toBe(true);
    });

    it('does not cover fresh generated bridge requests from a different owner', () => {
        const question = { questions: [{ question: 'Proceed?', options: [{ label: 'Yes' }] }] };

        expect(isAgentStateRequestCoveredByCompletedRequests({
            requestId: 'perm_generated',
            request: {
                tool: 'AskUserQuestion',
                kind: 'user_action',
                arguments: question,
                createdAt: 10_400,
                source: LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE,
                owner: { kind: 'plugin', pluginId: 'plugin-b', runtimeId: 'runtime-b' },
            },
            completedRequests: {
                toolu_canonical: {
                    tool: 'AskUserQuestion',
                    kind: 'user_action',
                    arguments: question,
                    createdAt: 1_000,
                    completedAt: 10_000,
                    status: 'canceled',
                    reason: LOCAL_PERMISSION_BRIDGE_STOPPED_REASON,
                    source: LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE,
                    owner: { kind: 'plugin', pluginId: 'plugin-a', runtimeId: 'runtime-a' },
                },
            },
            options: bridgeCoverageOptions,
        })).toBe(false);
    });

    it('does not cover old repeated bridge questions outside the race window', () => {
        const question = { questions: [{ question: 'Proceed?', options: [{ label: 'Yes' }] }] };

        expect(isAgentStateRequestCoveredByCompletedRequests({
            requestId: 'perm_later',
            request: {
                tool: 'AskUserQuestion',
                kind: 'user_action',
                arguments: question,
                createdAt: 20_000,
                source: LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE,
            },
            completedRequests: {
                toolu_canonical: {
                    tool: 'AskUserQuestion',
                    kind: 'user_action',
                    arguments: question,
                    completedAt: 10_000,
                    status: 'canceled',
                    reason: LOCAL_PERMISSION_BRIDGE_STOPPED_REASON,
                    source: LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE,
                },
            },
            options: bridgeCoverageOptions,
        })).toBe(false);
    });
});
