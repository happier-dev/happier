import type { VoiceProviderSettingsActionDeclaration } from '@happier-dev/protocol';

import type { VoiceProviderRegistryEntry } from '@/voice/registry/providerRegistry';

export type BundledSpeechSettingsConfig = Readonly<{
  [key: string]: unknown;
}>;

type BundledSpeechSettingsFieldBase = Readonly<{
  key: string;
  titleKey: string;
  subtitleKey: string;
  nullable: boolean;
}>;

export type BundledSpeechSettingsField =
  | (BundledSpeechSettingsFieldBase & Readonly<{
      kind: 'text';
      minLength: number;
      maxLength: number;
      promptTitleKey?: string;
      promptBodyKey?: string;
    }>)
  | (BundledSpeechSettingsFieldBase & Readonly<{
      kind: 'remote_select';
      catalog: 'models' | 'voices';
      searchPlaceholderKey?: string;
      allowCustom: boolean;
    }>)
  | (BundledSpeechSettingsFieldBase & Readonly<{
      kind: 'language';
      autoTitleKey: string;
      autoSubtitleKey: string;
    }>)
  | (BundledSpeechSettingsFieldBase & Readonly<{
      kind: 'enum';
      options: readonly Readonly<{ id: string; title: string }>[];
    }>)
  | (BundledSpeechSettingsFieldBase & Readonly<{
      kind: 'number';
      min?: number;
      max?: number;
      step?: number;
      promptTitleKey?: string;
      promptBodyKey?: string;
    }>)
  | (BundledSpeechSettingsFieldBase & Readonly<{
      kind: 'textarea';
      minLength: number;
      maxLength: number;
    }>)
  | (BundledSpeechSettingsFieldBase & Readonly<{
      kind: 'switch';
    }>)
  | (BundledSpeechSettingsFieldBase & Readonly<{
      kind: 'json';
    }>);

export type BundledSpeechSettingsDescriptor = Readonly<{
  providerId: string;
  contribution: Readonly<{ pluginId: string; localId: string }>;
  role: 'stt' | 'tts' | 'both';
  schemaVersion: number;
  titleKey: string;
  subtitleKey: string;
  detailKey: string;
  /**
   * The provider declaration's own disclosure, forwarded verbatim. Collapsing it
   * to its translation key discards the declared fallback prose, which is the only
   * copy an externally installed plugin has: its translations are never merged into
   * the host bundle.
   */
  privacyDisclosure?: string | Readonly<{ key: string; fallback: string }>;
  iconName: string;
  credential: Readonly<{
    slotId: string;
    purpose: string;
    titleKey: string;
    promptTitleKey: string;
    promptBodyKey: string;
  }> | null;
  fields: readonly BundledSpeechSettingsField[];
  actions: readonly VoiceProviderSettingsActionDeclaration[];
  endpointConsent: Readonly<{
    baseUrlFieldId: 'baseUrl';
    originConsentFieldId: 'insecureLocalOriginConsent';
    machineConsentFieldId: 'insecureLocalConsentMachineId';
  }> | null;
  defaultConfig: BundledSpeechSettingsConfig;
  parseConfig(value: unknown): BundledSpeechSettingsConfig | null;
  test: null | Readonly<{
    missingFieldId: string;
    missingValueMessageKey: string;
  }>;
}>;

export type BundledSpeechSettingsEntry = VoiceProviderRegistryEntry;

type SettingSchema = Readonly<{
  type?: string;
  const?: unknown;
  enum?: readonly unknown[];
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  anyOf?: readonly SettingSchema[];
  oneOf?: readonly SettingSchema[];
}>;

function schemaAcceptsNull(schema: SettingSchema): boolean {
  if (schema.type === 'null' || schema.const === null) return true;
  return [...(schema.anyOf ?? []), ...(schema.oneOf ?? [])].some(schemaAcceptsNull);
}

function findNumericSchema(schema: SettingSchema): SettingSchema | null {
  if (schema.type === 'number' || schema.type === 'integer') return schema;
  for (const candidate of [...(schema.anyOf ?? []), ...(schema.oneOf ?? [])]) {
    const found = findNumericSchema(candidate);
    if (found) return found;
  }
  return null;
}

function findStringSchema(schema: SettingSchema): SettingSchema | null {
  if (schema.type === 'string') return schema;
  for (const candidate of [...(schema.anyOf ?? []), ...(schema.oneOf ?? [])]) {
    const found = findStringSchema(candidate);
    if (found) return found;
  }
  return null;
}

