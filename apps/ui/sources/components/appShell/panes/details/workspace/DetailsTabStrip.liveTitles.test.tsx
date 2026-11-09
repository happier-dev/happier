import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DiscussionOpenedSummaryV1 } from '@happier-dev/protocol/discussions/actions';

import { renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { installPanelCommonModuleMocks } from '@/components/ui/panels/panelTestHelpers';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { storage } from '@/sync/domains/state/storage';
import { upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { getDiscussionRepository, retireDiscussionRepository, clearDiscussionRepositoryRegistryForTests } from '@/sync/ops/discussions/discussionRepositoryRegistry';
import { useDestinationInstanceTitles, type DestinationInstanceTitleEntry } from '@/components/appShell/destinations/compactAppDestinationCatalog';
import type { DiscussionRepositoryClient } from '@/sync/ops/discussions/discussionRepository';
import { createSessionDiscussionDetailsTab } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';
import { DetailsTabStrip } from './DetailsTabStrip';
import type { DetailsTabState } from './detailsWorkspaceTypes';

installPanelCommonModuleMocks();
vi.mock('socket.io-client', async (importOriginal) => {
    const { createSocketIoClientBoundary } = await import('@/dev/testkit/harness/serverAccountConnectionHarness');
    return createSocketIoClientBoundary(importOriginal);
});
vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});
// Secure credential storage is the system boundary; Home/Account resolution stays real.
vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => {
    const { createTokenStorageModuleMock } = await import('@/dev/testkit/mocks/tokenStorage');
    return createTokenStorageModuleMock({ importOriginal, tokenStorage: {
        getCredentialsForServerUrl: async () => ({ token: `header.${Buffer.from(JSON.stringify({ sub: 'titles-account' })).toString('base64')}.signature`, secret: 'test-secret' }),
    } });
});

// The app entry now registers the real Sync runtime before any Session surface
// can demand content. Reproduce that boot with only HTTP/Socket boundaries.
installHomeGovernanceBoundaries(createHomeGovernanceHarness());
await loadSyncSingletonForTests();

afterEach(() => {
    standardCleanup();
    clearDiscussionRepositoryRegistryForTests();
    storage.setState(storage.getInitialState(), true);
});

async function renderStrip(tab: DetailsTabState, sessionId: string, serverId?: string) {
    const props = {
        sessionId, serverId,
        pane: { setActiveDetailsTab: vi.fn(), pinDetailsTab: vi.fn(), unpinDetailsTab: vi.fn(), closeDetailsTab: vi.fn() },
        group: { id: 'titles', tabKeys: [tab.key], activeTabKey: tab.key, tabs: [tab], isFocused: true },
    };
    return renderScreen(<DetailsTabStrip {...props} />);
}

function text(screen: Awaited<ReturnType<typeof renderScreen>>) {
    return screen.root.findAll(node => typeof node.props.children === 'string').map(node => node.props.children);
}

