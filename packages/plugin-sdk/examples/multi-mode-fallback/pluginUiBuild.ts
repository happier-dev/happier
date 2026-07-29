import { definePluginUiBuildConfig } from '@happier-dev/plugin-sdk/ui/build';
export const pluginUiBuildConfig = definePluginUiBuildConfig({ projectRoot: '.', outDir: 'dist/ui', targets: [
    {
        rendererId: 'panel-native',
        entry: 'ui/panel.tsx',
        kind: 'reactNative',
        platforms: ['web', 'ios', 'android'],
        module: {
            containerName: 'examples_multi_mode_fallback_panel_native',
            modulePath: './renderSurface',
            exportName: 'renderSurface',
        },
    },
    { rendererId: 'panel-web', entry: 'ui/panel.tsx', kind: 'hostedWeb', platforms: ['web', 'ios', 'android', 'desktop'] },
] });
export default pluginUiBuildConfig;
