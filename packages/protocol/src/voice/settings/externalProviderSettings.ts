import { createPluginJsonSchemaZodValueAdapter } from '../../plugins/actions/jsonSchemaValidation.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';
import { ConnectedServiceBindingsV1Schema, PersistedConnectedServiceBindingsV1Schema, readBuiltInLegacyConnectedAccountServiceKeyIngress, type ConnectedServiceId } from '../../connect/connectedServiceBindings.js';
import type { PluginSettingFieldV2 } from '../../plugins/contributions/settings.js';
import type { VoiceProviderSettings, VoiceProviderSettingsPresentation } from '../../plugins/contributions/voiceProviders.js';
import type { VoiceProviderSettingsJsonValueV1 } from '../realtime/providerSettings.js';
import type { VoiceProviderSettingsProjection } from './providerRegistry.js';

export type ExternalVoiceProviderSettingsDescriptor = Readonly<{
  schemaVersion: 1 | 2;
  fields: readonly PluginSettingFieldV2[];
  privacyDisclosure: string | Readonly<{ key: string; fallback: string }> | null;
  privacyFacts?: VoiceProviderSettings['privacyFacts'] | null;
  presentation: VoiceProviderSettingsPresentation | null;
  connectedServicesBinding: Readonly<{
    id: string;
    title: string | Readonly<{ key: string; fallback: string }>;
    description?: string | Readonly<{ key: string; fallback: string }>;
    agent: string | Readonly<{ pluginId: string; localId: string }>;
    serviceIds: readonly ConnectedServiceId[];
  }> | null;
  defaultConfig: Readonly<Record<string, VoiceProviderSettingsJsonValueV1>>;
  parseConfig(config: unknown): VoiceProviderSettingsJsonValueV1 | null;
  parseStoredConfig(config: unknown): VoiceProviderSettingsJsonValueV1 | null;
}>;

function hasRequiredConnectedServicesBinding(
  config: unknown,
  settings: ExternalVoiceProviderSettingsDescriptor,
): boolean {
  const binding = settings.connectedServicesBinding;
  if (!binding) return true;
  if (!config || typeof config !== 'object' || Array.isArray(config)) return false;
  const selectedBinding = (config as Readonly<Record<string, unknown>>)[binding.id];
  return selectedBinding !== null && selectedBinding !== undefined;
}

export function isExternalVoiceProviderConnectedServicesBindingReady(
  envelope: Readonly<{ schemaVersion: number; config: unknown }> | null,
  settings: ExternalVoiceProviderSettingsDescriptor,
): boolean {
  const binding = settings.connectedServicesBinding;
  if (!binding) return true;
  if (!envelope || envelope.schemaVersion !== settings.schemaVersion) return false;
  if (!envelope.config || typeof envelope.config !== 'object' || Array.isArray(envelope.config)) return false;
  const selectedBinding = (envelope.config as Readonly<Record<string, unknown>>)[binding.id];
  return createStoredReadSchema(ConnectedServiceBindingsV1Schema).safeParse(selectedBinding).success;
}

export function projectExternalVoiceProviderSettings(
  envelope: Readonly<{ schemaVersion: number; config: unknown }> | null,
  settings: ExternalVoiceProviderSettingsDescriptor,
  modeId = 'default',
  projectConfig?: (config: VoiceProviderSettingsJsonValueV1,
    projection: VoiceProviderSettingsProjection & Readonly<{ status: 'ready' | 'missing_required_setting' }>) => VoiceProviderSettingsProjection,
): VoiceProviderSettingsProjection {
  if (!envelope) return { status: 'needs_migration' as const, modeId: null };
  if (envelope.schemaVersion !== settings.schemaVersion) {
    return { status: 'unsupported_version' as const, modeId: null };
  }
  const config = settings.parseStoredConfig(envelope.config);
  if (config === null) {
    return { status: 'invalid' as const, modeId: null };
  }
  const projection = { status: hasRequiredConnectedServicesBinding(config, settings)
    ? 'ready' as const : 'missing_required_setting' as const, modeId };
  return projectConfig ? projectConfig(config, projection) : projection;
}

