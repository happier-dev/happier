import { describe, expect, it } from 'vitest';

import { buildWorktreeCheckoutOptionId } from './worktreeCheckoutOptionId';

describe('buildWorktreeCheckoutOptionId', () => {
    it('prefixes the canonicalized path with "checkout:"', () => {
        expect(buildWorktreeCheckoutOptionId('/repo/.dev/worktree/feature')).toBe(
            'checkout:/repo/.dev/worktree/feature',
        );
    });

    it('normalizes trailing slashes + mixed separators so the id is stable', () => {
        // The chip model and the step builder must agree on this id regardless of
        // how the SCM reported the worktree path; canonicalization guarantees it.
        expect(buildWorktreeCheckoutOptionId('/repo/.dev/worktree/feature/')).toBe(
            'checkout:/repo/.dev/worktree/feature',
        );
        expect(buildWorktreeCheckoutOptionId('C:\\repo\\feature')).toBe(
            buildWorktreeCheckoutOptionId('C:/repo/feature'),
        );
    });
});
