import { describe, expect, it, vi } from 'vitest';

import { buildSessionTagsMenuContent } from './SessionTagsMenuContent';

describe('buildSessionTagsMenuContent', () => {
    it('projects one multi-select tag presentation for dropdown and composer list consumers', () => {
        const onToggle = vi.fn();
        const onCreate = vi.fn();
        const content = buildSessionTagsMenuContent({
            tags: [
                { id: 'tag-a', label: 'Urgent' },
                { id: 'tag-b', label: 'Review' },
            ],
            selectedTagIds: ['tag-b'],
            iconColor: '#fff',
            onToggle,
            onCreate,
        });

        expect(content.dropdownItems.map((item) => ({ id: item.id, selected: item.rightElement != null }))).toEqual([
            { id: 'tag-a', selected: false },
            { id: 'tag-b', selected: true },
        ]);
        const section = content.selectionListStep.sections[0];
        expect(section?.kind).toBe('static');
        if (!section || section.kind !== 'static') throw new Error('Expected static tag section');
        expect(section.options.map((option) => ({ id: option.id, selected: option.rightAccessory != null }))).toEqual([
            { id: 'tag-a', selected: false },
            { id: 'tag-b', selected: true },
        ]);

        section.options[0]?.onSelect?.();
        content.dropdownOnSelect('tag-b');
        content.selectionListStep.buildInputRow?.('  New tag  ')?.onSelect?.();
        expect(onToggle.mock.calls).toEqual([['tag-a'], ['tag-b']]);
        expect(onCreate).toHaveBeenCalledWith('New tag');
    });

    it('normalizes duplicate tag ids and selected ids without inventing labels', () => {
        const content = buildSessionTagsMenuContent({
            tags: [
                { id: ' tag-a ', label: ' First ' },
                { id: 'tag-a', label: 'Second' },
                { id: '', label: 'Ignored' },
            ],
            selectedTagIds: ['tag-a', 'tag-a', 'missing'],
            iconColor: '#fff',
            onToggle: () => {},
        });

        expect(content.tags).toEqual([{ id: 'tag-a', label: 'First' }]);
        expect(content.selectedTagIds).toEqual(['tag-a', 'missing']);
    });
});
