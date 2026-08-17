import { defineBuildConfig } from '@happier-dev/plugin-sdk/ui/build';
export const pluginUiBuildConfig = defineBuildConfig({ projectRoot: '.', outDir: 'dist/ui', targets: [
    {
        rendererId: 'panel-native',
        entry: 'ui/panel.native.tsx',
        kind: 'reactNative',
        platforms: ['web', 'ios', 'android'],
        module: {
            containerName: 'examples_react_native_installed_panel_native',
            modulePath: './renderSurface',
            exportName: 'renderSurface',
        },
    },
] });
export default pluginUiBuildConfig;
