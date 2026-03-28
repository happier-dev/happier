import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: {
            OS: 'ios',
            select: <T,>(values: { ios?: T; default?: T }) => values.ios ?? values.default,
        },
    });
});

vi.mock('@/components/ui/popover', () => ({
    PopoverPortalTargetProvider: ({ children }: React.PropsWithChildren<Record<string, never>>) =>
        React.createElement('PopoverPortalTargetProvider', null, children),
}));

afterEach(() => {
    standardCleanup();
});

describe('newSessionContainedModalScreen helpers', () => {
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

    it('scopes children with the shared popover portal provider', async () => {
        const { NewSessionScreenPortalScope } = await import('./newSessionContainedModalScreen');

        const screen = await renderScreen(
            <NewSessionScreenPortalScope>
                {React.createElement('Child')}
            </NewSessionScreenPortalScope>,
        );

        expect(screen.findAllByType('PopoverPortalTargetProvider' as any)).toHaveLength(1);
    });
});
