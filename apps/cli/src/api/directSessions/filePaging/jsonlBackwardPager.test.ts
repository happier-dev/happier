import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readJsonlFileBackwardPage } from './jsonlBackwardPager';

function buildJsonl(lines: unknown[], opts?: { trailingNewline?: boolean }): string {
  const trailingNewline = opts?.trailingNewline !== false;
  const joined = lines.map((line) => JSON.stringify(line)).join('\n');
  return trailingNewline ? `${joined}\n` : joined;
}

describe('readJsonlFileBackwardPage', () => {
  it('pages backward from the end in stable order', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-jsonl-backward-'));
    const filePath = join(dir, 't.jsonl');
    await writeFile(filePath, buildJsonl([{ i: 1 }, { i: 2 }, { i: 3 }, { i: 4 }, { i: 5 }]), 'utf8');

    const page1 = await readJsonlFileBackwardPage({ filePath, endOffsetBytes: null, maxBytes: 1024, maxItems: 2 });
    expect(page1.items.map((x) => (x.value as any).i)).toEqual([4, 5]);
    expect(page1.reachedStart).toBe(false);

    const page2 = await readJsonlFileBackwardPage({ filePath, endOffsetBytes: page1.nextEndOffsetBytes, maxBytes: 1024, maxItems: 2 });
    expect(page2.items.map((x) => (x.value as any).i)).toEqual([2, 3]);

    const page3 = await readJsonlFileBackwardPage({ filePath, endOffsetBytes: page2.nextEndOffsetBytes, maxBytes: 1024, maxItems: 2 });
    expect(page3.items.map((x) => (x.value as any).i)).toEqual([1]);
    expect(page3.reachedStart).toBe(true);
  });

  it('includes a trailing line even when the file has no terminal newline', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-jsonl-backward-'));
    const filePath = join(dir, 't.jsonl');
    await writeFile(filePath, buildJsonl([{ i: 1 }, { i: 2 }], { trailingNewline: false }), 'utf8');

    const page = await readJsonlFileBackwardPage({ filePath, endOffsetBytes: null, maxBytes: 1024, maxItems: 10 });
    expect(page.items.map((x) => (x.value as any).i)).toEqual([1, 2]);
  });

  it('keeps scanning backward until it can parse an oversized newest unread line', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-jsonl-backward-'));
    const filePath = join(dir, 't.jsonl');
    const oversized = { i: 2, payload: 'x'.repeat(6 * 1024) };
    await writeFile(filePath, buildJsonl([{ i: 1 }, oversized, { i: 3 }]), 'utf8');

    const page1 = await readJsonlFileBackwardPage({ filePath, endOffsetBytes: null, maxBytes: 1024, maxItems: 1 });
    expect(page1.items.map((x) => (x.value as any).i)).toEqual([3]);

    const page2 = await readJsonlFileBackwardPage({
      filePath,
      endOffsetBytes: page1.nextEndOffsetBytes,
      maxBytes: 1024,
      maxItems: 1,
    });
    expect(page2.items.map((x) => (x.value as any).i)).toEqual([2]);
    expect(page2.nextEndOffsetBytes).toBeLessThan(page1.nextEndOffsetBytes);
  });
});
