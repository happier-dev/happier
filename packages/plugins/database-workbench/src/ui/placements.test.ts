import { expect, it } from 'vitest';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { PluginManifestV2Schema } from '@happier-dev/protocol/plugins/manifest';
import { createDatabaseWorkbenchPlacements } from './placements.js';
import { PLUGIN_MANIFEST } from '../manifest.js';
import { WORKBENCH_RAIL_RENDERER_ID, WORKBENCH_RAIL_ARTIFACT_ID } from './surface/views.js';

it('publishes Database and Insights rail and details destinations through the committed rail renderer', () => {
    const ui = PLUGIN_MANIFEST.contributes.ui;
    expect(ui?.renderers?.find(renderer => renderer.id === WORKBENCH_RAIL_RENDERER_ID)).toMatchObject({
        kind: 'reactNative', artifact: WORKBENCH_RAIL_ARTIFACT_ID,
    });
    for (const kind of ['session', 'project']) {
        for (const name of ['database', 'insights']) {
            const destinations = ui?.views?.filter(view => view.target.kind === kind
                && view.id.startsWith(`${name}-${kind}-`)) ?? [];
            expect(destinations.map(view => view.container).sort()).toEqual(['detailsPane', 'rightSidebarTab']);
            expect(destinations.every(view => view.renderer === WORKBENCH_RAIL_RENDERER_ID)).toBe(true);
            expect(destinations.find(view => view.container === 'rightSidebarTab')).toMatchObject({ defaultPlacement: 'overflow' });
        }
    }
});

it('admits project and Session rail tabs and details destinations with the same renderer', () => {
    const plugin = definePlugin({
        id: 'happier.database', version: '0.0.0',
        ui: {
            views: createDatabaseWorkbenchPlacements({ databaseRenderer: 'database', insightsRenderer: 'insights' }),
            renderers: [
                { id: 'database', kind: 'declarative', root: { kind: 'text', text: 'Database fixture' } },
                { id: 'insights', kind: 'declarative', root: { kind: 'text', text: 'Insights fixture' } },
            ],
        },
    });
    // The published manifest owner admits every view id (the host loads nothing a manifest refuses).
    expect(PluginManifestV2Schema.safeParse(plugin.manifest).success).toBe(true);
    const views = plugin.manifest.contributes.ui?.views ?? [];
    expect(views).toHaveLength(8);
    expect(new Set(views.map(view => view.id)).size).toBe(8);
    for (const target of ['session', 'project']) {
        const scoped = views.filter(view => view.target.kind === target);
        expect(scoped).toHaveLength(4);
        for (const renderer of ['database', 'insights']) {
            const pair = scoped.filter(view => view.renderer === renderer);
            expect(pair.map(view => view.container).sort()).toEqual(['detailsPane', 'rightSidebarTab']);
            expect(pair.find(view => view.container === 'rightSidebarTab')).toMatchObject({ defaultPlacement: 'overflow' });
        }
    }
});
