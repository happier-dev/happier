import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';

import type {
  AccountSettings,
  ConnectedServiceCredentialRecordV1,
  ConnectedServiceCredentialRevisionV1,
  ConnectedServiceId,
  ConnectedServiceMaterializationIdentityV1,
} from '@happier-dev/protocol';

import type { CatalogAgentId } from '@/backends/types';
import { getConnectedServiceMaterializer } from '@/backends/catalog';
import { replaceDirectoryAtomically } from '@/utils/fs/replaceDirectoryAtomically';
import {
  HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_ENV_KEY,
  HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY,
  HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT_ENV_KEY,
  serializeConnectedServiceMaterializedEnvKeys,
  serializeConnectedServiceChildSelections,
} from '../connectedServiceChildEnvironment';
import type { ConnectedServicesMaterializeResult } from './providerMaterializerTypes';
import type { ConnectedServicesProviderMaterializerInput } from './providerMaterializerTypes';
import { resolveConnectedServiceMaterializedRootDir } from './resolveConnectedServiceMaterializedRootDir';
import { resolveConnectedServiceTargetMaterializedRoot } from './resolveConnectedServiceTargetMaterializedRoot';

export type ConnectedServiceResolvedSelection =
  | Readonly<{
      kind: 'profile';
      serviceId: ConnectedServiceId;
      profileId: string;
      credentialRevision?: ConnectedServiceCredentialRevisionV1 | null;
      record: ConnectedServiceCredentialRecordV1;
    }>
  | Readonly<{
      kind: 'group';
      serviceId: ConnectedServiceId;
      groupId: string;
      activeProfileId: string;
      fallbackProfileId: string;
      generation: number;
      credentialRevision?: ConnectedServiceCredentialRevisionV1 | null;
      record: ConnectedServiceCredentialRecordV1;
      policy: unknown;
    }>;

type ConnectedServiceMaterializationCredentialRefresh = (
  params: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
    record: ConnectedServiceCredentialRecordV1;
  }>,
) => Promise<
  | ConnectedServiceCredentialRecordV1
  | Readonly<{
      record: ConnectedServiceCredentialRecordV1;
      credentialRevision: ConnectedServiceCredentialRevisionV1 | null;
    }>
  | null
>;

const activeMaterializationAttemptByRootDir = new Map<string, string>();
const materializationWorkTailByRootDir = new Map<string, Promise<void>>();
const materializationPromotionTailByRootDir = new Map<string, Promise<void>>();

export class ConnectedServiceMaterializationSupersededError extends Error {
  readonly code = 'connected_service_materialization_superseded';

  constructor(rootDir: string) {
    super(`Connected-service materialization for ${rootDir} was superseded by a newer attempt`);
    this.name = 'ConnectedServiceMaterializationSupersededError';
  }
}

