import { describe, expect, it } from 'vitest';

import {
    hasMaxOldSpaceSize,
    resolveMaxOldSpaceSizeMb,
    upsertMaxOldSpaceSize,
} from '../../scripts/withNodeHeapLimit.mjs';

describe('apps/ui withNodeHeapLimit', () => {
    it('detects existing max-old-space-size flags', () => {
        expect(hasMaxOldSpaceSize('--trace-warnings --max-old-space-size=4096')).toBe(true);
        expect(hasMaxOldSpaceSize('--max-old-space-size 2048')).toBe(true);
    });

    it('appends max-old-space-size when NODE_OPTIONS is empty', () => {
        expect(upsertMaxOldSpaceSize('', 8192)).toBe('--max-old-space-size=8192');
    });

    it('appends max-old-space-size without dropping existing NODE_OPTIONS', () => {
        expect(upsertMaxOldSpaceSize('--trace-warnings', 8192)).toBe('--trace-warnings --max-old-space-size=8192');
    });

    it('does not overwrite an existing max-old-space-size flag', () => {
        expect(upsertMaxOldSpaceSize('--max-old-space-size=2048 --trace-warnings', 8192)).toBe(
            '--max-old-space-size=2048 --trace-warnings',
        );
    });

    it('leaves heap allocation to Node when no valid explicit UI allocation is supplied', () => {
        for (const env of [{}, { HAPPIER_UI_TEST_MAX_OLD_SPACE_SIZE_MB: 'nope' }, { HAPPIER_UI_TEST_MAX_OLD_SPACE_SIZE_MB: '0' }]) {
            const allocation = resolveMaxOldSpaceSizeMb(env);
            expect(allocation).toBeUndefined();
            expect(upsertMaxOldSpaceSize('--trace-warnings', allocation)).toBe('--trace-warnings');
        }
    });

    it('respects HAPPIER_UI_TEST_MAX_OLD_SPACE_SIZE_MB when valid', () => {
        expect(resolveMaxOldSpaceSizeMb({ HAPPIER_UI_TEST_MAX_OLD_SPACE_SIZE_MB: '6144' })).toBe(6144);
    });
});
