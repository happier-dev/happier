// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installUiListsCommonModuleMocks } from '@/components/ui/lists/uiListsTestHelpers';
import { createPluginPagePlacementFixture } from '@/dev/testkit/fixtures/pluginPageProjectionFixture';

installUiListsCommonModuleMocks();
vi.mock('@/utils/web/reactDomCjs', () => ({
    // ReactTestRenderer cannot mount DOM portals; keep the real popover/menu beneath this boundary.
    requireReactDOM: () => ({ createPortal: (children: React.ReactNode) => children }),
}));

const { ProjectShellHeader } = await import('./ProjectShellHeader');
const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
const { EntityFlatReorderList } = await import('@/components/ui/treeDragDrop/ui/EntityFlatReorder');
const { resolveProjectPageCatalog } = await import('../detail/projectPageCatalog');

describe('Project header page descriptors', () => {
    afterEach(standardCleanup);

    it('keeps a same-named machine\'s telling suffix whole when the chip shortens', async () => {
        const pages = resolveProjectPageCatalog({ target: { kind: 'project', workspaceRefId: 'project', serverId: 'home' }, surface: 'projects' });
        const screen = await renderScreen(<ProjectShellHeader projectName="Project"
            checkout={{ machineName: 'NLDW3-5-36-33 · 5ac7', machineNameParts: { name: 'NLDW3-5-36-33', hint: '5ac7' },
                machineIcon: 'desktop', branch: null, choices: [], onSelect: () => {} }}
            pages={pages.slice(0, 1)} activePage="overview" onSelectPage={() => {}} onNewSession={null} menuActions={[]} />);
        const texts = screen.root.findAll(node => typeof node.props?.children === 'string').map(node => node.props.children as string);
        expect(texts).toContain('NLDW3-5-36-33');
        expect(texts).toContain(' · 5ac7');
        await screen.unmount();
    });

    it('changes placement from a tab menu without changing selection, and keeps Overview pinned', async () => {
        const pages = resolveProjectPageCatalog({ target: { kind: 'project', workspaceRefId: 'project', serverId: 'home' } });
        const preferences = { orderedIds: ['code', 'overview'], placements: {} };
        const writes: unknown[] = [];
        let customizations = 0;
        const screen = await renderScreen(<ProjectShellHeader projectName="Project" checkout={null}
            pages={pages.slice(0, 2)} activePage="overview" onSelectPage={() => { throw new Error('Menu changed selection'); }}
            onNewSession={null} menuActions={[]} onCustomizeTabs={() => { customizations += 1; }}
            placement={{ items: pages, preferences, scope: { serverId: 'home', accountId: 'account' },
                onChange: next => { writes.push(next); } }} />);
        const codeTab = screen.findHostByTestId('project-shell-header.pages:code')!;
        expect(codeTab.props.onContextMenu).toBeTypeOf('function');
        await React.act(async () => { codeTab.props.onContextMenu({ preventDefault() {}, stopPropagation() {} }); });
        const menu = screen.root.findAllByType(DropdownMenu).find(node => node.props.open === true)!;
        expect(menu.props.items.find((item: { id: string }) => item.id === 'pinned')).toMatchObject({ checked: true });
        const selectPlacement = menu.props.onSelect;
        await React.act(async () => { menu.props.onOpenChange(false); });
        await React.act(async () => { await selectPlacement('overflow'); });
        expect(writes).toEqual([{ orderedIds: ['code', 'overview'], placements: { code: 'overflow' } }]);
        await React.act(async () => { screen.findHostByTestId('project-shell-header.pages:overview')!.props.onContextMenu({ preventDefault() {}, stopPropagation() {} }); });
        const overviewMenu = screen.root.findAllByType(DropdownMenu).find(node => node.props.open === true)!;
        expect(overviewMenu.props.items.map((item: { id: string }) => item.id)).toEqual(['customize']);
        await React.act(async () => { overviewMenu.props.onSelect('customize'); });
        expect(customizations).toBe(1);
        expect(writes).toHaveLength(1);
    });

    it('reorders the tab bar through the placement binding while retaining hidden pages and their choices', async () => {
        const pages = resolveProjectPageCatalog({ target: { kind: 'project', workspaceRefId: 'project', serverId: 'home' } });
        const writes: unknown[] = [];
        const screen = await renderScreen(<ProjectShellHeader projectName="Project" checkout={null}
            pages={pages.slice(0, 2)} activePage="overview" onSelectPage={() => {}} onNewSession={null} menuActions={[]}
            placement={{ items: pages, preferences: { orderedIds: ['overview', 'code', 'changes'], placements: { changes: 'hidden' } },
                scope: { serverId: 'home', accountId: 'account' }, onChange: next => { writes.push(next); } }} />);
        const binding = screen.root.findByType(EntityFlatReorderList).props.binding;
        const admission = binding.resolve('code', { anchorId: 'overview', placement: 'before' });
        expect(admission.status).toBe('allowed');
        expect(admission.effect).toMatchObject({ actionId: 'settings.set', input: { anchor: 'appearance.navigationPlacements' } });
        await React.act(async () => { expect(await binding.execute(admission.effect)).toEqual({ status: 'applied' }); });
        expect(writes).toEqual([expect.objectContaining({ orderedIds: expect.arrayContaining(['code', 'overview', 'changes']), placements: { changes: 'hidden' } })]);
        expect((writes[0] as { orderedIds: string[] }).orderedIds.slice(0, 3)).toEqual(['code', 'overview', 'changes']);
    });

    it('announces the authored disabled explanation instead of interpreting it as a diagnostic code', async () => {
        const placement = createPluginPagePlacementFixture({ pluginId: 'external.tools', localId: 'builds', title: 'Builds' });
        const pages = resolveProjectPageCatalog({ target: { kind: 'project', workspaceRefId: 'project', serverId: 'home' },
            placements: [{ ...placement, availability: { ...placement.availability,
                disabledWhen: { fact: 'project.exists', operator: 'equals', value: true },
                disabledReason: 'Builds are paused for this Project' } }],
            policyContext: { data: { project: { exists: true } } } });
        const external = pages.at(-1)!;
        const screen = await renderScreen(<ProjectShellHeader projectName="Project" checkout={null}
            pages={[external]} activePage="overview" onSelectPage={() => {}} onNewSession={null} menuActions={[]} />);
        expect(screen.findHostByTestId(`project-shell-header.pages:${external.id}`)?.props.accessibilityLabel)
            .toContain(external.disabledReason);
    });

    it('keeps an explicitly overflowed external page reachable in More, and a visible selected tab once opened', async () => {
        const pages = resolveProjectPageCatalog({ target: { kind: 'project', workspaceRefId: 'project', serverId: 'home' },
            placements: [createPluginPagePlacementFixture({ pluginId: 'external.tools', localId: 'builds', title: 'Builds' })] });
        const external = pages.find(page => page.id === 'plugin:external.tools:builds')!;
        const selected: string[] = [];
        let customizations = 0;
        const scene = (activePage: string) => <ProjectShellHeader projectName="Project" checkout={null}
            pages={pages.slice(0, 1)} overflowPages={[external]} orderedPageIds={[external.id, 'overview']}
            activePage={activePage} onSelectPage={id => selected.push(id)} onNewSession={null} menuActions={[]}
            onCustomizeTabs={() => { customizations += 1; }} />;
        const screen = await renderScreen(scene('overview'));
        const menu = screen.root.findAllByType(DropdownMenu).find(menu =>
            menu.props.items.some((item: { id: string }) => item.id === external.id));
        expect(menu).toBeDefined();
        expect(menu?.props.items.find((item: { id: string }) => item.id === external.id)).toMatchObject({ title: external.title });
        // Customize is an operation row past the pages in the same menu.
        const customize = menu?.props.items.find((item: { id: string }) => item.id !== external.id);
        expect(customize).toBeDefined();
        await React.act(async () => { menu?.props.onSelect(customize.id); });
        expect(customizations).toBe(1);
        await React.act(async () => { await menu?.props.onSelect(external.id); });
        expect(selected).toEqual([external.id]);
        // Opened, the page is a selected tab in the row, never the More it was chosen from.
        await screen.update(scene(external.id));
        expect(screen.findHostByTestId(`project-shell-header.pages:${external.id}`)?.props.accessibilityState)
            .toMatchObject({ selected: true });
    });
});
