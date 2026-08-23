import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ParsedPluginEventContributionV1 } from '@happier-dev/protocol';
import type { PluginAccountStorageScope } from '@happier-dev/plugin-sdk/storage';
import {
    createLoggerAndEventsAvailablePluginInvocationServiceBinding,
    createUnavailablePluginInvocationServiceBinding,
} from '../../invocation/services/factory';
import {
    createUnavailablePluginServices,
} from '../../invocation/services/unavailable';
import { createPluginInvocationPresentation } from '../../invocation/services/interactions';
import { createProductionPluginInvocationServiceOwners } from '../../invocation/services/production';
import { createPluginInvocationHostPolicyResolver } from '../../hostAccess/resolve';
import type { StablePluginAccountStorageHost } from '../../context/storage';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import { ingestCanonicalPluginManifest } from '@/plugins/manifest/ingest';
import { activatePluginRuntimeRegistry } from '../manager';
import type { TargetInvocationServiceOwner } from './targetHooks';
import { createBackgroundServiceRunnerHost } from './backgroundServices';

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((innerResolve) => {
        resolve = innerResolve;
    });
    return { promise, resolve };
}

function registration(
    localId: string,
    runner: Parameters<typeof createBackgroundServiceRunnerHost>[0]['registrations'][number]['runner'],
) {
    return Object.freeze({
        pluginId: 'acme.indexer',
        pluginVersion: '1.0.0',
        generation: 'generation-one',
        localId,
        runner,
    });
}

