import { defineBuildConfig } from '@happier-dev/plugin-sdk/ui/build';

export const pluginUiBuildConfig = defineBuildConfig({
    projectRoot: '.',
    outDir: 'dist/ui',
    targets: [
        {
            rendererId: 'projects-tasks-native',
            entry: 'ui/panel.native.tsx',
            kind: 'reactNative',
            platforms: ['web', 'ios', 'android'],
            module: {
                containerName: 'examples_projects_tasks_native',
                modulePath: './renderSurface',
                exportName: 'renderSurface',
            },
        },
    ],
});

export default pluginUiBuildConfig;
