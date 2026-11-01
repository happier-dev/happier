import { mkdtemp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as tar from 'tar';
import { expect, it } from 'vitest';

import { extractGitHubReleaseAsset } from './extractGitHubReleaseAsset.js';

it('cancels archive extraction before publishing output and awaits staging cleanup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-extract-cancel-'));
  const controller = new AbortController();
  const reason = new Error('stop extracting');
  try {
    const payload = join(root, 'payload');
    await mkdir(payload);
    await writeFile(join(payload, 'runtime'), 'runtime payload');
    const archivePath = join(root, 'runtime.tar.gz');
    await tar.c({ cwd: payload, file: archivePath, gzip: true }, ['runtime']);
    const extractDir = join(root, 'extract');
    const outputPath = join(root, 'published');
    const extracting = extractGitHubReleaseAsset({
      archivePath, archiveName: 'runtime.tar.gz', extractDir, outputPath, signal: controller.signal,
    });
    controller.abort(reason);
    await expect(extracting).rejects.toBe(reason);
    await expect(stat(outputPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(extractDir)).toEqual([]);
    expect((await readdir(root)).filter((name) => name.startsWith('.extract.extract-'))).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
