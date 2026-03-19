import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readJsonlFileForward } from './jsonlForwardReader';

function buildJsonl(lines: unknown[], opts?: { trailingNewline?: boolean }): string {
  const trailingNewline = opts?.trailingNewline !== false;
  const joined = lines.map((line) => JSON.stringify(line)).join('\n');
  return trailingNewline ? `${joined}\n` : joined;
}

describe('readJsonlFileForward', () => {
  it('reads forward from an offset and advances the cursor', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-jsonl-forward-'));
    const filePath = join(dir, 't.jsonl');
    await writeFile(filePath, buildJsonl([{ i: 1 }, { i: 2 }, { i: 3 }, { i: 4 }, { i: 5 }]), 'utf8');

    const page1 = await readJsonlFileForward({ filePath, offsetBytes: 0, maxBytes: 1024, maxItems: 2 });
    expect(page1.items.map((x) => (x.value as any).i)).toEqual([1, 2]);
    expect(page1.truncated).toBe(false);

    const page2 = await readJsonlFileForward({ filePath, offsetBytes: page1.nextOffsetBytes, maxBytes: 1024, maxItems: 2 });
    expect(page2.items.map((x) => (x.value as any).i)).toEqual([3, 4]);

    const page3 = await readJsonlFileForward({ filePath, offsetBytes: page2.nextOffsetBytes, maxBytes: 1024, maxItems: 10 });
    expect(page3.items.map((x) => (x.value as any).i)).toEqual([5]);
    expect(page3.reachedEnd).toBe(true);
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
});
