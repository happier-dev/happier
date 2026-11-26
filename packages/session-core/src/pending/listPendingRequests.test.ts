import { describe, expect, it } from 'vitest';
import type { AgentStateRequestCoverageOptions } from '@happier-dev/agents';
import { SessionStatusResultSchema } from '@happier-dev/protocol/sessions/control/contract';
import { buildSessionTurnsProjectionV1 } from '@happier-dev/protocol/sessions/turns/sessionTurnV1';
import type { Message } from "../messages/messageTypes.js";
import { readSharedMetadataActionConfirmationState } from "./readSharedMetadataPendingRequestFacts.js";
import {
    collectTranscriptRequestStates,
    deriveLatestPendingRequestObservedAt,
    derivePendingRequestFlags,
    listPendingRequests,
    projectSessionStatusPendingRequestsV1,
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

const localPermissionBridgeCoverageOptions = {
    equivalentSources: ['test_local_bridge'],
    equivalentCompletedStatuses: ['canceled'],
    equivalentCompletedReasons: ['Test bridge stopped'],
} satisfies AgentStateRequestCoverageOptions;
const LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE = localPermissionBridgeCoverageOptions?.equivalentSources?.[0] ?? '';
const LOCAL_PERMISSION_BRIDGE_STOPPED_REASON = localPermissionBridgeCoverageOptions?.equivalentCompletedReasons?.[0] ?? '';

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

describe('public status pending request projection', () => {
    it('retains server question attention without a held ledger only while running and unarchived', () => {
        const facts = createPendingFacts({ active: true, agentState: null,
            projected: { permissionCount: 0, userActionCount: 1, observedAt: 100 } });
        expect(derivePendingRequestFlags(facts, []).hasPendingUserActionRequests).toBe(true);
        expect(derivePendingRequestFlags({ ...facts, archivedAt: 300 }, []).hasPendingUserActionRequests).toBe(false);
        expect(derivePendingRequestFlags({ ...facts, active: false }, []).hasPendingUserActionRequests).toBe(false);
        expect(listPendingRequests(facts, [])).toEqual([]);
    });

    // SEC-COORD-OPUS-1126H: continue/lasting questions outlive successful or failed raising Turns.
    it.each([
        { mode: 'continue', lasting: false, status: 'completed' },
        { mode: 'continue', lasting: false, status: 'failed' },
        { mode: 'continue', lasting: true, status: 'completed' },
        { mode: 'continue', lasting: true, status: 'failed' },
        { mode: 'wait', lasting: true, status: 'completed' },
        { mode: 'wait', lasting: true, status: 'failed' },
        { mode: 'continue', lasting: true, status: 'cancelled' },
    ] as const)('projects $mode lasting=$lasting after $status, including Unarchive', ({ mode, lasting, status }) => {
        for (const active of [true, false]) {
            const facts = createPendingFacts({ active, archivedAt: null, latestTurnId: 'raising-turn', latestTurnStatus: status,
                agentState: { requests: { question: { tool: 'AskUserQuestion', kind: 'user_action',
                    source: 'session.needs_you.raise', turnId: 'raising-turn', createdAt: 100, arguments: {},
                    questionV1: { mode, lasting, type: 'decision', ...(mode === 'continue' ? { assumption: 'assume yes' } : {}) },
                } } } });
            const expected = status === 'cancelled' ? [] : ['question'];
            expect(listPendingRequests(facts, []).map(request => request.id)).toEqual(expected);
            expect(derivePendingRequestFlags(facts, []).hasPendingUserActionRequests).toBe(status !== 'cancelled');
            expect(listPendingRequests({ ...facts, archivedAt: 300 }, [])).toEqual([]);
            expect(listPendingRequests({ ...facts, archivedAt: null }, []).map(request => request.id)).toEqual(expected);
        }
    });

    it.each([true, false])('closes archived and cancelled-Turn questions across pending projections (active %s)', active => {
        const facts = createPendingFacts({ active, agentState: { requests: {
            question: { tool: 'AskUserQuestion', kind: 'user_action', turnId: 'older-turn', createdAt: 100, arguments: {} },
        } }, projected: { permissionCount: 0, userActionCount: 1, observedAt: 100 } });
        for (const status of ['waiting', 'in_progress', 'completed', 'cancelled', 'failed'] as const) {
            const current = { ...facts, archivedAt: null, latestTurnId: 'newer-turn', latestTurnStatus: 'completed' as const,
                sessionTurns: buildSessionTurnsProjectionV1({ sessionId: facts.sessionId, updatedAt: 200,
                    turns: [{ turnId: 'older-turn', status, startedAt: 1, updatedAt: 200 }] }) };
            const open = status !== 'cancelled';
            expect(listPendingRequests(current, []).map(request => request.id), status).toEqual(open ? ['question'] : []);
            expect(derivePendingRequestFlags(current, []).hasPendingUserActionRequests, status).toBe(open);
            expect(deriveLatestPendingRequestObservedAt(current, []), status).toBe(open ? 100 : null);
            const archived = { ...current, archivedAt: 300 };
            expect(listPendingRequests(archived, []), status).toEqual([]);
            expect(derivePendingRequestFlags(archived, []).hasPendingUserActionRequests, status).toBe(false);
            expect(deriveLatestPendingRequestObservedAt(archived, []), status).toBeNull();
        }
    });

    it('hides a lasting question only while archived and requires Agent State membership for transcript questions', () => {
        const facts = createPendingFacts({ active: true, agentState: { requests: {
            lasting: { tool: 'AskUserQuestion', kind: 'user_action', createdAt: 100, arguments: {} },
        } } });
        const archived = { ...facts, archivedAt: 300 };
        expect(listPendingRequests(archived, [])).toEqual([]);
        expect(listPendingRequests({ ...archived, archivedAt: null }, []).map(request => request.id)).toEqual(['lasting']);
        const transcript: Message = { id: 'question-message', kind: 'tool-call', localId: null, createdAt: 100,
            tool: { id: 'transcript-question', name: 'AskUserQuestion', input: {}, state: 'running', createdAt: 100,
                startedAt: null, completedAt: null, description: null,
                permission: { id: 'absent-request', status: 'pending', kind: 'user_action' } }, children: [] };
        expect(listPendingRequests({ ...facts, agentState: { requests: {} } }, [transcript])).toEqual([]);
        expect(derivePendingRequestFlags({ ...facts, agentState: { requests: {} } }, [transcript]).hasPendingUserActionRequests).toBe(false);
    });

    it('carries the authorized owner label with a disabled native choice through public status', () => {
        const nativeChoices = { requirementId: 'owner-label', source: 'native', choices: [
            { id: 'remember', label: 'Remember', decision: 'approved' as const, scope: 'localPersistent' as const,
                response: { approved: true } },
        ] };
        const facts = { ...createPendingFacts({ active: true, permissionRelationship: 'sharedApprover',
            agentState: { requests: { request: { tool: 'Shell', arguments: {}, nativeChoices } } } }),
            permissionOwnerLabel: 'Ada Lovelace' };
        expect(projectSessionStatusPendingRequestsV1(listPendingRequests(facts, []))).toEqual([
            expect.objectContaining({ permissionOwnerLabel: 'Ada Lovelace', nativeChoiceAvailability: [
                { choiceId: 'remember', allowed: false, reason: 'owner_required' },
            ] }),
        ]);
    });
    it('exposes fresh native operands without a transcript while preserving offered choices and caller refusals', () => {
        const nativeChoices = { requirementId: 'requirement', source: 'native-agent', choices: [
            { id: 'persistent-choice', label: 'Remember for this Machine', decision: 'approved' as const,
                scope: 'localPersistent' as const, response: { approved: true as const, decision: 'approved' as const } },
        ] };
        const nativeChoiceAvailability = [{ choiceId: 'persistent-choice', allowed: false, reason: 'owner_required' as const }];
        // READY249's pending native request exists before its durable tool-call message.
        const requestId = 'call_01a1e79eef8876fb9111655565682b8a';
        const turnId = 'native-turn-3e8d86af-dfdb-47ab-bc1e-1fd12d447097-1';
        const argumentsValue = { command: 'git status --short --untracked-files=all' };
        const facts = createPendingFacts({ active: true, permissionRelationship: 'sharedApprover', agentState: {
            requests: { [requestId]: { tool: 'Bash', kind: 'permission', turnId, createdAt: 1,
                arguments: argumentsValue, nativeChoices } },
        } });
        expect(SessionStatusResultSchema.shape.pendingRequests.parse(projectSessionStatusPendingRequestsV1(listPendingRequests(facts, []))))
            .toEqual([{ requestId, turnId, kind: 'permission', tool: 'Bash', arguments: argumentsValue,
                nativeChoices, nativeChoiceAvailability }]);
        // Older AgentState producers may publish a pending request without operands.
        expect(projectSessionStatusPendingRequestsV1(listPendingRequests(createPendingFacts({ active: true,
            agentState: { requests: { legacy: { tool: 'Bash' } } },
        }), []))).toEqual([{ requestId: 'legacy', kind: 'permission', tool: 'Bash' }]);
        expect(projectSessionStatusPendingRequestsV1([])).toEqual([]);
    });
});

describe('oldest pending request', () => {
    it.each([true, false])('uses selected custom coverage for equivalent cancellations without applying it to other agents (active %s)', active => {
        const requestCoverage = {
            equivalentSources: ['custom_bridge'],
            equivalentCompletedStatuses: ['canceled'],
            equivalentCompletedReasons: ['Custom bridge stopped'],
        };
        const request = { tool: 'Shell', kind: 'user_action' as const, arguments: { command: 'pwd' }, createdAt: 10_500, source: 'custom_bridge' };
        const facts = {
            ...createPendingFacts({ active, agentState: {
                requests: { pending: request },
                completedRequests: { pending: { ...request, createdAt: 1_000, completedAt: 10_000,
                    status: 'canceled' as const, reason: 'Custom bridge stopped' } },
            } }),
            requestCoverage,
        };
        expect(listPendingRequests(facts, [])).toEqual([]);
        expect(deriveLatestPendingRequestObservedAt(facts, [])).toBeNull();
        expect(listPendingRequests({ ...facts, requestCoverage: undefined }, []).map(request => request.id)).toEqual(['pending']);
    });

    it('preserves native choice identity and child origin from the stored occurrence', () => {
        const nativeChoices = {
            requirementId: 'requirement-2', source: 'native', origin: { sessionId: 'parent', subagentId: 'child', subagentLabel: 'Review the API' },
            choices: [{ id: 'custom-allow', label: 'Allow this command', decision: 'approved' as const, scope: 'once' as const, response: { approved: true as const } }],
        };
        const pending = listPendingRequests(createPendingFacts({ active: true, agentState: {
            requests: { request: { tool: 'Shell', arguments: {}, createdAt: 1, nativeChoices } },
        } }), []);
        expect(pending[0]?.nativeChoices).toEqual(nativeChoices);
    });

    it('projects native choice availability from trusted relationship without changing the offer', () => {
        const nativeChoices = { requirementId: 'native', source: 'native', choices: [
            { id: 'once', label: 'Once', decision: 'approved' as const, scope: 'once' as const, response: { approved: true as const } },
            { id: 'remember', label: 'Remember', decision: 'approved' as const, scope: 'localPersistent' as const, response: { approved: true as const } },
            { id: 'mode', label: 'Mode', decision: 'approved' as const, scope: 'session' as const, response: { approved: true as const, mode: 'acceptEdits' } },
        ] };
        const facts = createPendingFacts({ active: true, agentState: { requests: { request: { tool: 'Shell', arguments: {}, nativeChoices } } } });
        expect(listPendingRequests(facts, [])[0]?.nativeChoiceAvailability).toEqual([
            { choiceId: 'once', allowed: true },
            { choiceId: 'remember', allowed: false, reason: 'owner_required' },
            { choiceId: 'mode', allowed: false, reason: 'owner_required' },
        ]);
        expect(listPendingRequests({ ...facts, permissionRelationship: 'owner' }, [])[0]?.nativeChoiceAvailability)
            .toEqual(nativeChoices.choices.map(choice => ({ choiceId: choice.id, allowed: true })));
        expect(listPendingRequests(facts, [])[0]?.nativeChoices).toEqual(nativeChoices);
    });

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
    it.each([true, false])('renders an archived Action-only request independently of question openness (active %s)', active => {
        const session = createPendingFacts({
            sessionId: 'session-action',
            active,
            archivedAt: 300,
            latestTurnId: 'turn-action',
            latestTurnStatus: 'cancelled',
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
    it('uses projected zero counts ahead of stale hydrated pending requests', () => {
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

    it('does not manufacture a question from projected counts without Agent State membership', () => {
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
            hasPendingUserActionRequests: false,
        });
        expect(deriveLatestPendingRequestObservedAt(session)).toBeNull();
    });

    it('keeps a hydrated native permission visible when projected zero counts have no observation or predate it', () => {
        const request = { tool: 'Bash', kind: 'permission' as const, arguments: { command: 'sleep 300' },
            createdAt: 12_345, turnId: 'native-turn' };
        const facts = createPendingFacts({ active: true, agentState: { requests: { 'exec-native': request } },
            projected: { permissionCount: 0, userActionCount: 0, observedAt: null, referenceAt: 20_000 } });
        for (const observedAt of [null, 12_000]) {
            const current = { ...facts, projected: { ...facts.projected!, observedAt } };
            expect(listPendingRequests(current)).toEqual([expect.objectContaining({ id: 'exec-native', tool: 'Bash', turnId: 'native-turn' })]);
            expect(derivePendingRequestFlags(current)).toEqual({ hasPendingPermissionRequests: true, hasPendingUserActionRequests: false });
            expect(deriveLatestPendingRequestObservedAt(current)).toBe(request.createdAt);
        }
        const newerZero = { ...facts, projected: { ...facts.projected!, observedAt: 13_000 } };
        expect(listPendingRequests(newerZero)).toEqual([]);
        expect(derivePendingRequestFlags(newerZero).hasPendingPermissionRequests).toBe(false);
        expect(deriveLatestPendingRequestObservedAt(newerZero)).toBeNull();
        const completed = { ...facts, agentState: { requests: { 'exec-native': request }, completedRequests: {
            'exec-native': { ...request, completedAt: 13_000, status: 'approved' as const },
        } } };
        expect(listPendingRequests(completed)).toEqual([]);
        expect(derivePendingRequestFlags(completed).hasPendingPermissionRequests).toBe(false);
        expect(deriveLatestPendingRequestObservedAt(completed)).toBeNull();
        const terminal: Message = { id: 'native', kind: 'tool-call', localId: null, createdAt: request.createdAt,
            tool: { id: 'native-tool', name: 'Bash', state: 'running', input: request.arguments, createdAt: request.createdAt,
                startedAt: request.createdAt, completedAt: null, description: null,
                permission: { id: 'exec-native', status: 'approved' } }, children: [] };
        const pendingTranscript: Message = { ...terminal, tool: { ...terminal.tool, permission: { id: 'exec-native', status: 'pending' } } };
        expect(listPendingRequests(newerZero, [pendingTranscript])).toEqual([]);
        expect(listPendingRequests(facts, [terminal])).toEqual([]);
        expect(derivePendingRequestFlags(facts, [terminal]).hasPendingPermissionRequests).toBe(false);
        expect(listPendingRequests({ ...facts, active: false })).toEqual([]);
        expect(derivePendingRequestFlags({ ...facts, active: false }).hasPendingPermissionRequests).toBe(false);
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
            requestCoverage: localPermissionBridgeCoverageOptions,
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
