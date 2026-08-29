import { describe, expect, it } from 'vitest';

import {
  parseRealtimeSettingsDescriptor,
  resolveRealtimeProviderConfig,
  updateRealtimeProviderConfig,
} from './descriptor';
import { VOICE_PROVIDER_CONVERSATION_RETENTION_MS } from '@/voice/persistence/voiceProviderConversationRetention';

const owner = Object.freeze({
  schemaVersion: 1,
  defaultConfig: Object.freeze({ model: { kind: 'pinned', id: 'stable' }, nested: { value: 1 } }),
  parseConfig(value: unknown) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const candidate = value as Readonly<Record<string, unknown>>;
    const nested = candidate.nested as Readonly<Record<string, unknown>> | undefined;
    return typeof nested?.value === 'number' && nested.value >= 0 && nested.value <= 10
      ? candidate
      : null;
  },
});

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
    });

    expect(descriptor).toMatchObject({ providerId: 'acme_realtime', mode: 'byo' });
    expect(descriptor?.fields).toHaveLength(1);
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
  it('preserves newer and invalid envelopes inert instead of replacing them with defaults', () => {
    expect(resolveRealtimeProviderConfig(owner, { schemaVersion: 2, config: { nested: { value: 2 } } })).toEqual({ status: 'unsupported_version' });
    expect(resolveRealtimeProviderConfig(owner, { schemaVersion: 1, config: { nested: { value: 99 } } })).toEqual({ status: 'invalid' });
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
