import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';

import {
    mergeNewSessionHostParams,
    NewSessionEmbeddedHostProvider,
    useNewSessionHostDemanded,
    useNewSessionHostNavigation,
    useNewSessionHostParams,
    type NewSessionEmbeddedHost,
} from './newSessionHost';

const routeBoundary = vi.hoisted(() => ({
    params: { draftId: 'route-draft', machineId: 'route-machine' } as Record<string, string>,
    push: vi.fn(),
    replace: vi.fn(),
    setParams: vi.fn(),
}));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({
        params: () => routeBoundary.params,
        navigation: { dispatch: vi.fn(), setParams: vi.fn(), canGoBack: () => true, goBack: vi.fn() },
        router: { push: routeBoundary.push, replace: routeBoundary.replace, setParams: routeBoundary.setParams },
    }).module;
});

function useHostSurface() {
    return {
        params: useNewSessionHostParams(),
        demanded: useNewSessionHostDemanded(),
        navigation: useNewSessionHostNavigation(),
    };
}

describe('newSessionHost', () => {
    it('on /new, reads and writes the route and opens drafts by navigating', async () => {
        const hook = await renderHook(useHostSurface);
        const surface = hook.getCurrent();
        expect(surface.params).toEqual(routeBoundary.params);
        expect(surface.demanded).toBe(true);
        expect(surface.navigation.embedded).toBe(false);

        surface.navigation.openDraft({ draftId: 'next', draftOrigin: 'ordinary' }, 'replace');
        expect(routeBoundary.replace).toHaveBeenCalledWith({ pathname: '/new', params: { draftId: 'next', draftOrigin: 'ordinary' } });
        await hook.unmount();
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

        surface.navigation.openDraft({ draftId: 'fresh', draftOrigin: 'ordinary' }, 'push');
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
        expect(onHandedOff).toHaveBeenCalledWith('/session/created');
        await hook.unmount();
    });

    it('merges param patches like router.setParams and keeps the object when nothing changed', () => {
        const current = { draftId: 'd', machineId: 'm1' };
        expect(mergeNewSessionHostParams(current, { machineId: 'm1' })).toBe(current);
        expect(mergeNewSessionHostParams(current, { machineId: undefined, directory: '/w' })).toEqual({ draftId: 'd', directory: '/w' });
    });
});
