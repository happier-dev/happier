import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { usePluginSurfaceFocusEligibility } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import {
    createNewSessionContainedModalScreenOptions,
    NewSessionScreenPortalScope,
} from './newSessionContainedModalScreen';

function PluginFocusProbe() {
    return React.createElement('PluginFocusProbe', { testID: 'route-plugin-focus', eligible: usePluginSurfaceFocusEligibility() });
}

const modalMock = vi.hoisted(() => ({
    module: null as null | ReturnType<typeof import('@/dev/testkit/mocks/modal').createModalModuleMock>['module'],
}));

const navigationMock = vi.hoisted(() => ({
    isFocused: true,
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: {
            OS: 'ios',
            select: <T,>(values: { ios?: T; default?: T }) => values.ios ?? values.default,
        },
    });
});

vi.mock('@react-navigation/native', async () => {
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    return {
        ...createReactNavigationNativeMock(),
        useIsFocused: () => navigationMock.isFocused,
    };
});

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    modalMock.module = createModalModuleMock().module;
    return modalMock.module;
});

afterEach(() => {
    standardCleanup();
});

describe('newSessionContainedModalScreen helpers', () => {
    afterEach(() => {
        navigationMock.isFocused = true;
    });

    it('creates picker chrome without owning the root navigator presentation', async () => {
        const options = createNewSessionContainedModalScreenOptions({
            title: 'externalSessions.browseTitle',
            headerBackTitle: 'common.cancel',
        });

        expect(options.headerShown).toBe(true);
        expect(options.title).toBe('externalSessions.browseTitle');
        expect(options.headerBackTitle).toBe('common.cancel');
    });

    it('scopes children with the shared popover and modal providers', async () => {
        const { NavigationContext } = await import('@react-navigation/native');
        // SDK boundary fixture: this owner reads only navigator presence, not its methods.
        const navigation = {} as React.ContextType<typeof NavigationContext>;

        const screen = await renderScreen(
            <NavigationContext.Provider value={navigation}><NewSessionScreenPortalScope>
                <PluginFocusProbe />
            </NewSessionScreenPortalScope></NavigationContext.Provider>,
        );

        expect(screen.findAllByType('ModalProvider' as any)).toHaveLength(1);
        expect(screen.findByType('ModalProvider' as any).props.active).toBe(true);
        expect(screen.findByTestId('route-plugin-focus')?.props.eligible).toBe(true);
    });

    it('deactivates the contained modal provider while the route is not focused', async () => {
        navigationMock.isFocused = false;

        const { NavigationContext } = await import('@react-navigation/native');
        // SDK boundary fixture: this owner reads only navigator presence, not its methods.
        const navigation = {} as React.ContextType<typeof NavigationContext>;

        const screen = await renderScreen(
            <NavigationContext.Provider value={navigation}><NewSessionScreenPortalScope>
                <PluginFocusProbe />
            </NewSessionScreenPortalScope></NavigationContext.Provider>,
        );

        expect(screen.findByType('ModalProvider' as any).props.active).toBe(false);
        expect(screen.findByTestId('route-plugin-focus')?.props.eligible).toBe(false);
    });
});
