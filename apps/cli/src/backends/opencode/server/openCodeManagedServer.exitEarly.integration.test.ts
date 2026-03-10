import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { startManagedOpenCodeServer } from './openCodeManagedServer';

describe('startManagedOpenCodeServer (exit before ready)', () => {
  it('includes signal and a no-output marker when the child exits without stdout/stderr', async () => {
    const prevCmd = process.env.HAPPIER_OPENCODE_PATH;
    const dir = await mkdtemp(join(tmpdir(), 'happier-opencode-managed-exit-'));
    const scriptPath = join(dir, 'fake-opencode');
    try {
      await writeFile(
        scriptPath,
        `#!/usr/bin/env node
process.exit(3);
`,
        'utf8',
      );
      await chmod(scriptPath, 0o755);
      process.env.HAPPIER_OPENCODE_PATH = scriptPath;

      await expect(startManagedOpenCodeServer({ timeoutMs: 5_000 })).rejects.toThrow(/signal=/);
      await expect(startManagedOpenCodeServer({ timeoutMs: 5_000 })).rejects.toThrow(/no output captured/i);
    } finally {
      if (prevCmd === undefined) delete process.env.HAPPIER_OPENCODE_PATH;
      else process.env.HAPPIER_OPENCODE_PATH = prevCmd;
      await rm(dir, { recursive: true, force: true });
    }
  });
});

