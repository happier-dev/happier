import { ingestPluginManifestV2 } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST } from './manifest.js';
import { PI_LAUNCH_ENV_KEYS } from './agent/launchEnvironment.js';

describe('Pi strict plugin manifest', () => {
  it('declares only the target custom session runtime contract', () => {
    expect(ingestPluginManifestV2(PLUGIN_MANIFEST)).toMatchObject({ ok: true });
    expect(PLUGIN_MANIFEST.contributes.agents).toEqual([
      expect.objectContaining({ id: 'pi', runtime: { kind: 'custom' }, primary: 'sessions' }),
    ]);
    expect(PLUGIN_MANIFEST).toMatchObject({
      entrypoints: { daemon: './.happier-plugin-build/daemon.js' },
      hostAccess: {
        required: expect.arrayContaining([
          expect.objectContaining({ id: 'pi-process', capability: 'process' }),
        ]),
        optional: [],
      },
    });
    expect(PLUGIN_MANIFEST).not.toHaveProperty('activation');
    const processAccess = PLUGIN_MANIFEST.hostAccess.required.find((entry) => entry.id === 'pi-process');
    expect(processAccess?.scope.envKeys).toEqual(PI_LAUNCH_ENV_KEYS);

    expect(PLUGIN_MANIFEST.contributes.agents[0]?.connectedAccounts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        purpose: 'anthropic-model-request',
        materializationKinds: ['httpHeaders', 'environment'],
      }),
      expect.objectContaining({
        purpose: 'openai-codex-model-request',
        materializationKinds: ['httpHeaders'],
      }),
      expect.objectContaining({
        purpose: 'openai-api-key',
        materializationKinds: ['environment'],
      }),
      expect.objectContaining({
        purpose: 'anthropic-api-key',
        materializationKinds: ['environment'],
      }),
    ]));
  });
});
