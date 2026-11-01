import type { Disposable } from './contracts.js';
import type { PluginContributionRegistrationRight } from '@happier-dev/protocol';
import { PluginContributionLocalIdSchema } from '@happier-dev/protocol/plugins/contribution-identity';
import { normalizeWorkItemsRuntime } from './staticRegistrationSnapshots.js';
import { snapshotConnectedAccountRuntime } from './connectedAccountSnapshots.js';

export type PluginRegistrationFamily = (typeof REGISTRATION_FAMILY)[keyof typeof REGISTRATION_FAMILY];
export type PluginRuntimeRegistration = Readonly<{ family: PluginRegistrationFamily; localId: string; value: unknown }>;
export type PluginAgentRuntimeRegistration = Readonly<Record<string, unknown>>;

export type PluginRegistrationRight = PluginContributionRegistrationRight;

export type PluginRegistrationScopeTarget =
    | Readonly<{ realm: 'daemon' }>
    | Readonly<{ realm: 'account'; artifactId: string; exportName: string }>
    | Readonly<{
        realm: 'client';
        artifactId: string;
        exportName: string;
        platform: 'web' | 'ios' | 'android';
    }>;

type StagedAgentRuntimeRegistration = Readonly<Record<string, unknown>>;

type StagedProviderRuntimeRegistration = Readonly<Record<string, unknown>>;

export type PluginRegistrationScopeParams = Readonly<{
    pluginId: string;
    target: PluginRegistrationScopeTarget;
    rights: readonly PluginRegistrationRight[];
    assertAvailable?(): void;
    onFailure?(message: string): void;
}>;

export type PluginRegistrationScope<TApi, TRegistration = PluginRuntimeRegistration> = Readonly<{
    api: TApi;
    commit(): readonly TRegistration[];
    registrations(): readonly TRegistration[];
    dispose(): Promise<void>;
}>;

type PluginDaemonRegistrationScopeTarget = Extract<
    PluginRegistrationScopeTarget,
    Readonly<{ realm: 'daemon' }>
>;

type PluginClientRegistrationScopeTarget = Extract<
    PluginRegistrationScopeTarget,
    Readonly<{ realm: 'client' }>
>;

type RegistrationState = 'staging' | 'committing' | 'committed' | 'disposed' | 'failed';

const REGISTRATION_FAMILY = Object.freeze({
    actions: 'actions',
    agents: 'agents',
    hooks: 'hooks',
    events: 'events',
    notifications: 'notificationChannels',
    connectedAccounts: 'connectedAccountDescriptors',
    providers: 'providers',
    scmHostingProviders: 'scmHostingProviders',
    scmBackends: 'scmBackends',
    mcpServers: 'mcp.servers',
    mcpDiscoverySources: 'mcp.discoverySources',
    interceptors: 'requestInterceptors',
    voiceProviders: 'voiceProviders',
    backgroundServices: 'backgroundServices',
    captureSources: 'captureSources',
    projectNativeAdapters: 'projectNativeAdapters',
    dragSources: 'dragSources',
    workItems: 'workItems',
    dropTargets: 'dropTargets',
    dynamicResources: 'resources',
    composerReferences: 'composerReferences',
    composerAttachments: 'composerAttachments',
} as const);

function registrationKey(family: string, localId: string): string {
    return `${family}\u0000${localId}`;
}

function freezeRegistration<TFamily extends PluginRegistrationFamily>(family: TFamily, localId: string, value: unknown) {
    return Object.freeze({ family, localId, value });
}

