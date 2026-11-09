import * as React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { MemoryFactV1 } from '@happier-dev/protocol/prompts/library/memoryDocV1';
import { DiscussionSummaryV1Schema } from '@happier-dev/protocol/discussions/models';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createPlainSessionByIdResponseFixture, createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { act, createDeferred, flushHookEffects } from '@/dev/testkit';
import type { DiscussionMessageRefV1 } from '@happier-dev/protocol/discussions/messageRefs';
import { setScreenSharingPrivacyActive } from '@/desktop/capture/useNativeRecordingActive';
import { buildSessionOrganizationSessionKey } from '@/sync/domains/session/organization/keys';

const homes = createHomeGovernanceHarness();
const httpBoundary = { ...homes, request: createSessionReadBatchFetchBoundary(homes.request) };
installHomeGovernanceBoundaries(httpBoundary);
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { MemoryFactDetail } = await import('./MemoryFactDetail');
const { getStorage } = await import('@/sync/domains/state/storage');
const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
const initial = getStorage().getState();
let serverId: string;
beforeEach(async () => {
    await homes.reset();
    installHomeGovernanceBoundaries(httpBoundary);
    serverId = await homes.addHome({ name: 'Source', serverUrl: 'https://memory-source.test', accountId: 'alice', currentAccount: true });
    const features = createRootLayoutFeaturesResponse({ features: { sessions: { conversations: { enabled: true } } } });
    homes.answer(serverId, '/v1/features', { body: features });
    homes.answer(serverId, '/v1/features/authenticated', { body: features });
    primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
});

it('loads a Discussion source title from the shared authorized Discussion reader', async () => {
    const row = sourceDiscussion();
    homes.answer(serverId, '/v1/discussions', { body: { discussions: [], nextCursor: null } });
    homes.answer(serverId, '/v1/discussions/source-discussion', { body: { discussion: row } });
    homes.answer(serverId, '/v1/discussions/source-discussion/messages', { body: { messages: [], hasMoreOlder: false, messageSeq: 1 } });
    const fact = discussionDecision();
    let opened: DiscussionMessageRefV1 | null = null;
    const screen = await renderScreen(<MemoryFactDetail testID="fact" fact={fact} documentRef={null} serverId={serverId} viewerAccountId="alice" archived={false}
        onOpenDiscussion={ref => { opened = ref; }} />);
    await waitForHomeGovernance(() => expect(sourceTitle(screen)).toBe('Decision discussion'));
    await screen.pressByTestIdAsync('fact.source');
    expect(opened).toEqual(fact.decision?.sourceMessageRef);
});
afterEach(() => { standardCleanup(); setScreenSharingPrivacyActive(false); getStorage().setState(initial, true); });

it('masks a recording-private fact source title while preserving its exact message link', async () => {
    const session = createSessionFixture({ id: 'source-session', encryptionMode: 'plain',
        metadata: { path: '/project', host: 'host', summary: { text: 'Confidential decision source', updatedAt: 1 } } });
    homes.answer(serverId, '/v2/sessions/source-session', { body: createPlainSessionByIdResponseFixture(session) });
    getStorage().setState({ settings: { ...getStorage().getState().settings, sessionListHiddenTagIdsWhileRecording: { [serverId]: ['private'] } },
        sessionOrganizationTagAssignmentsBySessionKey: {
            [buildSessionOrganizationSessionKey(serverId, session.id)]: { sessionId: session.id, tagIds: ['private'] },
        } });
    const opened = vi.fn();
    const screen = await renderScreen(<MemoryFactDetail testID="fact" fact={decision()} documentRef={null} serverId={serverId}
        viewerAccountId="alice" archived={false} onOpenSession={opened} />);
    await waitForHomeGovernance(() => expect(sourceTitle(screen)).toBe('Confidential decision source'));
    await act(async () => setScreenSharingPrivacyActive(true));
    expect(sourceTitle(screen)).not.toBe('Confidential decision source');
    await screen.pressByTestIdAsync('fact.source');
    expect(opened).toHaveBeenCalledWith(expect.objectContaining({ serverId, sessionId: session.id }));
});

