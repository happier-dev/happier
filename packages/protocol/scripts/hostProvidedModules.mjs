import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { build, version as esbuildVersion } from 'esbuild';
import { withWorkspaceBundleLock } from '../../../scripts/workspaces/workspaceBundleLock.mjs';
import { tmpdir } from 'node:os';

/**
 * Host-provided Protocol modules for Plugin UI artifacts.
 *
 * Plugin UIs run in the app (React Native/Hermes on iOS and Android, the same
 * source on web and desktop) and, for Account runtimes, in the CLI. Each host
 * supplies every public Protocol subpath whose import graph the React Native
 * host can load, so artifacts stop bundling private Protocol copies. The set is
 * derived here from the real import graph (React Native resolution: the
 * `react-native`/`browser` fields and `browser` replacement maps); nobody edits
 * it by hand. A subpath already provided that stops being loadable fails the
 * generator, because older artifacts rely on it and mobile would break first.
 */
export const HOST_PROVIDED_SUBPATHS_FILE = 'src/plugins/ui/hostProvidedProtocolSubpaths.generated.ts';
export const HOST_PROVIDED_MODULES_FILE = 'src/plugins/ui/hostProvidedProtocolModules.generated.ts';
export const HOST_PROVIDED_MODULE_LOADERS_FILE = 'src/plugins/ui/hostProvidedProtocolModuleLoaders.generated.ts';
const generatedSources = new Set([HOST_PROVIDED_SUBPATHS_FILE, HOST_PROVIDED_MODULES_FILE, HOST_PROVIDED_MODULE_LOADERS_FILE]
  .map(file => file.slice('src/'.length, -'.ts'.length)));
const cacheFile = 'node_modules/.cache/happier-protocol-host-provided-modules.json';
const analyzerIdentity = createHash('sha256')
  .update(await readFile(fileURLToPath(import.meta.url))).update(esbuildVersion).digest('hex');
const nodeBuiltins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));
const rnDisabledNamespace = 'happier-react-native-disabled';
const stdinFile = '<host-provided-protocol-modules>';

/** The same resolution React Native's Metro applies: installed packages by their
 * React Native fields, workspace packages by their `happier-source` export (so a
 * dependency whose dist is not built yet still resolves during export generation). */
const reactNativeResolution = Object.freeze({
  platform: 'browser',
  mainFields: ['react-native', 'browser', 'module', 'main'],
  conditions: ['happier-source', 'react-native', 'browser', 'module', 'import', 'default'],
});

const specifierOf = key => `@happier-dev/protocol/${key.slice(2)}`;

