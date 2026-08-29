import { describe, expect, it } from 'vitest';
import {
  buildQualifiedPluginContributionKey,
  compilePluginJsonSchema,
  createPluginContributionIdentity,
  isValidPluginJsonSchemaValue,
  type PluginSettingFieldSchemaV2,
  type PluginSettingFieldV2,
} from '@happier-dev/protocol';

import { getBundledVoiceProviderEntry } from '@/voice/registry/internalContributions';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';

import { parseRealtimeSettingsDescriptor, resolveRealtimeProviderConfig } from './descriptor';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readPrivacyDisclosure(value: unknown): unknown {
  return isRecord(value) ? value.privacyDisclosure : null;
}

function readPrivacyDisclosureFallback(value: unknown): string {
  const disclosure = readPrivacyDisclosure(value);
  if (typeof disclosure === 'string') return disclosure;
  return isRecord(disclosure) && typeof disclosure.fallback === 'string'
    ? disclosure.fallback
    : '';
}

type DescriptorContractIssue = Readonly<{
  path: string;
  reason: string;
}>;

function schemaBranches(schema: PluginSettingFieldSchemaV2): readonly PluginSettingFieldSchemaV2[] {
  return [schema, ...(schema.anyOf ?? []), ...(schema.oneOf ?? [])];
}

function resolveSchemaPath(
  fields: readonly PluginSettingFieldV2[],
  path: string,
): Readonly<{
  schema: PluginSettingFieldSchemaV2;
  defaultValue: unknown;
}> | null {
  const [fieldId, ...segments] = path.split('.');
  const field = fields.find((candidate) => candidate.id === fieldId);
  if (!field) return null;
  let schemas: readonly PluginSettingFieldSchemaV2[] = [field.schema];
  let defaultValue: unknown = field.default;
  for (const segment of segments) {
    const children = schemas.flatMap((schema) => schemaBranches(schema))
      .flatMap((schema) => schema.properties?.[segment] ? [schema.properties[segment]] : []);
    if (children.length === 0) return null;
    schemas = children;
    defaultValue = isRecord(defaultValue) ? defaultValue[segment] : undefined;
  }
  return {
    // A leaf may be expressed as `anyOf: [value, null]`. Preserve the complete
    // union so nullable and option checks exercise the manifest contract.
    schema: schemas.length === 1 ? schemas[0]! : { anyOf: [...schemas] },
    defaultValue,
  };
}

function numericBranch(schema: PluginSettingFieldSchemaV2): PluginSettingFieldSchemaV2 | null {
  return schemaBranches(schema).find((branch) => branch.type === 'number' || branch.type === 'integer') ?? null;
}

function enumValues(schema: PluginSettingFieldSchemaV2): readonly unknown[] | null {
  return schemaBranches(schema).find((branch) => Array.isArray(branch.enum))?.enum ?? null;
}

