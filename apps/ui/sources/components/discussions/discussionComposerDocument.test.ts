import { describe, expect, it } from 'vitest';

import { DiscussionMessageContentV1Schema, readDiscussionMentionedParticipantIdsV1 } from '@happier-dev/protocol/discussions/content';
import { formatInlineReferenceTokenV1 } from '@happier-dev/protocol/runtime/input/inlineReferenceTokenV1';
import type { ComposerStructuredInputMention } from '@/components/sessions/agentInput/structuredInputMentions';

import {
    buildDiscussionAccountMentionPayload,
    buildDiscussionContent,
    buildDiscussionContentFromPendingText,
    buildDiscussionModelSlotMentionPayload,
    resolveDiscussionCreationTitle,
    prepareDiscussionContentForRecipients,
    readDiscussionContentPassage,
    readUnresolvedDiscussionMentionTokens,
} from './discussionComposerDocument';
import { projectDiscussionMessageReferences } from './discussionTimelineProjection';

function mention(payload: Readonly<{ kind: string; ref: string; label: string }>, start = 0):
    ComposerStructuredInputMention & Readonly<{ ref: string; label: string }> {
    const tokenText = formatInlineReferenceTokenV1(payload);
    return { ...payload, tokenText, start, end: start + tokenText.length };
}

