#!/usr/bin/env node
// The exact-tree safety checks and ref lock shared by every commit writer.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { bundledPluginManifestAssetRelativePath } from '../../apps/cli/scripts/build-owned/bundledPlugins/manifestAssetPath.mjs';
import { clearsWorkingDependencyInputDrift, RELOAD_DEPENDENCY_INPUTS } from '../../apps/stack/scripts/runtime/launch/reloadDependencyInputs.mjs';
import { commitSourceSyntax } from './commitSourceSyntax.mjs';
import { commitPluginManifests } from './commitPluginManifests.mjs';
import { commitLockfile } from './commitLockfile.mjs';
import { commitLocalImportClosure, commitProducerClosure, createRevisionViewReader, gitIn, restoresHeadImports as verifyHeadImportRepair } from './commitProducerClosure.mjs';
import { commitExtensionBoundaries } from './commitExtensionBoundaries.mjs';
import { commitImportCycles } from './commitImportCycles.mjs';
import { APPROVAL_DTO_PATH, commitTreeEntryLoads, defaultCommitTreeLedger, EntryLoadAdmissionRequired, EntryLoadAdmissionUnavailable,
  selectCommitTreeEntryGraphs, withAdmittedCommitEntryPhase } from './commitTreeEntryLoads.mjs';
import { withCommitLock } from './commitWriterLock.mjs';
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
    return { verdict: 'refused', check: "entry loads of the commit's own tree", findings: loads.findings, notes, entryGenerationMs };
  }
  return { verdict: 'pass', check: null, findings: [], notes, entryGenerationMs };
}

export function formatCommitGateIncomplete(result) {
  return `commit gate incomplete (${result.check}): ${JSON.stringify(result.reason)}`;
}

