import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());

import { createSessionFixture, createSessionViewerFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { buildSessionListServerScopedRowKey } from '@/sync/domains/session/listing/sessionListKeyNormalization';
import { readSessionWorkStatusFacts } from '@/components/work/status/sessionWorkStatusFacts';
import { resolveWorkStatusTone } from '@/components/work/status/resolveWorkStatusTone';
import { buildDiscussionListAttention } from './buildDiscussionListAttention';

const NOW = 1_700_000_000_000;
const scope = { serverId: 'home-a', accountId: 'account-a' };

describe('Discussion member Session attention', () => {
    it.each(['permission_required', 'user_action_required'] as const)('carries the member Session owner’s %s through the Discussion status and withdraws it when answered', reason => {
        const member = buildSessionListRenderableFromSession(createSessionFixture({
            id: 'member', serverId: scope.serverId, active: true, activeAt: NOW,
            viewer: createSessionViewerFixture({ attention: { needsAttention: true, reasons: [reason], primary: reason, presentation: 'full' } }),
        }));
        const input = { scope, artifactScope: scope, artifactsLoaded: true, approvalEntries: [],
            items: [{ id: 'discussion', unreadMentionCount: 0, participantSessionIds: ['member'] },
                { id: 'unrelated', unreadMentionCount: 0, participantSessionIds: ['other'] }],
            sessionRows: new Map([[buildSessionListServerScopedRowKey(member.serverId, member.id)!, member]]), nowMs: NOW };
        const rows = buildDiscussionListAttention(input);
        const sessionStatus = resolveWorkStatusTone({ kind: 'session', facts: readSessionWorkStatusFacts(member, NOW) });
        expect(resolveWorkStatusTone({ kind: 'discussion', facts: rows[0]! }))
            .toMatchObject({ bucket: 'needs_you', attentionType: sessionStatus.attentionType, word: sessionStatus.word });
        expect(rows[0]?.waitingSessionId).toBe(member.id);
        expect(rows[1]?.attentionType).toBeNull();
        expect(buildDiscussionListAttention(input, rows)).toBe(rows);
        const answered = { ...member, viewer: createSessionViewerFixture() };
        expect(buildDiscussionListAttention({ ...input, sessionRows: new Map([[buildSessionListServerScopedRowKey(member.serverId, member.id)!, answered]]) }, rows)[0])
            .toMatchObject({ attentionReason: null, attentionType: null, waitingSessionId: null });
    });

    it('keeps a member’s unread news out of Needs you and does not borrow another Home’s Session', () => {
        const member = buildSessionListRenderableFromSession(createSessionFixture({ id: 'member', serverId: 'other-home',
            viewer: createSessionViewerFixture({ attention: { needsAttention: true, reasons: ['permission_required'], primary: 'permission_required', presentation: 'full' } }),
        }));
        const input = { scope, artifactScope: scope, artifactsLoaded: true, approvalEntries: [],
            items: [{ id: 'discussion', unreadMentionCount: 0, participantSessionIds: ['member'] }],
            sessionRows: new Map([[buildSessionListServerScopedRowKey(member.serverId, member.id)!, member]]), nowMs: NOW };
        expect(buildDiscussionListAttention(input)[0]?.attentionType).toBeNull();
        const unread = { ...member, serverId: scope.serverId,
            viewer: createSessionViewerFixture({ attention: { needsAttention: true, reasons: ['unread'], primary: 'unread', presentation: 'full' } }) };
        expect(buildDiscussionListAttention({ ...input, sessionRows: new Map([[buildSessionListServerScopedRowKey(unread.serverId, unread.id)!, unread]]) })[0]?.attentionType).toBeNull();
    });
});
