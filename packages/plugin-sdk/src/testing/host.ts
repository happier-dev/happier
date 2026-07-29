import {
    createPluginActionInvocation,
    derivePluginDaemonContributionRegistrationRights,
    ingestPluginManifestV2,
} from '@happier-dev/protocol';

import type {
    ActionHandler,
    PluginActivationModule,
    PluginCleanup,
} from '../activation.js';
import type { JsonValue } from '../identity.js';
import { PluginError } from '../errors.js';
import type { PluginInvocationSurface, PluginInvocationUi } from '../invocation.js';
import type { PluginManifest } from '../manifest.js';
import type { PluginServices } from '../services/index.js';
import {
    createPluginRegistrationScope,
    type PluginRuntimeRegistration,
} from './registrationScope.js';

export type PluginTestkitRegistration = Readonly<{
    family: string;
    localId: string;
}>;

export type PluginTestkitInvokeOptions = Readonly<{
    surface?: PluginInvocationSurface;
    sessionId?: string;
    signal?: AbortSignal;
    services?: PluginServices;
}>;

type PluginTestkitRegistrationValue<
    TFamily extends PluginRuntimeRegistration['family'],
> = Extract<PluginRuntimeRegistration, { family: TFamily }>['value'];

function createPluginTestkitRegistrationLookup(
    registrations: () => readonly PluginRuntimeRegistration[],
) {
    function lookup(family: 'actions', localId: string): PluginTestkitRegistrationValue<'actions'> | undefined;
    function lookup(family: 'agents', localId: string): PluginTestkitRegistrationValue<'agents'> | undefined;
    function lookup(family: 'hooks', localId: string): PluginTestkitRegistrationValue<'hooks'> | undefined;
    function lookup(family: 'events', localId: string): PluginTestkitRegistrationValue<'events'> | undefined;
    function lookup(family: 'notificationChannels', localId: string): PluginTestkitRegistrationValue<'notificationChannels'> | undefined;
    function lookup(family: 'connectedAccountDescriptors', localId: string): PluginTestkitRegistrationValue<'connectedAccountDescriptors'> | undefined;
    function lookup(family: 'scmHostingProviders', localId: string): PluginTestkitRegistrationValue<'scmHostingProviders'> | undefined;
    function lookup(family: 'scmBackends', localId: string): PluginTestkitRegistrationValue<'scmBackends'> | undefined;
    function lookup(family: 'mcp.servers', localId: string): PluginTestkitRegistrationValue<'mcp.servers'> | undefined;
    function lookup(family: 'mcp.discoveryProviders', localId: string): PluginTestkitRegistrationValue<'mcp.discoveryProviders'> | undefined;
    function lookup(family: 'requestInterceptors', localId: string): PluginTestkitRegistrationValue<'requestInterceptors'> | undefined;
    function lookup(family: 'voiceProviders', localId: string): PluginTestkitRegistrationValue<'voiceProviders'> | undefined;
    function lookup(family: 'voiceProviders.speech', localId: string): PluginTestkitRegistrationValue<'voiceProviders.speech'> | undefined;
    function lookup(
        family: PluginRuntimeRegistration['family'],
        localId: string,
    ): PluginRuntimeRegistration['value'] | undefined {
        return registrations().find((entry) => (
            entry.family === family && entry.localId === localId
        ))?.value;
    }
    return lookup;
}

type InferredPluginTestkitRegistrationLookup = ReturnType<
    typeof createPluginTestkitRegistrationLookup
>;
type MissingPluginTestkitRegistrationLookupFamily = {
    [TFamily in PluginRuntimeRegistration['family']]:
    InferredPluginTestkitRegistrationLookup extends (
        family: TFamily,
        localId: string,
    ) => PluginTestkitRegistrationValue<TFamily> | undefined
        ? never
        : TFamily;
}[PluginRuntimeRegistration['family']];
type PluginTestkitRegistrationLookup =
    [MissingPluginTestkitRegistrationLookupFamily] extends [never]
        ? InferredPluginTestkitRegistrationLookup
        : never;

