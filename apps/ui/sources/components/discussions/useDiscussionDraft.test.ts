import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { formatInlineReferenceTokenV1 } from '@happier-dev/protocol/runtime/input/inlineReferenceTokenV1';
import type { ComposerStructuredInputMention } from '@/components/sessions/agentInput/structuredInputMentions';

import { renderHook } from '@/dev/testkit';
import {
    getSessionComposerDraftSnapshot,
    getSessionDraftSnapshot,
    resetSessionDraftRepositoryForTests,
    purgeSessionDraftPresentation,
    writeDiscussionSessionDraft,
} from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import type { DiscussionDraftSubmission } from '@/sync/ops/discussions/discussionRepository';

import { seedDiscussionDraft, useDiscussionDraft } from './useDiscussionDraft';
import { buildDiscussionContent } from './discussionComposerDocument';

function mention(kind: string, ref: string, label: string, start: number) {
    const tokenText = formatInlineReferenceTokenV1({ ref, label });
    return { kind, ref, label, tokenText, start, end: start + tokenText.length } satisfies ComposerStructuredInputMention;
}
const alex = formatInlineReferenceTokenV1({ label: 'Alex', ref: 'account:account-alex' });
const sessionAlex = formatInlineReferenceTokenV1({ label: 'Alex', ref: 'session:session-alex' });
const bob = formatInlineReferenceTokenV1({ label: 'Bob', ref: 'account:account-bob' });
const model = formatInlineReferenceTokenV1({ label: 'Model', ref: 'discussion-participant:saved-model-slot' });
const ana = formatInlineReferenceTokenV1({ label: 'Ana', ref: 'account:ana' });

const scope = { serverId: 'discussion-draft-home', accountId: 'discussion-draft-account' } as const;
const newAddress = { kind: 'newDiscussion' } as const;
const existingAddress = {
    kind: 'discussion',
    discussionId: 'discussion-draft-existing',
} as const;

afterEach(() => {
    resetSessionDraftRepositoryForTests();
});

