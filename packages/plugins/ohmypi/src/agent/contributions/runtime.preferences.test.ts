import { describe, expect, it } from 'vitest';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';

import { activate } from '../../activate.js';
import { PLUGIN_MANIFEST } from '../../manifest.js';

describe('Oh My Pi session runtime preferences', () => {
  it('lets the Oh My Pi Agent setting override the shared ambient vendor key', async () => {
    const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    try {
      const buildSessionOptions = activation.registration('agents', 'ohmypi')?.cliSessionCommand?.buildSessionOptions;
      expect(buildSessionOptions).toBeTypeOf('function');
      expect(await buildSessionOptions?.({
        isExplicitCliSubcommand: true,
        parsed: { agentArgs: [] },
        settings: { ohMyPiAgentDir: '/wrong/global' },
        pluginSettings: { account: { ohMyPiAgentDir: '~/isolated/omp' } },
        environment: {
          HOME: '/home/alice',
          PI_CODING_AGENT_DIR: '/ambient/shared',
        },
        startOrigin: 'daemon',
      })).toEqual({
        ok: true,
        options: {
          environmentVariables: { PI_CODING_AGENT_DIR: '/home/alice/isolated/omp' },
        },
      });
    } finally {
      await activation.dispose();
    }
  });
});
