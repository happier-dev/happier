import { describe, expect, it } from 'vitest';

import { XAI_REALTIME_DEFAULT_SETTINGS, XaiRealtimeSettingsV1Schema } from './settings.js';

describe('XaiRealtimeSettingsV1Schema', () => {
  it('defaults to pinned, secret-free, opt-out resumption settings', () => {
    const settings = XaiRealtimeSettingsV1Schema.parse({});
    expect(settings).toEqual(XAI_REALTIME_DEFAULT_SETTINGS);
    expect(settings.model).toEqual({ kind: 'pinned', id: 'grok-voice-think-fast-2.0' });
    expect(settings.resumptionEnabled).toBe(false);
    expect(JSON.stringify(settings)).not.toMatch(/api.?key|secret|token/iu);
  });

  it('creates independent mutable transcription defaults for each parsed settings object', () => {
    const first = XaiRealtimeSettingsV1Schema.parse({});
    const second = XaiRealtimeSettingsV1Schema.parse({});

    expect(first.transcription).not.toBe(second.transcription);
    expect(first.transcription.keyterms).not.toBe(second.transcription.keyterms);

    first.transcription.keyterms.push('Happier');
    expect(second.transcription.keyterms).toEqual([]);
    expect(XAI_REALTIME_DEFAULT_SETTINGS.transcription.keyterms).toEqual([]);
  });

  it('preserves an explicitly saved deprecated pinned model instead of migrating it implicitly', () => {
    expect(XaiRealtimeSettingsV1Schema.parse({
      model: { kind: 'pinned', id: 'grok-voice-think-fast-1.0' },
    }).model).toEqual({ kind: 'pinned', id: 'grok-voice-think-fast-1.0' });
  });

  it('enforces the documented language, keyterm, speed, and VAD bounds', () => {
    expect(XaiRealtimeSettingsV1Schema.safeParse({ outputSpeed: 0.69 }).success).toBe(false);
    expect(XaiRealtimeSettingsV1Schema.safeParse({ transcription: { languageHint: 'es', keyterms: [] } }).success).toBe(false);
    expect(XaiRealtimeSettingsV1Schema.safeParse({ transcription: { languageHint: 'es-MX', keyterms: ['Grok', 'Grok'] } }).success).toBe(false);
    expect(XaiRealtimeSettingsV1Schema.safeParse({ turnDetection: { threshold: 0.95 } }).success).toBe(false);
  });

  it('rejects undocumented demo fields and credential material', () => {
    expect(XaiRealtimeSettingsV1Schema.safeParse({ personality: 'friendly' }).success).toBe(false);
    expect(XaiRealtimeSettingsV1Schema.safeParse({ apiKey: 'xai-secret' }).success).toBe(false);
  });
});
