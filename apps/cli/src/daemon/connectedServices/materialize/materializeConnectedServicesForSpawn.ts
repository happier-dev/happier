import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import {
  qualifiedPurposeKey,
  resolveConnectedServicesProviderStateSharingPolicyV1,
  type AccountSettings,
  type ConnectedAccountServiceKey,
  type ConnectedServiceCredentialRecordV1,
  type ConnectedServiceId,
  type QualifiedConnectedAccountPurposeBindingV1,
} from '@happier-dev/protocol';
import {
  resolveConnectedAccountRequestAuthCapabilityPath,
} from '@happier-dev/agents/request-auth';
import {
  CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV,
} from '@happier-dev/plugin-sdk/connected-accounts';

import type { CatalogAgentId } from '@/agent/catalog/ids';
import { resolveAgentContributionQualifiedId } from '@/plugins/projection/registry/agentRoutingIdentity';
import type { AgentSpawnQualifiedPurposeBindingSnapshot } from '@/daemon/connectedServices/requestAuth/prepareConnectedAccountRequestAuthForSpawn';
import { resolveQualifiedPurposeBindingSnapshotForAgentSpawn } from '@/daemon/connectedServices/requestAuth/prepareConnectedAccountRequestAuthForSpawn';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import {
  applyConnectedServiceStateSharingDescriptor,
  resolveConnectedServiceNativeHomeRoot,
} from '@/daemon/connectedServices/stateSharing/applyConnectedServiceStateSharingDescriptor';
import { materializeConnectedServiceNativeHomeCredentials } from '@/daemon/connectedServices/stateSharing/materializeConnectedServiceNativeHomeCredentials';
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
import { materializeQualifiedConnectedAccountLaunchUses } from './materializeQualifiedConnectedAccountLaunchUses';
import {
  createExactV021ConnectedServiceMaterializationOwner,
  isExactV021GeminiOauthLaunchProjection,
  materializeExactV021AgentLaunchProjection,
} from '../compatibility/exactV021ConnectedServiceMaterialization';

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

