import { expect, it, vi } from 'vitest';
import { createDeferred, flushHookEffects } from '@/dev/testkit';
import { publishMountedDiscussionChanges } from '@/sync/domains/discussions/discussionChangeWatch';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { readDiscussionAttentionPage } from '@/sync/api/discussions/discussionActions';
import { DiscussionAttentionResponseV1Schema } from '@happier-dev/protocol/discussions/api';
import { handleEphemeralSocketUpdate } from '@/sync/engine/socket/socket';
import { createDiscussionRepository, type DiscussionRepositoryClient } from './discussionRepository';
import { address, scope, client, message, summary, listResult, readResult, attentionClient } from './discussionRepository.testkit';

it('does not read attention for accounting-only pushes, but repairs changed and revoked attention on snapshot and reconnect', async () => {
    const { title, ...discussion } = summary('discussion-a', null, 1);
    const { messageRef: _messageRef, content, ...storedMessage } = message(1);
    const changed = DiscussionAttentionResponseV1Schema.parse({ discussions: [{
        discussion: { ...discussion, titleContent: { t: 'plain', v: { v: 1, title } } },
        occurrences: [{ type: 'update', message: { ...storedMessage, content: { t: 'plain', v: content } } }],
    }], nextCursor: null, incomplete: false });
    let response: Response = Response.json({ discussions: [], nextCursor: null, incomplete: false });
    // HTTP is the boundary: opening, schema admission, repository and push routing remain real.
    const request = vi.fn(async () => response.clone());
    const repository = createDiscussionRepository({ scope, address, client: client({
        attention: (input, signal) => readDiscussionAttentionPage({ scope, encryption: null, availability: 'available', request }, input, signal),
    }) });
    await repository.refreshAttention();
    const leave = repository.mount({ attention: true });
    try {
        request.mockClear();
        const before = repository.getSnapshot().attention;
        for (let cursor = 0; cursor < 20; cursor++) await handleEphemeralSocketUpdate({
            sourceServerId: scope.serverId,
            update: cursor % 2 ? { type: 'usage-sources-invalidated', machineId: 'machine', installationId: 'installation' }
                : { type: 'usage', id: null, key: 'codex:model', tokens: { total: 1 }, cost: { total: 0 }, timestamp: cursor },
            addActivityUpdate: () => {}, addMachineActivityUpdate: () => {},
            getSessionEncryption: () => null, getSession: () => undefined, applyMessages: () => {},
        });
        await flushHookEffects();
        expect(request).not.toHaveBeenCalled();
        expect(repository.getSnapshot().attention).toBe(before);

        response = Response.json(changed);
        publishHomeAccountChange(scope.serverId, undefined, { source: 'snapshot' });
        await vi.waitFor(() => expect(repository.getSnapshot().attention.discussions[0]?.discussion.title).toBe(title));
        expect(request).toHaveBeenCalledTimes(1);

        response = Response.json({ error: 'discussion_read_denied' }, { status: 403 });
        publishHomeAccountChange(scope.serverId, undefined, { source: 'connected' });
        await vi.waitFor(() => expect(repository.getSnapshot().attention.status).toBe('revoked'));
        expect(request).toHaveBeenCalledTimes(2);
        expect(repository.getSnapshot().attention.discussions).toEqual([]);
    } finally { leave(); repository.clear(); }
});

it('publishes no attention facts for identical warm pages and preserves ready state through cancellation', async () => {
    const entries = Array.from({ length: 200 }, (_, index) => ({ discussion: summary(`attention-${index}`, null, 1),
        occurrences: [{ message: message(1, null, `attention-${index}`), type: 'update' as const }] }));
    let pause = false;
    const pending = createDeferred<Awaited<ReturnType<DiscussionRepositoryClient['attention']>>>();
    const attention = vi.fn<DiscussionRepositoryClient['attention']>(async (input = {}) => pause ? pending.promise : ({
        kind: 'succeeded', value: { v: 1, serverId: scope.serverId,
            discussions: structuredClone(entries.slice(input.cursor ? 100 : 0, input.cursor ? 200 : 100)),
            nextCursor: input.cursor ? 'older' : '100', incomplete: false },
    }));
    const repository = createDiscussionRepository({ scope, address, client: client({ attention }) });
    await repository.refreshAttention();
    await repository.loadMoreAttention();
    const before = repository.getSnapshot().attention;
    const publications = vi.fn();
    const unsubscribe = repository.subscribe(publications);
    try {
        await repository.refreshAttention();
        expect(publications).toHaveBeenCalledTimes(0);
        expect(repository.getSnapshot().attention).toBe(before);
        expect(repository.getSnapshot().attention.nextCursor).toBe('older');
        pause = true;
        const controller = new AbortController();
        const refresh = repository.refreshAttention(controller.signal);
        expect(repository.getSnapshot().attention).toBe(before);
        controller.abort();
        pending.resolve({ kind: 'failed', errorCode: 'canceled' });
        await refresh;
        expect(publications).toHaveBeenCalledTimes(0);
        expect(repository.getSnapshot().attention).toBe(before);
    } finally { unsubscribe(); repository.clear(); }
});

