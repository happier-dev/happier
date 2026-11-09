import { describe, expect, it } from 'vitest';
import * as intelligence from './languageIntelligence.js';
import { applyWorkspaceFileTextEdits } from './workspaceFilesReplace.js';

const input = { connectionId: 'source', modelId: 'model', document: 'function renamed() {}\r\nold();\r\n',
  target: { range: { start: { line: 0, character: 0 }, end: { line: 2, character: 0 } }, text: 'function renamed() {}\r\nold();\r\n' },
  recentEdits: [{ baseVersion: 1, version: 2, range: { start: { line: 0, character: 9 }, end: { line: 0, character: 12 } }, oldText: 'old', newText: 'renamed' }] };

describe('the dedicated rewrite-window codec', () => {
  it('emits only the three changed identifier spans in a distant rename window', () => {
    const lines = [input.document.split('\r\n')[0], ...Array.from({ length: 1000 }, (_, index) => `// unchanged ${index}`)];
    for (const line of [18, 36, 56]) lines[line] = 'const price = formatPrice(value);';
    const document = lines.join('\r\n');
    const request = { ...input, document, target: { text: document, range: { start: { line: 0, character: 0 }, end: { line: 1000, character: lines[1000].length } } } };
    const rewritten = document.replaceAll('formatPrice', 'formatMoney');
    const edits = intelligence.decodeNextEditRewriteWindow('a.ts', request, 2, rewritten, true);
    expect(edits).toEqual([18, 36, 56].map(line => ({ path: 'a.ts',
      range: { start: { line, character: 20 }, end: { line, character: 25 } }, oldText: 'Price', newText: 'Money' })));
    expect(applyWorkspaceFileTextEdits(document, edits!.map(edit => ({ range: edit.range, text: edit.newText }))).text).toBe(rewritten);
  });
  it('separates same-line changes without splitting UTF-16 or CRLF, including inserted and removed lines', () => {
    const document = 'function renamed() {}\r\n😀 formatPrice(a); formatPrice(b);\r\nremove();\r\nkeep();\r\n';
    const rewritten = 'function renamed() {}\r\n😃 formatMoney(a); formatMoney(b);\r\nkeep();\r\ninsert();\r\n';
    const request = { ...input, document, target: { text: document, range: { start: { line: 0, character: 0 }, end: { line: 4, character: 0 } } } };
    const edits = intelligence.decodeNextEditRewriteWindow('a.ts', request, 2, rewritten, true);
    expect(edits).toEqual([
      { path: 'a.ts', range: { start: { line: 1, character: 0 }, end: { line: 1, character: 2 } }, oldText: '😀', newText: '😃' },
      { path: 'a.ts', range: { start: { line: 1, character: 9 }, end: { line: 1, character: 14 } }, oldText: 'Price', newText: 'Money' },
      { path: 'a.ts', range: { start: { line: 1, character: 25 }, end: { line: 1, character: 30 } }, oldText: 'Price', newText: 'Money' },
      { path: 'a.ts', range: { start: { line: 2, character: 0 }, end: { line: 3, character: 0 } }, oldText: 'remove();\r\n', newText: '' },
      { path: 'a.ts', range: { start: { line: 4, character: 0 }, end: { line: 4, character: 0 } }, oldText: '', newText: 'insert();\r\n' },
    ]);
    expect(applyWorkspaceFileTextEdits(document, edits!.map(edit => ({ range: edit.range, text: edit.newText }))).text).toBe(rewritten);
  });
  it('encodes ordered original/current/updated sections and decodes replacement data into exact UTF-16 edits', () => {
    expect(intelligence.encodeNextEditRewriteWindow).toBeDefined();
    const encoded = intelligence.encodeNextEditRewriteWindow('a.ts', input, 2)!;
    expect(encoded.prompt).toBe('<|file_sep|>a.ts.diff\noriginal:\nfunction old() {}\r\nold();\r\n\nupdated:\nfunction renamed() {}\r\nold();\r\n\n<|file_sep|>original/a.ts\nfunction old() {}\r\nold();\r\n\n<|file_sep|>current/a.ts\nfunction renamed() {}\r\nold();\r\n\n<|file_sep|>updated/a.ts\n');
    expect(encoded.stop).toEqual(['<|file_sep|>', '</s>']);
    expect(intelligence.decodeNextEditRewriteWindow('a.ts', input, 2, input.document.replace('old();', 'renamed();'), true)).toEqual([
      { path: 'a.ts', range: { start: { line: 1, character: 0 }, end: { line: 1, character: 2 } }, oldText: 'ol', newText: 'rename' },
    ]);
  });
  it('rejects truncated, malformed and stale rewrites and drops a complete no-op', () => {
    expect(intelligence.decodeNextEditRewriteWindow).toBeDefined();
    expect(intelligence.decodeNextEditRewriteWindow('a.ts', input, 2, input.document, true)).toEqual([]);
    for (const [text, complete] of [[input.document.slice(0, 8), false], ['<|file_sep|>other.ts\ncode', true], ['\ud800', true]] as const)
      expect(intelligence.decodeNextEditRewriteWindow('a.ts', input, 2, text, complete)).toBeNull();
    expect(intelligence.decodeNextEditRewriteWindow('a.ts', input, 3, input.document, true)).toBeNull();
  });
  it('round-trips insertions, deletions, repeated lines and line-ending changes within the captured window', () => {
    const tails = ['', 'a', 'a\r\n', 'a\n', 'a\r', '😀 a();\r\n', 'a\r\na\r\n', 'b\r\na\r\n', 'a\r\nb\r\n'];
    for (const before of tails) for (const after of tails) {
      const document = `function renamed() {}\r\n${before}`;
      const end = document.split(/\r\n|\r|\n/u);
      const request = { ...input, document, target: { text: document, range: {
        start: { line: 0, character: 0 }, end: { line: end.length - 1, character: end.at(-1)!.length },
      } } };
      const edits = intelligence.decodeNextEditRewriteWindow('a.ts', request, 2, `function renamed() {}\r\n${after}`, true);
      expect(edits, JSON.stringify({ before, after })).not.toBeNull();
      expect(applyWorkspaceFileTextEdits(document, edits!.map(edit => ({ range: edit.range, text: edit.newText }))).text).toBe(`function renamed() {}\r\n${after}`);
    }
  });
});