function validateRealtimeDescriptorAgainstDeclaration(
  descriptor: NonNullable<ReturnType<typeof parseRealtimeSettingsDescriptor>>,
  fields: readonly PluginSettingFieldV2[],
  presentationOwnedRootIds: readonly string[] = [],
): readonly DescriptorContractIssue[] {
  const issues: DescriptorContractIssue[] = [];
  const add = (path: string, reason: string) => issues.push({ path, reason });
  const descriptorRootIds = new Set(descriptor.fields
    .filter((field) => field.kind !== 'welcome')
    .map((field) => field.pathSegments[0]));
  const presentationOwnedRoots = new Set(presentationOwnedRootIds);
  for (const field of fields) {
    if (!descriptorRootIds.has(field.id) && !presentationOwnedRoots.has(field.id)) {
      add(field.id, 'manifest_field_not_presented');
    }
  }

  for (const field of descriptor.fields) {
    // `welcome` is explanatory presentation, not persisted provider config.
    if (field.kind === 'welcome') continue;
    const resolved = resolveSchemaPath(fields, field.path);
    if (!resolved) {
      add(field.path, 'missing_manifest_schema_path');
      continue;
    }
    const validate = compilePluginJsonSchema(resolved.schema);
    const accepts = (value: unknown) => isValidPluginJsonSchemaValue(validate, value);

    if (field.kind === 'instructions' || field.kind === 'text') {
      if (!accepts('value')) add(field.path, 'descriptor_text_not_accepted');
      if (typeof field.maxLength === 'number') {
        if (!accepts('x'.repeat(field.maxLength))) add(field.path, 'descriptor_max_length_rejected');
        if (accepts('x'.repeat(field.maxLength + 1))) add(field.path, 'manifest_max_length_exceeds_descriptor');
      }
      continue;
    }

    if (field.kind === 'number' || field.kind === 'range') {
      const numeric = numericBranch(resolved.schema);
      if (!numeric || numeric.minimum !== field.min || numeric.maximum !== field.max) {
        add(field.path, 'numeric_bounds_mismatch');
      }
      if (field.reset !== undefined && resolved.defaultValue !== field.reset) {
        add(field.path, 'numeric_default_mismatch');
      }
      continue;
    }

    if (field.kind === 'segmented' || field.kind === 'language_hint') {
      const declared = enumValues(resolved.schema);
      const presented = Array.isArray(field.options) ? field.options : [];
      if (!declared || JSON.stringify(declared) !== JSON.stringify(presented)) {
        add(field.path, 'enum_options_mismatch');
      }
      continue;
    }

    if (field.kind === 'keyterms') {
      const array = schemaBranches(resolved.schema).find((branch) => branch.type === 'array');
      if (!array || array.maxItems !== field.maxItems || array.items?.maxLength !== field.maxLength) {
        add(field.path, 'array_bounds_mismatch');
      }
      continue;
    }

    if (field.kind === 'server_vad') {
      const subfields = Array.isArray(field.subfields) ? field.subfields : [];
      for (const rawSubfield of subfields) {
        if (!isRecord(rawSubfield) || typeof rawSubfield.path !== 'string') {
          add(field.path, 'invalid_subfield_descriptor');
          continue;
        }
        const subfield = resolveSchemaPath(fields, rawSubfield.path);
        const numeric = subfield ? numericBranch(subfield.schema) : null;
        if (!numeric
          || numeric.minimum !== rawSubfield.min
          || numeric.maximum !== rawSubfield.max
          || (rawSubfield.integer === true) !== (numeric.type === 'integer')) {
          add(rawSubfield.path, 'server_vad_bounds_mismatch');
        }
      }
      continue;
    }

    if (field.kind === 'privacy_opt_in') {
      if (!accepts(true) || !accepts(false)) add(field.path, 'boolean_schema_mismatch');
      if (field.defaultValue !== resolved.defaultValue) add(field.path, 'boolean_default_mismatch');
      continue;
    }

    if (field.kind === 'model') {
      const options = Array.isArray(field.options) ? field.options : [];
      for (const option of options) {
        if (!accepts(option)) add(field.path, 'model_option_rejected');
      }
      for (const id of Array.isArray(field.supportedModelIds) ? field.supportedModelIds : []) {
        if (typeof id !== 'string') {
          add(field.path, 'invalid_supported_model_id');
          continue;
        }
        const option = id.endsWith('-latest')
          ? { kind: 'moving_alias', id }
          : { kind: 'pinned', id };
        if (!accepts(option)) add(field.path, 'supported_model_rejected');
      }
      continue;
    }

    if (field.kind === 'voice_catalog') {
      for (const option of [{ kind: 'catalog', id: 'voice' }, { kind: 'custom', id: 'voice' }]) {
        if (!accepts(option)) add(field.path, `${option.kind}_voice_rejected`);
      }
      continue;
    }

    if (field.kind === 'remote_voice') {
      if (!accepts('voice')) add(field.path, 'remote_voice_rejected');
      continue;
    }

    if (field.kind === 'select') {
      for (const option of Array.isArray(field.options) ? field.options : []) {
        if (!isRecord(option) || typeof option.id !== 'string' || option.id === '' || option.id === 'custom') continue;
        if (!accepts(option.id)) add(field.path, 'select_option_rejected');
      }
    }
  }
  return issues;
}

