import { describe, expect, it } from 'vitest';

import { compareSemVer } from './semverComparison.js';

describe('general SemVer precedence', () => {
    it('orders releases, prereleases and numeric identifiers by SemVer 2.0', () => {
        expect(compareSemVer('1.2.3-rc.1', '1.2.3')).toBe(-1);
        expect(compareSemVer('1.10.0', '1.9.0')).toBe(1);
        expect(compareSemVer('v1.2.3+build.5', '1.2.3')).toBe(0);
        expect(compareSemVer('1.0.0-alpha', '1.0.0-alpha.1')).toBe(-1);
        expect(compareSemVer('1.0.0-alpha.1', '1.0.0-alpha.beta')).toBe(-1);
        expect(compareSemVer('1.0.0-rc.10', '1.0.0-rc.9')).toBe(1);
        expect(compareSemVer('1.0.0-dev.1', '1.0.0-preview.1')).toBe(-1);
        expect(compareSemVer('1.0.0-1.99999999999999999999', '1.0.0-1.99999999999999999998')).toBe(1);
        expect(compareSemVer('unknown', '1.0.0')).toBeNull();
    });
});
