import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

type FsModule = Readonly<{
  writeAtomicJsonFile(input: Readonly<{
    path: string;
    value: unknown;
    mode?: number;
    temporaryDirectory?: string | null;
  }>): Promise<void>;
}>;

async function loadFs(): Promise<FsModule> {
  const loaded = await import('./fs.js').catch((error: unknown) => error);
  expect(loaded).not.toBeInstanceOf(Error);
  return loaded as FsModule;
}

describe('experimental fs helpers', () => {
  it('publishes the fs helper experimental subpath', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { exports?: Record<string, unknown> };

    expect(packageJson.exports).toHaveProperty('./experimental/fs', {
      types: './dist/fs.d.ts',
      default: './dist/fs.js',
    });
  });

  it('atomically publishes JSON through a temporary sibling file', async () => {
    const fs = await loadFs();
    const root = await mkdtemp(join(tmpdir(), 'happier-plugin-sdk-fs-'));
    const path = join(root, 'nested', 'auth.json');

    await fs.writeAtomicJsonFile({
      path,
      value: { token: 'new-token' },
      mode: 0o600,
    });

    expect(await readFile(path, 'utf8')).toBe('{\n  "token": "new-token"\n}\n');
    const entries = await import('node:fs/promises').then(({ readdir }) => readdir(dirname(path)));
    expect(entries).toEqual(['auth.json']);
  });

  it('leaves an existing destination intact when the temp write cannot publish', async () => {
    const fs = await loadFs();
    const root = await mkdtemp(join(tmpdir(), 'happier-plugin-sdk-fs-fail-'));
    const path = join(root, 'auth.json');
    const blockedTmpDir = join(root, 'not-a-directory');
    await writeFile(path, '{"token":"old"}\n', 'utf8');
    await writeFile(blockedTmpDir, 'file blocks temp dir creation', 'utf8');

    await expect(fs.writeAtomicJsonFile({
      path,
      value: { token: 'new' },
      temporaryDirectory: join(blockedTmpDir, 'child'),
    })).rejects.toThrow();

    expect(await readFile(path, 'utf8')).toBe('{"token":"old"}\n');
  });

  it('creates destination parents before publishing', async () => {
    const fs = await loadFs();
    const root = await mkdtemp(join(tmpdir(), 'happier-plugin-sdk-fs-parent-'));
    const path = join(root, 'a', 'b', 'payload.json');

    await mkdir(root, { recursive: true });
    await fs.writeAtomicJsonFile({ path, value: { ok: true } });

    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ ok: true });
  });

  it('rejects values that cannot be represented as a JSON document', async () => {
    const fs = await loadFs();
    const root = await mkdtemp(join(tmpdir(), 'happier-plugin-sdk-fs-json-'));
    const path = join(root, 'payload.json');

    await expect(fs.writeAtomicJsonFile({ path, value: undefined })).rejects.toThrow(TypeError);
    await expect(readFile(path, 'utf8')).rejects.toThrow();
  });
});
