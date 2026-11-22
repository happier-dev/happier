#!/usr/bin/env node
// The exact-tree safety checks and ref lock shared by every commit writer.
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, existsSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundledPluginManifestAssetRelativePath } from '../../apps/cli/scripts/build-owned/bundledPlugins/manifestAssetPath.mjs';
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


const CLI_PROJECTION_ROOT = 'apps/cli';
const manifestAssetRoot = dirname(`${CLI_PROJECTION_ROOT}/${bundledPluginManifestAssetRelativePath('plugin')}`);
const projectionHeader = /^\/\*\* GENERATED by generateBundledPluginEntries\.ts[.; ]/u;

function cliProjectionOwned(git, revision, path) {
  if (path.startsWith(manifestAssetRoot + '/') && path.endsWith('.json')) return true;
  if (!path.startsWith(CLI_PROJECTION_ROOT + '/') || !/\.[cm]?[jt]s$/u.test(path)) return false;
  try { return projectionHeader.test(git(['show', `${revision}:${path}`]).slice(0, 160)); }
  catch { return false; }
}

/** Compose the frozen delta against the exact locked parent in a private index. */
async function composeLockedPacket({ git, packet, head, regenerate, scratchRoot = tmpdir() }) {
  const scratch = await mkdtemp(join(scratchRoot, 'replay-index-'));
  const env = { ...process.env, GIT_INDEX_FILE: join(scratch, 'index'), GIT_LITERAL_PATHSPECS: '1' };
  const gitIndex = (args, options) => git(args, { ...options, env: options?.env ?? env });
  const writeTree = () => gitIndex(['write-tree']).trim();
  try {
    git(['merge-base', '--is-ancestor', packet.base, head]);
    const patch = git(['diff', '--binary', '--full-index', '--no-renames', packet.base, packet.tree], { encoding: 'buffer' });
    gitIndex(['read-tree', head]);
    try {
      gitIndex(['apply', '--cached'], { input: patch });
    } catch {
      gitIndex(['read-tree', head]);
      try {
        gitIndex(['apply', '--cached', '--3way'], { input: patch });
      } catch (cause) {
        const stages = gitIndex(['ls-files', '--unmerged', '-z']).split('\0').filter(Boolean);
        const conflicts = [...new Set(stages.map(record => record.slice(record.indexOf('\t') + 1)))];
        if (!conflicts.length) throw cause;
        const source = conflicts.filter(path => !cliProjectionOwned(git, packet.base, path) && !cliProjectionOwned(git, head, path));
        if (source.length) throw new Error(`patch conflicts in source: ${source.join(', ')}`);
        // Take HEAD's projections temporarily. Every clean source hunk is already
        // in the index. The generator will replace projections in that combined tree.
        gitIndex(['update-index', '--force-remove', '--', ...conflicts]);
        const restored = gitIndex(['ls-tree', '-r', '-z', head, '--', ...conflicts])
          .replace(/(\d+) \S+ ([a-f0-9]+)\t/gu, '$1 $2\t');
        if (restored) gitIndex(['update-index', '-z', '--index-info'], { input: restored });

        const combined = writeTree();
        const output = join(scratch, 'projections');
        await regenerate(combined, output);
        const cliOutput = join(output, CLI_PROJECTION_ROOT);
        const emitted = new Map((existsSync(cliOutput) ? readdirSync(cliOutput, { recursive: true, withFileTypes: true }) : [])
          .filter(entry => entry.isFile())
          .map(entry => {
            const file = join(entry.parentPath, entry.name);
            return [relative(output, file).split(sep).join('/'), file];
          }));
        const missing = conflicts.filter(path => !emitted.has(path));
        if (missing.length) throw new Error(`canonical generator did not emit conflicting paths: ${missing.join(', ')}`);
        const tracked = new Map(gitIndex(['ls-tree', '-r', '-z', combined, '--', CLI_PROJECTION_ROOT])
          .split('\0').filter(Boolean).map(record => [record.slice(record.indexOf('\t') + 1), record.split(' ', 1)[0]]));
        for (const path of conflicts) {
          const mode = tracked.get(path) ?? '100644';
          if (!['100644', '100755'].includes(mode)) throw new Error(`cannot regenerate non-regular projection: ${path}`);
          tracked.set(path, mode);
        }
        const records = [];
        for (const [path, mode] of tracked) {
          const outputFile = emitted.get(path);
          if (!outputFile || !['100644', '100755'].includes(mode)
            || !cliProjectionOwned(git, combined, path) && !conflicts.includes(path)) continue;
          const blob = gitIndex(['hash-object', '-w', '--stdin'], { input: readFileSync(outputFile) }).trim();
          records.push(`${mode} ${blob}\t${path}\0`);
        }
        gitIndex(['update-index', '-z', '--index-info'], { input: records.join('') });
        console.error(`commit gate: regenerated ${conflicts.length} conflicting CLI projection(s)`);
      }
    }
    gitIndex(['diff', '--cached', '--check', head, '--', '.', ':(exclude)patches/*.patch'], {
      env: { ...env, GIT_LITERAL_PATHSPECS: '0' },
    });
    const tree = writeTree();
    if (tree === git(['rev-parse', `${head}^{tree}`]).trim()) throw new Error('Packet is already present at HEAD');
    return { base: head, tree };
  } catch (cause) {
    throw new CommitGateUnavailable('frozen packet no longer applies to HEAD; refresh the patch', cause.stderr?.toString().trim() || cause);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Admission is outside the lock. Once admitted, compose against the current
 * ref, judge once and publish that exact tree. A foreign ref move makes CAS
 * fail without re-running the gate or changing the ref.
 */
export async function finalizeGatedCommit({ repo, ref = 'HEAD', label, packet, createCommit, replayScratchRoot, dry = false }) {
  const git = gitIn(repo);
  const admissionAt = performance.now();
  try {
    return await withAdmittedCommitEntryPhase({ repo, ...packet, phase: 'commit' }, (compareAdmittedEntryLoads, regenerate) => {
      console.error(`commit gate: admission ${Math.round(performance.now() - admissionAt)} ms`);
      const queuedAt = performance.now();
      return withCommitLock({ repo, ref, label }, async moveRef => {
        const lockedAt = performance.now();
        console.error(`commit gate: lock wait ${Math.round(lockedAt - queuedAt)} ms`);
        try {
          const head = git(['rev-parse', '--verify', ref]).trim();
          const exact = head === packet.base ? packet : await composeLockedPacket({ git, packet, head, regenerate, scratchRoot: replayScratchRoot });
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
  return await finalizeGatedCommit({
    repo, ref, label: 'commit-partial', packet: { base, tree }, dry, replayScratchRoot: dirname(resolve(patch)),
    createCommit: exact => exact.base === base ? candidate : git(['commit-tree', exact.tree, '-p', exact.base, '-F', message]).trim(),
  });
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
      const patch = option('packet');
      const message = option('message');
      const ref = option('ref');
      if (!patch || !message || !ref) throw new Error('a frozen candidate needs a packet, message, and ref');
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