function localizedKey(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value;
  if (value && typeof value === 'object' && 'key' in value
    && typeof value.key === 'string' && value.key.length > 0) return value.key;
  return null;
}

function readDeclaredDisclosure(
  value: unknown,
): string | Readonly<{ key: string; fallback: string }> | null {
  if (typeof value === 'string' && value.length > 0) return value;
  if (value && typeof value === 'object' && 'key' in value
    && typeof value.key === 'string' && value.key.length > 0) {
    const fallback = 'fallback' in value && typeof value.fallback === 'string' && value.fallback.length > 0
      ? value.fallback
      : value.key;
    return Object.freeze({ key: value.key, fallback });
  }
  return null;
}

function isSettingsConfig(value: unknown): value is BundledSpeechSettingsConfig {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function readBundledSpeechSettingsDescriptorFromEntry(
  providerId: string,
  entry: BundledSpeechSettingsEntry | null | undefined,
): BundledSpeechSettingsDescriptor | null {
  if (!entry || entry.kind !== 'voice.speech-engine.v1' || entry.providerId !== providerId
    || entry.declaration?.kind !== 'speech' || !entry.providerSettings) return null;
  const createSettingsSpec = entry.presentation?.createSettingsSpec;
  if (!createSettingsSpec) return null;

  try {
    const presentation = createSettingsSpec();
    const credentials = entry.declaration.credentials;
    if (!presentation || (credentials && !presentation.credential)) return null;
    const declaredFields = new Map(
      entry.providerSettings.fields.map((field) => [field.id, field] as const),
    );
    const catalogs = new Map(
      (entry.declaration.catalogs ?? []).map((catalog) => [catalog.settingFieldId, catalog] as const),
    );
    const endpointConsent = declaredFields.has('baseUrl')
      && declaredFields.get('insecureLocalOriginConsent')?.presentation?.hidden === true
      && declaredFields.get('insecureLocalConsentMachineId')?.presentation?.hidden === true
      ? Object.freeze({
          baseUrlFieldId: 'baseUrl' as const,
          originConsentFieldId: 'insecureLocalOriginConsent' as const,
          machineConsentFieldId: 'insecureLocalConsentMachineId' as const,
        })
      : null;
    const fields = (presentation.fields ?? []).map((fieldPresentation): BundledSpeechSettingsField => {
      const field = declaredFields.get(fieldPresentation.fieldId);
      if (!field) throw new Error('bundled_speech_presentation_field_undeclared');
      const schema = field.schema as SettingSchema;
      const nullable = schemaAcceptsNull(schema);
      const catalog = catalogs.get(field.id);
      if (catalog) {
        return Object.freeze({
          kind: 'remote_select' as const,
          key: field.id,
          catalog: catalog.kind,
          titleKey: fieldPresentation.titleKey,
          subtitleKey: fieldPresentation.subtitleKey,
          ...(fieldPresentation.searchPlaceholderKey
            ? { searchPlaceholderKey: fieldPresentation.searchPlaceholderKey }
            : {}),
          allowCustom: catalog.allowCustom,
          nullable,
        });
      }
      if (fieldPresentation.autoTitleKey && fieldPresentation.autoSubtitleKey) {
        return Object.freeze({
          kind: 'language' as const,
          key: field.id,
          titleKey: fieldPresentation.titleKey,
          subtitleKey: fieldPresentation.subtitleKey,
          autoTitleKey: fieldPresentation.autoTitleKey,
          autoSubtitleKey: fieldPresentation.autoSubtitleKey,
          nullable,
        });
      }
      if (field.presentation?.control === 'select' && field.presentation.options) {
        const options = field.presentation.options.map((option) => {
          if (typeof option.value !== 'string') {
            throw new Error('bundled_speech_string_option_required');
          }
          const title = localizedKey(option.title);
          if (!title) throw new Error('bundled_speech_option_title_required');
          return Object.freeze({ id: option.value, title });
        });
        return Object.freeze({
          kind: 'enum' as const,
          key: field.id,
          titleKey: fieldPresentation.titleKey,
          subtitleKey: fieldPresentation.subtitleKey,
          options: Object.freeze(options),
          nullable,
        });
      }
      const stringSchema = findStringSchema(schema);
      if ((field.presentation?.control === 'text' || field.presentation?.control === 'textarea')
        && stringSchema
        && Number.isInteger(stringSchema.maxLength)
        && (stringSchema.maxLength ?? 0) > 0) {
        return Object.freeze({
          kind: field.presentation.control,
          key: field.id,
          titleKey: fieldPresentation.titleKey,
          subtitleKey: fieldPresentation.subtitleKey,
          ...(field.presentation.control === 'text' && fieldPresentation.promptTitleKey
            ? { promptTitleKey: fieldPresentation.promptTitleKey }
            : {}),
          ...(field.presentation.control === 'text' && fieldPresentation.promptBodyKey
            ? { promptBodyKey: fieldPresentation.promptBodyKey }
            : {}),
          minLength: stringSchema.minLength ?? 0,
          maxLength: stringSchema.maxLength!,
          nullable,
        });
      }
      if (field.presentation?.control === 'switch' && schema.type === 'boolean') {
        return Object.freeze({
          kind: 'switch' as const,
          key: field.id,
          titleKey: fieldPresentation.titleKey,
          subtitleKey: fieldPresentation.subtitleKey,
          nullable,
        });
      }
      if (field.presentation?.control === 'json'
        && (schema.type === 'object' || schema.type === 'array')) {
        return Object.freeze({
          kind: 'json' as const,
          key: field.id,
          titleKey: fieldPresentation.titleKey,
          subtitleKey: fieldPresentation.subtitleKey,
          nullable,
        });
      }
      const numericSchema = findNumericSchema(schema);
      if (field.presentation?.control === 'number' && numericSchema) {
        return Object.freeze({
          kind: 'number' as const,
          key: field.id,
          titleKey: fieldPresentation.titleKey,
          subtitleKey: fieldPresentation.subtitleKey,
          ...(fieldPresentation.promptTitleKey
            ? { promptTitleKey: fieldPresentation.promptTitleKey }
            : {}),
          ...(fieldPresentation.promptBodyKey
            ? { promptBodyKey: fieldPresentation.promptBodyKey }
            : {}),
          ...(numericSchema.minimum !== undefined ? { min: numericSchema.minimum } : {}),
          ...(numericSchema.maximum !== undefined ? { max: numericSchema.maximum } : {}),
          ...(field.presentation.step !== undefined ? { step: field.presentation.step } : {}),
          nullable,
        });
      }
      throw new Error('bundled_speech_presentation_control_unsupported');
    });
    const hiddenHostFieldCount = endpointConsent ? 2 : 0;
    if (fields.length + hiddenHostFieldCount !== declaredFields.size
      || new Set(fields.map((field) => field.key)).size !== fields.length) {
      return null;
    }
    const privacyDisclosure = readDeclaredDisclosure(entry.declaration.settings?.privacyDisclosure);
    const voicesCatalog = entry.declaration.catalogs?.find((catalog) => catalog.kind === 'voices');
    const testMissingFieldId = voicesCatalog?.settingFieldId
      ?? entry.declaration.settings?.readiness?.find(
        (requirement) => requirement.kind === 'setting_nonempty',
      )?.settingId;
    const defaultConfig = entry.providerSettings.defaultConfig;
    if (!isSettingsConfig(defaultConfig)) return null;
    return Object.freeze({
      providerId: entry.providerId,
      contribution: Object.freeze({ pluginId: entry.pluginId, localId: entry.declaration.id }),
      role: entry.role,
      schemaVersion: entry.providerSettings.schemaVersion,
      titleKey: presentation.titleKey,
      subtitleKey: presentation.subtitleKey,
      detailKey: presentation.detailKey,
      ...(privacyDisclosure ? { privacyDisclosure } : {}),
      iconName: presentation.iconName,
      credential: credentials && presentation.credential
        ? Object.freeze({
            slotId: credentials.slot.id,
            purpose: credentials.slot.purpose,
            ...presentation.credential,
          })
        : null,
      fields: Object.freeze(fields),
      actions: Object.freeze([...(entry.declaration.settings.actions ?? [])]),
      endpointConsent,
      defaultConfig,
      parseConfig(value: unknown) {
        const parsed = entry.providerSettings?.parseConfig(value);
        return isSettingsConfig(parsed) ? parsed : null;
      },
      test: presentation.test && testMissingFieldId
        ? Object.freeze({
            missingFieldId: testMissingFieldId,
            missingValueMessageKey: presentation.test.missingValueMessageKey,
          })
        : null,
    });
  } catch {
    return null;
  }
}
