import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
    ResolvedAgentRuntimeContribution,
    ResolvedActivationTarget,
    ResolvedContributionProvenance,
    ResolvedContributionRegistry,
    ResolvedContributionSourceKind,
    ResolvedAgentContribution,
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
        runtimeCapabilities: ['actions', 'tools', 'commands', 'hooks', 'agents', 'lifecycle', 'notifications'],
        permissions: ['network', 'network.intercept'],
        agentIds: ['acme.activated.backend'],
        actionIds: ['acme.activated.action'],
        actionSurfaces: ['cli', 'agent'],
        toolIds: ['acme.activated.tool'],
        toolSurfaces: ['cli', 'agent'],
        commandIds: ['acme.activated.command'],
        hookIds: ['session.message.send'],
        lifecycleHandlerIds: ['acme.activated.lifecycleActivated', 'acme.activated.lifecycleDeactivating', 'acme.activated.lifecycleDeactivated'],
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
            '    handler: async () => ({ ok: true, data: "activated-action-result" }),',
            '  });',
            '  api.registerTool({',
            '    id: "acme.activated.tool",',
            '    handler: async () => "activated-tool-result",',
            '  });',
            '  api.registerCommand({',
            '    id: "acme.activated.command",',
            '    handler: async (request) => ({ argv: request.input?.argv ?? [] }),',
            '  });',
            '  api.registerHook({',
            '    hookId: "session.message.send",',
            '    priority: 25,',
            '    handler: async () => undefined,',
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
            '    id: "acme.activated.lifecycleDeactivated",',
            '    event: "deactivated",',
            '    handler: async () => {',
            '      const { appendFile } = await import("node:fs/promises");',
            '      await appendFile(process.env.HAPPIER_PLUGIN_LIFECYCLE_MARKER, "deactivated\\n", "utf8");',
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
            '  api.registerAgentRuntime({',
            '    agentId: "acme.activated.backend",',
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

