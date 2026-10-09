import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    activeReviewFileKeyForWorkspace,
    acknowledgeActiveReviewFileRequest,
    openChangedFileFromList,
    publishActiveReviewFile,
    readActiveReviewFile,
    requestActiveReviewFile,
    requestActiveReviewFileForComparison,
    resetActiveReviewFilesForTests,
    subscribeActiveReviewFile,
} from './activeReviewFile';

describe('active review file', () => {
    afterEach(() => resetActiveReviewFilesForTests());

    it('shares a normalized workspace review scope while isolating other machines, roots and Homes', () => {
        const scope = { serverId: 'home', machineId: 'machine', rootPath: '/repo/' };
        const key = activeReviewFileKeyForWorkspace(scope);
        const normalizedKey = activeReviewFileKeyForWorkspace({ ...scope, rootPath: '/repo' });
        publishActiveReviewFile(key, { presented: true, activePath: 'src/a.ts' });
        expect(requestActiveReviewFile(normalizedKey, 'src/b.ts')).toBe(true);
        expect(readActiveReviewFile(key).focusRequest?.path).toBe('src/b.ts');
        for (const other of [
            { ...scope, serverId: 'other-home' },
            { ...scope, machineId: 'other-machine' },
            { ...scope, rootPath: '/other-repo' },
        ]) {
            expect(requestActiveReviewFile(activeReviewFileKeyForWorkspace(other), 'src/b.ts')).toBe(false);
        }
    });

    it('lets a changed-files list focus a file in Review only while Review is shown', () => {
        expect(requestActiveReviewFile('s1', 'src/a.ts')).toBe(false);

        publishActiveReviewFile('s1', { presented: true, activePath: 'src/b.ts' });
        expect(requestActiveReviewFile('s1', 'src/a.ts')).toBe(true);
        const first = readActiveReviewFile('s1').focusRequest;
        expect(first?.path).toBe('src/a.ts');

        // The same file asked for again is a new request, so Review scrolls back to it.
        expect(requestActiveReviewFile('s1', 'src/a.ts')).toBe(true);
        expect(readActiveReviewFile('s1').focusRequest?.nonce).not.toBe(first?.nonce);

        publishActiveReviewFile('s1', { presented: false, activePath: 'src/a.ts' });
        expect(requestActiveReviewFile('s1', 'src/c.ts')).toBe(false);
    });

    it('retains one comparison-qualified promotion before Review mounts, not an unqualified hidden list request', () => {
        expect(requestActiveReviewFile('workspace', 'src/a.ts')).toBe(false);
        expect(requestActiveReviewFile('workspace', 'src/a.ts', { kind: 'workingTree' })).toBe(true);
        publishActiveReviewFile('workspace', { presented: false, activePath: null });
        publishActiveReviewFile('workspace', { presented: true, activePath: null });
        expect(readActiveReviewFile('workspace').focusRequest).toMatchObject({ path: 'src/a.ts', comparison: { kind: 'workingTree' } });
    });

    it('acknowledges only the latest matching promotion and drops it on scope retirement', () => {
        let current = true;
        requestActiveReviewFileForComparison('workspace', 'first.ts', { kind: 'workingTree' }, () => current);
        const first = readActiveReviewFile('workspace').focusRequest!;
        requestActiveReviewFileForComparison('workspace', 'next.ts', { kind: 'workingTree' }, () => current);
        const next = readActiveReviewFile('workspace').focusRequest!;
        acknowledgeActiveReviewFileRequest('workspace', first.nonce);
        expect(readActiveReviewFile('workspace').focusRequest).toMatchObject({ path: 'next.ts', comparison: { kind: 'workingTree' } });
        publishActiveReviewFile('workspace', { presented: true, activePath: null });
        acknowledgeActiveReviewFileRequest('workspace', next.nonce);
        expect(readActiveReviewFile('workspace').focusRequest).toMatchObject({ path: 'next.ts', nonce: next.nonce });
        expect(readActiveReviewFile('workspace').focusRequest).not.toHaveProperty('comparison');
        publishActiveReviewFile('workspace', { presented: false, activePath: null });
        expect(readActiveReviewFile('workspace').focusRequest).toBeNull();
        requestActiveReviewFileForComparison('workspace', 'retired.ts', { kind: 'workingTree' }, () => current);
        current = false;
        expect(readActiveReviewFile('workspace').focusRequest).toBeNull();
    });

    it('tells the list which file Review is on, and nothing once Review is hidden', () => {
        const listener = vi.fn();
        const unsubscribe = subscribeActiveReviewFile('s1', listener);
        publishActiveReviewFile('s1', { presented: true, activePath: 'src/a.ts' });
        expect(readActiveReviewFile('s1').activePath).toBe('src/a.ts');
        expect(listener).toHaveBeenCalledTimes(1);

        // Same fact again: no notification (lists do not re-render while Review scrolls within a file).
        publishActiveReviewFile('s1', { presented: true, activePath: 'src/a.ts' });
        expect(listener).toHaveBeenCalledTimes(1);

        publishActiveReviewFile('s1', { presented: false, activePath: 'src/a.ts' });
        expect(readActiveReviewFile('s1').activePath).toBeNull();
        unsubscribe();
    });

    it('keeps sessions apart', () => {
        publishActiveReviewFile('s1', { presented: true, activePath: 'src/a.ts' });
        expect(readActiveReviewFile('s2').activePath).toBeNull();
        expect(requestActiveReviewFile('s2', 'src/a.ts')).toBe(false);
    });

    it('a list tap shows the file in Review when Review is on screen, and opens it otherwise', () => {
        const open = vi.fn();
        openChangedFileFromList('s1', 'src/a.ts', open);
        expect(open).toHaveBeenCalledWith('src/a.ts');

        open.mockClear();
        publishActiveReviewFile('s1', { presented: true, activePath: 'src/b.ts' });
        openChangedFileFromList('s1', 'src/a.ts', open);
        expect(open).not.toHaveBeenCalled();
        expect(readActiveReviewFile('s1').focusRequest?.path).toBe('src/a.ts');
    });
});