/** Every public specifier (pattern sources plus exact aliases) and the source module it loads. */
function readCandidates(publicSources, exports) {
  const candidates = new Map();
  for (const source of publicSources) {
    if (!generatedSources.has(source)) candidates.set(specifierOf(`./${source}`), source);
  }
  for (const [key, entry] of Object.entries(exports)) {
    if (key === '.' || key === './package.json' || key.includes('*') || !entry || typeof entry !== 'object') continue;
    const source = String(entry['happier-source'] ?? '').replace(/^\.\/src\//, '').replace(/\.ts$/, '');
    if (publicSources.has(source) && !generatedSources.has(source)) candidates.set(specifierOf(key), source);
  }
  return new Map([...candidates].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
}

async function analyzeImportGraph(packageRoot, sources) {
  const unloadable = new Map();
  const result = await build({
    absWorkingDir: packageRoot,
    stdin: {
      contents: sources.map((source, index) => `export * as m${index} from './src/${source}.ts';`).join('\n'),
      resolveDir: packageRoot, sourcefile: stdinFile, loader: 'ts',
    },
    ...reactNativeResolution,
    bundle: true, write: false, format: 'esm', treeShaking: false, minify: false, sourcemap: false,
    legalComments: 'none', metafile: true, logLevel: 'silent',
    plugins: [{
      name: 'happier-react-native-loadability',
      setup(pluginBuild) {
        pluginBuild.onResolve({ filter: /.*/ }, async args => {
          if (!nodeBuiltins.has(args.path) || args.pluginData?.builtinProbe) return null;
          // A package may replace a builtin with `false` in its browser map
          // (tweetnacl's guarded `require('crypto')`); Metro honours that too.
          const mapped = await pluginBuild.resolve(args.path, {
            kind: args.kind, importer: args.importer, resolveDir: args.resolveDir, pluginData: { builtinProbe: true },
          });
          if (mapped.errors.length === 0 && !args.path.startsWith('node:')) {
            return { path: args.path, namespace: rnDisabledNamespace };
          }
          unloadable.set(relative(packageRoot, args.importer).replaceAll('\\', '/'), args.path);
          return { path: args.path, external: true };
        });
        pluginBuild.onLoad({ filter: /.*/, namespace: rnDisabledNamespace }, () => ({ contents: 'module.exports = {};', loader: 'js' }));
      },
    }],
  });
  const files = Object.keys(result.metafile.inputs).filter(file => !file.startsWith(`${rnDisabledNamespace}:`));
  const edges = new Map(files.map(file => [file, result.metafile.inputs[file].imports
    .filter(imported => !imported.external && !imported.path.startsWith(`${rnDisabledNamespace}:`))
    .map(imported => imported.path)]));
  // A source without top-level import/export (an empty file) is not a module to
  // TypeScript, so the generated namespace import of it would not compile.
  const modules = new Set();
  for (const source of sources) {
    const file = `src/${source}.ts`;
    if (/^[ \t]*(?:import|export)\b/mu.test(await readFile(join(packageRoot, file), 'utf8'))) modules.add(file);
  }
  return { files: files.filter(file => file !== stdinFile), edges, unloadable, modules };
}

/** The import chain from one module to the Node-only import that makes it unloadable. */
function explainUnloadable(start, graph) {
  const previous = new Map([[start, null]]);
  const queue = [start];
  while (queue.length > 0) {
    const file = queue.shift();
    if (graph.unloadable.has(file)) {
      const chain = [graph.unloadable.get(file)];
      for (let at = file; at; at = previous.get(at)) chain.unshift(at);
      return chain.join(' -> ');
    }
    for (const next of graph.edges.get(file) ?? []) {
      if (!previous.has(next)) { previous.set(next, file); queue.push(next); }
    }
  }
  return start;
}

function deriveProvided(candidates, graph) {
  const importers = new Map();
  for (const [file, imports] of graph.edges) {
    for (const imported of imports) {
      if (!importers.has(imported)) importers.set(imported, []);
      importers.get(imported).push(file);
    }
  }
  const unloadable = new Set(graph.unloadable.keys());
  const queue = [...unloadable];
  while (queue.length > 0) {
    for (const importer of importers.get(queue.pop()) ?? []) {
      if (!unloadable.has(importer)) { unloadable.add(importer); queue.push(importer); }
    }
  }
  const provided = [];
  const refused = new Map();
  for (const [specifier, source] of candidates) {
    const file = `src/${source}.ts`;
    if (unloadable.has(file)) refused.set(specifier, explainUnloadable(file, graph));
    else if (graph.modules.has(file)) provided.push(specifier);
  }
  return { provided, refused };
}

async function digestFiles(packageRoot, files) {
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file).update('\0');
    try { hash.update(await readFile(join(packageRoot, file))); } catch { hash.update('missing'); }
    hash.update('\0');
  }
  return hash.digest('hex');
}

async function readCache(packageRoot) {
  try { return JSON.parse(await readFile(join(packageRoot, cacheFile), 'utf8')); } catch { return null; }
}

/**
 * The analysis is keyed by its exact inputs: the candidate list and the
 * contents of every file the last graph reached (Protocol sources and the
 * installed packages they import). A file outside that graph cannot change the
 * result until a reached file starts importing it.
 */
async function analyze(packageRoot, candidates, signal) {
  const sources = [...new Set(candidates.values())].sort();
  const candidateKey = createHash('sha256').update(analyzerIdentity)
    .update(JSON.stringify([...candidates])).digest('hex');
  const readCurrent = async () => {
    const cached = await readCache(packageRoot);
    return cached?.candidateKey === candidateKey && Array.isArray(cached.files)
      && cached.filesDigest === await digestFiles(packageRoot, cached.files)
      ? { provided: cached.provided, refused: new Map(cached.refused) } : null;
  };
  const current = await readCurrent();
  if (current) return current;
  // Concurrent preparations over the same tree run one analysis; the others
  // wait for it and adopt its record when their inputs still match it.
  return await withWorkspaceBundleLock(async () => await readCurrent() ?? await analyzeAndRecord(packageRoot, candidates, sources, candidateKey), {
    // Host-local and always writable: revision trees mount the package read-only.
    lockPath: join(tmpdir(), `happier-protocol-host-modules-${createHash('sha256').update(packageRoot).digest('hex').slice(0, 16)}.lock`),
    timeoutMs: null, errorLabel: 'Protocol host-module analysis', signal,
  });
}

