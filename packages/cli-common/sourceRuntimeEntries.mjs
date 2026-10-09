import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CLI_RUNTIME_SIDECAR_ENTRIES } from './cliRuntimeSidecars.mjs';

export const SOURCE_CONDITION = 'happier-source';

// Node source tools reuse the bundle resolver's authored workspace authority.
// This adapter maps only bare first-party imports; tsx retains transpilation.
let nodeWorkspacePackages;

export async function initialize(repoDir) {
  nodeWorkspacePackages = await readWorkspacePackages(repoDir);
}

async function resolveSourceImport(specifier, context, nextResolve) {
  // Loading the registration leaf is explicit source-tool intent. Preserve
  // Node's conditions while selecting source targets for package-local imports
  // too (for example SDK #http), without requiring another caller flag.
  const sourceContext = context.conditions.includes(SOURCE_CONDITION) ? context
    : { ...context, conditions: [...context.conditions, SOURCE_CONDITION] };
  if (specifier.startsWith('@happier-dev/') || nodeWorkspacePackages.has(packageNameOfSpecifier(specifier))) {
    return await nextResolve(pathToFileURL(resolveWorkspaceSource(nodeWorkspacePackages, specifier)).href, sourceContext);
  }
  return await nextResolve(specifier, sourceContext);
}

export { resolveSourceImport as resolve };

export function sourceExport(value, label) {
  const target = value?.[SOURCE_CONDITION];
  if (typeof target !== 'string' || !target.startsWith('./')) {
    throw new Error(`Source runtime requires an explicit ${SOURCE_CONDITION} export: ${label}`);
  }
  return target;
}

export async function readWorkspacePackages(repoDir) {
  const packages = new Map();
  for (const parent of ['packages', 'packages/plugins', 'apps']) {
    const directory = join(repoDir, parent);
    if (!existsSync(directory)) continue;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const root = join(directory, entry.name);
      if (!entry.isDirectory() || !existsSync(join(root, 'package.json'))) continue;
      const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
      if (typeof manifest.name === 'string' && manifest.name) packages.set(manifest.name, { root, manifest });
    }
  }
  return packages;
}

export function packageNameOfSpecifier(specifier) {
  return specifier.split('/').slice(0, specifier.startsWith('@') ? 2 : 1).join('/');
}

function sourceConditionTarget(declaration) {
  if (typeof declaration === 'string') return declaration;
  if (!declaration || typeof declaration !== 'object') return undefined;
  for (const condition of [SOURCE_CONDITION, 'node', 'import', 'default']) {
    const target = sourceConditionTarget(declaration[condition]);
    if (target !== undefined) return target;
  }
  return undefined;
}

export function resolveWorkspaceSource(packages, specifier) {
  const segments = specifier.split('/');
  const name = packageNameOfSpecifier(specifier);
  const owner = packages.get(name);
  if (!owner) throw new Error(`Source runtime workspace owner is missing: ${name}`);
  const nameLength = name.startsWith('@') ? 2 : 1;
  const key = segments.length === nameLength ? '.' : `./${segments.slice(nameLength).join('/')}`;
  const exports = owner.manifest.exports;
  let declaration = key === '.' && !Object.keys(exports ?? {}).some((key) => key.startsWith('.'))
    ? exports : exports?.[key];
  let replacement;
  if (declaration === undefined) {
    for (const [pattern, value] of Object.entries(exports ?? {})) {
      if (!pattern.includes('*')) continue;
      const [prefix, suffix] = pattern.split('*');
      if (key.startsWith(prefix) && key.endsWith(suffix)) {
        declaration = value;
        replacement = key.slice(prefix.length, key.length - suffix.length);
        break;
      }
    }
  }
  const target = sourceConditionTarget(declaration);
  if (typeof target !== 'string' || !target.startsWith('./') || /(?:^|\/)(?:dist|package-dist)\//.test(target)) {
    throw new Error(`Source runtime requires an explicit source export: ${specifier}`);
  }
  return resolve(owner.root, replacement === undefined ? target : target.replaceAll('*', replacement));
}

/** CLI exports/imports and the generated semantic projection are the entry
 * authority for both retained source QA and native artifact construction. */
