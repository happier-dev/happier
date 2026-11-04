import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { uiTypedRoutesDeclaration } from './uiTypedRoutesDeclaration.mjs';
export { uiTypedRoutesDeclaration } from './uiTypedRoutesDeclaration.mjs';
import { deriveTypecheckProjects, prepareDerivedTypecheckProjects } from '../../../scripts/workspaces/deriveTypecheckProjects.mjs';

const sourceNames = ['foundation', 'core', 'source'];
const testNames = ['test-components', 'test-other'];
const names = [...sourceNames, ...testNames];

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
