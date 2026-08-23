import { lstat, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { describe, expect, it } from 'vitest';

import { materializeProtectedTempTextArtifact } from './protectedTempTextArtifact';

describe.runIf(process.platform !== 'win32')('materializeProtectedTempTextArtifact', () => {
  it('writes private text with owner-only permissions and cleans it up idempotently', async () => {
    const artifact = await materializeProtectedTempTextArtifact({
      prefix: 'happier-test-artifact-',
      contents: 'PRIVATE PROMPT TEXT',
    });

    expect((await lstat(artifact.path)).mode & 0o777).toBe(0o600);
    expect((await lstat(dirname(artifact.path))).mode & 0o777).toBe(0o700);
    await expect(readFile(artifact.path, 'utf8')).resolves.toBe('PRIVATE PROMPT TEXT');
    await artifact.cleanup();
    await expect(lstat(artifact.path)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(artifact.cleanup()).resolves.toBeUndefined();
  });
});
