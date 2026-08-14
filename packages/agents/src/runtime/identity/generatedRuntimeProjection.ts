import {
  readCanonicalRuntimeDescriptorV1ForAgent,
} from '@happier-dev/protocol/sessions/metadata/runtime-descriptor';
import {
  readRuntimeDescriptorV1FromMetadata,
} from '@happier-dev/protocol/sessions/metadata/runtime-descriptor-compat';

import type { AgentRuntimeKind } from '../../runtimeKinds.js';
import type { ProviderSessionControlAdapter } from '../controlSurface/types.js';
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

type RuntimeKindPathConfig = Readonly<{
  path: readonly string[];
  providerId?: string;
}>;

type GenericStateRuntimeKindConfig = Readonly<{
  fields: readonly string[];
  providerId: string;
  runtimeKind: AgentRuntimeKind;
}>;

type ControlRuntimeKindConfig = Readonly<{
  aliases: readonly RuntimeKindAlias[];
  rawDescriptorPaths?: readonly RuntimeKindPathConfig[];
  metadataPaths?: readonly RuntimeKindPathConfig[];
  genericState?: GenericStateRuntimeKindConfig;
}>;

type RuntimeKindOverrideConfig = RuntimeKindNormalizerConfig & Readonly<{
  accountSettingsField?: string;
  fallbackRuntimeKind?: AgentRuntimeKind;
}>;

type ConfiguredRuntimeKindConfig = RuntimeKindNormalizerConfig & Readonly<{
  accountSettingsField: string;
  defaultRuntimeKind?: AgentRuntimeKind;
  booleanTrueField?: string;
  booleanTrueRuntimeKind?: AgentRuntimeKind;
}>;

type ExperimentalGateConfig = Readonly<{
  runtimeKinds: readonly AgentRuntimeKind[];
  accountSettingsField: string;
  accountSettingsValues: readonly string[];
  booleanTrueField?: string;
  requireConfiguredRuntimeKind?: boolean;
}>;

export type GeneratedRuntimeProjectionSessionControlAdapterConfig<
  TProviderId extends SupportedRuntimeDescriptorProviderId = SupportedRuntimeDescriptorProviderId,
> = Readonly<{
  providerId: TProviderId;
  runtimeDescriptor: GeneratedRuntimeDescriptorReaderConfig<TProviderId>;
  runtimeKindOverride?: RuntimeKindOverrideConfig;
  configuredRuntimeKind?: ConfiguredRuntimeKindConfig;
  controlRuntimeKind?: ControlRuntimeKindConfig;
  vendorResumeId?: Readonly<{
    descriptorField: string;
    legacyField?: string;
  }>;
  experimentalVendorResume?: ExperimentalGateConfig;
  experimentalVendorHandoff?: ExperimentalGateConfig;
}>;

