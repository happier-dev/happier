import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type {
    ResolvedBackendContribution,
    ResolvedContributionProvenance,
    ResolvedContributionRegistry,
    ResolvedContributionSourceKind,
    ResolvedProviderContribution,
} from '@/plugins/projection/registry/types';
import type { PluginApi } from '@/plugins/runtime/api/types';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';

import { activatePluginRuntimeRegistry } from './manager';
import { createPluginDisposableRegistry } from './disposables';

type TestPermissionDeclaration = string | Readonly<{
    capability: string;
    scope?: string;
}>;

async function writeActivationModule(): Promise<Readonly<{
    manifestPath: string;
    daemonEntryPath: string;
    disposeMarkerPath: string;
    lifecycleMarkerPath: string;
}>> {
    const root = await mkdtemp(join(tmpdir(), 'happier-plugin-activation-'));
    const manifestPath = await writeManifest(root, {
        id: 'acme.activated',
        runtimeCapabilities: ['actions', 'tools', 'commands', 'hooks', 'backends', 'lifecycle', 'notifications'],
        permissions: ['actions.register', 'tools.register', 'commands.register', 'hooks.register', 'notifications.register', 'network', 'network.intercept'],
        backendIds: ['acme.activated.backend'],
        actionIds: ['acme.activated.action'],
        toolIds: ['acme.activated.tool'],
        commandIds: ['acme.activated.command'],
        hookIds: ['session.message.send'],
        lifecycleHandlerIds: ['acme.activated.lifecycleActivated', 'acme.activated.lifecycleDeactivating'],
        notificationCategoryIds: ['acme.activated.notification'],
        notificationChannelIds: ['acme.activated.notification.memory'],
        requestInterceptorIds: ['acme.activated.fetch.audit'],
    });
    const daemonEntryPath = join(root, 'daemon.mjs');
    const disposeMarkerPath = join(root, 'dispose.log');
    const lifecycleMarkerPath = join(root, 'lifecycle.log');
    await writeFile(
        daemonEntryPath,
        [
            'export async function activate(api) {',
            '  api.registerAction({',
            '    id: "acme.activated.action",',
            '    title: "Activated Action",',
            '    description: "Action from activation",',
            '    surface: "cli",',
            '    handler: async () => "activated-action-result",',
            '  });',
            '  api.registerTool({',
            '    id: "acme.activated.tool",',
            '    name: "acme_activated_tool",',
            '    title: "Activated Tool",',
            '    description: "Tool from activation",',
            '    surfaces: { cli: true, mcp: true, session_agent: false },',
            '    handler: async () => "activated-tool-result",',
            '  });',
            '  api.registerCommand({',
            '    id: "acme.activated.command",',
            '    command: "activated-review",',
            '    rootHelpLabel: "happier activated-review",',
            '    rootHelpDescription: "Run activated review",',
            '    allowTmux: false,',
            '    handler: async (request) => ({ argv: request.input?.argv ?? [] }),',
            '  });',
            '  api.registerHook({',
            '    hookId: "session.message.send",',
            '    priority: 25,',
            '    handler: async () => "activated-hook",',
            '  });',
            '  api.registerLifecycleHandler({',
            '    id: "acme.activated.lifecycleActivated",',
            '    event: "activated",',
            '    handler: async () => {',
            '      const { appendFile } = await import("node:fs/promises");',
            '      await appendFile(process.env.HAPPIER_PLUGIN_LIFECYCLE_MARKER, "activated\\n", "utf8");',
            '    },',
            '  });',
            '  api.registerLifecycleHandler({',
            '    id: "acme.activated.lifecycleDeactivating",',
            '    event: "deactivating",',
            '    handler: async () => {',
            '      const { appendFile } = await import("node:fs/promises");',
            '      await appendFile(process.env.HAPPIER_PLUGIN_LIFECYCLE_MARKER, "deactivating\\n", "utf8");',
            '    },',
            '  });',
            '  api.registerBackendEngine({',
            '    backendId: "acme.activated.backend",',
            '    create: async () => ({',
            '      runtimeCore: {',
            '        createSessionRuntime: async () => null,',
            '        createExecutionRunBackend: () => ({ launch: async () => "activated-launch" }),',
            '      },',
            '    }),',
            '  });',
            '  api.registerNotificationCategory({',
            '    id: "acme.activated.notification",',
            '    kind: "activity",',
            '    title: "Activated notification",',
            '    eventIds: ["ready"],',
            '    defaultChannelIds: ["acme.activated.notification.memory"],',
            '  });',
            '  api.registerNotificationChannel({',
            '    id: "acme.activated.notification.memory",',
            '    kind: "plugin",',
            '    title: "Activated memory channel",',
            '    send: async () => ({ delivered: true }),',
            '  });',
            '  api.registerRequestInterceptor({',
            '    id: "acme.activated.fetch.audit",',
            '    handle: async () => ({ kind: "allow" }),',
            '  });',
            '  return {',
            '    dispose: async () => {',
            '      const { appendFile } = await import("node:fs/promises");',
            '      await appendFile(process.env.HAPPIER_PLUGIN_DISPOSE_MARKER, "disposed\\n", "utf8");',
            '    },',
            '  };',
            '}',
            '',
        ].join('\n'),
        'utf8',
    );
    return { manifestPath, daemonEntryPath, disposeMarkerPath, lifecycleMarkerPath };
}