function createUnavailableUi(): PluginInvocationUi {
    const fail = async (): Promise<never> => {
        throw new PluginError({
            code: 'plugin_ui_unavailable',
            message: 'Plugin invocation UI is unavailable; pass an explicit UI fixture',
        });
    };
    return Object.freeze({
        requestApproval: async () => Object.freeze({
            status: 'unavailable' as const,
            diagnostic: Object.freeze({
                code: 'plugin_ui_unavailable',
                severity: 'error' as const,
                message: 'Plugin invocation UI is unavailable; pass an explicit UI fixture',
            }),
        }),
        askQuestions: async () => Object.freeze({
            status: 'unavailable' as const,
            diagnostic: Object.freeze({
                code: 'plugin_ui_unavailable',
                severity: 'error' as const,
                message: 'Plugin invocation UI is unavailable; pass an explicit UI fixture',
            }),
        }),
        confirm: fail,
        notify: fail,
        status: Object.freeze({ set: fail }),
        widget: Object.freeze({ set: fail }),
        title: Object.freeze({ set: fail }),
        composer: Object.freeze({ replace: fail }),
    });
}

export interface PluginTestkit {
    registrations(): readonly PluginTestkitRegistration[];
    registration: PluginTestkitRegistrationLookup;
    invokeAction(
        localId: string,
        input: JsonValue,
        options?: PluginTestkitInvokeOptions,
    ): Promise<JsonValue | void>;
    dispose(): Promise<void>;
}

function createUnavailableServices(): PluginServices {
    const unavailableService = new Proxy(Object.freeze({}), {
        get(_target, property) {
            throw new Error(`Plugin test service '${String(property)}' is unavailable; pass an explicit services fixture`);
        },
    });
    const root = new Proxy(Object.freeze({
        availability() {
            return Object.freeze({
                status: 'unavailable' as const,
                code: 'plugin_test_service_unavailable',
            });
        },
    }), {
        get(target, property, receiver) {
            if (property === 'availability') return Reflect.get(target, property, receiver);
            return unavailableService;
        },
    });
    // This proxy is the daemon-independent system-service boundary exposed to plugin tests.
    return root as unknown as PluginServices;
}

