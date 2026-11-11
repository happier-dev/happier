import * as React from 'react';
import type { DiscussionOpenedSummaryV1 } from '@happier-dev/protocol/discussions/actions';
import { HAPPIER_COLLECTION_ROW_METRICS } from '@happier-dev/plugin-ui/presentation';
import { describe, expect, it } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '@/components/settings/settingsViewTestHelpers';

installSettingsViewCommonModuleMocks({
    storage: async () => {
        const { createStorageModuleStub, createUseSettingMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({ useSetting: createUseSettingMock({ values: { avatarStyle: 'gradient', showFlavorIcons: false } }) });
    },
});

import { sessionCollaborationTranslations } from '@/text/translations/sessionCollaborationTranslations';
import { buildDiscussionRowAccessibilityLabel, buildDiscussionRowSubtitle, DiscussionRow, readDiscussionRowAccountAvatar, readDiscussionRowAccountAvatarUrl, resolveDiscussionRowGlyph, resolveDiscussionRowSummary } from '@/components/discussions/DiscussionRow';

const labels = {
    you: 'You',
    viaAgent: 'Via Agent',
    messages: (count: number) => `${count} messages`,
    unread: (count: number) => `${count} unread`,
    mentions: (count: number) => count === 1 ? '1 unread mention' : `${count} unread mentions`,
    onDoc: 'On a doc',
    openComments: (count: number) => `${count} open comments`,
    freshOpinions: (count: number) => `Fresh opinions · ${count} answers`,
    freshOpinionsSynthesis: (count: number) => `Fresh opinions · ${count} answers and a synthesis`,
    answerReviewSettled: 'Answer + review · settled',
};

function discussionFixture(): DiscussionOpenedSummaryV1 {
        return {
            id: 'many-unread', ownerAccountId: 'viewer', encryptionMode: 'plain', anchor: null,
            access: 'owner', keyReadiness: true, dataEncryptionKey: null, creationLocalId: null, title: 'Review',
            latestMessage: { id: 'message', localId: null, seq: 250, authorAccountId: 'author', accountActor: { v: 1, accountId: 'author', profile: null }, producerV1: null, createdAt: 1 },
            messageSeq: 250, lastReadSeq: 0, unreadCount: 250, unreadMentionCount: 0, recentAuthorAccountIds: [], archivedAt: null,
            capabilities: { postMessages: true, rename: true, archive: true, restore: false, askAgent: true, sendToSession: true, manageAccess: true, leave: false },
        };
}

describe('DiscussionRow presentation', () => {
    it('gives a glyph, one face and two faces the Session rows\' leading slot, so every title in the column starts on their edge', async () => {
        const base = discussionFixture();
        const actor = (accountId: string) => ({ ...base.latestMessage.accountActor!, accountId });
        const rows: readonly DiscussionOpenedSummaryV1[] = [
            { ...base, id: 'glyph', participantAccounts: [actor('viewer')] },
            { ...base, id: 'one', recentAuthorAccountIds: ['author'] },
            { ...base, id: 'two', participantAccounts: [actor('viewer'), actor('author')] },
        ];
        const widths: unknown[] = [];
        for (const discussion of rows) {
            const screen = await renderScreen(React.createElement(DiscussionRow, { discussion, viewerAccountId: 'viewer', onOpenDiscussion: () => {},
                geometry: 'column', attentionReason: null, attentionType: null }));
            widths.push([screen.findByTestId(`session-discussion-row-recent-authors-${discussion.id}`)!.props.style].flat(4).filter(Boolean)
                .reduce((width: unknown, style: { width?: unknown }) => style.width ?? width, undefined));
            await screen.unmount();
        }
        const slot = HAPPIER_COLLECTION_ROW_METRICS.identity.compact.slotSize;
        expect(widths).toEqual([slot, slot, slot]);
    });

    it('caps the unread badge while announcing the complete count', async () => {
        const discussion = discussionFixture();
        const screen = await renderScreen(React.createElement(DiscussionRow, { discussion, viewerAccountId: 'viewer', onOpenDiscussion: () => {},
            attentionReason: null, attentionType: null }));
        const badge = screen.findByTestId('session-discussion-row-unread-many-unread');
        expect(badge?.findAll((node) => node.children.includes('99+')).length).toBeGreaterThan(0);
        expect(screen.findByTestId('session-discussion-row-many-unread')?.props.accessibilityLabel).toContain('250');
    });
    it.each(['pane', 'column'] as const)('keeps the admitted approval control accessible outside %s row navigation', async (geometry) => {
        const screen = await renderScreen(React.createElement(DiscussionRow, { discussion: discussionFixture(), viewerAccountId: 'viewer',
            onOpenDiscussion: () => {}, geometry, serverId: 'approval-home', approvalArtifactId: 'approval-artifact',
            attentionReason: 'approval_pending', attentionType: 'approval' }));
        const slot = screen.findHostByTestId('discussion-request-peek:many-unread');
        expect(slot).not.toBeNull();
        expect(screen.findByTestId('discussion-request-peek:many-unread:peek')).toBeNull();
        for (let node = slot?.parent; node; node = node.parent) {
            if (typeof node.type !== 'string') continue;
            expect(node.props.testID).not.toBe('session-discussion-row-many-unread');
            expect(node.props.importantForAccessibility).not.toBe('no-hide-descendants');
        }
    });
    it('names who wrote last and how long the conversation is, never an unread count in the subtitle', () => {
        expect(buildDiscussionRowSubtitle({
            latestAuthor: 'Ben',
            latestIsViewer: false,
            producedByAgent: false,
            messageCount: 14,
            labels,
        })).toEqual(['Ben', '14 messages']);
    });

    it('keeps an Agent message on its Session speaker instead of calling the executing Account You', () => {
        expect(buildDiscussionRowSubtitle({
            latestAuthor: 'Session participant',
            latestIsViewer: false,
            producedByAgent: true,
            messageCount: 6,
            labels,
        })).toEqual(['Session participant', 'Via Agent', '6 messages']);
    });

    it('omits an unknown latest author rather than inventing one', () => {
        expect(buildDiscussionRowSubtitle({
            latestAuthor: null,
            latestIsViewer: false,
            producedByAgent: false,
            messageCount: 1,
            labels,
        })).toEqual(['1 messages']);
    });

    it('never renders a retained former-member avatar in a row face', () => {
        const discussion = { ...discussionFixture(), latestMessage: { ...discussionFixture().latestMessage,
            accountActor: { v: 1 as const, accountId: 'author', accessibility: 'former' as const, profile: {
                name: 'Retained Person', firstName: 'Retained', lastName: 'Person', username: 'retained',
                avatarUrl: 'https://discussion-row.test/retained.png',
            } } } };
        expect(readDiscussionRowAccountAvatarUrl(discussion, 'author', 'viewer')).toBeNull();
        expect(readDiscussionRowAccountAvatar(discussion.latestMessage.accountActor, 'author', 'viewer')).toEqual({
            id: 'former-member',
            imageUrl: null,
        });
        expect(readDiscussionRowAccountAvatarUrl({ ...discussion, latestMessage: { ...discussion.latestMessage,
            accountActor: { ...discussion.latestMessage.accountActor!, accessibility: 'current' } } }, 'author', 'viewer'))
            .toBe('https://discussion-row.test/retained.png');
    });

    it('speaks the mention and unread counts the badges show, then the time', () => {
        expect(buildDiscussionRowAccessibilityLabel({
            title: 'Relay retry plan',
            subtitle: ['Ben', '14 messages'],
            unreadCount: 2,
            unreadMentionCount: 1,
            relativeTime: '2m',
            labels,
        })).toBe('Relay retry plan. 1 unread mention, 2 unread, Ben, 14 messages, 2m');
        expect(buildDiscussionRowAccessibilityLabel({
            title: 'Release notes wording',
            subtitle: ['Mei', '9 messages'],
            unreadCount: 0,
            unreadMentionCount: 0,
            relativeTime: '1h',
            labels,
        })).toBe('Release notes wording. Mei, 9 messages, 1h');
    });

    it('provides a semantic unread-mention label for every supported locale', () => {
        for (const translations of Object.values(sessionCollaborationTranslations)) {
            const label = translations.discussion.unreadMentionCount({ count: 2 });
            expect(label).toContain('2');
            expect(label).not.toBe('@2');
        }
    });

    it('marks an agent-only Discussion by what it is about, not by the viewer\'s own face (lab T2-L)', () => {
        const base = { participantAccounts: [{ v: 1 as const, accountId: 'viewer', profile: null }] };
        expect(resolveDiscussionRowGlyph({ ...base, anchor: { kind: 'session', sessionId: 's', messageId: 'm' } } as never, 'viewer')).toBe('scales');
        expect(resolveDiscussionRowGlyph({ ...base, anchor: { kind: 'doc', doc: {} } } as never, 'viewer')).toBe('file-text');
        expect(resolveDiscussionRowGlyph({ ...base, anchor: null } as never, 'viewer')).toBe('robot');
        // Anyone else in it keeps the faces.
        expect(resolveDiscussionRowGlyph({ participantAccounts: [...base.participantAccounts, { v: 1, accountId: 'mei', profile: null }],
            anchor: null } as never, 'viewer')).toBeNull();
        // Who is in it is unknown: faces, never a guess.
        expect(resolveDiscussionRowGlyph({ anchor: null } as never, 'viewer')).toBeNull();
    });
});

describe('DiscussionRow summary line (lab T2-L)', () => {
    const round = (pattern: 'fresh_opinions' | 'answer_and_review', answerCount: number, synthesized: boolean, settled: boolean) =>
        ({ runId: 'run', pattern, answerCount, synthesized, settled });
    const doc = { kind: 'doc', doc: {} } as never;

    it('says what a round produced, from the summary facts alone', () => {
        expect(resolveDiscussionRowSummary({ anchor: null, roundOutcomeV1: round('fresh_opinions', 3, true, false) }, labels))
            .toBe('Fresh opinions · 3 answers and a synthesis');
        expect(resolveDiscussionRowSummary({ anchor: null, roundOutcomeV1: round('fresh_opinions', 2, false, false) }, labels))
            .toBe('Fresh opinions · 2 answers');
        expect(resolveDiscussionRowSummary({ anchor: null, roundOutcomeV1: round('answer_and_review', 1, false, true) }, labels))
            .toBe('Answer + review · settled');
    });

    it('keeps the conversation for a pending, unsettled or unknown round', () => {
        expect(resolveDiscussionRowSummary({ anchor: null, roundOutcomeV1: round('fresh_opinions', 0, false, false) }, labels)).toBeNull();
        expect(resolveDiscussionRowSummary({ anchor: null, roundOutcomeV1: round('answer_and_review', 1, false, false) }, labels)).toBeNull();
        expect(resolveDiscussionRowSummary({ anchor: null, roundOutcomeV1: null }, labels)).toBeNull();
        expect(resolveDiscussionRowSummary({ anchor: null }, labels)).toBeNull();
    });

    it('counts open comments only on a Doc, and an absent or empty count is not a summary', () => {
        expect(resolveDiscussionRowSummary({ anchor: doc, openCommentCount: 3 }, labels)).toBe('On a doc · 3 open comments');
        expect(resolveDiscussionRowSummary({ anchor: doc, openCommentCount: 0 }, labels)).toBeNull();
        expect(resolveDiscussionRowSummary({ anchor: doc, openCommentCount: null }, labels)).toBeNull();
        expect(resolveDiscussionRowSummary({ anchor: null, openCommentCount: 3 }, labels)).toBeNull();
    });

    it('prefers a round outcome over a Doc comment count', () => {
        expect(resolveDiscussionRowSummary({ anchor: doc, openCommentCount: 3, roundOutcomeV1: round('answer_and_review', 1, false, true) }, labels))
            .toBe('Answer + review · settled');
    });

    it('is translated in every locale with its count', () => {
        for (const translations of Object.values(sessionCollaborationTranslations)) {
            const d = translations.discussion;
            expect(d.rowFreshOpinions({ count: 3 })).toContain('3');
            expect(d.rowFreshOpinionsSynthesis({ count: 3 }).length).toBeGreaterThan(d.rowFreshOpinions({ count: 3 }).length);
            expect(d.rowOpenComments({ count: 3 })).toContain('3');
            expect(d.rowAnswerReviewSettled.length).toBeGreaterThan(0);
        }
    });

    async function renderColumn(discussion: DiscussionOpenedSummaryV1, factsOverride?: Pick<React.ComponentProps<typeof DiscussionRow>, 'attentionReason' | 'attentionType'>) {
        const screen = await renderScreen(React.createElement(DiscussionRow, { discussion, viewerAccountId: 'viewer', onOpenDiscussion: () => {},
            geometry: 'column', ...(factsOverride ?? { attentionReason: null, attentionType: null }) }));
        const flat = (id: string) => JSON.stringify(screen.findByTestId(id)?.props.children ?? '');
        return { screen, subtitle: flat(`session-discussion-row-subtitle-${discussion.id}`) };
    }

    it('shows the summary in the column row, and the attention word before it', async () => {
        const base = { ...discussionFixture(), unreadCount: 0, roundOutcomeV1: round('fresh_opinions', 3, true, false) };
        // The harness's `t` echoes keys with their params; the wording itself is covered per locale above.
        expect((await renderColumn(base)).subtitle).toContain('rowFreshOpinionsSynthesis(count=3)');
        const attention = await renderColumn(base, { attentionReason: 'approval_pending', attentionType: 'approval' });
        expect(attention.subtitle).not.toContain('rowFreshOpinions');
        expect(attention.screen.findByTestId('session-discussion-row-many-unread')?.props.accessibilityLabel).toContain('rowFreshOpinionsSynthesis(count=3)');
    });

    it('falls back to the last message when a Doc has no open comments (an archived Discussion projects zero)', async () => {
        const archived = { ...discussionFixture(), unreadCount: 0, anchor: { kind: 'doc', doc: {} } as never, openCommentCount: 0, archivedAt: 5 };
        expect((await renderColumn(archived)).subtitle).not.toContain('open comments');
        const restored = { ...archived, archivedAt: null, openCommentCount: 3 };
        const shown = (await renderColumn(restored)).subtitle;
        expect(shown).toContain('rowOnDoc');
        expect(shown).toContain('rowOpenComments(count=3)');
    });

    it('labels a retained-profile mention as a former member from its explicit relationship fact', async () => {
        const former = { v: 1 as const, accountId: 'former', accessibility: 'former' as const,
            profile: { name: 'Alex Person', firstName: 'Alex', lastName: 'Person', username: 'alex', avatarUrl: null } };
        const discussion = { ...discussionFixture(), participantAccounts: [former], latestMessage: {
            ...discussionFixture().latestMessage,
            content: { v: 1 as const, parts: [
                { t: 'text' as const, text: 'Ask ' },
                { t: 'mention' as const, participant: { kind: 'account' as const, accountId: former.accountId } },
            ] },
        } };

        const { subtitle } = await renderColumn(discussion);

        expect(subtitle).toContain('message.accountActorFormerMember');
        expect(subtitle).not.toContain('Alex Person');
    });
});
