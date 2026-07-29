import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import * as Repack from '@callstack/repack';

const projectRoot = dirname(fileURLToPath(import.meta.url));
const contributionId = 'panel-native';
const containerName = 'examples_react_native_installed_panel_native';

export default Repack.defineRspackConfig((env) => {
    const { platform = 'ios', mode = 'production' } = env;

    return {
        mode,
        context: projectRoot,
        entry: {},
        resolve: {
            ...Repack.getResolveOptions(platform),
        },
        output: {
            uniqueName: containerName,
            path: join(projectRoot, 'dist/ui/react-native', contributionId, platform),
            publicPath: 'noop:///',
            chunkFilename: '[name].chunk.bundle',
        },
        module: {
            rules: [
                ...Repack.getJsTransformRules({ codegen: { enabled: false } }),
                ...Repack.getAssetTransformRules(),
            ],
        },
        plugins: [
            new Repack.plugins.RepackTargetPlugin(),
            new Repack.plugins.ModuleFederationPlugin({
                name: containerName,
                filename: `${platform}.bundle.js`,
                exposes: {
                    './renderSurface': './ui/panel.native.tsx',
                },
                shared: {
                    react: { singleton: true, eager: false, import: false },
                    'react-native': { singleton: true, eager: false, import: false },
                },
            }),
        ],
    };
});
