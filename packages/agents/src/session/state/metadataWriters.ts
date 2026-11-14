import { z } from 'zod/mini';
import { ApprovalProfileIdV1Schema } from '@happier-dev/protocol/actions';
import { SessionIdentityAdditionsV1Schema, type SessionIdentityAdditions } from '@happier-dev/protocol/sessions/identity/sessionBotV1';
import { SessionAttestedContextV1Schema, type SessionAttestedContextV1 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { ConnectedServiceBindingsV2IngressSchema } from '@happier-dev/protocol/connect/connected-service-bindings';
import { SessionPromptStackV1Schema, type SessionPromptStackV1 } from '@happier-dev/protocol/sessions/context/sessionContextV1';
import { PluginUiNewSessionSeedOriginV1Schema, type PluginUiNewSessionSeedOriginV1 } from '@happier-dev/protocol/plugins/ui/newSessionSeedOrigin';
import { SessionRolesV1Schema } from '@happier-dev/protocol/prompts/roles/sessionRolesSnapshot';
import { writeSessionCapabilitySelectionToMetadataV1 } from '@happier-dev/protocol/reach/sessionCapabilityMetadataV1';
import { AcpConfigOptionOverridesV1Schema } from '@happier-dev/protocol/sessions/metadata/overrides';
import type { SessionOwnerMetadataV1, SessionCreationCorrespondenceV1, MachinePoolSelectionOriginV1, ConnectedServiceMaterializationIdentityV1, SessionRolesV1, SessionCapabilitySelectionV1, SessionModelSelectionV1, AcpConfigOptionOverridesV1 } from '@happier-dev/protocol';
import type { SessionTeamCredentialBindingIntentListV1 } from '@happier-dev/protocol/teams';
import type {
  RuntimeDescriptorV1,
  ProviderBoundModelRef,
  SessionModelSelectionV2,
  SessionMetadata,
  SessionStateFieldId,
  SessionStateFieldValue,
} from '@happier-dev/protocol';
import { ProviderBoundModelRefSchema, SessionModelSelectionIntentV1Schema } from '@happier-dev/protocol/providers/model-selection';
import { SessionModelSelectionV2Schema } from '@happier-dev/protocol/providers/selection/v2';
import type { SessionModelMutationExpectedV1, SessionModelMutationReversalV1, SessionModelMutationScopeV1 } from '@happier-dev/protocol/sessions/control/modelTransitionV1';

import type { SessionStateFieldWriteValue } from './_types.js';
import {
  clearMatchingAcpConfigOptionIntentFromMetadata,
  writeAcpConfigOptionIntentToMetadata,
  writeAcpSessionModeIntentToMetadata,
  writeModelIntentToMetadata,
  readModelIntentFromMetadata,
  readModelIntentUpdatedAtFromMetadata,
  writePermissionModeIntentToMetadata,
} from './bindings/intent.js';
import { MODEL_OVERRIDE_KEY, MODEL_SELECTION_INTENT_KEY } from './bindings/metadataKeys.js';
import { writeRuntimeDescriptorSessionState } from './bindings/runtimeDescriptor.js';
import { summaryTextBinding } from './bindings/summaryText.js';
import { writeProviderSessionIdSessionState, type ProviderSessionIdMetadataKey } from './bindings/providerSessionId.js';
import {
  clearSessionStateFieldFromMetadata,
  createSessionStateFieldMetadataUpdater,
  hasSessionStateFieldMetadataBinding,
  publishSessionStateFieldMutationToMetadata,
  publishSessionStateFieldToMetadata,
  writeSessionStateFieldToMetadata,
} from './bindings/publishField.js';

export {
  clearSessionStateFieldFromMetadata,
  createSessionStateFieldMetadataUpdater,
  hasSessionStateFieldMetadataBinding,
  publishSessionStateFieldMutationToMetadata,
  publishSessionStateFieldToMetadata,
  writeSessionStateFieldToMetadata,
};

export { normalizeLegacyAgentVocabularySessionMetadata } from './legacyAgentVocabularyMetadata.js';

export {
  projectCurrentAgentSessionView,
  type CurrentAgentSessionViewStatePolicyV1,
  type ProjectCurrentAgentSessionViewParamsV1,
} from './projectCurrentAgentSessionView.js';

export type SessionStateMetadataUpdateV1<F extends SessionStateFieldId = SessionStateFieldId> = Readonly<{
  fieldId: F;
  value: SessionStateFieldValue<F>;
}>;

export function applySessionStateUpdatesToMetadata<TMetadata extends SessionMetadata>(
  metadata: TMetadata,
  updates: readonly SessionStateMetadataUpdateV1[],
): TMetadata {
  let next: SessionMetadata = metadata;
  for (const update of updates) {
    next = writeSessionStateFieldToMetadata(
      next,
      update.fieldId,
      update.value as never,
    );
  }
  return next as TMetadata;
}

export function applyRuntimeDescriptorSessionMetadata<TMetadata extends SessionMetadata>(
  metadata: TMetadata,
  descriptor: RuntimeDescriptorV1 | null,
): TMetadata {
  return writeRuntimeDescriptorSessionState(metadata, descriptor);
}

export function buildRuntimeDescriptorSessionMetadata(
  descriptor: RuntimeDescriptorV1 | null,
): SessionMetadata {
  return applyRuntimeDescriptorSessionMetadata({}, descriptor);
}

export function applyProviderSessionIdSessionMetadata<TMetadata extends Record<string, unknown>>(
  metadata: TMetadata,
  update: Readonly<{
    metadataKey: ProviderSessionIdMetadataKey | null;
    value: string | null | undefined;
  }>,
): TMetadata {
  return writeProviderSessionIdSessionState(metadata, update);
}

export function buildProviderSessionIdSessionMetadata(
  update: Readonly<{
    metadataKey: ProviderSessionIdMetadataKey;
    value: string | null | undefined;
  }>,
): SessionMetadata {
  return applyProviderSessionIdSessionMetadata({}, update);
}

export function applyDisplayTitleSessionMetadata<TMetadata extends SessionMetadata>(
  metadata: TMetadata,
  value: SessionStateFieldWriteValue<'display.title'>,
): TMetadata {
  return summaryTextBinding.write(metadata, { value }) as TMetadata;
}

export function applyPermissionModeIntentSessionMetadata<TMetadata extends SessionMetadata>(
  metadata: TMetadata,
  value: SessionStateFieldWriteValue<'intent.permissionMode'>,
): TMetadata {
  return writePermissionModeIntentToMetadata(metadata, {
    permissionMode: value.permissionMode,
    updatedAt: value.updatedAt,
  }) as TMetadata;
}

export function clearPermissionModeIntentSessionMetadata<TMetadata extends SessionMetadata>(
  metadata: TMetadata,
): TMetadata {
  return clearSessionStateFieldFromMetadata(metadata, 'intent.permissionMode') as TMetadata;
}

export function applyModelIntentSessionMetadata<TMetadata extends SessionMetadata>(
  metadata: TMetadata,
  value: SessionStateFieldWriteValue<'intent.model'>,
): TMetadata {
  return writeModelIntentToMetadata(metadata, {
    v: 1,
    selection: value.selection,
    updatedAt: value.updatedAt,
  }) as TMetadata;
}

/** The stored V1 intent (and its legacy projection) is exactly what writing `selection` would store. */
function holdsExactModelIntent(metadata: SessionMetadata, selection: ProviderBoundModelRef, updatedAt: number): boolean {
  const record = metadata as Readonly<Record<string, unknown>>;
  if (updatedAt <= 0 || record.modelSelectionIntentV2 !== undefined) return false;
  const { [MODEL_SELECTION_INTENT_KEY]: _intent, [MODEL_OVERRIDE_KEY]: _legacy, ...rest } = record;
  const rewritten = writeModelIntentToMetadata(rest as SessionMetadata, { v: 1, selection, updatedAt }) as Readonly<Record<string, unknown>>;
  return JSON.stringify(rewritten[MODEL_SELECTION_INTENT_KEY]) === JSON.stringify(record[MODEL_SELECTION_INTENT_KEY])
    && JSON.stringify(rewritten[MODEL_OVERRIDE_KEY] ?? null) === JSON.stringify(record[MODEL_OVERRIDE_KEY] ?? null);
}

export function createModelIntentMetadataCasCandidate(input: Readonly<{
  selection: ProviderBoundModelRef;
  nowMs?: () => number;
  captureBefore?: boolean;
  /** Live owner capture requires durable intent to match its proven active tuple. */
  requiredBefore?: ProviderBoundModelRef;
  ownerScope?: SessionModelMutationScopeV1;
  expected?: Extract<SessionModelMutationExpectedV1, { owner: 'inactive' }>;
}>): Readonly<{
  update<TMetadata extends SessionMetadata>(metadata: TMetadata): TMetadata;
  readState(): Readonly<{ accepted: boolean; updatedAt: number | null; refusal?: 'conflict' | 'unsupported';
    reversal?: Extract<SessionModelMutationReversalV1, { owner: 'inactive' }> }>;
}> {
  const selection = ProviderBoundModelRefSchema.parse(input.selection);
  const nowMs = input.nowMs ?? Date.now;
  let updatedAt: number | null = null;
  /** Set when the stored intent already held this selection: nothing was written. */
  let heldUpdatedAt: number | null = null;
  let accepted = false;
  let refusal: 'conflict' | 'unsupported' | undefined;
  let reversal: Extract<SessionModelMutationReversalV1, { owner: 'inactive' }> | undefined;

  return Object.freeze({
    update<TMetadata extends SessionMetadata>(metadata: TMetadata): TMetadata {
      accepted = false;
      heldUpdatedAt = null;
      refusal = undefined;
      reversal = undefined;
      const canonicalBefore = SessionModelSelectionIntentV1Schema.safeParse(metadata.modelSelectionIntentV1);
      if (input.captureBefore || input.expected) {
        const ownerScope = input.ownerScope;
        if (!ownerScope) {
          refusal = input.expected ? 'conflict' : 'unsupported';
          return metadata;
        }
        if (input.expected && (input.expected.scope.serverId !== ownerScope.serverId
          || input.expected.scope.accountId !== ownerScope.accountId
          || input.expected.scope.sessionId !== ownerScope.sessionId)) {
          refusal = 'conflict';
          return metadata;
        }
        // V2/legacy/absent intent needs its own exact restoration contract.
        // Ordinary writes retain their established compatibility behavior.
        if (!canonicalBefore.success || canonicalBefore.data.selection === null || metadata.modelSelectionIntentV2 !== undefined) {
          refusal = input.expected ? 'conflict' : 'unsupported';
          return metadata;
        }
        // The Session setter re-derives the Agent target rather than accepting
        // it from the caller. Do not promise an inverse it cannot express.
        if (canonicalBefore.data.selection.agentTargetKey !== selection.agentTargetKey) {
          refusal = input.expected ? 'conflict' : 'unsupported';
          return metadata;
        }
        if (input.requiredBefore && (canonicalBefore.data.selection.agentTargetKey !== input.requiredBefore.agentTargetKey
          || canonicalBefore.data.selection.providerConnectionId !== input.requiredBefore.providerConnectionId
          || canonicalBefore.data.selection.modelId !== input.requiredBefore.modelId)) {
          refusal = 'conflict';
          return metadata;
        }
        if (input.expected && (canonicalBefore.data.updatedAt !== input.expected.updatedAt
          || canonicalBefore.data.selection.agentTargetKey !== input.expected.selection.agentTargetKey
          || canonicalBefore.data.selection.providerConnectionId !== input.expected.selection.providerConnectionId
          || canonicalBefore.data.selection.modelId !== input.expected.selection.modelId)) {
          refusal = 'conflict';
          return metadata;
        }
      }
      const currentUpdatedAt = readModelIntentUpdatedAtFromMetadata(metadata);
      // An ordinary write of the intent this Session already holds is no change: a prompt
      // re-submits the Session's model every turn and must not mint a newer timestamp.
      // Conditional/capture writes keep their explicit receipts.
      if (!input.captureBefore && !input.expected && holdsExactModelIntent(metadata, selection, currentUpdatedAt)) {
        accepted = true;
        heldUpdatedAt = currentUpdatedAt;
        return metadata;
      }
      updatedAt ??= Math.max(
        nowMs(),
        currentUpdatedAt + 1,
      );
      if (currentUpdatedAt >= updatedAt) {
        return metadata;
      }
      const next = writeModelIntentToMetadata(metadata, {
        v: 1,
        selection,
        updatedAt,
      }) as TMetadata;
      const persisted = readModelIntentFromMetadata(next);
      const canonical = SessionModelSelectionIntentV1Schema.safeParse(persisted);
      const persistedSelection = canonical.success ? canonical.data.selection : null;
      accepted = canonical.success
        && canonical.data.updatedAt === updatedAt
        && persistedSelection !== null
        && persistedSelection.agentTargetKey === selection.agentTargetKey
        && persistedSelection.providerConnectionId === selection.providerConnectionId
        && persistedSelection.modelId === selection.modelId;
      if (accepted && input.captureBefore && canonicalBefore.success && canonicalBefore.data.selection !== null && input.ownerScope) {
        reversal = { owner: 'inactive', scope: input.ownerScope, before: canonicalBefore.data.selection, applied: selection, updatedAt };
      }
      return next;
    },
    readState: () => ({ accepted, updatedAt: heldUpdatedAt ?? updatedAt, ...(refusal ? { refusal } : {}), ...(reversal ? { reversal } : {}) }),
  });
}

/**
 * V2 companion of the existing model-intent CAS owner. Team selections cannot
 * be projected onto the V1 Provider-connection tuple without changing their
 * meaning, so they remain exact under the V2 metadata key while sharing the
 * same owner ordering and retry semantics.
 */
export function createModelIntentV2MetadataCasCandidate(input: Readonly<{
  selection: SessionModelSelectionV2;
  nowMs?: () => number;
}>): Readonly<{
  update<TMetadata extends SessionMetadata>(metadata: TMetadata): TMetadata;
  readState(): Readonly<{ accepted: boolean; updatedAt: number | null }>;
}> {
  const requested = SessionModelSelectionV2Schema.parse(input.selection);
  const nowMs = input.nowMs ?? Date.now;
  let updatedAt: number | null = null;
  let accepted = false;

  return Object.freeze({
    update<TMetadata extends SessionMetadata>(metadata: TMetadata): TMetadata {
      accepted = false;
      const record = metadata as Record<string, unknown>;
      const currentUpdatedAt = readModelIntentUpdatedAtFromMetadata(metadata);
      updatedAt ??= Math.max(nowMs(), currentUpdatedAt + 1);
      if (currentUpdatedAt >= updatedAt) return metadata;

      const persisted = SessionModelSelectionV2Schema.parse({ ...requested, updatedAt });
      const next: Record<string, unknown> = {
        ...record,
        modelSelectionIntentV2: persisted,
      };
      delete next.modelSelectionIntentV1;
      delete next.modelOverrideV1;
      accepted = true;
      return next as TMetadata;
    },
    readState: () => ({ accepted, updatedAt }),
  });
}

export function isInactiveModelIntentSessionActiveError(
  error: unknown,
): error is Error & {
  code: 'session_active';
  retryable: false;
} {
  return error instanceof Error
    && (error as { code?: unknown }).code === 'session_active'
    && (error as { retryable?: unknown }).retryable === false;
}

/**
 * Canonical active/inactive disposition for a model-intent mutation.
 *
 * The initial activity projection is only a routing hint. An inactive write
 * becomes authoritative only when its conditioned metadata CAS commits. If
 * the Session row instead proves an active publisher, callers re-resolve that
 * publisher once and must not fall back to metadata again.
 */
export async function runModelIntentAtAuthoritativeDisposition<
  TInactive,
  TActive,
>(params: Readonly<{
  observedActive: boolean;
  updateInactiveIntent: () => Promise<TInactive>;
  invokeObservedActiveOwner: () => Promise<TActive>;
  resolveAndInvokeActiveOwnerAfterConflict: () => Promise<TActive>;
}>): Promise<TInactive | TActive> {
  if (params.observedActive) {
    return await params.invokeObservedActiveOwner();
  }
  try {
    return await params.updateInactiveIntent();
  } catch (error) {
    if (!isInactiveModelIntentSessionActiveError(error)) {
      throw error;
    }
    return await params.resolveAndInvokeActiveOwnerAfterConflict();
  }
}

export function clearModelIntentSessionMetadata<TMetadata extends SessionMetadata>(
  metadata: TMetadata,
): TMetadata {
  return clearSessionStateFieldFromMetadata(metadata, 'intent.model') as TMetadata;
}

export function applyAcpSessionModeIntentSessionMetadata<TMetadata extends SessionMetadata>(
  metadata: TMetadata,
  value: SessionStateFieldWriteValue<'intent.acpSessionMode'>,
): TMetadata {
  return writeAcpSessionModeIntentToMetadata(metadata, {
    modeId: value.modeId,
    updatedAt: value.updatedAt,
  }) as TMetadata;
}

export function clearAcpSessionModeIntentSessionMetadata<TMetadata extends SessionMetadata>(
  metadata: TMetadata,
): TMetadata {
  return clearSessionStateFieldFromMetadata(metadata, 'intent.acpSessionMode') as TMetadata;
}

export function applyAcpConfigOptionIntentSessionMetadata<TMetadata extends SessionMetadata>(
  metadata: TMetadata,
  value: SessionStateFieldWriteValue<'intent.acpConfigOption'>,
): TMetadata {
  return writeAcpConfigOptionIntentToMetadata(metadata, {
    configId: value.configId,
    value: value.value,
    updatedAt: value.updatedAt,
  }) as TMetadata;
}

export function clearAcpConfigOptionIntentSessionMetadata<TMetadata extends SessionMetadata>(
  metadata: TMetadata,
  expected?: Readonly<{ configId: string; value: string | number | boolean | null; updatedAt: number }>,
): TMetadata {
  if (expected) return clearMatchingAcpConfigOptionIntentFromMetadata(metadata, expected) as TMetadata;
  return clearSessionStateFieldFromMetadata(metadata, 'intent.acpConfigOption') as TMetadata;
}


type SessionBirthMetadataFieldsV1 = Pick<SessionOwnerMetadataV1, 'work'>
  & Pick<NonNullable<SessionOwnerMetadataV1['runtime']>, 'allowedTools' | 'unlistedTools' | 'workspaceWrites' | 'approvalProfileId'>
  & Pick<NonNullable<SessionOwnerMetadataV1['system']>, 'attestedContext'>;

export type CommittedLaunchMetadataOptionsV1 = Readonly<{
  machineId?: string;
  directoryKind?: 'path' | 'managed';
  sessionCreationCorrespondence?: SessionCreationCorrespondenceV1;
  placementOrigin?: MachinePoolSelectionOriginV1;
  runtimeDescriptorV1?: RuntimeDescriptorV1;
  connectedServices?: unknown;
  connectedServicesUpdatedAt?: number;
  initialSessionRolesV1?: SessionRolesV1;
  capabilitySelection?: SessionCapabilitySelectionV1;
  initialTitle?: string;
  modelSelection?: SessionModelSelectionV1;
  teamCredentialBindings?: SessionTeamCredentialBindingIntentListV1;
  sessionConfigOptionOverrides?: AcpConfigOptionOverridesV1;
  allowedTools?: readonly string[];
  unlistedTools?: 'ask' | 'deny';
  workspaceWrites?: 'allow' | 'deny';
  identity?: SessionIdentityAdditions;
  attestedContext?: SessionAttestedContextV1;
  memoryEnabled?: boolean;
  promptStack?: SessionPromptStackV1;
  approvalProfileId?: string | null;
  authoringOrigin?: PluginUiNewSessionSeedOriginV1;
}>;

/** All fresh row creators use the same birth facts; source metadata cannot choose a child's kind. */
export function applyInitialSessionCreationFactsToMetadata<TMetadata extends SessionMetadata & Pick<SessionBirthMetadataFieldsV1, 'work' | 'approvalProfileId'>>(
    metadata: TMetadata,
    facts: Readonly<{ allowedTools?: readonly string[]; unlistedTools?: 'ask' | 'deny'; workspaceWrites?: 'allow' | 'deny'; identity?: SessionIdentityAdditions;
        attestedContext?: SessionAttestedContextV1; memoryEnabled?: boolean; promptStack?: SessionPromptStackV1; approvalProfileId?: string | null;
        authoringOrigin?: PluginUiNewSessionSeedOriginV1;
        accountSettings?: Readonly<Record<string, unknown>> }>,
): Omit<TMetadata, keyof SessionIdentityAdditions | 'work' | 'allowedTools' | 'unlistedTools' | 'workspaceWrites' | 'attestedContext' | 'approvalProfileId'> & SessionIdentityAdditions
    & Pick<SessionBirthMetadataFieldsV1, 'allowedTools' | 'unlistedTools' | 'workspaceWrites' | 'attestedContext' | 'approvalProfileId'> & { work: NonNullable<SessionBirthMetadataFieldsV1['work']> } {
    const { bot: _inheritedBot, botFace: _inheritedBotFace, createdAsBot: _inheritedCreatedAsBot,
        approvalProfileId: inheritedApprovalProfileId, allowedTools: _inheritedAllowedTools,
        unlistedTools: _inheritedUnlistedTools, workspaceWrites: _inheritedWorkspaceWrites,
        attestedContext: _inheritedAttestation, work, ...base } = metadata;
    const identity = facts.identity === undefined ? undefined : SessionIdentityAdditionsV1Schema.parse(facts.identity);
    const approvalProfileId = facts.approvalProfileId === undefined ? inheritedApprovalProfileId
        : z.nullable(ApprovalProfileIdV1Schema).parse(facts.approvalProfileId);
    const settings = accountSettingsParse(facts.accountSettings ?? {});
    return {
        ...base,
        ...identity,
        ...(approvalProfileId === undefined ? {} : { approvalProfileId }),
        ...(facts.attestedContext === undefined ? {} : { attestedContext: SessionAttestedContextV1Schema.parse(facts.attestedContext) }),
        ...(facts.allowedTools === undefined ? {} : { allowedTools: [...facts.allowedTools] }),
        ...(facts.unlistedTools === undefined ? {} : { unlistedTools: facts.unlistedTools }),
        ...(facts.workspaceWrites === undefined ? {} : { workspaceWrites: facts.workspaceWrites }),
        work: { ...work,
            ...(facts.authoringOrigin === undefined ? {} : { authoringOriginV1: PluginUiNewSessionSeedOriginV1Schema.parse(facts.authoringOrigin) }),
            ...(facts.promptStack === undefined ? {} : { promptStack: SessionPromptStackV1Schema.parse(facts.promptStack) }),
            memoryEnabled: facts.memoryEnabled ?? (identity?.bot?.kind === 'bot'
                ? settings.memoryUseInNewBots : settings.memoryUseInNewSessions) },
    };
}

export function applySessionConfigOptionOverridesToMetadata<TMetadata extends SessionMetadata>(
    metadata: TMetadata,
    overrides: AcpConfigOptionOverridesV1 | null,
): TMetadata {
    if (!overrides) return metadata;

    let nextMetadata = metadata;
    for (const [configId, entry] of Object.entries(overrides.overrides)) {
        nextMetadata = applyAcpConfigOptionIntentSessionMetadata(nextMetadata, {
            v: 1,
            configId,
            value: entry.value,
            updatedAt: entry.updatedAt,
        });
    }

    return nextMetadata;
}

export function generateConnectedServiceMaterializationIdentityV1(params: Readonly<{
    now?: () => number;
    randomBytes: (length: number) => Uint8Array;
}>): ConnectedServiceMaterializationIdentityV1 {
    const now = Math.max(0, Math.trunc(params.now?.() ?? Date.now()));
    const hex = Array.from(params.randomBytes(8), byte => byte.toString(16).padStart(2, '0')).join('');
    return { v: 1, id: `csm_${now}_${hex}`, createdAt: now, source: 'first_spawn' };
}

/** Birth intents an attaching runner preserves instead of taking from its process. */
export function buildCommittedLaunchMetadata(input: Readonly<{
    options: CommittedLaunchMetadataOptionsV1;
    directory?: string;
    host?: string;
    agentModeId?: string;
    agentModeUpdatedAt?: number;
    materializationIdentity?: ConnectedServiceMaterializationIdentityV1;
    accountSettings?: Readonly<Record<string, unknown>>;
}>): SessionMetadata {
    const { options } = input;
    const machineId = options.machineId || options.sessionCreationCorrespondence?.recipe.execution.machineId;
    let metadata: SessionMetadata = {
        ...(input.directory !== undefined ? { path: input.directory, ...(input.host ? { host: input.host } : {}) } : {}),
        // The private allocation is never a folder to show: say so at birth, not only once a runner starts.
        ...(options.directoryKind === 'managed' ? { sessionDirectoryV1: { v: 1 as const, kind: 'managed' as const } } : {}),
        ...(machineId ? { machineId } : {}),
        ...(options.sessionCreationCorrespondence ? { sessionCreationCorrespondenceV1: options.sessionCreationCorrespondence } : {}),
        ...(options.sessionCreationCorrespondence?.recipe.checkout?.branchName !== undefined
            ? { branch: options.sessionCreationCorrespondence.recipe.checkout.branchName } : {}),
        ...(options.placementOrigin ? { placementOrigin: options.placementOrigin } : {}),
        ...(options.runtimeDescriptorV1 ? { runtimeDescriptorV1: options.runtimeDescriptorV1 } : {}),
        ...(options.connectedServices ? { connectedServices: ConnectedServiceBindingsV2IngressSchema.parse(options.connectedServices) } : {}),
        ...(options.connectedServicesUpdatedAt !== undefined ? { connectedServicesUpdatedAt: options.connectedServicesUpdatedAt } : {}),
        ...(input.materializationIdentity ? { connectedServiceMaterializationIdentityV1: input.materializationIdentity } : {}),
        ...(options.initialSessionRolesV1 ? { work: { sessionRolesV1: SessionRolesV1Schema.parse(options.initialSessionRolesV1) } } : {}),
    };
    if (options.capabilitySelection !== undefined) metadata = writeSessionCapabilitySelectionToMetadataV1(
        metadata, options.capabilitySelection, { sessionActive: false },
    );
    if (options.initialTitle) metadata = applyDisplayTitleSessionMetadata(metadata, {
        title: options.initialTitle, staleBehavior: 'bump-if-value-changed',
    });
    const agentModeId = input.agentModeId?.trim();
    if (agentModeId) metadata = applyAcpSessionModeIntentSessionMetadata(metadata, {
        v: 1, modeId: agentModeId, updatedAt: input.agentModeUpdatedAt ?? Date.now(),
    });
    if (options.modelSelection) {
        const model = options.modelSelection;
        const teamBinding = options.teamCredentialBindings?.find(binding => binding.slot.kind === 'provider_model');
        // Commit the selected source with its binding. The runner's later startup
        // merge replays this accepted intent rather than choosing a native source.
        metadata = teamBinding?.resourceId && teamBinding.teamId && model.ref.providerConnectionId === null
            ? { ...metadata, modelSelectionIntentV2: SessionModelSelectionV2Schema.parse({ v: 2, updatedAt: model.updatedAt, ref: {
                    source: 'team_resource', resourceId: teamBinding.resourceId, teamId: teamBinding.teamId,
                    expectedResourceRevision: teamBinding.expectedResourceRevision, deliveryMode: teamBinding.deliveryMode,
                    agentTargetKey: model.ref.agentTargetKey, modelId: model.ref.modelId,
                    ...(teamBinding.nativeDelivery ? { nativeDelivery: teamBinding.nativeDelivery } : {}),
                } }) }
            : applyModelIntentSessionMetadata(metadata, { v: 1, updatedAt: model.updatedAt, selection: model.ref });
    }
    return applySessionConfigOptionOverridesToMetadata(
        applyInitialSessionCreationFactsToMetadata(metadata, { ...options, accountSettings: input.accountSettings }),
        options.sessionConfigOptionOverrides
            ? (() => { const parsed = AcpConfigOptionOverridesV1Schema.safeParse(options.sessionConfigOptionOverrides); return parsed.success ? parsed.data : null; })() : null,
    );
}