it.each(['pages', 'exact'] as const)('reconciles %s attention by occurrence identity and publishes only changed facts', async mode => {
    const entries = Array.from({ length: 200 }, (_, index) => ({ discussion: summary(`attention-${index}`, null, 2),
        occurrences: [2, 1].map(seq => ({ message: message(seq, null, `attention-${index}`, {
            messageId: `attention-${index}-message-${seq}`, createdAt: 1000 - index + seq,
        }), type: 'update' as const })) }));
    const attention = vi.fn<DiscussionRepositoryClient['attention']>(async (input = {}) => ({ kind: 'succeeded', value: {
        v: 1, serverId: scope.serverId, discussions: structuredClone(input.discussionId
            ? entries.filter(entry => entry.discussion.id === input.discussionId) : entries), nextCursor: null, incomplete: false,
    } }));
    const network = client({ attention, get: async id => ({ kind: 'succeeded', value: {
        v: 1, serverId: scope.serverId, discussion: structuredClone(entries.find(entry => entry.discussion.id === id)!.discussion),
    } }) });
    const repository = createDiscussionRepository({ scope, address, client: network });
    await repository.refreshAttention();
    const leave = repository.mount({ attention: true });
    let previous = repository.getSnapshot().attention;
    const publications = vi.fn();
    const unsubscribe = repository.subscribe(() => {
        const next = repository.getSnapshot().attention;
        if (next !== previous) { publications(); previous = next; }
    });
    let cursor = 0;
    const refresh = async () => {
        if (mode === 'pages') await repository.refreshAttention();
        else {
            const calls = attention.mock.calls.length;
            publishMountedDiscussionChanges({ ...scope, changes: [{ cursor: ++cursor, kind: 'discussion', entityId: entries[0]!.discussion.id, changedAt: cursor }] });
            await vi.waitFor(() => expect(attention.mock.calls.length).toBe(calls + 1));
            await flushHookEffects();
        }
    };
    try {
        const before = repository.getSnapshot().attention;
        await refresh();
        expect(publications).toHaveBeenCalledTimes(0);
        expect(repository.getSnapshot().attention).toBe(before);
        entries[0]!.occurrences[0]!.message = { ...entries[0]!.occurrences[0]!.message,
            participantDeliveryV1: [{ participantSessionId: 'agent-a', disposition: 'held', code: 'session_input_target_unavailable' }] };
        await refresh();
        const after = repository.getSnapshot().attention;
        expect(publications).toHaveBeenCalledTimes(1);
        expect(after.discussions[0]).not.toBe(before.discussions[0]);
        expect(after.discussions[0]!.discussion).toBe(before.discussions[0]!.discussion);
        expect(after.discussions[0]!.occurrences[0]).not.toBe(before.discussions[0]!.occurrences[0]);
        expect(after.discussions[0]!.occurrences[0]!.message.content).toBe(before.discussions[0]!.occurrences[0]!.message.content);
        expect(after.discussions[0]!.occurrences[1]).toBe(before.discussions[0]!.occurrences[1]);
        expect(after.discussions.slice(1).every((entry, index) => entry === before.discussions[index + 1])).toBe(true);
        entries[0]!.occurrences.reverse();
        await refresh();
        const reordered = repository.getSnapshot().attention.discussions.find(entry => entry.discussion.id === entries[0]!.discussion.id)!;
        expect(reordered.occurrences[0]).toBe(after.discussions[0]!.occurrences[1]);
        expect(reordered.occurrences[1]).toBe(after.discussions[0]!.occurrences[0]);
    } finally { unsubscribe(); leave(); repository.clear(); }
});

