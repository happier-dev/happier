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
  writeAcpConfigOptionIntentToMetadata,
  writeAcpSessionModeIntentToMetadata,
  writeModelIntentToMetadata,
  readModelIntentFromMetadata,
  writePermissionModeIntentToMetadata,
} from './bindings/intent.js';
import { writeRuntimeDescriptorSessionState } from './bindings/runtimeDescriptor.js';
import { summaryTextBinding } from './bindings/summaryText.js';
import { writeProviderSessionIdSessionState, type ProviderSessionIdMetadataKey } from './bindings/providerSessionId.js';
import {
  clearSessionStateFieldFromMetadata,
  hasSessionStateFieldMetadataBinding,
  publishSessionStateFieldMutationToMetadata,
  publishSessionStateFieldToMetadata,
  writeSessionStateFieldToMetadata,
} from './bindings/publishField.js';

export {
  clearSessionStateFieldFromMetadata,
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
  let accepted = false;
  let refusal: 'conflict' | 'unsupported' | undefined;
  let reversal: Extract<SessionModelMutationReversalV1, { owner: 'inactive' }> | undefined;

  return Object.freeze({
    update<TMetadata extends SessionMetadata>(metadata: TMetadata): TMetadata {
      accepted = false;
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
      const current = readModelIntentFromMetadata(metadata);
      updatedAt ??= Math.max(
        nowMs(),
        (current?.updatedAt ?? 0) + 1,
      );
      if ((current?.updatedAt ?? 0) >= updatedAt) {
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
    readState: () => ({ accepted, updatedAt, ...(refusal ? { refusal } : {}), ...(reversal ? { reversal } : {}) }),
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
      const currentV2 = SessionModelSelectionV2Schema.safeParse(record.modelSelectionIntentV2);
      const currentV1 = SessionModelSelectionIntentV1Schema.safeParse(record.modelSelectionIntentV1);
      const currentUpdatedAt = Math.max(
        currentV2.success ? currentV2.data.updatedAt : 0,
        currentV1.success ? currentV1.data.updatedAt : 0,
      );
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
): TMetadata {
  return clearSessionStateFieldFromMetadata(metadata, 'intent.acpConfigOption') as TMetadata;
}
