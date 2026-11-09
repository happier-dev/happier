import { describe, expect, it } from 'vitest';

import type { DiscussionOpenedSummaryV1 } from '@happier-dev/protocol/discussions/actions';

import {
  buildDiscussionActivityItems,
  buildDiscussionColumnItems,
  discussionActivityItemKey,
} from '@/components/discussions/discussionActivityItems';

function discussion(
  id: string,
  anchorSessionId: string | null = null,
): DiscussionOpenedSummaryV1 {
  return {
    id,
    ownerAccountId: 'account-1',
    encryptionMode: 'plain',
    anchor: anchorSessionId
      ? { kind: 'session', sessionId: anchorSessionId }
      : null,
    access: 'owner',
    keyReadiness: true,
    dataEncryptionKey: null,
    creationLocalId: null,
    title: `Discussion ${id}`,
    latestMessage: {
      id: `${id}-m1`,
      localId: null,
      seq: 1,
      authorAccountId: 'account-1',
      accountActor: { v: 1, accountId: 'account-1', profile: null },
      producerV1: null,
      createdAt: 1_700_000_000_000,
    },
    messageSeq: 1,
    lastReadSeq: null,
    unreadCount: 0,
    unreadMentionCount: 0,
    recentAuthorAccountIds: ['account-1'],
    archivedAt: null,
    capabilities: {
      postMessages: true,
      rename: true,
      archive: true,
      restore: false,
      askAgent: true,
      sendToSession: true,
      manageAccess: true,
      leave: false,
    },
  };
}

describe('buildDiscussionActivityItems', () => {
  it('keeps Home discussions independent and selects Session links only from their server anchor', () => {
    const discussions = [
      discussion('standalone'),
      discussion('here', 'session-1'),
      discussion('elsewhere', 'session-2'),
    ];
    const home = buildDiscussionActivityItems({
      discussions,
      humanListPending: false,
    });
    const people = buildDiscussionActivityItems({
      discussions,
      humanListPending: false,
      anchor: { kind: 'session', sessionId: 'session-1' },
    });
    expect(
      home
        .filter((item) => item.kind === 'human_discussion')
        .map((item) => item.discussion.id),
    ).toEqual(['standalone', 'here', 'elsewhere']);
    expect(
      people
        .filter((item) => item.kind === 'human_discussion')
        .map((item) => item.discussion.id),
    ).toEqual(['here']);
  });

  it('lists only conversations with people: Agent conversations live in the Agents tab (A3)', () => {
    const items = buildDiscussionActivityItems({
      discussions: [discussion('d1'), discussion('d2')],
      humanListPending: false,
    });

    expect(items.map((item) => item.kind)).toEqual([
      'human_section',
      'human_discussion',
      'human_discussion',
    ]);
  });

  it('reserves the rows while the first read is pending and invites only once it settled empty', () => {
    const pending = buildDiscussionActivityItems({
      discussions: [],
      humanListPending: true,
    });
    expect(pending.map((item) => item.kind)).toEqual([
      'human_section',
      'human_pending',
    ]);

    const settled = buildDiscussionActivityItems({
      discussions: [],
      humanListPending: false,
    });
    expect(settled.map((item) => item.kind)).toEqual([
      'human_section',
      'human_empty',
    ]);
  });

  it('gives every item a stable distinct list key', () => {
    const items = buildDiscussionActivityItems({
      discussions: [discussion('d1'), discussion('d2')],
      humanListPending: false,
    });
    const keys = items.map(discussionActivityItemKey);

    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain('discussion:d1');
  });
});

describe('buildDiscussionColumnItems', () => {
  const now = new Date(2026, 9, 19, 15, 0, 0);
  const at = (
    id: string,
    createdAt: number,
    mentioned = false,
  ): DiscussionOpenedSummaryV1 => {
    const base = discussion(id);
    return {
      ...base,
      latestMessage: { ...base.latestMessage, createdAt },
      unreadCount: mentioned ? 2 : 0,
      unreadMentionCount: mentioned ? 1 : 0,
    };
  };

  it('keeps unread mentions in recency groups, preserving the repository order inside each group', () => {
    const today = new Date(2026, 9, 19, 9, 0, 0).getTime();
    const thisWeek = new Date(2026, 9, 14, 12, 0, 0).getTime();
    const earlier = new Date(2026, 9, 12, 23, 0, 0).getTime();
    const items = buildDiscussionColumnItems({
      discussions: [
        at('a', today),
        at('b', thisWeek, true),
        at('c', earlier),
        at('d', today),
      ],
      humanListPending: false,
      now,
    });
    expect(
      items.map((item) =>
        item.kind === 'recency_group'
          ? item.group
          : item.kind === 'human_discussion'
            ? item.discussion.id
            : item.kind,
      ),
    ).toEqual(['today', 'a', 'd', 'this_week', 'b', 'earlier', 'c']);
    expect(new Set(items.map(discussionActivityItemKey)).size).toBe(
      items.length,
    );
  });

  it('keeps an admitted mention out of Needs you while an approval remains actionable', () => {
    const today = new Date(2026, 9, 19, 9, 0, 0).getTime();
    const items = buildDiscussionColumnItems({
      discussions: [at('mention', today, true), at('approval', today)],
      humanListPending: false,
      now,
      attention: new Map([['mention', { attentionType: 'mention' as const }], ['approval', { attentionType: 'approval' as const }]]),
    });
    expect(items.map(item => item.kind === 'recency_group' ? item.group
      : item.kind === 'human_discussion' ? item.discussion.id : item.kind))
      .toEqual(['needs_you', 'approval', 'today', 'mention']);
  });

  it("leads with a Discussion waiting on the viewer's approval or draft even without an unread mention", () => {
    const today = new Date(2026, 9, 19, 9, 0, 0).getTime();
    const items = buildDiscussionColumnItems({
      discussions: [at('a', today), at('b', today), at('c', today)],
      humanListPending: false,
      now,
      attention: new Map([
        ['b', { attentionType: 'approval' as const }],
        ['c', { attentionType: 'approval' as const }],
        ['a', { attentionType: null }],
      ]),
    });
    expect(
      items.map((item) =>
        item.kind === 'recency_group'
          ? item.group
          : item.kind === 'human_discussion'
            ? item.discussion.id
            : item.kind,
      ),
    ).toEqual(['needs_you', 'b', 'c', 'today', 'a']);
  });

  it('reserves rows while the first read is pending and says empty only once it settled', () => {
    expect(
      buildDiscussionColumnItems({
        discussions: [],
        humanListPending: true,
        now,
      }).map((item) => item.kind),
    ).toEqual(['human_pending']);
    expect(
      buildDiscussionColumnItems({
        discussions: [],
        humanListPending: false,
        now,
      }).map((item) => item.kind),
    ).toEqual(['human_empty']);
  });
});