it('refreshes attention only for the changed Discussion within its retained occurrence frontier', async () => {
    const entries = Array.from({ length: 300 }, (_, index) => {
        const row = message(1, null, `attention-${index}`, { messageId: `attention-message-${index}`, createdAt: 1000 - index });
        return { discussion: summary(`attention-${index}`, null, 1), occurrences: [{
            message: row, type: 'update' as const }] };
    });
    const attention = vi.fn<DiscussionRepositoryClient['attention']>(async (input = {}) => {
        const selected: unknown = Reflect.get(input, 'discussionId');
        const offset = Number(input.cursor ?? 0);
        return { kind: 'succeeded', value: { v: 1, serverId: scope.serverId,
            discussions: typeof selected === 'string' ? entries.filter(entry => entry.discussion.id === selected) : entries.slice(offset, offset + 100),
            nextCursor: typeof selected === 'string' || offset === 200 ? null : String(offset + 100), incomplete: false } };
    });
    const get = vi.fn<DiscussionRepositoryClient['get']>(async id => ({ kind: 'succeeded', value: {
        v: 1, serverId: scope.serverId, discussion: entries.find(entry => entry.discussion.id === id)!.discussion } }));
    const repository = createDiscussionRepository({ scope, address, client: client({ attention, get }) });
    await repository.refreshAttention();
    await repository.loadMoreAttention();
    // Keep the third page closed: targeted refresh must retain the global older-page frontier.
    const before = repository.getSnapshot().attention;
    const leave = repository.mount({ attention: true });
    const states: string[] = [];
    const unsubscribe = repository.subscribe(() => states.push(repository.getSnapshot().attention.status));
    try {
        attention.mockClear();
        for (let arrival = 1; arrival <= 5; arrival++) {
            const row = entries[0]!;
            const next = message(arrival + 1, null, row.discussion.id, { messageId: `arrival-${arrival}`, createdAt: 1000 + arrival });
            entries[0] = { discussion: { ...row.discussion, messageSeq: arrival + 1,
                latestMessage: { ...row.discussion.latestMessage, id: next.id, seq: next.seq, createdAt: next.createdAt } },
                occurrences: [{ message: next, type: 'update' }, ...row.occurrences] };
            publishMountedDiscussionChanges({ ...scope, changes: [{ cursor: arrival, kind: 'discussion', entityId: row.discussion.id, changedAt: arrival }] });
            await flushHookEffects();
            await vi.waitFor(() => expect(repository.getSnapshot().attention.discussions[0]?.discussion.messageSeq).toBe(arrival + 1));
        }
        console.info('Discussion attention arrival cost', { arrivals: 5, loadedDiscussions: 200,
            requests: attention.mock.calls.map(([input]) => input) });
        expect(attention.mock.calls.map(([input]) => input)).toEqual(Array(5).fill({ discussionId: 'attention-0', afterCursor: '200' }));
        expect(repository.getSnapshot().attention.nextCursor).toBe('200');
        expect(repository.getSnapshot().attention.discussions).toHaveLength(200);
        expect(repository.getSnapshot().attention.discussions[100]).toBe(before.discussions[100]);
        expect(repository.getSnapshot().attention.discussions[0]?.discussion.messageSeq).toBe(6);
        expect(states).not.toContain('loading');
    } finally { unsubscribe(); leave(); repository.clear(); }
});