async function analyzeAndRecord(packageRoot, candidates, sources, candidateKey) {
  const startedAt = Date.now();
  const graph = await analyzeImportGraph(packageRoot, sources);
  const derived = deriveProvided(candidates, graph);
  // One full esbuild graph walk; under Protocol churn it dominates test preparation.
  console.error(`[protocol-host-modules] analyzed ${graph.files.length} files for ${candidates.size} subpaths in ${Date.now() - startedAt}ms`);
  const files = [...graph.files].sort();
  const record = { candidateKey, files, filesDigest: await digestFiles(packageRoot, files),
    provided: derived.provided, refused: [...derived.refused] };
  try {
    await mkdir(dirname(join(packageRoot, cacheFile)), { recursive: true });
    const temporary = `${join(packageRoot, cacheFile)}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(record));
    await rename(temporary, join(packageRoot, cacheFile));
  } catch (error) {
    // The record only skips repeated analysis; a read-only tree still generates.
    console.warn('[protocol-host-modules] analysis record not written', error instanceof Error ? error.message : error);
  }
  return derived;
}

function readPreviouslyProvided(text) {
  return new Set(text === null ? [] : [...text.matchAll(/'(@happier-dev\/protocol\/[^']+)'/gu)].map(match => match[1]));
}

const header = [
  '// Generated by packages/protocol/scripts/generate-exports.mjs. Do not edit.',
  '// Every public Protocol subpath whose import graph the React Native host can load.',
  '// The plugin UI compiler leaves these external; every Plugin UI host provides them.',
].join('\n');

function renderSubpaths(provided) {
  return `${header}\nexport const PLUGIN_UI_HOST_PROVIDED_PROTOCOL_SPECIFIERS: readonly string[] = Object.freeze([\n${
    provided.map(specifier => `    '${specifier}',\n`).join('')}]);\n`;
}

function renderModules(provided, candidates) {
  const sources = [...new Set(provided.map(specifier => candidates.get(specifier)))].sort();
  const local = new Map(sources.map((source, index) => [source, `m${index}`]));
  const fromModules = relative(dirname(HOST_PROVIDED_MODULES_FILE), 'src').replaceAll('\\', '/');
  return `${header}\n${sources.map(source => `import * as ${local.get(source)} from '${fromModules}/${source}.js';\n`).join('')}
export const PLUGIN_UI_HOST_PROVIDED_PROTOCOL_MODULES: Readonly<Record<string, unknown>> = Object.freeze({\n${
  provided.map(specifier => `    '${specifier}': ${local.get(candidates.get(specifier))},\n`).join('')}});\n`;
}

/**
 * The same set for Metro and compiled CLI hosts. Literal requires keep each edge
 * visible to bundlers while deferring evaluation. The unbundled CLI ESM host
 * supplies its own synchronous resolver.
 */
function renderModuleLoaders(provided) {
  return `${header}
export const HAS_BUNDLED_PROTOCOL_MODULE_REQUIRE = typeof require === 'function';
export const PLUGIN_UI_HOST_PROVIDED_PROTOCOL_MODULE_LOADERS: Readonly<Record<string, () => unknown>> = Object.freeze({
${provided.map(specifier => `    '${specifier}': () => require('${specifier}'),\n`).join('')}});\n`;
}

async function readText(path) {
  try { return await readFile(path, 'utf8'); } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

/** Derives the generated files; throws when a listed (provided) subpath stopped being loadable. */
export async function deriveHostProvidedProtocolModules({ packageRoot, publicSources, exports, signal }) {
  const candidates = readCandidates(publicSources, exports);
  const { provided, refused } = await analyze(packageRoot, candidates, signal);
  const currentSubpaths = await readText(join(packageRoot, HOST_PROVIDED_SUBPATHS_FILE));
  const regressions = [...readPreviouslyProvided(currentSubpaths)].filter(specifier => refused.has(specifier));
  if (regressions.length > 0) {
    throw new Error([
      'Protocol subpaths provided to Plugin UI hosts are no longer loadable by React Native:',
      ...regressions.map(specifier => `  ${specifier}: ${refused.get(specifier)}`),
      'Plugin artifacts already rely on the host providing these modules. Keep them free of Node-only imports',
      '(move the Node-only code to a separate module) instead of withdrawing them from the host.',
    ].join('\n'));
  }
  const currentModules = await readText(join(packageRoot, HOST_PROVIDED_MODULES_FILE));
  const currentModuleLoaders = await readText(join(packageRoot, HOST_PROVIDED_MODULE_LOADERS_FILE));
  const listed = [...readPreviouslyProvided(currentSubpaths)];
  const providedSet = new Set(provided);
  // A set that lacks newer loadable modules is still coherent: the compiler and
  // every host read the same files, so those modules are bundled as before.
  // Verification-only callers (CI, workers, publication) accept it; authoring regenerates.
  const coherent = currentSubpaths !== null && listed.every(specifier => providedSet.has(specifier))
    && currentSubpaths === renderSubpaths(listed) && currentModules === renderModules(listed, candidates)
    && currentModuleLoaders === renderModuleLoaders(listed);
  return {
    coherent,
    files: [
      { path: join(packageRoot, HOST_PROVIDED_SUBPATHS_FILE), current: currentSubpaths, next: renderSubpaths(provided) },
      { path: join(packageRoot, HOST_PROVIDED_MODULES_FILE), current: currentModules, next: renderModules(provided, candidates) },
      { path: join(packageRoot, HOST_PROVIDED_MODULE_LOADERS_FILE), current: currentModuleLoaders, next: renderModuleLoaders(provided) },
    ],
  };
}
