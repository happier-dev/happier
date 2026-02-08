import { describe, expect, it } from 'vitest';

import { shouldShowGitOperationsPanel } from './useGitOperationsVisibility';

describe('shouldShowGitOperationsPanel', () => {
    it('shows panel only when not refreshing, in a git repo, and write operations are enabled', () => {
        expect(
            shouldShowGitOperationsPanel({
                isRefreshing: false,
                isGitRepo: true,
                gitWriteEnabled: true,
            }),
        ).toBe(true);

        expect(
            shouldShowGitOperationsPanel({
                isRefreshing: true,
                isGitRepo: true,
                gitWriteEnabled: true,
            }),
        ).toBe(false);

        expect(
            shouldShowGitOperationsPanel({
                isRefreshing: false,
                isGitRepo: false,
                gitWriteEnabled: true,
            }),
        ).toBe(false);

        expect(
            shouldShowGitOperationsPanel({
                isRefreshing: false,
                isGitRepo: true,
                gitWriteEnabled: false,
            }),
        ).toBe(false);
    });
});
