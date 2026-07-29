import {
  compilePluginJsonSchema,
  isValidPluginJsonSchemaValue,
  PersistedConnectedServiceBindingsV1Schema,
  type ConnectedServiceId,
  type PluginVoiceProviderContributionV1,
  type PluginSettingFieldV2,
  type VoiceProviderSettingsJsonValueV1,
} from '@happier-dev/protocol';

type VoiceConversationSettings = NonNullable<Extract<
  PluginVoiceProviderContributionV1,
  Readonly<{ kind: 'conversation' }>
>['settings']>;

export type ExternalVoiceProviderSettingsDescriptor = Readonly<{
  schemaVersion: 1 | 2;
  fields: readonly PluginSettingFieldV2[];
  privacyDisclosure: string | Readonly<{ key: string; fallback: string }> | null;
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

export function isExternalVoiceProviderConnectedServicesBindingReady(
  envelope: Readonly<{ schemaVersion: number; config: unknown }> | null,
  settings: ExternalVoiceProviderSettingsDescriptor,
): boolean {
  const binding = settings.connectedServicesBinding;
  if (!binding) return true;
  if (!envelope || envelope.schemaVersion !== settings.schemaVersion) return false;
  const config = settings.parseConfig(envelope.config);
  if (!config || typeof config !== 'object' || Array.isArray(config)) return false;
  const selectedBinding = (config as Readonly<Record<string, unknown>>)[binding.id];
  return selectedBinding !== null && selectedBinding !== undefined;
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
  if (settings.parseConfig(envelope.config) === null) {
    return { status: 'invalid' as const, modeId: null };
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
  settings: VoiceConversationSettings | undefined,
): ExternalVoiceProviderSettingsDescriptor {
  const fields = deepFreeze(cloneJson(settings?.fields ?? [])) as unknown as readonly PluginSettingFieldV2[];
  const privacyDisclosure = settings?.privacyDisclosure
    ? deepFreeze(cloneJson(settings.privacyDisclosure)) as ExternalVoiceProviderSettingsDescriptor['privacyDisclosure']
    : null;
  const connectedServicesBinding = settings?.connectedServicesBinding
    ? deepFreeze(cloneJson(settings.connectedServicesBinding)) as unknown as NonNullable<
        ExternalVoiceProviderSettingsDescriptor['connectedServicesBinding']
      >
    : null;
  const includesHostMode = fields.length > 0 || !connectedServicesBinding;
  const defaultConfig: Readonly<Record<string, VoiceProviderSettingsJsonValueV1>> = deepFreeze({
    ...(includesHostMode ? { mode: 'default' } : {}),
    ...Object.fromEntries(fields.map((field) => [field.id, field.default])),
    ...(connectedServicesBinding ? { [connectedServicesBinding.id]: null } : {}),
  });
  const validate = compilePluginJsonSchema({
    type: 'object',
    properties: {
      ...(includesHostMode ? { mode: { type: 'string', const: 'default' } } : {}),
      ...Object.fromEntries(fields.map((field) => [field.id, field.schema])),
    },
    required: [...(includesHostMode ? ['mode'] : []), ...fields.map((field) => field.id)],
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
        ...(includesHostMode ? ['mode'] : []),
        ...fields.map((field) => field.id),
        connectedServicesBinding.id,
      ]);
      if (Object.keys(record).some((key) => !expectedKeys.has(key))
        || Object.keys(record).length !== expectedKeys.size) return null;
      const rawBinding = record[connectedServicesBinding.id];
      if (rawBinding !== null) {
        const parsed = PersistedConnectedServiceBindingsV1Schema.safeParse(rawBinding);
        if (!parsed.success) return null;
        const requiredServiceIds = new Set(connectedServicesBinding.serviceIds);
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
