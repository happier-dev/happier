import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { normalizeRawMessage, type NormalizedMessage } from '@happier-dev/session-core/raw';
import { createReducer, reducer } from '@happier-dev/session-core/reducer';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { flushHookEffects, renderScreen } from '@/dev/testkit';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { projectSessionMessageInvocationV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageInvocationV1';
import { SessionMessageReplyReadBatchRequestV1Schema } from '@happier-dev/protocol/sessions/messages/sessionMessageReplyV1';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { SessionTargetV1 } from '@happier-dev/protocol/actions/sessionTargetV1';
import { t } from '@/text';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { PENDING_INPUT_PROTOCOL_VERSION_V4 } from '@happier-dev/protocol/clientCompatibility/primitives';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true }).module);

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { SessionAskRecord } = await import('./SessionAskRecord');
const { AppSessionTranscriptSourceProvider } = await import('../source/appSessionTranscriptSource');
beforeEach(async () => { await homes.reset(); });
afterEach(standardCleanup);

/** The composer's one non-executing entry, round-tripped through the real transcript reducer. */
function composerInput(serverId: string, target: SessionTargetV1, results: ReadonlyArray<readonly [string, ActionExecuteResult]>, reply: 'none' | 'return' = 'return') {
    const invocation = projectSessionMessageInvocationV1({ serverId, localId: 'attempt', requestLocalId: 'attempt', target, reply,
        result: typeof target === 'string' ? results[0]![1] : { ok: true, result: { kind: 'fanout',
            results: results.map(([sessionId, result]) => ({ target: { serverId, sessionId }, result })) } } });
    const raw = normalizeRawMessage('source-entry', 'attempt', 10, { role: 'agent', content: { type: 'event', id: 'attempt', data: {
        type: 'message', message: 'Does a replayed charge need a different banner?', sessionMessageInvocationV1: invocation,
    } } }, { messageRole: 'event', seq: 1 });
    if (!raw) throw new Error('Source entry must normalize');
    return raw;
}
function composerEntry(...args: Parameters<typeof composerInput>) {
    return reducer(createReducer(), [composerInput(...args)]).messages[0]!;
}
const accepted = { ok: true, result: { status: 'accepted', localId: 'attempt' } } as const satisfies ActionExecuteResult;
const refused = { ok: false, errorCode: 'permission_denied', error: 'Unavailable' } as const satisfies ActionExecuteResult;