/** One atomic registration map for manifest-declared identities and families. */
export function createPluginRegistrationScope(
    params: PluginRegistrationScopeParams,
) {
    const rightsByKey = new Map<string, PluginRegistrationRight>();
    for (const right of params.rights) {
        if (!Object.values(REGISTRATION_FAMILY).includes(right.family as never)) {
            throw new Error(`Unknown contribution registration family '${right.family}'`);
        }
        if (!PluginContributionLocalIdSchema.safeParse(right.localId).success) {
            throw new Error(`Invalid contribution registration local id '${right.localId}'`);
        }
        const targetMatches = params.target.realm === 'daemon'
            ? right.target.realm === 'daemon'
            : params.target.realm === 'account'
                ? right.target.realm === 'account'
                    && right.target.artifactId === params.target.artifactId
                    && right.target.exportName === params.target.exportName
            : right.target.realm === 'client'
                && right.target.artifactId === params.target.artifactId
                && right.target.exportName === params.target.exportName
                && right.target.platforms.includes(params.target.platform);
        if (!targetMatches) {
            throw new Error(
                `Contribution registration right '${right.family}/${right.localId}' does not belong to the ${params.target.realm} registration realm`,
            );
        }
        const key = registrationKey(right.family, right.localId);
        if (rightsByKey.has(key)) {
            throw new Error(`Duplicate contribution registration right '${right.family}/${right.localId}'`);
        }
        rightsByKey.set(key, right);
    }

    const stagedByKey = new Map<string, PluginRuntimeRegistration>();
    const ownedMcpServerCleanups: Array<Readonly<{
        localId: string;
        dispose: Disposable['dispose'] | null;
    }>> = [];
    let published: readonly PluginRuntimeRegistration[] = Object.freeze([]);
    let state: RegistrationState = 'staging';
    let disposalPromise: Promise<void> | null = null;

    function fail(message: string): never {
        state = 'failed';
        stagedByKey.clear();
        params.onFailure?.(message);
        throw new Error(message);
    }

    function assertRegistrationOpen(): void {
        try {
            params.assertAvailable?.();
        } catch (error) {
            fail(error instanceof Error ? error.message : `Plugin '${params.pluginId}' registration is unavailable`);
        }
        if (state !== 'staging') {
            fail(`Plugin '${params.pluginId}' activation registration is ${state}`);
        }
    }

    function assertCommitActive(): void {
        if (state !== 'committing') {
            fail(`Plugin '${params.pluginId}' activation registration became ${state} during commit`);
        }
    }

    function assertRegistrationLocalId(localId: unknown): asserts localId is string {
        if (!PluginContributionLocalIdSchema.safeParse(localId).success) {
            fail(`Plugin '${params.pluginId}' registered an invalid contribution local id`);
        }
    }

    function register<TFamily extends PluginRegistrationFamily>(
        family: TFamily,
        localId: string,
        value: unknown,
    ): void {
        assertRegistrationOpen();
        assertRegistrationLocalId(localId);
        const key = registrationKey(family, localId);
        const right = rightsByKey.get(key);
        if (!right) {
            fail(`Plugin '${params.pluginId}' cannot register undeclared contribution '${family}/${localId}'`);
        }
        if (stagedByKey.has(key)) {
            fail(`Plugin '${params.pluginId}' registered duplicate contribution '${family}/${localId}'`);
        }
        const registration = freezeRegistration(family, localId, value);
        stagedByKey.set(key, registration);
        if (family === REGISTRATION_FAMILY.mcpServers) {
            ownedMcpServerCleanups.push({
                localId,
                dispose: () => (value as Disposable).dispose(),
            });
        }
    }

    function registerVoiceProvider(localId: string, runtime: unknown): void {
        register(REGISTRATION_FAMILY.voiceProviders, localId, runtime);
    }

    function registerProviderFields(
        localId: string,
        fields: StagedProviderRuntimeRegistration,
        duplicateLabel: string,
    ): void {
        assertRegistrationOpen();
        assertRegistrationLocalId(localId);
        const key = registrationKey(REGISTRATION_FAMILY.providers, localId);
        if (!rightsByKey.has(key)) {
            fail(`Plugin '${params.pluginId}' cannot register undeclared contribution 'providers/${localId}'`);
        }
        const existing = stagedByKey.get(key);
        if (existing && existing.family !== REGISTRATION_FAMILY.providers) {
            fail(`Plugin '${params.pluginId}' registered conflicting contribution 'providers/${localId}'`);
        }
        const current = existing?.value as StagedProviderRuntimeRegistration | undefined;
        if (fields.managedRuntime !== undefined && current?.managedRuntime !== undefined) {
            fail(`Plugin '${params.pluginId}' registered duplicate ${duplicateLabel} for Provider '${localId}'`);
        }
        const catalogParsers = {
            ...((current?.catalogParsers as Readonly<Record<string, unknown>> | undefined) ?? {}),
        };
        for (const [format, parse] of Object.entries((fields.catalogParsers as Readonly<Record<string, unknown>> | undefined) ?? {})) {
            if (Object.hasOwn(catalogParsers, format)) {
                fail(`Plugin '${params.pluginId}' registered duplicate catalog format '${format}' for Provider '${localId}'`);
            }
            catalogParsers[format] = parse;
        }
        stagedByKey.set(key, Object.freeze({
            family: REGISTRATION_FAMILY.providers,
            localId,
            value: Object.freeze({
                ...(fields.managedRuntime !== undefined
                    ? { managedRuntime: fields.managedRuntime }
                    : current?.managedRuntime !== undefined
                        ? { managedRuntime: current.managedRuntime }
                        : {}),
                ...(Object.keys(catalogParsers).length > 0
                    ? { catalogParsers: Object.freeze(catalogParsers) }
                    : {}),
            }),
        }));
    }

    function registerAgentFields(
        localId: string,
        fields: StagedAgentRuntimeRegistration,
        duplicateLabel: string,
    ): void {
        assertRegistrationOpen();
        assertRegistrationLocalId(localId);
        const key = registrationKey(REGISTRATION_FAMILY.agents, localId);
        if (!rightsByKey.has(key)) {
            fail(`Plugin '${params.pluginId}' cannot register undeclared contribution 'agents/${localId}'`);
        }
        const existing = stagedByKey.get(key);
        if (existing && existing.family !== REGISTRATION_FAMILY.agents) {
            fail(`Plugin '${params.pluginId}' registered conflicting contribution 'agents/${localId}'`);
        }
        const current = existing?.value as StagedAgentRuntimeRegistration | undefined;
        const fieldsDeclareLaunch = fields.connectedAccountLaunch !== undefined || (fields.options as Readonly<Record<string, unknown>> | undefined)?.connectedAccountLaunch !== undefined;
        const currentDeclaresLaunch = current?.connectedAccountLaunch !== undefined || (current?.options as Readonly<Record<string, unknown>> | undefined)?.connectedAccountLaunch !== undefined;
        const fieldsDeclareCliAuth = fields.cliAuth !== undefined || (fields.options as Readonly<Record<string, unknown>> | undefined)?.cliAuth !== undefined;
        const currentDeclaresCliAuth = current?.cliAuth !== undefined || (current?.options as Readonly<Record<string, unknown>> | undefined)?.cliAuth !== undefined;
        if ((fields.factory !== undefined && current?.factory !== undefined)
            || (fields.options !== undefined && current?.options !== undefined)
            || (fieldsDeclareCliAuth && currentDeclaresCliAuth)
            || (fieldsDeclareLaunch && currentDeclaresLaunch)
            || (fields.terminal !== undefined && current?.terminal !== undefined)
            || (fields.externalSessions !== undefined && current?.externalSessions !== undefined)
            || (fields.externalSessionHooks !== undefined
                && current?.externalSessionHooks !== undefined)
            || (fields.externalSessionObservation !== undefined
                && current?.externalSessionObservation !== undefined)
            || (fields.externalSessionTakeover !== undefined
                && current?.externalSessionTakeover !== undefined)) {
            fail(`Plugin '${params.pluginId}' registered duplicate ${duplicateLabel} for Agent '${localId}'`);
        }
        const value = Object.freeze({
            ...(current?.factory !== undefined ? { factory: current.factory } : {}),
            ...(current?.options !== undefined ? { options: current.options } : {}),
            ...(current?.cliAuth !== undefined ? { cliAuth: current.cliAuth } : {}),
            ...(current?.connectedAccountLaunch !== undefined ? { connectedAccountLaunch: current.connectedAccountLaunch } : {}),
            ...(current?.terminal !== undefined ? { terminal: current.terminal } : {}),
            ...(current?.externalSessions !== undefined
                ? { externalSessions: current.externalSessions }
                : {}),
            ...(current?.externalSessionHooks !== undefined
                ? { externalSessionHooks: current.externalSessionHooks }
                : {}),
            ...(current?.externalSessionObservation !== undefined
                ? { externalSessionObservation: current.externalSessionObservation }
                : {}),
            ...(current?.externalSessionTakeover !== undefined
                ? { externalSessionTakeover: current.externalSessionTakeover }
                : {}),
            ...fields,
        });
        stagedByKey.set(key, Object.freeze({
            family: REGISTRATION_FAMILY.agents,
            localId,
            value,
        }));
    }

    const daemonActions = Object.freeze({
        register(id: string, handler: unknown) { return register(REGISTRATION_FAMILY.actions, id, handler); },
    });
    const clientActions = daemonActions;
    const accountActions = daemonActions;
    const hooks = Object.freeze({
        register(id: string, handler: unknown) { return register(REGISTRATION_FAMILY.hooks, id, handler); },
    });
    const events = Object.freeze({
        register(id: string, handler: unknown) {
            return register(
                REGISTRATION_FAMILY.events,
                id,
                handler,
            );
        },
    });
    const voiceProviders = Object.freeze({
        register: (id: string, runtime: unknown) =>
            registerVoiceProvider(id, runtime),
    });
    const daemonApi = Object.freeze({
        actions: daemonActions,
        hooks,
        events,
        agents: Object.freeze({
            register: (id: string, factory: unknown, options?: unknown) => {
                return registerAgentFields(id, Object.freeze({
                    factory,
                    ...(options !== undefined ? { options } : {}),
                }), 'Agent runtime');
            },
            registerCliAuth: (id: string, contribution: unknown) => {
                return registerAgentFields(
                    id,
                    Object.freeze({ cliAuth: contribution }),
                    'Agent CLI auth contribution',
                );
            },
            registerConnectedAccountLaunch: (id: string, contribution: unknown) => {
                return registerAgentFields(
                    id,
                    Object.freeze({ connectedAccountLaunch: contribution }),
                    'Agent Connected Account launch contribution',
                );
            },
            registerTerminal: (id: string, contribution: unknown) => {
                return registerAgentFields(
                    id,
                    Object.freeze({ terminal: contribution }),
                    'Agent terminal contribution',
                );
            },
            registerExternalSessions: (id: string, contribution: unknown) => {
                return registerAgentFields(
                    id,
                    Object.freeze({ externalSessions: contribution }),
                    'Agent External Sessions contribution',
                );
            },
            registerExternalSessionHooks: (
                id: string,
                contribution: unknown,
            ) => {
                return registerAgentFields(
                    id,
                    Object.freeze({ externalSessionHooks: contribution }),
                    'Agent External Session hooks',
                );
            },
            registerExternalSessionObservation: (
                id: string,
                contribution: unknown,
            ) => {
                return registerAgentFields(
                    id,
                    Object.freeze({ externalSessionObservation: contribution }),
                    'Agent External Session observation',
                );
            },
            registerExternalSessionTakeover: (
                id: string,
                contribution: unknown,
            ) => {
                return registerAgentFields(
                    id,
                    Object.freeze({ externalSessionTakeover: contribution }),
                    'Agent External Session takeover',
                );
            },
        }),
        notifications: Object.freeze({
            registerChannel: (id: string, sender: unknown) =>
                register(REGISTRATION_FAMILY.notifications, id, sender),
        }),
        connectedAccounts: Object.freeze({
            register: (id: string, runtime: unknown) =>
                register(REGISTRATION_FAMILY.connectedAccounts, id, runtime),
        }),
        providers: Object.freeze({
            register: (id: string, runtime: unknown) =>
                registerProviderFields(
                    id,
                    Object.freeze({ managedRuntime: runtime }),
                    'managed Provider runtime',
                ),
            registerCatalogParser: (
                id: string,
                format: string,
                parse: unknown,
            ) => {
                assertRegistrationLocalId(format);
                return registerProviderFields(
                    id,
                    Object.freeze({ catalogParsers: Object.freeze({ [format]: parse }) }),
                    'Provider catalog format',
                );
            },
        }),
        scm: Object.freeze({
            registerHostingProvider: (id: string, runtime: unknown) =>
                register(REGISTRATION_FAMILY.scmHostingProviders, id, runtime),
            registerBackend: (id: string, runtime: unknown) =>
                register(REGISTRATION_FAMILY.scmBackends, id, runtime),
        }),
        mcp: Object.freeze({
            registerServer: (id: string, runtime: unknown) =>
                register(REGISTRATION_FAMILY.mcpServers, id, runtime),
            registerDiscoverySource: (
                id: string,
                discover: unknown,
            ) => register(REGISTRATION_FAMILY.mcpDiscoverySources, id, discover),
        }),
        interceptors: Object.freeze({
            register: (id: string, interceptor: unknown) =>
                register(REGISTRATION_FAMILY.interceptors, id, interceptor),
        }),
        voiceProviders,
        composerReferences: Object.freeze({
            register: (id: string, runtime: unknown) =>
                register(REGISTRATION_FAMILY.composerReferences, id, runtime),
        }),
        composerAttachments: Object.freeze({
            register: (id: string, runtime: unknown) =>
                register(REGISTRATION_FAMILY.composerAttachments, id, runtime),
        }),
        resources: Object.freeze({
            registerDynamicResource: (id: string, runtime: unknown) =>
                register(REGISTRATION_FAMILY.dynamicResources, id, runtime),
        }),
        backgroundServices: Object.freeze({
            register: (id: string, runner: unknown) =>
                register(REGISTRATION_FAMILY.backgroundServices, id, runner),
        }),
        captureSources: Object.freeze({
            register: (id: string, runtime: unknown) => register(REGISTRATION_FAMILY.captureSources, id, runtime),
        }),
        projectNativeAdapters: Object.freeze({
            register: (id: string, runtime: unknown) => register(REGISTRATION_FAMILY.projectNativeAdapters, id, runtime),
        }),
    });
    const clientApi = Object.freeze({
        workItems: Object.freeze({ register: (id: 'work-items', runtime: unknown) => register(REGISTRATION_FAMILY.workItems, id, runtime) }),
        actions: clientActions,
        voiceProviders,
        dragSources: Object.freeze({ register: (id: string, runtime: unknown) => register(REGISTRATION_FAMILY.dragSources, id, runtime) }),
        dropTargets: Object.freeze({ register: (id: string, runtime: unknown) => register(REGISTRATION_FAMILY.dropTargets, id, runtime) }),
    });
    const accountApi = Object.freeze({ actions: accountActions,
        connectedAccounts: daemonApi.connectedAccounts });
    const api = params.target.realm === 'account'
        ? accountApi : params.target.realm === 'client'
        ? clientApi
        : daemonApi;

    return Object.freeze<PluginRegistrationScope<typeof daemonApi | typeof clientApi | typeof accountApi>>({
        api,
        commit() {
            assertRegistrationOpen();
            const missing = [...rightsByKey.keys()].filter((key) => !stagedByKey.has(key));
            if (missing.length > 0) {
                const right = rightsByKey.get(missing[0]!)!;
                fail(`Plugin '${params.pluginId}' activation is missing registration '${right.family}/${right.localId}'`);
            }
            state = 'committing';
            const registrations = [...stagedByKey.values()].map(staged => {
                if (staged.family === REGISTRATION_FAMILY.agents) {
                    const { options, ...fields } = staged.value as StagedAgentRuntimeRegistration;
                    return { ...staged, value: { ...(options as Readonly<Record<string, unknown>> | undefined), ...fields } };
                }
                if (staged.family === REGISTRATION_FAMILY.workItems) {
                    return { ...staged, value: normalizeWorkItemsRuntime(staged.value) };
                }
                if (staged.family === REGISTRATION_FAMILY.connectedAccounts) {
                    return { ...staged, value: snapshotConnectedAccountRuntime(staged.value) };
                }
                return staged;
            });
            assertCommitActive();
            published = Object.freeze(registrations);
            state = 'committed';
            return published;
        },
        registrations() {
            return published;
        },
        dispose() {
            if (disposalPromise) return disposalPromise;
            state = 'disposed';
            published = Object.freeze([]);
            stagedByKey.clear();
            const pending = [...ownedMcpServerCleanups].reverse();
            ownedMcpServerCleanups.length = 0;
            disposalPromise = (async () => {
                const errors: unknown[] = [];
                // Each scope owns its LIFO cleanup sequence; other plugin
                // scopes dispose independently without a phase-local timeout.
                for (const cleanup of pending) {
                    if (!cleanup?.dispose) continue;
                    const capturedDispose = cleanup.dispose;
                    try {
                        await Promise.resolve().then(capturedDispose);
                    } catch (error) {
                        errors.push(error);
                    }
                }
                if (errors.length === 1) throw errors[0];
                if (errors.length > 1) {
                    throw new AggregateError(errors, `Plugin '${params.pluginId}' registration cleanup failed`);
                }
            })();
            return disposalPromise;
        },
    });
}
