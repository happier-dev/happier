import { describe, expect, it } from 'vitest';

import { shouldShowScmOperationsPanel } from './useScmOperationsVisibility';

describe('shouldShowScmOperationsPanel', () => {
    it('shows panel when repository is available and read status capability is enabled', () => {
        expect(
            shouldShowScmOperationsPanel({
                isRefreshing: false,
                isRepo: true,
                capabilities: { readStatus: true },
                scmWriteEnabled: false,
            }),
        ).toBe(true);

        expect(
            shouldShowScmOperationsPanel({
                isRefreshing: true,
                isRepo: true,
                capabilities: { readStatus: true },
                scmWriteEnabled: true,
            }),
        ).toBe(false);

        expect(
            shouldShowScmOperationsPanel({
                isRefreshing: false,
                isRepo: false,
                capabilities: { readStatus: true },
                scmWriteEnabled: true,
            }),
        ).toBe(false);

        expect(
            shouldShowScmOperationsPanel({
                isRefreshing: false,
                isRepo: true,
                capabilities: { readStatus: false },
                scmWriteEnabled: true,
            }),
        ).toBe(false);
    });

    it('hides panel when capabilities are missing', () => {
        expect(
            shouldShowScmOperationsPanel({
                isRefreshing: false,
                isRepo: true,
                capabilities: null,
                scmWriteEnabled: true,
            }),
        ).toBe(false);
    });
});
