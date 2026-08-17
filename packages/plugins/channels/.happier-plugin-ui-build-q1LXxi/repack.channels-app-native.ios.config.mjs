import * as Repack from '@callstack/repack';
import {
  createPluginUiPackageInstanceRepackPlugin,
  createReactNativeRepackResolveOptions,
  createReactNativeRepackSharedModules,
} from '@happier-dev/plugin-sdk/ui/build';

const projectRoot = "/Users/leeroy/Documents/Development/happier/dev/packages/plugins/channels";
const expectedPlatform = "ios";
const moduleIdentity = Object.freeze({"containerName":"happier_channels_channels_app_native","modulePath":"./renderSurface","exportName":"renderSurface"});

export default function config(env = {}) {
  const { platform = expectedPlatform, mode = 'production' } = env;
  if (platform !== expectedPlatform) {
    throw new Error(`Managed Re.Pack config expected ${expectedPlatform}, received ${platform}`);
  }
  return {
    mode,
    context: projectRoot,
    entry: {},
    resolve: {
      ...createReactNativeRepackResolveOptions(Repack.getResolveOptions(platform)),
    },
    output: {
      uniqueName: moduleIdentity.containerName,
      path: "/Users/leeroy/Documents/Development/happier/dev/packages/plugins/channels/node_modules/.cache/happier-plugin-ui/react-native/channels-app-native/ios",
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
      createPluginUiPackageInstanceRepackPlugin(),
      new Repack.plugins.RepackTargetPlugin(),
      new Repack.plugins.ModuleFederationPlugin({
        name: moduleIdentity.containerName,
        filename: `${platform}.bundle.js`,
        exposes: {
          [moduleIdentity.modulePath]: "./src/ui/renderSurface.tsx",
        },
        shared: createReactNativeRepackSharedModules(),
      }),
    ],
  };
}
