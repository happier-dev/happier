import { describe, expect, it } from 'vitest';

import { PromptFoldersV1Schema } from './promptFoldersV1.js';

describe('promptFoldersV1 schema', () => {
  it('accepts prompt folders with optional parent ids', () => {
    const parsed = PromptFoldersV1Schema.parse({
      v: 1,
      folders: [
        { id: 'root', name: 'Root', parentId: null },
        { id: 'child', name: 'Child', parentId: 'root' },
      ],
    });

    expect(parsed.folders[1]).toMatchObject({ id: 'child', parentId: 'root' });
  });

  it('defaults to an empty folder list', () => {
    expect(PromptFoldersV1Schema.parse({ v: 1 })).toEqual({ v: 1, folders: [] });
  });
});
