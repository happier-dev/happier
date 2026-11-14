import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, utimes, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { syncGeneratedDirectorySync } from './writeChangedFile.mjs';

test('a generated directory republishes only real changes and removes files no longer produced', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'happier-website-generated-'));
  try {
    const files = new Map([['ru/agents.json', '{"a":1}'], ['ru/_routes.json', '{}'], ['de/agents.json', '{"b":2}']]);
    assert.deepEqual(syncGeneratedDirectorySync(dir, files), { written: 3, removed: 0 });
    await mkdir(join(dir, 'pl'), { recursive: true });
    await writeFile(join(dir, 'pl', 'old.json'), '{}');
    for (const path of files.keys()) await utimes(join(dir, path), 1_000_000, 1_000_000);

    const next = new Map(files).set('de/agents.json', '{"b":3}');
    assert.deepEqual(syncGeneratedDirectorySync(dir, next), { written: 1, removed: 1 });
    assert.equal((await stat(join(dir, 'ru/agents.json'))).mtimeMs, 1_000_000_000);
    assert.equal((await stat(join(dir, 'ru/_routes.json'))).mtimeMs, 1_000_000_000);
    assert.equal(await readFile(join(dir, 'de/agents.json'), 'utf8'), '{"b":3}');
    assert.equal(existsSync(join(dir, 'pl')), false);

    assert.deepEqual(syncGeneratedDirectorySync(dir, next), { written: 0, removed: 0 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
