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
      entrypoints: { daemon: './dist/index.js' },
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
    expect(processAccess?.scope.envKeys).toEqual([
      'HAPPIER_PI_THINKING_LEVEL',
      'HAPPIER_CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH',
      'HAPPIER_PI_REQUEST_AUTH_PRODUCER_VERSION',
      'NODE_ENV',
      'DEBUG',
      'CI',
      'OPENAI_API_KEY',
      'ANTHROPIC_API_KEY',
      'GEMINI_API_KEY',
      'OPENROUTER_API_KEY',
      'KIMI_API_KEY',
      'HOME',
      'XDG_CONFIG_HOME',
      'USERPROFILE',
      'PI_CODING_AGENT_DIR',
    ]);
    expect(PLUGIN_MANIFEST.contributes.agents[0]?.connectedAccounts).toEqual([
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
    ]);
  });
});
