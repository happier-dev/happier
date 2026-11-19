#!/usr/bin/env node
// The commit gate: the one list of checks a packet passes before any writer moves HEAD, and the one lock under which a
// writer moves it. Every HEAD writer calls it: the commit wrapper's gate (.project/scripts/p03/cw-head/gate.sh, through
// this CLI), scripts/git/commitFromPrivateIndex.mjs and the coherence finalizer (checkCommitTypeCoherence.mjs
// --message-file). P03-SPLIT-AUDIT-A P1-1: each writer had assembled its own list, and a packet one refused (an eager
// import cycle, a manifest or lockfile break) landed through another.
//
//   node scripts/workspaces/commitGate.mjs --base=<rev> --tree=<tree-ish> [--prior=<tree-ish>] [--cheap-only]
//   exit 0 pass, 10 refused, 3 needs a full recheck (--cheap-only), 75 unavailable (never the candidate's fault)
//
// Every check reads the candidate's Git objects, never the moving checkout, and refuses only what the packet adds over
// its base. The commit wrapper adds its cached bundle and export-scan tier (gate.sh) on top of this list.
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, openSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { commitSourceSyntax } from './commitSourceSyntax.mjs';
import { commitPluginManifests, PLUGIN_MANIFEST_INPUT } from './commitPluginManifests.mjs';
import { commitLockfile } from './commitLockfile.mjs';
import { commitProducerClosure, createRevisionViewReader } from './commitProducerClosure.mjs';
import { commitExtensionBoundaries } from './commitExtensionBoundaries.mjs';
import { commitImportCycles } from './commitImportCycles.mjs';
import { commitTreeGateMode, commitTreeEntryLoads, startCommitTreeEntryLoadReport } from './commitTreeEntryLoads.mjs';

export const COMMIT_GATE_EXIT = Object.freeze({ pass: 0, refused: 10, needsFull: 3, unavailable: 75 });

/**
 * The typecheck delta of touched packages/* workspaces (P03-GATE-TC): `report` (default) checks each landed commit after
 * HEAD moved (kickRollingHeadTypecheck), `block` refuses here, `off` skips it. Blocking returns when admission sizing lets
 * the check run without holding commits (P03-GATE-TC "Blocked"); switching is this default, for every writer at once.
 */
export function commitTypecheckGateMode(env = process.env) {
  const mode = String(env.HAPPIER_COMMIT_TYPECHECK_GATE ?? '').trim() || 'report';
  if (!['report', 'block', 'off'].includes(mode)) throw new Error(`HAPPIER_COMMIT_TYPECHECK_GATE must be report, block or off (got ${mode})`);
  return mode;
}

class CommitGateUnavailable extends Error {
  constructor(check, cause) {
    super(`commit gate unavailable: ${check} could not judge: ${String(cause?.message ?? cause).slice(0, 600)}`);
    this.check = check;
    this.unavailable = true;
  }
}

/**
 * Runs every check for the packet `base..tree`. Returns `{ verdict: 'pass' | 'refused' | 'needs-full', check, findings,
 * notes }`; `check` names the first refusing check. Throws (`error.unavailable`) when a check cannot judge.
 * `prior`: the tree this packet passed as before HEAD moved (a recheck): work its earlier pass already judged and the
 * landed commits cannot change is reused, and nothing detached is started again. `cheapOnly`: try the quick recheck first;
 * a check that takes minutes returns `needs-full`.
 */
