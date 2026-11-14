import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderHook } from '@/dev/testkit';
import { NavigationContext } from '@react-navigation/native';
import { createNavigationPropMock } from '@/dev/testkit/mocks/reactNavigation';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';

import {
    mergeNewSessionHostParams,
    NewSessionEmbeddedHostProvider,
    useNewSessionHostDemanded,
    useNewSessionHostFocused,
    useNewSessionHostNavigation,
    useNewSessionHostParams,
    type NewSessionEmbeddedHost,
} from './newSessionHost';
import { completeNewSessionPickerReturn } from './setNewSessionPickerReturnParams';
import { getTempData, storeTempData, type NewSessionData } from '@/utils/sessions/tempDataStore';

const routeBoundary = vi.hoisted(() => ({
    params: { draftId: 'route-draft', machineId: 'route-machine' } as Record<string, string>,
    push: vi.fn(),
    replace: vi.fn(),
    setParams: vi.fn(),
    resetParams: () => {},
}));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const mock = createExpoRouterMock({
        params: () => routeBoundary.params,
        navigation: { dispatch: vi.fn(), setParams: vi.fn(), canGoBack: () => true, goBack: vi.fn() },
        router: { push: routeBoundary.push, replace: routeBoundary.replace, setParams: routeBoundary.setParams },
    });
    routeBoundary.resetParams = mock.resetParams;
    return mock.module;
});

beforeEach(() => routeBoundary.resetParams());

function useHostSurface() {
    return {
        params: useNewSessionHostParams(),
        demanded: useNewSessionHostDemanded(),
        navigation: useNewSessionHostNavigation(),
    };
}

