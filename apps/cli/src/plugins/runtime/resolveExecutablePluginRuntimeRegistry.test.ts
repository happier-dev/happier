import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ScmBackendContribution } from '@happier-dev/protocol';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { executePluginActionIfAvailable } from '@/plugins/projection/actions/execute';
import { resolveBuiltInContributions } from '@/plugins/projection/registry/resolveBuiltInContributions';
import type { ResolvedHookRegistration } from '@/plugins/projection/registry/types';
import { writePluginReloadStateSnapshot } from '@/plugins/runtime/reload/state';
import { createPluginStateStore } from '@/plugins/store/state';
import { listBuiltInHappierTools } from '@/agent/tools/happierTools/listBuiltInHappierTools';
import { dispatchPluginHookEvent } from '@/plugins/runtime/hooks/execution/dispatchPluginHookEvent';

import { resolveExecutablePluginRuntimeRegistry } from './resolveExecutablePluginRuntimeRegistry';

const {
    axiosPostMock,
    readCredentialsMock,
    readSettingsMock,
    readInstallationIdentityIfExistsSyncMock,
} = vi.hoisted(() => ({
    axiosPostMock: vi.fn<(...args: unknown[]) => unknown>(),
    readCredentialsMock: vi.fn<(...args: unknown[]) => unknown>(),
    readSettingsMock: vi.fn<(...args: unknown[]) => unknown>(),
    readInstallationIdentityIfExistsSyncMock: vi.fn<(...args: unknown[]) => unknown>(),
}));

vi.mock('axios', () => ({
    default: {
        post: axiosPostMock,
    },
}));

vi.mock('@/persistence', () => ({
    readCredentials: readCredentialsMock,
    readSettings: readSettingsMock,
}));

vi.mock('@/daemon/identity/store', () => ({
    readInstallationIdentityIfExistsSync: readInstallationIdentityIfExistsSyncMock,
}));

async function writePlugin(
    rootDir: string,
    manifest: Record<string, unknown>,
    daemonSource: string,
    daemonBasename = 'daemon.mjs',
): Promise<void> {
    const manifestDir = join(rootDir, '.happier-plugin');
    await mkdir(manifestDir, { recursive: true });
    await writeFile(join(rootDir, daemonBasename), daemonSource, 'utf8');
    await writeFile(
        join(manifestDir, 'plugin.json'),
        JSON.stringify(
            {
                schemaVersion: 2,
                id: 'acme.runtime',
                version: '1.0.0',
                displayName: 'Acme Runtime',
                description: 'Runtime hook plugin',
                engines: {
                    happier: '^0.2.0',
                },
                uses: ['agents', 'hooks'],
                entrypoints: {
                    main: `./${daemonBasename}`,
                },
                permissions: { required: [], optional: [] },
                contributes: {
                    agents: [{
                        kindVersion: 1,
                        id: 'acme.runtime',
                        runtime: {
                            kind: 'custom',
                        },
                        catalogAgentId: 'claude',
                        display: {
                            name: 'Acme Runtime',
                            tags: ['plugin'],
                        },
                        ownedBackendIds: ['acme.runtime'],
                        capabilities: {},
                        surfaceHandlers: [
                            {
                                surfaceApiVersion: 1,
                                id: 'backend.terminalRuntime.launch',
                                kind: 'terminalRuntime',
                                operation: 'launch',
                                handler: {
                                    target: 'daemon',
                                    exportName: 'launch',
                                },
                            },
                        ],
                    }],
                    hooks: [{
                        hookApiVersion: 1,
                        id: 'agent.resolvePrerequisites',
                        category: 'decision',
                        scope: 'agent',
                        executionKind: 'decide',
                        handler: {
                            target: 'plugin',
                        },
                    }],
                },
                ...manifest,
            },
            null,
            2,
        ),
        'utf8',
    );
}

function createRuntimeHookRegistration(params: Readonly<{
    pluginId: string;
    daemonEntryPath: string;
    exportName: string;
    backendIdFilter?: string;
}>): ResolvedHookRegistration {
    return {
        provenance: 'external',
        source: { kind: 'path' },
        pluginId: params.pluginId,
        manifestPath: `/plugins/${params.pluginId}/.happier-plugin/plugin.json`,
        manifestDigest: `sha256:${params.pluginId}`,
        daemonEntryPath: params.daemonEntryPath,
        sourceSpec: {
            kind: 'path',
            locator: `/plugins/${params.pluginId}`,
            trustPolicy: 'local_trusted',
            installPolicy: 'link',
        },
        definition: {
            hookApiVersion: 1,
            id: 'agent.resolvePrerequisites',
            category: 'decision',
            scope: 'agent',
            executionKind: 'decide',
            ...(params.backendIdFilter ? { filters: { backendId: params.backendIdFilter } } : {}),
            handler: {
                target: 'plugin',
                exportName: params.exportName,
            },
        },
    };
}

async function writeActivationManifest(
    rootDir: string,
    params: Readonly<{
        id: string;
        runtimeCapabilities: readonly string[];
        permissions: readonly string[];
        optionalPermissions?: readonly Record<string, unknown>[];
        contributes?: Record<string, unknown>;
    }>,
): Promise<string> {
    const manifestDir = join(rootDir, '.happier-plugin');
    await mkdir(manifestDir, { recursive: true });
    const manifestPath = join(manifestDir, 'plugin.json');
    await writeFile(
        manifestPath,
        JSON.stringify({
            schemaVersion: 2,
            id: params.id,
            version: '1.0.0',
            displayName: params.id,
            description: `${params.id} activation manifest`,
            engines: {
                happier: '^0.2.0',
            },
            uses: params.runtimeCapabilities,
            entrypoints: {
                main: './daemon.mjs',
            },
            permissions: {
                required: params.permissions.map((capability) => ({ capability })),
                optional: params.optionalPermissions ?? [],
            },
            contributes: params.contributes ?? {},
        }),
        'utf8',
    );
    return manifestPath;
}

