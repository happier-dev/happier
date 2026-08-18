import { describe, expect, it } from 'vitest';

import { resolveWebScaffoldSafeAreaBottom } from './resolveWebSessionContentBottomReservation';

describe('resolveWebScaffoldSafeAreaBottom', () => {
    it('returns zero for web session composes so floating chrome does not double-count the browser safe area', () => {
        expect(resolveWebScaffoldSafeAreaBottom({ layoutBottomInset: 64, safeAreaBottom: 24 })).toBe(0);
    });

    it('returns zero when only safe area is present on web', () => {
        expect(resolveWebScaffoldSafeAreaBottom({ layoutBottomInset: 0, safeAreaBottom: 24 })).toBe(0);
    });

    it('returns zero when neither chrome nor safe area is present', () => {
        expect(resolveWebScaffoldSafeAreaBottom({ layoutBottomInset: 0, safeAreaBottom: 0 })).toBe(0);
    });

    it('tolerates degenerate inputs without leaking a phantom gap', () => {
        expect(resolveWebScaffoldSafeAreaBottom({ layoutBottomInset: -1, safeAreaBottom: 24 })).toBe(0);
        expect(resolveWebScaffoldSafeAreaBottom({ layoutBottomInset: 64, safeAreaBottom: Number.NaN })).toBe(0);
    });
});
