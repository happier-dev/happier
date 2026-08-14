import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { createSignedReleaseAssetEnvelope } from './signed-asset-envelope.mjs';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

test('creates a flat, signed checksum envelope that covers exactly the declared release assets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-signed-envelope-'));
  const assetsDir = join(root, 'assets');
  const binDir = join(root, 'bin');
  const keyPath = join(root, 'release.key');
  const invocationPath = join(root, 'minisign.args');
  try {
    await Promise.all([mkdir(assetsDir), mkdir(binDir)]);
    await Promise.all([
      writeFile(join(assetsDir, 'happier-ui-mobile-v1.2.3.apk'), 'apk-bytes'),
      writeFile(join(assetsDir, 'latest.json'), '{"version":"1.2.3"}\n'),
      writeFile(keyPath, 'test release key\n'),
    ]);
    await writeFile(
      join(binDir, 'minisign'),
      `#!/bin/sh\nset -eu\nprintf '%s\\n' "$*" > ${JSON.stringify(invocationPath)}\nout=''\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = '-x' ]; then out="$2"; shift 2; continue; fi\n  shift\ndone\nprintf 'test signature\\n' > "$out"\n`,
    );
    await chmod(join(binDir, 'minisign'), 0o755);

    const result = await createSignedReleaseAssetEnvelope({
      assetsDir,
      product: 'happier-ui-mobile',
      version: '1.2.3',
      assetNames: ['happier-ui-mobile-v1.2.3.apk', 'latest.json'],
      trustedComment: 'happier-ui-mobile 1.2.3 production',
      env: {
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        MINISIGN_SECRET_KEY: keyPath,
        MINISIGN_PASSPHRASE: '',
      },
    });

    assert.deepEqual((await readdir(assetsDir)).sort(), [
      'checksums-happier-ui-mobile-v1.2.3.txt',
      'checksums-happier-ui-mobile-v1.2.3.txt.minisig',
      'happier-ui-mobile-v1.2.3.apk',
      'latest.json',
    ]);
    assert.equal(result.checksumsName, 'checksums-happier-ui-mobile-v1.2.3.txt');
    assert.equal(result.signatureName, 'checksums-happier-ui-mobile-v1.2.3.txt.minisig');
    assert.equal(
      await readFile(join(assetsDir, result.checksumsName), 'utf8'),
      [
        `${sha256('apk-bytes')}  happier-ui-mobile-v1.2.3.apk`,
        `${sha256('{"version":"1.2.3"}\n')}  latest.json`,
        '',
      ].join('\n'),
    );
    assert.match(await readFile(invocationPath, 'utf8'), /-S/);
    assert.match(await readFile(invocationPath, 'utf8'), /happier-ui-mobile 1\.2\.3 production/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