function sourceDiscussion() {
    return DiscussionSummaryV1Schema.parse({
        id: 'source-discussion', ownerAccountId: 'alice', encryptionMode: 'plain', anchor: null, access: 'owner',
        keyReadiness: true, dataEncryptionKey: null, creationLocalId: null,
        titleContent: { t: 'plain', v: { v: 1, title: 'Decision discussion' } },
        latestMessage: { id: 'committed-message', localId: null, seq: 1, authorAccountId: 'alice',
            accountActor: { v: 1, accountId: 'alice', profile: null }, producerV1: null, createdAt: 1 },
        messageSeq: 1, lastReadSeq: 0, unreadCount: 0, unreadMentionCount: 0,
        recentAuthorAccountIds: ['alice'], archivedAt: null,
        capabilities: { postMessages: true, rename: true, archive: true, restore: false, askAgent: true, sendToSession: true, manageAccess: true, leave: false },
    });
}

function discussionDecision(): MemoryFactV1 {
    return { ...decision(), decision: { reason: 'Keep the source clear', approvedBy: null,
        sourceMessageRef: { kind: 'discussion', discussion: { serverId, discussionId: 'source-discussion' }, messageId: 'committed-message' } } };
}

function decision(): MemoryFactV1 {
    return { id: 'fact', text: 'Use the scoped reader', createdAtMs: 1, sourceSessionRef: null,
        decision: { reason: 'Keep the source clear', approvedBy: null,
            sourceMessageRef: { kind: 'session', session: { serverId, sessionId: 'source-session' }, messageId: 'committed-message' } } };
}

function sourceTitle(screen: Awaited<ReturnType<typeof renderScreen>>): string | null {
    return screen.findAllByTestId('fact.source').find(node => typeof node.props.detail === 'string')?.props.detail ?? null;
}

it('loads the exact decision Session title without loading its transcript or a Machine', async () => {
    const session = createSessionFixture({ id: 'source-session', metadata: { path: '/project', host: 'host', summary: { text: 'Scoped source title', updatedAt: 1 } } });
    homes.answer(serverId, '/v2/sessions/source-session', { body: createPlainSessionByIdResponseFixture(session) });
    const screen = await renderScreen(<MemoryFactDetail testID="fact" fact={decision()} documentRef={null} serverId={serverId} viewerAccountId="alice" archived={false} />);
    await waitForHomeGovernance(() => expect(sourceTitle(screen)).toBe('Scoped source title'));
    expect(homes.requests.some(request => request.path.includes('/messages') || request.path.startsWith('/v1/machines'))).toBe(false);
});

it('opens distinct committed decision messages in the same Session while retaining legacy Session-only links', async () => {
    homes.answer(serverId, '/v2/sessions/source-session', { status: 403, body: { error: 'forbidden' } });
    const opened = vi.fn();
    for (const messageId of ['committed-first', 'committed-second']) {
        const fact = decision();
        if (!fact.decision || fact.decision.sourceMessageRef.kind !== 'session') throw new Error('Expected Session source');
        fact.decision.sourceMessageRef.messageId = messageId;
        const screen = await renderScreen(<MemoryFactDetail testID="fact" fact={fact} documentRef={null} serverId={serverId}
            viewerAccountId="alice" archived={false} onOpenSession={opened} />);
        await screen.pressByTestIdAsync('fact.source');
        expect(opened).toHaveBeenLastCalledWith({ serverId, sessionId: 'source-session', messageId });
        await screen.unmount();
    }
    const fact = { ...decision(), decision: undefined, sourceSessionRef: { serverId, sessionId: 'source-session' } };
    const screen = await renderScreen(<MemoryFactDetail testID="fact" fact={fact} documentRef={null} serverId={serverId}
        viewerAccountId="alice" archived={false} onOpenSession={opened} />);
    await screen.pressByTestIdAsync('fact.source');
    expect(opened).toHaveBeenLastCalledWith({ serverId, sessionId: 'source-session' });
});

it('does not use a different legacy Session as the decision source when the real source is denied', async () => {
    const legacy = createSessionFixture({ id: 'legacy-session', metadata: { path: '/project', host: 'host', summary: { text: 'Unrelated legacy title', updatedAt: 1 } } });
    getStorage().getState().applySessions([legacy]);
    homes.answer(serverId, '/v2/sessions/source-session', { status: 403, body: { error: 'forbidden' } });
    const fact = { ...decision(), sourceSessionRef: { serverId, sessionId: legacy.id } };
    const screen = await renderScreen(<MemoryFactDetail testID="fact" fact={fact} documentRef={null} serverId={serverId} viewerAccountId="alice" archived={false} />);
    await waitForHomeGovernance(() => expect(homes.requests.some(request => request.path.startsWith('/v2/sessions/source-session'))).toBe(true));
    expect(sourceTitle(screen)).not.toBe('Unrelated legacy title');
});

