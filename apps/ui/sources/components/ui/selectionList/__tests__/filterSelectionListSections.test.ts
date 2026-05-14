import { describe, expect, it } from 'vitest';

import { filterSelectionListSections } from '../filterSelectionListSections';
import type { SelectionListSectionDescriptor } from '../_types';

type StaticDescriptor = SelectionListSectionDescriptor & { kind: 'static' };
function asStatic(s: SelectionListSectionDescriptor): StaticDescriptor {
    if (s.kind !== 'static') throw new Error(`expected static section, got ${s.kind}`);
    return s;
}

function makeSection(id: string, options: ReadonlyArray<{ id: string; label: string; subtitle?: string }>): SelectionListSectionDescriptor {
    return {
        kind: 'static',
        id,
        title: id.toUpperCase(),
        options,
    };
}

const sections: ReadonlyArray<SelectionListSectionDescriptor> = [
    makeSection('quick', [
        { id: 'use-current', label: 'Use current directory', subtitle: 'Skips creating a worktree' },
        { id: 'new-worktree', label: 'Create new worktree from…' },
    ]),
    makeSection('existing', [
        { id: 'wt-1', label: 'feature/login', subtitle: '~/projects/lantern' },
        { id: 'wt-2', label: 'main', subtitle: '~/projects/lantern' },
    ]),
];

describe('filterSelectionListSections', () => {
    it('returns the input untouched when the query is empty', () => {
        const out = filterSelectionListSections(sections, '');
        expect(out).toBe(sections);
    });

    it('returns the input untouched when the query is whitespace only', () => {
        const out = filterSelectionListSections(sections, '   ');
        expect(out).toBe(sections);
    });

    it('matches case-insensitively against option labels', () => {
        const out = filterSelectionListSections(sections, 'CURRENT');
        expect(out).toHaveLength(1);
        expect(out[0].id).toBe('quick');
        expect(asStatic(out[0]).options.map((o) => o.id)).toEqual(['use-current']);
    });

    it('matches against option subtitles too', () => {
        const out = filterSelectionListSections(sections, 'lantern');
        expect(out).toHaveLength(1);
        expect(out[0].id).toBe('existing');
        expect(asStatic(out[0]).options).toHaveLength(2);
    });

    it('drops sections that have no matching option', () => {
        const out = filterSelectionListSections(sections, 'feature');
        expect(out.map((s) => s.id)).toEqual(['existing']);
        expect(asStatic(out[0]).options).toHaveLength(1);
        expect(asStatic(out[0]).options[0].id).toBe('wt-1');
    });

    it('preserves the original section order', () => {
        const out = filterSelectionListSections(sections, 'e'); // matches across both
        expect(out.map((s) => s.id)).toEqual(['quick', 'existing']);
    });

    it('returns empty array when nothing matches', () => {
        const out = filterSelectionListSections(sections, 'zzz-nope');
        expect(out).toEqual([]);
    });

    it('does not mutate the input options arrays', () => {
        const before = asStatic(sections[0]).options;
        filterSelectionListSections(sections, 'current');
        expect(asStatic(sections[0]).options).toBe(before);
    });
});
