#!/usr/bin/env node
// Commit import-cycle check: refuse a packet when an import cycle through one of its changed modules
// has a module that reads an imported binding while it evaluates (a schema alias, `X.extend(...)`, a
// top-level call). Some load order then reads that binding before its module ran: a TDZ crash at start
// (2026-11-16: themeProfiles.ts:65 after 6964ea8f1a3). Type-only and function-body cycles pass.
//
//   node scripts/workspaces/commitImportCycles.mjs <base> <tree>    exit 0 clean, 1 new findings, 2 failure
//
// Static, from Git objects, no compiler program and no admission; replaces the runtime multi-order
// Protocol import (owner ruling 2026-11-16 "Checks must not cost more than they save"). Module
// resolution is the producer-closure view's (tsconfig paths, workspace packages, `happier-source`);
// eager-read and cycle semantics are the entry-load import-cycle guard's. Only findings the packet adds
// relative to its base refuse.
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, posix, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { collectImportBindingReads, findEvaluationCycles } from '../../apps/cli/scripts/importCycleEvaluation.mjs';
import {
  collectRuntimeModuleSpecifiers, findStronglyConnectedComponents, formatCycleKey, isTestModulePath,
} from '../../apps/cli/scripts/importCycleGuard.mjs';
import { gitIn, revisionView } from './commitProducerClosure.mjs';

const ts = createRequire(import.meta.url)('typescript');

