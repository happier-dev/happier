/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { answerDiscussionThreadForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';

// Browser Markdown is outside this store-only DOM consumer's native import graph.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: (text: string) => [{ text, reveal: false }],
}));
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { createDiscussionClient } = await import('@/sync/api/discussions/discussionActions');
const { getDiscussionRepository, clearDiscussionRepositoryRegistryForTests } = await import('./discussionRepositoryRegistry');
const { useDiscussionRepositorySnapshot } = await import('./useDiscussionRepositorySnapshot');
const { getStorage } = await import('@/sync/domains/state/storageStore');
const { publishMountedDiscussionChanges } = await import('@/sync/domains/discussions/discussionChangeWatch');
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(async () => {
    await act(async () => { root?.unmount(); });
    root = undefined;
    container?.remove();
    container = undefined;
    clearDiscussionRepositoryRegistryForTests();
    await homes.reset();
    vi.restoreAllMocks();
});

it('keeps Discussion snapshots stable, ignores unrelated state and wrong-Account hints, and paints arriving replies', async () => {
    const errors = vi.spyOn(console, 'error');
    const serverId = await homes.addHome({ name: 'DOM Discussion', serverUrl: 'https://discussion-dom.test', accountId: 'alice', currentAccount: true });
    const scope = { serverId, accountId: 'alice' };
    const fixture = answerDiscussionThreadForTests(homes, serverId, { loseCreate: false, loseFirstRejoin: false });
    const client = createDiscussionClient({ scope, availability: 'available' });
    const created = await client.create({ creationLocalId: 'snapshot-thread', messageLocalId: 'snapshot-root', title: 'Snapshot thread',
        content: { v: 1, parts: [{ t: 'text', text: 'Question' }] } });
    expect(created.kind).toBe('succeeded');
    const repository = getDiscussionRepository({ scope, address: { serverId }, client });
    await repository.refreshDiscussion('committed-thread');
    const initial = repository.getSnapshot();
    expect(repository.getSnapshot()).toBe(initial);
    const release = repository.mount({ discussionId: 'committed-thread' });
    let renders = 0;
    function Thread() {
        renders++;
        const snapshot = useDiscussionRepositorySnapshot(repository);
        return <output>{snapshot.threads['committed-thread']?.messages.map(row => row.id).join(',')}</output>;
    }
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    try {
        await act(async () => { root!.render(<Thread />); });
        const settled = renders;
        await act(async () => { getStorage().setState({ lastSyncAt: Date.now() }); });
        expect(renders - settled).toBe(0);
        fixture.messages.push({ ...fixture.messages[0]!, id: 'arriving-reply', seq: 2, localId: 'reply-local' });
        const hint = { kind: 'discussion' as const, entityId: 'committed-thread', cursor: 2, changedAt: 2, hint: null };
        await act(async () => { publishMountedDiscussionChanges({ serverId, accountId: 'other-account', changes: [hint] }); });
        expect(container.textContent).not.toContain('arriving-reply');
        await act(async () => {
            publishMountedDiscussionChanges({ ...scope, changes: [hint] });
            await vi.waitFor(() => expect(repository.getSnapshot().threads['committed-thread']?.messages).toHaveLength(2));
        });
        expect(container.textContent).toContain('arriving-reply');
        expect(repository.getSnapshot()).not.toBe(initial);
        expect(repository.getSnapshot()).toBe(repository.getSnapshot());
        expect(errors.mock.calls.flat().some(value => typeof value === 'string' && /getSnapshot|Maximum update depth/.test(value))).toBe(false);
    } finally { release(); }
});
