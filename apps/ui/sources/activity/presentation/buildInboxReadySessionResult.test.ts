import { describe, expect, it } from 'vitest';
import type { Message } from '@happier-dev/session-core/messages';
import type { SessionTurnV1, SessionTurnsProjectionV1 } from '@happier-dev/protocol/sessions/turns/sessionTurnV1';
import { createSessionFixture, createSessionViewerFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { buildSessionActivityAttention } from '@/activity/attention/buildSessionActivityAttention';
import { buildInboxReadySessionResult } from './buildInboxReadySessionResult';

const first: SessionTurnV1 = { turnId: 'first', status: 'completed', startedAt: 1, updatedAt: 5, terminalAt: 5,
    transcriptAnchors: { startSeqInclusive: 2, endSeqInclusive: 5, finalAssistantMessageSeq: 4 },
    workflowInvocation: { runId: 'first-run', invocationRecordId: 'first-invocation' } };
const second: SessionTurnV1 = { turnId: 'second', status: 'completed', startedAt: 6, updatedAt: 10, terminalAt: 10,
    transcriptAnchors: { startSeqInclusive: 6, endSeqInclusive: 10, finalAssistantMessageSeq: 9 },
    workflowInvocation: { runId: 'second-run', invocationRecordId: 'second-invocation' } };
const turns: SessionTurnsProjectionV1 = { v: 1, sessionId: 'bot', updatedAt: 10, latestTurnId: 'second', turns: [first, second] };
const candidate = buildSessionActivityAttention({ session: createSessionFixture({ id: 'bot', serverId: 'home', latestTurnId: 'first',
    latestTurnStatus: 'completed', latestReadyEventSeq: 5, latestReadyEventAt: 5,
    sessionTurns: turns }), nowMs: 20 });
const messages: Message[] = [
    { kind: 'agent-text', id: 'answer-1', localId: null, seq: 4, createdAt: 4, text: 'First\n  result' },
    { kind: 'agent-text', id: 'answer-2', localId: null, seq: 9, createdAt: 9, text: 'Later result' },
];

describe('buildInboxReadySessionResult', () => {
    it('keeps the committed finding and its evidence links intact without treating completion as a diagnosis', () => {
        const text = 'Root cause remains unconfirmed.\n\nEvidence: [masked build log](https://example.test/log).\n\nNext: restore diagnostic access, then continue in this Session.';
        const result = buildInboxReadySessionResult({ candidate, turns,
            messages: [{ ...messages[0]!, text }] });
        expect(result.output).toEqual({ text, messageRef: { kind: 'session',
            session: { serverId: 'home', sessionId: 'bot' }, messageId: 'answer-1' } });
        expect(result.completedAt).toBe(5);
        const running = buildInboxReadySessionResult({ candidate, turns: { ...turns,
            turns: [{ ...first, status: 'in_progress' }] }, messages, selection: 'latestTurn' });
        expect(running.output).toBeUndefined();
    });
    it('lets a linked receipt select the latest Turn while Inbox keeps its once-delivery Turn', () => {
        const current = buildSessionActivityAttention({ session: createSessionFixture({ id: 'bot', serverId: 'home',
            latestTurnId: 'second', latestTurnStatus: 'completed', sessionTurns: turns,
            viewer: createSessionViewerFixture({ follow: { follows: true, notificationLevel: 'all_messages',
                onceDelivery: { event: 'ready', turnId: 'first', agentStateVersion: 1 } } }) }), nowMs: 20 });
        expect(buildInboxReadySessionResult({ candidate: current, turns, messages }).preview)
            .toEqual({ state: 'available', text: 'First result' });
        expect(buildInboxReadySessionResult({ candidate: current, turns, messages, selection: 'latestTurn' }).preview)
            .toEqual({ state: 'available', text: 'Later result' });
        expect(buildInboxReadySessionResult({ candidate: current, turns: { ...turns,
            turns: [first, { ...second, status: 'in_progress' }] }, messages, selection: 'latestTurn' }).preview)
            .toEqual({ state: 'unavailable' });
    });

    it('uses the matching ready Turn for both assistant result and loaded workflow attribution', () => {
        expect(buildInboxReadySessionResult({ candidate: { ...candidate, lastTurnCompletedAt: 10 }, turns, messages,
            resolveWorkflowName: invocation => invocation.runId === 'first-run' ? 'Morning routine' : 'Later routine' }))
            .toMatchObject({ preview: { state: 'available', text: 'First result' },
                workflowInvocation: { ...first.workflowInvocation, label: 'Morning routine' }, completedAt: 5 });
        expect(buildInboxReadySessionResult({ candidate, messages, turns: null })).toMatchObject({ preview: { state: 'unavailable' }, workflowInvocation: null });
        expect(buildInboxReadySessionResult({ candidate, messages: [messages[1]!], turns }))
            .toMatchObject({ preview: { state: 'unavailable' }, workflowInvocation: first.workflowInvocation });
        const manual = { ...first, workflowInvocation: undefined };
        expect(buildInboxReadySessionResult({ candidate, messages, turns: { v: 1, sessionId: 'bot', updatedAt: 5, turns: [manual] } }))
            .toHaveProperty('workflowInvocation', null);
    });

    it('retains typed unavailable without touching messages or workflow names for unreadable or Runner-only content', () => {
        for (const locked of [
            { ...candidate, awareness: { ...candidate.awareness, encryption: 'locked' as const } },
            { ...candidate, session: { ...candidate.session, access: { ...candidate.session.access!, capabilities: {
                ...candidate.session.access!.capabilities, readTranscript: false } } } },
        ]) {
            expect(buildInboxReadySessionResult({ candidate: locked, turns,
                get messages(): readonly Message[] { throw new Error('private content accessed'); },
                resolveWorkflowName: () => { throw new Error('private label accessed'); } }))
                .toMatchObject({ preview: { state: 'unavailable' }, workflowInvocation: null });
        }
    });
});
