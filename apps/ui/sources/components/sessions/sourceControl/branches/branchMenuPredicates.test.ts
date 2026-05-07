import { describe, expect, it } from 'vitest';

describe('branchMenuPredicates', () => {
    it('detects Git index lock failures from error output only on failed responses', async () => {
        const { isGitIndexLockError } = await import('./branchMenuPredicates');

        expect(isGitIndexLockError({
            success: false,
            error: 'fatal: Unable to create /repo/.git/index.lock: File exists.',
        })).toBe(true);
        expect(isGitIndexLockError({
            success: false,
            stderr: 'Another git process seems to be running in this repository. remove .git/index.lock manually to continue.',
        })).toBe(true);
        expect(isGitIndexLockError({
            success: true,
            stderr: 'index.lock',
        })).toBe(false);
    });
});
