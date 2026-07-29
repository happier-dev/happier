import type {
    ActionHandler,
    AgentExternalSessionObservationContribution,
    AgentExternalSessionsContribution,
    HookHandler,
    PluginApi,
    PluginMcpDiscoveryRequest,
    PluginMcpDiscoveryResult,
    PluginMcpServerRuntime,
    PluginNotificationSender,
    PluginRequestInterceptor,
    PluginScmBackendRuntime,
    PluginScmHostingProviderRuntime,
    PluginVoiceProviderRuntimeRegistration,
    PluginVoiceSpeechRuntimeRegistration,
} from '../activation.js';
import { PluginContributionLocalIdSchema } from '@happier-dev/protocol';
import {
    validateAgentExternalSessionHooksContribution,
    type AgentExternalSessionHooksContribution,
} from '../externalSessionHooks.js';
import {
    validateAgentExternalSessionTakeoverContribution,
    type AgentExternalSessionTakeoverContribution,
} from '../sessions/externalSessionTakeover.js';
import type {
    AgentProviderBindingAdapter,
    AgentRuntimeFactory,
    AgentRuntimeRegistrationOptions,
} from '../agentRuntime/index.js';
import type { JsonValue } from '../identity.js';
import type { PluginInvocationContext } from '../invocation.js';
import type { PluginConnectedAccountRuntime } from '../services/index.js';

export type PluginRegistrationRight = Readonly<{
    family: string;
    localId: string;
    requiredFields?: readonly ('factory' | 'externalSessions')[];
}>;

export type PluginAgentRuntimeRegistration = Readonly<{
    factory?: AgentRuntimeFactory;
    providerBinding?: AgentProviderBindingAdapter;
    externalSessions?: AgentExternalSessionsContribution;
    externalSessionHooks?: AgentExternalSessionHooksContribution;
    externalSessionObservation?: AgentExternalSessionObservationContribution;
    externalSessionTakeover?: AgentExternalSessionTakeoverContribution;
}>;

type PluginRuntimeRegistrationValueByFamily = Readonly<{
    actions: ActionHandler;
    agents: PluginAgentRuntimeRegistration;
    hooks: HookHandler;
    events: (payload: never, context: PluginInvocationContext) => unknown;
    notificationChannels: PluginNotificationSender;
    connectedAccountDescriptors: PluginConnectedAccountRuntime;
    scmHostingProviders: PluginScmHostingProviderRuntime;
    scmBackends: PluginScmBackendRuntime;
    'mcp.servers': PluginMcpServerRuntime;
    'mcp.discoveryProviders': Parameters<PluginApi['mcp']['registerDiscoveryProvider']>[1];
    requestInterceptors: PluginRequestInterceptor;
    voiceProviders: PluginVoiceProviderRuntimeRegistration;
    'voiceProviders.speech': PluginVoiceSpeechRuntimeRegistration;
}>;
type PluginRuntimeRegistrationFamily = keyof PluginRuntimeRegistrationValueByFamily;
type PluginRuntimeRegistrationFor<TFamily extends PluginRuntimeRegistrationFamily> = Readonly<{
    family: TFamily;
    localId: string;
    value: PluginRuntimeRegistrationValueByFamily[TFamily];
}>;
export type PluginRuntimeRegistration = {
    [TFamily in PluginRuntimeRegistrationFamily]: PluginRuntimeRegistrationFor<TFamily>;
}[PluginRuntimeRegistrationFamily];

type RegistrationState = 'staging' | 'committed' | 'disposed' | 'failed';

const REGISTRATION_FAMILY = Object.freeze({
    actions: 'actions',
    agents: 'agents',
    hooks: 'hooks',
    events: 'events',
    notifications: 'notificationChannels',
    connectedAccounts: 'connectedAccountDescriptors',
    scmHostingProviders: 'scmHostingProviders',
    scmBackends: 'scmBackends',
    mcpServers: 'mcp.servers',
    mcpDiscoveryProviders: 'mcp.discoveryProviders',
    interceptors: 'requestInterceptors',
    voiceProviders: 'voiceProviders',
    voiceSpeechProviders: 'voiceProviders.speech',
} as const);

