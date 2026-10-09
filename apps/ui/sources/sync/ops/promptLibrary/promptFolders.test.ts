import { describe, expect, it } from 'vitest';
import { createPromptFolderV1, placeArtifactInPromptFolderV1 } from '@happier-dev/protocol/prompts/library/promptFoldersV1';
import { ensurePromptFolderByName, findPromptFolderById } from './promptFolders';

describe('prompt folder adapters', () => {
    it('preserves exact whitespace-paired folder identities and metadata through live lookup and ensure', () => {
        let current = createPromptFolderV1({ v: 1, folders: [] }, { id: 'retained', name: 'Neighbor' });
        current = createPromptFolderV1(current, { id: ' retained ', name: 'Spaced' });
        current = createPromptFolderV1(current, { id: 'child', name: 'Child', parentId: ' retained ' });
        current = placeArtifactInPromptFolderV1(current, { artifactId: 'neighbor-item', folderId: 'retained', tags: ['neighbor'] });
        current = placeArtifactInPromptFolderV1(current, { artifactId: 'spaced-item', folderId: ' retained ', tags: ['spaced'] });

        expect(findPromptFolderById(current, ' retained ')?.name).toBe('Spaced');
        expect(findPromptFolderById(current, 'retained')?.name).toBe('Neighbor');
        const existing = ensurePromptFolderByName(current, '  SPACED  ');
        expect(existing.folderId).toBe(' retained ');
        expect(existing.promptFoldersV1).toBe(current);
        const created = ensurePromptFolderByName(current, '  New   folder  ');
        expect(findPromptFolderById(created.promptFoldersV1, created.folderId)?.name).toBe('New folder');
        expect(created.promptFoldersV1.artifactHeadersById).toEqual(current.artifactHeadersById);
        expect(created.promptFoldersV1.folders.slice(0, current.folders.length)).toEqual(current.folders);
    });
});
