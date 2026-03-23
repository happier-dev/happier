import { describe, expect, it } from 'vitest';

import {
    createScmSourceControllerWorkspaceTransferEntry,
    createScmSourceControllerWorkspaceTransferRequest,
    createScmSourceControllerWorkspaceTransferResult,
} from './workspaceTransfer';

describe('workspaceTransfer', () => {
    it('clones transfer request arrays without sharing ignored-glob state', () => {
        const ignoredIncludeGlobs = ['dist/**'];
        const request = createScmSourceControllerWorkspaceTransferRequest({
            strategy: 'transfer_snapshot',
            includeIgnoredMode: 'include_selected',
            ignoredIncludeGlobs,
        });

        ignoredIncludeGlobs.push('coverage/**');

        expect(request.strategy).toBe('transfer_snapshot');
        expect(request.includeIgnoredMode).toBe('include_selected');
        expect(request.ignoredIncludeGlobs).toEqual(['dist/**']);
    });

    it('creates transfer entries without rewriting their paths', () => {
        const entry = createScmSourceControllerWorkspaceTransferEntry({
            relativePath: '.git/HEAD',
            sourcePath: '/repo/.git/HEAD',
        });

        expect(entry).toEqual({
            relativePath: '.git/HEAD',
            sourcePath: '/repo/.git/HEAD',
        });
    });

    it('clones transfer result entries and preserves metadata', () => {
        const entries = [{
            relativePath: '.git/HEAD',
            sourcePath: '/repo/.git/HEAD',
        }];
        const metadata = { branchName: 'main' };
        const result = createScmSourceControllerWorkspaceTransferResult({
            entries,
            metadata,
        });

        entries.push({
            relativePath: '.git/config',
            sourcePath: '/repo/.git/config',
        });

        expect(result.entries).toEqual([
            {
                relativePath: '.git/HEAD',
                sourcePath: '/repo/.git/HEAD',
            },
        ]);
        expect(result.metadata).toEqual({
            branchName: 'main',
        });
    });
});
