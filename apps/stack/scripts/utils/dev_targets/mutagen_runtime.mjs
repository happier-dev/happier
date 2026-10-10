import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { DEV_TARGET_DISPOSABLE_REPLICA_ARTIFACT_ROOTS, DEV_TARGET_SYNC_EXECUTOR_REPO, resolveMutagenRepositoryKey } from './mutagen_project.mjs';
import { resolveRepoStackIdentity, resolveStacksStorageRoot } from '../stack/repo_stack_identity.mjs';

export const MUTAGEN_SYNC_LIST_JSON_TEMPLATE = '{{json .}}';
export const DEV_TARGET_MUTAGEN_RUNTIME_OWNER = 'stack-dev-targets';

// One readiness policy for JSON consumers and the generated native selector.
// Endpoint/error/conflict validation belongs to each transport boundary; these
// rules decide when clean connected evidence can enter the causal flush.
const SYNC_READINESS_RULES = [
  { when: { scanProblems: true, scanned: true, completed: true }, state: 'rescan' },
  { when: { scanProblems: true }, state: 'unhealthy' },
  { when: { cyclesValid: false }, state: 'synchronizing' },
  { when: { watching: true, noWatch: true, completed: false }, state: 'needs-flush' },
  { when: { scanned: false }, state: 'synchronizing' },
  { when: { completed: false }, state: 'synchronizing' },
  { when: {}, state: 'ready' },
];

export function classifyCleanMutagenReadiness(facts) {
  return SYNC_READINESS_RULES.find(({ when }) => (
    Object.entries(when).every(([fact, value]) => facts[fact] === value)
  )).state;
}

export function renderNativeSyncReadinessPolicy() {
  return [
    '# Generated from mutagen_runtime.mjs; do not edit.',
    '# Regenerate: node apps/stack/scripts/utils/dev_targets/native_execution_projection.mjs --write-sync-policy',
    'classify_clean_mutagen_readiness() {',
    ...SYNC_READINESS_RULES.flatMap(({ when, state }) => {
      const conditions = Object.entries(when).map(([fact, value]) => `[ "$sync_fact_${fact}" = ${value ? '1' : '0'} ]`);
      return conditions.length
        ? [`  if ${conditions.join(' && ')}; then`, `    sync_readiness=${state}`, '    return', '  fi']
        : [`  sync_readiness=${state}`];
    }),
    '}',
    '',
  ].join('\n');
}

const MUTAGEN_SYNCHRONIZING_STATUSES = new Set([
  'scanning',
  'waiting-for-rescan',
  'reconciling',
  'staging-alpha',
  'staging-beta',
  'transitioning',
  'saving',
]);

const MUTAGEN_CONNECTING_STATUSES = new Set([
  'connecting-alpha',
  'connecting-beta',
]);

const MUTAGEN_UNHEALTHY_STATUSES = new Set([
  'disconnected',
  'halted-on-root-emptied',
  'halted-on-root-deletion',
  'halted-on-root-type-change',
  'unknown',
]);

export function resolveDevTargetMutagenRuntime({
  stackBaseDir,
  env = process.env,
  sourceDir = env?.HAPPIER_STACK_SYNC_SOURCE_DIR || DEV_TARGET_SYNC_EXECUTOR_REPO,
  pathExists = existsSync,
} = {}) {
  const baseDir = String(stackBaseDir ?? '').trim();
  if (!baseDir) throw new Error('[dev-targets] stack base directory is required');
  const ownerBaseDir = resolveRepoStackIdentity({
    repoRoot: DEV_TARGET_SYNC_EXECUTOR_REPO,
    stacksStorageRoot: resolveStacksStorageRoot(env),
    createIfMissing: false,
  }).stackBaseDir;
  const mutagenDir = join(ownerBaseDir, 'mutagen');
  const dataDir = join(mutagenDir, 'data');
  const opensshDir = join(mutagenDir, 'openssh');
  const repository = resolveMutagenRepositoryKey(sourceDir);
  const projectDir = repository ? join(mutagenDir, 'repositories', repository) : mutagenDir;
  return {
    owner: DEV_TARGET_MUTAGEN_RUNTIME_OWNER,
    mutagenDir,
    dataDir,
    opensshDir,
    sourceDir,
    ownerBaseDir,
    projectFile: join(projectDir, 'mutagen.yml'),
    syncServiceStateFile: join(projectDir, 'sync-service-state.v1.json'),
    env: {
      ...(env ?? process.env),
      MUTAGEN_DATA_DIRECTORY: dataDir,
      HAPPIER_STACK_SYNC_SOURCE_DIR: sourceDir,
      MUTAGEN_SSH_CONNECT_TIMEOUT: String(env?.MUTAGEN_SSH_CONNECT_TIMEOUT ?? '10'),
      ...(pathExists(opensshDir) ? { MUTAGEN_SSH_PATH: opensshDir } : {}),
    },
  };
}

