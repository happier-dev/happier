import { afterEach, beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import * as React from 'react';
import type { Message } from '@happier-dev/session-core/messages';
import { normalizeRawMessage } from '@happier-dev/session-core/raw';
import { createReducer, reducer } from '@happier-dev/session-core/reducer';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { renderHook, renderScreen, flushHookEffects } from '@/dev/testkit';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { projectSessionMessageInvocationV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageInvocationV1';
import { SessionMessageReplyReadBatchRequestV1Schema } from '@happier-dev/protocol/sessions/messages/sessionMessageReplyV1';
import { publishSessionMessageReplyInvalidation } from '@/sync/runtime/sessionMessageReplyInvalidation';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { createToolCallMessageFixture } from '@/dev/testkit/fixtures/transcriptFixtures';
import { isSessionMessageInvocationAnchor, presentsAsSessionAskRecord } from './readSessionMessageInvocation';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { useSessionMessageInvocation } = await import('./useSessionMessageInvocation');
beforeEach(async () => { await homes.reset(); });
afterEach(standardCleanup);

function sourceEntry(serverId: string, localId = 'attempt') {
    const invocation = projectSessionMessageInvocationV1({ serverId, localId, requestLocalId: localId, target: { selector: 'workers' }, reply: 'return',
        result: { ok: true, result: { kind: 'fanout', results: [
            { target: { serverId, sessionId: 'a' }, result: { ok: true, result: { status: 'accepted', localId } } },
            { target: { serverId, sessionId: 'b' }, result: { ok: false, errorCode: 'permission_denied', error: 'Unavailable' } },
            { target: { serverId, sessionId: 'c' }, result: { ok: true, result: { status: 'accepted', localId } } },
        ] } } });
    const raw = normalizeRawMessage(`source-entry:${localId}`, localId, 10, { role: 'agent', content: { type: 'event', id: localId, data: {
        type: 'message', message: 'Review this', sessionMessageInvocationV1: invocation,
    } } }, { messageRole: 'event', seq: 1 });
    if (!raw) throw new Error('Source entry must normalize');
    const message = reducer(createReducer(), [raw]).messages[0];
    if (!message) throw new Error('Source entry must reload into the transcript');
    return message;
}

function InvocationProbe(props: { scope: { serverId: string; accountId: string }; message: Message; active: boolean; arrival: number }) {
    useSessionMessageInvocation({ ...props, sessionId: 'source' });
    return null;
}

describe('source Session messaging invocation', () => {
    it('keeps a failed explicit pass separate from the original Ask and its typed return', () => {
        const message = createToolCallMessageFixture({ tool: { ...createToolCallMessageFixture().tool,
            name: 'mcp__happier__action_execute', input: { actionId: 'session.message.reply', input: {
                sessionId: 'receiver', requestLocalId: 'question', reply: { kind: 'pass' },
            } }, result: { content: [{ type: 'text', text: JSON.stringify({ v: 1, ok: false, error: 'unavailable' }) }] },
        } });
        expect(isSessionMessageInvocationAnchor(message)).toBe(false);
        expect(presentsAsSessionAskRecord(message, { serverId: 'home', sessionId: 'receiver' })).toBe(false);
    });
    it.each(['outcomeUnknown', 'rejected'] as const)('does not attach an old original or return to an unadmitted %s operation key', async status => {
        const serverId = await homes.addHome({ name: 'Unbound', serverUrl: 'https://invocation-unbound.test', accountId: 'alice', currentAccount: true });
        const message = createToolCallMessageFixture({ id: 'second-call', tool: { ...createToolCallMessageFixture().tool,
            name: 'mcp__happier__action_execute', input: { actionId: 'session.message.send', input: {
                sessionId: 'receiver', message: 'A different question', reply: 'return', localId: 'already-used',
            } }, result: { ok: true, result: { status, ...(status === 'outcomeUnknown' ? { localId: 'already-used' } : {}),
                code: status === 'outcomeUnknown' ? 'session_input_admission_identity_mismatch' : 'session_input_target_unavailable' } },
        } });
        const hook = await renderHook(useSessionMessageInvocation, { initialProps: { scope: { serverId, accountId: 'alice' },
            sessionId: 'source', message, active: true, returnedAnswers: [{ requestSessionId: 'receiver', requestLocalId: 'already-used',
                outcome: 'answer' as const, delivery: 'wake' as const, sourceMessageRef: { kind: 'session' as const,
                    session: { serverId, sessionId: 'receiver' }, messageId: 'other-question-answer' } }],
        } });
        await flushHookEffects({ cycles: 10 });
        expect(hook.getCurrent()).toMatchObject({ status: 'ready', targets: [{ localId: 'already-used', requestBound: false,
            status: status === 'outcomeUnknown' ? 'unknown' : 'failed', resultRef: null }] });
        expect(homes.requestsFor('/v2/sessions/messages/replies/read-batch')).toHaveLength(0);
    });
    it('reuses the native tool anchor and inline result without fetching or inventing a receiver request id', async () => {
        const serverId = await homes.addHome({ name: 'Native', serverUrl: 'https://invocation-native.test', accountId: 'alice', currentAccount: true });
        const binding = getActionSpec('session.message.send').bindings?.mcpToolName;
        if (!binding) throw new Error('Session message Action requires its catalog binding');
        const message = createToolCallMessageFixture({ id: 'existing-tool-row', createdAt: 10,
            tool: { name: `mcp__happier__${binding}`, input: { sessionId: 'receiver', message: 'Question', reply: 'wait' },
                result: { content: [{ type: 'text', text: JSON.stringify({ status: 'replied', localId: 'real-request',
                    outcome: { kind: 'answer', text: 'Answer', messageRef: { kind: 'session', session: { serverId, sessionId: 'receiver' }, messageId: 'real-answer' } } }) }] },
                state: 'completed', createdAt: 10, startedAt: 10, completedAt: 11, description: null } });
        const params = { scope: { serverId, accountId: 'alice' }, sessionId: 'source', message, active: true };
        const hook = await renderHook(useSessionMessageInvocation, { initialProps: params });
        expect(hook.getCurrent()).toMatchObject({ status: 'ready', origin: 'agent_tool', sourceRowId: 'existing-tool-row', text: 'Question',
            targets: [{ localId: 'real-request', status: 'answered', replyStatus: 'not_requested', resultRef: { messageId: 'real-answer' } }] });
        await hook.rerender({ ...params, message: { ...message, tool: { ...message.tool, result: { ok: false, errorCode: 'permission_denied', error: 'Unavailable' } } } });
        expect(hook.getCurrent()).toMatchObject({ status: 'ready', targets: [{ localId: null, status: 'failed' }] });
        await flushHookEffects({ cycles: 5 });
        expect(homes.requestsFor('/v2/sessions/messages/replies/read-batch')).toHaveLength(0);
        await hook.rerender({ ...params, message: { ...message, tool: { ...message.tool, result: { ok: true, result: { unrelated: true } } } } });
        expect(hook.getCurrent()).toEqual({ status: 'unavailable' });
        await hook.rerender({ ...params, message: { ...message, tool: { ...message.tool, input: { sessionId: { selector: 'manager' }, reply: 'wait' } } } });
        expect(hook.getCurrent()).toEqual({ status: 'unavailable' });
        await hook.rerender({ ...params, message: { ...message, tool: { ...message.tool, input: { sessionId: 'matching:not-json' } } } });
        expect(hook.getCurrent()).toEqual({ status: 'unavailable' });
        await hook.rerender({ ...params, message: { ...message, tool: { ...message.tool, name: 'another_server_message_send' } } });
        expect(hook.getCurrent()).toEqual({ status: 'unavailable' });
    });
    it('refreshes on the actual matching Home hint, then uses admitted returns without another read', async () => {
        const serverId = await homes.addHome({ name: 'Hints', serverUrl: 'https://invocation-hints.test', accountId: 'alice', currentAccount: true });
        const otherHome = await homes.addHome({ name: 'Other', serverUrl: 'https://invocation-other.test', accountId: 'alice' });
        const { storage } = await import('@/sync/domains/state/storage');
        const { publishAppliedActiveServerSnapshot, getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
        const previousRuntime = getAppliedActiveServerSnapshot();
        const previousAvailable = isAppliedActiveServerRuntimeAvailable();
        const previousState = storage.getState();
        onTestFinished(() => {
            publishAppliedActiveServerSnapshot(previousRuntime, previousAvailable);
            storage.setState(previousState, true);
        });
        storage.getState().activateProfileScope({ serverId, accountId: 'alice' });
        publishAppliedActiveServerSnapshot({ serverId, serverUrl: 'https://invocation-hints.test', generation: previousRuntime.generation + 1 });
        const { getActiveServerAccountScope } = await import('@/sync/domains/scope/activeServerAccountScope');
        expect(getActiveServerAccountScope()).toEqual({ serverId, accountId: 'alice' });
        let completed = false;
        homes.answer(serverId, 'POST /v2/sessions/messages/replies/read-batch', { select: input => ({ body: {
            results: SessionMessageReplyReadBatchRequestV1Schema.parse(input).requests.map(key => ({ ...key, reply: {
                v: 1, status: 'available', progress: { v: 1, mode: 'return', humanOrigin: { sessionId: 'source' },
                    disposition: completed ? 'returned' : 'observing', ...(completed ? { outcome: { kind: 'pass' } } : {}) },
            } })),
        } }) });
        const params = { scope: { serverId, accountId: 'alice' }, sessionId: 'source', message: sourceEntry(serverId), active: true,
            returnedAnswers: [] as import('@happier-dev/protocol/sessions/messages/sessionInputAdmission').SessionInputReturnedAnswerV1[] };
        const hook = await renderHook(useSessionMessageInvocation, { initialProps: params });
        await flushHookEffects({ cycles: 20 });
        expect(hook.getCurrent()).toMatchObject({ targets: [{ status: 'queued' }, { status: 'failed' }, { status: 'queued' }] });
        const { handleEphemeralSocketUpdate } = await import('@/sync/engine/socket/socket');
        const hint = (sourceServerId: string) => handleEphemeralSocketUpdate({ sourceServerId,
            update: { type: 'session-message-reply-pending-v1', v: 1, sessionId: 'a', requestLocalId: 'attempt' },
            addActivityUpdate: () => {}, addMachineActivityUpdate: () => {}, getSessionEncryption: () => null,
            getSession: () => undefined, applyMessages: () => {},
        });
        await hint(otherHome);
        await flushHookEffects({ cycles: 3 });
        expect(homes.requestsFor('/v2/sessions/messages/replies/read-batch')).toHaveLength(1);
        completed = true;
        await hint(serverId);
        await flushHookEffects({ cycles: 20 });
        expect(hook.getCurrent()).toMatchObject({ targets: [{ status: 'passed' }, { status: 'failed' }, { status: 'passed' }] });
        expect(homes.requestsFor('/v2/sessions/messages/replies/read-batch')).toHaveLength(2);
        await hook.rerender({ ...params, returnedAnswers: [{ requestSessionId: 'a', requestLocalId: 'attempt', outcome: 'answer', delivery: 'wake',
            sourceMessageRef: { kind: 'session', session: { serverId, sessionId: 'a' }, messageId: 'stale-answer' } }] });
        await flushHookEffects({ cycles: 3 });
        // The original's terminal pass remains authoritative over a conflicting return projection.
        expect(hook.getCurrent()).toMatchObject({ targets: [{ status: 'passed', resultRef: null }, { status: 'failed' }, { status: 'passed' }] });
        expect(homes.requestsFor('/v2/sessions/messages/replies/read-batch')).toHaveLength(2);
        await hook.unmount();
    });
    it('batches 1000 historical asks once on demand and adds zero reads for unrelated arrivals or closed rows', async () => {
        const serverId = await homes.addHome({ name: 'History', serverUrl: 'https://invocation-history.test', accountId: 'alice', currentAccount: true });
        const scope = { serverId, accountId: 'alice' };
        const messages = Array.from({ length: 1000 }, (_, index) => sourceEntry(serverId, `attempt-${index}`));
        homes.answer(serverId, 'POST /v2/sessions/messages/replies/read-batch', { select: input => {
            const request = SessionMessageReplyReadBatchRequestV1Schema.parse(input);
            return { body: { results: request.requests.map(key => ({ ...key, reply: { v: 1, status: 'available', progress: {
                v: 1, mode: 'return', humanOrigin: { sessionId: 'source' }, disposition: 'observing',
            } } })) } };
        } });
        const rows = (active: boolean, arrival: number) => React.createElement(React.Fragment, null,
            messages.map(message => React.createElement(InvocationProbe, { key: message.id, message, scope, active, arrival })));
        const screen = await renderScreen(rows(false, 0));
        const count = () => homes.requests.filter(request => request.path === '/v2/sessions/messages/replies/read-batch').length;
        expect(count()).toBe(0);
        await screen.update(rows(true, 0));
        await flushHookEffects({ cycles: 30 });
        expect(count()).toBe(1);
        expect(SessionMessageReplyReadBatchRequestV1Schema.parse(homes.requestsFor('/v2/sessions/messages/replies/read-batch')[0]?.input).requests).toHaveLength(2000);
        for (let arrival = 1; arrival <= 5; arrival++) {
            publishSessionMessageReplyInvalidation(scope, { type: 'session-message-reply-pending-v1', v: 1, sessionId: 'unrelated', requestLocalId: `unrelated-${arrival}` });
            await screen.update(rows(true, arrival));
        }
        await flushHookEffects({ cycles: 5 });
        expect(count()).toBe(1);
        await screen.unmount();
    });
    it('joins frozen source targets to exact live answer/pass custody and keeps the refused leaf after reload', async () => {
        const serverId = await homes.addHome({ name: 'Source', serverUrl: 'https://invocation.test', accountId: 'alice', currentAccount: true });
        const message = sourceEntry(serverId);
        homes.answer(serverId, 'POST /v2/sessions/messages/replies/read-batch', { select: input => {
            expect(input).toEqual({ requests: [{ sessionId: 'a', localId: 'attempt' }, { sessionId: 'c', localId: 'attempt' }] });
            return { body: { results: [
                { sessionId: 'a', localId: 'attempt', reply: { v: 1, status: 'available', progress: { v: 1, mode: 'return',
                    humanOrigin: { sessionId: 'source' }, disposition: 'returned', outcome: { kind: 'answer', result: { sessionId: 'a', messageId: 'answer-a' } } } } },
                { sessionId: 'c', localId: 'attempt', reply: { v: 1, status: 'available', progress: { v: 1, mode: 'return',
                    humanOrigin: { sessionId: 'source' }, disposition: 'returned', outcome: { kind: 'pass' } } } },
            ] } };
        } });
        const params = { scope: { serverId, accountId: 'alice' }, sessionId: 'source', message, active: true };
        const hook = await renderHook(useSessionMessageInvocation, { initialProps: params });
        await flushHookEffects({ cycles: 20 });
        expect(hook.getCurrent()).toMatchObject({ status: 'ready', targets: [
            { target: { serverId, sessionId: 'a' }, status: 'answered', resultRef: { messageId: 'answer-a' } },
            { target: { serverId, sessionId: 'b' }, status: 'failed', code: 'permission_denied' },
            { target: { serverId, sessionId: 'c' }, status: 'passed' },
        ] });
        const reads = homes.requests.length;
        for (let i = 0; i < 5; i++) await hook.rerender({ ...params });
        await flushHookEffects({ cycles: 5 });
        expect(homes.requests).toHaveLength(reads);
        expect(homes.requests.filter(request => request.path.includes('/messages')).map(request => request.path))
            .toEqual(['/v2/sessions/messages/replies/read-batch']);
    });
    it('uses an admitted source return when original custody is unavailable without fetching its body', async () => {
        const serverId = await homes.addHome({ name: 'Return', serverUrl: 'https://invocation-return.test', accountId: 'alice', currentAccount: true });
        homes.answer(serverId, 'POST /v2/sessions/messages/replies/read-batch', { status: 503, body: {} });
        const params = { scope: { serverId, accountId: 'alice' }, sessionId: 'source', message: sourceEntry(serverId), active: true,
            returnedAnswers: [] as import('@happier-dev/protocol/sessions/messages/sessionInputAdmission').SessionInputReturnedAnswerV1[] };
        const hook = await renderHook(useSessionMessageInvocation, { initialProps: params });
        await flushHookEffects({ cycles: 20 });
        expect(hook.getCurrent()).toMatchObject({ targets: [
            { status: 'queued', replyStatus: 'unavailable' }, { status: 'failed' }, { status: 'queued', replyStatus: 'unavailable' },
        ] });
        await hook.rerender({ ...params, returnedAnswers: [{ requestSessionId: 'a', requestLocalId: 'attempt', outcome: 'answer', delivery: 'wake',
            sourceMessageRef: { kind: 'session', session: { serverId, sessionId: 'a' }, messageId: 'committed-answer' } }] });
        expect(hook.getCurrent()).toMatchObject({ targets: [
            { status: 'answered', resultRef: { messageId: 'committed-answer' } }, { status: 'failed' }, { status: 'queued', replyStatus: 'unavailable' },
        ] });
        expect(homes.requests.filter(request => request.path.includes('/messages')).map(request => request.path))
            .toEqual(['/v2/sessions/messages/replies/read-batch']);
    });
});
