import { describe, expect, it, vi } from 'vitest';

import { createNewSessionOrganizationPlacementActionChips } from './newSessionOrganizationPlacementActionChips';
import type { SessionSection } from '@/sync/domains/session/organization/sections';
import { t } from '@/text';

const launch: SessionSection = {
    address: { serverId: 'home-a', sectionId: 'section-a' },
    display: { status: 'available', value: { name: 'Launch 0.3', icon: 'rocket' } },
    sortKey: 'a0',
};
const base = {
    enabled: true,
    tagIds: [] as string[],
    tags: [],
    iconColor: '#fff',
    onSectionSelect: () => {},
    onTagToggle: () => {},
};

describe('createNewSessionOrganizationPlacementActionChips', () => {
    it('chooses among the Account sections by captured address and tags without mutation semantics', () => {
        const onSectionSelect = vi.fn();
        const onTagToggle = vi.fn();
        const onTagCreate = vi.fn();
        const chips = createNewSessionOrganizationPlacementActionChips({
            enabled: true,
            sectionAddress: launch.address,
            tagIds: ['tag-b'],
            sections: [launch],
            tags: [
                { id: 'tag-a', label: 'Urgent' },
                { id: 'tag-b', label: 'Review' },
            ],
            iconColor: '#fff',
            onSectionSelect,
            onTagToggle,
            onTagCreate,
        });

        expect(chips.map((chip) => chip.key)).toEqual(['organization-folder', 'organization-tags']);
        expect(chips[0]?.collapsedOptionsPopover?.label).toBe('Launch 0.3');
        expect(chips[0]?.collapsedOptionsPopover?.selectedOptionId).toBe('section-a');
        const folderSection = chips[0]?.collapsedOptionsPopover?.rootStep?.sections[0];
        if (!folderSection || folderSection.kind !== 'static') throw new Error('Expected section choices');
        folderSection.options[0]?.onSelect?.();
        folderSection.options[1]?.onSelect?.();
        expect(onSectionSelect.mock.calls).toEqual([[null], [launch.address]]);

        const tagStep = chips[1]?.collapsedOptionsPopover?.rootStep;
        const tagSection = tagStep?.sections[0];
        if (!tagSection || tagSection.kind !== 'static') throw new Error('Expected tag section');
        expect(tagSection.options[1]?.rightAccessory).toBeDefined();
        tagSection.options[0]?.onSelect?.();
        tagStep?.buildInputRow?.('New')?.onSelect?.();
        expect(onTagToggle).toHaveBeenCalledWith('tag-a');
        expect(onTagCreate).toHaveBeenCalledWith('New');
    });

    it('never labels a retained foreign-Home selection with the current Home\'s same-id section', () => {
        const chips = createNewSessionOrganizationPlacementActionChips({
            ...base,
            sectionAddress: { serverId: 'home-b', sectionId: 'section-a' },
            sections: [launch],
        });
        expect(chips[0]?.collapsedOptionsPopover?.label).toBe(t('common.unavailable'));
    });

    it('puts the section on the location rail and tags on the setup rail', () => {
        const chips = createNewSessionOrganizationPlacementActionChips({ ...base, sectionAddress: null, sections: [launch] });
        expect(chips.map((chip) => chip.controlId)).toEqual(['organization', 'tags']);
    });

    it('omits the section control while there is no section to choose, and keeps tags', () => {
        const chips = createNewSessionOrganizationPlacementActionChips({ ...base, sectionAddress: null, sections: [] });
        expect(chips.map((chip) => chip.key)).toEqual(['organization-tags']);
    });

    it('keeps a chosen section reachable so it can be cleared', () => {
        const chips = createNewSessionOrganizationPlacementActionChips({ ...base, sectionAddress: launch.address, sections: [] });
        expect(chips.map((chip) => chip.key)).toEqual(['organization-folder', 'organization-tags']);
    });

    it('omits both controls when Session folders are unavailable', () => {
        expect(createNewSessionOrganizationPlacementActionChips({
            ...base, enabled: false, sectionAddress: null, sections: [],
        })).toEqual([]);
    });

    describe('space', () => {
        const spaces = [
            { id: 'my-work', name: 'My work', icon: { kind: 'icon', name: 'list' } },
            { id: 'launch', name: 'Launch 0.3', icon: { kind: 'icon', name: 'rocket' } },
        ] as const;

        it('starts the session in the captured space and offers every space plus a clear choice', () => {
            const onSelect = vi.fn();
            const chips = createNewSessionOrganizationPlacementActionChips({ ...base, sectionAddress: null, sections: [],
                space: { spaces, selectedSpaceId: 'launch', onSelect } });
            const chip = chips.find(candidate => candidate.key === 'organization-space');
            expect(chip?.collapsedOptionsPopover?.label).toBe('Launch 0.3');
            expect(chip?.collapsedOptionsPopover?.selectedOptionId).toBe('launch');
            // A chosen space shows on the location rail so it can be seen and cleared.
            expect(chip?.placement?.defaultPlacement).toBe('pinned');
            const options = chip?.collapsedOptionsPopover?.rootStep?.sections[0];
            if (!options || options.kind !== 'static') throw new Error('Expected space choices');
            expect(options.options.map(option => option.label)).toEqual([t('sessionsList.spacesNone'), 'My work', 'Launch 0.3']);
            options.options[0]?.onSelect?.();
            options.options[1]?.onSelect?.();
            expect(onSelect.mock.calls).toEqual([[null], ['my-work']]);
        });

        it('waits in the overflow when no space is chosen, and names a removed space unavailable', () => {
            const none = createNewSessionOrganizationPlacementActionChips({ ...base, sectionAddress: null, sections: [],
                space: { spaces, selectedSpaceId: null, onSelect: () => {} } })
                .find(candidate => candidate.key === 'organization-space');
            expect(none?.collapsedOptionsPopover?.label).toBe(t('sessionsList.spacesNone'));
            expect(none?.placement?.defaultPlacement).toBe('overflow');
            const removed = createNewSessionOrganizationPlacementActionChips({ ...base, sectionAddress: null, sections: [],
                space: { spaces, selectedSpaceId: 'deleted', onSelect: () => {} } })
                .find(candidate => candidate.key === 'organization-space');
            expect(removed?.collapsedOptionsPopover?.label).toBe(t('common.unavailable'));
        });

        it('has no space control when spaces are off', () => {
            const chips = createNewSessionOrganizationPlacementActionChips({ ...base, sectionAddress: null, sections: [] });
            expect(chips.map(chip => chip.key)).toEqual(['organization-tags']);
        });
    });
});