const RUNTIME_MODULE = /\.(?:[cm]?[jt]s|[jt]sx)$/u;
const DECLARATION = /\.d\.[cm]?ts$/u;
// Over-approximates static runtime edges without parsing: every import/export-from and side-effect
// import except `import type` / `export type`. Only modules sharing a cycle on this graph are parsed.
const STATIC_IMPORT = /(?:^|[\n;])[ \t]*(?:import|export)(?![ \t]+type[\s{*])(?:[^'";]*?[\s}*]from)?\s*['"]([^'"\n]+)['"]/gu;
const IMPORT_REQUIRE = /\bimport\s+[\w$]+\s*=\s*require\(\s*['"]([^'"\n]+)['"]\s*\)/gu;

const RESOLUTION_INPUT = /(?:^|\/)(?:package\.json|tsconfig[^/]*\.json)$/u;
// HEAD moves every few minutes and each environment seeds the next, so a short history suffices.
const RESOLUTION_FILES_KEPT = 24;
const nul = text => text.split('\0').filter(Boolean);
const runtimeModules = new Map();
const isRuntimeModule = path => {
  if (!runtimeModules.has(path)) runtimeModules.set(path, RUNTIME_MODULE.test(path) && !DECLARATION.test(path) && !isTestModulePath(path));
  return runtimeModules.get(path);
};
// Scope: workspace library packages (packages/**), which many entries (UI, CLI, daemon, server, stack
// tooling) load in different orders, so an eager cyclic read crashes whichever entry reaches it first
// (2026-11-16 Protocol TDZs; this replaces the runtime multi-order Protocol import), plus the Node-loaded
// apps/cli and apps/stack (P03 ORCH 2026-11-17, cheap in the measured sample).
const IN_SCOPE = /^(?:packages|apps\/(?:cli|stack))\//u;
const isCyclic = (component, graph) => component.length > 1 || Boolean(graph.get(component[0])?.has(component[0]));

// Per-revision context: the tree view plus two caches that never change a verdict.
// - Blob facts are pure functions of a blob's bytes (its textual import list; its parsed runtime specifiers
//   and load-time reads per script kind), keyed by blob id: an unchanged module is never read or parsed again.
// - Resolutions (directory + specifier -> module) are a function of the tracked path set and the
//   package.json / tsconfig bytes (the resolution environment), keyed by its hash. A new environment is
//   seeded from the newest cached one through `git diff-tree`, dropping every entry the diff could change.
// Blob facts are one small file per blob (a run reads only the modules it touches); resolutions are one
// gzipped file per environment, of which the newest RESOLUTION_FILES_KEPT are kept. Without a cache
// directory both live in memory for one run only.
function cycleContext({ git, view, tree, store }) {
  const hash = createHash('sha1');
  for (const [path, oid] of view.blobs) {
    hash.update(path).update('\n');
    if (RESOLUTION_INPUT.test(path)) hash.update(oid).update('\n');
  }
  const env = hash.digest('hex');
  const ctx = { git, view, tree, store, env, blobs: new Map(), known: new Map(), resolutions: new Map(), added: 0,
    optionHashes: new Map(), seededFrom: null };
  const exact = store?.read(`res/${env}.json.gz`);
  if (exact) ctx.resolutions = new Map(exact.entries);
  else if (store) seedResolutions(ctx);
  return ctx;
}

function seedResolutions(ctx) {
  const seed = ctx.store.newest('res');
  if (!seed?.tree || !seed.options) return;
  let records;
  try {
    records = nul(ctx.git(['diff-tree', '-r', '-z', '--no-renames', '--name-status', seed.tree, ctx.tree]));
  } catch {
    return; // The seed's tree object is gone: start cold.
  }
  const added = [];
  const deleted = new Set();
  const manifests = [];
  for (let index = 0; index < records.length; index += 2) {
    const [status, path] = [records[index], records[index + 1]];
    if (/(?:^|\/)package\.json$/u.test(path)) manifests.push(path === 'package.json' ? '.' : posix.dirname(path));
    if (status === 'A') added.push(path);
    if (status === 'D') deleted.add(path);
  }
  // An added module can only satisfy a specifier whose last segment names it (x.ts, x/index.ts, x.tsx …).
  const stems = new Set(added.map(path => {
    const name = posix.basename(path).replace(/(?:\.d)?\.[^.]+$/u, '');
    return name === 'index' ? posix.basename(posix.dirname(path)) : name;
  }));
  // A manifest change re-resolves what goes through that package: its exports and main (every target
  // inside it), its `#imports`, and anything that resolved to nothing.
  const under = (path, dir) => dir === '.' || path === dir || path.startsWith(`${dir}/`);
  const workspacesChanged = seed.workspaces !== workspacesHash(ctx.view) || manifests.includes('.');
  for (const [key, target] of seed.entries) {
    const separator = key.indexOf('\0');
    const dir = key.slice(0, separator);
    const specifier = key.slice(separator + 1);
    // tsconfig changes (including through `extends`) show up as different effective options for the importer.
    if (seed.options[dir] === undefined || seed.options[dir] !== optionsHash(ctx, dir)) continue;
    if (typeof target === 'string' && deleted.has(target)) continue;
    if (added.length || manifests.length) {
      if (target === null) continue;
      const stem = specifierStem(specifier);
      if (added.length && (!stem || stems.has(stem))) continue;
    }
    if (manifests.length) {
      if (typeof target === 'string' && manifests.some(at => under(target, at))) continue;
      if (!specifier.startsWith('.')) {
        if (workspacesChanged) continue;
        if (specifier.startsWith('#') && manifests.some(at => under(dir, at))) continue;
      }
    }
    ctx.resolutions.set(key, target);
  }
  ctx.seededFrom = seed.tree;
}

// The compiler options that decide resolution for modules in `dir` (nearest tsconfig.json and everything
// it extends, plus the producer-closure view's own defaults).
function optionsHash(ctx, dir) {
  if (!ctx.optionHashes.has(dir)) {
    const options = ctx.view.optionsFor(dir === '.' ? '__import_cycles__.ts' : `${dir}/__import_cycles__.ts`);
    ctx.optionHashes.set(dir, createHash('sha1').update(JSON.stringify(options)).digest('hex').slice(0, 16));
  }
  return ctx.optionHashes.get(dir);
}

const workspacesHash = view => createHash('sha1').update(JSON.stringify([...view.workspaces].sort())).digest('hex').slice(0, 16);

const specifierStem = specifier => {
  const last = specifier.replace(/\/+$/u, '').split('/').at(-1) ?? '';
  return last === '.' || last === '..' ? '' : last.replace(/\.[cm]?[jt]sx?$/u, '');
};

function resolvedPath(ctx, file, specifier) {
  const key = `${posix.dirname(file)}\0${specifier}`;
  if (!ctx.resolutions.has(key)) {
    const resolved = ctx.view.resolveImport(file, specifier);
    ctx.resolutions.set(key, resolved.kind === 'file' ? resolved.path : resolved.kind === 'missing' ? null : false);
    ctx.added += 1;
  }
  return ctx.resolutions.get(key);
}

const targetOf = (ctx, file, specifier) => {
  const path = resolvedPath(ctx, file, specifier);
  return typeof path === 'string' && isRuntimeModule(path) ? path : null;
};

function blobEntry(ctx, file) {
  const oid = ctx.view.blobs.get(file);
  if (!ctx.blobs.has(oid)) ctx.blobs.set(oid, ctx.store?.read(`blobs/${oid.slice(0, 2)}/${oid}.json`) ?? {});
  return { oid, entry: ctx.blobs.get(oid) };
}

const saveBlob = (ctx, oid, entry) => ctx.store?.write(`blobs/${oid.slice(0, 2)}/${oid}.json`, entry);

/** The static import specifiers a module's text names (over-approximating its runtime edges). */
function looseSpecifiers(ctx, file) {
  const { oid, entry } = blobEntry(ctx, file);
  if (!entry.loose) {
    const text = ctx.view.read(file) ?? '';
    entry.loose = [...new Set([STATIC_IMPORT, IMPORT_REQUIRE].flatMap(pattern => [...text.matchAll(pattern)].map(match => match[1])))];
    saveBlob(ctx, oid, entry);
  }
  return entry.loose;
}

const needsText = (ctx, file, kind) => {
  const { entry } = blobEntry(ctx, file);
  return kind ? !entry.parsed?.[kind] : !entry.loose;
};

/** A module's resolved runtime edges and load-time reads of imported bindings, in one revision. */
function moduleFacts(ctx, file) {
  if (ctx.known.has(file)) return ctx.known.get(file);
  // No static import (the textual scan over-approximates): no runtime edge and no imported binding to read.
  // Skips parsing data modules such as the 1-2 MB translation tables.
  if (!looseSpecifiers(ctx, file).length) {
    const none = { edges: new Set(), eagerReads: [] };
    ctx.known.set(file, none);
    return none;
  }
  const kind = ts.getScriptKindFromFileName(file);
  const { oid, entry } = blobEntry(ctx, file);
  entry.parsed ??= {};
  if (!entry.parsed[kind]) {
    const source = ts.createSourceFile(file, ctx.view.read(file) ?? '', ts.ScriptTarget.Latest, true, kind);
    const reads = collectImportBindingReads(source);
    entry.parsed[kind] = {
      runtime: collectRuntimeModuleSpecifiers(source, reads.runtimeBindings),
      verbatim: collectRuntimeModuleSpecifiers(source, undefined),
      eager: reads.eagerReads,
    };
    saveBlob(ctx, oid, entry);
  }
  const parsed = entry.parsed[kind];
  const specifiers = ctx.view.optionsFor(file).verbatimModuleSyntax ? parsed.verbatim : parsed.runtime;
  const result = {
    edges: new Set(specifiers.map(specifier => targetOf(ctx, file, specifier)).filter(Boolean)),
    eagerReads: parsed.eager.map(read => ({ ...read, from: file, to: targetOf(ctx, file, read.moduleSpecifier) }))
      .filter(read => read.to),
  };
  ctx.known.set(file, result);
  return result;
}

/** Content-addressed JSON files under `dir`; a failed read or write costs time only, and is counted. */
function cacheStore(dir) {
  if (!dir) return null;
  const store = { errors: 0 };
  store.read = name => {
    try {
      const bytes = readFileSync(join(dir, name));
      return JSON.parse((name.endsWith('.gz') ? gunzipSync(bytes) : bytes).toString('utf8'));
    } catch (error) {
      if (error?.code !== 'ENOENT') store.errors += 1;
      return undefined;
    }
  };
  store.write = (name, value) => {
    const path = join(dir, name);
    try {
      mkdirSync(dirname(path), { recursive: true });
      const temp = `${path}.${process.pid}.part`;
      const text = JSON.stringify(value);
      writeFileSync(temp, name.endsWith('.gz') ? gzipSync(text, { level: 1 }) : text);
      renameSync(temp, path);
    } catch {
      store.errors += 1;
    }
  };
  const listed = sub => {
    try {
      return readdirSync(join(dir, sub)).filter(name => name.endsWith('.json.gz'))
        .map(name => ({ name, mtime: statSync(join(dir, sub, name)).mtimeMs })).sort((a, b) => b.mtime - a.mtime);
    } catch (error) {
      if (error?.code !== 'ENOENT') store.errors += 1;
      return [];
    }
  };
  store.newest = sub => {
    const [newest] = listed(sub);
    return newest && store.read(`${sub}/${newest.name}`);
  };
  store.prune = (sub, keep) => {
    for (const { name } of listed(sub).slice(keep)) {
      try { unlinkSync(join(dir, sub, name)); } catch { /* a concurrent gate pruned it */ }
    }
  };
  return store;
}

function saveResolutions(ctx) {
  if (!ctx.store || !ctx.added) return;
  const options = {};
  for (const key of ctx.resolutions.keys()) {
    const dir = key.slice(0, key.indexOf('\0'));
    options[dir] ??= optionsHash(ctx, dir);
  }
  ctx.store.write(`res/${ctx.env}.json.gz`, { tree: ctx.tree, workspaces: workspacesHash(ctx.view), options,
    entries: [...ctx.resolutions] });
  ctx.store.prune('res', RESOLUTION_FILES_KEPT);
}

const packageScopes = new WeakMap();
/**
 * The workspace packages a cycle through `file` can span. pnpm links only declared workspace dependencies,
 * so a runtime cycle leaves its package only through a declared package cycle (today plugin-sdk,
 * channels-protocol and triage-protocol). Assumption: no runtime module reaches another package's
 * sources by a relative path that closes a cycle; such an edge is followed only inside this scope.
 */
function packageScopeOf(ctx, file) {
  const { view } = ctx;
  if (!packageScopes.has(view)) {
    const dirOf = new Map();
    const packageDir = path => {
      const dir = path.slice(0, path.lastIndexOf('/'));
      if (!dir) return '.';
      if (!dirOf.has(dir)) dirOf.set(dir, view.blobs.has(`${dir}/package.json`) ? dir : packageDir(dir));
      return dirOf.get(dir);
    };
    const declared = new Map();
    for (const dir of view.workspaces.values()) {
      let manifest = {};
      try { manifest = JSON.parse(view.read(`${dir}/package.json`) ?? '{}'); } catch { /* unparsable manifest: no deps */ }
      const names = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies, ...manifest.peerDependencies,
        ...manifest.optionalDependencies });
      declared.set(dir, new Set(names.map(name => view.workspaces.get(name)).filter(dep => dep && dep !== dir)));
    }
    const scope = new Map();
    for (const component of findStronglyConnectedComponents(declared)) {
      const members = new Set(component);
      for (const dir of component) scope.set(dir, members);
    }
    packageScopes.set(view, { packageDir, scope });
  }
  const { packageDir, scope } = packageScopes.get(view);
  const dir = packageDir(file);
  return { dir: packageDir, members: scope.get(dir) ?? new Set([dir]) };
}

