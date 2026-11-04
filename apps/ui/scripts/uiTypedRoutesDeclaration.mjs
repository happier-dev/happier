import { createRequire } from 'node:module';
import { relative, resolve } from 'node:path';

// The commit checker supplies the reviewed tree's paths; public typechecks use disk.
// Both consume Expo's configured route inventory and its one declaration generator.
export function uiTypedRoutesDeclaration(packageDir, sourceFiles) {
  const require = createRequire(resolve(packageDir, 'package.json'));
  const { exp } = require('expo/config').getConfig(packageDir, {
    skipSDKVersionRequirement: true, skipPlugins: true,
  });
  if (exp.experiments?.typedRoutes !== true) return;
  // Resolve Expo's private generator through the SDK's declared dependency
  // closure, so preparation uses the same installed versions as Expo CLI.
  const expoRequire = createRequire(require.resolve('expo/package.json'));
  const cliRequire = createRequire(expoRequire.resolve('@expo/cli/package.json'));
  const { getRouterDirectoryModuleIdWithManifest } = cliRequire('./build/src/start/server/metro/router');
  const appRoot = resolve(packageDir, getRouterDirectoryModuleIdWithManifest(packageDir, exp));
  const { requireContext, inMemoryContext } = require('expo-router/internal/testing');
  const { EXPO_ROUTER_CTX_IGNORE } = require('expo-router/_ctx-shared');
  const { resolver } = require(resolve(packageDir, 'metro.config.js'));
  const blockList = Array.isArray(resolver.blockList) ? resolver.blockList : [resolver.blockList];
  const routePaths = sourceFiles
    ? sourceFiles.map(file => relative(appRoot, file).replaceAll('\\', '/'))
      .filter(file => file !== '..' && !file.startsWith('../') && !file.startsWith('/'))
      .map(file => `./${file}`).filter(file => EXPO_ROUTER_CTX_IGNORE.test(file))
    : requireContext(appRoot, true, EXPO_ROUTER_CTX_IGNORE).keys();
  const context = inMemoryContext(Object.fromEntries(routePaths
    .filter(file => !blockList.some(rule => rule instanceof RegExp && rule.test(resolve(appRoot, file))))
    .map(file => [file, {}])));
  // Finite compilation needs the completed declaration now, not Expo's
  // watcher debounce. Use the exact generator underlying regenerateDeclarations.
  const { getTypedRoutesDeclarationFile } = cliRequire('@expo/router-server/build/typed-routes/generate');
  const declaration = getTypedRoutesDeclarationFile(context, exp.extra?.router);
  return { path: resolve(packageDir, '.expo/types/router.d.ts'), declaration };
}
