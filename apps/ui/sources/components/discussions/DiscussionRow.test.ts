import * as React from 'react';
import type { DiscussionOpenedSummaryV1 } from '@happier-dev/protocol';
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
import { buildDiscussionRowAccessibilityLabel, buildDiscussionRowSubtitle, DiscussionRow, readDiscussionRowAccountAvatar, readDiscussionRowAccountAvatarUrl, resolveDiscussionRowGlyph } from '@/components/discussions/DiscussionRow';

const labels = {
    you: 'You',
    viaAgent: 'Via Agent',
    messages: (count: number) => `${count} messages`,
    unread: (count: number) => `${count} unread`,
    mentions: (count: number) => count === 1 ? '1 unread mention' : `${count} unread mentions`,
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
    it('caps the unread badge while announcing the complete count', async () => {
        const discussion = discussionFixture();
        const screen = await renderScreen(React.createElement(DiscussionRow, { discussion, viewerAccountId: 'viewer', onPress: () => {} }));
        const badge = screen.findByTestId('session-discussion-row-unread-many-unread');
        expect(badge?.findAll((node) => node.children.includes('99+')).length).toBeGreaterThan(0);
        expect(screen.findByTestId('session-discussion-row-many-unread')?.props.accessibilityLabel).toContain('250');
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

    it('says You for the viewer’s own last message and keeps agent provenance', () => {
        expect(buildDiscussionRowSubtitle({
            latestAuthor: 'Alice',
            latestIsViewer: true,
            producedByAgent: true,
            messageCount: 6,
            labels,
        })).toEqual(['You', 'Via Agent', '6 messages']);
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
