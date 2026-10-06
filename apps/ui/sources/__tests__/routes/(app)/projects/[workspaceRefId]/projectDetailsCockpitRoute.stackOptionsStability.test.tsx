import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { WorkspaceRefV1Schema } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createScmCapabilities, type ScmWorkingSnapshot } from '@happier-dev/protocol/scm';
import { createMachineFixture, renderScreen } from '@/dev/testkit';
import { createExpoRouterMock, type StackScreenOptionsInput } from '@/dev/testkit/mocks/router';
import { installSessionRouteCommonModuleMocks } from '../../session/[id]/sessionRouteTestHelpers';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { storage } from '@/sync/domains/state/storageStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const setOptions = vi.fn();
const listeners = new Set<() => void>();
let phone = true;
let cockpit = true;
const router = createExpoRouterMock({ params: { workspaceRefId: 'wr_1' }, navigation: { canGoBack: () => true } });
installSessionRouteCommonModuleMocks({
    reactNative: async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeNativeMock({ platformOS: 'ios' }, {
        useWindowDimensions: () => ({ width: phone ? 390 : 1280, height: phone ? 844 : 900, scale: 1, fontScale: 1 }),
    }),
    router: () => ({
        ...router.module,
        Stack: { Screen: ({ options }: { options: StackScreenOptionsInput }) => {
            React.useEffect(() => {
                setOptions(typeof options === 'function' ? options() : options);
                for (const notify of listeners) notify();
            }, [options]);
            return null;
        } },
        useNavigation: () => {
            const [, force] = React.useReducer((value) => value + 1, 0);
            React.useLayoutEffect(() => { listeners.add(force); return () => { listeners.delete(force); }; }, [force]);
            return { canGoBack: () => true };
        },
    }),
});
const snapshot: ScmWorkingSnapshot = {
    fetchedAt: 1, projectKey: 'machine-1:/repo',
    repo: { isRepo: true, rootPath: '/repo', backendId: 'git', mode: '.git', remotes: [],
        worktrees: [
            { id: 'gitwt_main', path: '/repo', branch: 'main', isCurrent: true, isMain: true },
            { id: 'gitwt_feature', path: '/repo/.worktrees/feature-auth', branch: 'feature/auth', isCurrent: false },
        ] },
    capabilities: createScmCapabilities({ readStatus: true }),
    branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
    stashCount: 0, hasConflicts: false, entries: [],
    totals: { includedFiles: 0, pendingFiles: 0, untrackedFiles: 0, includedAdded: 0, includedRemoved: 0, pendingAdded: 0, pendingRemoved: 0 },
};
function configureSocket(socket: import('socket.io-client').Socket) {
    vi.mocked(socket.connect).mockImplementation(() => {
        socket.connected = true;
        for (const listener of socket.listeners('connect')) listener();
        return socket;
    });
    vi.spyOn(socket, 'emit').mockReturnValue(socket);
    vi.spyOn(socket, 'emitWithAck').mockImplementation(async (event, payload: unknown) => {
        if (event !== 'rpc-call' || !payload || typeof payload !== 'object' || !('method' in payload)
            || typeof payload.method !== 'string' || !('params' in payload)) throw new Error('Unexpected Socket RPC envelope');
        const method = payload.method.slice(payload.method.indexOf(':') + 1);
        return { ok: true, result: method === RPC_METHODS.SCM_STATUS_SNAPSHOT
            ? { success: true, snapshot } : { success: false, errorCode: 'FEATURE_UNSUPPORTED' } };
    });
}
const runtime = installSessionPaneRuntimeTestHarness({ scopeId: 'project:wr_1', configureSocket });
beforeEach(() => {
    phone = true; cockpit = true; listeners.clear(); setOptions.mockClear();
    router.resetParams();
    router.state.router.setParams({ workspaceRefId: 'wr_1' });
    router.spies.push.mockClear(); router.spies.back.mockClear(); router.spies.replace.mockClear(); router.spies.setParams.mockClear();
});

async function renderRoute(kind: 'details' | 'terminal') {
    storage.getState().applySettingsLocal({
        mobileWorkspaceExperienceV1: cockpit ? 'cockpit' : 'classic',
        workspaceRefsV1: [WorkspaceRefV1Schema.parse({
            id: 'wr_1', serverId: runtime.serverId, machineId: 'machine-1',
            rootPath: '/repo', label: 'Project Alpha', createdAtMs: 1,
        })],
    });
    storage.getState().applyMachines([createMachineFixture({ storageMode: 'plain', activeAt: Date.now() })], true, { sourceServerId: runtime.serverId });
    storage.getState().updateWorkspaceScmSnapshot({ serverId: runtime.serverId, machineId: 'machine-1', rootPath: '/repo' }, snapshot);
    const Screen = kind === 'details'
        ? (await import('@/app/(app)/projects/[workspaceRefId]/details')).default
        : (await import('@/app/(app)/projects/[workspaceRefId]/terminal')).default;
    const { createProjectFileDetailsTab } = await import('@/components/projects/detail/projectDetailsTabBuilders');
    const screen = await renderScreen(<runtime.Wrapper />);
    await act(async () => {
        runtime.pane.openRight({ tabId: 'git' });
        runtime.pane.openDetailsTab(createProjectFileDetailsTab('/repo/a.ts'), { intent: 'pinned' });
    });
    await screen.update(<runtime.Wrapper><Screen /></runtime.Wrapper>);
    return { screen, rerender: () => screen.update(<runtime.Wrapper><Screen /></runtime.Wrapper>) };
}

describe('project details route stack options stability', () => {
    it('keeps native screen options stable when the actual cockpit details route rerenders', async () => {
        const { rerender } = await renderRoute('details');
        await rerender();
        expect(setOptions).toHaveBeenCalledTimes(1);
    });

    it('keeps native screen options stable when the actual classic details route rerenders', async () => {
        phone = false; cockpit = false;
        const { rerender } = await renderRoute('details');
        await rerender();
        expect(setOptions).toHaveBeenCalledTimes(1);
    });

    it('canonicalizes a stale terminal activeRootPath once without suppressing real preference writes', async () => {
        router.state.router.setParams({ workspaceRefId: 'wr_1', activeRootPath: '/repo/.worktrees/feature-auth', worktreeId: undefined });
        const { rerender } = await renderRoute('terminal');
        await rerender();
        expect(router.spies.replace).toHaveBeenCalledTimes(1);
        expect(router.spies.replace).toHaveBeenCalledWith('/projects/wr_1/terminal?worktreeId=gitwt_feature');
        expect(storage.getState().localSettings.projectLastActiveWorktreeIdByWorkspaceRefId.wr_1).toBe('gitwt_feature');
    });
});