export async function readCliSourceEntries({ repoDir, manifest, transform,
  cliPrefix = 'apps/cli', mainOutput = `${cliPrefix}/src/index`,
  publicPrefix = `${cliPrefix}/package-dist`,
  pluginPrefix = (name) => `packages/plugins/${name.slice('@happier-dev/plugins-'.length)}` }) {
  const projectDir = join(repoDir, 'apps/cli');
  const entries = { [mainOutput]: join(projectDir, 'src/index.ts') };
  for (const [key, value] of Object.entries(manifest.exports ?? {})) {
    const source = sourceExport(value, key);
    entries[`${publicPrefix}/${key === '.' ? 'index' : key.slice(2)}`] = resolve(projectDir, source);
  }
  for (const [key, value] of Object.entries(manifest.imports ?? {})) {
    const source = sourceExport(value, key);
    entries[`${publicPrefix}/${source.slice('./src/'.length).replace(/\.[^.]+$/, '')}`] = resolve(projectDir, source);
  }
  const pluginMetadata = [];
  const locatorPath = join(projectDir, 'src/plugins/projection/registry/sources/generatedBundledPluginManifests.ts');
  if (existsSync(locatorPath)) {
    const transformed = await transform(await readFile(locatorPath, 'utf8'), { loader: 'ts', format: 'esm' });
    const generated = await import(`data:text/javascript;base64,${Buffer.from(transformed.code).toString('base64')}`);
    for (const locator of generated.BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS) {
      if (!locator.daemonEntryPath) continue;
      const packageName = locator.sourceSpec.locator;
      const pluginDir = join(repoDir, 'packages/plugins', packageName.slice('@happier-dev/plugins-'.length));
      const pluginManifest = JSON.parse(await readFile(join(pluginDir, 'package.json'), 'utf8'));
      const prefix = pluginPrefix(packageName);
      const key = `${prefix}/dist/index`;
      entries[key] = resolve(pluginDir, sourceExport(pluginManifest.exports['.'], packageName));
      entries[`${prefix}/${locator.manifest.entrypoints.daemon.replace(/^\.\//, '').replace(/\.js$/, '')}`] = entries[key];
      for (const [importKey, declaration] of Object.entries(pluginManifest.imports ?? {})) {
        const source = sourceExport(declaration, `${packageName}:${importKey}`);
        const runtimeTarget = sourceConditionTarget({ ...declaration, [SOURCE_CONDITION]: undefined });
        if (typeof runtimeTarget !== 'string' || !runtimeTarget.startsWith('./')) {
          throw new Error(`Source runner import target is missing: ${packageName}:${importKey}`);
        }
        entries[`${prefix}/${runtimeTarget.slice(2).replace(/\.[^.]+$/, '')}`] = resolve(pluginDir, source);
      }
      for (const factory of locator.manifest.runtime.agentFactories ?? []) {
        const stem = factory.locator.module.replace(/^\.\//, '').replace(/\.js$/, '');
        const source = ['.ts', '.tsx', '.mts', '.js'].map((extension) => join(pluginDir, 'src', stem + extension)).find(existsSync);
        if (!source) throw new Error(`Source runner leaf is missing: ${packageName}:${factory.locator.module}`);
        entries[`${prefix}/dist/${stem}`] = source;
        entries[`${prefix}/${factory.normalizedModulePath.replace(/\.js$/, '')}`] = source;
      }
      pluginMetadata.push({ prefix, sourceDir: pluginDir, manifest: locator.manifest, package: pluginManifest });
    }
  }
  return { entries, pluginMetadata };
}

export function createWorkspaceSourceResolver({ workspacePackages, requireFromProject, externalPackages }) {
  return {
    name: 'workspace-source-exports',
    setup(builder) {
      builder.onResolve({ filter: /^[^./#]/ }, (args) => {
        if (args.path.startsWith('@/')) return;
        if (args.path.startsWith('@happier-dev/') || workspacePackages.has(packageNameOfSpecifier(args.path))) {
          return { path: resolveWorkspaceSource(workspacePackages, args.path) };
        }
        // Sodium's ESM wrapper references an unshipped sibling. Its authored
        // CJS entry is bundled without converting Ink's async ESM graph.
        if (args.path === 'libsodium-wrappers-sumo') return { path: requireFromProject.resolve(args.path) };
        if (args.path === 'libsodium-sumo') return;
        if (externalPackages === undefined || externalPackages.some((name) => args.path === name || args.path.startsWith(`${name}/`))) {
          return { path: args.path, external: true };
        }
      });
    },
  };
}

/** Built runtime packages must never select authored files they do not carry. */
export function runtimePackageExports(value) {
  if (Array.isArray(value)) return value.map(runtimePackageExports);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key])=>key!==SOURCE_CONDITION)
    .map(([key,target])=>[key,runtimePackageExports(target)]));
}

/** Executable sidecars own process-local source graphs, not npm package dist. */
export async function bundleCliSourceSidecars({repoDir, outputDir, build, workspacePackages, requireFromProject}) {
  const sourceDir = join(repoDir, 'apps/cli/scripts');
  const codeFiles = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, {withFileTypes:true})) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (/\.(?:cjs|mjs|js)$/.test(entry.name)) codeFiles.push(path);
    }
  }
  await mkdir(outputDir, {recursive:true});
  for (const [name] of CLI_RUNTIME_SIDECAR_ENTRIES) {
    const source = join(sourceDir,name);
    if (existsSync(source)) await cp(source,join(outputDir,name),{recursive:true});
  }
  await visit(outputDir);
  const metafile = {inputs:{},outputs:{}};
  for (const file of codeFiles) {
    if (!(await readFile(file,'utf8')).includes('@happier-dev/')) continue;
    const result = await build({
      absWorkingDir:repoDir, entryPoints:[join(sourceDir,relative(outputDir,file))], outfile:file,
      bundle:true, platform:'node', format:file.endsWith('.cjs')?'cjs':'esm', target:'node20',
      conditions:[SOURCE_CONDITION], metafile:true, logLevel:'silent',
      plugins:[createWorkspaceSourceResolver({workspacePackages,requireFromProject})],
    });
    Object.assign(metafile.inputs,result.metafile.inputs);
    Object.assign(metafile.outputs,result.metafile.outputs);
  }
  return {codeFiles,metafile};
}
