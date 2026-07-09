import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

type CodecModule = Readonly<{
  isBareSessionFileId(value: string): boolean;
  parseSessionIdFromFileName(fileNameOrPath: string): string | null;
  readSessionIdFromFileHead(filePath: string): Promise<string | null>;
  sessionFileNameMatchesSessionId(fileName: string, sessionId: string): boolean;
}>;

const tempDirs = new Set<string>();

async function loadCodec(): Promise<CodecModule> {
  const loaded = await import('./index.js').catch((error: unknown) => error);
  expect(loaded).not.toBeInstanceOf(Error);
  return loaded as CodecModule;
}

function jsonlLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

afterEach(async () => {
  await Promise.all([...tempDirs].map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.clear();
});

describe('session file-name codec', () => {
  it('uses header ids as authoritative and last-underscore filename ids as advisory', async () => {
    const codec = await loadCodec();
    const root = await mkdtemp(join(tmpdir(), 'happier-file-store-codec-'));
    tempDirs.add(root);
    await mkdir(root, { recursive: true });

    const realId = '4c9a3243-ee7d-4a12-a6fd-032021c8bdab';
    const realFile = join(root, `2026-03-23T13-19-48-646Z_${realId}.jsonl`);
    await writeFile(realFile, jsonlLine({
      type: 'session',
      id: realId,
      timestamp: '2026-03-23T13:19:48.646Z',
      cwd: '/repo',
    }), 'utf8');

    expect(codec.parseSessionIdFromFileName(realFile)).toBe(realId);
    await expect(codec.readSessionIdFromFileHead(realFile)).resolves.toBe(realId);

    const divergentFile = join(root, 'a_b_c.jsonl');
    await writeFile(divergentFile, jsonlLine({
      type: 'session',
      id: 'c',
      timestamp: '2026-03-23T13:19:48.646Z',
      cwd: '/repo',
    }), 'utf8');

    expect(codec.parseSessionIdFromFileName(divergentFile)).toBe('c');
    expect(codec.parseSessionIdFromFileName(divergentFile)).not.toBe('b_c');
    await expect(codec.readSessionIdFromFileHead(divergentFile)).resolves.toBe('c');

    const headerWinsFile = join(root, 'prefix_b_c.jsonl');
    await writeFile(headerWinsFile, jsonlLine({
      type: 'session',
      id: 'b_c',
      timestamp: '2026-03-23T13:19:48.646Z',
      cwd: '/repo',
    }), 'utf8');

    expect(codec.parseSessionIdFromFileName(headerWinsFile)).toBe('c');
    await expect(codec.readSessionIdFromFileHead(headerWinsFile)).resolves.toBe('b_c');
  });

  it('keeps suffix matching parse-direction-free for id-known lookups', async () => {
    const codec = await loadCodec();

    expect(codec.sessionFileNameMatchesSessionId('2026-03-23T13-19-48-646Z_b_c.jsonl', 'b_c')).toBe(true);
    expect(codec.sessionFileNameMatchesSessionId('2026-03-23T13-19-48-646Z_b_c.jsonl', 'c')).toBe(true);
    expect(codec.sessionFileNameMatchesSessionId('session-b_c.jsonl', 'b_c')).toBe(true);
    expect(codec.sessionFileNameMatchesSessionId('b_c.jsonl', 'b_c')).toBe(true);
    expect(codec.sessionFileNameMatchesSessionId('2026-03-23T13-19-48-646Z_other.jsonl', 'b_c')).toBe(false);
    expect(codec.isBareSessionFileId('b_c')).toBe(true);
    expect(codec.isBareSessionFileId('b_c.jsonl')).toBe(false);
  });
});
