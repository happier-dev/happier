import { definePlugin } from '@happier-dev/plugin-sdk';
import { PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1 } from '@happier-dev/plugin-sdk/ui/build';
import type { PluginUiHostApi, PluginUiWidgetAreaOperationV1 } from '@happier-dev/plugin-sdk/ui';

export const widgetAreasPlugin = definePlugin({
    id: 'examples.widget-areas', version: '1.0.0', displayName: 'Widget areas',
    runtime: { apiVersion: Number(PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.toolchain.runtime) as 1 },
    resources: { count: { source: 'dynamic', kind: 'config', scope: 'global', contentType: 'application/json',
        runtime: { read: () => JSON.stringify({ count: 42 }), observe: () => ({ dispose() {} }) } } },
    ui: {
        views: [
            { id: 'overview', container: 'appPage', target: { kind: 'app' }, renderer: 'count-renderer',
                widgetAreas: [{ name: 'pinned', contextSchema: { type: 'object', properties: { filter: { type: 'string' } },
                    required: ['filter'], additionalProperties: false } }] },
            { id: 'counter', container: 'widget', target: { kind: 'app' }, renderer: 'count-renderer',
                resources: [{ pluginId: 'examples.widget-areas', localId: 'count' }],
                inputs: { fields: [{ path: 'filter', title: 'Filter', widget: 'text', required: true }] },
                inputSchema: { type: 'object', properties: { filter: { type: 'string' } }, required: ['filter'], additionalProperties: false } },
        ],
        renderers: [{ id: 'count-renderer', kind: 'declarative', root: { kind: 'text', text: 'Registered count' } }],
    },
});

/** Native and declarative pages use the shared area port; hosted HTML uses ordinary widget Actions. */
export function runWidgetAreaExample(host: Pick<PluginUiHostApi, 'widgetArea'>, operation: PluginUiWidgetAreaOperationV1, filter = 'open') {
    return host.widgetArea({ area: 'pinned', context: { filter }, operation });
}
