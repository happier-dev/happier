import type { AgentRuntimeKind } from '../../runtimeKinds.js';
import {
  asRecord,
  normalizeTrimmedString,
} from './runtimeDescriptorShared.js';
import type {
  RuntimeDescriptorReaderMap,
  SharedRuntimeDescriptorByProviderId,
  SupportedRuntimeDescriptorProviderId,
} from './runtimeDescriptorTypes.js';

type RuntimeKindAlias = Readonly<{
  input: string;
  runtimeKind: AgentRuntimeKind;
}>;

type RuntimeKindNormalizerConfig = Readonly<{
  aliases: readonly RuntimeKindAlias[];
  caseInsensitive?: boolean;
}>;

type GeneratedRuntimeDescriptorFieldKind =
  | 'runtimeKind'
  | 'trimmedString'
  | 'loopbackHttpOrigin'
  | 'booleanTrue';

type GeneratedRuntimeDescriptorFieldConfig = Readonly<{
  key: string;
  sourceKey?: string;
  kind: GeneratedRuntimeDescriptorFieldKind;
  runtimeHandle?: 'whenPresent' | 'booleanTrue';
  requiresField?: string;
}>;

type GeneratedRuntimeDescriptorLegacyConfig = Readonly<{
  fields: readonly GeneratedRuntimeDescriptorFieldConfig[];
  defaultRuntimeKindWhenAnyFieldPresent?: AgentRuntimeKind;
  requireRuntimeKind?: boolean;
}>;

export type GeneratedRuntimeDescriptorReaderConfig<
  TProviderId extends SupportedRuntimeDescriptorProviderId = SupportedRuntimeDescriptorProviderId,
> = Readonly<{
  providerId: TProviderId;
  runtimeKind: RuntimeKindNormalizerConfig;
  backendModeKey?: string;
  fields: readonly GeneratedRuntimeDescriptorFieldConfig[];
  legacy?: GeneratedRuntimeDescriptorLegacyConfig;
}>;

function normalizeRuntimeKindValue(
  value: unknown,
  config: RuntimeKindNormalizerConfig,
): AgentRuntimeKind | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const candidate = config.caseInsensitive ? trimmed.toLowerCase() : trimmed;
  for (const alias of config.aliases) {
    const input = config.caseInsensitive ? alias.input.toLowerCase() : alias.input;
    if (candidate === input) return alias.runtimeKind;
  }
  return null;
}

function normalizeLoopbackHttpOrigin(value: unknown): string | null {
  const raw = normalizeTrimmedString(value);
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (parsed.username || parsed.password) return null;
    if (parsed.protocol === 'http:') {
      const hostname = parsed.hostname.trim().toLowerCase();
      const isLoopback =
        hostname === 'localhost'
        || hostname === '127.0.0.1'
        || hostname === '::1'
        || hostname === '[::1]';
      if (!isLoopback) return null;
    }
    return parsed.origin.endsWith('/') ? parsed.origin : `${parsed.origin}/`;
  } catch {
    return null;
  }
}

