import { describe, expect, it } from 'vitest';

import { resolvePiDaemonSpawnPrerequisites } from './spawnHooks.js';

describe('Pi daemon spawn prerequisites', () => {
  it('does not require Bash for native-extension tools', async () => {
    await expect(resolvePiDaemonSpawnPrerequisites({
      payload: {
        cwd: 'C:\\workspace',
        runtimeSelection: {
          env: { PI_CODING_AGENT_DIR: 'C:\\happier\\pi-agent' },
        },
      },
    })).resolves.toEqual({ decision: 'allow' });
  });
});
