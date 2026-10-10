import { expect, it } from 'vitest';
import { SessionListQueryResponseV1Schema, projectSessionOwnerCompatibilityViewV1 } from '@happier-dev/protocol';
import { createPlainSessionCurrentProjectionRecordFixture, createSessionFixture, createSessionOwnerViewerFixture } from './sessionFixtures';

it('preserves private launch profile identity through the real owner metadata envelope', () => {
    const metadata = { ...createSessionFixture().metadata!, profileId: 'work' };
    const row = createPlainSessionCurrentProjectionRecordFixture({ metadata });
    if (row.ownerMetadata?.t !== 'plain') throw new Error('Expected plain owner fixture');
    const view = projectSessionOwnerCompatibilityViewV1({ sharedMetadata: JSON.parse(row.metadata), ownerMetadata: row.ownerMetadata.v });
    expect(view.profileId).toBe('work');
    expect(JSON.parse(row.metadata)).not.toHaveProperty('profileId');
});

it('keeps an owner without a read row quiet and derives unread only from an explicit viewer frontier', () => {
    const session = createSessionFixture({ seq: 4 });
    const quiet = createSessionOwnerViewerFixture(session);
    expect(quiet.readState).toEqual({ state: 'not_started' });
    expect(quiet.attention.needsAttention).toBe(false);
    const unread = createSessionOwnerViewerFixture({ ...session, lastViewedSessionSeq: 2, unreadSince: 3 });
    expect(unread.readState).toEqual({ state: 'tracking', lastViewedSessionSeq: 2, unreadSince: 3 });
    expect(unread.attention.reasons).toContain('unread');
    const page = SessionListQueryResponseV1Schema.parse({ sessions: [{
        ...createPlainSessionCurrentProjectionRecordFixture({ seq: session.seq }), viewer: unread,
    }], nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false });
    expect(page.sessions[0]?.viewer).toEqual(unread);
});
