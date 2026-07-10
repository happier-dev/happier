import type {
  AcpConfigOptionIntentV1,
  AcpConfigOptionOverridesV1,
  AcpSessionModeIntentV1,
  ModelOverrideV1,
  SessionModelSelectionIntentReadCompatV1,
  SessionModelSelectionIntentV1,
  PermissionModeIntentV1,
  SessionMetadata,
} from '@happier-dev/protocol';
import {
  AcpConfigOptionOverridesV1Schema,
  AcpSessionModeOverrideV1Schema,
  ModelOverrideV1Schema,
  SessionModelSelectionIntentV1Schema,
} from '@happier-dev/protocol';

import { parsePermissionIntentAlias } from '../../../permissions/index.js';
import { resolveTimestampedFieldUpdate } from '../../timestamps/resolveTimestampedFieldUpdate.js';
import type { SessionStateBinding } from './_types.js';
import {
  LEGACY_ACP_CONFIG_OPTION_OVERRIDES_KEY,
  LEGACY_ACP_SESSION_MODE_OVERRIDE_KEY,
  MODEL_OVERRIDE_KEY,
  MODEL_SELECTION_INTENT_KEY,
  PERMISSION_MODE_KEY,
  PERMISSION_MODE_UPDATED_AT_KEY,
  SESSION_CONFIG_OPTION_OVERRIDES_KEY,
  SESSION_MODE_OVERRIDE_KEY,
  getIntentMetadataKeysForAlias,
} from './metadataKeys.js';

type MetadataRecord = Record<string, unknown>;
type StringOverrideValueKey = 'modelId' | 'modeId';

function asRecord(value: unknown): MetadataRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as MetadataRecord;
}

function asFiniteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function readStringOverrideIntentFromMetadata(params: Readonly<{
  metadata: MetadataRecord;
  overrideKey: string;
  valueKey: string;
}>): { value: string | null; updatedAt: number } | null {
  if (params.valueKey !== 'modelId' && params.valueKey !== 'modeId') return null;
  const parsed = params.valueKey === 'modelId'
    ? ModelOverrideV1Schema.safeParse(params.metadata[params.overrideKey])
    : AcpSessionModeOverrideV1Schema.safeParse(params.metadata[params.overrideKey]);
  if (!parsed.success) return null;

  const value = parsed.data[params.valueKey];
  return {
    value: typeof value === 'string' && value.trim() ? value.trim() : null,
    updatedAt: asFiniteNumber(parsed.data.updatedAt),
  };
}

function readLatestStringOverrideIntentFromMetadata(params: Readonly<{
  metadata: MetadataRecord;
  overrideKeys: readonly string[];
  valueKey: string;
}>): { value: string | null; updatedAt: number } | null {
  let latest: { value: string | null; updatedAt: number } | null = null;
  for (const overrideKey of params.overrideKeys) {
    const candidate = readStringOverrideIntentFromMetadata({
      metadata: params.metadata,
      overrideKey,
      valueKey: params.valueKey,
    });
    if (!candidate) continue;
    if (!latest || candidate.updatedAt > latest.updatedAt) {
      latest = candidate;
    }
  }
  return latest;
}

export function writeStringOverrideIntentToMetadata(params: Readonly<{
  metadata: MetadataRecord;
  overrideKey: string;
  valueKey: StringOverrideValueKey;
  value: string | null;
  updatedAt: number;
}>): MetadataRecord {
  const overrideKey = asTrimmedString(params.overrideKey);
  if (!overrideKey) return params.metadata;

  const rawValue = typeof params.value === 'string' ? params.value.trim() : '';
  const isClear = !rawValue;
  const overrideKeys = getIntentMetadataKeysForAlias(overrideKey);
  const current = readLatestStringOverrideIntentFromMetadata({
    metadata: params.metadata,
    overrideKeys,
    valueKey: params.valueKey,
  });
  const result = resolveTimestampedFieldUpdate({
    current: current
      ? { value: current.value ?? '__cleared__', updatedAt: current.updatedAt }
      : null,
    candidate: {
      value: isClear ? '__cleared__' : rawValue,
      updatedAt: asFiniteNumber(params.updatedAt),
    },
    staleBehavior: 'bump-if-value-changed',
  });
  if (!result.accepted) return params.metadata;

  const nextOverride = {
    v: 1,
    updatedAt: result.updatedAt,
    [params.valueKey]: isClear ? null : rawValue,
  };

  const nextMetadata: MetadataRecord = { ...params.metadata };
  for (const key of overrideKeys) {
    nextMetadata[key] = nextOverride;
  }
  return nextMetadata;
}