async function writeActivationModuleWithBackendEngine(params: Readonly<{
    pluginId: string;
    backendId: string;
}>): Promise<Readonly<{
    manifestPath: string;
    daemonEntryPath: string;
}>> {
    const root = await mkdtemp(join(tmpdir(), 'happier-plugin-backend-engine-'));
    const manifestPath = await writeManifest(root, {
        id: params.pluginId,
        runtimeCapabilities: ['backends'],
        permissions: [],
        backendIds: [params.backendId],
    });
    const daemonEntryPath = join(root, 'daemon.mjs');
    await writeFile(
        daemonEntryPath,
        [
            'export async function activate(api) {',
            `  api.registerBackendEngine({ backendId: ${JSON.stringify(params.backendId)}, create: async () => ({}) });`,
            '}',
            '',
        ].join('\n'),
        'utf8',
    );
    return { manifestPath, daemonEntryPath };
}

async function writeActivationModuleWithAutoAcpBackend(params: Readonly<{
    pluginId: string;
    backendId: string;
}>): Promise<Readonly<{
    manifestPath: string;
    daemonEntryPath: string;
}>> {
    const root = await mkdtemp(join(tmpdir(), 'happier-plugin-auto-acp-'));
    const manifestPath = await writeManifest(root, {
        id: params.pluginId,
        runtimeCapabilities: ['backends'],
        permissions: [],
        backendIds: [params.backendId],
    });
    const daemonEntryPath = join(root, 'daemon.mjs');
    await mkdir(join(root, 'agent'), { recursive: true });
    await writeFile(
        daemonEntryPath,
        [
            'export async function activate() {',
            '}',
            '',
        ].join('\n'),
        'utf8',
    );
    await writeFile(
        join(root, 'agent', 'acp.js'),
        [
            'export const ACP_BACKEND_DEFINITION = {',
            `  backendId: ${JSON.stringify(params.backendId)},`,
            '  transport: {',
            '    kind: "stdio",',
            '    launch: { kind: "executable", command: "acme-agent", args: ["acp"] },',
            '  },',
            '  ux: { title: "Auto ACP Backend" },',
            '};',
            '',
        ].join('\n'),
        'utf8',
    );
    return { manifestPath, daemonEntryPath };
}

async function writeManifest(
    root: string,
    params: Readonly<{
        id: string;
        runtimeCapabilities: readonly string[];
        permissions: readonly TestPermissionDeclaration[];
        backendIds?: readonly string[];
        actionIds?: readonly string[];
        toolIds?: readonly string[];
        commandIds?: readonly string[];
        hookIds?: readonly string[];
        lifecycleHandlerIds?: readonly string[];
        lifecycleHandlers?: readonly Readonly<{
            id?: string;
            event: 'activated' | 'deactivating';
        }>[];
        notificationCategoryIds?: readonly string[];
        notificationChannelIds?: readonly string[];
        requestInterceptorIds?: readonly string[];
        mcpServerIds?: readonly string[];
        mcpDiscoveryProviderIds?: readonly string[];
        systemTools?: readonly Readonly<{
            toolId: string;
            displayName: string;
            lookupNames?: readonly string[];
            executablePath?: string | null;
            source?: 'system' | 'user_config' | 'managed';
        }>[];
    }>,
): Promise<string> {
    const manifestPath = join(root, '.happier-plugin', 'plugin.json');
    await mkdir(join(root, '.happier-plugin'), { recursive: true });
    await writeFile(
        manifestPath,
        JSON.stringify(createPluginManifestV2Fixture({
            schemaVersion: 2,
            id: params.id,
            version: '1.0.0',
            displayName: params.id,
            description: `${params.id} test manifest`,
            engines: {
                happier: '^0.2.0',
            },
            runtime: {
                apiVersion: 1,
                capabilities: params.runtimeCapabilities,
            },
            permissions: params.permissions.map((permission) => {
                if (typeof permission === 'string') {
                    return { capability: permission };
                }
                return { ...permission };
            }),
            targets: {
                daemon: {
                    entry: './daemon.mjs',
                },
            },
            contributes: {
                backends: (params.backendIds ?? []).map((backendId) => ({
                    kindVersion: 1,
                    id: backendId,
                    agentId: params.id,
                    engine: { kind: 'custom' },
                    capabilities: { executionRun: { supported: false } },
                })),
                actions: (params.actionIds ?? []).map((actionId) => ({
                    id: actionId,
                    title: `${actionId} test action`,
                    scopes: ['global'],
                    surfaces: ['cli'],
                    placement: 'commandPalette',
                    dangerLevel: 'safe',
                    handler: { target: 'daemon', registrationId: actionId },
                })),
                tools: (params.toolIds ?? []).map((toolId) => ({
                    id: toolId,
                    name: toolId.replaceAll('.', '_'),
                    title: `${toolId} test tool`,
                    surfaces: { cli: true, mcp: false, session_agent: false },
                    handler: { target: 'daemon', registrationId: toolId },
                })),
                commands: (params.commandIds ?? []).map((commandId) => ({
                    id: commandId,
                    command: commandId,
                    allowTmux: false,
                    handler: { target: 'daemon', registrationId: commandId },
                })),
                hooks: (params.hookIds ?? []).map((hookId) => ({
                    id: hookId,
                    category: 'lifecycle',
                    scope: 'session',
                    executionKind: 'observe',
                    handler: { target: 'plugin', registrationId: hookId },
                })),
                lifecycleHandlers: (params.lifecycleHandlers ?? (params.lifecycleHandlerIds ?? []).map((handlerId) => ({
                    id: handlerId,
                    event: handlerId.endsWith('Deactivating') ? 'deactivating' as const : 'activated' as const,
                }))).map((handler) => ({
                    ...(handler.id ? { id: handler.id } : {}),
                    event: handler.event,
                    handler: {
                        target: 'daemon',
                        registrationId: handler.id ?? `${params.id}.${handler.event}`,
                    },
                })),
                notifications: (params.notificationCategoryIds ?? []).map((notificationId) => ({
                    id: notificationId,
                    kind: 'activity',
                    title: `${notificationId} test notification`,
                    eventIds: ['ready'],
                    defaultChannelIds: params.notificationChannelIds ?? [],
                })),
                notificationChannels: (params.notificationChannelIds ?? []).map((channelId) => ({
                    id: channelId,
                    kind: 'plugin',
                    title: `${channelId} test channel`,
                })),
                requestInterceptors: (params.requestInterceptorIds ?? []).map((interceptorId) => ({
                    id: interceptorId,
                    order: 10,
                    targets: [{ scope: 'plugin-fetch' }],
                })),
                mcp: {
                    servers: (params.mcpServerIds ?? []).map((serverId) => ({
                        id: serverId,
                        kind: 'mcp.server',
                        version: '1.0.0',
                        capabilityGates: [],
                        permissionGates: [],
                        redaction: 'none',
                        hidden: false,
                        name: serverId.replaceAll('.', '_'),
                        transport: 'hosted',
                        providerId: params.id,
                    })),
                    discoveryProviders: (params.mcpDiscoveryProviderIds ?? []).map((providerId) => ({
                        id: providerId,
                        kind: 'mcp.discoveryProvider',
                        version: '1.0.0',
                        capabilityGates: [],
                        permissionGates: [],
                        redaction: 'none',
                        hidden: false,
                        providerId: params.id,
                    })),
                },
                systemTools: params.systemTools ?? [],
            },
        })),
        'utf8',
    );
    return manifestPath;
}