function cloneJson(value: unknown): VoiceProviderSettingsJsonValueV1 {
  return JSON.parse(JSON.stringify(value)) as VoiceProviderSettingsJsonValueV1;
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

export function createExternalVoiceProviderSettingsDescriptor(
  settings: VoiceProviderSettings | undefined,
): ExternalVoiceProviderSettingsDescriptor {
  const fields = deepFreeze(cloneJson(settings?.fields ?? [])) as unknown as readonly PluginSettingFieldV2[];
  const privacyDisclosure = settings?.privacyDisclosure
    ? deepFreeze(cloneJson(settings.privacyDisclosure)) as ExternalVoiceProviderSettingsDescriptor['privacyDisclosure']
    : null;
  const privacyFacts = settings?.privacyFacts
    ? deepFreeze(cloneJson(settings.privacyFacts)) as ExternalVoiceProviderSettingsDescriptor['privacyFacts']
    : null;
  const presentation = settings?.presentation
    ? deepFreeze(cloneJson(settings.presentation)) as unknown as VoiceProviderSettingsPresentation
    : null;
  const connectedServicesBinding = settings?.connectedServicesBinding
    ? deepFreeze(cloneJson(settings.connectedServicesBinding)) as unknown as NonNullable<
        ExternalVoiceProviderSettingsDescriptor['connectedServicesBinding']
      >
    : null;
  const mutableDefaultConfig: Record<string, VoiceProviderSettingsJsonValueV1> = {};
  for (const field of fields) {
    if (field.default === undefined) {
      throw new Error('invalid_external_voice_provider_settings_defaults');
    }
    mutableDefaultConfig[field.id] = field.default;
  }
  if (connectedServicesBinding) {
    mutableDefaultConfig[connectedServicesBinding.id] = null;
  }
  const defaultConfig: Readonly<Record<string, VoiceProviderSettingsJsonValueV1>> = deepFreeze(
    mutableDefaultConfig,
  );
  // Every caller passes a declaration admitted by VoiceProviderContributionSchema,
  // which already checked each field default against its own schema. A descriptor
  // exists for every bundled provider while the first Account settings parse runs,
  // but only providers with a stored config parse one, so compile on first parse.
  let configSchemas: Readonly<{ current: ReturnType<typeof createPluginJsonSchemaZodValueAdapter>;
    stored: ReturnType<typeof createPluginJsonSchemaZodValueAdapter> }> | undefined;
  const readConfigSchemas = () => {
    if (configSchemas) return configSchemas;
    const current = createPluginJsonSchemaZodValueAdapter({
      type: 'object',
      properties: {
        ...Object.fromEntries(fields.map((field) => [field.id, field.schema])),
      },
      required: fields.map((field) => field.id),
      additionalProperties: false,
    });
    configSchemas = { current, stored: createStoredReadSchema(current) };
    return configSchemas;
  };
  return Object.freeze({
    schemaVersion: settings?.schemaVersion ?? 1,
    fields,
    privacyDisclosure,
    privacyFacts,
    presentation,
    connectedServicesBinding,
    defaultConfig,
    parseConfig: (config: unknown) => parseConfig(config, false),
    parseStoredConfig: (config: unknown) => parseConfig(config, true),
  });

  function parseConfig(config: unknown, stored: boolean): VoiceProviderSettingsJsonValueV1 | null {
    if (!config || typeof config !== 'object' || Array.isArray(config)) return null;
    const record = config as Readonly<Record<string, unknown>>;
    const fieldConfig = connectedServicesBinding
      ? Object.fromEntries(
          Object.entries(record).filter(([key]) => key !== connectedServicesBinding.id),
        )
      : record;
    const schemas = readConfigSchemas();
    const parsedFields = (stored ? schemas.stored : schemas.current).safeParse(fieldConfig);
    if (!parsedFields.success || parsedFields.data === null
      || typeof parsedFields.data !== 'object' || Array.isArray(parsedFields.data)) return null;
    if (!connectedServicesBinding) return cloneJson(parsedFields.data);
    const expectedKeys = new Set([
      ...fields.map((field) => field.id),
      connectedServicesBinding.id,
    ]);
    if (!stored && (Object.keys(record).some((key) => !expectedKeys.has(key))
      || Object.keys(record).length !== expectedKeys.size)) return null;
    const rawBinding = record[connectedServicesBinding.id];
    let normalizedBinding: unknown = rawBinding;
    if (rawBinding !== null) {
      const parsed = (stored ? createStoredReadSchema(PersistedConnectedServiceBindingsV1Schema)
        : PersistedConnectedServiceBindingsV1Schema).safeParse(rawBinding);
      if (!parsed.success) return null;
      normalizedBinding = parsed.data;
      const requiredServiceIds = new Set(connectedServicesBinding.serviceIds.map((serviceId) => {
        const serviceKey = readBuiltInLegacyConnectedAccountServiceKeyIngress(serviceId);
        if (!serviceKey) throw new Error('invalid_external_voice_provider_connected_service');
        return serviceKey;
      }));
      const bindings = Object.entries(parsed.data.bindingsByServiceId);
      if (bindings.length !== requiredServiceIds.size
        || bindings.some(([serviceId, binding]) => (
          !requiredServiceIds.has(serviceId as ConnectedServiceId)
          || binding.source !== 'connected'
        ))) return null;
    }
    return cloneJson(stored
      ? { ...parsedFields.data, [connectedServicesBinding.id]: normalizedBinding }
      : config);
  }
}