describe('useDiscussionDraft', () => {
    it('carries edits made during creation into the confirmed discussion draft', async () => {
        const hook = await renderHook(() => useDiscussionDraft({ scope, address: newAddress }));
        act(() => { hook.getCurrent().setTitle('First conversation'); hook.getCurrent().setText('First question'); });
        const submitted = hook.getCurrent().captureSubmittedCurrentness();
        act(() => { hook.getCurrent().setText(`Next ${ana}`); hook.getCurrent().setMentions([mention('happier.account', 'account:ana', 'Ana', 5)]); });
        await act(async () => { await hook.getCurrent().clearAfterObservedSuccess(submitted, existingAddress.discussionId); });
        expect(getSessionComposerDraftSnapshot(scope, existingAddress)?.composer).toMatchObject({
            text: { value: `Next ${ana}` }, mentions: { value: [mention('happier.account', 'account:ana', 'Ana', 5)] },
        });
        expect(hook.getCurrent().text).toBe('');
        await hook.unmount();
    });
    it('preserves reply and passage context authored after a retained question opened for review', async () => {
        const passage = { ref: { kind: 'doc' as const, artifactId: 'next-source', serverId: scope.serverId },
            revision: { headerVersion: 1, bodyVersion: 1 }, range: { start: 0, end: 6 }, quote: 'source' };
        writeDiscussionSessionDraft({ scope, address: existingAddress, patch: { text: 'Retained question' } });
        const hook = await renderHook(() => useDiscussionDraft({ scope, address: existingAddress }));
        const retained = hook.getCurrent().captureSubmittedCurrentness();
        act(() => {
            hook.getCurrent().setReplyTarget({ kind: 'message', messageId: 'next-reply' });
            hook.getCurrent().setPassage(passage);
        });
        let submitted: DiscussionDraftSubmission;
        act(() => { submitted = hook.getCurrent().captureSubmittedCurrentness({ kind: 'post', discussionId: existingAddress.discussionId,
            localId: 'reviewed-question' }, { content: buildDiscussionContent('Retained question', []), retainedCurrentness: retained.currentness }); });
        await act(async () => { await hook.getCurrent().clearAfterObservedSuccess(submitted!); });
        expect(hook.getCurrent().text).toBe('');
        expect(hook.getCurrent().replyTarget).toEqual({ kind: 'message', messageId: 'next-reply' });
        expect(hook.getCurrent().passage).toEqual(passage);
        expect(hook.getCurrent().submitted).toBeNull();
        expect(hook.getCurrent().pendingMutationAttempt).toBeNull();
        await hook.unmount();
    });
    it('clears the submitted passage, reply and invitees independently of newer text after acceptance', async () => {
        const passage = { ref: { kind: 'doc' as const, artifactId: 'notes', serverId: scope.serverId },
            revision: { headerVersion: 1, bodyVersion: 1 }, range: { start: 0, end: 6 }, quote: 'source' };
        writeDiscussionSessionDraft({ scope, address: newAddress, patch: { title: 'Review', text: 'First question', passage,
            participants: [{ kind: 'account', accountId: 'ana' }], replyTarget: { kind: 'doc_passage', doc: { ref: passage.ref, revision: passage.revision } } } });
        const hook = await renderHook(() => useDiscussionDraft({ scope, address: newAddress }));
        let submission: DiscussionDraftSubmission | undefined;
        act(() => { submission = hook.getCurrent().captureSubmittedCurrentness({ kind: 'create', creationLocalId: 'accepted', messageLocalId: 'first' }); });
        act(() => hook.getCurrent().setText('Next question'));
        expect(hook.getCurrent().passage).toEqual(passage);
        await act(async () => { await hook.getCurrent().clearAfterObservedSuccess(submission!); });
        expect(hook.getCurrent().text).toBe('Next question');
        expect(hook.getCurrent().passage).toBeNull();
        expect(hook.getCurrent().replyTarget).toBeNull();
        expect(hook.getCurrent().participants).toEqual([]);
        expect(hook.getCurrent().submitted).toBeNull();
        expect(hook.getCurrent().pendingMutationAttempt).toBeNull();
        await hook.unmount();
    });
    it('persists only explicit Reply intent, supports clearing, and consumes it after observed send success', async () => {
        const plain = buildDiscussionContent('A new post', []);
        const first = await renderHook(() => useDiscussionDraft({ scope, address: existingAddress }));
        expect(first.getCurrent().replyTarget).toBeNull();
        act(() => first.getCurrent().setRecipients([{ kind: 'session', sessionId: 'default-recipient' }]));
        act(() => first.getCurrent().setReplyTarget({ kind: 'message', messageId: 'explicit-reply' }));
        act(() => first.getCurrent().setText('A new post'));
        await first.unmount();
        const restored = await renderHook(() => useDiscussionDraft({ scope, address: existingAddress }));
        expect(restored.getCurrent().replyTarget).toEqual({ kind: 'message', messageId: 'explicit-reply' });
        expect(restored.getCurrent().prepareContent(plain)).toEqual(plain);
        act(() => restored.getCurrent().setReplyTarget(null));
        expect(restored.getCurrent().replyTarget).toBeNull();
        expect(restored.getCurrent().prepareContent(plain)).toMatchObject({ parts: [{ t: 'mention', participant: { kind: 'session', sessionId: 'default-recipient' } }, { t: 'text' }, { t: 'text' }] });
        act(() => restored.getCurrent().setReplyTarget({ kind: 'message', messageId: 'next-reply' }));
        let submitted: DiscussionDraftSubmission;
        act(() => { submitted = restored.getCurrent().captureSubmittedCurrentness({ kind: 'post', discussionId: existingAddress.discussionId,
            localId: 'explicit-reply-post', replyTarget: restored.getCurrent().replyTarget! }, { content: plain }); });
        // Preparing or failing a send must retain intent for retry.
        expect(restored.getCurrent().replyTarget).toEqual({ kind: 'message', messageId: 'next-reply' });
        await act(async () => { await restored.getCurrent().clearAfterObservedSuccess(submitted!); });
        expect(restored.getCurrent().replyTarget).toBeNull();
        await restored.unmount();
    });

    it('preserves a newer reply choice made while the previous post was in flight', async () => {
        const rendered = await renderHook(() => useDiscussionDraft({ scope, address: existingAddress }));
        act(() => { rendered.getCurrent().setText('First reply'); rendered.getCurrent().setReplyTarget({ kind: 'message', messageId: 'first' }); });
        let submitted: DiscussionDraftSubmission;
        act(() => { submitted = rendered.getCurrent().captureSubmittedCurrentness({ kind: 'post', discussionId: existingAddress.discussionId,
            localId: 'first-reply', replyTarget: rendered.getCurrent().replyTarget! }); });
        act(() => rendered.getCurrent().setReplyTarget({ kind: 'message', messageId: 'second' }));
        await act(async () => { await rendered.getCurrent().clearAfterObservedSuccess(submitted!); });
        expect(rendered.getCurrent().replyTarget).toEqual({ kind: 'message', messageId: 'second' });
        await rendered.unmount();
    });
    it('keeps multiple recipients in the qualified draft through remount and accepted send clearing, while explicit mentions and Reply override them', async () => {
        const recipients = [{ kind: 'session' as const, sessionId: 'reviewer-a' }, { kind: 'account' as const, accountId: 'person-b' }];
        writeDiscussionSessionDraft({ scope, address: existingAddress, patch: { text: 'Review this', recipients } });
        const first = await renderHook(() => useDiscussionDraft({ scope, address: existingAddress }));
        const plain = { v: 1 as const, parts: [{ t: 'text' as const, text: 'Review this' }] };
        const addressed = { v: 1, parts: [
            { t: 'mention', participant: recipients[0] }, { t: 'text', text: ' ' },
            { t: 'mention', participant: recipients[1] }, { t: 'text', text: ' ' }, ...plain.parts,
        ] };
        expect(first.getCurrent().prepareContent(plain)).toEqual(addressed);
        let submission: DiscussionDraftSubmission | undefined;
        act(() => { submission = first.getCurrent().captureSubmittedCurrentness({ kind: 'post', discussionId: existingAddress.discussionId, localId: 'recipient-send' }); });
        await first.unmount();
        const restored = await renderHook(() => useDiscussionDraft({ scope, address: existingAddress }));
        expect(restored.getCurrent().recipients).toEqual(recipients);
        expect(restored.getCurrent().submitted?.content).toEqual(addressed);
        expect(restored.getCurrent().prepareContent(plain, { replyTarget: { kind: 'message', messageId: 'reply-id' } })).toEqual(plain);
        const explicit = buildDiscussionContent(ana, [mention('happier.account', 'account:ana', 'Ana', 0)]);
        expect(restored.getCurrent().prepareContent(explicit)).toEqual(explicit);
        act(() => restored.getCurrent().setRecipients([{ kind: 'session', sessionId: 'next-reviewer' }]));
        await act(async () => { await restored.getCurrent().clearAfterObservedSuccess(submission!); });
        expect(restored.getCurrent().text).toBe('');
        expect(restored.getCurrent().recipients).toEqual([{ kind: 'session', sessionId: 'next-reviewer' }]);
        await restored.unmount();
        const otherHome = await renderHook(() => useDiscussionDraft({ scope: { ...scope, serverId: 'different-home' }, address: existingAddress }));
        expect(otherHome.getCurrent().recipients).toEqual([]);
        await otherHome.unmount();
        const otherAccount = await renderHook(() => useDiscussionDraft({ scope: { ...scope, accountId: 'different-account' }, address: existingAddress }));
        expect(otherAccount.getCurrent().recipients).toEqual([]);
        await otherAccount.unmount();
    });
    // New Discussion (C3 §6.1): the people and agents chosen before create stay in the creation draft —
    // through remount, per Home and Account — and leave with the other captured create fields.
    it('keeps the chosen initial participants in the new Discussion draft until the create is observed', async () => {
        const participants = [{ kind: 'account' as const, accountId: 'ana' }, { kind: 'session' as const, sessionId: 'checkout-ui' }];
        writeDiscussionSessionDraft({ scope, address: newAddress, patch: { title: 'Retry cap', text: 'Drop the banner?', mentions: [] } });
        const first = await renderHook(() => useDiscussionDraft({ scope, address: newAddress }));
        expect(first.getCurrent().participants).toEqual([]);
        act(() => first.getCurrent().setParticipants(participants));
        await first.unmount();
        const restored = await renderHook(() => useDiscussionDraft({ scope, address: newAddress }));
        expect(restored.getCurrent().participants).toEqual(participants);
        const otherAccount = await renderHook(() => useDiscussionDraft({ scope: { ...scope, accountId: 'different-account' }, address: newAddress }));
        expect(otherAccount.getCurrent().participants).toEqual([]);
        await otherAccount.unmount();
        let submitted: DiscussionDraftSubmission | null = null;
        act(() => {
            submitted = restored.getCurrent().captureSubmittedCurrentness({ kind: 'create',
                creationLocalId: 'create-with-people', messageLocalId: 'create-with-people-message', participants });
        });
        expect(restored.getCurrent().pendingMutationAttempt).toMatchObject({ kind: 'create', participants });
        await act(async () => { await restored.getCurrent().clearAfterObservedSuccess(submitted!); });
        expect(restored.getCurrent().participants).toEqual([]);
        expect(getSessionComposerDraftSnapshot(scope, newAddress)).toBeNull();
        await restored.unmount();
    });

    it('retains only the selected model slot identity across editing and remount before any Send', async () => {
        writeDiscussionSessionDraft({ scope, address: existingAddress, patch: {
            text: model, mentions: [mention('happier.discussionParticipant', 'discussion-participant:saved-model-slot', 'Model', 0)],
        } });
        const first = await renderHook(() => useDiscussionDraft({ scope, address: existingAddress }));
        expect(first.getCurrent().mentions).toEqual([mention('happier.discussionParticipant', 'discussion-participant:saved-model-slot', 'Model', 0)]);
        act(() => first.getCurrent().setText(`Ask ${model}`));
        await first.unmount();
        const restored = await renderHook(() => useDiscussionDraft({ scope, address: existingAddress }));
        expect(restored.getCurrent().mentions).toEqual([mention('happier.discussionParticipant', 'discussion-participant:saved-model-slot', 'Model', 4)]);
        expect(getSessionComposerDraftSnapshot(scope, existingAddress)?.composer.mentions.value)
            .toEqual([mention('happier.discussionParticipant', 'discussion-participant:saved-model-slot', 'Model', 4)]);
        expect(restored.getCurrent().pendingMutationAttempt).toBeNull();
        await restored.unmount();
    });
    it('switches keyed route drafts without borrowing subscriptions or clearing another draft submission', async () => {
        const firstAddress = { kind: 'newDiscussion' as const, draftId: '00000000-0000-5000-8000-000000000001' };
        const secondAddress = { kind: 'newDiscussion' as const, draftId: '00000000-0000-5000-8000-000000000002' };
        for (const [address, text] of [[newAddress, 'Unrelated singleton'], [firstAddress, 'First passage'], [secondAddress, 'Second passage']] as const) {
            writeDiscussionSessionDraft({ scope, address, patch: { text, mentions: [] } });
        }
        const hook = await renderHook(({ address }) => useDiscussionDraft({ scope, address }), { initialProps: { address: firstAddress } });
        let first: DiscussionDraftSubmission | undefined;
        act(() => { first = hook.getCurrent().captureSubmittedCurrentness({ kind: 'create', creationLocalId: 'first-create', messageLocalId: 'first-message' }); });
        await hook.rerender({ address: secondAddress });
        expect(hook.getCurrent().text).toBe('Second passage');
        act(() => { hook.getCurrent().captureSubmittedCurrentness({ kind: 'create', creationLocalId: 'second-create', messageLocalId: 'second-message' }); });
        await act(async () => { expect(await hook.getCurrent().clearAfterObservedSuccess(first!)).toBe(false); });
        expect(hook.getCurrent().text).toBe('Second passage');
        expect(hook.getCurrent().pendingMutationAttempt).toMatchObject({ creationLocalId: 'second-create' });
        await hook.rerender({ address: firstAddress });
        expect(hook.getCurrent().pendingMutationAttempt).toMatchObject({ creationLocalId: 'first-create' });
        await act(async () => { await hook.getCurrent().clearAfterObservedSuccess(first!); });
        expect(hook.getCurrent().text).toBe('');
        expect(getSessionComposerDraftSnapshot(scope, secondAddress)?.composer.text.value).toBe('Second passage');
        expect(getSessionComposerDraftSnapshot(scope, newAddress)?.composer.text.value).toBe('Unrelated singleton');
        await hook.unmount();
    });
    it('retains a qualified passage and retry identity across remount, then clears only the submitted basis', async () => {
        const passage = { ref: { kind: 'doc' as const, artifactId: 'notes', serverId: scope.serverId },
            revision: { headerVersion: 2, bodyVersion: 4 }, range: { start: 12, end: 18 }, quote: 'second' };
        writeDiscussionSessionDraft({ scope, address: newAddress, patch: { text: 'Please review', mentions: [], passage } });
        const first = await renderHook(() => useDiscussionDraft({ scope, address: newAddress }));
        expect(first.getCurrent().passage).toEqual(passage);
        let submission: DiscussionDraftSubmission | undefined;
        act(() => { submission = first.getCurrent().captureSubmittedCurrentness({ kind: 'create', creationLocalId: 'stable-thread', messageLocalId: 'stable-comment' }); });
        await first.unmount();
        const restored = await renderHook(() => useDiscussionDraft({ scope, address: newAddress }));
        expect(restored.getCurrent().prepareContent({ v: 1, parts: [{ t: 'text', text: 'Please review' }] }))
            .toEqual({ kind: 'doc_passage_comment', passage, content: { v: 1, parts: [{ t: 'text', text: 'Please review' }] } });
        expect(restored.getCurrent().pendingMutationAttempt).toMatchObject({ creationLocalId: 'stable-thread', messageLocalId: 'stable-comment' });
        await act(async () => { await restored.getCurrent().clearAfterObservedSuccess(submission!); });
        expect(restored.getCurrent().passage).toBeNull();
        expect(restored.getCurrent().text).toBe('');
        await restored.unmount();
    });

    it('restores the original uncertain submission after the synchronized draft changes, and purges only source material on refusal', async () => {
        const passage = { ref: { kind: 'doc' as const, artifactId: 'notes', serverId: scope.serverId },
            revision: { headerVersion: 1, bodyVersion: 1 }, range: { start: 0, end: 6 }, quote: 'secret' };
        writeDiscussionSessionDraft({ scope, address: newAddress, patch: { text: 'Original question', passage } });
        const first = await renderHook(() => useDiscussionDraft({ scope, address: newAddress }));
        act(() => { first.getCurrent().captureSubmittedCurrentness({ kind: 'create', creationLocalId: 'stable-thread', messageLocalId: 'stable-message' }); });
        act(() => { first.getCurrent().setText('Newer authored question'); first.getCurrent().setPassage({ ...passage, ref: { ...passage.ref, artifactId: 'other-doc' } }); });
        await first.unmount();
        const restored = await renderHook(() => useDiscussionDraft({ scope, address: newAddress }));
        expect(restored.getCurrent().submitted).toMatchObject({ attemptLocalId: 'stable-thread',
            content: { kind: 'doc_passage_comment', passage, content: { parts: [{ t: 'text', text: 'Original question' }] } } });
        await restored.unmount();
        await purgeSessionDraftPresentation({ scope, address: newAddress, fieldIds: ['passage', 'submission'] });
        const afterRefusal = await renderHook(() => useDiscussionDraft({ scope, address: newAddress }));
        expect(afterRefusal.getCurrent().passage).toBeNull();
        expect(afterRefusal.getCurrent().submitted).toBeNull();
        expect(afterRefusal.getCurrent().text).toBe('Newer authored question');
        await afterRefusal.unmount();
    });

    it('preserves typed participant identities after restoring and synchronizing a draft, then editing it', async () => {
        const mentions = [
            mention('happier.account', 'account:account-alex', 'Alex', 0),
            mention('happier.session', 'session:session-alex', 'Alex', alex.length + 1),
        ];
        writeDiscussionSessionDraft({ scope, address: existingAddress, patch: { text: `${alex} ${sessionAlex}`, mentions } });
        const first = await renderHook(() => useDiscussionDraft({ scope, address: existingAddress }));
        expect(first.getCurrent().mentions).toEqual(mentions);
        await first.unmount();
        const restored = await renderHook(() => useDiscussionDraft({ scope, address: existingAddress }));
        expect(restored.getCurrent().mentions).toEqual(mentions);
        act(() => writeDiscussionSessionDraft({ scope, address: existingAddress, patch: {
            text: `Ask ${sessionAlex}`, mentions: [mention('happier.session', 'session:session-alex', 'Alex', 4)],
        } }));
        await vi.waitFor(() => expect(restored.getCurrent().text).toBe(`Ask ${sessionAlex}`));
        act(() => restored.getCurrent().setText(`Please Ask ${sessionAlex}`));
        expect(restored.getCurrent().mentions).toEqual([mention('happier.session', 'session:session-alex', 'Alex', 11)]);
        expect(getSessionComposerDraftSnapshot(scope, existingAddress)?.composer.mentions.value).toEqual([
            mention('happier.session', 'session:session-alex', 'Alex', 11),
        ]);
        await restored.unmount();
    });

    it('projects one exact synchronized V2 draft and updates it through the repository owner', async () => {
        writeDiscussionSessionDraft({
            scope,
            address: newAddress,
            patch: {
                title: 'Release review',
                text: `Ask ${alex}`,
                mentions: [
                    mention('happier.account', 'account:account-alex', 'Alex', 4),
                    mention('happier.account', 'account:forged-outside', 'Outside', 999),
                ],
            },
        });

        const rendered = await renderHook(() => useDiscussionDraft({ scope, address: newAddress }));
        expect(rendered.getCurrent()).toMatchObject({
            title: 'Release review',
            text: `Ask ${alex}`,
            mentions: [mention('happier.account', 'account:account-alex', 'Alex', 4)],
            status: 'clean',
            conflict: null,
        });

        const draftBeforeWrite = rendered.getCurrent();
        act(() => {
            draftBeforeWrite.setComposer({
                text: `Ask ${alex} and ${bob}`,
                mentions: [
                    mention('happier.account', 'account:account-alex', 'Alex', 4),
                    mention('happier.account', 'account:account-bob', 'Bob', alex.length + 9),
                ],
            });
        });
        expect(draftBeforeWrite.captureSubmittedCurrentness()).toMatchObject({
            scope,
            address: newAddress,
            currentness: { address: newAddress },
        });
        await vi.waitFor(() => expect(rendered.getCurrent().text).toBe(`Ask ${alex} and ${bob}`));
        expect(rendered.getCurrent().mentions).toHaveLength(2);

        act(() => rendered.getCurrent().setText(`Ask @Bert and ${bob}`));
        await vi.waitFor(() => expect(rendered.getCurrent().text).toBe(`Ask @Bert and ${bob}`));
        expect(rendered.getCurrent().mentions).toEqual([
            mention('happier.account', 'account:account-bob', 'Bob', 14),
        ]);
        await rendered.unmount();
    });

    it('clears only the captured post fields after observed success and preserves a newer concurrent edit', async () => {
        writeDiscussionSessionDraft({
            scope,
            address: existingAddress,
            patch: {
                text: `Captured ${alex}`,
                mentions: [mention('happier.account', 'account:account-alex', 'Alex', 9)],
            },
        });
        const rendered = await renderHook(() => useDiscussionDraft({ scope, address: existingAddress }));
        const submitted = rendered.getCurrent().captureSubmittedCurrentness();

        act(() => {
            rendered.getCurrent().setComposer({
                text: `Newer ${alex} edit`,
                mentions: [mention('happier.account', 'account:account-alex', 'Alex', 6)],
            });
        });
        await act(async () => {
            await rendered.getCurrent().clearAfterObservedSuccess(submitted);
        });

        expect(getSessionComposerDraftSnapshot(scope, existingAddress)?.composer).toMatchObject({
            text: { value: `Newer ${alex} edit` },
            mentions: { value: [mention('happier.account', 'account:account-alex', 'Alex', 6)] },
        });
        await rendered.unmount();
    });

    it('restores and clears the same crash-stable post retry identity through the draft supplement', async () => {
        writeDiscussionSessionDraft({
            scope,
            address: existingAddress,
            patch: { text: 'Retry me', mentions: [] },
        });
        const first = await renderHook(() => useDiscussionDraft({ scope, address: existingAddress }));
        let submitted: DiscussionDraftSubmission | null = null;
        act(() => {
            submitted = first.getCurrent().captureSubmittedCurrentness({
                kind: 'post',
                discussionId: existingAddress.discussionId,
                localId: 'post-local-stable',
            });
        });
        await first.unmount();

        const restored = await renderHook(() => useDiscussionDraft({ scope, address: existingAddress }));
        expect(restored.getCurrent().pendingMutationAttempt).toMatchObject({
            kind: 'post',
            discussionId: existingAddress.discussionId,
            localId: 'post-local-stable',
            currentness: submitted!.currentness,
        });
        await act(async () => {
            await restored.getCurrent().clearAfterObservedSuccess(submitted!);
        });
        expect(restored.getCurrent().pendingMutationAttempt).toBeNull();
        await restored.unmount();
    });

    it('releases a refused retry identity while keeping the drafted text for a fresh attempt', async () => {
        writeDiscussionSessionDraft({
            scope,
            address: existingAddress,
            patch: { text: 'Refused once', mentions: [] },
        });
        const hook = await renderHook(() => useDiscussionDraft({ scope, address: existingAddress }));
        act(() => {
            hook.getCurrent().captureSubmittedCurrentness({
                kind: 'post',
                discussionId: existingAddress.discussionId,
                localId: 'post-local-refused',
            });
        });
        expect(hook.getCurrent().pendingMutationAttempt).not.toBeNull();

        act(() => {
            hook.getCurrent().releaseSubmittedAttempt();
        });

        expect(hook.getCurrent().pendingMutationAttempt).toBeNull();
        expect(hook.getCurrent().text).toBe('Refused once');
        await hook.unmount();
    });

    it('preserves a newer mention-only edit when accepted text is unchanged', async () => {
        writeDiscussionSessionDraft({
            scope,
            address: existingAddress,
            patch: { text: `Captured ${alex}`, mentions: [] },
        });
        const rendered = await renderHook(() => useDiscussionDraft({ scope, address: existingAddress }));
        const submitted = rendered.getCurrent().captureSubmittedCurrentness();

        act(() => {
            rendered.getCurrent().setMentions([mention('happier.account', 'account:account-alex', 'Alex', 9)]);
        });
        await act(async () => {
            await rendered.getCurrent().clearAfterObservedSuccess(submitted);
        });

        expect(getSessionComposerDraftSnapshot(scope, existingAddress)?.composer).toMatchObject({
            text: { value: `Captured ${alex}` },
            mentions: { value: [mention('happier.account', 'account:account-alex', 'Alex', 9)] },
        });
        await rendered.unmount();
    });

    it('preserves a newer text-only edit when accepted mentions are unchanged', async () => {
        writeDiscussionSessionDraft({
            scope,
            address: existingAddress,
            patch: { text: 'Captured text', mentions: [] },
        });
        const rendered = await renderHook(() => useDiscussionDraft({ scope, address: existingAddress }));
        const submitted = rendered.getCurrent().captureSubmittedCurrentness();

        act(() => {
            writeDiscussionSessionDraft({ scope, address: existingAddress, patch: { text: 'Newer text' } });
        });
        await act(async () => {
            await rendered.getCurrent().clearAfterObservedSuccess(submitted);
        });

        expect(getSessionComposerDraftSnapshot(scope, existingAddress)?.composer).toMatchObject({
            text: { value: 'Newer text' },
            mentions: { value: [] },
        });
        await rendered.unmount();
    });

    it('preserves a newer grouped composer edit and a newer title', async () => {
        writeDiscussionSessionDraft({
            scope,
            address: newAddress,
            patch: { title: 'Accepted title', text: `Captured ${alex}`, mentions: [] },
        });
        const rendered = await renderHook(() => useDiscussionDraft({ scope, address: newAddress }));
        const submitted = rendered.getCurrent().captureSubmittedCurrentness();

        act(() => {
            rendered.getCurrent().setTitle('Newer title');
            rendered.getCurrent().setMentions([mention('happier.account', 'account:account-alex', 'Alex', 9)]);
        });
        await act(async () => {
            await rendered.getCurrent().clearAfterObservedSuccess(submitted);
        });

        expect(getSessionDraftSnapshot(scope, newAddress)?.document).toMatchObject({
            title: { value: 'Newer title' },
            composer: {
                text: { value: `Captured ${alex}` },
                mentions: { value: [mention('happier.account', 'account:account-alex', 'Alex', 9)] },
            },
        });
        await rendered.unmount();
    });

    it('clears captured create fields together and lets the repository contract the empty draft', async () => {
        writeDiscussionSessionDraft({
            scope,
            address: newAddress,
            patch: {
                title: 'Captured title',
                text: 'Captured text',
                mentions: [],
            },
        });
        const rendered = await renderHook(() => useDiscussionDraft({ scope, address: newAddress }));
        const submitted = rendered.getCurrent().captureSubmittedCurrentness();
        let cleared = false;
        await act(async () => {
            cleared = await rendered.getCurrent().clearAfterObservedSuccess(submitted);
        });
        expect(cleared).toBe(true);

        expect(getSessionComposerDraftSnapshot(scope, newAddress)).toBeNull();
        await rendered.unmount();
    });

    it.each([
        ['create', newAddress] as const,
        ['post', existingAddress] as const,
    ])('retires the %s mutation attempt after observed success even when every captured field moved on', async (kind, address) => {
        writeDiscussionSessionDraft({
            scope,
            address,
            patch: { ...(kind === 'create' ? { title: 'Captured title' } : {}), text: 'Captured text', mentions: [] },
        });
        const rendered = await renderHook(() => useDiscussionDraft({ scope, address }));
        let submitted: DiscussionDraftSubmission | null = null;
        act(() => {
            submitted = rendered.getCurrent().captureSubmittedCurrentness(
                kind === 'create'
                    ? { kind: 'create', creationLocalId: 'create-local-stable', messageLocalId: 'create-message-stable' }
                    : { kind: 'post', discussionId: existingAddress.discussionId, localId: 'post-local-stable' },
            );
        });
        expect(rendered.getCurrent().pendingMutationAttempt).not.toBeNull();

        // Every captured field moves on while the mutation is in flight.
        act(() => {
            if (kind === 'create') rendered.getCurrent().setTitle('Newer title');
            rendered.getCurrent().setComposer({
                text: `Newer ${alex} text`,
                mentions: [mention('happier.account', 'account:account-alex', 'Alex', 6)],
            });
        });
        await act(async () => {
            await rendered.getCurrent().clearAfterObservedSuccess(submitted!);
        });

        expect(rendered.getCurrent().pendingMutationAttempt).toBeNull();
        await rendered.unmount();

        const remounted = await renderHook(() => useDiscussionDraft({ scope, address }));
        expect(remounted.getCurrent().pendingMutationAttempt).toBeNull();
        expect(remounted.getCurrent().text).toBe(`Newer ${alex} text`);
        expect(remounted.getCurrent().mentions).toEqual([mention('happier.account', 'account:account-alex', 'Alex', 6)]);
        if (kind === 'create') expect(remounted.getCurrent().title).toBe('Newer title');
        await remounted.unmount();
    });

    it('purges the local decrypted presentation when access is explicitly lost', async () => {
        writeDiscussionSessionDraft({
            scope,
            address: existingAddress,
            patch: { text: 'Private local draft', mentions: [] },
        });
        const rendered = await renderHook(() => useDiscussionDraft({ scope, address: existingAddress }));

        await act(async () => {
            await rendered.getCurrent().purgePresentation();
        });

        expect(getSessionComposerDraftSnapshot(scope, existingAddress)).toBeNull();
        await rendered.unmount();
    });
    it('seeds an empty new Discussion with an addressed request, and never replaces words already there', async () => {
        const seed = { scope, title: 'Reading desk isn’t ready', text: `${ana} Its machine is offline.`,
            mentions: [mention('happier.account', 'account:ana', 'Ana', 0)] } as const;
        expect(seedDiscussionDraft(seed)).toBe(true);
        const seeded = await renderHook(() => useDiscussionDraft({ scope, address: newAddress }));
        expect(seeded.getCurrent()).toMatchObject({ title: seed.title, text: seed.text, mentions: seed.mentions });
        await seeded.unmount();

        writeDiscussionSessionDraft({ scope, address: newAddress, patch: { title: '', text: 'My own unsent words', mentions: [] } });
        expect(seedDiscussionDraft(seed)).toBe(false);
        const kept = await renderHook(() => useDiscussionDraft({ scope, address: newAddress }));
        expect(kept.getCurrent().text).toBe('My own unsent words');
        await kept.unmount();
    });
});
