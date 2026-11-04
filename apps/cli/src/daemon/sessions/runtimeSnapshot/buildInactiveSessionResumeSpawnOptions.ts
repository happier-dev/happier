import {
  resolveAgentExecutionTargetFromSessionMetadata,
  resolveSessionMetadataAgentIdentity,
  parsePermissionIntentAlias,
} from '@happier-dev/agents';
import { AgentExecutionTargetV1Schema, CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1 } from '@happier-dev/protocol/agents/executionTargetV1';
import { SessionCreationCorrespondenceV1ReadSchema } from '@happier-dev/protocol/sessions/creation/sessionCreationCorrespondenceV1';
import { agentRoutingIdAddressesContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import { readLegacyConfiguredAcpBackendId } from '@happier-dev/protocol/backends/targets/compat/customAcp';
import { readRuntimeDescriptorV1FromMetadata } from '@happier-dev/protocol/sessions/metadata/runtime-descriptor-compat';
import { readSessionDirectoryKind } from '@happier-dev/protocol/sessions/metadata/directory';
import { resolveLinkedExternalSessionMetadataV1 } from '@happier-dev/protocol/sessions/external/linked-metadata';

import { PersistedProviderResumeBindingError } from '@/providers/lifecycle/readPersistedResumeSelection';
import { isCatalogAgentId } from '@/agent/catalog/resolution';
import { resolveBackendTargetFromSessionMetadata } from '@/session/backendTargets/resolveBackendTargetFromSessionMetadata';
import { resolveSessionMachineWorkspacePath } from '@/session/machineControlLocality';
import { createManagedSessionDirectories } from '@/session/creation/managedSessionDirectories';
import type { SpawnSessionOptions } from '@/session/shared/spawnSessionContract';
import {
  resolveCanonicalAbsolutePath,
  type CanonicalAbsolutePath,
} from '@/utils/path/expandHomeDirPath';

import { resolveSessionRuntimeSnapshot, SessionRuntimeDescriptorSelectionError } from './resolveSessionRuntimeSnapshot';

/** Launch controls only: persisted Session identity and workspace stay authoritative. */
export type InactiveSessionResumeRuntimeOptions = Partial<Pick<SpawnSessionOptions,
  'permissionMode' | 'permissionModeUpdatedAt' | 'modelSelection' | 'resume' | 'environmentVariables'
  | 'profileId' | 'terminal' | 'windowsRemoteSessionLaunchMode' | 'windowsRemoteSessionConsole' | 'windowsTerminalWindowName'
  | 'agentModeId' | 'capabilitySelection' | 'connectedServices' | 'transcriptStorage' | 'runtimeDescriptorV1' | 'sessionConfigOptionOverrides'>>;

export type BuildInactiveSessionResumeSpawnOptionsParams = Readonly<{
  fallbackMachineId?: string | null;
  sessionId: string;
  rawSession: unknown;
  metadata: Record<string, unknown>;
  incomingOptions?: InactiveSessionResumeRuntimeOptions;
  initialTranscriptAfterSeq?: number;
  executionAuthorization?: import('@happier-dev/protocol').SpawnSessionExecutionAuthorization;
}>;

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function resolveCanonicalPersistedDirectory(value: unknown): CanonicalAbsolutePath | null {
  const raw = readNonEmptyString(value);
  if (!raw) return null;
  return resolveCanonicalAbsolutePath(raw);
}

function selectCanonicalPersistedDirectory(
  rawDirectory: CanonicalAbsolutePath | null,
  metadataDirectory: CanonicalAbsolutePath | null,
): string | null {
  if (
    rawDirectory
    && metadataDirectory
    && rawDirectory.comparisonKey !== metadataDirectory.comparisonKey
  ) return null;
  if (!rawDirectory) return metadataDirectory?.path ?? null;
  if (!metadataDirectory) return rawDirectory.path;

  // Windows can preserve different case spellings for one identity. Select a
  // stable preserved spelling independent of which persisted carrier supplied
  // it; never lowercase the execution path merely to obtain a comparison key.
  return rawDirectory.path <= metadataDirectory.path
    ? rawDirectory.path
    : metadataDirectory.path;
}

/**
 * Resolves the exact Agent this inactive Session must be resumed as.
 *
 * Identity precedence is owned by `resolveSessionMetadataAgentIdentity`: a
 * declared runtime/linked identity wins, then `flavor`, then exactly one flat
 * vendor resume key. Deriving it here from a union of every piece of evidence
 * would be a second decision-maker, and the union's unanimity rule made any
 * Session that had ever carried two flat resume keys permanently unresumable —
 * `REQ-STATE-01` allows at most one key on an active view, so a second key is
 * legacy residue, not a competing identity.
 *
 * Ambiguity still fails closed: several flat keys with no higher authority
 * resolve to no Agent rather than to the first Agent in catalog order.
 */
export function resolveSessionPersistedRuntimeIdentity(metadata: Record<string, unknown>): Readonly<{
  agentTarget?: NonNullable<SpawnSessionOptions['agentTarget']>;
  backendTarget?: NonNullable<SpawnSessionOptions['backendTarget']>;
  runtimeDescriptorV1?: SpawnSessionOptions['runtimeDescriptorV1'];
}> | null {
  const backendTarget = resolveBackendTargetFromSessionMetadata(metadata);
  const runtimeDescriptorV1 = readRuntimeDescriptorV1FromMetadata(metadata);
  const identity = resolveSessionMetadataAgentIdentity(metadata);

  const correspondence = SessionCreationCorrespondenceV1ReadSchema.safeParse(
    metadata.sessionCreationCorrespondenceV1,
  );
  const linked = resolveLinkedExternalSessionMetadataV1(metadata, 'stored');
  const agentTarget = correspondence.success || linked.ok && linked.linkedSession.qualifiedIdentity
    ? resolveAgentExecutionTargetFromSessionMetadata(metadata)
    : null;

  // Creation correspondence is immutable provenance. Its qualified target can
  // still address the current Agent, but must not override a later cutover's
  // persisted target. Before the first native open publishes an Agent identity,
  // the admitted qualified birth target is already sufficient to retry it.
  if (agentTarget
    && backendTarget?.sourceKind !== 'configured'
    && !identity.ambiguousVendorResumeKeys) {
    if (runtimeDescriptorV1 && runtimeDescriptorV1.agentId !== identity.agentId) return null;
    return {
      agentTarget,
      ...(runtimeDescriptorV1 ? { runtimeDescriptorV1 } : {}),
    };
  }

  if (!backendTarget) return null;

  if (backendTarget.sourceKind === 'configured') {
    const definitionId = backendTarget.configuredBackendId ?? backendTarget.backendId;
    const flavorBackendId = readLegacyConfiguredAcpBackendId(metadata.flavor);
    if (flavorBackendId !== null && flavorBackendId !== definitionId) return null;
    if (runtimeDescriptorV1
      && agentRoutingIdAddressesContributionIdentityV1(runtimeDescriptorV1.agentId, CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1)) {
      if (identity.agentId !== runtimeDescriptorV1.agentId || runtimeDescriptorV1.agent.definitionId !== definitionId) return null;
      return {
        agentTarget: AgentExecutionTargetV1Schema.parse({ kind: 'agent', identity: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1, definitionId }),
        runtimeDescriptorV1,
      };
    }
    // The predecessor carrier has no contribution identity. Foreign Agent
    // evidence contradicts it rather than supplying a configured runtime.
    if (identity.agentId || identity.vendorResumeKeyAgentIds.length > 0 || runtimeDescriptorV1) return null;
  } else {
    if (!isCatalogAgentId(backendTarget.backendId)) return null;
    if (!identity.agentId || identity.agentId !== backendTarget.backendId) return null;
    if (
      runtimeDescriptorV1
      && isCatalogAgentId(runtimeDescriptorV1.agentId)
      && runtimeDescriptorV1.agentId !== identity.agentId
    ) return null;
  }

  return {
    backendTarget,
    ...(runtimeDescriptorV1 ? { runtimeDescriptorV1 } : {}),
  };
}

/** Canonical provider-neutral inactive-session snapshot composition. */
export function buildInactiveSessionResumeSpawnOptions(
  params: BuildInactiveSessionResumeSpawnOptionsParams,
): SpawnSessionOptions | null {
  const rawSession = params.rawSession && typeof params.rawSession === 'object' && !Array.isArray(params.rawSession)
    ? params.rawSession as Record<string, unknown>
    : {};
  const rawDirectory = resolveCanonicalPersistedDirectory(rawSession.path);
  const metadataDirectory = resolveCanonicalPersistedDirectory(params.metadata.path);

  const rawMachineId = readNonEmptyString(rawSession.machineId);
  const metadataMachineId = readNonEmptyString(params.metadata.machineId);
  if (rawMachineId && metadataMachineId && rawMachineId !== metadataMachineId) return null;

  const rawCorrespondence = params.metadata.sessionCreationCorrespondenceV1;
  const parsedCorrespondence = SessionCreationCorrespondenceV1ReadSchema.safeParse(rawCorrespondence);
  if (rawCorrespondence !== undefined && !parsedCorrespondence.success) return null;
  const correspondence = parsedCorrespondence.success ? parsedCorrespondence.data : null;
  // No native identity has been published for a failed first open. Recover its
  // admitted initial choices, then let the ordinary snapshot owner arbitrate
  // newer persisted or explicitly authored intent. A later Agent cutover must
  // never inherit these original-Agent launch choices.
  const initialRecipe = resolveSessionMetadataAgentIdentity(params.metadata).basis === 'none'
    ? correspondence?.recipe
    : undefined;
  const initialPermissionMode = initialRecipe?.requestedPermissionMode
    ? parsePermissionIntentAlias(initialRecipe.requestedPermissionMode)
    : null;
  if (initialRecipe?.requestedPermissionMode && !initialPermissionMode) return null;
  const createdAt = typeof rawSession.createdAt === 'number' && Number.isFinite(rawSession.createdAt)
    ? rawSession.createdAt : 0;

  const firstManagedBirth = !rawDirectory && !metadataDirectory
    && rawSession.runtimeActivityRevision === 0
    && initialRecipe?.execution.directory.kind === 'managed'
    && correspondence !== null;
  const persistedDirectory = firstManagedBirth
    ? createManagedSessionDirectories().prepareForCreation({ sessionCreationTag: correspondence.sessionCreationTag }).directory
    : selectCanonicalPersistedDirectory(rawDirectory, metadataDirectory);
  const machineId = rawMachineId ?? metadataMachineId ?? readNonEmptyString(params.fallbackMachineId);
  const runtimeIdentity = resolveSessionPersistedRuntimeIdentity(params.metadata);
  if (!persistedDirectory || !machineId || !runtimeIdentity) return null;
  const directory = resolveSessionMachineWorkspacePath({
    metadata: params.metadata,
    currentMachineId: machineId,
    candidatePath: persistedDirectory,
  });
  if (!directory) return null;
  const directoryKind = readSessionDirectoryKind(params.metadata);

  let resolved: SpawnSessionOptions;
  try {
    resolved = resolveSessionRuntimeSnapshot({
      incomingOptions: {
        existingSessionId: params.sessionId,
        machineId,
        directory,
        directoryKind,
        ...(initialRecipe?.modelSelection ? { modelSelection: initialRecipe.modelSelection } : {}),
        ...(initialRecipe?.machineSetupPlanInput ? { machineSetupPlanInput: initialRecipe.machineSetupPlanInput } : {}),
        ...(initialRecipe?.machineSetupExecution ? { machineSetupExecution: initialRecipe.machineSetupExecution } : {}),
        ...(initialRecipe?.checkoutCreationDraft ? { checkoutCreationDraft: initialRecipe.checkoutCreationDraft } : {}),
        ...(initialPermissionMode ? { permissionMode: initialPermissionMode,
          permissionModeUpdatedAt: initialRecipe?.configuration?.permissionIntent.updatedAtMs ?? createdAt } : {}),
        ...(correspondence
          ? {
              sessionCreationTag: correspondence.sessionCreationTag,
              sessionCreationCorrespondence: correspondence,
              ...(correspondence.recipe.profileId
                ? { profileId: correspondence.recipe.profileId }
                : {}),
              ...(correspondence.recipe.secretReferenceOverlay
                ? { secretReferenceOverlay: correspondence.recipe.secretReferenceOverlay }
                : {}),
            }
          : {}),
        ...(runtimeIdentity.agentTarget ? { agentTarget: runtimeIdentity.agentTarget } : {}),
        ...(runtimeIdentity.backendTarget ? { backendTarget: runtimeIdentity.backendTarget } : {}),
        approvedNewDirectoryCreation: directoryKind !== 'managed',
        ...(runtimeIdentity.runtimeDescriptorV1 ? { runtimeDescriptorV1: runtimeIdentity.runtimeDescriptorV1 } : {}),
        ...params.incomingOptions,
      },
      persistedMetadata: params.metadata,
    }).spawnOptions;
  } catch (error) {
    if (error instanceof PersistedProviderResumeBindingError || error instanceof SessionRuntimeDescriptorSelectionError) return null;
    throw error;
  }

  // Snapshot resolution intentionally excludes request-scoped controls from
  // durable tracked state. Reattach only this invocation's fresh controls.
  return {
    ...resolved,
    ...(firstManagedBirth ? { freshSessionCreation: true } : {}),
    ...(typeof params.initialTranscriptAfterSeq === 'number'
      && Number.isSafeInteger(params.initialTranscriptAfterSeq)
      && params.initialTranscriptAfterSeq >= 0
      ? { initialTranscriptAfterSeq: params.initialTranscriptAfterSeq }
      : {}),
    ...(params.executionAuthorization ? { executionAuthorization: params.executionAuthorization } : {}),
  };
}