function bestEffortCleanupDirectory(path: string): () => void {
  let cleaned = false;
  return () => {
    if (cleaned) return;
    cleaned = true;
    void rm(path, { recursive: true, force: true }).catch(() => {});
  };
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

export async function runSerializedMaterializationForRoot<T>(
  rootDir: string,
  materialize: () => Promise<T>,
): Promise<T> {
  return await runSerializedOnRootTail(materializationWorkTailByRootDir, rootDir, materialize);
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

async function resolveFreshMaterializationRecords(params: Readonly<{
  recordsByServiceId: ReadonlyMap<ConnectedServiceId, ConnectedServiceCredentialRecordV1>;
  selectionsByServiceId?: ReadonlyMap<ConnectedServiceId, ConnectedServiceResolvedSelection>;
  refreshCredentialForMaterialization?: ConnectedServiceMaterializationCredentialRefresh | null;
}>): Promise<Readonly<{
  recordsByServiceId: ReadonlyMap<ConnectedServiceId, ConnectedServiceCredentialRecordV1>;
  selectionsByServiceId?: ReadonlyMap<ConnectedServiceId, ConnectedServiceResolvedSelection>;
}>> {
  if (!params.refreshCredentialForMaterialization) {
    return {
      recordsByServiceId: params.recordsByServiceId,
      ...(params.selectionsByServiceId ? { selectionsByServiceId: params.selectionsByServiceId } : {}),
    };
  }

  let recordsByServiceId: Map<ConnectedServiceId, ConnectedServiceCredentialRecordV1> | null = null;
  let selectionsByServiceId: Map<ConnectedServiceId, ConnectedServiceResolvedSelection> | null = null;
  for (const [serviceId, record] of params.recordsByServiceId) {
    if (
      record.kind !== 'oauth'
      || typeof record.expiresAt !== 'number'
      || !Number.isFinite(record.expiresAt)
    ) {
      continue;
    }
    const refreshResult = await params.refreshCredentialForMaterialization({
      serviceId,
      profileId: record.profileId,
      record,
    });
    const refreshed = refreshResult && 'record' in refreshResult
      ? refreshResult.record
      : refreshResult;
    if (!refreshed || refreshed === record) continue;
    if (refreshed.serviceId !== serviceId || refreshed.profileId !== record.profileId) {
      throw new Error(`Connected-service materialization refresh returned mismatched credential for ${serviceId}/${record.profileId}`);
    }
    recordsByServiceId ??= new Map(params.recordsByServiceId);
    recordsByServiceId.set(serviceId, refreshed);

    const selection = params.selectionsByServiceId?.get(serviceId);
    if (selection) {
      selectionsByServiceId ??= new Map(params.selectionsByServiceId);
      selectionsByServiceId.set(serviceId, {
        ...selection,
        record: refreshed,
        ...(refreshResult && 'record' in refreshResult
          ? { credentialRevision: refreshResult.credentialRevision }
          : {}),
      });
    }
  }

  return {
    recordsByServiceId: recordsByServiceId ?? params.recordsByServiceId,
    ...(params.selectionsByServiceId
      ? { selectionsByServiceId: selectionsByServiceId ?? params.selectionsByServiceId }
      : {}),
  };
}

export async function materializeConnectedServicesForSpawn(params: Readonly<{
  agentId: CatalogAgentId;
  materializationKey: string;
  connectedServiceMaterializationIdentityV1?: ConnectedServiceMaterializationIdentityV1 | null;
  activeServerDir: string;
  baseDir: string;
  sessionDirectory?: string | null;
  recordsByServiceId: ReadonlyMap<ConnectedServiceId, ConnectedServiceCredentialRecordV1>;
  selectionsByServiceId?: ReadonlyMap<ConnectedServiceId, ConnectedServiceResolvedSelection>;
  refreshCredentialForMaterialization?: ConnectedServiceMaterializationCredentialRefresh | null;
  accountSettings?: AccountSettings | Readonly<Record<string, unknown>> | null;
  processEnv?: NodeJS.ProcessEnv;
  vendorResumeId?: string | null;
  candidatePersistedSessionFile?: string | null;
  validateGroupMutationCurrentness?: ConnectedServicesProviderMaterializerInput['validateGroupMutationCurrentness'];
}>): Promise<(ConnectedServicesMaterializeResult & Readonly<{
  materializationRoot: string;
  cleanupMaterializationRoot: () => void;
}>) | null> {
  const rootDir = resolveConnectedServiceMaterializedRootDir({
    baseDir: params.baseDir,
    agentId: params.agentId,
    materializationKey: params.materializationKey,
    materializationIdentity: params.connectedServiceMaterializationIdentityV1 ?? null,
  });
  return await runSerializedMaterializationForRoot(rootDir, async () => {
  const freshMaterial = await resolveFreshMaterializationRecords({
    recordsByServiceId: params.recordsByServiceId,
    ...(params.selectionsByServiceId ? { selectionsByServiceId: params.selectionsByServiceId } : {}),
    refreshCredentialForMaterialization: params.refreshCredentialForMaterialization ?? null,
  });
  // `rootDir` is `<baseDir>/<segment>/<agentId>`; recover the segment for the sibling attempt dir.
  const materializationSegment = basename(dirname(rootDir));
  const attemptRoot = join(params.baseDir, '.attempts', `${materializationSegment}-${params.agentId}-${randomUUID()}`);
  const attemptId = attemptRoot;
  activeMaterializationAttemptByRootDir.set(rootDir, attemptId);
  const cleanupRoot = bestEffortCleanupDirectory(attemptRoot);

  const materializer = await getConnectedServiceMaterializer(params.agentId);
  if (!materializer) {
    forgetActiveAttemptIfCurrent(rootDir, attemptId);
    return null;
  }
  await mkdir(attemptRoot, { recursive: true });
  let materialized: ConnectedServicesMaterializeResult | null;
  try {
    materialized = await materializer({
      agentId: params.agentId,
      activeServerDir: params.activeServerDir,
      rootDir: attemptRoot,
      sessionDirectory: params.sessionDirectory ?? null,
      recordsByServiceId: freshMaterial.recordsByServiceId,
      selectionsByServiceId: freshMaterial.selectionsByServiceId,
      accountSettings: params.accountSettings ?? null,
      processEnv: params.processEnv ?? process.env,
      vendorResumeId: params.vendorResumeId ?? null,
      candidatePersistedSessionFile: params.candidatePersistedSessionFile ?? null,
      cleanupRoot,
      ...(params.validateGroupMutationCurrentness
        ? { validateGroupMutationCurrentness: params.validateGroupMutationCurrentness }
        : {}),
    });
  } catch (error) {
    cleanupRoot();
    forgetActiveAttemptIfCurrent(rootDir, attemptId);
    throw error;
  }
  if (!materialized) {
    cleanupRoot();
    forgetActiveAttemptIfCurrent(rootDir, attemptId);
    return null;
  }
  const materializedEnv = rewriteEnvRoot(materialized.env, attemptRoot, rootDir);
  const explicitTargetMaterializedRoot = typeof materialized.targetMaterializedRoot === 'string'
    && materialized.targetMaterializedRoot.trim().length > 0
    ? rewritePathRoot(materialized.targetMaterializedRoot, attemptRoot, rootDir)
    : null;
  const serializedSelections = serializeConnectedServiceChildSelections(freshMaterial.selectionsByServiceId);
  const serializedMaterializedEnvKeys = serializeConnectedServiceMaterializedEnvKeys(materializedEnv);
  const targetMaterializedRoot = explicitTargetMaterializedRoot ?? resolveConnectedServiceTargetMaterializedRoot({
    agentId: params.agentId,
    targetMaterializedEnv: materializedEnv,
  }) ?? (materialized.cleanupOnFailure ? rootDir : null);
  try {
    await runSerializedPromotion(rootDir, async () => {
      assertActiveAttempt({ rootDir, attemptId, cleanupRoot });
      await replaceDirectoryAtomically({
        stagedDir: attemptRoot,
        targetDir: rootDir,
        afterPromote: async () => {
          await materialized.afterPromote?.({
            env: materializedEnv,
            targetMaterializedRoot,
            finalRootDir: rootDir,
          });
          assertActiveAttempt({ rootDir, attemptId, cleanupRoot });
        },
      });
      assertActiveAttempt({ rootDir, attemptId, cleanupRoot });
    });
    assertActiveAttempt({ rootDir, attemptId, cleanupRoot });
    const cleanupFinalRoot = bestEffortCleanupDirectory(rootDir);
    const cleanupOnFailure = materialized.cleanupOnFailure ? cleanupFinalRoot : materialized.cleanupOnFailure;
    const cleanupOnExit = materialized.cleanupOnExit ? cleanupFinalRoot : materialized.cleanupOnExit;
    return {
      ...materialized,
      materializationRoot: rootDir,
      cleanupMaterializationRoot: cleanupFinalRoot,
      cleanupOnFailure,
      cleanupOnExit,
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
  });
}
