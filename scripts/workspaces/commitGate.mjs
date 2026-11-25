#!/usr/bin/env node
// The exact-tree safety checks and ref lock shared by every commit writer.
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearsWorkingDependencyInputDrift, RELOAD_DEPENDENCY_INPUTS } from '../../apps/stack/scripts/runtime/launch/reloadDependencyInputs.mjs';
import { commitSourceSyntax } from './commitSourceSyntax.mjs';
import { commitPluginManifests } from './commitPluginManifests.mjs';
import { commitLockfile } from './commitLockfile.mjs';
import { commitLocalImportClosure, commitProducerClosure, createRevisionViewReader, gitIn, restoresHeadImports as verifyHeadImportRepair } from './commitProducerClosure.mjs';
import { commitExtensionBoundaries } from './commitExtensionBoundaries.mjs';
import { commitImportCycles } from './commitImportCycles.mjs';
import { commitTreeEntryLoads, defaultCommitTreeLedger, EntryLoadAdmissionRequired, EntryLoadAdmissionUnavailable } from './commitTreeEntryLoads.mjs';
import { withCommitLock } from './commitWriterLock.mjs';
import { assertCommitGateDisk } from './commitGateScratch.mjs';
export { commitGateLockPath, withCommitLock } from './commitWriterLock.mjs';


export const COMMIT_GATE_EXIT = Object.freeze({ refused: 10, incomplete: 11, unavailable: 75 });

class CommitGateUnavailable extends Error {
  constructor(check, cause) {
    super(`commit gate unavailable: ${check} could not judge: ${String(cause?.message ?? cause).slice(0, 600)}`);
    this.check = check;
    this.unavailable = true;
    this.exitCode = COMMIT_GATE_EXIT.unavailable;
  }
}

async function measureCheck(notes, check, run) {
  const started = performance.now();
  try {
    return await run();
  } catch (error) {
    if (error instanceof EntryLoadAdmissionRequired || error instanceof EntryLoadAdmissionUnavailable) throw error;
    throw new CommitGateUnavailable(check, error);
  } finally {
    notes.push(`${check}: ${Math.round(performance.now() - started)} ms`);
  }
}

export async function runCommitGate({ repo, base, tree, compareAdmittedEntryLoads, env = process.env, phase = 'commit',
  cacheDir = env.P03_GATE_CACHE, expectedEnvironment, entryProof }) {
  assertCommitGateDisk(env, repo, cacheDir);
  const fast = await runFastCommitGate({ repo, base, tree, phase, cacheDir });
  if (fast.verdict === 'refused' || phase === 'post-commit') return fast;
  return await judgeEntryLoads({ repo, base, tree, compareAdmittedEntryLoads, env, expectedEnvironment, entryProof, notes: fast.notes });
}

async function runFastCommitGate({ repo, base, tree, phase = 'commit', cacheDir = process.env.P03_GATE_CACHE }) {
  const scratch = cacheDir ? undefined : await mkdtemp(join(tmpdir(), 'happier-commit-gate-'));
  try {
    return await judgeFastCommit({ repo, base, tree, cacheDir: resolve(cacheDir ?? scratch), phase });
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  }
}

async function judgeFastCommit({ repo, base, tree, cacheDir, phase }) {
  const notes = [];
  const judge = (check, run) => measureCheck(notes, check, run);
  const refused = (check, findings) => ({ verdict: 'refused', check, findings, notes });
  const readView = createRevisionViewReader(repo, { trackedOnly: phase === 'commit' });
  if (phase === 'post-commit') {
    const closure = await judge('producer closure', () => commitProducerClosure({ repo, base, tree, readView }));
    if (closure.findings.length) return refused('producer closure', closure.findings);
    const boundary = await judge('plugin import boundary', () => commitExtensionBoundaries({ repo, base, tree }));
    if (boundary.findings.length) return refused('plugin import boundary', boundary.findings);
    const manifests = await judge('plugin manifests', () => commitPluginManifests({ repo, base, tree, cacheDir }));
    if (manifests.findings.length) return refused('plugin manifests', manifests.findings);
    return { verdict: 'pass', check: null, findings: [], notes };
  }
  const syntax = await judge('syntax', () => commitSourceSyntax({ repo, base, tree }));
  if (syntax.findings.length) return refused('syntax', syntax.findings);
  const imports = await judge('local import closure', () => commitLocalImportClosure({ repo, base, tree, readView }));
  if (imports.findings.length) return refused('local import closure', imports.findings);
  const cycles = await judge('import cycles', () => commitImportCycles({ repo, base, tree, cacheDir: join(cacheDir, 'import-cycles'), readView }));
  if (cycles.findings.length) return refused('eager import cycle through a changed module (a TDZ at load)', cycles.findings);

  const lockfile = await judge('lockfile', () => commitLockfile({ repo, base, tree }));
  notes.push(`lockfile: ${lockfile.note}`);
  if (lockfile.findings.length) return refused('lockfile', lockfile.findings);

  return { verdict: 'pass', check: null, findings: [], notes };
}

