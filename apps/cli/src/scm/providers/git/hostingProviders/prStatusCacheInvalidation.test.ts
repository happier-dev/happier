import { describe, expect, it } from 'vitest';

import { createPrStatusCache } from './prStatusCache';
import { invalidatePrStatusCacheAfterSuccessfulScmMutation } from './prStatusCacheInvalidation';

describe('PR status cache invalidation', () => {
    it('invalidates the current repository branch only after successful SCM mutations', () => {
        const invalidated: unknown[] = [];
        const cache = {
            invalidate(input: unknown) {
                invalidated.push(input);
            },
        } satisfies Pick<ReturnType<typeof createPrStatusCache>, 'invalidate'>;

        invalidatePrStatusCacheAfterSuccessfulScmMutation({
            cache,
            response: { success: false },
            context: {
                cwd: '/repo',
                projectKey: 'machine-1:/repo',
                detection: {
                    isRepo: true,
                    rootPath: '/repo',
                    mode: '.git',
                },
            },
            headBranch: 'feature/pr-cache',
        });
        expect(invalidated).toEqual([]);

        invalidatePrStatusCacheAfterSuccessfulScmMutation({
            cache,
            response: { success: true },
            context: {
                cwd: '/repo',
                projectKey: 'machine-1:/repo',
                detection: {
                    isRepo: true,
                    rootPath: '/repo',
                    mode: '.git',
                },
            },
            headBranch: 'feature/pr-cache',
        });

        expect(invalidated).toEqual([{
            repoRootPath: '/repo',
            headBranch: 'feature/pr-cache',
        }]);
    });
});
