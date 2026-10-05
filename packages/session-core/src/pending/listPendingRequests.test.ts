import { describe, expect, it } from 'vitest';
import { resolveAgentStateRequestCoverageOptions } from '@happier-dev/agents';
import type { Message } from "../messages/messageTypes.js";
import { readSharedMetadataActionConfirmationState } from "./readSharedMetadataPendingRequestFacts.js";
import {
    collectTranscriptRequestStates,
    deriveLatestPendingRequestObservedAt,
    derivePendingRequestFlags,
    listPendingRequests,
    comparePendingRequestsByAge,
    selectOldestPendingRequest,
    shouldReadTranscriptForPendingRequests,
    type TranscriptRequestState,
    type TranscriptRequestStatesCache,
    type PendingRequestFacts,
} from "./listPendingRequests.js";


function createPendingFacts(overrides: Partial<PendingRequestFacts> = {}): PendingRequestFacts {
    return { sessionId: 'session-1', active: false, agentState: null, actionConfirmations: null, presentationCompletedRequests: null, projected: null, ...overrides };
}

const localPermissionBridgeCoverageOptions = resolveAgentStateRequestCoverageOptions({ kind: 'localPermissionBridge' });
const LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE = localPermissionBridgeCoverageOptions.equivalentSources?.[0] ?? '';
const LOCAL_PERMISSION_BRIDGE_STOPPED_REASON = localPermissionBridgeCoverageOptions.equivalentCompletedReasons?.[0] ?? '';

const SHARED_ACTION_REQUEST = {
    tool: 'Happier Action confirmation' as const,
    kind: 'user_action' as const,
    arguments: {
        actionId: 'session.activity.get',
        preview: { sessionId: 'session-action' },
        sessionId: 'session-action',
        turnId: 'turn-action',
    },
    createdAt: 1_000,
    turnId: 'turn-action',
    source: 'happier_action' as const,
    responseTarget: {
        kind: 'happier_action_confirmation_v1' as const,
        requestId: 'action:req-1',
        actionId: 'session.activity.get',
        inputDigestV1: `sha256:${'0'.repeat(64)}`,
        runtimeAccountId: 'runtime-account',
        sessionId: 'session-action',
        turnId: 'turn-action',
    },
};

describe('oldest pending request', () => {
    it('orders questions and permissions by creation time, with unknown last and stable identity ties', () => {
        const requests = listPendingRequests(createPendingFacts({ active: true, agentState: {
            requests: {
                newer: { tool: 'Bash', arguments: { command: 'pwd' }, createdAt: 200 },
                older: { tool: 'AskUserQuestion', kind: 'question', arguments: { questions: [] }, createdAt: 100 },
                unknown: { tool: 'Bash', arguments: {}, createdAt: null },
                tie: { tool: 'Bash', arguments: { command: 'ls' }, createdAt: 100 },
            },
        } }), []);
        expect(selectOldestPendingRequest(requests)?.id).toBe('older');
        expect([...requests].sort(comparePendingRequestsByAge).map((r) => r.id)).toEqual(['older', 'tie', 'newer', 'unknown']);
        expect(selectOldestPendingRequest([])).toBeNull();
    });
});

