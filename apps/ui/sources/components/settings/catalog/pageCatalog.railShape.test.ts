import { describe, expect, it } from 'vitest';

import { SETTINGS_PAGE_CATALOG } from './pageCatalog';

type CatalogNode = Readonly<{
    id: string;
    route?: string;
    children?: readonly CatalogNode[];
}>;

const catalog = SETTINGS_PAGE_CATALOG as readonly CatalogNode[];

function walk(
    nodes: readonly CatalogNode[],
    depth = 0,
    out: Array<{ node: CatalogNode; depth: number }> = [],
): Array<{ node: CatalogNode; depth: number }> {
    for (const node of nodes) {
        out.push({ node, depth });
        walk(node.children ?? [], depth + 1, out);
    }
    return out;
}

/**
 * `SettingsSidebar` renders a node with children and no route as a static section label, and
 * anything else as a navigable row. That is a real invariant of the catalog rather than a
 * property of the type — `SettingsPageNode` lets any node omit `route` — so it is asserted
 * here instead of being left as an implicit assumption inside the renderer.
 */
describe('settings catalog rail shape', () => {
    it('gives every node either a destination or children to label', () => {
        const dead = walk(catalog)
            .filter(({ node }) => !node.route && (node.children?.length ?? 0) === 0)
            .map(({ node }) => node.id);

        // A route-less leaf would render as a row that neither navigates nor discloses.
        expect(dead).toEqual([]);
    });

    it('keeps every route-less group node at the top level of the rail', () => {
        const misplaced = walk(catalog)
            .filter(({ node, depth }) => !node.route && depth !== 1)
            .map(({ node, depth }) => `${node.id}@${depth}`);

        // Groups are the rail's section labels. One nested deeper would render a label in
        // among the indented rows of another section.
        expect(misplaced).toEqual([]);
    });

    it('exposes a single navigable root whose children are all groups', () => {
        expect(catalog).toHaveLength(1);
        const [root] = catalog;
        expect(root.route).toBeTruthy();
        expect(root.children?.length ?? 0).toBeGreaterThan(0);
        expect((root.children ?? []).every((child) => !child.route)).toBe(true);
    });

    it('registers the routed Voice pages beneath the searchable Voice catalog node', () => {
        const voice = walk(catalog).find(({ node }) => node.id === 'voice')?.node;

        expect(voice?.children?.map((child) => child.route)).toEqual([
            '/settings/voice/conversations',
            '/settings/voice/dictation',
            '/settings/voice/privacy',
            '/settings/voice/advanced',
        ]);
    });
});
