import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { prepareMinisignSecretKeyFile } from '../pipeline/release/lib/binary-release.mjs';

test('prepareMinisignSecretKeyFile accepts existing key path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'happier-minisign-key-path-'));
  const keyPath = join(dir, 'release.key');
  await writeFile(keyPath, 'untrusted comment: minisign secret key\nRWQ....\n', 'utf-8');
  const prepared = await prepareMinisignSecretKeyFile(keyPath);
  assert.equal(prepared.path, keyPath);
  assert.equal(prepared.temp, false);
});

test('prepareMinisignSecretKeyFile materializes inline key content', async () => {
  const keyContent = 'untrusted comment: minisign secret key\nRWQ....\n';
  const prepared = await prepareMinisignSecretKeyFile(keyContent);
  assert.equal(prepared.temp, true);
  const written = await readFile(prepared.path, 'utf-8');
  assert.equal(written, keyContent);
});

test('prepareMinisignSecretKeyFile rejects likely-truncated minisign key headers (dotenv-safe guidance)', async () => {
  await assert.rejects(
    () => prepareMinisignSecretKeyFile('untrusted comment: minisign secret key'),
    /truncated|dotenv|multiline|file/i,
  );
});

test('prepareMinisignSecretKeyFile rejects short single-line key values that are not file paths', async () => {
  await assert.rejects(
    () => prepareMinisignSecretKeyFile('RWQpH1vH1vH1vH1vH1vH1vH1vH1vH1vH1vH1vH1vH1'),
    /truncated|dotenv|multiline|file|path/i,
  );
});