async function judgeEntryLoads({ repo, base, tree, env = process.env, compareAdmittedEntryLoads, expectedEnvironment, entryProof, notes = [] }) {
  const loads = await measureCheck(notes, 'tree entry loads', () => commitTreeEntryLoads({
    repo, base, tree, env, phase: 'commit', compareAdmittedEntryLoads, expectedEnvironment, entryProof,
  }));
  if (loads.selected.length) notes.push(`tree entry loads: ${loads.selected.length} graph(s), ${JSON.stringify(loads.timings)}`);
  const entryGenerationMs = loads.timings.generatedMs ?? 0;
  if (loads.findings.length) {
    return { verdict: 'refused', check: "entry loads of the commit's own tree", findings: loads.findings, notes, entryGenerationMs, entryChecks: Number(loads.selected.length > 0) };
  }
  return { verdict: 'pass', check: null, findings: [], notes, entryGenerationMs, entryChecks: Number(loads.selected.length > 0) };
}

export function formatCommitGateIncomplete(result) {
  return `commit gate incomplete (${result.check}): ${JSON.stringify(result.reason)}`;
}

/** One message for a refusal, the same from every writer. */
export function formatCommitGateRefusal(result) {
  return [`Commit refused by the commit gate (${result.check}): ${result.findings.length} finding(s):`,
    ...result.findings.map(finding => `  ${finding}`)].join('\n');
}

function unnamedPostBaseRemovals(git, base, head, tree, message) {
  const pathsChanged = (from, to) => git(['diff', '--name-only', '--no-renames', '-z', from, to]).split('\0').filter(Boolean);
  const changedSinceBase = new Set(pathsChanged(base, head));
  const namedLines = new Set(message.split(/\r?\n/u).map(line => line.trim()).filter(Boolean));
  const removals = [];
  const diff = (from, to, path) => git(['--literal-pathspecs', 'diff', '--no-ext-diff', '--no-textconv',
    '--no-renames', '--no-color', '--unified=0', from, to, '--', path]);
  for (const path of pathsChanged(head, tree)) {
    if (!changedSinceBase.has(path)) continue;
    const added = [];
    for (const line of diff(base, head, path).split('\n')) {
      const range = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/u.exec(line);
      if (range && range[2] !== '0') added.push([Number(range[1]), Number(range[1]) + Number(range[2] ?? 1)]);
    }
    if (!added.length) continue;
    let oldLine = 0;
    let rangeIndex = 0;
    for (const line of diff(head, tree, path).split('\n')) {
      const hunk = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/u.exec(line);
      if (hunk) {
        oldLine = Number(hunk[1]);
      } else if (oldLine && line.startsWith('-')) {
        while (added[rangeIndex]?.[1] <= oldLine) rangeIndex++;
        const text = line.slice(1).trim();
        if (added[rangeIndex]?.[0] <= oldLine && !namedLines.has(text) && !namedLines.has(`${path}:${oldLine}`)) removals.push({ path, line: oldLine, text });
        oldLine++;
      }
    }
  }
  return removals;
}

