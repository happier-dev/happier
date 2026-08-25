import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createTypescriptModuleInspectionSession,
} from './typescriptModuleInspection.ts';

const fixtureRoots: string[] = [];
afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'happier-typescript-inspection-'));
  fixtureRoots.push(root);
  await mkdir(join(root, 'plug#in'), { recursive: true });
  return root;
}

describe('per-Plugin TypeScript inspection worker', () => {
  it('loads several authored modules through one isolated process', async () => {
    const root = await createFixture();
    const first = join(root, 'plug#in', 'first.ts');
    const second = join(root, 'plug#in', 'second.ts');
    await writeFile(first, 'export const FIRST = { value: 1 };\n', 'utf8');
    await writeFile(second, 'export const SECOND = { value: 2 };\n', 'utf8');
    let spawnCount = 0;
    const session = createTypescriptModuleInspectionSession({ onSpawn: () => { spawnCount += 1; } });
    try {
      await expect(session.inspect(first)).resolves.toMatchObject({ FIRST: { value: 1 } });
      await expect(session.inspect(second)).resolves.toMatchObject({ SECOND: { value: 2 } });
      expect(spawnCount).toBe(1);
    } finally {
      await session.close();
    }
  }, 120_000);

  it('carries a multi-byte character that straddles a stdout chunk boundary', async () => {
    // The worker answers over a pipe, and a pipe hands back chunks with no
    // regard for character boundaries. This is the real shape of a bundled
    // plugin manifest: its translations carry CJK, and a corrupted one is
    // published into `.happier-plugin/plugin.json` as mojibake with valid JSON
    // around it, so nothing downstream can notice.
    //
    // The split is unavoidable rather than aimed: every character here is three
    // bytes and the payload is far longer than one pipe chunk, so whatever
    // offset a chunk ends at, it lands mid-character unless it happens to be
    // divisible by three — and the next chunk boundary will not be. Aiming at a
    // single seam instead would depend on the response envelope's own length
    // and would silently stop testing anything.
    const root = await createFixture();
    const wide = join(root, 'plug#in', 'wide.ts');
    const value = '\u8be5'.repeat(80_000);
    await writeFile(
      wide,
      `export const WIDE = { value: ${JSON.stringify(value)} };\n`,
      'utf8',
    );
    const session = createTypescriptModuleInspectionSession();
    try {
      const inspected = await session.inspect(wide) as Readonly<{ WIDE: { value: string } }>;
      expect(inspected.WIDE.value).not.toContain('\ufffd');
      expect(inspected.WIDE.value).toBe(value);
    } finally {
      await session.close();
    }
  }, 120_000);

  it('contains an authored module that terminates its worker process', async () => {
    const root = await createFixture();
    const terminating = join(root, 'plug#in', 'terminating.ts');
    await writeFile(terminating, 'process.exit(23);\n', 'utf8');
    const session = createTypescriptModuleInspectionSession();
    try {
      await expect(session.inspect(terminating)).rejects.toThrow(/worker exited/u);
    } finally {
      await session.close();
    }
  }, 120_000);
});
