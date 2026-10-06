import { definePlugin } from '@happier-dev/plugin-sdk';
import { PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1 } from '@happier-dev/plugin-sdk/ui/build';
import type { PluginUiHostApi, PluginUiWidgetAreaOperationV1 } from '@happier-dev/plugin-sdk/ui';

export const widgetAreasPlugin = definePlugin({
    id: 'examples.widget-areas', version: '1.0.0', displayName: 'Widget areas',
    runtime: { apiVersion: Number(PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.toolchain.runtime) as 1 },
    entrypoints: { daemon: './dist/index.js' },
    resources: { count: { source: 'dynamic', kind: 'config', scope: 'global', contentType: 'application/json',
        runtime: { read: () => JSON.stringify({ count: 42 }), observe: () => ({ dispose() {} }) } } },
    ui: {
        views: [
            { id: 'overview', title: 'Widget areas', container: 'appPage', target: { kind: 'app' }, renderer: 'overview-native',
                widgetAreas: [{ name: 'pinned', contextSchema: { type: 'object', properties: { filter: { type: 'string' } },
                    required: ['filter'], additionalProperties: false } }] },
            { id: 'counter', title: 'Registered count', container: 'widget', target: { kind: 'app' }, renderer: 'counter-native',
                resources: [{ pluginId: 'examples.widget-areas', localId: 'count' }],
                inputs: { fields: [{ path: 'filter', title: 'Filter', widget: 'text', required: true }] },
                inputSchema: { type: 'object', properties: { filter: { type: 'string' } }, required: ['filter'], additionalProperties: false } },
        ],
        renderers: [
            { id: 'overview-native', kind: 'reactNative', artifact: 'overview-native', requiredHostMethods: ['widgetArea'] },
            { id: 'counter-native', kind: 'reactNative', artifact: 'counter-native', requiredHostMethods: ['readResource', 'watchResource'] },
        ],
    },
});

export const { manifest, activate } = widgetAreasPlugin;

/** Native and declarative pages use the shared area port; hosted HTML uses ordinary widget Actions. */
export function runWidgetAreaExample(host: Pick<PluginUiHostApi, 'widgetArea'>, operation: PluginUiWidgetAreaOperationV1, filter = 'open') {
    return host.widgetArea({ area: 'pinned', context: { filter }, operation });
}
