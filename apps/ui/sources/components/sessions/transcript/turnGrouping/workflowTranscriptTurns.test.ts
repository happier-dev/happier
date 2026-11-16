import { describe, expect, it } from 'vitest';
import type { Message } from '@happier-dev/session-core/messages';
import { buildChatListItems } from '@/components/sessions/chatListItems';
import { buildTranscriptTurnsCached } from './buildTranscriptTurns';
import { buildTranscriptTurnUnits } from './buildTranscriptTurnUnits';
import { deriveWorkflowSessionInputLocalIdV2 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { foldWorkflowOriginRuns, groupWorkflowTranscriptTurns, readWorkflowOriginRunMembership } from './workflowTranscriptTurns';

describe('workflow turn membership in linear transcripts', () => {
    it('does not fold a hidden user anchor back into a Pending-owned workflow turn', () => {
        const messages: Message[] = [
            { kind: 'user-text', id: 'workflow', localId: 'workflow-local', text: 'Daily summary', createdAt: 1,
                meta: { happierProvenanceV1: { v: 2, kind: 'workflow_invocation', runId: 'daily', invocationRecordId: 'step' } } },
            { kind: 'agent-text', id: 'failure', localId: null, text: 'Agent could not start', createdAt: 2 },
        ];
        const messagesById = Object.fromEntries(messages.map((message) => [message.id, message]));
        const messageIdsOldestFirst = messages.map((message) => message.id);
        const { turns } = buildTranscriptTurnsCached({ cache: null, messageIdsOldestFirst, messagesById,
            groupToolCalls: true, toolCallsGroupStrategy: 'consecutive_tools' });
        const linear = buildChatListItems({ messageIdsOldestFirst, messagesById, pendingMessages: [{
            id: 'pending-workflow', localId: 'workflow-local', text: 'Daily summary', createdAt: 1, updatedAt: 2,
            rawRecord: {}, source: 'server_pending', pendingDeliveryStatus: 'blocked',
        }] });
        const grouped = groupWorkflowTranscriptTurns(linear, turns, (id) => messagesById[id] ?? null);
        const rows = buildTranscriptTurnUnits({ items: grouped, getMessageById: (id) => messagesById[id] ?? null,
            collapsedPreviewCount: 0, isGroupExpanded: () => false, quietWorkflowTurnIds: new Set([turns[0]!.id]) });
        expect(rows.map((row) => row.kind === 'message' ? row.messageId : row.kind)).toEqual(['failure', 'pending-queue']);
    });

    it.each([false, true])('preserves unfolded interleaved linear rows with all-tools turn grouping (linear groups: %s)', groupToolCalls => {
        const tool = (id: string, createdAt: number): Message => ({ kind: 'tool-call', id, localId: null, createdAt,
            tool: { id: `call:${id}`, name: 'tool', state: 'completed', input: {}, result: {}, description: null,
                createdAt, startedAt: createdAt, completedAt: createdAt + 1 }, children: [] });
        const storedProvenance = { v: 2, kind: 'workflow_invocation', runId: 'daily', invocationRecordId: 'step', retired: true } as const;
        const messages: Message[] = [
            { kind: 'user-text', id: 'workflow', localId: null, text: 'Daily summary', createdAt: 1,
                meta: { happierProvenanceV1: storedProvenance } },
            tool('t1', 2), tool('t1b', 3),
            { kind: 'agent-text', id: 'a1', localId: null, text: 'First reply', createdAt: 4 },
            tool('t2', 5),
            { kind: 'agent-text', id: 'a2', localId: null, text: 'Final reply', createdAt: 6 },
            { kind: 'user-text', id: 'human', localId: null, text: 'Next task', createdAt: 7 },
        ];
        const messagesById = Object.fromEntries(messages.map(message => [message.id, message]));
        const getMessageById = (id: string) => messagesById[id] ?? null;
        const messageIdsOldestFirst = messages.map(message => message.id);
        const { turns } = buildTranscriptTurnsCached({ cache: null, messageIdsOldestFirst, messagesById,
            groupToolCalls: true, toolCallsGroupStrategy: 'all_tools_in_turn' });
        const linear = buildChatListItems({ messageIdsOldestFirst, messagesById, pendingMessages: [],
            groupConsecutiveToolCalls: groupToolCalls });
        const grouped = groupWorkflowTranscriptTurns(linear, turns, getMessageById);
        const decompose = (items: Parameters<typeof buildTranscriptTurnUnits>[0]['items'], quietWorkflowTurnIds?: ReadonlySet<string>) =>
            buildTranscriptTurnUnits({ items, getMessageById, collapsedPreviewCount: 0, isGroupExpanded: () => true, quietWorkflowTurnIds });
        // No evidence, or matched evidence projected as an empty quiet set, must retain exactly the old rows.
        expect(decompose(grouped)).toEqual(decompose(linear));
        expect(decompose(grouped, new Set())).toEqual(decompose(linear));
        const folded = decompose(grouped, new Set([turns[0]!.id]));
        expect(folded.map(item => item.id)).toEqual([turns[0]!.id, 'msg:human']);
        expect(folded[0]).toMatchObject({ turn: turns[0] });
    });
    it('folds the same canonical span in either mode without absorbing a new user turn or fork ancestor', () => {
        const messages: Message[] = [
            { kind: 'user-text', id: 'habit', localId: null, text: 'Daily summary', createdAt: 1,
                meta: { happierProvenanceV1: { v: 2, kind: 'workflow_invocation', runId: 'daily', invocationRecordId: 'step' } } },
            { kind: 'agent-text', id: 'reply', localId: null, text: 'Nothing to report', createdAt: 2 },
            { kind: 'agent-text', id: 'fork-child', localId: null, text: 'Child context', createdAt: 3 },
            { kind: 'user-text', id: 'human', localId: null, text: 'Check the release', createdAt: 4 },
            { kind: 'agent-text', id: 'human-reply', localId: null, text: 'Two things need you', createdAt: 5 },
        ];
        const messagesById = Object.fromEntries(messages.map((message) => [message.id, message]));
        const getMessageById = (id: string) => messagesById[id] ?? null;
        const messageIdsOldestFirst = messages.map((message) => message.id);
        const { turns } = buildTranscriptTurnsCached({ cache: null, messageIdsOldestFirst, messagesById,
            groupToolCalls: true, toolCallsGroupStrategy: 'consecutive_tools', forkBoundaryBeforeMessageIds: new Set(['fork-child']) });
        const linear = buildChatListItems({ messageIdsOldestFirst, messagesById, pendingMessages: [] });
        const grouped = groupWorkflowTranscriptTurns(linear, turns, getMessageById);
        const decompose = (items: Parameters<typeof buildTranscriptTurnUnits>[0]['items'], quiet: boolean) => buildTranscriptTurnUnits({
            items, getMessageById, collapsedPreviewCount: 0, isGroupExpanded: () => false,
            quietWorkflowTurnIds: new Set(quiet ? [turns[0]!.id] : []),
        });
        const fromTurns = turns.map((turn) => ({ kind: 'turn' as const, id: turn.id, turn }));
        expect(decompose(grouped, true)).toMatchObject(decompose(fromTurns, true));
        expect(decompose(grouped, true).map((item) => item.kind)).toEqual(['turn', 'message', 'message', 'message']);
        expect(decompose(grouped, false).map((item) => item.id)).toEqual(linear.map((item) => item.id));
        expect(decompose(grouped, true)[0]).toMatchObject({ turn: { userMessageId: 'habit', content: [{ messageId: 'reply' }] } });
    });
});

describe('origin-session workflow run folds', () => {
    const user = (id: string, seq: number, meta?: Record<string, unknown>): Message => ({ kind: 'user-text', id, localId: null,
        text: id, createdAt: seq, seq, ...(meta ? { meta } : {}) });
    const agent = (id: string, seq: number): Message => ({ kind: 'agent-text', id, localId: null, text: id, createdAt: seq, seq });
    const stepInput = (id: string, seq: number, runId: string, invocationRecordId: string): Message => ({ kind: 'agent-event', id,
        localId: deriveWorkflowSessionInputLocalIdV2({ purpose: 'invocation', runId, invocationRecordId }), createdAt: seq, seq,
        event: { type: 'message', message: 'Workflow step input' } } as Message);
    const tool = (id: string, seq: number): Message => ({ kind: 'tool-call', id, localId: null, createdAt: seq, seq,
        tool: { id: `call:${id}`, name: 'tool', state: 'completed', input: {}, result: {}, description: null,
            createdAt: seq, startedAt: seq, completedAt: seq + 1 }, children: [] });
    const sessionTurn = (turnId: string, start: number, end: number | null, invocation?: { runId: string; invocationRecordId: string }) => ({
        turnId, status: 'completed' as const, startedAt: start, updatedAt: start,
        ...(invocation ? { initiator: 'workflow' as const, workflowInvocation: invocation } : { initiator: 'user' as const }),
        transcriptAnchors: { startSeqInclusive: start, endSeqInclusive: end },
    });
    const build = (messages: Message[], sessionTurns: ReturnType<typeof sessionTurn>[], triggerRuns: Parameters<typeof readWorkflowOriginRunMembership>[0]['triggerRuns'] = []) => {
        const messagesById = Object.fromEntries(messages.map((message) => [message.id, message]));
        const getMessageById = (id: string) => messagesById[id] ?? null;
        const messageIdsOldestFirst = messages.map((message) => message.id);
        const membership = readWorkflowOriginRunMembership({ sessionId: 'session-1', sessionTurns, messageIdsOldestFirst, getMessageById, triggerRuns });
        const { turns } = buildTranscriptTurnsCached({ cache: null, messageIdsOldestFirst, messagesById,
            groupToolCalls: true, toolCallsGroupStrategy: 'consecutive_tools' });
        const turnItems = turns.map((turn) => ({ kind: 'turn' as const, id: turn.id, turn }));
        const linear = buildChatListItems({ messageIdsOldestFirst, messagesById, pendingMessages: [] });
        return { membership, turnItems, linear, getMessageById };
    };
    const ids = (turn: { userMessageId: string | null; content: readonly ({ kind: 'message'; messageId: string } | { kind: 'tool_calls'; toolMessageIds: string[] })[] }) =>
        [turn.userMessageId, ...turn.content.flatMap((content) => content.kind === 'message' ? [content.messageId] : content.toolMessageIds)]
            .filter((id) => id !== null);

    it('groups every origin-input turn of one run into a single fold where the run began, in either layout', () => {
        const run = { runId: 'run-a', invocationRecordId: 'continue-1' };
        const second = { runId: 'run-a', invocationRecordId: 'continue-2' };
        const { membership, turnItems, linear } = build([
            user('ask', 1), agent('ask-reply', 2),
            stepInput('input-1', 3, run.runId, run.invocationRecordId), tool('t1', 4), agent('cont-1', 5),
            stepInput('input-2', 6, second.runId, second.invocationRecordId), agent('cont-2', 7),
        ], [sessionTurn('u1', 1, 2), sessionTurn('w1', 4, 5, run), sessionTurn('w2', 7, 7, second)]);

        const fromTurns = foldWorkflowOriginRuns(turnItems, membership);
        expect(fromTurns.map((item) => item.id)).toEqual([turnItems[0]!.id, 'workflow-run:run-a']);
        expect(ids(fromTurns[0]!.kind === 'turn' ? fromTurns[0].turn : { userMessageId: null, content: [] })).toEqual(['ask', 'ask-reply']);
        const fold = fromTurns[1]!;
        expect(fold).toMatchObject({ kind: 'turn', workflowRun: { runId: 'run-a', turnCount: 2 } });
        // The host's step-input event is the run's own marker, never transcript text inside the fold.
        expect(fold.kind === 'turn' ? ids(fold.turn) : []).toEqual(['t1', 'cont-1', 'cont-2']);

        const fromLinear = foldWorkflowOriginRuns(linear, membership);
        expect(fromLinear.map((item) => item.id)).toEqual(['msg:ask', 'msg:ask-reply', 'workflow-run:run-a']);
        expect(fromLinear[2]).toMatchObject({ workflowRun: { runId: 'run-a', turnCount: 2 } });
        expect((fromLinear[2] as { linearItems?: readonly { id: string }[] }).linearItems?.map((item) => item.id)).toEqual(['msg:t1', 'msg:cont-1', 'msg:cont-2']);
    });

    it('ignores turns without origin-input provenance, including prompt-delivered workflow turns', () => {
        const prompt = { runId: 'habit', invocationRecordId: 'step' };
        const { membership, turnItems, linear } = build([
            user('ask', 1), agent('ask-reply', 2),
            user('habit-prompt', 3, { happierProvenanceV1: { v: 2, kind: 'workflow_invocation', ...prompt } }), agent('habit-reply', 4),
        ], [sessionTurn('u1', 1, 2), sessionTurn('h1', 3, 4, prompt)]);
        expect(foldWorkflowOriginRuns(turnItems, membership)).toEqual(turnItems);
        expect(foldWorkflowOriginRuns(linear, membership)).toEqual(linear);
        expect(readWorkflowOriginRunMembership({ sessionId: 'session-1', sessionTurns: null, messageIdsOldestFirst: ['ask'], getMessageById: () => null })).toBeNull();
    });

    it('keeps consecutive runs as separate folds and leaves a person turn between them in place', () => {
        const first = { runId: 'run-a', invocationRecordId: 'a1' };
        const next = { runId: 'run-b', invocationRecordId: 'b1' };
        const { membership, turnItems } = build([
            user('ask', 1), agent('ask-reply', 2),
            stepInput('input-a', 3, first.runId, first.invocationRecordId), agent('a-reply', 4),
            stepInput('input-b', 5, next.runId, next.invocationRecordId), agent('b-reply', 6),
            user('later', 7), agent('later-reply', 8),
        ], [sessionTurn('u1', 1, 2), sessionTurn('a', 4, 4, first), sessionTurn('b', 6, 6, next), sessionTurn('u2', 7, 8)]);
        const folded = foldWorkflowOriginRuns(turnItems, membership);
        expect(folded.map((item) => item.id)).toEqual([turnItems[0]!.id, 'workflow-run:run-a', 'workflow-run:run-b', turnItems[1]!.id]);
        expect(folded[1]).toMatchObject({ workflowRun: { runId: 'run-a', turnCount: 1 } });
        expect(folded[2]).toMatchObject({ workflowRun: { runId: 'run-b', turnCount: 1 } });
    });

    describe('a run that fired here without writing a turn', () => {
        const firedBy = (runId: string, sourceTurnId: string, sourceSessionId = 'session-1') => createWorkflowRunSummaryFixture({
            id: runId, state: 'succeeded',
            origin: { kind: 'automation', automationId: 'automation-1', originSessionId: sourceSessionId,
                cause: { kind: 'trigger', triggerId: 'trigger-1', triggerRevision: 1, triggerKind: 'sessionLifecycle',
                    occurrenceKey: 'A'.repeat(43), occurredAt: 1,
                    evidence: { event: 'parentTurnCompleted', sourceSessionId, sourceTurnId, policy: { kind: 'everyMatch' } } } } as never,
            automationScopeSessionId: sourceSessionId,
        });
        const conversation = [user('ask', 1), agent('ask-reply', 2), user('later', 3), agent('later-reply', 4)];
        const turnsOf = [sessionTurn('u1', 1, 2), sessionTurn('u2', 3, 4)];

        it('gets its own zero-turn fold right after the turn end that fired it, in either layout', () => {
            const { membership, turnItems, linear } = build(conversation, turnsOf, [firedBy('run-z', 'u1')]);
            const fromTurns = foldWorkflowOriginRuns(turnItems, membership);
            expect(fromTurns.map((item) => item.id)).toEqual([turnItems[0]!.id, 'workflow-run:run-z', turnItems[1]!.id]);
            expect(fromTurns[1]).toMatchObject({ kind: 'turn', workflowRun: { runId: 'run-z', turnCount: 0 } });
            expect(fromTurns[1]!.kind === 'turn' ? fromTurns[1].turn.content : null).toEqual([]);
            const fromLinear = foldWorkflowOriginRuns(linear, membership);
            expect(fromLinear.map((item) => item.id)).toEqual(['msg:ask', 'msg:ask-reply', 'workflow-run:run-z', 'msg:later', 'msg:later-reply']);
        });

        it('splits the person turn when the run fired from a turn that a continued run follows', () => {
            const continued = { runId: 'run-a', invocationRecordId: 'a1' };
            const { membership, turnItems } = build([user('ask', 1), agent('ask-reply', 2),
                stepInput('input-a', 3, continued.runId, continued.invocationRecordId), agent('a-reply', 4)],
            [sessionTurn('u1', 1, 2), sessionTurn('a', 4, 4, continued)], [firedBy('run-z', 'u1'), firedBy('run-a', 'u1')]);
            expect(foldWorkflowOriginRuns(turnItems, membership).map((item) => item.id))
                .toEqual([turnItems[0]!.id, 'workflow-run:run-z', 'workflow-run:run-a']);
        });

        it('never folds a run of another Session or one whose turn is not part of this Session', () => {
            const { membership, turnItems, linear } = build(conversation, turnsOf,
                [firedBy('run-other', 'u1', 'session-2'), firedBy('run-unknown-turn', 'turn-elsewhere')]);
            expect(membership).toBeNull();
            expect(foldWorkflowOriginRuns(turnItems, membership)).toEqual(turnItems);
            expect(foldWorkflowOriginRuns(linear, membership)).toEqual(linear);
        });
    });
});