/** Compose the frozen delta against a proposed parent in a private index. */
async function composeReplayedPacket({ git, packet, head, scratchRoot = tmpdir() }) {
  const parentTree = git(['rev-parse', `${head}^{tree}`]).trim();
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
        if (conflicts.length) throw new Error(`patch conflicts in: ${conflicts.join(', ')}`);
        throw cause;
      }
    }
    gitIndex(['diff', '--cached', '--check', head, '--', '.', ':(exclude)patches/*.patch'], {
      env: { ...env, GIT_LITERAL_PATHSPECS: '0' },
    });
    const tree = writeTree();
    if (tree === parentTree) throw new Error('Packet is already present at HEAD');
    return { base: head, tree };
  } catch (cause) {
    throw new CommitGateUnavailable('frozen packet no longer applies to HEAD; refresh the patch', cause.stderr?.toString().trim() || cause);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function composePacketAgainstHead({ git, head, packet, replayScratchRoot }) {
  return head === packet.base ? packet : composeReplayedPacket({ git, packet, head, scratchRoot: replayScratchRoot });
}

async function checkPreparedPacket({ repo, git, head, packet, exact, message, priority }) {
  if (priority?.dependencyInputs && !await clearsWorkingDependencyInputDrift({ repoDir: repo, head, tree: exact.tree })) {
    return { priorityExpired: true };
  }
  if (priority?.breaking && head !== priority.head && !isHeadRestoration(repo, priority.breaking, head, exact.tree)) {
    return { priorityExpired: true };
  }
  if (head !== packet.base && message !== undefined) {
    const started = performance.now();
    const removals = unnamedPostBaseRemovals(git, packet.base, head, exact.tree, message);
    console.error(`commit gate: post-base line removal: ${Math.round(performance.now() - started)} ms`);
    if (removals.length) return { gate: {
      verdict: 'refused', check: 'post-base line removal', notes: [],
      findings: removals.map(({ path, line, text }) => `${path}:${line}: name this removed line in the commit message: ${text}`),
    } };
  }
  const gate = await runFastCommitGate({ repo, base: head, tree: exact.tree });
  for (const note of gate.notes) console.error(`commit gate: ${note}`);
  return gate.verdict === 'pass' ? {} : { gate };
}

function frozenCandidate(git, candidate) {
  const [base, tree] = git(['rev-parse', `${candidate}^`, `${candidate}^{tree}`]).trim().split('\n');
  return { base, tree };
}

function createGroupedCommit(git, candidate, exact, packet, message) {
  if (exact.base === packet.base && exact.tree === packet.tree) return candidate;
  const contents = git(['cat-file', 'commit', candidate]);
  const headers = contents.slice(0, contents.indexOf('\n\n'));
  // A signed commit must be recreated by its original writer when the parent changes.
  if (/^gpgsig(?:-sha256)? /mu.test(headers)) return;
  const identities = git(['show', '-s', '--format=%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI', candidate]).trimEnd().split('\0');
  const [author, email, date, committer, committerEmail, committerDate] = identities;
  return git(['commit-tree', exact.tree, '-p', exact.base, '-F', '-'], {
    input: message, env: { ...process.env, GIT_AUTHOR_NAME: author, GIT_AUTHOR_EMAIL: email, GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_NAME: committer, GIT_COMMITTER_EMAIL: committerEmail, GIT_COMMITTER_DATE: committerDate },
  }).trim();
}

function isHeadRestoration(repo, breaking, head, tree) {
  try { gitIn(repo)(['merge-base', '--is-ancestor', breaking, head]); }
  catch (error) { if (error.status === 1) return false; throw error; }
  return verifyHeadImportRepair({ repo, breaking, head, tree });
}

async function identifyHeadRestoration({ repo, git, ref, packet, message, replayScratchRoot }) {
  const claimsImportRepair = message && /^Restores-HEAD:/imu.test(message);
  const dependencyInputs = git(['diff', '--name-only', '--no-renames', '-z', packet.base, packet.tree,
    '--', ...RELOAD_DEPENDENCY_INPUTS]).length > 0;
  if (!dependencyInputs && !claimsImportRepair) return;
  const head = git(['rev-parse', '--verify', ref]).trim();
  if (dependencyInputs) {
    try {
      const exact = await composePacketAgainstHead({ git, head, packet, replayScratchRoot });
      if (await clearsWorkingDependencyInputDrift({ repoDir: repo, head, tree: exact.tree })) {
        return { dependencyInputs: true };
      }
    } catch (error) {
      console.error(`commit gate: fleet preflight repair uses ordinary arrival order (${error.message})`);
    }
  }
  if (!claimsImportRepair) return;
  const trailers = git(['interpret-trailers', '--parse'], { input: message });
  const claims = trailers.split('\n').filter(line => /^Restores-HEAD:/iu.test(line));
  const requested = claims.length === 1 && /^Restores-HEAD:\s+([a-f0-9]{7,64})$/iu.exec(claims[0])?.[1];
  if (!requested) return;
  try {
    const breaking = git(['rev-parse', '--verify', `${requested}^{commit}`]).trim();
    const exact = await composePacketAgainstHead({ git, head, packet, replayScratchRoot });
    if (isHeadRestoration(repo, breaking, head, exact.tree)) return { breaking, head };
    console.error('commit gate: Restores-HEAD claim did not match the current missing imports');
  } catch (error) {
    console.error(`commit gate: Restores-HEAD claim uses ordinary arrival order (${error.message})`);
  }
}

async function composeGroup({ repo, git, head, writers, priority, replayScratchRoot, timing }) {
  const accepted = [];
  const refused = [];
  for (const writer of writers) {
    const started = performance.now();
    let exact;
    let commit;
    try {
      exact = await composePacketAgainstHead({ git, head, packet: writer.packet, replayScratchRoot });
      commit = writer.createCommit(exact);
      if (!commit) {
        console.error(`commit gate: writer ${writer.id} resumes individually (signed packet needs its original writer)`);
        continue;
      }
    } catch (error) {
      if (!writer.id || !(error instanceof CommitGateUnavailable) || !error.check.startsWith('frozen packet')) throw error;
      console.error(`commit gate: writer ${writer.id} resumes individually (${error.message})`);
      continue;
    } finally {
      timing.applyMs += performance.now() - started;
    }
    const recheckAt = performance.now();
    const result = await checkPreparedPacket({ repo, git, head, packet: writer.packet, exact, message: writer.message, priority });
    timing.recheckMs += performance.now() - recheckAt;
    if (result.priorityExpired) return result;
    if (result.gate) {
      console.error(`commit gate: excluding writer ${writer.id ?? 'at the head'} after its ${result.gate.check} refused`);
      refused.push({ writer, gate: result.gate });
      continue;
    }
    accepted.push({ writer, commit, head, tree: exact.tree });
    head = commit;
  }
  return { accepted, refused, tip: head };
}

async function verifyGroup({ repo, head, writers, timing, ...context }) {
  const composed = await composeGroup({ repo, head, writers, timing, ...context });
  if (composed.priorityExpired || !composed.accepted.length) return composed;
  const { accepted, refused } = composed;
  const tree = accepted.at(-1).tree;
  const started = performance.now();
  const gate = await judgeEntryLoads({ repo, base: head, tree });
  for (const note of gate.notes) console.error(`commit gate: ${note}`);
  timing.recheckMs += Math.max(0, performance.now() - started - gate.entryGenerationMs);
  timing.entryGenerationMs += gate.entryGenerationMs;
  timing.entryChecks += gate.entryChecks;
  if (gate.verdict === 'pass') return composed;
  if (accepted.length === 1) {
    return { accepted: [], tip: head, refused: [...refused, { writer: accepted[0].writer, gate }] };
  }
  const candidates = accepted.map(({ writer }) => writer);
  const middle = Math.floor(candidates.length / 2);
  console.error(`commit gate: bisecting ${candidates.length} packets after ${gate.check} refused the combined tree`);
  const left = await verifyGroup({ repo, head, writers: candidates.slice(0, middle), timing, ...context });
  const right = await verifyGroup({ repo, head: left.tip, writers: candidates.slice(middle), timing, ...context });
  return { accepted: [...left.accepted, ...right.accepted], refused: [...refused, ...left.refused, ...right.refused], tip: right.tip };
}

function reportHold(repo, { refUpdateMs, ...preparation }, holdMs, grouped, published) {
  const rounded = Object.fromEntries(Object.entries(preparation).map(([key, value]) => [key, Math.round(value)]));
  const record = { timestamp: new Date().toISOString(), pid: process.pid, grouped, published, preparation: rounded,
    hold: { elapsedMs: Math.round(holdMs), applyMs: 0, recheckMs: 0, regenerationMs: 0, refUpdateMs: Math.round(refUpdateMs) } };
  console.error(`commit gate: lock held ${record.hold.elapsedMs} ms ${JSON.stringify(record)}`);
  try {
    const dir = dirname(defaultCommitTreeLedger(repo));
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'holds.jsonl'), `${JSON.stringify(record)}\n`);
  } catch (error) {
    console.error(`commit gate: could not record hold timing (${error.message})`);
  }
}

