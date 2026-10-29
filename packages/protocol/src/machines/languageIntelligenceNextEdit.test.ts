import { describe, expect, it } from 'vitest';
import { validateLanguageIntelligenceNextEdit, validateLanguageIntelligenceNextEditInput, type LanguageIntelligencePredictedEdit } from './languageIntelligence.js';
import { applyWorkspaceFileTextEdits } from './workspaceFilesReplace.js';

const captured = { path: 'src/a.ts', version: 2, text: 'const renamed = "🦊";\r\nold();\r\n' };
const edit: LanguageIntelligencePredictedEdit = { path: captured.path,
  range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } }, oldText: 'old', newText: 'renamed' };

describe('next-edit admission', () => {
  it('keeps exact CRLF and Unicode and drops a valid no-op', () => {
    const edits = validateLanguageIntelligenceNextEdit(captured, captured, [edit]);
    expect(edits).toEqual([edit]);
    expect(applyWorkspaceFileTextEdits(captured.text, edits!.map(edit => ({ range: edit.range, text: edit.newText }))).text)
      .toBe('const renamed = "🦊";\r\nrenamed();\r\n');
    expect(validateLanguageIntelligenceNextEdit(captured, captured, [{ ...edit, newText: 'old' }])).toEqual([]);
  });
  it('refuses stale version/text, wrong path, overlap, out-of-range and split UTF-16 scalar boundaries as a whole', () => {
    for (const current of [{ ...captured, version: 3 }, { ...captured, text: captured.text + ' ' }])
      expect(validateLanguageIntelligenceNextEdit(captured, current, [edit])).toBeNull();
    for (const invalid of [
      [{ ...edit, path: '../outside' }], [{ ...edit, path: 'src/b.ts' }], [{ ...edit, oldText: 'stale' }],
      [edit, edit], [edit, { ...edit, range: { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } }, oldText: 'd()' }],
      [{ ...edit, range: { start: { line: 3, character: 0 }, end: { line: 3, character: 0 } }, oldText: '' }],
      [{ ...edit, range: { start: { line: 1, character: 6 }, end: { line: 1, character: 7 } }, oldText: '\r' }],
      [{ ...edit, range: { start: { line: 0, character: 18 }, end: { line: 0, character: 19 } }, oldText: '\udd8a' }],
      [{ ...edit, newText: '\ud800' }],
    ]) expect(validateLanguageIntelligenceNextEdit(captured, captured, invalid)).toBeNull();
    expect(validateLanguageIntelligenceNextEdit(captured, captured, [edit], { start: { line: 0, character: 0 }, end: { line: 0, character: 21 } })).toBeNull();
  });
  it('verifies chronological history and exact target bytes against the captured document', () => {
    const input = { connectionId: 'source', modelId: 'model', document: captured.text,
      target: { range: { start: { line: 0, character: 0 }, end: { line: 2, character: 0 } }, text: captured.text },
      recentEdits: [{ baseVersion: 1, version: 2, range: { start: { line: 0, character: 6 }, end: { line: 0, character: 9 } }, oldText: 'old', newText: 'renamed' }] };
    expect(validateLanguageIntelligenceNextEditInput(input, 2)).toBe(true);
    expect(validateLanguageIntelligenceNextEditInput(input, 3)).toBe(false);
    expect(validateLanguageIntelligenceNextEditInput({ ...input, target: { ...input.target, text: 'stale' } }, 2)).toBe(false);
    expect(validateLanguageIntelligenceNextEditInput({ ...input, recentEdits: [...input.recentEdits, ...input.recentEdits] }, 2)).toBe(false);
    expect(validateLanguageIntelligenceNextEditInput({ ...input, recentEdits: [{ ...input.recentEdits[0], newText: 'wrong' }] }, 2)).toBe(false);
  });
});