describe('bundled realtime provider settings projection', () => {
  for (const [legacyProviderId, pluginId, localId] of [
    ['happier.voice.elevenlabs/realtime-elevenlabs', 'happier.voice.elevenlabs', 'realtime-elevenlabs'],
    ['happier.voice.openai/realtime-openai', 'happier.voice.openai', 'realtime-openai'],
    ['happier.voice.xai/realtime-grok', 'happier.voice.xai', 'realtime-grok'],
    ['happier.agent.codex/realtime-codex', 'happier.agent.codex', 'realtime-codex'],
  ] as const) {
    const providerId = buildQualifiedPluginContributionKey(
      createPluginContributionIdentity({ pluginId, localId }),
    );
    it(`renders ${providerId} through the same descriptor and settings-owner boundary`, () => {
      const entry = getBundledVoiceProviderEntry(providerId);
      expect(entry?.kind).toBe('voice.conversation-provider.v1');
      if (!entry || entry.kind !== 'voice.conversation-provider.v1') throw new Error('missing bundled provider');
      const registryEntry = createDefaultVoiceProviderRegistry().get(providerId);
      const providerSettings = registryEntry?.providerSettings;
      if (legacyProviderId === 'happier.agent.codex/realtime-codex') {
        expect(providerSettings?.presentation).toBeNull();
        expect(providerSettings)
          .toMatchObject({
            schemaVersion: 2,
            privacyDisclosure: {
              key: 'settingsVoice.realtimeProviders.codex.privacyDisclosure',
            },
            connectedServicesBinding: {
              id: 'globalConnectedServices',
              agent: 'codex',
              serviceIds: ['openai-codex'],
            },
          });
        expect(registryEntry?.projectSettings?.({
          schemaVersion: 1,
          config: {},
        })).toEqual({ status: 'unsupported_version', modeId: null });
        expect(registryEntry?.projectSettings?.({
          schemaVersion: 2,
          config: { globalConnectedServices: null },
        })).toEqual({ status: 'missing_required_setting', modeId: 'experimental' });
        return;
      }
      if (legacyProviderId === 'happier.voice.elevenlabs/realtime-elevenlabs') {
        expect(readPrivacyDisclosureFallback(providerSettings)).toBe(
          'Audio and conversation content are sent from this device to ElevenLabs through the ElevenLabs client connection. Depending on the selected setup, Happier may also send ElevenLabs bounded agent instructions, client-tool definitions and results, and authentication or provisioning requests needed for the feature. Happier’s server may participate in hosted authentication and usage accounting, but neither Happier’s server nor relay carries the live conversation audio. ElevenLabs may process and retain received data under your ElevenLabs account settings and its terms. Voice context-sharing controls are separate from this provider processing.',
        );
      }
      if (legacyProviderId === 'happier.voice.openai/realtime-openai' || legacyProviderId === 'happier.voice.xai/realtime-grok') {
        expect(readPrivacyDisclosure(providerSettings)).toMatchObject({
          key: legacyProviderId === 'happier.voice.openai/realtime-openai'
            ? 'settingsVoice.realtimeProviders.openai.privacyDisclosure'
            : 'settingsVoice.realtimeProviders.xai.privacyDisclosure',
        });
        const disclosure = readPrivacyDisclosureFallback(providerSettings);
        expect(disclosure).toMatch(/audio/iu);
        expect(disclosure).toMatch(/context/iu);
        expect(disclosure).toMatch(/client-tool definitions/iu);
        expect(disclosure).toMatch(/delegated results/iu);
        expect(disclosure).toMatch(/server and relay do not carry live audio/iu);
        expect(disclosure).toMatch(/may retain/iu);
        expect(disclosure).toMatch(/context-sharing controls are separate/iu);
        expect(providerSettings).not.toHaveProperty('defaultConfig.mode');
        expect(isRecord(providerSettings)
          && typeof providerSettings.parseConfig === 'function'
          && isRecord(providerSettings.defaultConfig)
          ? providerSettings.parseConfig(providerSettings.defaultConfig)
          : null).not.toBeNull();
      }
      if (legacyProviderId === 'happier.voice.openai/realtime-openai') {
        expect(providerSettings?.presentation).toBeNull();
        return;
      }
      expect(providerSettings?.presentation).toBeTruthy();
      if (!providerSettings?.presentation) throw new Error('invalid bundled provider settings descriptor');

      const descriptor = parseRealtimeSettingsDescriptor(providerId, providerSettings.presentation);
      expect(descriptor?.providerId).toBe(providerId);
      if (!isRecord(providerSettings)
        || typeof providerSettings.schemaVersion !== 'number'
        || !isRecord(providerSettings.defaultConfig)
        || typeof providerSettings.parseConfig !== 'function') throw new Error('invalid bundled provider settings owner');
      expect(descriptor?.fields.length).toBeGreaterThan(0);
      expect(validateRealtimeDescriptorAgainstDeclaration(
        descriptor!,
        providerSettings.fields,
        legacyProviderId === 'happier.voice.elevenlabs/realtime-elevenlabs'
          ? ['billingMode']
          : [],
      )).toEqual([]);
      if (legacyProviderId === 'happier.voice.xai/realtime-grok') {
        const driftedFields = providerSettings.fields.map((field) => field.id === 'outputSpeed'
          ? { ...field, schema: { ...field.schema, maximum: 1.4 } }
          : field);
        expect(validateRealtimeDescriptorAgainstDeclaration(descriptor!, driftedFields))
          .toContainEqual({ path: 'outputSpeed', reason: 'numeric_bounds_mismatch' });
      }
      const resolved = resolveRealtimeProviderConfig({
        schemaVersion: providerSettings.schemaVersion,
        defaultConfig: providerSettings.defaultConfig,
        parseConfig: providerSettings.parseConfig as (value: unknown) => Readonly<Record<string, unknown>> | null,
      }, null);
      expect(resolved.status).toBe('ready');
      if (resolved.status !== 'ready') throw new Error('expected ready provider config');
      expect(JSON.stringify(resolved.config)).not.toMatch(/apiKey|accessToken|refreshToken|encryptedValue/iu);
    });
  }
});
