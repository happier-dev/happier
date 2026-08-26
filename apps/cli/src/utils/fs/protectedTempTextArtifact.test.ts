import { lstat, readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import { materializeProtectedTempTextArtifact } from './protectedTempTextArtifact';

describe.runIf(process.platform !== 'win32')('materializeProtectedTempTextArtifact on POSIX', () => {
  it('writes the contents to a protected file and exposes a working idempotent cleanup', async () => {
    const artifact = await materializeProtectedTempTextArtifact({
      prefix: 'happier-test-artifact-',
      contents: 'PRIVATE PROMPT TEXT',
    });

    const fileStats = await lstat(artifact.path);
    expect(fileStats.isFile()).toBe(true);
    expect(fileStats.mode & 0o777).toBe(0o600);
    await expect(readFile(artifact.path, 'utf8')).resolves.toBe('PRIVATE PROMPT TEXT');

    // Directory is per-artifact and owner-only.
    const dirStats = await lstat(artifact.path.slice(0, artifact.path.lastIndexOf('/')));
    expect(dirStats.mode & 0o777).toBe(0o700);

    await artifact.cleanup();
    await expect(lstat(artifact.path)).rejects.toMatchObject({ code: 'ENOENT' });
    // Idempotent: second cleanup must not throw.
    await expect(artifact.cleanup()).resolves.toBeUndefined();
  });

  it('uses a fresh directory per artifact (no reuse between materializations)', async () => {
    const first = await materializeProtectedTempTextArtifact({ prefix: 'happier-test-artifact-', contents: 'a' });
    const second = await materializeProtectedTempTextArtifact({ prefix: 'happier-test-artifact-', contents: 'b' });
    expect(first.path).not.toBe(second.path);
    await first.cleanup();
    await second.cleanup();
  });
});
