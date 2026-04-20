import { describe, expect, it } from 'vitest';

import { PromptFoldersV1Schema } from './promptFoldersV1.js';

describe('promptFoldersV1 schema', () => {
  it('preserves additive fields on folder payloads', () => {
    const parsed = PromptFoldersV1Schema.parse({
      v: 1,
      folders: [
        { id: 'root', name: 'Root', parentId: null, futureFolderField: true },
      ],
      futureFoldersEnvelope: {
        kind: 'prompt_folders.v2',
      },
    });

    expect((parsed as any).futureFoldersEnvelope).toEqual({
      kind: 'prompt_folders.v2',
    });
    expect((parsed.folders[0] as any)?.futureFolderField).toBe(true);
  });

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
