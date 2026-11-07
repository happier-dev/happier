import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act, renderScreen, standardCleanup } from '@/dev/testkit';
import { createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createSkillsSurfaceHarness } from '@/dev/testkit/harness/skillsSurfaceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
installDisconnectedServerSocketBoundary();
const { useSkillMakers } = await import('./useSkillMakers');
afterEach(standardCleanup);

it('keeps maker consumers idle for unrelated creator pushes and publishes changed identity and access', async () => {
    const home = await createSkillsSurfaceHarness('https://skills-maker-locality.test');
    const item = { creator: { kind: 'agent' as const, accountId: home.scope.accountId, sessionId: 'maker' } };
    const items = [item];
    let row = createSessionListRenderableSessionFixture({ id: 'maker', metadata: {
        path: '/project', name: 'Researcher', bot: { kind: 'bot' },
    } });
    const publish = () => home.storage.setState({ sessionListRowsByServerId: {
        [home.scope.serverId]: { maker: row },
    } });
    publish();
    let commits = 0;
    const presented: { current: ReturnType<ReturnType<typeof useSkillMakers>> | null } = { current: null };
    function Consumer() {
        const makerFor = useSkillMakers(items, home.scope);
        presented.current = makerFor(item);
        return null;
    }
    const screen = await renderScreen(<React.Profiler id="maker" onRender={() => commits++}><Consumer /></React.Profiler>);
    try {
        expect(presented.current).toMatchObject({ kind: 'bot', label: 'Researcher', openSessionId: 'maker' });
        const reads = home.requests.length;
        commits = 0;
        await act(async () => {
            row = { ...row, metadataVersion: (row.metadataVersion ?? 0) + 1, agentStateVersion: (row.agentStateVersion ?? 0) + 1,
                updatedAt: row.updatedAt + 1 };
            publish();
        });
        expect(commits).toBe(0);
        await act(async () => { row = { ...row, metadata: { ...row.metadata!, name: 'Writer' } }; publish(); });
        expect(presented.current).toMatchObject({ kind: 'bot', label: 'Writer', openSessionId: 'maker' });
        expect(commits).toBe(1);
        await act(async () => { row = { ...row, latestTurnStatus: 'failed', latestTurnStatusObservedAt: 42 }; publish(); });
        expect(presented.current?.face).toMatchObject({ restingMood: 'failed', failedAt: 42 });
        expect(commits).toBe(2);
        await act(async () => { row = { ...row, access: null }; publish(); });
        expect(presented.current).toMatchObject({ kind: 'session', openSessionId: null, face: null });
        expect(commits).toBe(3);
        expect(home.requests.length).toBe(reads);
    } finally { await screen.unmount(); await home.dispose(); }
});

it('conceals a hidden maker identity while keeping its configured maker filter', async () => {
    const home = await createSkillsSurfaceHarness('https://skills-maker-privacy.test');
    const item = { creator: { kind: 'agent' as const, accountId: home.scope.accountId, sessionId: 'maker' } };
    const items = [item];
    const row = createSessionListRenderableSessionFixture({ id: 'maker', metadata: {
        path: '/private-project', name: 'Private researcher', bot: { kind: 'bot' },
    } });
    home.storage.setState({ sessionListRowsByServerId: { [home.scope.serverId]: { maker: row } } });
    home.storage.getState().applySettingsLocal({ sessionListHiddenTagIdsWhileRecording: { [home.scope.serverId]: ['private'] } });
    home.storage.getState().setSessionTagAssignmentsOptimistic(home.scope.serverId, 'maker', ['private']);
    const { setScreenSharingPrivacyActive } = await import('@/desktop/capture/useNativeRecordingActive');
    const presented: { current: ReturnType<ReturnType<typeof useSkillMakers>> | null } = { current: null };
    function Consumer() {
        presented.current = useSkillMakers(items, home.scope)(item);
        return null;
    }
    const screen = await renderScreen(<Consumer />);
    try {
        expect(presented.current).toMatchObject({ label: 'Private researcher', openSessionId: 'maker' });
        const filters = presented.current?.filterValues;
        await act(async () => { setScreenSharingPrivacyActive(true); });
        expect(presented.current?.label).not.toBe('Private researcher');
        expect(presented.current).toMatchObject({ openSessionId: 'maker', face: null, filterValues: filters });
        await act(async () => { setScreenSharingPrivacyActive(false); });
        expect(presented.current).toMatchObject({ label: 'Private researcher', openSessionId: 'maker' });
    } finally { setScreenSharingPrivacyActive(false); await screen.unmount(); await home.dispose(); }
});
