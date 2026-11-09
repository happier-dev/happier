import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { createExternalSessionContentSearchControl, ExternalSessionContentSearchYield, prefilterExternalSessionContentPaths, searchExternalSessionContent } from './contentSearch.js';
import { readJsonlFileForwardLines } from './boundedJsonlScanner.js';

afterEach(() => vi.restoreAllMocks());

describe('decoded external conversation content search', () => {
  it('retains exact per-file admission when a multi-file offset response exceeds the host output budget', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-prefilter-budget-'));
    try {
      const paths = ['first', process.platform === 'win32' ? 'second' : 'second:with\nseparator', 'third']
        .map(name => join(root, `${name}.jsonl`));
      const rows = ['unrelated', ...Array.from({ length: 8 }, () => 'needle'), 'ordinary'];
      await Promise.all(paths.map(path => writeFile(path, rows.map(text => JSON.stringify({ text })).join('\n') + '\n')));
      const launcher = fileURLToPath(new URL('../../../../../apps/cli/scripts/ripgrep_launcher.cjs', import.meta.url));
      // The genuine process boundary reports its bounded output. Derive this
      // fixture's ceiling from one file, so only aggregate output overflows.
      let outputBudget: number | undefined;
      const run = async ({ args, paths }: { args: readonly string[]; paths: readonly string[] }) => {
        if (outputBudget === undefined) {
          const single = await promisify(execFile)(process.execPath, [launcher, JSON.stringify([
            ...args.map(arg => arg === '--heading' ? '--no-heading' : arg), '--', paths[0],
          ])]);
          outputBudget = Buffer.byteLength(single.stdout);
        }
        const result = await promisify(execFile)(process.execPath, [launcher, JSON.stringify([...args, '--', ...paths])]);
        return { ...result, exitCode: 0, stdoutTruncated: Buffer.byteLength(result.stdout) > outputBudget };
      };
      const result = await prefilterExternalSessionContentPaths({ query: 'needle', paths, ripgrep: { run }, lineOffsets: true });
      const expected = rows.flatMap((text, index) => text === 'needle'
        ? [Buffer.byteLength(rows.slice(0, index).map(text => JSON.stringify({ text })).join('\n') + '\n')]
        : []);
      expect(result).toEqual(new Map(paths.map(path => [path, expected])));
      // One indivisible file can still exhaust the real boundary. It must not
      // turn into a proven miss merely because framing is more compact.
      await expect(prefilterExternalSessionContentPaths({ query: 'needle', paths: [paths[0]!],
        ripgrep: { run: async request => ({ ...await run(request), stdoutTruncated: true }) }, lineOffsets: true })).resolves.toBeNull();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('keeps mixed JSON escapes and JavaScript ASCII folds without admitting unrelated Unicode escapes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-prefilter-spellings-'));
    try {
      const miss = join(root, 'unrelated.jsonl');
      const mixed = join(root, 'mixed.jsonl');
      const kelvin = join(root, 'kelvin.jsonl');
      const dotted = join(root, 'dotted.jsonl');
      const long = join(root, 'long.jsonl');
      const nul = join(root, 'nul.jsonl');
      // The candidate request schema permits 2,000 UTF-16 units.
      const longQuery = 'a'.repeat(2000);
      await writeFile(miss, '{"text":"unrelated \\u001b escape"}\n');
      await writeFile(mixed, JSON.stringify({ text: 'Need"le\nC:\\work/x' }).replace('Need', 'N\\u0065ed').replace('/x', '\\/x') + '\n');
      await writeFile(kelvin, '{"text":"\\u212a sign"}\n');
      await writeFile(dotted, '{"text":"\\u0130"}\n');
      await writeFile(long, JSON.stringify({ text: longQuery }) + '\n');
      // Native JSONL can retain a damaged record before a readable message.
      // rg's directory traversal otherwise silently drops the whole file.
      await writeFile(nul, '\0\n' + JSON.stringify({ text: 'test-r101 traced all 23' }) + '\n');
      const launcher = fileURLToPath(new URL('../../../../../apps/cli/scripts/ripgrep_launcher.cjs', import.meta.url));
      const ripgrep = { run: async ({ args, paths }: { args: readonly string[]; paths: readonly string[] }) => {
        try {
          const result = await promisify(execFile)(process.execPath, [launcher, JSON.stringify([...args, '--', ...paths])]);
          return { ...result, exitCode: 0 };
        } catch (error) {
          if (typeof error === 'object' && error !== null && 'code' in error && error.code === 1) return { exitCode: 1, stdout: '', stderr: '' };
          throw error;
        }
      } };
      for (const [query, path] of [['need"le\nc:\\work/x', mixed], ['k sign', kelvin], ['i', dotted], [longQuery, long], ['test-r101 traced all 23', nul]]) {
        const paths = await prefilterExternalSessionContentPaths({ query: query!, paths: [root], ripgrep });
        expect(paths?.has(path!)).toBe(true);
        expect(paths?.has(miss)).toBe(false);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('matches decoded text and keeps the transcript ordinal rather than the rg line', async () => {
    const result = await searchExternalSessionContent({
      query: 'café\n"needle"', paths: ['native.jsonl'],
      ripgrep: { run: async () => ({ exitCode: 0, stdout: 'native.jsonl\0', stderr: '' }) },
      control: createExternalSessionContentSearchControl({}),
      decode: async (matchText) => ({ records: [
        { id: 'tool' },
        { id: 'body', snippet: matchText('prefix café\n"needle" suffix') ?? undefined },
      ], partial: true }),
    });
    expect(result).toEqual({ match: { sourceItemId: 'body', messageIndex: 1, snippet: 'prefix café\n"needle" suffix' }, partial: true });
  });

  it('prefilters ASCII with escaped records admitted, and excludes a decoded non-match', async () => {
    let patterns: readonly string[] = [];
    const result = await searchExternalSessionContent({
      query: 'needle', paths: ['native.jsonl'],
      ripgrep: { run: async ({ args }) => { patterns = args; return { exitCode: 0, stdout: 'native.jsonl\0', stderr: '' }; } },
      control: createExternalSessionContentSearchControl({}),
      decode: async (matchText) => ({ records: [{ id: 'body', snippet: matchText('ordinary body') ?? undefined }], partial: false }),
    });
    expect(patterns).toContain('needle');
    expect(patterns).not.toContain('\\u');
    expect(result).toEqual({ partial: false });
  });

  it('decodes truncated prefilters and Unicode folding that rg cannot safely exclude', async () => {
    const run = vi.fn(async () => ({ exitCode: 1, stdout: '', stderr: '', stdoutTruncated: true }));
    for (const query of ['needle', 'İstanbul']) {
      const result = await searchExternalSessionContent({ query, paths: ['native.jsonl'], ripgrep: { run },
        control: createExternalSessionContentSearchControl({}),
        decode: async (matchText) => ({ records: [{ id: 'body', snippet: matchText(`before ${query} after`) ?? undefined }], partial: false }),
      });
      expect(result.match?.snippet).toContain(query);
    }
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('does not decode a proven prefilter miss and propagates prefilter failures', async () => {
    const decode = vi.fn(async () => ({ records: [], partial: false }));
    const base = { query: 'needle', paths: ['native.jsonl'], control: createExternalSessionContentSearchControl({}), decode };
    expect(await searchExternalSessionContent({ ...base, ripgrep: { run: async () => ({ exitCode: 1, stdout: '', stderr: '' }) } })).toEqual({ partial: false });
    expect(decode).not.toHaveBeenCalled();
    await expect(searchExternalSessionContent({ ...base, ripgrep: { run: async () => ({ exitCode: 2, stdout: '', stderr: 'IO failed' }) } })).rejects.toThrow();
  });

  it('uses the actual host deadline even after an earlier decode step was expensive', () => {
    let nowMs = 100;
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    const control = createExternalSessionContentSearchControl({ deadlineAtMs: 1000 });
    control.checkWork();
    nowMs = 500;
    control.checkWork();
    nowMs = 700;
    expect(() => control.checkWork()).not.toThrow();
    nowMs = 999;
    expect(() => control.checkWork()).not.toThrow();
    nowMs = 1000;
    expect(() => control.checkWork()).toThrow(ExternalSessionContentSearchYield);
    expect(() => control.assertNotYielded()).toThrow(ExternalSessionContentSearchYield);
  });

  it('normalizes repeated native path groups once before sparse scanner admission', async () => {
    const path = 'native.jsonl';
    const result = await prefilterExternalSessionContentPaths({ query: 'needle', paths: [path, path], lineOffsets: true,
      ripgrep: { run: async () => ({ exitCode: 0, stdout: `${path}\x000:-\n20:-\n\n${path}\x000:-\n20:-\n`, stderr: '' }) } });
    expect(result?.get(path)).toEqual([0, 20]);
  });

  it('keeps cancellation distinct from cooperative partial yield', async () => {
    const abort = new AbortController();
    const reason = new Error('cancelled');
    abort.abort(reason);
    await expect(searchExternalSessionContent({ query: 'needle', control: createExternalSessionContentSearchControl({ signal: abort.signal }),
      decode: async () => ({ records: [], partial: false }),
    })).rejects.toBe(reason);
  });

  it('commits real metadata preparation before yielding and resumes under the same budget', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-content-preparation-'));
    try {
      const names = ['first.jsonl', 'second.jsonl', 'third.jsonl'];
      await Promise.all(names.map((name, index) => writeFile(join(root, name), 'x'.repeat(index + 1))));
      let nowMs = 100;
      vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
      let progress = { offset: 0, files: [] as { name: string; size: number }[] };
      for (let page = 0; page < names.length; page += 1) {
        const control = createExternalSessionContentSearchControl({ deadlineAtMs: nowMs + 20 });
        // Source admission already consumed most of the same caller budget.
        nowMs += 14;
        const preparation = control.prepare(async () => {
          const name = names[progress.offset]!;
          const metadata = await stat(join(root, name));
          progress.files.push({ name, size: metadata.size });
          progress.offset += 1;
          nowMs += 12;
          return progress.offset === names.length;
        });
        if (page === names.length - 1) await expect(preparation).resolves.toBeUndefined();
        else await expect(preparation).rejects.toBeInstanceOf(ExternalSessionContentSearchYield);
        expect(progress.offset).toBe(page + 1);
        // Producers retain serializable native state, not an SDK registry.
        progress = JSON.parse(JSON.stringify(progress));
      }
      expect(progress.files).toEqual(names.map((name, index) => ({ name, size: index + 1 })));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps preparation cancellation hard before and after a committed step', async () => {
    const abort = new AbortController();
    const reason = new Error('cancelled during preparation');
    const control = createExternalSessionContentSearchControl({ signal: abort.signal });
    let offset = 0;
    await expect(control.prepare(async () => {
      offset += 1;
      abort.abort(reason);
      return false;
    })).rejects.toBe(reason);
    expect(offset).toBe(1);
    await expect(control.prepare(async () => {
      offset += 1;
      return true;
    })).rejects.toBe(reason);
    expect(offset).toBe(1);
  });

  it('yields when an empty decoded reply has consumed the host deadline', async () => {
    let nowMs = 100;
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    await expect(searchExternalSessionContent({ query: 'needle', control: createExternalSessionContentSearchControl({ deadlineAtMs: 1000 }),
      decode: async () => { nowMs = 1000; return { records: [], partial: false }; },
    })).rejects.toBeInstanceOf(ExternalSessionContentSearchYield);
  });

  it('finishes source-verified EOF under cancellation after the last indivisible scan unit crosses the scan deadline', async () => {
    let nowMs = 100;
    let complete = false;
    let cancelAtEof = false;
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    const abort = new AbortController();
    const reason = new Error('cancelled at EOF');
    const run = () => searchExternalSessionContent({
      query: 'needle',
      control: createExternalSessionContentSearchControl({ signal: abort.signal, deadlineAtMs: nowMs + 900 }),
      isScanComplete: () => complete,
      decode: async (matchText) => {
        nowMs += 1000;
        complete = true;
        if (cancelAtEof) abort.abort(reason);
        return { records: [{ id: 'native-body', messageIndex: 12, snippet: matchText('native needle') ?? undefined }], partial: true };
      },
    });
    expect(await run()).toEqual({ match: { sourceItemId: 'native-body', messageIndex: 12, snippet: 'native needle' }, partial: true });
    cancelAtEof = true;
    await expect(run()).rejects.toBe(reason);
  });

  it('resumes older native pages and re-decodes the earliest hit with its full ordinal', async () => {
    let nowMs = 100;
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    const progress = { cursor: undefined as string | undefined, complete: false, itemCount: 0,
      match: null as null | { cursor?: string; id: string; distanceFromEnd: number } };
    const abort = new AbortController();
    let retainedText = 'oldest needle';
    const run = () => {
      const control = createExternalSessionContentSearchControl({ signal: abort.signal, deadlineAtMs: nowMs + 10 });
      // Revalidating the native source on each page consumes the caller budget.
      nowMs += 8;
      return searchExternalSessionContent({
        query: 'needle', pageProgress: progress,
        control,
        async decode(matchText: (text: string) => string | null, cursor?: string) {
          nowMs += 20;
          const records = cursor === 'oldest'
            ? [{ id: 'first' }, { id: 'earliest', snippet: matchText(retainedText) ?? undefined }]
            : cursor === 'middle' ? [{ id: 'middle' }]
            : [{ id: 'latest', snippet: matchText('latest needle') ?? undefined }];
          return { records, partial: false, nextCursor: cursor === 'oldest' ? null : cursor === 'middle' ? 'oldest' : 'middle' };
        },
      });
    };
    await expect(run()).rejects.toBeInstanceOf(ExternalSessionContentSearchYield);
    expect(progress.cursor).toBe('middle');
    await expect(run()).rejects.toBeInstanceOf(ExternalSessionContentSearchYield);
    expect(progress.cursor).toBe('oldest');
    expect(await run()).toEqual({ match: { sourceItemId: 'earliest', messageIndex: 1, snippet: 'oldest needle' }, partial: false });
    // Even a completed continuation's locator must re-decode and re-match.
    retainedText = 'edited without a hit';
    expect(await run()).toEqual({ partial: true });
    abort.abort(new Error('cancelled after native EOF'));
    await expect(run()).rejects.toThrow('cancelled after native EOF');
  });

  it('admits a streaming native unit after slow source verification and prefiltering', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-content-streaming-'));
    try {
      const filePath = join(root, 'native.jsonl');
      const firstLine = '{"body":"first"}\n';
      const content = firstLine + '{"body":"second"}\n';
      await writeFile(filePath, content);
      let nowMs = 100;
      let offsetBytes = 0;
      let complete = false;
      vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
      const abort = new AbortController();
      const run = async () => {
        const control = createExternalSessionContentSearchControl({ signal: abort.signal, deadlineAtMs: nowMs + 20 });
        const metadata = await stat(filePath);
        nowMs += 14;
        return searchExternalSessionContent({
          query: 'needle', ...(offsetBytes === 0 ? { paths: [filePath] } : {}), control,
          isScanComplete: () => complete,
          ripgrep: { run: async () => { nowMs += 12; return { exitCode: 0, stdout: `${filePath}\0`, stderr: '' }; } },
          decode: async () => {
            await control.prepare(async () => {
              const page = await readJsonlFileForwardLines({ filePath, offsetBytes, maxBytes: metadata.size, maxItems: 1,
                fileSystem: createExternalSessionContentSearchControl({ signal: abort.signal }).fileSystem });
              offsetBytes = page.nextOffsetBytes;
              complete = page.reachedEnd;
              return complete;
            });
            return { records: [], partial: false };
          },
        });
      };
      await expect(run()).rejects.toBeInstanceOf(ExternalSessionContentSearchYield);
      expect(offsetBytes).toBe(Buffer.byteLength(firstLine));
      await expect(run()).resolves.toEqual({ partial: false });
      expect(offsetBytes).toBe(Buffer.byteLength(content));
      const reason = new Error('cancelled before next streaming unit');
      abort.abort(reason);
      await expect(run()).rejects.toBe(reason);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('finishes short native decode steps without treating the slow prefilter as their cost', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-content-phase-'));
    try {
      const filePath = join(root, 'native.jsonl');
      const content = ['first body', 'second needle', 'last body'].map((body) => JSON.stringify({ body })).join('\n') + '\n';
      await writeFile(filePath, content);
      let nowMs = 0;
      vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
      const deadlineAtMs = 15_000;
      const control = createExternalSessionContentSearchControl({ deadlineAtMs });
      const metadata = await stat(filePath);
      nowMs += 1_000;
      let offsetBytes = 0;
      let complete = false;
      const result = await searchExternalSessionContent({
        query: 'needle', paths: [filePath], control,
        isScanComplete: () => complete,
        ripgrep: { run: async () => { nowMs += 8_000; return { exitCode: 0, stdout: `${filePath}\0`, stderr: '' }; } },
        decode: async (matchText) => {
          const records: { id: string; snippet?: string }[] = [];
          await control.prepare(async () => {
            const page = await readJsonlFileForwardLines({ filePath, offsetBytes, maxBytes: metadata.size, maxItems: 1,
              fileSystem: createExternalSessionContentSearchControl({}).fileSystem });
            nowMs += 1_000;
            for (const line of page.items) {
              const value = line.value;
              if (typeof value === 'object' && value !== null && 'body' in value && typeof value.body === 'string') {
                records.push({ id: String(line.startOffsetBytes), snippet: matchText(value.body) ?? undefined });
              }
            }
            offsetBytes = page.nextOffsetBytes;
            complete = page.reachedEnd;
            return complete;
          });
          return { records, partial: false };
        },
      });
      expect(result).toEqual({ match: { snippet: 'second needle', sourceItemId: String(Buffer.byteLength('{"body":"first body"}\n')), messageIndex: 1 }, partial: false });
      expect(offsetBytes).toBe(Buffer.byteLength(content));
      expect(nowMs).toBeLessThan(deadlineAtMs);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
