import { describe, expect, it } from 'vitest';

import {
    formatMachineResourcesByteRange,
    formatMachineResourcesByteRangeCompact,
} from './machineResourcesFormatting';

describe('formatMachineResourcesByteRange', () => {
    it('joins used and total with a slash', () => {
        expect(formatMachineResourcesByteRange(5.2 * 1024 ** 3, 16 * 1024 ** 3)).toBe('5.2 GB / 16.0 GB');
        expect(formatMachineResourcesByteRange(0, 512 * 1024 ** 2)).toBe('0 B / 512 MB');
    });
});

describe('formatMachineResourcesByteRangeCompact', () => {
    it('shares one unit derived from the total', () => {
        expect(formatMachineResourcesByteRangeCompact(5.2 * 1024 ** 3, 16 * 1024 ** 3)).toBe('5.2/16 GB');
        expect(formatMachineResourcesByteRangeCompact(300 * 1024 ** 2, 512 * 1024 ** 2)).toBe('300/512 MB');
        expect(formatMachineResourcesByteRangeCompact(0, 900)).toBe('0/900 B');
    });

    it('drops the decimal once a side reaches three digits in the shared unit', () => {
        expect(formatMachineResourcesByteRangeCompact(120 * 1024 ** 3, 256 * 1024 ** 3)).toBe('120/256 GB');
    });
});
