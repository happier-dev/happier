import { describe, expect, it, vi } from 'vitest';

import { createNewSessionOrganizationPlacementActionChips } from './newSessionOrganizationPlacementActionChips';

describe('createNewSessionOrganizationPlacementActionChips', () => {
    it('adapts shared workspace folder and tag presentations without mutation semantics', () => {
        const onFolderSelect = vi.fn();
        const onTagToggle = vi.fn();
        const onTagCreate = vi.fn();
        const chips = createNewSessionOrganizationPlacementActionChips({
            enabled: true,
            folderId: 'folder-a',
            tagIds: ['tag-b'],
            folderTargets: [{ folderId: 'folder-a', title: 'Project', depth: 0 }],
            tags: [
                { id: 'tag-a', label: 'Urgent' },
                { id: 'tag-b', label: 'Review' },
            ],
            iconColor: '#fff',
            onFolderSelect,
            onTagToggle,
            onTagCreate,
        });

        expect(chips.map((chip) => chip.key)).toEqual(['organization-folder', 'organization-tags']);
        const folderSection = chips[0]?.collapsedOptionsPopover?.rootStep?.sections[0];
        if (!folderSection || folderSection.kind !== 'static') throw new Error('Expected folder section');
        folderSection.options[0]?.onSelect?.();
        folderSection.options[1]?.onSelect?.();
        expect(onFolderSelect.mock.calls).toEqual([[null], ['folder-a']]);

        const tagStep = chips[1]?.collapsedOptionsPopover?.rootStep;
        const tagSection = tagStep?.sections[0];
        if (!tagSection || tagSection.kind !== 'static') throw new Error('Expected tag section');
        expect(tagSection.options[1]?.rightAccessory).toBeDefined();
        tagSection.options[0]?.onSelect?.();
        tagStep?.buildInputRow?.('New')?.onSelect?.();
        expect(onTagToggle).toHaveBeenCalledWith('tag-a');
        expect(onTagCreate).toHaveBeenCalledWith('New');
    });

    it('omits both controls when Session folders are unavailable', () => {
        expect(createNewSessionOrganizationPlacementActionChips({
            enabled: false,
            folderId: null,
            tagIds: [],
            folderTargets: [],
            tags: [],
            iconColor: '#fff',
            onFolderSelect: () => {},
            onTagToggle: () => {},
        })).toEqual([]);
    });
});