export function resolveDevTargetSshConfigFile(target, { stackBaseDir, env = process.env } = {}) {
  if (stackBaseDir) {
    const { opensshDir } = resolveDevTargetMutagenRuntime({ stackBaseDir, env });
    const sharedConfig = join(opensshDir, 'config');
    if (existsSync(sharedConfig)) return sharedConfig;
  }
  return target.sshConfigFile;
}

/**
 * Stack dev-target Mutagen is an isolated tooling owner.  Product workspace
 * sync passes its own daemon-owned data directory and must never reuse this
 * path (or a parent/child of it).
 */
export function assertDevTargetMutagenRuntimeIsolation({ runtime, managedDataDir } = {}) {
  const runtimeDataDir = normalizePath(runtime?.dataDir);
  const managed = normalizePath(managedDataDir);
  if (!runtimeDataDir || !managed) throw new Error('[dev-targets] Mutagen isolation paths are required');
  if (pathsOverlap(runtimeDataDir, managed)) {
    throw new Error(`[dev-targets] managed workspace-sync Mutagen data overlaps stack dev-target data: ${managed}`);
  }
  if (runtime?.env?.MUTAGEN_DATA_DIRECTORY !== runtime?.dataDir) {
    throw new Error('[dev-targets] MUTAGEN_DATA_DIRECTORY must remain owned by the stack dev-target runtime');
  }
  return true;
}

function normalizePath(value) {
  return String(value ?? '').trim().replaceAll('\\', '/').replace(/\/+$/u, '').toLowerCase();
}

function pathsOverlap(left, right) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

