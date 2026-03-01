import { describe, expect, it } from 'vitest';

import { isSafeWorkspaceRelativePath } from './isSafeWorkspaceRelativePath';

describe('isSafeWorkspaceRelativePath', () => {
    it('accepts conservative workspace-relative paths', () => {
        expect(isSafeWorkspaceRelativePath('src/app.ts')).toBe(true);
        expect(isSafeWorkspaceRelativePath('.gitignore')).toBe(true);
        expect(isSafeWorkspaceRelativePath('apps/ui/sources/')).toBe(true);
        expect(isSafeWorkspaceRelativePath('dir/my file.ts')).toBe(true);
    });

    it('rejects absolute, traversal, and windows paths', () => {
        expect(isSafeWorkspaceRelativePath('/etc/passwd')).toBe(false);
        expect(isSafeWorkspaceRelativePath('~/secrets.txt')).toBe(false);
        expect(isSafeWorkspaceRelativePath('../secrets.txt')).toBe(false);
        expect(isSafeWorkspaceRelativePath('src/../../secrets.txt')).toBe(false);
        expect(isSafeWorkspaceRelativePath('C:\\Windows\\system.ini')).toBe(false);
    });
});
