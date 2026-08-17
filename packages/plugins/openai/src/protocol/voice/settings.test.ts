import { describe, expect, it } from 'vitest';

import {
  OPENAI_REALTIME_DEFAULT_SETTINGS,
  OpenAiRealtimeSettingsV1Schema,
} from './settings.js';

describe('OpenAiRealtimeSettingsV1Schema', () => {
  it('uses a pinned current model and contains no credential material', () => {
    const settings = OpenAiRealtimeSettingsV1Schema.parse({});
    expect(settings).toEqual(OPENAI_REALTIME_DEFAULT_SETTINGS);
    expect(settings.model.kind).toBe('pinned');
    expect(settings).not.toHaveProperty('authentication');
    expect(JSON.stringify(settings)).not.toMatch(/sk-[A-Za-z0-9]|accessToken|refreshToken|credentialValue/iu);
  });

  it('accepts released authentication shapes only at ingress and removes them from runtime settings', () => {
    expect(OpenAiRealtimeSettingsV1Schema.parse({
      authentication: {
        source: 'connected_service_api_key',
        binding: { source: 'connected', selection: 'profile', profileId: 'work' },
      },
    })).not.toHaveProperty('authentication');
    expect(OpenAiRealtimeSettingsV1Schema.parse({
      authentication: {
        source: 'connected_service_oauth',
      },
    })).not.toHaveProperty('authentication');
    expect(OpenAiRealtimeSettingsV1Schema.parse({
      authentication: {
        source: 'connected_service_oauth',
        binding: { source: 'connected', selection: 'group', groupId: 'codex-pool' },
      },
    })).not.toHaveProperty('authentication');
    expect(OpenAiRealtimeSettingsV1Schema.safeParse({
      authentication: {
        source: 'connected_service_oauth',
        fallbackSource: 'connected_service_api_key',
      },
    }).success).toBe(false);
    expect(OpenAiRealtimeSettingsV1Schema.safeParse({
      authentication: {
        source: 'connected_service_api_key',
        binding: { source: 'native' },
      },
    }).success).toBe(false);
    expect(OpenAiRealtimeSettingsV1Schema.safeParse({
      authentication: {
        source: 'voice_saved_secret',
        apiKey: 'sk-leak',
      },
    }).success).toBe(false);
  });

  it('rejects undocumented and correctness-owned fields', () => {
    expect(OpenAiRealtimeSettingsV1Schema.safeParse({ apiKey: 'sk-secret' }).success).toBe(false);
    expect(OpenAiRealtimeSettingsV1Schema.safeParse({ transport: 'websocket' }).success).toBe(false);
    expect(OpenAiRealtimeSettingsV1Schema.safeParse({ personality: 'friendly' }).success).toBe(false);
    expect(OpenAiRealtimeSettingsV1Schema.safeParse({
      model: { kind: 'moving_alias', id: 'arbitrary-moving-target' },
    }).success).toBe(false);
    expect(OpenAiRealtimeSettingsV1Schema.safeParse({
      model: { kind: 'moving_alias', id: 'gpt-realtime' },
    }).success).toBe(true);
  });
});
