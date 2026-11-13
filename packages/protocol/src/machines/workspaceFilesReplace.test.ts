import { describe, expect, it } from 'vitest';
import { buildWorkspaceFileRestoreOperation, computeFileReplacement, type ReplaceMatcher } from './workspaceFilesReplace.js';
import { applyInverseEdits } from '../diff/hunks.js';
import { DaemonWorkspaceFileReplaceApplyRequestSchema } from './workspaceFiles.js';

const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
const literal: ReplaceMatcher = { query: 'old', replacement: 'new', matchCase: true, regex: false };

describe('computeFileReplacement', () => {
  it('restores ordered writer receipts in reverse, including repeated paths and an empty-edit move', () => {
    const first = computeFileReplacement(encode('old'), { ...literal, replacement: 'mid' });
    const second = computeFileReplacement(encode('mid'), { ...literal, query: 'mid', replacement: 'fixed' });
    if (first.kind !== 'ok' || second.kind !== 'ok') throw new Error('Expected text replacements');
    const operation = buildWorkspaceFileRestoreOperation([
      { path: 'a.ts', status: 'replaced', hash: 'a'.repeat(64), edits: first.edits },
      { path: 'source.ts', status: 'replaced', renameTo: 'moved.ts', hash: 'b'.repeat(64), edits: [] },
      { path: 'a.ts', status: 'replaced', hash: 'c'.repeat(64), edits: second.edits },
      { path: 'refused.ts', status: 'changed' },
    ]);
    expect(operation.files.map(file => [file.path, file.expectedHash, file.renameTo])).toEqual([
      ['a.ts', 'c'.repeat(64), undefined], ['moved.ts', 'b'.repeat(64), 'source.ts'], ['a.ts', 'a'.repeat(64), undefined],
    ]);
    let text = 'fixed';
    for (const file of operation.files.filter(file => file.path === 'a.ts')) {
      const restored = applyInverseEdits(text, file.edits);
      expect(restored.ok).toBe(true);
      if (restored.ok) text = restored.text;
    }
    expect(text).toBe('old');
  });
  it('admits guarded semantic edit sets through the canonical multi-file operation schema', () => {
    expect(DaemonWorkspaceFileReplaceApplyRequestSchema.safeParse({ rootPath: '/repo', operation: { kind: 'editSet', files: [
      { path: 'source.ts', expectedHash: 'a'.repeat(64), renameTo: 'renamed.ts', edits: [
        { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, text: 'new' },
      ] },
    ] } }).success).toBe(true);
  });
  it.each<[string, string, ReplaceMatcher, string]>([
    ['BOM and CRLF', '\uFEFFold\r\nold\r\n', literal, '\uFEFFnew\r\nnew\r\n'],
    ['literal dollars and hyphens', 'old-old', { ...literal, query: 'old-', replacement: '$1-' }, '$1-old'],
    ['captures and standard replacement patterns', 'old42 old7', { ...literal, query: 'old(?<n>\\d+)', regex: true, replacement: '$<n>:$1:$&:$$' }, '42:42:old42:$ 7:7:old7:$'],
    ['case insensitive', 'OLD old Old', { ...literal, matchCase: false }, 'new new new'],
    ['line anchors and bare CR', 'old\rold\r\nold\n', { ...literal, query: '^old$', regex: true }, 'new\rnew\r\nnew\n'],
    ['zero width Unicode', '😀x', { ...literal, query: '(?=.)', replacement: '!', regex: true }, '!😀!x'],
    ['lookbehind', 'xold old', { ...literal, query: '(?<=x)old', regex: true }, 'xnew old'],
    ['adjacent deletions', 'old1old2', { ...literal, query: 'old\\d', replacement: '', regex: true }, ''],
    ['replacement context', 'aoldz', { ...literal, regex: true, replacement: "$`-$'" }, 'aa-zz'],
  ])('preserves bytes and JavaScript semantics: %s', (_name, before, matcher, after) => {
    const result = computeFileReplacement(encode(before), matcher);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(decode(result.newBytes)).toBe(after);
    expect(applyInverseEdits(after, result.edits)).toEqual({ ok: true, text: before });
  });

  it('round-trips generated BOM, Unicode, line-ending and replacement-length combinations through the canonical inverse', () => {
    for (let n = 0; n < 64; n++) {
      const before = (n % 2 ? '\uFEFF' : '')
        + Array.from({ length: 1 + n % 7 }, (_value, index) => `😀 old${index} old`).join(n % 3 ? '\r\n' : '\n');
      const result = computeFileReplacement(encode(before), { ...literal, replacement: 'x'.repeat(n % 5) });
      expect(result.kind).toBe('ok');
      if (result.kind !== 'ok') continue;
      expect(applyInverseEdits(decode(result.newBytes), result.edits)).toEqual({ ok: true, text: before });
    }
  });

  it('excludes only the selected original UTF-16 positions and computes final line previews', () => {
    const result = computeFileReplacement(encode('😀 old old\nold'), literal, [{ line: 1, column16: 4 }]);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(decode(result.newBytes)).toBe('😀 old new\nnew');
    expect(result.matches.map(({ line, column16, replacedText }) => ({ line, column16, replacedText }))).toEqual([
      { line: 1, column16: 8, replacedText: '😀 old new' },
      { line: 2, column16: 1, replacedText: 'new' },
    ]);
  });

  it('uses the existing file/search LF line coordinates when content contains a bare CR', () => {
    const result = computeFileReplacement(encode('old\rold\nold'), literal);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.matches.map(({ line, column16 }) => ({ line, column16 }))).toEqual([
      { line: 1, column16: 1 }, { line: 1, column16: 5 }, { line: 2, column16: 1 },
    ]);
    expect(decode(result.newBytes)).toBe('new\rnew\nnew');
  });

  it.each([
    [new Uint8Array([0xff, 0xfe, 0x61, 0]), 'utf16'],
    [new Uint8Array([0xfe, 0xff, 0, 0x61]), 'utf16'],
    [encode('old\0old'), 'binary'],
    [new Uint8Array([0xc3, 0x28]), 'not_text'],
  ])('refuses a non UTF-8 text input', (bytes, reason) => {
    expect(computeFileReplacement(bytes, literal)).toEqual({ kind: 'skip', reason });
  });

  it('returns no edits and identical bytes for no matches', () => {
    const bytes = encode('\uFEFFuntouched\r\n');
    expect(computeFileReplacement(bytes, literal)).toEqual({ kind: 'ok', matches: [], edits: [], newBytes: bytes });
  });

  it('keeps a UTF-8 BOM outside matching while returning raw-text columns and context', () => {
    const result = computeFileReplacement(encode('\uFEFFold\ncontext\nold\nlast'), literal);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.matches[0]).toMatchObject({ line: 1, column16: 2, text: '\uFEFFold', replacedText: '\uFEFFnew', before: [], after: ['context', 'old'] });
    expect(result.matches[1]).toMatchObject({ line: 3, column16: 1, before: ['\uFEFFold', 'context'], after: ['last'] });
    const anchored = computeFileReplacement(encode('\uFEFFold'), { ...literal, query: '^', replacement: '!', regex: true });
    expect(anchored.kind).toBe('ok');
    if (anchored.kind === 'ok') expect(decode(anchored.newBytes)).toBe('\uFEFF!old');
  });

  it.each([
    { ...literal, query: '[', regex: true },
    { ...literal, query: 'old\nold' },
    { ...literal, replacement: 'new\nline' },
    { ...literal, replacement: 'new\0line' },
    { ...literal, replacement: '\uD800' },
  ])('refuses invalid or multiline matchers before applying edits', matcher => {
    expect(() => computeFileReplacement(encode('old'), matcher)).toThrow(SyntaxError);
  });
});
