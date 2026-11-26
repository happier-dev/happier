import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { withFiniteTypecheckProjectInputs } from '../../../scripts/workspaces/workspaceSourceTypecheck.mjs';
import { deriveTypecheckProjects, prepareDerivedTypecheckProjects } from '../../../scripts/workspaces/deriveTypecheckProjects.mjs';

const sourceNames = ['foundation', 'services', 'core', 'source'];
const testNames = ['test', 'test-ui'];
const names = [...sourceNames, ...testNames];
const isBrowserHost = owner => owner.ownsForeignPrivateNamespace
  && owner.parsed.options.lib?.includes('lib.dom.d.ts');

export function deriveCliTypecheckProjects(packageDir, options = {}) {
  return deriveTypecheckProjects(packageDir, { sourceNames, testNames, resolveSourceOwners: true,
    // DOM types also belong to Protocol and plugins. Only actual UI reachability
    // selects UI composition; every other producer retains its own declarations.
    testGroup: (_path, context) => context.owners.some(isBrowserHost) ? 1 : 0,
    testCompilerOptions: (contexts, consumer) => {
      const owners = contexts.flatMap(context => context.owners);
      if (!owners.some(isBrowserHost)) return {};
      // Libraries are additive. JSX and export conditions remain consumer-owned;
      // producer references retain their own compiler options.
      const libraries = [consumer, ...owners].flatMap(owner =>
        ts.convertToTSConfig(owner.parsed, owner.configPath, ts.sys).compilerOptions.lib ?? []);
      return { lib: [...new Set(libraries)].sort() };
    },
    ...options });
}

export function prepareCliTypecheckProjects(projects, cwd) {
  return prepareDerivedTypecheckProjects(projects, cwd, { names, derive: deriveCliTypecheckProjects });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
  const inventory = await withFiniteTypecheckProjectInputs(packageDir, () => deriveCliTypecheckProjects(packageDir, {
    check: process.argv.includes('--check'), writeAuthored: process.argv.includes('--write-authored'),
  }));
  console.log(JSON.stringify(inventory));
}
