import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createNodeArchive, extractNodeArchive } from './node-archive.mjs';

test('node archive extraction accepts first-party release payloads beyond generic file limits', async () => {
  // Release payloads carry bundled runtime dependency trees; the generic 10,000-file ceiling is for provider archives.
  const root = await mkdtemp(path.join(os.tmpdir(), 'happier-node-archive-first-party-scale-'));
  try {
    const source = path.join(root, 'source', 'payload');
    await mkdir(source, { recursive: true });
    await Promise.all(Array.from({ length: 10_001 }, (_, index) => writeFile(path.join(source, `f${index}`), 'x')));
    const archive = path.join(root, 'payload.tar.gz');
    await createNodeArchive({ sourcePath: path.dirname(source), sourceName: 'payload', artifactPath: archive });

    await extractNodeArchive({ archivePath: archive, extractDir: path.join(root, 'extracted') });

    assert.equal(await readFile(path.join(root, 'extracted', 'payload', 'f10000'), 'utf8'), 'x');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
