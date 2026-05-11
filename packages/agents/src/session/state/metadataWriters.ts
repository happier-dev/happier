import type { RuntimeDescriptorV1, SessionMetadata } from '@happier-dev/protocol';

import type { SessionStateFieldWriteValue } from './_types.js';
import {
  writeAcpConfigOptionIntentToMetadata,
  writeAcpSessionModeIntentToMetadata,
  writeModelIntentToMetadata,
  writePermissionModeIntentToMetadata,
} from './bindings/intent.js';
import { writeRuntimeDescriptorSessionState } from './bindings/runtimeDescriptor.js';
import { summaryTextBinding } from './bindings/summaryText.js';
import { writeVendorSessionIdSessionState, type VendorSessionIdMetadataKey } from './bindings/vendorSessionId.js';
import { clearSessionStateFieldFromMetadata } from './bindings/publishField.js';

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

export function applyVendorSessionIdSessionMetadata<TMetadata extends Record<string, unknown>>(
  metadata: TMetadata,
  update: Readonly<{
    metadataKey: VendorSessionIdMetadataKey;
    value: string | null | undefined;
  }>,
): TMetadata {
  return writeVendorSessionIdSessionState(metadata, update);
}

export function buildVendorSessionIdSessionMetadata(
  update: Readonly<{
    metadataKey: VendorSessionIdMetadataKey;
    value: string | null | undefined;
  }>,
): SessionMetadata {
  return applyVendorSessionIdSessionMetadata({}, update);
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