describe('background service runner host', () => {
    it('reports unavailable required HostAccess as a typed non-start', async () => {
        const runner = vi.fn(async () => {});
        const diagnostics: unknown[] = [];
        const host = createBackgroundServiceRunnerHost({
            registrations: [registration('network-supervisor', runner)],
            createContext() {
                return Object.freeze({
                    unavailable: Object.freeze({
                        code: 'plugin_host_access_service_unavailable',
                        hostAccessId: 'gateway',
                        status: 'unavailable',
                    }),
                });
            },
            onDiagnostic(event) {
                diagnostics.push(event);
            },
        });

        host.start();
        await Promise.resolve();

        expect(runner).not.toHaveBeenCalled();
        expect(diagnostics).toEqual([{
            code: 'background_service_unavailable',
            pluginId: 'acme.indexer',
            generation: 'generation-one',
            localId: 'network-supervisor',
            reason: {
                code: 'plugin_host_access_service_unavailable',
                hostAccessId: 'gateway',
                status: 'unavailable',
            },
        }]);
        await host.dispose();
    });

    it('does not start committed work when the daemon invocation-service owner is unavailable', async () => {
        const pluginId = 'acme.missing-invocation-services';
        const ingested = ingestCanonicalPluginManifest({
            schemaVersion: 2,
            id: pluginId,
            version: '1.0.0',
            displayName: 'Missing invocation services',
            engines: { happier: '^0.2.0' },
            runtime: { apiVersion: 1 },
            entrypoints: { daemon: './daemon.mjs' },
            contributes: { backgroundServices: [{ id: 'indexer' }] },
        }, { sourceProvenance: 'registryCustodied' });
        if (!ingested.ok) {
            throw new Error(ingested.diagnostics.map((item) => item.message).join('\n'));
        }
        const contributes = {
            agents: [],
            actions: [],
            resources: [],
            activationTargets: [{
                provenance: 'first_party',
                source: { kind: 'bundled' },
                pluginId,
                manifestPath: '/virtual/happier.plugin.json',
                daemonEntryPath: '/virtual/daemon.mjs',
                sourceSpec: {
                    kind: 'package',
                    locator: '@happier-dev/plugins-missing-invocation-services',
                    trustPolicy: 'bundled_trusted',
                    installPolicy: 'copy',
                },
                activationEvents: [],
                manifest: ingested.manifest,
            }],
            catalogEntriesById: Object.freeze({}),
            agentDefinitionsById: new Map(),
            pluginDiagnosticsByPluginId: Object.freeze({}),
        } as unknown as ResolvedContributionRegistry;
        const runner = vi.fn(async () => {});
        const activated = await activatePluginRuntimeRegistry({
            contributes,
            generation: 1,
            resolveActivationSource: () => ({
                kind: 'bundled',
                moduleId: '@happier-dev/plugins-missing-invocation-services/daemon',
                load: async () => ({
                    activate(api: { backgroundServices: { register(id: string, value: typeof runner): void } }) {
                        api.backgroundServices.register('indexer', runner);
                    },
                }),
            }),
        });

        activated.startAdoptedBackgroundServices();
        await Promise.resolve();

        expect(runner).not.toHaveBeenCalled();
        expect(activated.pluginDiagnosticsByPluginId[pluginId]).toContainEqual({
            code: 'plugin_activation_failed',
            message: expect.stringMatching(/invocation-service owner is unavailable/i),
        });
        await activated.dispose();
    });

    it('binds an adopted daemon background runner to its canonical network.client HostAccess policy', async () => {
        const pluginId = 'acme.background-host-access';
        const ingested = ingestCanonicalPluginManifest({
            schemaVersion: 2,
            id: pluginId,
            version: '1.0.0',
            displayName: 'Background HostAccess',
            engines: { happier: '^0.2.0' },
            runtime: { apiVersion: 1 },
            entrypoints: { daemon: './daemon.mjs' },
            hostAccess: {
                required: [{
                    id: 'gateway',
                    capability: 'network.client',
                    reason: 'Maintain the remote gateway WebSocket connection',
                    scope: {
                        targets: [{ kind: 'fixedOrigin', origin: 'https://gateway.example.test' }],
                        transports: ['websocket'],
                    },
                }],
                optional: [],
            },
            contributes: {
                backgroundServices: [{ id: 'gateway-supervisor' }],
            },
        }, { sourceProvenance: 'registryCustodied' });
        if (!ingested.ok) {
            throw new Error(ingested.diagnostics.map((item) => item.message).join('\n'));
        }
        const runner = vi.fn(async () => {});
        const policyCalls: Array<Readonly<{ target: unknown; context: unknown }>> = [];
        const policyBindings: ReturnType<typeof createUnavailablePluginInvocationServiceBinding>[] = [];
        const serviceBindings: ReturnType<typeof createUnavailablePluginInvocationServiceBinding>[] = [];
        let ordinaryBindingCalls = 0;
        const resolvePolicy = createPluginInvocationHostPolicyResolver({
            createServiceBinding(generation, id, requests) {
                return createLoggerAndEventsAvailablePluginInvocationServiceBinding(
                    generation,
                    id,
                    requests,
                );
            },
        });
        const invocationServices = {
            createOrdinaryServiceBinding() {
                ordinaryBindingCalls += 1;
                return createUnavailablePluginInvocationServiceBinding('1', 'ordinary-background-policy');
            },
            resolveInvocationHostPolicy(target, context) {
                policyCalls.push(Object.freeze({ target, context }));
                const resolved = resolvePolicy(target, context);
                policyBindings.push(resolved.serviceBinding);
                return resolved;
            },
            createServices(_seed, binding) {
                serviceBindings.push(binding);
                return createUnavailablePluginServices();
            },
        } satisfies TargetInvocationServiceOwner;
        const contributes = {
            agents: [],
            actions: [],
            resources: [],
            activationTargets: [{
                provenance: 'first_party',
                source: { kind: 'bundled' },
                pluginId,
                manifestPath: '/virtual/happier.plugin.json',
                daemonEntryPath: '/virtual/daemon.mjs',
                sourceSpec: {
                    kind: 'package',
                    locator: '@happier-dev/plugins-background-host-access',
                    trustPolicy: 'bundled_trusted',
                    installPolicy: 'copy',
                },
                activationEvents: [],
                manifest: ingested.manifest,
            }],
            catalogEntriesById: Object.freeze({}),
            agentDefinitionsById: new Map(),
            pluginDiagnosticsByPluginId: Object.freeze({}),
        } as unknown as ResolvedContributionRegistry;
        const activated = await activatePluginRuntimeRegistry({
            contributes,
            generation: 1,
            invocationServices,
            resolveActivationSource: () => ({
                kind: 'bundled',
                moduleId: '@happier-dev/plugins-background-host-access/daemon',
                load: async () => ({
                    activate(api: { backgroundServices: { register(id: string, value: typeof runner): void } }) {
                        api.backgroundServices.register('gateway-supervisor', runner);
                    },
                }),
            }),
        });

        activated.startAdoptedBackgroundServices();
        await vi.waitFor(() => expect(runner).toHaveBeenCalledOnce());

        expect(policyCalls).toEqual([{
            target: {
                pluginId,
                generation: '1',
                qualifiedId: `${pluginId}/backgroundServices/gateway-supervisor`,
            },
            context: expect.objectContaining({
                surface: 'background',
                hostAccessRequests: [
                    { request: ingested.manifest.hostAccess.required[0], required: true },
                ],
            }),
        }]);
        expect(policyCalls[0]?.context).not.toHaveProperty('executionRealm');
        expect(ordinaryBindingCalls).toBe(0);
        expect(serviceBindings).toEqual(policyBindings);
        expect(serviceBindings[0]).toMatchObject({
            availability: {
                http: 'available',
            },
            networkClientRequestIds: ['gateway'],
        });
        await activated.dispose();
    });

    it('binds an adopted daemon background runner to its canonical storage.account HostAccess policy', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-background-account-storage-'));
        const pluginId = 'acme.background-account-storage';
        const ingested = ingestCanonicalPluginManifest({
            schemaVersion: 2,
            id: pluginId,
            version: '1.0.0',
            displayName: 'Background Account storage',
            engines: { happier: '^0.2.0' },
            runtime: { apiVersion: 1 },
            entrypoints: { daemon: './daemon.mjs' },
            hostAccess: {
                required: [{
                    id: 'account-state',
                    capability: 'storage.account',
                    reason: 'Maintain the declared Account state.',
                    scope: { enabled: true },
                }],
                optional: [],
            },
            contributes: {
                backgroundServices: [{ id: 'account-state-supervisor' }],
            },
        }, { sourceProvenance: 'registryCustodied' });
        if (!ingested.ok) {
            throw new Error(ingested.diagnostics.map((item) => item.message).join('\n'));
        }
        const runner = vi.fn(async () => {});
        const policyCalls: Array<Readonly<{ target: unknown; context: unknown }>> = [];
        const policyBindings: unknown[] = [];
        const serviceBindings: unknown[] = [];
        let ordinaryBindingCalls = 0;
        const account = Object.freeze({ marker: 'background_account_storage_bound' }) as unknown as PluginAccountStorageScope;
        const bind = vi.fn(() => account);
        const accountStorage: StablePluginAccountStorageHost = Object.freeze({ bind });
        const owners = createProductionPluginInvocationServiceOwners({
            loggerSink: { write() {} },
            storagePaths: resolvePluginStorePaths({ happyHomeDir }),
            accountStorage,
        });
        const invocationServices = {
            createOrdinaryServiceBinding(...args: Parameters<typeof owners.createOrdinaryServiceBinding>) {
                ordinaryBindingCalls += 1;
                return owners.createOrdinaryServiceBinding(...args);
            },
            resolveInvocationHostPolicy(target, context) {
                policyCalls.push(Object.freeze({ target, context }));
                const resolved = owners.resolveInvocationHostPolicy(target, context);
                policyBindings.push(resolved.serviceBinding);
                return resolved;
            },
            createServices(seed, binding) {
                serviceBindings.push(binding);
                return owners.createServices(seed, binding);
            },
        } satisfies TargetInvocationServiceOwner;
        const contributes = {
            agents: [],
            actions: [],
            resources: [],
            activationTargets: [{
                provenance: 'first_party',
                source: { kind: 'bundled' },
                pluginId,
                manifestPath: '/virtual/happier.plugin.json',
                daemonEntryPath: '/virtual/daemon.mjs',
                sourceSpec: {
                    kind: 'package',
                    locator: '@happier-dev/plugins-background-account-storage',
                    trustPolicy: 'bundled_trusted',
                    installPolicy: 'copy',
                },
                activationEvents: [],
                manifest: ingested.manifest,
            }],
            catalogEntriesById: Object.freeze({}),
            agentDefinitionsById: new Map(),
            pluginDiagnosticsByPluginId: Object.freeze({}),
        } as unknown as ResolvedContributionRegistry;
        let activated: Awaited<ReturnType<typeof activatePluginRuntimeRegistry>> | null = null;
        try {
            activated = await activatePluginRuntimeRegistry({
                contributes,
                generation: 1,
                invocationServices,
                resolveActivationSource: () => ({
                    kind: 'bundled',
                    moduleId: '@happier-dev/plugins-background-account-storage/daemon',
                    load: async () => ({
                        activate(api: { backgroundServices: { register(id: string, value: typeof runner): void } }) {
                            api.backgroundServices.register('account-state-supervisor', runner);
                        },
                    }),
                }),
            });

            activated.startAdoptedBackgroundServices();
            await vi.waitFor(() => expect(runner).toHaveBeenCalledOnce());

            expect(policyCalls).toEqual([{
                target: {
                    pluginId,
                    generation: '1',
                    qualifiedId: `${pluginId}/backgroundServices/account-state-supervisor`,
                },
                context: expect.objectContaining({
                    surface: 'background',
                    hostAccessRequests: [
                        { request: ingested.manifest.hostAccess.required[0], required: true },
                    ],
                }),
            }]);
            expect(ordinaryBindingCalls).toBe(0);
            expect(serviceBindings).toEqual(policyBindings);
            expect(bind).toHaveBeenCalledOnce();
        } finally {
            await activated?.dispose();
            await owners.dispose();
            await rm(happyHomeDir, { recursive: true, force: true });
        }
    });

    it('does not enter an adopted runner when required HostAccess is unavailable', async () => {
        const pluginId = 'acme.background-required-host-access';
        const ingested = ingestCanonicalPluginManifest({
            schemaVersion: 2,
            id: pluginId,
            version: '1.0.0',
            displayName: 'Required background HostAccess',
            engines: { happier: '^0.2.0' },
            runtime: { apiVersion: 1 },
            entrypoints: { daemon: './daemon.mjs' },
            hostAccess: {
                required: [{
                    id: 'gateway',
                    capability: 'network',
                    reason: 'Maintain the remote gateway connection',
                    scope: {
                        targets: [{ kind: 'fixedOrigin', origin: 'https://gateway.example.test' }],
                    },
                }],
                optional: [],
            },
            contributes: { backgroundServices: [{ id: 'gateway-supervisor' }] },
        }, { sourceProvenance: 'registryCustodied' });
        if (!ingested.ok) {
            throw new Error(ingested.diagnostics.map((item) => item.message).join('\n'));
        }
        const runner = vi.fn(async () => {});
        const policyBinding = createUnavailablePluginInvocationServiceBinding('1', 'required-background-policy');
        let policyCalls = 0;
        const resolvePolicy = createPluginInvocationHostPolicyResolver({
            createServiceBinding: () => policyBinding,
        });
        const invocationServices = {
            createOrdinaryServiceBinding() {
                throw new Error('Declared HostAccess must not use the ordinary binding');
            },
            resolveInvocationHostPolicy(_target, context) {
                policyCalls += 1;
                return resolvePolicy(_target, context);
            },
            createServices() {
                throw new Error('Unavailable required HostAccess must prevent service construction');
            },
        } satisfies TargetInvocationServiceOwner;
        const contributes = {
            agents: [],
            actions: [],
            resources: [],
            activationTargets: [{
                provenance: 'first_party',
                source: { kind: 'bundled' },
                pluginId,
                manifestPath: '/virtual/happier.plugin.json',
                daemonEntryPath: '/virtual/daemon.mjs',
                sourceSpec: {
                    kind: 'package',
                    locator: '@happier-dev/plugins-background-required-host-access',
                    trustPolicy: 'bundled_trusted',
                    installPolicy: 'copy',
                },
                activationEvents: [],
                manifest: ingested.manifest,
            }],
            catalogEntriesById: Object.freeze({}),
            agentDefinitionsById: new Map(),
            pluginDiagnosticsByPluginId: Object.freeze({}),
        } as unknown as ResolvedContributionRegistry;
        const activated = await activatePluginRuntimeRegistry({
            contributes,
            generation: 1,
            invocationServices,
            resolveActivationSource: () => ({
                kind: 'bundled',
                moduleId: '@happier-dev/plugins-background-required-host-access/daemon',
                load: async () => ({
                    activate(api: { backgroundServices: { register(id: string, value: typeof runner): void } }) {
                        api.backgroundServices.register('gateway-supervisor', runner);
                    },
                }),
            }),
        });

        activated.startAdoptedBackgroundServices();
        await vi.waitFor(() => expect(policyCalls).toBe(1));

        expect(runner).not.toHaveBeenCalled();
        await activated.dispose();
    });

    it('lets a composed reload registry delegate lifecycle without re-owning retained generations', async () => {
        const contributes = {
            agents: [],
            actions: [],
            resources: [],
            activationTargets: [],
            catalogEntriesById: Object.freeze({}),
            agentDefinitionsById: new Map(),
            pluginDiagnosticsByPluginId: Object.freeze({}),
        } as unknown as ResolvedContributionRegistry;
        const componentBase = await activatePluginRuntimeRegistry({
            contributes,
            generation: 1,
            pluginIds: Object.freeze([]),
        });
        const start = vi.fn(componentBase.startAdoptedBackgroundServices);
        const retire = vi.fn(componentBase.retireBackgroundServices);
        const settle = vi.fn(componentBase.settleRetiredBackgroundServices);
        const component = {
            ...componentBase,
            startAdoptedBackgroundServices: start,
            retireBackgroundServices: retire,
            settleRetiredBackgroundServices: settle,
        };
        const composed = await activatePluginRuntimeRegistry({
            contributes,
            generation: 2,
            pluginIds: Object.freeze([]),
            retainedRegistries: Object.freeze([component]),
        });

        composed.startAdoptedBackgroundServices();
        composed.startAdoptedBackgroundServices();
        composed.retireBackgroundServices(['acme.retained']);
        await composed.settleRetiredBackgroundServices(['acme.retained']);

        expect(start).toHaveBeenCalledOnce();
        expect(retire).toHaveBeenCalledOnce();
        expect(settle).toHaveBeenCalledOnce();
        await composed.dispose();
        await componentBase.dispose();
    });

    it('starts each committed registration at most once with factual headless context', async () => {
        const stopped = deferred();
        const completed = deferred();
        const seen: Array<Readonly<{ surface: string; session: unknown; aborted: boolean }>> = [];
        const runner = vi.fn(async (context) => {
            seen.push({
                surface: context.surface,
                session: context.session,
                aborted: context.signal.aborted,
            });
            await stopped.promise;
            completed.resolve();
        });
        const host = createBackgroundServiceRunnerHost({
            registrations: [registration('memory-indexer', runner)],
            createContext(input) {
                return Object.freeze({
                    context: Object.freeze({
                        plugin: Object.freeze({ id: input.pluginId, version: input.pluginVersion }),
                        contribution: Object.freeze({
                            id: input.localId,
                            qualifiedId: `${input.pluginId}/backgroundServices/${input.localId}`,
                        }),
                        surface: 'background' as const,
                        signal: input.signal,
                        services: createUnavailablePluginServices(),
                        ui: createPluginInvocationPresentation({
                            currentSession: null,
                            signal: input.signal,
                            isGenerationCurrent: input.isGenerationCurrent,
                        }),
                    }),
                    complete() {},
                });
            },
        });

        expect(runner).not.toHaveBeenCalled();
        host.start();
        host.start();
        await Promise.resolve();

        expect(runner).toHaveBeenCalledOnce();
        expect(seen).toEqual([{ surface: 'background', session: undefined, aborted: false }]);
        stopped.resolve();
        await completed.promise;
        host.start();
        await Promise.resolve();
        expect(runner).toHaveBeenCalledOnce();
        await host.dispose();
    });

    it('aborts and settles cooperative services while isolating failures from siblings', async () => {
        const siblingStopped = deferred();
        const failure = new Error('index rebuild failed');
        const diagnostics: string[] = [];
        const host = createBackgroundServiceRunnerHost({
            registrations: [
                registration('broken', async () => { throw failure; }),
                registration('healthy', async (context) => {
                    await new Promise<void>((resolve) => {
                        context.signal.addEventListener('abort', () => resolve(), { once: true });
                    });
                    siblingStopped.resolve();
                }),
            ],
            createContext(input) {
                return Object.freeze({
                    context: Object.freeze({
                        plugin: Object.freeze({ id: input.pluginId, version: input.pluginVersion }),
                        contribution: Object.freeze({ id: input.localId, qualifiedId: input.localId }),
                        surface: 'background' as const,
                        signal: input.signal,
                        services: createUnavailablePluginServices(),
                        ui: createPluginInvocationPresentation({ currentSession: null, signal: input.signal, isGenerationCurrent: input.isGenerationCurrent }),
                    }),
                    complete() {},
                });
            },
            onDiagnostic(event) {
                diagnostics.push(`${event.code}:${event.localId}`);
            },
        });

        host.start();
        await vi.waitFor(() => {
            expect(diagnostics).toEqual(['background_service_failed:broken']);
        });

        host.retire(['acme.indexer']);
        await host.settle(['acme.indexer']);
        await siblingStopped.promise;
        expect(diagnostics).toEqual(['background_service_failed:broken']);
    });

    it('bounds ignored cancellation without claiming containment', async () => {
        vi.useFakeTimers();
        const diagnostics: string[] = [];
        const host = createBackgroundServiceRunnerHost({
            registrations: [registration('ignores-abort', async () => await new Promise<void>(() => {}))],
            settlementTimeoutMs: 25,
            createContext(input) {
                return Object.freeze({
                    context: Object.freeze({
                        plugin: Object.freeze({ id: input.pluginId, version: input.pluginVersion }),
                        contribution: Object.freeze({ id: input.localId, qualifiedId: input.localId }),
                        surface: 'background' as const,
                        signal: input.signal,
                        services: createUnavailablePluginServices(),
                        ui: createPluginInvocationPresentation({ currentSession: null, signal: input.signal, isGenerationCurrent: input.isGenerationCurrent }),
                    }),
                    complete() {},
                });
            },
            onDiagnostic(event) {
                diagnostics.push(event.code);
            },
        });

        host.start();
        await Promise.resolve();
        host.retire(['acme.indexer']);
        const settlement = host.settle(['acme.indexer']);
        await vi.advanceTimersByTimeAsync(25);
        await settlement;

        expect(diagnostics).toEqual(['background_service_settlement_timeout']);
        vi.useRealTimers();
    });

    it('does not enter a runner retired before its deferred post-adoption start', async () => {
        const runner = vi.fn(async () => {});
        const createContext = vi.fn(() => {
            throw new Error('retired work must not create invocation services');
        });
        const host = createBackgroundServiceRunnerHost({
            registrations: [registration('retired-before-entry', runner)],
            createContext,
        });

        host.start();
        host.retire(['acme.indexer']);
        await host.settle(['acme.indexer']);

        expect(runner).not.toHaveBeenCalled();
        expect(createContext).not.toHaveBeenCalled();
    });

    it('runs a useful event-to-storage reconciliation workflow through production services', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-background-service-'));
        const declarations: readonly ParsedPluginEventContributionV1[] = Object.freeze([
            Object.freeze({ id: 'session-changed', kind: 'event', title: 'Session changed' }),
        ]);
        const subscriptions: readonly ParsedPluginEventContributionV1[] = Object.freeze([
            Object.freeze({
                id: 'watch-session-changed',
                kind: 'subscription',
                target: Object.freeze({
                    kind: 'plugin',
                    event: Object.freeze({ pluginId: 'acme.sessions', localId: 'session-changed' }),
                }),
            }),
        ]);
        const storagePaths = resolvePluginStorePaths({ happyHomeDir });
        const createOwners = () => createProductionPluginInvocationServiceOwners({
            loggerSink: { write() {} },
            storagePaths,
            eventDeclarationsByPluginId: new Map([
                ['acme.sessions', declarations],
                ['acme.indexer', subscriptions],
            ]),
            activePluginIds: new Set(['acme.sessions', 'acme.indexer']),
        });
        const owners = createOwners();
        const createBackgroundContext = (
            owner: typeof owners,
            input: Parameters<Parameters<typeof createBackgroundServiceRunnerHost>[0]['createContext']>[0],
        ) => {
            const seed = Object.freeze({
                plugin: Object.freeze({ id: input.pluginId, version: input.pluginVersion }),
                contribution: Object.freeze({
                    id: input.localId,
                    qualifiedId: `${input.pluginId}/backgroundServices/${input.localId}`,
                }),
                generation: input.generation,
                correlationId: 'background-indexer',
                surface: 'background' as const,
                signal: input.signal,
                isGenerationCurrent: input.isGenerationCurrent,
            });
            return Object.freeze({
                context: Object.freeze({
                    plugin: seed.plugin,
                    contribution: seed.contribution,
                    surface: 'background' as const,
                    signal: seed.signal,
                    services: owner.createServices(
                        seed,
                        owner.createOrdinaryServiceBinding(seed.generation, 'background-binding'),
                    ),
                    ui: createPluginInvocationPresentation({ currentSession: null, signal: seed.signal, isGenerationCurrent: seed.isGenerationCurrent }),
                }),
                complete() {},
            });
        };
        const publisherSeed = Object.freeze({
            plugin: Object.freeze({ id: 'acme.sessions', version: '1.0.0' }),
            contribution: Object.freeze({ id: 'publish', qualifiedId: 'acme.sessions/actions/publish' }),
            generation: 'generation-one',
            correlationId: 'publisher',
            surface: 'cli' as const,
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        });
        const publisher = owners.createServices(
            publisherSeed,
            owners.createOrdinaryServiceBinding('generation-one', 'publisher-binding'),
        );
        const subscribed = deferred();
        const host = createBackgroundServiceRunnerHost({
            registrations: [registration('session-indexer', async (context) => {
                const subscription = context.services.events.plugin.subscribe(
                    { pluginId: 'acme.sessions', localId: 'session-changed' },
                    async (event) => {
                        await context.services.storage.daemon.set('derived-index', event.payload);
                    },
                );
                subscribed.resolve();
                try {
                    await new Promise<void>((resolve) => {
                        context.signal.addEventListener('abort', () => resolve(), { once: true });
                    });
                } finally {
                    subscription.dispose();
                }
            })],
            createContext: (input) => createBackgroundContext(owners, input),
        });

        host.start();
        await subscribed.promise;
        await expect(publisher.events.plugin.emit('session-changed', { sessionId: 'session-1', cursor: 4 }))
            .resolves.toMatchObject({ status: 'admitted' });
        const inspectorSeed = Object.freeze({
            ...publisherSeed,
            plugin: Object.freeze({ id: 'acme.indexer', version: '1.0.0' }),
            contribution: Object.freeze({ id: 'inspect', qualifiedId: 'acme.indexer/actions/inspect' }),
            correlationId: 'inspector',
        });
        const inspector = owners.createServices(
            inspectorSeed,
            owners.createOrdinaryServiceBinding('generation-one', 'inspector-binding'),
        );
        await vi.waitFor(async () => {
            await expect(inspector.storage.daemon.get('derived-index')).resolves.toEqual({
                sessionId: 'session-1',
                cursor: 4,
            });
        });

        await host.dispose();
        await owners.dispose();

        const restartedOwners = createOwners();
        const restarted = deferred();
        let restartedState: unknown;
        const restartedHost = createBackgroundServiceRunnerHost({
            registrations: [registration('session-indexer', async (context) => {
                restartedState = await context.services.storage.daemon.get('derived-index');
                restarted.resolve();
                await new Promise<void>((resolve) => {
                    context.signal.addEventListener('abort', () => resolve(), { once: true });
                });
            })],
            createContext: (input) => createBackgroundContext(restartedOwners, input),
        });

        restartedHost.start();
        await restarted.promise;

        expect(restartedState).toEqual({ sessionId: 'session-1', cursor: 4 });
        await restartedHost.dispose();
        await restartedOwners.dispose();
    });
});
