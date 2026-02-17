import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { writeJsonAtomic } from './writeJsonAtomic';

describe('writeJsonAtomic', () => {
  it('writes JSON content atomically', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-writeJsonAtomic-'));
    const path = join(dir, 'auth.json');

    await writeFile(path, '{"a":1}', 'utf8');
    await writeJsonAtomic(path, { a: 2, b: 'x' });

    const raw = await readFile(path, 'utf8');
    expect(JSON.parse(raw)).toEqual({ a: 2, b: 'x' });
  });
});

