import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

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

vi.mock('@react-navigation/native', () => ({
    useIsFocused: () => navigationMock.isFocused,
}));

vi.mock('@/components/ui/popover', () => ({
    PopoverScope: ({ children }: React.PropsWithChildren<Record<string, never>>) =>
        React.createElement('PopoverScope', null, children),
}));

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

    it('creates containedModal screen options on iOS', async () => {
        const { createNewSessionContainedModalScreenOptions } = await import('./newSessionContainedModalScreen');

        const options = createNewSessionContainedModalScreenOptions({
            title: 'directSessions.browseTitle',
            headerBackTitle: 'common.cancel',
        });

        expect(options.presentation).toBe('containedModal');
        expect(options.headerShown).toBe(true);
        expect(options.title).toBe('directSessions.browseTitle');
        expect(options.headerBackTitle).toBe('common.cancel');
    });

    it('scopes children with the shared popover and modal providers', async () => {
        const { NewSessionScreenPortalScope } = await import('./newSessionContainedModalScreen');

        const screen = await renderScreen(
            <NewSessionScreenPortalScope>
                {React.createElement('Child')}
            </NewSessionScreenPortalScope>,
        );

        expect(screen.findAllByType('PopoverScope' as any)).toHaveLength(1);
        expect(screen.findAllByType('ModalProvider' as any)).toHaveLength(1);
        expect(screen.findByType('ModalProvider' as any).props.active).toBe(true);
    });

    it('deactivates the contained modal provider while the route is not focused', async () => {
        navigationMock.isFocused = false;

        const { NewSessionScreenPortalScope } = await import('./newSessionContainedModalScreen');

        const screen = await renderScreen(
            <NewSessionScreenPortalScope>
                {React.createElement('Child')}
            </NewSessionScreenPortalScope>,
        );

        expect(screen.findByType('ModalProvider' as any).props.active).toBe(false);
    });
});
