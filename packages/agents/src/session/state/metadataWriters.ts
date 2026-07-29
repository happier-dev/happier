import type {
  RuntimeDescriptorV1,
  ProviderBoundModelRef,
  SessionMetadata,
  SessionStateFieldId,
  SessionStateFieldValue,
} from '@happier-dev/protocol';
import {
  ProviderBoundModelRefSchema,
  SessionModelSelectionIntentV1Schema,
} from '@happier-dev/protocol';

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
    metadataKey: ProviderSessionIdMetadataKey;
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
}>): Readonly<{
  update<TMetadata extends SessionMetadata>(metadata: TMetadata): TMetadata;
  readState(): Readonly<{ accepted: boolean; updatedAt: number | null }>;
}> {
  const selection = ProviderBoundModelRefSchema.parse(input.selection);
  const nowMs = input.nowMs ?? Date.now;
  let updatedAt: number | null = null;
  let accepted = false;

  return Object.freeze({
    update<TMetadata extends SessionMetadata>(metadata: TMetadata): TMetadata {
      accepted = false;
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
      return next;
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
