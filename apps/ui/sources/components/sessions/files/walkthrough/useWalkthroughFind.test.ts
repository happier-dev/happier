import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react-test-renderer';
import { applyScmReviewedMarkIntent } from '@happier-dev/protocol/scm/reviewedMarks';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { SPECIMEN_COMPARISON, SPECIMEN_WALKTHROUGH } from '@/components/dev/changes/walkthroughSpecimenFixture';

import type { WalkthroughReadingInput } from './walkthroughReading';
import { useWalkthroughFind } from './walkthroughFind';
import { useWalkthroughReading } from './useWalkthroughReading';

afterEach(standardCleanup);
const reveal = () => {};

describe('walkthrough Find code demand', () => {
    it('publishes nothing for personal marks while a real code change reaches the active search', async () => {
        const input: WalkthroughReadingInput = { comparison: SPECIMEN_COMPARISON,
            walkthrough: { state: 'complete', value: SPECIMEN_WALKTHROUGH }, analysis: null, reviewed: null };
        const hook = await renderHook((next: WalkthroughReadingInput) => {
            const reading = useWalkthroughReading(next);
            return useWalkthroughFind(reading, reveal);
        }, { initialProps: input });
        const find = hook.getCurrent();
        await act(async () => { find.open(); find.setQuery('fxPerfChanged'); });
        expect(find.getSnapshot().status).toMatchObject({ kind: 'results', total: 0 });
        const snapshot = find.getSnapshot();
        let publications = 0;
        const unsubscribe = find.subscribe(() => { publications += 1; });
        try {
            const reviewed = applyScmReviewedMarkIntent(SPECIMEN_COMPARISON, null, SPECIMEN_WALKTHROUGH.stops[0]!.changeRefs, true);
            await hook.rerender({ ...input, reviewed });
            expect(publications).toBe(0);
            expect(find.getSnapshot()).toBe(snapshot);

            const comparison = { ...SPECIMEN_COMPARISON, inventory: { ...SPECIMEN_COMPARISON.inventory,
                files: SPECIMEN_COMPARISON.inventory.files.map((file, index) => index === 0 && file.evidence.state === 'available'
                    ? { ...file, evidence: { ...file.evidence, unifiedDiff: file.evidence.unifiedDiff.replace(/\n\+(?!\+)[^\n]*/, '\n+fxPerfChanged') } }
                    : file) } };
            await hook.rerender({ ...input, comparison, reviewed });
            expect(publications).toBeGreaterThan(0);
            expect(find.getSnapshot().status).toMatchObject({ kind: 'results', total: 1 });
        } finally { unsubscribe(); }
    });
});
