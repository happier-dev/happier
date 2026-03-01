import { mkdtemp, readFile, writeFile, rename as renameMock } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  const actualRename = actual.rename;
  let callCount = 0;

  return {
    ...actual,
    rename: vi.fn(async (from: string, to: string) => {
      callCount += 1;
      if (callCount === 1) {
        const err = new Error('EPERM') as NodeJS.ErrnoException;
        err.code = 'EPERM';
        throw err;
      }
      await actualRename(from, to);
    }),
  };
});

import { writeJsonAtomic } from './writeJsonAtomic';

describe('writeJsonAtomic (windows overwrite)', () => {
  it('overwrites existing file when rename fails with EPERM once', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-writeJsonAtomic-win-'));
    const path = join(dir, 'auth.json');

    await writeFile(path, '{"a":1}', 'utf8');
    await writeJsonAtomic(path, { a: 2, b: 'x' });

    const raw = await readFile(path, 'utf8');
    expect(JSON.parse(raw)).toEqual({ a: 2, b: 'x' });
    expect(renameMock).toHaveBeenCalledTimes(2);
  });
});