/** Eager cyclic reads reachable from `seeds` in one revision, keyed like the guard's baseline. */
function evaluationFindings(ctx, seeds) {
  // 1. Loose graph over what the seeds reach inside their package scope (a cycle through a seed lies inside it).
  const scope = new Set(seeds.flatMap(seed => [...packageScopeOf(ctx, seed).members]));
  const inScope = file => scope.has(packageScopeOf(ctx, file).dir(file));
  const loose = new Map();
  for (let level = seeds; level.length;) {
    ctx.view.prefetch(level.filter(file => needsText(ctx, file)));
    const next = [];
    for (const file of level) {
      const edges = new Set();
      for (const specifier of looseSpecifiers(ctx, file)) {
        const to = targetOf(ctx, file, specifier);
        if (to && inScope(to)) edges.add(to);
      }
      loose.set(file, edges);
      for (const to of edges) if (!loose.has(to)) { loose.set(to, undefined); next.push(to); }
    }
    level = next;
  }
  const looseComponent = new Map();
  for (const component of findStronglyConnectedComponents(loose)) {
    if (isCyclic(component, loose)) for (const file of component) looseComponent.set(file, component);
  }
  // 2. Exact runtime edges and eager reads (the guard's semantics) for the seeds and their loose cycles.
  const parse = file => moduleFacts(ctx, file);
  const nodes = new Set(seeds);
  for (const seed of seeds) for (const file of looseComponent.get(seed) ?? []) nodes.add(file);
  // A seed's load-time `.parse()` forces a schema graph it is not itself part of.
  for (const seed of seeds) {
    for (const read of parse(seed).eagerReads) if (read.parse) for (const file of looseComponent.get(read.to) ?? []) nodes.add(file);
  }
  ctx.view.prefetch([...nodes].filter(file => needsText(ctx, file, ts.getScriptKindFromFileName(file))));
  const graph = new Map([...nodes].sort().map(file => [file, new Set([...parse(file).edges].filter(to => nodes.has(to)))]));
  const eagerReads = [...nodes].flatMap(file => parse(file).eagerReads.filter(read => nodes.has(read.to)));
  const components = findStronglyConnectedComponents(graph);
  const seedSet = new Set(seeds);
  const throughSeed = new Set(components.filter(component => isCyclic(component, graph)
    && component.some(file => seedSet.has(file))).flat());
  const findings = new Map();
  for (const cycle of findEvaluationCycles({ graph, components, eagerReads, relativePath: file => file })) {
    if (!throughSeed.has(cycle.read.to) && !seedSet.has(cycle.read.from)) continue;
    const path = [cycle.edges[0][0], ...cycle.edges.map(([, to]) => to)].join(' -> ');
    findings.set(formatCycleKey(cycle), { from: cycle.read.from, message: `eager import cycle: ${cycle.read.from}:${cycle.line} reads ${cycle.read.binding} `
      + `from ${cycle.read.to} while loading, and ${cycle.read.to} can be mid-load then (TDZ). Cycle: ${path}. `
      + 'Defer the read (lazyZodSchema / inside a function) or import it from its owning leaf.' });
  }
  return { findings, parsed: nodes.size, reached: loose.size };
}

