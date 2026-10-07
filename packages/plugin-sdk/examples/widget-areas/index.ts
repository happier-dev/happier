import { watch } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { definePlugin } from '@happier-dev/plugin-sdk';
import type { PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';
import type { PluginResourceContextV1 } from '@happier-dev/plugin-sdk/resources';
import { PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1 } from '@happier-dev/plugin-sdk/ui/build';
import type { PluginUiHostApi, PluginUiWidgetAreaOperationV1 } from '@happier-dev/plugin-sdk/ui';

const directoryInputSchema = {
    type: 'object', additionalProperties: false, required: ['directory', 'filter'],
    properties: { directory: { type: 'string', minLength: 1 }, filter: { type: 'string', enum: ['files', 'folders'] } },
} satisfies PluginJsonSchema;

function readDirectoryInputs(context: PluginResourceContextV1) {
    const input = context.kind === 'surface' ? context.launchInput : null;
    if (!input || typeof input !== 'object' || Array.isArray(input)
        || !('directory' in input) || !('filter' in input)
        || typeof input.directory !== 'string' || input.directory.length === 0
        || (input.filter !== 'files' && input.filter !== 'folders')) {
        throw new Error('Directory count needs a directory and a Files or Folders filter from its mounted surface.');
    }
    return { directory: input.directory, filter: input.filter };
}

export const widgetAreasPlugin = definePlugin({
    id: 'examples.widget-areas', version: '1.0.0', displayName: 'Widget areas',
    runtime: { apiVersion: Number(PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.toolchain.runtime) as 1 },
    entrypoints: { daemon: './dist/index.js' },
    resources: { count: { source: 'dynamic', kind: 'config', scope: 'surface', contentType: 'application/json',
        runtime: {
            read: async ({ context }) => {
                const { directory, filter } = readDirectoryInputs(context);
                const entries = await readdir(directory, { withFileTypes: true });
                return JSON.stringify({ directory, filter,
                    count: entries.filter(entry => filter === 'files' ? entry.isFile() : entry.isDirectory()).length });
            },
            observe: (invalidate, { context }) => {
                const { directory } = readDirectoryInputs(context);
                const watcher = watch(directory, invalidate);
                watcher.on('error', invalidate);
                return { dispose: () => watcher.close() };
            },
        } } },
    ui: {
        views: [
            { id: 'overview', title: 'Widget areas', container: 'appPage', target: { kind: 'app' }, renderer: 'overview-native',
                widgetAreas: [{ name: 'pinned', contextSchema: directoryInputSchema }] },
            { id: 'counter', title: 'Directory count', container: 'widget', target: { kind: 'app' }, renderer: 'counter-native',
                sizeDeclaration: { sizes: ['small', 'medium', 'wide', 'full'], defaultSize: 'medium' },
                resources: [{ pluginId: 'examples.widget-areas', localId: 'count' }],
                inputs: { fields: [
                    { path: 'directory', title: 'Directory on the serving machine', widget: 'text', required: true },
                    { path: 'filter', title: 'Count', widget: 'select', required: true,
                        options: [{ value: 'files', label: 'Files' }, { value: 'folders', label: 'Folders' }] },
                ] },
                inputSchema: directoryInputSchema },
        ],
        renderers: [
            { id: 'overview-native', kind: 'reactNative', artifact: 'overview-native', requiredHostMethods: ['widgetArea'] },
            { id: 'counter-native', kind: 'reactNative', artifact: 'counter-native', requiredHostMethods: ['readResource', 'watchResource'] },
        ],
    },
});

export const { manifest, activate } = widgetAreasPlugin;

/** Native and declarative pages use the shared area port; hosted HTML uses ordinary widget Actions. */
export function runWidgetAreaExample(host: Pick<PluginUiHostApi, 'widgetArea'>, operation: PluginUiWidgetAreaOperationV1, filter = 'files', directory = '.') {
    return host.widgetArea({ area: 'pinned', context: { directory, filter }, operation });
}