async function writeActivationModuleWithAgentRuntime(params: Readonly<{
    pluginId: string;
    agentId: string;
}>): Promise<Readonly<{
    manifestPath: string;
    daemonEntryPath: string;
}>> {
    const root = await mkdtemp(join(tmpdir(), 'happier-plugin-agent-runtime-'));
    const manifestPath = await writeManifest(root, {
        id: params.pluginId,
        runtimeCapabilities: ['agents'],
        permissions: [],
        agentIds: [params.agentId],
    });
    const daemonEntryPath = join(root, 'daemon.mjs');
    await writeFile(
        daemonEntryPath,
        [
            'export async function activate(api) {',
            `  api.registerAgentRuntime({ agentId: ${JSON.stringify(params.agentId)}, create: async () => ({}) });`,
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
        runtimeCapabilities: ['agents'],
        permissions: [],
        agentIds: [params.backendId],
    });
    const daemonEntryPath = join(root, 'daemon.mjs');
    await mkdir(join(root, 'agent'), { recursive: true });
    await writeFile(
        daemonEntryPath,
        [
            'export async function activate(api) {',
            '  void api;',
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
        agentIds?: readonly string[];
        actionIds?: readonly string[];
        actionSurfaces?: readonly ('cli' | 'mcp' | 'agent')[];
        toolIds?: readonly string[];
        toolSurfaces?: readonly ('cli' | 'mcp' | 'agent')[];
        commandIds?: readonly string[];
        hookIds?: readonly string[];
        lifecycleHandlerIds?: readonly string[];
        lifecycleHandlers?: readonly Readonly<{
            id?: string;
            event: 'activated' | 'deactivating' | 'deactivated';
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
            uses: params.runtimeCapabilities,
            entrypoints: {
                main: './daemon.mjs',
            },
            permissions: {
                required: params.permissions.map((permission) => {
                    if (typeof permission === 'string') {
                        return { capability: permission };
                    }
                    return { ...permission };
                }),
                optional: [],
            },
            contributes: {
                agents: (params.agentIds ?? []).map((backendId) => ({
                    kindVersion: 1,
                    id: backendId,
                    runtime: { kind: 'custom' },
                    capabilities: { executionRun: { supported: false } },
                })),
                actions: (params.actionIds ?? []).map((actionId) => ({
                    id: actionId,
                    title: `${actionId} test action`,
                    scopes: ['global'],
                    surfaces: params.actionSurfaces ?? ['cli'],
                    placement: 'commandPalette',
                    dangerLevel: 'safe',
                    handler: { target: 'daemon', registrationId: actionId },
                })),
                tools: (params.toolIds ?? []).map((toolId) => ({
                    id: toolId,
                    name: toolId.replaceAll('.', '_'),
                    title: `${toolId} test tool`,
                    surfaces: params.toolSurfaces ?? ['cli'],
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
                    event: handlerId.endsWith('Deactivated') ? 'deactivated' as const : handlerId.endsWith('Deactivating') ? 'deactivating' as const : 'activated' as const,
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
    activationEvents?: readonly string[];
    trustPolicy?: 'local_trusted' | 'prompt' | 'untrusted';
    provenance?: ResolvedContributionProvenance;
    sourceKind?: ResolvedContributionSourceKind;
}>): ResolvedContributionRegistry {
    const pluginId = params.pluginId ?? 'acme.activated';
    const provenance = params.provenance ?? 'external';
    const sourceKind = params.sourceKind ?? 'path';
    const provider: ResolvedAgentContribution = {
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
    const backend: ResolvedAgentRuntimeContribution = {
        id: `${pluginId}.backend`,
        agentId: pluginId,
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
            agentId: pluginId,
        },
    };
    const activationTarget = {
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
        ...(params.activationEvents ? { activationEvents: params.activationEvents } : {}),
    } satisfies ResolvedActivationTarget;

    return {
        agents: [provider],
        agentRuntimes: [backend],
        actions: [],
        resources: [],
        uiDescriptors: [],
        activationTargets: [activationTarget],
        hookRegistrations: [],
        surfaceHandlersByBackendId: new Map(),
        catalogEntriesById: Object.freeze({}),
        agentDefinitionsById: new Map([[provider.id, provider]]),
        agentRuntimeDefinitionsById: new Map([[backend.id, backend]]),
        pluginDiagnosticsByPluginId: Object.freeze({}),
    };
}

function mergeContributes(...registries: readonly ResolvedContributionRegistry[]): ResolvedContributionRegistry {
    return {
        agents: registries.flatMap((registry) => registry.agents),
        agentRuntimes: registries.flatMap((registry) => registry.agentRuntimes),
        actions: registries.flatMap((registry) => registry.actions),
        resources: registries.flatMap((registry) => registry.resources),
        uiDescriptors: registries.flatMap((registry) => registry.uiDescriptors),
        activationTargets: registries.flatMap((registry) => registry.activationTargets),
        hookRegistrations: registries.flatMap((registry) => registry.hookRegistrations),
        surfaceHandlersByBackendId: new Map(),
        catalogEntriesById: Object.freeze({}),
        agentDefinitionsById: new Map(registries.flatMap((registry) => [...registry.agentDefinitionsById.entries()])),
        agentRuntimeDefinitionsById: new Map(registries.flatMap((registry) => [...registry.agentRuntimeDefinitionsById.entries()])),
        pluginDiagnosticsByPluginId: Object.freeze({}),
    };
}

function createDeferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((innerResolve, innerReject) => {
        resolve = innerResolve;
        reject = innerReject;
    });
    return { promise, resolve, reject };
}

type LazyActivationRegistry = Awaited<ReturnType<typeof activatePluginRuntimeRegistry>> & Readonly<{
    activatedPluginIds: ReadonlySet<string>;
    activatePluginsByEvent: (activationEvent: string) => Promise<readonly Readonly<{
        pluginId: string;
        diagnostics: readonly Readonly<{ code: string; message: string }>[];
    }>[]>;
}>;

describe('activatePluginRuntimeRegistry', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

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
                    title: 'acme.activated.action test action',
                    safety: 'safe',
                    surfaces: {
                        ui: false,
                        voice: false,
                        agent: true,
                        mcp: false,
                        cli: true,
                        rpc: false,
                        sdk: false,
                    },
                }),
            }),
        ]));
        expect(activatedWithFamilies.tools).toEqual([
            expect.objectContaining({
                pluginId: 'acme.activated',
                definition: expect.objectContaining({
                    id: 'acme.activated.tool',
                    name: 'acme_activated_tool',
                    surfaces: {
                        cli: true,
                        mcp: false,
                        agent: true,
                    },
                }),
            }),
        ]);
        expect(activatedWithFamilies.commands).toEqual([
            expect.objectContaining({
                pluginId: 'acme.activated',
                definition: expect.objectContaining({
                    id: 'acme.activated.command',
                    command: 'acme.activated.command',
                }),
            }),
        ]);
        const hookHandlers = activated.hookHandlersByHookId.get('session.message.send');
        expect(hookHandlers).toHaveLength(1);
        await expect(hookHandlers?.[0]?.handler({})).resolves.toBeUndefined();
        await expect(readFile(lifecycleMarkerPath, 'utf8')).resolves.toBe('activated\n');

        expect(activated.runtimeCoreHandlersByBackendId.get('acme.activated.backend')).toBeUndefined();
        expect(activated.agentRuntimesByAgentId.get('acme.activated.backend')).toMatchObject({
            pluginId: 'acme.activated',
            registration: expect.objectContaining({
                agentId: 'acme.activated.backend',
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
        await expect(readFile(lifecycleMarkerPath, 'utf8')).resolves.toBe('activated\ndeactivating\ndeactivated\n');
    });

    it('keeps onCommand-only plugins unloaded at startup and activates them on first command demand', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-plugin-lazy-command-'));
        const markerPath = join(root, 'activation.log');
        const commandId = 'acme.lazy.command';
        const manifestPath = await writeManifest(root, {
            id: 'acme.lazy',
            runtimeCapabilities: ['commands'],
            permissions: [],
            commandIds: [commandId],
        });
        const daemonEntryPath = join(root, 'daemon.mjs');
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

        const contributes = createContributes({
            pluginId: 'acme.lazy',
            manifestPath,
            daemonEntryPath,
            activationEvents: [`onCommand:${commandId}`],
        });
        const activated = await activatePluginRuntimeRegistry({
            contributes,
            generation: 31,
        }) as LazyActivationRegistry;

        expect(contributes.activationTargets.map((target) => target.pluginId)).toEqual(['acme.lazy']);
        expect(activated.activatedPluginIds.has('acme.lazy')).toBe(false);
        expect(activated.activatedPluginIds.size).toBeLessThan(contributes.activationTargets.length);
        expect(activated.actionHandlersByActionId.has(commandId)).toBe(false);
        await expect(readFile(markerPath, 'utf8')).rejects.toThrow();

        await expect(activated.activatePluginsByEvent(`onCommand:${commandId}`)).resolves.toEqual([
            {
                pluginId: 'acme.lazy',
                diagnostics: [],
            },
        ]);

        expect(activated.activatedPluginIds.has('acme.lazy')).toBe(true);
        expect(activated.actionHandlersByActionId.has(commandId)).toBe(true);
        await expect(readFile(markerPath, 'utf8')).resolves.toBe('activated\n');
        await expect(activated.actionHandlersByActionId.get(commandId)?.({
            actionId: commandId,
            pluginId: 'acme.lazy',
            input: { argv: ['--flag'] },
            context: { surface: 'cli' },
            provenance: {},
        })).resolves.toEqual({ ok: true, data: { argv: ['--flag'] } });
    });

    it('single-flights concurrent lazy activation demands for the same plugin', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-plugin-lazy-singleflight-'));
        const markerPath = join(root, 'activation.log');
        const commandId = 'acme.lazy.singleflight.command';
        const manifestPath = await writeManifest(root, {
            id: 'acme.lazy.singleflight',
            runtimeCapabilities: ['commands'],
            permissions: [],
            commandIds: [commandId],
        });
        const daemonEntryPath = join(root, 'daemon.mjs');
        await writeFile(
            daemonEntryPath,
            [
                'import { appendFile } from "node:fs/promises";',
                '',
                'export async function activate(api) {',
                `  await appendFile(${JSON.stringify(markerPath)}, "activated\\n", "utf8");`,
                '  await new Promise((resolve) => setTimeout(resolve, 50));',
                '  api.registerCommand({',
                `    id: ${JSON.stringify(commandId)},`,
                '    handler: async () => ({ ok: true, data: "singleflight" }),',
                '  });',
                '}',
                '',
            ].join('\n'),
            'utf8',
        );

        const activated = await activatePluginRuntimeRegistry({
            contributes: createContributes({
                pluginId: 'acme.lazy.singleflight',
                manifestPath,
                daemonEntryPath,
                activationEvents: [`onCommand:${commandId}`],
            }),
            generation: 32,
        }) as LazyActivationRegistry;

        const [first, second] = await Promise.all([
            activated.activatePluginsByEvent(`onCommand:${commandId}`),
            activated.activatePluginsByEvent(`onCommand:${commandId}`),
        ]);

        expect(first).toEqual([{ pluginId: 'acme.lazy.singleflight', diagnostics: [] }]);
        expect(second).toEqual([{ pluginId: 'acme.lazy.singleflight', diagnostics: [] }]);
        await expect(readFile(markerPath, 'utf8')).resolves.toBe('activated\n');
        expect(activated.activatedPluginIds.has('acme.lazy.singleflight')).toBe(true);
        expect(activated.actionHandlersByActionId.has(commandId)).toBe(true);
    });

    it('does not merge a lazy activation that completes after disposal begins', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-plugin-lazy-dispose-race-'));
        const commandId = 'acme.lazy.dispose.command';
        const manifestPath = await writeManifest(root, {
            id: 'acme.lazy.dispose',
            runtimeCapabilities: ['commands'],
            permissions: [],
            commandIds: [commandId],
        });
        const daemonEntryPath = join(root, 'daemon.mjs');
        const activationGate = createDeferred<void>();
        const globalWithGate = globalThis as typeof globalThis & {
            __HAPPIER_TEST_LAZY_ACTIVATION_GATE?: { promise: Promise<void> };
        };
        globalWithGate.__HAPPIER_TEST_LAZY_ACTIVATION_GATE = { promise: activationGate.promise };
        await writeFile(
            daemonEntryPath,
            [
                'export async function activate(api) {',
                '  await globalThis.__HAPPIER_TEST_LAZY_ACTIVATION_GATE.promise;',
                '  api.registerCommand({',
                `    id: ${JSON.stringify(commandId)},`,
                '    handler: async () => ({ ok: true, data: "late" }),',
                '  });',
                '}',
                '',
            ].join('\n'),
            'utf8',
        );

        try {
            const activated = await activatePluginRuntimeRegistry({
                contributes: createContributes({
                    pluginId: 'acme.lazy.dispose',
                    manifestPath,
                    daemonEntryPath,
                    activationEvents: [`onCommand:${commandId}`],
                }),
                generation: 35,
            }) as LazyActivationRegistry;

            const demand = activated.activatePluginsByEvent(`onCommand:${commandId}`);
            await Promise.resolve();
            await activated.dispose({ timeoutMs: 50 });
            activationGate.resolve();
            await expect(demand).resolves.toEqual([
                {
                    pluginId: 'acme.lazy.dispose',
                    diagnostics: [
                        expect.objectContaining({
                            code: 'plugin_activation_failed',
                            message: expect.stringMatching(/disposed/i),
                        }),
                    ],
                },
            ]);

            expect(activated.activatedPluginIds.has('acme.lazy.dispose')).toBe(false);
            expect(activated.actionHandlersByActionId.has(commandId)).toBe(false);
        } finally {
            delete globalWithGate.__HAPPIER_TEST_LAZY_ACTIVATION_GATE;
            activationGate.resolve();
        }
    });

    it('preserves ascending hook priority order after lazy onHook activation', async () => {
        const hookId = 'session.message.send';
        const writeLazyHookPlugin = async (params: Readonly<{
            pluginId: string;
            priority: number;
        }>) => {
            const root = await mkdtemp(join(tmpdir(), 'happier-plugin-lazy-hook-order-'));
            const manifestPath = await writeManifest(root, {
                id: params.pluginId,
                runtimeCapabilities: ['hooks'],
                permissions: [],
                hookIds: [hookId],
            });
            const daemonEntryPath = join(root, 'daemon.mjs');
            await writeFile(
                daemonEntryPath,
                [
                    'export async function activate(api) {',
                    '  api.registerHook({',
                    `    hookId: ${JSON.stringify(hookId)},`,
                    `    priority: ${params.priority},`,
                    '    handler: async () => undefined,',
                    '  });',
                    '}',
                    '',
                ].join('\n'),
                'utf8',
            );
            return createContributes({
                pluginId: params.pluginId,
                manifestPath,
                daemonEntryPath,
                activationEvents: [`onHook:${hookId}`],
            });
        };

        const activated = await activatePluginRuntimeRegistry({
            contributes: mergeContributes(
                await writeLazyHookPlugin({ pluginId: 'acme.lazy.hook.low', priority: 10 }),
                await writeLazyHookPlugin({ pluginId: 'acme.lazy.hook.high', priority: 20 }),
            ),
            generation: 34,
        }) as LazyActivationRegistry;

        expect(activated.hookHandlersByHookId.get(hookId)).toEqual(undefined);

        await activated.activatePluginsByEvent(`onHook:${hookId}`);

        expect(activated.hookHandlersByHookId.get(hookId)?.map((handler) => ({
            pluginId: handler.pluginId,
            priority: handler.priority,
        }))).toEqual([
            { pluginId: 'acme.lazy.hook.low', priority: 10 },
            { pluginId: 'acme.lazy.hook.high', priority: 20 },
        ]);
    });

    it('shares lazy activation failure diagnostics with all waiters without retrying failed plugins', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-plugin-lazy-failure-'));
        const markerPath = join(root, 'activation.log');
        const commandId = 'acme.lazy.failure.command';
        const manifestPath = await writeManifest(root, {
            id: 'acme.lazy.failure',
            runtimeCapabilities: ['commands'],
            permissions: [],
            commandIds: [commandId],
        });
        const daemonEntryPath = join(root, 'daemon.mjs');
        await writeFile(
            daemonEntryPath,
            [
                'import { appendFile } from "node:fs/promises";',
                '',
                'export async function activate() {',
                `  await appendFile(${JSON.stringify(markerPath)}, "activated\\n", "utf8");`,
                '  await new Promise((resolve) => setTimeout(resolve, 25));',
                '  throw new Error("activation exploded");',
                '}',
                '',
            ].join('\n'),
            'utf8',
        );

        const activated = await activatePluginRuntimeRegistry({
            contributes: createContributes({
                pluginId: 'acme.lazy.failure',
                manifestPath,
                daemonEntryPath,
                activationEvents: [`onCommand:${commandId}`],
            }),
            generation: 33,
        }) as LazyActivationRegistry;

        const [first, second] = await Promise.all([
            activated.activatePluginsByEvent(`onCommand:${commandId}`),
            activated.activatePluginsByEvent(`onCommand:${commandId}`),
        ]);

        const expectedDiagnostics = [
            expect.objectContaining({
                code: 'plugin_activation_failed',
                message: 'activation exploded',
            }),
        ];
        expect(first).toEqual([{ pluginId: 'acme.lazy.failure', diagnostics: expectedDiagnostics }]);
        expect(second).toEqual([{ pluginId: 'acme.lazy.failure', diagnostics: expectedDiagnostics }]);
        expect(activated.activatedPluginIds.has('acme.lazy.failure')).toBe(false);
        expect(activated.pluginDiagnosticsByPluginId['acme.lazy.failure']).toEqual(expectedDiagnostics);
        await expect(readFile(markerPath, 'utf8')).resolves.toBe('activated\n');

        await activated.activatePluginsByEvent(`onCommand:${commandId}`);

        await expect(readFile(markerPath, 'utf8')).resolves.toBe('activated\n');
        expect(activated.pluginDiagnosticsByPluginId['acme.lazy.failure']).toEqual(expectedDiagnostics);
    });

    it('loads a new-SDK fixture plugin and dispatches manifest-declared action, tool, and hook handlers', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-plugin-sdk-final-integration-'));
        const daemonEntryPath = join(root, 'daemon.mjs');
        const manifestPath = await writeManifest(root, {
            id: 'acme.sdk.final',
            runtimeCapabilities: ['actions', 'tools', 'hooks'],
            permissions: [],
            actionIds: ['acme.sdk.final.action'],
            toolIds: ['acme.sdk.final.tool'],
            hookIds: ['session.message.send'],
        });
        const { build } = await import('esbuild');
        await build({
            entryPoints: [
                fileURLToPath(new URL('./fixtures/newSdkActivationPlugin.ts', import.meta.url)),
            ],
            outfile: daemonEntryPath,
            platform: 'node',
            format: 'esm',
            bundle: false,
            logLevel: 'silent',
        });

        const activated = await activatePluginRuntimeRegistry({
            contributes: createContributes({
                pluginId: 'acme.sdk.final',
                manifestPath,
                daemonEntryPath,
            }),
            generation: 17,
        });

        expect(activated.pluginDiagnosticsByPluginId['acme.sdk.final']).toEqual([]);
        await expect(activated.actionHandlersByActionId.get('acme.sdk.final.action')?.({
            actionId: 'acme.sdk.final.action',
            pluginId: 'acme.sdk.final',
            input: { from: 'action' },
            context: { surface: 'cli' },
            provenance: {},
        })).resolves.toEqual({ ok: true, data: { kind: 'action', input: { from: 'action' } } });
        await expect(activated.actionHandlersByActionId.get('acme.sdk.final.tool')?.({
            actionId: 'acme.sdk.final.tool',
            pluginId: 'acme.sdk.final',
            input: { from: 'tool' },
            context: { surface: 'cli' },
            provenance: {},
        })).resolves.toEqual({ ok: true, data: { kind: 'tool', input: { from: 'tool' } } });
        await expect(activated.hookHandlersByHookId.get('session.message.send')?.[0]?.handler({
            payload: { from: 'hook' },
        })).resolves.toBeUndefined();
    });

    it('threads plugin-scoped context services to activated tool, action, and hook handlers', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-plugin-handler-services-'));
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-handler-services-home-'));
        const manifestPath = await writeManifest(root, {
            id: 'acme.handler-services',
            runtimeCapabilities: ['actions', 'tools', 'hooks'],
            permissions: [],
            actionIds: ['session_notes.list'],
            toolIds: ['session_notes_add'],
            hookIds: ['session.spawned'],
        });
        const daemonEntryPath = join(root, 'daemon.mjs');
        await writeFile(
            daemonEntryPath,
            [
                'export async function activate(api) {',
                '  api.registerTool({',
                '    id: "session_notes_add",',
                '    handler: async (request) => {',
                '      await request.context.storage.local.set("latestNote", request.input.note);',
                '      return { ok: true, data: { stored: await request.context.storage.local.get("latestNote") } };',
                '    },',
                '  });',
                '  api.registerAction({',
                '    id: "session_notes.list",',
                '    handler: async (request) => ({',
                '      ok: true,',
                '      data: {',
                '        stored: await request.context.storage.local.get("latestNote"),',
                '        hasSettings: !!request.context.settings,',
                '        hasLogger: !!request.context.logger,',
                '        hasEvents: !!request.context.events,',
                '      },',
                '    }),',
                '  });',
                '  api.registerHook({',
                '    hookId: "session.spawned",',
                '    handler: async (_payload, context) => {',
                '      await context.storage.local.set("spawnHook", context.hookId);',
                '      return await context.storage.local.get("spawnHook");',
                '    },',
                '  });',
                '}',
                '',
            ].join('\n'),
            'utf8',
        );

        const activated = await activatePluginRuntimeRegistry({
            contributes: createContributes({
                pluginId: 'acme.handler-services',
                manifestPath,
                daemonEntryPath,
            }),
            generation: 30,
            happyHomeDir,
        });

        expect(activated.pluginDiagnosticsByPluginId['acme.handler-services']).toEqual([]);
        await expect(activated.actionHandlersByActionId.get('session_notes_add')?.({
            actionId: 'session_notes_add',
            pluginId: 'acme.handler-services',
            input: { note: 'stored from tool handler' },
            context: { surface: 'agent' },
            provenance: {},
        })).resolves.toEqual({ ok: true, data: { stored: 'stored from tool handler' } });
        await expect(activated.actionHandlersByActionId.get('session_notes.list')?.({
            actionId: 'session_notes.list',
            pluginId: 'acme.handler-services',
            input: {},
            context: { surface: 'cli' },
            provenance: {},
        })).resolves.toEqual({
            ok: true,
            data: {
                stored: 'stored from tool handler',
                hasSettings: true,
                hasLogger: true,
                hasEvents: true,
            },
        });
        await expect(activated.hookHandlersByHookId.get('session.spawned')?.[0]?.handler({
            payload: {},
        })).resolves.toBe('session.spawned');
    });

    it('makes stale action, hook, and lifecycle handlers inert after registry disposal', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-plugin-stale-handles-'));
        const daemonEntryPath = join(root, 'daemon.mjs');
        const manifestPath = await writeManifest(root, {
            id: 'acme.stale',
            runtimeCapabilities: ['actions', 'hooks', 'lifecycle'],
            permissions: [],
            actionIds: ['acme.stale.action'],
            hookIds: ['session.message.send'],
            lifecycleHandlers: [{ id: 'acme.stale.deactivating', event: 'deactivating' }],
        });
        await writeFile(
            daemonEntryPath,
            [
                'export async function activate(api) {',
                '  api.registerAction({',
                '    id: "acme.stale.action",',
                '    handler: async () => ({ ok: true, data: "stale-action-ran" }),',
                '  });',
                '  api.registerHook({',
                '    hookId: "session.message.send",',
                '    handler: async () => ({ staleHookRan: true }),',
                '  });',
                '  api.registerLifecycleHandler({',
                '    id: "acme.stale.deactivating",',
                '    event: "deactivating",',
                '    handler: async () => ({ staleLifecycleRan: true }),',
                '  });',
                '}',
                '',
            ].join('\n'),
            'utf8',
        );

        const activated = await activatePluginRuntimeRegistry({
            contributes: createContributes({
                pluginId: 'acme.stale',
                manifestPath,
                daemonEntryPath,
            }),
            generation: 29,
        });

        const actionHandler = activated.actionHandlersByActionId.get('acme.stale.action');
        const hookHandler = activated.hookHandlersByHookId.get('session.message.send')?.[0]?.handler;
        const lifecycleHandler = activated.lifecycleHandlersByEvent.get('deactivating')?.[0]?.handler;
        expect(actionHandler).toEqual(expect.any(Function));
        expect(hookHandler).toEqual(expect.any(Function));
        expect(lifecycleHandler).toEqual(expect.any(Function));

        await expect(actionHandler?.({
            actionId: 'acme.stale.action',
            pluginId: 'acme.stale',
            input: {},
            context: { surface: 'cli' },
            provenance: {},
        })).resolves.toEqual({ ok: true, data: 'stale-action-ran' });
        await expect(hookHandler?.({ payload: { beforeDispose: true } })).resolves.toEqual({ staleHookRan: true });

        await activated.dispose();

        await expect(actionHandler?.({
            actionId: 'acme.stale.action',
            pluginId: 'acme.stale',
            input: {},
            context: { surface: 'cli' },
            provenance: {},
        })).rejects.toThrow(/no longer active/i);
        await expect(hookHandler?.({ payload: { afterDispose: true } })).rejects.toThrow(/no longer active/i);
        await expect(lifecycleHandler?.({
            event: 'deactivating',
            pluginId: 'acme.stale',
            generation: 29,
            provenance: {},
        })).rejects.toThrow(/no longer active/i);
    });

    it('preserves manifest permission scopes for network and process runtime services', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-plugin-scoped-policy-'));
        const manifestPath = await writeManifest(root, {
            id: 'acme.scoped',
            runtimeCapabilities: [],
            permissions: [{ capability: 'network', scope: 'https://api.example.test/v1' }, { capability: 'process.spawn', scope: '/usr/bin/git' }],
        });
        const daemonEntryPath = join(root, 'daemon.mjs');
        await writeFile(
            daemonEntryPath,
            [
                'export async function activate(api) {',
                '  void api;',
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
            permissions: [{ capability: 'process.spawn', scope: 'git' }, { capability: 'env', scope: 'HAPPIER_DECLARED_ENV' }, { capability: 'filesystem.read', scope: 'transcripts' }, { capability: 'filesystem.write', scope: 'artifacts' }],
        });
        const daemonEntryPath = join(root, 'daemon.mjs');
        await writeFile(
            daemonEntryPath,
            [
                'export async function activate(api) {',
                '  void api;',
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
                'export async function activate(api) {',
                '  void api;',
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

    it('fails closed when activation-time executable registrations exceed declared runtime capabilities', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-plugin-activation-policy-'));
        const manifestPath = await writeManifest(root, {
            id: 'acme.policy',
            runtimeCapabilities: [],
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
                code: 'plugin_runtime_capability_missing',
                message: expect.stringContaining("runtime capability 'tools'"),
            }),
        ]);
    });

    it('rejects activation-time executable and MCP registrations absent from the same manifest', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-plugin-activation-declared-ids-'));
        const manifestPath = await writeManifest(root, {
            id: 'acme.declared',
            runtimeCapabilities: ['tools', 'commands', 'hooks', 'lifecycle', 'mcp'],
            permissions: [],
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
                '      handler: async () => undefined,',
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

    it('rejects id-less lifecycle declarations before activation can bind them', async () => {
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

        expect(activated.pluginDiagnosticsByPluginId['acme.lifecycle.idless']).toEqual([
            expect.objectContaining({ code: 'plugin_manifest_semantic_invalid' }),
        ]);
        expect(activated.lifecycleHandlers).toEqual([]);
        await expect(readFile(markerPath, 'utf8')).rejects.toThrow();
    });

    it('binds explicit lifecycle declarations independent of registration order', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-plugin-idless-lifecycle-order-'));
        const markerPath = join(root, 'lifecycle.txt');
        const manifestPath = await writeManifest(root, {
            id: 'acme.lifecycle.order',
            runtimeCapabilities: ['lifecycle'],
            permissions: [],
            lifecycleHandlers: [
                { id: 'acme.lifecycle.order.activated', event: 'activated' },
                { id: 'acme.lifecycle.order.deactivating', event: 'deactivating' },
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
                '    id: "acme.lifecycle.order.deactivating",',
                '    event: "deactivating",',
                `    handler: async () => appendFile(${JSON.stringify(markerPath)}, "deactivating\\n"),`,
                '  });',
                '  api.registerLifecycleHandler({',
                '    id: "acme.lifecycle.order.activated",',
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
            'acme.lifecycle.order.deactivating',
            'acme.lifecycle.order.activated',
        ]);
        expect(activated.lifecycleHandlersByEvent.get('activated')?.[0]?.registrationId).toBe('acme.lifecycle.order.activated');
        expect(activated.lifecycleHandlersByEvent.get('deactivating')?.[0]?.registrationId).toBe('acme.lifecycle.order.deactivating');
        await expect(readFile(markerPath, 'utf8')).resolves.toBe('activated\n');

        await activated.dispose();

        await expect(readFile(markerPath, 'utf8')).resolves.toBe('activated\ndeactivating\n');
    });

    it('runs deactivating handlers before registered disposables and emits deactivated last', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-plugin-disposal-sequence-'));
        const markerPath = join(root, 'lifecycle.txt');
        const manifestPath = await writeManifest(root, {
            id: 'acme.lifecycle.sequence',
            runtimeCapabilities: ['lifecycle'],
            permissions: [],
            lifecycleHandlers: [
                { id: 'acme.lifecycle.sequence.deactivating', event: 'deactivating' },
                { id: 'acme.lifecycle.sequence.deactivated', event: 'deactivated' },
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
                '    id: "acme.lifecycle.sequence.deactivating",',
                '    event: "deactivating",',
                `    handler: async () => appendFile(${JSON.stringify(markerPath)}, "deactivating\\n"),`,
                '  });',
                '  api.registerLifecycleHandler({',
                '    id: "acme.lifecycle.sequence.deactivated",',
                '    event: "deactivated",',
                `    handler: async () => appendFile(${JSON.stringify(markerPath)}, "deactivated\\n"),`,
                '  });',
                '  api.onDispose(async () => {',
                `    await appendFile(${JSON.stringify(markerPath)}, "onDispose\\n");`,
                '  });',
                '}',
                '',
            ].join('\n'),
            'utf8',
        );

        const activated = await activatePluginRuntimeRegistry({
            contributes: createContributes({
                pluginId: 'acme.lifecycle.sequence',
                manifestPath,
                daemonEntryPath,
            }),
            generation: 18,
        });

        activated.addRuntimeDisposable('acme.lifecycle.sequence', async () => {
            const { appendFile } = await import('node:fs/promises');
            await appendFile(markerPath, 'runtimeDisposable\n');
        });

        await activated.dispose();

        await expect(readFile(markerPath, 'utf8')).resolves.toBe(
            'deactivating\nruntimeDisposable\nonDispose\ndeactivated\n',
        );
    });

    it('times out a hanging activation and continues activating sibling plugins', async () => {
        vi.useFakeTimers();

        const root = await mkdtemp(join(tmpdir(), 'happier-plugin-activation-timeout-'));
        const hangingActivationStarted = createDeferred<void>();
        const hanging = createContributes({
            pluginId: 'acme.activation.hangs',
            manifestPath: join(root, 'hanging-plugin.json'),
            daemonEntryPath: join(root, 'hanging-daemon.mjs'),
            sourceKind: 'bundled',
            provenance: 'first_party',
        });
        const sibling = createContributes({
            pluginId: 'acme.activation.sibling',
            manifestPath: join(root, 'sibling-plugin.json'),
            daemonEntryPath: join(root, 'sibling-daemon.mjs'),
            sourceKind: 'bundled',
            provenance: 'first_party',
        });

        const activationResult: {
            registry: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>> | null;
        } = {
            registry: null,
        };
        const activation = activatePluginRuntimeRegistry({
            contributes: mergeContributes(hanging, sibling),
            generation: 19,
            resolveActivationSource(target) {
                if (target.pluginId === 'acme.activation.hangs') {
                    return {
                        kind: 'bundled',
                        moduleId: '@happier-dev/plugins-acme.activation.hangs/daemon',
                        load: async () => ({
                            PLUGIN_MANIFEST: createPluginManifestV2Fixture({
                                schemaVersion: 2,
                                id: 'acme.activation.hangs',
                                version: '0.0.0',
                                displayName: 'acme.activation.hangs',
                                engines: { happier: '^0.0.0' },
                                uses: [],
                                entrypoints: { main: './daemon.mjs' },
                                permissions: { required: [], optional: [] },
                                contributes: {},
                            }),
                            activate: async () => {
                                hangingActivationStarted.resolve();
                                await new Promise<void>(() => {});
                            },
                        }),
                    };
                }
                if (target.pluginId === 'acme.activation.sibling') {
                    return {
                        kind: 'bundled',
                        moduleId: '@happier-dev/plugins-acme.activation.sibling/daemon',
                        load: async () => ({
                            PLUGIN_MANIFEST: createPluginManifestV2Fixture({
                                schemaVersion: 2,
                                id: 'acme.activation.sibling',
                                version: '0.0.0',
                                displayName: 'acme.activation.sibling',
                                engines: { happier: '^0.0.0' },
                                uses: ['actions'],
                                entrypoints: { main: './daemon.mjs' },
                                permissions: { required: [], optional: [] },
                                contributes: {
                                    actions: [
                                        {
                                            id: 'acme.activation.sibling.action',
                                            title: 'Sibling Action',
                                            scopes: ['global'],
                                            surfaces: ['cli'],
                                            placement: 'commandPalette',
                                            dangerLevel: 'safe',
                                            handler: {
                                                target: 'daemon',
                                                registrationId: 'acme.activation.sibling.action',
                                            },
                                        },
                                    ],
                                },
                            }),
                            activate: async (api: PluginApi) => {
                                api.registerAction({
                                    id: 'acme.activation.sibling.action',
                                    handler: async () => ({ ok: true, data: 'sibling' }),
                                });
                            },
                        }),
                    };
                }
                return null;
            },
        });
        void activation.then((registry) => {
            activationResult.registry = registry;
        });

        await hangingActivationStarted.promise;
        await vi.advanceTimersByTimeAsync(30_001);
        await vi.runOnlyPendingTimersAsync();
        for (let index = 0; index < 10; index += 1) {
            await Promise.resolve();
        }

        const registry = activationResult.registry;
        expect(registry).not.toBeNull();
        if (!registry) return;

        expect(registry.pluginDiagnosticsByPluginId['acme.activation.hangs']).toEqual([
            expect.objectContaining({
                code: 'plugin_activation_failed',
                message: expect.stringContaining('timed out'),
            }),
        ]);
        expect(registry.pluginDiagnosticsByPluginId['acme.activation.sibling']).toEqual([]);
        expect(registry.actionHandlersByActionId.has('acme.activation.sibling.action')).toBe(true);
    });

    it('bounds hanging deactivating handlers and disposers while sibling cleanup continues', async () => {
        vi.useFakeTimers();

        const root = await mkdtemp(join(tmpdir(), 'happier-plugin-disposal-timeout-'));
        const markerPath = join(root, 'cleanup.txt');
        const hangingRoot = join(root, 'hanging');
        const siblingRoot = join(root, 'sibling');
        await mkdir(hangingRoot, { recursive: true });
        await mkdir(siblingRoot, { recursive: true });
        const hangingManifestPath = await writeManifest(hangingRoot, {
            id: 'acme.cleanup.hangs',
            runtimeCapabilities: ['lifecycle'],
            permissions: [],
            lifecycleHandlers: [
                { id: 'acme.cleanup.hangs.deactivating', event: 'deactivating' },
                { id: 'acme.cleanup.hangs.deactivated', event: 'deactivated' },
            ],
        });
        const siblingManifestPath = await writeManifest(siblingRoot, {
            id: 'acme.cleanup.sibling',
            runtimeCapabilities: ['lifecycle'],
            permissions: [],
            lifecycleHandlers: [
                { id: 'acme.cleanup.sibling.deactivated', event: 'deactivated' },
            ],
        });
        const hangingDaemonEntryPath = join(hangingRoot, 'daemon.mjs');
        const siblingDaemonEntryPath = join(siblingRoot, 'daemon.mjs');

        await writeFile(
            hangingDaemonEntryPath,
            [
                'import { appendFile } from "node:fs/promises";',
                '',
                'export async function activate(api) {',
                '  api.registerLifecycleHandler({',
                '    id: "acme.cleanup.hangs.deactivating",',
                '    event: "deactivating",',
                '    handler: async () => {',
                `      await appendFile(${JSON.stringify(markerPath)}, "hangingDeactivating\\n");`,
                '      await new Promise(() => {});',
                '    },',
                '  });',
                '  api.registerLifecycleHandler({',
                '    id: "acme.cleanup.hangs.deactivated",',
                '    event: "deactivated",',
                `    handler: async () => appendFile(${JSON.stringify(markerPath)}, "hangingDeactivated\\n"),`,
                '  });',
                '  api.onDispose(async () => {',
                `    await appendFile(${JSON.stringify(markerPath)}, "hangingDispose\\n");`,
                '    await new Promise(() => {});',
                '  });',
                '}',
                '',
            ].join('\n'),
            'utf8',
        );
        await writeFile(
            siblingDaemonEntryPath,
            [
                'import { appendFile } from "node:fs/promises";',
                '',
                'export async function activate(api) {',
                '  api.registerLifecycleHandler({',
                '    id: "acme.cleanup.sibling.deactivated",',
                '    event: "deactivated",',
                `    handler: async () => appendFile(${JSON.stringify(markerPath)}, "siblingDeactivated\\n"),`,
                '  });',
                '  api.onDispose(async () => {',
                `    await appendFile(${JSON.stringify(markerPath)}, "siblingDispose\\n");`,
                '  });',
                '}',
                '',
            ].join('\n'),
            'utf8',
        );

        const activated = await activatePluginRuntimeRegistry({
            contributes: mergeContributes(
                createContributes({
                    pluginId: 'acme.cleanup.sibling',
                    manifestPath: siblingManifestPath,
                    daemonEntryPath: siblingDaemonEntryPath,
                }),
                createContributes({
                    pluginId: 'acme.cleanup.hangs',
                    manifestPath: hangingManifestPath,
                    daemonEntryPath: hangingDaemonEntryPath,
                }),
            ),
            generation: 20,
        });

        let disposed = false;
        const disposal = activated.dispose({ timeoutMs: 50 }).then(() => {
            disposed = true;
        });

        await vi.advanceTimersByTimeAsync(50);
        await vi.advanceTimersByTimeAsync(50);
        await disposal;

        expect(disposed).toBe(true);
        await expect(readFile(markerPath, 'utf8')).resolves.toBe(
            'hangingDeactivating\nhangingDispose\nsiblingDispose\nsiblingDeactivated\n',
        );
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
                            uses: ['actions'],
                            entrypoints: { main: './daemon.mjs' },
                            permissions: {
                                required: [],
                                optional: [],
                            },
                                contributes: {
                                    actions: [
                                        {
                                            id: 'acme.activated.action',
                                            title: 'Activated Action',
                                            description: 'Manifest-owned bundled action metadata',
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
                                    handler: async () => ({ ok: true, data: 'activated-action-result' }),
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
                    title: 'Activated Action',
                    description: 'Manifest-owned bundled action metadata',
                    safety: 'safe',
                    surfaces: expect.objectContaining({
                        cli: true,
                    }),
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
                            uses: ['actions', 'tools', 'commands', 'hooks', 'lifecycle'],
                            entrypoints: { main: './daemon.mjs' },
                            permissions: {
                                required: [],
                                optional: [],
                            },
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
                                        surfaces: ['cli'],
                                        promptSnippet: 'Use happier_agent_activated_tool when the activated plugin can help.',
                                        promptGuidelines: [
                                            'Prefer this activated plugin tool for first-party provenance checks.',
                                        ],
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
                                handler: async () => ({ ok: true, data: 'activated-action-result' }),
                            });
                            api.registerTool({
                                id: toolId,
                                handler: async () => ({ ok: true, data: 'activated-tool-result' }),
                            });
                            api.registerCommand({
                                id: commandId,
                                handler: async () => ({ ok: true, data: 'activated-command-result' }),
                            });
                            api.registerHook({
                                hookId: 'session.message.send',
                                handler: async () => undefined,
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
                definition: expect.objectContaining({
                    promptSnippet: 'Use happier_agent_activated_tool when the activated plugin can help.',
                    promptGuidelines: [
                        'Prefer this activated plugin tool for first-party provenance checks.',
                    ],
                }),
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

    it('records a diagnostic when multiple plugins register agent runtimes with the same agentId and keeps the first registration', async () => {
        const agentId = 'acme.shared.agent';
        const first = await writeActivationModuleWithAgentRuntime({
            pluginId: 'acme.dupe.a',
            agentId,
        });
        const second = await writeActivationModuleWithAgentRuntime({
            pluginId: 'acme.dupe.b',
            agentId,
        });

        const contributes: ResolvedContributionRegistry = {
            ...createContributes({
                pluginId: 'acme.dupe.a',
                manifestPath: first.manifestPath,
                daemonEntryPath: first.daemonEntryPath,
            }),
            agents: [
                ...createContributes({
                    pluginId: 'acme.dupe.a',
                    manifestPath: first.manifestPath,
                    daemonEntryPath: first.daemonEntryPath,
                }).agents,
                ...createContributes({
                    pluginId: 'acme.dupe.b',
                    manifestPath: second.manifestPath,
                    daemonEntryPath: second.daemonEntryPath,
                }).agents,
            ],
            agentRuntimes: [
                ...createContributes({
                    pluginId: 'acme.dupe.a',
                    manifestPath: first.manifestPath,
                    daemonEntryPath: first.daemonEntryPath,
                }).agentRuntimes,
                ...createContributes({
                    pluginId: 'acme.dupe.b',
                    manifestPath: second.manifestPath,
                    daemonEntryPath: second.daemonEntryPath,
                }).agentRuntimes,
            ],
            agentDefinitionsById: new Map([
                ...createContributes({
                    pluginId: 'acme.dupe.a',
                    manifestPath: first.manifestPath,
                    daemonEntryPath: first.daemonEntryPath,
                }).agentDefinitionsById.entries(),
                ...createContributes({
                    pluginId: 'acme.dupe.b',
                    manifestPath: second.manifestPath,
                    daemonEntryPath: second.daemonEntryPath,
                }).agentDefinitionsById.entries(),
            ]),
            agentRuntimeDefinitionsById: new Map([
                ...createContributes({
                    pluginId: 'acme.dupe.a',
                    manifestPath: first.manifestPath,
                    daemonEntryPath: first.daemonEntryPath,
                }).agentRuntimeDefinitionsById.entries(),
                ...createContributes({
                    pluginId: 'acme.dupe.b',
                    manifestPath: second.manifestPath,
                    daemonEntryPath: second.daemonEntryPath,
                }).agentRuntimeDefinitionsById.entries(),
            ]),
        };

        const activated = await activatePluginRuntimeRegistry({
            contributes,
            generation: 1,
        });

        expect(activated.agentRuntimesByAgentId.get(agentId)?.pluginId).toBe('acme.dupe.a');
        expect(activated.pluginDiagnosticsByPluginId['acme.dupe.a'] ?? []).toEqual(expect.arrayContaining([
            expect.objectContaining({
                code: 'plugin_agent_runtime_duplicate_agent_id',
            }),
        ]));
        expect(activated.pluginDiagnosticsByPluginId['acme.dupe.b'] ?? []).toEqual(expect.arrayContaining([
            expect.objectContaining({
                code: 'plugin_agent_runtime_duplicate_agent_id',
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
        expect(activated.agentRuntimesByAgentId.get('acme.auto.backend')).toEqual(expect.objectContaining({
            pluginId: 'acme.auto.acp',
            registration: expect.objectContaining({
                agentId: 'acme.auto.backend',
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
