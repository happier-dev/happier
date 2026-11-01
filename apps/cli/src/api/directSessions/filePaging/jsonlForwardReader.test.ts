import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { withTempDir } from '@/testkit/fs/tempDir';

import { readJsonlFileForward } from './jsonlForwardReader';

function buildJsonl(lines: unknown[], opts?: { trailingNewline?: boolean }): string {
  const trailingNewline = opts?.trailingNewline !== false;
  const joined = lines.map((line) => JSON.stringify(line)).join('\n');
  return trailingNewline ? `${joined}\n` : joined;
}

describe('readJsonlFileForward', () => {
  it('reads an intact record whose framing exactly fits the caller allowance', async () => withTempDir('happier-jsonl-boundary-', async (dir) => {
    const filePath = join(dir, 't.jsonl');
    const value = { text: 'é'.repeat(1024) };
    const content = JSON.stringify(value) + '\n';
    await writeFile(filePath, content);
    const page = await readJsonlFileForward({ filePath, offsetBytes: 0, maxBytes: 1024,
      maxOversizeLineBytes: Buffer.byteLength(content), maxItems: 1 });
    expect(page.items.map(line => line.value)).toEqual([value]);
  }));

  it('reports an oversized record after returning any preceding complete rows, and permits a larger caller allowance', async () => withTempDir('happier-jsonl-forward-', async (dir) => {
    const filePath = join(dir, 't.jsonl');
    const first = buildJsonl([{ i: 1 }]);
    const oversized = { i: 2, data: 'x'.repeat(4096) };
    await writeFile(filePath, first + buildJsonl([oversized]));
    const page = await readJsonlFileForward({ filePath, offsetBytes: 0, maxBytes: 1024, maxOversizeLineBytes: 1024, maxItems: 10 });
    expect(page.items.map(line => line.value)).toEqual([{ i: 1 }]);
    expect(page.nextOffsetBytes).toBe(Buffer.byteLength(first));
    await expect(readJsonlFileForward({ filePath, offsetBytes: page.nextOffsetBytes, maxBytes: 1024, maxOversizeLineBytes: 1024, maxItems: 10 }))
      .rejects.toMatchObject({ code: 'JSONL_RECORD_TOO_LARGE', maxLineBytes: 1024 });
    const recovered = await readJsonlFileForward({ filePath, offsetBytes: page.nextOffsetBytes, maxBytes: 1024, maxOversizeLineBytes: 8192, maxItems: 10 });
    expect(recovered.items.map(line => line.value)).toEqual([oversized]);
    expect(recovered.reachedEnd).toBe(true);
  }));

  it('reads forward from an offset and advances the cursor', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-jsonl-forward-'));
    const filePath = join(dir, 't.jsonl');
    await writeFile(filePath, buildJsonl([{ i: 1 }, { i: 2 }, { i: 3 }, { i: 4 }, { i: 5 }]), 'utf8');

    const page1 = await readJsonlFileForward({ filePath, offsetBytes: 0, maxBytes: 1024, maxItems: 2 });
    expect(page1.items.map((x) => (x.value as any).i)).toEqual([1, 2]);
    expect(page1.truncated).toBe(false);
    expect(page1.hitPageLimit).toBe(true);

    const page2 = await readJsonlFileForward({ filePath, offsetBytes: page1.nextOffsetBytes, maxBytes: 1024, maxItems: 2 });
    expect(page2.items.map((x) => (x.value as any).i)).toEqual([3, 4]);

    const page3 = await readJsonlFileForward({ filePath, offsetBytes: page2.nextOffsetBytes, maxBytes: 1024, maxItems: 10 });
    expect(page3.items.map((x) => (x.value as any).i)).toEqual([5]);
    expect(page3.reachedEnd).toBe(true);
    expect(page3.hitPageLimit).toBe(false);
  });

  it('distinguishes a byte-limited page from an incomplete line at EOF', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-jsonl-forward-'));
    const filePath = join(dir, 't.jsonl');
    const firstLine = buildJsonl([{ i: 1 }]);
    const partialLine = JSON.stringify({ i: 2 }).slice(0, -1);
    await writeFile(filePath, firstLine + partialLine, 'utf8');

    const limited = await readJsonlFileForward({ filePath, offsetBytes: 0, maxBytes: Buffer.byteLength(firstLine), maxItems: 10 });
    expect(limited.items.map((line) => line.value)).toEqual([{ i: 1 }]);
    expect(limited.hitPageLimit).toBe(true);

    const partial = await readJsonlFileForward({ filePath, offsetBytes: limited.nextOffsetBytes, maxBytes: 1024, maxItems: 10 });
    expect(partial.items).toEqual([]);
    expect(partial.reachedEnd).toBe(false);
    expect(partial.hitPageLimit).toBe(false);
    expect(partial.nextOffsetBytes).toBe(limited.nextOffsetBytes);
  });

  it('parses a final line without a terminal newline when it is valid JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-jsonl-forward-'));
    const filePath = join(dir, 't.jsonl');
    await writeFile(filePath, buildJsonl([{ i: 1 }, { i: 2 }], { trailingNewline: false }), 'utf8');

    const page = await readJsonlFileForward({ filePath, offsetBytes: 0, maxBytes: 1024, maxItems: 10 });
    expect(page.items.map((x) => (x.value as any).i)).toEqual([1, 2]);
    expect(page.nextOffsetBytes).toBeGreaterThan(0);
  });

  it('reports truncation when the file shrinks behind the cursor', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-jsonl-forward-'));
    const filePath = join(dir, 't.jsonl');
    await writeFile(filePath, buildJsonl([{ i: 1 }, { i: 2 }]), 'utf8');

    const first = await readJsonlFileForward({ filePath, offsetBytes: 0, maxBytes: 1024, maxItems: 10 });
    expect(first.truncated).toBe(false);

    // Truncate file.
    await writeFile(filePath, '', 'utf8');

    const after = await readJsonlFileForward({ filePath, offsetBytes: first.nextOffsetBytes, maxBytes: 1024, maxItems: 10 });
    expect(after.truncated).toBe(true);
    expect(after.items).toEqual([]);
    expect(after.nextOffsetBytes).toBe(0);
  });

  it('advances past an oversized first line instead of stalling at the same offset', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-jsonl-forward-'));
    const filePath = join(dir, 't.jsonl');
    const oversized = { kind: 'image', data: 'x'.repeat(300_000) };
    await writeFile(filePath, buildJsonl([oversized, { i: 2 }]), 'utf8');

    const page1 = await readJsonlFileForward({ filePath, offsetBytes: 0, maxBytes: 1024, maxItems: 1 });
    expect(page1.items).toHaveLength(1);
    expect(page1.nextOffsetBytes).toBeGreaterThan(0);

    const page2 = await readJsonlFileForward({ filePath, offsetBytes: page1.nextOffsetBytes, maxBytes: 1024, maxItems: 10 });
    expect(page2.items.map((x) => (x.value as any).i)).toEqual([2]);
  });

  it('advances across complete malformed rows even when no item is returned', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-jsonl-forward-'));
    const filePath = join(dir, 't.jsonl');
    const malformed = `not-json-${'x'.repeat(1500)}\n`;
    await writeFile(filePath, malformed, 'utf8');

    const page = await readJsonlFileForward({ filePath, offsetBytes: 0, maxBytes: 1024, maxItems: 1 });
    expect(page.items).toEqual([]);
    expect(page.nextOffsetBytes).toBe(Buffer.byteLength(malformed));
    expect(page.reachedEnd).toBe(true);
  });
});