// The package.json fields module resolution reads; dependency, script and version edits change none.
const MANIFEST_RESOLUTION_FIELDS = ['name', 'exports', 'imports', 'main', 'module', 'types', 'typings', 'browser', 'type'];
const manifestResolution = (view, path) => {
  try {
    const manifest = JSON.parse(view.read(path) ?? 'null') ?? {};
    return JSON.stringify(MANIFEST_RESOLUTION_FIELDS.map(field => manifest[field] ?? null));
  } catch {
    return 'unparsable';
  }
};

/**
 * In-scope modules whose resolution a packet's manifest/tsconfig changes can alter: modules whose effective
 * compiler options differ (tsconfig, including `extends`), and for a manifest whose resolution fields
 * changed, the modules that name that package (its exports) or use `#imports` inside it.
 */
function resolutionCandidates(after, before, inputs) {
  const candidates = new Set();
  const inScope = file => isRuntimeModule(file) && IN_SCOPE.test(file);
  if (inputs.some(path => !/(?:^|\/)package\.json$/u.test(path))) {
    for (const file of after.view.blobs.keys()) {
      if (!inScope(file) || !before.view.blobs.has(file)) continue;
      const dir = posix.dirname(file);
      if (optionsHash(after, dir) !== optionsHash(before, dir)) candidates.add(file);
    }
  }
  const manifests = inputs.filter(path => /(?:^|\/)package\.json$/u.test(path))
    .filter(path => manifestResolution(after.view, path) !== manifestResolution(before.view, path));
  const grep = (patterns, paths, fixed) => {
    try {
      return after.git(['grep', '-l', '-I', fixed ? '-F' : '-E', ...patterns.flatMap(pattern => ['-e', pattern]), after.tree, '--', ...paths]);
    } catch (error) {
      if (error.status !== 1) throw error; // 1: no match
      return '';
    }
  };
  const names = new Set();
  for (const path of manifests) {
    const dir = posix.dirname(path);
    for (const view of [after.view, before.view]) {
      for (const [name, at] of view.workspaces) if (at === dir) names.add(name);
    }
    for (const line of grep(['[\'"]#'], [dir === '.' ? '.' : dir], false).split('\n').filter(Boolean)) {
      const file = line.slice(line.indexOf(':') + 1);
      if (inScope(file)) candidates.add(file);
    }
  }
  if (names.size) {
    for (const line of grep([...names], [], true).split('\n').filter(Boolean)) {
      const file = line.slice(line.indexOf(':') + 1);
      if (inScope(file)) candidates.add(file);
    }
  }
  return [...candidates].filter(file => before.view.blobs.has(file) || after.view.blobs.has(file));
}

