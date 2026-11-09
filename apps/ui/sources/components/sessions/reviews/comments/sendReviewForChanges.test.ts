import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildReviewCommentsOutboundMessage } from '@/sync/domains/input/reviewComments/buildReviewCommentsOutboundMessage';
import type { ReviewCommentDraft } from '@/sync/domains/input/reviewComments/reviewCommentTypes';
import {
    getExistingSessionDraftProjection,
    resetSessionDraftRepositoryForTests,
    writeExistingSessionDraft,
} from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { submitSessionUserMessage } from '@/sync/domains/session/input/submitSessionUserMessage';
import type { SessionSubmitPort } from '@/sync/domains/session/input/types';
import { buildSession } from '@/sync/engine/pending/pendingQueueV2.testHelpers';

const submitMessageSpy = vi.fn();

vi.mock('@/sync/sync', () => ({
    sync: { submitMessage: (...args: unknown[]) => submitMessageSpy(...args) },
}));

const SCOPE: ServerAccountScope = { serverId: 'srv_1', accountId: 'acct_1' };
const lifetime = { scope: SCOPE, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };

function draft(id: string, includeInPrompt = true): ReviewCommentDraft {
    return {
        id,
        filePath: 'src/SettingsModal.tsx',
        source: 'diff',
        anchor: { kind: 'diffLine', startLine: 22, side: 'after', oldLine: null, newLine: 22 },
        snapshot: { selectedLines: ['const key = useSettingsRouteKey(route);'], beforeContext: [], afterContext: [] },
        body: `Comment ${id}`,
        includeInPrompt,
        createdAt: 1,
    } as ReviewCommentDraft;
}

describe('sendReviewForChanges', () => {
    afterEach(() => {
        submitMessageSpy.mockReset();
        resetSessionDraftRepositoryForTests();
    });

    it('sends what the main composer sends for the same draft and comments, then clears both once', async () => {
        const { sendReviewForChanges } = await import('./sendReviewForChanges');
        writeExistingSessionDraft({ scope: SCOPE, sessionId: 's1', patch: { text: 'Address these, then run the settings tests again.' } });
        submitMessageSpy.mockImplementation(async (_sessionId, _text, _display, _meta, options) => {
            options?.onOutboundHandoff?.({ localId: 'local-1', persistence: 'direct' });
        });
        const clearSentDrafts = vi.fn();
        const drafts = [draft('a'), draft('b'), draft('c', false)];

        const outcome = await sendReviewForChanges({
            sessionId: 's1',
            serverId: 'srv_1',
            accountLifetime: lifetime,
            drafts,
            reviewScope: null,
            clearSentDrafts,
        });

        expect(outcome).toBe('sent');
        const expected = buildReviewCommentsOutboundMessage({
            sessionId: 's1',
            drafts: [drafts[0]!, drafts[1]!],
            additionalMessage: 'Address these, then run the settings tests again.',
        });
        expect(submitMessageSpy).toHaveBeenCalledTimes(1);
        expect(submitMessageSpy).toHaveBeenCalledWith(
            's1',
            expected.text,
            expected.displayText,
            expected.metaOverrides,
            expect.objectContaining({ serverId: 'srv_1', accountLifetime: lifetime, callerSurface: 'session_review_comment_composer' }),
        );
        expect(getExistingSessionDraftProjection(SCOPE, 's1')?.text ?? '').toBe('');
        expect(clearSentDrafts).toHaveBeenCalledTimes(1);
        expect(clearSentDrafts).toHaveBeenCalledWith([drafts[0], drafts[1]]);
    });

    it('keeps the draft and the comments when the send is refused', async () => {
        const { sendReviewForChanges } = await import('./sendReviewForChanges');
        writeExistingSessionDraft({ scope: SCOPE, sessionId: 's1', patch: { text: 'Please fix.' } });
        submitMessageSpy.mockRejectedValue(new Error('Failed to submit message'));
        const clearSentDrafts = vi.fn();

        const outcome = await sendReviewForChanges({
            sessionId: 's1',
            accountLifetime: lifetime,
            drafts: [draft('a')],
            reviewScope: null,
            clearSentDrafts,
        });

        expect(outcome).toBe('failed');
        expect(getExistingSessionDraftProjection(SCOPE, 's1')?.text).toBe('Please fix.');
        expect(clearSentDrafts).not.toHaveBeenCalled();
    });

    it('keeps review and Composer drafts when canonical pending admission is cancelled', async () => {
        const { sendReviewForChanges } = await import('./sendReviewForChanges');
        const session = buildSession({ sessionId: 's1', overrides: { pendingVersion: 2 } });
        // The admission port is the persistence/transport boundary; the real submission and draft owners run below it.
        const port: SessionSubmitPort = {
            blockPendingDelivery: async () => { throw new Error('Cancelled admission cannot block delivery'); },
            enqueuePendingMessage: async () => ({ localId: 'cancelled', accepted: true, cancelled: true }),
            sendMessage: async () => { throw new Error('Direct send is unexpected'); },
            ensureSessionRuntimeForPendingInput: async () => ({ type: 'success' }),
            isSessionTargetRemoteToActiveServer: () => false,
        };
        submitMessageSpy.mockImplementation(async (_sessionId, text, displayText, metaOverrides, options) => {
            const result = await submitSessionUserMessage(port, {
                sessionId: 's1', session, text, displayText, metaOverrides,
                configuredMode: 'server_pending', resumeCapabilityOptions: {},
                onOutboundHandoff: options?.onOutboundHandoff,
                accountLifetime: options?.accountLifetime,
            });
            if (result.type === 'rejected') throw new Error(result.errorCode);
        });
        writeExistingSessionDraft({ scope: SCOPE, sessionId: 's1', patch: { text: 'Please fix.' } });
        const clearSentDrafts = vi.fn();
        await expect(sendReviewForChanges({
            sessionId: 's1', accountLifetime: lifetime, drafts: [draft('a')], reviewScope: null, clearSentDrafts,
        })).resolves.toBe('failed');
        expect(getExistingSessionDraftProjection(SCOPE, 's1')?.text).toBe('Please fix.');
        expect(clearSentDrafts).not.toHaveBeenCalled();
    });

    it('does not send without a comment that rides along', async () => {
        const { sendReviewForChanges } = await import('./sendReviewForChanges');
        const outcome = await sendReviewForChanges({
            sessionId: 's1',
            accountLifetime: lifetime,
            drafts: [draft('a', false)],
            reviewScope: null,
            clearSentDrafts: vi.fn(),
        });
        expect(outcome).toBe('nothing');
        expect(submitMessageSpy).not.toHaveBeenCalled();
    });
});
