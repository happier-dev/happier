import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
    pathname: () => '/session/A', params: () => ({ id: 'A' }),
}).module);

const { CurrentRouteLocationProvider, useCurrentRouteParamsSelector } = await import('./currentRouteLocation');

describe('current route location selector', () => {
    it('renders a reader of one param only when that param changes in the published location', async () => {
        let renders = 0;
        let seen: unknown = null;
        const selectId = (params: Readonly<Record<string, string | string[] | undefined>>) => params.id;
        // The palette/current-UI read the Session id; a pane writing `right=` must not render them.
        function SessionIdReader() { seen = useCurrentRouteParamsSelector(selectId); renders += 1; return null; }
        const reader = <SessionIdReader />;
        const tree = (params: Record<string, string>) => <CurrentRouteLocationProvider value={{ pathname: `/session/${params.id}`, params }}>
            {reader}
        </CurrentRouteLocationProvider>;
        const screen = await renderScreen(tree({ id: 'B' }));
        const before = renders;

        for (const right of ['files', 'review', 'terminal']) await screen.update(tree({ id: 'B', right }));
        expect(renders).toBe(before);
        await screen.update(tree({ id: 'C', right: 'terminal' }));
        expect(seen).toBe('C');
        expect(renders).toBe(before + 1);
    });
});
