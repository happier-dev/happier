import { describe, expect, it } from 'vitest';

import { formatPendingCountBadge } from './pendingBadge';

describe('formatPendingCountBadge', () => {
    it('returns null when pending count is not positive', () => {
        expect(formatPendingCountBadge(0)).toBeNull();
        expect(formatPendingCountBadge(-3)).toBeNull();
    });

    it('returns exact pending count up to 99', () => {
        expect(formatPendingCountBadge(1)).toBe('1');
        expect(formatPendingCountBadge(42)).toBe('42');
        expect(formatPendingCountBadge(99)).toBe('99');
    });

    it('caps pending badge at 99+', () => {
        expect(formatPendingCountBadge(100)).toBe('99+');
        expect(formatPendingCountBadge(999)).toBe('99+');
    });
});
