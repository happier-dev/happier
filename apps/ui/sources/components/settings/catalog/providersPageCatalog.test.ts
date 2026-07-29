import { describe, expect, it } from 'vitest';

import { SETTINGS_PAGE_CATALOG } from './pageCatalog';
import { SETTINGS_ROUTES } from './routes';

function flatten(nodes: readonly { id: string; route?: string; gate?: { featureId?: string }; children?: readonly unknown[] }[]): readonly typeof nodes[number][] {
    return nodes.flatMap((node) => [
        node,
        ...flatten((node.children ?? []) as typeof nodes),
    ]);
}

describe('provider settings catalog', () => {
    it('keeps Agents and Providers as distinct routes and gates only model providers', () => {
        const pages = flatten(SETTINGS_PAGE_CATALOG);
        expect(pages.find((page) => page.id === 'agents')).toMatchObject({ route: '/settings/agents' });
        expect(pages.find((page) => page.id === 'providers')).toMatchObject({
            route: '/settings/providers', gate: { featureId: 'providers' },
        });
        expect(SETTINGS_ROUTES.agents).not.toBe(SETTINGS_ROUTES.providers);
    });
});
