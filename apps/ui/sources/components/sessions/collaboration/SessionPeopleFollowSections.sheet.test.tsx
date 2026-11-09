import * as React from 'react';
import { act } from 'react-test-renderer';
import { Dimensions } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { standardCleanup } from '@/dev/testkit';
import { activateStorageAccountScope } from '@/dev/testkit/mocks/storage';
import { createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { renderSettingsView } from '@/dev/testkit/harness/settingsViewHarness';

// The Follow list transport and the router are the boundaries; the sheet, editors, controllers and panels stay real.
const api = vi.hoisted(() => ({ list: vi.fn(), followers: vi.fn(), remove: vi.fn(), set: vi.fn() }));
const followState = vi.hoisted(() => ({ rows: {} as Record<string, unknown> }));
const router = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({ useFeatureEnabled: () => true }));
vi.mock('@/components/ui/popover', async (importOriginal) => (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal));
vi.mock('@/sync/api/session/sessionFollowSourcesApi', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    listSessionFollowSources: api.list,
    listSessionFollowers: api.followers,
    removeSessionFollowSource: api.remove,
    setSessionFollowSource: api.set,
}));
vi.mock('@/sync/api/session/sessionFollowApi', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    executeSessionFollowAction: async () => ({ kind: 'failed', error: 'unavailable' }),
}));
vi.mock('@/components/appShell/workspace/destinationRoute', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    useRouter: () => router,
}));
vi.mock('@/text', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    t: (key: string, params?: { title?: string }) => params?.title ? `${key}:${params.title}` : key,
}));
vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({ useSessionListRowsByServerId: () => followState.rows, useServerScopedMachine: () => null });
});

