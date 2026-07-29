import { ingestPluginManifestV2 } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST } from './manifest.js';

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
  });
});
