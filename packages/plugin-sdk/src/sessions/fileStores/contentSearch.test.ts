import { afterEach, describe, expect, it, vi } from 'vitest';

import { createExternalSessionContentSearchControl, ExternalSessionContentSearchYield, searchExternalSessionContent } from './contentSearch.js';

afterEach(() => vi.restoreAllMocks());

describe('decoded external conversation content search', () => {
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
    expect(patterns).toContain('\\');
    expect(patterns).not.toContain('İ');
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

  it('yields before the next measured decode unit will consume the host deadline', () => {
    let nowMs = 100;
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    const control = createExternalSessionContentSearchControl({ deadlineAtMs: 1000 });
    control.checkWork();
    nowMs = 500;
    control.checkWork();
    nowMs = 700;
    expect(() => control.checkWork()).toThrow(ExternalSessionContentSearchYield);
    expect(() => control.assertNotYielded()).toThrow(ExternalSessionContentSearchYield);
    expect(nowMs).toBeLessThan(1000);
  });

  it('keeps cancellation distinct from cooperative partial yield', async () => {
    const abort = new AbortController();
    const reason = new Error('cancelled');
    abort.abort(reason);
    await expect(searchExternalSessionContent({ query: 'needle', control: createExternalSessionContentSearchControl({ signal: abort.signal }),
      decode: async () => ({ records: [], partial: false }),
    })).rejects.toBe(reason);
  });

  it('yields when an empty decoded reply has consumed the host deadline', async () => {
    let nowMs = 100;
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    await expect(searchExternalSessionContent({ query: 'needle', control: createExternalSessionContentSearchControl({ deadlineAtMs: 1000 }),
      decode: async () => { nowMs = 1000; return { records: [], partial: false }; },
    })).rejects.toBeInstanceOf(ExternalSessionContentSearchYield);
  });
});
