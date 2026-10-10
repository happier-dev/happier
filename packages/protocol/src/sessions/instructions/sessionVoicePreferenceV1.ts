import { z } from 'zod';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';
import { VoiceProviderIdSchema, VoiceProviderSettingsJsonValueV1Schema, type VoiceProviderSettingsJsonValueV1 } from '../../voice/realtime/providerSettings.js';
import type { VoiceProviderContribution } from '../../plugins/contributions/voiceProviders.js';
import { VoiceProviderSettingsPresentationPathSchema } from '../../plugins/contributions/voiceProviders.js';
import { compilePluginJsonSchema, isValidPluginJsonSchemaValue } from '../../plugins/actions/jsonSchemaValidation.js';
import { BUILT_IN_VOICE_SETTINGS_REGISTRY_ENTRIES } from '../../voice/settings/builtInRegistry.js';

export { BUILT_IN_LOCAL_NEURAL_VOICE_DECLARATION, BUILT_IN_LOCAL_NEURAL_VOICE_PROVIDER_ID } from '../../voice/settings/builtInRegistry.js';
/** Voice-field admission is shared by plugin declarations and trusted host engines.
 * Host engines are not plugins and do not declare plugin HTTP request/format fields. */
export type SessionVoiceDeclarationV1 = Readonly<{
  kind: VoiceProviderContribution['kind'];
  settings?: VoiceProviderContribution['settings'];
  catalogs?: Extract<VoiceProviderContribution, { kind: 'speech' }>['catalogs'];
}>;
/** Built-in declaration admission does not activate plugins or wake a Voice computer. */
export function readBuiltInSessionVoiceDeclarationV1(providerContributionId: string): SessionVoiceDeclarationV1 | null {
  return BUILT_IN_VOICE_SETTINGS_REGISTRY_ENTRIES.find(entry =>
    entry.sessionVoice?.providerContributionId === providerContributionId)?.sessionVoice?.declaration ?? null;
}

/** One provider-declared voice setting. Declaration/value admission belongs to the current provider. */
export const SessionVoicePreferenceV1Schema = lazyZodSchema(() => z.object({
  providerContributionId: VoiceProviderIdSchema,
  settingFieldPath: VoiceProviderSettingsPresentationPathSchema,
  value: VoiceProviderSettingsJsonValueV1Schema,
}).strict());
export type SessionVoicePreferenceV1 = Readonly<z.infer<typeof SessionVoicePreferenceV1Schema>>;
function isVoiceSettingsRecord(value: VoiceProviderSettingsJsonValueV1 | undefined): value is Readonly<{ [key: string]: VoiceProviderSettingsJsonValueV1 }> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export const StoredSessionVoicePreferenceV1Schema = lazyZodSchema(() => createStoredReadSchema(SessionVoicePreferenceV1Schema));

