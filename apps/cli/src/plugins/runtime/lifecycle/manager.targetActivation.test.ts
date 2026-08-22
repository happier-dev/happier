import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import type { PluginApi, PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { createPluginRegistrationScope } from '@happier-dev/plugin-sdk/host/registration';
import type {
    TargetPluginInterceptedRequest as PluginInterceptedRequest,
} from './contributions/targetRequestInterceptors';

import type { ResolvedContributionRegistry } from '../../projection/registry/types';
import type { ResolvedExecutablePluginRuntimeRegistry } from '../resolveExecutablePluginRuntimeRegistry';
import { createUnavailablePluginServices } from '../invocation/services/unavailable';
import { createPluginReloadController } from '../reload/controller';
import { ingestCanonicalPluginManifest } from '../../manifest/ingest';
import {
    createLocalPathPluginDistributionIdentity,
    createPluginTrustRecord,
} from '../../store/install/trustIdentity';
import { activatePluginRuntimeRegistry } from './manager';
import type { PluginContributionActivationDemand } from './activation/targets';

type TargetPluginRegistrationApi = ReturnType<typeof createPluginRegistrationScope>['api'];

async function createCommittedFileBackedFixtureActivationSource(params: Readonly<{
    pluginId: string;
    root: string;
    entryPath: string;
}>) {
    const distribution = await createLocalPathPluginDistributionIdentity(params.root);
    const trust = createPluginTrustRecord({
        pluginId: params.pluginId,
        distribution,
        approvedAtMs: 1,
    });
    return () => ({
        kind: 'file_backed' as const,
        entryPath: params.entryPath,
        trustPolicy: 'prompt' as const,
        committedAuthorization: {
            pluginId: params.pluginId,
            immutableGenerationId: `fixture:${params.pluginId}`,
            distribution,
            trust,
            isCurrent: async () => true,
        },
    });
}

describe('target activation publication', () => {
    it('projects required HostAccess directly for static daemon consumers without a legacy grant map', async () => {
        const pluginId = 'acme.host-access-projection';
        const ingested = ingestCanonicalPluginManifest({
            schemaVersion: 2,
            id: pluginId,
            version: '1.0.0',
            displayName: 'Host access projection',
            engines: { happier: '^0.2.0' },
            runtime: { apiVersion: 1 },
            entrypoints: { daemon: './daemon.mjs' },
            hostAccess: {
                required: [
                    {
                        id: 'workspace-read',
                        capability: 'filesystem',
                        reason: 'Observe a bounded workspace subtree.',
                        scope: {
                            locations: [{ root: 'workspace', pathPrefix: 'observed' }],
                            access: ['read'],
                        },
                    },
                    {
                        id: 'plugin-data-read',
                        capability: 'filesystem',
                        reason: 'Read plugin-local state through normal invocation services.',
                        scope: {
                            locations: [{ root: 'pluginData', pathPrefix: 'state' }],
                            access: ['read'],
                        },
                    },
                    {
                        id: 'runtime-environment',
                        capability: 'environment',
                        reason: 'Pass the declared environment variable to an SCM operation.',
                        scope: { keys: ['FORGE_TOKEN'] },
                    },
                    {
                        id: 'runtime-process',
                        capability: 'process',
                        reason: 'Run the declared executable with its declared variable.',
                        scope: { executables: [{ kind: 'systemTool', id: 'forge' }], envKeys: ['FORGE_REGION'] },
                    },
                ],
                optional: [],
            },
            contributes: {
                actions: [{
                    id: 'run', title: 'Run', scopes: ['global'], surfaces: ['cli'],
                    execution: { target: 'daemon' },
                    placementBindings: ['primary'], dangerLevel: 'safe',
                }],
                systemTools: [{ id: 'forge', title: 'Forge', executableNames: ['forge'] }],
            },
        });
        if (!ingested.ok) throw new Error(ingested.diagnostics.map((item) => item.message).join('\n'));

        const activated = await activatePluginRuntimeRegistry({
            contributes: {
                agents: [], actions: [], resources: [],
                activationTargets: [{
                    provenance: 'external', source: { kind: 'path' }, pluginId,
                    manifestPath: '/virtual/happier.plugin.json', daemonEntryPath: '/virtual/daemon.mjs',
                    sourceSpec: { kind: 'path', locator: '/virtual', trustPolicy: 'local_trusted', installPolicy: 'copy' },
                    activationEvents: [], manifest: ingested.manifest,
                }],
                catalogEntriesById: Object.freeze({}),
                agentDefinitionsById: new Map(),
                pluginDiagnosticsByPluginId: Object.freeze({}),
            } as unknown as ResolvedContributionRegistry,
            generation: 24,
            resolveActivationSource: () => ({
                kind: 'bundled',
                moduleId: '@happier-dev/host-access-projection',
                load: async () => ({
                    activate(api: PluginApi) {
                        api.actions.register('run', async () => ({ ok: true }));
                    },
                }),
            }),
        });

        try {
            await activated.activatePluginsForValidation([pluginId]);
            expect(activated).not.toHaveProperty('permissionsByPluginId');
            expect(activated.filesystemReadAllowedPathsByPluginId.get(pluginId))
                .toEqual(new Set(['observed']));
            expect(activated.envAllowedNamesByPluginId.get(pluginId))
                .toEqual(new Set(['FORGE_REGION', 'FORGE_TOKEN']));
        } finally {
            await activated.dispose();
        }
    });

    it.each([
        ['admits', 'manual', 'active'],
        ['rejects before publication', 'oauthDeviceCode', 'unavailable'],
    ] as const)(
        '%s an external Connected Account runtime only when it matches its declared authentication mode',
        async (_expectation, runtimeKind, expectedStatus) => {
            const pluginId = expectedStatus === 'active'
                ? 'acme.external.accounts.matched'
                : 'acme.external.accounts.mismatch';
            const ingested = ingestCanonicalPluginManifest({
                schemaVersion: 2,
                id: pluginId,
                version: '1.0.0',
                displayName: 'External account fixture',
                engines: { happier: '^0.2.0' },
                runtime: { apiVersion: 1 },
                entrypoints: { daemon: './daemon.mjs' },
                contributes: {
                    connectedAccountDescriptors: [{
                        id: 'forge',
                        title: 'Forge account',
                        authentication: {
                            defaultModeId: 'manual',
                            modes: [{
                                id: 'manual',
                                kind: 'manual',
                                outcomeReconciliation: 'none',
                                fields: [{
                                    id: 'token',
                                    title: 'Token',
                                    schema: { type: 'string' },
                                    secret: true,
                                }],
                            }],
                        },
                    }],
                },
            });
            if (!ingested.ok) throw new Error(ingested.diagnostics.map((item) => item.message).join('\n'));
            const activate = vi.fn((api: PluginApi) => {
                api.connectedAccounts.register('forge', {
                    authentication: {
                        modes: {
                            manual: runtimeKind === 'manual'
                                ? {
                                    kind: 'manual',
                                    async complete() { return { status: 'rejected' as const }; },
                                }
                                : {
                                    kind: 'oauthDeviceCode',
                                    async begin() { return { status: 'failed' as const }; },
                                    async poll() { return { status: 'failed' as const }; },
                                    async cancel() {},
                                },
                        },
                    },
                    async refresh() { return { status: 'connected' as const }; },
                    async revoke() { return { status: 'remoteUnsupported' as const }; },
                    async status() { return { status: 'connected' as const }; },
                    async materialize() { return { kind: 'environment' as const, env: {} }; },
                } as never);
            });
            const activated = await activatePluginRuntimeRegistry({
                contributes: {
                    agents: [], actions: [], resources: [],
                    activationTargets: [{
                        provenance: 'external', source: { kind: 'path' }, pluginId,
                        manifestPath: '/virtual/happier.plugin.json',
                        daemonEntryPath: '/virtual/daemon.mjs',
                        sourceSpec: {
                            kind: 'path', locator: '/virtual', trustPolicy: 'prompt', installPolicy: 'copy',
                        },
                        activationEvents: [], manifest: ingested.manifest,
                    }],
                    catalogEntriesById: Object.freeze({}),
                    agentDefinitionsById: new Map(),
                    pluginDiagnosticsByPluginId: Object.freeze({}),
                } as unknown as ResolvedContributionRegistry,
                generation: 23,
                resolveActivationSource: () => ({
                    kind: 'bundled',
                    moduleId: `@happier-dev/${pluginId}`,
                    load: async () => ({ activate }),
                }),
            });

            try {
                await activated.activatePluginsForValidation([pluginId]);
                expect(activated.targetActivationFacts).toEqual([
                    expect.objectContaining({ pluginId, status: expectedStatus }),
                ]);
                if (expectedStatus === 'active') {
                    expect(activated.targetRegistrations).toEqual([
                        expect.objectContaining({
                            pluginId,
                            registration: expect.objectContaining({
                                family: 'connectedAccountDescriptors',
                                localId: 'forge',
                            }),
                        }),
                    ]);
                } else {
                    expect(activated.targetRegistrations).toEqual([]);
                    expect(activated.activatedPluginIds.has(pluginId)).toBe(false);
                }
            } finally {
                await activated.dispose();
            }
        },
    );

    it('scopes a native activation module by its committed immutable generation', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-direct-activation-generation-'));
        const entryPath = join(root, 'daemon.mjs');
        const pluginId = 'acme.direct.activation';
        const evaluationCountKey = '__happierDirectActivationEvaluationCount';
        await writeFile(entryPath, [
            `globalThis[${JSON.stringify(evaluationCountKey)}] = (globalThis[${JSON.stringify(evaluationCountKey)}] ?? 0) + 1;`,
            'export function activate() {}',
            '',
        ].join('\n'));
        const ingested = ingestCanonicalPluginManifest({
            schemaVersion: 2,
            id: pluginId,
            version: '1.0.0',
            displayName: 'Direct activation',
            engines: { happier: '^0.2.0' },
            runtime: { apiVersion: 1 },
            entrypoints: { daemon: './daemon.mjs' },
            contributes: {},
        });
        if (!ingested.ok) {
            throw new Error(ingested.diagnostics.map((item) => item.message).join('\n'));
        }
        const createRegistry = () => ({
            agents: [], actions: [], resources: [],
            activationTargets: [{
                provenance: 'external', source: { kind: 'path' }, pluginId,
                manifestPath: join(root, 'happier.plugin.json'),
                daemonEntryPath: entryPath,
                sourceSpec: {
                    kind: 'path', locator: root, trustPolicy: 'prompt', installPolicy: 'copy',
                },
                activationEvents: ['startup'],
                manifest: ingested.manifest,
            }],
            catalogEntriesById: Object.freeze({}),
            agentDefinitionsById: new Map(),
            pluginDiagnosticsByPluginId: Object.freeze({}),
        } as unknown as ResolvedContributionRegistry);
        const resolveActivationSource =
            await createCommittedFileBackedFixtureActivationSource({
                pluginId,
                root,
                entryPath,
            });
        let first: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>> | null = null;
        let second: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>> | null = null;
        try {
            first = await activatePluginRuntimeRegistry({
                contributes: createRegistry(),
                generation: 19,
                resolveActivationSource,
            });
            await first.dispose();
            second = await activatePluginRuntimeRegistry({
                contributes: createRegistry(),
                generation: 20,
                resolveActivationSource,
            });
            expect(Reflect.get(globalThis, evaluationCountKey)).toBe(1);
        } finally {
            await second?.dispose();
            await first?.dispose();
            Reflect.deleteProperty(globalThis, evaluationCountKey);
        }
    });

    it.each(['moduleLoad', 'activate'] as const)('does not retry a failed startup %s attempt during validation of the same generation', async (failurePhase) => {
        const pluginId = 'acme.validation.failed-startup';
        const ingested = ingestCanonicalPluginManifest({
            schemaVersion: 2,
            id: pluginId,
            version: '2.0.0',
            displayName: 'Failed startup validation',
            engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
            entrypoints: { daemon: './daemon.mjs' },
            activation: { events: [{ kind: 'startup' }] },
            contributes: {
                actions: [{ id: 'run', title: 'Run', scopes: ['global'], surfaces: ['cli'], execution: { target: 'daemon' }, placementBindings: ['primary'], dangerLevel: 'safe' }],
            },
        });
        if (!ingested.ok) throw new Error(ingested.diagnostics.map((item) => item.message).join('\n'));
        const registry = {
            agents: [], actions: [], resources: [],
            activationTargets: [{
                provenance: 'first_party', source: { kind: 'bundled' }, pluginId,
                manifestPath: '/virtual/happier.plugin.json',
                daemonEntryPath: '/virtual/daemon.mjs',
                sourceSpec: { kind: 'package', locator: '@happier-dev/plugins-failed-startup', trustPolicy: 'bundled_trusted', installPolicy: 'copy' },
                activationEvents: ['startup'], manifest: ingested.manifest,
            }],
            catalogEntriesById: Object.freeze({}),
            agentDefinitionsById: new Map(),             pluginDiagnosticsByPluginId: Object.freeze({}),
        } as unknown as ResolvedContributionRegistry;
        const activate = vi.fn(() => {
            if (failurePhase === 'activate') throw new Error('rejected update');
        });
        const load = vi.fn(async () => {
            if (failurePhase === 'moduleLoad') throw new Error('rejected module');
            return { activate };
        });
        const activated = await activatePluginRuntimeRegistry({
            contributes: registry,
            generation: 14,
            resolveActivationSource: () => ({
                kind: 'bundled',
                moduleId: '@happier-dev/plugins-failed-startup/daemon',
                load,
            }),
        });

        expect(load).toHaveBeenCalledTimes(1);
        expect(activate).toHaveBeenCalledTimes(failurePhase === 'activate' ? 1 : 0);
        await activated.activatePluginsForValidation([pluginId]);
        expect(load).toHaveBeenCalledTimes(1);
        expect(activate).toHaveBeenCalledTimes(failurePhase === 'activate' ? 1 : 0);
        expect(activated.targetActivationFacts).toEqual([
            expect.objectContaining({ pluginId, status: 'unavailable' }),
        ]);
        await activated.dispose();
    });

    it('retries startup source preparation once so package-local preflight can isolate an aggregate failure', async () => {
        const pluginId = 'acme.validation.startup-preparation-isolation';
        const ingested = ingestCanonicalPluginManifest({
            schemaVersion: 2,
            id: pluginId,
            version: '2.0.0',
            displayName: 'Startup source preparation isolation',
            engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
            entrypoints: { daemon: './daemon.mjs' },
            activation: { events: [{ kind: 'startup' }] },
            contributes: {
                actions: [{ id: 'run', title: 'Run', scopes: ['global'], surfaces: ['cli'], execution: { target: 'daemon' }, placementBindings: ['primary'], dangerLevel: 'safe' }],
            },
        });
        if (!ingested.ok) throw new Error(ingested.diagnostics.map((item) => item.message).join('\n'));
        const registry = {
            agents: [], actions: [], resources: [],
            activationTargets: [{
                provenance: 'first_party', source: { kind: 'bundled' }, pluginId,
                manifestPath: '/virtual/happier.plugin.json',
                daemonEntryPath: '/virtual/daemon.mjs',
                sourceSpec: { kind: 'package', locator: '@happier-dev/plugins-startup-preparation-isolation', trustPolicy: 'bundled_trusted', installPolicy: 'copy' },
                activationEvents: ['startup'], manifest: ingested.manifest,
            }],
            catalogEntriesById: Object.freeze({}),
            agentDefinitionsById: new Map(),             pluginDiagnosticsByPluginId: Object.freeze({}),
        } as unknown as ResolvedContributionRegistry;
        const prepare = vi.fn()
            .mockRejectedValueOnce(new Error('bundled plugin workspace closure is stale'))
            .mockResolvedValueOnce(undefined);
        const activate = vi.fn((api: PluginApi) => {
            api.actions.register('run', async () => ({ ok: true }));
        });
        const load = vi.fn(async () => ({ activate }));
        const activated = await activatePluginRuntimeRegistry({
            contributes: registry,
            generation: 15,
            resolveActivationSource: () => ({
                kind: 'bundled',
                moduleId: '@happier-dev/plugins-startup-preparation-isolation/daemon',
                prepare,
                load,
            }),
        });

        expect(prepare).toHaveBeenCalledTimes(2);
        expect(load).toHaveBeenCalledTimes(1);
        expect(activate).toHaveBeenCalledTimes(1);
        expect(activated.activatedPluginIds.has(pluginId)).toBe(true);
        expect(activated.targetActivationFacts).toEqual([
            expect.objectContaining({ pluginId, status: 'active' }),
        ]);
        await activated.dispose();
    });

    it('retries lazy activation on later demand only after bounded package isolation also fails', async () => {
        const pluginId = 'acme.validation.retryable-preparation';
        const ingested = ingestCanonicalPluginManifest({
            schemaVersion: 2,
            id: pluginId,
            version: '2.0.0',
            displayName: 'Retryable source preparation',
            engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
            entrypoints: { daemon: './daemon.mjs' },
            contributes: {
                actions: [{ id: 'run', title: 'Run', scopes: ['global'], surfaces: ['cli'], execution: { target: 'daemon' }, placementBindings: ['primary'], dangerLevel: 'safe' }],
            },
        });
        if (!ingested.ok) throw new Error(ingested.diagnostics.map((item) => item.message).join('\n'));
        const registry = {
            agents: [], actions: [], resources: [],
            activationTargets: [{
                provenance: 'first_party', source: { kind: 'bundled' }, pluginId,
                manifestPath: '/virtual/happier.plugin.json',
                daemonEntryPath: '/virtual/daemon.mjs',
                sourceSpec: { kind: 'package', locator: '@happier-dev/plugins-retryable-preparation', trustPolicy: 'bundled_trusted', installPolicy: 'copy' },
                activationEvents: [], manifest: ingested.manifest,
            }],
            catalogEntriesById: Object.freeze({}),
            agentDefinitionsById: new Map(),             pluginDiagnosticsByPluginId: Object.freeze({}),
        } as unknown as ResolvedContributionRegistry;
        const prepare = vi.fn()
            .mockRejectedValueOnce(new Error('aggregate source-dev preparation selected package isolation'))
            .mockRejectedValueOnce(new Error('package-local source preparation is still unavailable'))
            .mockResolvedValueOnce(undefined);
        const activate = vi.fn((api: PluginApi) => {
            api.actions.register('run', async () => ({ ok: true }));
        });
        const load = vi.fn(async () => ({ activate }));
        const activated = await activatePluginRuntimeRegistry({
            contributes: registry,
            generation: 15,
            resolveActivationSource: () => ({
                kind: 'bundled',
                moduleId: '@happier-dev/plugins-retryable-preparation/daemon',
                prepare,
                load,
            }),
        });

        const demand = [{ pluginId, family: 'actions' as const, localId: 'run' }];
        const first = await activated.activateContributionsOnDemand(demand);

        expect(first).toEqual([expect.objectContaining({
            pluginId,
            diagnostics: [expect.objectContaining({
                code: 'plugin_daemon_module_load_failed',
                message: expect.stringContaining('package-local source preparation is still unavailable'),
            })],
        })]);
        expect(prepare).toHaveBeenCalledTimes(2);
        expect(load).not.toHaveBeenCalled();
        expect(activate).not.toHaveBeenCalled();
        expect(activated.targetActivationFacts).toEqual([]);

        await activated.activateContributionsOnDemand(demand);

        expect(prepare).toHaveBeenCalledTimes(3);
        expect(load).toHaveBeenCalledTimes(1);
        expect(activate).toHaveBeenCalledTimes(1);
        expect(activated.activatedPluginIds.has(pluginId)).toBe(true);
        expect(activated.targetActivationFacts).toEqual([
            expect.objectContaining({ pluginId, status: 'active' }),
        ]);
        await activated.dispose();
    });

    it('does not load or activate a lazy bundled target after disposal completes during source preparation', async () => {
        const pluginId = 'acme.validation.disposed-preparation';
        const ingested = ingestCanonicalPluginManifest({
            schemaVersion: 2,
            id: pluginId,
            version: '2.0.0',
            displayName: 'Disposed source preparation',
            engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
            entrypoints: { daemon: './daemon.mjs' },
            contributes: {
                actions: [{ id: 'run', title: 'Run', scopes: ['global'], surfaces: ['cli'], execution: { target: 'daemon' }, placementBindings: ['primary'], dangerLevel: 'safe' }],
            },
        });
        if (!ingested.ok) throw new Error(ingested.diagnostics.map((item) => item.message).join('\n'));
        const registry = {
            agents: [], actions: [], resources: [],
            activationTargets: [{
                provenance: 'first_party', source: { kind: 'bundled' }, pluginId,
                manifestPath: '/virtual/happier.plugin.json',
                daemonEntryPath: '/virtual/daemon.mjs',
                sourceSpec: { kind: 'package', locator: '@happier-dev/plugins-disposed-preparation', trustPolicy: 'bundled_trusted', installPolicy: 'copy' },
                activationEvents: [], manifest: ingested.manifest,
            }],
            catalogEntriesById: Object.freeze({}),
            agentDefinitionsById: new Map(),             pluginDiagnosticsByPluginId: Object.freeze({}),
        } as unknown as ResolvedContributionRegistry;
        let releasePreparation!: () => void;
        let markPreparationEntered!: () => void;
        const preparationGate = new Promise<void>((resolve) => { releasePreparation = resolve; });
        const preparationEntered = new Promise<void>((resolve) => { markPreparationEntered = resolve; });
        const prepare = vi.fn(async () => {
            markPreparationEntered();
            await preparationGate;
        });
        const activate = vi.fn((api: PluginApi) => {
            api.actions.register('run', async () => ({ ok: true }));
        });
        const load = vi.fn(async () => ({ activate }));
        const activated = await activatePluginRuntimeRegistry({
            contributes: registry,
            generation: 15,
            resolveActivationSource: () => ({
                kind: 'bundled',
                moduleId: '@happier-dev/plugins-disposed-preparation/daemon',
                prepare,
                load,
            }),
        });

        try {
            const demand = activated.activateContributionsOnDemand([{
                pluginId,
                family: 'actions',
                localId: 'run',
            }]);
            await preparationEntered;

            await activated.dispose();
            releasePreparation();
            await demand;

            expect(prepare).toHaveBeenCalledTimes(1);
            expect(load).not.toHaveBeenCalled();
            expect(activate).not.toHaveBeenCalled();
            expect(activated.targetActivationFacts).toEqual([]);
        } finally {
            releasePreparation();
            await activated.dispose();
        }
    });

    it('uses the contribution registration API for bundled targets', async () => {
        const ingested = ingestCanonicalPluginManifest({
            schemaVersion: 2, id: 'acme.target.bundled', version: '1.0.0', displayName: 'Bundled target',
            engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 }, entrypoints: { daemon: './missing.mjs' },
            hostAccess: {
                required: [
                    {
                        id: 'api', capability: 'network', reason: 'Call the fixture API.',
                        scope: { targets: [{ kind: 'fixedOrigin', origin: 'https://example.test' }], methods: ['POST'] },
                    },
                    {
                        id: 'external-session-files', capability: 'filesystem',
                        reason: 'Observe the declared workspace files.',
                        scope: {
                            locations: [{ root: 'workspace', pathPrefix: 'observed' }],
                            access: ['read'],
                        },
                    },
                    {
                        id: 'hosting-provider-environment', capability: 'environment',
                        reason: 'Pass the declared credential variable to the hosting provider.',
                        scope: { keys: ['FORGE_TOKEN'] },
                    },
                ],
                optional: [],
            },
            contributes: {
                actions: [{ id: 'run', title: 'Run', scopes: ['session'], surfaces: ['cli'], execution: { target: 'daemon' }, placementBindings: ['primary'], dangerLevel: 'safe' }],
                hooks: [{
                    id: 'after-spawn', on: 'session.spawned', category: 'lifecycle', scope: 'session',
                    executionKind: 'observe', priority: 12,
                }],
                mcp: {
                    servers: [],
                    discoverySources: [{ id: 'config', title: 'Config discovery' }],
                },
                scmBackends: [{
                    id: 'fixture', title: 'Fixture SCM', kind: 'git', capabilities: ['detect'],
                }],
                events: [{ id: 'review-ready-event', kind: 'event', title: 'Review ready' }],
                notifications: [{
                    id: 'review-ready', kind: 'activity', title: 'Review ready', eventIds: ['review-ready-event'],
                    defaultChannels: ['configured'],
                }],
                notificationChannels: [{
                    id: 'configured', kind: 'webhook', title: 'Configured delivery', configurable: true, defaultEnabled: true,
                }],
                systemTools: [{ id: 'fixture-cli', title: 'Fixture CLI', executableNames: ['fixture'] }],
            },
        });
        if (!ingested.ok) throw new Error(ingested.diagnostics.map((item) => item.message).join('\n'));
        const registry = {
            agents: [], actions: [], resources: [],
            activationTargets: [{
                provenance: 'first_party', source: { kind: 'bundled' }, pluginId: 'acme.target.bundled',
                manifestPath: '/virtual/happier.plugin.json',
                daemonEntryPath: '/virtual/missing.mjs',
                sourceSpec: { kind: 'package', locator: '@happier-dev/plugins-target-bundled', trustPolicy: 'bundled_trusted', installPolicy: 'copy' },
                activationEvents: [], manifest: ingested.manifest,
            }],
            catalogEntriesById: Object.freeze({}),
            agentDefinitionsById: new Map(),             pluginDiagnosticsByPluginId: Object.freeze({}),
        } as unknown as ResolvedContributionRegistry;

        const activated = await activatePluginRuntimeRegistry({
            contributes: registry,
            generation: 7,
            resolveActivationSource: () => ({
                kind: 'bundled',
                moduleId: '@happier-dev/plugins-target-bundled/daemon',
                load: async () => ({
                    activate(api: PluginApi) {
                        api.actions.register('run', async () => ({ ok: true }));
                        api.hooks.register('after-spawn', async () => ({ handled: true }));
                        api.mcp.registerDiscoverySource('config', async () => ({
                            items: [],
                            endpoints: [],
                        }));
                        api.scm.registerBackend('fixture', {
                            handlers: {
                                detection: {
                                    detectRepo: async ({ cwd }) => ({
                                        isRepo: true,
                                        rootPath: cwd,
                                        mode: '.git',
                                    }),
                                },
                            },
                        });
                        api.notifications.registerChannel('configured', async (request) => ({
                            deliveryId: request.deliveryId,
                            channelId: request.channelId,
                            status: 'accepted',
                            evidence: 'provider',
                        }));
                    },
                }),
            }),
        });

        expect(activated.targetActivationFacts).toEqual([]);
        await activated.activateContributionsOnDemand([{
            pluginId: 'acme.target.bundled',
            family: 'notificationChannels',
            localId: 'configured',
        }]);
        expect(activated.pluginDiagnosticsByPluginId['acme.target.bundled']).toEqual([]);
        expect(activated.targetRegistrations).toEqual([
            expect.objectContaining({
                pluginId: 'acme.target.bundled', generation: '7',
                registration: expect.objectContaining({ family: 'actions', localId: 'run' }),
            }),
            expect.objectContaining({
                pluginId: 'acme.target.bundled', generation: '7',
                registration: expect.objectContaining({ family: 'hooks', localId: 'after-spawn' }),
            }),
            expect.objectContaining({
                pluginId: 'acme.target.bundled', generation: '7',
                registration: expect.objectContaining({ family: 'mcp.discoverySources', localId: 'config' }),
            }),
            expect.objectContaining({
                pluginId: 'acme.target.bundled', generation: '7',
                registration: expect.objectContaining({ family: 'scmBackends', localId: 'fixture' }),
            }),
            expect.objectContaining({
                pluginId: 'acme.target.bundled', generation: '7',
                registration: expect.objectContaining({ family: 'notificationChannels', localId: 'configured' }),
            }),
        ]);
        expect(activated.targetActivationFacts).toEqual([
            expect.objectContaining({
                pluginId: 'acme.target.bundled', status: 'active',
                required: expect.arrayContaining([
                    { family: 'actions', localId: 'run' },
                    { family: 'hooks', localId: 'after-spawn' },
                    { family: 'mcp.discoverySources', localId: 'config' },
                    { family: 'scmBackends', localId: 'fixture' },
                    { family: 'notificationChannels', localId: 'configured' },
                ]),
                bound: expect.arrayContaining([
                    { family: 'actions', localId: 'run' },
                    { family: 'hooks', localId: 'after-spawn' },
                    { family: 'mcp.discoverySources', localId: 'config' },
                    { family: 'scmBackends', localId: 'fixture' },
                    { family: 'notificationChannels', localId: 'configured' },
                ]),
            }),
        ]);
        const hook = activated.hookHandlersByHookId.get('session.spawned')?.[0];
        expect(hook).toEqual(expect.objectContaining({
            pluginId: 'acme.target.bundled', hookId: 'session.spawned', priority: 12,
        }));
        await expect(hook?.handler({ payload: {} }, {})).resolves.toEqual({ handled: true });
        const scmBackend = activated.scmBackendsById.get('acme.target.bundled/fixture');
        expect(scmBackend).toEqual(expect.objectContaining({
            pluginId: 'acme.target.bundled',
            registration: expect.objectContaining({
                id: 'fixture',
                handlers: expect.objectContaining({ detection: expect.any(Object) }),
            }),
        }));
        await expect(scmBackend?.registration.handlers.detection?.detectRepo?.({ cwd: '/workspace' }))
            .resolves.toEqual({ isRepo: true, rootPath: '/workspace', mode: '.git' });
        expect(activated).not.toHaveProperty('permissionsByPluginId');
        expect(activated.filesystemReadAllowedPathsByPluginId.get('acme.target.bundled'))
            .toEqual(new Set(['observed']));
        expect(activated.envAllowedNamesByPluginId.get('acme.target.bundled'))
            .toEqual(new Set(['FORGE_TOKEN']));
        expect(activated.runtimeCapabilitiesByPluginId.get('acme.target.bundled')).toEqual(expect.any(Set));
        expect(activated.systemToolDefinitionsByPluginId.get('acme.target.bundled')).toEqual([
            expect.objectContaining({ id: 'fixture-cli' }),
        ]);
        await activated.dispose();
        expect(activated.targetRegistrations).toEqual([]);
        await expect(hook?.handler({ payload: {} }, {})).rejects.toThrow(/no longer active/);
        expect(() => scmBackend?.registration.handlers.detection?.detectRepo?.({ cwd: '/workspace' }))
            .toThrow(/no longer active/);
    });

    it('publishes an unavailable target fact when module loading fails before registration', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-target-load-failure-'));
        const ingested = ingestCanonicalPluginManifest({
            schemaVersion: 2, id: 'acme.target.load-failure', version: '2.0.0', displayName: 'Target',
            engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 }, entrypoints: { daemon: './missing.mjs' },
            contributes: {
                actions: [{ id: 'run', title: 'Run', scopes: ['session'], surfaces: ['cli'], execution: { target: 'daemon' }, placementBindings: ['primary'], dangerLevel: 'safe' }],
            },
        });
        if (!ingested.ok) throw new Error(ingested.diagnostics.map((item) => item.message).join('\n'));
        const registry = {
            agents: [], actions: [], resources: [],
            activationTargets: [{
                provenance: 'external', source: { kind: 'path' }, pluginId: 'acme.target.load-failure',
                manifestPath: join(root, 'happier.plugin.json'),
                daemonEntryPath: join(root, 'missing.mjs'),
                sourceSpec: { kind: 'path', locator: root, trustPolicy: 'local_trusted', installPolicy: 'link', devWatch: true },
                activationEvents: [], manifest: ingested.manifest,
            }],
            catalogEntriesById: Object.freeze({}),
            agentDefinitionsById: new Map(),             pluginDiagnosticsByPluginId: Object.freeze({}),
        } as unknown as ResolvedContributionRegistry;

        const activated = await activatePluginRuntimeRegistry({
            contributes: registry,
            generation: 6,
            resolveActivationSource: await createCommittedFileBackedFixtureActivationSource({
                pluginId: 'acme.target.load-failure',
                root,
                entryPath: join(root, 'missing.mjs'),
            }),
        });
        await activated.activateContributionsOnDemand([{
            pluginId: 'acme.target.load-failure', family: 'actions', localId: 'run',
        }]);

        expect(activated.targetActivationFacts).toMatchObject([{
            pluginId: 'acme.target.load-failure', pluginVersion: '2.0.0', source: 'development',
            generation: '6', host: 'daemon', platform: process.platform, occurredAtMs: expect.any(Number),
            status: 'unavailable',
            diagnostics: [expect.objectContaining({ code: 'plugin_source_missing' })],
        }]);
        const [fact] = activated.targetActivationFacts;
        expect(fact?.required).toEqual([{ family: 'actions', localId: 'run' }]);
        expect(fact?.bound).toEqual([]);
        expect(JSON.stringify(fact?.required)).not.toMatch(
            /target|realm|artifactId|requiredFields|promptAssetDescriptor/,
        );
        await activated.dispose();
    });

    it('does not load a lazy target before demand and single-flights concurrent activation', async () => {
        const ingested = ingestCanonicalPluginManifest({
            schemaVersion: 2, id: 'acme.target.lazy', version: '1.0.0', displayName: 'Lazy target',
            engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 }, entrypoints: { daemon: './daemon.mjs' },
            contributes: {
                actions: [{ id: 'run', title: 'Run', scopes: ['session'], execution: { target: 'daemon' }, surfaces: ['cli'], placementBindings: ['primary'], dangerLevel: 'safe' }],
            },
        });
        if (!ingested.ok) throw new Error(ingested.diagnostics.map((item) => item.message).join('\n'));
        const registry = {
            agents: [], actions: [], resources: [],
            activationTargets: [{
                provenance: 'first_party', source: { kind: 'bundled' }, pluginId: 'acme.target.lazy',
                manifestPath: '/virtual/happier.plugin.json',
                daemonEntryPath: '/virtual/daemon.mjs',
                sourceSpec: { kind: 'package', locator: '@happier-dev/plugins-target-lazy', trustPolicy: 'bundled_trusted', installPolicy: 'copy' },
                activationEvents: [], manifest: ingested.manifest,
            }],
            catalogEntriesById: Object.freeze({}),
            agentDefinitionsById: new Map(),             pluginDiagnosticsByPluginId: Object.freeze({}),
        } as unknown as ResolvedContributionRegistry;
        const activate = vi.fn((api: PluginApi) => {
            api.actions.register('run', async () => ({ ok: true }));
        });
        const load = vi.fn(async () => ({ activate }));

        const activated = await activatePluginRuntimeRegistry({
            contributes: registry,
            generation: 7,
            resolveActivationSource: () => ({
                kind: 'bundled',
                moduleId: '@happier-dev/plugins-target-lazy/daemon',
                load,
            }),
        });

        expect(load).not.toHaveBeenCalled();
        await Promise.all([
            activated.activateContributionsOnDemand([{ pluginId: 'acme.target.lazy', family: 'actions', localId: 'run' }]),
            activated.activateContributionsOnDemand([{ pluginId: 'acme.target.lazy', family: 'actions', localId: 'run' }]),
        ]);
        expect(load).toHaveBeenCalledTimes(1);
        expect(activate).toHaveBeenCalledTimes(1);
        expect(activated.activatedPluginIds.has('acme.target.lazy')).toBe(true);

        await activated.dispose();
    });

    it('keeps a public request-policy target dormant until exact demand and fences its published handler on disposal', async () => {
        const ingested = ingestCanonicalPluginManifest({
            schemaVersion: 2,
            id: 'acme.target.request-policy',
            version: '1.0.0',
            displayName: 'Request policy',
            engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
            entrypoints: { daemon: './daemon.mjs' },
            hostAccess: { required: [], optional: [] },
            contributes: {
                requestInterceptors: [{
                    id: 'authorize-api',
                    origins: ['https://api.example.test'],
                    methods: ['POST'],
                    priority: 10,
                }],
            },
        });
        if (!ingested.ok) throw new Error(ingested.diagnostics.map((item) => item.message).join('\n'));
        const registry = {
            agents: [], actions: [], resources: [],
            activationTargets: [{
                provenance: 'first_party', source: { kind: 'bundled' }, pluginId: 'acme.target.request-policy',
                manifestPath: '/virtual/happier.plugin.json',
                daemonEntryPath: '/virtual/daemon.mjs',
                sourceSpec: { kind: 'package', locator: '@happier-dev/plugins-target-request-policy', trustPolicy: 'bundled_trusted', installPolicy: 'copy' },
                activationEvents: [], manifest: ingested.manifest,
            }],
            catalogEntriesById: Object.freeze({}),
            agentDefinitionsById: new Map(),             pluginDiagnosticsByPluginId: Object.freeze({}),
        } as unknown as ResolvedContributionRegistry;
        const handler = vi.fn(async (request: PluginInterceptedRequest) => ({
            decision: 'continue' as const,
            request: Object.freeze({ ...request, headers: Object.freeze({ ...request.headers, authorization: 'Bearer fixture' }) }),
        }));
        const activate = vi.fn((api: TargetPluginRegistrationApi) => {
            api.interceptors.register('authorize-api', handler);
        });
        const load = vi.fn(async () => ({ activate }));
        const activated = await activatePluginRuntimeRegistry({
            contributes: registry,
            generation: 11,
            resolveActivationSource: () => ({
                kind: 'bundled',
                moduleId: '@happier-dev/plugins-target-request-policy/daemon',
                load,
            }),
        });

        expect(load).not.toHaveBeenCalled();
        expect(activated.requestInterceptors).toEqual([]);
        await Promise.all([
            activated.activateContributionsOnDemand([{
                pluginId: 'acme.target.request-policy', family: 'requestInterceptors', localId: 'authorize-api',
            }]),
            activated.activateContributionsOnDemand([{
                pluginId: 'acme.target.request-policy', family: 'requestInterceptors', localId: 'authorize-api',
            }]),
        ]);

        expect(load).toHaveBeenCalledTimes(1);
        expect(activate).toHaveBeenCalledTimes(1);
        expect(activated.requestInterceptors).toEqual([
            expect.objectContaining({
                pluginId: 'acme.target.request-policy',
                generation: '11',
                contribution: expect.objectContaining({ id: 'authorize-api' }),
            }),
        ]);
        const published = activated.requestInterceptors[0];
        if (!published) throw new Error('Expected a published request interceptor binding');
        const request: PluginInterceptedRequest = Object.freeze({
            url: 'https://api.example.test/data', method: 'POST', headers: Object.freeze({}),
        });
        const invocationContext = Object.freeze({}) as PluginInvocationContext;
        await expect(published.handler(request, invocationContext)).resolves.toEqual(expect.objectContaining({
            decision: 'continue',
            request: expect.objectContaining({ headers: expect.objectContaining({ authorization: 'Bearer fixture' }) }),
        }));

        await activated.dispose();
        expect(() => published.handler(request, invocationContext)).toThrow(/no longer active/);
    });

    it('fails closed for unqualified demand when plugins share a local contribution id', async () => {
        const createManifest = (pluginId: string) => ingestCanonicalPluginManifest({
            schemaVersion: 2,
            id: pluginId,
            version: '1.0.0',
            displayName: pluginId,
            engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
            entrypoints: { daemon: './daemon.mjs' },
            contributes: {
                actions: [{ id: 'run', title: 'Run', scopes: ['session'], surfaces: ['cli'], execution: { target: 'daemon' }, placementBindings: ['primary'], dangerLevel: 'safe' }],
            },
        });
        const alpha = createManifest('acme.target.alpha');
        const beta = createManifest('acme.target.beta');
        if (!alpha.ok || !beta.ok) throw new Error('Fixture manifests must be valid');
        const targets = [
            { pluginId: 'acme.target.alpha', manifest: alpha.manifest },
            { pluginId: 'acme.target.beta', manifest: beta.manifest },
        ].map(({ pluginId, manifest }) => ({
            provenance: 'first_party' as const,
            source: { kind: 'bundled' as const },
            pluginId,
            manifestPath: `/virtual/${pluginId}/happier.plugin.json`,
            daemonEntryPath: `/virtual/${pluginId}/daemon.mjs`,
            sourceSpec: { kind: 'package' as const, locator: `@happier-dev/${pluginId}`, trustPolicy: 'bundled_trusted' as const, installPolicy: 'copy' as const },
            activationEvents: [],
            manifest,
        }));
        const registry = {
            agents: [], actions: [], resources: [],
            activationTargets: targets,
            catalogEntriesById: Object.freeze({}),
            agentDefinitionsById: new Map(),             pluginDiagnosticsByPluginId: Object.freeze({}),
        } as unknown as ResolvedContributionRegistry;
        const alphaLoad = vi.fn(async () => ({
            activate(api: PluginApi) { api.actions.register('run', async () => ({ owner: 'alpha' })); },
        }));
        const betaLoad = vi.fn(async () => ({
            activate(api: PluginApi) { api.actions.register('run', async () => ({ owner: 'beta' })); },
        }));
        const activated = await activatePluginRuntimeRegistry({
            contributes: registry,
            generation: 8,
            resolveActivationSource: (target) => ({
                kind: 'bundled',
                moduleId: target.pluginId,
                load: target.pluginId === 'acme.target.alpha' ? alphaLoad : betaLoad,
            }),
        });

        const malformedDemand = {
            family: 'actions',
            localId: 'run',
        } as unknown as PluginContributionActivationDemand;
        await expect(activated.activateContributionsOnDemand([malformedDemand])).resolves.toEqual([]);
        expect(alphaLoad).not.toHaveBeenCalled();
        expect(betaLoad).not.toHaveBeenCalled();

        await activated.activateContributionsOnDemand([{
            pluginId: 'acme.target.beta',
            family: 'actions',
            localId: 'run',
        }]);
        expect(alphaLoad).not.toHaveBeenCalled();
        expect(betaLoad).toHaveBeenCalledTimes(1);
        await activated.dispose();
    });

    it('publishes target handlers only in the PluginInvocationContext registry', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-target-activation-'));
        const daemonEntryPath = join(root, 'daemon.mjs');
        await writeFile(daemonEntryPath, [
            'export function activate(api) {',
            '  api.actions.register("run", async () => ({ ok: true }));',
            '}',
        ].join('\n'));
        const ingested = ingestCanonicalPluginManifest({
            schemaVersion: 2, id: 'acme.target', version: '1.0.0', displayName: 'Target',
            engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 }, entrypoints: { daemon: './daemon.mjs' },
            contributes: {
                actions: [{ id: 'run', title: 'Run', scopes: ['session'], surfaces: ['cli'], execution: { target: 'daemon' }, placementBindings: ['primary'], dangerLevel: 'safe' }],
            },
        });
        if (!ingested.ok) throw new Error(ingested.diagnostics.map((item) => item.message).join('\n'));
        const registry = {
            agents: [], actions: [], resources: [],
            activationTargets: [{
                provenance: 'external', source: { kind: 'path' }, pluginId: 'acme.target',
                manifestPath: join(root, 'happier.plugin.json'), daemonEntryPath,
                sourceSpec: { kind: 'path', locator: root, trustPolicy: 'local_trusted', installPolicy: 'link' },
                activationEvents: [], manifest: ingested.manifest,
            }],
            catalogEntriesById: Object.freeze({}),
            agentDefinitionsById: new Map(),             pluginDiagnosticsByPluginId: Object.freeze({}),
        } as unknown as ResolvedContributionRegistry;

        const activated = await activatePluginRuntimeRegistry({
            contributes: registry,
            generation: 7,
            resolveActivationSource: await createCommittedFileBackedFixtureActivationSource({
                pluginId: 'acme.target',
                root,
                entryPath: daemonEntryPath,
            }),
        });
        await activated.activateContributionsOnDemand([{
            pluginId: 'acme.target', family: 'actions', localId: 'run',
        }]);

        expect(activated.targetRegistrations).toEqual([
            expect.objectContaining({
                pluginId: 'acme.target', generation: '7',
                registration: expect.objectContaining({ family: 'actions', localId: 'run' }),
            }),
        ]);
        expect(activated.targetActivationFacts).toEqual([
            expect.objectContaining({
                pluginVersion: '1.0.0',
                source: 'localPath',
                host: 'daemon',
                platform: process.platform,
                occurredAtMs: expect.any(Number),
                status: 'active',
                required: [{ family: 'actions', localId: 'run' }],
                bound: [{ family: 'actions', localId: 'run' }],
            }),
        ]);
        expect(activated.actions).toEqual([]);
        expect(activated.activatedPluginIds.has('acme.target')).toBe(true);
        await activated.dispose();
        expect(activated.targetRegistrations).toEqual([]);
    });

    it('single-flights concurrent disposal until target cleanup completes', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-target-disposal-singleflight-'));
        const daemonEntryPath = join(root, 'daemon.mjs');
        let releaseCleanup!: () => void;
        let markCleanupEntered!: () => void;
        const cleanupGate = new Promise<void>((resolve) => { releaseCleanup = resolve; });
        const cleanupEntered = new Promise<void>((resolve) => { markCleanupEntered = resolve; });
        const globalWithGate = globalThis as typeof globalThis & {
            __HAPPIER_TARGET_DISPOSAL_GATE?: Readonly<{
                entered(): void;
                promise: Promise<void>;
            }>;
        };
        globalWithGate.__HAPPIER_TARGET_DISPOSAL_GATE = {
            entered: markCleanupEntered,
            promise: cleanupGate,
        };
        await writeFile(daemonEntryPath, [
            'export function activate(api) {',
            '  api.actions.register("run", async () => ({ ok: true }));',
            '  return async () => {',
            '    globalThis.__HAPPIER_TARGET_DISPOSAL_GATE.entered();',
            '    await globalThis.__HAPPIER_TARGET_DISPOSAL_GATE.promise;',
            '  };',
            '}',
        ].join('\n'));
        const ingested = ingestCanonicalPluginManifest({
            schemaVersion: 2, id: 'acme.target.disposal', version: '1.0.0', displayName: 'Target',
            engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 }, entrypoints: { daemon: './daemon.mjs' },
            contributes: {
                actions: [{ id: 'run', title: 'Run', scopes: ['session'], surfaces: ['cli'], execution: { target: 'daemon' }, placementBindings: ['primary'], dangerLevel: 'safe' }],
            },
        });
        if (!ingested.ok) throw new Error(ingested.diagnostics.map((item) => item.message).join('\n'));
        const registry = {
            agents: [], actions: [], resources: [],
            activationTargets: [{
                provenance: 'external', source: { kind: 'path' }, pluginId: 'acme.target.disposal',
                manifestPath: join(root, 'happier.plugin.json'), daemonEntryPath,
                sourceSpec: { kind: 'path', locator: root, trustPolicy: 'local_trusted', installPolicy: 'link' },
                activationEvents: [], manifest: ingested.manifest,
            }],
            catalogEntriesById: Object.freeze({}),
            agentDefinitionsById: new Map(),             pluginDiagnosticsByPluginId: Object.freeze({}),
        } as unknown as ResolvedContributionRegistry;

        try {
            const activated = await activatePluginRuntimeRegistry({
                contributes: registry,
                generation: 8,
                resolveActivationSource: await createCommittedFileBackedFixtureActivationSource({
                    pluginId: 'acme.target.disposal',
                    root,
                    entryPath: daemonEntryPath,
                }),
            });
            await activated.activateContributionsOnDemand([{
                pluginId: 'acme.target.disposal', family: 'actions', localId: 'run',
            }]);
            const first = activated.dispose();
            await cleanupEntered;
            let secondSettled = false;
            const second = activated.dispose().then(() => { secondSettled = true; });
            await Promise.resolve();

            expect(secondSettled).toBe(false);
            releaseCleanup();
            await Promise.all([first, second]);
            expect(activated.targetRegistrations).toEqual([]);
        } finally {
            releaseCleanup();
            delete globalWithGate.__HAPPIER_TARGET_DISPOSAL_GATE;
        }
    });

    it('isolates a target cleanup failure and reports it once while retiring registrations', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-target-disposal-failure-'));
        const daemonEntryPath = join(root, 'daemon.mjs');
        await writeFile(daemonEntryPath, [
            'export function activate(api) {',
            '  api.actions.register("run", async () => ({ ok: true }));',
            '  return async () => { throw new Error("target cleanup failed"); };',
            '}',
        ].join('\n'));
        const ingested = ingestCanonicalPluginManifest({
            schemaVersion: 2, id: 'acme.target.cleanup-failure', version: '1.0.0', displayName: 'Target',
            engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 }, entrypoints: { daemon: './daemon.mjs' },
            contributes: {
                actions: [{ id: 'run', title: 'Run', scopes: ['session'], surfaces: ['cli'], execution: { target: 'daemon' }, placementBindings: ['primary'], dangerLevel: 'safe' }],
            },
        });
        if (!ingested.ok) throw new Error(ingested.diagnostics.map((item) => item.message).join('\n'));
        const registry = {
            agents: [], actions: [], resources: [],
            activationTargets: [{
                provenance: 'external', source: { kind: 'path' }, pluginId: 'acme.target.cleanup-failure',
                manifestPath: join(root, 'happier.plugin.json'), daemonEntryPath,
                sourceSpec: { kind: 'path', locator: root, trustPolicy: 'local_trusted', installPolicy: 'link' },
                activationEvents: [], manifest: ingested.manifest,
            }],
            catalogEntriesById: Object.freeze({}),
            agentDefinitionsById: new Map(),             pluginDiagnosticsByPluginId: Object.freeze({}),
        } as unknown as ResolvedContributionRegistry;
        const onError = vi.fn(() => {
            throw new Error('diagnostic sink failed');
        });
        const laterCleanup = vi.fn(async () => undefined);
        const activated = await activatePluginRuntimeRegistry({
            contributes: registry,
            generation: 9,
            resolveActivationSource: await createCommittedFileBackedFixtureActivationSource({
                pluginId: 'acme.target.cleanup-failure',
                root,
                entryPath: daemonEntryPath,
            }),
        });
        await activated.activateContributionsOnDemand([{
            pluginId: 'acme.target.cleanup-failure', family: 'actions', localId: 'run',
        }]);
        activated.addRuntimeDisposable('acme.other-cleanup', laterCleanup);

        await expect(activated.dispose({ onError })).resolves.toBeUndefined();

        expect(onError).toHaveBeenCalledTimes(1);
        expect(onError).toHaveBeenCalledWith(expect.objectContaining({
            pluginId: 'acme.target.cleanup-failure',
            phase: 'target_activation',
        }));
        expect(laterCleanup).toHaveBeenCalledTimes(1);
        expect(activated.targetRegistrations).toEqual([]);
    });

    it('bounds hanging target cleanup by default, diagnoses it, and continues later cleanup', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-target-disposal-timeout-'));
        const daemonEntryPath = join(root, 'daemon.mjs');
        await writeFile(daemonEntryPath, [
            'export function activate(api) {',
            '  api.actions.register("run", async () => ({ ok: true }));',
            '  return () => new Promise(() => undefined);',
            '}',
        ].join('\n'));
        const ingested = ingestCanonicalPluginManifest({
            schemaVersion: 2, id: 'acme.target.cleanup-timeout', version: '1.0.0', displayName: 'Target',
            engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 }, entrypoints: { daemon: './daemon.mjs' },
            contributes: {
                actions: [{ id: 'run', title: 'Run', scopes: ['session'], surfaces: ['cli'], execution: { target: 'daemon' }, placementBindings: ['primary'], dangerLevel: 'safe' }],
            },
        });
        if (!ingested.ok) throw new Error(ingested.diagnostics.map((item) => item.message).join('\n'));
        const registry = {
            agents: [], actions: [], resources: [],
            activationTargets: [{
                provenance: 'external', source: { kind: 'path' }, pluginId: 'acme.target.cleanup-timeout',
                manifestPath: join(root, 'happier.plugin.json'), daemonEntryPath,
                sourceSpec: { kind: 'path', locator: root, trustPolicy: 'local_trusted', installPolicy: 'link' },
                activationEvents: [], manifest: ingested.manifest,
            }],
            catalogEntriesById: Object.freeze({}),
            agentDefinitionsById: new Map(),             pluginDiagnosticsByPluginId: Object.freeze({}),
        } as unknown as ResolvedContributionRegistry;
        const onError = vi.fn();
        const laterCleanup = vi.fn(async () => undefined);
        const activated = await activatePluginRuntimeRegistry({
            contributes: registry,
            generation: 10,
            resolveActivationSource: await createCommittedFileBackedFixtureActivationSource({
                pluginId: 'acme.target.cleanup-timeout',
                root,
                entryPath: daemonEntryPath,
            }),
        });
        await activated.activateContributionsOnDemand([{
            pluginId: 'acme.target.cleanup-timeout', family: 'actions', localId: 'run',
        }]);
        activated.addRuntimeDisposable('acme.later-cleanup', laterCleanup);

        vi.useFakeTimers();
        try {
            const disposal = activated.dispose({ onError });
            await Promise.resolve();
            expect(laterCleanup).not.toHaveBeenCalled();

            await vi.advanceTimersByTimeAsync(5_000);
            await expect(disposal).resolves.toBeUndefined();

            expect(onError).toHaveBeenCalledWith(expect.objectContaining({
                pluginId: 'acme.target.cleanup-timeout',
                phase: 'target_activation',
                error: expect.objectContaining({ message: expect.stringMatching(/timed out after 5000ms/i) }),
            }));
            expect(laterCleanup).toHaveBeenCalledTimes(1);
            expect(activated.targetRegistrations).toEqual([]);
        } finally {
            vi.useRealTimers();
        }
    });

    it('settles only changed-plugin runtime disposables before successor publication', async () => {
        const contributes: ResolvedContributionRegistry = {
            agents: Object.freeze([]),
            actions: Object.freeze([]),
            resources: Object.freeze([]),
            activationTargets: Object.freeze([]),
            catalogEntriesById: Object.freeze({}),
            agentDefinitionsById: new Map(),
            pluginDiagnosticsByPluginId: Object.freeze({}),
        };
        const changedCleanup = vi.fn(async () => undefined);
        const retainedPeerCleanup = vi.fn(async () => undefined);
        const activated = await activatePluginRuntimeRegistry({
            contributes,
            generation: 11,
        });
        activated.addRuntimeDisposable('acme.changed', Object.freeze({
            dispose: changedCleanup,
        }));
        activated.addRuntimeDisposable('acme.retained-peer', Object.freeze({
            dispose: retainedPeerCleanup,
        }));

        activated.retireBackgroundServices(['acme.changed']);
        await activated.settleRetiredBackgroundServices(['acme.changed']);

        expect(changedCleanup).toHaveBeenCalledOnce();
        expect(retainedPeerCleanup).not.toHaveBeenCalled();

        await activated.dispose();
        expect(changedCleanup).toHaveBeenCalledOnce();
        expect(retainedPeerCleanup).toHaveBeenCalledOnce();
    });

    it('holds successor publication until the real changed-plugin runtime disposable settles', async () => {
        const pluginId = 'acme.changed';
        const contributes: ResolvedContributionRegistry = {
            agents: Object.freeze([]),
            actions: Object.freeze([]),
            resources: Object.freeze([]),
            activationTargets: Object.freeze([]),
            catalogEntriesById: Object.freeze({}),
            agentDefinitionsById: new Map(),
            pluginDiagnosticsByPluginId: Object.freeze({}),
        };
        const activated = await activatePluginRuntimeRegistry({
            contributes,
            generation: 12,
        });
        const events: string[] = [];
        let releaseCleanup!: () => void;
        const cleanupGate = new Promise<void>((resolve) => {
            releaseCleanup = resolve;
        });
        let markCleanupEntered!: () => void;
        const cleanupEntered = new Promise<void>((resolve) => {
            markCleanupEntered = resolve;
        });
        activated.addRuntimeDisposable(pluginId, Object.freeze({
            async dispose() {
                events.push('p-cleanup-start');
                markCleanupEntered();
                await cleanupGate;
                events.push('p-cleanup-end');
            },
        }));

        const executableRegistry = (
            dispose: () => Promise<void>,
        ): ResolvedExecutablePluginRuntimeRegistry => ({
            contributes,
            hookHandlersByHookId: new Map(),
            agentRuntimesByAgentId: new Map(),
            scmHostingProvidersById: new Map(),
            pluginDiagnosticsByPluginId: Object.freeze({}),
            activatedPluginIds: new Set([pluginId]),
            activateContributionsOnDemand: async () => [],
            resolvePromptAssetBlocks: async () => [],
            createAgentInvocationServices: async () => createUnavailablePluginServices(),
            retireConsumers: () => {},
            retirePluginConsumers: (pluginIds) => {
                activated.retireBackgroundServices(pluginIds);
            },
            settleRetiredBackgroundServices: async (pluginIds) => {
                await activated.settleRetiredBackgroundServices(pluginIds);
            },
            addRuntimeDisposable: activated.addRuntimeDisposable,
            dispose,
        });
        const previous = executableRegistry(async () => await activated.dispose());
        const replacementDispose = vi.fn(async () => undefined);
        const replacement = executableRegistry(replacementDispose);
        const controller = createPluginReloadController({
            resolveRuntimeRegistry: async () => previous,
        });
        const lease = await controller.acquireRuntimeRegistry();
        await lease.release();

        const adoption = controller.adoptPreparedRuntimeRegistry({
            registry: replacement,
            changedPluginIds: Object.freeze([pluginId]),
            durableRevision: 1,
            runningSessionDisposition: 'retainRunningSessions',
            beforePublish: async (_registry, publish) => {
                events.push('q-publish');
                publish();
            },
        });
        await cleanupEntered;

        expect(controller.getState().activeRegistry).toBe(previous);
        expect(events).toEqual(['p-cleanup-start']);
        expect(() => activated.addRuntimeDisposable(pluginId, Object.freeze({
            dispose: vi.fn(async () => undefined),
        }))).toThrow(/retired/i);

        releaseCleanup();
        await adoption;

        expect(events).toEqual([
            'p-cleanup-start',
            'p-cleanup-end',
            'q-publish',
        ]);
        expect(controller.getState().activeRegistry).toBe(replacement);
        await controller.shutdown({ timeoutMs: 0 });
        expect(replacementDispose).toHaveBeenCalledOnce();
    });
});
