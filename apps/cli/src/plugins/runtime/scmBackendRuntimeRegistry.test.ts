import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { ScmBackendContribution } from '@happier-dev/protocol';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import type { ResolvedContributionSourceKind } from '@/plugins/projection/registry/types';
import { createPluginScmBackendRegistryFromRuntimeRegistry } from '@/scm/scmBackendCatalog';

import { resolveExecutablePluginRuntimeRegistry } from './resolveExecutablePluginRuntimeRegistry';

const BACKEND_ID = 'acme-vcs';

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

function createScmBackendContribution(): ScmBackendContribution {
    return {
        id: BACKEND_ID,
        displayName: 'Acme VCS',
        repoModes: ['.git'],
        detection: { rootMarkers: ['.acme'] },
        capabilities: createGroupedCapabilities(),
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

async function writeScmBackendPlugin(params: Readonly<{
    pluginId: string;
    detectedRootPath: string;
    registerAction?: boolean;
}>): Promise<Readonly<{
    root: string;
    manifestPath: string;
    daemonEntryPath: string;
}>> {
    const root = await mkdtemp(join(tmpdir(), 'happier-plugin-scm-runtime-'));
    const manifestDir = join(root, '.happier-plugin');
    const manifestPath = join(manifestDir, 'plugin.json');
    const daemonEntryPath = join(root, 'daemon.mjs');
    await mkdir(manifestDir, { recursive: true });
    await writeFile(
        manifestPath,
        JSON.stringify({
            schemaVersion: 2,
            id: params.pluginId,
            version: '1.0.0',
            displayName: params.pluginId,
            description: `${params.pluginId} SCM backend`,
            engines: { happier: '^0.2.0' },
            runtime: {
                apiVersion: 1,
                capabilities: params.registerAction ? ['scmBackends', 'actions'] : ['scmBackends'],
            },
            capabilities: { permissions: params.registerAction ? [{ capability: 'actions.register' }] : [] },
            targets: {
                daemon: { entry: './daemon.mjs' },
            },
            contributes: {
                ...(params.registerAction ? {
                    actions: [
                        {
                            id: `${params.pluginId}.diagnostic`,
                            title: 'Diagnostic action',
                            scopes: ['global'],
                            surfaces: ['cli'],
                            placement: 'commandPalette',
                            dangerLevel: 'safe',
                            handler: {
                                target: 'daemon',
                                registrationId: `${params.pluginId}.diagnostic`,
                            },
                        },
                    ],
                } : {}),
                scmBackends: [createScmBackendContribution()],
            },
        }),
        'utf8',
    );
    await writeFile(
        daemonEntryPath,
        [
            'export async function activate(api) {',
            ...(params.registerAction ? [
                '  api.registerAction({',
                `    id: ${JSON.stringify(`${params.pluginId}.diagnostic`)},`,
                '    title: "Diagnostic action",',
                '    handler: async () => ({ ok: true }),',
                '  });',
            ] : []),
            '  api.registerScmBackend({',
            `    id: ${JSON.stringify(BACKEND_ID)},`,
            '    handlers: {',
            '      detection: {',
            `        detectRepo: async () => ({ isRepo: true, rootPath: ${JSON.stringify(params.detectedRootPath)}, mode: ".git" }),`,
            '      },',
            '      read: {',
            '        statusSnapshot: async () => ({ success: true }),',
            '      },',
            '    },',
            '  });',
            '}',
            '',
        ].join('\n'),
        'utf8',
    );

    return { root, manifestPath, daemonEntryPath };
}

describe('SCM backend runtime registry', () => {
    it('preserves static SCM backend definitions when activation adds runtime contributions', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-runtime-home-'));
        const pluginId = 'acme.scm.backend';
        const plugin = await writeScmBackendPlugin({
            pluginId,
            detectedRootPath: '/acme-root',
            registerAction: true,
        });
        const contributes = createResolvedContributionRegistry({
            providers: [],
            backends: [],
            actions: [
                {
                    provenance: 'external',
                    source: { kind: 'path' },
                    pluginId,
                    manifestPath: plugin.manifestPath,
                    manifestDigest: 'sha256:acme',
                    daemonEntryPath: plugin.daemonEntryPath,
                    sourceSpec: {
                        kind: 'path',
                        locator: plugin.root,
                        trustPolicy: 'local_trusted',
                        installPolicy: 'link',
                    },
                    definition: {
	                        kindVersion: 1,
	                        id: `${pluginId}.diagnostic`,
	                        title: 'Diagnostic action',
	                        description: null,
	                        safety: 'safe',
	                        placements: ['command_palette'],
	                        slash: null,
	                        bindings: null,
	                        examples: null,
	                        scopes: ['global'],
	                        surfaces: {
	                            ui: false,
	                            voice: false,
	                            cli: true,
	                            mcp: false,
	                            session_agent: false,
	                            rpc: false,
	                            sdk: false,
	                        },
	                        inputHints: null,
	                        inputSchema: {},
	                        placement: 'commandPalette',
	                    },
                },
            ],
	            activationTargets: [
	                {
	                    provenance: 'external',
                    source: { kind: 'path' },
                    pluginId,
                    manifestPath: plugin.manifestPath,
                    manifestDigest: 'sha256:acme',
                    daemonEntryPath: plugin.daemonEntryPath,
	                    sourceSpec: {
	                        kind: 'path',
	                        locator: plugin.root,
	                        trustPolicy: 'local_trusted',
	                        installPolicy: 'link',
	                    },
	                },
            ],
            scmBackends: [
                {
                    id: BACKEND_ID,
                    provenance: 'external',
                    source: { kind: 'path' },
                    pluginId,
                    manifestPath: plugin.manifestPath,
                    manifestDigest: 'sha256:acme',
                    daemonEntryPath: plugin.daemonEntryPath,
                    sourceSpec: {
                        kind: 'path',
                        locator: plugin.root,
                        trustPolicy: 'local_trusted',
                        installPolicy: 'link',
                    },
                    definition: createScmBackendContribution(),
                },
            ],
        });

        const runtimeRegistry = await resolveExecutablePluginRuntimeRegistry({
            happyHomeDir,
            contributes,
        });
        const scmRegistry = createPluginScmBackendRegistryFromRuntimeRegistry(runtimeRegistry);

        expect(runtimeRegistry.contributes.actions.map((action) => action.definition.id))
            .toContain(`${pluginId}.diagnostic`);
        expect(runtimeRegistry.contributes.scmBackends?.map((backend) => backend.pluginId)).toEqual([pluginId]);
        expect(runtimeRegistry.scmBackendRegistrations?.map((entry) => ({
            pluginId: entry.pluginId,
            id: entry.registration.id,
        }))).toEqual([{ pluginId, id: BACKEND_ID }]);
        expect(scmRegistry.diagnostics).toEqual([]);
        expect(scmRegistry.backends).toHaveLength(1);
        await expect(scmRegistry.backends[0]?.detectRepo({ cwd: '/workspace' })).resolves.toEqual({
            isRepo: true,
            rootPath: '/acme-root',
            mode: '.git',
        });
    });

    it('preserves the winning owner registration when a duplicate backend id activates first', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-runtime-home-'));
        const losingPluginId = 'aaa.losing.scm.backend';
        const winningPluginId = 'zzz.winning.scm.backend';
        const losing = await writeScmBackendPlugin({
            pluginId: losingPluginId,
            detectedRootPath: '/losing-root',
        });
        const winning = await writeScmBackendPlugin({
            pluginId: winningPluginId,
            detectedRootPath: '/winning-root',
        });

        const createRuntimeEntry = (params: Readonly<{
            pluginId: string;
            plugin: Awaited<ReturnType<typeof writeScmBackendPlugin>>;
            sourceKind: ResolvedContributionSourceKind;
            digest: string;
        }>) => ({
            id: BACKEND_ID,
            provenance: 'external' as const,
            source: { kind: params.sourceKind },
            pluginId: params.pluginId,
            manifestPath: params.plugin.manifestPath,
            manifestDigest: params.digest,
            daemonEntryPath: params.plugin.daemonEntryPath,
            sourceSpec: {
                kind: 'path' as const,
                locator: params.plugin.root,
                trustPolicy: 'local_trusted' as const,
                installPolicy: 'link' as const,
            },
            definition: createScmBackendContribution(),
        });
        const contributes = createResolvedContributionRegistry({
            providers: [],
            backends: [],
            activationTargets: [
                createRuntimeEntry({
                    pluginId: losingPluginId,
                    plugin: losing,
                    sourceKind: 'path',
                    digest: 'sha256:losing',
                }),
                createRuntimeEntry({
                    pluginId: winningPluginId,
                    plugin: winning,
                    sourceKind: 'archive',
                    digest: 'sha256:winning',
                }),
            ],
            scmBackends: [
                createRuntimeEntry({
                    pluginId: losingPluginId,
                    plugin: losing,
                    sourceKind: 'path',
                    digest: 'sha256:losing',
                }),
                createRuntimeEntry({
                    pluginId: winningPluginId,
                    plugin: winning,
                    sourceKind: 'archive',
                    digest: 'sha256:winning',
                }),
            ],
        });

        expect(contributes.scmBackends?.[0]?.pluginId).toBe(winningPluginId);

        const runtimeRegistry = await resolveExecutablePluginRuntimeRegistry({
            happyHomeDir,
            contributes,
        });
        const scmRegistry = createPluginScmBackendRegistryFromRuntimeRegistry(runtimeRegistry);

        expect(scmRegistry.backends).toHaveLength(1);
        await expect(scmRegistry.backends[0]?.detectRepo({ cwd: '/workspace' })).resolves.toEqual({
            isRepo: true,
            rootPath: '/winning-root',
            mode: '.git',
        });
        expect(runtimeRegistry.pluginDiagnosticsByPluginId[winningPluginId]?.map((diagnostic) => diagnostic.code))
            .not.toContain('plugin_scm_backend_missing_activation');
        expect(runtimeRegistry.pluginDiagnosticsByPluginId[losingPluginId]?.map((diagnostic) => diagnostic.code))
            .toEqual(expect.arrayContaining([
                'scm_backend_duplicate',
                'plugin_scm_backend_duplicate_id',
                'plugin_scm_backend_undeclared_id',
            ]));
    });
});
