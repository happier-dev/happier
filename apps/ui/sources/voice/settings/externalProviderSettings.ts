import {
  compilePluginJsonSchema,
  isValidPluginJsonSchemaValue,
  ConnectedServiceBindingsV1Schema,
  PersistedConnectedServiceBindingsV1Schema,
  readBuiltInLegacyConnectedAccountServiceKeyIngress,
  type ConnectedServiceId,
  type PluginSettingFieldV2,
  type VoiceProviderSettings,
  type VoiceProviderSettingsPresentation,
  type VoiceProviderSettingsJsonValueV1,
} from '@happier-dev/protocol';

export type ExternalVoiceProviderSettingsDescriptor = Readonly<{
  schemaVersion: 1 | 2;
  fields: readonly PluginSettingFieldV2[];
  privacyDisclosure: string | Readonly<{ key: string; fallback: string }> | null;
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
  return ConnectedServiceBindingsV1Schema.safeParse(selectedBinding).success;
}

export function projectExternalVoiceProviderSettings(
  envelope: Readonly<{ schemaVersion: number; config: unknown }> | null,
  settings: ExternalVoiceProviderSettingsDescriptor,
  modeId = 'default',
) {
  if (!envelope) return { status: 'needs_migration' as const, modeId: null };
  if (envelope.schemaVersion !== settings.schemaVersion) {
    return { status: 'unsupported_version' as const, modeId: null };
  }
  const config = settings.parseConfig(envelope.config);
  if (config === null) {
    return { status: 'invalid' as const, modeId: null };
  }
  if (!hasRequiredConnectedServicesBinding(config, settings)) {
    return { status: 'missing_required_setting' as const, modeId };
  }
  return { status: 'ready' as const, modeId };
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
  const validate = compilePluginJsonSchema({
    type: 'object',
    properties: {
      ...Object.fromEntries(fields.map((field) => [field.id, field.schema])),
    },
    required: fields.map((field) => field.id),
    additionalProperties: false,
  });
  const defaultFieldConfig = connectedServicesBinding
    ? Object.fromEntries(
        Object.entries(defaultConfig).filter(([key]) => key !== connectedServicesBinding.id),
      )
    : defaultConfig;
  if (!isValidPluginJsonSchemaValue(validate, defaultFieldConfig)) {
    throw new Error('invalid_external_voice_provider_settings_defaults');
  }
  return Object.freeze({
    schemaVersion: settings?.schemaVersion ?? 1,
    fields,
    privacyDisclosure,
    presentation,
    connectedServicesBinding,
    defaultConfig,
    parseConfig(config: unknown): VoiceProviderSettingsJsonValueV1 | null {
      if (!config || typeof config !== 'object' || Array.isArray(config)) return null;
      const record = config as Readonly<Record<string, unknown>>;
      const fieldConfig = connectedServicesBinding
        ? Object.fromEntries(
            Object.entries(record).filter(([key]) => key !== connectedServicesBinding.id),
          )
        : record;
      if (!isValidPluginJsonSchemaValue(validate, fieldConfig)) return null;
      if (!connectedServicesBinding) return cloneJson(config);
      const expectedKeys = new Set([
        ...fields.map((field) => field.id),
        connectedServicesBinding.id,
      ]);
      if (Object.keys(record).some((key) => !expectedKeys.has(key))
        || Object.keys(record).length !== expectedKeys.size) return null;
      const rawBinding = record[connectedServicesBinding.id];
      if (rawBinding !== null) {
        const parsed = PersistedConnectedServiceBindingsV1Schema.safeParse(rawBinding);
        if (!parsed.success) return null;
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
      return cloneJson(config);
    },
  });
}
