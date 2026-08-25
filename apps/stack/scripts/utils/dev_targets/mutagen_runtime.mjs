import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { DEV_TARGET_DISPOSABLE_REPLICA_ARTIFACT_ROOTS } from './mutagen_project.mjs';

export const MUTAGEN_SYNC_LIST_JSON_TEMPLATE = '{{json .}}';

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
  pathExists = existsSync,
} = {}) {
  const baseDir = String(stackBaseDir ?? '').trim();
  if (!baseDir) throw new Error('[dev-targets] stack base directory is required');
  const mutagenDir = join(baseDir, 'mutagen');
  const dataDir = join(mutagenDir, 'data');
  const opensshDir = join(mutagenDir, 'openssh');
  return {
    mutagenDir,
    dataDir,
    opensshDir,
    projectFile: join(mutagenDir, 'mutagen.yml'),
    syncServiceStateFile: join(mutagenDir, 'sync-service-state.v1.json'),
    env: {
      ...(env ?? process.env),
      MUTAGEN_DATA_DIRECTORY: dataDir,
      MUTAGEN_SSH_CONNECT_TIMEOUT: String(env?.MUTAGEN_SSH_CONNECT_TIMEOUT ?? '10'),
      ...(pathExists(opensshDir) ? { MUTAGEN_SSH_PATH: opensshDir } : {}),
    },
  };
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
  const lastError = String(session.lastError ?? '').trim();
  if (session.paused === true) {
    return { state: 'paused', sessionName: expectedName, session };
  }
  if (lastError) {
    return { state: 'unhealthy', sessionName: expectedName, lastError, session };
  }
  const conflicts = Array.isArray(session.conflicts) ? session.conflicts : [];
  if (conflicts.length > 0) {
    const roots = conflicts
      .map((conflict) => String(conflict?.root ?? '').trim())
      .filter(Boolean);
    const conflictDetail = roots.length > 0 ? `: ${roots.join(', ')}` : '';
    return {
      state: 'unhealthy',
      sessionName: expectedName,
      lastError: `${conflicts.length} unresolved synchronization ${conflicts.length === 1 ? 'conflict' : 'conflicts'}${conflictDetail}`,
      session,
    };
  }
  const status = String(session.status ?? '').trim().toLowerCase();
  if (MUTAGEN_UNHEALTHY_STATUSES.has(status) || !status) {
    return { state: 'unhealthy', sessionName: expectedName, session };
  }
  if (MUTAGEN_CONNECTING_STATUSES.has(status)) {
    return { state: 'synchronizing', sessionName: expectedName, session };
  }
  if (status !== 'watching' && !MUTAGEN_SYNCHRONIZING_STATUSES.has(status)) {
    return { state: 'unhealthy', sessionName: expectedName, session };
  }
  const successfulCycles = Number(session.successfulCycles);
  if (!Number.isFinite(successfulCycles) || successfulCycles <= 0) {
    return { state: 'synchronizing', sessionName: expectedName, session };
  }
  return { state: 'ready', sessionName: expectedName, session };
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
