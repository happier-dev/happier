import { describe, expect, it } from 'vitest';
import { buildWorkspaceContentPolicy, normalizeSessionHandoffDefaults } from './sessionHandoffDefaults';
import { computeWorkspaceSyncPolicyDigest } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';

describe('stored handoff defaults', () => {
    it('preserves existing content exclusions when editing a replacement policy', () => {
        const policy = buildWorkspaceContentPolicy({ contentSelection: 'all_files', includeIgnoredMode: 'exclude',
            ignoredIncludeGlobs: [], extraIgnorePatterns: ['private/**'] });
        expect(policy.extraIgnorePatterns).toEqual(['private/**']);
        expect(policy.policyDigest).toBe(computeWorkspaceSyncPolicyDigest(policy));
    });
    it('retains saved choices while discarding retired source material', () => {
        expect(normalizeSessionHandoffDefaults({ v: 1, workspaceSyncMode: 'copy_once', includeIgnoredMode: 'exclude',
            ignoredIncludeGlobs: [], directTargetMode: 'keep_direct', retiredSource: { sourcePath: '/retired/path' },
        })).toEqual({ v: 1, workspaceSyncMode: 'copy_once', includeIgnoredMode: 'exclude',
            ignoredIncludeGlobs: [], directTargetMode: 'keep_direct' });
    });
});