export async function runCommitGate(options) {
  const cacheDir = options.cacheDir ?? (options.env ?? process.env).P03_GATE_CACHE;
  if (cacheDir) return judgeCommit({ ...options, cacheDir: resolve(cacheDir) });

  // Other HEAD writers own only this invocation. The wrapper supplies its longer-lived packet cache.
  const scratch = await mkdtemp(join(tmpdir(), 'happier-commit-gate-'));
  try {
    return await judgeCommit({ ...options, cacheDir: scratch });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function judgeCommit({ repo, base, tree, prior, cheapOnly = false, env = process.env, cacheDir, label = 'commit-gate' }) {
  const notes = [];
  const typecheckMode = commitTypecheckGateMode(env);
  const treeMode = commitTreeGateMode(env);
  const judge = async (check, run) => {
    try { return await run(); } catch (error) { throw new CommitGateUnavailable(check, error); }
  };
  const refused = (check, findings) => ({ verdict: 'refused', check, findings, notes });
  // The package typecheck waits for a worker compile, so it runs beside the checks below and is collected after them.
  const typecheck = typecheckMode === 'block' && !prior ? judge('package typecheck', async () => {
    const owner = await import('./commitPackageTypecheck.mjs');
    const result = await owner.commitGateTypecheck({ repo, base, tree, env });
    return { refuses: owner.commitPackageTypecheckRefuses(result), lines: result.skipped ? [] : owner.formatCommitPackageTypecheck(result) };
  }) : null;
  typecheck?.catch(() => {});

  const syntax = await judge('syntax', () => commitSourceSyntax({ repo, base, tree }));
  notes.push(`syntax: ${syntax.parsed} changed source file(s) parsed`);
  if (syntax.findings.length) return refused('syntax', syntax.findings);

  const readView = createRevisionViewReader(repo);
  const closure = await judge('producer closure', () => commitProducerClosure({ repo, base, tree, readView }));
  if (closure.findings.length) return refused('producer closure', closure.findings);
  const boundary = await judge('plugin import boundary', () => commitExtensionBoundaries({ repo, base, tree }));
  if (boundary.findings.length) return refused('plugin import boundary', boundary.findings);
  const cycles = await judge('import cycles', () => commitImportCycles({ repo, base, tree, cacheDir: join(cacheDir, 'import-cycles'), readView }));
  notes.push(`import cycles: ${cycles.findings.length} new eager cycle(s) (${cycles.changed} changed module(s) in scope, ${cycles.ms} ms)`);
  if (cycles.findings.length) return refused('eager import cycle through a changed module (a TDZ at load)', cycles.findings);

  const manifestInputsMoved = () => execFileSync('git', ['diff', '--no-renames', '--name-only', '-z', prior, tree], { cwd: repo, encoding: 'utf8', maxBuffer: 1 << 28 })
    .split('\0').some(path => PLUGIN_MANIFEST_INPUT.test(path));
  if (prior && !manifestInputsMoved()) notes.push('plugin manifests: recheck; the landed commits change no manifest or parser input');
  else {
    const manifests = await judge('plugin manifests', () => commitPluginManifests({ repo, base, tree, cacheDir }));
    notes.push(`plugin manifests: ${manifests.checked} checked with the judged trees' parsers${manifests.baselineInvalid ? `, ${manifests.baselineInvalid} already invalid at the base and untouched` : ''}`);
    if (manifests.findings.length) return refused('plugin manifests', manifests.findings);
  }

  const lockfile = await judge('lockfile', () => commitLockfile({ repo, base, tree }));
  notes.push(`lockfile: ${lockfile.note}`);
  if (lockfile.findings.length) return refused('lockfile', lockfile.findings);

  if (typecheck) {
    const result = await typecheck;
    notes.push(...result.lines);
    if (result.refuses) return refused('new type errors in a package the packet touches', result.lines);
  }

  if (treeMode === 'block') {
    if (cheapOnly) return { verdict: 'needs-full', check: 'tree entry loads', findings: [], notes };
    const loads = await judge('tree entry loads', () => commitTreeEntryLoads({ repo, base, tree, env }));
    if (loads.findings.length) return refused('entry loads of the commit\'s own tree', loads.findings);
  } else if (treeMode === 'report' && !prior) {
    // Report mode records the verdict in the ledger without waiting; a recheck replays a packet whose first gate started it.
    const pid = startCommitTreeEntryLoadReport({ repo, base, tree, label, env });
    if (pid) notes.push(`tree entry loads: report started (pid ${pid})`);
  }
  return { verdict: 'pass', check: null, findings: [], notes };
}

/** One message for a refusal, the same from every writer. */
export function formatCommitGateRefusal(result) {
  return [`Commit refused by the commit gate (${result.check}): ${result.findings.length} finding(s) the packet adds:`,
    ...result.findings.map(finding => `  ${finding}`)].join('\n');
}

/** The lock every HEAD writer holds during a stale recheck and CAS. */
export function commitGateLockPath(repo) {
  const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: repo, encoding: 'utf8' }).trim();
  return join(common, 'p03-commit-partial.lock');
}

/**
 * Serialize a writer's stale recheck and compare-and-swap. flock locks the inherited descriptor;
 * the parent holds it until the writer settles. Await acquisition so another writer in this process
 * can finish its gate and release the lock. Hosts without flock retain the plain CAS fallback.
 */
export async function withCommitLock({ repo, ref = 'HEAD' }, run) {
  const moveRef = ({ commit, head, reason }) => {
    execFileSync('git', ['update-ref', '-m', reason, ref, commit, head], {
      cwd: repo, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    });
  };
  if (process.platform === 'win32') return run(moveRef);

  const lock = openSync(commitGateLockPath(repo), 'a');
  try {
    try {
      const child = spawn('flock', ['-x', '3'], { cwd: repo, stdio: ['ignore', 'ignore', 'inherit', lock] });
      const [code, signal] = await once(child, 'exit');
      if (code !== 0) throw new Error(`commit gate: flock failed (${signal ?? code})`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      process.stderr.write('commit gate: no flock on this host (the commit wrapper cannot run here either); plain compare-and-swap\n');
    }
    return await run(moveRef);
  } finally {
    closeSync(lock);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = name => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  try {
    const repo = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
    if (!option('base') || !option('tree')) throw Object.assign(new Error('usage: commitGate.mjs --base=<rev> --tree=<tree-ish> [--prior=<tree-ish>] [--cheap-only]'), { unavailable: true });
    const result = await runCommitGate({ repo, base: option('base'), tree: option('tree'), prior: option('prior') || undefined,
      cheapOnly: args.includes('--cheap-only'), label: option('label') ?? 'commit-gate' });
    for (const note of result.notes) console.log(`commit gate: ${note}`);
    if (result.verdict === 'refused') {
      console.log(formatCommitGateRefusal(result));
      process.exitCode = COMMIT_GATE_EXIT.refused;
    } else if (result.verdict === 'needs-full') {
      console.log(`commit gate: ${result.check} needs a full recheck`);
      process.exitCode = COMMIT_GATE_EXIT.needsFull;
    }
  } catch (error) {
    console.log(error.unavailable ? error.message : `commit gate unavailable: ${String(error?.stack ?? error).slice(0, 600)}`);
    process.exitCode = COMMIT_GATE_EXIT.unavailable;
  }
}
