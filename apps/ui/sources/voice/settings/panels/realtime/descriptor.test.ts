import { describe, expect, it } from 'vitest';

import {
  parseRealtimeSettingsDescriptor,
  resolveRealtimeProviderConfig,
  updateRealtimeProviderConfig,
} from './descriptor';

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
      kind: 'voice.internal.realtime-settings.v1',
      providerId: 'acme_realtime',
      mode: 'byo',
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

  it('admits a non-credential Connected Services binding field for an Agent-backed provider', () => {
    const descriptor = parseRealtimeSettingsDescriptor('agent_realtime', {
      kind: 'voice.internal.realtime-settings.v1',
      providerId: 'agent_realtime',
      modes: ['happier'],
      credential: { kind: 'none', catalog: null },
      links: {},
      fields: [{
        kind: 'connected_services_binding',
        path: 'globalConnectedServices',
        agentId: 'codex',
        serviceIds: ['openai-codex'],
        titleKey: 'settingsVoice.realtimeProviders.codex.accountTitle',
      }],
    });

    expect(descriptor).toMatchObject({
      providerId: 'agent_realtime',
      mode: 'multi',
      credential: { kind: 'none', catalog: null },
      fields: [{
        kind: 'connected_services_binding',
        path: 'globalConnectedServices',
        agentId: 'codex',
        serviceIds: ['openai-codex'],
      }],
    });
  });

  it('fails closed on mismatched identity, malformed fields, or unsafe paths', () => {
    const base = {
      kind: 'voice.internal.realtime-settings.v1',
      providerId: 'other', mode: 'byo', credential: { kind: 'api_key', catalog: null }, links: {}, fields: [],
    };
    expect(parseRealtimeSettingsDescriptor('acme', base)).toBeNull();
    expect(parseRealtimeSettingsDescriptor('acme', { ...base, providerId: 'acme', fields: [{ kind: 'text', path: '__proto__.polluted' }] })).toBeNull();
    expect(parseRealtimeSettingsDescriptor('acme', { ...base, providerId: 'acme', fields: [{ kind: 'unknown', path: 'value' }] })).toBeNull();
    expect(parseRealtimeSettingsDescriptor('acme', { ...base, providerId: 'acme', mode: 'typo' })).toBeNull();
    expect(parseRealtimeSettingsDescriptor('acme', {
      ...base, providerId: 'acme', fields: [
        { kind: 'text', path: 'duplicate' },
        { kind: 'number', path: 'duplicate' },
      ],
    })).toBeNull();
    expect(parseRealtimeSettingsDescriptor('acme', {
      ...base, providerId: 'acme', fields: [{
        kind: 'server_vad', path: 'turnDetection',
        subfields: [{ kind: 'number', path: 'turnDetection.__proto__.polluted' }],
      }],
    })).toBeNull();
    expect(parseRealtimeSettingsDescriptor('acme', {
      ...base, providerId: 'acme', modes: ['byo', 42],
    })).toBeNull();
    expect(parseRealtimeSettingsDescriptor('acme', {
      ...base, providerId: 'acme', mode: 'byo', modes: ['happier'],
    })).toBeNull();
    expect(parseRealtimeSettingsDescriptor('acme', {
      ...base, providerId: 'acme', links: { privacy: 'javascript:alert(1)' },
    })).toBeNull();
    expect(parseRealtimeSettingsDescriptor('acme', {
      ...base, providerId: 'acme', fields: [{
        kind: 'server_vad', path: 'turnDetection',
        subfields: [{ kind: 'text', path: 'turnDetection.threshold', min: 0.1, max: 0.9 }],
      }],
    })).toBeNull();
    expect(parseRealtimeSettingsDescriptor('acme', {
      ...base, providerId: 'acme', fields: [
        { kind: 'autoprovision', path: 'agentId' },
        { kind: 'number', path: 'agentId', min: 0, max: 1 },
      ],
    })).toBeNull();
    expect(parseRealtimeSettingsDescriptor('acme', {
      ...base, providerId: 'acme', fields: [
        { kind: 'number', path: 'turnDetection.threshold', min: 0.1, max: 0.9 },
        { kind: 'server_vad', path: 'turnDetection', subfields: [
          { kind: 'number', path: 'turnDetection.threshold', min: 0.1, max: 0.9 },
        ] },
      ],
    })).toBeNull();
    expect(parseRealtimeSettingsDescriptor('acme', {
      ...base, providerId: 'acme', fields: [{
        kind: 'range', path: 'speed', min: 2, max: 1,
      }],
    })).toBeNull();
    expect(parseRealtimeSettingsDescriptor('acme', {
      ...base, providerId: 'acme', fields: [{
        kind: 'select', path: 'selection', options: Array.from({ length: 65 }, (_, index) => `value_${index}`),
      }],
    })).toBeNull();
  });

  it.each([
    ['missing', {}],
    ['blank', { titleKey: '   ' }],
  ])('rejects a privacy opt-in field with a %s title key', (_case, title) => {
    expect(parseRealtimeSettingsDescriptor('acme', {
      kind: 'voice.internal.realtime-settings.v1',
      providerId: 'acme',
      mode: 'byo',
      credential: { kind: 'api_key', catalog: null },
      links: {},
      fields: [{
        kind: 'privacy_opt_in',
        path: 'resumptionEnabled',
        ...title,
      }],
    })).toBeNull();
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