export function commitImportCycles({ repo, base, tree, cacheDir }) {
  const started = Date.now();
  const git = gitIn(repo);
  const records = nul(git(['diff-tree', '-r', '-z', '--no-renames', '--name-status', base, tree]));
  const changed = [];
  const inputs = [];
  for (let index = 0; index < records.length; index += 2) {
    if (records[index] !== 'D' && isRuntimeModule(records[index + 1]) && IN_SCOPE.test(records[index + 1])) changed.push(records[index + 1]);
    if (RESOLUTION_INPUT.test(records[index + 1])) inputs.push(records[index + 1]);
  }
  const result = { findings: [], changed: changed.length, seeds: 0, parsed: 0, reached: 0, resolved: 0, cacheErrors: 0 };
  if (!changed.length && !inputs.length) return { ...result, ms: Date.now() - started };
  const store = cacheStore(cacheDir);
  const treeOf = rev => git(['rev-parse', '--verify', `${rev}^{tree}`]).trim();
  const after = cycleContext({ git, view: revisionView(repo, git, tree), tree: treeOf(tree), store });
  const before = cycleContext({ git, view: revisionView(repo, git, base), tree: treeOf(base), store });
  // A manifest or tsconfig change re-resolves modules the packet does not touch; they go through the same
  // edge/read delta below.
  if (inputs.length) for (const file of resolutionCandidates(after, before, inputs)) if (!changed.includes(file)) changed.push(file);
  result.changed = changed.length;
  if (!changed.length) return { ...result, ms: Date.now() - started };
  const finish = extra => {
    saveResolutions(after);
    saveResolutions(before);
    return { ...result, ...extra, resolved: after.added + before.added, cacheErrors: store?.errors ?? 0, ms: Date.now() - started };
  };
  // Removing edges or reads never creates an eager cycle, and unchanged modules keep their edges and
  // reads (an added module is a seed, so a resolution it newly satisfies is walked from it). Only a
  // changed module that adds a resolved runtime edge or a load-time read can add a finding.
  after.view.prefetch(changed.filter(file => needsText(after, file, ts.getScriptKindFromFileName(file))));
  before.view.prefetch(changed.filter(file => before.view.blobs.has(file) && needsText(before, file, ts.getScriptKindFromFileName(file))));
  const seeds = changed.filter(file => {
    const now = moduleFacts(after, file);
    if (!before.view.blobs.has(file)) return now.edges.size > 0;
    const then = moduleFacts(before, file);
    const readKey = read => `${read.to}\0${read.binding}`;
    const thenReads = new Set(then.eagerReads.map(readKey));
    return [...now.edges].some(to => !then.edges.has(to)) || now.eagerReads.some(read => !thenReads.has(readKey(read)));
  });
  if (!seeds.length) return finish({ parsed: changed.length });
  const evaluated = evaluationFindings(after, seeds);
  if (evaluated.findings.size) {
    // The packet may have joined a cycle whose eager read was already there: seed the base with the readers too.
    const readers = [...evaluated.findings.values()].map(finding => finding.from);
    const inherited = evaluationFindings(before, [...new Set([...seeds, ...readers])]
      .filter(file => before.view.blobs.has(file))).findings;
    for (const [key, { message }] of evaluated.findings) if (!inherited.has(key)) result.findings.push(message);
  }
  return finish({ findings: result.findings.sort(), seeds: seeds.length, parsed: evaluated.parsed, reached: evaluated.reached });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const [base, tree] = process.argv.slice(2);
    if (!base || !tree) throw new Error('usage: commitImportCycles.mjs <base> <tree>');
    const result = commitImportCycles({ repo: process.cwd(), base, tree, cacheDir: process.env.IMPORT_CYCLES_CACHE });
    for (const finding of result.findings) console.log(`  ${finding}`);
    console.log(`import cycles: ${result.findings.length} new eager cycle(s); ${result.changed} changed module(s), `
      + `${result.seeds} adding edges or reads, ${result.reached} reached, ${result.parsed} parsed, `
      + `${result.resolved} resolved, ${result.cacheErrors} cache errors, ${result.ms} ms`);
    process.exitCode = result.findings.length ? 1 : 0;
  } catch (error) {
    console.error(`import-cycle check failed: ${error instanceof Error ? error.stack : String(error)}`);
    process.exitCode = 2;
  }
}
