import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { ScmBackend } from './types';
import {
    assertPortableWorkspaceEntriesWithSourceController,
    assertPortableWorkspaceTransferEntriesWithSourceController,
    classifyPortableWorkspacePathWithSourceController,
    classifyPortableWorkspaceTransferEntryWithSourceController,
    createWorkspaceCheckoutWithSourceController,
    isAdministrativeWorkspacePathWithSourceController,
    inspectWorkspaceLocationWithSourceController,
    materializeWorkspaceCheckoutWithSourceController,
    realizeWorkspaceCheckoutWithSourceController,
    reconcilePostMaterializationWithSourceController,
    resolveWorkspaceReplicationSourceInputsWithSourceController,
    resolveWorkspaceTransferWithSourceController,
    resolveWorkspaceTransferMetadataWithSourceController,
    resolveWorkspaceTransferEntriesWithSourceController,
} from './sourceController';
import { createScmBackendRegistry } from './registry';

function createTestBackend(input: {
    id: 'git' | 'sapling';
    detectionRootPath: string;
    sourceController?: ScmBackend['sourceController'];
    detectRepo?: ScmBackend['detectRepo'];
}): ScmBackend {
    return {
        id: input.id,
        selection: {
            modeSelectionScores: {
                '.git': 200,
            },
        },
        sourceController: input.sourceController,
        detectRepo: input.detectRepo ?? (async () => ({
            isRepo: true,
            mode: '.git',
            rootPath: input.detectionRootPath,
        })),
        getCapabilities: () => ({
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
        worktreeCreate: async () => {
            throw new Error('not needed in this test');
        },
        worktreeRemove: async () => {
            throw new Error('not needed in this test');
        },
        worktreePrune: async () => {
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

describe('scm source controller', () => {
    it('surfaces backend-declared checkout discovery details without assuming the backend id', async () => {
        const registry = createScmBackendRegistry([
            createTestBackend({
                id: 'sapling',
                detectionRootPath: '/repo',
                sourceController: {
                    inspectWorkspaceLocation: async () => ({
                        rootPath: '/repo',
                        scmProvider: 'git',
                        checkoutDiscovery: [{ kind: 'git_worktree' }],
                    }),
                },
            }),
        ]);

        await expect(inspectWorkspaceLocationWithSourceController({
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
                sourceController: {
                    inspectWorkspaceLocation: async () => ({
                        rootPath: '/repo',
                        scmProvider: 'git',
                        checkoutProviderKinds: ['git_worktree'],
                    }),
                },
            }),
        ]);

        await expect(inspectWorkspaceLocationWithSourceController({
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
                sourceController: {
                    inspectWorkspaceLocation: async () => null,
                    reconcilePostMaterialization,
                },
            }),
        ]);

        await reconcilePostMaterializationWithSourceController({
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
                sourceController: {
                    inspectWorkspaceLocation: async () => null,
                    reconcilePostMaterialization,
                },
            }),
        ]);

        await reconcilePostMaterializationWithSourceController({
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

    it('passes a backend-agnostic workspace transfer request through the shared source-controller hook', async () => {
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
                sourceController: {
                    inspectWorkspaceLocation: async () => null,
                    resolveWorkspaceTransferEntries,
                },
            }),
        ]);

        await expect(resolveWorkspaceTransferEntriesWithSourceController({
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
                sourceController: {
                    inspectWorkspaceLocation: async () => null,
                    resolveWorkspaceTransfer,
                    resolveWorkspaceTransferEntries,
                    resolveWorkspaceTransferMetadata,
                },
            }),
        ]);

        await expect(resolveWorkspaceTransferEntriesWithSourceController({
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

        await expect(resolveWorkspaceTransferMetadataWithSourceController({
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

    it('surfaces a combined workspace transfer result through the shared source-controller seam', async () => {
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
                sourceController: {
                    inspectWorkspaceLocation: async () => null,
                    resolveWorkspaceTransfer,
                    isAdministrativeWorkspacePath: ({ relativePath }) => relativePath.startsWith('.git/'),
                },
            }),
        ]);

        await expect(resolveWorkspaceTransferWithSourceController({
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

    it('resolves replication-friendly source inputs through the shared source-controller seam', async () => {
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
                sourceController: {
                    inspectWorkspaceLocation: async () => null,
                    resolveWorkspaceTransfer,
                    isAdministrativeWorkspacePath: ({ relativePath }) => relativePath.startsWith('.git/'),
                },
            }),
        ]);

        await expect(resolveWorkspaceReplicationSourceInputsWithSourceController({
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
            sourceControllerMetadata: {
                branchName: 'main',
            },
            safeFilterPolicy: {
                excludeAdministrativePaths: false,
            },
            isNestedRepoSourcePath: true,
        });
    });

    it('falls back to filesystem entries when no SCM transfer owner resolves', async () => {
        const sourcePath = await mkdtemp(join(tmpdir(), 'happier-source-controller-fallback-'));
        const nestedDir = join(sourcePath, 'nested');

        try {
            await mkdir(nestedDir, { recursive: true });
            await writeFile(join(sourcePath, 'README.md'), 'hello\n', 'utf8');
            await writeFile(join(nestedDir, 'copy.md'), 'hello\n', 'utf8');

            await expect(resolveWorkspaceReplicationSourceInputsWithSourceController({
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
                sourceControllerMetadata: null,
                safeFilterPolicy: {
                    excludeAdministrativePaths: true,
                },
                isNestedRepoSourcePath: false,
            });
        } finally {
            await rm(sourcePath, { recursive: true, force: true });
        }
    });

    it('passes a backend-agnostic checkout materialization request through the shared source-controller hook', async () => {
        const materializeWorkspaceCheckout = vi.fn(async () => undefined);
        const registry = createScmBackendRegistry([
            createTestBackend({
                id: 'git',
                detectionRootPath: '/repo',
                sourceController: {
                    inspectWorkspaceLocation: async () => null,
                    materializeWorkspaceCheckout,
                },
            }),
        ]);

        await expect(materializeWorkspaceCheckoutWithSourceController({
            sourcePath: '/repo/packages/app',
            targetPath: '/repo/.worktrees/feature-auth',
            checkoutCreation: {
                kind: 'git_worktree',
                displayName: 'feature-auth',
                baseRef: null,
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
            },
        });
    });

    it('uses a backend-reported materialized target path when legacy materialization rebinds the checkout', async () => {
        const materializeWorkspaceCheckout = vi.fn(async () => ({
            targetPath: '/repo/.dev/worktree/feature-auth',
        }));
        const registry = createScmBackendRegistry([
            createTestBackend({
                id: 'git',
                detectionRootPath: '/repo',
                sourceController: {
                    inspectWorkspaceLocation: async () => null,
                    materializeWorkspaceCheckout,
                },
            }),
        ]);

        await expect(realizeWorkspaceCheckoutWithSourceController({
            sourcePath: '/repo/packages/app',
            targetPath: '/repo/.worktrees/feature-auth',
            checkoutCreation: {
                kind: 'git_worktree',
                displayName: 'feature-auth',
                baseRef: 'main',
            },
            registry,
        })).resolves.toEqual({
            kind: 'git_worktree',
            targetPath: '/repo/.dev/worktree/feature-auth',
        });
    });

    it('passes a backend-agnostic checkout creation request through the shared source-controller hook', async () => {
        const createWorkspaceCheckout = vi.fn(async () => ({
            kind: 'git_worktree' as const,
            targetPath: '/repo/.dev/worktree/feature-auth',
        }));
        const registry = createScmBackendRegistry([
            createTestBackend({
                id: 'git',
                detectionRootPath: '/repo',
                sourceController: {
                    inspectWorkspaceLocation: async () => null,
                    createWorkspaceCheckout,
                },
            }),
        ]);

        await expect(createWorkspaceCheckoutWithSourceController({
            sourcePath: '/repo/packages/app',
            checkoutCreation: {
                kind: 'git_worktree',
                displayName: 'feature-auth',
                baseRef: 'main',
            },
            registry,
        })).resolves.toEqual({
            kind: 'git_worktree',
            targetPath: '/repo/.dev/worktree/feature-auth',
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
            },
        });
    });

    it('prefers a backend-owned checkout realization hook for creation before legacy create hooks', async () => {
        const realizeWorkspaceCheckout = vi.fn(async () => ({
            kind: 'git_worktree' as const,
            targetPath: '/repo/.scm/feature-auth',
        }));
        const createWorkspaceCheckout = vi.fn(async () => ({
            kind: 'git_worktree' as const,
            targetPath: '/repo/.dev/worktree/feature-auth',
        }));
        const registry = createScmBackendRegistry([
            createTestBackend({
                id: 'git',
                detectionRootPath: '/repo',
                sourceController: {
                    inspectWorkspaceLocation: async () => null,
                    realizeWorkspaceCheckout,
                    createWorkspaceCheckout,
                },
            }),
        ]);

        await expect(createWorkspaceCheckoutWithSourceController({
            sourcePath: '/repo/packages/app',
            checkoutCreation: {
                kind: 'git_worktree',
                displayName: 'feature-auth',
                baseRef: 'main',
            },
            registry,
        })).resolves.toEqual({
            kind: 'git_worktree',
            targetPath: '/repo/.scm/feature-auth',
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
                targetPath: null,
            },
        });
        expect(createWorkspaceCheckout).not.toHaveBeenCalled();
    });

    it('prefers a backend-owned checkout realization hook for materialization before legacy materialize hooks', async () => {
        const realizeWorkspaceCheckout = vi.fn(async () => ({
            kind: 'git_worktree' as const,
            targetPath: '/repo/.scm/feature-auth',
        }));
        const materializeWorkspaceCheckout = vi.fn(async () => undefined);
        const registry = createScmBackendRegistry([
            createTestBackend({
                id: 'git',
                detectionRootPath: '/repo',
                sourceController: {
                    inspectWorkspaceLocation: async () => null,
                    realizeWorkspaceCheckout,
                    materializeWorkspaceCheckout,
                },
            }),
        ]);

        await expect(materializeWorkspaceCheckoutWithSourceController({
            sourcePath: '/repo/packages/app',
            targetPath: '/repo/.worktrees/feature-auth',
            checkoutCreation: {
                kind: 'git_worktree',
                displayName: 'feature-auth',
                baseRef: 'main',
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
                targetPath: '/repo/.worktrees/feature-auth',
            },
        });
        expect(materializeWorkspaceCheckout).not.toHaveBeenCalled();
    });

    it('runs portable workspace entry guards through the shared source-controller seam', async () => {
        const assertPortableWorkspaceEntries = vi.fn(async () => undefined);
        const registry = createScmBackendRegistry([
            createTestBackend({
                id: 'git',
                detectionRootPath: '/repo',
                sourceController: {
                    inspectWorkspaceLocation: async () => null,
                    assertPortableWorkspaceEntries,
                },
            }),
        ]);

        await assertPortableWorkspaceEntriesWithSourceController({
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
                sourceController: {
                    inspectWorkspaceLocation: async () => null,
                    classifyPortableWorkspacePath: ({ relativePath }) => relativePath.startsWith('.sl/store/')
                        ? 'non_portable'
                        : 'unknown',
                },
            }),
        ]);

        await expect(assertPortableWorkspaceEntriesWithSourceController({
            entries: [{ relativePath: '.sl/store/data' }],
            registry,
        })).rejects.toThrow('non-portable workspace path: .sl/store/data');
    });

    it('runs transfer-entry portability classification through the shared source-controller seam', async () => {
        const classifyPortableWorkspaceTransferEntry = vi.fn(({ sourcePath }: { sourcePath: string }) =>
            sourcePath.endsWith('/.backend/private') ? 'non_portable' : 'portable');
        const registry = createScmBackendRegistry([
            createTestBackend({
                id: 'sapling',
                detectionRootPath: '/repo',
                sourceController: {
                    inspectWorkspaceLocation: async () => null,
                    classifyPortableWorkspaceTransferEntry,
                },
            }),
        ]);

        await expect(assertPortableWorkspaceTransferEntriesWithSourceController({
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
                sourceController: {
                    inspectWorkspaceLocation: async () => null,
                    classifyPortableWorkspaceTransferEntry,
                    classifyPortableWorkspacePath,
                },
            }),
        ]);

        await expect(assertPortableWorkspaceTransferEntriesWithSourceController({
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

    it('surfaces transfer-entry path classification through the shared source-controller seam', () => {
        const classifyPortableWorkspaceTransferEntry = vi.fn(() => 'unknown' as const);
        const classifyPortableWorkspacePath = vi.fn(({ relativePath }: { relativePath: string }) => relativePath === '.backend/private'
            ? 'non_portable' as const
            : 'portable' as const);
        const registry = createScmBackendRegistry([
            createTestBackend({
                id: 'sapling',
                detectionRootPath: '/repo',
                sourceController: {
                    inspectWorkspaceLocation: async () => null,
                    classifyPortableWorkspaceTransferEntry,
                    classifyPortableWorkspacePath,
                },
            }),
        ]);

        expect(classifyPortableWorkspaceTransferEntryWithSourceController({
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

    it('matches backend-declared administrative workspace paths through the shared source-controller seam', async () => {
        const registry = createScmBackendRegistry([
            createTestBackend({
                id: 'sapling',
                detectionRootPath: '/repo',
                sourceController: {
                    inspectWorkspaceLocation: async () => null,
                    isAdministrativeWorkspacePath: ({ relativePath }) => relativePath.startsWith('.sl/'),
                },
            }),
        ]);

        expect(isAdministrativeWorkspacePathWithSourceController({
            relativePath: '.sl/store/data',
            registry,
        })).toBe(true);

        expect(isAdministrativeWorkspacePathWithSourceController({
            relativePath: 'README.md',
            registry,
        })).toBe(false);
    });

    it('surfaces backend-declared portable path classifications through the shared source-controller seam', async () => {
        const registry = createScmBackendRegistry([
            createTestBackend({
                id: 'sapling',
                detectionRootPath: '/repo',
                sourceController: {
                    inspectWorkspaceLocation: async () => null,
                    classifyPortableWorkspacePath: ({ relativePath }) => relativePath.startsWith('.sl/store/')
                        ? 'non_portable'
                        : relativePath.startsWith('.sl/')
                            ? 'portable'
                            : 'unknown',
                },
            }),
        ]);

        expect(classifyPortableWorkspacePathWithSourceController({
            relativePath: '.sl/store/data',
            registry,
        })).toBe('non_portable');

        expect(classifyPortableWorkspacePathWithSourceController({
            relativePath: '.sl/config',
            registry,
        })).toBe('portable');

        expect(classifyPortableWorkspacePathWithSourceController({
            relativePath: 'README.md',
            registry,
        })).toBe('unknown');
    });
});
