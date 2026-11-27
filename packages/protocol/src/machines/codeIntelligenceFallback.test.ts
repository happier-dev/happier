import { describe, expect, it } from 'vitest';
import { queryCodeIntelligenceFallback, CodeIntelligenceFallbackInputSchema, CodeIntelligenceFallbackResultSchema } from './codeIntelligenceFallback.js';
import { DaemonWorkspaceFileSearchRequestSchema, DaemonWorkspaceFileSearchResponseSchema } from './workspaceFiles.js';
import { RPC_ERROR_CODES, RpcError } from '../rpc/errors.js';

describe('code name-search fallback', () => {
  it('uses declaration data per language and ranks same-file and nearby paths', async () => {
    const input = { rootPath: '/repo', path: 'src/current.py', line: 20, symbol: 'greet', languageId: 'python', kind: 'definition' as const };
    const result = await queryCodeIntelligenceFallback(input, async raw => {
      const request = DaemonWorkspaceFileSearchRequestSchema.parse(raw);
      expect(new RegExp(request.query, 'u').test('def greet(name):')).toBe(true);
      return DaemonWorkspaceFileSearchResponseSchema.parse({ ok: true, files: ['far/a.py', 'src/a.py', 'src/current.py'].map(path => ({ path,
        matches: [{ line: 3, column16: 1, length16: 9, text: 'def greet(name):', before: [], after: [] }] })), hasMore: false, coverage: 'complete' });
    });
    expect(CodeIntelligenceFallbackResultSchema.parse(result)).toMatchObject({ status: 'ok', source: 'text_matches',
      locations: [{ path: 'src/current.py', range: { start: { line: 2, character: 4 } } }, { path: 'src/a.py' }, { path: 'far/a.py' }] });
  });

  it('escapes identifier regex syntax, handles repeated matches, and preserves an empty successful search', async () => {
    const input = { rootPath: '/repo', path: 'a.ts', line: 1, symbol: '$item', kind: 'references' as const };
    const result = await queryCodeIntelligenceFallback(input, async request => {
      const pattern = new RegExp(request.query, 'u');
      expect(pattern.test('$item + $item')).toBe(true);
      return { ok: true, files: [{ path: 'a.ts', matches: [
        { line: 1, column16: 1, length16: 5, text: '$item + $item', before: [], after: [] },
        { line: 1, column16: 9, length16: 5, text: '$item + $item', before: [], after: [] },
        { line: 2, column16: 1, length16: 5, text: '$items', before: [], after: [] },
      ] }], hasMore: false, coverage: 'complete' };
    });
    expect(result).toMatchObject({ status: 'ok', locations: [{ range: { start: { character: 0 } } }, { range: { start: { character: 8 } } }] });
    expect(await queryCodeIntelligenceFallback(input, async () => ({ ok: true, files: [], hasMore: false, coverage: 'complete' })))
      .toEqual({ status: 'ok', source: 'text_matches', locations: [], hasMore: false, coverage: 'complete' });
    expect(CodeIntelligenceFallbackInputSchema.safeParse({ ...input, character: 4 }).success).toBe(false);
    expect(CodeIntelligenceFallbackInputSchema.safeParse({ ...input, path: '../outside.ts' }).success).toBe(false);
    for (const [code, reason] of [
      [RPC_ERROR_CODES.METHOD_NOT_AVAILABLE, 'target_unavailable'],
      [RPC_ERROR_CODES.METHOD_NOT_FOUND, 'update_required'],
      [RPC_ERROR_CODES.UPDATE_REQUIRED, 'update_required'],
    ] as const) {
      await expect(queryCodeIntelligenceFallback(input, async () => { throw new RpcError(code, code); }))
        .resolves.toEqual({ status: 'unavailable', reason });
      await expect(queryCodeIntelligenceFallback(input, async () => ({ ok: false, errorCode: code })))
        .resolves.toEqual({ status: 'unavailable', reason });
    }
  });

  it('preserves Unicode identifier UTF-16 ranges', async () => {
    const result = await queryCodeIntelligenceFallback({ rootPath: '/repo', path: 'a.ts', line: 1, symbol: '𝒜', kind: 'references' }, async request => {
      expect(request.regex).toBe(true);
      return { ok: true, files: [{ path: 'a.ts', matches: [{ line: 1, column16: 1, length16: 2, text: '𝒜 + 𝒜', before: [], after: [] }] }], hasMore: false, coverage: 'complete' };
    });
    expect(result).toMatchObject({ status: 'ok', locations: [{ range: { start: { character: 0 }, end: { character: 2 } } }] });
  });
});
