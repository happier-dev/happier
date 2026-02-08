import { describe, expect, it } from 'vitest';

import { getToolInputSchemaV2 } from '@happier-dev/protocol/tools/v2';

describe('DiffInputV2Schema', () => {
  it('accepts per-file old/new text pairs when unified diffs are unavailable', () => {
    const schema = getToolInputSchemaV2('Diff');
    const parsed = schema.safeParse({
      files: [
        { file_path: 'a.txt', oldText: 'old', newText: 'new' },
        { file_path: 'b.txt', oldText: '', newText: 'created' },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts snake_case old/new text pairs in files[] entries', () => {
    const schema = getToolInputSchemaV2('Diff');
    const parsed = schema.safeParse({
      files: [{ file_path: 'a.txt', old_text: 'old', new_text: 'new' }],
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects files[] entries that omit unified_diff and old/new pairs', () => {
    const schema = getToolInputSchemaV2('Diff');
    const parsed = schema.safeParse({
      files: [{ file_path: 'a.txt' }],
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.some((issue) => issue.message.includes('Diff.files entries must include unified_diff'))).toBe(
      true,
    );
  });
});
