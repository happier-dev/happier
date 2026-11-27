import { isAscii } from 'node:buffer';
import { existsSync } from 'node:fs';
import { chmod, cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { isBuiltin } from 'node:module';
import { pathToFileURL } from 'node:url';
import { CLI_RUNTIME_SIDECAR_ENTRIES } from './cliRuntimeSidecars.mjs';
export { observeSourceRuntimeDependencies, assertSourceRuntimeDependenciesCurrent, SourceRuntimeReloadRequiredError } from './sourceRuntimeDependencies.mjs';

export const SOURCE_CONDITION = 'happier-source';

// A single non-Latin-1 comment widens the entire V8 Script source string.
// Let esbuild remove comments and lower raw templates before ASCII emission;
// keep legal text beside the executable source and preserve diagnostic names.
export const SOURCE_RUNTIME_OUTPUT_OPTIONS = Object.freeze({
  charset: 'ascii',
  minifyWhitespace: true,
  legalComments: 'external',
  supported: Object.freeze({ 'template-literal': false }),
});

// Split ESM output still runs bundled CommonJS code that reads `require`, `__filename` and
// `__dirname`, so emitters give every chunk this banner and these defines. Evaluating the banner
// builds a CommonJS Module (`createRequire`) and two path strings and adds three builtin imports;
// a daemon or session host loads ~1,500 chunks and fewer than one in ten reads these names.
// Emitters strip it from the others with stripUnusedSourceRuntimeBanners.
export const SOURCE_RUNTIME_COMMONJS_BANNER = "import { createRequire as __sourceCreateRequire } from 'node:module'; import {fileURLToPath as __sourceFileURLToPath} from 'node:url'; import {dirname as __sourcePathDirname} from 'node:path'; const require = __sourceCreateRequire(import.meta.url); const __sourceFilename = __sourceFileURLToPath(import.meta.url); const __sourceDirname = __sourcePathDirname(__sourceFilename);";
export const SOURCE_RUNTIME_COMMONJS_DEFINE = Object.freeze({ __dirname: '__sourceDirname', __filename: '__sourceFilename' });
// A textual match can only keep a banner that is not needed, never drop one that is.
const READS_COMMONJS_BANNER_BINDING = /\brequire\b|__sourceFilename|__sourceDirname/;

/**
 * Removes the CommonJS banner from a chunk that never reads its bindings. Only a banner at the top
 * of the chunk (after an optional shebang line) counts. Its line stays, empty, so line numbers still
 * match an external source map.
 */
export function stripUnusedSourceRuntimeBanner(code) {
  const at = code.indexOf(SOURCE_RUNTIME_COMMONJS_BANNER);
  if (at < 0) return code;
  if (at !== 0 && !(code.startsWith('#!') && code.indexOf('\n') + 1 === at)) return code;
  const rest = code.slice(at + SOURCE_RUNTIME_COMMONJS_BANNER.length);
  return READS_COMMONJS_BANNER_BINDING.test(rest) ? code : code.slice(0, at) + rest;
}

/** Applies stripUnusedSourceRuntimeBanner to emitted JavaScript files; returns how many changed. */
export async function stripUnusedSourceRuntimeBanners(files) {
  let stripped = 0;
  for (const file of new Set(files)) {
    if (!/\.m?js$/.test(file)) continue;
    const code = await readFile(file, 'utf8');
    const next = stripUnusedSourceRuntimeBanner(code);
    if (next === code) continue;
    await writeFile(file, next);
    stripped += 1;
  }
  return stripped;
}

// esbuild's split output gives each chunk a bare `import"./chunk.js"` for every chunk its graph reaches,
// a browser preload hint. Node keeps one resolve and load record per import statement and importer, so a
// daemon or session host held ~16 MiB of loader caches for ~250k such edges (95% redundant, 2026-11-16).
// A bare import whose target an EARLIER import of the same chunk already reaches is a no-op when it runs:
// dropping it leaves ESM evaluation order unchanged. The statement becomes spaces so lines and columns
// still match a source map.
const CHUNK_IMPORT_STATEMENT = /\s*import\s*(?:(?:\{[^}]*\}|\*\s*as\s+[\w$]+|[\w$]+(?:\s*,\s*(?:\{[^}]*\}|\*\s*as\s+[\w$]+))?)\s*from\s*)?(["'])([^"'\n]+)\1\s*;?/y;

/** Leading import statements of an emitted chunk (after an optional shebang and CommonJS banner). */
function readChunkImportPrologue(code) {
  const statements = [];
  let at = code.startsWith('#!') ? code.indexOf('\n') + 1 : 0;
  if (code.startsWith(SOURCE_RUNTIME_COMMONJS_BANNER, at)) at += SOURCE_RUNTIME_COMMONJS_BANNER.length;
  for (;;) {
    CHUNK_IMPORT_STATEMENT.lastIndex = at;
    const match = CHUNK_IMPORT_STATEMENT.exec(code);
    if (!match) {
      // The banner and the chunk's own imports may sit on separate lines; skip one empty or banner-only line.
      if (statements.length === 0 && code[at] === '\n') { at += 1; continue; }
      return statements;
    }
    const text = match[0];
    const start = match.index + (text.length - text.trimStart().length);
    statements.push({ start, end: match.index + text.length, specifier: match[2], bare: /^import\s*["']/.test(text.trimStart()) });
    at = match.index + text.length;
  }
}

/** Blanks redundant bare chunk imports in emitted JavaScript files; returns how many were dropped. */
export async function dropRedundantSourceRuntimeChunkImports(files) {
  const paths = [...new Set(files)].filter(file => /\.m?js$/.test(file)).map(file => resolve(file));
  const index = new Map(paths.map((file, i) => [file, i]));
  const codes = await Promise.all(paths.map(file => readFile(file, 'utf8')));
  const edges = codes.map((code, i) => readChunkImportPrologue(code).flatMap(statement => {
    if (!statement.specifier.startsWith('./') && !statement.specifier.startsWith('../')) return [];
    const target = index.get(resolve(dirname(paths[i]), statement.specifier));
    return target === undefined ? [] : [{ ...statement, target }];
  }));
  // Chunks each chunk reaches (Tarjan SCCs complete in reverse topological order).
  const reach = paths.map(() => null);
  const order = new Int32Array(paths.length).fill(-1), low = new Int32Array(paths.length), onStack = new Uint8Array(paths.length);
  const stack = []; let counter = 0;
  for (let root = 0; root < paths.length; root += 1) {
    if (order[root] !== -1) continue;
    const work = [[root, 0]];
    while (work.length > 0) {
      const frame = work[work.length - 1]; const node = frame[0];
      if (frame[1] === 0 && order[node] === -1) { order[node] = low[node] = counter++; stack.push(node); onStack[node] = 1; }
      if (frame[1] < edges[node].length) {
        const next = edges[node][frame[1]++].target;
        if (order[next] === -1) work.push([next, 0]); else if (onStack[next]) low[node] = Math.min(low[node], order[next]);
        continue;
      }
      work.pop();
      if (work.length > 0) { const parent = work[work.length - 1][0]; low[parent] = Math.min(low[parent], low[node]); }
      if (low[node] !== order[node]) continue;
      const component = []; let member;
      do { member = stack.pop(); onStack[member] = 0; component.push(member); } while (member !== node);
      const reached = new Set();
      for (const from of component) for (const edge of edges[from]) {
        reached.add(edge.target);
        if (!component.includes(edge.target)) for (const deeper of reach[edge.target]) reached.add(deeper);
      }
      for (const from of component) reach[from] = reached;
    }
  }
  let dropped = 0;
  await Promise.all(paths.map(async (file, i) => {
    const covered = new Set(); const blank = [];
    for (const edge of edges[i]) {
      if (edge.bare && covered.has(edge.target)) { blank.push(edge); continue; }
      covered.add(edge.target);
      for (const deeper of reach[edge.target]) covered.add(deeper);
    }
    if (blank.length === 0) return;
    let code = codes[i];
    for (const edge of blank.reverse()) code = code.slice(0, edge.start) + ' '.repeat(edge.end - edge.start) + code.slice(edge.end);
    await writeFile(file, code);
    dropped += blank.length;
  }));
  return dropped;
}

// esbuild's ASCII charset escapes strings, identifiers and templates but not
// regular-expression literals. V8 and JavaScriptCore then hold the whole chunk
// source as a two-byte string, so one Unicode regex doubles that chunk in memory.
// Emitters check their executable outputs here; the fix belongs to the regex owner.
/** Null for ASCII code; otherwise the first non-ASCII byte offset and its surrounding text. */
export function describeNonAsciiCode(bytes) {
  if (isAscii(bytes)) return null;
  const at = bytes.findIndex(byte => byte > 0x7f);
  return `byte ${at}: ${JSON.stringify(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).subarray(Math.max(0, at - 48), at + 16).toString('utf8'))}`;
}

export async function assertSourceRuntimeCodeAscii(files) {
  const offenders = [];
  for (const file of new Set(files)) {
    if (!/\.[cm]?js$/.test(file)) continue;
    const offender = describeNonAsciiCode(await readFile(file));
    if (offender) offenders.push(`${file} (${offender})`);
  }
  if (offenders.length) {
    throw new Error(`[source-runtime] emitted code must be ASCII; escape these Unicode regular expressions at their source owner:\n${offenders.join('\n')}`);
  }
}

// Node source tools reuse the bundle resolver's authored workspace authority.
// This adapter maps only bare first-party imports; tsx retains transpilation.
let nodeWorkspacePackages;

export async function initialize(repoDir) {
  nodeWorkspacePackages = await readWorkspacePackages(repoDir);
}

function resolveSourceImport(specifier, context, nextResolve) {
  // Loading the registration leaf is explicit source-tool intent. Preserve
  // Node's conditions while selecting source targets for package-local imports
  // too (for example SDK #http), without requiring another caller flag.
  const sourceContext = context.conditions.includes(SOURCE_CONDITION) ? context
    : { ...context, conditions: [...context.conditions, SOURCE_CONDITION] };
  if (specifier.startsWith('@happier-dev/') || nodeWorkspacePackages.has(packageNameOfSpecifier(specifier))) {
    // This owner already selected the exact authored file. Re-entering Node's
    // package resolver repeats package-scope export-map parsing for no decision.
    return { url: pathToFileURL(resolveWorkspaceSource(nodeWorkspacePackages, specifier)).href, shortCircuit: true };
  }
  return nextResolve(specifier, sourceContext);
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

/** Source producers use declared workspace dependencies, including compiler
 * tooling, rather than unrelated package source trees. */
export function workspaceSourcePackageClosure(packages, roots) {
  const selected = new Set();
  const visit = name => {
    if (selected.has(name) || !packages.has(name)) return;
    selected.add(name);
    const { manifest } = packages.get(name);
    for (const dependency of new Set([
      ...Object.keys({ ...manifest.dependencies, ...manifest.devDependencies,
        ...manifest.peerDependencies, ...manifest.optionalDependencies }),
      ...(manifest.bundledDependencies ?? []),
    ])) visit(dependency);
  };
  for (const name of roots) visit(name);
  return selected;
}

export function packageNameOfSpecifier(specifier) {
  return specifier.split('/').slice(0, specifier.startsWith('@') ? 2 : 1).join('/');
}

function sourceConditionTarget(declaration, conditions = []) {
  if (typeof declaration === 'string') return declaration;
  if (!declaration || typeof declaration !== 'object') return undefined;
  for (const condition of [...conditions, SOURCE_CONDITION, 'node', 'import', 'default']) {
    const target = sourceConditionTarget(declaration[condition], conditions);
    if (target !== undefined) return target;
  }
  return undefined;
}

export function resolveWorkspaceSource(packages, specifier, { conditions = [] } = {}) {
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
  const target = sourceConditionTarget(declaration, conditions);
  if (typeof target !== 'string' || !target.startsWith('./') || /(?:^|\/)(?:dist|package-dist)\//.test(target)) {
    throw new Error(`Source runtime requires an explicit source export: ${specifier}`);
  }
  return resolve(owner.root, replacement === undefined ? target : target.replaceAll('*', replacement));
}

/** Compiler programs consume authored exports even when an installed copy is
 * stale. JavaScript exports retain their authored declaration authority; TS
 * implementation exports remain source inputs rather than built declarations. */
export function workspaceSourceCompilerPaths(packages) {
  const paths = {};
  for (const [name, { root, manifest }] of packages) {
    const exports = manifest.exports;
    const declarations = Object.keys(exports ?? {}).some(key => key.startsWith('.'))
      ? Object.entries(exports) : [['.', exports]];
    for (const [key, declaration] of declarations) {
      const target = sourceConditionTarget(declaration);
      if (typeof target !== 'string' || !target.startsWith('./') || /(?:^|\/)(?:dist|package-dist)\//.test(target)) continue;
      const specifier = key === '.' ? name : name + key.slice(1);
      const types = sourceConditionTarget(declaration, ['types']);
      const authoredJavaScriptTypes = /\.[cm]?jsx?$/.test(target) && typeof types === 'string'
        && types.startsWith('./') && /\.d\.[cm]?ts$/.test(types) && !/(?:^|\/)(?:dist|package-dist)\//.test(types);
      paths[specifier] = [authoredJavaScriptTypes ? resolve(root, types) : resolveWorkspaceSource(packages, specifier)];
    }
  }
  return paths;
}

/** Private file-URL runtime entries share one projection in bundles and source trees. */
export function readCliPrivateSourceEntries({ projectDir, manifest, publicPrefix }) {
  return Object.fromEntries(Object.entries(manifest.imports ?? {}).map(([key, value]) => {
    const source = sourceExport(value, key);
    return [`${publicPrefix}/${source.slice('./src/'.length).replace(/\.[^.]+$/, '')}`, resolve(projectDir, source)];
  }));
}

/** CLI exports/imports and the generated semantic projection are the entry
 * authority for both retained source QA and native artifact construction. */
// readText/exists default to the checkout; the commit gate passes Git-revision readers so a candidate's
// entries never depend on other lanes' uncommitted bytes.
export async function readCliSourceEntries({ repoDir, manifest, transform,
  readText = (path) => readFile(path, 'utf8'), exists = existsSync,
  projectionRoot = repoDir,
  cliPrefix = 'apps/cli', mainOutput = `${cliPrefix}/src/index`,
  publicPrefix = `${cliPrefix}/package-dist`,
  pluginPrefix = (name) => `packages/plugins/${name.slice('@happier-dev/plugins-'.length)}` }) {
  const projectDir = join(repoDir, 'apps/cli');
  const projectionDir = join(projectionRoot, 'apps/cli');
  const entries = { [mainOutput]: join(projectDir, 'src/index.ts') };
  for (const [key, value] of Object.entries(manifest.exports ?? {})) {
    const source = sourceExport(value, key);
    entries[`${publicPrefix}/${key === '.' ? 'index' : key.slice(2)}`] = resolve(projectDir, source);
  }
  Object.assign(entries, readCliPrivateSourceEntries({ projectDir, manifest, publicPrefix }));
  const pluginMetadata = [];
  const locatorPath = join(projectionDir, 'src/plugins/projection/registry/sources/generatedBundledPluginManifests.ts');
  if (exists(locatorPath)) {
    const { decodeBundledDeclarationManifest } = await import('../../apps/cli/src/plugins/projection/registry/builtIn/declarationAssetFormat.mjs');
    const transformed = await transform(await readText(locatorPath), { loader: 'ts', format: 'esm' });
    const generated = await import(`data:text/javascript;base64,${Buffer.from(transformed.code).toString('base64')}`);
    for (const locator of generated.BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS) {
      const packageName = locator.sourceSpec.locator;
      const pluginDir = join(repoDir, 'packages/plugins', packageName.slice('@happier-dev/plugins-'.length));
      const pluginManifest = JSON.parse(await readText(join(pluginDir, 'package.json')));
      const prefix = pluginPrefix(packageName);
      const key = `${prefix}/dist/index`;
      entries[key] = resolve(pluginDir, sourceExport(pluginManifest.exports['.'], packageName));
      // Locators are locator-only; the manifest lives in the generated asset beside them.
      const pluginManifestDocument = locator.manifest
        ?? decodeBundledDeclarationManifest(Buffer.from(await readText(join(projectionDir, locator.manifestRelativePath))));
      // Declaration-only plugins still own packaged Resources and a package
      // root. A missing daemon contribution does not remove that closure.
      if (locator.daemonEntryPath) {
        entries[`${prefix}/${pluginManifestDocument.entrypoints.daemon.replace(/^\.\//, '').replace(/\.js$/, '')}`] = entries[key];
      }
      for (const [importKey, declaration] of Object.entries(pluginManifest.imports ?? {})) {
        const source = sourceExport(declaration, `${packageName}:${importKey}`);
        const runtimeTarget = sourceConditionTarget({ ...declaration, [SOURCE_CONDITION]: undefined });
        if (typeof runtimeTarget !== 'string' || !runtimeTarget.startsWith('./')) {
          throw new Error(`Source runner import target is missing: ${packageName}:${importKey}`);
        }
        entries[`${prefix}/${runtimeTarget.slice(2).replace(/\.[^.]+$/, '')}`] = resolve(pluginDir, source);
      }
      for (const factory of pluginManifestDocument.runtime.agentFactories ?? []) {
        const stem = factory.locator.module.replace(/^\.\//, '').replace(/\.js$/, '');
        const source = ['.ts', '.tsx', '.mts', '.js'].map((extension) => join(pluginDir, 'src', stem + extension)).find((path) => exists(path));
        if (!source) throw new Error(`Source runner leaf is missing: ${packageName}:${factory.locator.module}`);
        entries[`${prefix}/dist/${stem}`] = source;
        entries[`${prefix}/${factory.normalizedModulePath.replace(/\.js$/, '')}`] = source;
      }
      pluginMetadata.push({ prefix, sourceDir: pluginDir, manifest: pluginManifestDocument, package: pluginManifest });
    }
  }
  return { entries, pluginMetadata };
}

/** Source builders consume the same private locator for entry discovery and
 * imports, including when the checkout's generated module does not exist. */
export function createCliSourceProjectionResolver({ projectionRoot }) {
  const projectDir = join(projectionRoot, 'apps/cli');
  const path = join(projectDir, 'src/plugins/projection/registry/sources/generatedBundledPluginManifests.ts');
  return {
    name: 'cli-source-projections',
    setup(builder) {
      builder.onResolve({ filter: /(?:^|[/\\])generatedBundledPluginManifests(?:\.ts)?$/ },
        () => ({ path, namespace: 'daemon-projections' }));
      builder.onLoad({ filter: /.*/, namespace: 'daemon-projections' }, async () => ({
        contents: await readFile(path, 'utf8'), loader: 'ts', resolveDir: projectDir,
      }));
    },
  };
}

export function createWorkspaceSourceResolver({ workspacePackages, requireFromProject, externalPackages }) {
  const resolvingExternal = Symbol('source-runtime-external');
  return {
    name: 'workspace-source-exports',
    setup(builder) {
      builder.onResolve({ filter: /^[^./#]/ }, async (args) => {
        if (args.pluginData === resolvingExternal) return;
        if (args.path.startsWith('@/')) return;
        if (args.path.startsWith('@happier-dev/') || workspacePackages.has(packageNameOfSpecifier(args.path))) {
          return { path: resolveWorkspaceSource(workspacePackages, args.path) };
        }
        // Sodium's ESM wrapper references an unshipped sibling. Its authored
        // CJS entry is bundled without converting Ink's async ESM graph.
        if (args.path === 'libsodium-wrappers-sumo') return { path: requireFromProject.resolve(args.path) };
        if (args.path === 'libsodium-sumo') return;
        if (externalPackages === undefined) {
          if (isBuiltin(args.path)) return { path: args.path, external: true };
          // Shared chunks borrow the host's installed tree, which can be
          // relaid out after emission. Keep host-visible imports bare, but
          // bundle importer-local dependencies rather than selecting a
          // different host version or retaining a vanished installed path.
          const resolved = await builder.resolve(args.path, {
            kind: args.kind, importer: args.importer, resolveDir: args.resolveDir,
            namespace: args.namespace, pluginData: resolvingExternal,
          });
          // Optional, uninstalled imports keep their existing runtime failure.
          if (resolved.errors.length) return { path: args.path, external: true };
          const host = await builder.resolve(args.path, {
            kind: args.kind, resolveDir: dirname(requireFromProject.resolve.paths(args.path)[0]),
            namespace: args.namespace, pluginData: resolvingExternal,
          });
          return host.errors.length === 0 && host.path === resolved.path
            ? { path: args.path, external: true }
            : { path: resolved.path };
        }
        if (externalPackages.some((name) => args.path === name || args.path.startsWith(`${name}/`))) {
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

/**
 * Sidecars run without the CLI's file logger. Its import closure (settings,
 * persistence, Account auth) would otherwise inline most of Protocol into every
 * bundled sidecar: process_tree.cjs was 10.6 MB, and 2.5 MB without this edge.
 */
const SIDECAR_CLI_LOGGER_STUB = 'const noop=()=>undefined;export const logger=new Proxy({}, {get:()=>noop});';
const sidecarCliLoggerBoundary = {name:'sidecar-cli-logger-boundary', setup(builder) {
  builder.onLoad({filter:/apps[\\/]cli[\\/]src[\\/]ui[\\/]logger\.ts$/}, () => ({contents:SIDECAR_CLI_LOGGER_STUB, loader:'js'}));
}};

/** Executable sidecars own process-local source graphs, not npm package dist. */
export async function bundleCliSourceSidecars({repoDir, outputDir, build, workspacePackages, requireFromProject}) {
  const sourceDir = join(repoDir, 'apps/cli/scripts');
  const codeFiles = [];
  async function visit(directory) {
    // Captured source may be read-only; only the staged output is rewritten.
    await chmod(directory, (await stat(directory)).mode | 0o200);
    for (const entry of await readdir(directory, {withFileTypes:true})) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (/\.(?:cjs|mjs|js)$/.test(entry.name)) {
        await chmod(path, (await stat(path)).mode | 0o200);
        codeFiles.push(path);
      }
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
    const bundlesWorkspaceSource = (await readFile(file,'utf8')).includes('@happier-dev/');
    const result = await build({
      absWorkingDir:repoDir, entryPoints:[join(sourceDir,relative(outputDir,file))], outfile:file,
      bundle:bundlesWorkspaceSource, platform:'node', format:file.endsWith('.cjs')?'cjs':'esm', target:'node20',
      ...SOURCE_RUNTIME_OUTPUT_OPTIONS,
      conditions:[SOURCE_CONDITION], metafile:true, logLevel:'silent',
      plugins:bundlesWorkspaceSource?[sidecarCliLoggerBoundary,createWorkspaceSourceResolver({workspacePackages,requireFromProject})]:[],
    });
    Object.assign(metafile.inputs,result.metafile.inputs);
    Object.assign(metafile.outputs,result.metafile.outputs);
  }
  // Legal notices emitted next to sidecars belong to the same retained closure.
  return {codeFiles:[...new Set([...codeFiles, ...Object.keys(metafile.outputs).map(file => resolve(repoDir, file))])],metafile};
}
