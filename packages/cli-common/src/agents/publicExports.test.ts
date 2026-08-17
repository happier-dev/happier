import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createManagedToolScratchDir } from './index.js';

describe('agents public exports', () => {
  it('exposes managed-tool scratch directories through the public agents barrel', async () => {
    const installDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-public-export-'));

    try {
      const scratchDir = await createManagedToolScratchDir({
        installDir,
        prefix: 'packed-cli',
      });

      expect(dirname(scratchDir)).toBe(join(installDir, '.tmp'));
      await expect(access(scratchDir)).resolves.toBeUndefined();
    } finally {
      await rm(installDir, { force: true, recursive: true });
    }
  });
});
