import { describe, expect, it } from 'vitest';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';

import type {
    ScmBackendCapabilities,
    ScmWorktreesEnrichmentRequest,
} from '@happier-dev/protocol/scm';
import { createScmCapabilitiesFromBackendCapabilities } from '@happier-dev/protocol/scm';
import { derivePluginDaemonContributionRegistrationRights } from '@happier-dev/protocol/plugins/contributions/catalog';
import type {
    BackendRuntimeHandlerInput as ScmBackendRuntimeHandlerInput,
    BackendRuntimeRegistration as ScmBackendRuntimeRegistration,
} from '@happier-dev/plugin-sdk/scm/backend';
import { readCurrentBackendRuntimeServices as readCurrentScmBackendRuntimeServices } from '@happier-dev/plugin-sdk/scm/backend';
import { readCurrentHostingProviderRuntimeServices as readCurrentScmHostingProviderRuntimeServices } from '@happier-dev/plugin-sdk/scm/hosting';
import { createPluginRegistrationScope } from '@happier-dev/plugin-sdk/host/registration';
import { PLUGIN_MANIFEST as GIT_PLUGIN_MANIFEST } from '@happier-dev/plugins-scm-git';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { listDirectoryEntries } from '@/rpc/handlers/fileSystem/directoryListing/listDirectoryEntries';

import { createRegisteredScmBackendRegistry } from './registeredScmBackendRegistry';
import { createRegisteredScmBackendAdapter } from './registeredScmBackendAdapter';
import { createGitBackend, createGitScmBackendRuntimeRegistration } from '../../../../../packages/plugins/scm-git/src/backend';
import type { ScmBackend } from '../types';
import { createScmBackendRegistry } from '../registry';
import { createLocalScmRepositoryFixture, runScmExecutable } from '../contracts/scmBackendContractFixtures';

const TEST_LAST_ACTIVITY_AT_MS = Date.UTC(2026, 4, 13, 4, 0, 0);

function createCapabilities(input?: Readonly<{
    branchList?: 'supported' | 'unsupported';
    changeDiscard?: 'supported' | 'unsupported';
    commitBackout?: 'supported' | 'unsupported';
    commitCreate?: 'supported' | 'unsupported';
    commitPathSelection?: 'supported' | 'unsupported';
    diffCommit?: 'supported' | 'unsupported';
    log?: 'supported' | 'unsupported';
    workspaceCheckoutMaterialization?: 'supported' | 'unsupported';
    workspaceTransfer?: 'supported' | 'unsupported';
    lifecycleClone?: 'supported' | 'unsupported';
    pullRequestRead?: 'supported' | 'unsupported';
}>): ScmBackendCapabilities {
    const supported = { support: 'supported' } as const;
    const unsupported = { support: 'unsupported', reason: 'not_implemented' } as const;

    return {
        detection: {
            repository: supported,
            repoIdentity: unsupported,
            ignoredPath: unsupported,
            repoMode: supported,
            executable: supported,
        },
        read: {
            status: supported,
            diffFile: supported,
            diffCommit: input?.diffCommit === 'supported' ? supported : unsupported,
            log: input?.log === 'supported' ? supported : unsupported,
            branches: unsupported,
            stash: unsupported,
            defaultBranch: unsupported,
            hostingProvider: unsupported,
            pullRequestStatus: unsupported,
        },
        changeSet: {
            model: 'working-copy',
            diffAreas: ['pending'],
            include: unsupported,
            exclude: unsupported,
            discard: input?.changeDiscard === 'supported' ? supported : unsupported,
        },
        commit: {
            create: input?.commitCreate === 'supported' ? supported : unsupported,
            pathSelection: input?.commitPathSelection === 'supported' ? supported : unsupported,
            lineSelection: unsupported,
            backout: input?.commitBackout === 'supported' ? supported : unsupported,
        },
        remote: {
            read: unsupported,
            add: unsupported,
            setUrl: unsupported,
            remove: unsupported,
            fetch: unsupported,
            pull: unsupported,
            push: unsupported,
            publish: unsupported,
        },
        branch: {
            list: input?.branchList === 'supported' ? supported : unsupported,
            create: unsupported,
            checkout: unsupported,
            merge: unsupported,
            rebase: unsupported,
            operationControl: unsupported,
        },
        worktree: {
            create: unsupported,
            remove: unsupported,
            prune: unsupported,
            prepare: unsupported,
        },
        lifecycle: {
            init: unsupported,
            clone: input?.lifecycleClone === 'supported' ? supported : unsupported,
            publish: unsupported,
            identityRediscovery: unsupported,
            removeIndexLock: unsupported,
        },
        hosting: {
            providerDetection: unsupported,
            repositoryPublishTargets: unsupported,
            repositoryPublish: unsupported,
            pullRequestRead: input?.pullRequestRead === 'supported' ? supported : unsupported,
            pullRequestStatus: unsupported,
            pullRequestCreate: unsupported,
            pullRequestReuse: unsupported,
            pullRequestCheckout: unsupported,
            pullRequestPrepareWorktree: unsupported,
            pullRequestRunStacked: unsupported,
        },
        checkpoints: {
            capture: unsupported,
            aliasFinalize: unsupported,
            diff: unsupported,
            cleanup: unsupported,
            backup: unsupported,
            rollbackApply: unsupported,
        },
        workspaceIntegration: {
            inspectLocation: unsupported,
            checkoutMaterialization: input?.workspaceCheckoutMaterialization === 'supported' ? supported : unsupported,
            workspaceTransfer: input?.workspaceTransfer === 'supported' ? supported : unsupported,
            exportPortability: unsupported,
            portablePathClassification: unsupported,
        },
        tooling: {
            systemCliResolution: supported,
            managedCliResolution: supported,
            binarySafe: supported,
        },
        freshness: {
            observed: unsupported,
            expiry: unsupported,
        },
    };
}

