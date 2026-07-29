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
    lineStartOffsets: readonly number[];
    diagnostics?: readonly Readonly<{
      code: string;
      count: number;
      positions: readonly number[];
    }>[];
    nextCursor: ByteCursor;
    truncated: boolean;
  }>>;
  readJsonlFileBackwardPage(params: Readonly<{
    filePath: string;
    endOffsetBytes: number | null;
    maxBytes: number;
    maxItems: number;
    chunkBytes?: number;
    fileSystem?: Readonly<{
      read(filePath: string, position: number, length: number): Promise<Buffer>;
      stat(filePath: string): Promise<Readonly<{ size: number; mtimeMs: number }>>;
    }>;
  }>): Promise<Readonly<{
    items: readonly unknown[];
    diagnostics?: readonly Readonly<{
      code: string;
      count: number;
      positions: readonly number[];
    }>[];
    nextEndOffsetBytes: number;
    reachedStart: boolean;
  }>>;
  readJsonlFileForward(params: Readonly<{
    filePath: string;
    offsetBytes: number;
    maxBytes: number;
    maxItems: number;
    chunkBytes?: number;
  }>): Promise<Readonly<{
    items: readonly Readonly<{
      value: unknown;
      startOffsetBytes: number;
      endOffsetBytes: number;
    }>[];
    diagnostics?: readonly Readonly<{
      code: string;
      count: number;
      positions: readonly number[];
    }>[];
    nextOffsetBytes: number;
    truncated: boolean;
    reachedEnd: boolean;
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
  it('accepts a fixed-width mutable title slot before the session header', async () => {
    const scanner = await loadScanner();
    const root = await mkdtemp(join(tmpdir(), 'happier-file-store-title-slot-'));
    tempDirs.add(root);
    const filePath = join(root, '2026-07-21T10-00-00-000Z_session-current.jsonl');
    await writeFile(filePath, [
      jsonlLine({
        type: 'title',
        v: 1,
        title: 'Mutable slot title',
        updatedAt: '2026-07-21T10:00:05.000Z',
        pad: ' '.repeat(64),
      }),
      jsonlLine({
        type: 'session',
        version: 3,
        id: 'session-current',
        timestamp: '2026-07-21T10:00:00.000Z',
        cwd: '/repo',
        title: 'Stale header title',
      }),
      jsonlLine({
        type: 'message',
        id: 'user-1',
        parentId: null,
        timestamp: '2026-07-21T10:00:01.000Z',
        message: { role: 'user', content: 'hello' },
      }),
    ].join(''), 'utf8');

    await expect(scanner.scanJsonlSessionFile(filePath)).resolves.toEqual(expect.objectContaining({
      sessionId: 'session-current',
      title: 'Mutable slot title',
      cwd: '/repo',
      createdAtMs: Date.parse('2026-07-21T10:00:00.000Z'),
    }));
  });

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

  it('reports stable source byte offsets and advances by original bytes for malformed UTF-8', async () => {
    const scanner = await loadScanner();
    const root = await mkdtemp(join(tmpdir(), 'happier-file-store-source-offsets-'));
    tempDirs.add(root);
    const filePath = join(root, 'source-offsets.jsonl');
    const firstLine = Buffer.from(`${JSON.stringify({ type: 'message', id: 'one' })}\n`, 'utf8');
    const malformedUtf8Line = Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d, 0x0a]);
    const thirdLine = Buffer.from(`${JSON.stringify({ type: 'message', id: 'three' })}\n`, 'utf8');
    await writeFile(filePath, Buffer.concat([firstLine, malformedUtf8Line, thirdLine]));

    const page = await scanner.readJsonlAfterCursor({
      filePath,
      cursor: null,
      maxBytes: firstLine.byteLength + malformedUtf8Line.byteLength + thirdLine.byteLength,
      maxItems: 10,
    });

    expect(page.lineStartOffsets).toEqual([
      0,
      firstLine.byteLength + malformedUtf8Line.byteLength,
    ]);
    expect(page.diagnostics).toEqual([{
      code: 'malformed_source_utf8',
      count: 1,
      positions: [firstLine.byteLength + 5],
    }]);
    expect(page.nextCursor.offset).toBe(
      firstLine.byteLength + malformedUtf8Line.byteLength + thirdLine.byteLength,
    );
  });

  it('keeps an exact malformed UTF-8 aggregate while bounding retained byte positions', async () => {
    const scanner = await loadScanner();
    const root = await mkdtemp(join(tmpdir(), 'happier-file-store-source-diagnostic-bound-'));
    tempDirs.add(root);
    const filePath = join(root, 'source-diagnostic-bound.jsonl');
    const malformedLine = Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d, 0x0a]);
    const lineCount = 205;
    await writeFile(filePath, Buffer.concat(Array.from({ length: lineCount }, () => malformedLine)));

    const page = await scanner.readJsonlAfterCursor({
      filePath,
      cursor: null,
      maxBytes: malformedLine.byteLength * lineCount,
      maxItems: 1,
    });

    expect(page.lines).toEqual([]);
    expect(page.diagnostics).toEqual([{
      code: 'malformed_source_utf8',
      count: lineCount,
      positions: Array.from(
        { length: 200 },
        (_, index) => index * malformedLine.byteLength + 5,
      ),
    }]);
    expect(page.nextCursor.offset).toBe(malformedLine.byteLength * lineCount);
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

  it('advances backward pages that contain only malformed records', async () => {
    const scanner = await loadScanner();
    const root = await mkdtemp(join(tmpdir(), 'happier-file-store-malformed-backward-'));
    tempDirs.add(root);
    const filePath = join(root, 'malformed-backward.jsonl');
    const content = 'not-json\n{\n';
    await writeFile(filePath, content, 'utf8');

    const page = await scanner.readJsonlFileBackwardPage({
      filePath,
      endOffsetBytes: null,
      maxBytes: 1024,
      maxItems: 10,
    });

    expect(page.items).toEqual([]);
    expect(page.nextEndOffsetBytes).toBe(0);
    expect(page.reachedStart).toBe(true);
  });

  it.each(['forward', 'backward'] as const)(
    'rejects malformed source UTF-8 inside valid JSON without admitting an item in the %s scanner',
    async (direction) => {
      const scanner = await loadScanner();
      const root = await mkdtemp(join(tmpdir(), 'happier-file-store-malformed-utf8-'));
      tempDirs.add(root);
      const filePath = join(root, `${direction}.jsonl`);
      const prefix = Buffer.from('{"type":"message","message":{"content":"', 'utf8');
      const suffix = Buffer.from('"}}\n', 'utf8');
      await writeFile(filePath, Buffer.concat([prefix, Buffer.from([0xff]), suffix]));

      const page = direction === 'forward'
        ? await scanner.readJsonlFileForward({
          filePath,
          offsetBytes: 0,
          maxBytes: 1024,
          maxItems: 10,
        })
        : await scanner.readJsonlFileBackwardPage({
          filePath,
          endOffsetBytes: null,
          maxBytes: 1024,
          maxItems: 10,
        });

      expect(page.items).toEqual([]);
      expect(page.diagnostics).toEqual([{
        code: 'malformed_source_utf8',
        count: 1,
        positions: [prefix.byteLength],
      }]);
    },
  );

  it.each(['forward', 'backward'] as const)(
    'preserves a valid literal replacement character in the %s scanner',
    async (direction) => {
      const scanner = await loadScanner();
      const root = await mkdtemp(join(tmpdir(), 'happier-file-store-valid-replacement-'));
      tempDirs.add(root);
      const filePath = join(root, `${direction}.jsonl`);
      await writeFile(filePath, jsonlLine({ type: 'message', text: '\uFFFD' }), 'utf8');

      const page = direction === 'forward'
        ? await scanner.readJsonlFileForward({
          filePath,
          offsetBytes: 0,
          maxBytes: 1024,
          maxItems: 10,
        })
        : await scanner.readJsonlFileBackwardPage({
          filePath,
          endOffsetBytes: null,
          maxBytes: 1024,
          maxItems: 10,
        });

      expect(page.items).toHaveLength(1);
      expect(page.items[0]).toMatchObject({ value: { text: '\uFFFD' } });
      expect(page.diagnostics ?? []).toEqual([]);
    },
  );

  it.each(['forward', 'backward'] as const)(
    'preserves a valid multibyte scalar split across read chunks in the %s scanner',
    async (direction) => {
      const scanner = await loadScanner();
      const root = await mkdtemp(join(tmpdir(), 'happier-file-store-chunked-utf8-'));
      tempDirs.add(root);
      const filePath = join(root, `${direction}.jsonl`);
      const prefix = Buffer.from('{"text":"', 'utf8');
      const padding = 'x'.repeat(1023 - prefix.byteLength);
      await writeFile(filePath, `{"text":"${padding}€"}\n`, 'utf8');

      const page = direction === 'forward'
        ? await scanner.readJsonlFileForward({
          filePath,
          offsetBytes: 0,
          maxBytes: 4096,
          maxItems: 10,
          chunkBytes: 1024,
        })
        : await scanner.readJsonlFileBackwardPage({
          filePath,
          endOffsetBytes: null,
          maxBytes: 4096,
          maxItems: 10,
          chunkBytes: 1024,
        });

      expect(page.items).toHaveLength(1);
      expect(page.items[0]).toMatchObject({ value: { text: `${padding}€` } });
      expect(page.diagnostics ?? []).toEqual([]);
    },
  );
});
