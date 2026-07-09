import { mkdir, mkdtemp, open, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

type ByteCursor = Readonly<{ v: 1; kind: 'byteOffset'; offset: number }>;

type ScannerModule = Readonly<{
  decodeJsonlByteCursor(raw: string | null | undefined): ByteCursor | null;
  encodeJsonlByteCursor(cursor: ByteCursor): string;
  readJsonlAfterCursor(params: Readonly<{
    filePath: string;
    cursor: ByteCursor | null;
    maxBytes: number;
    maxItems: number;
  }>): Promise<Readonly<{
    lines: readonly string[];
    nextCursor: ByteCursor;
    truncated: boolean;
  }>>;
  scanJsonlSessionFile(filePath: string, bounds?: Readonly<{
    headBytes?: number;
    tailBytes?: number;
    fullScanLineLimit?: number;
    fileSystem?: Readonly<{
      read(filePath: string, position: number, length: number): Promise<Buffer>;
      stat(filePath: string): Promise<Readonly<{ size: number; mtimeMs: number }>>;
    }>;
  }>): Promise<Readonly<{
    filePath: string;
    sessionId: string;
    cwd: string | null;
    createdAtMs: number | null;
    title: string | null;
    firstUserMessage: string | null;
    lastUserMessage: string | null;
    lastActivityAtMs: number;
  }> | null>;
}>;

const tempDirs = new Set<string>();

async function loadScanner(): Promise<ScannerModule> {
  const loaded = await import('./index.js').catch((error: unknown) => error);
  expect(loaded).not.toBeInstanceOf(Error);
  return loaded as ScannerModule;
}

function jsonlLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

afterEach(async () => {
  await Promise.all([...tempDirs].map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.clear();
});

describe('bounded JSONL session scanner', () => {
  it('derives discovery fields without whole-file reads', async () => {
    const scanner = await loadScanner();
    const root = await mkdtemp(join(tmpdir(), 'happier-file-store-scan-'));
    tempDirs.add(root);
    await mkdir(root, { recursive: true });
    const filePath = join(root, '2026-03-23T13-19-48-646Z_session-1.jsonl');
    const fillerLine = jsonlLine({ type: 'debug', payload: 'x'.repeat(4096) });
    const content = [
      jsonlLine({ type: 'session', id: 'session-1', timestamp: '2026-03-23T13:19:48.646Z', cwd: '/repo' }),
      jsonlLine({ type: 'message', id: 'first', timestamp: '2026-03-23T13:19:49.000Z', message: { role: 'user', content: 'first prompt' } }),
      ...Array.from({ length: 260 }, () => fillerLine),
      jsonlLine({ type: 'session_info', name: 'Tail title', timestamp: '2026-03-23T13:20:00.000Z' }),
      jsonlLine({ type: 'message', id: 'last', timestamp: '2026-03-23T13:20:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'last prompt' }] } }),
    ].join('');
    await writeFile(filePath, content, 'utf8');

    let bytesRead = 0;
    const descriptor = await scanner.scanJsonlSessionFile(filePath, {
      headBytes: 512,
      tailBytes: 1024,
      fullScanLineLimit: 10,
      fileSystem: {
        async stat(path) {
          return await stat(path);
        },
        async read(path, position, length) {
          const handle = await open(path, 'r');
          try {
            const buffer = Buffer.alloc(length);
            const result = await handle.read(buffer, 0, length, position);
            bytesRead += result.bytesRead;
            return buffer.subarray(0, result.bytesRead);
          } finally {
            await handle.close();
          }
        },
      },
    });

    expect(Buffer.byteLength(content, 'utf8')).toBeGreaterThan(1024 * 1024);
    expect(bytesRead).toBeLessThanOrEqual(512 + 1024 + 512);
    expect(descriptor).toEqual(expect.objectContaining({
      filePath,
      sessionId: 'session-1',
      cwd: '/repo',
      createdAtMs: Date.parse('2026-03-23T13:19:48.646Z'),
      title: 'Tail title',
      firstUserMessage: 'first prompt',
      lastUserMessage: 'last prompt',
      lastActivityAtMs: Date.parse('2026-03-23T13:20:01.000Z'),
    }));
  });

  it('returns null for corrupt or headerless files', async () => {
    const scanner = await loadScanner();
    const root = await mkdtemp(join(tmpdir(), 'happier-file-store-corrupt-'));
    tempDirs.add(root);
    const filePath = join(root, 'corrupt.jsonl');
    await writeFile(filePath, `${jsonlLine({ type: 'message', message: { role: 'user', content: 'missing header' } })}{`, 'utf8');

    await expect(scanner.scanJsonlSessionFile(filePath, { headBytes: 128, tailBytes: 128 })).resolves.toBeNull();
  });

  it('reads after byte cursors across appends and honors item limits', async () => {
    const scanner = await loadScanner();
    const root = await mkdtemp(join(tmpdir(), 'happier-file-store-cursor-'));
    tempDirs.add(root);
    const filePath = join(root, 'cursor.jsonl');
    await writeFile(filePath, [
      jsonlLine({ type: 'session', id: 'cursor-session' }),
      jsonlLine({ type: 'message', id: 'one' }),
      jsonlLine({ type: 'message', id: 'two' }),
    ].join(''), 'utf8');

    const firstPage = await scanner.readJsonlAfterCursor({
      filePath,
      cursor: null,
      maxBytes: 1024,
      maxItems: 2,
    });
    expect(firstPage.lines).toHaveLength(2);
    expect(firstPage.truncated).toBe(true);
    expect(firstPage.nextCursor.offset).toBeGreaterThan(0);

    await writeFile(filePath, [
      jsonlLine({ type: 'session', id: 'cursor-session' }),
      jsonlLine({ type: 'message', id: 'one' }),
      jsonlLine({ type: 'message', id: 'two' }),
      jsonlLine({ type: 'message', id: 'three' }),
    ].join(''), 'utf8');

    const secondPage = await scanner.readJsonlAfterCursor({
      filePath,
      cursor: firstPage.nextCursor,
      maxBytes: 1024,
      maxItems: 10,
    });
    expect(secondPage.lines.map((line) => JSON.parse(line) as { id?: string })).toEqual([
      { type: 'message', id: 'two' },
      { type: 'message', id: 'three' },
    ]);
    expect(scanner.decodeJsonlByteCursor(scanner.encodeJsonlByteCursor(secondPage.nextCursor))).toEqual(secondPage.nextCursor);
    expect(scanner.decodeJsonlByteCursor('not-a-cursor')).toBeNull();
  });

  it('does not skip bytes after a chunk ending exactly on a newline', async () => {
    const scanner = await loadScanner();
    const root = await mkdtemp(join(tmpdir(), 'happier-file-store-cursor-boundary-'));
    tempDirs.add(root);
    const filePath = join(root, 'cursor-boundary.jsonl');
    const firstLine = jsonlLine({ type: 'message', id: 'one' });
    const secondLine = jsonlLine({ type: 'message', id: 'two' });
    await writeFile(filePath, `${firstLine}${secondLine}`, 'utf8');

    const firstPage = await scanner.readJsonlAfterCursor({
      filePath,
      cursor: null,
      maxBytes: Buffer.byteLength(firstLine, 'utf8'),
      maxItems: 10,
    });
    expect(firstPage.lines).toEqual([firstLine.trim()]);

    const secondPage = await scanner.readJsonlAfterCursor({
      filePath,
      cursor: firstPage.nextCursor,
      maxBytes: 1024,
      maxItems: 10,
    });

    expect(secondPage.lines).toEqual([secondLine.trim()]);
  });
});
