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

    it('resolves qualified first-party snapshot identities to their leaf UI policies', () => {
        const git = scmUiBackendRegistry.getPlugin('happier.scm.backend.git/git');
        const sapling = scmUiBackendRegistry.getPlugin('happier.scm.backend.sapling/sapling');

        expect(git.diffModeConfig(null).availableModes).toEqual(['included', 'pending']);
        expect(sapling.diffModeConfig(null).availableModes).toEqual(['pending']);
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
                worktreeCreate: false,
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

        // Be conservative when capabilities are unknown so older daemons don't get a "both" diff request
        // that they can't satisfy.
        expect(gitPlugin.diffModeConfig(null).availableModes).toEqual(['included', 'pending']);
        expect(saplingPlugin.diffModeConfig(null).availableModes).toEqual(['pending']);
    });

    it('fails closed for sapling remote actions when capabilities are unavailable', () => {
        const saplingPlugin = scmUiBackendRegistry.getPlugin('sapling');
        const snapshot: ScmWorkingSnapshot = {
            projectKey: 'machine:/repo',
            fetchedAt: 1,
            repo: {
                isRepo: true,
                rootPath: '/repo',
                backendId: 'sapling',
                mode: '.sl',
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
        };

        expect(saplingPlugin.remoteActionConfig(snapshot)).toMatchObject({
            fetch: false,
            pull: false,
            push: false,
        });
    });
});