export function readModelIntentFromMetadata(metadata: SessionMetadata): SessionModelSelectionIntentReadCompatV1 | null {
  const record = metadata as MetadataRecord;
  const canonical = SessionModelSelectionIntentV1Schema.safeParse(record[MODEL_SELECTION_INTENT_KEY]);
  const legacy = ModelOverrideV1Schema.safeParse(record[MODEL_OVERRIDE_KEY]);
  if (!canonical.success) return legacy.success ? legacy.data : null;
  if (!legacy.success || canonical.data.updatedAt >= legacy.data.updatedAt) return canonical.data;
  return legacy.data;
}

export function writeModelIntentToMetadata(
  metadata: SessionMetadata,
  update: SessionModelSelectionIntentV1,
): SessionMetadata {
  const candidate = SessionModelSelectionIntentV1Schema.parse(update);
  const current = readModelIntentFromMetadata(metadata);
  const currentComparable = current && 'selection' in current
    ? current.selection
    : current && current.modelId !== null
      ? { legacyModelId: current.modelId }
      : null;
  const candidateComparable = candidate.selection;
  const result = resolveTimestampedFieldUpdate({
    current: current
      ? { value: currentComparable, updatedAt: current.updatedAt }
      : null,
    candidate: { value: candidateComparable, updatedAt: candidate.updatedAt },
    staleBehavior: 'bump-if-value-changed',
    isEqual: (left, right) => JSON.stringify(left) === JSON.stringify(right),
  });
  if (!result.accepted) return metadata;
  return {
    ...(metadata as MetadataRecord),
    [MODEL_SELECTION_INTENT_KEY]: {
      v: 1,
      updatedAt: result.updatedAt,
      selection: result.value,
    },
  } as SessionMetadata;
}

export function readPermissionModeIntentFromMetadata(
  metadata: SessionMetadata,
): PermissionModeIntentV1 | null {
  const rawMode = asTrimmedString((metadata as MetadataRecord)[PERMISSION_MODE_KEY]);
  if (!rawMode) return null;
  const permissionMode = parsePermissionIntentAlias(rawMode);
  if (!permissionMode) return null;
  return {
    v: 1,
    permissionMode,
    updatedAt: asFiniteNumber((metadata as MetadataRecord)[PERMISSION_MODE_UPDATED_AT_KEY]),
  };
}

export function writePermissionModeIntentToMetadata(
  metadata: SessionMetadata,
  update: Readonly<{ permissionMode: string; updatedAt: number | null }>,
): SessionMetadata {
  const permissionMode = parsePermissionIntentAlias(update.permissionMode);
  if (!permissionMode) return metadata;
  if (update.updatedAt === null) {
    const nextMetadata: MetadataRecord = { ...(metadata as MetadataRecord), [PERMISSION_MODE_KEY]: permissionMode };
    delete nextMetadata[PERMISSION_MODE_UPDATED_AT_KEY];
    return nextMetadata as SessionMetadata;
  }

  const current = readPermissionModeIntentFromMetadata(metadata);
  const result = resolveTimestampedFieldUpdate({
    current: current
      ? { value: current.permissionMode, updatedAt: current.updatedAt }
      : null,
    candidate: {
      value: permissionMode,
      updatedAt: asFiniteNumber(update.updatedAt),
    },
    staleBehavior: 'drop',
  });
  if (!result.accepted) return metadata;

  return {
    ...(metadata as MetadataRecord),
    [PERMISSION_MODE_KEY]: result.value,
    [PERMISSION_MODE_UPDATED_AT_KEY]: result.updatedAt,
  } as SessionMetadata;
}

