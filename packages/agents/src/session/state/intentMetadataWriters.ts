import {
  writeAcpConfigOptionIntentToMetadata,
  writeAcpSessionModeIntentToMetadata,
  writePermissionModeIntentToMetadata,
  writeStringOverrideIntentToMetadata,
} from './bindings/intent.js';
import {
  LEGACY_ACP_SESSION_MODE_OVERRIDE_KEY,
  MODEL_OVERRIDE_KEY,
  SESSION_MODE_OVERRIDE_KEY,
} from './bindings/metadataKeys.js';

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function computeNextPermissionIntentMetadata(params: Readonly<{
  metadata: Record<string, unknown>;
  permissionMode: string;
  permissionModeUpdatedAt: number;
}>): Record<string, unknown> {
  return writePermissionModeIntentToMetadata(params.metadata, {
    permissionMode: params.permissionMode,
    updatedAt: params.permissionModeUpdatedAt,
  });
}

export function computeNextMetadataStringOverrideV1(params: Readonly<{
  metadata: Record<string, unknown>;
  overrideKey: string;
  valueKey: string;
  value: string;
  updatedAt: number;
}>): Record<string, unknown> {
  const overrideKey = asTrimmedString(params.overrideKey);
  const valueKey = asTrimmedString(params.valueKey);
  if (!overrideKey || !valueKey) return params.metadata;

  if (overrideKey === MODEL_OVERRIDE_KEY && valueKey === 'modelId') {
    // Deployed modelOverrideV1 is read-only compatibility. New model writes must use
    // SessionModelSelectionIntentV1 through the typed intent.model state publisher.
    return params.metadata;
  }

  if (
    (overrideKey === SESSION_MODE_OVERRIDE_KEY || overrideKey === LEGACY_ACP_SESSION_MODE_OVERRIDE_KEY)
    && valueKey === 'modeId'
  ) {
    return writeAcpSessionModeIntentToMetadata(params.metadata, {
      modeId: params.value,
      updatedAt: params.updatedAt,
    });
  }

  if (valueKey !== 'modeId') return params.metadata;
  return writeStringOverrideIntentToMetadata({
    metadata: params.metadata,
    overrideKey,
    valueKey,
    value: params.value,
    updatedAt: params.updatedAt,
  });
}

export function computeNextMetadataConfigOptionOverrideV1(params: Readonly<{
  metadata: Record<string, unknown>;
  configId: string;
  value: unknown;
  updatedAt: number;
}>): Record<string, unknown> {
  if (typeof params.value !== 'string') return params.metadata;
  const value = params.value.trim();
  if (!value) return params.metadata;
  return writeAcpConfigOptionIntentToMetadata(params.metadata, {
    configId: params.configId,
    value,
    updatedAt: params.updatedAt,
  });
}
