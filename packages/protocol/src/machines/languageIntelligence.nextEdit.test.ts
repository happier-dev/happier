import { describe, expect, it } from 'vitest';
import { DaemonLspQueryRequestSchema, DaemonLspQueryResponseSchema } from './languageIntelligence.js';

const range = { start: { line: 0, character: 0 }, end: { line: 1, character: 6 } };
const nextEdit = { connectionId: 'pc_source', modelId: 'edit-model', document: 'const renamed = 1;\nold();',
  target: { range, text: 'const renamed = 1;\nold();' },
  recentEdits: [{ baseVersion: 1, version: 2, range: { start: { line: 0, character: 6 }, end: { line: 0, character: 9 } }, oldText: 'old', newText: 'renamed' }] };

describe('next-edit Machine contract', () => {
  it('carries chronological active-file history and an explicit target without credential or execution authority', () => {
    const request = { rootPath: '/repo', path: 'src/a.ts', kind: 'ai.nextEdit', version: 2, languageId: 'typescript',
      position: { line: 0, character: 13 }, nextEdit };
    expect(DaemonLspQueryRequestSchema.safeParse(request).success).toBe(true);
    expect(DaemonLspQueryRequestSchema.safeParse({ ...request, nextEdit: { ...nextEdit,
      target: { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 6 } }, text: 'old();' },
    } }).success).toBe(false);
    for (const patch of [{ version: undefined }, { position: undefined }, { inlineSuggestion: { connectionId: 'pc_source', modelId: 'base', prefix: '', suffix: '' } },
      { nextEdit: { ...nextEdit, command: 'write' } }, { path: '../secret' }]) {
      expect(DaemonLspQueryRequestSchema.safeParse({ ...request, ...patch }).success).toBe(false);
    }
    expect(DaemonLspQueryResponseSchema.safeParse({ status: 'ok', kind: 'ai.nextEdit', version: 2,
      edits: [{ path: 'src/a.ts', range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } }, oldText: 'old', newText: 'renamed' }] }).success).toBe(true);
  });
});
