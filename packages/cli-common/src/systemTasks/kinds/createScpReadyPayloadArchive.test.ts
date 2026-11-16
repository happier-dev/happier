import { execFile } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, it, vi } from 'vitest';

import { createScpReadyPayloadArchive } from './createScpReadyPayloadArchive.js';

const execFileAsync = promisify(execFile);

it.skipIf(process.platform === 'win32')('delivers a read-only payload through platform tar without metadata warnings or changed executable bytes', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'happier-readonly-payload-'));
  const payload = join(scratch, 'payload');
  const nested = join(payload, '.project');
  const longFileName = `${'λ'.repeat(60)}.json`;
  await mkdir(nested, { recursive: true });
  await writeFile(join(payload, 'happier'), '#!/bin/sh\nexit 0\n', { mode: 0o555 });
  await writeFile(join(nested, 'fixture'), 'read-only payload data', { mode: 0o444 });
  await writeFile(join(nested, longFileName), 'long Unicode payload path', { mode: 0o444 });
  await chmod(nested, 0o555);
  await chmod(payload, 0o555);
  vi.stubEnv('TMPDIR', scratch);
  try {
    const archive = await createScpReadyPayloadArchive(payload);
    try {
      const extracted = join(scratch, 'extracted');
      await mkdir(extracted);
      const extraction = await execFileAsync('tar', ['-xf', join(archive.archiveStageRoot, archive.archiveFileName), '-C', extracted]);
      expect(extraction.stderr).toBe('');
      const delivered = join(extracted, archive.extractedPayloadDirName);
      expect(await readFile(join(delivered, '.project', 'fixture'), 'utf8')).toBe('read-only payload data');
      expect(await readFile(join(delivered, '.project', longFileName), 'utf8')).toBe('long Unicode payload path');
      expect(await readFile(join(delivered, 'happier'), 'utf8')).toBe('#!/bin/sh\nexit 0\n');
      expect((await lstat(join(delivered, 'happier'))).mode & 0o111).toBe(0o111);
      expect((await lstat(payload)).mode & 0o777).toBe(0o555);
      expect((await lstat(nested)).mode & 0o777).toBe(0o555);
    } finally {
      await archive.cleanup();
    }
  } finally {
    vi.unstubAllEnvs();
    // Only this test's fixture/scratch may be made writable for removal, including a failed copy.
    const unlock = async (directory: string): Promise<void> => {
      await chmod(directory, 0o700);
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.isDirectory()) await unlock(join(directory, entry.name));
      }
    };
    await unlock(scratch);
    await rm(scratch, { recursive: true, force: true });
  }
});
