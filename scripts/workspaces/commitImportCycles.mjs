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
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
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

const nul = text => text.split('\0').filter(Boolean);
const isRuntimeModule = path => RUNTIME_MODULE.test(path) && !DECLARATION.test(path) && !isTestModulePath(path);
// Scope: workspace library packages (packages/**), which many entries (UI, CLI, daemon, server, stack
// tooling) load in different orders, so an eager cyclic read crashes whichever entry reaches it first:
// tonight's Protocol TDZs, and the runtime multi-order Protocol import this replaces. Apps load from fixed
// entries that the load sentinel's entry graphs already import; walking them here cost 17-80 s per packet
// (measured 2026-11-16: apps/ui alone has one ~3,000-module function-body SCC), more than it saves.
const IN_SCOPE = /^packages\//u;
const isCyclic = (component, graph) => component.length > 1 || Boolean(graph.get(component[0])?.has(component[0]));

const facts = new WeakMap();
const factsOf = view => { if (!facts.has(view)) facts.set(view, new Map()); return facts.get(view); };
const targetOf = (view, file, specifier) => {
  const resolved = view.resolveImport(file, specifier);
  return resolved.kind === 'file' && isRuntimeModule(resolved.path) ? resolved.path : null;
};

/** A module's resolved runtime edges and load-time reads of imported bindings, in one revision. */
function moduleFacts(view, file) {
  const known = factsOf(view);
  if (known.has(file)) return known.get(file);
  const source = ts.createSourceFile(file, view.read(file) ?? '', ts.ScriptTarget.Latest, true,
    ts.getScriptKindFromFileName(file));
  const reads = collectImportBindingReads(source);
  const specifiers = collectRuntimeModuleSpecifiers(source,
    view.optionsFor(file).verbatimModuleSyntax ? undefined : reads.runtimeBindings);
  const result = {
    edges: new Set(specifiers.map(specifier => targetOf(view, file, specifier)).filter(Boolean)),
    eagerReads: reads.eagerReads.map(read => ({ ...read, from: file, to: targetOf(view, file, read.moduleSpecifier) }))
      .filter(read => read.to),
  };
  known.set(file, result);
  return result;
}

const packageScopes = new WeakMap();
/**
 * The workspace packages a cycle through `file` can span. pnpm links only declared workspace dependencies,
 * so a runtime cycle leaves its package only through a declared package cycle (today plugin-sdk,
 * channels-protocol and triage-protocol). Assumption: no runtime module reaches another package's
 * sources by a relative path that closes a cycle; such an edge is followed only inside this scope.
 */
function packageScopeOf(view, file) {
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
function evaluationFindings(view, seeds) {
  const target = (file, specifier) => targetOf(view, file, specifier);
  // 1. Loose graph over what the seeds reach inside their package scope (a cycle through a seed lies inside it).
  const scope = new Set(seeds.flatMap(seed => [...packageScopeOf(view, seed).members]));
  const inScope = file => scope.has(packageScopeOf(view, file).dir(file));
  const loose = new Map();
  for (let level = seeds; level.length;) {
    view.prefetch(level);
    const next = [];
    for (const file of level) {
      const edges = new Set();
      const text = view.read(file) ?? '';
      for (const pattern of [STATIC_IMPORT, IMPORT_REQUIRE]) {
        for (const match of text.matchAll(pattern)) {
          const to = target(file, match[1]);
          if (to && inScope(to)) edges.add(to);
        }
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
  const parse = file => moduleFacts(view, file);
  const nodes = new Set(seeds);
  for (const seed of seeds) for (const file of looseComponent.get(seed) ?? []) nodes.add(file);
  // A seed's load-time `.parse()` forces a schema graph it is not itself part of.
  for (const seed of seeds) {
    for (const read of parse(seed).eagerReads) if (read.parse) for (const file of looseComponent.get(read.to) ?? []) nodes.add(file);
  }
  view.prefetch([...nodes]);
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
  return { findings, parsed: factsOf(view).size, reached: loose.size };
}

export function commitImportCycles({ repo, base, tree }) {
  const started = Date.now();
  const git = gitIn(repo);
  const records = nul(git(['diff-tree', '-r', '-z', '--no-renames', '--name-status', base, tree]));
  const changed = [];
  for (let index = 0; index < records.length; index += 2) {
    if (records[index] !== 'D' && isRuntimeModule(records[index + 1]) && IN_SCOPE.test(records[index + 1])) changed.push(records[index + 1]);
  }
  const result = { findings: [], changed: changed.length, seeds: 0, parsed: 0, reached: 0 };
  if (!changed.length) return { ...result, ms: Date.now() - started };
  // Removing edges or reads never creates an eager cycle, and unchanged modules keep their edges and
  // reads (an added module is a seed, so a resolution it newly satisfies is walked from it). Only a
  // changed module that adds a resolved runtime edge or a load-time read can add a finding.
  const afterView = revisionView(repo, git, tree);
  const beforeView = revisionView(repo, git, base);
  afterView.prefetch(changed);
  beforeView.prefetch(changed.filter(file => beforeView.blobs.has(file)));
  const seeds = changed.filter(file => {
    const now = moduleFacts(afterView, file);
    if (!beforeView.blobs.has(file)) return now.edges.size > 0;
    const then = moduleFacts(beforeView, file);
    const readKey = read => `${read.to}\0${read.binding}`;
    const thenReads = new Set(then.eagerReads.map(readKey));
    return [...now.edges].some(to => !then.edges.has(to)) || now.eagerReads.some(read => !thenReads.has(readKey(read)));
  });
  if (!seeds.length) return { ...result, parsed: factsOf(afterView).size, ms: Date.now() - started };
  const after = evaluationFindings(afterView, seeds);
  if (after.findings.size) {
    // The packet may have joined a cycle whose eager read was already there: seed the base with the readers too.
    const readers = [...after.findings.values()].map(finding => finding.from);
    const inherited = evaluationFindings(beforeView, [...new Set([...seeds, ...readers])]
      .filter(file => beforeView.blobs.has(file))).findings;
    for (const [key, { message }] of after.findings) if (!inherited.has(key)) result.findings.push(message);
  }
  return { ...result, findings: result.findings.sort(), seeds: seeds.length, parsed: after.parsed, reached: after.reached,
    ms: Date.now() - started };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const [base, tree] = process.argv.slice(2);
    if (!base || !tree) throw new Error('usage: commitImportCycles.mjs <base> <tree>');
    const result = commitImportCycles({ repo: process.cwd(), base, tree });
    for (const finding of result.findings) console.log(`  ${finding}`);
    console.log(`import cycles: ${result.findings.length} new eager cycle(s); ${result.changed} changed module(s), `
      + `${result.seeds} adding edges or reads, ${result.reached} reached, ${result.parsed} parsed, ${result.ms} ms`);
    process.exitCode = result.findings.length ? 1 : 0;
  } catch (error) {
    console.error(`import-cycle check failed: ${error instanceof Error ? error.stack : String(error)}`);
    process.exitCode = 2;
  }
}
