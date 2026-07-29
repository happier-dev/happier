import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { maybeSignFile } from '../pipeline/release/lib/binary-release.mjs';

test('maybeSignFile removes stale signatures when signing is disabled', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'happier-minisign-unsigned-cleanup-'));
  const checksumsPath = join(dir, 'checksums-happier-v1.2.3.txt');
  const staleSignaturePath = `${checksumsPath}.minisig`;
  const envSnapshot = { ...process.env };

  try {
    await writeFile(checksumsPath, 'abc123  happier-v1.2.3-linux-x64.tar.gz\n', 'utf8');
    await writeFile(staleSignaturePath, 'stale signature from a previous signed build\n', 'utf8');
    delete process.env.MINISIGN_SECRET_KEY;
    delete process.env.MINISIGN_PASSPHRASE;

    const signaturePath = await maybeSignFile({ path: checksumsPath });

    assert.equal(signaturePath, null);
    await assert.rejects(() => access(staleSignaturePath), { code: 'ENOENT' });
  } finally {
    process.env = envSnapshot;
    await rm(dir, { recursive: true, force: true });
  }
});