function createScmBackendContribution(id: string): ScmBackendContribution {
    const supported = { support: 'supported' } as const;
    const unsupported = { support: 'unsupported', reason: 'not_implemented' } as const;
    return {
        id,
        displayName: 'Acme VCS',
        repoModes: ['.git'],
        detection: {
            rootMarkers: ['.acme'],
        },
        capabilities: {
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
        },
        installableDependencies: ['dep.acme-vcs'],
        tooling: {
            commands: [{ installableKey: 'dep.acme-vcs', command: 'acme' }],
            systemFirst: true,
            managedFallback: true,
        },
        safetyConstraints: {
            mutatesWorkingTree: false,
            requiresUserConfirmationForDestructiveWrites: false,
        },
    };
}

describe('resolveExecutablePluginRuntimeRegistry', () => {
    beforeEach(() => {
        axiosPostMock.mockReset();
        readCredentialsMock.mockReset();
        readSettingsMock.mockReset();
        readInstallationIdentityIfExistsSyncMock.mockReset();
        readCredentialsMock.mockResolvedValue(null);
        readSettingsMock.mockResolvedValue({ machineId: 'machine-1' });
        readInstallationIdentityIfExistsSyncMock.mockReturnValue({
            version: 1,
            installationId: 'installation-1',
            createdAt: 1,
            publicKey: 'public-key',
            privateKey: 'private-key',
        });
    });

    it('activates the bundled opencode plugin on agent demand and exposes an agent runtime registration', async () => {
        const contributes = createResolvedContributionRegistry(resolveBuiltInContributions());
        const runtimeRegistry = await resolveExecutablePluginRuntimeRegistry({
            contributes,
        });

        expect(runtimeRegistry.agentRuntimesByAgentId.has('opencode')).toBe(false);

        await runtimeRegistry.activatePluginsByEvent('onAgent:opencode');

        const runtime = runtimeRegistry.agentRuntimesByAgentId.get('opencode');
        expect(runtime?.pluginId).toBe('happier.agent.opencode');
        expect(runtime?.registration.agentId).toBe('opencode');
    });

    it('merges activation-time executable actions without exposing descriptor-only static registration methods', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-runtime-home-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-runtime-activated-root-'));
        const daemonEntryPath = join(pluginRoot, 'daemon.mjs');
        const manifestPath = await writeActivationManifest(pluginRoot, {
            id: 'acme.activated',
            runtimeCapabilities: ['actions', 'hooks'],
            permissions: [],
            contributes: {
                actions: [
                    {
                        id: 'acme.activated.action',
                        title: 'Activated Action',
                        description: 'Manifest action surface',
                        scopes: ['global'],
                        surfaces: ['cli'],
                        placement: 'commandPalette',
                        dangerLevel: 'safe',
                        handler: { target: 'daemon', registrationId: 'acme.activated.action' },
                    },
                ],
                resources: [
                    {
                        id: 'acme.activated.prompt',
                        resourceKind: 'prompt',
                        path: 'resources/prompt.md',
                    },
                ],
                uiDescriptors: [
                    {
                        id: 'acme.activated.settings',
                        surface: 'settings',
                        title: 'Activated Settings',
                        fields: [
                            {
                                id: 'enabled',
                                type: 'boolean',
                                title: 'Enabled',
                            },
                        ],
                    },
                ],
                executionRunProfiles: [
                    {
                        id: 'acme.activated.review-profile',
                        kind: 'executionRun.profile',
                        version: '1.0.0',
                        intent: 'review',
                        displayKey: 'acme.activated.reviewProfile',
                        capabilityGates: [],
                        permissionGates: [],
                        redaction: 'none',
                        hidden: false,
                        actionIds: ['acme.activated.action'],
                    },
                ],
                hooks: [
                    {
                        id: 'session.message.send',
                        category: 'lifecycle',
                        scope: 'session',
                        executionKind: 'observe',
                        handler: { target: 'plugin', registrationId: 'session.message.send' },
                    },
                ],
            },
        });

        await writeFile(
            daemonEntryPath,
            [
                'export async function activate(api) {',
                '  for (const key of ["registerResource", "registerUiDescriptor", "registerExecutionRunProfile"]) {',
                '    if (key in api) throw new Error(`${key} must be manifest-owned`);',
                '  }',
                '  api.registerAction({',
                '    id: "acme.activated.action",',
                '    handler: async () => ({ ok: true, data: "activated-action" }),',
                '  });',
                '  api.registerHook({',
                '    hookId: "session.message.send",',
                '    handler: async () => undefined,',
                '  });',
                '}',
                '',
            ].join('\n'),
            'utf8',
        );

        const contributes = createResolvedContributionRegistry({
            agents: [],
            agentRuntimes: [],
            activationTargets: [
                {
                    provenance: 'external',
                    source: { kind: 'path' },
                    pluginId: 'acme.activated',
                    manifestPath,
                    manifestDigest: 'sha256:activated',
                    daemonEntryPath,
                    sourceSpec: {
                        kind: 'path',
                        locator: pluginRoot,
                        trustPolicy: 'local_trusted',
                        installPolicy: 'link',
                    },
                },
            ],
        });

        const runtimeRegistry = await resolveExecutablePluginRuntimeRegistry({
            happyHomeDir,
            contributes,
        });

        expect(runtimeRegistry.contributes.actionsById?.get('acme.activated.action')).toMatchObject({
            pluginId: 'acme.activated',
                definition: {
                    id: 'acme.activated.action',
                    title: 'Activated Action',
                    description: 'Manifest action surface',
                    safety: 'safe',
                surfaces: expect.objectContaining({
                    cli: true,
                }),
            },
        });
        await expect(runtimeRegistry.actionHandlersByActionId.get('acme.activated.action')?.({
            actionId: 'acme.activated.action',
            pluginId: 'acme.activated',
            input: { scope: 'runtime' },
            context: {
                surface: 'cli',
            },
            provenance: {},
        })).resolves.toEqual({ ok: true, data: 'activated-action' });
        await expect(runtimeRegistry.hookHandlersByHookId.get('session.message.send')?.[0]?.handler()).resolves.toBeUndefined();
    });

    it('loads trusted optional grants from the server by default during activation', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-runtime-server-grant-home-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-runtime-server-grant-root-'));
        const pluginId = 'acme.optional.server.default';
        const daemonEntryPath = join(pluginRoot, 'daemon.mjs');
        const manifestPath = await writeActivationManifest(pluginRoot, {
            id: pluginId,
            runtimeCapabilities: [],
            permissions: [],
            optionalPermissions: [{ capability: 'env', scope: 'HAPPIER_OPTIONAL_TOKEN' }],
        });
        await writeFile(daemonEntryPath, 'export async function activate() {}\n', 'utf8');
        readCredentialsMock.mockResolvedValue({
            token: 'token-1',
            encryption: { type: 'legacy', secret: new Uint8Array() },
        });
        axiosPostMock.mockResolvedValue({
            status: 200,
            data: {
                grants: [{
                    v: 1,
                    id: 'grant-1',
                    accountId: 'account-1',
                    pluginId,
                    capability: 'env',
                    targetScope: { kind: 'account' },
                    authoritySource: {
                        kind: 'machine_installation',
                        machineId: 'machine-1',
                        installationId: 'installation-1',
                    },
                    status: 'active',
                    grantedByUserId: 'user-1',
                    grantedAt: 1,
                    createdAt: 1,
                    updatedAt: 1,
                }],
                pendingRequests: [],
            },
        });

        const runtimeRegistry = await resolveExecutablePluginRuntimeRegistry({
            happyHomeDir,
            contributes: createResolvedContributionRegistry({
                agents: [],
                agentRuntimes: [],
                activationTargets: [
                    {
                        provenance: 'external',
                        source: { kind: 'path' },
                        pluginId,
                        manifestPath,
                        manifestDigest: 'sha256:server-grant',
                        daemonEntryPath,
                        sourceSpec: {
                            kind: 'path',
                            locator: pluginRoot,
                            trustPolicy: 'local_trusted',
                            installPolicy: 'link',
                        },
                    },
                ],
            }),
        });

        expect(runtimeRegistry.trustedOptionalPermissionsByPluginId?.get(pluginId)).toEqual(new Set(['env']));
        expect(runtimeRegistry.envAllowedNamesByPluginId?.get(pluginId)).toEqual(new Set(['HAPPIER_OPTIONAL_TOKEN']));
        expect(axiosPostMock).toHaveBeenCalledWith(
            expect.stringContaining('/v1/plugins/permissions/grants/list'),
            expect.objectContaining({
                pluginId,
                includeRevoked: false,
            }),
            expect.objectContaining({
                headers: { Authorization: 'Bearer token-1' },
            }),
        );
    });

    it('rejects activation-time lifecycle registrations without stable ids', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-runtime-lifecycle-home-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-runtime-lifecycle-root-'));
        const pluginId = 'acme.lifecycle.runtime';
        const daemonEntryPath = join(pluginRoot, 'daemon.mjs');
        const markerPath = join(pluginRoot, 'lifecycle.txt');
        const manifestPath = await writeActivationManifest(pluginRoot, {
            id: pluginId,
            runtimeCapabilities: ['lifecycle'],
            permissions: [],
            contributes: {
                lifecycleHandlers: [
                    {
                        id: `${pluginId}.activated`,
                        event: 'activated',
                        handler: { target: 'daemon', registrationId: 'activated' },
                    },
                    {
                        id: `${pluginId}.deactivating`,
                        event: 'deactivating',
                        handler: { target: 'daemon', registrationId: 'deactivating' },
                    },
                ],
            },
        });

        await writeFile(
            daemonEntryPath,
            [
                'import { appendFile } from "node:fs/promises";',
                '',
                'export async function activate(api) {',
                '  api.registerLifecycleHandler({',
                '    event: "deactivating",',
                `    handler: async () => appendFile(${JSON.stringify(markerPath)}, "deactivating\\n"),`,
                '  });',
                '  api.registerLifecycleHandler({',
                '    event: "activated",',
                `    handler: async () => appendFile(${JSON.stringify(markerPath)}, "activated\\n"),`,
                '  });',
                '}',
                '',
            ].join('\n'),
            'utf8',
        );

        const contributes = createResolvedContributionRegistry({
            agents: [],
            agentRuntimes: [],
            activationTargets: [
                {
                    provenance: 'external',
                    source: { kind: 'path' },
                    pluginId,
                    manifestPath,
                    manifestDigest: 'sha256:lifecycle',
                    daemonEntryPath,
                    sourceSpec: {
                        kind: 'path',
                        locator: pluginRoot,
                        trustPolicy: 'local_trusted',
                        installPolicy: 'link',
                    },
                },
            ],
            lifecycleHandlers: [
                {
                    provenance: 'external',
                    source: { kind: 'path' },
                    pluginId,
                    manifestPath,
                    manifestDigest: 'sha256:lifecycle',
                    daemonEntryPath,
                    definition: {
                        kindVersion: 1,
                        id: `${pluginId}.activated`,
                        event: 'activated',
                        priority: 0,
                    },
                },
                {
                    provenance: 'external',
                    source: { kind: 'path' },
                    pluginId,
                    manifestPath,
                    manifestDigest: 'sha256:lifecycle',
                    daemonEntryPath,
                    definition: {
                        kindVersion: 1,
                        id: `${pluginId}.deactivating`,
                        event: 'deactivating',
                        priority: 0,
                    },
                },
            ],
        });

        const runtimeRegistry = await resolveExecutablePluginRuntimeRegistry({
            happyHomeDir,
            contributes,
        });

        expect(runtimeRegistry.pluginDiagnosticsByPluginId[pluginId] ?? []).toEqual([
            expect.objectContaining({ code: 'plugin_lifecycle_handler_undeclared_id' }),
            expect.objectContaining({
                code: 'plugin_activation_failed',
                message: expect.stringContaining('stable lifecycle handler id'),
            }),
        ]);
        expect((runtimeRegistry.contributes.lifecycleHandlers ?? []).map((handler) => ({
            id: handler.definition.id,
            event: handler.definition.event,
        }))).toEqual([
            { id: `${pluginId}.activated`, event: 'activated' },
            { id: `${pluginId}.deactivating`, event: 'deactivating' },
        ]);
        await expect(readFile(markerPath, 'utf8')).rejects.toThrow();

        await runtimeRegistry.dispose();

        await expect(readFile(markerPath, 'utf8')).rejects.toThrow();
    });

    it('loads the ui-descriptor authoring example through the activation-time runtime contract', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-runtime-authoring-home-'));
        const pluginRoot = fileURLToPath(new URL('../testkit/fixtures/authoring-examples/ui-descriptor-plugin/', import.meta.url));
        const manifestPath = join(pluginRoot, '.happier-plugin', 'plugin.json');
        const daemonEntryPath = join(pluginRoot, 'daemon.mjs');

        const runtimeRegistry = await resolveExecutablePluginRuntimeRegistry({
            happyHomeDir,
            contributes: createResolvedContributionRegistry({
                agents: [],
                agentRuntimes: [],
                actions: [],
                resources: [{
                    provenance: 'external',
                    source: { kind: 'path' },
                    pluginId: 'examples.ui-descriptor-plugin',
                    manifestPath,
                    manifestDigest: 'sha256:ui-descriptor-example',
                    daemonEntryPath,
                    sourceSpec: {
                        kind: 'path',
                        locator: pluginRoot,
                        trustPolicy: 'local_trusted',
                        installPolicy: 'link',
                    },
                    definition: {
                        kindVersion: 1,
                        id: 'examples.ui.prompt',
                        type: 'prompt',
                        path: 'resources/review-prompt.md',
                        contentType: 'text/markdown',
                    },
                }],
                uiDescriptors: [{
                    provenance: 'external',
                    source: { kind: 'path' },
                    pluginId: 'examples.ui-descriptor-plugin',
                    manifestPath,
                    manifestDigest: 'sha256:ui-descriptor-example',
                    daemonEntryPath,
                    sourceSpec: {
                        kind: 'path',
                        locator: pluginRoot,
                        trustPolicy: 'local_trusted',
                        installPolicy: 'link',
                    },
                    definition: {
                        kindVersion: 1,
                        id: 'examples.ui.settings',
                        surface: 'settings',
                        title: 'Example Plugin Settings',
                        description: 'Host-rendered descriptor declared in the manifest.',
                        fields: [{
                            id: 'enabled',
                            kind: 'boolean',
                            title: 'Enabled',
                            options: [],
                        }],
                    },
                }],
                activationTargets: [
                    {
                        provenance: 'external',
                        source: { kind: 'path' },
                        pluginId: 'examples.ui-descriptor-plugin',
                        manifestPath,
                        manifestDigest: 'sha256:ui-descriptor-example',
                        daemonEntryPath,
                        sourceSpec: {
                            kind: 'path',
                            locator: pluginRoot,
                            trustPolicy: 'local_trusted',
                            installPolicy: 'link',
                        },
                    },
                ],
            }),
        });

        expect(runtimeRegistry.contributes.resourcesById?.get('examples.ui.prompt')).toMatchObject({
            pluginId: 'examples.ui-descriptor-plugin',
            definition: {
                id: 'examples.ui.prompt',
                path: 'resources/review-prompt.md',
            },
        });
        expect(runtimeRegistry.contributes.uiDescriptorsById?.get('examples.ui.settings')).toMatchObject({
            pluginId: 'examples.ui-descriptor-plugin',
            definition: {
                id: 'examples.ui.settings',
                surface: 'settings',
            },
        });
        expect(runtimeRegistry.pluginDiagnosticsByPluginId['examples.ui-descriptor-plugin'] ?? []).toEqual([]);

        await runtimeRegistry.dispose();
    });

    it('normalizes activation-time tools and commands through the authoritative runtime contribution snapshot', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-runtime-home-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-runtime-command-root-'));
        const daemonEntryPath = join(pluginRoot, 'daemon.mjs');
        const manifestPath = await writeActivationManifest(pluginRoot, {
            id: 'acme.activated',
            runtimeCapabilities: ['tools', 'commands'],
            permissions: [],
            contributes: {
                tools: [
                    {
                        id: 'acme.activated.tool',
                        name: 'acme_activated_tool',
                        title: 'Activated Tool',
                        surfaces: ['cli', 'mcp', 'agent'],
                        handler: { target: 'daemon', registrationId: 'acme.activated.tool' },
                    },
                ],
                commands: [
                    {
                        id: 'acme.activated.command',
                        command: 'activated-review',
                        allowTmux: false,
                        handler: { target: 'daemon', registrationId: 'acme.activated.command' },
                    },
                ],
            },
        });

        await writeFile(
            daemonEntryPath,
            [
                'export async function activate(api) {',
                '  api.registerTool({',
                '    id: "acme.activated.tool",',
                '    handler: async () => "activated-tool",',
                '  });',
                '  api.registerCommand({',
                '    id: "acme.activated.command",',
                '    handler: async (request) => ({ argv: request.input?.argv ?? [] }),',
                '  });',
                '}',
                '',
            ].join('\n'),
            'utf8',
        );

        const contributes = createResolvedContributionRegistry({
            agents: [],
            agentRuntimes: [],
            activationTargets: [
                {
                    provenance: 'external',
                    source: { kind: 'path' },
                    pluginId: 'acme.activated',
                    manifestPath,
                    manifestDigest: 'sha256:activated',
                    daemonEntryPath,
                    sourceSpec: {
                        kind: 'path',
                        locator: pluginRoot,
                        trustPolicy: 'local_trusted',
                        installPolicy: 'link',
                    },
                },
            ],
        });

        const runtimeRegistry = await resolveExecutablePluginRuntimeRegistry({
            happyHomeDir,
            contributes,
        });
        const projected = runtimeRegistry.contributes as typeof runtimeRegistry.contributes & Readonly<Record<string, unknown>>;

        expect(listBuiltInHappierTools({
            surface: 'cli',
            registry: runtimeRegistry.contributes,
        }).map((tool) => tool.name)).toContain('acme_activated_tool');
        expect(runtimeRegistry.contributes.actionsById?.get('acme.activated.tool')).toMatchObject({
            pluginId: 'acme.activated',
            definition: expect.objectContaining({
                id: 'acme.activated.tool',
                bindings: expect.objectContaining({
                    mcpToolName: 'acme_activated_tool',
                }),
            }),
        });
        expect(projected.commandsById).toBeInstanceOf(Map);
        expect((projected.commandsById as Map<string, unknown>).get('acme.activated.command')).toMatchObject({
            pluginId: 'acme.activated',
            definition: expect.objectContaining({
                id: 'acme.activated.command',
                command: 'activated-review',
            }),
        });
    });

    it('loads merged plugin hook handlers from the executable runtime registry using the default export fallback', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-runtime-home-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-runtime-root-'));
        const store = createPluginStateStore({ happyHomeDir });

        await writePlugin(
            pluginRoot,
            {},
            'export default async function resolveTranscriptBinding() { return "runtime-bound"; }\n',
        );

        await store.write({
            t: 'happier_plugin_state_v1',
            schemaVersion: 1,
            plugins: {
                'acme.runtime': {
                    source: {
                        kind: 'path',
                        locator: pluginRoot,
                        trustPolicy: 'local_trusted',
                        installPolicy: 'link',
                        resolvedPath: pluginRoot,
                        manifestPath: join(pluginRoot, '.happier-plugin', 'plugin.json'),
                    },
                    compatibility: {
                        status: 'unknown',
                        diagnostics: [],
                    },
                    install: {
                        mode: 'link',
                        manifestVersion: '1.0.0',
                        manifestDigest: null,
                        installedPath: null,
                    },
                    state: {
                        enabled: true,
                    },
                },
            },
        });

        const runtimeRegistry = await resolveExecutablePluginRuntimeRegistry({ happyHomeDir });

        expect(typeof runtimeRegistry.readHookEventEnvelopeV1).toBe('function');
        expect(runtimeRegistry.readHookEventEnvelopeV1({
            hookVersion: 1,
            hookEventId: 'session.message.send',
            category: 'lifecycle',
            scope: 'session',
            timestampMs: 1,
            payload: {},
        })?.eventId).toBe('session.message.send');
        expect(runtimeRegistry.readHookEventEnvelopeV1({
            hookVersion: 2,
            eventId: 'session.message.send',
            category: 'lifecycle',
            scope: 'session',
            timestampMs: 1,
            payload: {},
        })).toBe(null);

        expect(runtimeRegistry.contributes.surfaceHandlersByBackendId.get('acme.runtime')).toEqual([
            expect.objectContaining({
                backendId: 'acme.runtime',
                definition: expect.objectContaining({
                    id: 'backend.terminalRuntime.launch',
                    kind: 'terminalRuntime',
                }),
            }),
        ]);
        expect(runtimeRegistry.contributes.hookRegistrations).toHaveLength(1);
        const handlers = runtimeRegistry.hookHandlersByHookId.get('agent.resolvePrerequisites');
        const runtimeHandlers = handlers?.filter((handler) => handler.pluginId === 'acme.runtime') ?? [];
        expect(runtimeHandlers).toHaveLength(1);
        await expect(runtimeHandlers[0]?.handler()).resolves.toBe('runtime-bound');
        await expect(dispatchPluginHookEvent({
            runtimeRegistry,
            event: {
                hookVersion: 1,
                hookEventId: 'agent.resolvePrerequisites',
                category: 'decision',
                scope: 'agent',
                backendId: 'acme.runtime',
                timestampMs: 1,
                payload: {
                    agentId: 'acme.runtime',
                    backendId: 'acme.runtime',
                    runtimeTarget: {
                        kind: 'backend',
                        backendId: 'acme.runtime',
                        configuredBackendId: 'acme.runtime',
                        sourceKind: 'configured',
                    },
                    targetRef: {
                        kind: 'backend',
                        backendId: 'acme.runtime',
                        configuredBackendId: 'acme.runtime',
                        sourceKind: 'configured',
                    },
                    timestampMs: 1,
                },
            },
        })).resolves.toEqual(expect.objectContaining({
            matchedHandlerCount: 1,
            outcomes: [expect.objectContaining({ pluginId: 'acme.runtime' })],
        }));
        expect(runtimeRegistry.pluginDiagnosticsByPluginId['acme.runtime']).toEqual([]);
    });

    it('merges contribution diagnostics with runtime hook resolution diagnostics', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-runtime-home-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-runtime-root-'));
        const store = createPluginStateStore({ happyHomeDir });

        await writePlugin(
            pluginRoot,
            {
                id: 'acme.runtime.invalid',
                displayName: 'Acme Runtime Invalid',
                description: 'Invalid runtime hook plugin',
                contributes: {
                    agents: [{
                        kindVersion: 1,
                        id: 'acme.runtime.invalid',
                        runtime: {
                            kind: 'custom',
                        },
                        catalogAgentId: 'claude',
                        display: {
                            name: 'Acme Runtime Invalid',
                            tags: ['plugin'],
                        },
                        ownedBackendIds: ['acme.runtime.invalid'],
                        iconAgentId: 'not-a-built-in-agent',
                        capabilities: {},
                        surfaceHandlers: [
                            {
                                surfaceApiVersion: 1,
                                id: 'backend.terminalRuntime.launch',
                                kind: 'terminalRuntime',
                                operation: 'launch',
                                handler: {
                                    target: 'daemon',
                                    exportName: 'launch',
                                },
                            },
                        ],
                    }],
                    hooks: [{
                        hookApiVersion: 1,
                        id: 'agent.resolvePrerequisites',
                        category: 'decision',
                        scope: 'agent',
                        executionKind: 'decide',
                        handler: {
                            target: 'plugin',
                            exportName: 'resolveTranscriptBinding',
                        },
                    }],
                },
            },
            'export const otherHandler = async () => "nope";\n',
        );

        await store.write({
            t: 'happier_plugin_state_v1',
            schemaVersion: 1,
            plugins: {
                'acme.runtime.invalid': {
                    source: {
                        kind: 'path',
                        locator: pluginRoot,
                        trustPolicy: 'local_trusted',
                        installPolicy: 'link',
                        resolvedPath: pluginRoot,
                        manifestPath: join(pluginRoot, '.happier-plugin', 'plugin.json'),
                    },
                    compatibility: {
                        status: 'unknown',
                        diagnostics: [],
                    },
                    install: {
                        mode: 'link',
                        manifestVersion: '1.0.0',
                        manifestDigest: null,
                        installedPath: null,
                    },
                    state: {
                        enabled: true,
                    },
                },
            },
        });

        const runtimeRegistry = await resolveExecutablePluginRuntimeRegistry({ happyHomeDir });

        expect(runtimeRegistry.contributes.hookRegistrations).toHaveLength(1);
        const handlers = runtimeRegistry.hookHandlersByHookId.get('agent.resolvePrerequisites') ?? [];
        expect(handlers).not.toContainEqual(
            expect.objectContaining({
                pluginId: 'acme.runtime.invalid',
            }),
        );
        expect(runtimeRegistry.pluginDiagnosticsByPluginId['acme.runtime.invalid']).toEqual(expect.arrayContaining([
            expect.objectContaining({
                code: 'plugin_manifest_semantic_invalid',
            }),
            expect.objectContaining({
                code: 'plugin_hook_handler_missing',
            }),
        ]));
    });

    it('merges catalog-time SCM backend activation diagnostics into plugin diagnostics', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-runtime-home-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-runtime-scm-root-'));
        const pluginId = 'acme.scm.backend';
        const daemonEntryPath = join(pluginRoot, 'daemon.mjs');
        const manifestPath = await writeActivationManifest(pluginRoot, {
            id: pluginId,
            runtimeCapabilities: ['scmBackends'],
            permissions: [],
            contributes: {
                scmBackends: [createScmBackendContribution('acme-vcs')],
            },
        });
        await writeFile(
            daemonEntryPath,
            [
                'export async function activate() {',
                '  return undefined;',
                '}',
                '',
            ].join('\n'),
            'utf8',
        );

        const contributes = createResolvedContributionRegistry({
            agents: [],
            agentRuntimes: [],
            activationTargets: [
                {
                    provenance: 'external',
                    source: { kind: 'path' },
                    pluginId,
                    manifestPath,
                    manifestDigest: 'sha256:scm',
                    daemonEntryPath,
                    sourceSpec: {
                        kind: 'path',
                        locator: pluginRoot,
                        trustPolicy: 'local_trusted',
                        installPolicy: 'link',
                    },
                },
            ],
            scmBackends: [
                {
                    id: 'acme-vcs',
                    provenance: 'external',
                    source: { kind: 'path' },
                    pluginId,
                    manifestPath,
                    manifestDigest: 'sha256:scm',
                    daemonEntryPath,
                    sourceSpec: {
                        kind: 'path',
                        locator: pluginRoot,
                        trustPolicy: 'local_trusted',
                        installPolicy: 'link',
                    },
                    definition: createScmBackendContribution('acme-vcs'),
                },
            ],
        });

        const runtimeRegistry = await resolveExecutablePluginRuntimeRegistry({
            happyHomeDir,
            contributes,
        });

        expect(runtimeRegistry.pluginDiagnosticsByPluginId[pluginId]).toEqual([
            expect.objectContaining({
                code: 'plugin_scm_backend_missing_activation',
            }),
        ]);
        expect(runtimeRegistry.pluginDiagnosticsByPluginId[pluginId]?.[0]?.message).toContain(`Plugin '${pluginId}'`);
        expect(runtimeRegistry.pluginDiagnosticsByPluginId[pluginId]?.[0]?.message).toContain("SCM backend 'acme-vcs'");
    });

    it('reuses caller-provided contribution ingress when resolving executable runtime hooks', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-runtime-home-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-runtime-root-'));
        const store = createPluginStateStore({ happyHomeDir });

        await writePlugin(
            pluginRoot,
            {},
            'export default async function resolveTranscriptBinding() { return "runtime-bound"; }\n',
        );

        await store.write({
            t: 'happier_plugin_state_v1',
            schemaVersion: 1,
            plugins: {
                'acme.runtime': {
                    source: {
                        kind: 'path',
                        locator: pluginRoot,
                        trustPolicy: 'local_trusted',
                        installPolicy: 'link',
                        resolvedPath: pluginRoot,
                        manifestPath: join(pluginRoot, '.happier-plugin', 'plugin.json'),
                    },
                    compatibility: {
                        status: 'unknown',
                        diagnostics: [],
                    },
                    install: {
                        mode: 'link',
                        manifestVersion: '1.0.0',
                        manifestDigest: null,
                        installedPath: null,
                    },
                    state: {
                        enabled: true,
                    },
                },
            },
        });

        const initial = await resolveExecutablePluginRuntimeRegistry({ happyHomeDir });
        const reused = await resolveExecutablePluginRuntimeRegistry({
            contributes: initial.contributes,
        });

        expect(reused.contributes).toBe(initial.contributes);
        expect(
            reused.hookHandlersByHookId.get('agent.resolvePrerequisites')
                ?.filter((handler) => handler.pluginId === 'acme.runtime'),
        ).toHaveLength(1);
    });

    it('applies targeted plugin ids before manifest hook daemon modules are loaded', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-runtime-home-'));
        const targetRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-runtime-target-'));
        const unrelatedRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-runtime-unrelated-'));
        const targetEntryPath = join(targetRoot, 'daemon.mjs');
        const unrelatedEntryPath = join(unrelatedRoot, 'daemon.mjs');

        await writeFile(
            targetEntryPath,
            'export async function resolvePrerequisites() { return { allowed: true }; }\n',
            'utf8',
        );
        await writeFile(
            unrelatedEntryPath,
            'throw new Error("unrelated hook module must not be imported");\n',
            'utf8',
        );

        const contributes = createResolvedContributionRegistry({
            agents: [],
            agentRuntimes: [],
            hookRegistrations: [
                createRuntimeHookRegistration({
                    pluginId: 'acme.target',
                    daemonEntryPath: targetEntryPath,
                    exportName: 'resolvePrerequisites',
                }),
                createRuntimeHookRegistration({
                    pluginId: 'acme.unrelated',
                    daemonEntryPath: unrelatedEntryPath,
                    exportName: 'resolvePrerequisites',
                    backendIdFilter: 'other-backend',
                }),
            ],
        });

        const runtimeRegistry = await resolveExecutablePluginRuntimeRegistry({
            happyHomeDir,
            contributes,
            pluginIds: ['acme.target'],
        });

        expect(
            runtimeRegistry.hookHandlersByHookId.get('agent.resolvePrerequisites')
                ?.map((handler) => handler.pluginId),
        ).toEqual(['acme.target']);
        expect(runtimeRegistry.pluginDiagnosticsByPluginId['acme.unrelated']).toBeUndefined();
    });

    it('projects onCommand contributions before activation and activates on first command action dispatch', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-runtime-home-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-runtime-lazy-command-'));
        const pluginId = 'acme.lazy.command.plugin';
        const commandId = 'acme.lazy.command';
        const markerPath = join(pluginRoot, 'activation.log');
        const daemonEntryPath = join(pluginRoot, 'daemon.mjs');
        const manifestDir = join(pluginRoot, '.happier-plugin');
        await mkdir(manifestDir, { recursive: true });
        const manifestPath = join(manifestDir, 'plugin.json');
        await writeFile(
            manifestPath,
            JSON.stringify({
                schemaVersion: 2,
                id: pluginId,
                version: '1.0.0',
                displayName: 'Lazy Command Plugin',
                description: 'Projects a command statically and activates on command demand',
                engines: { happier: '^0.2.0' },
                activationEvents: [`onCommand:${commandId}`],
                uses: ['commands'],
                entrypoints: { main: './daemon.mjs' },
                permissions: {
                    required: [],
                    optional: [],
                },
                contributes: {
                    commands: [
                        {
                            id: commandId,
                            command: 'happier lazy-command',
                            allowTmux: false,
                            handler: { target: 'daemon', registrationId: commandId },
                        },
                    ],
                },
            }, null, 2),
            'utf8',
        );
        await writeFile(
            daemonEntryPath,
            [
                'import { appendFile } from "node:fs/promises";',
                '',
                'export async function activate(api) {',
                `  await appendFile(${JSON.stringify(markerPath)}, "activated\\n", "utf8");`,
                '  api.registerCommand({',
                `    id: ${JSON.stringify(commandId)},`,
                '    handler: async (request) => ({ ok: true, data: { argv: request.input?.argv ?? [] } }),',
                '  });',
                '}',
                '',
            ].join('\n'),
            'utf8',
        );
        const sourceSpec = {
            kind: 'path' as const,
            locator: pluginRoot,
            trustPolicy: 'local_trusted' as const,
            installPolicy: 'link' as const,
        };
        const commandContribution = {
            provenance: 'external' as const,
            source: { kind: 'path' as const },
            pluginId,
            manifestPath,
            manifestDigest: 'sha256:lazy-command',
            daemonEntryPath,
            sourceSpec,
            definition: {
                kindVersion: 1 as const,
                id: commandId,
                command: 'happier lazy-command',
                allowTmux: false,
                actionId: commandId,
            },
        };
        const actionContribution = {
            provenance: 'external' as const,
            source: { kind: 'path' as const },
            pluginId,
            manifestPath,
            manifestDigest: 'sha256:lazy-command',
            daemonEntryPath,
            sourceSpec,
            definition: {
                kindVersion: 1 as const,
                id: commandId,
                title: 'happier lazy-command',
                description: null,
                safety: 'safe' as const,
                placements: [],
                slash: null,
                bindings: null,
                examples: null,
                surfaces: {
                    ui: false,
                    voice: false,
                    agent: false,
                    mcp: false,
                    cli: true,
                    rpc: false,
                    sdk: false,
                },
                inputHints: null,
                inputSchema: {
                    type: 'object',
                    properties: {
                        argv: { type: 'array' },
                        rawArgv: { type: 'array' },
                    },
                    additionalProperties: true,
                },
            },
        };
        const activationTarget = {
            provenance: 'external' as const,
            source: { kind: 'path' as const },
            pluginId,
            manifestPath,
            manifestDigest: 'sha256:lazy-command',
            daemonEntryPath,
            sourceSpec,
            activationEvents: [`onCommand:${commandId}`],
        };
        const contributes = createResolvedContributionRegistry({
            agents: [],
            agentRuntimes: [],
            actions: [actionContribution],
            commands: [commandContribution],
            activationTargets: [activationTarget],
        });

        const runtimeRegistry = await resolveExecutablePluginRuntimeRegistry({
            happyHomeDir,
            contributes,
        });

        expect(runtimeRegistry.contributes.commandsById?.has(commandId)).toBe(true);
        expect(runtimeRegistry.contributes.actionsById?.has(commandId)).toBe(true);
        expect(runtimeRegistry.activatedPluginIds.has(pluginId)).toBe(false);
        expect(runtimeRegistry.actionHandlersByActionId.has(commandId)).toBe(false);
        await expect(readFile(markerPath, 'utf8')).rejects.toThrow();

        const result = await executePluginActionIfAvailable({
            runtimeRegistry,
            actionId: commandId,
            input: { argv: ['--verbose'] },
            context: { surface: 'cli' },
        });

        expect(result).toEqual({
            matched: true,
            result: {
                ok: true,
                result: { argv: ['--verbose'] },
            },
        });
        expect(runtimeRegistry.activatedPluginIds.has(pluginId)).toBe(true);
        expect(runtimeRegistry.actionHandlersByActionId.has(commandId)).toBe(true);
        await expect(readFile(markerPath, 'utf8')).resolves.toBe('activated\n');
    });

    it('uses the persisted reload generation to invalidate daemon module caches between runtime resolutions', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-runtime-home-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-runtime-generation-root-'));
        const daemonEntryPath = join(pluginRoot, 'daemon.mjs');
        const manifestPath = await writeActivationManifest(pluginRoot, {
            id: 'acme.generation',
            runtimeCapabilities: ['hooks'],
            permissions: [],
            contributes: {
                hooks: [
                    {
                        id: 'agent.resolvePrerequisites',
                        category: 'decision',
                        scope: 'agent',
                        executionKind: 'decide',
                        handler: { target: 'plugin', registrationId: 'agent.resolvePrerequisites' },
                    },
                ],
            },
        });

        await writeFile(
            daemonEntryPath,
            [
                'export async function activate(api) {',
                '  api.registerHook({',
                '    hookId: "agent.resolvePrerequisites",',
                '    handler: async () => "generation-one",',
                '  });',
                '}',
                '',
            ].join('\n'),
            'utf8',
        );

        const contributes = createResolvedContributionRegistry({
            agents: [],
            agentRuntimes: [],
            activationTargets: [
                {
                    provenance: 'external',
                    source: { kind: 'path' },
                    pluginId: 'acme.generation',
                    manifestPath,
                    manifestDigest: 'sha256:generation',
                    daemonEntryPath,
                    sourceSpec: {
                        kind: 'path',
                        locator: pluginRoot,
                        trustPolicy: 'local_trusted',
                        installPolicy: 'link',
                    },
                },
            ],
        });

        const first = await resolveExecutablePluginRuntimeRegistry({
            happyHomeDir,
            contributes,
        });
        await expect(first.hookHandlersByHookId.get('agent.resolvePrerequisites')?.[0]?.handler()).resolves.toBe('generation-one');

        await writePluginReloadStateSnapshot(happyHomeDir, {
            t: 'happier_plugin_reload_state_v1',
            schemaVersion: 1,
            generation: 1,
            activeGenerationId: 'reload:1',
            changedPluginIds: ['acme.generation'],
            updatedAt: Date.now(),
        });
        await writeFile(
            daemonEntryPath,
            [
                'export async function activate(api) {',
                '  api.registerHook({',
                '    hookId: "agent.resolvePrerequisites",',
                '    handler: async () => "generation-two",',
                '  });',
                '}',
                '',
            ].join('\n'),
            'utf8',
        );

        const second = await resolveExecutablePluginRuntimeRegistry({
            happyHomeDir,
            contributes,
        });

        await expect(second.hookHandlersByHookId.get('agent.resolvePrerequisites')?.[0]?.handler()).resolves.toBe('generation-two');
    });
});
