import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { prepareCliForGlobalSetup } from './prepareCliForGlobalSetup';

describe('prepareCliForGlobalSetup', () => {
  it('does not prepare a dist snapshot when the lane launches the CLI from source', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-cli-global-setup-'));

    try {
      await prepareCliForGlobalSetup({
        rootDir,
        lane: 'core-slow',
        env: {
          HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
        },
      });

      await expect(stat(join(rootDir, '.project'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
