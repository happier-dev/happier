import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { ScmBackend } from './types';
import {
    assertPortableWorkspaceEntriesWithScmWorkspace,
    assertPortableWorkspaceTransferEntriesWithScmWorkspace,
    classifyPortableWorkspacePathWithScmWorkspace,
    classifyPortableWorkspaceTransferEntryWithScmWorkspace,
    createWorkspaceCheckoutWithScmWorkspace,
    isAdministrativeWorkspacePathWithScmWorkspace,
    inspectWorkspaceLocationWithScmWorkspace,
    materializeWorkspaceCheckoutWithScmWorkspace,
    realizeWorkspaceCheckoutWithScmWorkspace,
    reconcilePostMaterializationWithScmWorkspace,
    resolveWorkspaceReplicationSourceInputsWithScmWorkspace,
    resolveWorkspaceTransferWithScmWorkspace,
    resolveWorkspaceTransferMetadataWithScmWorkspace,
    resolveWorkspaceTransferEntriesWithScmWorkspace,
} from './workspace';
import { createScmBackendRegistry } from './registry';

function createTestBackend(input: {
    id: 'git' | 'sapling';
    detectionRootPath: string;
    workspaceIntegration?: ScmBackend['workspaceIntegration'];
    detectRepo?: ScmBackend['detectRepo'];
}): ScmBackend {
    return {
        id: input.id,
        selection: {
            modeSelectionScores: {
                '.git': 200,
            },
        },
        workspaceIntegration: input.workspaceIntegration,
        detectRepo: input.detectRepo ?? (async () => ({
            isRepo: true,
            mode: '.git',
            rootPath: input.detectionRootPath,
        })),
        getCapabilities: () => ({
            capabilityScope: 'local-backend',
            readStatus: true,
            readDiffFile: true,
            readDiffCommit: true,
            readLog: true,
            readBranches: true,
            readStash: true,
            writeInclude: true,
            writeExclude: true,
            writeDiscard: true,
            writeCommit: true,
            writeCommitPathSelection: true,
            writeCommitLineSelection: true,
            writeBackout: true,
            writeRemoteFetch: true,
            writeRemotePull: true,
            writeRemotePush: true,
            writeRemotePublish: true,
            writeRemoteAdd: true,
            writeRemoteSetUrl: true,
            writeRemoteRemove: true,
            writeBranchMerge: true,
            writeBranchRebase: true,
            writeBranchOperationControl: true,
            worktreeCreate: false,
            changeSetModel: 'index',
            supportedDiffAreas: ['included', 'pending', 'both'],
            writeBranchCreate: true,
            writeBranchCheckout: true,
            writeStash: true,
        }),
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

describe('scm workspace integration', () => {
    it('surfaces backend-declared checkout discovery details without assuming the backend id', async () => {
        const registry = createScmBackendRegistry([
            createTestBackend({
                id: 'sapling',
                detectionRootPath: '/repo',
                workspaceIntegration: {
                    inspectWorkspaceLocation: async () => ({
                        rootPath: '/repo',
                        scmProvider: 'git',
                        checkoutDiscovery: [{ kind: 'git_worktree' }],
                    }),
                },
            }),
        ]);

        await expect(inspectWorkspaceLocationWithScmWorkspace({
            candidatePath: '/repo/packages/app',
            registry,
        })).resolves.toEqual(expect.objectContaining({
            backendId: 'sapling',
            workspaceLocationScm: {
                provider: 'git',
                rootPath: '/repo',
            },
            checkoutDiscovery: [{ kind: 'git_worktree' }],
            checkoutProviderKinds: ['git_worktree'],
        }));
    });

    it('maps legacy checkout provider kinds into the generic checkout discovery contract', async () => {
        const registry = createScmBackendRegistry([
            createTestBackend({
                id: 'git',
                detectionRootPath: '/repo',
                workspaceIntegration: {
                    inspectWorkspaceLocation: async () => ({
                        rootPath: '/repo',
                        scmProvider: 'git',
                        checkoutProviderKinds: ['git_worktree'],
                    }),
                },
            }),
        ]);

        await expect(inspectWorkspaceLocationWithScmWorkspace({
            candidatePath: '/repo/packages/app',
            registry,
        })).resolves.toEqual(expect.objectContaining({
            checkoutDiscovery: [{ kind: 'git_worktree' }],
            checkoutProviderKinds: ['git_worktree'],
        }));
    });

    it('passes source and previous target paths through the shared materialization hook', async () => {
        const reconcilePostMaterialization = vi.fn(async () => undefined);
        const registry = createScmBackendRegistry([
            createTestBackend({
                id: 'git',
                detectionRootPath: '/repo',
                workspaceIntegration: {
                    inspectWorkspaceLocation: async () => null,
                    reconcilePostMaterialization,
                },
            }),
        ]);

        await reconcilePostMaterializationWithScmWorkspace({
            targetPath: '/repo/checkout',
            sourcePath: '/repo',
            previousTargetPath: '/repo/.backup',
            registry,
        });

        expect(reconcilePostMaterialization).toHaveBeenCalledWith({
            context: expect.objectContaining({
                cwd: '/repo/checkout',
                detection: expect.objectContaining({
                    rootPath: '/repo',
                }),
            }),
            checkoutMaterialization: {
                targetPath: '/repo/checkout',
                sourcePath: '/repo',
                previousTargetPath: '/repo/.backup',
            },
            sourcePath: '/repo',
            previousTargetPath: '/repo/.backup',
        });
    });

    it('falls back to the source checkout selection when the target paths are not yet SCM-detectable', async () => {
        const reconcilePostMaterialization = vi.fn(async () => undefined);
        const registry = createScmBackendRegistry([
            createTestBackend({
                id: 'git',
                detectionRootPath: '/repo/source',
                detectRepo: async ({ cwd }) => cwd === '/repo/source'
                    ? {
                        isRepo: true,
                        mode: '.git',
                        rootPath: '/repo/source',
                    }
                    : {
                        isRepo: false,
                        mode: null,
                        rootPath: null,
                    },
                workspaceIntegration: {
                    inspectWorkspaceLocation: async () => null,
                    reconcilePostMaterialization,
                },
            }),
        ]);

        await reconcilePostMaterializationWithScmWorkspace({
            targetPath: '/imports/target',
            sourcePath: '/repo/source',
            previousTargetPath: '/imports/backup',
            registry,
        });

        expect(reconcilePostMaterialization).toHaveBeenCalledWith({
            context: expect.objectContaining({
                cwd: '/imports/target',
                detection: expect.objectContaining({
                    rootPath: '/imports/target',
                }),
            }),
            checkoutMaterialization: {
                targetPath: '/imports/target',
                sourcePath: '/repo/source',
                previousTargetPath: '/imports/backup',
            },
            sourcePath: '/repo/source',
            previousTargetPath: '/imports/backup',
        });
    });

    it('passes a backend-agnostic workspace transfer request through the shared workspace-integration hook', async () => {
        const resolveWorkspaceTransferEntries = vi.fn(async () => [
            {
                relativePath: '.git/HEAD',
                sourcePath: '/repo/.git/HEAD',
            },
        ]);
        const registry = createScmBackendRegistry([
            createTestBackend({
                id: 'git',
                detectionRootPath: '/repo',
                workspaceIntegration: {
                    inspectWorkspaceLocation: async () => null,
                    resolveWorkspaceTransferEntries,
                },
            }),
        ]);

        await expect(resolveWorkspaceTransferEntriesWithScmWorkspace({
            sourcePath: '/repo/packages/app',
            workspaceTransfer: {
                strategy: 'transfer_snapshot',
                includeIgnoredMode: 'include_selected',
                ignoredIncludeGlobs: ['dist/**'],
            },
            registry,
        })).resolves.toEqual([
            {
                relativePath: '.git/HEAD',
                sourcePath: '/repo/.git/HEAD',
            },
        ]);

        expect(resolveWorkspaceTransferEntries).toHaveBeenCalledWith({
            context: expect.objectContaining({
                cwd: '/repo/packages/app',
                detection: expect.objectContaining({
                    rootPath: '/repo',
                }),
            }),
            workspaceTransfer: {
                strategy: 'transfer_snapshot',
                includeIgnoredMode: 'include_selected',
                ignoredIncludeGlobs: ['dist/**'],
            },
        });
    });

    it('prefers a backend-owned workspace transfer realization hook before legacy transfer hooks', async () => {
        const resolveWorkspaceTransfer = vi.fn(async () => ({
            entries: [{
                relativePath: '.git/HEAD',
                sourcePath: '/repo/.git/HEAD',
            }],
            metadata: {
                branchName: 'main',
            },
        }));
        const resolveWorkspaceTransferEntries = vi.fn(async () => []);
        const resolveWorkspaceTransferMetadata = vi.fn(async () => null);
        const registry = createScmBackendRegistry([
            createTestBackend({
                id: 'git',
                detectionRootPath: '/repo',
                workspaceIntegration: {
                    inspectWorkspaceLocation: async () => null,
                    resolveWorkspaceTransfer,
                    resolveWorkspaceTransferEntries,
                    resolveWorkspaceTransferMetadata,
                },
            }),
        ]);

        await expect(resolveWorkspaceTransferEntriesWithScmWorkspace({
            sourcePath: '/repo/packages/app',
            workspaceTransfer: {
                strategy: 'transfer_snapshot',
                includeIgnoredMode: 'include_selected',
                ignoredIncludeGlobs: ['dist/**'],
            },
            registry,
        })).resolves.toEqual([{
            relativePath: '.git/HEAD',
            sourcePath: '/repo/.git/HEAD',
        }]);

        await expect(resolveWorkspaceTransferMetadataWithScmWorkspace({
            sourcePath: '/repo/packages/app',
            workspaceTransfer: {
                strategy: 'transfer_snapshot',
                includeIgnoredMode: 'include_selected',
                ignoredIncludeGlobs: ['dist/**'],
            },
            registry,
        })).resolves.toEqual({
            branchName: 'main',
        });

        expect(resolveWorkspaceTransfer).toHaveBeenCalledTimes(2);
        expect(resolveWorkspaceTransfer).toHaveBeenCalledWith({
            context: expect.objectContaining({
                cwd: '/repo/packages/app',
                detection: expect.objectContaining({
                    rootPath: '/repo',
                }),
            }),
            workspaceTransfer: {
                strategy: 'transfer_snapshot',
                includeIgnoredMode: 'include_selected',
                ignoredIncludeGlobs: ['dist/**'],
            },
        });
        expect(resolveWorkspaceTransferEntries).not.toHaveBeenCalled();
        expect(resolveWorkspaceTransferMetadata).not.toHaveBeenCalled();
    });

    it('surfaces a combined workspace transfer result through the shared workspace-integration seam', async () => {
        const resolveWorkspaceTransfer = vi.fn(async () => ({
            entries: [{
                relativePath: '.git/HEAD',
                sourcePath: '/repo/.git/HEAD',
            }],
            metadata: {
                branchName: 'main',
            },
        }));
        const registry = createScmBackendRegistry([
            createTestBackend({
                id: 'git',
                detectionRootPath: '/repo',
                workspaceIntegration: {
                    inspectWorkspaceLocation: async () => null,
                    resolveWorkspaceTransfer,
                    isAdministrativeWorkspacePath: ({ relativePath }) => relativePath.startsWith('.git/'),
                },
            }),
        ]);

        await expect(resolveWorkspaceTransferWithScmWorkspace({
            sourcePath: '/repo/packages/app',
            workspaceTransfer: {
                strategy: 'transfer_snapshot',
                includeIgnoredMode: 'include_selected',
                ignoredIncludeGlobs: ['dist/**'],
            },
            registry,
        })).resolves.toEqual({
            entries: [{
                relativePath: '.git/HEAD',
                sourcePath: '/repo/.git/HEAD',
            }],
            metadata: {
                branchName: 'main',
            },
        });

        expect(resolveWorkspaceTransfer).toHaveBeenCalledTimes(1);
    });

    it('returns null when the workspace-integration transfer hook reports no transfer', async () => {
        const resolveWorkspaceTransfer = vi.fn(async () => null);
        const registry = createScmBackendRegistry([
            createTestBackend({
                id: 'git',
                detectionRootPath: '/repo',
                workspaceIntegration: {
                    inspectWorkspaceLocation: async () => null,
                    resolveWorkspaceTransfer,
                },
            }),
        ]);

        await expect(resolveWorkspaceTransferWithScmWorkspace({
            sourcePath: '/repo/packages/app',
            workspaceTransfer: {
                strategy: 'transfer_snapshot',
                includeIgnoredMode: 'include_selected',
                ignoredIncludeGlobs: ['dist/**'],
            },
            registry,
        })).resolves.toBeNull();

        expect(resolveWorkspaceTransfer).toHaveBeenCalledTimes(1);
    });

    it('propagates workspace-integration transfer resolution errors instead of treating them as no transfer', async () => {
        const resolveWorkspaceTransfer = vi.fn(async () => {
            throw new Error('workspace transfer resolution failed');
        });
        const resolveWorkspaceTransferEntries = vi.fn(async () => [
            {
                relativePath: 'README.md',
                sourcePath: '/repo/README.md',
            },
        ]);
        const registry = createScmBackendRegistry([
            createTestBackend({
                id: 'git',
                detectionRootPath: '/repo',
                workspaceIntegration: {
                    inspectWorkspaceLocation: async () => null,
                    resolveWorkspaceTransfer,
                    resolveWorkspaceTransferEntries,
                },
            }),
        ]);

        await expect(resolveWorkspaceTransferWithScmWorkspace({
            sourcePath: '/repo/packages/app',
            workspaceTransfer: {
                strategy: 'transfer_snapshot',
                includeIgnoredMode: 'include_selected',
                ignoredIncludeGlobs: ['dist/**'],
            },
            registry,
        })).rejects.toThrow('workspace transfer resolution failed');

        expect(resolveWorkspaceTransfer).toHaveBeenCalledTimes(1);
        expect(resolveWorkspaceTransferEntries).not.toHaveBeenCalled();
    });

    it('resolves replication-friendly source inputs through the shared workspace-integration seam', async () => {
        const resolveWorkspaceTransfer = vi.fn(async () => ({
            entries: [{
                relativePath: '.git/HEAD',
                sourcePath: '/repo/.git/HEAD',
            }],
            metadata: {
                branchName: 'main',
            },
        }));
        const registry = createScmBackendRegistry([
            createTestBackend({
                id: 'git',
                detectionRootPath: '/repo',
                workspaceIntegration: {
                    inspectWorkspaceLocation: async () => null,
                    resolveWorkspaceTransfer,
                    isAdministrativeWorkspacePath: ({ relativePath }) => relativePath.startsWith('.git/'),
                },
            }),
        ]);

        await expect(resolveWorkspaceReplicationSourceInputsWithScmWorkspace({
            sourcePath: '/repo/packages/app',
            workspaceTransfer: {
                strategy: 'sync_changes',
                includeIgnoredMode: 'include_selected',
                ignoredIncludeGlobs: ['dist/**'],
            },
            registry,
        })).resolves.toEqual({
            entries: [{
                relativePath: '.git/HEAD',
                sourcePath: '/repo/.git/HEAD',
            }],
            workspaceIntegrationMetadata: {
                branchName: 'main',
            },
            safeFilterPolicy: {
                excludeAdministrativePaths: false,
            },
            isNestedRepoSourcePath: true,
        });
    });

    it('falls back to filesystem entries when no SCM transfer owner resolves', async () => {
        const sourcePath = await mkdtemp(join(tmpdir(), 'happier-workspace-integration-fallback-'));
        const nestedDir = join(sourcePath, 'nested');

        try {
            await mkdir(nestedDir, { recursive: true });
            await writeFile(join(sourcePath, 'README.md'), 'hello\n', 'utf8');
            await writeFile(join(nestedDir, 'copy.md'), 'hello\n', 'utf8');

            await expect(resolveWorkspaceReplicationSourceInputsWithScmWorkspace({
                sourcePath,
                workspaceTransfer: {
                    strategy: 'transfer_snapshot',
                    includeIgnoredMode: 'exclude',
                    ignoredIncludeGlobs: [],
                },
                registry: createScmBackendRegistry([]),
            })).resolves.toEqual({
                entries: [
                    {
                        relativePath: 'README.md',
                        sourcePath: join(sourcePath, 'README.md'),
                    },
                    {
                        relativePath: 'nested/copy.md',
                        sourcePath: join(sourcePath, 'nested/copy.md'),
                    },
                ],
                workspaceIntegrationMetadata: null,
                safeFilterPolicy: {
                    excludeAdministrativePaths: true,
                },
                isNestedRepoSourcePath: false,
            });
        } finally {
            await rm(sourcePath, { recursive: true, force: true });
        }
    });

    it('fails closed when the filesystem fallback source root is missing', async () => {
        const sourcePath = await mkdtemp(join(tmpdir(), 'happier-workspace-integration-fallback-missing-'));
        await rm(sourcePath, { recursive: true, force: true });

        await expect(resolveWorkspaceReplicationSourceInputsWithScmWorkspace({
            sourcePath,
            workspaceTransfer: {
                strategy: 'transfer_snapshot',
                includeIgnoredMode: 'exclude',
                ignoredIncludeGlobs: [],
            },
            registry: createScmBackendRegistry([]),
        })).rejects.toMatchObject({
            code: 'source_path_unreadable',
            sourcePath,
        });
    });

    it('passes a backend-agnostic checkout materialization request through the shared workspace-integration hook', async () => {
        const materializeWorkspaceCheckout = vi.fn(async () => undefined);
        const registry = createScmBackendRegistry([
            createTestBackend({
                id: 'git',
                detectionRootPath: '/repo',
                workspaceIntegration: {
                    inspectWorkspaceLocation: async () => null,
                    materializeWorkspaceCheckout,
                },
            }),
        ]);

        await expect(materializeWorkspaceCheckoutWithScmWorkspace({
            sourcePath: '/repo/packages/app',
            targetPath: '/repo/.worktrees/feature-auth',
            checkoutCreation: {
                kind: 'git_worktree',
                displayName: 'feature-auth',
                baseRef: null,
                branchMode: 'new',
            },
            registry,
        })).resolves.toBe(true);

        expect(materializeWorkspaceCheckout).toHaveBeenCalledWith({
            context: expect.objectContaining({
                cwd: '/repo/packages/app',
                detection: expect.objectContaining({
                    rootPath: '/repo',
                }),
            }),
            workspaceCheckoutMaterialization: {
                kind: 'git_worktree',
                sourcePath: '/repo/packages/app',
                targetPath: '/repo/.worktrees/feature-auth',
                displayName: 'feature-auth',
                baseRef: null,
                branchMode: 'new',
            },
        });
    });

    it('uses a backend-reported materialized target path when legacy materialization rebinds the checkout', async () => {
        const materializeWorkspaceCheckout = vi.fn(async () => ({
            targetPath: '/repo/.dev/worktree/feature-auth',
            branchName: 'feature-auth',
            created: true,
        }));
        const registry = createScmBackendRegistry([
            createTestBackend({
                id: 'git',
                detectionRootPath: '/repo',
                workspaceIntegration: {
                    inspectWorkspaceLocation: async () => null,
                    materializeWorkspaceCheckout,
                },
            }),
        ]);

        await expect(realizeWorkspaceCheckoutWithScmWorkspace({
            sourcePath: '/repo/packages/app',
            targetPath: '/repo/.worktrees/feature-auth',
            checkoutCreation: {
                kind: 'git_worktree',
                displayName: 'feature-auth',
                baseRef: 'main',
                branchMode: 'new',
            },
            registry,
        })).resolves.toEqual({
            kind: 'git_worktree',
            targetPath: '/repo/.dev/worktree/feature-auth',
            branchName: 'feature-auth',
            created: true,
        });
    });

    it('passes a backend-agnostic checkout creation request through the shared workspace-integration hook', async () => {
        const createWorkspaceCheckout = vi.fn(async () => ({
            kind: 'git_worktree' as const,
            targetPath: '/repo/.dev/worktree/feature-auth',
            branchName: 'feature-auth',
            created: true,
        }));
        const registry = createScmBackendRegistry([
            createTestBackend({
                id: 'git',
                detectionRootPath: '/repo',
                workspaceIntegration: {
                    inspectWorkspaceLocation: async () => null,
                    createWorkspaceCheckout,
                },
            }),
        ]);

        await expect(createWorkspaceCheckoutWithScmWorkspace({
            sourcePath: '/repo/packages/app',
            checkoutCreation: {
                kind: 'git_worktree',
                displayName: 'feature-auth',
                baseRef: 'main',
                branchMode: 'new',
            },
            registry,
        })).resolves.toEqual({
            kind: 'git_worktree',
            targetPath: '/repo/.dev/worktree/feature-auth',
            branchName: 'feature-auth',
            created: true,
        });

        expect(createWorkspaceCheckout).toHaveBeenCalledWith({
            context: expect.objectContaining({
                cwd: '/repo/packages/app',
                detection: expect.objectContaining({
                    rootPath: '/repo',
                }),
            }),
            workspaceCheckoutCreation: {
                kind: 'git_worktree',
                sourcePath: '/repo/packages/app',
                displayName: 'feature-auth',
                baseRef: 'main',
                branchMode: 'new',
            },
        });
    });

    it('prefers a backend-owned checkout realization hook for creation before legacy create hooks', async () => {
        const realizeWorkspaceCheckout = vi.fn(async () => ({
            kind: 'git_worktree' as const,
            targetPath: '/repo/.scm/feature-auth',
            branchName: 'feature-auth',
            created: true,
        }));
        const createWorkspaceCheckout = vi.fn(async () => ({
            kind: 'git_worktree' as const,
            targetPath: '/repo/.dev/worktree/feature-auth',
            branchName: 'feature-auth',
            created: true,
        }));
        const registry = createScmBackendRegistry([
            createTestBackend({
                id: 'git',
                detectionRootPath: '/repo',
                workspaceIntegration: {
                    inspectWorkspaceLocation: async () => null,
                    realizeWorkspaceCheckout,
                    createWorkspaceCheckout,
                },
            }),
        ]);

        await expect(createWorkspaceCheckoutWithScmWorkspace({
            sourcePath: '/repo/packages/app',
            checkoutCreation: {
                kind: 'git_worktree',
                displayName: 'feature-auth',
                baseRef: 'main',
                branchMode: 'new',
            },
            registry,
        })).resolves.toEqual({
            kind: 'git_worktree',
            targetPath: '/repo/.scm/feature-auth',
            branchName: 'feature-auth',
            created: true,
        });

        expect(realizeWorkspaceCheckout).toHaveBeenCalledWith({
            context: expect.objectContaining({
                cwd: '/repo/packages/app',
                detection: expect.objectContaining({
                    rootPath: '/repo',
                }),
            }),
            workspaceCheckoutRealization: {
                kind: 'git_worktree',
                sourcePath: '/repo/packages/app',
                displayName: 'feature-auth',
                baseRef: 'main',
                branchMode: 'new',
                targetPath: null,
            },
        });
        expect(createWorkspaceCheckout).not.toHaveBeenCalled();
    });

    it('prefers a backend-owned checkout realization hook for materialization before legacy materialize hooks', async () => {
        const realizeWorkspaceCheckout = vi.fn(async () => ({
            kind: 'git_worktree' as const,
            targetPath: '/repo/.scm/feature-auth',
            branchName: 'feature-auth',
            created: true,
        }));
        const materializeWorkspaceCheckout = vi.fn(async () => undefined);
        const registry = createScmBackendRegistry([
            createTestBackend({
                id: 'git',
                detectionRootPath: '/repo',
                workspaceIntegration: {
                    inspectWorkspaceLocation: async () => null,
                    realizeWorkspaceCheckout,
                    materializeWorkspaceCheckout,
                },
            }),
        ]);

        await expect(materializeWorkspaceCheckoutWithScmWorkspace({
            sourcePath: '/repo/packages/app',
            targetPath: '/repo/.worktrees/feature-auth',
            checkoutCreation: {
                kind: 'git_worktree',
                displayName: 'feature-auth',
                baseRef: 'main',
                branchMode: 'new',
            },
            registry,
        })).resolves.toBe(true);

        expect(realizeWorkspaceCheckout).toHaveBeenCalledWith({
            context: expect.objectContaining({
                cwd: '/repo/packages/app',
                detection: expect.objectContaining({
                    rootPath: '/repo',
                }),
            }),
            workspaceCheckoutRealization: {
                kind: 'git_worktree',
                sourcePath: '/repo/packages/app',
                displayName: 'feature-auth',
                baseRef: 'main',
                branchMode: 'new',
                targetPath: '/repo/.worktrees/feature-auth',
            },
        });
        expect(materializeWorkspaceCheckout).not.toHaveBeenCalled();
    });

    it('runs portable workspace entry guards through the shared workspace-integration seam', async () => {
        const assertPortableWorkspaceEntries = vi.fn(async () => undefined);
        const registry = createScmBackendRegistry([
            createTestBackend({
                id: 'git',
                detectionRootPath: '/repo',
                workspaceIntegration: {
                    inspectWorkspaceLocation: async () => null,
                    assertPortableWorkspaceEntries,
                },
            }),
        ]);

        await assertPortableWorkspaceEntriesWithScmWorkspace({
            entries: [
                { relativePath: '.git/HEAD' },
                { relativePath: 'README.md' },
            ],
            registry,
        });

        expect(assertPortableWorkspaceEntries).toHaveBeenCalledWith({
            entries: [
                { relativePath: '.git/HEAD' },
                { relativePath: 'README.md' },
            ],
        });
    });

    it('falls back to shared portable-path classification when a backend does not expose a dedicated portability guard', async () => {
        const registry = createScmBackendRegistry([
            createTestBackend({
                id: 'sapling',
                detectionRootPath: '/repo',
                workspaceIntegration: {
                    inspectWorkspaceLocation: async () => null,
                    classifyPortableWorkspacePath: ({ relativePath }) => relativePath.startsWith('.sl/store/')
                        ? 'non_portable'
                        : 'unknown',
                },
            }),
        ]);

        await expect(assertPortableWorkspaceEntriesWithScmWorkspace({
            entries: [{ relativePath: '.sl/store/data' }],
            registry,
        })).rejects.toThrow('non-portable workspace path: .sl/store/data');
    });

    it('runs transfer-entry portability classification through the shared workspace-integration seam', async () => {
        const classifyPortableWorkspaceTransferEntry = vi.fn(({ sourcePath }: { sourcePath: string }) =>
            sourcePath.endsWith('/.backend/private') ? 'non_portable' : 'portable');
        const registry = createScmBackendRegistry([
            createTestBackend({
                id: 'sapling',
                detectionRootPath: '/repo',
                workspaceIntegration: {
                    inspectWorkspaceLocation: async () => null,
                    classifyPortableWorkspaceTransferEntry,
                },
            }),
        ]);

        await expect(assertPortableWorkspaceTransferEntriesWithScmWorkspace({
            entries: [{
                relativePath: '.backend/private',
                sourcePath: '/repo/.backend/private',
            }],
            registry,
        })).rejects.toThrow('non-portable workspace path: .backend/private');

        expect(classifyPortableWorkspaceTransferEntry).toHaveBeenCalledWith({
            relativePath: '.backend/private',
            sourcePath: '/repo/.backend/private',
        });
    });

    it('falls back to shared path classification when transfer-entry classification is unknown', async () => {
        const classifyPortableWorkspaceTransferEntry = vi.fn(() => 'unknown' as const);
        const classifyPortableWorkspacePath = vi.fn(({ relativePath }: { relativePath: string }) => relativePath.startsWith('.backend/private')
            ? 'non_portable' as const
            : 'unknown' as const);
        const registry = createScmBackendRegistry([
            createTestBackend({
                id: 'sapling',
                detectionRootPath: '/repo',
                workspaceIntegration: {
                    inspectWorkspaceLocation: async () => null,
                    classifyPortableWorkspaceTransferEntry,
                    classifyPortableWorkspacePath,
                },
            }),
        ]);

        await expect(assertPortableWorkspaceTransferEntriesWithScmWorkspace({
            entries: [{
                relativePath: '.backend/private',
                sourcePath: '/repo/.backend/private',
            }],
            registry,
        })).rejects.toThrow('non-portable workspace path: .backend/private');

        expect(classifyPortableWorkspaceTransferEntry).toHaveBeenCalledWith({
            relativePath: '.backend/private',
            sourcePath: '/repo/.backend/private',
        });
        expect(classifyPortableWorkspacePath).toHaveBeenCalledWith({
            relativePath: '.backend/private',
        });
    });

    it('rejects git and sapling admin transfer entries through the authoritative SCM registry', async () => {
        const registry = createScmBackendRegistry([
            createTestBackend({
                id: 'git',
                detectionRootPath: '/repo',
                workspaceIntegration: {
                    inspectWorkspaceLocation: async () => null,
                    classifyPortableWorkspacePath: ({ relativePath }) => (
                        relativePath === '.git'
                        || relativePath.startsWith('.git/')
                        || relativePath === '.sl'
                        || relativePath.startsWith('.sl/')
                    ) ? 'non_portable' : 'unknown',
                },
            }),
        ]);

        await expect(assertPortableWorkspaceTransferEntriesWithScmWorkspace({
            entries: [{
                relativePath: '.git/worktrees/feature/HEAD',
                sourcePath: '/repo/.git/worktrees/feature/HEAD',
            }],
            registry,
        })).rejects.toThrow('non-portable workspace path: .git/worktrees/feature/HEAD');

        await expect(assertPortableWorkspaceTransferEntriesWithScmWorkspace({
            entries: [{
                relativePath: '.sl/store',
                sourcePath: '/repo/.sl/store',
            }],
            registry,
        })).rejects.toThrow('non-portable workspace path: .sl/store');
    });

    it('surfaces transfer-entry path classification through the shared workspace-integration seam', () => {
        const classifyPortableWorkspaceTransferEntry = vi.fn(() => 'unknown' as const);
        const classifyPortableWorkspacePath = vi.fn(({ relativePath }: { relativePath: string }) => relativePath === '.backend/private'
            ? 'non_portable' as const
            : 'portable' as const);
        const registry = createScmBackendRegistry([
            createTestBackend({
                id: 'sapling',
                detectionRootPath: '/repo',
                workspaceIntegration: {
                    inspectWorkspaceLocation: async () => null,
                    classifyPortableWorkspaceTransferEntry,
                    classifyPortableWorkspacePath,
                },
            }),
        ]);

        expect(classifyPortableWorkspaceTransferEntryWithScmWorkspace({
            entry: {
                relativePath: '.backend/private',
                sourcePath: '/repo/.backend/private',
            },
            registry,
        })).toBe('non_portable');

        expect(classifyPortableWorkspaceTransferEntry).toHaveBeenCalledWith({
            relativePath: '.backend/private',
            sourcePath: '/repo/.backend/private',
        });
        expect(classifyPortableWorkspacePath).toHaveBeenCalledWith({
            relativePath: '.backend/private',
        });
    });

    it('matches backend-declared administrative workspace paths through the shared workspace-integration seam', async () => {
        const registry = createScmBackendRegistry([
            createTestBackend({
                id: 'sapling',
                detectionRootPath: '/repo',
                workspaceIntegration: {
                    inspectWorkspaceLocation: async () => null,
                    isAdministrativeWorkspacePath: ({ relativePath }) => relativePath.startsWith('.sl/'),
                },
            }),
        ]);

        expect(isAdministrativeWorkspacePathWithScmWorkspace({
            relativePath: '.sl/store/data',
            registry,
        })).toBe(true);

        expect(isAdministrativeWorkspacePathWithScmWorkspace({
            relativePath: 'README.md',
            registry,
        })).toBe(false);
    });

    it('surfaces backend-declared portable path classifications through the shared workspace-integration seam', async () => {
        const registry = createScmBackendRegistry([
            createTestBackend({
                id: 'sapling',
                detectionRootPath: '/repo',
                workspaceIntegration: {
                    inspectWorkspaceLocation: async () => null,
                    classifyPortableWorkspacePath: ({ relativePath }) => relativePath.startsWith('.sl/store/')
                        ? 'non_portable'
                        : relativePath.startsWith('.sl/')
                            ? 'portable'
                            : 'unknown',
                },
            }),
        ]);

        expect(classifyPortableWorkspacePathWithScmWorkspace({
            relativePath: '.sl/store/data',
            registry,
        })).toBe('non_portable');

        expect(classifyPortableWorkspacePathWithScmWorkspace({
            relativePath: '.sl/config',
            registry,
        })).toBe('portable');

        expect(classifyPortableWorkspacePathWithScmWorkspace({
            relativePath: 'README.md',
            registry,
        })).toBe('unknown');
    });
});
