import { describe, expect, it } from 'vitest';

import { resolveGitWriteEnabled } from './featureFlags';

describe('resolveGitWriteEnabled', () => {
    it('enables git write operations only when both flags are true', () => {
        expect(resolveGitWriteEnabled({ experiments: true, expGitOperations: true })).toBe(true);
        expect(resolveGitWriteEnabled({ experiments: false, expGitOperations: true })).toBe(false);
        expect(resolveGitWriteEnabled({ experiments: true, expGitOperations: false })).toBe(false);
        expect(resolveGitWriteEnabled({ experiments: false, expGitOperations: false })).toBe(false);
    });
});
