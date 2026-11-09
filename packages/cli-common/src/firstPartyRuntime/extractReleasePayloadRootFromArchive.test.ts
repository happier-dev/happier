import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

import { extractReleasePayloadRootFromArchive } from './extractReleasePayloadRootFromArchive.js';

it.each(['tar.bz2', 'tbz2'])('selects the archive-stem payload root from a %s release with companion directories', async (extension) => {
  const root = await mkdtemp(join(tmpdir(), 'release-payload-bzip2-'));
  try {
    const archiveName = `payload.${extension}`;
    const archivePath = join(root, archiveName);
    // Python stdlib tarfile + bz2: payload/tool and extras/README.
    await writeFile(archivePath, Buffer.from('QlpoOTFBWSZTWfr8tRkAAJZ/gMuQAEBAAPeAJgIcAGYE3mAKCCAAdBKQmRMIaMBP1QehlBKSAaAMgDQAPmunB8WoAFQoiCDLNxhKDV0iiQQQUA5zk/O8jzFgg8YCCq4QoMHg24tTGBoZa+lVaQy+kRsTMlOEyI2p+9I4ZI9l0yRMgdxED+LuSKcKEh9flqMg', 'base64'));
    const extractDir = join(root, 'extract');
    const payloadRoot = await extractReleasePayloadRootFromArchive({ archiveName, archivePath, extractDir });
    expect(payloadRoot).toBe(join(extractDir, 'payload'));
    expect(await readFile(join(payloadRoot, 'tool'), 'utf8')).toBe('payload\n');
    expect(await readFile(join(extractDir, 'extras/README'), 'utf8')).toBe('extra\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
