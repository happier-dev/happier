import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
    pathname: () => '/session/A', params: () => ({ id: 'A' }),
}).module);

const { CurrentRouteLocationProvider, useCurrentRouteParamsSelector, useCurrentRoutePathname } = await import('./currentRouteLocation');

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

    it('renders a pathname reader only when the path changes, not on a query write', async () => {
        let renders = 0;
        let seen: string | null = null;
        // Shell gates and root effects read the path; a Session side tab writing `right=` must not render them.
        function PathReader() { seen = useCurrentRoutePathname(); renders += 1; return null; }
        const reader = <PathReader />;
        const tree = (pathname: string, params: Record<string, string>) => <CurrentRouteLocationProvider value={{ pathname, params }}>
            {reader}
        </CurrentRouteLocationProvider>;
        const screen = await renderScreen(tree('/session/B', { id: 'B' }));
        const before = renders;

        for (const right of ['files', 'review', 'terminal']) await screen.update(tree('/session/B', { id: 'B', right }));
        expect(renders).toBe(before);
        await screen.update(tree('/session/C', { id: 'C', right: 'terminal' }));
        expect(seen).toBe('/session/C');
        expect(renders).toBe(before + 1);
    });
});
