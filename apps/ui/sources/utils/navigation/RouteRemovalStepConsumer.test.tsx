import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NavigationContext } from '@react-navigation/native';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { DestinationInstanceHost } from '@/components/appShell/workspace/DestinationInstanceHost';
import { WorkspaceNavigationContext, type WorkspaceNavigationContextValue } from '@/components/appShell/workspace/WorkspaceNavigationContext';
import { createWorkspaceState } from '@/components/appShell/workspace/workspaceState';

const removal = vi.hoisted(() => ({
    enabled: false,
    callback: null as null | ((event: Readonly<{ data: Readonly<{ action: unknown }> }>) => void),
}));

vi.mock('@react-navigation/native', async () => {
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    return createReactNavigationNativeMock({
        usePreventRemove: (enabled, callback) => {
            removal.enabled = enabled;
            removal.callback = callback;
        },
    });
});

describe('RouteRemovalStepConsumer', () => {
    beforeEach(() => {
        removal.enabled = false;
        removal.callback = null;
    });

    afterEach(() => {
        standardCleanup();
    });

    it('registers the hosted page step with workspace Back without guarding the outer Expo route', async () => {
        const consume = vi.fn(() => true);
        const participants = new Map<string, () => boolean>();
        const workspace: WorkspaceNavigationContextValue = {
            active: true,
            state: createWorkspaceState({ id: 'plugin-tab', target: { kind: 'plugin:notes', params: {} }, pinned: false, preview: false }),
            canGoBack: true, canGoForward: false, openHref: () => true,
            activateTab: () => {}, closeTab: () => {}, closeTabs: () => {}, dispatch: () => {}, back: () => {}, forward: () => {},
            navigationForTab: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
            registerBackStep: (tabId, step) => {
                participants.set(tabId, step);
                return () => { participants.delete(tabId); };
            },
        };
        const { RouteRemovalStepConsumer } = await import('./RouteRemovalStepConsumer');
        const screen = await renderScreen(<WorkspaceNavigationContext.Provider value={workspace}>
            <DestinationInstanceHost tabId="plugin-tab" ref={{ kind: 'plugin:notes', params: {} }}
                pathname="/plugins/notes/page" focused visible>
                <RouteRemovalStepConsumer active consume={consume} />
            </DestinationInstanceHost>
        </WorkspaceNavigationContext.Provider>);
        expect(removal.callback).toBeNull();
        expect(participants.get('plugin-tab')?.()).toBe(true);
        consume.mockReturnValue(false);
        expect(participants.get('plugin-tab')?.()).toBe(false);
        await screen.unmount();
        expect(participants.size).toBe(0);
    });

    it('redispatches a same-page replacement without spending the declared Back step', async () => {
        const dispatch = vi.fn();
        const consume = vi.fn(() => true);
        const replacement = {
            type: 'REPLACE',
            payload: { name: 'plugin-settings-page', params: { subPath: 'bindings/7' } },
        };
        const { RouteRemovalStepConsumer } = await import('./RouteRemovalStepConsumer');

        await renderScreen(
            <NavigationContext.Provider value={{ dispatch } as never}>
                <RouteRemovalStepConsumer active consume={consume} />
            </NavigationContext.Provider>,
        );
        expect(removal.enabled).toBe(true);

        await act(async () => {
            removal.callback?.({ data: { action: replacement } });
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(consume).not.toHaveBeenCalled();
        expect(dispatch).toHaveBeenCalledWith(replacement);
    });

    it('spends the declared step for an actual backward removal', async () => {
        const dispatch = vi.fn();
        const consume = vi.fn(() => true);
        const goBack = { type: 'GO_BACK' };
        const { RouteRemovalStepConsumer } = await import('./RouteRemovalStepConsumer');

        await renderScreen(
            <NavigationContext.Provider value={{ dispatch } as never}>
                <RouteRemovalStepConsumer active consume={consume} />
            </NavigationContext.Provider>,
        );

        await act(async () => {
            removal.callback?.({ data: { action: goBack } });
            await Promise.resolve();
        });

        expect(consume).toHaveBeenCalledOnce();
        expect(dispatch).not.toHaveBeenCalled();
    });

    it('redispatches the same Back action when the declared step declines it', async () => {
        const dispatch = vi.fn();
        const goBack = { type: 'GO_BACK' };
        const { RouteRemovalStepConsumer } = await import('./RouteRemovalStepConsumer');
        await renderScreen(<NavigationContext.Provider value={{ dispatch } as never}>
            <RouteRemovalStepConsumer active consume={() => false} />
        </NavigationContext.Provider>);
        await act(async () => {
            removal.callback?.({ data: { action: goBack } });
            await Promise.resolve();
            await Promise.resolve();
        });
        expect(dispatch).toHaveBeenCalledWith(goBack);
    });

    it('redispatches a targeted stack dismissal without spending the page-local step', async () => {
        const dispatch = vi.fn();
        const consume = vi.fn(() => true);
        const dismissTo = { type: 'POP_TO', payload: { name: 'settings' } };
        const { RouteRemovalStepConsumer } = await import('./RouteRemovalStepConsumer');

        await renderScreen(
            <NavigationContext.Provider value={{ dispatch } as never}>
                <RouteRemovalStepConsumer active consume={consume} />
            </NavigationContext.Provider>,
        );

        await act(async () => {
            removal.callback?.({ data: { action: dismissTo } });
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(consume).not.toHaveBeenCalled();
        expect(dispatch).toHaveBeenCalledWith(dismissTo);
    });
});
