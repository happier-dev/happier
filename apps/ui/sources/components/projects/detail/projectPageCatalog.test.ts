import { describe, expect, it } from 'vitest';
import { createPluginPagePlacementFixture } from '@/dev/testkit/fixtures/pluginPageProjectionFixture';
import { PROJECT_PAGES } from '@/components/workspaceCockpit/project/projectCockpitState';
import { resolveProjectPageCatalog, resolveProjectPageCatalogState } from './projectPageCatalog';
import { normalizePluginUiDestinationBindingV1 } from '@happier-dev/protocol/plugins/ui';
import { resolveNavigationPlacements } from '@/sync/domains/settings/navigationPlacement';

const target = { kind: 'project', workspaceRefId: 'checkout-a', serverId: 'home-a' } as const;
const page = (localId: string, title: string) => createPluginPagePlacementFixture({ pluginId: 'acme.tools', localId, title });

describe('Project page catalog', () => {
    it('keeps authored disabled wording separate from its canonical diagnostic', () => {
        const declaration = page('builds', 'Builds');
        const pages = resolveProjectPageCatalog({ target, placements: [{ ...declaration,
            availability: { ...declaration.availability,
                disabledWhen: { fact: 'project.exists', operator: 'equals', value: true },
                disabledReason: 'Builds are paused for this Project' } }],
            policyContext: { data: { project: { exists: true } } } });
        expect(pages.at(-1)).toMatchObject({ visible: true, disabledReason: 'Builds are paused for this Project',
            disabledReasonCode: 'policy_disabled' });
    });
    it('retains the canonical route refusal while excluding unknown or inapplicable entries from discovery', () => {
        const declaration = page('builds', 'Builds');
        const contextual = { ...declaration, availability: { ...declaration.availability,
            when: { fact: 'project.exists', operator: 'equals', value: true } as const } };
        const unknown = resolveProjectPageCatalogState({ target, placements: [contextual], policyContext: {} });
        expect(unknown.pages.map(entry => entry.id)).toEqual([...PROJECT_PAGES]);
        expect(unknown.routePages.at(-1)).toMatchObject({ visible: false, disabledReason: 'availability_fact_unavailable' });
        const baseline = resolveProjectPageCatalogState({ target, placements: [contextual],
            policyContext: { data: { project: { exists: true } } } });
        expect(baseline.pages.at(-1)).toBe(baseline.routePages.at(-1));
        let current = baseline;
        for (let index = 0; index < 20; index += 1) current = resolveProjectPageCatalogState({ target,
            placements: structuredClone([contextual]), policyContext: { data: { project: { exists: true } } }, baseline: current });
        expect(current).toBe(baseline);
        const falseState = resolveProjectPageCatalogState({ target, placements: [contextual],
            policyContext: { data: { project: { exists: false } } }, baseline });
        expect(falseState.pages).toHaveLength(PROJECT_PAGES.length);
        expect(falseState.routePages.at(-1)).toMatchObject({ visible: false, disabledReason: 'availability_not_applicable' });
    });
    it('pins the six Project page tabs by default and keeps later built-ins behind More (plan 12 D44)', () => {
        const placements = resolveNavigationPlacements(resolveProjectPageCatalog({ target }));
        expect(placements.pinned.map(item => item.id)).toEqual(['overview', 'code', 'changes', 'scripts', 'services', 'context']);
        expect(placements.overflow.map(item => item.id)).toEqual(['deployments', 'memory', 'defaults']);
        // A person's own choice still pins a later page.
        expect(resolveNavigationPlacements(resolveProjectPageCatalog({ target }), { orderedIds: [], placements: { deployments: 'pinned' } })
            .pinned.map(item => item.id)).toContain('deployments');
        // The phone bar follows the same default: later pages start in its More.
        const phone = resolveProjectPageCatalogState({ target }).items;
        expect(phone.filter(item => item.phonePlacement === 'more').map(item => item.id)).toEqual(expect.arrayContaining(['deployments', 'memory', 'defaults']));
        expect(phone.find(item => item.id === 'context')?.phonePlacement).toBe('bar');
    });
    it('describes built-ins then qualified project pages without a Machine', () => {
        const pages = resolveProjectPageCatalog({ target, placements: [page('builds', 'Builds')] });
        expect(pages.map(item => item.id)).toEqual([...PROJECT_PAGES, 'plugin:acme.tools:builds']);
        expect(pages.at(-1)).toMatchObject({ kind: 'plugin', title: 'Builds', destination: { pluginId: 'acme.tools', localId: 'builds' },
            href: '/projects/checkout-a/plugins/acme.tools/builds?serverId=home-a', disabledReason: null });
    });
    it('publishes no new semantic descriptors for equal relevant refresh, changes one keyed page, and never reuses another target', () => {
        const placements = [page('builds', 'Builds'), page('notes', 'Notes')];
        const baseline = resolveProjectPageCatalog({ target, placements });
        const equal = resolveProjectPageCatalog({ target, placements: structuredClone(placements), baseline });
        expect(equal).toBe(baseline);
        const changed = resolveProjectPageCatalog({ target, placements: [placements[0]!, page('notes', 'Journal')], baseline });
        expect(changed.filter(item => !baseline.includes(item))).toHaveLength(1);
        const other = resolveProjectPageCatalog({ target: { ...target, workspaceRefId: 'checkout-b' }, placements, baseline });
        expect(other.every(item => !baseline.includes(item))).toBe(true);
    });
});


describe('Project unified detail navigation', () => {
    it('links Changes to its one page and companion while keeping App tools companion-only', () => {
        const binding = normalizePluginUiDestinationBindingV1({ pluginId: 'acme.tools', destinationId: 'app-tool',
            rendererId: 'app-tool', container: 'rightSidebarTab', target: { kind: 'app' } });
        if (!binding) throw new Error('App companion fixture must be admitted by Protocol');
        const state = resolveProjectPageCatalogState({ target, sidebar: { appPluginPlacements: [{
            id: 'surfacePlacement:acme.tools:app-tool', pluginId: 'acme.tools', contributionKind: 'surfacePlacement',
            descriptorId: 'app-tool', binding, target: binding.target, renderer: { kind: 'host', rendererId: 'app-tool' },
            display: { developerFallback: 'App tool' }, headerActions: [],
            availability: { state: 'available', reason: 'available', diagnostics: [] },
        }] } });
        expect(state.items.find(item => item.id === 'plugin:acme.tools:app-tool')).toMatchObject({
            navigation: { kind: 'companion', companion: 'plugin:acme.tools:app-tool' },
        });
        const changes = state.items.find(item => item.id === 'changes');
        expect(changes).toMatchObject({ navigation: { kind: 'both', page: 'changes', companion: 'git' },
            phonePlacement: 'bar', page: state.pages.find(page => page.id === 'changes'), companion: { id: 'git' } });
        expect(state.items.filter(item => item.page).map(item => item.id))
            .toEqual(state.pages.map(page => page.id));
        expect(state.items.some(item => item.id === 'git')).toBe(false);
        const selected = resolveProjectPageCatalogState({ target, activePage: 'changes', baseline: state });
        expect(selected.items.find(item => item.id === 'changes')?.companion?.hiddenInLauncher).toBe(true);
        const overview = resolveProjectPageCatalogState({ target, activePage: 'overview', baseline: selected });
        expect(overview.items.find(item => item.id === 'changes')?.companion?.hiddenInLauncher).not.toBe(true);
        expect(overview.pages).toBe(state.pages);
    });
});
