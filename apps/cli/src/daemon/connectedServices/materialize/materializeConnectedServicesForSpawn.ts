import { randomUUID } from 'node:crypto';
import type { AgentLaunchMaterializationTarget } from '@/daemon/agentIsolation/agentLaunchMaterials';
import type { AgentLaunchSelectedMaterial } from '@/daemon/agentIsolation/agentLaunchFrame';
import { lstat, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { qualifiedPurposeKey } from '@happier-dev/protocol/connect/connected-account-purpose-bindings';
import { sameQualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import { resolveConnectedServicesProviderStateSharingPolicyV1 } from '@happier-dev/protocol/account/settings/connected-services';
import { pluginSourceCustodyV1Equal } from '@happier-dev/protocol/plugins/runtime/sourceCustody';
import type { AccountSettings, ConnectedAccountServiceKey, ConnectedServiceCredentialRecordV1, ConnectedServiceId, QualifiedConnectedAccountPurposeBindingV1, RuntimeDescriptorV1 } from '@happier-dev/protocol';
import {
  resolveConnectedAccountRequestAuthCapabilityPath,
} from '@happier-dev/agents/request-auth';
import {
  CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV,
} from '@happier-dev/plugin-sdk/connected-accounts';
import type { AgentSessionConnectedAccountSelection } from '@happier-dev/plugin-sdk/agents/runtime';

import type { CatalogAgentId } from '@/agent/catalog/ids';
import { logger } from '@/utils/logger';
import { readRetainedExecutionRunRecords } from '@/daemon/executionRunRegistry';
import type { RequesterWorkAttributionV1 } from '@/daemon/lifecycle/requesterWorkAttribution';
import { readRequesterHomeWithinActionLifetime } from '@/daemon/sessionEncryption/requesterCurrentness';
import { resolveAgentContributionQualifiedId } from '@/plugins/projection/registry/agentRoutingIdentity';
import type { AgentSpawnQualifiedPurposeBindingSnapshot } from '@/daemon/connectedServices/requestAuth/prepareConnectedAccountRequestAuthForSpawn';
import { resolveQualifiedPurposeBindingSnapshotForAgentSpawn } from '@/daemon/connectedServices/requestAuth/prepareConnectedAccountRequestAuthForSpawn';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import type { StablePluginConnectedAccountsOwner } from '@/plugins/runtime/invocation/services/connectedAccounts';
import {
  applyConnectedServiceStateSharingDescriptor,
  resolveConnectedServiceNativeHomeRoot,
} from '@/daemon/connectedServices/stateSharing/applyConnectedServiceStateSharingDescriptor';
import { materializeConnectedServiceNativeHomeCredentials, readConnectedServiceNativeHomeCredentialFiles } from '@/daemon/connectedServices/stateSharing/materializeConnectedServiceNativeHomeCredentials';
import type {
  ConnectedServiceResolvedSelection,
  ConnectedServiceMaterializedStateObservationBinding,
  ConnectedServicesMaterializationAuthority,
  ConnectedServicesMaterialization,
  ConnectedServicesMaterializationDiagnostic,
} from '@/daemon/connectedServices/materialization/materializer';
import { createBestEffortCleanupDirectory } from '@/daemon/connectedServices/materialization/materializer';
import { isConnectedServiceMaterializedHomeRetainedOnExit } from './cleanup/createConnectedServiceMaterializedHomeCleanupScheduler';
import { copyConnectedServiceHomeEntry } from '../stateSharing/connectedServiceHomeEntrySync';
import { readConnectedServiceStateSharingManifest, writeConnectedServiceStateSharingManifest } from '../stateSharing/connectedServiceStateSharingManifest';
import { importConnectedServiceSessionFiles, type ConnectedServiceSessionFileImportRoot } from '../stateSharing/importConnectedServiceSessionFiles';
import { verifyResumeReachableThroughCatalog } from '../catalogHooks';
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
import { resolveConnectedServiceNativeHomeTarget } from './resolveConnectedServiceNativeHomeTarget';
import { observeConnectedServiceMaterializationPhase, startConnectedServiceMaterializationPhase } from './materializationPhase';
import { ensurePrivateConnectedServiceMaterializedRoot, isCanonicalConnectedServiceMaterializedRoot } from './privateMaterializedRoot';
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
 * Single owner of per-root tail serialization (used for both materialization work and staged
 * promotion). A live predecessor retains exclusive write custody until it settles. Queue wait
 * time is not an authority refusal and cannot release another writer onto that same root.
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
    await previousTail.catch(() => {});
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

type MaterializationArtifactWrite = <T>(write: () => Promise<T>) => Promise<T>;

async function materializeQualifiedConnectedAccountLaunchForSpawn(params: Readonly<{
  agentLaunchTarget?: AgentLaunchMaterializationTarget;
  signal?: AbortSignal;
  retainCleanup?: (cleanup: () => Promise<void>) => Promise<() => void>;
  agentId: CatalogAgentId;
  materializationKey: string;
  requesterWorkAttributionV1?: RequesterWorkAttributionV1;
  activeServerDir: string;
  rootDir: string;
  probePurpose?: 'probe';
  runtimeDescriptorV1?: RuntimeDescriptorV1;
  vendorResumeId?: string | null;
  candidatePersistedSessionFile?: string | null;
  previousMaterializedRoot?: string | null;
  sessionDirectory?: string | null;
  processEnv?: NodeJS.ProcessEnv;
  allowNativeAccountState?: boolean;
  connectedAccountsOwner?: Parameters<typeof materializeQualifiedConnectedAccountLaunchUses>[0]['connectedAccountsOwner'];
  isAccountRuntimeCurrent?: () => Promise<boolean>;
  accountSettings?: AccountSettings | Readonly<Record<string, unknown>> | null;
  snapshot?: AgentSpawnQualifiedPurposeBindingSnapshot | null;
  requestAuthRequired: boolean;
  legacyV021?: boolean;
  nativeHomeOnly?: boolean;
  recordsByServiceId: ReadonlyMap<ConnectedServiceId, ConnectedServiceCredentialRecordV1>;
  exactPurposeBindingSubjectId?: string;
  purposeBindingSessionId?: string;
  writeArtifacts?: MaterializationArtifactWrite;
  waitForArtifactWrite?: () => Promise<void>;
}>): Promise<ConnectedServicesMaterialization> {
  const lease = await observeConnectedServiceMaterializationPhase(params, 'plugin_registry',
    () => acquireAuthoritativePluginRuntimeRegistryLease());
  const signalController = new AbortController();
  const abort = () => signalController.abort(params.signal?.reason);
  params.signal?.addEventListener('abort', abort, { once: true });
  if (params.signal?.aborted) abort();
  const writeArtifacts: MaterializationArtifactWrite = params.writeArtifacts ?? (async write => await write());
  const retainedCredentialFileCleanups: Array<() => void | Promise<void>> = [];
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = (): Promise<void> => cleanupPromise ??= (async () => {
    signalController.abort();
    params.signal?.removeEventListener('abort', abort);
    // File leases must outlive an already-started host write, which may still
    // be creating their protected parent. Never wait for credential transport.
    const failures: unknown[] = [];
    try { await params.waitForArtifactWrite?.(); } catch (error) { failures.push(error); }
    const results = await Promise.allSettled(retainedCredentialFileCleanups.splice(0).map(async dispose => await dispose()));
    failures.push(...results.flatMap(result => result.status === 'rejected' ? [result.reason] : []));
    // A cancelled credential transport may never settle to reach finally.
    // Release this same idempotent lease after its known host resources close.
    try { await lease.release(); } catch (error) { failures.push(error); }
    if (failures.length > 0) throw new AggregateError(failures, 'Connected Account materialization cleanup failed');
  })();

  try {
    if (params.retainCleanup) await params.retainCleanup(cleanup);
    signalController.signal.throwIfAborted();
    const contribution = lease.registry.contributes.agentDefinitionsById.get(
      params.agentId,
    );
    const catalogEntry = lease.registry.acquireAgentCatalogEntry
      ? await lease.registry.acquireAgentCatalogEntry(params.agentId)
      : contribution?.catalogEntry ?? null;
    const snapshot = params.snapshot ?? (params.legacyV021
      ? resolveQualifiedPurposeBindingSnapshotForAgentSpawn({
          agentId: params.agentId,
          bindings: {
            v: 2,
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
          catalogEntry,
        })
      : null);
    if (!snapshot && !params.legacyV021 && !params.nativeHomeOnly) {
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
      : params.connectedAccountsOwner ?? lease.registry.resolveConnectedAccountPurposeBindingOwner?.();
    if (!connectedAccountsOwner && !params.nativeHomeOnly) {
      throw new Error('Connected Account launch authority is unavailable');
    }
    const materializedAccountsByPurposeKey = new Map<string, AgentSessionConnectedAccountSelection>();
    const materializeAccount: StablePluginConnectedAccountsOwner['materialize'] = async input => {
      if (!connectedAccountsOwner) throw new Error('Connected Account launch authority is unavailable');
      const materialization = await connectedAccountsOwner.materialize(input);
      // The purpose owner verifies this exact Account before and after producing
      // credentials. A declared target or a native home alone is not such proof.
      if (!params.legacyV021 && input.expectedAccount) {
        materializedAccountsByPurposeKey.set(qualifiedPurposeKey(input.purpose), Object.freeze({
          purpose: input.purpose.purpose,
          ...(materialization.usageAccountScope === undefined ? {} : { usageAccountScope: materialization.usageAccountScope }),
          account: Object.freeze({ service: Object.freeze({ ...input.expectedAccount.service }),
            accountId: input.expectedAccount.accountId }),
        }));
      }
      return materialization;
    };
    const identity = contribution?.identity;
    const currentRuntime = identity
      ? lease.registry.pluginFinalPolicyCurrentRuntimesById?.get(identity.pluginId)
      : null;
    const credentialFileOwner =
      lease.registry.resolveManagedServiceCredentialFileOwner?.();
    const stateSharingDescriptor =
      await catalogEntry?.getConnectedServiceStateSharingDescriptor?.() ?? null;
    const expectedAccountsByPurposeKey = new Map(
      (snapshot?.bindings ?? []).flatMap((binding) => (
        binding.target.kind === 'account'
          ? [[qualifiedPurposeKey(binding.purpose), binding.target.account] as const]
          : []
      )),
    );
    if (!projectionOnlyGeminiOauth && stateSharingDescriptor?.providerSupportStatus === 'supported'
      && stateSharingDescriptor.nativeHome) {
      const capturedPurposes = new Set<string>();
      for (const scope of snapshot?.fileMaterializationPurposes ?? []) {
        const purposeKey = qualifiedPurposeKey(scope.purpose);
        if (capturedPurposes.has(purposeKey) || !snapshot?.bindings.some(binding =>
          qualifiedPurposeKey(binding.purpose) === purposeKey)) continue;
        if (!connectedAccountsOwner) throw new Error('Connected Account launch authority is unavailable');
        const binding = await observeConnectedServiceMaterializationPhase(params, 'binding_read', () => readRequesterHomeWithinActionLifetime(() => connectedAccountsOwner.getBinding({
          purpose: scope.purpose,
          serviceRefs: scope.serviceRefs,
          requireSelected: true,
          ...(params.exactPurposeBindingSubjectId
            ? { exactPurposeBindingSubjectId: params.exactPurposeBindingSubjectId } : {}),
          ...(params.purposeBindingSessionId ? { sessionId: params.purposeBindingSessionId } : {}),
          signal: signalController.signal,
        }), params.signal));
        signalController.signal.throwIfAborted();
        if (!binding) {
          const error = new Error('Connected Account native-home binding is unavailable');
          logger.infoFile('[CONNECTED ACCOUNT] Native-home binding rejected', {
            phase: 'binding_read', agentId: params.agentId, purposeKey,
            sessionId: params.purposeBindingSessionId,
            materializationKey: params.materializationKey, error,
          });
          throw error;
        }
        const expected = expectedAccountsByPurposeKey.get(purposeKey);
        if (expected && !sameQualifiedConnectedAccountRef(expected, binding.account)) {
          throw new Error('Connected Account native-home binding changed');
        }
        expectedAccountsByPurposeKey.set(purposeKey, Object.freeze({
          service: Object.freeze({ ...binding.account.service }), accountId: binding.account.accountId,
        }));
        capturedPurposes.add(purposeKey);
      }
    }
    const launchEnvironment: Awaited<ReturnType<typeof materializeQualifiedConnectedAccountLaunchUses>> = snapshot && connectedAccountsOwner && !projectionOnlyGeminiOauth
      ? await observeConnectedServiceMaterializationPhase(params, 'launch_credentials', () => materializeQualifiedConnectedAccountLaunchUses({
        connectedAccountsOwner: {
          getBinding: input => connectedAccountsOwner.getBinding(input),
          materialize: materializeAccount,
        },
        credentialFileOwner,
        snapshot,
        ...(params.exactPurposeBindingSubjectId
          ? { exactPurposeBindingSubjectId: params.exactPurposeBindingSubjectId }
          : {}),
        ...(params.purposeBindingSessionId
          ? { sessionId: params.purposeBindingSessionId }
          : {}),
        signal: signalController.signal,
        agentLaunchTarget: params.agentLaunchTarget,
        writeArtifacts,
        expectedAccountsByPurposeKey,
        ...(identity && currentRuntime
          ? {
              credentialFileScope: Object.freeze({
                occurrenceId: currentRuntime.occurrenceId,
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
      }))
      : Object.freeze({ env: Object.freeze({}), unsetEnvKeys: Object.freeze([]) });

    signalController.signal.throwIfAborted();
    const env: Record<string, string> = { ...launchEnvironment.env };
    const agentSelectedMaterials: AgentLaunchSelectedMaterial[] = [
      ...(launchEnvironment.agentLaunchMaterials?.selectedMaterials ?? []),
    ];
    const agentEnvironment: Record<string, string> = { ...(launchEnvironment.agentLaunchMaterials?.environment ?? {}) };
    if (params.requestAuthRequired) {
      env[CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV] =
        resolveConnectedAccountRequestAuthCapabilityPath(params.rootDir);
    }
    const diagnostics: ConnectedServicesMaterializationDiagnostic[] = [];
    let materializedStateObservationBinding: ConnectedServiceMaterializedStateObservationBinding | undefined;
    const mergeSharedStateFile = await catalogEntry?.getConnectedServiceSharedStateFileMerge?.() ?? undefined;
    let targetMaterializedRoot = params.rootDir;
    const nativeHome = stateSharingDescriptor?.nativeHome;
    if (params.nativeHomeOnly && (!stateSharingDescriptor?.nativeHome
      || stateSharingDescriptor.providerSupportStatus !== 'supported')) {
      throw new Error('agent_native_home_unavailable');
    }
    if (
      stateSharingDescriptor?.providerSupportStatus === 'supported'
      && nativeHome
    ) {
      const homesRoot = join(params.activeServerDir, 'daemon', 'connected-services', 'homes');
      const homesRootIsOwned = await isCanonicalConnectedServiceMaterializedRoot({
        baseDir: params.activeServerDir, rootDir: homesRoot, allowMissing: true,
      });
      const durableTarget = resolveConnectedServiceNativeHomeTarget({
        agentId: params.agentId, activeServerDir: params.activeServerDir,
        nativeHome, snapshot, expectedAccountsByPurposeKey, probePurpose: params.probePurpose,
      });
      if (durableTarget) {
        targetMaterializedRoot = durableTarget;
        if (!homesRootIsOwned || !await isCanonicalConnectedServiceMaterializedRoot({
          baseDir: homesRoot, rootDir: targetMaterializedRoot, allowMissing: true,
        })) throw new Error('connected_service_materialization_root_unsafe');
      }
      const nativeRoot = targetMaterializedRoot;
      const durableNativeHome = nativeRoot !== params.rootDir;
      const prepareNativeHome = async () => {
        signalController.signal.throwIfAborted();
        const allowNativeState = params.allowNativeAccountState !== false;
        const sourceEnvironment = Object.freeze(Object.fromEntries(
          Object.entries(allowNativeState ? params.processEnv ?? process.env : {}).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string',
          ),
        ));
        const policy = resolveConnectedServicesProviderStateSharingPolicyV1(
          (params.accountSettings as Readonly<Record<string, unknown>> | null | undefined)
            ?.connectedServicesProviderStateSharingSettingsV1,
          params.agentId,
        );
        if (!allowNativeState && !params.previousMaterializedRoot) {
          throw new Error('Requester materialized home identity unavailable');
        }
        const existingManifest = durableNativeHome
          ? await readConnectedServiceStateSharingManifest(nativeRoot) : undefined;
        const sourceRoots = new Set<string>();
        if (params.probePurpose !== 'probe') {
          if (params.previousMaterializedRoot) sourceRoots.add(params.previousMaterializedRoot);
          if (durableNativeHome) sourceRoots.add(nativeRoot);
          const priorHomeDeclaration = nativeHome.runtimeDescriptorHome;
          const runtimeDescriptor = params.runtimeDescriptorV1;
          if (priorHomeDeclaration && runtimeDescriptor?.agentId === params.agentId
            && runtimeDescriptor.agent[priorHomeDeclaration.scopeField] === priorHomeDeclaration.scopeValue) {
            const previousHome = runtimeDescriptor.agent[priorHomeDeclaration.pathField];
            if (homesRootIsOwned && typeof previousHome === 'string' && isAbsolute(previousHome)
              && await isCanonicalConnectedServiceMaterializedRoot({ baseDir: homesRoot, rootDir: previousHome })) {
              sourceRoots.add(previousHome);
            }
          }
        }
        const nativeSourceRoot = allowNativeState ? resolveConnectedServiceNativeHomeRoot({
          nativeHome, sourceEnvironment, homeDir: homedir(),
        }) : params.previousMaterializedRoot!;
        const effectiveStateMode = allowNativeState && params.probePurpose !== 'probe' ? policy.stateMode : 'isolated';
        const privateStatePaths = stateSharingDescriptor.state.entries.map(entry => entry.path);
        const isolatedImportRoots: ConnectedServiceSessionFileImportRoot[] | null =
          durableNativeHome && effectiveStateMode !== 'shared' ? [] : null;
        if (isolatedImportRoots) {
          const resumeIds = new Set(params.vendorResumeId ? [params.vendorResumeId] : []);
          const borrowedEntries = await Promise.all(stateSharingDescriptor.state.entries.map(async entry => {
            try { return (await lstat(join(nativeRoot, entry.path))).isSymbolicLink(); }
            catch (error) { if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return false; throw error; }
          }));
          if (borrowedEntries.some(Boolean)) {
            let complete = true;
            const records = await readRetainedExecutionRunRecords(() => { complete = false; });
            // Unknown retained custody cannot authorize detaching its source.
            if (!complete) throw new Error('retained_conversation_inventory_unavailable');
            const retained = records.find(record => record.state.runId === params.materializationKey);
            // The home transition owns preservation for every caller, including
            // an ordinary Session with no Run at its materialization key.
            const owner = params.requesterWorkAttributionV1 ?? retained?.requesterWorkAttributionV1;
            const sessionId = params.purposeBindingSessionId ?? retained?.state.sessionId;
            for (const record of records) {
              if (record.state.retentionPolicy !== 'resumable' || record.state.backendId !== params.agentId
                || record.state.resumeHandle?.kind !== 'provider_session.v1') continue;
              const candidateOwner = record.requesterWorkAttributionV1;
              const sameAccount = Boolean(owner && candidateOwner
                && owner.serverId === candidateOwner.serverId && owner.accountId === candidateOwner.accountId);
              const sameSession = Boolean(sessionId && record.state.sessionId === sessionId);
              if (owner && ((!sameSession && !sameAccount) || (candidateOwner && !sameAccount))) continue;
              const bindings = record.state.launch?.connectedServicesSelection;
              if (bindings) {
                const retainedSnapshot = resolveQualifiedPurposeBindingSnapshotForAgentSpawn({
                  agentId: params.agentId, bindings, contributions: lease.registry.contributes, catalogEntry,
                });
                if (resolveConnectedServiceNativeHomeTarget({
                  agentId: params.agentId, activeServerDir: params.activeServerDir, nativeHome,
                  snapshot: retainedSnapshot, expectedAccountsByPurposeKey,
                }) !== nativeRoot) continue;
              } else if (!sameSession) continue;
              // Without this home's requester identity, do not sever a link
              // that may still be the only reachable state of a retained Run.
              if (!owner && !sameSession) throw new Error('retained_conversation_owner_unavailable');
              resumeIds.add(record.state.resumeHandle.providerSessionId);
            }
          }
          const selectedFilesByRoot = new Map<string, Set<string>>();
          for (const sourceRoot of sourceRoots) {
            const accountHome = homesRootIsOwned && await isCanonicalConnectedServiceMaterializedRoot({
              baseDir: homesRoot, rootDir: sourceRoot,
            });
            if (accountHome) {
              // Preserve this home's retained conversations before detaching a
              // borrowed store. An exact sealed identity never grants a whole-store import.
              for (const vendorResumeId of resumeIds) {
                const resumed = await verifyResumeReachableThroughCatalog(params.agentId, {
                  targetMaterializedRoot: sourceRoot,
                  vendorResumeId,
                  ...(vendorResumeId === params.vendorResumeId
                    ? { candidatePersistedSessionFile: params.candidatePersistedSessionFile } : {}),
                  ...(params.runtimeDescriptorV1 ? { runtimeDescriptorV1: params.runtimeDescriptorV1 } : {}),
                });
                if (!resumed?.ok) continue;
                for (const entry of stateSharingDescriptor.state.entries) {
                  const declaredRoot = await realpath(join(sourceRoot, entry.path)).catch(() => null);
                  if (!declaredRoot) continue;
                  const resumedPath = relative(declaredRoot, resumed.resolvedPath);
                  if (!resumedPath || resumedPath.startsWith('..') || isAbsolute(resumedPath)) continue;
                  const normalizedPath = resumedPath.split(sep).join('/');
                  const rootKey = JSON.stringify([declaredRoot, entry.path]);
                  const selectedFiles = selectedFilesByRoot.get(rootKey);
                  if (selectedFiles) { selectedFiles.add(normalizedPath); break; }
                  const files = new Set([normalizedPath]);
                  selectedFilesByRoot.set(rootKey, files);
                  isolatedImportRoots.push({
                    sourceRoot: declaredRoot, destinationRoot: join(nativeRoot, entry.path),
                    includePaths: files,
                    ...(mergeSharedStateFile ? { mergeSharedStateFile: file => mergeSharedStateFile({
                      ...file, entryPath: `${entry.path}/${file.entryPath}`,
                    }) } : {}),
                  });
                  break;
                }
              }
            } else {
              // A legacy Run home belongs to this session, so retain its declared private state.
              isolatedImportRoots.push({ sourceRoot, destinationRoot: nativeRoot, includePaths: privateStatePaths,
                mergeSharedStateFile });
            }
          }
        }
        // Catalog reachability is read preparation, not an artifact write.
        // Cancellation cleanup must not wait for a plugin/catalog lookup.
        return async () => {
          signalController.signal.throwIfAborted();
          await observeConnectedServiceMaterializationPhase(params, 'native_home_prepare',
            () => ensurePrivateConnectedServiceMaterializedRoot(nativeRoot));
          signalController.signal.throwIfAborted();
          const stateSharing = await observeConnectedServiceMaterializationPhase(params, 'native_home_state', () => applyConnectedServiceStateSharingDescriptor({
            signal: signalController.signal,
            descriptor: stateSharingDescriptor,
            nativeSourceContext: {
              // Foreign requester materialization has no authority over the
              // custodian's native home. Only its already-owned target is reachable.
              sourceRoot: nativeSourceRoot,
              sourceEnv: sourceEnvironment,
            },
            target: {
              targetMaterializedRoot: nativeRoot,
              targetMaterializedEnv: env,
            },
            previousMaterializedRoot: durableNativeHome ? nativeRoot : params.previousMaterializedRoot ?? null,
            existingManifest,
            configMode: allowNativeState ? policy.configMode : 'isolated',
            requestedStateMode: params.probePurpose === 'probe' ? 'isolated' : policy.stateMode,
            effectiveStateMode,
            sessionImportRoots: durableNativeHome && effectiveStateMode === 'shared'
              ? [...sourceRoots].map(sourceRoot => ({
                  sourceRoot, destinationRoot: nativeSourceRoot, includePaths: privateStatePaths,
                })) : undefined,
            mergeSharedStateFile,
            cwd: params.sessionDirectory ?? process.cwd(),
            providerLabel: params.agentId,
          }));
          Object.assign(env, stateSharing.envOverrides, {
            [nativeHome.environmentKey]: nativeRoot,
          });
          diagnostics.push(...stateSharing.diagnostics);
          if (identity && currentRuntime && stateSharing.linkedStateEntries.length > 0) {
            const nativeHomeRoot = await realpath(nativeRoot);
            materializedStateObservationBinding = {
              agentId: params.agentId,
              pluginId: identity.pluginId,
              sourceCustody: currentRuntime.sourceCustody,
              nativeHomeRoot,
              entries: stateSharing.linkedStateEntries.map(entry => ({
                ...entry, materializedEntryPath: join(nativeHomeRoot, entry.entryPath),
              })),
            };
          }

          if (isolatedImportRoots) {
            signalController.signal.throwIfAborted();
            await observeConnectedServiceMaterializationPhase(params, 'native_home_import', () => importConnectedServiceSessionFiles({
              roots: isolatedImportRoots,
            }));
          } else if (params.previousMaterializedRoot && params.probePurpose !== 'probe') {
            signalController.signal.throwIfAborted();
            await observeConnectedServiceMaterializationPhase(params, 'native_home_import', async () => {
              for (const entry of stateSharingDescriptor.state.entries) {
                // The descriptor result owns which entries are managed in the new home.
                // A linked entry with no native source remains local, just like isolated state.
                if (stateSharing.manifest.stateEntries.includes(entry.path)) continue;
                const source = join(params.previousMaterializedRoot!, entry.path);
                const sourceStat = await lstat(source).catch((error: unknown) => {
                  if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
                  throw error;
                });
                // Carry this Run's private state through credential replacement.
                // Shared native-account links remain owned by their original home.
                if (sourceStat && !sourceStat.isSymbolicLink()) {
                  await copyConnectedServiceHomeEntry(source, join(nativeRoot, entry.path), { localStateOnly: true });
                }
              }
            });
          }
          signalController.signal.throwIfAborted();
          await observeConnectedServiceMaterializationPhase(params, 'native_home_manifest',
            () => writeConnectedServiceStateSharingManifest(nativeRoot, stateSharing.manifest));
        };
      };

      const materializeNativeHome = async () => {
        // Prepare this serialized home as one filesystem effect. Each helper
        // already writes multiple files; repeated Home verification between
        // those dependent substeps adds network latency while holding the home
        // queue. Credentials and promotion keep their separate fresh fences.
        const applyNativeHome = await prepareNativeHome();
        await writeArtifacts(applyNativeHome);

        const nativeHomeFiles: Record<string, Uint8Array> = Object.create(null);
        for (const scope of projectionOnlyGeminiOauth
          ? []
          : snapshot?.fileMaterializationPurposes ?? []) {
          if (!snapshot?.bindings.some((binding) => (
            qualifiedPurposeKey(binding.purpose) === qualifiedPurposeKey(scope.purpose)
          ))) continue;
          if (!connectedAccountsOwner) throw new Error('Connected Account launch authority is unavailable');
          const expectedAccount = expectedAccountsByPurposeKey.get(qualifiedPurposeKey(scope.purpose));
          if (!expectedAccount) {
            const error = new Error('Connected Account native-home binding is unavailable');
            logger.infoFile('[CONNECTED ACCOUNT] Native-home binding rejected', {
              phase: 'expected_account', agentId: params.agentId,
              purposeKey: qualifiedPurposeKey(scope.purpose),
              sessionId: params.purposeBindingSessionId,
              materializationKey: params.materializationKey, error,
            });
            throw error;
          }
          const materialization = await observeConnectedServiceMaterializationPhase({
            agentId: params.agentId, materializationKey: params.materializationKey,
            service: expectedAccount.service,
          }, 'native_home_credentials', async () => materializeAccount({
            purpose: scope.purpose,
            serviceRefs: scope.serviceRefs,
            ...(params.exactPurposeBindingSubjectId
              ? { exactPurposeBindingSubjectId: params.exactPurposeBindingSubjectId }
              : {}),
            ...(params.purposeBindingSessionId
              ? { sessionId: params.purposeBindingSessionId }
              : {}),
            expectedAccount,
            existingFiles: await readConnectedServiceNativeHomeCredentialFiles({
              targetRoot: nativeRoot,
              declaredSecretEntries: stateSharingDescriptor.authIsolation.secretEntries,
            }),
            request: Object.freeze({
              kind: 'files' as const,
              fileIds: Object.freeze([
                ...stateSharingDescriptor.authIsolation.secretEntries,
              ]),
            }),
            signal: signalController.signal,
          }));
          signalController.signal.throwIfAborted();
          if (materialization.kind !== 'files') {
            throw new Error(
              'Connected Account native-home credential returned the wrong materialization kind',
            );
          }
          if (!Object.entries(materialization.files).some(([fileId, contents]) =>
            stateSharingDescriptor.authIsolation.secretEntries.includes(fileId) && contents.byteLength > 0)) {
            throw new Error('Connected Account native-home credential file is unavailable');
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
        await observeConnectedServiceMaterializationPhase(params, 'native_home_credential_write', () => writeArtifacts(() => materializeConnectedServiceNativeHomeCredentials({
          targetRoot: nativeRoot,
          declaredSecretEntries:
            stateSharingDescriptor.authIsolation.secretEntries,
          files: Object.freeze(nativeHomeFiles),
        })));
        if (params.agentLaunchTarget) {
          const agentNativeHome = join(params.agentLaunchTarget.runtimeHome, 'native-home');
          Object.assign(agentEnvironment, rewriteEnvRoot(env, nativeRoot, agentNativeHome), {
            [nativeHome.environmentKey]: agentNativeHome,
          });
          // File-environment values keep their selected Agent paths when native
          // environment projection adds its separately owned home.
          Object.assign(agentEnvironment, launchEnvironment.agentLaunchMaterials?.environment);
          agentSelectedMaterials.push(...Object.entries(nativeHomeFiles).map(([fileId, contents]) => Object.freeze({
            relativePath: `native-home/${fileId}`, contentBase64: Buffer.from(contents).toString('base64'),
          })));
        }
      };
      if (durableNativeHome) {
        const entered = startConnectedServiceMaterializationPhase(params, 'native_home_queue');
        await runSerializedMaterialization(nativeRoot, async () => {
          entered('completed');
          return await materializeNativeHome();
        });
      } else await materializeNativeHome();
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

    const sourceCustody = identity ? lease.registry.readPluginSourceCustody?.(identity.pluginId) : null;
    const bindingIsCurrent = identity && currentRuntime && sourceCustody
      && lease.registry.isPluginOccurrenceCurrent?.(identity.pluginId, currentRuntime.occurrenceId) === true
      && pluginSourceCustodyV1Equal(currentRuntime.sourceCustody, sourceCustody);
    return {
      env,
      ...(params.agentLaunchTarget ? { agentLaunchMaterials: Object.freeze({
        runtimeHome: params.agentLaunchTarget.runtimeHome,
        ...(params.agentLaunchTarget.memberIdentity ? { memberIdentity: params.agentLaunchTarget.memberIdentity } : {}),
        environment: Object.freeze(Object.fromEntries(Object.entries(agentEnvironment)
          .filter(([key]) => !key.startsWith('HAPPIER_')))),
        selectedMaterials: Object.freeze(agentSelectedMaterials),
      }) } : {}),
      ...(materializedAccountsByPurposeKey.size > 0
        ? { sessionConnectedAccounts: Object.freeze([...materializedAccountsByPurposeKey.values()]) }
        : {}),
      ...(launchEnvironment.unsetEnvKeys.length > 0 ? { unsetEnvKeys: launchEnvironment.unsetEnvKeys } : {}),
      targetMaterializedRoot,
      requestAuthMaterializedRoot:
        params.requestAuthRequired ? params.rootDir : null,
      ...(bindingIsCurrent && materializedStateObservationBinding ? { materializedStateObservationBinding } : {}),
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
  agentLaunchTarget?: AgentLaunchMaterializationTarget;
  signal?: AbortSignal;
  retainCleanup?: (cleanup: () => Promise<void>) => Promise<() => void>;
  agentId: CatalogAgentId;
  materializationKey: string;
  /** Existing admitted requester identity for shared native-home preservation. */
  requesterWorkAttributionV1?: RequesterWorkAttributionV1;
  probePurpose?: 'probe';
  runtimeDescriptorV1?: RuntimeDescriptorV1;
  vendorResumeId?: string | null;
  candidatePersistedSessionFile?: string | null;
  activeServerDir: string;
  baseDir: string;
  sessionDirectory?: string | null;
  recordsByServiceId: ReadonlyMap<ConnectedServiceId, ConnectedServiceCredentialRecordV1>;
  selectionsByServiceId?: ReadonlyMap<ConnectedAccountServiceKey, ConnectedServiceResolvedSelection>;
  connectedAccountMaterializationAuthority?: ConnectedServicesMaterializationAuthority;
  qualifiedPurposeBindingSnapshot?: AgentSpawnQualifiedPurposeBindingSnapshot | null;
  exactPurposeBindingSubjectId?: string;
  purposeBindingSessionId?: string;
  accountSettings?: AccountSettings | Readonly<Record<string, unknown>> | null;
  processEnv?: NodeJS.ProcessEnv;
  allowNativeAccountState?: boolean;
  connectedAccountsOwner?: Parameters<typeof materializeQualifiedConnectedAccountLaunchUses>[0]['connectedAccountsOwner'];
  isAccountRuntimeCurrent?: () => Promise<boolean>;
}>): Promise<ConnectedServicesMaterialization | null> {
  const rootDir = resolveConnectedServiceMaterializedRootDir({
    baseDir: params.baseDir,
    agentId: params.agentId,
    materializationKey: params.materializationKey,
  });
  const entered = startConnectedServiceMaterializationPhase(params, 'run_root_queue');
  return await runSerializedMaterialization(rootDir, async () => {
    entered('completed');
    return await observeConnectedServiceMaterializationPhase(params, 'run_materialization',
      () => materializeConnectedServicesForSpawnUnlocked(params, rootDir));
  });
}

async function materializeConnectedServicesForSpawnUnlocked(params: Readonly<{
  agentLaunchTarget?: AgentLaunchMaterializationTarget;
  signal?: AbortSignal;
  retainCleanup?: (cleanup: () => Promise<void>) => Promise<() => void>;
  agentId: CatalogAgentId;
  materializationKey: string;
  requesterWorkAttributionV1?: RequesterWorkAttributionV1;
  probePurpose?: 'probe';
  runtimeDescriptorV1?: RuntimeDescriptorV1;
  vendorResumeId?: string | null;
  candidatePersistedSessionFile?: string | null;
  activeServerDir: string;
  baseDir: string;
  sessionDirectory?: string | null;
  recordsByServiceId: ReadonlyMap<ConnectedServiceId, ConnectedServiceCredentialRecordV1>;
  selectionsByServiceId?: ReadonlyMap<ConnectedAccountServiceKey, ConnectedServiceResolvedSelection>;
  connectedAccountMaterializationAuthority?: ConnectedServicesMaterializationAuthority;
  qualifiedPurposeBindingSnapshot?: AgentSpawnQualifiedPurposeBindingSnapshot | null;
  exactPurposeBindingSubjectId?: string;
  purposeBindingSessionId?: string;
  accountSettings?: AccountSettings | Readonly<Record<string, unknown>> | null;
  processEnv?: NodeJS.ProcessEnv;
  allowNativeAccountState?: boolean;
  connectedAccountsOwner?: Parameters<typeof materializeQualifiedConnectedAccountLaunchUses>[0]['connectedAccountsOwner'];
  isAccountRuntimeCurrent?: () => Promise<boolean>;
}>, rootDir: string): Promise<ConnectedServicesMaterialization | null> {
  // Qualified Agent ids contain '/'; staging has one owned root per attempt.
  const attemptRoot = join(params.baseDir, '.attempts', randomUUID());
  const attemptId = attemptRoot;
  activeMaterializationAttemptByRootDir.set(rootDir, attemptId);
  const cleanupAttemptRoot = createBestEffortCleanupDirectory(attemptRoot, undefined,
    params.retainCleanup ? { failureMode: 'reject' } : undefined);
  let artifactWrite: Promise<unknown> | undefined;
  let disposed = false;
  let promoted = false;
  const assertOpen = () => {
    params.signal?.throwIfAborted();
    if (disposed) throw new Error('Connected Account materialization cleanup has closed');
  };
  const writeArtifacts: MaterializationArtifactWrite = async write => {
    assertOpen();
    if (params.isAccountRuntimeCurrent && !await observeConnectedServiceMaterializationPhase(
      params, 'artifact_currentness_before', () => params.isAccountRuntimeCurrent!(),
    )) {
      throw new Error('requester_account_context_unavailable');
    }
    const pending = write();
    artifactWrite = pending;
    try {
      const result = await pending;
      assertOpen();
      if (params.isAccountRuntimeCurrent && !await observeConnectedServiceMaterializationPhase(
        params, 'artifact_currentness_after', () => params.isAccountRuntimeCurrent!(),
      )) {
        throw new Error('requester_account_context_unavailable');
      }
      return result;
    } finally {
      if (artifactWrite === pending) artifactWrite = undefined;
    }
  };
  if (params.retainCleanup) {
    await params.retainCleanup(async () => {
      disposed = true;
      const failures: unknown[] = [];
      // Only a known host filesystem write is awaited. Credential transport may never settle.
      try { await artifactWrite; } catch (error) { failures.push(error); }
      try { await cleanupAttemptRoot(); } catch (error) { failures.push(error); }
      if (promoted) {
        try {
          if (await isCanonicalConnectedServiceMaterializedRoot({ baseDir: params.baseDir, rootDir })
            && (params.probePurpose === 'probe' || !await isConnectedServiceMaterializedHomeRetainedOnExit({
            materializationKey: params.materializationKey, homeRoot: rootDir,
          }))) {
            await createBestEffortCleanupDirectory(rootDir, undefined, { failureMode: 'reject' })();
          }
        } catch (error) { failures.push(error); }
      }
      forgetActiveAttemptIfCurrent(rootDir, attemptId);
      if (failures.length > 0) throw new AggregateError(failures, 'Connected Account materialization artifact cleanup failed');
    });
  }
  assertOpen();
  // Attempt roots are pre-promotion staging: removal here is observed
  // best-effort and any residue is bounded by the attempt orphan sweep. The
  // promoted-root cleanup below is the custody surface that publishes an
  // awaited receipt.
  const dropAttemptRoot = (): void => {
    void cleanupAttemptRoot().catch(() => undefined);
  };

  const qualifiedAuthority =
    params.connectedAccountMaterializationAuthority?.kind === 'qualified'
      ? params.connectedAccountMaterializationAuthority
      : null;
  const legacyV021Authority =
    params.connectedAccountMaterializationAuthority?.kind === 'legacy_unfenced_one_shot';
  const nativeHomeOnly = params.connectedAccountMaterializationAuthority === undefined
    && params.allowNativeAccountState === false && params.recordsByServiceId.size === 0
    && !params.qualifiedPurposeBindingSnapshot;
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
        writeArtifacts,
        waitForArtifactWrite: async () => { await artifactWrite; },
        previousMaterializedRoot: rootDir,
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
          writeArtifacts,
          waitForArtifactWrite: async () => { await artifactWrite; },
          previousMaterializedRoot: rootDir,
          snapshot: qualifiedPurposeBindingSnapshot,
          recordsByServiceId: params.recordsByServiceId,
          requestAuthRequired: false,
          legacyV021: true,
        })
      : nativeHomeOnly
        ? async () => await materializeQualifiedConnectedAccountLaunchForSpawn({ ...params,
            rootDir: attemptRoot, writeArtifacts, waitForArtifactWrite: async () => { await artifactWrite; },
            previousMaterializedRoot: rootDir, nativeHomeOnly: true, requestAuthRequired: false })
        : null;
  if (!materializer) {
    forgetActiveAttemptIfCurrent(rootDir, attemptId);
    return null;
  }

  let materialized: ConnectedServicesMaterialization | null;
  try {
    if (!await isCanonicalConnectedServiceMaterializedRoot({ baseDir: params.baseDir, rootDir, allowMissing: true })
      || !await isCanonicalConnectedServiceMaterializedRoot({ baseDir: params.baseDir, rootDir: attemptRoot, allowMissing: true })) {
      throw new Error('connected_service_materialization_root_unsafe');
    }
    await observeConnectedServiceMaterializationPhase(params, 'materialization_root_prepare',
      () => writeArtifacts(() => ensurePrivateConnectedServiceMaterializedRoot(attemptRoot)));
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
  const cleanupFinalRoot = createBestEffortCleanupDirectory(
    rootDir, undefined, { failureMode: 'reject' },
  );
  // Unretained promoted roots are custody: cleanup awaits real removal and
  // surfaces failures alongside credential retirement. Resumable native
  // state remains under the existing home reclamation owner.
  const runPromotedRootCleanup = async (
    cleanupCredentials: (() => void | Promise<void>) | null | undefined,
  ): Promise<void> => {
    let rootRemovalError: unknown;
    const rootRemoval = (async () => {
      if (!await isCanonicalConnectedServiceMaterializedRoot({ baseDir: params.baseDir, rootDir })) return;
      // Native rollouts may be the only resume state. Credential/runtime
      // retirement still runs; the existing orphan sweep owns later reclamation.
      if (params.probePurpose === 'probe' || !await isConnectedServiceMaterializedHomeRetainedOnExit({
        materializationKey: params.materializationKey, homeRoot: rootDir,
      })) await cleanupFinalRoot();
    })().catch((error: unknown) => {
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
  try {
    // Final root preparation and promotion form one dependent filesystem
    // publication. Qualify after entering the existing queue and before
    // returning its result, not separately around each permission check.
    await observeConnectedServiceMaterializationPhase(params, 'materialization_promotion', () => runSerializedMaterializationPromotion(rootDir, () => writeArtifacts(async () => {
      assertOpen();
      assertActiveAttempt({ rootDir, attemptId, cleanupRoot: dropAttemptRoot });
      await observeConnectedServiceMaterializationPhase(params, 'materialization_root_finalize', async () => {
        await ensurePrivateConnectedServiceMaterializedRoot(attemptRoot);
        if (targetMaterializedRoot && resolve(targetMaterializedRoot) !== resolve(rootDir)) {
          await ensurePrivateConnectedServiceMaterializedRoot(targetMaterializedRoot);
        }
      });
      assertOpen();
      if (!await isCanonicalConnectedServiceMaterializedRoot({ baseDir: params.baseDir, rootDir, allowMissing: true })) {
        throw new Error('connected_service_materialization_root_unsafe');
      }
      const durableNativeHome = targetMaterializedRoot
        && resolve(targetMaterializedRoot) !== resolve(rootDir);
      if (durableNativeHome) {
        // Native history belongs to the account/group, not this attempt. Keep
        // predecessor private state until native resume continuity is established.
        if (requestAuthMaterializedRoot) {
          await ensurePrivateConnectedServiceMaterializedRoot(rootDir);
          promoted = true;
        }
        await cleanupAttemptRoot();
      } else {
        await replaceDirectoryAtomically({
          stagedDir: attemptRoot,
          targetDir: rootDir,
          afterPromote: () => {
            promoted = true;
            assertActiveAttempt({ rootDir, attemptId, cleanupRoot: dropAttemptRoot });
          },
        });
      }
      assertActiveAttempt({ rootDir, attemptId, cleanupRoot: dropAttemptRoot });
    })));
    assertActiveAttempt({ rootDir, attemptId, cleanupRoot: dropAttemptRoot });

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
    const capturedBinding = materialized.materializedStateObservationBinding;
    const promotedNativeHomeRoot = capturedBinding && targetMaterializedRoot ? await realpath(targetMaterializedRoot) : null;
    const materializedStateObservationBinding = capturedBinding && promotedNativeHomeRoot
      ? {
          ...capturedBinding,
          nativeHomeRoot: promotedNativeHomeRoot,
          entries: capturedBinding.entries.map(entry => ({
            ...entry,
            materializedEntryPath: join(promotedNativeHomeRoot, entry.entryPath),
          })),
        }
      : capturedBinding;
    if (
      !serializedSelections
      && !serializedMaterializedEnvKeys
      && !targetMaterializedRoot
      && !requestAuthMaterializedRoot
    ) {
      return {
        ...materialized,
        ...(materializedStateObservationBinding ? { materializedStateObservationBinding } : {}),
        cleanupOnFailure,
        cleanupOnExit,
        env: materializedEnv,
      };
    }

    return {
      ...materialized,
      ...(materializedStateObservationBinding ? { materializedStateObservationBinding } : {}),
      cleanupOnFailure,
      cleanupOnExit,
      targetMaterializedRoot,
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
    if (promoted) await runPromotedRootCleanup(cleanupMaterialized);
    else await cleanupMaterialized();
    dropAttemptRoot();
    throw error;
  } finally {
    forgetActiveAttemptIfCurrent(rootDir, attemptId);
  }
}