it('refreshes cursor facts without list or attention queries for readState-only hints, but rereads mixed message hints', async () => {
    let row = summary('discussion-a', null, 2);
    const list = vi.fn<DiscussionRepositoryClient['list']>(async input => ({ kind: 'succeeded', value:
        listResult(input?.state === 'archived' ? [] : [row], null) }));
    const get = vi.fn<DiscussionRepositoryClient['get']>(async () => ({ kind: 'succeeded', value:
        { v: 1, serverId: scope.serverId, discussion: row } }));
    const attention = vi.fn<DiscussionRepositoryClient['attention']>(async () => ({ kind: 'succeeded', value: {
        v: 1, serverId: scope.serverId, discussions: [{ discussion: row,
            occurrences: [...(row.unreadCount ? [{ message: message(row.messageSeq), type: 'update' as const }] : []),
                { message: message(1), type: 'decision' as const }] }], nextCursor: null, incomplete: false } }));
    const repository = createDiscussionRepository({ scope, address, client: client({ list, get, attention }) });
    await repository.refreshList('active');
    await repository.refreshAttention();
    const leaveHome = repository.mount();
    const leaveAttention = repository.mount({ attention: true });
    try {
        list.mockClear(); get.mockClear(); attention.mockClear();
        row = { ...row, lastReadSeq: 2, unreadCount: 0, unreadMentionCount: 0 };
        publishMountedDiscussionChanges({ ...scope, changes: [{ cursor: 1, kind: 'discussion', entityId: row.id, changedAt: 1,
            hint: { v: 1, discussions: true, changes: { readState: true } } }] });
        await vi.waitFor(() => expect(repository.getSnapshot().lists.active.items[0]?.lastReadSeq).toBe(2));
        expect(get).toHaveBeenCalledExactlyOnceWith(row.id, undefined);
        expect(list).not.toHaveBeenCalled();
        expect(attention).not.toHaveBeenCalled();
        expect(repository.getSnapshot().attention.discussions[0]?.occurrences.map(occurrence => [occurrence.type, occurrence.message.seq]))
            .toEqual([['decision', 1]]);

        get.mockClear();
        row = { ...row, messageSeq: 3, unreadCount: 1, latestMessage: { ...row.latestMessage, seq: 3, createdAt: 3 } };
        publishMountedDiscussionChanges({ ...scope, changes: [{ cursor: 2, kind: 'discussion', entityId: row.id, changedAt: 2,
            hint: { v: 1, discussions: true, changes: { readState: true, resource: true } } }] });
        await vi.waitFor(() => expect(repository.getSnapshot().attention.discussions[0]?.discussion.messageSeq).toBe(3));
        expect(get).toHaveBeenCalledExactlyOnceWith(row.id, undefined);
        expect(attention).toHaveBeenCalledExactlyOnceWith({ discussionId: row.id }, undefined);
        expect(list).not.toHaveBeenCalled();
    } finally { leaveAttention(); leaveHome(); repository.clear(); }
});

