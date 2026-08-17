import { isAbsolute, relative, sep } from 'node:path';
import * as Repack from '@callstack/repack';
import {
  createPluginUiPackageInstanceRepackPlugin,
  createReactNativeRepackResolveOptions,
  createReactNativeRepackSharedModules,
} from '@happier-dev/plugin-sdk/ui/build';

const projectRoot = "/Users/leeroy/Documents/Development/happier/dev/packages/plugins/posthog";
const managedOperationRoot = "/Users/leeroy/Documents/Development/happier/dev/packages/plugins/posthog/.happier-plugin-ui-build-xmbX3v";
const managedOperationSourceRoot = '.happier-plugin-ui-build';
const expectedPlatform = "ios";
const moduleIdentity = Object.freeze({"containerName":"happier_posthog_posthog_issue_detail_native","modulePath":"./renderSurface","exportName":"renderSurface"});

function portableDevtoolResourcePath(absoluteResourcePath) {
  const jsonModulePrefix = absoluteResourcePath.startsWith('json|') ? 'json|' : '';
  const resourcePath = jsonModulePrefix === '' ? absoluteResourcePath : absoluteResourcePath.slice(jsonModulePrefix.length);
  const operationRelativePath = relative(managedOperationRoot, resourcePath);
  if (!isAbsolute(operationRelativePath) && operationRelativePath !== '..' && !operationRelativePath.startsWith(`..${sep}`)) {
    return `${jsonModulePrefix}${managedOperationSourceRoot}/${operationRelativePath.replace(/\\/gu, '/')}`;
  }
  return `${jsonModulePrefix}${relative(projectRoot, resourcePath).replace(/\\/gu, '/')}`;
}

function portableDevtoolModuleFilenameTemplate(info) {
  return `webpack://${moduleIdentity.containerName}/${portableDevtoolResourcePath(info.absoluteResourcePath)}`;
}

function portableDevtoolFallbackModuleFilenameTemplate(info) {
  return `${portableDevtoolModuleFilenameTemplate(info)}?${info.hash}`;
}

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
      path: "/Users/leeroy/Documents/Development/happier/dev/packages/plugins/posthog/node_modules/.cache/happier-plugin-ui/react-native/posthog-issue-detail-native/ios",
      publicPath: 'noop:///',
      chunkFilename: '[name].chunk.bundle',
      devtoolModuleFilenameTemplate: portableDevtoolModuleFilenameTemplate,
      devtoolFallbackModuleFilenameTemplate: portableDevtoolFallbackModuleFilenameTemplate,
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