async function activateHome(serverId: string) {
    const { storage } = await import('@/sync/domains/state/storage');
    const { publishAppliedActiveServerSnapshot, getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
    const previousRuntime = getAppliedActiveServerSnapshot();
    const previousAvailable = isAppliedActiveServerRuntimeAvailable();
    const previousState = storage.getState();
    onTestFinished(() => { publishAppliedActiveServerSnapshot(previousRuntime, previousAvailable); storage.setState(previousState, true); });
    storage.getState().activateProfileScope({ serverId, accountId: 'alice' });
    publishAppliedActiveServerSnapshot({ serverId, serverUrl: 'https://ask-record.test', generation: previousRuntime.generation + 1 });
}

function answerReplies(serverId: string, outcomes: Readonly<Record<string, 'answer' | 'pass' | 'cancelled'>>) {
    homes.answer(serverId, 'POST /v2/sessions/messages/replies/read-batch', { select: input => ({ body: {
        results: SessionMessageReplyReadBatchRequestV1Schema.parse(input).requests.map(key => ({ ...key, reply: {
            v: 1, status: 'available', progress: { v: 1, mode: 'return', humanOrigin: { sessionId: 'source' },
                disposition: outcomes[key.sessionId] ? 'returned' : 'observing',
                ...(outcomes[key.sessionId] ? { outcome: outcomes[key.sessionId] !== 'answer' ? { kind: outcomes[key.sessionId] }
                    : { kind: 'answer', result: { sessionId: key.sessionId, messageId: `answer-${key.sessionId}` } } } : {}) },
        } })),
    } }) });
}

const label = (screen: Awaited<ReturnType<typeof renderScreen>>, id: string) => screen.findHostByTestId(`${id}:label`)?.children.join('') ?? null;

describe('Ask record row', () => {
    it('withdraws only the recorded Ask and displays the canonical cancellation outcome', async () => {
        await loadSyncSingletonForTests();
        const serverId = await homes.addHome({ name: 'Ask record', serverUrl: 'https://ask-record.test', accountId: 'alice', currentAccount: true });
        await activateHome(serverId);
        const baseline = createRootLayoutFeaturesResponse();
        const features = createRootLayoutFeaturesResponse({ capabilities: { session: { ...baseline.capabilities.session,
            pendingInput: { protocolVersion: PENDING_INPUT_PROTOCOL_VERSION_V4 } } } });
        homes.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
        homes.answer(serverId, '/v1/features', { body: features });
        homes.answer(serverId, '/v1/features/authenticated', { body: features });
        const outcomes: Record<string, 'cancelled'> = {};
        answerReplies(serverId, outcomes);
        const endpoint = '/v2/sessions/bot/pending/attempt/withdraw';
        homes.answer(serverId, `POST ${endpoint}`, { select: () => {
            outcomes.bot = 'cancelled';
            return { body: { ok: true, outcome: 'removed' } };
        } });
        const message = composerEntry(serverId, 'bot', [['bot', accepted]]);
        const screen = await renderScreen(<AppSessionTranscriptSourceProvider sessionId="source" serverId={serverId}>
            <SessionAskRecord message={message} sessionId="source" serverId={serverId} />
        </AppSessionTranscriptSourceProvider>);
        await flushHookEffects({ cycles: 20 });
        await screen.pressByTestIdAsync(`session-ask-record-cancel:${message.id}`);
        await vi.waitFor(() => expect(homes.requestsFor(endpoint)).toMatchObject([{ serverId }]));
        await vi.waitFor(() => expect(label(screen, `session-ask-record-state:${message.id}`)).toBe(t('session.askRecord.cancelled')));
        expect(screen.findHostByTestId(`session-ask-record-cancel:${message.id}`)).toBeNull();
    });
    it('explains a person-held receipt through the invocation projection and clears the explanation for an accepted send', async () => {
        const serverId = await homes.addHome({ name: 'Held record', serverUrl: 'https://ask-record.test', accountId: 'alice', currentAccount: true });
        await activateHome(serverId);
        const held = { ok: true, result: { status: 'held', localId: 'attempt', code: 'session_input_target_unavailable',
            failureCause: { phase: 'session.message.send', errorClass: 'UnknownThrownValue', errorCode: 'held_by_person', httpStatus: null } } } as const satisfies ActionExecuteResult;
        const view = (result: ActionExecuteResult) => <AppSessionTranscriptSourceProvider sessionId="source" serverId={serverId}>
            <SessionAskRecord message={composerEntry(serverId, 'a', [['a', result]], 'none')} sessionId="source" serverId={serverId} />
        </AppSessionTranscriptSourceProvider>;
        const screen = await renderScreen(view(held));
        expect(screen.getTextContent()).toContain(t('errors.sessionHeldByPerson'));
        await screen.update(view(accepted));
        expect(screen.getTextContent()).not.toContain(t('errors.sessionHeldByPerson'));
        await screen.unmount();
    });
    it('clears the failed-target hint after the same-original retry receipt and then shows its returned answer', async () => {
        const serverId = await homes.addHome({ name: 'Ask record', serverUrl: 'https://ask-record.test', accountId: 'alice', currentAccount: true });
        await activateHome(serverId);
        answerReplies(serverId, { a: 'answer' });
        const state = createReducer();
        const initial = reducer(state, [composerInput(serverId, { selector: 'siblings' }, [['a', accepted], ['b', refused]])]).messages[0]!;
        const view = (message: typeof initial) => <AppSessionTranscriptSourceProvider sessionId="source" serverId={serverId}>
            <SessionAskRecord message={message} sessionId="source" serverId={serverId} />
        </AppSessionTranscriptSourceProvider>;
        const screen = await renderScreen(view(initial));
        await flushHookEffects({ cycles: 20 });
        expect(label(screen, 'session-ask-record-target-state:a')).toBe('Answered');
        expect(label(screen, 'session-ask-record-target-state:b')).toBe('Not sent');
        expect(screen.findHostByTestId(`session-ask-record-retry:${initial.id}`)).not.toBeNull();

        const corrected = { ...composerInput(serverId, { selector: 'siblings' }, [['a', accepted], ['b', accepted]]), isAuthoritativeUpdate: true as const };
        const updated = reducer(state, [corrected]).messages;
        expect(updated).toHaveLength(1);
        expect(state.messages.size).toBe(1);
        await screen.update(view(updated[0]!));
        await flushHookEffects({ cycles: 20 });
        expect(label(screen, 'session-ask-record-target-state:a')).toBe('Answered');
        expect(label(screen, 'session-ask-record-target-state:b')).not.toBe('Not sent');
        expect(screen.findHostByTestId(`session-ask-record-retry:${initial.id}`)).toBeNull();
        const { storage } = await import('@/sync/domains/state/storage');
        await act(async () => { storage.getState().applyMessages('source', [{ id: 'returned-b', localId: 'returned-b', seq: 2, createdAt: 20,
            role: 'user', isSidechain: false, content: { type: 'text', text: 'The retry kept the original question.' },
            meta: { happierInputAuthorityV1: { v: 1, producer: 'sessionAction', permission: { admittedPermissionCeiling: 'read-only' },
                caller: { kind: 'host' }, returnedAnswer: { requestSessionId: 'b', requestLocalId: 'attempt', outcome: 'answer',
                    delivery: 'wake', senderSessionId: 'b' } } },
        }]); });
        await flushHookEffects({ cycles: 10 });
        expect(label(screen, 'session-ask-record-target-state:b')).toBe('Answered');
        expect(screen.getTextContent()).toContain('The retry kept the original question.');
        expect(label(screen, 'session-ask-record-target-state:a')).toBe('Answered');
        expect(screen.findHostByTestId(`session-ask-record-retry:${initial.id}`)).toBeNull();
        expect(homes.requestsFor('/v1/actions/session.message.send')).toHaveLength(0);
        await screen.unmount();
    });

    it('shows the person’s text once, one result line per frozen target and the live answer, pass and refusal', async () => {
        const serverId = await homes.addHome({ name: 'Ask record', serverUrl: 'https://ask-record.test', accountId: 'alice', currentAccount: true });
        await activateHome(serverId);
        answerReplies(serverId, { a: 'answer', c: 'pass' });
        const message = composerEntry(serverId, { selector: 'siblings' }, [['a', accepted], ['b', refused], ['c', accepted]]);
        const screen = await renderScreen(<AppSessionTranscriptSourceProvider sessionId="source" serverId={serverId}>
            <SessionAskRecord message={message} sessionId="source" serverId={serverId} />
        </AppSessionTranscriptSourceProvider>);
        await flushHookEffects({ cycles: 20 });
        expect(screen.getTextContent().split('Does a replayed charge need a different banner?').length - 1).toBe(1);
        expect(screen.getTextContent()).toContain('Siblings');
        expect(label(screen, 'session-ask-record-target-state:a')).toBe('Answered');
        expect(label(screen, 'session-ask-record-target-state:c')).toBe('Passed');
        expect(label(screen, 'session-ask-record-target-state:b')).toBe('Not sent');
        expect(screen.getTextContent()).toContain('1 answered · 1 passed · 1 not sent');
        await screen.unmount();
    });

    it('counts a target whose delivery is unknown as unsure in the summary, never as not delivered', async () => {
        const serverId = await homes.addHome({ name: 'Ask record', serverUrl: 'https://ask-record.test', accountId: 'alice', currentAccount: true });
        await activateHome(serverId);
        answerReplies(serverId, { a: 'answer' });
        const unknown = { ok: false, errorCode: 'outcome_unknown', error: 'Lost' } as const satisfies ActionExecuteResult;
        const message = composerEntry(serverId, { selector: 'siblings' }, [['a', accepted], ['b', unknown]]);
        const screen = await renderScreen(<AppSessionTranscriptSourceProvider sessionId="source" serverId={serverId}>
            <SessionAskRecord message={message} sessionId="source" serverId={serverId} />
        </AppSessionTranscriptSourceProvider>);
        await flushHookEffects({ cycles: 20 });
        expect(label(screen, 'session-ask-record-target-state:b')).toBe('Not sure it was sent');
        expect(screen.getTextContent()).toContain('1 answered · 1 not sure');
        // It may have arrived: the person checks before sending again, so no retry prompt invites a duplicate.
        expect(screen.findHostByTestId(`session-ask-record-retry:${message.id}`)).toBeNull();
        expect(screen.findHostByTestId(`session-ask-record-unsure:${message.id}`)).not.toBeNull();
        await screen.unmount();
    });

    it('puts one line of the answer a target returned beside its name, and none beside a pass', async () => {
        const serverId = await homes.addHome({ name: 'Ask record', serverUrl: 'https://ask-record.test', accountId: 'alice', currentAccount: true });
        await activateHome(serverId);
        answerReplies(serverId, { a: 'answer', c: 'pass' });
        const { storage } = await import('@/sync/domains/state/storage');
        const returnedMessage = (id: string, requestSessionId: string, outcome: 'answer' | 'pass', text: string): NormalizedMessage => ({
            id, localId: id, createdAt: 20, role: 'user', isSidechain: false, content: { type: 'text', text },
            meta: { happierInputAuthorityV1: { v: 1, producer: 'sessionAction', permission: { admittedPermissionCeiling: 'read-only' },
                caller: { kind: 'host' }, returnedAnswer: { requestSessionId, requestLocalId: 'attempt', outcome, delivery: 'wake',
                    senderSessionId: requestSessionId } } },
        });
        const answer = returnedMessage('ra', 'a', 'answer', 'No banner change;\n\nreplays read as **confirmed**');
        const pass = returnedMessage('rc', 'c', 'pass', 'The requested session passed without an answer.');
        storage.getState().applyMessages('source', [answer, pass]);
        const message = composerEntry(serverId, { selector: 'siblings' }, [['a', accepted], ['b', refused], ['c', accepted]]);
        const screen = await renderScreen(<AppSessionTranscriptSourceProvider sessionId="source" serverId={serverId}>
            <SessionAskRecord message={message} sessionId="source" serverId={serverId} />
        </AppSessionTranscriptSourceProvider>);
        await flushHookEffects({ cycles: 20 });
        expect(screen.getTextContent()).toContain('No banner change; replays read as confirmed');
        expect(screen.getTextContent()).not.toContain('passed without an answer');
        expect(label(screen, 'session-ask-record-target-state:c')).toBe('Passed');
        await screen.unmount();
    });
});