it('waits for an exact attention disposition refresh before extending its retained older-page frontier', async () => {
    const first = createDeferred<Awaited<ReturnType<DiscussionRepositoryClient['attention']>>>();
    const refreshed = createDeferred<Awaited<ReturnType<DiscussionRepositoryClient['attention']>>>();
    const older = createDeferred<Awaited<ReturnType<DiscussionRepositoryClient['attention']>>>();
    const open = { v: 1 as const, serverId: address.serverId, discussions: [{ discussion: summary('discussion-a', null, 1),
        occurrences: [{ message: message(1), type: 'decision' as const }] }], nextCursor: 'older', incomplete: false };
    const attention = vi.fn<DiscussionRepositoryClient['attention']>().mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(refreshed.promise).mockReturnValueOnce(older.promise);
    const repository = createDiscussionRepository({ scope, address, client: attentionClient(attention) });
    const unmount = repository.mount({ attention: true });
    try {
        const initial = repository.refreshAttention();
        publishMountedDiscussionChanges({ ...scope, changes: [{ cursor: 1, kind: 'discussion', entityId: 'discussion-a', changedAt: 1 }] });
        const more = repository.loadMoreAttention();
        first.resolve({ kind: 'succeeded', value: open });
        await initial;
        await vi.waitFor(() => expect(attention.mock.calls.length).toBeGreaterThanOrEqual(2));
        refreshed.resolve({ kind: 'succeeded', value: { ...open, discussions: [], nextCursor: null } });
        await vi.waitFor(() => expect(repository.getSnapshot().attention.discussions).toEqual([]));
        expect(repository.getSnapshot().attention.nextCursor).toBe('older');
        expect(attention).toHaveBeenNthCalledWith(2, { discussionId: 'discussion-a', afterCursor: 'older' }, undefined);
        older.resolve({ kind: 'succeeded', value: { ...open, discussions: [], nextCursor: null } });
        await more;
        expect(repository.getSnapshot().attention.discussions).toEqual([]);
    } finally { unmount(); }
});
it('does not hydrate a previously viewed thread on Doc changes when only Inbox attention remains mounted', async () => {
    const attention = vi.fn<DiscussionRepositoryClient['attention']>().mockResolvedValue({ kind: 'succeeded', value: {
        v: 1, serverId: address.serverId, discussions: [], nextCursor: null, incomplete: false,
    } });
    const network = client({ attention,
        get: vi.fn<DiscussionRepositoryClient['get']>().mockResolvedValue({ kind: 'succeeded', value: {
            v: 1, serverId: address.serverId, discussion: summary('discussion-a', null, 1),
        } }),
        read: vi.fn<DiscussionRepositoryClient['read']>().mockResolvedValue({ kind: 'succeeded', value: readResult([message(1)], false, 1) }) });
    const repository = createDiscussionRepository({ scope, address, client: network });
    const leaveDetail = repository.mount();
    await repository.refreshDiscussion('discussion-a');
    leaveDetail();
    expect(repository.getSnapshot().threads['discussion-a']?.messages).toHaveLength(1);
    vi.mocked(network.get).mockClear();
    vi.mocked(network.read).mockClear();
    const leaveInbox = repository.mount({ attention: true });
    try {
        publishMountedDiscussionChanges({ ...scope, changes: [{ cursor: 1, kind: 'artifact', entityId: 'plan', changedAt: 1 }] });
        await vi.waitFor(() => expect(repository.getSnapshot().attention.status).toBe('ready'));
        expect(network.get).not.toHaveBeenCalled();
        expect(network.read).not.toHaveBeenCalled();
        expect(network.list).not.toHaveBeenCalled();
    } finally { leaveInbox(); }
});
it.each(['discussion', 'artifact'] as const)('rereads an owner %s change invalidated while the prior attention snapshot is still in flight', async kind => {
    const pending = createDeferred<Awaited<ReturnType<DiscussionRepositoryClient['attention']>>>();
    const old = { v: 1 as const, serverId: address.serverId, discussions: [{ discussion: summary('discussion-a', null, 1),
        occurrences: [{ message: message(1), type: 'decision' as const }] }], nextCursor: null, incomplete: false };
    const attention = vi.fn<DiscussionRepositoryClient['attention']>().mockReturnValueOnce(pending.promise)
        .mockResolvedValue({ kind: 'succeeded', value: { ...old, discussions: [] } });
    const repository = createDiscussionRepository({ scope, address, client: attentionClient(attention) });
    const unmount = repository.mount({ attention: true });
    try {
        const read = repository.refreshAttention();
        publishMountedDiscussionChanges({ ...scope, changes: [{ cursor: 1, kind, entityId: 'discussion-a', changedAt: 1 }] });
        pending.resolve({ kind: 'succeeded', value: old });
        await read;
        await vi.waitFor(() => expect(repository.getSnapshot().attention.discussions).toEqual([]));
    } finally { unmount(); }
});
it('batches cold attention demand, keeps unrelated identities and refreshes only its captured Home/Account', async () => {
    const pending = createDeferred<Awaited<ReturnType<DiscussionRepositoryClient['attention']>>>();
    const value = { v: 1 as const, serverId: address.serverId, discussions: ['discussion-a', 'discussion-b'].map(id => ({ discussion: summary(id, null, 1),
        occurrences: [{ message: message(1, null, id), type: 'decision' as const }] })), nextCursor: null, incomplete: false };
    const attention = vi.fn<DiscussionRepositoryClient['attention']>().mockReturnValueOnce(pending.promise)
        .mockImplementation(async input => ({ kind: 'succeeded', value: { ...value,
            discussions: value.discussions.filter(entry => entry.discussion.id === input?.discussionId) } }));
    const network = attentionClient(attention);
    const repository = createDiscussionRepository({ scope, address, client: network });
    const unmount = repository.mount({ attention: true });
    try {
        const first = repository.refreshAttention();
        const second = repository.refreshAttention();
        expect(second).toBe(first);
        pending.resolve({ kind: 'succeeded', value });
        await first;
        const before = repository.getSnapshot().attention.discussions;
        expect(repository.getSnapshot().threads).toEqual({});
        publishMountedDiscussionChanges({ ...scope, serverId: 'other-home', changes: [{ cursor: 1, kind: 'discussion', entityId: 'discussion-a', changedAt: 1 }] });
        publishMountedDiscussionChanges({ ...scope, accountId: 'other-person', changes: [{ cursor: 1, kind: 'discussion', entityId: 'discussion-a', changedAt: 1 }] });
        expect(attention).toHaveBeenCalledTimes(1);
        publishMountedDiscussionChanges({ ...scope, changes: [{ cursor: 2, kind: 'discussion', entityId: 'discussion-a', changedAt: 2 }] });
        await vi.waitFor(() => expect(attention).toHaveBeenCalledTimes(2));
        expect(repository.getSnapshot().attention.discussions.find(entry => entry.discussion.id === 'discussion-b')).toBe(before[1]);
        expect(network.list).not.toHaveBeenCalled();
        expect(network.read).not.toHaveBeenCalled();
    } finally { unmount(); }
});

