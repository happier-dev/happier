import { describe, expect, it } from 'vitest';
import { resolveAgentStateRequestCoverageOptions } from '@happier-dev/agents';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import type { Message } from '@/sync/domains/messages/messageTypes';
import type { Metadata } from '@/sync/domains/state/storageTypes';
import { readSessionPresentationCompletedRequests } from '@/sync/domains/session/presentation/readSessionPresentationCompletedRequests';
import {
    collectTranscriptRequestStates,
    deriveLatestPendingRequestObservedAtFromSession,
    derivePendingRequestFlagsFromSession,
    listPendingSessionRequests,
    shouldReadTranscriptForPendingSessionRequests,
    type TranscriptRequestState,
    type TranscriptRequestStatesCache,
} from './listPendingSessionRequests';

const localPermissionBridgeCoverageOptions = resolveAgentStateRequestCoverageOptions({ kind: 'localPermissionBridge' });
const LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE = localPermissionBridgeCoverageOptions.equivalentSources?.[0] ?? '';
const LOCAL_PERMISSION_BRIDGE_STOPPED_REASON = localPermissionBridgeCoverageOptions.equivalentCompletedReasons?.[0] ?? '';

describe('derivePendingRequestFlagsFromSession', () => {
    it('uses the strict public completion projection only for recipient presentation', () => {
        const requestId = 'permission-publicly-completed';
        const createdAt = 1_000;
        const messages: Message[] = [{
            id: 'message-publicly-completed',
            kind: 'tool-call',
            localId: null,
            createdAt,
            tool: {
                id: 'tool-publicly-completed',
                name: 'Bash',
                state: 'running',
                input: { command: 'git status' },
                createdAt,
                startedAt: createdAt,
                completedAt: null,
                description: null,
                permission: {
                    id: requestId,
                    status: 'pending',
                },
            },
            children: [],
        }];
        const completedRequests = {
            [requestId]: {
                tool: 'Bash',
                kind: 'permission',
                createdAt,
                completedAt: createdAt + 100,
                status: 'approved',
            },
        };
        const sharedMetadata = {
            v: 1,
            publicAgentState: {
                completedRequests,
            },
        } as unknown as Metadata;

        const recipient = createSessionFixture({
            active: true,
            accessLevel: 'view',
            metadataLayoutVersion: 1,
            metadata: sharedMetadata,
            agentState: null,
        });
        const owner = createSessionFixture({
            active: true,
            metadataLayoutVersion: 1,
            metadata: sharedMetadata,
            agentState: {
                requests: {},
                completedRequests: {},
            },
        });
        const malformedRecipient = createSessionFixture({
            active: true,
            accessLevel: 'view',
            metadataLayoutVersion: 1,
            metadata: {
                ...sharedMetadata,
                path: '/private/path-must-not-pass',
            },
            agentState: null,
        });

        expect(readSessionPresentationCompletedRequests(recipient)).toEqual(
            completedRequests,
        );
        expect(listPendingSessionRequests(recipient, messages)).toEqual([]);
        expect(listPendingSessionRequests(owner, messages)).toEqual([
            expect.objectContaining({ id: requestId, tool: 'Bash' }),
        ]);
        expect(listPendingSessionRequests(malformedRecipient, messages)).toEqual([
            expect.objectContaining({ id: requestId, tool: 'Bash' }),
        ]);
    });

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

        const session = createSessionFixture({
            active: true,
            updatedAt: 10_000,
            agentState: {
                requests: {},
                completedRequests: null,
            },
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
        });

        expect(derivePendingRequestFlagsFromSession(session, messages)).toEqual({
            hasPendingPermissionRequests: false,
            hasPendingUserActionRequests: false,
        });
    });

    it('uses projected pending counts and timestamps before stale hydrated request details', () => {
        const session = createSessionFixture({
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
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 1,
            pendingRequestObservedAt: 5_000,
        });

        expect(derivePendingRequestFlagsFromSession(session)).toEqual({
            hasPendingPermissionRequests: false,
            hasPendingUserActionRequests: true,
        });
        expect(deriveLatestPendingRequestObservedAtFromSession(session)).toBe(5_000);
    });

    it('surfaces live agentState user-action requests even when projected counts are stale zero', () => {
        const session = createSessionFixture({
            active: true,
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
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
        });

        expect(shouldReadTranscriptForPendingSessionRequests(session)).toBe(false);
        expect(listPendingSessionRequests(session)).toEqual([
            expect.objectContaining({
                id: 'toolu_question',
                tool: 'AskUserQuestion',
                kind: 'user_action',
                createdAt: 123,
            }),
        ]);
        expect(derivePendingRequestFlagsFromSession(session)).toEqual({
            hasPendingPermissionRequests: false,
            hasPendingUserActionRequests: true,
        });
        expect(deriveLatestPendingRequestObservedAtFromSession(session)).toBe(123);
    });

    it('surfaces live agentState user-action requests even while the session is inactive', () => {
        const session = createSessionFixture({
            active: false,
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
            agentState: {
                requests: {
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
        });

        expect(shouldReadTranscriptForPendingSessionRequests(session)).toBe(false);
        expect(listPendingSessionRequests(session)).toEqual([
            expect.objectContaining({
                id: 'claude_resume_choice',
                tool: 'AskUserQuestion',
                kind: 'user_action',
                createdAt: 456,
            }),
        ]);
        expect(derivePendingRequestFlagsFromSession(session)).toEqual({
            hasPendingPermissionRequests: false,
            hasPendingUserActionRequests: true,
        });
        expect(deriveLatestPendingRequestObservedAtFromSession(session)).toBe(456);
    });

    it('does not surface a generated local-bridge request covered by a recent canonical cancellation', () => {
        const question = { questions: [{ question: 'How should I proceed?', options: [{ label: 'Continue' }] }] };
        const session = createSessionFixture({
            active: true,
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
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
        });

        expect(listPendingSessionRequests(session)).toEqual([]);
        expect(derivePendingRequestFlagsFromSession(session)).toEqual({
            hasPendingPermissionRequests: false,
            hasPendingUserActionRequests: false,
        });
        expect(deriveLatestPendingRequestObservedAtFromSession(session)).toBe(null);
    });

    it('uses uncovered agentState request timestamps when projected counts have no observed timestamp', () => {
        const session = createSessionFixture({
            active: true,
            pendingPermissionRequestCount: 1,
            pendingUserActionRequestCount: 0,
            pendingRequestObservedAt: null,
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
        });

        expect(listPendingSessionRequests(session)).toEqual([
            expect.objectContaining({
                id: 'permission_retry',
                kind: 'permission',
                createdAt: 12_345,
            }),
        ]);
        expect(derivePendingRequestFlagsFromSession(session)).toEqual({
            hasPendingPermissionRequests: true,
            hasPendingUserActionRequests: false,
        });
        expect(deriveLatestPendingRequestObservedAtFromSession(session)).toBe(12_345);
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
        return createSessionFixture({
            active: true,
            updatedAt: 100,
            agentState: {
                requests: {},
                completedRequests: null,
            },
        });
    }

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

        expect(derivePendingRequestFlagsFromSession(session, undefined, cache))
            .toEqual(derivePendingRequestFlagsFromSession(session, messages));
        expect(deriveLatestPendingRequestObservedAtFromSession(session, undefined, cache))
            .toBe(deriveLatestPendingRequestObservedAtFromSession(session, messages));
        expect(listPendingSessionRequests(session, undefined, cache))
            .toEqual(listPendingSessionRequests(session, messages));
    });

    it('walks the transcript once per cache and reuses the collected states', () => {
        const session = activeTranscriptSession();
        const messages = [pendingToolCallMessage('m1', 50)];

        const cache: TranscriptRequestStatesCache = {};
        const flags = derivePendingRequestFlagsFromSession(session, messages, cache);
        expect(flags.hasPendingPermissionRequests).toBe(true);
        expect(cache.states?.size).toBe(1);

        // A later derivation in the same pass must reuse the cached states and
        // never re-walk the (now grown) message array.
        messages.push(pendingToolCallMessage('m2', 80));
        expect(deriveLatestPendingRequestObservedAtFromSession(session, messages, cache)).toBe(50);
    });
});
