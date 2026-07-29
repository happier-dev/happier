import { ingestPluginManifestV2 } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';
import { KIMI_AGENT_SETTINGS_CONTRIBUTION } from './agentSettings/definition.js';
import { PLUGIN_MANIFEST } from './manifest.js';

describe('Kimi plugin manifest', () => {
  it('is a canonical data-only custom Agent declaration', () => {
    const result = ingestPluginManifestV2(PLUGIN_MANIFEST);
    expect(result).toMatchObject({ ok: true });
    expect(ingestPluginManifestV2(JSON.stringify(PLUGIN_MANIFEST))).toEqual(result);
    expect(PLUGIN_MANIFEST.contributes.agents).toEqual([
      expect.objectContaining({ id: 'kimi', runtime: { kind: 'custom' } }),
    ]);
    expect(PLUGIN_MANIFEST.contributes.settings).toEqual([
      KIMI_AGENT_SETTINGS_CONTRIBUTION,
    ]);
    expect(PLUGIN_MANIFEST.hostAccess.required).toContainEqual(expect.objectContaining({
      id: 'kimi-process',
      capability: 'process',
      scope: {
        executables: [{ kind: 'systemTool', id: 'kimi-cli' }],
        envKeys: ['HAPPIER_KIMI_ACP_SELECTOR', 'PYTHONPATH'],
      },
    }));
  });
});
