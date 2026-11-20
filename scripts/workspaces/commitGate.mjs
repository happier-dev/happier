#!/usr/bin/env node
// The commit gate: the one list of checks a packet passes before any writer moves HEAD, and the one lock under which a
// writer moves it. Every HEAD writer calls it: the commit wrapper's gate (.project/scripts/p03/cw-head/gate.sh, through
// this CLI), scripts/git/commitFromPrivateIndex.mjs and the coherence finalizer (checkCommitTypeCoherence.mjs
// --message-file). P03-SPLIT-AUDIT-A P1-1: each writer had assembled its own list, and a packet one refused (an eager
// import cycle, a manifest or lockfile break) landed through another.
//
//   node scripts/workspaces/commitGate.mjs --base=<rev> --tree=<tree-ish> [--prior=<tree-ish>] [--cheap-only]
//   exit 0 pass, 10 refused, 11 incomplete, 3 needs a full recheck (--cheap-only), 75 unavailable (never the candidate's fault)
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
import { commitProducerClosure, createRevisionViewReader, gitIn } from './commitProducerClosure.mjs';
import { commitExtensionBoundaries } from './commitExtensionBoundaries.mjs';
import { commitImportCycles } from './commitImportCycles.mjs';
import { commitTreeGateMode, commitTreeEntryLoads, EntryLoadAdmissionUnavailable, selectWorkspaceClosureInputs,
  startCommitTreeEntryLoadReport, withAdmittedCommitEntryPhase } from './commitTreeEntryLoads.mjs';

export const COMMIT_GATE_EXIT = Object.freeze({ pass: 0, refused: 10, incomplete: 11, needsFull: 3, unavailable: 75 });

const P03_DECLARATION_PACKAGES = ['packages/protocol', 'packages/plugin-sdk'];
const SHARED_DECLARATION_INPUT = /^(?:package\.json$|pnpm-(?:lock|workspace)\.yaml$|\.npmrc$|tsconfig[^/]*\.json$|patches\/|scripts\/workspaces\/|\.github\/feature-policy\/)/u;

async function changedDeclarationScopes(repo, base, tree, prior, priorBase, scopes) {
  if (!prior || !scopes.length) return scopes;
  const git = gitIn(repo);
  if (!priorBase) {
    try { priorBase = git(['rev-parse', '--verify', `${prior}^`]).trim(); }
    catch { return scopes; } // With no accepted baseline, reuse cannot prove the comparison is still valid.
  }
  const changed = (from, to) => git(['diff', '--no-renames', '--name-only', '-z', from, to]).split('\0').filter(Boolean);
  const moved = [...changed(priorBase, base), ...changed(prior, tree)];
  if (!moved.length) return [];
  if (moved.some(path => SHARED_DECLARATION_INPUT.test(path))) return scopes;
  return selectWorkspaceClosureInputs({ repo, revisions: [prior, tree], scopes, paths: moved });
}

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
 * Runs every check for the packet `base..tree`. Returns `{ verdict: 'pass' | 'refused' | 'incomplete' | 'needs-full', check, findings,
 * notes }`; `check` names the first refusing or incomplete check. Throws (`error.unavailable`) when a check cannot judge.
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

