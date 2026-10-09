import { describe, expect, it } from 'vitest';

import { PromptFoldersV1Schema } from './promptFoldersV1.js';
import * as folders from './promptFoldersV1.js';

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

describe('canonical library folder mutations', () => {
  it('creates nested folders and preserves personal organization through rename and move', () => {
    const current = PromptFoldersV1Schema.parse({ v: 1, folders: [{ id: 'root', name: 'Root' }],
      artifactHeadersById: { memory: { folderId: 'root', tags: ['facts'] } } });
    const created = folders.createPromptFolderV1(current, { id: 'child', name: '  New   folder ', parentId: 'root' });
    expect(created.folders[1]).toEqual({ id: 'child', name: 'New folder', parentId: 'root' });
    const renamed = folders.renamePromptFolderV1(created, { folderId: 'child', name: 'Research' });
    expect(folders.movePromptFolderV1(renamed, { folderId: 'child', parentId: null })).toMatchObject({
      folders: [{ id: 'root', name: 'Root' }, { id: 'child', name: 'Research', parentId: null }],
      artifactHeadersById: { memory: { folderId: 'root', tags: ['facts'] } },
    });
    expect(current.folders).toHaveLength(1);
  });

  it('rejects cycles and missing parents at the semantic writer', () => {
    const current = PromptFoldersV1Schema.parse({ v: 1, folders: [
      { id: 'root', name: 'Root' }, { id: 'child', name: 'Child', parentId: 'root' },
    ] });
    expect(() => folders.movePromptFolderV1(current, { folderId: 'root', parentId: 'child' })).toThrowError(
      expect.objectContaining({ code: 'folder_cycle' }));
    expect(() => folders.createPromptFolderV1(current, { id: 'bad', name: 'Bad', parentId: 'missing' })).toThrowError(
      expect.objectContaining({ code: 'folder_parent_not_found' }));
    expect(() => folders.movePromptFolderV1(current, { folderId: 'child', parentId: 'missing' })).toThrowError(
      expect.objectContaining({ code: 'folder_parent_not_found' }));
  });

  it('deletes a folder by reparenting children and explicitly unplacing items without losing tags', () => {
    const current = PromptFoldersV1Schema.parse({ v: 1, folders: [
      { id: 'root', name: 'Root' }, { id: 'child', name: 'Child', parentId: 'root' },
      { id: 'grandchild', name: 'Grandchild', parentId: 'child' },
    ], artifactHeadersById: {
      workflow: { folderId: 'child', tags: ['daily'] }, memory: { folderId: 'root', tags: ['facts'] },
    } });
    expect(folders.removePromptFolderV1(current, { folderId: 'child', artifactIds: ['legacy-owned-role'] })).toEqual({ v: 1, folders: [
      { id: 'root', name: 'Root' }, { id: 'grandchild', name: 'Grandchild', parentId: 'root' },
    ], artifactHeadersById: {
      workflow: { folderId: null, tags: ['daily'] }, memory: { folderId: 'root', tags: ['facts'] },
      'legacy-owned-role': { folderId: null },
    } });
    const placed = folders.placeArtifactInPromptFolderV1(current, { artifactId: 'shared-document', folderId: 'grandchild', tags: ['private'] });
    const unplaced = folders.placeArtifactInPromptFolderV1(placed, { artifactId: 'shared-document', folderId: null });
    expect(unplaced.artifactHeadersById?.['shared-document']).toEqual({ folderId: null, tags: ['private'] });
    expect(current).not.toHaveProperty('artifactHeadersById.shared-document');
  });
});
