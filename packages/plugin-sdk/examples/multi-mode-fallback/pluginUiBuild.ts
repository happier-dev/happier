import { defineBuildConfig } from '@happier-dev/plugin-sdk/ui/build';
export const pluginUiBuildConfig = defineBuildConfig({ projectRoot: '.', outDir: 'dist/ui', targets: [
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
    {
        rendererId: 'panel-web',
        entry: 'ui/panel.web.ts',
        kind: 'hostedWeb',
    },
] });
export default pluginUiBuildConfig;