describe('shared Action confirmation projection', () => {
    it('renders an Action-only request without exposing owner AgentState', () => {
        const session = createPendingFacts({
            sessionId: 'session-action',
            active: true,
            agentState: null,
            actionConfirmations: readSharedMetadataActionConfirmationState({
                v: 1,
                actionConfirmationsV1: {
                    v: 1,
                    requests: { 'action:req-1': SHARED_ACTION_REQUEST },
                    completedRequests: {},
                },
            }, 1)
        });

        expect(listPendingRequests(session, [])).toEqual([
            expect.objectContaining({
                id: 'action:req-1',
                source: 'happier_action',
                tool: 'Happier Action confirmation',
                turnId: 'turn-action',
                responseTarget: SHARED_ACTION_REQUEST.responseTarget,
            }),
        ]);
        expect(derivePendingRequestFlags(session, [])).toEqual({
            hasPendingPermissionRequests: true,
            hasPendingUserActionRequests: false,
        });
    });

    it('keeps the Action response target when matching a transcript request', () => {
        const facts = createPendingFacts({
            active: true,
            actionConfirmations: readSharedMetadataActionConfirmationState({
                v: 1,
                actionConfirmationsV1: {
                    v: 1,
                    requests: { 'action:req-1': SHARED_ACTION_REQUEST },
                    completedRequests: {},
                },
            }, 1),
        });
        const messages: Message[] = [{
            id: 'action-message',
            kind: 'tool-call',
            localId: null,
            createdAt: SHARED_ACTION_REQUEST.createdAt,
            tool: {
                id: 'action:req-1',
                name: SHARED_ACTION_REQUEST.tool,
                input: SHARED_ACTION_REQUEST.arguments,
                state: 'running',
                createdAt: SHARED_ACTION_REQUEST.createdAt,
                startedAt: null,
                completedAt: null,
                description: null,
                permission: { id: 'action:req-1', status: 'pending', kind: 'user_action' },
            },
            children: [],
        }];

        expect(listPendingRequests(facts, messages)).toEqual([
            expect.objectContaining({
                id: 'action:req-1',
                kind: 'user_action',
                source: 'happier_action',
                turnId: 'turn-action',
                responseTarget: SHARED_ACTION_REQUEST.responseTarget,
            }),
        ]);
    });
});

