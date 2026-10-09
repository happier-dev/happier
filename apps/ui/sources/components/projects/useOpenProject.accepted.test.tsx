import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, standardCleanup } from '@/dev/testkit';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { installFileFindAccountBoundaryMocks } from '@/components/appShell/panes/fileFindSeedTestHelpers';
import { applyProjectAccountRowsFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { storage } from '@/sync/domains/state/storage';
import { useOpenProject } from './useOpenProject';

installFileFindAccountBoundaryMocks('home', 'account');
const push = vi.hoisted(() => vi.fn());
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: { push } }).module;
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles'); return createUnistylesMock();
});
function Wrapper(props: React.PropsWithChildren) { return React.createElement(AppPaneProvider, null, props.children); }
const ref = { id: 'checkout', serverId: 'home', machineId: 'machine', rootPath: '/repo', createdAtMs: 1 };

describe('accepted Project Open focus', () => {
    beforeEach(() => {
        standardCleanup(); push.mockReset(); storage.getState().activateProfileScope({ serverId: 'home', accountId: 'account' });
        applyProjectAccountRowsFixture(storage);
        storage.getState().applyLocalSettings({ projectLastActiveRootPathByWorkspaceRefId: { checkout: '/stale' },
            projectLastActiveWorktreeIdByWorkspaceRefId: { checkout: 'stale-worktree' } }, { persist: false });
    });
    it('uses the freshly admitted exact row and accepted directory, not a stale subscription or remembered checkout', async () => {
        const hook = await renderHook(() => useOpenProject(), { wrapper: Wrapper });
        // Refresh publication is real and may precede React's next render.
        applyProjectAccountRowsFixture(storage, { workspaceRefs: [ref] });
        expect(hook.getCurrent()(ref.id, { workspaceAddress: { serverId: ref.serverId, workspaceId: ref.id,
            machineId: ref.machineId, rootPath: ref.rootPath }, activeRootPath: '/repo/accepted' })).toBe(true);
        const href = new URL(push.mock.calls[0]![0], 'https://happier.test');
        expect(href.searchParams.get('activeRootPath')).toBe('/repo/accepted');
        expect(href.searchParams.get('worktreeId')).not.toBe('stale-worktree');
        expect(href.searchParams.get('serverId')).toBe('home');
        await hook.unmount();
    });
});
