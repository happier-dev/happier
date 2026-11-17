import * as React from 'react';
import { PluginRightSidebarCountsState, formatPluginRightSidebarCount, type PluginRightSidebarCountDescriptor,
    type PluginRightSidebarLabelledCount } from '@/components/appShell/rightSidebar/rightSidebarPluginCount';
import { PluginContextualResourceStoreProvider } from '@/components/plugins/surfaces/PluginContextualResourceStoreProvider';
import type { ProjectPageDescriptor } from '@/components/projects/detail/projectPageCatalog';
import { resolveNavigationPlacements, type NavigationPlacementPreferences } from '@/sync/domains/settings/navigationPlacement';
import type { ProjectPageCatalogModel } from './useProjectPageCatalog';

/** Presentation of the count owner's ordered values, never a second numeric interpretation. */
export type ProjectPageChromeDescriptor = ProjectPageDescriptor & Readonly<{
    count?: string;
    counts?: readonly PluginRightSidebarLabelledCount[];
}>;
type CountScope = Pick<ProjectPageCatalogModel, 'context' | 'projection' | 'authority'>;
type CountedPages = readonly ProjectPageChromeDescriptor[];
type CountValue = number | null | readonly PluginRightSidebarLabelledCount[];
const selectCount = (count: number | null, counts?: readonly PluginRightSidebarLabelledCount[]): CountValue => counts ?? count;

/** The same Account Resource owner is borrowed by page content, desktop tabs and phone chrome. */
export function ProjectPageChromeCounts(props: CountScope & Readonly<{
    pages: readonly ProjectPageDescriptor[];
    preferences?: NavigationPlacementPreferences;
    children: (pages: CountedPages) => React.ReactNode;
}>) {
    const placements = React.useMemo(() => resolveNavigationPlacements(props.pages, props.preferences), [props.pages, props.preferences]);
    const target = props.context.target;
    const runtime = React.useMemo(() => ({ pluginUiProjection: props.projection,
        machineId: target?.checkout?.machineId ?? null, serverId: props.context.scope.serverId,
        accountLifetime: props.authority, interactionEnabled: target !== null }),
        [props.projection, props.context.scope.serverId, props.authority, target]);
    const items = React.useMemo(() => props.pages.flatMap(page => {
        const plugin = page.pluginPage;
        if (!plugin || !plugin.counts && !plugin.countResourceId) return [];
        const descriptor: PluginRightSidebarCountDescriptor = {
            tab: { plugin: { pluginId: plugin.pluginId, descriptorId: plugin.descriptorId }, placement: plugin.placement,
                ...(plugin.disabledReason ? { disabledReason: plugin.disabledReason } : {}),
                ...(plugin.counts ? { counts: plugin.counts } : {}),
                ...(plugin.countResourceId ? { countResourceId: plugin.countResourceId } : {}) },
            runtime, ...(target ? { target } : {}),
        };
        return [{ id: page.id, descriptor, active: placements.effectivePlacements[page.id] !== 'hidden' }];
    }), [props.pages, runtime, target, placements.effectivePlacements]);
    return <PluginContextualResourceStoreProvider><PluginRightSidebarCountsState items={items} select={selectCount}>
        {values => <ProjectPageCountPresentation pages={props.pages} values={values}>{props.children}</ProjectPageCountPresentation>}
    </PluginRightSidebarCountsState></PluginContextualResourceStoreProvider>;
}

function ProjectPageCountPresentation(props: Readonly<{
    pages: readonly ProjectPageDescriptor[];
    values: ReadonlyMap<string, CountValue>;
    children: (pages: CountedPages) => React.ReactNode;
}>) {
    // This baseline only reconciles formatted DTO identities. Values and subscriptions
    // remain owned by the canonical keyed count presentation and Resource store.
    const previous = React.useRef<Readonly<{ input: typeof props.pages; output: CountedPages; values: typeof props.values }> | null>(null);
    const pages = React.useMemo(() => {
        const prior = previous.current;
        const indices = new Map(prior?.input.map((page, index) => [page.id, index]));
        const rows = props.pages.map((page): ProjectPageChromeDescriptor => {
            const value = props.values.get(page.id);
            const index = indices.get(page.id);
            if (index !== undefined && prior?.input[index] === page && prior.values.get(page.id) === value) return prior.output[index]!;
            if (value === undefined || value === null) return page;
            const counts = typeof value === 'number' ? undefined : value;
            const count = formatPluginRightSidebarCount(typeof value === 'number' ? value : null, counts);
            return Object.freeze({ ...page, count, ...(counts ? { counts } : {}) });
        });
        const output = prior?.output.length === rows.length && rows.every((page, index) => page === prior.output[index])
            ? prior.output : Object.freeze(rows);
        previous.current = { input: props.pages, output, values: props.values };
        return output;
    }, [props.pages, props.values]);
    return props.children(pages);
}
