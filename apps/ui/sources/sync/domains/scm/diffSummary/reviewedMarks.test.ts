import { describe, expect, it } from 'vitest';
import { applyScmReviewedMarkIntent } from '@happier-dev/protocol/scm/reviewedMarks';
import { SPECIMEN_COMPARISON } from '@/components/dev/changes/walkthroughSpecimenFixture';
import { createScmReviewedSelections } from './reviewedMarks';

describe('indexed reviewed selections', () => {
    it('does not read captured evidence when there are no selection consumers', () => {
        let reads = 0;
        const comparison = { ...SPECIMEN_COMPARISON, inventory: { ...SPECIMEN_COMPARISON.inventory,
            files: SPECIMEN_COMPARISON.inventory.files.map(file => ({ ...file,
                get evidence() { reads++; return file.evidence; },
            })),
        } };
        const source = createScmReviewedSelections(comparison, []);
        expect(source.apply(null).size).toBe(0);
        expect(source.getReviewedCount()).toBe(0);
        expect(reads).toBe(0);
    });
    it('preserves exact all-key membership, overlapping selections, withdrawal and recovery', () => {
        const comparison = SPECIMEN_COMPARISON;
        const refs = comparison.inventory.files.flatMap(file => file.occurrences.map(occurrence => occurrence.id));
        const selections = [
            { changeRefs: [refs[0]!] }, { changeRefs: refs.slice(0, 2) },
            { changeRefs: [] }, { changeRefs: ['unavailable-reference'] },
        ];
        const source = createScmReviewedSelections(comparison, selections);
        const one = applyScmReviewedMarkIntent(comparison, null, [refs[0]!], true);
        const both = applyScmReviewedMarkIntent(comparison, one, refs.slice(0, 2), true);
        const check = (record: typeof one | null, expected: boolean[]) => {
            source.apply(record);
            expect(selections.map((_, index) => source.isReviewed(index))).toEqual(expected);
            expect(source.getReviewedCount()).toBe(expected.filter(Boolean).length);
        };
        check(one, [true, false, false, false]);
        expect(source.apply({ ...one, reviewedChangeKeys: [...one.reviewedChangeKeys] }).size).toBe(0);
        check(both, [true, true, false, false]);
        check({ ...both, scopeId: 'another-scope' }, [false, false, false, false]);
        check(both, [true, true, false, false]);
        check(null, [false, false, false, false]);
        check(one, [true, false, false, false]);
    });
});