import type { FollowSourceRelationV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowSourcesApi';
import { projectSessionFollowerCensus, SessionPeopleFollowSections, SessionPeopleFollowSheet } from './SessionPeopleFollowSections';

const target = { serverId: 'home-a', sessionId: 'this' } as const;
type Screen = Awaited<ReturnType<typeof renderSettingsView>>;

/**
 * The Followers sheet over a real census projection. The pane's reverse read needs a stored Home credential this
 * harness doesn't provide, so the sheet receives the projection that read would produce.
 */
function FollowersSheet(props: Readonly<{
    sources: readonly FollowSourceRelationV1[] | null;
    followersError?: string | null;
    refreshFollowers?: () => void;
}>) {
    const anchorRef = React.useRef(null);
    const focusReturnRef = React.useRef(null);
    const people = {
        enabled: true,
        census: projectSessionFollowerCensus(props.sources ? { sources: props.sources, follows: [], peopleCount: 1 } : null),
        followersLoading: false,
        followersError: props.followersError ?? null,
        refreshFollowers: props.refreshFollowers ?? (() => {}),
        following: { projection: null, loading: false, error: null, refresh: async () => {},
            ruleInputs: { snapshot: null, lifetime: null, accountId: undefined, refresh: async () => null, loading: false } },
        youLevel: 'quiet' as const,
        youLoading: false,
    };
    return <SessionPeopleFollowSheet target={target} machineId={null} direction="followers" people={people}
        host={{ kind: 'panel', anchorRef, focusReturnRef, onClose: () => {} }} />;
}

async function press(screen: Screen, testID: string) {
    await vi.waitFor(() => expect(screen.findAllByTestId(testID).some((node) => typeof node.props.onPress === 'function'), testID).toBe(true));
    const node = screen.findAllByTestId(testID).find((candidate) => typeof candidate.props.onPress === 'function');
    await act(async () => { node?.props.onPress?.(); await Promise.resolve(); });
}

let account: Awaited<ReturnType<typeof activateStorageAccountScope>> | undefined;
afterEach(() => { standardCleanup(); account?.dispose(); account = undefined; vi.restoreAllMocks(); });

describe('People Follow summary rows and their sheet', () => {
    beforeEach(async () => {
        account = await activateStorageAccountScope({ serverId: 'home-a', accountId: 'follow-account' });
        api.list.mockReset(); api.followers.mockReset(); api.remove.mockReset(); api.set.mockReset(); router.push.mockReset();
        // This session follows "worker"; "lead" follows this session (its own list holds that edge).
        api.list.mockImplementation(async ({ sessionId }: { sessionId: string }) => ({ kind: 'ok', value: { sources: sessionId === 'this'
            ? [{ sourceSessionId: 'worker', destinationSessionId: 'this', policy: { preset: 'quiet' }, deliveryState: 'eligible', hasPendingUpdates: false }]
            : [{ sourceSessionId: 'this', destinationSessionId: 'lead', policy: { preset: 'quiet' }, deliveryState: 'eligible', hasPendingUpdates: false }], rules: [] } }));
        api.followers.mockResolvedValue({ kind: 'ok', value: { sources: [
            { sourceSessionId: 'this', destinationSessionId: 'lead', relation: 'follower', policy: { preset: 'quiet' }, deliveryState: 'eligible', hasPendingUpdates: false },
        ], follows: [], peopleCount: 2 } });
        api.set.mockResolvedValue({ kind: 'ok', value: { changed: true } });
        followState.rows = { 'home-a': {
            lead: createSessionListRenderableSessionFixture({ id: 'lead', metadata: { name: 'Daily coordinator', path: '/repo' } }),
            worker: createSessionListRenderableSessionFixture({ id: 'worker', metadata: { name: 'Payments worker', path: '/repo' } }),
        } };
    });

    it('on a wide window: each summary opens one sheet in its direction, rows step in place with Back, Done closes', async () => {
        const screen = await renderSettingsView(<SessionPeopleFollowSections target={target} session={null} />);
        // The pane holds summaries, not the expanded lists.
        await vi.waitFor(() => expect(screen.findByTestId('session-people-following-summary')).not.toBeNull());
        expect(screen.findByTestId('session-people-followers-summary')).not.toBeNull();
        expect(screen.findByTestId('session-follow-source-worker')).toBeNull();
        expect(screen.findByTestId('session-people-follower-session-lead')).toBeNull();

        // Following: the sheet lists the source; its row replaces the list with that source's panel, in the same sheet.
        await press(screen, 'session-people-following-summary');
        expect(screen.findByTestId('session-people-follow-sheet')).not.toBeNull();
        await press(screen, 'session-follow-source-worker');
        await vi.waitFor(() => expect(screen.findAllByTestId('session-follow-source-worker-policy.preset.important').length).toBeGreaterThan(0));
        // One sheet: the row's panel replaced the list in place rather than floating over it.
        expect(screen.findByTestId('session-people-follow-sheet')).not.toBeNull();
        expect(screen.findByTestId('session-follow-source-worker-panel')).toBeNull();
        expect(screen.findByTestId('session-follow-source-worker')).toBeNull();
        expect(router.push).not.toHaveBeenCalled();
        await press(screen, 'session-people-follow-sheet-back');
        await vi.waitFor(() => expect(screen.findByTestId('session-follow-source-worker')).not.toBeNull());
        await press(screen, 'session-people-follow-sheet-done');
        expect(screen.findByTestId('session-people-follow-sheet')).toBeNull();
        await screen.unmount();
    });

    it('in the Followers sheet: a follower opens its own Follow panel for this pair in place, and Done returns to the list', async () => {
        const screen = await renderSettingsView(<FollowersSheet sources={[
            { sourceSessionId: 'this', destinationSessionId: 'lead', relation: 'follower', policy: { preset: 'quiet' }, deliveryState: 'eligible', hasPendingUpdates: false },
        ]} />);
        // The follower's row opens its own Follow panel for this pair (not the follower Session) and writes its edge.
        await press(screen, 'session-people-follower-session-lead');
        await vi.waitFor(() => expect(screen.findAllByTestId('session-follow-source-this-policy.preset.important').length).toBeGreaterThan(0));
        expect(api.list.mock.calls.map(([address]) => address)).toContainEqual({ serverId: 'home-a', sessionId: 'lead' });
        expect(screen.getTextContent()).toContain('session.follow.sources.followsThis:');
        await press(screen, 'session-follow-source-this-policy.preset.important');
        expect(api.set).toHaveBeenCalledWith(expect.objectContaining({ destinationSessionId: 'lead', sourceSessionId: 'this' }));
        // Done in a step returns to the list it came from.
        await press(screen, 'session-follow-source-this-done');
        await vi.waitFor(() => expect(screen.findByTestId('session-people-follower-session-lead')).not.toBeNull());
        expect(router.push).not.toHaveBeenCalled();
        await screen.unmount();
    });

    it('says where a manager-only follower is changed instead of offering an editor that would write an ordinary follow', async () => {
        const screen = await renderSettingsView(<FollowersSheet sources={[
            { sourceSessionId: 'this', destinationSessionId: 'lead', relation: 'manager', policy: { preset: 'important' }, deliveryState: 'eligible', hasPendingUpdates: false },
        ]} />);
        await press(screen, 'session-people-follower-session-lead');
        expect(screen.getTextContent()).toContain('session.follow.sources.managerOnly');
        expect(screen.findByTestId('session-people-follow-sheet-back')).not.toBeNull();
        expect(api.list.mock.calls.map(([address]) => address)).not.toContainEqual({ serverId: 'home-a', sessionId: 'lead' });
        expect(router.push).not.toHaveBeenCalled();
        await screen.unmount();
    });

    it('opens the Following sheet for an "Edit what it follows" request, again when repeated, and never without one', async () => {
        const request = (direction: 'followers' | 'following') => ({ direction });
        const screen = await renderSettingsView(<SessionPeopleFollowSections target={target} session={null} openRequest={null} />);
        await vi.waitFor(() => expect(screen.findByTestId('session-people-following-summary')).not.toBeNull());
        // Ordinary People navigation stays closed.
        expect(screen.findByTestId('session-people-follow-sheet')).toBeNull();

        await screen.update(<SessionPeopleFollowSections target={target} session={null} openRequest={request('following')} />);
        await vi.waitFor(() => expect(screen.findByTestId('session-follow-source-worker')).not.toBeNull());
        expect(screen.findByTestId('session-people-follow-sheet')).not.toBeNull();
        await press(screen, 'session-people-follow-sheet-done');
        expect(screen.findByTestId('session-people-follow-sheet')).toBeNull();

        // The same request issued again (a new one-shot intent) opens it again.
        await screen.update(<SessionPeopleFollowSections target={target} session={null} openRequest={request('following')} />);
        await vi.waitFor(() => expect(screen.findByTestId('session-people-follow-sheet')).not.toBeNull());
        expect(router.push).not.toHaveBeenCalled();
        await screen.unmount();
    });

    it('on a phone: an "Edit what it follows" request pushes the Following page', async () => {
        vi.spyOn(Dimensions, 'get').mockReturnValue({ width: 390, height: 844, scale: 3, fontScale: 1 });
        const screen = await renderSettingsView(<SessionPeopleFollowSections target={target} session={null} openRequest={{ direction: 'following' }} />);
        await vi.waitFor(() => expect(router.push).toHaveBeenCalledTimes(1));
        expect(String(router.push.mock.calls[0]?.[0])).toContain('/follow-people');
        expect(String(router.push.mock.calls[0]?.[0])).toContain('direction=following');
        expect(screen.findByTestId('session-people-follow-sheet')).toBeNull();
        await screen.unmount();
    });

    it('says a failed Followers read could not be checked, with Retry, instead of showing only you', async () => {
        // The reverse read cannot bind a Home credential in this harness, so it settles unavailable, as a failed read does.
        const pane = await renderSettingsView(<SessionPeopleFollowSections target={target} session={null} />);
        await press(pane, 'session-people-followers-summary');
        await vi.waitFor(() => expect(pane.findByTestId('session-people-followers-error')).not.toBeNull());
        expect(pane.findByTestId('session-people-follower-you')).not.toBeNull();
        await pane.unmount();

        // Retry re-reads through the followers owner; a failed refresh keeps the last-known rows beside it.
        const refreshFollowers = vi.fn();
        const sheet = await renderSettingsView(<FollowersSheet sources={null} followersError="unavailable" refreshFollowers={refreshFollowers} />);
        await press(sheet, 'session-people-followers-error');
        expect(refreshFollowers).toHaveBeenCalledTimes(1);
        await sheet.unmount();
        const retained = await renderSettingsView(<FollowersSheet followersError="unavailable" sources={[
            { sourceSessionId: 'this', destinationSessionId: 'lead', relation: 'follower', policy: { preset: 'quiet' }, deliveryState: 'eligible', hasPendingUpdates: false },
        ]} />);
        await vi.waitFor(() => expect(retained.findByTestId('session-people-follower-session-lead')).not.toBeNull());
        expect(retained.findByTestId('session-people-followers-error')).not.toBeNull();
        await retained.unmount();
    });

    it('on a phone: a summary pushes the directional page instead of floating a panel', async () => {
        vi.spyOn(Dimensions, 'get').mockReturnValue({ width: 390, height: 844, scale: 3, fontScale: 1 });
        const screen = await renderSettingsView(<SessionPeopleFollowSections target={target} session={null} />);
        await press(screen, 'session-people-following-summary');
        expect(screen.findByTestId('session-people-follow-sheet')).toBeNull();
        expect(router.push).toHaveBeenCalledWith(expect.stringContaining('/follow-people'));
        expect(String(router.push.mock.calls[0]?.[0])).toContain('direction=following');
        await press(screen, 'session-people-followers-summary');
        expect(String(router.push.mock.calls[1]?.[0])).toContain('direction=followers');
        await screen.unmount();
    });
});