function registrationKey(family: string, localId: string): string {
    return `${family}\u0000${localId}`;
}

function freezeRegistration<TFamily extends PluginRuntimeRegistrationFamily>(
    family: TFamily,
    localId: string,
    value: PluginRuntimeRegistrationValueByFamily[TFamily],
): PluginRuntimeRegistrationFor<TFamily> {
    return Object.freeze({ family, localId, value });
}

const AGENT_PROVIDER_BINDING_KEYS = Object.freeze([
    'v',
    'adapterVersion',
    'prepare',
    'materialize',
] as const);
const AGENT_EXTERNAL_SESSIONS_KEYS = Object.freeze([
    'resolveSource',
    'listCandidates',
    'resolveLinkIdentity',
    'resolveLinkedIdentity',
    'pageTranscript',
    'readAfterTranscript',
] as const);
const AGENT_EXTERNAL_SESSION_OBSERVATION_KEYS = Object.freeze([
    'describeResource',
    'observeResource',
    'reconcileResource',
] as const);

function readOwnEnumerableDataValue(value: object, key: string): unknown {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
        throw new TypeError(`Agent provider binding field '${key}' must be an own enumerable data property`);
    }
    return descriptor.value;
}

function snapshotAgentProviderBindingAdapter(
    value: AgentProviderBindingAdapter,
): AgentProviderBindingAdapter {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new TypeError('Agent provider binding must be a plain object');
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError('Agent provider binding must be a plain object');
    }
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== AGENT_PROVIDER_BINDING_KEYS.length
        || ownKeys.some((key) => typeof key !== 'string'
            || !AGENT_PROVIDER_BINDING_KEYS.includes(key as typeof AGENT_PROVIDER_BINDING_KEYS[number]))) {
        throw new TypeError('Agent provider binding contains unknown fields');
    }
    const v = readOwnEnumerableDataValue(value, 'v');
    const adapterVersion = readOwnEnumerableDataValue(value, 'adapterVersion');
    const prepare = readOwnEnumerableDataValue(value, 'prepare');
    const materialize = readOwnEnumerableDataValue(value, 'materialize');
    if (v !== 1
        || !Number.isSafeInteger(adapterVersion)
        || (adapterVersion as number) < 1
        || typeof prepare !== 'function'
        || typeof materialize !== 'function') {
        throw new TypeError('Agent provider binding has an invalid version or callback');
    }
    return Object.freeze({
        v: 1,
        adapterVersion: adapterVersion as number,
        prepare: prepare as AgentProviderBindingAdapter['prepare'],
        materialize: materialize as AgentProviderBindingAdapter['materialize'],
    });
}

function snapshotAgentRuntimeRegistrationOptions(
    options: AgentRuntimeRegistrationOptions | undefined,
): AgentRuntimeRegistrationOptions {
    if (options === undefined) return Object.freeze({});
    if (typeof options !== 'object' || options === null || Array.isArray(options)) {
        throw new TypeError('Agent runtime registration options must be a plain object');
    }
    const prototype = Object.getPrototypeOf(options);
    if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError('Agent runtime registration options must be a plain object');
    }
    const ownKeys = Reflect.ownKeys(options);
    if (ownKeys.some((key) => key !== 'providerBinding')) {
        throw new TypeError('Agent runtime registration options contain unknown fields');
    }
    if (!ownKeys.includes('providerBinding')) return Object.freeze({});
    const providerBinding = readOwnEnumerableDataValue(options, 'providerBinding');
    if (providerBinding === undefined) return Object.freeze({});
    return Object.freeze({
        providerBinding: snapshotAgentProviderBindingAdapter(
            providerBinding as AgentProviderBindingAdapter,
        ),
    });
}