export function readSessionVoicePreferenceV1(value: unknown): SessionVoicePreferenceV1 | null {
  const parsed = StoredSessionVoicePreferenceV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function writeSessionVoicePreferenceV1ToMetadata<T extends Record<string, unknown>>(
  metadata: T, preference: SessionVoicePreferenceV1 | null,
): T {
  const rawWork = metadata.work;
  const work = rawWork && typeof rawWork === 'object' && !Array.isArray(rawWork) ? rawWork : {};
  const { voicePreference: _previous, ...rest } = work as Record<string, unknown>;
  return { ...metadata, work: { ...rest, ...(preference === null ? {} : {
    voicePreference: SessionVoicePreferenceV1Schema.parse(preference),
  }) } };
}

export type SessionVoiceSettingFieldV1 = Readonly<{
  path: string;
  pathSegments: readonly string[];
  customIdAllowed: boolean;
  valueShape: 'string' | 'selection';
}>;

/** The declaration, not a provider-id table, owns the voice field and its value grammar. */
export function readSessionVoiceSettingFieldV1(
  declaration: SessionVoiceDeclarationV1, path?: string,
): SessionVoiceSettingFieldV1 | null {
  const fields = (declaration.settings?.presentation?.fields ?? [])
    .filter(field => field.kind === 'voice_catalog' || field.kind === 'remote_voice')
    .map(field => ({ path: field.path, pathSegments: field.path.split('.'),
      customIdAllowed: field.customIdAllowed === true, valueShape: field.valueShape ?? (field.kind === 'voice_catalog' ? 'selection' : 'string') }));
  if (declaration.kind === 'speech') {
    for (const catalog of declaration.catalogs ?? []) {
      if (catalog.kind === 'voices' && !fields.some(field => field.path === catalog.settingFieldId)) {
        fields.push({ path: catalog.settingFieldId, pathSegments: [catalog.settingFieldId],
          customIdAllowed: catalog.allowCustom === true, valueShape: 'string' });
      }
    }
  }
  return path === undefined ? fields[0] ?? null : fields.find(field => field.path === path) ?? null;
}

export function readSessionVoiceSettingValueV1(
  config: VoiceProviderSettingsJsonValueV1, field: SessionVoiceSettingFieldV1,
): VoiceProviderSettingsJsonValueV1 | undefined {
  let value: VoiceProviderSettingsJsonValueV1 | undefined = config;
  for (const segment of field.pathSegments) {
    if (!isVoiceSettingsRecord(value)) return undefined;
    value = value[segment];
  }
  return value;
}

export type DeclaredSessionVoicePreferenceInputV1 = Readonly<{
  providerContributionId: string;
  declaration: SessionVoiceDeclarationV1;
  providerConfig: VoiceProviderSettingsJsonValueV1;
  preference: SessionVoicePreferenceV1 | null;
}>;
export type DeclaredSessionVoicePreferenceResolutionV1 =
  | Readonly<{ kind: 'inherited'; providerConfig: VoiceProviderSettingsJsonValueV1; field: SessionVoiceSettingFieldV1 | null }>
  | Readonly<{ kind: 'selected'; providerConfig: VoiceProviderSettingsJsonValueV1; field: SessionVoiceSettingFieldV1 }>
  | Readonly<{ kind: 'unavailable'; reason: 'provider_mismatch' | 'voice_missing' | 'override_unsupported' | 'invalid_value' }>;

/** Desired metadata admission needs no daemon wake or catalog fetch; consumption admits current catalog rows. */
export function admitDeclaredSessionVoicePreferenceV1(input: DeclaredSessionVoicePreferenceInputV1): DeclaredSessionVoicePreferenceResolutionV1 {
  const { preference, declaration } = input;
  const field = readSessionVoiceSettingFieldV1(declaration, preference?.settingFieldPath);
  if (preference === null) return { kind: 'inherited' as const, providerConfig: input.providerConfig, field };
  if (preference.providerContributionId !== input.providerContributionId) return { kind: 'unavailable' as const, reason: 'provider_mismatch' as const };
  if (!field) return { kind: 'unavailable' as const, reason: readSessionVoiceSettingFieldV1(declaration) ? 'voice_missing' as const : 'override_unsupported' as const };
  const value = preference.value;
  const selection = isVoiceSettingsRecord(value) ? value : null;
  const id = typeof value === 'string' ? value : typeof selection?.id === 'string' ? selection.id : null;
  if (value !== null && ((id === null) || (selection?.kind === 'custom' && !field.customIdAllowed))) {
    return { kind: 'unavailable' as const, reason: 'invalid_value' as const };
  }
  const patch = (config: VoiceProviderSettingsJsonValueV1, segments: readonly string[]): VoiceProviderSettingsJsonValueV1 | null => {
    if (!isVoiceSettingsRecord(config)) return null;
    const [segment, ...rest] = segments;
    if (!segment) return null;
    const next = rest.length ? patch(config[segment] ?? null, rest) : value;
    return next === null && rest.length ? null : { ...config, [segment]: next };
  };
  const providerConfig = patch(input.providerConfig, field.pathSegments);
  const rootField = declaration.settings?.fields.find(root => root.id === field.pathSegments[0]);
  if (!isVoiceSettingsRecord(providerConfig) || !rootField
    || !isValidPluginJsonSchemaValue(compilePluginJsonSchema(rootField.schema), providerConfig[rootField.id])) {
    return { kind: 'unavailable' as const, reason: 'invalid_value' as const };
  }
  return { kind: 'selected' as const, providerConfig, field };
}

export function resolveDeclaredSessionVoicePreferenceV1(input: DeclaredSessionVoicePreferenceInputV1 & Readonly<{
  catalog?: readonly Readonly<{ id: string; name: string }>[] | null;
}>): DeclaredSessionVoicePreferenceResolutionV1 {
  const resolved = admitDeclaredSessionVoicePreferenceV1(input);
  if (resolved.kind !== 'selected' || input.preference === null) return resolved;
  const { field } = resolved;
  const preference = input.preference;
  const value = preference.value;
  if (value === null || value === '') return resolved;
  const selection = isVoiceSettingsRecord(value) ? value : null;
  const id = typeof value === 'string' ? value : typeof selection?.id === 'string' ? selection.id : null;
  const custom = selection?.kind === 'custom' || (field.valueShape === 'string' && field.customIdAllowed);
  if (!custom && (!input.catalog || !input.catalog.some(row => row.id === id))) {
    return { kind: 'unavailable' as const, reason: 'voice_missing' as const };
  }
  return resolved;
}