it('does not resurrect retired or explicitly refused attention from an in-flight read', async () => {
    const pending = createDeferred<Awaited<ReturnType<DiscussionRepositoryClient['attention']>>>();
    const value = { v: 1 as const, serverId: address.serverId, discussions: [{ discussion: summary('discussion-a', null, 1),
        occurrences: [{ message: message(1), type: 'decision' as const }] }], nextCursor: null, incomplete: false };
    const attention = vi.fn<DiscussionRepositoryClient['attention']>().mockResolvedValueOnce({ kind: 'succeeded', value })
        .mockReturnValueOnce(pending.promise).mockResolvedValue({ kind: 'failed', errorCode: 'discussion_read_denied' });
    const repository = createDiscussionRepository({ scope, address, client: client({ attention }) });
    await repository.refreshAttention();
    const stale = repository.refreshAttention();
    repository.clear();
    pending.resolve({ kind: 'succeeded', value });
    await stale;
    expect(repository.getSnapshot().attention.discussions).toEqual([]);
    await repository.refreshAttention();
    expect(repository.getSnapshot().attention).toMatchObject({ status: 'revoked', discussions: [] });
});

it('reads attention once for one Artifact write: the local receipt is not a snapshot repair', async () => {
    const attention = vi.fn<DiscussionRepositoryClient['attention']>().mockResolvedValue({ kind: 'succeeded', value: {
        v: 1, serverId: address.serverId, discussions: [], nextCursor: null, incomplete: false,
    } });
    const network = client({ attention });
    const repository = createDiscussionRepository({ scope, address, client: network });
    await repository.refreshAttention();
    const leave = repository.mount({ attention: true });
    try {
        attention.mockClear();
        // One committed Artifact write (a Board layout switch) reaches the focused Home twice: the
        // socket receipt that wakes Artifact readers (socket.ts), then the detailed change page.
        publishHomeAccountChange(scope.serverId, ['board-artifact'], { changeKinds: ['artifact'] });
        publishMountedDiscussionChanges({ ...scope, changes: [{ cursor: 1, kind: 'artifact', entityId: 'board-artifact', changedAt: 1 }] });
        await flushHookEffects();
        await vi.waitFor(() => expect(repository.getSnapshot().attention.status).toBe('ready'));
        await flushHookEffects();
        expect(attention).toHaveBeenCalledTimes(1);
        expect(network.list).not.toHaveBeenCalled();
    } finally { leave(); repository.clear(); }
});

it('re-reads mounted attention on a primary-Home reconnect only when its last read did not succeed', async () => {
    let response: Response = Response.json({ discussions: [], nextCursor: null, incomplete: false });
    // HTTP is the boundary: the catch-up's exact Discussion rows are the reconnect's delivery path.
    const request = vi.fn(async () => response.clone());
    const repository = createDiscussionRepository({ scope, address, client: client({
        attention: (input, signal) => readDiscussionAttentionPage({ scope, encryption: null, availability: 'available', request }, input, signal),
    }) });
    await repository.refreshAttention();
    const leave = repository.mount({ attention: true });
    try {
        await flushHookEffects();
        request.mockClear();
        publishHomeAccountChange(scope.serverId, undefined, { source: 'connected', changesCatchUp: true });
        await flushHookEffects();
        expect(request).toHaveBeenCalledTimes(0);

        response = Response.json({ error: 'unavailable' }, { status: 503 });
        publishHomeAccountChange(scope.serverId, undefined, { source: 'snapshot' });
        await vi.waitFor(() => expect(repository.getSnapshot().attention.status).not.toBe('ready'));
        response = Response.json({ discussions: [], nextCursor: null, incomplete: false });
        request.mockClear();
        publishHomeAccountChange(scope.serverId, undefined, { source: 'connected', changesCatchUp: true });
        await vi.waitFor(() => expect(repository.getSnapshot().attention.status).toBe('ready'));
        expect(request).toHaveBeenCalledTimes(1);
    } finally { leave(); repository.clear(); }
});