function snapshotAgentExternalSessionsContribution(
    contribution: AgentExternalSessionsContribution,
): AgentExternalSessionsContribution {
    if (typeof contribution !== 'object' || contribution === null || Array.isArray(contribution)) {
        throw new TypeError('Agent External Sessions contribution must be a plain object');
    }
    const prototype = Object.getPrototypeOf(contribution);
    if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError('Agent External Sessions contribution must be a plain object');
    }
    const ownKeys = Reflect.ownKeys(contribution);
    if (ownKeys.length !== AGENT_EXTERNAL_SESSIONS_KEYS.length
        || ownKeys.some((key) => typeof key !== 'string'
            || !AGENT_EXTERNAL_SESSIONS_KEYS.includes(
                key as typeof AGENT_EXTERNAL_SESSIONS_KEYS[number],
            ))) {
        throw new TypeError('Agent External Sessions contribution contains unsupported public operations');
    }
    const snapshot = Object.fromEntries(AGENT_EXTERNAL_SESSIONS_KEYS.map((key) => {
        const operation = readOwnEnumerableDataValue(contribution, key);
        if (typeof operation !== 'function') {
            throw new TypeError(`Agent External Sessions operation '${key}' must be a function`);
        }
        return [key, operation];
    }));
    return Object.freeze(snapshot) as AgentExternalSessionsContribution;
}

function snapshotAgentExternalSessionObservationContribution(
    contribution: AgentExternalSessionObservationContribution,
): AgentExternalSessionObservationContribution {
    if (typeof contribution !== 'object' || contribution === null || Array.isArray(contribution)) {
        throw new TypeError('Agent External Session observation must be a plain object');
    }
    const prototype = Object.getPrototypeOf(contribution);
    if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError('Agent External Session observation must be a plain object');
    }
    const ownKeys = Reflect.ownKeys(contribution);
    if (
        ownKeys.some((key) => typeof key !== 'string'
            || !AGENT_EXTERNAL_SESSION_OBSERVATION_KEYS.includes(
                key as typeof AGENT_EXTERNAL_SESSION_OBSERVATION_KEYS[number],
            ))
        || ownKeys.length !== AGENT_EXTERNAL_SESSION_OBSERVATION_KEYS.length
    ) {
        throw new TypeError('Agent External Session observation contains unknown fields or is missing a required operation');
    }
    const snapshot: Record<string, unknown> = Object.fromEntries(
        AGENT_EXTERNAL_SESSION_OBSERVATION_KEYS.flatMap((key) => {
            if (!ownKeys.includes(key)) return [];
            const operation = readOwnEnumerableDataValue(contribution, key);
            if (typeof operation !== 'function') {
                throw new TypeError(`Agent External Session observation operation '${key}' must be a function`);
            }
            return [[key, operation]];
        }),
    );
    return Object.freeze(snapshot) as AgentExternalSessionObservationContribution;
}

