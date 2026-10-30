import { describe, expect, it } from 'vitest';

import {
  parseRealtimeSettingsDescriptor,
  resolveRealtimeProviderConfig,
  updateRealtimeProviderConfig,
} from './descriptor';
import { VOICE_PROVIDER_CONVERSATION_RETENTION_MS } from '@/voice/persistence/voiceProviderConversationRetention';
import { createExternalVoiceProviderSettingsDescriptor } from '@happier-dev/protocol/voice/settings/externalProviderSettings';
import { VoiceProviderSettingsSchema } from '@happier-dev/protocol/plugins/contributions/voice';

const declaredOwner = createExternalVoiceProviderSettingsDescriptor(VoiceProviderSettingsSchema.parse({
  schemaVersion: 1,
  fields: [
    { id: 'model', title: 'Model', schema: { type: 'object', properties: {
      kind: { const: 'pinned' }, id: { type: 'string', minLength: 1 },
    }, required: ['kind', 'id'], additionalProperties: false },
    default: { kind: 'pinned', id: 'stable' }, presentation: { control: 'json' } },
    { id: 'nested', title: 'Nested', schema: { type: 'object', properties: {
      value: { type: 'number', minimum: 0, maximum: 10 },
    }, required: ['value'], additionalProperties: false },
    default: { value: 1 }, presentation: { control: 'json' } },
  ],
}));
const owner = Object.freeze({
  ...declaredOwner,
  parseConfig(value: unknown) {
    const parsed = declaredOwner.parseConfig(value);
    return isConfigRecord(parsed) ? parsed : null;
  },
  parseStoredConfig(value: unknown) {
    const parsed = declaredOwner.parseStoredConfig(value);
    return isConfigRecord(parsed) ? parsed : null;
  },
});

function isConfigRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

describe('realtime settings descriptor boundary', () => {
  it('admits a provider-owned descriptor without knowing the provider id or field paths', () => {
    const descriptor = parseRealtimeSettingsDescriptor('acme_realtime', {
      kind: 'voice.provider-settings.v1',
      modes: ['byo'],
      titleKey: 'settingsVoice.realtimeProviders.provider.title',
      footerKey: 'settingsVoice.realtimeProviders.provider.footer',
      credential: {
        kind: 'api_key',
        catalog: 'voices',
        titleKey: 'settingsVoice.realtimeProviders.credential.title',
        promptTitleKey: 'settingsVoice.realtimeProviders.credential.promptTitle',
        promptBodyKey: 'settingsVoice.realtimeProviders.credential.promptBody',
      },
      links: {},
      fields: [{
        kind: 'range', path: 'nested.value', min: 0, max: 10, reset: 1,
        titleKey: 'settingsVoice.realtimeProviders.speed.title',
        subtitleKey: 'settingsVoice.realtimeProviders.speed.subtitle',
      }],
      groups: [{ id: 'voice', titleKey: 'voice.output', fieldPaths: ['nested.value'] }],
    });

    expect(descriptor).toMatchObject({ providerId: 'acme_realtime', mode: 'byo' });
    expect(descriptor?.fields).toHaveLength(1);
    expect(descriptor?.groups).toEqual([{ id: 'voice', titleKey: 'voice.output', fieldPaths: ['nested.value'] }]);
  });

  it('projects the canonical provider-conversation retention into privacy copy metadata', () => {
    const descriptor = parseRealtimeSettingsDescriptor('acme', {
      kind: 'voice.provider-settings.v1',
      modes: ['byo'],
      credential: { kind: 'api_key', catalog: null },
      links: {},
      fields: [{
        kind: 'privacy_opt_in',
        path: 'resumptionEnabled',
        titleKey: 'fixture.resumption.title',
      }],
    });

    expect(descriptor?.fields[0]).toMatchObject({
      retentionMinutes: VOICE_PROVIDER_CONVERSATION_RETENTION_MS / 60_000,
    });
  });
});

describe('realtime provider config projection', () => {
  it('opens stored provider preferences with retired fields while keeping edits strict', () => {
    const descriptor = createExternalVoiceProviderSettingsDescriptor(VoiceProviderSettingsSchema.parse({
      schemaVersion: 1, fields: [{ id: 'voice', title: 'Voice', schema: { type: 'string', maxLength: 32 }, default: 'default', presentation: { control: 'text' } }],
    }));
    const projectionOwner = { ...descriptor,
      defaultConfig: { voice: 'default' },
      parseConfig: (value: unknown) => {
        const parsed = descriptor.parseConfig(value);
        return isConfigRecord(parsed) ? parsed : null;
      },
      parseStoredConfig: (value: unknown) => {
        const parsed = descriptor.parseStoredConfig(value);
        return isConfigRecord(parsed) ? parsed : null;
      },
    };
    expect(resolveRealtimeProviderConfig(projectionOwner, { schemaVersion: 1, config: { voice: 'kept', retired: true } }))
      .toMatchObject({ status: 'ready', source: 'persisted', config: { voice: 'kept' } });
    expect(updateRealtimeProviderConfig(projectionOwner, { voice: 'kept' }, 'retired', true)).toBeNull();
  });
  it('preserves newer and invalid envelopes inert instead of replacing them with defaults', () => {
    expect(resolveRealtimeProviderConfig(owner, { schemaVersion: 2, config: { nested: { value: 2 } } })).toEqual({ status: 'unsupported_version' });
    expect(resolveRealtimeProviderConfig(owner, { schemaVersion: 1, config: { ...owner.defaultConfig, nested: { value: 99 } } })).toEqual({ status: 'invalid' });
  });

  it('uses defaults only for an unconfigured provider and immutably validates nested writes', () => {
    const resolved = resolveRealtimeProviderConfig(owner, null);
    expect(resolved).toMatchObject({ status: 'ready', source: 'default' });
    if (resolved.status !== 'ready') throw new Error('expected ready config');

    const updated = updateRealtimeProviderConfig(owner, resolved.config, 'nested.value', 4);
    expect(updated).toMatchObject({ nested: { value: 4 } });
    expect(resolved.config).toMatchObject({ nested: { value: 1 } });
    expect(updateRealtimeProviderConfig(owner, resolved.config, 'nested.value', 99)).toBeNull();
    expect(updateRealtimeProviderConfig(owner, resolved.config, 'constructor.value', 1)).toBeNull();
  });
});