export function readAcpSessionModeIntentFromMetadata(
  metadata: SessionMetadata,
): AcpSessionModeIntentV1 | null {
  const current = readLatestStringOverrideIntentFromMetadata({
    metadata: metadata as MetadataRecord,
    overrideKeys: getIntentMetadataKeysForAlias(SESSION_MODE_OVERRIDE_KEY),
    valueKey: 'modeId',
  });
  return current
    ? { v: 1, modeId: current.value, updatedAt: current.updatedAt }
    : null;
}

export function writeAcpSessionModeIntentToMetadata(
  metadata: SessionMetadata,
  update: Readonly<{ modeId: string | null; updatedAt: number }>,
): SessionMetadata {
  return writeStringOverrideIntentToMetadata({
    metadata: metadata as MetadataRecord,
    overrideKey: SESSION_MODE_OVERRIDE_KEY,
    valueKey: 'modeId',
    value: update.modeId,
    updatedAt: update.updatedAt,
  }) as SessionMetadata;
}

function readAcpConfigOptionRoot(metadata: SessionMetadata): {
  updatedAt: number;
  overrides: Record<string, { updatedAt: number; value: string | number | boolean | null }>;
} | null {
  const record = metadata as MetadataRecord;
  const parsedRoots = [
    AcpConfigOptionOverridesV1Schema.safeParse(record[SESSION_CONFIG_OPTION_OVERRIDES_KEY]),
    AcpConfigOptionOverridesV1Schema.safeParse(record[LEGACY_ACP_CONFIG_OPTION_OVERRIDES_KEY]),
  ].filter((parsed): parsed is { success: true; data: AcpConfigOptionOverridesV1 } => parsed.success);
  if (parsedRoots.length === 0) return null;

  const overrides: Record<string, { updatedAt: number; value: string | number | boolean | null }> = {};
  let rootUpdatedAt = 0;
  for (const parsed of parsedRoots) {
    rootUpdatedAt = Math.max(rootUpdatedAt, asFiniteNumber(parsed.data.updatedAt));
    for (const [configId, entry] of Object.entries(parsed.data.overrides)) {
      const normalizedConfigId = asTrimmedString(configId);
      if (!normalizedConfigId) continue;
      const current = overrides[normalizedConfigId];
      const updatedAt = asFiniteNumber(entry.updatedAt);
      if (current && updatedAt <= asFiniteNumber(current.updatedAt)) continue;
      overrides[normalizedConfigId] = {
        updatedAt,
        value: entry.value,
      };
      rootUpdatedAt = Math.max(rootUpdatedAt, updatedAt);
    }
  }

  return {
    updatedAt: rootUpdatedAt,
    overrides,
  };
}

export function readAcpConfigOptionIntentFromMetadata(
  metadata: SessionMetadata,
  configId: string,
): AcpConfigOptionIntentV1 | null {
  const normalizedConfigId = asTrimmedString(configId);
  if (!normalizedConfigId) return null;
  const root = readAcpConfigOptionRoot(metadata);
  const entry = root?.overrides[normalizedConfigId];
  return entry
    ? {
      v: 1,
      configId: normalizedConfigId,
      value: entry.value,
      updatedAt: asFiniteNumber(entry.updatedAt),
    }
    : null;
}

export function readLatestAcpConfigOptionIntentFromMetadata(
  metadata: SessionMetadata,
): AcpConfigOptionIntentV1 | null {
  const root = readAcpConfigOptionRoot(metadata);
  if (!root) return null;

  let latest: AcpConfigOptionIntentV1 | null = null;
  for (const [configId, entry] of Object.entries(root.overrides)) {
    const normalizedConfigId = asTrimmedString(configId);
    if (!normalizedConfigId) continue;
    const updatedAt = asFiniteNumber(entry.updatedAt);
    if (latest && updatedAt < latest.updatedAt) continue;
    if (latest && updatedAt === latest.updatedAt && normalizedConfigId >= latest.configId) continue;
    latest = {
      v: 1,
      configId: normalizedConfigId,
      value: entry.value,
      updatedAt,
    };
  }
  return latest;
}

