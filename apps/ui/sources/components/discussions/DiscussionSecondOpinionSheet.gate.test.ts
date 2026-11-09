import { describe, expect, it } from 'vitest';

import { isDiscussionSecondOpinionSourceGrantRepairableV1 as isRepairableSourceGap } from '@happier-dev/protocol/discussions/secondOpinion';

const reviewer = (overrides: Partial<Parameters<typeof isRepairableSourceGap>[0] & object> = {}) => ({
    disclosure: { ok: false as const, reason: 'destination_audience_broader' },
    sourceAccess: 'read',
    missingSourceAccountIds: ['bob'],
    canGrantSource: true,
    ...overrides,
});

describe('second-opinion Ask gate (RVB-05)', () => {
    it('lets the person share and ask when the only gap is a reviewer outside the source audience', () => {
        expect(isRepairableSourceGap(reviewer())).toBe(true);
    });

    it('keeps refusals the grant cannot repair', () => {
        expect(isRepairableSourceGap(reviewer({ canGrantSource: false }))).toBe(false);
        expect(isRepairableSourceGap(reviewer({ disclosure: { ok: false, reason: 'destination_public' } }))).toBe(false);
        expect(isRepairableSourceGap(reviewer({ disclosure: { ok: false, reason: 'same_session' } }))).toBe(false);
        expect(isRepairableSourceGap(reviewer({ sourceAccess: 'quote_only' }))).toBe(false);
        expect(isRepairableSourceGap(reviewer({ missingSourceAccountIds: [] }))).toBe(false);
        expect(isRepairableSourceGap(null)).toBe(false);
    });
});
