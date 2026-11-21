#!/usr/bin/env node
// The exact-tree safety checks and ref lock shared by every commit writer.
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { commitSourceSyntax } from './commitSourceSyntax.mjs';
import { commitPluginManifests } from './commitPluginManifests.mjs';
import { commitLockfile } from './commitLockfile.mjs';
import { commitProducerClosure, createRevisionViewReader, gitIn } from './commitProducerClosure.mjs';
import { commitExtensionBoundaries } from './commitExtensionBoundaries.mjs';
import { commitImportCycles } from './commitImportCycles.mjs';
import { commitTreeEntryLoads, EntryLoadAdmissionUnavailable,
  withAdmittedCommitEntryPhase } from './commitTreeEntryLoads.mjs';


export const COMMIT_GATE_EXIT = Object.freeze({ refused: 10, incomplete: 11, unavailable: 75 });

class CommitGateUnavailable extends Error {
  constructor(check, cause) {
    super(`commit gate unavailable: ${check} could not judge: ${String(cause?.message ?? cause).slice(0, 600)}`);
    this.check = check;
    this.unavailable = true;
    this.exitCode = COMMIT_GATE_EXIT.unavailable;
  }
}

export async function runCommitGate({ repo, base, tree, compareAdmittedEntryLoads, env = process.env,
  cacheDir = env.P03_GATE_CACHE }) {
  const scratch = cacheDir ? undefined : await mkdtemp(join(tmpdir(), 'happier-commit-gate-'));
  try {
    return await judgeCommit({ repo, base, tree, cacheDir: resolve(cacheDir ?? scratch), compareAdmittedEntryLoads, env });
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  }
}

async function judgeCommit({ repo, base, tree, cacheDir, compareAdmittedEntryLoads, env }) {
  const notes = [];
  const judge = async (check, run) => {
    const started = performance.now();
    try {
      return await run();
    } catch (error) {
      throw new CommitGateUnavailable(check, error);
    } finally {
      notes.push(`${check}: ${Math.round(performance.now() - started)} ms`);
    }
  };
  const refused = (check, findings) => ({ verdict: 'refused', check, findings, notes });
  const syntax = await judge('syntax', () => commitSourceSyntax({ repo, base, tree }));
  if (syntax.findings.length) return refused('syntax', syntax.findings);

  const readView = createRevisionViewReader(repo);
  const closure = await judge('producer closure', () => commitProducerClosure({ repo, base, tree, readView }));
  if (closure.findings.length) return refused('producer closure', closure.findings);
  const boundary = await judge('plugin import boundary', () => commitExtensionBoundaries({ repo, base, tree }));
  if (boundary.findings.length) return refused('plugin import boundary', boundary.findings);
  const cycles = await judge('import cycles', () => commitImportCycles({ repo, base, tree, cacheDir: join(cacheDir, 'import-cycles'), readView }));
  if (cycles.findings.length) return refused('eager import cycle through a changed module (a TDZ at load)', cycles.findings);

  const manifests = await judge('plugin manifests', () => commitPluginManifests({ repo, base, tree, cacheDir }));
  if (manifests.findings.length) return refused('plugin manifests', manifests.findings);
  const lockfile = await judge('lockfile', () => commitLockfile({ repo, base, tree }));
  notes.push(`lockfile: ${lockfile.note}`);
  if (lockfile.findings.length) return refused('lockfile', lockfile.findings);

  const loads = await judge('tree entry loads', () => commitTreeEntryLoads({
    repo, base, tree, env, phase: 'commit', compareAdmittedEntryLoads,
  }));
  if (loads.selected.length) notes.push(`tree entry loads: ${loads.selected.length} graph(s), ${JSON.stringify(loads.timings)}`);
  if (loads.findings.length) return refused("entry loads of the commit's own tree", loads.findings);
  return { verdict: 'pass', check: null, findings: [], notes };
}

export function formatCommitGateIncomplete(result) {
  return `commit gate incomplete (${result.check}): ${JSON.stringify(result.reason)}`;
}

/** One message for a refusal, the same from every writer. */
export function formatCommitGateRefusal(result) {
  return [`Commit refused by the commit gate (${result.check}): ${result.findings.length} finding(s):`,
    ...result.findings.map(finding => `  ${finding}`)].join('\n');
}

/** The lock every HEAD writer holds while judging and publishing an exact tree. */
export function commitGateLockPath(repo) {
  const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: repo, encoding: 'utf8' }).trim();
  return join(common, 'p03-commit-partial.lock');
}

/**
 * Serialize the exact-tree gate and compare-and-swap. flock locks the inherited descriptor;
 * the parent holds it until the writer settles. Await acquisition so another writer in this process
 * can finish its gate and release the lock. Hosts without flock retain the plain CAS fallback.
 */
