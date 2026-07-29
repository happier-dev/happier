import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readPluginManifest } from '@/plugins/manifest/read';

import { ZIPFORMER_VOICE_MODEL_PACK_FIXTURE_ROOT } from './voiceModelPackPackage';

describe('Zipformer Voice model-pack fixture contract', () => {
  it('declares only the Linux x64 host proven by the external-pack vertical', async () => {
    const result = await readPluginManifest({
      manifestPath: join(ZIPFORMER_VOICE_MODEL_PACK_FIXTURE_ROOT, '.happier-plugin', 'plugin.json'),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [pack] = result.manifest.contributes.voiceModelPacks;
    expect(pack?.manifest.runtime.platforms).toEqual(['linux']);
    expect(pack?.manifest.runtime.architectures).toEqual(['x64']);
  });
});