function snapshotConnectedAccountRuntime(
    value: PluginConnectedAccountRuntime,
): PluginConnectedAccountRuntime {
    const snapshotPlainFunctionRecord = (
        input: unknown,
        required: readonly string[],
        optional: readonly string[],
        label: string,
    ): Readonly<Record<string, unknown>> => {
        if (typeof input !== 'object' || input === null || Array.isArray(input)) {
            throw new TypeError(`${label} must be a plain object`);
        }
        const prototype = Object.getPrototypeOf(input);
        if (prototype !== Object.prototype && prototype !== null) {
            throw new TypeError(`${label} must be a plain object`);
        }
        const allowed = new Set([...required, ...optional]);
        const ownKeys = Reflect.ownKeys(input);
        if (ownKeys.some((key) => typeof key !== 'string' || !allowed.has(key))) {
            throw new TypeError(`${label} contains unknown fields`);
        }
        const result: Record<string, unknown> = {};
        for (const key of required) {
            const field = readOwnEnumerableDataValue(input, key);
            if (typeof field !== 'function' && key !== 'authentication' && key !== 'kind') {
                throw new TypeError(`${label} field '${key}' must be a function`);
            }
            result[key] = field;
        }
        for (const key of optional) {
            if (!ownKeys.includes(key)) continue;
            const field = readOwnEnumerableDataValue(input, key);
            if (typeof field !== 'function') throw new TypeError(`${label} field '${key}' must be a function`);
            result[key] = field;
        }
        return result;
    };
    const runtime = snapshotPlainFunctionRecord(
        value,
        ['authentication', 'refresh', 'revoke', 'status', 'materialize'],
        ['quota'],
        'Connected-account runtime',
    );
    const authenticationValue = runtime.authentication;
    if (typeof authenticationValue !== 'object' || authenticationValue === null || Array.isArray(authenticationValue)) {
        throw new TypeError('Connected-account authentication runtime must be a plain object');
    }
    const authenticationPrototype = Object.getPrototypeOf(authenticationValue);
    if (authenticationPrototype !== Object.prototype && authenticationPrototype !== null) {
        throw new TypeError('Connected-account authentication runtime must be a plain object');
    }
    const authenticationKeys = Reflect.ownKeys(authenticationValue);
    if (authenticationKeys.length !== 1 || authenticationKeys[0] !== 'modes') {
        throw new TypeError("Connected-account authentication runtime must define exactly one 'modes' field");
    }
    const modesValue = readOwnEnumerableDataValue(authenticationValue, 'modes');
    if (typeof modesValue !== 'object' || modesValue === null || Array.isArray(modesValue)) {
        throw new TypeError('Connected-account authentication modes must be a plain object');
    }
    const modesPrototype = Object.getPrototypeOf(modesValue);
    if (modesPrototype !== Object.prototype && modesPrototype !== null) {
        throw new TypeError('Connected-account authentication modes must be a plain object');
    }
    const modeIds = Reflect.ownKeys(modesValue);
    if (
        modeIds.length === 0
        || modeIds.some((modeId) => (
            typeof modeId !== 'string'
            || !PluginContributionLocalIdSchema.safeParse(modeId).success
        ))
    ) {
        throw new TypeError('Connected-account authentication modes must use contribution-local ids');
    }
    const modes: Record<string, PluginConnectedAccountRuntime['authentication']['modes'][string]> = {};
    for (const modeId of modeIds as string[]) {
        const modeValue = readOwnEnumerableDataValue(modesValue, modeId);
        if (typeof modeValue !== 'object' || modeValue === null || Array.isArray(modeValue)) {
            throw new TypeError(`Connected-account authentication mode '${modeId}' must be a plain object`);
        }
        const kind = readOwnEnumerableDataValue(modeValue, 'kind');
        const mode = kind === 'manual'
            ? snapshotPlainFunctionRecord(
                modeValue,
                ['kind', 'complete'],
                ['reconcile'],
                `Manual connected-account authentication mode '${modeId}'`,
            )
            : kind === 'oauthAuthorizationCode'
                ? snapshotPlainFunctionRecord(
                    modeValue,
                    ['kind', 'begin', 'complete', 'cancel'],
                    ['reconcile'],
                    `OAuth connected-account authentication mode '${modeId}'`,
                )
                : kind === 'oauthDeviceCode'
                    ? snapshotPlainFunctionRecord(
                        modeValue,
                        ['kind', 'begin', 'poll', 'cancel'],
                        ['reconcile'],
                        `Device connected-account authentication mode '${modeId}'`,
                    )
                    : (() => {
                        throw new TypeError(`Connected-account authentication mode '${modeId}' has an unknown kind`);
                    })();
        modes[modeId] = Object.freeze(mode) as PluginConnectedAccountRuntime['authentication']['modes'][string];
    }
    const authentication = Object.freeze({
        modes: Object.freeze(modes),
    });
    return Object.freeze({
        ...runtime,
        authentication,
    }) as unknown as PluginConnectedAccountRuntime;
}

/**
 * Daemon-independent registration contract shared by the production host and
 * the SDK testkit. It validates and snapshots author registrations, but cannot
 * install a plugin or publish daemon currentness.
 */
