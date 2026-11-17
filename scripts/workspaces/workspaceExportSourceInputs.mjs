import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  collectPackageBuildOutputTargets,
  isLocalPackageBuildOutputTarget,
  isPackageBuildDistOutputTarget,
  resolvePackageBuildOutputTargetMatches,
} from './packageBuildOutputTargets.mjs';

const require = createRequire(import.meta.url);
const cliDistBuildManifest = require('../../packages/cli-common/cliDistBuildManifest.cjs');
const packageExportMatch = require('../../packages/cli-common/packageExportMatch.cjs');
let typescript;

function readExportedSourcePaths(packageDir, packageJson) {
  const outputs = declaration => collectPackageBuildOutputTargets({ exports: declaration })
    .filter(target => isLocalPackageBuildOutputTarget(target) && !isPackageBuildDistOutputTarget(target));
  const matches = target => resolvePackageBuildOutputTargetMatches({ packageDir, outputDir: join(packageDir, 'dist'), target });
  const paths = collectPackageBuildOutputTargets({ ...packageJson, exports: undefined })
    .filter(target => isLocalPackageBuildOutputTarget(target) && !isPackageBuildDistOutputTarget(target)).flatMap(matches);
  const exports = packageJson.exports;
  const entries = exports && typeof exports === 'object' && Object.keys(exports).some(key => key.startsWith('.'))
    ? Object.entries(exports) : [['.', exports]];
  for (const [key, declaration] of entries) {
    for (const target of outputs(declaration)) {
      for (const path of matches(target)) {
        const local = `./${relative(packageDir, path).split(sep).join('/')}`;
        const star = target.indexOf('*');
        const replacement = star < 0 ? undefined : local.slice(star, local.length - target.length + star + 1);
        const subpath = packageExportMatch.substitutePackageExportTarget(key, replacement);
        const selected = packageExportMatch.matchPackageExport(exports, subpath);
        if (selected && outputs(selected.declaration).some(value =>
          packageExportMatch.substitutePackageExportTarget(value, selected.replacement) === local)) paths.push(path);
      }
    }
  }
  return paths;
}

/** Declared authored exports are build inputs even when their names look like tests.
 * Resolve their local imports with the compiler API, not a second extension resolver.
 * Dependencies in other packages are inventoried by their own package owner. */
export function readWorkspaceExportSourceInputs(packageDir, packageJson) {
  const pending = readExportedSourcePaths(packageDir, packageJson);
  if (pending.length === 0) return [];
  const ts = typescript ??= require('typescript');
  const configPath = join(packageDir, 'tsconfig.json');
  const options = existsSync(configPath) ? ts.getParsedCommandLineOfConfigFile(configPath, {}, {
    ...ts.sys,
    // Only resolver options are needed; the inventory already walks the sources.
    readDirectory: () => [],
    onUnRecoverableConfigFileDiagnostic(diagnostic) {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
    },
  }).options : { module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler };
  const resolverOptions = { ...options, allowJs: true, resolveJsonModule: true };
  const cache = ts.createModuleResolutionCache(packageDir, path => ts.sys.useCaseSensitiveFileNames ? path : path.toLowerCase(), resolverOptions);
  const isLocalSource = path => {
    const local = relative(packageDir, path);
    return !isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`)
      && !local.split(sep).includes('node_modules') && !isPackageBuildDistOutputTarget(`./${local.split(sep).join('/')}`);
  };
  const files = new Set();
  for (const path of pending) {
    const local = relative(packageDir, path);
    if (!isLocalSource(path) || files.has(local)) continue;
    files.add(local);
    if (!/\.[cm]?[jt]sx?$/.test(path)) continue;
    for (const specifier of cliDistBuildManifest.extractModuleSpecifiers(readFileSync(path, 'utf8'))) {
      const resolved = ts.resolveModuleName(specifier, path, resolverOptions, ts.sys, cache).resolvedModule;
      if (resolved) pending.push(resolve(resolved.resolvedFileName));
    }
  }
  return [...files];
}
