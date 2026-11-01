import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deriveTypecheckProjects, prepareDerivedTypecheckProjects } from '../../../scripts/workspaces/deriveTypecheckProjects.mjs';

const sourceNames = ['foundation', 'core', 'source'];
const testNames = ['test-components', 'test-other'];
const names = [...sourceNames, ...testNames];

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

function prepareUiTypedRoutes(packageDir) {
  const routes = uiTypedRoutesDeclaration(packageDir);
  if (!routes) return;
  // Expo's live watcher owns .expo/types/router.d.ts and can regenerate it
  // while finite programs compile. Keep this input with the finite configs.
  const outputDir = resolve(packageDir, 'node_modules/.cache/tsc');
  mkdirSync(outputDir, { recursive: true });
  const outputPath = resolve(outputDir, 'router.d.ts');
  const temporaryPath = resolve(outputDir, `.router.${process.pid}.tmp`);
  writeFileSync(temporaryPath, routes.declaration);
  renameSync(temporaryPath, outputPath);
  process.stderr.write(`[typescript] prepared UI typed routes: ${outputPath}\n`);
  return { declarationOverrides: new Map([[routes.path, outputPath]]) };
}


export function deriveUiTypecheckProjects(packageDir, options = {}) {
  return deriveTypecheckProjects(packageDir, {
    sourceNames, testNames,
    testGroup: path => path.startsWith('sources/components/') ? 0 : 1,
    ...options,
  });
}

export async function prepareUiTypecheckProjects(projects, cwd) {
  return prepareDerivedTypecheckProjects(projects, cwd, {
    names: projects.length === sourceNames.length ? sourceNames : names,
    derive: packageDir => deriveUiTypecheckProjects(packageDir, prepareUiTypedRoutes(packageDir)),
  });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
  const writeAuthored = process.argv.includes('--write-authored');
  console.log(JSON.stringify(await deriveUiTypecheckProjects(packageDir, {
    ...(!writeAuthored ? prepareUiTypedRoutes(packageDir) : {}),
    check: process.argv.includes('--check'), writeAuthored,
  })));
}