export async function withCommitLock({ repo, ref = 'HEAD', label = 'commit-gate' }, run) {
  const moveRef = ({ commit, head, reason }) => {
    execFileSync('git', ['update-ref', '-m', reason, ref, commit, head], {
      cwd: repo, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    });
  };
  if (process.platform === 'win32') return run(moveRef);

  const path = commitGateLockPath(repo);
  const lock = openSync(path, 'a');
  let mark;
  try {
    try {
      const child = spawn('flock', ['-x', '3'], { cwd: repo, stdio: ['ignore', 'ignore', 'inherit', lock] });
      const [code, signal] = await once(child, 'exit');
      if (code !== 0) throw new Error(`commit gate: flock failed (${signal ?? code})`);
      mark = `${path}.holder`;
      writeFileSync(mark, `pid=${process.pid} since=${new Date().toISOString().slice(11, 19)}Z msg=${label}\n`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      process.stderr.write('commit gate: no flock on this host (the commit wrapper cannot run here either); plain compare-and-swap\n');
    }
    return await run(moveRef);
  } finally {
    try { if (mark) rmSync(mark, { force: true }); }
    finally { closeSync(lock); }
  }
}


/**
 * Admission is outside the lock. Once admitted, compose against the current
 * ref, judge once and publish that exact tree. A foreign ref move makes CAS
 * fail without re-running the gate or changing the ref.
 */
export async function finalizeGatedCommit({ repo, ref = 'HEAD', label, packet, replay, createCommit, dry = false }) {
  const git = gitIn(repo);
  const admissionAt = performance.now();
  try {
    return await withAdmittedCommitEntryPhase({ repo, ...packet, phase: 'commit' }, compareAdmittedEntryLoads => {
      console.error(`commit gate: admission ${Math.round(performance.now() - admissionAt)} ms`);
      const queuedAt = performance.now();
      return withCommitLock({ repo, ref, label }, async moveRef => {
        const lockedAt = performance.now();
        console.error(`commit gate: lock wait ${Math.round(lockedAt - queuedAt)} ms`);
        try {
          const head = git(['rev-parse', '--verify', ref]).trim();
          const exact = head === packet.base ? packet : replay(head);
          if (!exact) return {};
          const gate = await runCommitGate({ repo, base: head, tree: exact.tree, compareAdmittedEntryLoads });
          for (const note of gate.notes) console.error(`commit gate: ${note}`);
          if (gate.verdict !== 'pass') return { gate };
          const commit = createCommit(exact);
          if (!dry) {
            try { moveRef({ commit, head, reason: `${label}: pid ${process.pid}` }); }
            catch (error) { throw new CommitGateUnavailable('ref update', error); }
          }
          return { commit, head, tree: exact.tree };
        } finally {
          console.error(`commit gate: lock held ${Math.round(performance.now() - lockedAt)} ms`);
        }
      });
    });
  } catch (error) {
    if (!(error instanceof EntryLoadAdmissionUnavailable)) throw error;
    return { gate: {
      verdict: 'incomplete', check: 'tree entry loads',
      reason: { code: 'entry-load-admission-unavailable', status: error.status }, findings: [], notes: [],
    } };
  }
}

async function finalizeFrozenPacket({ repo, candidate, message, patch, ref, dry }) {
  const git = gitIn(repo);
  const base = git(['rev-parse', `${candidate}^`]).trim();
  const tree = git(['rev-parse', `${candidate}^{tree}`]).trim();
  const scratch = await mkdtemp(join(tmpdir(), 'happier-commit-index-'));
  const env = { ...process.env, GIT_INDEX_FILE: join(scratch, 'index') };
  try {
    return await finalizeGatedCommit({
      repo, ref, label: 'commit-partial', packet: { base, tree }, dry,
      replay: head => {
        try {
          git(['read-tree', head], { env });
          git(['apply', '--cached', patch], { env });
          git(['diff', '--cached', '--check', head, '--', '.', ':(exclude)patches/*.patch'], { env });
          return { base: head, tree: git(['write-tree'], { env }).trim() };
        } catch (cause) {
          throw new CommitGateUnavailable('frozen packet no longer applies to HEAD; refresh the patch', cause);
        }
      },
      createCommit: exact => exact.base === base ? candidate : git(['commit-tree', exact.tree, '-p', exact.base, '-F', message]).trim(),
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = name => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const format = result => {
    if (result.verdict === 'refused') {
      console.error(formatCommitGateRefusal(result));
      return COMMIT_GATE_EXIT.refused;
    }
    if (result.verdict === 'incomplete') {
      console.error(formatCommitGateIncomplete(result));
      return COMMIT_GATE_EXIT.incomplete;
    }
    return 0;
  };
  try {
    const repo = gitIn(process.cwd())(['rev-parse', '--show-toplevel']).trim();
    if (option('candidate')) {
      const message = option('message');
      const patch = option('packet');
      const ref = option('ref');
      if (!message || !patch || !ref) throw new Error('a frozen packet needs a message, patch and ref');
      const dry = args.includes('--dry');
      const result = await finalizeFrozenPacket({ repo, candidate: option('candidate'), message, patch, ref, dry });
      if (result.gate) process.exitCode = format(result.gate);
      else console.log(`${dry ? 'DRY candidate' : 'COMMITTED'} ${result.commit} parent ${result.head}`);
    } else {
      const base = option('base');
      const tree = option('tree');
      if (!base || !tree) throw new Error('usage: commitGate.mjs --base=<rev> --tree=<tree-ish>');
      const result = await runCommitGate({ repo, base, tree });
      for (const note of result.notes) console.log(`commit gate: ${note}`);
      process.exitCode = format(result);
    }
  } catch (error) {
    console.error(error.unavailable ? error.message : `commit gate unavailable: ${String(error?.message ?? error).slice(0, 600)}`);
    process.exitCode = COMMIT_GATE_EXIT.unavailable;
  }
}
