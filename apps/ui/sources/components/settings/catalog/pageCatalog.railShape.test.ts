import { describe, expect, it } from 'vitest';
import { isFeatureId } from '@happier-dev/protocol/features/catalog';

// Match the app's runtime-first composition before inspecting the catalog projection.
await import('./runtime/useResolvedSettingsPageCatalog');
const { PROMPTS_CONTEXT_ROUTE } = await import('@/components/settings/prompts/context/promptsContextNavigation');
const { SETTINGS_PAGE_CATALOG, readSettingsPageGate } = await import('./pageCatalog');

type CatalogNode = Readonly<{
    id: string;
    route?: string;
    gate?: Readonly<{ featureId?: string }>;
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
    it('passes every page gate to the canonical FeatureId consumer before boot', () => {
        const unknownGates = (nodes: readonly CatalogNode[]) => walk(nodes)
            .filter(({ node }) => node.gate?.featureId && !isFeatureId(node.gate.featureId))
            .map(({ node }) => `${node.id}:${node.gate?.featureId}`);
        // A retired gate must be caught even when an older transpiled node still carries it.
        expect(unknownGates([{ id: 'promptsAssets', gate: { featureId: 'prompts.assets.external' } }]))
            .toEqual(['promptsAssets:prompts.assets.external']);
        expect(unknownGates(catalog)).toEqual([]);
    });
    it('offers Skills before MCP and keeps retired asset and registry pages out of Prompts', () => {
        const tools = (catalog[0]?.children ?? []).find(group => group.id === 'groupToolsAndModels');
        const ids = tools?.children?.map(page => page.id) ?? [];
        expect(ids.indexOf('skills')).toBeGreaterThanOrEqual(0);
        expect(ids.indexOf('skills')).toBeLessThan(ids.indexOf('mcp'));
        const prompts = tools?.children?.find(page => page.id === 'prompts');
        expect(prompts?.children?.map(page => page.id)).toEqual([
            'promptsTemplates', 'promptsFolders', 'promptsStacks', 'promptsLibrary',
        ]);
    });
    it('keeps MCP servers reachable as a core settings destination', () => {
        const mcp = walk(catalog).find(({ node }) => node.id === 'mcp')?.node;
        expect(mcp?.route).toBe('/settings/mcp');
        expect(readSettingsPageGate('mcp')).toBeUndefined();
    });
    it('keeps Files preferences reachable when SCM writes are disabled', () => {
        const files = walk(catalog).find(({ node }) => node.id === 'sourceControl')?.node;
        expect(files?.route).toBe('/settings/source-control');
        expect(readSettingsPageGate('sourceControl')).toBeUndefined();
    });
    it('gates conversations independently while keeping Dictation reachable when conversations are disabled', () => {
        const voice = walk(catalog).find(({ node }) => node.id === 'voice')?.node;
        expect(readSettingsPageGate('voice')).toBeUndefined();
        expect(readSettingsPageGate('voiceDictation')).toBeUndefined();
        expect(readSettingsPageGate('voiceConversations')).toEqual({ featureId: 'voice' });
        expect(voice?.children?.some((child) => child.id === 'voiceDictation')).toBe(true);
    });
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

    it('groups the agent pages apart from the tools and models agents use (lab F2 rhythm)', () => {
        const groupOf = (id: string) => (catalog[0]?.children ?? []).find((group) => group.children?.some((child) => child.id === id))?.id;
        for (const id of ['agents', 'subAgent', 'profiles', 'roles', 'delegation', 'voice']) expect(groupOf(id)).toBe('groupAiAndAgents');
        for (const id of ['providers', 'connectedServices', 'mcp', 'plugins', 'prompts', 'search', 'memory']) expect(groupOf(id)).toBe('groupToolsAndModels');
    });

    it('exposes a single navigable root whose children are all groups', () => {
        expect(catalog).toHaveLength(1);
        const [root] = catalog;
        expect(root.route).toBeTruthy();
        expect(root.children?.length ?? 0).toBeGreaterThan(0);
        expect((root.children ?? []).every((child) => !child.route)).toBe(true);
    });

    it('opens Homes inside the settings layout, like its siblings', () => {
        const homes = walk(catalog).find(({ node }) => node.id === 'servers')?.node;
        // `/server` is the Home-recovery entry outside the settings layout: the rail and search must not
        // send the Homes page there, or it renders with no settings shell around it.
        expect(homes?.route).toBe('/settings/server');
    });

    it('opens Context on the Account layer page itself, not a hub that lists Context again', () => {
        const context = walk(catalog).find(({ node }) => node.id === 'promptsStacks')?.node;
        // The Context page already links Voice sessions and Launch profiles under "Other sessions" (c-ctx A).
        expect(context?.route).toBe(PROMPTS_CONTEXT_ROUTE);
    });

    it('registers Machine Pool creation beneath the searchable Machines catalog node', () => {
        const machines = walk(catalog).find(({ node }) => node.id === 'machines')?.node;

        expect(machines?.children?.map((child) => child.route)).toEqual([
            '/settings/machines/pools/new',
            '/settings/machines/add',
            '/settings/machines/this-computer',
        ]);
    });

    it('registers the routed Voice pages beneath the searchable Voice catalog node', () => {
        const voice = walk(catalog).find(({ node }) => node.id === 'voice')?.node;

        expect(voice?.children?.map((child) => child.route)).toEqual([
            '/settings/voice/conversations',
            '/settings/voice/dictation',
            '/settings/voice/privacy',
            '/settings/voice/advanced',
            '/settings/voice/history',
        ]);
    });
});