/** One message for a refusal, the same from every writer. */
export function formatCommitGateRefusal(result) {
  return [`Commit refused by the commit gate (${result.check}): ${result.findings.length} finding(s):`,
    ...result.findings.map(finding => `  ${finding}`)].join('\n');
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

function packetProjectionInputs(git, packet) {
  const paths = git(['diff', '--name-only', '--no-renames', '-z', packet.base, packet.tree]).split('\0');
  const candidates = new Map();
  for (const path of paths) {
    const match = /^packages\/plugins\/([^/]+)\/(src\/.+|package\.json)$/u.exec(path);
    if (!match || /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(path)) continue;
    const [, plugin, source] = match;
    candidates.set(plugin, candidates.get(plugin) || source === 'src/manifest.ts');
  }
  const plugins = new Set();
  if (candidates.size) {
    const tracked = new Set(git(['ls-tree', '-r', '--name-only', '-z', packet.base, '--', manifestAssetRoot]).split('\0'));
    for (const [plugin, manifestChanged] of candidates) {
      // This includes imported inputs such as accountDefinition.ts for an enrolled bundle.
      if (manifestChanged || tracked.has(`${CLI_PROJECTION_ROOT}/${bundledPluginManifestAssetRelativePath(plugin)}`)) {
        plugins.add(plugin);
      }
    }
  }
  return {
    plugins,
    dependencyInputs: paths.some(path => RELOAD_DEPENDENCY_INPUTS.includes(path)),
    fieldTitles: paths.includes('packages/protocol/src/actions/schemaInputHints.ts'),
    // Bundled Collection schemas embed the shared Action result declaration.
    // Re-evaluate those manifests even when no plugin-local source changed.
    collectionContracts: paths.includes('packages/protocol/src/actions/actionExecutionResult.ts'),
    approvals: paths.some(path => /^packages\/protocol\/src\/(?:approvals\/[^/]+|actions\/specs\/approvals)\.ts$/u.test(path)
      && !/\.(?:test|spec|d)\.ts$/u.test(path)),
  };
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

function mergeProjectionInputs(combined, added) {
  for (const name of added.plugins) combined.plugins.add(name);
  for (const path of added.conflicts) combined.conflicts.add(path);
  combined.fieldTitles ||= added.fieldTitles;
  combined.collectionContracts ||= added.collectionContracts;
  combined.approvals ||= added.approvals;
}

function requiredProjections({ conflicts, fieldTitles, collectionContracts, plugins, approvals }) {
  const cliConflict = [...conflicts].some(path => path !== APPROVAL_DTO_PATH);
  return { cli: cliConflict || fieldTitles || collectionContracts || plugins.size > 0,
    approvals: approvals || conflicts.has(APPROVAL_DTO_PATH), cliConflict };
}

async function emitPacketProjections({ gitIndex, replayedTree, scratch, projections, regenerate, timing }) {
  const { conflicts } = projections;
  const { cli, approvals, cliConflict } = requiredProjections(projections);
  if (!cli && !approvals) return;
  const output = join(scratch, 'projections');
  const started = performance.now();
  try { await regenerate(replayedTree, output, { cli, approvals, plugins: [...projections.plugins] }); }
  finally {
    if (timing) {
      timing.regenerationMs += performance.now() - started;
      if (regenerate !== requireOwnAdmission) timing.regenerations++;
    }
  }
  const emitted = new Map((existsSync(output) ? readdirSync(output, { recursive: true, withFileTypes: true }) : [])
    .filter(entry => entry.isFile()).map(entry => {
      const file = join(entry.parentPath, entry.name);
      return [relative(output, file).split(sep).join('/'), file];
    }));
  const required = new Set(conflicts);
  if (approvals) required.add(APPROVAL_DTO_PATH);
  const missing = [...required].filter(path => !emitted.has(path));
  if (missing.length) throw new Error(`canonical generator did not emit projections: ${missing.join(', ')}`);
  const tracked = new Map(gitIndex(['ls-tree', '-r', '-z', replayedTree, '--', CLI_PROJECTION_ROOT, APPROVAL_DTO_PATH])
    .split('\0').filter(Boolean).map(record => [record.slice(record.indexOf('\t') + 1), record.split(' ', 1)[0]]));
  const plugins = new Set(projections.plugins);
  if (projections.collectionContracts) {
    for (const [path, outputFile] of emitted) {
      if (dirname(path) !== manifestAssetRoot || !path.endsWith('.json')) continue;
      const previous = tracked.has(path)
        ? JSON.parse(gitIndex(['show', `${replayedTree}:${path}`]))?.contributes?.accountCollections ?? []
        : [];
      const next = JSON.parse(readFileSync(outputFile, 'utf8'))?.contributes?.accountCollections ?? [];
      if (!isDeepStrictEqual(previous, next)) plugins.add(path.slice(manifestAssetRoot.length + 1, -5));
    }
  }
  const selected = path => {
    if (required.has(path)) return true;
    if (cliConflict && tracked.has(path) && cliProjectionOwned(git, replayedTree, path)) return true;
    if (projections.fieldTitles && tracked.has(path) && path.startsWith(`${manifestAssetRoot}/declarations/`)) return true;
    for (const plugin of plugins) {
      if (path === `${CLI_PROJECTION_ROOT}/${bundledPluginManifestAssetRelativePath(plugin)}`
        || path.startsWith(`${manifestAssetRoot}/declarations/${plugin}.`)) return true;
    }
    return false;
  };
  const records = [];
  for (const [path, outputFile] of emitted) {
    if (!selected(path)) continue;
    const mode = tracked.get(path) ?? '100644';
    if (!['100644', '100755'].includes(mode)) throw new Error(`cannot regenerate non-regular projection: ${path}`);
    const blob = gitIndex(['hash-object', '-w', '--stdin'], { input: readFileSync(outputFile) }).trim();
    records.push(`${mode} ${blob}\t${path}\0`);
  }
  if (records.length) gitIndex(['update-index', '-z', '--index-info'], { input: records.join('') });
}

async function generateGroupTree({ git, tree, projections, regenerate, replayScratchRoot, timing }) {
  const { cli, approvals } = requiredProjections(projections);
  if (!cli && !approvals) return tree;
  const scratch = await mkdtemp(join(replayScratchRoot ?? tmpdir(), 'group-projections-'));
  const env = { ...process.env, GIT_INDEX_FILE: join(scratch, 'index'), GIT_LITERAL_PATHSPECS: '1' };
  const gitIndex = (args, options) => git(args, { ...options, env });
  try {
    gitIndex(['read-tree', tree]);
    await emitPacketProjections({ gitIndex, replayedTree: tree, scratch, projections, regenerate, timing });
    gitIndex(['diff', '--cached', '--check', tree]);
    return gitIndex(['write-tree']).trim();
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Compose the frozen delta against a proposed parent in a private index. */
async function composeReplayedPacket({ git, packet, head, regenerate, projections, headTree, scratchRoot = tmpdir(),
  deferProjection, timing }) {
  const parentTree = git(['rev-parse', `${headTree}^{tree}`]).trim();
  const scratch = await mkdtemp(join(scratchRoot, 'replay-index-'));
  const env = { ...process.env, GIT_INDEX_FILE: join(scratch, 'index'), GIT_LITERAL_PATHSPECS: '1' };
  const gitIndex = (args, options) => git(args, { ...options, env: options?.env ?? env });
  const writeTree = () => gitIndex(['write-tree']).trim();
  let conflicts = [];
  try {
    git(['merge-base', '--is-ancestor', packet.base, head]);
    const patch = git(['diff', '--binary', '--full-index', '--no-renames', packet.base, packet.tree], { encoding: 'buffer' });
    gitIndex(['read-tree', headTree]);
    try {
      gitIndex(['apply', '--cached'], { input: patch });
    } catch {
      gitIndex(['read-tree', headTree]);
      try {
        gitIndex(['apply', '--cached', '--3way'], { input: patch });
      } catch (cause) {
        const stages = gitIndex(['ls-files', '--unmerged', '-z']).split('\0').filter(Boolean);
        conflicts = [...new Set(stages.map(record => record.slice(record.indexOf('\t') + 1)))];
        if (!conflicts.length) throw cause;
        const source = conflicts.filter(path => path !== APPROVAL_DTO_PATH && !cliProjectionOwned(git, packet.base, path) && !cliProjectionOwned(git, headTree, path));
        if (source.length) throw new Error(`patch conflicts in source: ${source.join(', ')}`);
        // Take HEAD's projections temporarily. Every clean source hunk is already
        // in the index. The generator will replace projections in that combined tree.
        gitIndex(['update-index', '--force-remove', '--', ...conflicts]);
        const restored = gitIndex(['ls-tree', '-r', '-z', headTree, '--', ...conflicts])
          .replace(/(\d+) \S+ ([a-f0-9]+)\t/gu, '$1 $2\t');
        if (restored) gitIndex(['update-index', '-z', '--index-info'], { input: restored });
      }
    }
    const replayedTree = writeTree();
    const projected = { ...projections, conflicts: new Set(conflicts) };
    if (!deferProjection) {
      await emitPacketProjections({ gitIndex, replayedTree, scratch, projections: projected, regenerate, timing });
    }
    gitIndex(['diff', '--cached', '--check', headTree, '--', '.', ':(exclude)patches/*.patch'], {
      env: { ...env, GIT_LITERAL_PATHSPECS: '0' },
    });
    const tree = writeTree();
    if (tree === parentTree) throw new Error('Packet is already present at HEAD');
    return { base: head, tree, replayedTree, projections: projected };
  } catch (cause) {
    if (cause instanceof EntryLoadAdmissionRequired) throw cause;
    throw new CommitGateUnavailable('frozen packet no longer applies to HEAD; refresh the patch', cause.stderr?.toString().trim() || cause);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function composePacketAgainstHead({ git, head, headTree = head, packet, regenerate, projections, replayScratchRoot, ...projection }) {
  return headTree === packet.base && !projections.approvals && !projections.fieldTitles
    && !projections.collectionContracts && !projections.plugins.size
    ? { ...packet, replayedTree: packet.tree, projections: { ...projections, conflicts: new Set() } }
    : composeReplayedPacket({ git, packet, head, headTree, regenerate, projections, scratchRoot: replayScratchRoot, ...projection });
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
    const removals = unnamedPostBaseRemovals(git, packet.base, head, exact.replayedTree, message);
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

const requireOwnAdmission = () => { throw new EntryLoadAdmissionRequired(); };

function isHeadRestoration(repo, breaking, head, tree) {
  try { gitIn(repo)(['merge-base', '--is-ancestor', breaking, head]); }
  catch (error) { if (error.status === 1) return false; throw error; }
  return verifyHeadImportRepair({ repo, breaking, head, tree });
}

async function identifyHeadRestoration({ repo, git, ref, packet, message, projections, replayScratchRoot }) {
  const claimsImportRepair = message && /^Restores-HEAD:/imu.test(message);
  if (!projections.dependencyInputs && !claimsImportRepair) return;
  const head = git(['rev-parse', '--verify', ref]).trim();
  if (projections.dependencyInputs) {
    try {
      const exact = await composePacketAgainstHead({ git, head, packet, projections,
        regenerate: requireOwnAdmission, replayScratchRoot, deferProjection: true });
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
    const exact = await composePacketAgainstHead({ git, head, packet, projections,
      regenerate: requireOwnAdmission, replayScratchRoot });
    if (isHeadRestoration(repo, breaking, head, exact.tree)) return { breaking, head };
    console.error('commit gate: Restores-HEAD claim did not match the current missing imports');
  } catch (error) {
    console.error(`commit gate: Restores-HEAD claim uses ordinary arrival order (${error.message})`);
  }
}

async function composeGroup({ git, head, writers, replayScratchRoot, timing }) {
  const composed = [];
  for (const writer of writers) {
    const started = performance.now();
    try {
      const exact = await composePacketAgainstHead({ git, head, packet: writer.packet, projections: writer.projections,
        replayScratchRoot, deferProjection: true });
      const commit = writer.createCommit(exact);
      if (!commit) {
        console.error(`commit gate: writer ${writer.id} resumes individually (signed packet needs its original writer)`);
        continue;
      }
      composed.push({ writer, exact, commit });
      head = commit;
    } catch (error) {
      if (!writer.id || !(error instanceof CommitGateUnavailable) || !error.check.startsWith('frozen packet')) throw error;
      console.error(`commit gate: writer ${writer.id} resumes individually (${error.message})`);
    } finally {
      timing.applyMs += performance.now() - started;
    }
  }
  return composed;
}

async function checkGroup({ repo, git, head, composed, priority, replayScratchRoot, timing }) {
  const last = composed.at(-1);
  const projections = { plugins: new Set(), conflicts: new Set() };
  for (const { exact } of composed) mergeProjectionInputs(projections, exact.projections);
  const { cli, approvals } = requiredProjections(projections);
  const { selected: projects } = await selectCommitTreeEntryGraphs({ repo, base: head, tree: last.exact.tree, phase: 'commit' });
  const preparationAt = performance.now();
  const generationAt = timing.regenerationMs;
  const entryGenerationAt = timing.entryGenerationMs;
  try {
    const admissionAt = performance.now();
    return await withAdmittedCommitEntryPhase({ repo, tree: last.exact.tree, projects }, async (compareAdmittedEntryLoads, regenerate) => {
      console.error(`commit gate: preparation admission ${Math.round(performance.now() - admissionAt)} ms`);
      const tree = cli || approvals ? await generateGroupTree({ git, tree: last.exact.tree, projections, regenerate,
        replayScratchRoot, timing }) : last.exact.tree;
      const accepted = [];
      for (const { writer, exact, commit } of composed) {
        // Only the final commit carries the combined generated outputs. The fast checks
        // still judge every individual commit against the parent it will expose.
        const finalTree = writer === last.writer ? tree : exact.tree;
        const result = await checkPreparedPacket({ repo, git, head: exact.base, packet: writer.packet,
          exact: { ...exact, tree: finalTree }, message: writer.message, priority });
        if (result.gate || result.priorityExpired) return result;
        const verifiedCommit = finalTree === exact.tree ? commit : writer.createCommit({ ...exact, tree: finalTree });
        accepted.push({ writer, commit: verifiedCommit, head: exact.base, tree: finalTree });
      }
      const gate = await judgeEntryLoads({ repo, base: head, tree, compareAdmittedEntryLoads });
      for (const note of gate.notes) console.error(`commit gate: ${note}`);
      timing.entryGenerationMs += gate.entryGenerationMs ?? 0;
      if (projects.length) timing.entryChecks++;
      return gate.verdict === 'pass' ? { accepted } : { gate };
    });
  } finally {
    timing.recheckMs += Math.max(0, performance.now() - preparationAt -
      (timing.regenerationMs - generationAt) - (timing.entryGenerationMs - entryGenerationAt));
  }
}

async function verifyGroup({ head, writers, timing, ...context }) {
  const composed = await composeGroup({ head, writers, timing, ...context });
  if (!composed.length) return { accepted: [], refused: [], tip: head };
  const result = await checkGroup({ head, composed, timing, ...context });
  if (result.priorityExpired) return result;
  if (result.accepted) return { ...result, refused: [], tip: result.accepted.at(-1).commit };
  if (composed.length === 1) return { accepted: [], tip: head, refused: [{ writer: composed[0].writer, gate: result.gate }] };

  const candidates = composed.map(({ writer }) => writer);
  const middle = Math.floor(candidates.length / 2);
  console.error(`commit gate: bisecting ${candidates.length} packets after ${result.gate.check} refused the combined tree`);
  const left = await verifyGroup({ head, writers: candidates.slice(0, middle), timing, ...context });
  const right = await verifyGroup({ head: left.tip, writers: candidates.slice(middle), timing, ...context });
  return { accepted: [...left.accepted, ...right.accepted], refused: [...left.refused, ...right.refused], tip: right.tip };
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
  const projections = packetProjectionInputs(git, packet);
  const arrival = process.env.HAPPIER_COMMIT_GATE_ARRIVED_AT || Date.now();
  const waiting = candidate && !dry ? { candidate, label, message } : undefined;
  try {
    const queuedAt = performance.now();
    const priority = waiting && await identifyHeadRestoration({ repo, git, ref, packet, message, projections, replayScratchRoot });
    const land = async priority => {
      const timing = { applyMs: 0, recheckMs: 0, regenerationMs: 0, regenerations: 0, entryGenerationMs: 0, entryChecks: 0,
        refUpdateMs: 0 };
      const landed = [];
      let published = 0;
      const self = { packet, projections, message, createCommit };
      const plan = async (head, queued) => {
        const writers = [self];
        if (queued && !priority && !dry) {
          for await (const { id, packet: waiting, restoresHead, saveLanding } of queued()) {
            if (restoresHead) break;
            if (!waiting) continue;
            const packet = frozenCandidate(git, waiting.candidate);
            writers.push({ id, packet, projections: packetProjectionInputs(git, packet), message: waiting.message, saveLanding,
              createCommit: exact => createGroupedCommit(git, waiting.candidate, exact, packet, waiting.message) });
          }
        }
        try {
          const prepared = await verifyGroup({ repo, git, head, writers, priority, replayScratchRoot, timing });
          if (prepared.priorityExpired) return prepared;
          const tickets = [...prepared.accepted, ...prepared.refused].map(({ writer }) => writer.id).filter(Boolean);
          return { ...prepared, head, tickets };
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
