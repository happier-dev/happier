import { describe, expect, it } from 'vitest';

import { scmUiBackendRegistry } from './scmUiBackendRegistry';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';

describe('scmUiBackendRegistry', () => {
    it('resolves git and sapling plugins by backend id', () => {
        const git = scmUiBackendRegistry.getPlugin('git');
        const sapling = scmUiBackendRegistry.getPlugin('sapling');

        expect(git.displayName).toBe('Git');
        expect(sapling.displayName).toBe('Sapling');
    });

    it('falls back when backend id is unknown', () => {
        const fallback = scmUiBackendRegistry.getPlugin('unknown');
        expect(fallback.displayName).toBe('Source control');
    });

    it('does not infer branch from head for unknown backends without upstream', () => {
        const fallback = scmUiBackendRegistry.getPlugin('unknown');
        const snapshot = {
            projectKey: 'machine:/repo',
            fetchedAt: 1,
            repo: {
                isRepo: true,
                rootPath: '/repo',
                backendId: 'git-unknown',
                mode: '.git',
            },
            capabilities: {
                readStatus: true,
                readDiffFile: true,
                readDiffCommit: true,
                readLog: true,
                writeInclude: false,
                writeExclude: false,
                writeCommit: true,
                writeCommitPathSelection: true,
                writeCommitLineSelection: false,
                writeBackout: true,
                writeRemoteFetch: true,
                writeRemotePull: true,
                writeRemotePush: true,
                workspaceWorktreeCreate: false,
                changeSetModel: 'working-copy',
                supportedDiffAreas: ['pending', 'both'],
            },
            branch: {
                head: 'feature/no-upstream',
                upstream: null,
                ahead: 0,
                behind: 0,
                detached: false,
            },
            stashCount: 0,
            hasConflicts: false,
            entries: [],
            totals: {
                includedFiles: 0,
                pendingFiles: 0,
                untrackedFiles: 0,
                includedAdded: 0,
                includedRemoved: 0,
                pendingAdded: 0,
                pendingRemoved: 0,
            },
        } as unknown as ScmWorkingSnapshot;

        expect(fallback.inferRemoteTarget(snapshot)).toEqual({
            remote: 'origin',
            branch: null,
        });
    });

    it('validates plugin map invariants', () => {
        expect(() => scmUiBackendRegistry.assertRegistryValid()).not.toThrow();
    });

    it('uses backend-default diff areas when no snapshot is available', () => {
        const gitPlugin = scmUiBackendRegistry.getPlugin('git');
        const saplingPlugin = scmUiBackendRegistry.getPlugin('sapling');

        expect(gitPlugin.diffModeConfig(null).availableModes).toEqual(['included', 'pending', 'both']);
        expect(saplingPlugin.diffModeConfig(null).availableModes).toEqual(['pending', 'both']);
    });
});
