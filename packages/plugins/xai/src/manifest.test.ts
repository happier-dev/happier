import { ingestPluginManifestV2 } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST } from './manifest.js';
import { XaiRealtimeSettingsV1Schema } from './protocol/voice/settings.js';

describe('xAI Voice plugin manifest', () => {
  it('declares truthful account, processing, and local-resumption disclosure', () => {
    expect(ingestPluginManifestV2(PLUGIN_MANIFEST)).toMatchObject({ ok: true });
    const disclosure = PLUGIN_MANIFEST.contributes.voiceProviders[0]?.settings?.privacyDisclosure;
    expect(disclosure).toMatchObject({
      key: 'settingsVoice.realtimeProviders.xai.privacyDisclosure',
    });
    const fallback = typeof disclosure === 'string' ? disclosure : disclosure?.fallback ?? '';
    expect(fallback).toMatch(/audio/iu);
    expect(fallback).toMatch(/conversation/iu);
    expect(fallback).toMatch(/xAI/iu);
    expect(fallback).toMatch(/Happier account secrets/iu);
    expect(fallback).toMatch(/Happier.*(?:conversation )?ID/iu);
    expect(fallback).toMatch(/does not delete.*xAI/iu);

    const declaration = PLUGIN_MANIFEST.contributes.voiceProviders[0];
    expect(declaration?.platforms).toEqual(['web', 'ios', 'android']);
    expect(declaration?.capabilities).toMatchObject({
      tools: { effectCalls: 'stable_ids' },
    });
    expect(declaration?.credentials).toMatchObject({
      slot: { id: 'api_key', purpose: 'voice.client-auth' },
      requirement: { kind: 'always' },
      sources: [{
        kind: 'savedSecret',
        operationProjections: [
          { operation: 'client-auth', phase: 'prepare' },
          { operation: 'voices', phase: 'settings' },
        ],
      }],
    });

    const fields = declaration?.settings?.fields ?? [];
    expect(fields.map((field) => field.id)).toEqual([
      'model',
      'voice',
      'instructions',
      'reasoningEffort',
      'outputSpeed',
      'transcription',
      'turnDetection',
      'resumptionEnabled',
    ]);
    expect(XaiRealtimeSettingsV1Schema.parse(Object.fromEntries(
      fields.map((field) => [field.id, field.default]),
    ))).toMatchObject({
      model: { kind: 'pinned', id: 'grok-voice-think-fast-1.0' },
      voice: { kind: 'catalog', id: 'eve' },
      instructions: '',
      reasoningEffort: 'high',
      resumptionEnabled: false,
    });
  });
});