function readPath(value: unknown, path: readonly string[]): unknown {
  let current: unknown = value;
  for (const segment of path) {
    const record = asRecord(current);
    if (!record) return undefined;
    current = record[segment];
  }
  return current;
}

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

  const descriptorInput = readRuntimeDescriptorV1FromMetadata(metadataRecord);
  const canonical = readCanonicalRuntimeDescriptorV1ForAgent(descriptorInput, config.providerId);
  const legacyValues = readLegacyRuntimeDescriptorValues(metadataRecord, config);
  if (!canonical && !legacyValues) return null;

  const values: Record<string, unknown> = {};
  for (const field of config.fields) {
    const canonicalValue = canonical
      ? normalizeFieldValue(canonical[field.sourceKey ?? field.key], field, config.runtimeKind)
      : null;
    const legacyValue = legacyValues?.[field.key] ?? null;
    values[field.key] = field.kind === 'booleanTrue'
      ? Boolean(canonicalValue === true || legacyValue === true)
      : canonicalValue ?? legacyValue;
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

function isExplicitSettingEnabled(
  settings: Readonly<Record<string, unknown>>,
  config: ExperimentalGateConfig,
): boolean {
  const settingValue = normalizeTrimmedString(settings[config.accountSettingsField]);
  if (settingValue && config.accountSettingsValues.includes(settingValue)) return true;
  return config.booleanTrueField ? settings[config.booleanTrueField] === true : false;
}

function readRawDescriptorProviderControlKind(
  metadataRecord: Record<string, unknown>,
  config: ControlRuntimeKindConfig,
): AgentRuntimeKind | null {
  const descriptor = asRecord(readRuntimeDescriptorV1FromMetadata(metadataRecord));
  if (!descriptor) return null;
  for (const pathConfig of config.rawDescriptorPaths ?? []) {
    if (pathConfig.providerId && descriptor.agentId !== pathConfig.providerId) continue;
    const runtimeKind = normalizeRuntimeKindValue(readPath(descriptor, pathConfig.path), config);
    if (runtimeKind) return runtimeKind;
  }
  return null;
}

function readMetadataControlKind(
  metadataRecord: Record<string, unknown>,
  config: ControlRuntimeKindConfig,
): AgentRuntimeKind | null {
  for (const pathConfig of config.metadataPaths ?? []) {
    if (pathConfig.providerId) {
      const providerId = readPath(metadataRecord, [...pathConfig.path.slice(0, -1), 'providerId']);
      if (providerId !== pathConfig.providerId) continue;
    }
    const runtimeKind = normalizeRuntimeKindValue(readPath(metadataRecord, pathConfig.path), config);
    if (runtimeKind) return runtimeKind;
  }

  const genericState = config.genericState;
  if (!genericState) return null;
  const hasGenericState = genericState.fields.some((field) => {
    const state = asRecord(metadataRecord[field]);
    // legacy `provider` state-record read-compat (pre-rename persisted metadata)
    return (state?.agentId ?? state?.provider) === genericState.providerId;
  });
  return hasGenericState && normalizeTrimmedString(metadataRecord[`${genericState.providerId}SessionId`])
    ? genericState.runtimeKind
    : null;
}

function resolveControlRuntimeKind(
  metadata: unknown,
  config: GeneratedRuntimeProjectionSessionControlAdapterConfig,
): AgentRuntimeKind | null {
  const metadataRecord = asRecord(metadata);
  if (!metadataRecord) return null;
  if (config.controlRuntimeKind) {
    return readRawDescriptorProviderControlKind(metadataRecord, config.controlRuntimeKind)
      ?? readMetadataControlKind(metadataRecord, config.controlRuntimeKind);
  }
  return readGeneratedRuntimeDescriptorFromMetadata(metadataRecord, config.runtimeDescriptor)?.runtimeKind ?? null;
}

function resolveConfiguredRuntimeKind(
  accountSettings: Record<string, unknown> | null | undefined,
  config: ConfiguredRuntimeKindConfig | undefined,
): AgentRuntimeKind | null {
  if (!config) return null;
  const settings = accountSettings ?? {};
  return normalizeRuntimeKindValue(settings[config.accountSettingsField], config)
    ?? config.defaultRuntimeKind
    ?? (config.booleanTrueField && settings[config.booleanTrueField] === true ? config.booleanTrueRuntimeKind ?? null : null);
}

export function createGeneratedRuntimeProjectionSessionControlAdapter<
  TProviderId extends SupportedRuntimeDescriptorProviderId,
>(
  config: GeneratedRuntimeProjectionSessionControlAdapterConfig<TProviderId>,
): ProviderSessionControlAdapter {
  return Object.freeze({
    normalizeRuntimeKindOverride(value: unknown): AgentRuntimeKind | null {
      return config.runtimeKindOverride
        ? normalizeRuntimeKindValue(value, config.runtimeKindOverride)
        : null;
    },
    applyRuntimeKindOverrideToAccountSettings(
      accountSettings: Record<string, unknown> | null,
      runtimeKind: AgentRuntimeKind,
    ): Record<string, unknown> | null {
      const override = config.runtimeKindOverride;
      if (!override?.accountSettingsField) return accountSettings ?? {};
      const normalized = normalizeRuntimeKindValue(runtimeKind, override) ?? override.fallbackRuntimeKind ?? null;
      return {
        ...(accountSettings ?? {}),
        ...(normalized ? { [override.accountSettingsField]: normalized } : {}),
      };
    },
    resolveConfiguredRuntimeKind(accountSettings?: Record<string, unknown> | null): AgentRuntimeKind | null {
      return resolveConfiguredRuntimeKind(accountSettings, config.configuredRuntimeKind);
    },
    resolvePersistedSessionRuntimeKind(metadata: unknown): AgentRuntimeKind | null {
      return resolveControlRuntimeKind(metadata, config);
    },
    resolveVendorResumeId(metadata: unknown): string | null {
      const descriptor = readGeneratedRuntimeDescriptorFromMetadata(metadata, config.runtimeDescriptor);
      const descriptorValue = config.vendorResumeId
        ? normalizeTrimmedString((descriptor as Record<string, unknown> | null)?.[config.vendorResumeId.descriptorField])
        : null;
      if (descriptorValue) return descriptorValue;
      const metadataRecord = asRecord(metadata);
      return config.vendorResumeId?.legacyField
        ? normalizeTrimmedString(metadataRecord?.[config.vendorResumeId.legacyField])
        : null;
    },
    isExperimentalVendorResumeEnabled(input: Readonly<{
      metadata: unknown;
      accountSettings: Record<string, unknown> | null;
    }>): boolean {
      const gate = config.experimentalVendorResume;
      if (!gate) return false;
      const runtimeKind = resolveControlRuntimeKind(input.metadata, config);
      if (runtimeKind) return gate.runtimeKinds.includes(runtimeKind);
      const configuredRuntimeKind = resolveConfiguredRuntimeKind(input.accountSettings, config.configuredRuntimeKind);
      return (!gate.requireConfiguredRuntimeKind || Boolean(configuredRuntimeKind && gate.runtimeKinds.includes(configuredRuntimeKind)))
        && isExplicitSettingEnabled(input.accountSettings ?? {}, gate);
    },
    isExperimentalVendorHandoffEnabled(input: Readonly<{
      metadata: unknown;
      accountSettings: Record<string, unknown> | null;
    }>): boolean {
      const gate = config.experimentalVendorHandoff;
      if (!gate) return false;
      const runtimeKind = resolveControlRuntimeKind(input.metadata, config);
      if (runtimeKind) return gate.runtimeKinds.includes(runtimeKind);
      return isExplicitSettingEnabled(input.accountSettings ?? {}, gate);
    },
  });
}
