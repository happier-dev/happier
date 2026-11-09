import { describe, expect, it } from 'vitest';
import { SessionHumanPresenceViewerV1Schema } from '@happier-dev/protocol/sessions';
import { createSessionHumanPresenceStore } from './sessionHumanPresenceStore';

const address = { serverId: 'home-a', sessionId: 'session-1' };
const viewer = (accountId: string, typing = false) => SessionHumanPresenceViewerV1Schema.parse({
    account: { kind: 'account', accountId, firstName: accountId, lastName: null, username: null, avatarUrl: null },
    typing,
});
const snapshot = (viewers = [viewer('other')]) => ({ v: 1, sessionId: address.sessionId, observedAt: 100, viewers });

describe('human presence observation store', () => {
    it('admits only declared sessions, excludes self, deduplicates and stays Home scoped', () => {
        const store = createSessionHumanPresenceStore();
        const home = store.attachHome(address.serverId, 'self');
        home.receiveSnapshot(snapshot());
        expect(store.read(address).status).toBe('connecting');
        home.beginDeclaration([address.sessionId]);
        home.receiveSnapshot(snapshot([viewer('z'), viewer('self'), viewer('a'), viewer('a', true)]));
        expect(store.read(address)).toMatchObject({ status: 'live', viewers: [viewer('a', true), viewer('z')] });
        expect(store.read({ ...address, serverId: 'home-b' }).status).toBe('unavailable');
        home.receiveSnapshot({ ...snapshot(), email: 'private' });
        expect(store.read(address).viewers).toHaveLength(2);
    });

    it('publishes nothing when a snapshot only advances its observation clock', () => {
        const store = createSessionHumanPresenceStore();
        const home = store.attachHome(address.serverId, 'self');
        home.beginDeclaration([address.sessionId]);
        home.receiveSnapshot(snapshot([viewer('other')]));
        const shown = store.read(address);
        let notified = 0;
        const off = store.subscribe(address, () => { notified += 1; });
        home.receiveSnapshot({ ...snapshot([viewer('other')]), observedAt: 200 });
        home.receiveSnapshot({ ...snapshot([viewer('other')]), observedAt: 300 });
        expect(notified).toBe(0);
        expect(store.read(address)).toBe(shown);
        home.receiveSnapshot({ ...snapshot([viewer('other', true)]), observedAt: 400 });
        expect(notified).toBe(1);
        expect(store.read(address).viewers).toEqual([viewer('other', true)]);
        off();
    });

    it('retains last observation as stale across reconnect and ignores replaced socket callbacks', () => {
        const store = createSessionHumanPresenceStore();
        const old = store.attachHome(address.serverId, 'self');
        old.beginDeclaration([address.sessionId]);
        old.receiveSnapshot(snapshot([viewer('other', true)]));
        old.setStatus('unavailable');
        expect(store.read(address)).toMatchObject({ status: 'stale', observedAt: 100 });
        const replacement = store.attachHome(address.serverId, 'self');
        replacement.beginDeclaration([address.sessionId]);
        old.receiveSnapshot(snapshot([]));
        old.dispose();
        expect(store.read(address).viewers).toHaveLength(1);
        replacement.receiveSnapshot(snapshot([]));
        expect(store.read(address)).toMatchObject({ status: 'live', viewers: [] });
        replacement.dispose();
        expect(store.read(address)).toMatchObject({ status: 'unavailable', viewers: [] });
    });

    it('narrows acknowledged admission without invalidating a live admitted observation', () => {
        const store = createSessionHumanPresenceStore();
        const home = store.attachHome(address.serverId, 'self');
        home.beginDeclaration([address.sessionId, 'denied']);
        home.receiveSnapshot(snapshot());
        const live = store.read(address);
        home.confirmDeclaration([address.sessionId]);
        expect(store.read(address)).toBe(live);
        expect(store.read({ ...address, sessionId: 'denied' }).status).toBe('unavailable');
        home.receiveSnapshot({ ...snapshot(), sessionId: 'denied' });
        expect(store.read({ ...address, sessionId: 'denied' }).viewers).toEqual([]);
    });

    it('keeps the Session root and two discussions isolated through replacement and unavailable admission', () => {
        const store = createSessionHumanPresenceStore();
        const home = store.attachHome(address.serverId, 'self');
        const discussionA = { serverId: address.serverId, discussionId: 'discussion-a' };
        const discussionB = { serverId: address.serverId, discussionId: 'discussion-b' };
        home.beginDeclaration([address.sessionId], [
            { discussionId: discussionA.discussionId },
            { discussionId: discussionB.discussionId },
        ]);
        home.confirmDeclaration([address.sessionId], [
            { discussionId: discussionA.discussionId },
            { discussionId: discussionB.discussionId },
        ]);
        const notifications = { root: 0, discussionA: 0, discussionB: 0 };
        const unsubscribeRoot = store.subscribe(address, () => notifications.root++);
        const unsubscribeDiscussionA = store.subscribe(discussionA, () => notifications.discussionA++);
        const unsubscribeDiscussionB = store.subscribe(discussionB, () => notifications.discussionB++);
        home.receiveSnapshot(snapshot([viewer('root')]));
        expect(notifications).toEqual({ root: 1, discussionA: 0, discussionB: 0 });
        home.receiveSnapshot({ v: 1, discussionId: discussionA.discussionId, observedAt: 101, viewers: [viewer('a')] });
        expect(notifications).toEqual({ root: 1, discussionA: 1, discussionB: 0 });
        home.receiveSnapshot({ v: 1, discussionId: discussionB.discussionId, observedAt: 102, viewers: [viewer('b')] });
        expect(notifications).toEqual({ root: 1, discussionA: 1, discussionB: 1 });

        expect(store.read(address)).toMatchObject({ status: 'live', viewers: [viewer('root')] });
        expect(store.read(discussionA)).toMatchObject({ status: 'live', viewers: [viewer('a')] });
        expect(store.read(discussionB)).toMatchObject({ status: 'live', viewers: [viewer('b')] });

        home.beginDeclaration([], [{ discussionId: discussionB.discussionId }]);
        home.confirmDeclaration([], [{ discussionId: discussionB.discussionId }]);
        expect(store.read(address)).toMatchObject({ status: 'unavailable', viewers: [] });
        expect(store.read(discussionA)).toMatchObject({ status: 'unavailable', viewers: [] });
        expect(store.read(discussionB)).toMatchObject({ status: 'stale', viewers: [viewer('b')] });

        home.receiveSnapshot(snapshot([viewer('must-not-leak')]));
        home.receiveSnapshot({ v: 1, discussionId: discussionA.discussionId, observedAt: 103, viewers: [viewer('must-not-leak')] });
        expect(store.read(address).viewers).toEqual([]);
        expect(store.read(discussionA).viewers).toEqual([]);
        expect(store.read(discussionB).viewers).toEqual([viewer('b')]);
        unsubscribeRoot();
        unsubscribeDiscussionA();
        unsubscribeDiscussionB();
    });

    it('notifies only changed Session subscribers and keeps stable snapshots for unchanged data', () => {
        const store = createSessionHumanPresenceStore();
        const home = store.attachHome(address.serverId, 'self');
        home.beginDeclaration([address.sessionId, 'session-2']);
        let changes = 0;
        store.subscribe({ ...address, sessionId: 'session-2' }, () => changes++);
        home.receiveSnapshot(snapshot());
        const value = store.read(address);
        home.receiveSnapshot(snapshot());
        expect(store.read(address)).toBe(value);
        expect(changes).toBe(0);
        home.setStatus('unsupported');
        expect(store.read(address)).toMatchObject({ status: 'unsupported', viewers: [] });
    });

    it('keeps a Discussion snapshot exclusive and scoped to its captured Home and Account', () => {
        const store = createSessionHumanPresenceStore();
        const target = { serverId: 'home-a', discussionId: 'same-id' };
        const first = store.attachHome(target.serverId, 'account-a');
        first.beginDeclaration([], [{ discussionId: target.discussionId }]);
        first.confirmDeclaration([], [{ discussionId: target.discussionId }]);
        first.receiveSnapshot({ v: 1, discussionId: target.discussionId, observedAt: 1, viewers: [viewer('peer-a')] });
        const observation = store.read(target, 'account-a');
        first.receiveSnapshot({ v: 1, sessionId: 'source', discussionId: target.discussionId, observedAt: 2, viewers: [] });
        first.receiveSnapshot({ v: 1, sourceSessionId: 'source', discussionId: target.discussionId, observedAt: 2, viewers: [] });
        expect(store.read(target, 'account-a')).toBe(observation);
        expect(store.read({ ...target, serverId: 'home-b' })).toMatchObject({ status: 'unavailable', viewers: [] });
        const next = store.attachHome(target.serverId, 'account-b');
        next.beginDeclaration([], [{ discussionId: target.discussionId }]);
        next.confirmDeclaration([], [{ discussionId: target.discussionId }]);
        first.receiveSnapshot({ v: 1, discussionId: target.discussionId, observedAt: 3, viewers: [viewer('retired-peer')] });
        next.receiveSnapshot({ v: 1, discussionId: target.discussionId, observedAt: 4, viewers: [viewer('peer-b')] });
        expect(store.read(target, 'account-a')).toMatchObject({ status: 'unavailable', viewers: [] });
        expect(store.read(target, 'account-b')).toMatchObject({ status: 'live', viewers: [viewer('peer-b')] });
    });
});
