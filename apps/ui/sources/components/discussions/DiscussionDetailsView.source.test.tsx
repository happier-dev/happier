import 'fake-indexeddb/auto';
// Enter the shared Action graph through its policy owner; the current catalog/request cycle
// evaluates declaration-derived policy arrays while initializing the opposite import direction.
import '@happier-dev/protocol/actions/actionApprovalPolicy';
import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act, createDeferred, flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { createPlainSessionCurrentProjectionRecordFixture, createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, answerDiscussionThreadForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { SessionCurrentProjectionRecordV1Schema } from '@happier-dev/protocol/sessions/listing/response';
import { projectSessionAccessCapabilitiesV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import { SessionOrganizationSnapshotResponseSchema } from '@happier-dev/protocol/sessions/organization/snapshot';
import { DiscussionParticipantsListResponseV1Schema } from '@happier-dev/protocol/discussions/participants';

const pushed = vi.hoisted(() => vi.fn());
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ router: { push: pushed } }).module);
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
// The vendor's browser Markdown adapter is outside this native platform harness.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: (text: string) => [{ text, reveal: false }],
}));
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { DiscussionDetailsView } = await import('./DiscussionDetailsView');
const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
const { SurfaceStateSizeProvider } = await import('@/components/ui/surfaces/surfaceStateSize');
const { createDiscussionClient } = await import('@/sync/api/discussions/discussionActions');
const { getStorage } = await import('@/sync/domains/state/storage');
const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
const { t } = await import('@/text');
const { prepareSessionDraftPersistenceStorage } = await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage');
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
afterEach(async () => {
    await standardCleanup();
    await connection?.dispose();
    connection = undefined;
    await homes.reset();
    pushed.mockClear();
});