describe('derivePendingRequestFlags', () => {
    it('uses projected pending request counts without scanning large transcript message lists', () => {
        const messages: Message[] = Array.from({ length: 1_000 }, (_, index) => ({
            id: `msg-${index}`,
            kind: 'tool-call',
            localId: null,
            createdAt: index + 1,
            tool: {
                id: `tool-${index}`,
                name: 'bash',
                state: 'running',
                input: {},
                createdAt: index + 1,
                startedAt: index + 1,
                completedAt: null,
                description: null,
                permission: {
                    id: `permission-${index}`,
                    status: 'pending',
                },
            },
            children: [],
        }));

        const session = createPendingFacts({
            active: true,
            agentState: {
                requests: {},
                completedRequests: null,
            },
            projected: { permissionCount: 0, userActionCount: 0, observedAt: null, referenceAt: 10_000 }
        });

        expect(derivePendingRequestFlags(session, messages)).toEqual({
            hasPendingPermissionRequests: false,
            hasPendingUserActionRequests: false,
        });
    });

    it('uses projected pending counts and timestamps before stale hydrated request details', () => {
        const session = createPendingFacts({
            active: true,
            agentState: {
                requests: {
                    stale_permission: {
                        tool: 'Bash',
                        kind: 'permission',
                        arguments: { command: 'git status' },
                        createdAt: 1_000,
                    },
                },
                completedRequests: null,
            },
            projected: { permissionCount: 0, userActionCount: 1, observedAt: 5_000, referenceAt: 1 }
        });

        expect(derivePendingRequestFlags(session)).toEqual({
            hasPendingPermissionRequests: false,
            hasPendingUserActionRequests: true,
        });
        expect(deriveLatestPendingRequestObservedAt(session)).toBe(5_000);
    });

    it('surfaces live agentState user-action requests even when projected counts are stale zero', () => {
        const session = createPendingFacts({
            active: true,
            agentState: {
                requests: {
                    toolu_question: {
                        tool: 'AskUserQuestion',
                        kind: 'user_action',
                        arguments: {
                            questions: [{
                                header: 'Direction',
                                question: 'How should I resolve this?',
                                options: [{ label: 'Keep', description: 'Keep the behavior' }],
                                multiSelect: false,
                            }],
                        },
                        createdAt: 123,
                    },
                },
                completedRequests: null,
            },
            projected: { permissionCount: 0, userActionCount: 0, observedAt: null, referenceAt: 1 }
        });

        expect(shouldReadTranscriptForPendingRequests(session)).toBe(false);
        expect(listPendingRequests(session)).toEqual([
            expect.objectContaining({
                id: 'toolu_question',
                tool: 'AskUserQuestion',
                kind: 'user_action',
                createdAt: 123,
            }),
        ]);
        expect(derivePendingRequestFlags(session)).toEqual({
            hasPendingPermissionRequests: false,
            hasPendingUserActionRequests: true,
        });
        expect(deriveLatestPendingRequestObservedAt(session)).toBe(123);
    });

    it('preserves the canonical Action request source for presentation', () => {
        const session = createPendingFacts({
            active: true,
            agentState: {
                requests: {
                    'action:request-1': {
                        tool: 'Happier Action confirmation',
                        kind: 'user_action',
                        source: 'happier_action',
                        arguments: {
                            actionId: 'session.title.set',
                            preview: { summary: 'Rename the session' },
                            sessionId: 'session-1',
                            turnId: 'turn-1',
                        },
                        createdAt: 789,
                        turnId: 'turn-1',
                    },
                },
                completedRequests: null,
            }
        });

        expect(listPendingRequests(session)).toEqual([
            expect.objectContaining({
                id: 'action:request-1',
                source: 'happier_action',
                kind: 'user_action',
            }),
        ]);
        expect(derivePendingRequestFlags(session, [])).toEqual({
            hasPendingPermissionRequests: true, hasPendingUserActionRequests: false,
        });
    });

    it('surfaces live agentState user-action requests even while the session is inactive', () => {
        const session = createPendingFacts({
            active: false,
            agentState: {
                requests: {
                    inactive_permission: {
                        tool: 'Bash',
                        kind: 'permission',
                        arguments: { command: 'pwd' },
                        createdAt: 123,
                    },
                    claude_resume_choice: {
                        tool: 'AskUserQuestion',
                        kind: 'user_action',
                        arguments: {
                            questions: [{
                                header: 'Resume',
                                question: 'How should Claude resume this session?',
                                options: [
                                    { label: 'Resume from summary', description: 'Start from the compact summary.' },
                                    { label: 'Resume full session', description: 'Load the full transcript.' },
                                ],
                                multiSelect: false,
                            }],
                        },
                        createdAt: 456,
                    },
                },
                completedRequests: null,
            },
            projected: { permissionCount: 0, userActionCount: 0, observedAt: null, referenceAt: 1 }
        });

        expect(shouldReadTranscriptForPendingRequests(session)).toBe(false);
        expect(listPendingRequests(session)).toEqual([
            expect.objectContaining({
                id: 'claude_resume_choice',
                tool: 'AskUserQuestion',
                kind: 'user_action',
                createdAt: 456,
            }),
        ]);
        expect(derivePendingRequestFlags(session)).toEqual({
            hasPendingPermissionRequests: false,
            hasPendingUserActionRequests: true,
        });
        expect(deriveLatestPendingRequestObservedAt(session)).toBe(456);
    });

    it('does not surface a generated local-bridge request covered by a recent canonical cancellation', () => {
        const question = { questions: [{ question: 'How should I proceed?', options: [{ label: 'Continue' }] }] };
        const session = createPendingFacts({
            active: true,
            agentState: {
                requests: {
                    perm_generated: {
                        tool: 'AskUserQuestion',
                        kind: 'user_action',
                        arguments: question,
                        createdAt: 10_500,
                        source: LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE,
                    },
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
            },
            projected: { permissionCount: 0, userActionCount: 0, observedAt: null, referenceAt: 1 }
        });

        expect(listPendingRequests(session)).toEqual([]);
        expect(derivePendingRequestFlags(session)).toEqual({
            hasPendingPermissionRequests: false,
            hasPendingUserActionRequests: false,
        });
        expect(deriveLatestPendingRequestObservedAt(session)).toBe(null);
    });

    it('uses uncovered agentState request timestamps when projected counts have no observed timestamp', () => {
        const session = createPendingFacts({
            active: true,
            agentState: {
                requests: {
                    permission_retry: {
                        tool: 'Bash',
                        kind: 'permission',
                        arguments: { command: 'git status' },
                        createdAt: 12_345,
                    },
                },
                completedRequests: {
                    permission_retry: {
                        tool: 'Bash',
                        kind: 'permission',
                        arguments: { command: 'git diff' },
                        completedAt: 12_500,
                        status: 'approved',
                    },
                },
            },
            projected: { permissionCount: 1, userActionCount: 0, observedAt: null, referenceAt: 1 }
        });

        expect(listPendingRequests(session)).toEqual([
            expect.objectContaining({
                id: 'permission_retry',
                kind: 'permission',
                createdAt: 12_345,
            }),
        ]);
        expect(derivePendingRequestFlags(session)).toEqual({
            hasPendingPermissionRequests: true,
            hasPendingUserActionRequests: false,
        });
        expect(deriveLatestPendingRequestObservedAt(session)).toBe(12_345);
    });
});

describe('transcript request states cache', () => {
    function pendingToolCallMessage(id: string, createdAt: number): Message {
        return {
            id,
            kind: 'tool-call',
            localId: null,
            createdAt,
            tool: {
                id: `${id}-tool`,
                name: 'bash',
                state: 'running',
                input: { command: 'ls' },
                createdAt,
                startedAt: createdAt,
                completedAt: null,
                description: null,
                permission: {
                    id: `${id}-perm`,
                    status: 'pending',
                },
            },
            children: [],
        } as unknown as Message;
    }

    function activeTranscriptSession() {
        return createPendingFacts({
            active: true,
            agentState: {
                requests: {},
                completedRequests: null,
            },
            projected: { permissionCount: null, userActionCount: null, observedAt: null, referenceAt: 100 }
        });
    }

    it('lets completion evidence override a stale pending transcript', () => {
        const facts = createPendingFacts({
            active: true,
            presentationCompletedRequests: {
                'm1-perm': { tool: 'bash', kind: 'permission', createdAt: 50, completedAt: 60, status: 'approved' },
            },
        });
        const messages = [pendingToolCallMessage('m1', 50)];

        expect(listPendingRequests(facts, messages)).toEqual([]);
        expect(derivePendingRequestFlags(facts, messages)).toEqual({
            hasPendingPermissionRequests: false,
            hasPendingUserActionRequests: false,
        });
    });

    it('uses the projection freshness fallback without reporting it as the request timestamp', () => {
        const facts = createPendingFacts({
            active: true,
            projected: { permissionCount: 1, userActionCount: 0, observedAt: null, referenceAt: 100 },
        });
        const message = pendingToolCallMessage('m1', 50);
        if (message.kind !== 'tool-call') throw new Error('Expected tool message');
        message.tool.permission = { id: 'm1-perm', status: 'approved' };

        expect(derivePendingRequestFlags(facts, [message]).hasPendingPermissionRequests).toBe(true);
        expect(derivePendingRequestFlags({ ...facts, projected: { ...facts.projected!, referenceAt: 40 } }, [message]).hasPendingPermissionRequests).toBe(false);
        expect(deriveLatestPendingRequestObservedAt(facts, [message])).toBe(null);
    });

    it('derives identical results from a pre-filled cache without messages', () => {
        const session = activeTranscriptSession();
        const messages = [pendingToolCallMessage('m1', 50)];

        const cache: TranscriptRequestStatesCache = {
            states: (() => {
                const states = new Map<string, TranscriptRequestState>();
                collectTranscriptRequestStates(messages, null, states);
                return states;
            })(),
        };

        expect(derivePendingRequestFlags(session, undefined, cache))
            .toEqual(derivePendingRequestFlags(session, messages));
        expect(deriveLatestPendingRequestObservedAt(session, undefined, cache))
            .toBe(deriveLatestPendingRequestObservedAt(session, messages));
        expect(listPendingRequests(session, undefined, cache))
            .toEqual(listPendingRequests(session, messages));
    });

    it('walks the transcript once per cache and reuses the collected states', () => {
        const session = activeTranscriptSession();
        const messages = [pendingToolCallMessage('m1', 50)];

        const cache: TranscriptRequestStatesCache = {};
        const flags = derivePendingRequestFlags(session, messages, cache);
        expect(flags.hasPendingPermissionRequests).toBe(true);
        expect(cache.states?.size).toBe(1);

        // A later derivation in the same pass must reuse the cached states and
        // never re-walk the (now grown) message array.
        messages.push(pendingToolCallMessage('m2', 80));
        expect(deriveLatestPendingRequestObservedAt(session, messages, cache)).toBe(50);
    });
});