export function parseMutagenSyncList(raw, sessionName) {
  const expectedName = String(sessionName ?? '').trim();
  if (!expectedName) throw new Error('[dev-targets] Mutagen session name is required');
  let sessions;
  try {
    sessions = JSON.parse(String(raw ?? '').trim() || '[]');
  } catch (error) {
    throw new Error(
      `[dev-targets] invalid Mutagen session response: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!Array.isArray(sessions)) {
    throw new Error('[dev-targets] invalid Mutagen session response: expected an array');
  }
  const session = sessions.find((entry) => (
    entry?.name === expectedName || entry?.identifier === expectedName
  ));
  if (!session) return { state: 'missing', sessionName: expectedName };
  if (typeof session.paused !== 'boolean') {
    return { state: 'unhealthy', sessionName: expectedName, lastError: 'malformed paused evidence', session };
  }
  const lastError = String(session.lastError ?? '').trim();
  if (session.paused === true) {
    return { state: 'paused', sessionName: expectedName, session };
  }
  if (lastError) {
    return { state: 'unhealthy', sessionName: expectedName, lastError, session };
  }
  const conflicts = session.conflicts == null ? [] : session.conflicts;
  const excludedConflicts = session.excludedConflicts == null ? 0 : session.excludedConflicts;
  if (
    !Array.isArray(conflicts)
    || !Number.isSafeInteger(excludedConflicts)
    || excludedConflicts < 0
  ) {
    return { state: 'unhealthy', sessionName: expectedName, lastError: 'malformed conflict evidence', session };
  }
  if (conflicts.length > 0 || excludedConflicts > 0) {
    const roots = conflicts
      .map((conflict) => String(conflict?.root ?? '').trim())
      .filter(Boolean);
    const totalConflicts = conflicts.length + excludedConflicts;
    const conflictDetail = roots.length > 0 ? `: ${roots.join(', ')}` : '';
    return {
      state: 'unhealthy',
      sessionName: expectedName,
      lastError: `${totalConflicts} unresolved synchronization ${totalConflicts === 1 ? 'conflict' : 'conflicts'}${conflictDetail}`,
      session,
    };
  }
  if (typeof session.status !== 'string') {
    return { state: 'unhealthy', sessionName: expectedName, lastError: 'malformed status evidence', session };
  }
  const status = session.status.trim().toLowerCase();
  if (MUTAGEN_UNHEALTHY_STATUSES.has(status) || !status) {
    return { state: 'unhealthy', sessionName: expectedName, session };
  }
  if (MUTAGEN_CONNECTING_STATUSES.has(status)) {
    return { state: 'synchronizing', sessionName: expectedName, session };
  }
  if (status !== 'watching' && !MUTAGEN_SYNCHRONIZING_STATUSES.has(status)) {
    return { state: 'unhealthy', sessionName: expectedName, session };
  }
  const alpha = session.alpha ?? null;
  const beta = session.beta ?? null;
  if (!alpha || !beta || alpha.connected !== true || beta.connected !== true) {
    return { state: 'unhealthy', sessionName: expectedName, lastError: 'missing connected endpoint evidence', session };
  }
  const scanDetails = [];
  for (const [endpointName, endpoint] of [['alpha', alpha], ['beta', beta]]) {
    const scanProblems = endpoint.scanProblems == null ? [] : endpoint.scanProblems;
    const excludedScan = endpoint.excludedScanProblems == null ? 0 : endpoint.excludedScanProblems;
    const transitionProblems = endpoint.transitionProblems == null ? [] : endpoint.transitionProblems;
    const excludedTransition = endpoint.excludedTransitionProblems == null
      ? 0
      : endpoint.excludedTransitionProblems;
    if (
      !Array.isArray(scanProblems)
      || !Number.isSafeInteger(excludedScan)
      || excludedScan < 0
      || !Array.isArray(transitionProblems)
      || !Number.isSafeInteger(excludedTransition)
      || excludedTransition < 0
    ) {
      return {
        state: 'unhealthy',
        sessionName: expectedName,
        lastError: `malformed ${endpointName} problem evidence`,
        session,
      };
    }
    const hasExcludedScan = excludedScan > 0;
    const hasExcludedTransition = excludedTransition > 0;
    if (transitionProblems.length > 0 || hasExcludedTransition) {
      const parts = [];
      if (scanProblems.length > 0 || hasExcludedScan) parts.push(`${scanProblems.length + (hasExcludedScan ? excludedScan : 0)} scan problems`);
      if (transitionProblems.length > 0 || hasExcludedTransition) parts.push(`${transitionProblems.length + (hasExcludedTransition ? excludedTransition : 0)} transition problems`);
      return {
        state: 'unhealthy',
        sessionName: expectedName,
        lastError: `${endpointName} has ${parts.join(' and ')}`,
        session,
      };
    }
    if (scanProblems.length > 0 || hasExcludedScan) {
      const detail = scanProblems.map(problem => `${String(problem?.path ?? '')}: ${String(problem?.error ?? '')}`).join('; ');
      scanDetails.push(`${endpointName} has ${scanProblems.length + excludedScan} scan problems${detail ? ` (${detail})` : ''}`);
    }
  }
  const cycles = session.successfulCycles === undefined ? 0 : session.successfulCycles;
  const readiness = classifyCleanMutagenReadiness({
    watching: status === 'watching',
    noWatch: alpha.watch?.mode === 'no-watch' && beta.watch?.mode === 'no-watch',
    scanned: alpha.scanned === true && beta.scanned === true,
    cyclesValid: Number.isSafeInteger(cycles) && cycles >= 0,
    completed: Number.isSafeInteger(cycles) && cycles > 0,
    scanProblems: scanDetails.length > 0,
  });
  if (scanDetails.length) {
    return {
      state: 'unhealthy', sessionName: expectedName, lastError: scanDetails.join('; '),
      ...(readiness === 'rescan' ? { recovery: 'rescan' } : {}), session,
    };
  }
  return { state: readiness, sessionName: expectedName, session };
}

function isSafeRelativeConflictRoot(value) {
  const root = String(value ?? '').trim();
  return Boolean(root)
    && !root.startsWith('/')
    && !root.startsWith('\\')
    && !root.split(/[\\/]+/).some((segment) => segment === '..' || segment === '');
}

export function resolveRecoverableReplicaArtifactConflictRoots(session) {
  if (session?.mode !== 'one-way-replica') return [];
  const conflicts = Array.isArray(session?.conflicts) ? session.conflicts : [];
  if (conflicts.length === 0) return [];
  const roots = [];
  const disposableArtifactRoots = new Set(DEV_TARGET_DISPOSABLE_REPLICA_ARTIFACT_ROOTS);
  for (const conflict of conflicts) {
    const root = String(conflict?.root ?? '').trim();
    if (!isSafeRelativeConflictRoot(root)) continue;
    const alphaChanges = Array.isArray(conflict?.alphaChanges) ? conflict.alphaChanges : [];
    const betaChanges = Array.isArray(conflict?.betaChanges) ? conflict.betaChanges : [];
    const alphaRemovesRoot = alphaChanges.length === 1
      && alphaChanges[0]?.path === root
      && (alphaChanges[0]?.old == null || alphaChanges[0]?.old?.kind === 'directory')
      && alphaChanges[0]?.new == null;
    const rootPrefix = `${root}/`;
    const rootName = root.split(/[\\/]+/).at(-1);
    const rootIsDisposableArtifact = disposableArtifactRoots.has(rootName);
    const betaOnlyHasIgnoredArtifacts = betaChanges.length > 0 && betaChanges.every((change) => (
      String(change?.path ?? '').startsWith(rootPrefix)
      && disposableArtifactRoots.has(String(change.path).slice(rootPrefix.length).split(/[\\/]/, 1)[0])
      && change?.old == null
      && change?.new?.kind === 'untracked'
    ));
    const betaOnlyHasUntrackedRootContents = betaChanges.length > 0 && betaChanges.every((change) => (
      String(change?.path ?? '').startsWith(rootPrefix)
      && change?.old == null
      && change?.new?.kind === 'untracked'
    ));
    if (
      !alphaRemovesRoot
      || !(betaOnlyHasIgnoredArtifacts || (rootIsDisposableArtifact && betaOnlyHasUntrackedRootContents))
    ) continue;
    roots.push(root);
  }
  return roots;
}