function createContributes(params: Readonly<{
    pluginId?: string;
    manifestPath: string;
    daemonEntryPath: string;
    trustPolicy?: 'local_trusted' | 'prompt' | 'untrusted';
    provenance?: ResolvedContributionProvenance;
    sourceKind?: ResolvedContributionSourceKind;
}>): ResolvedContributionRegistry {
    const pluginId = params.pluginId ?? 'acme.activated';
    const provenance = params.provenance ?? 'external';
    const sourceKind = params.sourceKind ?? 'path';
    const provider: ResolvedProviderContribution = {
        id: pluginId,
        provenance,
        source: { kind: sourceKind },
        pluginId,
        manifestPath: params.manifestPath,
        manifestDigest: 'digest-activation',
        daemonEntryPath: params.daemonEntryPath,
        sourceSpec: {
            kind: 'path',
            locator: join(params.manifestPath, '..', '..'),
            trustPolicy: params.trustPolicy ?? 'local_trusted',
            installPolicy: 'link',
        },
        definition: {
            kindVersion: 1,
            id: pluginId,
            ownedBackendIds: [`${pluginId}.backend`],
        },
    };
    const backend: ResolvedBackendContribution = {
        id: `${pluginId}.backend`,
        providerId: pluginId,
        provenance,
        source: { kind: sourceKind },
        pluginId,
        manifestPath: params.manifestPath,
        manifestDigest: 'digest-activation',
        daemonEntryPath: params.daemonEntryPath,
        sourceSpec: provider.sourceSpec,
        definition: {
            kindVersion: 1,
            id: `${pluginId}.backend`,
            providerId: pluginId,
        },
    };

    return {
        providers: [provider],
        backends: [backend],
        actions: [],
        resources: [],
        uiDescriptors: [],
        activationTargets: [],
        hookRegistrations: [],
        surfaceHandlersByBackendId: new Map(),
        catalogEntriesById: Object.freeze({}),
        providerDefinitionsById: new Map([[provider.id, provider]]),
        backendDefinitionsById: new Map([[backend.id, backend]]),
        pluginDiagnosticsByPluginId: Object.freeze({}),
    };
}

function mergeContributes(...registries: readonly ResolvedContributionRegistry[]): ResolvedContributionRegistry {
    return {
        providers: registries.flatMap((registry) => registry.providers),
        backends: registries.flatMap((registry) => registry.backends),
        actions: registries.flatMap((registry) => registry.actions),
        resources: registries.flatMap((registry) => registry.resources),
        uiDescriptors: registries.flatMap((registry) => registry.uiDescriptors),
        activationTargets: registries.flatMap((registry) => registry.activationTargets),
        hookRegistrations: registries.flatMap((registry) => registry.hookRegistrations),
        surfaceHandlersByBackendId: new Map(),
        catalogEntriesById: Object.freeze({}),
        providerDefinitionsById: new Map(registries.flatMap((registry) => [...registry.providerDefinitionsById.entries()])),
        backendDefinitionsById: new Map(registries.flatMap((registry) => [...registry.backendDefinitionsById.entries()])),
        pluginDiagnosticsByPluginId: Object.freeze({}),
    };
}