describe('newSessionHost', () => {
    it('returns a picker result to the original inline Home composer', async () => {
        routeBoundary.push.mockClear();
        routeBoundary.setParams.mockClear();
        const originalRoute = routeBoundary.params;
        routeBoundary.params = {};
        const setParams = vi.fn();
        const openDraft = vi.fn();
        const host: NewSessionEmbeddedHost = { params: { draftId: 'inline-original' }, demanded: true,
            setParams, openDraft, onHandedOff: vi.fn() };
        const hook = await renderHook(useHostSurface, {
            wrapper: ({ children }: React.PropsWithChildren) => <NewSessionEmbeddedHostProvider host={host}>{children}</NewSessionEmbeddedHostProvider>,
        });
        try {
            await act(async () => hook.getCurrent().navigation.router.push({ pathname: '/settings/machines/add', params: { draftId: 'inline-original' } }));
            expect(routeBoundary.setParams).toHaveBeenCalledWith({ newSessionHostDraftId: 'inline-original' });
            routeBoundary.params = { newSessionHostDraftId: 'inline-original', dataId: 'returned-target', machineId: 'joined' };
            await hook.rerender();
            expect(setParams).toHaveBeenCalledWith(expect.objectContaining({ dataId: 'returned-target', machineId: 'joined' }));
            expect(openDraft).not.toHaveBeenCalled();
        } finally { routeBoundary.params = originalRoute; await hook.unmount(); }
    });
    it('returns from nested Add to the original composer with its selected machine and draft intact', async () => {
        routeBoundary.push.mockClear();
        const authoring = { prompt: 'Keep this prompt', agentType: 'claude', permissionMode: 'read-only', selectedProfileId: 'original-profile' } satisfies NewSessionData;
        const originalDataId = storeTempData(authoring);
        const params = { draftId: 'original', dataId: originalDataId };
        const setParams = vi.fn((patch) => Object.assign(params, patch));
        const openDraft = vi.fn();
        const host: NewSessionEmbeddedHost = { kind: 'docked', params, demanded: true,
            setParams, openDraft, onHandedOff: vi.fn() };
        const hook = await renderHook(useHostSurface, {
            wrapper: ({ children }: React.PropsWithChildren) => <NewSessionEmbeddedHostProvider host={host}>{children}</NewSessionEmbeddedHostProvider>,
        });
        try {
            hook.getCurrent().navigation.router.push({ pathname: '/settings/machines/add', params: { draftId: 'original', dataId: originalDataId } });
            const href = routeBoundary.push.mock.calls[0][0];
            expect(href.params.newSessionHostDraftId).toBe('original');
            const dispatch = vi.fn();
            completeNewSessionPickerReturn({
                navigation: { dispatch, getState: () => ({ index: 2, routes: [
                    { key: 'home', name: 'index' },
                    { key: 'add', name: 'settings/machines/add', params: href.params },
                    { key: 'pair', name: 'settings/machines/add', params: { ...href.params, path: 'pair' } },
                ] }) },
                router: { replace: vi.fn() }, currentParams: href.params,
                returnToHost: (id, patch) => { if (id !== params.draftId) return false; setParams(patch); return true; },
                managedMachineSelection: null,
                routeParams: { machineId: 'joined', spawnServerId: 'home' },
            });
            expect(params).toEqual({ draftId: 'original', dataId: expect.any(String), machineId: 'joined', spawnServerId: 'home' });
            expect(getTempData<NewSessionData>(params.dataId)).toMatchObject(authoring);
            expect(openDraft).not.toHaveBeenCalled();
            expect(dispatch).toHaveBeenCalledWith({ type: 'POP', payload: { count: 2 } });
        } finally { getTempData(originalDataId); getTempData(params.dataId); await hook.unmount(); }
    });
    it('keeps a docked draft active when the background route loses focus', async () => {
        const navigation = createNavigationPropMock({ isFocused: () => false });
        let host: NewSessionEmbeddedHost = {
            kind: 'docked', params: { draftId: 'dock-draft' }, demanded: true,
            setParams: vi.fn(), openDraft: vi.fn(), onHandedOff: vi.fn(),
        };
        const hook = await renderHook(useNewSessionHostFocused, {
            wrapper: ({ children }: React.PropsWithChildren) => (
                <NavigationContext.Provider value={navigation}>
                    <NewSessionEmbeddedHostProvider host={host}>{children}</NewSessionEmbeddedHostProvider>
                </NavigationContext.Provider>
            ),
        });
        try {
            expect(hook.getCurrent()).toBe(true);
            host = { ...host, kind: undefined };
            await hook.rerender();
            expect(hook.getCurrent()).toBe(false);
        } finally { await hook.unmount(); }
    });
    it('withdraws route demand while the New Session surface is retained out of view', async () => {
        let presented = false;
        const hook = await renderHook(useNewSessionHostDemanded, {
            wrapper: ({ children }: React.PropsWithChildren) => (
                <PluginSurfaceFocusEligibilityProvider active={presented}>{children}</PluginSurfaceFocusEligibilityProvider>
            ),
        });
        try {
            expect(hook.getCurrent()).toBe(false);
            presented = true;
            await hook.rerender();
            expect(hook.getCurrent()).toBe(true);
            presented = false;
            await hook.rerender();
            expect(hook.getCurrent()).toBe(false);
        } finally { await hook.unmount(); }
    });

    it('on /new, reads and writes the route and opens drafts by navigating', async () => {
        const hook = await renderHook(useHostSurface);
        const surface = hook.getCurrent();
        expect(surface.params).toEqual(routeBoundary.params);
        expect(surface.demanded).toBe(true);
        expect(surface.navigation.embedded).toBe(false);

        surface.navigation.openDraft({ draftId: 'next', draftOrigin: 'ordinary' });
        expect(routeBoundary.replace).toHaveBeenCalledWith({ pathname: '/new', params: { draftId: 'next', draftOrigin: 'ordinary' } });
        await hook.unmount();
    });

    it('starts another draft in the current New Session route without stacking dialogs', async () => {
        const routes: unknown[] = ['/session/existing', {
            pathname: '/new', params: { draftId: 'route-draft' },
        }];
        // Expo navigation is the external boundary: model its retained route stack.
        routeBoundary.push.mockImplementation((href: unknown) => { routes.push(href); });
        routeBoundary.replace.mockImplementation((href: unknown) => { routes[routes.length - 1] = href; });
        const hook = await renderHook(useHostSurface);
        try {
            hook.getCurrent().navigation.openDraft({ draftId: 'fresh-1', draftOrigin: 'ordinary' });
            hook.getCurrent().navigation.openDraft({ draftId: 'fresh-2', draftOrigin: 'ordinary' });

            expect(routes).toEqual(['/session/existing', {
                pathname: '/new', params: { draftId: 'fresh-2', draftOrigin: 'ordinary' },
            }]);
        } finally {
            routeBoundary.push.mockReset();
            routeBoundary.replace.mockReset();
            await hook.unmount();
        }
    });

    it('embedded, keeps params in the host, pushes the created session and reports the hand-off', async () => {
        routeBoundary.push.mockClear();
        routeBoundary.replace.mockClear();
        routeBoundary.setParams.mockClear();
        const setParams = vi.fn();
        const openDraft = vi.fn();
        const onHandedOff = vi.fn();
        const host: NewSessionEmbeddedHost = {
            params: { draftId: 'home-draft' },
            setParams,
            openDraft,
            onHandedOff,
            demanded: false,
        };
        const hook = await renderHook(useHostSurface, {
            wrapper: ({ children }: { children?: React.ReactNode }) => (
                <NewSessionEmbeddedHostProvider host={host}>{children}</NewSessionEmbeddedHostProvider>
            ),
        });
        const surface = hook.getCurrent();
        expect(surface.params).toEqual({ draftId: 'home-draft' });
        expect(surface.demanded).toBe(false);
        expect(surface.navigation.embedded).toBe(true);

        surface.navigation.router.setParams({ machineId: 'm1' });
        surface.navigation.navigation.dispatch({ type: 'SET_PARAMS', payload: { params: { profileId: undefined } } } as never);
        expect(setParams.mock.calls).toEqual([[{ machineId: 'm1' }], [{ profileId: undefined }]]);
        expect(routeBoundary.setParams).not.toHaveBeenCalled();

        // Handing the draft to the created session keeps the embedding page in history.
        surface.navigation.router.replace('/session/s1' as never);
        expect(routeBoundary.push).toHaveBeenCalledWith('/session/s1', undefined);
        expect(routeBoundary.replace).not.toHaveBeenCalled();
        expect(onHandedOff).toHaveBeenCalledOnce();

        surface.navigation.openDraft({ draftId: 'fresh', draftOrigin: 'ordinary' });
        expect(openDraft).toHaveBeenCalledWith({ draftId: 'fresh', draftOrigin: 'ordinary' });
        expect(routeBoundary.push).toHaveBeenCalledTimes(1);
        await hook.unmount();
    });

    it('embedded in place (the embed new chat), hands off to the created session without navigating', async () => {
        routeBoundary.push.mockClear();
        routeBoundary.replace.mockClear();
        const onHandedOff = vi.fn();
        const host: NewSessionEmbeddedHost = {
            params: { draftId: 'embed-draft' },
            setParams: vi.fn(),
            openDraft: vi.fn(),
            onHandedOff,
            demanded: true,
            createdSessionPresentation: 'inPlace',
        };
        const hook = await renderHook(useHostSurface, {
            wrapper: ({ children }: { children?: React.ReactNode }) => <NewSessionEmbeddedHostProvider host={host}>{children}</NewSessionEmbeddedHostProvider>,
        });
        // Machine-install preflight uses push rather than the final session hand-off.
        // An in-place host must retain its own surface on either navigation path.
        hook.getCurrent().navigation.router.push('/machine/m1');
        hook.getCurrent().navigation.router.replace('/session/created');

        expect(routeBoundary.push).not.toHaveBeenCalled();
        expect(routeBoundary.replace).not.toHaveBeenCalled();
        expect(onHandedOff).toHaveBeenCalledTimes(1);
        expect(onHandedOff).toHaveBeenCalledWith('/session/created', { opened: false });
        await hook.unmount();
    });

    it('merges param patches like router.setParams and keeps the object when nothing changed', () => {
        const current = { draftId: 'd', machineId: 'm1' };
        expect(mergeNewSessionHostParams(current, { machineId: 'm1' })).toBe(current);
        expect(mergeNewSessionHostParams(current, { machineId: undefined, directory: '/w' })).toEqual({ draftId: 'd', directory: '/w' });
    });

    it('docked in place, opens a picker for its draft but hands off without replacing the page', async () => {
        routeBoundary.push.mockClear();
        routeBoundary.replace.mockClear();
        const onHandedOff = vi.fn();
        const host: NewSessionEmbeddedHost = {
            kind: 'docked', params: { draftId: 'dock-draft' }, demanded: true,
            setParams: vi.fn(), openDraft: vi.fn(), onHandedOff,
            createdSessionPresentation: 'inPlace',
        };
        const hook = await renderHook(useHostSurface, {
            wrapper: ({ children }: React.PropsWithChildren) => <NewSessionEmbeddedHostProvider host={host}>{children}</NewSessionEmbeddedHostProvider>,
        });
        try {
            hook.getCurrent().navigation.router.push({ pathname: '/new/pick/profile-edit', params: { profileId: 'profile' } });
            expect(routeBoundary.push).toHaveBeenCalledWith({ pathname: '/new/pick/profile-edit', params: {
                profileId: 'profile', newSessionHostDraftId: 'dock-draft',
            } }, undefined);
            hook.getCurrent().navigation.router.replace('/session/created');
            expect(onHandedOff).toHaveBeenCalledWith('/session/created', { opened: false });
            expect(routeBoundary.replace).not.toHaveBeenCalled();
            expect(routeBoundary.push).toHaveBeenCalledTimes(1);
        } finally { await hook.unmount(); }
    });

    it('docked in a workspace, opens a picker inside the pane that holds the page (#5, UI refinements ruling 14:10Z)', async () => {
        routeBoundary.push.mockClear();
        const { WorkspaceNavigationProvider } = await import('@/components/appShell/workspace/WorkspaceNavigationContext');
        const { createWorkspaceState } = await import('@/components/appShell/workspace/workspaceState');
        const panePush = vi.fn();
        const navigationForTab = vi.fn(() => ({ push: panePush, replace: vi.fn(), back: vi.fn() }));
        const workspace = {
            active: true,
            state: createWorkspaceState({ id: 'page-tab', target: { kind: 'sessions', params: {} } as never, pinned: false, preview: false }),
            canGoBack: true, canGoForward: false, openHref: () => true,
            activateTab: () => {}, closeTab: () => {}, closeTabs: () => {}, dispatch: () => {}, back: () => {}, forward: () => {},
            navigationForTab, registerBackStep: () => () => {},
        };
        const host: NewSessionEmbeddedHost = { kind: 'docked', params: { draftId: 'dock-draft' }, demanded: true,
            setParams: vi.fn(), openDraft: vi.fn(), onHandedOff: vi.fn() };
        const hook = await renderHook(useHostSurface, {
            wrapper: ({ children }: React.PropsWithChildren) => <WorkspaceNavigationProvider value={workspace}>
                <NewSessionEmbeddedHostProvider host={host}>{children}</NewSessionEmbeddedHostProvider>
            </WorkspaceNavigationProvider>,
        });
        try {
            hook.getCurrent().navigation.router.push({ pathname: '/settings/machines/add', params: { draftId: 'dock-draft' } });
            // The pane keeps the page in its history, so the picker's return pops back to it.
            expect(navigationForTab).toHaveBeenCalledWith('page-tab');
            expect(panePush).toHaveBeenCalledWith({ pathname: '/settings/machines/add', params: {
                draftId: 'dock-draft', newSessionHostDraftId: 'dock-draft',
            } });
            expect(routeBoundary.push).not.toHaveBeenCalled();
        } finally { await hook.unmount(); }
    });

    it('inline on a page (Home), opens a picker inside the same pane, the one opener for every origin (#5, ruling 15:07Z)', async () => {
        routeBoundary.push.mockClear();
        const { WorkspaceNavigationProvider } = await import('@/components/appShell/workspace/WorkspaceNavigationContext');
        const { createWorkspaceState } = await import('@/components/appShell/workspace/workspaceState');
        const panePush = vi.fn();
        const navigationForTab = vi.fn(() => ({ push: panePush, replace: vi.fn(), back: vi.fn() }));
        const workspace = {
            active: true,
            state: createWorkspaceState({ id: 'home-tab', target: { kind: 'home', params: {} } as never, pinned: false, preview: false }),
            canGoBack: true, canGoForward: false, openHref: () => true,
            activateTab: () => {}, closeTab: () => {}, closeTabs: () => {}, dispatch: () => {}, back: () => {}, forward: () => {},
            navigationForTab, registerBackStep: () => () => {},
        };
        const host: NewSessionEmbeddedHost = { params: { draftId: 'home-draft' }, demanded: true,
            setParams: vi.fn(), openDraft: vi.fn(), onHandedOff: vi.fn() };
        const hook = await renderHook(useHostSurface, {
            wrapper: ({ children }: React.PropsWithChildren) => <WorkspaceNavigationProvider value={workspace}>
                <NewSessionEmbeddedHostProvider host={host}>{children}</NewSessionEmbeddedHostProvider>
            </WorkspaceNavigationProvider>,
        });
        try {
            hook.getCurrent().navigation.router.push({ pathname: '/settings/machines/add', params: { draftId: 'home-draft' } });
            expect(navigationForTab).toHaveBeenCalledWith('home-tab');
            expect(panePush).toHaveBeenCalledWith({ pathname: '/settings/machines/add', params: {
                draftId: 'home-draft', newSessionHostDraftId: 'home-draft',
            } });
            expect(routeBoundary.push).not.toHaveBeenCalled();
        } finally { await hook.unmount(); }
    });
});
