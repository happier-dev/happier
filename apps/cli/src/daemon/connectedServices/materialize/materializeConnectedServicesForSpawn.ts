import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import type {
  AccountSettings,
  ConnectedServiceCredentialRecordV1,
  ConnectedServiceId,
  QualifiedConnectedAccountPurposeBindingV1,
} from '@happier-dev/protocol';

import { getConnectedServicesMaterializer } from '@/daemon/connectedServices/catalogHooks';
import type { CatalogAgentId } from '@/agent/catalog/ids';
import type {
  ConnectedServiceResolvedSelection,
  ConnectedServicesMaterializationAuthority,
  ConnectedServicesMaterialization,
  ConnectedServicesMaterializationDiagnostic,
} from '@/daemon/connectedServices/materialization/materializer';
import { createBestEffortCleanupDirectory } from '@/daemon/connectedServices/materialization/materializer';
import { replaceDirectoryAtomically } from '@/utils/fs/replaceDirectoryAtomically';
import {
  HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_ENV_KEY,
  HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY,
  HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT_ENV_KEY,
  serializeConnectedServiceMaterializedEnvKeys,
  serializeConnectedServiceChildSelections,
} from '../connectedServiceChildEnvironment';
import { resolveConnectedServiceMaterializedRootDir } from './resolveConnectedServiceMaterializedRootDir';
import { resolveConnectedServiceTargetMaterializedRoot } from './resolveConnectedServiceTargetMaterializedRoot';
import { ensurePrivateConnectedServiceMaterializedRoot } from './privateMaterializedRoot';

export class ConnectedServiceMaterializationBlockedError extends Error {
  readonly code = 'connected_service_materialization_blocked';
  readonly diagnostics: readonly ConnectedServicesMaterializationDiagnostic[];

  constructor(diagnostics: readonly ConnectedServicesMaterializationDiagnostic[]) {
    super('Connected service materialization blocked');
    this.name = 'ConnectedServiceMaterializationBlockedError';
    this.diagnostics = diagnostics;
  }
}

const activeMaterializationAttemptByRootDir = new Map<string, string>();
const materializationAttemptTailByRootDir = new Map<string, Promise<void>>();
const materializationPromotionTailByRootDir = new Map<string, Promise<void>>();

export class ConnectedServiceMaterializationSupersededError extends Error {
  readonly code = 'connected_service_materialization_superseded';

  constructor(rootDir: string) {
    super(`Connected-service materialization for ${rootDir} was superseded by a newer attempt`);
    this.name = 'ConnectedServiceMaterializationSupersededError';
  }
}

function forgetActiveAttemptIfCurrent(rootDir: string, attemptId: string): void {
  if (activeMaterializationAttemptByRootDir.get(rootDir) === attemptId) {
    activeMaterializationAttemptByRootDir.delete(rootDir);
  }
}

function assertActiveAttempt(params: Readonly<{
  rootDir: string;
  attemptId: string;
  cleanupRoot: () => void;
}>): void {
  if (activeMaterializationAttemptByRootDir.get(params.rootDir) === params.attemptId) {
    return;
  }
  params.cleanupRoot();
  throw new ConnectedServiceMaterializationSupersededError(params.rootDir);
}

/**
 * RR-3 backstop: every leaf inside a serialized segment is bounded (fetch/keychain budgets +
 * the external-waits invariant guard), so a predecessor that never settles is pathological. A
 * joiner therefore waits at most this long, then fails LOUDLY (typed error) instead of hanging
 * every future materialization of that root forever — and the finally-cleanup drops the stuck
 * tail from the map so the NEXT attempt starts a fresh queue (self-healing).
 */
const MATERIALIZATION_TAIL_WAIT_TIMEOUT_MS = 6 * 60_000;

export class ConnectedServiceMaterializationTailStuckError extends Error {
  constructor(rootDir: string) {
    super(`connected_service_materialization_tail_stuck:${rootDir}`);
    this.name = 'ConnectedServiceMaterializationTailStuckError';
  }
}

