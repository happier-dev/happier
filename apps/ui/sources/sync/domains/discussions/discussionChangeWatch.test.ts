import { afterEach, describe, expect, it, vi } from 'vitest';

import { publishMountedDiscussionChanges, watchMountedDiscussions } from './discussionChangeWatch';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';

afterEach(() => {
    vi.clearAllMocks();
});

describe('mounted Discussion AccountChange watch', () => {
    it('revalidates only live matching snapshots without duplicating detailed or unrelated wakes', () => {
        const onSnapshotInvalidated = vi.fn();
        const onInvalidated = vi.fn();
        const watch = watchMountedDiscussions({ address: { serverId: 'server-a' },
            scope: { serverId: 'server-a', accountId: 'account-a' }, onInvalidated, onSnapshotInvalidated });
        try {
            publishHomeAccountChange('server-b', undefined, { source: 'catch-up-pending' });
            publishHomeAccountChange('server-a', ['session-a'], { source: 'socket', changeKinds: ['session'] });
            publishHomeAccountChange('server-a', ['discussion-a'], { source: 'catch-up-pending', changeKinds: ['discussion'] });
            publishHomeAccountChange('server-a', ['discussion-a'], { feedPageConsumed: true, changeKinds: ['discussion'] });
            expect(onSnapshotInvalidated).not.toHaveBeenCalled();
            publishHomeAccountChange('server-a', undefined, { source: 'catch-up-pending' });
            expect(onSnapshotInvalidated).toHaveBeenCalledTimes(1);
            publishHomeAccountChange('server-a', undefined, { source: 'snapshot' });
            expect(onSnapshotInvalidated).toHaveBeenCalledTimes(2);
            expect(onInvalidated).not.toHaveBeenCalled();
            watch.dispose();
            publishHomeAccountChange('server-a', undefined, { source: 'catch-up-pending' });
            publishHomeAccountChange('server-a', undefined, { source: 'snapshot' });
            expect(onSnapshotInvalidated).toHaveBeenCalledTimes(2);
        } finally { watch.dispose(); }
    });

    it('distinguishes only a validated own-Account readState-only hint, never a mixed or malformed hint', () => {
        const onInvalidated = vi.fn();
        const watch = watchMountedDiscussions({ address: { serverId: 'server-a' },
            scope: { serverId: 'server-a', accountId: 'account-a' }, onInvalidated });
        try {
            publishMountedDiscussionChanges({ serverId: 'server-a', accountId: 'account-b', changes: [{
                cursor: 1, kind: 'discussion', entityId: 'foreign', changedAt: 1,
                hint: { v: 1, discussions: true, changes: { readState: true } },
            }] });
            expect(onInvalidated).not.toHaveBeenCalled();
            publishMountedDiscussionChanges({ serverId: 'server-a', accountId: 'account-a', changes: [
                { cursor: 2, kind: 'discussion', entityId: 'read', changedAt: 2,
                    hint: { v: 1, discussions: true, changes: { readState: true } } },
                { cursor: 3, kind: 'discussion', entityId: 'mixed', changedAt: 3,
                    hint: { v: 1, discussions: true, changes: { readState: true, resource: true } } },
                { cursor: 4, kind: 'discussion', entityId: 'malformed', changedAt: 4,
                    hint: { v: 1, discussions: true, changes: { readState: true, unexpected: true } } },
                { cursor: 5, kind: 'discussion', entityId: 'repeated', changedAt: 5,
                    hint: { v: 1, discussions: true, changes: { readState: true } } },
                { cursor: 6, kind: 'discussion', entityId: 'repeated', changedAt: 6,
                    hint: { v: 1, discussions: true, changes: { resource: true } } },
            ] });
            expect(onInvalidated).toHaveBeenCalledExactlyOnceWith(['read', 'mixed', 'malformed', 'repeated'],
                new Map([['read', 2], ['mixed', 3], ['malformed', 4], ['repeated', 6]]), new Set(['read']));
        } finally { watch.dispose(); }
    });

    it('invalidates Home Discussions without any Session change and isolates the captured Account', () => {
        const onInvalidated = vi.fn();
        const watch = watchMountedDiscussions({
            address: { serverId: 'server-a' },
            scope: { serverId: 'server-a', accountId: 'account-a' },
            onInvalidated,
        });
        publishMountedDiscussionChanges({
            serverId: 'server-a', accountId: 'account-b',
            changes: [{ cursor: 1, kind: 'discussion', entityId: 'discussion-a', changedAt: 1 }],
        });
        expect(onInvalidated).not.toHaveBeenCalled();
        publishMountedDiscussionChanges({
            serverId: 'server-a', accountId: 'account-a',
            changes: [{ cursor: 2, kind: 'discussion', entityId: 'discussion-a', changedAt: 2 }],
        });
        expect(onInvalidated).toHaveBeenCalledOnce();
        expect(onInvalidated).toHaveBeenLastCalledWith(['discussion-a'], new Map([['discussion-a', 2]]));
        watch.dispose();
    });

    it('wakes only the captured Home and Account for coalesced Discussion changes', async () => {
        const onFirstInvalidated = vi.fn();
        const onSecondHomeInvalidated = vi.fn();
        const onSecondSessionInvalidated = vi.fn();

        const first = watchMountedDiscussions({
            scope: { serverId: 'server-a', accountId: 'account-a' },
            address: { serverId: 'server-a' },
            onInvalidated: onFirstInvalidated,
        });
        const secondHome = watchMountedDiscussions({
            scope: { serverId: 'server-b', accountId: 'account-a' },
            address: { serverId: 'server-b' },
            onInvalidated: onSecondHomeInvalidated,
        });
        const secondSession = watchMountedDiscussions({
            scope: { serverId: 'server-a', accountId: 'account-b' },
            address: { serverId: 'server-a' },
            onInvalidated: onSecondSessionInvalidated,
        });

        publishMountedDiscussionChanges({
            serverId: 'server-a',
            accountId: 'account-a',
            changes: [{
                cursor: 1,
                kind: 'discussion',
                entityId: 'same-session',
                changedAt: 1,
                hint: { unrelatedSessionProjection: true },
            }],
        });

        expect(onFirstInvalidated).toHaveBeenCalledOnce();
        expect(onSecondHomeInvalidated).not.toHaveBeenCalled();
        expect(onSecondSessionInvalidated).not.toHaveBeenCalled();

        publishMountedDiscussionChanges({
            serverId: 'server-a',
            accountId: 'account-a',
            changes: [{
                cursor: 2,
                kind: 'discussion',
                entityId: 'same-session',
                changedAt: 2,
                hint: { v: 1, discussions: true },
            }],
        });
        expect(onFirstInvalidated).toHaveBeenCalledTimes(2);

        first.dispose();
        secondHome.dispose();
        secondSession.dispose();
        publishMountedDiscussionChanges({
            serverId: 'server-a',
            accountId: 'account-a',
            changes: [{ cursor: 3, kind: 'discussion', entityId: 'same-session', changedAt: 3 }],
        });
        expect(onFirstInvalidated).toHaveBeenCalledTimes(2);
    });

    it('ignores unrelated changes even when their entity id matches a Discussion', async () => {
        const onInvalidated = vi.fn();
        const watch = watchMountedDiscussions({
            scope: { serverId: 'server-a', accountId: 'account-a' },
            address: { serverId: 'server-a' },
            onInvalidated,
        });

        publishMountedDiscussionChanges({
            serverId: 'server-a',
            accountId: 'account-a',
            changes: [
                { cursor: 1, kind: 'share', entityId: 'same-session', changedAt: 1 },
                { cursor: 2, kind: 'account', entityId: 'same-session', changedAt: 2 },
            ],
        });

        expect(onInvalidated).not.toHaveBeenCalled();
        watch.dispose();
    });
});
