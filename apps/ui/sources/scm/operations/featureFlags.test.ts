import { describe, expect, it } from 'vitest';

import { resolveScmWriteEnabled } from './featureFlags';

describe('resolveScmWriteEnabled', () => {
    it('enables scm write operations only when both flags are true', () => {
        expect(resolveScmWriteEnabled({ experiments: true, expScmOperations: true })).toBe(true);
        expect(resolveScmWriteEnabled({ experiments: false, expScmOperations: true })).toBe(false);
        expect(resolveScmWriteEnabled({ experiments: true, expScmOperations: false })).toBe(false);
        expect(resolveScmWriteEnabled({ experiments: false, expScmOperations: false })).toBe(false);
    });
});