async function judgeCommit({ repo, base, tree, prior, priorBase, cheapOnly = false, finalEntryRecheck = false, compareAdmittedEntryLoads, env = process.env, cacheDir, label = 'commit-gate' }) {
  const notes = [];
  const typecheckMode = commitTypecheckGateMode(env);
  const treeMode = commitTreeGateMode(env);
  const judge = async (check, run) => {
    try { return await run(); } catch (error) { throw new CommitGateUnavailable(check, error); }
  };
  const refused = (check, findings) => ({ verdict: 'refused', check, findings, notes });
  const declarationsIncomplete = (packages, stall) => ({
    verdict: 'incomplete', check: 'package declarations', findings: [], notes,
    reason: { code: 'declaration-comparison-incomplete', packages, ...(stall ? { stall } : {}) },
  });
  // The package typecheck waits for a worker compile, so it runs beside the checks below and is collected after them.
  const checkTypes = (packages, cachedOnly = false) => judge('package typecheck', async () => {
    const owner = await import('./commitPackageTypecheck.mjs');
    const result = await owner.commitGateTypecheck({ repo, base, tree, env, packages, cachedOnly });
    return { ...result, refuses: owner.commitPackageTypecheckRefuses(result), lines: result.skipped ? [] : owner.formatCommitPackageTypecheck(result) };
  });
  const typecheck = typecheckMode === 'block' && !prior && !cheapOnly ? checkTypes() : null;
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

  // R2 judges only authored Protocol and Plugin SDK packet scopes in the P03 wrapper.
  const scopes = label === 'commit-partial'
    ? P03_DECLARATION_PACKAGES.filter(dir => closure.changedSources.some(({ path }) => path.startsWith(`${dir}/src/`)))
    : [];
  const declarations = await changedDeclarationScopes(repo, base, tree, prior, priorBase, scopes);
  if (declarations.length) {
    const result = await (typecheck ?? checkTypes(declarations, cheapOnly));
    notes.push(...result.lines);
    if (result.stall) return declarationsIncomplete(declarations, result.stall);
    if (result.fresh.length) return refused('new type errors in a package the packet touches', result.lines);
    const unjudged = declarations.filter(dir => !result.packages.includes(dir)
      || result.incomplete.includes(dir) || result.unavailable.includes(dir));
    if (unjudged.length) {
      const check = 'package declarations';
      if (cheapOnly) return { verdict: 'needs-full', check, findings: [], notes };
      return declarationsIncomplete(unjudged);
    }
    if (result.refuses) return refused('new type errors in a package the packet touches', result.lines);
  }

  if (typecheck && !declarations.length) {
    const result = await typecheck;
    notes.push(...result.lines);
    if (result.stall) return declarationsIncomplete(result.packages, result.stall);
    if (result.refuses) return refused('new type errors in a package the packet touches', result.lines);
  }

  if (treeMode === 'block') {
    const loads = await judge('tree entry loads', () => commitTreeEntryLoads({ repo, base, tree, prior, priorBase, env, cheapOnly, finalEntryRecheck, compareAdmittedEntryLoads }));
    if (loads.needsFull) return { verdict: 'needs-full', check: 'tree entry loads', findings: [], notes };
    if (loads.findings.length) return refused('entry loads of the commit\'s own tree', loads.findings);
  } else if (treeMode === 'report' && !prior && !cheapOnly) {
    // Report mode records the verdict in the ledger without waiting; a recheck replays a packet whose first gate started it.
    const pid = startCommitTreeEntryLoadReport({ repo, base, tree, label, env });
    if (pid) notes.push(`tree entry loads: report started (pid ${pid})`);
  }
  return { verdict: 'pass', check: null, findings: [], notes };
}

