import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

async function readText(relativePath) {
  return readFile(resolve(repoRoot, relativePath), 'utf8');
}

test('docs docker build copies the UI font assets required by next/font/local', async () => {
  const dockerfile = await readText('Dockerfile');

  assert.match(
    dockerfile,
    /COPY\s+apps\/ui\/sources\/assets\/fonts\s+\.\/apps\/ui\/sources\/assets\/fonts/,
    'docs-builder stage should copy the shared UI font assets into the isolated docs build context'
  );
  assert.match(
    dockerfile,
    /RUN yarn workspace docs postinstall:real && yarn workspace docs build/,
    'docs-builder stage should still build docs after copying the shared font assets'
  );
});