describe('Details live instance titles', () => {
    it('uses the session title owner and updates a retained tab after rename', async () => {
        const named = (name: string) => createSessionFixture({ id: 'titles-session', metadata: {
            path: '/project', host: 'tester', homeDir: '/home/tester', summary: { text: name, updatedAt: 1 },
        } });
        act(() => storage.getState().applySessions([named('Before rename')]));
        const screen = await renderStrip({ key: 'session-title', kind: 'session', title: 'Saved title', resource: null, isPinned: false, isPreview: false }, 'titles-session');
        expect(text(screen)).toContain('Before rename');
        await act(async () => storage.getState().applySessions([named('After rename')]));
        expect(text(screen)).toContain('After rename');
        expect(text(screen)).not.toContain('Before rename');
    });

    it('observes the canonical discussion source even when it arrives after the strip, without mounting a watcher', async () => {
        const profile = await upsertServerProfile({ serverUrl: 'https://titles.example.test', name: 'Titles' });
        const address = { serverId: profile.id, sessionId: 'titles-session' };
        const tab = { ...createSessionDiscussionDetailsTab({ kind: 'discussion', address, discussionId: 'd1', title: 'Saved discussion' }), isPinned: false, isPreview: false };
        const sibling = { ...createSessionDiscussionDetailsTab({ kind: 'discussion', address, discussionId: 'd2', title: 'Saved sibling' }), isPinned: false, isPreview: false };
        const resolveIcon = vi.fn((_tab: DetailsTabState) => 'circle');
        const screen = await renderScreen(<DetailsTabStrip sessionId={address.sessionId} serverId={address.serverId}
            pane={{ setActiveDetailsTab: vi.fn(), pinDetailsTab: vi.fn(), unpinDetailsTab: vi.fn(), closeDetailsTab: vi.fn() }}
            group={{ id: 'titles', tabKeys: [tab.key, sibling.key], activeTabKey: tab.key, tabs: [tab, sibling], isFocused: true }}
            resolveTabIconName={resolveIcon} />);
        expect(text(screen)).toContain('Saved discussion');
        const summary = (id: string, title: string): DiscussionOpenedSummaryV1 => ({
            id, ownerAccountId: 'titles-account', encryptionMode: 'plain', anchor: null,
            access: 'owner', keyReadiness: true, dataEncryptionKey: null, creationLocalId: null, title,
            latestMessage: { id: 'message-1', localId: null, seq: 1, authorAccountId: null, accountActor: null, producerV1: null, createdAt: 1 },
            messageSeq: 1, lastReadSeq: 1, unreadCount: 0, unreadMentionCount: 0, recentAuthorAccountIds: [], archivedAt: null,
            capabilities: { postMessages: true, rename: true, archive: true, restore: false, askAgent: true, sendToSession: true, manageAccess: true, leave: false },
        });
        // The repository's HTTP client is the boundary; summary application and notifications are real.
        let currentTitle = 'Live discussion';
        const unavailable = async () => ({ kind: 'failed' as const, errorCode: 'unavailable' });
        const client: DiscussionRepositoryClient = {
            list: async () => ({ kind: 'succeeded', value: { v: 1, serverId: address.serverId, discussions: [summary('d1', currentTitle), summary('d2', 'Sibling discussion')], nextCursor: null, incomplete: false } }),
            rename: async (_id, title) => { currentTitle = title; return { kind: 'succeeded', value: { v: 1, serverId: address.serverId, discussion: summary('d1', title) } }; },
            attention: unavailable, get: unavailable, read: unavailable, create: unavailable, post: unavailable, archive: unavailable, restore: unavailable, readState: unavailable,
            participants: unavailable, setParticipantPolicy: unavailable, invite: unavailable, inviteExecutableParticipant: unavailable, removeParticipant: unavailable, leave: unavailable,
            getSettings: unavailable, setSettings: unavailable,
            transferOwner: unavailable, listGrants: unavailable, setGrant: unavailable, removeGrant: unavailable,
        };
        const repository = getDiscussionRepository({ scope: { serverId: address.serverId, accountId: 'titles-account' }, address, client });
        await act(async () => repository.refreshList('active'));
        await vi.waitFor(() => expect(text(screen)).toContain('Live discussion'));
        expect(text(screen)).toContain('Sibling discussion');
        resolveIcon.mockClear();
        await act(async () => { await repository.rename('d1', 'Renamed discussion'); });
        expect(text(screen)).toContain('Renamed discussion');
        expect(text(screen)).toContain('Sibling discussion');
        expect(resolveIcon).toHaveBeenCalledOnce();
        expect(text(screen)).not.toContain('Live discussion');
        expect(repository.isMounted()).toBe(false);
        currentTitle = 'Other Account discussion';
        const otherAccount = getDiscussionRepository({ scope: { serverId: address.serverId, accountId: 'other-account' }, address, client });
        await act(async () => otherAccount.refreshList('active'));
        expect(text(screen)).toContain('Renamed discussion');
        expect(text(screen)).not.toContain('Other Account discussion');
        currentTitle = 'Renamed discussion';
        const entries: readonly DestinationInstanceTitleEntry[] = [
            { key: 'discussion', ref: { kind: 'sessionDetails', params: { id: address.sessionId, serverId: address.serverId, details: 'discussion', discussionId: 'd1' } } },
            { key: 'home-discussion', ref: { kind: 'discussions', params: { serverId: address.serverId, discussionId: 'd1', workspacePathname: '/discussions/d1' } } },
        ];
        const catalog = Object.freeze([]);
        const observer = await renderHook(() => useDestinationInstanceTitles(catalog, entries));
        await vi.waitFor(() => expect(observer.getCurrent().get('discussion')).toBe('Renamed discussion'));
        expect(observer.getCurrent().get('home-discussion')).toBe('Renamed discussion');
        const unchanged = observer.getCurrent();
        await act(async () => repository.refreshList('active'));
        expect(observer.getCurrent()).toBe(unchanged);
        act(() => retireDiscussionRepository({ scope: { serverId: address.serverId, accountId: 'titles-account' }, address }));
        expect(text(screen)).not.toContain('Renamed discussion');
        currentTitle = 'Replacement repository';
        const replacement = getDiscussionRepository({ scope: { serverId: address.serverId, accountId: 'titles-account' }, address, client });
        await act(async () => replacement.refreshList('active'));
        expect(text(screen)).toContain('Replacement repository');
        expect(replacement.isMounted()).toBe(false);
    });
});
