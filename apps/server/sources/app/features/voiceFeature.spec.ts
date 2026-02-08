import { describe, expect, it } from 'vitest';

import { resolveVoiceFeature } from './voiceFeature';

describe('features/voiceFeature', () => {
  it('treats ELEVENLABS_AGENT_ID as configured in non-production', () => {
    const res = resolveVoiceFeature({
      NODE_ENV: 'development',
      VOICE_ENABLED: 'true',
      VOICE_REQUIRE_SUBSCRIPTION: 'false',
      ELEVENLABS_API_KEY: 'k',
      ELEVENLABS_AGENT_ID: 'agent_dev',
    } as any);

    expect(res.voice.configured).toBe(true);
    expect(res.voice.enabled).toBe(true);
    expect(res.voice.provider).toBe('elevenlabs');
  });

  it('allows using ELEVENLABS_AGENT_ID_PROD as a fallback in non-production', () => {
    const res = resolveVoiceFeature({
      NODE_ENV: 'development',
      VOICE_ENABLED: 'true',
      VOICE_REQUIRE_SUBSCRIPTION: 'false',
      ELEVENLABS_API_KEY: 'k',
      ELEVENLABS_AGENT_ID_PROD: 'agent_prod',
    } as any);

    expect(res.voice.configured).toBe(true);
    expect(res.voice.enabled).toBe(true);
  });

  it('prefers ELEVENLABS_AGENT_ID_PROD in production when set', () => {
    const res = resolveVoiceFeature({
      NODE_ENV: 'production',
      VOICE_ENABLED: 'true',
      VOICE_REQUIRE_SUBSCRIPTION: 'false',
      ELEVENLABS_API_KEY: 'k',
      ELEVENLABS_AGENT_ID: 'agent_dev',
      ELEVENLABS_AGENT_ID_PROD: 'agent_prod',
    } as any);

    expect(res.voice.configured).toBe(true);
    expect(res.voice.enabled).toBe(true);
  });

  it('falls back to ELEVENLABS_AGENT_ID in production when prod override is missing', () => {
    const res = resolveVoiceFeature({
      NODE_ENV: 'production',
      VOICE_ENABLED: 'true',
      VOICE_REQUIRE_SUBSCRIPTION: 'false',
      ELEVENLABS_API_KEY: 'k',
      ELEVENLABS_AGENT_ID: 'agent_dev',
    } as any);

    expect(res.voice.configured).toBe(true);
    expect(res.voice.enabled).toBe(true);
  });
});