export async function runSerializedMaterializationPromotion<T>(
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

async function materializeQualifiedConnectedAccountLaunchForSpawn(params: Readonly<{
  agentId: CatalogAgentId;
  materializationKey: string;
  rootDir: string;
  sessionDirectory?: string | null;
  processEnv?: NodeJS.ProcessEnv;
  accountSettings?: AccountSettings | Readonly<Record<string, unknown>> | null;
  snapshot?: AgentSpawnQualifiedPurposeBindingSnapshot | null;
  requestAuthRequired: boolean;
  legacyV021?: boolean;
  recordsByServiceId: ReadonlyMap<ConnectedServiceId, ConnectedServiceCredentialRecordV1>;
  exactPurposeBindingSubjectId?: string;
  purposeBindingSessionId?: string;
}>): Promise<ConnectedServicesMaterialization> {
  const lease = await acquireAuthoritativePluginRuntimeRegistryLease();
  const signalController = new AbortController();
  const retainedCredentialFileCleanups: Array<() => void | Promise<void>> = [];
  let cleanupStarted = false;
  const cleanup = async (): Promise<void> => {
    if (cleanupStarted) return;
    cleanupStarted = true;
    signalController.abort();
    await Promise.allSettled(
      retainedCredentialFileCleanups.splice(0).map(async (dispose) => {
        await dispose();
      }),
    );
  };

  try {
    const snapshot = params.snapshot ?? (params.legacyV021
      ? resolveQualifiedPurposeBindingSnapshotForAgentSpawn({
          agentId: params.agentId,
          bindings: {
            v: 1,
            bindingsByServiceId: Object.fromEntries(
              [...params.recordsByServiceId].map(([serviceId, record]) => [
                serviceId,
                {
                  source: 'connected' as const,
                  selection: 'profile' as const,
                  profileId: record.profileId,
                },
              ]),
            ),
          },
          contributions: lease.registry.contributes,
        })
      : null);
    if (!snapshot && !params.legacyV021) {
      throw new Error('Connected Account launch declaration is unavailable');
    }
    const projectionOnlyGeminiOauth = params.legacyV021
      && [...params.recordsByServiceId.values()].some((record) =>
        isExactV021GeminiOauthLaunchProjection({
          agentId: params.agentId,
          record,
        }));
    const connectedAccountsOwner = params.legacyV021
      ? createExactV021ConnectedServiceMaterializationOwner({
          registry: lease.registry,
          purposeBindings: snapshot?.bindings ?? Object.freeze([]),
          recordsByServiceId: params.recordsByServiceId,
        })
      : lease.registry.resolveConnectedAccountPurposeBindingOwner?.();
    if (!connectedAccountsOwner) {
      throw new Error('Connected Account launch authority is unavailable');
    }
    const contribution = lease.registry.contributes.agentDefinitionsById.get(
      params.agentId,
    );
    const catalogEntry = lease.registry.acquireAgentCatalogEntry
      ? await lease.registry.acquireAgentCatalogEntry(params.agentId)
      : contribution?.catalogEntry ?? null;
    const identity = contribution?.identity;
    const currentGeneration = identity
      ? lease.registry.pluginFinalPolicyCurrentGenerationsById?.get(identity.pluginId)
      : null;
    const credentialFileOwner =
      lease.registry.resolveManagedServiceCredentialFileOwner?.();
    const expectedAccountsByPurposeKey = new Map(
      (snapshot?.bindings ?? []).flatMap((binding) => (
        binding.target.kind === 'account'
          ? [[qualifiedPurposeKey(binding.purpose), binding.target.account] as const]
          : []
      )),
    );
    const launchEnvironment = snapshot && !projectionOnlyGeminiOauth
      ? await materializeQualifiedConnectedAccountLaunchUses({
        connectedAccountsOwner,
        credentialFileOwner,
        snapshot,
        ...(params.exactPurposeBindingSubjectId
          ? { exactPurposeBindingSubjectId: params.exactPurposeBindingSubjectId }
          : {}),
        ...(params.purposeBindingSessionId
          ? { sessionId: params.purposeBindingSessionId }
          : {}),
        signal: signalController.signal,
        expectedAccountsByPurposeKey,
        ...(identity && currentGeneration
          ? {
              credentialFileScope: Object.freeze({
                generation: currentGeneration.immutableGenerationId,
                pluginId: identity.pluginId,
                contributionQualifiedId: resolveAgentContributionQualifiedId({
                  pluginId: identity.pluginId,
                  localId: identity.localId,
                }),
                operationId: params.materializationKey,
              }),
              retainCredentialFileCleanup(cleanupLease: Readonly<{
                dispose(): void | Promise<void>;
              }>) {
                retainedCredentialFileCleanups.push(() => cleanupLease.dispose());
              },
            }
          : {}),
      })
      : Object.freeze({});

    const env: Record<string, string> = { ...launchEnvironment };
    if (params.requestAuthRequired) {
      env[CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV] =
        resolveConnectedAccountRequestAuthCapabilityPath(params.rootDir);
    }
    const diagnostics: ConnectedServicesMaterializationDiagnostic[] = [];
    const stateSharingDescriptor =
      await catalogEntry?.getConnectedServiceStateSharingDescriptor?.() ?? null;
    if (
      stateSharingDescriptor?.providerSupportStatus === 'supported'
      && stateSharingDescriptor.nativeHome
    ) {
      const sourceEnvironment = Object.freeze(Object.fromEntries(
        Object.entries(params.processEnv ?? process.env).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      ));
      const policy = resolveConnectedServicesProviderStateSharingPolicyV1(
        (params.accountSettings as Readonly<Record<string, unknown>> | null | undefined)
          ?.connectedServicesProviderStateSharingSettingsV1,
        params.agentId,
      );
      const stateSharing = await applyConnectedServiceStateSharingDescriptor({
        descriptor: stateSharingDescriptor,
        nativeSourceContext: {
          sourceRoot: resolveConnectedServiceNativeHomeRoot({
            nativeHome: stateSharingDescriptor.nativeHome,
            sourceEnvironment,
            homeDir: homedir(),
          }),
          sourceEnv: sourceEnvironment,
        },
        target: {
          targetMaterializedRoot: params.rootDir,
          targetMaterializedEnv: env,
        },
        configMode: policy.configMode,
        requestedStateMode: policy.stateMode,
        effectiveStateMode: policy.stateMode,
        cwd: params.sessionDirectory ?? process.cwd(),
        providerLabel: params.agentId,
      });
      Object.assign(env, stateSharing.envOverrides, {
        [stateSharingDescriptor.nativeHome.environmentKey]: params.rootDir,
      });
      diagnostics.push(...stateSharing.diagnostics);

      const nativeHomeFiles: Record<string, Uint8Array> = Object.create(null);
      for (const scope of projectionOnlyGeminiOauth
        ? []
        : snapshot?.fileMaterializationPurposes ?? []) {
        if (!snapshot?.bindings.some((binding) => (
          qualifiedPurposeKey(binding.purpose) === qualifiedPurposeKey(scope.purpose)
        ))) continue;
        const binding = await connectedAccountsOwner.getBinding({
          purpose: scope.purpose,
          serviceRefs: scope.serviceRefs,
          ...(params.exactPurposeBindingSubjectId
            ? { exactPurposeBindingSubjectId: params.exactPurposeBindingSubjectId }
            : {}),
          ...(params.purposeBindingSessionId
            ? { sessionId: params.purposeBindingSessionId }
            : {}),
          signal: signalController.signal,
        });
        if (!binding) {
          throw new Error('Connected Account native-home binding is unavailable');
        }
        const materialization = await connectedAccountsOwner.materialize({
          purpose: scope.purpose,
          serviceRefs: scope.serviceRefs,
          ...(params.exactPurposeBindingSubjectId
            ? { exactPurposeBindingSubjectId: params.exactPurposeBindingSubjectId }
            : {}),
          ...(params.purposeBindingSessionId
            ? { sessionId: params.purposeBindingSessionId }
            : {}),
          expectedAccount:
            expectedAccountsByPurposeKey.get(qualifiedPurposeKey(scope.purpose))
            ?? binding.account,
          request: Object.freeze({
            kind: 'files' as const,
            fileIds: Object.freeze([
              ...stateSharingDescriptor.authIsolation.secretEntries,
            ]),
          }),
          signal: signalController.signal,
        });
        if (materialization.kind !== 'files') {
          throw new Error(
            'Connected Account native-home credential returned the wrong materialization kind',
          );
        }
        for (const [fileId, contents] of Object.entries(materialization.files)) {
          if (Object.prototype.hasOwnProperty.call(nativeHomeFiles, fileId)) {
            throw new Error(
              `Connected Account native-home credential '${fileId}' has multiple owners`,
            );
          }
          nativeHomeFiles[fileId] = contents;
        }
      }
      await materializeConnectedServiceNativeHomeCredentials({
        targetRoot: params.rootDir,
        declaredSecretEntries:
          stateSharingDescriptor.authIsolation.secretEntries,
        files: Object.freeze(nativeHomeFiles),
      });
    }

    if (params.legacyV021) {
      const legacyProjection = await materializeExactV021AgentLaunchProjection({
        agentId: params.agentId,
        rootDir: params.rootDir,
        recordsByServiceId: params.recordsByServiceId,
        signal: signalController.signal,
      });
      if (!legacyProjection) {
        throw new Error('Exact v0.2.1 Connected Service launch projection is unavailable');
      }
      Object.assign(env, legacyProjection.env);
    }

    return {
      env,
      targetMaterializedRoot: params.rootDir,
      requestAuthMaterializedRoot:
        params.requestAuthRequired ? params.rootDir : null,
      cleanupOnFailure: cleanup,
      cleanupOnExit: cleanup,
      diagnostics,
    };
  } catch (error) {
    await cleanup();
    throw error;
  } finally {
    await lease.release();
  }
}

export async function materializeConnectedServicesForSpawn(params: Readonly<{
  agentId: CatalogAgentId;
  materializationKey: string;
  activeServerDir: string;
  baseDir: string;
  sessionDirectory?: string | null;
  recordsByServiceId: ReadonlyMap<ConnectedServiceId, ConnectedServiceCredentialRecordV1>;
  selectionsByServiceId?: ReadonlyMap<ConnectedAccountServiceKey, ConnectedServiceResolvedSelection>;
  connectedAccountMaterializationAuthority: ConnectedServicesMaterializationAuthority;
  qualifiedPurposeBindingSnapshot?: AgentSpawnQualifiedPurposeBindingSnapshot | null;
  exactPurposeBindingSubjectId?: string;
  purposeBindingSessionId?: string;
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
  selectionsByServiceId?: ReadonlyMap<ConnectedAccountServiceKey, ConnectedServiceResolvedSelection>;
  connectedAccountMaterializationAuthority: ConnectedServicesMaterializationAuthority;
  qualifiedPurposeBindingSnapshot?: AgentSpawnQualifiedPurposeBindingSnapshot | null;
  exactPurposeBindingSubjectId?: string;
  purposeBindingSessionId?: string;
  accountSettings?: AccountSettings | Readonly<Record<string, unknown>> | null;
  processEnv?: NodeJS.ProcessEnv;
}>, rootDir: string): Promise<ConnectedServicesMaterialization | null> {
  const materializationSegment = basename(dirname(rootDir));
  const attemptRoot = join(params.baseDir, '.attempts', `${materializationSegment}-${params.agentId}-${randomUUID()}`);
  const attemptId = attemptRoot;
  activeMaterializationAttemptByRootDir.set(rootDir, attemptId);
  const cleanupAttemptRoot = createBestEffortCleanupDirectory(attemptRoot);
  // Attempt roots are pre-promotion staging: removal here is observed
  // best-effort and any residue is bounded by the attempt orphan sweep. The
  // promoted-root cleanup below is the custody surface that publishes an
  // awaited receipt.
  const dropAttemptRoot = (): void => {
    void cleanupAttemptRoot().catch(() => undefined);
  };

  const qualifiedAuthority =
    params.connectedAccountMaterializationAuthority.kind === 'qualified'
      ? params.connectedAccountMaterializationAuthority
      : null;
  const legacyV021Authority =
    params.connectedAccountMaterializationAuthority.kind === 'legacy_unfenced_one_shot';
  const qualifiedPurposeBindingSnapshot =
    params.qualifiedPurposeBindingSnapshot ?? null;
  const exactPurposeBindingSubjectId =
    params.exactPurposeBindingSubjectId ?? null;
  const purposeBindingSessionId = params.purposeBindingSessionId ?? null;
  if (
    qualifiedAuthority
    && qualifiedPurposeBindingSnapshot
    && !exactPurposeBindingSubjectId
    && !purposeBindingSessionId
  ) {
    dropAttemptRoot();
    forgetActiveAttemptIfCurrent(rootDir, attemptId);
    throw new Error('Connected Account exact launch authority is unavailable');
  }
  const materializer =
    qualifiedAuthority
    && qualifiedPurposeBindingSnapshot
    && (exactPurposeBindingSubjectId || purposeBindingSessionId)
    ? async () => await materializeQualifiedConnectedAccountLaunchForSpawn({
        ...params,
        rootDir: attemptRoot,
        snapshot: qualifiedPurposeBindingSnapshot,
        recordsByServiceId: params.recordsByServiceId,
        ...(exactPurposeBindingSubjectId
          ? { exactPurposeBindingSubjectId }
          : {}),
        ...(purposeBindingSessionId
          ? { purposeBindingSessionId }
          : {}),
        requestAuthRequired:
          qualifiedAuthority.requestAuthPurposeBindings.length > 0,
      })
    : legacyV021Authority
      ? async () => await materializeQualifiedConnectedAccountLaunchForSpawn({
          ...params,
          rootDir: attemptRoot,
          snapshot: qualifiedPurposeBindingSnapshot,
          recordsByServiceId: params.recordsByServiceId,
          requestAuthRequired: false,
          legacyV021: true,
        })
      : null;
  if (!materializer) {
    forgetActiveAttemptIfCurrent(rootDir, attemptId);
    return null;
  }

  let materialized: ConnectedServicesMaterialization | null;
  try {
    await ensurePrivateConnectedServiceMaterializedRoot(attemptRoot);
    materialized = await materializer();
  } catch (error) {
    dropAttemptRoot();
    forgetActiveAttemptIfCurrent(rootDir, attemptId);
    throw error;
  }
  if (!materialized) {
    dropAttemptRoot();
    forgetActiveAttemptIfCurrent(rootDir, attemptId);
    return null;
  }
  const cleanupMaterialized = async (): Promise<void> => {
    await (materialized?.cleanupOnFailure ?? materialized?.cleanupOnExit)?.();
  };
  const blockingDiagnostics = (materialized.diagnostics ?? [])
    .filter((diagnostic) => diagnostic.severity === 'blocking');
  if (blockingDiagnostics.length > 0) {
    await cleanupMaterialized();
    dropAttemptRoot();
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
    await cleanupMaterialized();
    dropAttemptRoot();
    forgetActiveAttemptIfCurrent(rootDir, attemptId);
    throw error;
  }

  try {
    await runSerializedMaterializationPromotion(rootDir, async () => {
      assertActiveAttempt({ rootDir, attemptId, cleanupRoot: dropAttemptRoot });
      await replaceDirectoryAtomically({
        stagedDir: attemptRoot,
        targetDir: rootDir,
        afterPromote: () => {
          assertActiveAttempt({ rootDir, attemptId, cleanupRoot: dropAttemptRoot });
        },
      });
      assertActiveAttempt({ rootDir, attemptId, cleanupRoot: dropAttemptRoot });
    });
    assertActiveAttempt({ rootDir, attemptId, cleanupRoot: dropAttemptRoot });

    const cleanupFinalRoot = createBestEffortCleanupDirectory(
      rootDir, undefined, { failureMode: 'reject' },
    );
    // The promoted root is custody: its cleanup receipt awaits real root
    // removal and surfaces a typed failure alongside the leaf credential
    // cleanup instead of detaching the removal and suppressing its outcome.
    const runPromotedRootCleanup = async (
      cleanupCredentials: (() => void | Promise<void>) | null | undefined,
    ): Promise<void> => {
      let rootRemovalError: unknown;
      const rootRemoval = cleanupFinalRoot().catch((error: unknown) => {
        rootRemovalError = error;
      });
      let credentialCleanupError: unknown;
      try {
        await cleanupCredentials?.();
      } catch (error) {
        credentialCleanupError = error;
      }
      await rootRemoval;
      const failures = [rootRemovalError, credentialCleanupError]
        .filter((error) => error !== undefined);
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(
          failures,
          'Connected-service materialized-root and credential cleanup failed',
        );
      }
    };
    const cleanupOnFailure = materialized.cleanupOnFailure
      ? async () => {
          await runPromotedRootCleanup(materialized.cleanupOnFailure);
        }
      : materialized.cleanupOnFailure;
    const cleanupOnExit = materialized.cleanupOnExit
      ? async () => {
          await runPromotedRootCleanup(materialized.cleanupOnExit);
        }
      : materialized.cleanupOnExit;
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
  } catch (error) {
    await cleanupMaterialized();
    dropAttemptRoot();
    throw error;
  } finally {
    forgetActiveAttemptIfCurrent(rootDir, attemptId);
  }
}