/** Judge a snapshot of clean queued packets, then publish their commit chain with one CAS. */
export async function finalizeGatedCommit({ repo, ref = 'HEAD', label, packet, createCommit, replayScratchRoot, message,
  candidate, dry = false }) {
  const git = gitIn(repo);
  const arrival = process.env.HAPPIER_COMMIT_GATE_ARRIVED_AT || Date.now();
  const waiting = candidate && !dry ? { candidate, label, message } : undefined;
  try {
    const queuedAt = performance.now();
    assertCommitGateDisk(process.env, repo, replayScratchRoot, process.env.P03_GATE_CACHE);
    const priority = waiting && await identifyHeadRestoration({ repo, git, ref, packet, message, replayScratchRoot });
    const land = async priority => {
      const timing = { applyMs: 0, recheckMs: 0, entryGenerationMs: 0, entryChecks: 0,
        refUpdateMs: 0 };
      const landed = [];
      let published = 0;
      const self = { packet, message, createCommit };
      const plan = async (head, queued) => {
        assertCommitGateDisk(process.env, repo, replayScratchRoot, process.env.P03_GATE_CACHE);
        const writers = [self];
        if (queued && !priority && !dry) {
          for await (const { id, packet: waiting, restoresHead, saveLanding } of queued()) {
            if (restoresHead) break;
            if (!waiting) continue;
            const packet = frozenCandidate(git, waiting.candidate);
            writers.push({ id, packet, message: waiting.message, saveLanding,
              createCommit: exact => createGroupedCommit(git, waiting.candidate, exact, packet, waiting.message) });
          }
        }
        try {
          const prepared = await verifyGroup({ repo, git, head, writers, priority, replayScratchRoot, timing });
          if (prepared.priorityExpired) return prepared;
          return { ...prepared, head };
        } catch (error) {
          if (error instanceof EntryLoadAdmissionRequired || error instanceof EntryLoadAdmissionUnavailable) throw error;
          return { error };
        }
      };
      const publish = async (moveRef, prepared) => {
        console.error(`commit gate: queue and preparation ${Math.round(performance.now() - queuedAt)} ms`);
        if (prepared.error) throw prepared.error;
        if (prepared.priorityExpired) return prepared;
        const { accepted, refused, head, tip } = prepared;
        const own = accepted.find(({ writer }) => writer === self);
        const failed = refused.find(({ writer }) => writer === self);
        if (!dry) {
          if (priority?.dependencyInputs && own &&
            !await clearsWorkingDependencyInputDrift({ repoDir: repo, head, tree: own.tree })) {
            return { priorityExpired: true };
          }
          if (refused.length) {
            for (const { writer, gate } of refused) writer.saveLanding?.({ commit: tip, gate });
          }
          for (const { writer, commit, head, tree } of accepted) writer.saveLanding?.({ commit, head, tree });
          if (tip !== head) {
            const started = performance.now();
            try { moveRef({ commit: tip, head, reason: `${label}: pid ${process.pid} (${accepted.length} packet(s))` }); }
            catch (error) { throw new CommitGateUnavailable('ref update', error); }
            finally { timing.refUpdateMs += performance.now() - started; }
            published = accepted.length;
            landed.push(...accepted.filter(({ writer }) => writer !== self));
          }
        }
        if (failed) return { gate: failed.gate };
        return { commit: own.commit, head: own.head, tree: own.tree };
      };
      try {
        return await withCommitLock({ repo, ref, label, arrival, packet: waiting, plan,
          restoresHead: priority?.breaking ?? priority?.dependencyInputs,
          onPublishedHold: elapsed => reportHold(repo, timing, elapsed, landed.length, published) }, publish);
      } finally {
        for (const { commit, head } of landed) console.error(`commit gate: grouped ${commit} after ${head}`);
      }
    };
    const result = await land(priority);
    if (!result.priorityExpired) return result;
    console.error('commit gate: HEAD repair priority expired; resuming in ordinary arrival order');
    return await land();
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
  const packet = frozenCandidate(git, candidate);
  return await finalizeGatedCommit({
    repo, ref, label: 'commit-partial', packet, candidate, dry,
    replayScratchRoot: dirname(resolve(patch)), message: readFileSync(message, 'utf8'),
    createCommit: exact => exact.base === packet.base && exact.tree === packet.tree ? candidate
      : git(['commit-tree', exact.tree, '-p', exact.base, '-F', message]).trim(),
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
      const postCommit = args.includes('--post-commit');
      const result = await runCommitGate({ repo, base, tree, phase: postCommit ? 'post-commit' : 'commit' });
      if (postCommit && result.verdict === 'refused') {
        const path = result.findings[0]?.match(/(?:^|\s)((?:apps|packages|scripts)\/[^\s:]+)/u)?.[1] ?? '';
        console.log(`HAPPIER_POST_COMMIT_FAILURE\t${result.check}\t${path}`);
      }
      for (const note of result.notes) console.log(`commit gate: ${note}`);
      process.exitCode = format(result);
    }
  } catch (error) {
    console.error(error.unavailable ? error.message : `commit gate unavailable: ${String(error?.message ?? error).slice(0, 600)}`);
    process.exitCode = COMMIT_GATE_EXIT.unavailable;
  }
}
