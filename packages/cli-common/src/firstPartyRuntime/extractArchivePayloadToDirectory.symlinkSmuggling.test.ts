import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as tar from 'tar';
import { describe, expect, it } from 'vitest';

import { extractArchivePayloadToDirectory } from './extractArchivePayloadToDirectory';

describe('extractArchivePayloadToDirectory (symlink smuggling hardening)', () => {
  it('fails closed before writing through a symlink payload path (tar.gz)', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'cli-common-extract-symlink-smuggling-'));
    const payloadDir = join(rootDir, 'payload');
    const outsideDir = join(rootDir, 'outside');
    const extractDir = join(rootDir, 'extract');
    const archivePath = join(rootDir, 'payload.tar.gz');

    try {
      await mkdir(payloadDir, { recursive: true });
      await mkdir(outsideDir, { recursive: true });

      const outsideTargetPath = join(outsideDir, 'pwned.txt');
      await writeFile(outsideTargetPath, 'malicious', 'utf8');

      // Create a symlink inside the payload that escapes the eventual extractDir.
      await symlink(outsideDir, join(payloadDir, 'escape'));

      // Force the archive to contain both:
      // - the symlink entry
      // - a file entry under the symlink path
      // This simulates the classic "symlink smuggling" exploit.
      await tar.c(
        {
          gzip: true,
          file: archivePath,
          cwd: rootDir,
          portable: true,
        },
        ['payload/escape', 'payload/escape/pwned.txt'],
      );

      // Reset the outside file after creating the archive, so a vulnerable extractor overwrites it.
      await writeFile(outsideTargetPath, 'original', 'utf8');

      await expect(
        extractArchivePayloadToDirectory({
          archivePath,
          archiveName: 'payload.tar.gz',
          extractDir,
        }),
      ).rejects.toThrow(/symlink|symbolic|link/i);

      expect(await readFile(outsideTargetPath, 'utf8')).toBe('original');
    } finally {
      await rm(rootDir, { recursive: true, force: true });
}
  });
});
