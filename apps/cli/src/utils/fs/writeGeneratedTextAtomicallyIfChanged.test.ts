import { mkdtemp, readFile, readdir, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { writeGeneratedTextAtomicallyIfChanged } from './writeGeneratedTextAtomicallyIfChanged';

describe('writeGeneratedTextAtomicallyIfChanged', () => {
  it('preserves an unchanged asset and atomically replaces changed bytes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-generated-text-'));
    const path = join(dir, 'extension.js');
    await writeFile(path, 'first', { mode: 0o600 });
    const preservedTime = new Date('2020-01-02T03:04:05.000Z');
    await utimes(path, preservedTime, preservedTime);

    await writeGeneratedTextAtomicallyIfChanged({ path, contents: 'first', mode: 0o600 });
    expect((await stat(path)).mtimeMs).toBe(preservedTime.getTime());

    await writeGeneratedTextAtomicallyIfChanged({ path, contents: 'second', mode: 0o600 });
    expect(await readFile(path, 'utf8')).toBe('second');
    if (process.platform !== 'win32') {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
    expect((await readdir(dir)).filter((name) => name.includes('.tmp-'))).toEqual([]);
  });
});