export function writeAcpConfigOptionIntentToMetadata(
  metadata: SessionMetadata,
  update: Readonly<{ configId: string; value: string | number | boolean | null; updatedAt: number }>,
): SessionMetadata {
  const configId = asTrimmedString(update.configId);
  if (!configId) return metadata;
  const value = update.value === null
    ? null
    : typeof update.value === 'string'
      ? update.value.trim()
      : update.value;
  if (value === '') return metadata;

  const root = readAcpConfigOptionRoot(metadata);
  const currentEntry = root?.overrides[configId];
  const result = resolveTimestampedFieldUpdate({
    current: currentEntry
      ? { value: currentEntry.value, updatedAt: asFiniteNumber(currentEntry.updatedAt) }
      : null,
    candidate: {
      value,
      updatedAt: asFiniteNumber(update.updatedAt),
    },
    staleBehavior: 'drop',
    isEqual: (left, right) => JSON.stringify(left) === JSON.stringify(right),
  });
  if (!result.accepted) return metadata;

  const nextOverrides = { ...(root?.overrides ?? {}) };
  nextOverrides[configId] = {
    updatedAt: result.updatedAt,
    value: result.value,
  };
  const nextRoot = {
    v: 1,
    updatedAt: Math.max(root?.updatedAt ?? 0, result.updatedAt),
    overrides: nextOverrides,
  };

  const nextMetadata: MetadataRecord = { ...(metadata as MetadataRecord) };
  for (const key of getIntentMetadataKeysForAlias(SESSION_CONFIG_OPTION_OVERRIDES_KEY)) {
    nextMetadata[key] = nextRoot;
  }
  return nextMetadata as SessionMetadata;
}

export const modelIntentBinding = {
  read: (metadata) => {
    const value = readModelIntentFromMetadata(metadata);
    return { value, updatedAt: value?.updatedAt ?? null };
  },
  write: (metadata, update) => writeModelIntentToMetadata(metadata, {
    v: 1,
    selection: update.value.selection,
    updatedAt: update.updatedAt ?? update.value.updatedAt,
  }),
} satisfies SessionStateBinding<'intent.model'>;

export const permissionModeIntentBinding = {
  read: (metadata) => {
    const value = readPermissionModeIntentFromMetadata(metadata);
    return { value, updatedAt: value?.updatedAt ?? null };
  },
  write: (metadata, update) => writePermissionModeIntentToMetadata(metadata, {
    permissionMode: update.value.permissionMode,
    updatedAt: update.updatedAt ?? update.value.updatedAt,
  }),
} satisfies SessionStateBinding<'intent.permissionMode'>;

export const acpSessionModeIntentBinding = {
  read: (metadata) => {
    const value = readAcpSessionModeIntentFromMetadata(metadata);
    return { value, updatedAt: value?.updatedAt ?? null };
  },
  write: (metadata, update) => writeAcpSessionModeIntentToMetadata(metadata, {
    modeId: update.value.modeId,
    updatedAt: update.updatedAt ?? update.value.updatedAt,
  }),
} satisfies SessionStateBinding<'intent.acpSessionMode'>;

export const acpConfigOptionIntentBinding = {
  read: (metadata) => {
    const value = readLatestAcpConfigOptionIntentFromMetadata(metadata);
    return { value, updatedAt: value?.updatedAt ?? null };
  },
  write: (metadata, update) => writeAcpConfigOptionIntentToMetadata(metadata, {
    configId: update.value.configId,
    value: update.value.value,
    updatedAt: update.updatedAt ?? update.value.updatedAt,
  }),
} satisfies SessionStateBinding<'intent.acpConfigOption'>;
