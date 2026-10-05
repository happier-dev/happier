import { installFileFindAccountBoundaryMocks } from '@/components/appShell/panes/fileFindSeedTestHelpers';
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { useOpenProject } from './useOpenProject';
import { AppPaneProvider, useAppPaneContext } from '@/components/appShell/panes/AppPaneProvider';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';

installFileFindAccountBoundaryMocks('server-a', 'account-a');

const routerPush = vi.hoisted(() => vi.fn());
function PaneWrapper(props: React.PropsWithChildren) { return React.createElement(AppPaneProvider, null, props.children); }

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: { push: routerPush } }).module;
});
vi.mock('@/utils/platform/responsive', () => ({ useDeviceType: () => 'phone' }));
vi.mock('@/components/workspaceCockpit/useMobileWorkspaceExperienceState', () => ({
    useMobileWorkspaceExperienceState: () => ({ cockpitEnabled: true }),
}));
vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        useSetting: () => [{
            id: 'wr_1',
            serverId: 'server-a',
            machineId: 'machine-a',
            rootPath: '/repo',
            label: null,
            createdAtMs: 1,
            lastOpenedAtMs: null,
        }],
        useProjectLastMobileSurfacesByWorkspaceRefId: () => ({}),
        useLocalSetting: () => ({}),
    });
});

describe('useOpenProject', () => {
    beforeEach(() => {
        standardCleanup();
        routerPush.mockReset();
        installFileFindAccountBoundaryMocks('server-a', 'account-a');
    });

    it('opens an initial saved-workspace file in the project details owner', async () => {
        const hook = await renderHook(() => ({ open: useOpenProject(), pane: useAppPaneContext() }), { wrapper: PaneWrapper });

        expect(hook.getCurrent().open('wr_1', {
            activeRootPath: '/repo',
            initialResource: { kind: 'file', path: 'src/index.ts' },
        })).toBe(true);
        // The destination instance admits its own resource after it receives its scope.
        expect(hook.getCurrent().pane.state.scopes).toEqual({});
        expect(routerPush).toHaveBeenCalledWith('/projects/wr_1/details?worktreeId=%40root&sourceSurface=browse&initialFile=src%2Findex.ts');
    });
    it('stages direct same-Home file Find input and reuses Search input without replacing its lifetime', async () => {
        const hook = await renderHook(() => ({ open: useOpenProject(), handoff: useAppPaneContext().fileFindSeedHandoff }), { wrapper: PaneWrapper });
        const destination = { host: 'project' as const, id: 'wr_1', accountId: 'account-a', path: 'src/index.ts',
            scope: { serverId: 'server-a', machineId: 'machine-a', rootPath: '/repo' } };
        const find = { query: 'private needle', options: { matchCase: false, regex: false }, target: { kind: 'file' as const, path: destination.path } };
        const options = { initialResource: { kind: 'file' as const, path: destination.path, find } };
        expect(hook.getCurrent().open('wr_1', options)).toBe(true);
        expect(hook.getCurrent().handoff.take(destination)).toEqual(find);
        expect(routerPush.mock.calls[0][0]).not.toContain(find.query);
        const authority = captureActiveServerAccountScopeLifetime();
        if (!authority) throw new Error('Expected real Account lifetime');
        const cancelSearch = hook.getCurrent().handoff.stage(destination, find, authority);
        expect(hook.getCurrent().open('wr_1', options)).toBe(true);
        cancelSearch();
        expect(hook.getCurrent().handoff.take(destination)).toBeNull();
        routerPush.mockImplementationOnce(() => { throw new Error('Route failed'); });
        expect(() => hook.getCurrent().open('wr_1', options)).toThrow('Route failed');
        expect(hook.getCurrent().handoff.take(destination)).toBeNull();
        installFileFindAccountBoundaryMocks('other-home', 'account-a');
        expect(hook.getCurrent().open('wr_1', options)).toBe(false);
    });
});