export function formatCommitGateIncomplete(result) {
  return `commit gate incomplete (${result.check}): ${JSON.stringify(result.reason)}`;
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

/**
 * Shared replay for the JavaScript HEAD writers. The lock covers the local
 * recheck and CAS. After two losses, allow one more preparation outside it.
 */
export async function finalizeGatedCommit({ repo, ref, label, packet, replay, createCommit }) {
  const git = gitIn(repo);
  const headAt = () => git(['rev-parse', 'HEAD']).trim();
  let accepted;
  let commit;
  let losses = 0;
  let finalPrepared = false;
  const incomplete = () => ({
    verdict: 'incomplete', check: 'final scoped recheck',
    reason: { code: 'final-recheck-incomplete' }, findings: [], notes: [],
  });
  let recheckedAfterRelease = false;
  const entryBlocking = commitTreeGateMode() === 'block';
  const check = async (cheapOnly, compareAdmittedEntryLoads) => {
    const gate = await runCommitGate({ repo, base: packet.base, tree: packet.tree, prior: accepted?.tree,
      priorBase: accepted?.base, cheapOnly, compareAdmittedEntryLoads, label });
    for (const note of gate.notes) console.error(`commit gate: ${note}`);
    if (gate.verdict === 'pass') {
      commit = createCommit(packet);
      accepted = packet;
    }
    return gate;
  };

  if (headAt() === packet.base) {
    const gate = await check(false);
    if (gate.verdict !== 'pass') return { gate };
  }
  for (;;) {
    const finalEntryPhase = entryBlocking && losses >= 2;
    const locked = (compareAdmittedEntryLoads, entryPhaseAttempted = false) => withCommitLock({ repo, ref }, async (moveRef) => {
      for (;;) {
        const head = headAt();
        if (head !== packet.base) {
          if (recheckedAfterRelease) losses++;
          recheckedAfterRelease = false;
          if (entryBlocking && losses >= 2 && !entryPhaseAttempted) return { admitEntry: true };
          packet = replay(head);
          if (!packet) return {};
        }
        if (packet !== accepted) {
          if (!accepted) return { recheck: 'the replay has no prior verdict' };
          let gate;
          try {
            gate = await check(true, compareAdmittedEntryLoads);
          } catch (error) {
            if (!error.unavailable) throw error;
            return { recheck: error.message };
          }
          if (gate.verdict === 'needs-full') return { recheck: `${gate.check} needs a full recheck` };
          if (gate.verdict !== 'pass') return { gate };
        }
        try {
          moveRef({ commit, head, reason: `${label}: pid ${process.pid}` });
          return { commit };
        } catch (error) {
          if (headAt() === head) throw error;
          // A writer outside the lock (or a host without flock) can still win CAS.
          recheckedAfterRelease = false;
          losses++;
          if (entryBlocking && losses >= 2 && !entryPhaseAttempted) return { admitEntry: true };
        }
      }
    });
    let result;
    try {
      result = finalEntryPhase && headAt() !== packet.base
        ? await withAdmittedCommitEntryPhase({ repo, base: packet.base, tree: packet.tree },
          compare => locked(compare, true))
        : await locked();
    } catch (error) {
      if (!(error instanceof EntryLoadAdmissionUnavailable)) throw error;
      return { gate: {
        verdict: 'incomplete', check: 'tree entry loads',
        reason: { code: 'entry-load-admission-unavailable', status: error.status }, findings: [], notes: [],
      } };
    }
    if (result.admitEntry) continue;
    if (!result.recheck) return result;
    if (finalPrepared) return { gate: incomplete() };
    finalPrepared = losses >= 2;
    console.error(`commit gate: ${result.recheck}. Released the commit lock for the full gate`);
    let gate;
    try {
      gate = await check(false);
    } catch (error) {
      if (!finalPrepared || !error.unavailable) throw error;
      console.error(error.message);
      return { gate: incomplete() };
    }
    if (gate.verdict !== 'pass') return { gate };
    recheckedAfterRelease = true;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = name => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  try {
    const repo = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
    if (!option('base') || !option('tree')) throw Object.assign(new Error('usage: commitGate.mjs --base=<rev> --tree=<tree-ish> [--prior=<tree-ish>] [--cheap-only]'), { unavailable: true });
    const result = await runCommitGate({ repo, base: option('base'), tree: option('tree'), prior: option('prior') || undefined,
      cheapOnly: args.includes('--cheap-only'), finalEntryRecheck: process.env.P03_GATE_FINAL_ENTRY_RECHECK === '1', label: option('label') ?? 'commit-gate' });
    for (const note of result.notes) console.log(`commit gate: ${note}`);
    if (result.verdict === 'refused') {
      console.log(formatCommitGateRefusal(result));
      process.exitCode = COMMIT_GATE_EXIT.refused;
    } else if (result.verdict === 'incomplete') {
      console.log(formatCommitGateIncomplete(result));
      process.exitCode = COMMIT_GATE_EXIT.incomplete;
    } else if (result.verdict === 'needs-full') {
      console.log(`commit gate: ${result.check} needs a full recheck`);
      process.exitCode = COMMIT_GATE_EXIT.needsFull;
    }
  } catch (error) {
    console.log(error.unavailable ? error.message : `commit gate unavailable: ${String(error?.stack ?? error).slice(0, 600)}`);
    process.exitCode = COMMIT_GATE_EXIT.unavailable;
  }
}
