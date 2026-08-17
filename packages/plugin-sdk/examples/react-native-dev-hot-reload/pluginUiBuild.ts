import { defineBuildConfig } from '@happier-dev/plugin-sdk/ui/build';
export const pluginUiBuildConfig = defineBuildConfig({ projectRoot: '.', outDir: 'dist/ui-development', targets: [
    {
        rendererId: 'panel-native-dev',
        entry: 'ui/panel.native.tsx',
        kind: 'reactNative',
        platforms: ['web', 'ios', 'android'],
        module: {
            containerName: 'examples_react_native_dev_hot_reload_panel_native_dev',
            modulePath: './renderSurface',
            exportName: 'renderSurface',
        },
    },
] });
export default pluginUiBuildConfig;
