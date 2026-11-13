import { describe, expect, it, vi } from 'vitest';

import { sendDiscussionSelectionToSession, sendDiscussionSelectionToSessionNow } from '@/components/discussions/sendDiscussionSelectionToSession';

const SOURCE = { kind: 'discussion' as const, serverId: 'server-a', discussionId: 'discussion-a', messageIds: ['reply-a'] };

function sendNow(execute: (...args: any[]) => Promise<unknown>, source: typeof SOURCE | Readonly<Record<string, unknown>> = SOURCE) {
    return sendDiscussionSelectionToSessionNow({
        scope: { serverId: 'server-a', accountId: 'account-a' },
        sessionId: 'session-a',
        selectedText: '**Reviewer:**\n\nCheck the retry path',
        source: source as typeof SOURCE,
        template: 'From the discussion:\n\n{{MESSAGES}}',
        sourceSessionName: 'Checkout UI',
        localId: 'local-1',
        // The Action executor is the boundary: it carries the send to the Session's Home.
        execute: execute as never,
    });
}

describe('sendDiscussionSelectionToSessionNow', () => {
    it('sends the quoted reply with its source as information, under the caller’s localId, and never touches a draft', async () => {
        const execute = vi.fn(async () => ({ ok: true, result: { status: 'accepted', localId: 'local-1' } }));
        await expect(sendNow(execute)).resolves.toEqual({ status: 'queued', requestBound: true });
        expect(execute).toHaveBeenCalledWith('session.message.send', {
            sessionId: 'session-a',
            message: 'From the discussion:\n\n**Reviewer:**\n\nCheck the retry path',
            localId: 'local-1',
            reply: 'none',
            structuredInput: { v: 1, discussionSelectionSourceV1: SOURCE },
        }, expect.objectContaining({ surface: 'ui', authority: 'present_user', serverId: 'server-a', expectedAccountId: 'account-a' }));
    });

    it.each([
        [{ ok: true, result: { status: 'alreadyAccepted', localId: 'local-1' } }, { status: 'queued', requestBound: true }],
        [{ ok: true, result: { status: 'held', localId: 'local-1', code: 'autonomous_check_in' } }, { status: 'held', requestBound: true }],
        [{ ok: true, result: { status: 'rejected', code: 'session_input_target_unavailable' } }, { status: 'failed', requestBound: false, code: 'session_input_target_unavailable' }],
        [{ ok: true, result: { status: 'outcomeUnknown', localId: 'local-1', code: 'transport_lost' } }, { status: 'unknown', requestBound: false, code: 'transport_lost' }],
        [{ ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' }, { status: 'failed', requestBound: false, code: 'target_unavailable' }],
    ])('says the true outcome: %j', async (result, receipt) => {
        await expect(sendNow(vi.fn(async () => result))).resolves.toEqual(receipt);
    });

    it('refuses a source from another Home before sending', async () => {
        const execute = vi.fn();
        await expect(sendNow(execute, { ...SOURCE, serverId: 'other-home' })).resolves.toEqual({ status: 'failed', requestBound: false, code: 'invalid_parameters' });
        expect(execute).not.toHaveBeenCalled();
    });
});

describe('sendDiscussionSelectionToSession', () => {
    it('appends the formatted Discussion selection before revealing and focusing', async () => {
        const calls: string[] = [];
        const appendToDraft = vi.fn(async () => { calls.push('write'); });
        const revealPrimaryComposer = vi.fn(async () => { calls.push('reveal'); });
        const focusPrimaryComposer = vi.fn(() => { calls.push('focus'); return true; });

        await expect(sendDiscussionSelectionToSession({
            sessionId: 'session-a',
            serverId: 'server-a',
            selectedText: '**Alice:**\n\nPlease review',
            source: {
                kind: 'discussion',
                serverId: 'server-a',
                discussionId: 'discussion-a',
                messageIds: ['message-a'],
            },
            template: 'Review this selection:\n\n{{MESSAGES}}',
            sourceSessionName: 'Primary',
            appendToDraft,
            revealPrimaryComposer,
            focusPrimaryComposer,
        })).resolves.toBe(true);

        expect(appendToDraft).toHaveBeenCalledWith({
            sessionId: 'session-a',
            serverId: 'server-a',
            text: 'Review this selection:\n\n**Alice:**\n\nPlease review',
            discussionSource: { kind: 'discussion', serverId: 'server-a', discussionId: 'discussion-a', messageIds: ['message-a'] },
        });
        expect(calls).toEqual(['write', 'reveal', 'focus']);
    });

    it('rejects the same raw Discussion identity from another Home before writing', async () => {
        const appendToDraft = vi.fn();
        await expect(sendDiscussionSelectionToSession({
            sessionId: 'session-a',
            serverId: 'server-a',
            selectedText: 'message',
            source: {
                kind: 'discussion',
                serverId: 'other-home',
                discussionId: 'discussion-a',
                messageIds: ['message-a'],
            },
            template: '{{MESSAGES}}',
            sourceSessionName: null,
            appendToDraft,
            revealPrimaryComposer: () => undefined,
            focusPrimaryComposer: () => true,
        })).resolves.toBe(false);
        expect(appendToDraft).not.toHaveBeenCalled();
    });
});
