import { describe, expect, it } from 'vitest';

import { ScmBackendCapabilitiesSchema, type ScmBackendPreference, type ScmRepoMode } from '@happier-dev/protocol';

import {
    createScmBackendRegistry,
} from './registry';
import type { ScmBackend } from './types';

const TEST_DECLARED_CAPABILITIES = ScmBackendCapabilitiesSchema.parse({
    detection: {},
    read: {},
    changeSet: {
        model: 'working-copy',
        diffAreas: ['pending', 'both'],
    },
    commit: {},
    remote: {},
    branch: {},
    worktree: {},
    lifecycle: {},
    hosting: {},
    checkpoints: {},
    workspaceIntegration: {},
    tooling: {},
    freshness: {},
});

function backend(input: {
    id: string;
    localId?: string;
    detected: { isRepo: boolean; mode: ScmRepoMode | null; rootPath: string | null };
    modeSelectionScores?: Partial<Record<ScmRepoMode, number>>;
}): ScmBackend {
    return {
        id: input.id,
        ...(input.localId ? { localId: input.localId } : {}),
        declaredCapabilities: TEST_DECLARED_CAPABILITIES,
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

    it('honors a unique legacy local-id preference for a qualified plugin backend', async () => {
        const registry = createScmBackendRegistry([
            backend({
                id: 'happier.scm.backend.git/git',
                localId: 'git',
                detected: { isRepo: true, mode: '.git', rootPath: '/repo' },
                modeSelectionScores: { '.git': 200 },
            }),
            backend({
                id: 'happier.scm.backend.sapling/sapling',
                localId: 'sapling',
                detected: { isRepo: true, mode: '.git', rootPath: '/repo' },
                modeSelectionScores: { '.git': 100 },
            }),
        ]);

        const selected = await registry.selectBackend({
            cwd: '/repo',
            workingDirectory: '/repo',
            backendPreference: {
                kind: 'prefer',
                backendId: 'sapling',
            },
        });

        expect(selected?.backend.id).toBe('happier.scm.backend.sapling/sapling');
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

    it('keeps a healthy backend selectable when another plugin detector throws', async () => {
        const failing = backend({
            id: 'acme.broken/detector',
            detected: { isRepo: false, mode: null, rootPath: null },
        });
        const healthy = backend({
            id: 'happier.scm.backend.git/git',
            localId: 'git',
            detected: { isRepo: true, mode: '.git', rootPath: '/repo' },
            modeSelectionScores: { '.git': 200 },
        });
        const registry = createScmBackendRegistry([
            {
                ...failing,
                detectRepo: async () => {
                    throw new Error('packed detector failed');
                },
            },
            healthy,
        ]);

        await expect(registry.selectBackend({
            cwd: '/repo',
            workingDirectory: '/repo',
        })).resolves.toMatchObject({
            backend: { id: 'happier.scm.backend.git/git' },
            detection: { isRepo: true, mode: '.git', rootPath: '/repo' },
        });
    });

    it('does not misreport a working path as a non-repository when no detector could answer', async () => {
        const failing = backend({
            id: 'acme.broken/detector',
            detected: { isRepo: false, mode: null, rootPath: null },
        });
        const registry = createScmBackendRegistry([
            {
                ...failing,
                detectRepo: async () => {
                    throw new Error('packed detector failed');
                },
            },
            {
                ...backend({
                    id: 'happier.scm.backend.git/git',
                    localId: 'git',
                    detected: { isRepo: false, mode: null, rootPath: null },
                }),
                detectRepo: async () => {
                    throw new Error('git is not usable on this machine');
                },
            },
        ]);

        await expect(registry.selectBackend({
            cwd: '/repo',
            workingDirectory: '/repo',
        })).rejects.toThrow('packed detector failed');
    });

    // F-SCM-1: a detector that could not run must not override one that did. A machine without
    // Sapling installed is the common case, and its non-answer used to be indistinguishable from a
    // real "not a repository" — collapsing both into the same confident negative.
    it('keeps a detector failure from overriding a backend that answered authoritatively', async () => {
        const registry = createScmBackendRegistry([
            {
                ...backend({
                    id: 'happier.scm.backend.sapling/sapling',
                    localId: 'sapling',
                    detected: { isRepo: false, mode: null, rootPath: null },
                }),
                detectRepo: async () => {
                    throw new Error('SCM executable not found for sapling-cli (sl)');
                },
            },
            backend({
                id: 'happier.scm.backend.git/git',
                localId: 'git',
                detected: { isRepo: false, mode: null, rootPath: null },
            }),
        ]);

        await expect(registry.selectBackend({
            cwd: '/repo',
            workingDirectory: '/repo',
        })).resolves.toBeNull();
    });

    it('resolves live availability without mutating static declared support', async () => {
        const module = await import('./capabilities/resolveScmBackendCapabilities').catch(() => null);
        expect(module).not.toBeNull();
        if (!module) return;

        const capabilityModule = await import('@happier-dev/protocol').then((protocol) => ({
            schema: protocol.ScmBackendCapabilitiesSchema,
        })).catch(() => null);
        expect(capabilityModule).not.toBeNull();
        if (!capabilityModule) return;

        const declared = capabilityModule.schema.parse({
            detection: {
                repository: { support: 'supported' },
                executable: { support: 'supported' },
            },
            read: {
                status: { support: 'supported' },
            },
            changeSet: {
                model: 'index',
                diffAreas: ['included', 'pending', 'both'],
            },
            commit: {},
            remote: {
                push: { support: 'supported' },
            },
            branch: {},
            worktree: {},
            lifecycle: {},
            hosting: {},
            checkpoints: {},
            workspaceIntegration: {},
            tooling: {
                binarySafe: { support: 'supported' },
            },
            freshness: {},
        });

        const resolved = module.resolveScmBackendCapabilities({
            declaredCapabilities: declared,
            mode: '.sl',
            executableAvailable: false,
            freshness: {
                state: {
                    source: 'live-local',
                    observedAt: 100,
                },
                refreshPolicy: 'cache-first',
            },
        });

        expect(declared.remote.push).toEqual({ support: 'supported' });
        expect(resolved.remote.push).toEqual({
            support: 'unsupported',
            reason: 'tool_missing',
            declaredSupport: 'supported',
        });
        expect(resolved.detection.repository).toEqual({
            support: 'unsupported',
            reason: 'repo_mode_unsupported',
            declaredSupport: 'supported',
        });
        expect(resolved.freshness.state).toEqual({
            source: 'live-local',
            observedAt: 100,
        });
        expect(resolved.freshness.refreshPolicy).toBe('cache-first');
    });

    it('does not infer tool availability when live executable status is omitted', async () => {
        const module = await import('./capabilities/resolveScmBackendCapabilities').catch(() => null);
        expect(module).not.toBeNull();
        if (!module) return;

        const declared = ScmBackendCapabilitiesSchema.parse({
            detection: {
                repository: { support: 'supported' },
                executable: { support: 'supported' },
            },
            read: {
                status: { support: 'supported' },
            },
            changeSet: {
                model: 'index',
                diffAreas: ['included', 'pending', 'both'],
            },
            commit: {},
            remote: {
                push: { support: 'supported' },
            },
            branch: {},
            worktree: {},
            lifecycle: {},
            hosting: {},
            checkpoints: {},
            workspaceIntegration: {},
            tooling: {},
            freshness: {},
        });

        const resolved = module.resolveScmBackendCapabilities({
            declaredCapabilities: declared,
            mode: '.git',
            supportedRepoModes: ['.git'],
        });

        expect(resolved.detection.executable).toEqual({ support: 'supported' });
        expect(resolved.read.status).toEqual({ support: 'supported' });
        expect(resolved.remote.push).toEqual({ support: 'supported' });
    });

    it('treats missing repo mode as unavailable instead of live supported', async () => {
        const module = await import('./capabilities/resolveScmBackendCapabilities').catch(() => null);
        expect(module).not.toBeNull();
        if (!module) return;

        const declared = ScmBackendCapabilitiesSchema.parse({
            detection: {
                repository: { support: 'supported' },
                executable: { support: 'supported' },
            },
            read: {
                status: { support: 'supported' },
            },
            changeSet: {
                model: 'index',
                diffAreas: ['included', 'pending', 'both'],
                include: { support: 'supported' },
            },
            commit: {
                create: { support: 'supported' },
            },
            remote: {
                push: { support: 'supported' },
            },
            branch: {},
            worktree: {},
            lifecycle: {},
            hosting: {},
            checkpoints: {},
            workspaceIntegration: {},
            tooling: {},
            freshness: {},
        });

        const resolved = module.resolveScmBackendCapabilities({
            declaredCapabilities: declared,
            mode: null,
            supportedRepoModes: ['.git'],
            executableAvailable: true,
        });

        expect(resolved.detection.repository).toEqual({
            support: 'unsupported',
            reason: 'repo_mode_unsupported',
            declaredSupport: 'supported',
        });
        expect(resolved.read.status).toEqual({
            support: 'unsupported',
            reason: 'repo_mode_unsupported',
            declaredSupport: 'supported',
        });
        expect(resolved.remote.push).toEqual({
            support: 'unsupported',
            reason: 'repo_mode_unsupported',
            declaredSupport: 'supported',
        });
    });
});
