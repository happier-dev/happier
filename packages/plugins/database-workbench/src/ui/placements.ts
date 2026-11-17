import type { PluginUiViewV2Input } from '@happier-dev/plugin-sdk/ui';

/** D23 uses the same renderer for each rail and its details destination. */
export function createDatabaseWorkbenchPlacements(renderers: Readonly<{
    databaseRenderer: string; insightsRenderer: string;
}>): PluginUiViewV2Input[] {
    const views: PluginUiViewV2Input[] = [];
    for (const target of [{ kind: 'session' }, { kind: 'project' }] as const) {
        const { kind } = target;
        for (const [name, renderer] of [['database', renderers.databaseRenderer], ['insights', renderers.insightsRenderer]] as const) {
            for (const container of ['rightSidebarTab', 'detailsPane'] as const) {
                const common = { id: `${name}-${kind}-${container}`, renderer,
                    title: name === 'database' ? 'Database' : 'Insights' };
                if (container === 'rightSidebarTab') {
                    views.push(kind === 'session'
                        ? { ...common, container, target: { kind }, defaultPlacement: 'overflow' }
                        : { ...common, container, target: { kind }, defaultPlacement: 'overflow' });
                } else {
                    views.push(kind === 'session'
                        ? { ...common, container, target: { kind } }
                        : { ...common, container, target: { kind } });
                }
            }
        }
    }
    return views;
}