export async function createPluginTestkit(input: Readonly<{
    manifest: PluginManifest;
    module: PluginActivationModule;
    services?: PluginServices;
    ui?: PluginInvocationUi;
}>): Promise<PluginTestkit> {
    const manifestResult = ingestPluginManifestV2(input.manifest);
    if (!manifestResult.ok) {
        throw new TypeError(`Plugin test manifest is invalid: ${manifestResult.diagnostics.map((item) => item.message).join('; ')}`);
    }
    if (!input.module || typeof input.module.activate !== 'function') {
        throw new TypeError('Plugin test module must export activate(api)');
    }

    const manifest = manifestResult.manifest;
    const rights = derivePluginDaemonContributionRegistrationRights(
        manifest.contributes as Readonly<Record<string, unknown>>,
    );
    const registrationScope = createPluginRegistrationScope({
        pluginId: manifest.id,
        rights,
    });
    const invocationLifetime = new AbortController();
    const defaultServices = input.services ?? createUnavailableServices();
    const defaultUi = input.ui ?? createUnavailableUi();
    let state: 'staging' | 'active' | 'disposed' | 'failed' = 'staging';
    let disposalPromise: Promise<void> | null = null;
    let pluginCleanup: PluginCleanup | null = null;

    try {
        const activationResult: unknown = await input.module.activate(registrationScope.api);
        if (activationResult !== undefined && typeof activationResult !== 'function') {
            throw new Error(`Plugin '${manifest.id}' test activate export must return void or one cleanup function`);
        }
        pluginCleanup = typeof activationResult === 'function' ? activationResult as PluginCleanup : null;
        registrationScope.commit();
        state = 'active';
    } catch (error) {
        state = 'failed';
        const cleanupErrors: unknown[] = [];
        try {
            await registrationScope.dispose();
        } catch (cleanupError) {
            cleanupErrors.push(cleanupError);
        }
        if (pluginCleanup) {
            try {
                await pluginCleanup();
            } catch (cleanupError) {
                cleanupErrors.push(cleanupError);
            }
        }
        if (cleanupErrors.length > 0) {
            throw new AggregateError([error, ...cleanupErrors], `Plugin '${manifest.id}' test activation cleanup failed`);
        }
        throw error;
    }

    const actionDefinitions = new Map(
        manifest.contributes.actions.map((definition) => [definition.id, definition] as const),
    );
    const actionInvocations = new Map(
        registrationScope.registrations().flatMap((registration) => {
            if (registration.family !== 'actions') return [];
            const definition = actionDefinitions.get(registration.localId);
            if (!definition) return [];
            return [[registration.localId, createPluginActionInvocation({
                pluginId: manifest.id,
                localId: registration.localId,
                ...(definition.inputSchema === undefined ? {} : { inputSchema: definition.inputSchema }),
                ...(definition.resultSchema === undefined ? {} : { resultSchema: definition.resultSchema }),
                generationSignal: invocationLifetime.signal,
                isCurrent: () => state === 'active',
            })] as const];
        }),
    );

    async function dispose(): Promise<void> {
        if (disposalPromise) return disposalPromise;
        state = 'disposed';
        invocationLifetime.abort(new PluginError({
            code: 'plugin_action_generation_retired',
            message: `Plugin '${manifest.id}' test invocation lifetime was disposed`,
        }));
        disposalPromise = (async () => {
            const errors: unknown[] = [];
            try {
                await registrationScope.dispose();
            } catch (error) {
                errors.push(error);
            }
            try {
                await pluginCleanup?.();
            } catch (error) {
                errors.push(error);
            }
            if (errors.length === 1) throw errors[0];
            if (errors.length > 1) {
                throw new AggregateError(errors, `Plugin '${manifest.id}' test cleanup failed`);
            }
        })();
        return disposalPromise;
    }

    const registration = createPluginTestkitRegistrationLookup(
        registrationScope.registrations,
    );

    return Object.freeze({
        registrations(): readonly PluginTestkitRegistration[] {
            return Object.freeze(registrationScope.registrations().map(({ family, localId }) => Object.freeze({ family, localId })));
        },
        registration,
        async invokeAction(localId: string, actionInput: JsonValue, options: PluginTestkitInvokeOptions = {}) {
            if (state !== 'active') throw new Error(`Plugin '${manifest.id}' testkit is ${state}`);
            const registration = registrationScope.registrations().find((entry): entry is Extract<
                PluginRuntimeRegistration,
                { family: 'actions' }
            > => (
                entry.family === 'actions' && entry.localId === localId
            ));
            if (!registration) {
                throw new Error(`Plugin '${manifest.id}' has no registered action '${localId}'`);
            }
            const handler: ActionHandler = registration.value;
            const invocation = actionInvocations.get(localId);
            if (!invocation) {
                throw new Error(`Plugin '${manifest.id}' has no invokable action '${localId}'`);
            }
            const result = await invocation.invoke(actionInput, {
                ...(options.signal ? { signal: options.signal } : {}),
                handler: async ({ input: normalizedInput, qualifiedId, signal }) => await handler(
                    normalizedInput,
                    Object.freeze({
                        plugin: Object.freeze({ id: manifest.id, version: manifest.version }),
                        contribution: Object.freeze({ id: localId, qualifiedId }),
                        surface: options.surface ?? 'cli',
                        ...(options.sessionId ? { session: Object.freeze({ id: options.sessionId }) } : {}),
                        signal,
                        services: options.services ?? defaultServices,
                        ui: defaultUi,
                    }),
                ),
            });
            if (result.status === 'executed') return result.value;
            if (result.cause instanceof PluginError && result.cause.code === result.code) {
                throw result.cause;
            }
            throw new PluginError({ code: result.code, message: result.message }, {
                ...(result.cause === undefined ? {} : { cause: result.cause }),
            });
        },
        dispose,
    });
}
