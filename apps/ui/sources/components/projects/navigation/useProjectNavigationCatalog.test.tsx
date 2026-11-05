import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import * as owner from '../detail/projectPageCatalog';
import { createPluginPagePlacementFixture } from '@/dev/testkit/fixtures/pluginPageProjectionFixture';
import { useProjectNavigationCatalog } from './useProjectNavigationCatalog';

afterEach(() => { standardCleanup(); vi.restoreAllMocks(); });
it('does zero resolutions for equivalent Project renders and placement/viewport changes, and one for a changed scope', async () => {
    const resolve = vi.spyOn(owner, 'resolveProjectPageCatalogState');
    const target = { kind: 'project', workspaceRefId: 'checkout-a', serverId: 'home' } as const;
    const placements = [createPluginPagePlacementFixture({ pluginId: 'acme.tools', localId: 'notes', title: 'Notes' })];
    const observed: ReturnType<typeof useProjectNavigationCatalog>[] = [];
    function Project(props: Readonly<{ title: string; width: number; preference: string }>) {
        const pages = React.useMemo(() => props.title === 'Notes' ? placements
            : [{ ...placements[0]!, display: { ...placements[0]!.display, title: props.title } }], [props.title]);
        observed.push(useProjectNavigationCatalog({ target, placements: pages }));
        return null;
    }
    const screen = await renderScreen(<Project title="Notes" width={1200} preference="desktop" />);
    expect(resolve).toHaveBeenCalledTimes(1);
    const initial = observed.at(-1)!;
    await screen.update(<Project title="Notes" width={390} preference="phone-top" />);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(observed.at(-1)).toBe(initial);
    await screen.update(<Project title="Journal" width={390} preference="phone-top" />);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(observed.at(-1)?.pages.at(-1)?.title).toBe('Journal');
    expect(observed.at(-1)?.items[0]).toBe(initial.items[0]);
});
