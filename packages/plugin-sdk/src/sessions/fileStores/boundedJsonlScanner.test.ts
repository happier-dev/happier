import { appendFile, mkdir, mkdtemp, open, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildHappierBaseSystemPromptV1 } from '@happier-dev/protocol/prompts/systemPromptBaseV1';

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
  it('reports unreadable history as a read failure and only missing history as empty', async () => {
    const { readJsonlFileBackwardPage } = await import('./boundedJsonlScanner.js');
    const page = (code: string) => readJsonlFileBackwardPage({ filePath: 'history.jsonl', endOffsetBytes: null,
      maxBytes: 4096, maxItems: 10, fileSystem: {
        stat: async () => { throw Object.assign(new Error('Filesystem failure'), { code }); },
        read: async () => { throw new Error('Cannot read a file without stat'); },
      } });
    await expect(page('EACCES')).rejects.toMatchObject({ code: 'EACCES' });
    await expect(page('EIO')).rejects.toMatchObject({ code: 'EIO' });
    await expect(page('ENOENT')).resolves.toMatchObject({ items: [], reachedStart: true });
  });
  it('assembles forward multi-chunk records with linear buffer copying and exact page continuation', async () => {
    const scanner = await import('./boundedJsonlScanner.js');
    const root = await mkdtemp(join(tmpdir(), 'happier-jsonl-allocation-'));
    tempDirs.add(root);
    const filePath = join(root, 'transcript.jsonl');
    const text = 'café 😀 '.repeat(160_000);
    const first = jsonlLine({ text });
    const second = jsonlLine({ text: 'next record' });
    await writeFile(filePath, first + second);
    let copiedBytes = 0;
    const concat = Buffer.concat;
    // Observe the actual platform allocation; framing and parsing stay real.
    const allocation = vi.spyOn(Buffer, 'concat').mockImplementation((buffers, length) => {
      copiedBytes += length ?? buffers.reduce((sum, buffer) => sum + buffer.byteLength, 0);
      return concat(buffers, length);
    });
    try {
      const page = await scanner.readJsonlFileForwardLines({ filePath, offsetBytes: 0,
        maxBytes: Buffer.byteLength(first + second), maxItems: 1, chunkBytes: 64 * 1024 });
      expect(page.items.map(line => line.value)).toEqual([{ text }]);
      expect(page.nextOffsetBytes).toBe(Buffer.byteLength(first));
      expect(page.reachedEnd).toBe(false);
      const next = await scanner.readJsonlFileForwardLines({ filePath, offsetBytes: page.nextOffsetBytes,
        maxBytes: Buffer.byteLength(second), maxItems: 1 });
      expect(next.items.map(line => line.value)).toEqual([{ text: 'next record' }]);
      expect(next.reachedEnd).toBe(true);
      // One assembly per completed record; permit one extra source-sized copy.
      // Repeatedly copying the growing carry exceeds this by an order of magnitude.
      expect(copiedBytes).toBeLessThanOrEqual(2 * Buffer.byteLength(first + second));
    } finally { allocation.mockRestore(); }
  });

  it.each(['forward', 'backward'] as const)(
    'keeps exact record offsets around leading and consecutive separators in the %s scanner',
    async (direction) => {
      const scanner = await loadScanner();
      const root = await mkdtemp(join(tmpdir(), 'happier-file-store-separators-'));
      tempDirs.add(root);
      const filePath = join(root, `${direction}.jsonl`);
      const first = jsonlLine({ text: 'café 😀' });
      const body = `\n\r\n${first}\n${jsonlLine({ text: 'last' })}`;
      await writeFile(filePath, body);
      const page = direction === 'forward'
        ? await scanner.readJsonlFileForward({ filePath, offsetBytes: 0, maxBytes: 4096, maxItems: 10 })
        : await scanner.readJsonlFileBackwardPage({ filePath, endOffsetBytes: null, maxBytes: 4096, maxItems: 10 });
      expect(page.items).toEqual([
        { value: { text: 'café 😀' }, startOffsetBytes: 3, endOffsetBytes: 3 + Buffer.byteLength(first) - 1 },
        { value: { text: 'last' }, startOffsetBytes: 4 + Buffer.byteLength(first), endOffsetBytes: Buffer.byteLength(body) - 1 },
      ]);
      expect(page.diagnostics ?? []).toEqual([]);
    },
  );
  it('retains complete malformed records for tolerant transcript projection without consuming a partial tail', async () => {
    const scanner = await import('./index.js');
    const root = await mkdtemp(join(tmpdir(), 'happier-malformed-records-'));
    tempDirs.add(root);
    const filePath = join(root, 'transcript.jsonl');
    const first = jsonlLine({ text: 'before' });
    const malformed = '{broken native record}\n';
    const body = first + malformed + jsonlLine({ text: 'after' });
    await writeFile(filePath, body);
    const backward = await scanner.readJsonlFileBackwardPage({ filePath, endOffsetBytes: null,
      maxBytes: 4096, maxItems: 10, includeMalformedRecords: true });
    expect(backward.items.map(item => item.value)).toEqual([{ text: 'before' }, null, { text: 'after' }]);
    expect(backward.items[1]?.startOffsetBytes).toBe(Buffer.byteLength(first));
    const forward = await scanner.readJsonlFileForward({ filePath, offsetBytes: 0,
      maxBytes: 4096, maxItems: 2, includeMalformedRecords: true });
    expect(forward.items.map(item => item.value)).toEqual([{ text: 'before' }, null]);
    expect(forward.nextOffsetBytes).toBe(Buffer.byteLength(first + malformed));
    const remaining = await scanner.readJsonlFileForward({ filePath, offsetBytes: forward.nextOffsetBytes,
      maxBytes: 4096, maxItems: 10, includeMalformedRecords: true });
    expect(remaining.items.map(item => item.value)).toEqual([{ text: 'after' }]);
    await appendFile(filePath, '{"unfinished":');
    const tail = await scanner.readJsonlFileForward({ filePath, offsetBytes: Buffer.byteLength(body),
      maxBytes: 4096, maxItems: 10, includeMalformedRecords: true });
    expect(tail.items).toEqual([]);
    expect(tail.nextOffsetBytes).toBe(Buffer.byteLength(body));
    expect(tail.reachedEnd).toBe(false);
  });

  it('retains forward source diagnostics before a consumed native line yields', async () => {
    const scanner = await import('./index.js');
    const root = await mkdtemp(join(tmpdir(), 'happier-forward-progress-'));
    tempDirs.add(root);
    const filePath = join(root, 'transcript.jsonl');
    const body = Buffer.concat([Buffer.from([0xff, 0x0a]), Buffer.from(jsonlLine({ text: 'native row' }))]);
    await writeFile(filePath, body);
    const diagnostics: unknown[] = [];
    const yielded = new Error('host work yielded');
    await expect(scanner.readJsonlFileForwardLines({
      filePath, offsetBytes: 0, maxBytes: body.length, maxItems: body.length,
      onDiagnostic(diagnostic) { diagnostics.push(diagnostic); },
      onLine() { throw yielded; },
    })).rejects.toBe(yielded);
    expect(diagnostics).toEqual([{ code: 'malformed_source_utf8', count: 1, positions: [0] }]);
  });

  it('retains newest-first consumed lines and diagnostics before a backward read yields', async () => {
    const scanner = await import('./index.js');
    const root = await mkdtemp(join(tmpdir(), 'happier-backward-progress-'));
    tempDirs.add(root);
    const filePath = join(root, 'transcript.jsonl');
    const prefix = Buffer.from(jsonlLine({ text: 'older' }));
    const body = Buffer.concat([prefix, Buffer.alloc(1024, 0x20), Buffer.from('\n'), Buffer.from([0xff, 0x0a]), Buffer.from(jsonlLine({ text: 'newest' }))]);
    await writeFile(filePath, body);
    const consumed: unknown[] = [];
    const diagnostics: unknown[] = [];
    let endOffsetBytes = body.length;
    const yielded = new Error('host work yielded');
    await expect(scanner.readJsonlFileBackwardPage({ filePath, endOffsetBytes: body.length, maxBytes: body.length, maxItems: body.length,
      chunkBytes: 1024, onLine(line) { consumed.push(line.value); endOffsetBytes = line.startOffsetBytes; },
      onDiagnostic(diagnostic) { diagnostics.push(diagnostic.code); },
      fileSystem: { stat, async read(path, position, length) {
        if (position === 0) throw yielded;
        const handle = await open(path, 'r');
        try { const buffer = Buffer.alloc(length); const { bytesRead } = await handle.read(buffer, 0, length, position); return buffer.subarray(0, bytesRead); }
        finally { await handle.close(); }
      } },
    })).rejects.toBe(yielded);
    expect(consumed).toEqual([{ text: 'newest' }]);
    expect(diagnostics).toEqual(['malformed_source_utf8']);
    const remaining = await scanner.readJsonlFileBackwardPage({ filePath, endOffsetBytes, maxBytes: body.length, maxItems: body.length });
    expect(remaining.items.map(line => line.value)).toEqual([{ text: 'older' }]);
    expect(remaining.reachedStart).toBe(true);
  });
  it('projects and releases lines before reading the rest while retaining the same page frontier', async () => {
    const scanner = await import('./index.js');
    const first = jsonlLine({ text: 'first' });
    const second = jsonlLine({ text: 'second' });
    const body = Buffer.from(first + second + jsonlLine({ text: 'third' }));
    const projected: unknown[] = [];
    const page = await scanner.readJsonlFileForwardLines({
      filePath: 'stream.jsonl', offsetBytes: 0, maxBytes: body.length, maxItems: 2,
      onLine(line) { projected.push(line.value); },
      fileSystem: {
        async stat() { return { size: body.length, mtimeMs: 0 }; },
        async read(_path, position) {
          if (position > 0) expect(projected).toEqual([{ text: 'first' }]);
          return position === 0 ? body.subarray(0, first.length) : body.subarray(position);
        },
      },
    });
    expect(projected).toEqual([{ text: 'first' }, { text: 'second' }]);
    expect(page.items).toEqual([]);
    expect(page.nextOffsetBytes).toBe(Buffer.byteLength(first + second));
    expect(page.hitPageLimit).toBe(true);
    expect(page.reachedEnd).toBe(false);
  });

  it('propagates stopped projection before reading a later source chunk', async () => {
    const scanner = await import('./index.js');
    const first = Buffer.from(jsonlLine({ text: 'first' }));
    const stopped = new Error('projection cancelled');
    await expect(scanner.readJsonlFileForwardLines({
      filePath: 'stream.jsonl', offsetBytes: 0, maxBytes: first.length * 2, maxItems: 2,
      onLine() { throw stopped; },
      fileSystem: {
        async stat() { return { size: first.length * 2, mtimeMs: 0 }; },
        async read(_path, position) {
          if (position > 0) throw new Error('read after stopped projection');
          return first;
        },
      },
    })).rejects.toBe(stopped);
  });

  it.each(['forward', 'cursor', 'range'] as const)('fails explicitly on a bounded %s record and recovers intact with a larger allowance', async (kind) => {
    const scanner = await import('./index.js');
    const root = await mkdtemp(join(tmpdir(), 'happier-file-store-read-allowance-'));
    tempDirs.add(root);
    const filePath = join(root, 'transcript.jsonl');
    const first = jsonlLine({ id: 1 });
    const value = { id: 2, text: 'x'.repeat(4096) };
    const content = first + jsonlLine(value);
    await writeFile(filePath, content);
    const read = (offset: number, allowance: number) => kind === 'cursor'
      ? scanner.readJsonlAfterCursor({ filePath, cursor: { v: 1, kind: 'byteOffset', offset }, maxBytes: allowance, maxItems: 10 })
      : kind === 'range' ? scanner.readJsonlRange({ filePath, startOffset: offset, maxBytes: allowance })
      : scanner.readJsonlFileForward({ filePath, offsetBytes: offset, maxBytes: 1024, maxOversizeLineBytes: allowance, maxItems: 10 });
    const preceding = await read(0, 1024);
    expect('nextCursor' in preceding ? preceding.nextCursor.offset : 'nextOffset' in preceding ? preceding.nextOffset : preceding.nextOffsetBytes).toBe(first.length);
    await expect(read(first.length, 1024)).rejects.toMatchObject({ code: 'JSONL_RECORD_TOO_LARGE', retryable: false });
    const recovered = await read(first.length, Buffer.byteLength(content));
    expect('lines' in recovered ? recovered.lines.map(line => JSON.parse(line)) : recovered.items.map(line => line.value)).toEqual([value]);
  });

  it.each(['forward', 'backward'] as const)('accepts exact framing allowance in the %s reader', async (direction) => {
    const scanner = await import('./index.js');
    const root = await mkdtemp(join(tmpdir(), 'happier-file-store-exact-allowance-'));
    tempDirs.add(root);
    const filePath = join(root, 'transcript.jsonl');
    const value = { text: 'é'.repeat(1024) };
    const content = jsonlLine(value);
    await writeFile(filePath, content);
    const bounds = { filePath, maxBytes: 1024, maxOversizeLineBytes: Buffer.byteLength(content), maxItems: 1 };
    const page = direction === 'forward'
      ? await scanner.readJsonlFileForward({ ...bounds, offsetBytes: 0 })
      : await scanner.readJsonlFileBackwardPage({ ...bounds, endOffsetBytes: null });
    expect(page.items.map(line => line.value)).toEqual([value]);
  });

  it('distinguishes a bounded parsed page from an incomplete EOF without changing raw-line reads', async () => {
    const scanner = await import('./index.js');
    const root = await mkdtemp(join(tmpdir(), 'happier-file-store-incomplete-'));
    tempDirs.add(root);
    const filePath = join(root, 'transcript.jsonl');
    const first = jsonlLine({ id: 1 });
    const incomplete = '{"id":2';
    await writeFile(filePath, first + incomplete);
    const bounded = await scanner.readJsonlFileForward({ filePath, offsetBytes: 0, maxBytes: first.length, maxItems: 10 });
    expect(bounded).toMatchObject({ nextOffsetBytes: first.length, hitPageLimit: true });
    const pending = await scanner.readJsonlFileForward({ filePath, offsetBytes: bounded.nextOffsetBytes, maxBytes: 1024, maxItems: 10 });
    expect(pending).toMatchObject({ items: [], nextOffsetBytes: first.length, reachedEnd: false, hitPageLimit: false });
    const raw = await scanner.readJsonlFileForwardLines({ filePath, offsetBytes: first.length, maxBytes: 1024, maxItems: 10 });
    expect(raw.items.map((line) => line.rawLine)).toEqual([incomplete]);
    expect(raw.nextOffsetBytes).toBe(first.length + incomplete.length);
    await appendFile(filePath, '}\ninvalid\nnull');
    const completed = await scanner.readJsonlFileForward({ filePath, offsetBytes: pending.nextOffsetBytes, maxBytes: 1024, maxItems: 10 });
    expect(completed.items.map((line) => line.value)).toEqual([{ id: 2 }]);
    expect(completed).toMatchObject({ nextOffsetBytes: (await stat(filePath)).size, reachedEnd: true, hitPageLimit: false });
  });

  it('reports the consumed tail boundary without scanning beyond the existing oversize-line budget', async () => {
    const scanner = await import('./index.js');
    const root = await mkdtemp(join(tmpdir(), 'happier-file-store-tail-boundary-'));
    tempDirs.add(root);
    const filePath = join(root, 'transcript.jsonl');
    const first = jsonlLine({ id: 1 });
    await writeFile(filePath, first + '{"id":2');
    expect(await scanner.readJsonlFileBackwardPage({ filePath, endOffsetBytes: null, maxBytes: 1024, maxItems: 10 }))
      .toMatchObject({ tailOffsetBytes: first.length });
    await appendFile(filePath, '}');
    expect(await scanner.readJsonlFileBackwardPage({ filePath, endOffsetBytes: null, maxBytes: 1024, maxItems: 10 }))
      .toMatchObject({ tailOffsetBytes: (await stat(filePath)).size });
    await writeFile(filePath, first + '{"text":"' + 'x'.repeat(4096));
    await expect(scanner.readJsonlFileBackwardPage({ filePath, endOffsetBytes: null, maxBytes: 1024, maxOversizeLineBytes: 1024, maxItems: 10 }))
      .rejects.toMatchObject({ code: 'JSONL_RECORD_TOO_LARGE', retryable: false });
  });

  it('refuses an oversize unterminated tail across small read chunks', async () => {
    const scanner = await import('./index.js');
    const root = await mkdtemp(join(tmpdir(), 'happier-file-store-oversize-tail-'));
    tempDirs.add(root);
    const filePath = join(root, 'transcript.jsonl');
    const first = jsonlLine({ id: 1 });
    const oversizeLineBytes = 8 * 1024 * 1024;
    const content = first + '{"text":"' + 'x'.repeat(oversizeLineBytes);
    await writeFile(filePath, content);

    await expect(scanner.readJsonlFileBackwardPage({
      filePath, endOffsetBytes: null, maxBytes: 8192, maxItems: 1, chunkBytes: 8192,
    })).rejects.toMatchObject({ code: 'JSONL_RECORD_TOO_LARGE', retryable: false });
  });

  it('never publishes a backward continuation inside a valid oversized UTF-8 row', async () => {
    const scanner = await import('./index.js');
    const root = await mkdtemp(join(tmpdir(), 'happier-file-store-oversize-utf8-'));
    tempDirs.add(root);
    const filePath = join(root, 'transcript.jsonl');
    const content = jsonlLine({ id: 1, pad: '🙂'.repeat(2_100_000) });
    await writeFile(filePath, content);
    await expect(scanner.readJsonlFileBackwardPage({ filePath, endOffsetBytes: null, maxBytes: 8192, maxItems: 1 }))
      .rejects.toMatchObject({ code: 'JSONL_RECORD_TOO_LARGE', retryable: false });
  });

  it.each([false, true])('paginates complete oversize records across read chunks with trailing newline=%s', async (trailingNewline) => {
    const scanner = await import('./index.js');
    const root = await mkdtemp(join(tmpdir(), 'happier-file-store-oversize-pages-'));
    tempDirs.add(root);
    const filePath = join(root, 'transcript.jsonl');
    const values = Array.from({ length: 3 }, (_, id) => ({ id, text: '€'.repeat(2500) }));
    const lines = values.map(jsonlLine);
    const content = lines.join('').slice(0, trailingNewline ? undefined : -1);
    await writeFile(filePath, content);

    let endOffsetBytes: number | null = null;
    for (let index = values.length - 1; index >= 0; index -= 1) {
      const page = await scanner.readJsonlFileBackwardPage({
        filePath,
        endOffsetBytes,
        maxBytes: 1024,
        maxOversizeLineBytes: 8192,
        maxItems: 1,
        chunkBytes: 1024,
      });
      const startOffsetBytes = Buffer.byteLength(lines.slice(0, index).join(''));
      expect(page.items).toEqual([{
        value: values[index],
        startOffsetBytes,
        endOffsetBytes: startOffsetBytes + Buffer.byteLength(lines[index]!) - 1,
      }]);
      expect(page).toMatchObject({
        tailOffsetBytes: endOffsetBytes ?? Buffer.byteLength(content),
        nextEndOffsetBytes: startOffsetBytes,
        reachedStart: index === 0,
      });
      endOffsetBytes = page.nextEndOffsetBytes;
    }
  });

  it.each([false, true])('preserves requested byte anchors for short filesystem reads with carry=%s', async (withCarry) => {
    const scanner = await import('./index.js');
    const record = Buffer.from(JSON.stringify({ id: 2 }));
    const source = Buffer.alloc(2048, 0x20);
    source[0] = 0x0a;
    source.set(withCarry ? record : Buffer.concat([Buffer.from('\n'), record]), 1024);

    const page = await scanner.readJsonlFileBackwardPage({
      filePath: 'short-read.jsonl',
      endOffsetBytes: null,
      maxBytes: 2048,
      maxItems: 1,
      chunkBytes: 1024,
      // The filesystem boundary allows reads shorter than the requested span.
      fileSystem: {
        async stat() {
          return { size: source.length, mtimeMs: 0 };
        },
        async read(_filePath, position, length) {
          const returnedLength = position === 1024 ? record.length + (withCarry ? 0 : 1) : 1;
          return source.subarray(position, position + Math.min(length, returnedLength));
        },
      },
    });

    const startOffsetBytes = withCarry ? 1024 : 1025;
    expect(page).toMatchObject({
      items: [{
        value: { id: 2 },
        startOffsetBytes,
        endOffsetBytes: withCarry ? 1024 + record.length : source.length,
      }],
      nextEndOffsetBytes: startOffsetBytes,
      tailOffsetBytes: source.length,
      reachedStart: false,
    });
  });

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

  it('skips injected-only user records when deriving the first real user text', async () => {
    const scanner = await loadScanner();
    const root = await mkdtemp(join(tmpdir(), 'happier-file-store-real-user-'));
    tempDirs.add(root);
    const filePath = join(root, 'session.jsonl');
    await writeFile(filePath, [
      { type: 'session', id: 'session', timestamp: '2026-07-21T10:00:00.000Z', cwd: '/repo' },
      { type: 'message', message: { role: 'user', content: buildHappierBaseSystemPromptV1() } },
      { type: 'message', message: { role: 'user', content: 'Review the release branch' } },
    ].map(jsonlLine).join(''));
    expect((await scanner.scanJsonlSessionFile(filePath))?.firstUserMessage).toBe('Review the release branch');
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
