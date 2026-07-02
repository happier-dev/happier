import type {
  RuntimeDescriptorV1,
  SessionMetadata,
  SessionStateFieldId,
  SessionStateFieldValue,
} from '@happier-dev/protocol';

import type { SessionStateFieldWriteValue } from './_types.js';
import {
  writeAcpConfigOptionIntentToMetadata,
  writeAcpSessionModeIntentToMetadata,
  writeModelIntentToMetadata,
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
    modelId: value.modelId,
    updatedAt: value.updatedAt,
  }) as TMetadata;
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