async function awaitTailWithBackstop(previousTail: Promise<void>, rootDir: string): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const backstop = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new ConnectedServiceMaterializationTailStuckError(rootDir)),
      MATERIALIZATION_TAIL_WAIT_TIMEOUT_MS,
    );
    timer.unref?.();
  });
  try {
    await Promise.race([previousTail.catch(() => {}), backstop]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Single owner of per-root tail serialization (used for both materialization work and staged
 * promotion — previously two identical copies). Segments run strictly after the root's previous
 * segment; a stuck predecessor is bounded by the RR-3 backstop above.
 */
async function runSerializedOnRootTail<T>(
  tailByRootDir: Map<string, Promise<void>>,
  rootDir: string,
  work: () => Promise<T>,
): Promise<T> {
  const previousTail = tailByRootDir.get(rootDir) ?? Promise.resolve();
  let releaseCurrent!: () => void;
  const currentTailSegment = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const currentTail = previousTail.catch(() => {}).then(() => currentTailSegment);
  tailByRootDir.set(rootDir, currentTail);

  try {
    await awaitTailWithBackstop(previousTail, rootDir);
    return await work();
  } finally {
    releaseCurrent();
    if (tailByRootDir.get(rootDir) === currentTail) {
      tailByRootDir.delete(rootDir);
    }
  }
}

async function runSerializedPromotion<T>(
  rootDir: string,
  promote: () => Promise<T>,
): Promise<T> {
  return await runSerializedOnRootTail(materializationPromotionTailByRootDir, rootDir, promote);
}

export async function runSerializedMaterialization<T>(
  rootDir: string,
  materialize: () => Promise<T>,
): Promise<T> {
  return await runSerializedOnRootTail(materializationAttemptTailByRootDir, rootDir, materialize);
}

function rewriteEnvRoot(
  env: Readonly<Record<string, string>>,
  fromRoot: string,
  toRoot: string,
): Record<string, string> {
  const rewritten: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    const rel = relative(fromRoot, value);
    rewritten[key] = rel === ''
      ? toRoot
      : !rel.startsWith('..') && !isAbsolute(rel)
        ? join(toRoot, rel)
        : value;
  }
  return rewritten;
}

function rewritePathRoot(
  value: string,
  fromRoot: string,
  toRoot: string,
): string {
  const rel = relative(fromRoot, value);
  return rel === ''
    ? toRoot
    : !rel.startsWith('..') && !isAbsolute(rel)
      ? join(toRoot, rel)
      : value;
}

export async function materializeConnectedServicesForSpawn(params: Readonly<{
  agentId: CatalogAgentId;
  materializationKey: string;
  activeServerDir: string;
  baseDir: string;
  sessionDirectory?: string | null;
  recordsByServiceId: ReadonlyMap<ConnectedServiceId, ConnectedServiceCredentialRecordV1>;
  selectionsByServiceId?: ReadonlyMap<ConnectedServiceId, ConnectedServiceResolvedSelection>;
  connectedAccountMaterializationAuthority: ConnectedServicesMaterializationAuthority;
  accountSettings?: AccountSettings | Readonly<Record<string, unknown>> | null;
  processEnv?: NodeJS.ProcessEnv;
}>): Promise<ConnectedServicesMaterialization | null> {
  const rootDir = resolveConnectedServiceMaterializedRootDir({
    baseDir: params.baseDir,
    agentId: params.agentId,
    materializationKey: params.materializationKey,
  });
  return await runSerializedMaterialization(rootDir, async () =>
    materializeConnectedServicesForSpawnUnlocked(params, rootDir),
  );
}

async function materializeConnectedServicesForSpawnUnlocked(params: Readonly<{
  agentId: CatalogAgentId;
  materializationKey: string;
  activeServerDir: string;
  baseDir: string;
  sessionDirectory?: string | null;
  recordsByServiceId: ReadonlyMap<ConnectedServiceId, ConnectedServiceCredentialRecordV1>;
  selectionsByServiceId?: ReadonlyMap<ConnectedServiceId, ConnectedServiceResolvedSelection>;
  connectedAccountMaterializationAuthority: ConnectedServicesMaterializationAuthority;
  accountSettings?: AccountSettings | Readonly<Record<string, unknown>> | null;
  processEnv?: NodeJS.ProcessEnv;
}>, rootDir: string): Promise<ConnectedServicesMaterialization | null> {
  const materializationSegment = basename(dirname(rootDir));
  const attemptRoot = join(params.baseDir, '.attempts', `${materializationSegment}-${params.agentId}-${randomUUID()}`);
  const attemptId = attemptRoot;
  activeMaterializationAttemptByRootDir.set(rootDir, attemptId);
  const cleanupAttemptRoot = createBestEffortCleanupDirectory(attemptRoot);

  const materializer = await getConnectedServicesMaterializer(params.agentId);
  if (!materializer) {
    forgetActiveAttemptIfCurrent(rootDir, attemptId);
    return null;
  }

  let materialized: ConnectedServicesMaterialization | null;
  try {
    await ensurePrivateConnectedServiceMaterializedRoot(attemptRoot);
    materialized = await materializer({
      materializationKey: params.materializationKey,
      activeServerDir: params.activeServerDir,
      baseDir: params.baseDir,
      rootDir: attemptRoot,
      sessionDirectory: params.sessionDirectory ?? null,
      recordsByServiceId: params.recordsByServiceId,
      selectionsByServiceId: params.selectionsByServiceId,
      connectedAccountMaterializationAuthority:
        params.connectedAccountMaterializationAuthority,
      accountSettings: params.accountSettings ?? null,
      processEnv: params.processEnv ?? process.env,
    });
  } catch (error) {
    cleanupAttemptRoot();
    forgetActiveAttemptIfCurrent(rootDir, attemptId);
    throw error;
  }
  if (!materialized) {
    cleanupAttemptRoot();
    forgetActiveAttemptIfCurrent(rootDir, attemptId);
    return null;
  }
  const blockingDiagnostics = (materialized.diagnostics ?? [])
    .filter((diagnostic) => diagnostic.severity === 'blocking');
  if (blockingDiagnostics.length > 0) {
    cleanupAttemptRoot();
    forgetActiveAttemptIfCurrent(rootDir, attemptId);
    throw new ConnectedServiceMaterializationBlockedError(blockingDiagnostics);
  }

  const materializedEnv = rewriteEnvRoot(materialized.env, attemptRoot, rootDir);
  const explicitTargetMaterializedRoot = typeof materialized.targetMaterializedRoot === 'string'
    && materialized.targetMaterializedRoot.trim().length > 0
    ? rewritePathRoot(materialized.targetMaterializedRoot, attemptRoot, rootDir)
    : null;
  const requestAuthMaterializedRoot =
    typeof materialized.requestAuthMaterializedRoot === 'string'
      && materialized.requestAuthMaterializedRoot.trim().length > 0
      ? rewritePathRoot(
        materialized.requestAuthMaterializedRoot,
        attemptRoot,
        rootDir,
      )
      : null;
  const serializedSelections = serializeConnectedServiceChildSelections(params.selectionsByServiceId);
  const serializedMaterializedEnvKeys = serializeConnectedServiceMaterializedEnvKeys(materializedEnv);
  const targetMaterializedRoot = explicitTargetMaterializedRoot
    ?? resolveConnectedServiceTargetMaterializedRoot({
      agentId: params.agentId,
      targetMaterializedEnv: materializedEnv,
    })
    ?? (materialized.cleanupOnFailure ? rootDir : null);
  try {
    await ensurePrivateConnectedServiceMaterializedRoot(attemptRoot);
    if (
      targetMaterializedRoot
      && resolve(targetMaterializedRoot) !== resolve(rootDir)
    ) {
      await ensurePrivateConnectedServiceMaterializedRoot(targetMaterializedRoot);
    }
  } catch (error) {
    cleanupAttemptRoot();
    forgetActiveAttemptIfCurrent(rootDir, attemptId);
    throw error;
  }

  try {
    await runSerializedPromotion(rootDir, async () => {
      assertActiveAttempt({ rootDir, attemptId, cleanupRoot: cleanupAttemptRoot });
      await replaceDirectoryAtomically({
        stagedDir: attemptRoot,
        targetDir: rootDir,
        afterPromote: () => {
          assertActiveAttempt({ rootDir, attemptId, cleanupRoot: cleanupAttemptRoot });
        },
      });
      assertActiveAttempt({ rootDir, attemptId, cleanupRoot: cleanupAttemptRoot });
    });
    assertActiveAttempt({ rootDir, attemptId, cleanupRoot: cleanupAttemptRoot });

    const cleanupFinalRoot = createBestEffortCleanupDirectory(rootDir);
    const cleanupOnFailure = materialized.cleanupOnFailure ? cleanupFinalRoot : materialized.cleanupOnFailure;
    const cleanupOnExit = materialized.cleanupOnExit ? cleanupFinalRoot : materialized.cleanupOnExit;
    if (
      !serializedSelections
      && !serializedMaterializedEnvKeys
      && !targetMaterializedRoot
      && !requestAuthMaterializedRoot
    ) {
      return {
        ...materialized,
        cleanupOnFailure,
        cleanupOnExit,
        env: materializedEnv,
      };
    }

    return {
      ...materialized,
      cleanupOnFailure,
      cleanupOnExit,
      requestAuthMaterializedRoot,
      env: {
        ...materializedEnv,
        ...(targetMaterializedRoot
          ? { [HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT_ENV_KEY]: targetMaterializedRoot }
          : null),
        ...(serializedSelections
          ? { [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: serializedSelections }
          : null),
        ...(serializedMaterializedEnvKeys
          ? { [HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_ENV_KEY]: serializedMaterializedEnvKeys }
          : null),
      },
    };
  } finally {
    forgetActiveAttemptIfCurrent(rootDir, attemptId);
  }
}
