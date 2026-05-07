import { describe, expect, it } from 'vitest';

import type { ScmBackendPreference, ScmRepoMode } from '@happier-dev/protocol';

import {
    createScmBackendRegistry,
} from './registry';
import type { ScmBackend } from './types';

function backend(input: {
    id: 'git' | 'sapling';
    detected: { isRepo: boolean; mode: ScmRepoMode | null; rootPath: string | null };
    modeSelectionScores?: Partial<Record<ScmRepoMode, number>>;
}): ScmBackend {
    return {
        id: input.id,
        selection: {
            modeSelectionScores: input.modeSelectionScores ?? {},
        },
        detectRepo: async () => input.detected,
        getCapabilities: () => {
            throw new Error('not needed in this test');
        },
        describeBackend: async () => {
            throw new Error('not needed in this test');
        },
        statusSnapshot: async () => {
            throw new Error('not needed in this test');
        },
        diffFile: async () => {
            throw new Error('not needed in this test');
        },
        diffCommit: async () => {
            throw new Error('not needed in this test');
        },
        changeInclude: async () => {
            throw new Error('not needed in this test');
        },
        changeExclude: async () => {
            throw new Error('not needed in this test');
        },
        changeDiscard: async () => {
            throw new Error('not needed in this test');
        },
        commitCreate: async () => {
            throw new Error('not needed in this test');
        },
        commitBackout: async () => {
            throw new Error('not needed in this test');
        },
        logList: async () => {
            throw new Error('not needed in this test');
        },
        branchList: async () => {
            throw new Error('not needed in this test');
        },
        branchCreate: async () => {
            throw new Error('not needed in this test');
        },
        branchCheckout: async () => {
            throw new Error('not needed in this test');
        },
        branchMerge: async () => {
            throw new Error('not needed in this test');
        },
        branchRebase: async () => {
            throw new Error('not needed in this test');
        },
        branchOperationContinue: async () => {
            throw new Error('not needed in this test');
        },
        branchOperationAbort: async () => {
            throw new Error('not needed in this test');
        },
        worktreeCreate: async () => {
            throw new Error('not needed in this test');
        },
        worktreeRemove: async () => {
            throw new Error('not needed in this test');
        },
        worktreePrune: async () => {
            throw new Error('not needed in this test');
        },
        remoteAdd: async () => {
            throw new Error('not needed in this test');
        },
        remoteSetUrl: async () => {
            throw new Error('not needed in this test');
        },
        remoteRemove: async () => {
            throw new Error('not needed in this test');
        },
        remoteFetch: async () => {
            throw new Error('not needed in this test');
        },
        remotePull: async () => {
            throw new Error('not needed in this test');
        },
        remotePush: async () => {
            throw new Error('not needed in this test');
        },
        remotePublish: async () => {
            throw new Error('not needed in this test');
        },
        stashList: async () => {
            throw new Error('not needed in this test');
        },
        stashDrop: async () => {
            throw new Error('not needed in this test');
        },
        stashPop: async () => {
            throw new Error('not needed in this test');
        },
        stashApply: async () => {
            throw new Error('not needed in this test');
        },
        stashShow: async () => {
            throw new Error('not needed in this test');
        },
    } satisfies ScmBackend;
}

describe('scm backend registry selection', () => {
    it('prefers sapling for .sl repositories', async () => {
        const registry = createScmBackendRegistry([
            backend({ id: 'git', detected: { isRepo: false, mode: null, rootPath: null } }),
            backend({ id: 'sapling', detected: { isRepo: true, mode: '.sl', rootPath: '/repo' } }),
        ]);

        const selected = await registry.selectBackend({
            cwd: '/repo',
            workingDirectory: '/repo',
        });

        expect(selected?.backend.id).toBe('sapling');
        expect(selected?.mode).toBe('.sl');
    });

    it('defaults to git backend for .git repositories', async () => {
        const registry = createScmBackendRegistry([
            backend({ id: 'git', detected: { isRepo: true, mode: '.git', rootPath: '/repo' }, modeSelectionScores: { '.git': 200 } }),
            backend({ id: 'sapling', detected: { isRepo: true, mode: '.git', rootPath: '/repo' }, modeSelectionScores: { '.git': 100 } }),
        ]);

        const selected = await registry.selectBackend({
            cwd: '/repo',
            workingDirectory: '/repo',
        });

        expect(selected?.backend.id).toBe('git');
        expect(selected?.mode).toBe('.git');
    });

    it('honors explicit sapling preference for .git repositories', async () => {
        const registry = createScmBackendRegistry([
            backend({ id: 'git', detected: { isRepo: true, mode: '.git', rootPath: '/repo' } }),
            backend({ id: 'sapling', detected: { isRepo: true, mode: '.git', rootPath: '/repo' } }),
        ]);
        const backendPreference: ScmBackendPreference = {
            kind: 'prefer',
            backendId: 'sapling',
        };

        const selected = await registry.selectBackend({
            cwd: '/repo',
            workingDirectory: '/repo',
            backendPreference,
        });

        expect(selected?.backend.id).toBe('sapling');
        expect(selected?.mode).toBe('.git');
    });

    it('selects backend for a mode using backend-provided scores (no hardcoded backend ordering)', async () => {
        const registry = createScmBackendRegistry([
            backend({ id: 'git', detected: { isRepo: true, mode: '.git', rootPath: '/repo' }, modeSelectionScores: { '.git': 10 } }),
            backend({ id: 'sapling', detected: { isRepo: true, mode: '.git', rootPath: '/repo' }, modeSelectionScores: { '.git': 300 } }),
        ]);

        const selected = await registry.selectBackend({
            cwd: '/repo',
            workingDirectory: '/repo',
        });

        expect(selected?.backend.id).toBe('sapling');
        expect(selected?.mode).toBe('.git');
    });

    it('preserves the selected backend detection root path for downstream scm consumers', async () => {
        const registry = createScmBackendRegistry([
            backend({ id: 'git', detected: { isRepo: true, mode: '.git', rootPath: '/repo' }, modeSelectionScores: { '.git': 200 } }),
        ]);

        const selected = await registry.selectBackend({
            cwd: '/repo/packages/app',
            workingDirectory: '/repo',
        });

        expect(selected).toEqual(expect.objectContaining({
            backend: expect.objectContaining({ id: 'git' }),
            mode: '.git',
            detection: {
                isRepo: true,
                mode: '.git',
                rootPath: '/repo',
            },
        }));
    });

    it('returns null when no backend detects the working path as a repository', async () => {
        const registry = createScmBackendRegistry([
            backend({ id: 'git', detected: { isRepo: false, mode: null, rootPath: null } }),
            backend({ id: 'sapling', detected: { isRepo: false, mode: null, rootPath: null } }),
        ]);

        await expect(registry.selectBackend({
            cwd: '/not-a-repo',
            workingDirectory: '/not-a-repo',
        })).resolves.toBeNull();
    });

    it('selects the owning backend for repository provisioning when another scm already owns the path', async () => {
        const registry = createScmBackendRegistry([
            backend({ id: 'git', detected: { isRepo: false, mode: null, rootPath: null } }),
            backend({ id: 'sapling', detected: { isRepo: true, mode: '.sl', rootPath: '/repo' } }),
        ]);

        const selected = await registry.selectProvisioningBackend({
            cwd: '/repo',
            workingDirectory: '/repo',
        });

        expect(selected?.backend.id).toBe('sapling');
        expect(selected?.mode).toBe('.sl');
        expect(selected?.detection).toEqual({
            isRepo: true,
            mode: '.sl',
            rootPath: '/repo',
        });
    });
});