function createDefinition(input?: Readonly<{
    capabilities?: ScmBackendCapabilities;
}>) {
    return {
        id: 'acme-vcs',
        displayName: 'Acme VCS',
        repoModes: ['.git'],
        detection: { rootMarkers: ['.acme'] },
        capabilities: input?.capabilities ?? createCapabilities(),
        installableDependencies: ['dep.acme-vcs'],
        tooling: {
            commands: [{ installableKey: 'dep.acme-vcs', command: 'acme' }],
            systemFirst: true,
            managedFallback: true,
        },
        safetyConstraints: {
            mutatesWorkingTree: true,
            requiresUserConfirmationForDestructiveWrites: true,
        },
    };
}

describe('registered SCM backend registry', () => {
    it('rejects advertised entry history when its typed batch producer is missing', () => {
        const capabilities = createCapabilities();
        capabilities.read.historyEntries = { support: 'supported' };
        const registration: ScmBackendRuntimeRegistration = {
            id: 'acme-vcs',
            handlers: {
                detection: { detectRepo: async () => ({ isRepo: true, rootPath: '/repo', mode: '.git' }) },
                read: {
                    statusSnapshot: async () => ({ success: true }),
                    diffFile: async () => ({ success: true, diff: '' }),
                },
            },
        };
        const resolved = createRegisteredScmBackendRegistry({
            definitions: [{ pluginId: 'acme.scm.backend', contributionId: 'acme-vcs', definition: createDefinition({ capabilities }) }],
            registrations: [{ pluginId: 'acme.scm.backend', registration }],
        });
        expect(resolved.backends).toEqual([]);
        expect(resolved.diagnostics).toEqual([expect.objectContaining({ code: 'plugin_scm_backend_activation_drift' })]);
        expect(resolved.diagnostics[0]?.message).toContain('read.historyEntries');
    });

    it.each(['amend', 'signOff'] as const)('rejects advertised commit %s without its handler producer', (leaf) => {
        const capabilities = createCapabilities();
        capabilities.commit[leaf] = { support: 'supported' };
        const registration: ScmBackendRuntimeRegistration = {
            id: 'acme-vcs',
            handlers: {
                detection: { detectRepo: async () => ({ isRepo: true, rootPath: '/repo', mode: '.git' }) },
                read: {
                    statusSnapshot: async () => ({ success: true }),
                    diffFile: async () => ({ success: true, diff: '' }),
                },
            },
        };
        const resolved = createRegisteredScmBackendRegistry({
            definitions: [{
                pluginId: 'acme.scm.backend', contributionId: 'acme-vcs',
                definition: createDefinition({ capabilities }),
            }],
            registrations: [{ pluginId: 'acme.scm.backend', registration }],
        });
        expect(resolved.backends).toEqual([]);
        expect(resolved.diagnostics).toEqual([
            expect.objectContaining({ code: 'plugin_scm_backend_activation_drift' }),
        ]);
        expect(resolved.diagnostics[0]?.message).toContain(`commit.${leaf}`);
    });

    it.each(['operationSkip', 'conflictResolution'] as const)('rejects advertised branch %s without its complete handler producer', (leaf) => {
        const capabilities = createCapabilities();
        capabilities.branch[leaf] = { support: 'supported' };
        const registration: ScmBackendRuntimeRegistration = {
            id: 'acme-vcs',
            handlers: {
                detection: { detectRepo: async () => ({ isRepo: true, rootPath: '/repo', mode: '.git' }) },
                read: {
                    statusSnapshot: async () => ({ success: true }),
                    diffFile: async () => ({ success: true, diff: '' }),
                },
                branch: {
                    // One conflict producer is insufficient: mark-resolved is
                    // independently reachable through the same advertised facet.
                    conflictAcceptSide: async () => ({ success: true }),
                },
            },
        };
        const resolved = createRegisteredScmBackendRegistry({
            definitions: [{
                pluginId: 'acme.scm.backend', contributionId: 'acme-vcs',
                definition: createDefinition({ capabilities }),
            }],
            registrations: [{ pluginId: 'acme.scm.backend', registration }],
        });
        expect(resolved.backends).toEqual([]);
        expect(resolved.diagnostics).toEqual([
            expect.objectContaining({ code: 'plugin_scm_backend_activation_drift' }),
        ]);
        expect(resolved.diagnostics[0]?.message).toContain(`branch.${leaf}`);
    });

    it.each(['.git', '.sl', null] as const)('keeps registered Git inspection and describe policy aligned for %s', async (mode) => {
        const registration = createGitScmBackendRuntimeRegistration();
        const adapter = createRegisteredScmBackendAdapter({
            definition: { id: 'git', kind: 'git' },
            qualifiedId: 'happier.scm.git/git',
            executableDefinition: registration.runtime!,
            registration,
        });
        const description = await adapter.describeBackend({
            context: { cwd: '/repo', projectKey: 'repo', detection: { isRepo: mode !== null, rootPath: '/repo', mode } },
            request: {},
        });
        expect(description.backendId).toBe('happier.scm.git/git');
        expect(description.capabilities).toEqual(adapter.getCapabilities({ mode }));
        expect(adapter.getCapabilities({ mode, executableAvailable: false }))
            .toEqual(createGitBackend().getCapabilities({ mode, executableAvailable: false }));
    });

    it('retains real Git commit publication, undo and ignore classification through public SDK registration', async () => {
        const manifest = normalizePluginManifestV2(GIT_PLUGIN_MANIFEST);
        const definition = manifest.contributes.scmBackends.find((entry) => entry.id === 'git');
        if (!definition) throw new Error('Git manifest must declare its backend');
        const scope = createPluginRegistrationScope({
            pluginId: manifest.id,
            target: { realm: 'daemon' },
            rights: derivePluginDaemonContributionRegistrationRights(manifest.contributes),
        });
        let fixture: ReturnType<typeof createLocalScmRepositoryFixture> | undefined;
        try {
            const authored = createGitScmBackendRuntimeRegistration();
            scope.api.scm.registerBackend(definition.id, {
                runtime: authored.runtime,
                handlers: authored.handlers,
            });
            const [captured] = scope.commit();
            if (captured?.family !== 'scmBackends') throw new Error('Expected captured Git backend registration');
            const resolved = createRegisteredScmBackendRegistry({
                definitions: [{ pluginId: manifest.id, contributionId: definition.id, definition }],
                registrations: [{ pluginId: manifest.id, registration: {
                    id: captured.localId,
                    ...captured.value,
                } }],
            });
            expect(resolved.diagnostics).toEqual([]);
            const backend = resolved.backends.find((entry) => entry.id === 'happier.scm.backend.git/git');
            if (!backend) throw new Error('Public SDK registration must admit the declared Git backend');
            if (!backend.commitResolveOutcome || !backend.commitUndoLast) {
                throw new Error('Registered Git must retain commit outcome resolution and undo');
            }
            fixture = createLocalScmRepositoryFixture({
                executable: 'git', repoMode: '.git', prefix: 'happier-scm-sdk-commit-contract-',
            });
            const listing = await listDirectoryEntries({
                directoryPath: fixture.rootPath,
                includeFiles: true,
                maxEntries: null,
                statConcurrency: 4,
                includeGitIgnore: true,
                scmRegistry: createScmBackendRegistry(resolved.backends),
            });
            expect(listing.gitIgnoreAvailable).toBe(true);
            const { ignoredPath, trackedPath } = fixture;
            expect(listing.entries.find((entry) => entry.name === ignoredPath))
                .toMatchObject({ type: 'file', gitIgnored: true });
            expect(listing.entries.find((entry) => entry.name === trackedPath))
                .toMatchObject({ type: 'file', gitIgnored: false });
            const context = {
                cwd: fixture.rootPath,
                projectKey: `${backend.id}:${fixture.rootPath}`,
                detection: await backend.detectRepo({ cwd: fixture.rootPath }),
            };
            if (!backend.commitCaptureTarget) throw new Error('Registered Git must retain its commit admission witness');
            const expectedRef = `refs/heads/${fixture.branchName}`;
            expect(await backend.commitCaptureTarget({ context })).toEqual({
                success: true,
                target: {
                    headOid: fixture.headCommit,
                    ref: expectedRef,
                    baseTreeOid: runScmExecutable(fixture.rootPath, 'git', ['rev-parse', 'HEAD^{tree}']),
                },
            });
            await writeFile(join(fixture.rootPath, fixture.trackedPath), 'registered commit change\n');
            const committed = await backend.commitCreate({ context, request: {
                message: 'registered publication', expectedHeadOid: fixture.headCommit, expectedRef,
                scope: { kind: 'all-pending' },
            } });
            expect(committed).toMatchObject({ success: true, publication: { state: 'published' } });
            if (!committed.commitSha) throw new Error('Registered Git must publish a commit object');
            expect(runScmExecutable(fixture.rootPath, 'git', ['rev-parse', 'HEAD'])).toBe(committed.commitSha);
            expect(await backend.commitResolveOutcome({ context, request: {
                candidateOid: committed.commitSha, expectedHeadOid: fixture.headCommit, expectedRef,
            } })).toMatchObject({
                success: true,
                publication: { state: 'published', candidateOid: committed.commitSha },
            });
            expect(await backend.commitUndoLast({ context, request: { expectedHeadOid: committed.commitSha } }))
                .toMatchObject({ success: true });
            expect(runScmExecutable(fixture.rootPath, 'git', ['rev-parse', 'HEAD'])).toBe(fixture.headCommit);
        } finally {
            await scope.dispose();
            if (fixture) await rm(fixture.rootPath, { recursive: true, force: true });
        }
    });

    it('activates a workspace-transfer backend that registers only the combined resolver', () => {
        const registration: ScmBackendRuntimeRegistration = {
            id: 'acme-vcs',
            handlers: {
                detection: {
                    detectRepo: async () => ({ isRepo: true, rootPath: '/repo', mode: '.git' }),
                },
                read: {
                    statusSnapshot: async () => ({ success: true }),
                    diffFile: async () => ({ success: true, diff: '' }),
                },
                workspaceIntegration: {
                    // The separate entries/metadata leaves are the compatibility
                    // fallback; a backend that only implements the atomic result
                    // still satisfies the advertised workspace-transfer leaf.
                    resolveWorkspaceTransfer: async () => ({ entries: [], metadata: { head: 'abc123' } }),
                },
            },
        };

        const resolved = createRegisteredScmBackendRegistry({
            definitions: [{
                pluginId: 'acme.scm.backend',
                contributionId: 'acme-vcs',
                definition: createDefinition({
                    capabilities: createCapabilities({ workspaceTransfer: 'supported' }),
                }),
            }],
            registrations: [{ pluginId: 'acme.scm.backend', registration }],
        });

        expect(resolved.diagnostics).toEqual([]);
        expect(resolved.backends.map((backend) => backend.id)).toEqual(['acme.scm.backend/acme-vcs']);
    });

    it('keeps same-local-id backends from distinct plugins independently selectable', () => {
        const registration: ScmBackendRuntimeRegistration = {
            id: 'acme-vcs',
            handlers: {
                detection: {
                    detectRepo: async () => ({ isRepo: true, rootPath: '/repo', mode: '.git' }),
                },
                read: {
                    statusSnapshot: async () => ({ success: true }),
                    diffFile: async () => ({ success: true, diff: '' }),
                },
            },
        };
        const resolved = createRegisteredScmBackendRegistry({
            definitions: ['one', 'two'].map((suffix) => ({
                pluginId: `acme.scm.${suffix}`,
                contributionId: 'acme-vcs',
                definition: createDefinition(),
            })),
            registrations: ['one', 'two'].map((suffix) => ({
                pluginId: `acme.scm.${suffix}`,
                registration,
            })),
        });

        expect(resolved.diagnostics).toEqual([]);
        expect(resolved.backends.map((backend) => backend.id)).toEqual([
            'acme.scm.one/acme-vcs',
            'acme.scm.two/acme-vcs',
        ]);
    });

    it('does not hand a backend an empty hosting-services capability when the host supplied none', async () => {
        let observedHostingServices: unknown = 'not-invoked';
        const registration: ScmBackendRuntimeRegistration = {
            id: 'acme-vcs',
            handlers: {
                detection: {
                    detectRepo: async () => {
                        observedHostingServices = readCurrentScmHostingProviderRuntimeServices();
                        return { isRepo: true, rootPath: '/repo', mode: '.git' };
                    },
                },
                read: {
                    statusSnapshot: async () => ({ success: true }),
                    diffFile: async () => ({ success: true, diff: '' }),
                },
            },
        };
        const resolved = createRegisteredScmBackendRegistry({
            definitions: [{
                pluginId: 'acme.scm.one',
                contributionId: 'acme-vcs',
                definition: createDefinition(),
            }],
            registrations: [{ pluginId: 'acme.scm.one', registration }],
        });

        expect(resolved.diagnostics).toEqual([]);
        await resolved.backends[0]!.detectRepo({ cwd: '/repo' });

        // `{}` is a valid `HostingProviderRuntimeServices`, so a fabricated one is indistinguishable
        // from a real host that offers nothing — and every hosting plugin reads an absent
        // `executeCommand` as "the CLI is not installed". A host that wired no services must be
        // visibly absent instead.
        expect(observedHostingServices).toBeNull();
    });

    it('projects the selected qualified backend identity through describe and status responses', async () => {
        const capabilities = createCapabilities();
        const registration: ScmBackendRuntimeRegistration = {
            id: 'acme-vcs',
            handlers: {
                detection: {
                    detectRepo: async () => ({ isRepo: true, rootPath: '/repo', mode: '.git' }),
                    describeBackend: async () => ({
                        success: true,
                        backendId: 'acme-vcs',
                        repoMode: '.git',
                        isRepo: true,
                    }),
                },
                read: {
                    statusSnapshot: async () => ({
                        success: true,
                        snapshot: {
                            projectKey: 'acme-vcs:/repo',
                            fetchedAt: 1,
                            repo: {
                                isRepo: true,
                                rootPath: '/repo',
                                backendId: 'acme-vcs',
                                mode: '.git',
                                worktrees: [],
                                remotes: [],
                            },
                            capabilities: createScmCapabilitiesFromBackendCapabilities(capabilities),
                            branch: {
                                head: 'main',
                                upstream: null,
                                ahead: 0,
                                behind: 0,
                                detached: false,
                            },
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
                        },
                    }),
                    diffFile: async () => ({ success: true, diff: '' }),
                },
            },
        };
        const resolved = createRegisteredScmBackendRegistry({
            definitions: [{
                pluginId: 'acme.scm.backend',
                contributionId: 'acme-vcs',
                definition: createDefinition({ capabilities }),
            }],
            registrations: [{
                pluginId: 'acme.scm.backend',
                registration,
            }],
        });
        const backend = resolved.backends[0];
        if (!backend) throw new Error('Expected registered backend');
        const context = {
            cwd: '/repo',
            projectKey: 'acme-vcs:/repo',
            detection: { isRepo: true, rootPath: '/repo', mode: '.git' as const },
        };

        await expect(backend.describeBackend({
            context,
            request: { cwd: '/repo' },
        })).resolves.toMatchObject({
            success: true,
            backendId: 'acme.scm.backend/acme-vcs',
        });
        await expect(backend.statusSnapshot({
            context,
            request: { cwd: '/repo' },
        })).resolves.toMatchObject({
            success: true,
            snapshot: {
                repo: { backendId: 'acme.scm.backend/acme-vcs' },
            },
        });
    });

    it('rejects a V2 declaration without executable runtime facts instead of indexing retired manifest fields', () => {
        const resolved = createRegisteredScmBackendRegistry({
            definitions: [{
                pluginId: 'acme.scm.backend',
                contributionId: 'acme-vcs',
                definition: {
                    id: 'acme-vcs',
                    title: 'Acme VCS',
                    kind: 'acme',
                    capabilities: ['detect'],
                },
            }],
            registrations: [{
                pluginId: 'acme.scm.backend',
                registration: {
                    id: 'acme-vcs',
                    handlers: {
                        detection: {
                            detectRepo: async () => ({ isRepo: false, rootPath: null, mode: null }),
                        },
                    },
                },
            }],
        });

        expect(resolved.backends).toEqual([]);
        expect(resolved.diagnostics).toEqual([
            expect.objectContaining({ code: 'plugin_scm_backend_activation_drift' }),
        ]);
    });

    it('rejects activation when an advertised executable read leaf has no handler', () => {
        const registration: ScmBackendRuntimeRegistration = {
            id: 'acme-vcs',
            handlers: {
                detection: {
                    detectRepo: async () => ({ isRepo: false, rootPath: null, mode: null }),
                },
                read: {
                    statusSnapshot: async () => ({ success: true }),
                },
            },
        };

        const resolved = createRegisteredScmBackendRegistry({
            definitions: [{
                pluginId: 'acme.scm.backend',
                contributionId: 'acme-vcs',
                definition: createDefinition(),
            }],
            registrations: [{
                pluginId: 'acme.scm.backend',
                registration,
            }],
        });

        expect(resolved.backends).toEqual([]);
        expect(resolved.diagnostics).toEqual([
            expect.objectContaining({
                code: 'plugin_scm_backend_activation_drift',
            }),
        ]);
        expect(resolved.diagnostics[0]?.message).toContain("Plugin 'acme.scm.backend'");
        expect(resolved.diagnostics[0]?.message).toContain("SCM backend 'acme-vcs'");
        expect(resolved.diagnostics[0]?.message).toContain('read.diffFile');
    });

    it.each(['create', 'safePlan', 'resolveOutcome'] as const)('rejects activation when advertised commit.%s lacks its required handler', (leaf) => {
        const registration: ScmBackendRuntimeRegistration = {
            id: 'acme-vcs',
            handlers: {
                detection: {
                    detectRepo: async () => ({ isRepo: false, rootPath: null, mode: null }),
                },
                read: {
                    statusSnapshot: async () => ({ success: true }),
                    diffFile: async () => ({
                        success: false,
                        errorCode: 'FEATURE_UNSUPPORTED',
                        error: 'not implemented',
                    }),
                },
                ...(leaf === 'create' ? {} : { commit: { create: async () => ({ success: true }) } }),
            },
        };

        const resolved = createRegisteredScmBackendRegistry({
            definitions: [{
                pluginId: 'acme.scm.backend',
                contributionId: 'acme-vcs',
                definition: createDefinition({
                    capabilities: { ...createCapabilities(), commit: { [leaf]: { support: 'supported' } } },
                }),
            }],
            registrations: [{
                pluginId: 'acme.scm.backend',
                registration,
            }],
        });

        expect(resolved.backends).toEqual([]);
        expect(resolved.diagnostics).toEqual([
            expect.objectContaining({
                code: 'plugin_scm_backend_activation_drift',
            }),
        ]);
        expect(resolved.diagnostics[0]?.message).toContain("Plugin 'acme.scm.backend'");
        expect(resolved.diagnostics[0]?.message).toContain("SCM backend 'acme-vcs'");
        expect(resolved.diagnostics[0]?.message).toContain(`commit.${leaf}`);
    });

    it('adapts advertised executable branch leaves through plugin handlers', async () => {
        const registration: ScmBackendRuntimeRegistration = {
            id: 'acme-vcs',
            handlers: {
                detection: {
                    detectRepo: async () => ({ isRepo: true, rootPath: '/repo', mode: '.git' }),
                },
                read: {
                    statusSnapshot: async () => ({ success: true }),
                    diffFile: async () => ({ success: true, diff: '' }),
                },
                branch: {
                    list: async () => ({
                        success: true,
                        branches: [{
                            name: 'main',
                            current: true,
                            remote: false,
                        }],
                    }),
                },
            },
        } as unknown as ScmBackendRuntimeRegistration;

        const resolved = createRegisteredScmBackendRegistry({
            definitions: [{
                pluginId: 'acme.scm.backend',
                contributionId: 'acme-vcs',
                definition: createDefinition({
                    capabilities: createCapabilities({ branchList: 'supported' }),
                }),
            }],
            registrations: [{
                pluginId: 'acme.scm.backend',
                registration,
            }],
        });

        expect(resolved.diagnostics).toEqual([]);
        expect(resolved.backends).toHaveLength(1);
        await expect(resolved.backends[0]?.branchList({
            context: {
                cwd: '/repo',
                projectKey: 'acme-vcs:/repo',
                detection: { isRepo: true, rootPath: '/repo', mode: '.git' },
            },
            request: { cwd: '/repo' },
        })).resolves.toEqual({
            success: true,
            branches: [{
                name: 'main',
                current: true,
                remote: false,
            }],
        });
    });

    it('adapts dedicated worktree enrichment through plugin read handlers', async () => {
        const registration = {
            id: 'acme-vcs',
            handlers: {
                detection: {
                    detectRepo: async () => ({ isRepo: true, rootPath: '/repo', mode: '.git' as const }),
                },
                read: {
                    statusSnapshot: async () => ({ success: true }),
                    diffFile: async () => ({ success: true, diff: '' }),
                    worktreesEnrichment: async ({ request }: ScmBackendRuntimeHandlerInput<ScmWorktreesEnrichmentRequest>) => ({
                        success: true,
                        worktrees: request.worktreePaths.map((path) => ({
                            path,
                            changeCount: 2,
                            lastActivityAt: TEST_LAST_ACTIVITY_AT_MS,
                        })),
                    }),
                },
            },
        };

        const resolved = createRegisteredScmBackendRegistry({
            definitions: [{
                pluginId: 'acme.scm.backend',
                contributionId: 'acme-vcs',
                definition: createDefinition(),
            }],
            registrations: [{
                pluginId: 'acme.scm.backend',
                registration,
            }],
        });

        expect(resolved.diagnostics).toEqual([]);
        const backend = resolved.backends[0];
        if (!backend) throw new Error('Expected registered backend');
        expect(typeof backend.worktreesEnrichment).toBe('function');
        if (!backend.worktreesEnrichment) throw new Error('Expected worktree enrichment handler');

        await expect(backend.worktreesEnrichment({
            context: {
                cwd: '/repo',
                projectKey: 'acme-vcs:/repo',
                detection: { isRepo: true, rootPath: '/repo', mode: '.git' },
            },
            request: {
                cwd: '/repo',
                worktreePaths: ['/repo/feature'],
            },
        })).resolves.toEqual({
            success: true,
            worktrees: [{
                path: '/repo/feature',
                changeCount: 2,
                lastActivityAt: TEST_LAST_ACTIVITY_AT_MS,
            }],
        });
    });

    it('adapts deliberately limited Sapling-style supported leaves through plugin handlers', async () => {
        const registration = {
            id: 'acme-vcs',
            handlers: {
                detection: {
                    detectRepo: async () => ({ isRepo: true, rootPath: '/repo', mode: '.git' }),
                },
                read: {
                    statusSnapshot: async () => ({ success: true }),
                    diffFile: async () => ({ success: true, diff: 'file diff' }),
                    diffCommit: async () => ({ success: true, diff: 'commit diff' }),
                    logList: async () => ({
                        success: true,
                        entries: [{
                            sha: 'abc123',
                            shortSha: 'abc123',
                            authorName: 'A',
                            authorEmail: 'a@example.com',
                            timestamp: 1,
                            subject: 'subject',
                            body: '',
                        }],
                    }),
                },
                changeSet: {
                    discard: async () => ({ success: true }),
                },
                commit: {
                    create: async () => ({ success: true, commitSha: 'def456' }),
                    backout: async () => ({ success: true, stdout: '', stderr: '' }),
                },
            },
        } as unknown as ScmBackendRuntimeRegistration;

        const resolved = createRegisteredScmBackendRegistry({
            definitions: [{
                pluginId: 'acme.scm.backend',
                contributionId: 'acme-vcs',
                definition: createDefinition({
                    capabilities: createCapabilities({
                        changeDiscard: 'supported',
                        commitBackout: 'supported',
                        commitCreate: 'supported',
                        commitPathSelection: 'supported',
                        diffCommit: 'supported',
                        log: 'supported',
                    }),
                }),
            }],
            registrations: [{
                pluginId: 'acme.scm.backend',
                registration,
            }],
        });

        expect(resolved.diagnostics).toEqual([]);
        expect(resolved.backends).toHaveLength(1);
        const backend = resolved.backends[0];
        if (!backend) throw new Error('Expected registered backend');
        const context = {
            cwd: '/repo',
            projectKey: 'acme-vcs:/repo',
            detection: { isRepo: true, rootPath: '/repo', mode: '.git' as const },
        };

        await expect(backend.diffCommit({
            context,
            request: { cwd: '/repo', commit: 'abc123' },
        })).resolves.toEqual({ success: true, diff: 'commit diff' });
        await expect(backend.logList({
            context,
            request: { cwd: '/repo', limit: 1 },
        })).resolves.toEqual(expect.objectContaining({ success: true }));
        await expect(backend.changeDiscard({
            context,
            request: { cwd: '/repo', entries: [{ path: 'a.txt', kind: 'modified' }] },
        })).resolves.toEqual({ success: true });
        await expect(backend.commitCreate({
            context,
            request: { cwd: '/repo', message: 'commit' },
        })).resolves.toEqual({ success: true, commitSha: 'def456' });
        await expect(backend.commitBackout({
            context,
            request: { cwd: '/repo', commit: 'abc123' },
        })).resolves.toEqual({ success: true, stdout: '', stderr: '' });
    });

    it('adapts workspace integration leaves through plugin handlers', async () => {
        let prepareReviewWorkspaceSignal: AbortSignal | null = null;
        let verifyPreparedReviewWorkspaceSignal: AbortSignal | null = null;
        const registration: ScmBackendRuntimeRegistration = {
            id: 'acme-vcs',
            handlers: {
                detection: {
                    detectRepo: async () => ({ isRepo: true, rootPath: '/repo', mode: '.git' }),
                },
                read: {
                    statusSnapshot: async () => ({ success: true }),
                    diffFile: async () => ({ success: true, diff: '' }),
                },
                workspaceIntegration: {
                    prepareReviewWorkspace: async ({ signal }) => {
                        prepareReviewWorkspaceSignal = signal;
                        return {
                            success: true,
                            targetPath: '/repo/.dev/worktree/feature',
                            branchName: 'feature',
                            created: true,
                            currentness: { kind: 'currentAtObservedHead' },
                        };
                    },
                    verifyPreparedReviewWorkspace: async ({ request, signal }) => {
                        verifyPreparedReviewWorkspaceSignal = signal;
                        return {
                            success: true,
                            verification: {
                                targetPath: request.verification!.targetPath,
                                sourceHeadSha: request.sourceTip.sourceHeadSha,
                            },
                        };
                    },
                    inspectWorkspaceLocation: async () => ({
                        rootPath: '/repo',
                        scmProvider: 'git',
                        committedRevision: '0123456789abcdef0123456789abcdef01234567',
                        checkoutProviderKinds: ['git_worktree'],
                    }),
                    realizeWorkspaceCheckout: async ({ workspaceCheckoutRealization }) => ({
                        kind: workspaceCheckoutRealization.kind,
                        targetPath: workspaceCheckoutRealization.targetPath ?? '/repo/.dev/worktree/feature',
                        branchName: 'feature',
                        created: true,
                    }),
                    materializeWorkspaceCheckout: async ({ workspaceCheckoutMaterialization }) => ({
                        targetPath: workspaceCheckoutMaterialization.targetPath,
                        branchName: 'feature',
                        created: true,
                    }),
                    createWorkspaceCheckout: async ({ workspaceCheckoutCreation }) => ({
                        kind: workspaceCheckoutCreation.kind,
                        targetPath: '/repo/.dev/worktree/feature',
                        branchName: 'feature',
                        created: true,
                    }),
                    resolveWorkspaceTransferEntries: async () => [{
                        relativePath: '.git/HEAD',
                        sourcePath: '/repo/.git/HEAD',
                    }],
                    resolveWorkspaceTransferMetadata: async () => ({ head: 'abc123' }),
                    assertPortableWorkspaceEntries: async () => undefined,
                    classifyPortableWorkspaceTransferEntry: () => 'scm_administrative',
                    isAdministrativeWorkspacePath: () => true,
                    classifyPortableWorkspacePath: () => 'scm_administrative',
                },
            },
        };

        const resolved = createRegisteredScmBackendRegistry({
            definitions: [{
                pluginId: 'acme.scm.backend',
                contributionId: 'acme-vcs',
                definition: createDefinition({
                    capabilities: createCapabilities({ workspaceCheckoutMaterialization: 'supported' }),
                }),
            }],
            registrations: [{
                pluginId: 'acme.scm.backend',
                registration,
            }],
        });

        expect(resolved.diagnostics).toEqual([]);
        const backend = resolved.backends[0];
        if (!backend) throw new Error('Expected registered backend');
        const context = {
            cwd: '/repo',
            projectKey: 'acme-vcs:/repo',
            detection: { isRepo: true, rootPath: '/repo', mode: '.git' as const },
        };
        const operationController = new AbortController();
        const operationContext = { ...context, signal: operationController.signal };

        await expect(backend.workspaceIntegration?.prepareReviewWorkspace?.({
            context: operationContext,
            request: {
                cwd: '/repo',
                displayName: 'feature',
                sourceTip: {
                    repository: {
                        kind: 'github',
                        deployment: 'https://github.com',
                        repository: 'acme/repository',
                    },
                    cloneUrl: 'https://github.com/acme/repository.git',
                    branch: 'feature',
                    sourceHeadSha: '0123456789abcdef0123456789abcdef01234567',
                    fetchRef: 'refs/heads/feature',
                },
            },
        })).resolves.toEqual(expect.objectContaining({ success: true }));
        expect(prepareReviewWorkspaceSignal).toBe(operationController.signal);

        await expect(backend.workspaceIntegration?.verifyPreparedReviewWorkspace?.({
            context: operationContext,
            request: {
                cwd: '/repo',
                displayName: 'feature',
                sourceTip: {
                    repository: {
                        kind: 'github',
                        deployment: 'https://github.com',
                        repository: 'acme/repository',
                    },
                    cloneUrl: 'https://github.com/acme/repository.git',
                    branch: 'feature',
                    sourceHeadSha: '0123456789abcdef0123456789abcdef01234567',
                    fetchRef: 'refs/heads/feature',
                },
                verification: { targetPath: '/repo/.dev/worktree/feature' },
            },
        })).resolves.toEqual({
            success: true,
            verification: {
                targetPath: '/repo/.dev/worktree/feature',
                sourceHeadSha: '0123456789abcdef0123456789abcdef01234567',
            },
        });
        expect(verifyPreparedReviewWorkspaceSignal).toBe(operationController.signal);

        await expect(backend.workspaceIntegration?.inspectWorkspaceLocation?.({ context })).resolves.toEqual({
            rootPath: '/repo',
            scmProvider: 'git',
            committedRevision: '0123456789abcdef0123456789abcdef01234567',
            checkoutProviderKinds: ['git_worktree'],
        });
        await expect(backend.workspaceIntegration?.realizeWorkspaceCheckout?.({
            context,
            workspaceCheckoutRealization: {
                kind: 'git_worktree',
                sourcePath: '/repo',
                displayName: 'feature',
                baseRef: 'main',
                branchMode: 'new',
                targetPath: null,
            },
        })).resolves.toEqual({
            kind: 'git_worktree',
            targetPath: '/repo/.dev/worktree/feature',
            branchName: 'feature',
            created: true,
        });
        await expect(backend.workspaceIntegration?.classifyPortableWorkspacePath?.({
            relativePath: '.git/HEAD',
        })).toBe('non_portable');
        expect(backend.workspaceIntegration?.classifyPortableWorkspaceTransferEntry?.({
            relativePath: '.git/HEAD',
            sourcePath: '/repo/.git/HEAD',
        })).toBe('non_portable');
    });

    it('rejects plugin command execution when the installable key does not own the requested SCM command', async () => {
        const registration: ScmBackendRuntimeRegistration = {
            id: 'acme-vcs',
            handlers: {
                detection: {
                    detectRepo: async () => ({ isRepo: true, rootPath: '/repo', mode: '.git' }),
                },
                read: {
                    statusSnapshot: async () => {
                        const services = readCurrentScmBackendRuntimeServices();
                        if (!services) throw new Error('Expected SCM backend runtime services');
                        const result = await services.runCommand({
                            installableKey: 'dep.acme-vcs',
                            command: 'git',
                            cwd: '/repo',
                            args: ['--version'],
                        });
                        return {
                            success: false,
                            errorCode: 'FEATURE_UNSUPPORTED',
                            error: result.stderr,
                        };
                    },
                    diffFile: async () => ({ success: true, diff: '' }),
                },
            },
        };

        const resolved = createRegisteredScmBackendRegistry({
            definitions: [{
                pluginId: 'acme.scm.backend',
                contributionId: 'acme-vcs',
                definition: createDefinition(),
            }],
            registrations: [{
                pluginId: 'acme.scm.backend',
                registration,
            }],
        });

        expect(resolved.diagnostics).toEqual([]);
        const backend = resolved.backends[0];
        if (!backend) throw new Error('Expected registered backend');

        await expect(backend.statusSnapshot({
            context: {
                cwd: '/repo',
                projectKey: 'acme-vcs:/repo',
                detection: { isRepo: true, rootPath: '/repo', mode: '.git' },
            },
            request: { cwd: '/repo' },
        })).resolves.toEqual(expect.objectContaining({
            success: false,
            error: expect.stringContaining("does not authorize SCM command 'git'"),
        }));
    });

    it('allows declared third-party SCM backend commands through the host runtime command seam', async () => {
        const binDir = mkdtempSync(join(tmpdir(), 'happier-acme-scm-bin-'));
        const acmeBin = join(binDir, 'acme');
        await writeFile(acmeBin, '#!/bin/sh\nprintf "acme-ok\\n"\n', 'utf8');
        await chmod(acmeBin, 0o755);

        const registration: ScmBackendRuntimeRegistration = {
            id: 'acme-vcs',
            handlers: {
                detection: {
                    detectRepo: async () => ({ isRepo: true, rootPath: '/repo', mode: '.git' }),
                },
                read: {
                    statusSnapshot: async () => {
                        const services = readCurrentScmBackendRuntimeServices();
                        if (!services) throw new Error('Expected SCM backend runtime services');
                        const result = await services.runCommand({
                            installableKey: 'dep.acme-vcs',
                            command: 'acme',
                            cwd: binDir,
                            args: [],
                            env: { PATH: binDir },
                        });
                        return result.success
                            ? { success: true, snapshot: undefined, diagnostics: [result.stdout.trim()] }
                            : { success: false, errorCode: 'FEATURE_UNSUPPORTED', error: result.stderr };
                    },
                    diffFile: async () => ({ success: true, diff: '' }),
                },
            },
        };

        const resolved = createRegisteredScmBackendRegistry({
            definitions: [{
                pluginId: 'acme.scm.backend',
                contributionId: 'acme-vcs',
                definition: createDefinition(),
            }],
            registrations: [{
                pluginId: 'acme.scm.backend',
                registration,
            }],
        });

        expect(resolved.diagnostics).toEqual([]);
        const backend = resolved.backends[0];
        if (!backend) throw new Error('Expected registered backend');

        await expect(backend.statusSnapshot({
            context: {
                cwd: binDir,
                projectKey: 'acme-vcs:/repo',
                detection: { isRepo: true, rootPath: binDir, mode: '.git' },
            },
            request: { cwd: binDir },
        })).resolves.toEqual(expect.objectContaining({
            success: true,
            diagnostics: ['acme-ok'],
        }));
    });

    it('rejects activation when lifecycle clone is advertised without a clone handler', () => {
        const registration: ScmBackendRuntimeRegistration = {
            id: 'acme-vcs',
            handlers: {
                detection: {
                    detectRepo: async () => ({ isRepo: true, rootPath: '/repo', mode: '.git' }),
                },
                read: {
                    statusSnapshot: async () => ({ success: true }),
                    diffFile: async () => ({ success: true, diff: '' }),
                },
            },
        };

        const resolved = createRegisteredScmBackendRegistry({
            definitions: [{
                pluginId: 'acme.scm.backend',
                contributionId: 'acme-vcs',
                definition: createDefinition({
                    capabilities: createCapabilities({ lifecycleClone: 'supported' }),
                }),
            }],
            registrations: [{
                pluginId: 'acme.scm.backend',
                registration,
            }],
        });

        expect(resolved.backends).toEqual([]);
        expect(resolved.diagnostics).toEqual([
            expect.objectContaining({
                code: 'plugin_scm_backend_activation_drift',
                message: expect.stringContaining('lifecycle.clone'),
            }),
        ]);
    });

    it('rejects activation when pull request read is advertised without read handlers', () => {
        const registration: ScmBackendRuntimeRegistration = {
            id: 'acme-vcs',
            handlers: {
                detection: {
                    detectRepo: async () => ({ isRepo: true, rootPath: '/repo', mode: '.git' }),
                },
                read: {
                    statusSnapshot: async () => ({ success: true }),
                    diffFile: async () => ({ success: true, diff: '' }),
                },
            },
        };

        const resolved = createRegisteredScmBackendRegistry({
            definitions: [{
                pluginId: 'acme.scm.backend',
                contributionId: 'acme-vcs',
                definition: createDefinition({
                    capabilities: createCapabilities({ pullRequestRead: 'supported' }),
                }),
            }],
            registrations: [{
                pluginId: 'acme.scm.backend',
                registration,
            }],
        });

        expect(resolved.backends).toEqual([]);
        expect(resolved.diagnostics).toEqual([
            expect.objectContaining({
                code: 'plugin_scm_backend_activation_drift',
                message: expect.stringContaining('hosting.pullRequestRead'),
            }),
        ]);
    });

    it('reports undeclared activation with plugin owner and contribution id', () => {
        const registration: ScmBackendRuntimeRegistration = {
            id: 'acme-missing',
            handlers: {
                detection: {
                    detectRepo: async () => ({ isRepo: false, rootPath: null, mode: null }),
                },
            },
        };

        const resolved = createRegisteredScmBackendRegistry({
            definitions: [{
                pluginId: 'acme.scm.backend',
                contributionId: 'acme-vcs',
                definition: createDefinition(),
            }],
            registrations: [{
                pluginId: 'acme.scm.backend',
                registration,
            }],
        });

        expect(resolved.diagnostics).toEqual([
            expect.objectContaining({
                code: 'plugin_scm_backend_missing_activation',
            }),
            expect.objectContaining({
                code: 'plugin_scm_backend_undeclared_id',
            }),
        ]);
        expect(resolved.diagnostics[0]?.message).toContain("Plugin 'acme.scm.backend'");
        expect(resolved.diagnostics[0]?.message).toContain("SCM backend 'acme-vcs'");
        expect(resolved.diagnostics[1]?.message).toContain("Plugin 'acme.scm.backend'");
        expect(resolved.diagnostics[1]?.message).toContain("SCM backend 'acme-missing'");
    });

    it('does not satisfy one plugin owner manifest with another plugin owner activation using the same backend id', () => {
        const registration: ScmBackendRuntimeRegistration = {
            id: 'acme-vcs',
            handlers: {
                detection: {
                    detectRepo: async () => ({ isRepo: true, rootPath: '/repo', mode: '.git' }),
                },
                read: {
                    statusSnapshot: async () => ({ success: true }),
                    diffFile: async () => ({ success: true, diff: '' }),
                },
            },
        };

        const resolved = createRegisteredScmBackendRegistry({
            definitions: [{
                pluginId: 'acme.scm.backend',
                contributionId: 'acme-vcs',
                definition: createDefinition(),
            }],
            registrations: [{
                pluginId: 'contoso.scm.backend',
                registration,
            }],
        });

        expect(resolved.backends).toEqual([]);
        expect(resolved.diagnostics).toEqual([
            expect.objectContaining({
                code: 'plugin_scm_backend_missing_activation',
            }),
            expect.objectContaining({
                code: 'plugin_scm_backend_undeclared_id',
            }),
        ]);
        expect(resolved.diagnostics[0]?.message).toContain("Plugin 'acme.scm.backend'");
        expect(resolved.diagnostics[0]?.message).toContain("SCM backend 'acme-vcs'");
        expect(resolved.diagnostics[1]?.message).toContain("Plugin 'contoso.scm.backend'");
        expect(resolved.diagnostics[1]?.message).toContain("SCM backend 'acme-vcs'");
    });
});