it('keeps a retained title for the exact source private after the current source read is denied', async () => {
    const session = createSessionFixture({ id: 'source-session', encryptionMode: 'plain',
        metadata: { path: '/private', host: 'host', summary: { text: 'Retained private source title', updatedAt: 1 } } });
    getStorage().getState().applySessions([session]);
    homes.answer(serverId, '/v2/sessions/source-session', { status: 403, body: { error: 'forbidden' } });
    const screen = await renderScreen(<MemoryFactDetail testID="fact" fact={decision()} documentRef={null}
        serverId={serverId} viewerAccountId="alice" archived={false} />);
    await waitForHomeGovernance(() => expect(homes.requests.some(request => request.path.startsWith('/v2/sessions/source-session'))).toBe(true));
    await flushHookEffects();
    expect(sourceTitle(screen)).not.toBe('Retained private source title');
    expect(getStorage().getState().sessions['source-session']?.metadata?.summary?.text).toBe('Retained private source title');
});

it('discards an in-flight source title when the admitting Account retires', async () => {
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const session = createSessionFixture({ id: 'source-session', metadata: { path: '/project', host: 'host',
        summary: { text: 'Retired private title', updatedAt: 1 } } });
    homes.answer(serverId, '/v2/sessions/source-session', { select: () => {
        entered.resolve();
        return { body: createPlainSessionByIdResponseFixture(session), respondAfter: release.promise };
    } });
    const screen = await renderScreen(<MemoryFactDetail testID="fact" fact={decision()} documentRef={null} serverId={serverId} viewerAccountId="alice" archived={false} />);
    await entered.promise;
    await act(async () => { await TokenStorage.removeCredentialsForServerUrl('https://memory-source.test', { serverId }); });
    await act(async () => { release.resolve(); });
    await flushHookEffects();
    expect(sourceTitle(screen)).not.toBe('Retired private title');
    expect(getStorage().getState().sessions['source-session']).toBeUndefined();
});

it('keeps an unknown source Home generic without borrowing the focused Home credentials', async () => {
    const fact = decision();
    if (!fact.decision || fact.decision.sourceMessageRef.kind !== 'session') throw new Error('Expected Session decision');
    fact.decision.sourceMessageRef.session.serverId = 'unknown-source-home';
    const screen = await renderScreen(<MemoryFactDetail testID="fact" fact={fact} documentRef={null} serverId={serverId} viewerAccountId="alice" archived={false} />);
    await flushHookEffects();
    expect(sourceTitle(screen)).toBeTruthy();
    expect(homes.requests.some(request => request.path.includes('/sessions/source-session'))).toBe(false);
});

it.each(['session', 'discussion'] as const)('rechecks an admitted %s title on its Home change and removes it after source access is revoked', async kind => {
    const session = createSessionFixture({ id: 'source-session', metadata: { path: '/project', host: 'host',
        summary: { text: 'Scoped source title', updatedAt: 1 } } });
    const initialTitle = kind === 'session' ? 'Scoped source title' : 'Decision discussion';
    const path = kind === 'session' ? '/v2/sessions/source-session' : '/v1/discussions/source-discussion';
    const sourceId = kind === 'session' ? 'source-session' : 'source-discussion';
    let revoked = false;
    let reads = 0;
    homes.answer(serverId, path, { select: () => {
        reads++;
        return revoked ? { status: 403, body: { error: 'forbidden' } }
            : { body: kind === 'session' ? createPlainSessionByIdResponseFixture(session) : { discussion: sourceDiscussion() } };
    } });
    const screen = await renderScreen(<MemoryFactDetail testID="fact" fact={kind === 'session' ? decision() : discussionDecision()}
        documentRef={null} serverId={serverId} viewerAccountId="alice" archived={false} />);
    await waitForHomeGovernance(() => expect(sourceTitle(screen)).toBe(initialTitle));
    const admittedReads = reads;
    await act(async () => {
        publishHomeAccountChange(serverId, [sourceId], { changeKinds: ['artifact'] });
        publishHomeAccountChange(serverId, ['unrelated-source'], { changeKinds: [kind] });
    });
    await flushHookEffects();
    expect(reads).toBe(admittedReads);
    expect(sourceTitle(screen)).toBe(initialTitle);
    revoked = true;
    await act(async () => { publishHomeAccountChange(serverId, [sourceId], { changeKinds: [kind] }); });
    expect(sourceTitle(screen)).not.toBe(initialTitle);
    await waitForHomeGovernance(() => expect(reads).toBeGreaterThan(admittedReads));
    await flushHookEffects();
    expect(sourceTitle(screen)).toBeTruthy();
    expect(sourceTitle(screen)).not.toBe(initialTitle);
});