describe('activatePluginRuntimeRegistry', () => {
    it('activates trusted plugin modules, records API handlers, and disposes once', async () => {
        const { manifestPath, daemonEntryPath, disposeMarkerPath, lifecycleMarkerPath } = await writeActivationModule();
        await mkdir(join(daemonEntryPath, '..'), { recursive: true });
        process.env.HAPPIER_PLUGIN_DISPOSE_MARKER = disposeMarkerPath;
        process.env.HAPPIER_PLUGIN_LIFECYCLE_MARKER = lifecycleMarkerPath;

        const activated = await activatePluginRuntimeRegistry({
            contributes: createContributes({
                manifestPath,
                daemonEntryPath,
            }),
            generation: 7,
        });
        const activatedWithFamilies = activated as typeof activated & Readonly<Record<string, unknown>>;

        expect(activated.generation).toBe(7);
        expect(activated.pluginDiagnosticsByPluginId['acme.activated']).toEqual([]);
        expect(activated.actions).toEqual(expect.arrayContaining([
            expect.objectContaining({
                pluginId: 'acme.activated',
                definition: expect.objectContaining({
                    id: 'acme.activated.action',
                    title: 'Activated Action',
                    safety: 'safe',
                    surfaces: expect.objectContaining({
                        cli: true,
                    }),
                }),
            }),
        ]));
        expect(activatedWithFamilies.tools).toEqual([
            expect.objectContaining({
                pluginId: 'acme.activated',
                definition: expect.objectContaining({
                    id: 'acme.activated.tool',
                    name: 'acme_activated_tool',
                }),
            }),
        ]);
        expect(activatedWithFamilies.commands).toEqual([
            expect.objectContaining({
                pluginId: 'acme.activated',
                definition: expect.objectContaining({
                    id: 'acme.activated.command',
                    command: 'activated-review',
                }),
            }),
        ]);
        const hookHandlers = activated.hookHandlersByHookId.get('session.message.send');
        expect(hookHandlers).toHaveLength(1);
        await expect(hookHandlers?.[0]?.handler({})).resolves.toBe('activated-hook');
        await expect(readFile(lifecycleMarkerPath, 'utf8')).resolves.toBe('activated\n');

        expect(activated.runtimeCoreHandlersByBackendId.get('acme.activated.backend')).toBeUndefined();
        expect(activated.backendEnginesByBackendId.get('acme.activated.backend')).toMatchObject({
            pluginId: 'acme.activated',
            registration: expect.objectContaining({
                backendId: 'acme.activated.backend',
                create: expect.any(Function),
            }),
        });
        expect(activated.notificationCategoriesById.get('acme.activated.notification')).toMatchObject({
            pluginId: 'acme.activated',
            registration: expect.objectContaining({
                id: 'acme.activated.notification',
                kind: 'activity',
            }),
        });
        expect(activated.notificationChannelsById.get('acme.activated.notification.memory')).toMatchObject({
            pluginId: 'acme.activated',
            registration: expect.objectContaining({
                id: 'acme.activated.notification.memory',
                send: expect.any(Function),
            }),
        });
        expect(activated.requestInterceptors).toEqual([
            expect.objectContaining({
                pluginId: 'acme.activated',
                registration: expect.objectContaining({
                    id: 'acme.activated.fetch.audit',
                    handle: expect.any(Function),
                }),
                contribution: expect.objectContaining({
                    id: 'acme.activated.fetch.audit',
                    order: 10,
                    targets: [{ scope: 'plugin-fetch' }],
                }),
            }),
        ]);
        expect(activated.networkAllowedPluginIds.has('acme.activated')).toBe(true);

        await activated.dispose();
        await activated.dispose();

        await expect(readFile(disposeMarkerPath, 'utf8')).resolves.toBe('disposed\n');
        await expect(readFile(lifecycleMarkerPath, 'utf8')).resolves.toBe('activated\ndeactivating\n');
    });

    it('preserves manifest permission scopes for network and process runtime services', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-plugin-scoped-policy-'));
        const manifestPath = await writeManifest(root, {
            id: 'acme.scoped',
            runtimeCapabilities: [],
            permissions: [
                { capability: 'network', scope: 'https://api.example.test/v1' },
                { capability: 'process.spawn', scope: '/usr/bin/git' },
            ],
        });
        const daemonEntryPath = join(root, 'daemon.mjs');
        await writeFile(
            daemonEntryPath,
            [
                'export async function activate() {',
                '}',
                '',
            ].join('\n'),
            'utf8',
        );

        const activated = await activatePluginRuntimeRegistry({
            contributes: createContributes({
                pluginId: 'acme.scoped',
                manifestPath,
                daemonEntryPath,
            }),
            generation: 11,
        });

        expect(activated.networkAllowedPluginIds.has('acme.scoped')).toBe(true);
        expect(activated.networkAllowedUrlOriginsByPluginId.get('acme.scoped')).toEqual(
            new Set(['https://api.example.test']),
        );
        expect(activated.processSpawnAllowedPathsByPluginId.get('acme.scoped')).toEqual(
            new Set(['/usr/bin/git']),
        );
    });

    it('drops path-only process.spawn scopes and preserves explicit env scopes', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-plugin-env-policy-'));
        const manifestPath = await writeManifest(root, {
            id: 'acme.env',
            runtimeCapabilities: [],
            permissions: [
                { capability: 'process.spawn', scope: 'git' },
                { capability: 'env', scope: 'HAPPIER_DECLARED_ENV' },
                { capability: 'filesystem.read', scope: 'transcripts' },
                { capability: 'filesystem.write', scope: 'artifacts' },
            ],
        });
        const daemonEntryPath = join(root, 'daemon.mjs');
        await writeFile(
            daemonEntryPath,
            [
                'export async function activate() {',
                '}',
                '',
            ].join('\n'),
            'utf8',
        );

        const activated = await activatePluginRuntimeRegistry({
            contributes: createContributes({
                pluginId: 'acme.env',
                manifestPath,
                daemonEntryPath,
            }),
            generation: 12,
        });

        expect(activated.processSpawnAllowedPathsByPluginId.get('acme.env')).toBeUndefined();
        expect(activated.envAllowedNamesByPluginId.get('acme.env')).toEqual(
            new Set(['HAPPIER_DECLARED_ENV']),
        );
        expect(activated.filesystemReadAllowedPathsByPluginId.get('acme.env')).toEqual(
            new Set(['transcripts']),
        );
        expect(activated.filesystemWriteAllowedPathsByPluginId.get('acme.env')).toEqual(
            new Set(['artifacts']),
        );
    });

    it('projects manifest-declared system tools into plugin runtime policy', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-plugin-system-tools-'));
        const manifestPath = await writeManifest(root, {
            id: 'acme.system-tools',
            runtimeCapabilities: [],
            permissions: [],
            systemTools: [
                {
                    toolId: 'acme.audit',
                    displayName: 'Acme Audit',
                    lookupNames: ['acme-audit'],
                    source: 'system',
                },
            ],
        });
        const daemonEntryPath = join(root, 'daemon.mjs');
        await writeFile(
            daemonEntryPath,
            [
                'export async function activate() {',
                '}',
                '',
            ].join('\n'),
            'utf8',
        );

        const activated = await activatePluginRuntimeRegistry({
            contributes: createContributes({
                pluginId: 'acme.system-tools',
                manifestPath,
                daemonEntryPath,
            }),
            generation: 13,
        });

        expect(activated.systemToolDefinitionsByPluginId.get('acme.system-tools')).toEqual([
            {
                toolId: 'acme.audit',
                displayName: 'Acme Audit',
                lookupNames: ['acme-audit'],
                defaultArgs: [],
                source: 'system',
            },
        ]);
    });

    it('records trust diagnostics instead of collapsing prompt-trust activation failures into generic load errors', async () => {
        const { manifestPath, daemonEntryPath } = await writeActivationModule();

        const activated = await activatePluginRuntimeRegistry({
            contributes: createContributes({
                pluginId: 'acme.prompt',
                manifestPath,
                daemonEntryPath,
                trustPolicy: 'prompt',
            }),
            generation: 3,
        });

        expect(activated.pluginDiagnosticsByPluginId['acme.prompt']).toEqual([
            expect.objectContaining({
                code: 'plugin_trust_approval_required',
            }),
        ]);
        expect(activated.actions).toEqual([]);
    });

    it('fails closed when activation-time executable registrations exceed declared runtime capabilities or permissions', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-plugin-activation-policy-'));
        const manifestPath = await writeManifest(root, {
            id: 'acme.policy',
            runtimeCapabilities: ['tools'],
            permissions: [],
        });
        const daemonEntryPath = join(root, 'daemon.mjs');

        await writeFile(
            daemonEntryPath,
            [
                'export async function activate(api) {',
                '  for (const key of ["registerResource", "registerUiDescriptor", "registerExecutionRunProfile"]) {',
                '    if (key in api) throw new Error(`${key} must be manifest-owned`);',
                '  }',
                '  api.registerTool({',
                '    id: "acme.policy.tool",',
                '    name: "acme_policy_tool",',
                '    title: "Policy Tool",',
                '    handler: async () => "tool",',
                '  });',
                '}',
                '',
            ].join('\n'),
            'utf8',
        );

        const activated = await activatePluginRuntimeRegistry({
            contributes: createContributes({
                pluginId: 'acme.policy',
                manifestPath,
                daemonEntryPath,
            }),
            generation: 5,
        });
        const activatedWithFamilies = activated as typeof activated & Readonly<Record<string, unknown>>;

        expect(activated.actions).toEqual([]);
        expect(activatedWithFamilies.tools).toEqual([]);
        expect(activated.pluginDiagnosticsByPluginId['acme.policy']).toEqual([
            expect.objectContaining({
                code: 'plugin_permission_missing',
                message: expect.stringContaining('tools.register'),
            }),
        ]);
    });

    it('rejects activation-time executable and MCP registrations absent from the same manifest', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-plugin-activation-declared-ids-'));
        const manifestPath = await writeManifest(root, {
            id: 'acme.declared',
            runtimeCapabilities: ['tools', 'commands', 'hooks', 'lifecycle', 'mcp'],
            permissions: ['tools.register', 'commands.register', 'hooks.register'],
            toolIds: ['acme.declared.tool'],
            commandIds: ['acme.declared.command'],
            hookIds: ['tool.call.before'],
            lifecycleHandlerIds: ['acme.declared.lifecycle'],
        });
        const daemonEntryPath = join(root, 'daemon.mjs');

        await writeFile(
            daemonEntryPath,
            [
                'export async function activate(api) {',
                '  for (const bind of [',
                '    () => api.registerTool({',
                '      id: "acme.declared.shadowTool",',
                '      name: "acme_declared_shadow_tool",',
                '      title: "Shadow Tool",',
                '      handler: async () => "shadow-tool",',
                '    }),',
                '    () => api.registerCommand({',
                '      id: "acme.declared.shadowCommand",',
                '      command: "shadow-command",',
                '      allowTmux: false,',
                '      handler: async () => "shadow-command",',
                '    }),',
                '    () => api.registerHook({',
                '      id: "acme.declared.shadowHook",',
                '      hookId: "session.message.send",',
                '      handler: async () => "shadow-hook",',
                '    }),',
                '    () => api.registerLifecycleHandler({',
                '      id: "acme.declared.shadowLifecycle",',
                '      event: "activated",',
                '      handler: async () => undefined,',
                '    }),',
                '    () => api.registerMcpServer({',
                '      id: "acme.declared.shadowMcp",',
                '      name: "shadow-mcp",',
                '      transport: { kind: "hosted" },',
                '    }),',
                '    () => api.registerMcpDiscoveryProvider({',
                '      id: "acme.declared.shadowMcpDiscovery",',
                '      discover: async () => [],',
                '    }),',
                '  ]) {',
                '    try { bind(); } catch {}',
                '  }',
                '}',
                '',
            ].join('\n'),
            'utf8',
        );

        const activated = await activatePluginRuntimeRegistry({
            contributes: createContributes({
                pluginId: 'acme.declared',
                manifestPath,
                daemonEntryPath,
            }),
            generation: 14,
        });

        expect(activated.tools).toEqual([]);
        expect(activated.commands).toEqual([]);
        expect(activated.hookHandlersByHookId.size).toBe(0);
        expect(activated.lifecycleHandlers).toEqual([]);
        expect(activated.mcpServers).toEqual([]);
        expect(activated.mcpDiscoveryProviders).toEqual([]);
        expect(activated.pluginDiagnosticsByPluginId['acme.declared']).toEqual([
            expect.objectContaining({ code: 'plugin_tool_undeclared_id' }),
            expect.objectContaining({ code: 'plugin_command_undeclared_id' }),
            expect.objectContaining({ code: 'plugin_hook_undeclared_id' }),
            expect.objectContaining({ code: 'plugin_lifecycle_handler_undeclared_id' }),
            expect.objectContaining({ code: 'plugin_mcp_server_undeclared_id' }),
            expect.objectContaining({ code: 'plugin_mcp_discovery_provider_undeclared_id' }),
        ]);
    });

    it('binds id-less lifecycle declarations through their synthetic projection id', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-plugin-idless-lifecycle-'));
        const markerPath = join(root, 'activated.txt');
        const manifestPath = await writeManifest(root, {
            id: 'acme.lifecycle.idless',
            runtimeCapabilities: ['lifecycle'],
            permissions: [],
            lifecycleHandlers: [
                { event: 'activated' },
            ],
        });
        const daemonEntryPath = join(root, 'daemon.mjs');

        await writeFile(
            daemonEntryPath,
            [
                'import { appendFile } from "node:fs/promises";',
                '',
                'export async function activate(api) {',
                '  api.registerLifecycleHandler({',
                '    event: "activated",',
                `    handler: async () => appendFile(${JSON.stringify(markerPath)}, "activated\\n"),`,
                '  });',
                '}',
                '',
            ].join('\n'),
            'utf8',
        );

        const activated = await activatePluginRuntimeRegistry({
            contributes: createContributes({
                pluginId: 'acme.lifecycle.idless',
                manifestPath,
                daemonEntryPath,
            }),
            generation: 15,
        });

        expect(activated.pluginDiagnosticsByPluginId['acme.lifecycle.idless']).toEqual([]);
        expect(activated.lifecycleHandlers).toEqual([
            expect.objectContaining({
                definition: expect.objectContaining({
                    id: 'acme.lifecycle.idless:activated:0',
                    event: 'activated',
                }),
                pluginId: 'acme.lifecycle.idless',
            }),
        ]);
        await expect(readFile(markerPath, 'utf8')).resolves.toBe('activated\n');
    });

    it('binds multiple id-less lifecycle declarations to manifest synthetic ids independent of registration order', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-plugin-idless-lifecycle-order-'));
        const markerPath = join(root, 'lifecycle.txt');
        const manifestPath = await writeManifest(root, {
            id: 'acme.lifecycle.order',
            runtimeCapabilities: ['lifecycle'],
            permissions: [],
            lifecycleHandlers: [
                { event: 'activated' },
                { event: 'deactivating' },
            ],
        });
        const daemonEntryPath = join(root, 'daemon.mjs');

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

        const activated = await activatePluginRuntimeRegistry({
            contributes: createContributes({
                pluginId: 'acme.lifecycle.order',
                manifestPath,
                daemonEntryPath,
            }),
            generation: 16,
        });

        expect(activated.pluginDiagnosticsByPluginId['acme.lifecycle.order']).toEqual([]);
        expect(activated.lifecycleHandlers.map((handler) => handler.definition.id)).toEqual([
            'acme.lifecycle.order:deactivating:1',
            'acme.lifecycle.order:activated:0',
        ]);
        expect(activated.lifecycleHandlersByEvent.get('activated')?.[0]?.registrationId).toBe('acme.lifecycle.order:activated:0');
        expect(activated.lifecycleHandlersByEvent.get('deactivating')?.[0]?.registrationId).toBe('acme.lifecycle.order:deactivating:1');
        await expect(readFile(markerPath, 'utf8')).resolves.toBe('activated\n');

        await activated.dispose();

        await expect(readFile(markerPath, 'utf8')).resolves.toBe('activated\ndeactivating\n');
    });

    it('supports bundled activation sources without requiring a file-backed daemon entry path', async () => {
        const { manifestPath: existingManifestPath, disposeMarkerPath, lifecycleMarkerPath } = await writeActivationModule();
        process.env.HAPPIER_PLUGIN_DISPOSE_MARKER = disposeMarkerPath;
        process.env.HAPPIER_PLUGIN_LIFECYCLE_MARKER = lifecycleMarkerPath;

        const activated = await activatePluginRuntimeRegistry({
            contributes: createContributes({
                // Bundled sources must not require a manifest file on disk.
                manifestPath: join(existingManifestPath, '..', 'missing-plugin.json'),
                // Intentionally points to a non-existent file. The activation source must be bundled.
                daemonEntryPath: join(join(existingManifestPath, '..'), 'missing-daemon.mjs'),
            }),
            generation: 1,
            resolveActivationSource(target) {
                if (target.pluginId !== 'acme.activated') {
                    return null;
                }
                return {
                    kind: 'bundled',
                    moduleId: '@happier-dev/plugins-acme.activated/daemon',
                    load: async () => {
                        return {
                            PLUGIN_MANIFEST: createPluginManifestV2Fixture({
                                schemaVersion: 2,
                                id: 'acme.activated',
                                version: '0.0.0',
                                displayName: 'acme.activated',
                                engines: { happier: '^0.0.0' },
                                runtime: { apiVersion: 1, capabilities: ['actions'] },
                                targets: {},
                                permissions: [{ capability: 'actions.register' }],
                                contributes: {
                                    actions: [
                                        {
                                            id: 'acme.activated.action',
                                            title: 'Activated Action',
                                            scopes: ['global'],
                                            surfaces: ['cli'],
                                            placement: 'commandPalette',
                                            dangerLevel: 'safe',
                                            handler: { target: 'daemon', registrationId: 'acme.activated.action' },
                                        },
                                    ],
                                },
                            }),
                            activate: async (api: PluginApi) => {
                                api.registerAction({
                                    id: 'acme.activated.action',
                                    title: 'Activated Action',
                                    description: 'Action from bundled activation',
                                    surface: 'cli',
                                    handler: async () => 'activated-action-result',
                                });
                                return {
                                    dispose: async () => {
                                        const { appendFile } = await import('node:fs/promises');
                                        await appendFile(
                                            process.env.HAPPIER_PLUGIN_DISPOSE_MARKER!,
                                            'disposed\n',
                                            'utf8',
                                        );
                                    },
                                };
                            },
                        };
                    },
                };
            },
        });

        expect(activated.pluginDiagnosticsByPluginId['acme.activated']).toEqual([]);
        expect(activated.actions).toEqual(expect.arrayContaining([
            expect.objectContaining({
                pluginId: 'acme.activated',
                definition: expect.objectContaining({
                    id: 'acme.activated.action',
                }),
            }),
        ]));
        await activated.dispose();
        const disposeMarker = await readFile(disposeMarkerPath, 'utf8');
        expect(disposeMarker.trim()).toBe('disposed');
    });

    it('preserves bundled first-party provenance for activation-time contributions', async () => {
        const pluginRoot = join(tmpdir(), 'happier-plugin-first-party-missing');
        const pluginId = 'happier.agent.activated';
        const actionId = `${pluginId}.action`;
        const toolId = `${pluginId}.tool`;
        const commandId = `${pluginId}.command`;
        const lifecycleHandlerId = `${pluginId}.lifecycle`;
        const hookHandlerId = `${pluginId}.hook`;

        const activated = await activatePluginRuntimeRegistry({
            contributes: createContributes({
                pluginId,
                manifestPath: join(pluginRoot, 'plugin.json'),
                daemonEntryPath: join(pluginRoot, 'daemon.mjs'),
                provenance: 'first_party',
                sourceKind: 'bundled',
            }),
            generation: 15,
            resolveActivationSource(target) {
                if (target.pluginId !== pluginId) {
                    return null;
                }
                return {
                    kind: 'bundled',
                    moduleId: '@happier-dev/plugins-activated/daemon',
                    load: async () => ({
                        PLUGIN_MANIFEST: createPluginManifestV2Fixture({
                            schemaVersion: 2,
                            id: pluginId,
                            version: '0.0.0',
                            displayName: pluginId,
                            engines: { happier: '^0.0.0' },
                            runtime: { apiVersion: 1, capabilities: ['actions', 'tools', 'commands', 'hooks', 'lifecycle'] },
                            targets: {},
                            permissions: [
                                { capability: 'actions.register' },
                                { capability: 'tools.register' },
                                { capability: 'commands.register' },
                                { capability: 'hooks.register' },
                            ],
                            contributes: {
                                actions: [
                                    {
                                        id: actionId,
                                        title: 'Activated Action',
                                        scopes: ['global'],
                                        surfaces: ['cli'],
                                        placement: 'commandPalette',
                                        dangerLevel: 'safe',
                                        handler: { target: 'daemon', registrationId: actionId },
                                    },
                                ],
                                tools: [
                                    {
                                        id: toolId,
                                        name: 'happier_agent_activated_tool',
                                        title: 'Activated Tool',
                                        surfaces: { cli: true, mcp: false, session_agent: false },
                                        handler: { target: 'daemon', registrationId: toolId },
                                    },
                                ],
                                commands: [
                                    {
                                        id: commandId,
                                        command: 'activated-command',
                                        allowTmux: false,
                                        handler: { target: 'daemon', registrationId: commandId },
                                    },
                                ],
                                hooks: [
                                    {
                                        id: 'session.message.send',
                                        category: 'lifecycle',
                                        scope: 'session',
                                        executionKind: 'observe',
                                        handler: { target: 'plugin', registrationId: hookHandlerId },
                                    },
                                ],
                                lifecycleHandlers: [
                                    {
                                        id: lifecycleHandlerId,
                                        event: 'activated',
                                        handler: { target: 'daemon', registrationId: lifecycleHandlerId },
                                    },
                                ],
                            },
                        }),
                        activate: async (api: PluginApi) => {
                            api.registerAction({
                                id: actionId,
                                title: 'Activated Action',
                                surface: 'cli',
                                handler: async () => 'activated-action-result',
                            });
                            api.registerTool({
                                id: toolId,
                                name: 'happier_agent_activated_tool',
                                title: 'Activated Tool',
                                handler: async () => 'activated-tool-result',
                            });
                            api.registerCommand({
                                id: commandId,
                                command: 'activated-command',
                                allowTmux: false,
                                handler: async () => 'activated-command-result',
                            });
                            api.registerHook({
                                hookId: 'session.message.send',
                                handler: async () => 'activated-hook',
                            });
                            api.registerLifecycleHandler({
                                id: lifecycleHandlerId,
                                event: 'activated',
                                handler: async () => undefined,
                            });
                        },
                    }),
                };
            },
        });

        expect(activated.pluginDiagnosticsByPluginId[pluginId]).toEqual([]);
        expect(activated.actions).toEqual(expect.arrayContaining([
            expect.objectContaining({
                provenance: 'first_party',
                source: { kind: 'bundled' },
                pluginId,
            }),
        ]));
        expect(activated.tools).toEqual([
            expect.objectContaining({
                provenance: 'first_party',
                source: { kind: 'bundled' },
                pluginId,
            }),
        ]);
        expect(activated.commands).toEqual([
            expect.objectContaining({
                provenance: 'first_party',
                source: { kind: 'bundled' },
                pluginId,
            }),
        ]);
        expect(activated.lifecycleHandlers).toEqual([
            expect.objectContaining({
                provenance: 'first_party',
                source: { kind: 'bundled' },
                pluginId,
            }),
        ]);
        expect(activated.hookHandlersByHookId.get('session.message.send')).toEqual([
            expect.objectContaining({
                registration: expect.objectContaining({
                    provenance: 'first_party',
                    source: { kind: 'bundled' },
                }),
            }),
        ]);
    });

    it('records a diagnostic when multiple plugins register backend engines with the same backendId and keeps the first registration', async () => {
        const backendId = 'acme.shared.backend';
        const first = await writeActivationModuleWithBackendEngine({
            pluginId: 'acme.dupe.a',
            backendId,
        });
        const second = await writeActivationModuleWithBackendEngine({
            pluginId: 'acme.dupe.b',
            backendId,
        });

        const contributes: ResolvedContributionRegistry = {
            ...createContributes({
                pluginId: 'acme.dupe.a',
                manifestPath: first.manifestPath,
                daemonEntryPath: first.daemonEntryPath,
            }),
            providers: [
                ...createContributes({
                    pluginId: 'acme.dupe.a',
                    manifestPath: first.manifestPath,
                    daemonEntryPath: first.daemonEntryPath,
                }).providers,
                ...createContributes({
                    pluginId: 'acme.dupe.b',
                    manifestPath: second.manifestPath,
                    daemonEntryPath: second.daemonEntryPath,
                }).providers,
            ],
            backends: [
                ...createContributes({
                    pluginId: 'acme.dupe.a',
                    manifestPath: first.manifestPath,
                    daemonEntryPath: first.daemonEntryPath,
                }).backends,
                ...createContributes({
                    pluginId: 'acme.dupe.b',
                    manifestPath: second.manifestPath,
                    daemonEntryPath: second.daemonEntryPath,
                }).backends,
            ],
            providerDefinitionsById: new Map([
                ...createContributes({
                    pluginId: 'acme.dupe.a',
                    manifestPath: first.manifestPath,
                    daemonEntryPath: first.daemonEntryPath,
                }).providerDefinitionsById.entries(),
                ...createContributes({
                    pluginId: 'acme.dupe.b',
                    manifestPath: second.manifestPath,
                    daemonEntryPath: second.daemonEntryPath,
                }).providerDefinitionsById.entries(),
            ]),
            backendDefinitionsById: new Map([
                ...createContributes({
                    pluginId: 'acme.dupe.a',
                    manifestPath: first.manifestPath,
                    daemonEntryPath: first.daemonEntryPath,
                }).backendDefinitionsById.entries(),
                ...createContributes({
                    pluginId: 'acme.dupe.b',
                    manifestPath: second.manifestPath,
                    daemonEntryPath: second.daemonEntryPath,
                }).backendDefinitionsById.entries(),
            ]),
        };

        const activated = await activatePluginRuntimeRegistry({
            contributes,
            generation: 1,
        });

        expect(activated.backendEnginesByBackendId.get(backendId)?.pluginId).toBe('acme.dupe.a');
        expect(activated.pluginDiagnosticsByPluginId['acme.dupe.a'] ?? []).toEqual(expect.arrayContaining([
            expect.objectContaining({
                code: 'plugin_backend_engine_duplicate_backend_id',
            }),
        ]));
        expect(activated.pluginDiagnosticsByPluginId['acme.dupe.b'] ?? []).toEqual(expect.arrayContaining([
            expect.objectContaining({
                code: 'plugin_backend_engine_duplicate_backend_id',
            }),
        ]));
    });

    it('auto-registers agent/acp.js definitions during plugin activation', async () => {
        const { manifestPath, daemonEntryPath } = await writeActivationModuleWithAutoAcpBackend({
            pluginId: 'acme.auto.acp',
            backendId: 'acme.auto.backend',
        });

        const activated = await activatePluginRuntimeRegistry({
            contributes: createContributes({
                pluginId: 'acme.auto.acp',
                manifestPath,
                daemonEntryPath,
            }),
            generation: 9,
        });

        expect(activated.pluginDiagnosticsByPluginId['acme.auto.acp']).toEqual([]);
        expect(activated.backendEnginesByBackendId.get('acme.auto.backend')).toEqual(expect.objectContaining({
            pluginId: 'acme.auto.acp',
            registration: expect.objectContaining({
                backendId: 'acme.auto.backend',
                create: expect.any(Function),
            }),
        }));
    });
});

describe('createPluginDisposableRegistry', () => {
    it('disposes late registrations immediately after plugin deactivation cleanup has run', async () => {
        const first = vi.fn();
        const late = vi.fn();
        const registry = createPluginDisposableRegistry();

        registry.add(first);
        await registry.dispose();
        registry.add(late);

        expect(first).toHaveBeenCalledTimes(1);
        expect(late).toHaveBeenCalledTimes(1);
        await registry.dispose();
        expect(first).toHaveBeenCalledTimes(1);
        expect(late).toHaveBeenCalledTimes(1);
    });
});
