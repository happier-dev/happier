import { describe, expect, it } from 'vitest';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { activate } from '../../activate.js';
import { PLUGIN_MANIFEST } from '../../manifest.js';

describe('Cursor native history registration', () => {
  it('binds the native reader through the public activation ABI', async () => {
    const plugin = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    expect(plugin.registration('agents', 'cursor')?.externalSessions).toMatchObject({
      resolveSource: expect.any(Function), listCandidates: expect.any(Function),
      pageTranscript: expect.any(Function), readAfterTranscript: expect.any(Function),
    });
    expect(PLUGIN_MANIFEST.contributes.agents[0]?.surfaces?.externalSession?.sources).toEqual([
      expect.objectContaining({ sourceKind: 'cursorHome', contentSearch: true }),
      expect.objectContaining({ sourceKind: 'cursorApp' }),
    ]);
  });
});