export function createPluginRegistrationScope(params: Readonly<{
    pluginId: string;
    rights: readonly PluginRegistrationRight[];
    assertAvailable?(): void;
    onFailure?(message: string): void;
}>): Readonly<{
    api: PluginApi;
    commit(): readonly PluginRuntimeRegistration[];
    registrations(): readonly PluginRuntimeRegistration[];
    dispose(): Promise<void>;
}> {
    const rightsByKey = new Map<string, PluginRegistrationRight>();
    for (const right of params.rights) {
        const key = registrationKey(right.family, right.localId);
        if (rightsByKey.has(key)) {
            throw new Error(`Duplicate contribution registration right '${right.family}/${right.localId}'`);
        }
        rightsByKey.set(key, Object.freeze({
            ...right,
            ...(right.requiredFields
                ? { requiredFields: Object.freeze([...right.requiredFields]) }
                : {}),
        }));
    }

    const stagedByKey = new Map<string, PluginRuntimeRegistration>();
    const ownedMcpServerRuntimes: PluginMcpServerRuntime[] = [];
    let published: readonly PluginRuntimeRegistration[] = Object.freeze([]);
    let state: RegistrationState = 'staging';
    let disposalPromise: Promise<void> | null = null;

    function fail(message: string): never {
        params.onFailure?.(message);
        state = 'failed';
        stagedByKey.clear();
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

    function assertRegistrationLocalId(localId: unknown): asserts localId is string {
        if (typeof localId !== 'string') {
            fail(`Plugin '${params.pluginId}' registered an invalid contribution local id`);
        }
    }

    function register<TFamily extends PluginRuntimeRegistrationFamily>(
        family: TFamily,
        localId: string,
        value: PluginRuntimeRegistrationValueByFamily[TFamily],
    ): void {
        assertRegistrationOpen();
        assertRegistrationLocalId(localId);
        const key = registrationKey(family, localId);
        if (!rightsByKey.has(key)) {
            fail(`Plugin '${params.pluginId}' cannot register undeclared contribution '${family}/${localId}'`);
        }
        if (stagedByKey.has(key)) {
            fail(`Plugin '${params.pluginId}' registered duplicate contribution '${family}/${localId}'`);
        }
        const registration = freezeRegistration(family, localId, value);
        stagedByKey.set(key, registration as PluginRuntimeRegistration);
        if (family === REGISTRATION_FAMILY.mcpServers) {
            ownedMcpServerRuntimes.push(value as PluginMcpServerRuntime);
        }
    }

    function registerAgentFields(
        localId: string,
        fields: PluginAgentRuntimeRegistration,
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
        const current = existing?.value as PluginAgentRuntimeRegistration | undefined;
        if ((fields.factory !== undefined && current?.factory !== undefined)
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
            ...(current?.factory ? { factory: current.factory } : {}),
            ...(current?.providerBinding ? { providerBinding: current.providerBinding } : {}),
            ...(current?.externalSessions ? { externalSessions: current.externalSessions } : {}),
            ...(current?.externalSessionHooks
                ? { externalSessionHooks: current.externalSessionHooks }
                : {}),
            ...(current?.externalSessionObservation
                ? { externalSessionObservation: current.externalSessionObservation }
                : {}),
            ...(current?.externalSessionTakeover
                ? { externalSessionTakeover: current.externalSessionTakeover }
                : {}),
            ...fields,
        });
        stagedByKey.set(
            key,
            freezeRegistration(REGISTRATION_FAMILY.agents, localId, value) as PluginRuntimeRegistration,
        );
    }

    const actions: PluginApi['actions'] = Object.freeze({
        register<I extends JsonValue = JsonValue, O extends JsonValue | void = JsonValue | void>(id: string, handler: ActionHandler<I, O>) {
            return register(REGISTRATION_FAMILY.actions, id, (input, context) => handler(input as I, context));
        },
    });
    const hooks: PluginApi['hooks'] = Object.freeze({
        register(id, handler) { return register(REGISTRATION_FAMILY.hooks, id, handler); },
    });
    const events: PluginApi['events'] = Object.freeze({
        register(id, handler) { return register(REGISTRATION_FAMILY.events, id, handler); },
    });
    const api: PluginApi = Object.freeze({
        actions,
        hooks,
        events,
        agents: Object.freeze({
            register: (id: string, factory: AgentRuntimeFactory, options?: AgentRuntimeRegistrationOptions) => {
                let snapshot: AgentRuntimeRegistrationOptions;
                try {
                    snapshot = snapshotAgentRuntimeRegistrationOptions(options);
                } catch {
                    fail(`Plugin '${params.pluginId}' registered an invalid Agent provider binding`);
                }
                return registerAgentFields(id, Object.freeze({
                    factory,
                    ...(snapshot.providerBinding ? { providerBinding: snapshot.providerBinding } : {}),
                }), 'Agent runtime');
            },
            registerExternalSessions: (id: string, contribution: AgentExternalSessionsContribution) => {
                let snapshot: AgentExternalSessionsContribution;
                try {
                    snapshot = snapshotAgentExternalSessionsContribution(contribution);
                } catch {
                    fail(`Plugin '${params.pluginId}' registered an invalid Agent External Sessions contribution`);
                }
                return registerAgentFields(id, Object.freeze({ externalSessions: snapshot }), 'Agent External Sessions contribution');
            },
            registerExternalSessionHooks: (
                id: string,
                contribution: AgentExternalSessionHooksContribution,
            ) => {
                assertRegistrationLocalId(id);
                const right = rightsByKey.get(registrationKey(REGISTRATION_FAMILY.agents, id));
                if (right?.family === REGISTRATION_FAMILY.agents
                    && !right.requiredFields?.includes('externalSessions')) {
                    fail(
                        `Plugin '${params.pluginId}' cannot register Agent External Session hooks without External Sessions entitlement for Agent '${id}'`,
                    );
                }
                let snapshot: AgentExternalSessionHooksContribution;
                try {
                    snapshot = validateAgentExternalSessionHooksContribution(contribution);
                } catch {
                    fail(
                        `Plugin '${params.pluginId}' registered invalid Agent External Session hooks`,
                    );
                }
                return registerAgentFields(
                    id,
                    Object.freeze({ externalSessionHooks: snapshot }),
                    'Agent External Session hooks',
                );
            },
            registerExternalSessionObservation: (
                id: string,
                contribution: AgentExternalSessionObservationContribution,
            ) => {
                assertRegistrationLocalId(id);
                const right = rightsByKey.get(registrationKey(REGISTRATION_FAMILY.agents, id));
                if (right?.family === REGISTRATION_FAMILY.agents
                    && !right.requiredFields?.includes('externalSessions')) {
                    fail(
                        `Plugin '${params.pluginId}' cannot register Agent External Session observation without External Sessions entitlement for Agent '${id}'`,
                    );
                }
                let snapshot: AgentExternalSessionObservationContribution;
                try {
                    snapshot = snapshotAgentExternalSessionObservationContribution(contribution);
                } catch {
                    fail(
                        `Plugin '${params.pluginId}' registered an invalid Agent External Session observation`,
                    );
                }
                return registerAgentFields(
                    id,
                    Object.freeze({ externalSessionObservation: snapshot }),
                    'Agent External Session observation',
                );
            },
            registerExternalSessionTakeover: (
                id: string,
                contribution: AgentExternalSessionTakeoverContribution,
            ) => {
                assertRegistrationLocalId(id);
                const right = rightsByKey.get(
                    registrationKey(REGISTRATION_FAMILY.agents, id),
                );
                if (right?.family === REGISTRATION_FAMILY.agents
                    && !right.requiredFields?.includes('externalSessions')) {
                    fail(
                        `Plugin '${params.pluginId}' cannot register Agent External Session takeover without External Sessions entitlement for Agent '${id}'`,
                    );
                }
                let snapshot: AgentExternalSessionTakeoverContribution;
                try {
                    snapshot =
                        validateAgentExternalSessionTakeoverContribution(
                            contribution,
                        );
                } catch {
                    fail(
                        `Plugin '${params.pluginId}' registered an invalid Agent External Session takeover`,
                    );
                }
                return registerAgentFields(
                    id,
                    Object.freeze({ externalSessionTakeover: snapshot }),
                    'Agent External Session takeover',
                );
            },
        }),
        notifications: Object.freeze({
            registerChannel: (id: string, sender: PluginNotificationSender) =>
                register(REGISTRATION_FAMILY.notifications, id, sender),
        }),
        connectedAccounts: Object.freeze({
            register: (id: string, runtime: PluginConnectedAccountRuntime) => {
                let snapshot: PluginConnectedAccountRuntime;
                try {
                    snapshot = snapshotConnectedAccountRuntime(runtime);
                } catch {
                    fail(`Plugin '${params.pluginId}' registered an invalid connected-account runtime`);
                }
                return register(REGISTRATION_FAMILY.connectedAccounts, id, snapshot);
            },
        }),
        scm: Object.freeze({
            registerHostingProvider: (id: string, runtime: PluginScmHostingProviderRuntime) =>
                register(REGISTRATION_FAMILY.scmHostingProviders, id, runtime),
            registerBackend: (id: string, runtime: PluginScmBackendRuntime) =>
                register(REGISTRATION_FAMILY.scmBackends, id, runtime),
        }),
        mcp: Object.freeze({
            registerServer: (id: string, runtime: PluginMcpServerRuntime) =>
                register(REGISTRATION_FAMILY.mcpServers, id, runtime),
            registerDiscoveryProvider: (
                id: string,
                discover: (request: PluginMcpDiscoveryRequest, context: Parameters<PluginApi['mcp']['registerDiscoveryProvider']>[1] extends (request: PluginMcpDiscoveryRequest, context: infer TContext) => unknown ? TContext : never) => PluginMcpDiscoveryResult | Promise<PluginMcpDiscoveryResult>,
            ) => register(REGISTRATION_FAMILY.mcpDiscoveryProviders, id, discover),
        }),
        interceptors: Object.freeze({
            register: (id: string, interceptor: PluginRequestInterceptor) =>
                register(REGISTRATION_FAMILY.interceptors, id, interceptor),
        }),
        voiceProviders: Object.freeze({
            register: (id: string, runtime: PluginVoiceProviderRuntimeRegistration) =>
                register(REGISTRATION_FAMILY.voiceProviders, id, runtime),
            registerSpeech: (id: string, runtime: PluginVoiceSpeechRuntimeRegistration) =>
                register(REGISTRATION_FAMILY.voiceSpeechProviders, id, runtime),
        }),
    });

    return Object.freeze({
        api,
        commit() {
            assertRegistrationOpen();
            const missing = [...rightsByKey.keys()].filter((key) => !stagedByKey.has(key));
            if (missing.length > 0) {
                const right = rightsByKey.get(missing[0]!)!;
                fail(`Plugin '${params.pluginId}' activation is missing registration '${right.family}/${right.localId}'`);
            }
            for (const right of rightsByKey.values()) {
                if (right.family !== REGISTRATION_FAMILY.agents || !right.requiredFields) continue;
                const registration = stagedByKey.get(registrationKey(right.family, right.localId));
                const value = registration?.family === REGISTRATION_FAMILY.agents
                    ? registration.value as PluginAgentRuntimeRegistration
                    : undefined;
                if (right.requiredFields.includes('factory') && value?.factory === undefined) {
                    fail(`Plugin '${params.pluginId}' activation is missing Agent runtime for 'agents/${right.localId}'`);
                }
                if (right.requiredFields.includes('externalSessions') && value?.externalSessions === undefined) {
                    fail(`Plugin '${params.pluginId}' activation is missing Agent External Sessions contribution for 'agents/${right.localId}'`);
                }
            }
            for (const registration of stagedByKey.values()) {
                if (registration.family !== REGISTRATION_FAMILY.agents) continue;
                const value = registration.value as PluginAgentRuntimeRegistration;
                if (value.externalSessionObservation !== undefined
                    && value.externalSessions === undefined) {
                    fail(
                        `Plugin '${params.pluginId}' activation is missing Agent External Sessions contribution for 'agents/${registration.localId}'`,
                    );
                }
                if (value.externalSessionHooks !== undefined
                    && value.externalSessions === undefined) {
                    fail(
                        `Plugin '${params.pluginId}' activation is missing Agent External Sessions contribution for 'agents/${registration.localId}'`,
                    );
                }
                if (value.externalSessionTakeover !== undefined
                    && value.externalSessions === undefined) {
                    fail(
                        `Plugin '${params.pluginId}' activation is missing Agent External Sessions contribution for 'agents/${registration.localId}'`,
                    );
                }
            }
            published = Object.freeze([...stagedByKey.values()]);
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
            const pending = [...ownedMcpServerRuntimes].reverse();
            ownedMcpServerRuntimes.length = 0;
            disposalPromise = (async () => {
                const errors: unknown[] = [];
                for (const runtime of pending) {
                    try {
                        await runtime.dispose();
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
