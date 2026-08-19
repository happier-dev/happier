import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return Object.assign({}, ...style.map((entry) => flattenStyle(entry)));
    }
    if (style && typeof style === 'object') return style as Record<string, unknown>;
    return {};
}

describe('SessionLateralSwipeContent on web', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('stamps no transform where the swipe cannot exist', async () => {
        const { SessionLateralSwipeContent } = await import('./SessionLateralSwipeContent');
        const { SessionCockpitChromeRegistryProvider } = await import(
            '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry'
        );

        const screen = await renderScreen(
            <SessionCockpitChromeRegistryProvider>
                <SessionLateralSwipeContent>
                    {React.createElement('SessionContentProbe', { testID: 'session-content-probe' })}
                </SessionLateralSwipeContent>
            </SessionCockpitChromeRegistryProvider>,
        );

        // Mobile web renders the cockpit but has no lateral pan, and an identity transform
        // there would create a containing block and defeat `backdrop-filter` on the glass
        // surfaces inside the session tree.
        const style = flattenStyle(screen.findHostByTestId('session-cockpit-swipe-content')?.props.style);
        expect(style.transform).toBeUndefined();
        expect(style.opacity).toBeUndefined();
        expect(screen.findAllHostsByTestId('session-content-probe')).toHaveLength(1);
    });
});
