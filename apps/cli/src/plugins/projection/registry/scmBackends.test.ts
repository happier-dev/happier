import { describe, expect, it } from 'vitest';

import type { ScmBackendContribution } from '@happier-dev/protocol';

import { buildPluginContributionRegistry } from './normalize/package';
import { createResolvedContributionRegistry } from './createResolvedContributionRegistry';
import type { ResolvedContributionRegistry } from './types';

const sourceSpec = {
    kind: 'path' as const,
    locator: '/plugins/acme-scm-backend',
    trustPolicy: 'local_trusted' as const,
    installPolicy: 'link' as const,
};

function createGroupedCapabilities(): ScmBackendContribution['capabilities'] {
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
            diffFile: unsupported,
            diffCommit: unsupported,
            log: unsupported,
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
            discard: unsupported,
        },
        commit: {
            create: unsupported,
            pathSelection: unsupported,
            lineSelection: unsupported,
            backout: unsupported,
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
            list: unsupported,
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
            clone: unsupported,
            publish: unsupported,
            identityRediscovery: unsupported,
            removeIndexLock: unsupported,
        },
        hosting: {
            providerDetection: unsupported,
            repositoryPublishTargets: unsupported,
            repositoryPublish: unsupported,
            pullRequestRead: unsupported,
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
            checkoutMaterialization: unsupported,
            workspaceTransfer: unsupported,
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

function createScmBackendDefinition(id: string): ScmBackendContribution {
    return {
        id,
        displayName: 'Acme VCS',
        repoModes: ['.git'],
        detection: { rootMarkers: ['.acme'] },
        capabilities: createGroupedCapabilities(),
        installableDependencies: ['dep.acme-vcs'],
        tooling: {
            commands: [
                {
                    installableKey: 'dep.acme-vcs',
                    command: 'acme',
                },
            ],
            systemFirst: true,
            managedFallback: true,
        },
        safetyConstraints: {
            mutatesWorkingTree: true,
            requiresUserConfirmationForDestructiveWrites: true,
        },
    };
}

describe('SCM backend plugin contributions', () => {
    it('flattens non-agent backend descriptors with plugin contribution identity', () => {
        const registry = buildPluginContributionRegistry({
            loadedPlugins: [
                {
                    pluginId: 'acme.scm.backend',
                    pluginRootPath: '/plugins/acme-scm-backend',
                    manifestPath: '/plugins/acme-scm-backend/.happier-plugin/plugin.json',
                    manifestDigest: 'sha256:acme',
                    daemonEntryPath: '/plugins/acme-scm-backend/daemon.js',
                    sourceSpec,
                    devDaemonEntryPath: null,
                    manifest: {
                        schemaVersion: 2,
                        id: 'acme.scm.backend',
                        version: '1.0.0',
                        displayName: 'Acme SCM Backend',
                        engines: { happier: '^0.2.0' },
                        activationEvents: [],
                        uses: [],
                        entrypoints: { main: './daemon.js' },
                        permissions: [],
                        contributes: {
                            agents: [],
                            agentRuntimes: [],
                            actions: [],
                            tools: [],
                            commands: [],
                            resources: [],
                            uiDescriptors: [],
                            scmBackends: [createScmBackendDefinition('acme-vcs')],
                            hooks: [],
                            lifecycleHandlers: [],
                        },
                    },
                },
            ],
        });

        const scmBackends = (registry as unknown as {
            scmBackends?: readonly {
                definition: { id: string };
                identity?: {
                    pluginId: string;
                    family: string;
                    contributionId: string;
                    provenance: string;
                };
            }[];
        }).scmBackends;

        expect(scmBackends).toEqual([
            expect.objectContaining({
                definition: expect.objectContaining({ id: 'acme-vcs' }),
                identity: {
                    pluginId: 'acme.scm.backend',
                    family: 'scmBackends',
                    contributionId: 'acme-vcs',
                    provenance: 'external',
                },
            }),
        ]);
        expect(registry.agents).toEqual([]);
        expect(registry.agentRuntimes).toEqual([]);
    });

    it('keeps first-party backend ids active when an external plugin declares a duplicate id', () => {
        const registry = createResolvedContributionRegistry({
            agents: [],
            agentRuntimes: [],
            scmBackends: [
                {
                    id: 'git',
                    provenance: 'first_party',
                    source: { kind: 'bundled' },
                    pluginId: 'happier.scm.backend.git',
                    definition: createScmBackendDefinition('git'),
                },
                {
                    id: 'git',
                    provenance: 'external',
                    source: { kind: 'path' },
                    pluginId: 'acme.shadow',
                    manifestPath: '/plugins/acme-shadow/.happier-plugin/plugin.json',
                    manifestDigest: 'sha256:shadow',
                    daemonEntryPath: '/plugins/acme-shadow/daemon.js',
                    sourceSpec,
                    devDaemonEntryPath: null,
                    definition: createScmBackendDefinition('git'),
                },
            ],
        } as Parameters<typeof createResolvedContributionRegistry>[0] & {
            scmBackends: readonly unknown[];
        });

        const projected = registry as ResolvedContributionRegistry & {
            scmBackends?: readonly { id: string; pluginId?: string }[];
            scmBackendsById?: ReadonlyMap<string, { pluginId?: string }>;
        };

        expect(projected.scmBackendsById?.get('git')?.pluginId).toBe('happier.scm.backend.git');
        expect(projected.scmBackends).toHaveLength(1);
        expect(registry.pluginDiagnosticsByPluginId['acme.shadow']).toEqual([
            expect.objectContaining({
                code: 'scm_backend_duplicate',
                message: expect.stringContaining('acme.shadow:scmBackends:git'),
            }),
        ]);
    });
});