it.each(['readable', 'deferred', 'alias', 'foreign_home', 'archived', 'missing', 'denied', 'key_unavailable', 'retired', 'phone'] as const)(
    'keeps shared Discussion navigation and cold source behavior (%s)', async mode => {
    const serverUrl = `https://cold-discussion-source-${mode}.test`;
    const serverIdentityId = `srv_cold_discussion_source_${mode}`;
    const localServerId = await homes.addHome({ name: 'Review Home', serverUrl, serverIdentityId, accountId: 'alice', currentAccount: true });
    const serverId = resolveServerProfileScopeIdForIdentifier(localServerId);
    const features = createRootLayoutFeaturesResponse({ features: { sessions: { enabled: true, conversations: { enabled: true } } } });
    homes.answer(serverId, '/v1/features', { body: features });
    homes.answer(serverId, '/v1/features/authenticated', { body: features });
    primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
    homes.answer(serverId, '/v2/cursor', { body: { cursor: 0, changesFloor: 0 } });
    homes.answer(serverId, '/v2/sessions', { body: { sessions: [], nextCursor: null, hasNext: false } });
    homes.answer(serverId, '/v2/sessions/active', { body: { sessions: [], nextCursor: null, hasNext: false } });
    homes.answer(serverId, '/v2/sessions/metadata-upgrades', { body: { sessionIds: [] } });
    homes.answer(serverId, '/v2/session-organization', { body: SessionOrganizationSnapshotResponseSchema.parse({ snapshot: {
        schemaVersion: 1, version: 0, pins: [], folders: [], folderAssignments: [], tags: [], tagAssignments: [], orderEntries: [], labels: [],
    } }) });
    const sourceId = 'never-opened-source';
    let source = createPlainSessionCurrentProjectionRecordFixture({ id: sourceId,
        metadata: { name: 'Release review', path: '/release', host: 'review-box' } });
    if (mode === 'archived') source = { ...source, archivedAt: 1 };
    if (mode === 'key_unavailable') {
        const { ownerMetadata: _ownerMetadata, ...recipientSource } = source;
        source = SessionCurrentProjectionRecordV1Schema.parse({ ...recipientSource,
        encryptionMode: 'e2ee', metadata: 'unopenable-encrypted-metadata', dataEncryptionKey: null,
        share: { accessLevel: 'view', canApprovePermissions: false },
        effectiveAccess: { v: 1, level: 'view', sources: [{ kind: 'direct', shareId: 'source-share' }],
            capabilities: projectSessionAccessCapabilitiesV1({ owner: false, grants: [{ accessLevel: 'view', canApprovePermissions: false }] }) },
        });
    }
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    homes.answer(serverId, `/v2/sessions/${sourceId}`, { select: () => {
        entered.resolve();
        return { ...(['retired', 'deferred'].includes(mode) ? { respondAfter: release.promise } : {}),
            ...(mode === 'missing' ? { status: 404, body: { error: 'Session not found' } }
                : mode === 'denied' ? { status: 403, body: { error: 'forbidden' } } : { body: { session: source } }) };
    } });
    const thread = answerDiscussionThreadForTests(homes, serverId, { loseCreate: false, loseFirstRejoin: false });
    homes.answer(serverId, '/v1/discussions/committed-thread/participants', { body: DiscussionParticipantsListResponseV1Schema.parse({
        discussionId: 'committed-thread', ownerAccountId: 'alice', access: 'owner', grants: [], participants: [],
    }) });
    connection = await restoreServerAccountForTest({ serverUrl, serverIdentityId, accountId: 'alice', request: createSessionReadBatchFetchBoundary(homes.request) });
    await prepareSessionDraftPersistenceStorage();
    const client = createDiscussionClient({ scope: { serverId, accountId: 'alice' }, availability: 'available' });
    const created = await client.create({ creationLocalId: 'cold-source-room', messageLocalId: 'cold-source-quote', title: 'Release discussion',
        anchor: { kind: 'session', sessionId: sourceId, messageId: 'exact/answer' },
        content: { v: 1, parts: [{ t: 'text', text: 'The original answer.' }] } });
    if (created.kind !== 'succeeded') throw new Error(JSON.stringify(created));
    expect(thread.stored()?.discussion.anchor).toMatchObject({ sessionId: sourceId });
    expect(getStorage().getState().sessions[sourceId]).toBeUndefined();
    expect(getStorage().getState().sessionListRowsByServerId[serverId]?.[sourceId]).toBeUndefined();
    if (mode === 'foreign_home') getStorage().setState({ sessions: { [sourceId]: createSessionFixture({ id: sourceId, serverId: 'another-home',
        metadata: { name: 'Other Home secret', path: '/other', host: 'other' } }) } });
    const screen = await renderScreen(<AppPaneProvider><SurfaceStateSizeProvider size={mode === 'phone' ? 'phone' : 'pane'}><DiscussionDetailsView target={{ kind: 'discussion', address: { serverId: mode === 'alias' ? localServerId : serverId }, discussionId: created.value.discussion.id }} active standaloneSurface={mode === 'phone'} /></SurfaceStateSizeProvider></AppPaneProvider>);
    await vi.waitFor(() => expect(screen.getTextContent()).toContain('Release discussion'));
    if (mode === 'phone') {
        await vi.waitFor(() => expect(screen.findHostByTestId('session-discussion-invite')).not.toBeNull());
        expect(screen.findHostByTestId('session-discussion-header')).not.toBeNull();
        return;
    }
    await vi.waitFor(() => expect(screen.getTextContent()).toContain(t('session.collaboration.discussion.participants.invitedOnly')));
    try {
    await vi.waitFor(() => expect(homes.requests.some(request => new URL(request.path, serverUrl).pathname === `/v2/sessions/${sourceId}`)).toBe(true));
    await entered.promise;
    if (mode === 'deferred') {
        await flushHookEffects();
        expect(screen.findHostByTestId('session-discussion-anchor')).toBeNull();
        expect(screen.getTextContent()).not.toContain(t('session.collaboration.discussion.quote.unavailable'));
        await act(async () => { release.resolve(); });
    }
    if (mode === 'retired') {
        await act(async () => { await connection?.dispose(); connection = undefined; release.resolve(); });
        await flushHookEffects();
        expect(getStorage().getState().sessions[sourceId]).toBeUndefined();
    }
    if (['archived', 'missing', 'denied', 'key_unavailable', 'retired'].includes(mode)) {
        if (mode === 'archived') await vi.waitFor(() => expect(getStorage().getState().sessions[sourceId]?.archivedAt).toBe(1));
        if (mode === 'key_unavailable') await vi.waitFor(() => expect(getStorage().getState().sessions[sourceId]?.encryptedContentAvailability).toBe('recipient_encryption_setup_required'));
        await flushHookEffects();
        expect(screen.findHostByTestId('session-discussion-anchor')).toBeNull();
        if (mode !== 'retired') await vi.waitFor(() => expect(screen.getTextContent()).toContain(t('session.collaboration.discussion.quote.unavailable')));
        expect(pushed).not.toHaveBeenCalled();
        return;
    }
    await vi.waitFor(() => expect(screen.findHostByTestId('session-discussion-anchor')).not.toBeNull());
    expect(screen.getTextContent()).not.toContain('Other Home secret');
    await screen.pressByTestIdAsync('session-discussion-anchor');
    expect(pushed).toHaveBeenLastCalledWith(`/session/${sourceId}/message/server%3Aexact%2Fanswer?serverId=${serverId}`);
    expect(homes.requests.some(request => request.path.includes(`/sessions/${sourceId}/messages`))).toBe(false);
    if (mode === 'readable') {
        const retainedPress = screen.findHostByTestId('session-discussion-anchor')?.props.onPress;
        expect(typeof retainedPress).toBe('function');
        const opened = getStorage().getState().sessions[sourceId];
        if (!opened) throw new Error('Expected the authorized cold source to be hydrated');
        await act(async () => { getStorage().getState().applySessions([{ ...opened, archivedAt: 2 }]); });
        expect(screen.findHostByTestId('session-discussion-anchor')).toBeNull();
        pushed.mockClear();
        await act(async () => { retainedPress(); });
        expect(pushed).not.toHaveBeenCalled();
    }
    } finally { release.resolve(); }
});