function normalizeBooleanTrue(value: unknown): boolean {
  if (value === true) return true;
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function normalizeFieldValue(
  value: unknown,
  field: GeneratedRuntimeDescriptorFieldConfig,
  runtimeKindConfig: RuntimeKindNormalizerConfig,
): unknown {
  if (field.kind === 'runtimeKind') {
    return normalizeRuntimeKindValue(value, runtimeKindConfig);
  }
  if (field.kind === 'trimmedString') {
    return normalizeTrimmedString(value);
  }
  if (field.kind === 'loopbackHttpOrigin') {
    return normalizeLoopbackHttpOrigin(value);
  }
  return normalizeBooleanTrue(value);
}

function hasMeaningfulFieldValue(value: unknown, field: GeneratedRuntimeDescriptorFieldConfig): boolean {
  if (field.kind === 'booleanTrue') return value === true;
  return value !== null && value !== undefined;
}

function isPresentFieldValue(value: unknown): boolean {
  return value !== null && value !== undefined && value !== false;
}

function collectRuntimeHandle(
  fields: readonly GeneratedRuntimeDescriptorFieldConfig[],
  values: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> | null {
  const runtimeHandle: Record<string, unknown> = {};
  for (const field of fields) {
    const value = values[field.key];
    if (field.runtimeHandle === 'booleanTrue') {
      if (value === true) runtimeHandle[field.key] = true;
      continue;
    }
    if (field.runtimeHandle === 'whenPresent' && value !== null && value !== undefined) {
      runtimeHandle[field.key] = value;
    }
  }
  return Object.keys(runtimeHandle).length > 0 ? runtimeHandle : null;
}

function readLegacyRuntimeDescriptorValues(
  metadataRecord: Record<string, unknown>,
  config: GeneratedRuntimeDescriptorReaderConfig,
): Record<string, unknown> | null {
  const legacy = config.legacy;
  if (!legacy) return null;

  const values: Record<string, unknown> = {};
  for (const field of legacy.fields) {
    const rawValue = metadataRecord[field.sourceKey ?? field.key];
    const normalizedValue = normalizeFieldValue(rawValue, field, config.runtimeKind);
    values[field.key] = normalizedValue;
  }

  for (const field of legacy.fields) {
    if (!field.requiresField) continue;
    if (!isPresentFieldValue(values[field.requiresField])) {
      values[field.key] = field.kind === 'booleanTrue' ? false : null;
    }
  }

  const backendModeKey = config.backendModeKey;
  const runtimeKind = backendModeKey ? values[backendModeKey] : null;
  const hasAnyOutput = Object.values(values).some((value) => value !== null && value !== undefined && value !== false);
  if (!runtimeKind && legacy.defaultRuntimeKindWhenAnyFieldPresent && hasAnyOutput) {
    values[backendModeKey ?? 'runtimeKind'] = legacy.defaultRuntimeKindWhenAnyFieldPresent;
  }

  if (legacy.requireRuntimeKind && backendModeKey && !values[backendModeKey]) return null;
  return hasAnyOutput ? values : null;
}

export function readGeneratedRuntimeDescriptorFromMetadata<
  TProviderId extends SupportedRuntimeDescriptorProviderId,
>(
  metadata: unknown,
  config: GeneratedRuntimeDescriptorReaderConfig<TProviderId>,
): SharedRuntimeDescriptorByProviderId[TProviderId] | null {
  const metadataRecord = asRecord(metadata);
  if (!metadataRecord) return null;

  const legacyValues = readLegacyRuntimeDescriptorValues(metadataRecord, config);
  if (!legacyValues) return null;

  const values: Record<string, unknown> = {};
  for (const field of config.fields) {
    const legacyValue = legacyValues?.[field.key] ?? null;
    values[field.key] = field.kind === 'booleanTrue'
      ? legacyValue === true
      : legacyValue;
  }

  for (const field of config.fields) {
    if (!field.requiresField) continue;
    if (!isPresentFieldValue(values[field.requiresField])) {
      values[field.key] = field.kind === 'booleanTrue' ? false : null;
    }
  }

  const backendModeKey = config.backendModeKey;
  const backendMode = backendModeKey ? values[backendModeKey] ?? null : null;
  const providerSessionId = values.providerSessionId ?? null;
  const sharedDescriptor = {
    agentId: config.providerId,
    runtimeKind: backendMode,
    ...(backendModeKey === 'backendMode' ? { backendMode } : {}),
    ...values,
    providerSessionId,
    runtimeHandle: collectRuntimeHandle(config.fields, values),
  };

  return sharedDescriptor as unknown as SharedRuntimeDescriptorByProviderId[TProviderId];
}

export function createGeneratedRuntimeDescriptorReader<
  TProviderId extends SupportedRuntimeDescriptorProviderId,
>(
  config: GeneratedRuntimeDescriptorReaderConfig<TProviderId>,
): RuntimeDescriptorReaderMap[TProviderId] {
  return ((metadataRecord: Record<string, unknown>) => readGeneratedRuntimeDescriptorFromMetadata(
    metadataRecord,
    config,
  )) as RuntimeDescriptorReaderMap[TProviderId];
}