describe('discussion composer document', () => {
    it('distinguishes unselected addressing from selected references, email and escaped @ text', () => {
        const selected = mention({ kind: 'happier.session', ref: 'session:reviewer', label: 'Selected @reviewer' });
        const text = `${selected.tokenText} ask @DOCS-JOURNEY3 and @"Other reviewer"; email a@b.example or write \\@decorator`;
        expect(readUnresolvedDiscussionMentionTokens(text, [selected])).toEqual(['@DOCS-JOURNEY3', '@"Other reviewer"']);
        expect(readUnresolvedDiscussionMentionTokens('Email reviewer@example.com and \\@decorator', [])).toEqual([]);
    });

    it('keeps authored attachment occurrences and emits one payload for every retained tray root', () => {
        const attachment = { kind: 'folder' as const, id: '093862e6-2d88-4dc2-9b29-3b365460f83c', name: 'Sources', entries: [], directories: ['empty'] };
        const token = formatInlineReferenceTokenV1({ ref: `attachment:${attachment.id}`, label: attachment.name });
        const text = `Review ${token} and ${token}`;
        expect(buildDiscussionContent(text, [], undefined, [attachment])).toEqual({ v: 1, parts: [
            { t: 'text', text }, { t: 'attachment', attachment },
        ] });
        expect(buildDiscussionContent('The chip was deleted, not the tray entry', [], undefined, [attachment]).parts.at(-1))
            .toEqual({ t: 'attachment', attachment });
        expect(buildDiscussionContent('', [], undefined, [attachment]).parts).toEqual([{ t: 'attachment', attachment }]);
    });
    it('retains a selected declared plugin reference through send and read without addressing its Session-shaped label', () => {
        const payload = { kind: 'happier.composerReference', ref: 'composerReference:issue-42', label: 'Reviewer',
            composerReference: { pluginId: 'acme.issues', localId: 'issues' }, composerReferenceTrigger: '@' as const };
        const selected = mention(payload);
        const reference = { ...payload, token: selected.tokenText };
        const content = buildDiscussionContent(`Review ${selected.tokenText}`, [{ ...selected, ...payload, start: 7, end: 7 + selected.end }]);
        expect(DiscussionMessageContentV1Schema.parse(content)).toEqual({ v: 1, parts: [
            { t: 'text', text: 'Review ' }, { t: 'reference', reference },
        ] });
        expect(readDiscussionMentionedParticipantIdsV1(content)).toEqual({ mentionedAccountIds: [], mentionedSessionIds: [] });
        expect(projectDiscussionMessageReferences(content).readableText).toBe('Review @Reviewer');
        expect(projectDiscussionMessageReferences(content).inline.get(payload.ref)).toMatchObject({ kind: payload.kind, label: payload.label });
        expect(buildDiscussionContent(selected.tokenText, [])).toEqual({ v: 1, parts: [{ t: 'text', text: selected.tokenText }] });
    });
    it('separates default recipient mentions from each other and the unchanged authored message', () => {
        const authored = buildDiscussionContent('Review this', []);
        const recipients = [{ kind: 'session' as const, sessionId: 'reviewer' }, { kind: 'account' as const, accountId: 'person' }];
        const content = prepareDiscussionContentForRecipients({ content: authored, recipients });
        expect(projectDiscussionMessageReferences(content, { session: () => 'Reviewer', account: () => 'Person' }).readableText)
            .toBe('@Reviewer @Person Review this');
        expect(readDiscussionMentionedParticipantIdsV1(content)).toEqual({ mentionedAccountIds: ['person'], mentionedSessionIds: ['reviewer'] });
        expect('parts' in content && content.parts.slice(-authored.parts.length)).toEqual(authored.parts);
    });
    it('uses chip defaults only without a typed mention or any explicit reply target', () => {
        const recipients = [{ kind: 'session' as const, sessionId: 'reviewer' }];
        const text = buildDiscussionContent('Please review', []);
        expect(prepareDiscussionContentForRecipients({ content: text, recipients })).toEqual({ v: 1, parts: [
            { t: 'mention', participant: recipients[0] }, { t: 'text', text: ' ' }, ...text.parts,
        ] });
        for (const ref of [buildDiscussionAccountMentionPayload('person', 'Same label'),
            { kind: 'happier.session', ref: 'session:explicit-reviewer', label: 'Same label' }]) {
            const token = mention(ref);
            const content = buildDiscussionContent(token.tokenText, [token]);
            expect(prepareDiscussionContentForRecipients({ content, recipients })).toBe(content);
        }
        const target = { kind: 'doc_passage' as const, doc: { ref: { kind: 'doc' as const, artifactId: 'notes', serverId: 'home' },
            revision: { headerVersion: 1, bodyVersion: 1 } } };
        expect(prepareDiscussionContentForRecipients({ content: text, recipients, replyTarget: target })).toBe(text);
        expect(() => prepareDiscussionContentForRecipients({ content: text, recipients: [recipients[0]!, recipients[0]!] })).toThrow();
    });
    it('submits inline Account and Session ranges directly as unchanged participant parts', () => {
        const account = mention(buildDiscussionAccountMentionPayload('same-id', 'Alex'));
        const session = mention({ kind: 'happier.session', ref: 'session:same-id', label: 'Alex' }, account.end + 1);
        const text = `${account.tokenText} ${session.tokenText}`;
        const content = buildDiscussionContentFromPendingText({ previousText: text, pendingText: `Ask ${text}`, mentions: [account, session] });
        expect(DiscussionMessageContentV1Schema.parse(content)).toEqual({ v: 1, parts: [
            { t: 'text', text: 'Ask ' },
            { t: 'mention', participant: { kind: 'account', accountId: 'same-id' } },
            { t: 'text', text: ' ' },
            { t: 'mention', participant: { kind: 'session', sessionId: 'same-id' } },
        ] });
        expect(readDiscussionMentionedParticipantIdsV1(content).mentionedAccountIds).toEqual(['same-id']);
        expect(readDiscussionMentionedParticipantIdsV1(buildDiscussionContent(session.tokenText, [{ ...session, start: 0, end: session.tokenText.length }]))
            .mentionedAccountIds).toEqual([]);
    });

    it('keeps an unstarted slot inert until its send-time owner resolves a Session', () => {
        const slot = mention(buildDiscussionModelSlotMentionPayload('saved-model-slot', 'Model'));
        expect(() => buildDiscussionContent(slot.tokenText, [slot])).toThrow('discussion_participant_start_required');
        expect(buildDiscussionContent(slot.tokenText, [slot], new Map([['saved-model-slot', 'started-session']]))).toEqual({ v: 1, parts: [
            { t: 'mention', participant: { kind: 'session', sessionId: 'started-session' } },
        ] });
    });

    it('does not infer identity from pasted inline tokens, a mismatched scheme or another kind', () => {
        const selected = mention(buildDiscussionAccountMentionPayload('account-a', 'Alex'));
        expect(buildDiscussionContent(selected.tokenText, [])).toEqual({ v: 1, parts: [{ t: 'text', text: selected.tokenText }] });
        const mismatched = buildDiscussionContent(selected.tokenText, [{ ...selected, ref: 'session:account-a' }]);
        expect(mismatched).toEqual({ v: 1, parts: [{ t: 'reference', reference: { kind: selected.kind,
            ref: 'session:account-a', label: selected.label, token: selected.tokenText } }] });
        expect(readDiscussionMentionedParticipantIdsV1(mismatched)).toEqual({ mentionedAccountIds: [], mentionedSessionIds: [] });
        const inert = buildDiscussionContent(selected.tokenText, [{ ...selected, kind: 'partner.account' }]);
        expect(inert).toEqual({ v: 1, parts: [{ t: 'reference', reference: { kind: 'partner.account',
            ref: selected.ref, label: selected.label, token: selected.tokenText } }] });
        expect(readDiscussionMentionedParticipantIdsV1(inert)).toEqual({ mentionedAccountIds: [], mentionedSessionIds: [] });
    });

    it('drops only the edited reference when reconciling a pending input', () => {
        const account = mention(buildDiscussionAccountMentionPayload('account-a', 'Alex'));
        const session = mention({ kind: 'happier.session', ref: 'session:session-b', label: 'Bob' }, account.end + 5);
        const text = `${account.tokenText} and ${session.tokenText}`;
        const edited = account.tokenText.replace('Alex', 'Alexa');
        const content = buildDiscussionContentFromPendingText({ previousText: text, pendingText: `${edited} and ${session.tokenText}`, mentions: [account, session] });
        expect(content).toEqual({ v: 1, parts: [
            { t: 'text', text: `${edited} and ` },
            { t: 'mention', participant: { kind: 'session', sessionId: 'session-b' } },
        ] });
        expect(readDiscussionMentionedParticipantIdsV1(content).mentionedAccountIds).toEqual([]);
    });

    it('preserves reference identity beside adjacent text and normalizes authored text to NFC', () => {
        const account = mention(buildDiscussionAccountMentionPayload('account-a', 'Alex'), 6);
        expect(buildDiscussionContent(`Cafe\u0301 ${account.tokenText}!`, [account])).toEqual({ v: 1, parts: [
            { t: 'text', text: 'Café ' },
            { t: 'mention', participant: { kind: 'account', accountId: 'account-a' } },
            { t: 'text', text: '!' },
        ] });
    });

    it('requires an exact current token range before authoring a mention part', () => {
        const account = mention(buildDiscussionAccountMentionPayload('account-a', 'Alex'));
        expect(buildDiscussionContent(account.tokenText, [{ ...account, end: account.end - 1 }])).toEqual({ v: 1, parts: [{ t: 'text', text: account.tokenText }] });
    });

    it('uses an explicit title or the first nonempty non-reference line', () => {
        const account = mention(buildDiscussionAccountMentionPayload('account-a', 'Alex'));
        expect(resolveDiscussionCreationTitle({ title: '  Release review  ', text: '' })).toBe('Release review');
        expect(resolveDiscussionCreationTitle({ title: '', text: `\n${account.tokenText} First line\nSecond line`, mentions: [{ ...account, start: 1, end: account.end + 1 }] })).toBe('First line');
        expect(resolveDiscussionCreationTitle({ title: '', text: account.tokenText, mentions: [account] })).toBeNull();
    });
    it('reads no passage from a Workflow result, which has no Doc target', () => {
        const result = DiscussionMessageContentV1Schema.parse({ kind: 'workflow_result', value: { verdict: 'ship' },
            summary: 'Ship it', source: { runId: 'run-1', invocationRecordId: 'invocation-1', invocationAttempt: '0' } });
        expect(readDiscussionContentPassage(result)).toBeNull();
    });
});
