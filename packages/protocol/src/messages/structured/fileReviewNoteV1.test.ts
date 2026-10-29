import { describe, expect, it } from 'vitest';
import { FileReviewNoteV1Schema, readFileReviewNoteV1, formatFileReviewNoteV1 } from './fileReviewNoteV1.js';

describe('file review notes', () => {
  it('round trips one action covering multiple paths through its transcript reader', () => {
    const payload = FileReviewNoteV1Schema.parse({ action: 'discard', paths: ['src/a.ts', 'src/b.ts'], changeCount: 3, turnId: 'turn-4' });
    expect(readFileReviewNoteV1({ happier: { kind: 'file_review_note.v1', payload } })).toEqual(payload);
    expect(formatFileReviewNoteV1(payload)).toContain('src/b.ts');
    expect(readFileReviewNoteV1({ happier: { kind: 'file_review_note.v1', payload: { action: 'keep', paths: ['src/a.ts'] } } })).toBeNull();
    expect(FileReviewNoteV1Schema.safeParse({ action: 'undo', paths: [] }).success).toBe(false);
  });
  it('keeps mixed successful operations in one item while describing each operation accurately', () => {
    const payload = FileReviewNoteV1Schema.parse({ action: 'mixed', operations: [
      { action: 'discard', paths: ['src/a.ts'], changeCount: 2 },
      { action: 'restore', paths: ['src/b.ts'], turnId: '4' },
    ] });
    expect(readFileReviewNoteV1({ happier: { kind: 'file_review_note.v1', payload } })).toEqual(payload);
    const text = formatFileReviewNoteV1(payload);
    expect(text).toContain('discarded 2 changes in "src/a.ts"');
    expect(text).toContain('restored "src/b.ts"');
  });
  it('attributes review actions to the person for agents without changing transcript copy', () => {
    const discard = { action: 'discard' as const, paths: ['src/a.ts'], changeCount: 2, turnId: '4' };
    expect(formatFileReviewNoteV1(discard)).toBe('You discarded 2 changes in "src/a.ts" (turn "4").');
    expect(formatFileReviewNoteV1(discard, 'person')).toBe(formatFileReviewNoteV1(discard));
    expect(formatFileReviewNoteV1(discard, 'agent')).toBe(
      'The person reviewing your work discarded 2 of your changes in "src/a.ts" (turn "4"). Do not reapply them unless asked.',
    );
    const restore = { action: 'restore' as const, paths: ['src/b.ts'], turnId: '4' };
    expect(formatFileReviewNoteV1(restore)).toBe('You restored "src/b.ts" to before turn "4".');
    expect(formatFileReviewNoteV1(restore, 'agent')).toBe(
      'The person reviewing your work restored "src/b.ts" to before turn "4". Do not undo this restoration unless asked.',
    );
    for (const undoes of ['discard', 'restore'] as const) {
      const undo = { action: 'undo' as const, undoes, paths: ['src/a.ts'], turnId: '4' };
      expect(formatFileReviewNoteV1(undo)).toBe(`You undid the ${undoes} in "src/a.ts" (turn "4").`);
      expect(formatFileReviewNoteV1(undo, 'agent')).toBe(
        `The person reviewing your work undid the ${undoes} in "src/a.ts" (turn "4"). Respect the resulting file state unless asked to change it.`,
      );
    }
    expect(formatFileReviewNoteV1({ action: 'mixed', operations: [discard, restore] }, 'agent')).toBe(
      `${formatFileReviewNoteV1(discard, 'agent')} ${formatFileReviewNoteV1(restore, 'agent')}`,
    );
  });
});
