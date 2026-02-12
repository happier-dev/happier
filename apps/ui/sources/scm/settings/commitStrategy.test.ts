import { describe, expect, it } from 'vitest';
import { allowsLiveStaging, isAtomicCommitStrategy, resolveCommitScopeForStrategy } from '@/scm/settings/commitStrategy';

describe('commitStrategy', () => {
    it('identifies atomic strategy', () => {
        expect(isAtomicCommitStrategy('atomic')).toBe(true);
        expect(isAtomicCommitStrategy('git_staging')).toBe(false);
    });

    it('disables live staging in atomic strategy', () => {
        expect(
            allowsLiveStaging({
                strategy: 'atomic',
                snapshot: {
                    capabilities: {
                        writeInclude: true,
                        writeExclude: true,
                    },
                } as any,
            }),
        ).toBe(false);
    });

    it('enables live staging in git staging strategy when backend supports include/exclude', () => {
        expect(
            allowsLiveStaging({
                strategy: 'git_staging',
                snapshot: {
                    capabilities: {
                        writeInclude: true,
                        writeExclude: true,
                    },
                } as any,
            }),
        ).toBe(true);
    });

    it('maps strategy to commit scope', () => {
        expect(resolveCommitScopeForStrategy('atomic')).toEqual({ kind: 'all-pending' });
        expect(resolveCommitScopeForStrategy('git_staging')).toBeUndefined();
    });

    it('uses path-scoped atomic commits when virtual selection includes paths', () => {
        expect(
            resolveCommitScopeForStrategy('atomic', {
                selectedPaths: ['b.ts', 'a.ts', 'a.ts', ''],
            }),
        ).toEqual({
            kind: 'paths',
            include: ['a.ts', 'b.ts'],
        });
    });
});
