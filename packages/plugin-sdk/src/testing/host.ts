/** @moduleRealm daemon */
import {
    createPluginActionInvocation,
    readPluginActionFailureAuthorPayload,
    MessageActionAvailableSnapshotV1Schema,
    PluginMachineExecutionOriginV1Schema,
    PluginMachineMaterializationRefV1Schema,
    PluginContributionPointProtocolV1Schema,
    rehydratePluginContributionPointSemanticsV1,
} from '@happier-dev/protocol';
import type {
    PluginMachineExecutionOriginV1,
    PluginMachineMaterializationRefV1,
    RehydratedPluginContributionPointOperationV1,
} from '@happier-dev/protocol';
import {
    derivePluginDaemonContributionRegistrationRights,
} from '@happier-dev/protocol/plugins/manifest';

import type {
    ActionHandler,
    AdmittedTargetedOperationExecutionHandle,
    ActionsService,
    ContributedActionExecutionWithOriginOptions,
    ContributedActionExecutionWithOriginResult,
} from '../actions/service.js';
import type { PluginCleanup } from '../activation.js';
import { PluginError } from '../errors.js';
import {
    parsePluginManifest,
    type ParsedPluginManifest,
} from '../manifest.js';
import type {
    JsonValue,
    PluginContributionLocalId,
    PluginContributionRef,
} from '../identity.js';
import type {
    PluginInvocationCaller,
    PluginInvocationSurface,
} from '../invocation.js';
import { arePluginMachineExecutionOriginsEqual } from '../executionOrigin.js';
import type { PresentationService } from '../interactions.js';
import type { PluginCancellationOptions } from '../lifecycle.js';
import {
    createPluginActionHandlerNotStartedError,
    createPluginRegistrationScope,
    type PluginRuntimeRegistration,
} from '../host/registration/index.js';
import type { PluginServiceId, PluginServices } from '../services/index.js';
import type {
    TargetedContributionObservation,
    TargetedContributionPointRef,
    TargetedContributionSnapshot,
    TargetedContributionsService,
} from '../services/targetedContributions.js';
import type {
    PluginTestServicesFixture,
    PluginTestkit,
    PluginTestkitAdmittedTargetedOperation,
    PluginTestkitAdmittedTargetedOperationRequest,
    PluginTestkitInvokeActionOptions,
    PluginTestkitOptions,
    PluginTestkitRegistration,
    PluginTestkitRegistrationByFamily,
} from './types.js';

type PluginActionCaller = Extract<PluginInvocationCaller, Readonly<{ kind: 'plugin' }>>;
type TestkitActionTargetInvocation = Readonly<{
    localId: PluginContributionLocalId;
    input: unknown;
    caller: PluginActionCaller;
    /** Host-private request from ActionsService.executeWithExecutionOrigin only. */
    captureExecutionOrigin?: true;
    /** Equality-only precondition from ActionsService.executeWithExecutionOrigin only. */
    expectedExecutionOrigin?: PluginMachineExecutionOriginV1;
    /** Exact-generation expectation from one host-issued admitted handle. */
    admittedTargetedOperation?: Readonly<{
        contributorImmutableGenerationId: string;
    }>;
    signal: AbortSignal;
}>;

type TestkitActionTargetInvocationResult = Readonly<{
    value: JsonValue | null;
    /** Present only for the host-private execution-origin request. */
    executionOrigin?: PluginMachineExecutionOriginV1;
}>;

type TestkitActionTarget = Readonly<{
    pluginId: string;
    immutableGenerationId: string;
    manifest: ParsedPluginManifest;
    isCurrent(): boolean;
    subscribeCurrentness(listener: () => void): () => void;
    isAdmittedActionAvailable(localId: PluginContributionLocalId): boolean;
    invokeFromPlugin(
        invocation: TestkitActionTargetInvocation,
    ): Promise<TestkitActionTargetInvocationResult>;
}>;

type TestkitActionServiceSource = Readonly<{
    localId: PluginContributionLocalId;
    qualifiedId: string;
    surface: PluginInvocationSurface;
    caller?: PluginInvocationCaller;
    sessionId?: string;
    signal: AbortSignal;
}>;

type TestkitRegisteredActionInvocation = Readonly<{
    localId: PluginContributionLocalId;
    input: unknown;
    surface: PluginInvocationSurface;
    signal?: AbortSignal;
    caller?: PluginActionCaller;
    sessionId?: string;
    messageAction?: PluginTestkitInvokeActionOptions['messageAction'];
    services?: PluginTestServicesFixture;
    presentation?: PresentationService;
    contributedTarget?: true;
}>;

const actionTargetsByTestkit = new WeakMap<PluginTestkit, TestkitActionTarget>();
type TestkitAdmittedTargetedOperationBinding = Readonly<{
    action: PluginContributionRef;
    contributorImmutableGenerationId: string;
    targetPluginId: string;
    targetImmutableGenerationId: string;
    /**
     * The exact target-owned parser pair for this operation role. Production
     * carries the same pair on its opaque handle binding and parses around the
     * incumbent Action invocation, so a testkit handle that dropped it would
     * pass an author's test where production rejects.
     */
    targetProtocol: RehydratedPluginContributionPointOperationV1;
}>;
const admittedTargetedOperationBindings = new WeakMap<
    object,
    TestkitAdmittedTargetedOperationBinding
>();

type TestkitFixtureProtocol = ParsedPluginManifest['contributes']['pluginContributionPoints'][number]['protocols'][number];

type TestkitFixturePoint = ParsedPluginManifest['contributes']['pluginContributionPoints'][number];

type TestkitFixtureContributionDeclaration = Readonly<{
    id: string;
    target: Readonly<{
        pluginId: string;
        pointId: string;
    }>;
    protocol: Readonly<{
        id: string;
        version: number;
    }>;
    operations: Readonly<Record<string, string>>;
}>;

type TestkitFixtureAdmittedContribution = Readonly<{
    contributor: Readonly<{
        pluginId: string;
        contributionId: string;
        immutableGenerationId: string;
    }>;
    operations: Readonly<Record<string, AdmittedTargetedOperationExecutionHandle>>;
}>;

/** Testkit's synthetic daemon identity; authors cannot supply or replace it. */
const TESTKIT_SERVER_IDENTITY_ID = 'srv_plugin_testkit';
let syntheticPluginGenerationSequence = 0;

function readExpectedExecutionOrigin(expectedExecutionOrigin: unknown): PluginMachineExecutionOriginV1 | undefined {
    if (expectedExecutionOrigin === undefined) return undefined;
    const parsed = PluginMachineExecutionOriginV1Schema.safeParse(expectedExecutionOrigin);
    if (!parsed.success) {
        throw new PluginError({
            code: 'plugin_action_execution_origin_invalid',
            message: 'Expected target execution origin is invalid',
        });
    }
    return Object.freeze({
        serverIdentityId: parsed.data.serverIdentityId,
        materializationRef: Object.freeze({ ...parsed.data.materializationRef }),
    });
}

function unavailableBoundaryError(code: string, message: string): PluginError {
    return new PluginError({ code, message });
}

function createUnavailablePresentation(): PresentationService {
    const fail = async (): Promise<never> => {
        throw unavailableBoundaryError(
            'plugin_presentation_unavailable',
            'Plugin presentation is unavailable; pass an explicit presentation fixture',
        );
    };
    return Object.freeze({
        notify: fail,
        status: Object.freeze({ set: fail }),
        widget: Object.freeze({ set: fail }),
        composer: Object.freeze({ replace: fail }),
    });
}

function fixtureHasService(
    fixture: PluginTestServicesFixture,
    serviceId: Exclude<keyof PluginServices, 'availability'>,
): boolean {
    return Object.prototype.hasOwnProperty.call(fixture, serviceId)
        && fixture[serviceId] !== undefined;
}

function createUnavailableService<K extends Exclude<keyof PluginServices, 'availability'>>(
    serviceId: K,
): PluginServices[K] {
    const unavailable = new Proxy(Object.freeze({}), {
        get() {
            throw unavailableBoundaryError(
                'plugin_test_service_unavailable',
                `Plugin test service '${serviceId}' is unavailable; pass an explicit services fixture`,
            );
        },
    });
    // The proxy is the daemon-independent genuine-boundary fixture for one omitted service.
    return unavailable as PluginServices[K];
}

function fixtureService<K extends Exclude<keyof PluginServices, 'availability'>>(
    fixture: PluginTestServicesFixture,
    serviceId: K,
): PluginServices[K] {
    return fixture[serviceId] ?? createUnavailableService(serviceId);
}

function createActionTargetIndex(
    testkits: readonly PluginTestkit[] | undefined,
): ReadonlyMap<string, TestkitActionTarget> {
    const targets = new Map<string, TestkitActionTarget>();
    for (const testkit of testkits ?? []) {
        const target = actionTargetsByTestkit.get(testkit);
        if (!target) {
            throw new TypeError('Plugin Action targets must be created by createPluginTestkit');
        }
        if (targets.has(target.pluginId)) {
            throw new TypeError(`Plugin Action target '${target.pluginId}' was configured more than once`);
        }
        targets.set(target.pluginId, target);
    }
    return targets;
}

function combineTestkitActionTargets(
    actionTargets: readonly PluginTestkit[] | undefined,
    fixtureContributors: readonly PluginTestkit[] | undefined,
): readonly PluginTestkit[] {
    const combined = [...(actionTargets ?? [])];
    const seen = new Set(combined);
    for (const target of fixtureContributors ?? []) {
        if (seen.has(target)) continue;
        seen.add(target);
        combined.push(target);
    }
    return combined;
}

function fixturePointsForManifest(
    manifest: ParsedPluginManifest,
): readonly TestkitFixturePoint[] {
    return manifest.contributes.pluginContributionPoints;
}

function fixtureContributionDeclarationsForManifest(
    manifest: ParsedPluginManifest,
): readonly TestkitFixtureContributionDeclaration[] {
    return manifest.contributes.targetedPluginContributions;
}

function sameFixtureProtocol(
    left: Readonly<{ id: string; version: number }>,
    right: Readonly<{ id: string; version: number }>,
): boolean {
    return left.id === right.id && left.version === right.version;
}

function createSyntheticPluginMaterialization(
    pluginId: string,
): PluginMachineMaterializationRefV1 {
    return Object.freeze(PluginMachineMaterializationRefV1Schema.parse({
        pluginId,
        machineId: 'plugin-testkit-machine',
        materializationId: `plugin-testkit-${pluginId}`,
    }));
}

function createSyntheticPluginImmutableGenerationId(pluginId: string): string {
    syntheticPluginGenerationSequence += 1;
    return `plugin-testkit-generation-${pluginId}-${syntheticPluginGenerationSequence}`;
}

function invalidAdmittedTargetedOperationHandle(): PluginError {
    return createPluginActionHandlerNotStartedError({
        code: 'plugin_admitted_targeted_operation_handle_invalid',
        message: 'Admitted targeted operation handle is invalid',
    });
}

/**
 * The target's own operation parsers run around the contributor invocation,
 * exactly as the daemon Action executor runs them in production. A testkit
 * that skipped them would let an author's contribution pass a test and then be
 * rejected by the real target, so the codes and the not-started classification
 * match the production owner.
 */
function parseAdmittedTargetedOperationInput(
    targetProtocol: RehydratedPluginContributionPointOperationV1,
    input: JsonValue,
): JsonValue {
    if (targetProtocol.input.kind === 'contributorDefined') return input;
    try {
        const parsed = targetProtocol.input.schema.safeParse(input);
        if (parsed.success) return parsed.data;
    } catch {
        // A throwing target parser rejects before the contributor Action runs.
    }
    throw createPluginActionHandlerNotStartedError({
        code: 'plugin_targeted_operation_input_invalid',
        message: 'Targeted operation input does not match the target protocol',
    });
}

function parseAdmittedTargetedOperationResult(
    targetProtocol: RehydratedPluginContributionPointOperationV1,
    result: JsonValue | null,
): JsonValue {
    try {
        const parsed = targetProtocol.resultSchema.safeParse(result);
        if (parsed.success) return parsed.data;
    } catch {
        // A throwing target parser cannot disclose a contributor result.
    }
    throw new PluginError({
        code: 'plugin_targeted_operation_result_invalid',
        message: 'Targeted operation result does not match the target protocol',
    });
}

function readAdmittedTargetedOperationBinding(
    operation: unknown,
): TestkitAdmittedTargetedOperationBinding | null {
    if (operation === null || typeof operation !== 'object') return null;
    return admittedTargetedOperationBindings.get(operation) ?? null;
}

function composeActionSignal(
    invocationSignal: AbortSignal,
    callerSignal: AbortSignal | undefined,
): AbortSignal {
    if (!callerSignal || callerSignal === invocationSignal) return invocationSignal;
    return AbortSignal.any([invocationSignal, callerSignal]);
}

function readPluginContributionRef(value: unknown): PluginContributionRef | null {
    if (!value || typeof value !== 'object') return null;
    const candidate = value as Readonly<Record<string, unknown>>;
    if (typeof candidate.pluginId !== 'string' || typeof candidate.localId !== 'string') {
        return null;
    }
    return Object.freeze({ pluginId: candidate.pluginId, localId: candidate.localId });
}

function createPluginServices(
    fixture: PluginTestServicesFixture = {},
    actionService?: ActionsService,
    targetedContributionsService?: TargetedContributionsService,
): PluginServices {
    return Object.freeze({
        availability(serviceId: PluginServiceId) {
            return (serviceId === 'actions' && actionService !== undefined)
                || (serviceId === 'targetedContributions'
                    && targetedContributionsService !== undefined)
                || fixtureHasService(fixture, serviceId)
                ? Object.freeze({ status: 'available' as const })
                : Object.freeze({
                    status: 'unavailable' as const,
                    code: 'plugin_test_service_unavailable',
                });
        },
        logger: fixtureService(fixture, 'logger'),
        storage: fixtureService(fixture, 'storage'),
        settings: fixtureService(fixture, 'settings'),
        secrets: fixtureService(fixture, 'secrets'),
        events: fixtureService(fixture, 'events'),
        http: fixtureService(fixture, 'http'),
        fs: fixtureService(fixture, 'fs'),
        exec: fixtureService(fixture, 'exec'),
        providers: fixtureService(fixture, 'providers'),
        managedServices: fixtureService(fixture, 'managedServices'),
        sessions: fixtureService(fixture, 'sessions'),
        resources: fixtureService(fixture, 'resources'),
        mcp: fixtureService(fixture, 'mcp'),
        notifications: fixtureService(fixture, 'notifications'),
        connectedAccounts: fixtureService(fixture, 'connectedAccounts'),
        actions: actionService ?? fixtureService(fixture, 'actions'),
        targetedContributions: targetedContributionsService
            ?? fixtureService(fixture, 'targetedContributions'),
        interactions: fixtureService(fixture, 'interactions'),
        composerContent: fixtureService(fixture, 'composerContent'),
    });
}

function registrationValue<F extends keyof PluginTestkitRegistrationByFamily>(
    registrations: readonly PluginRuntimeRegistration[],
    family: F,
    localId: PluginContributionLocalId,
): PluginTestkitRegistrationByFamily[F] | undefined {
    const registration = registrations.find((entry) => (
        entry.family === family && entry.localId === localId
    ));
    if (registration === undefined) {
        return undefined;
    }
    return registration?.value as PluginTestkitRegistrationByFamily[F] | undefined;
}

export async function createPluginTestkit(
    options: PluginTestkitOptions,
): Promise<PluginTestkit> {
    const manifestResult = parsePluginManifest(options.manifest);
    if (!manifestResult.ok) {
        throw new TypeError(`Plugin test manifest is invalid: ${manifestResult.diagnostics.map((item) => item.message).join('; ')}`);
    }
    if (!options.module || typeof options.module.activate !== 'function') {
        throw new TypeError('Plugin test module must export activate(api)');
    }

    const manifest = manifestResult.manifest;
    const rights = derivePluginDaemonContributionRegistrationRights(
        manifest.contributes as Readonly<Record<string, unknown>>,
    );
    const registrationScope = createPluginRegistrationScope({
        pluginId: manifest.id,
        target: { realm: 'daemon' },
        rights,
    });
    const invocationLifetime = new AbortController();
    const defaultServicesFixture = options.services ?? {};
    const defaultPresentation = options.presentation ?? createUnavailablePresentation();
    const fixtureContributorTestkits = options.targetedContributionContributors ?? [];
    if (fixtureContributorTestkits.length > 0
        && options.services?.targetedContributions !== undefined) {
        throw new TypeError(
            'Plugin testkit structural targeted-contribution fixtures cannot be combined with a targetedContributions service fixture',
        );
    }
    let state: 'staging' | 'active' | 'disposed' | 'failed' = 'staging';
    const currentnessListeners = new Set<() => void>();
    let disposalPromise: Promise<void> | null = null;
    let pluginCleanup: PluginCleanup | null = null;
    let registrations: readonly PluginRuntimeRegistration[] = Object.freeze([]);
    const actionDefinitions = new Map(
        manifest.contributes.actions.map((definition) => [definition.id, definition] as const),
    );
    let actionInvocations = new Map<string, ReturnType<typeof createPluginActionInvocation>>();
    const actionTargets = createActionTargetIndex(combineTestkitActionTargets(
        options.actionTargets,
        fixtureContributorTestkits,
    ));
    const fixtureContributorTargets = fixtureContributorTestkits.map((testkit) => {
        const target = actionTargetsByTestkit.get(testkit);
        if (!target) {
            throw new TypeError('Targeted contribution fixture contributors must be created by createPluginTestkit');
        }
        return target;
    });
    const syntheticMaterialization = createSyntheticPluginMaterialization(manifest.id);
    const syntheticImmutableGenerationId = createSyntheticPluginImmutableGenerationId(manifest.id);
    const defaultServices = actionTargets.size === 0 && fixtureContributorTargets.length === 0
        ? createPluginServices(defaultServicesFixture)
        : undefined;

    /**
     * The synthetic host owns the current materialization just as the daemon
     * runtime registry does. Action input never provides this identity.
     */
    function resolveCurrentPluginMaterializationRef(): PluginMachineMaterializationRefV1 | null {
        if (state !== 'active' || invocationLifetime.signal.aborted) return null;
        let materialization: PluginMachineMaterializationRefV1 | null;
        try {
            materialization = options.resolveCurrentPluginMaterializationRef === undefined
                ? syntheticMaterialization
                : options.resolveCurrentPluginMaterializationRef();
        } catch {
            return null;
        }
        const parsed = PluginMachineMaterializationRefV1Schema.safeParse(materialization);
        if (!parsed.success || parsed.data.pluginId !== manifest.id) return null;
        return Object.freeze(parsed.data);
    }

    /**
     * The synthetic host composes its fixed server identity with the same
     * target currentness/materialization resolver used for Action dispatch.
     * Neither Action input nor public testkit options can supply this origin.
     */
    function resolveCurrentPluginExecutionOrigin(): PluginMachineExecutionOriginV1 | null {
        const materializationRef = resolveCurrentPluginMaterializationRef();
        if (!materializationRef) return null;
        const origin = PluginMachineExecutionOriginV1Schema.safeParse({
            serverIdentityId: TESTKIT_SERVER_IDENTITY_ID,
            materializationRef,
        });
        if (!origin.success) return null;
        return Object.freeze({
            serverIdentityId: origin.data.serverIdentityId,
            materializationRef: Object.freeze({ ...origin.data.materializationRef }),
        });
    }

    try {
        const activationResult: unknown = await options.module.activate(registrationScope.api);
        if (activationResult !== undefined && typeof activationResult !== 'function') {
            throw new TypeError(`Plugin '${manifest.id}' test activate export must return void or one cleanup function`);
        }
        pluginCleanup = typeof activationResult === 'function'
            ? activationResult as PluginCleanup
            : null;
        registrations = registrationScope.commit();
        actionInvocations = new Map(
            registrations.flatMap((registration) => {
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
            pluginCleanup = null;
        }
        if (cleanupErrors.length > 0) {
            throw new AggregateError(
                [error, ...cleanupErrors],
                `Plugin '${manifest.id}' test activation cleanup failed`,
            );
        }
        throw error;
    }

    async function dispose(): Promise<void> {
        if (disposalPromise) return disposalPromise;
        state = 'disposed';
        invocationLifetime.abort(new PluginError({
            code: 'plugin_action_generation_retired',
            message: `Plugin '${manifest.id}' test invocation lifetime was disposed`,
        }));
        for (const listener of currentnessListeners) {
            try {
                listener();
            } catch {
                // A fixture observer cannot break testkit retirement.
            }
        }
        currentnessListeners.clear();
        disposalPromise = (async () => {
            const errors: unknown[] = [];
            try {
                await registrationScope.dispose();
            } catch (error) {
                errors.push(error);
            }
            const cleanup = pluginCleanup;
            pluginCleanup = null;
            try {
                await cleanup?.();
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

    function throwIfActionInvocationInactive(signal: AbortSignal): void {
        if (state !== 'active' || invocationLifetime.signal.aborted) {
            throw new PluginError({
                code: 'plugin_action_generation_retired',
                message: `Plugin '${manifest.id}' test action generation is no longer current`,
            });
        }
        if (signal.aborted) {
            throw new PluginError({
                code: 'plugin_action_aborted',
                message: 'Plugin action invocation was aborted',
            });
        }
    }

    function resolvePluginActionCaller(
        source: TestkitActionServiceSource,
    ): PluginActionCaller | null {
        const materialization = resolveCurrentPluginMaterializationRef();
        if (!materialization) return null;
        const originSurface = source.surface === 'plugin'
            && source.caller?.kind === 'plugin'
            ? source.caller.originSurface
            : source.surface === 'plugin'
                ? undefined
                : source.surface;
        return Object.freeze({
            kind: 'plugin' as const,
            pluginId: manifest.id,
            contribution: Object.freeze({ id: source.localId, qualifiedId: source.qualifiedId }),
            materialization,
            ...(originSurface === undefined ? {} : { originSurface }),
        });
    }

    function hasCurrentContributedActionCaller(
        source: TestkitActionServiceSource,
        caller: PluginActionCaller,
    ): boolean {
        const currentCaller = resolvePluginActionCaller(source);
        const currentMaterialization = currentCaller?.materialization;
        const callerMaterialization = caller.materialization;
        return currentMaterialization !== undefined
            && callerMaterialization !== undefined
            && currentMaterialization.pluginId === callerMaterialization.pluginId
            && currentMaterialization.machineId === callerMaterialization.machineId
            && currentMaterialization.materializationId === callerMaterialization.materializationId;
    }

    function throwIfContributedActionCallerInactive(
        source: TestkitActionServiceSource,
        signal: AbortSignal,
        caller: PluginActionCaller,
    ): void {
        throwIfActionInvocationInactive(signal);
        if (!hasCurrentContributedActionCaller(source, caller)) {
            throw new PluginError({
                code: 'plugin_action_caller_unavailable',
                message: 'Plugin contributed Action caller materialization is no longer current',
            });
        }
    }

    function fixtureStaleGeneration(): PluginError {
        return new PluginError({
            code: 'plugin_generation_stale',
            message: `Plugin '${manifest.id}' test targeted-contribution fixture generation is no longer current`,
        });
    }

    function fixturePointMismatch(): PluginError {
        return new PluginError({
            code: 'plugin_targeted_contributions_target_mismatch',
            message: `Targeted contribution point does not belong to plugin '${manifest.id}'`,
        });
    }

    function fixtureUnavailable(): PluginError {
        return new PluginError({
            code: 'plugin_targeted_contributions_unavailable',
            message: `Plugin '${manifest.id}' test targeted-contribution fixture is unavailable`,
        });
    }

    function fixtureAborted(): PluginError {
        return new PluginError({
            code: 'plugin_targeted_contributions_aborted',
            message: 'Plugin test targeted-contribution fixture observation was aborted',
        });
    }

    function assertFixtureCurrent(signal?: AbortSignal): void {
        if (state !== 'active' || invocationLifetime.signal.aborted) {
            throw fixtureStaleGeneration();
        }
        if (signal?.aborted) throw fixtureAborted();
    }

    function readFixturePoint(
        point: TargetedContributionPointRef<unknown>,
    ): Readonly<{
        declaration: TestkitFixturePoint;
        protocol: TestkitFixtureProtocol;
    }> {
        assertFixtureCurrent();
        if (point.targetPluginId !== manifest.id) throw fixturePointMismatch();
        const declaration = fixturePointsForManifest(manifest).find((candidate) => (
            candidate.id === point.id
        ));
        const protocol = declaration?.protocols.find((candidate) => (
            sameFixtureProtocol(candidate, point.protocol)
        ));
        if (!declaration || !protocol) throw fixtureUnavailable();
        return Object.freeze({ declaration, protocol });
    }

    /**
     * Rehydrates the target's parser pairs from the parsed cold manifest
     * through the same Protocol owner used by CLI admission. Point refs stay
     * structural, so independently copied refs cannot carry hidden semantics.
     */
    function readFixtureOperationSemantics(
        protocol: TestkitFixtureProtocol,
    ): ReadonlyMap<string, RehydratedPluginContributionPointOperationV1> {
        const admittedProtocol = PluginContributionPointProtocolV1Schema.safeParse(protocol);
        if (!admittedProtocol.success) throw fixtureUnavailable();
        const semantics = rehydratePluginContributionPointSemanticsV1(admittedProtocol.data);
        if (!semantics) throw fixtureUnavailable();
        return new Map(semantics.operations.map((operation) => [operation.role, operation]));
    }

    function createFixtureOperationHandle(
        point: TargetedContributionPointRef<unknown>,
        declaration: TestkitFixtureContributionDeclaration,
        contributor: TestkitActionTarget,
        role: string,
        actionLocalId: PluginContributionLocalId,
        targetProtocol: RehydratedPluginContributionPointOperationV1,
    ): AdmittedTargetedOperationExecutionHandle {
        const identity = Object.freeze({
            target: Object.freeze({ pluginId: manifest.id }),
            point: Object.freeze({
                pointId: point.id,
                protocol: Object.freeze({
                    id: point.protocol.id,
                    version: point.protocol.version,
                }),
            }),
            contributor: Object.freeze({
                pluginId: contributor.pluginId,
                contributionId: declaration.id,
                immutableGenerationId: contributor.immutableGenerationId,
            }),
            role,
        });
        const handle = Object.freeze({ identity }) as AdmittedTargetedOperationExecutionHandle;
        admittedTargetedOperationBindings.set(handle, Object.freeze({
            action: Object.freeze({
                pluginId: contributor.pluginId,
                localId: actionLocalId,
            }),
            contributorImmutableGenerationId: contributor.immutableGenerationId,
            targetPluginId: manifest.id,
            targetImmutableGenerationId: syntheticImmutableGenerationId,
            targetProtocol,
        }));
        return handle;
    }

    /**
     * This deliberately stops at parsed structural declarations and active
     * testkit Action registrations. The CLI registry remains the only owner
     * of cold candidate admission, diagnostics, descriptor/surface semantics,
     * and catalog ordering.
     */
    function readTargetedContributionFixture<TContribution>(
        point: TargetedContributionPointRef<TContribution>,
        signal?: AbortSignal,
    ): TargetedContributionSnapshot<TContribution> {
        assertFixtureCurrent(signal);
        const targetPoint = readFixturePoint(point);
        const operationSemantics = readFixtureOperationSemantics(targetPoint.protocol);
        const contributions: unknown[] = [];

        for (const contributor of fixtureContributorTargets) {
            if (!contributor.isCurrent()) continue;
            const declarationsForPoint = fixtureContributionDeclarationsForManifest(contributor.manifest)
                .filter((candidate) => (
                    candidate.target.pluginId === manifest.id
                    && candidate.target.pointId === point.id
                ));
            if (targetPoint.declaration.maxContributionsPerContributor !== undefined
                && declarationsForPoint.length > targetPoint.declaration.maxContributionsPerContributor) {
                continue;
            }

            for (const declaration of declarationsForPoint) {
                if (!sameFixtureProtocol(declaration.protocol, point.protocol)) continue;
                const roles = Object.entries(declaration.operations);
                if (roles.some(([role]) => targetPoint.protocol.operations[role] === undefined)
                    || Object.entries(targetPoint.protocol.operations).some(([role, operation]) => (
                        operation.required && declaration.operations[role] === undefined
                    ))) {
                    continue;
                }

                const actionBindings: Array<readonly [string, PluginContributionLocalId]> = [];
                let actionUnavailable = false;
                for (const [role, localId] of roles) {
                    const actionLocalId = localId as PluginContributionLocalId;
                    if (!contributor.isAdmittedActionAvailable(actionLocalId)) {
                        actionUnavailable = true;
                        break;
                    }
                    actionBindings.push([role, actionLocalId]);
                }
                if (actionUnavailable) continue;

                const operations = Object.freeze(Object.fromEntries(actionBindings.map(([role, actionLocalId]) => {
                    const targetProtocol = operationSemantics.get(role);
                    if (!targetProtocol) throw fixtureUnavailable();
                    return [
                        role,
                        createFixtureOperationHandle(
                            point,
                            declaration,
                            contributor,
                            role,
                            actionLocalId,
                            targetProtocol,
                        ),
                    ];
                })));
                contributions.push(Object.freeze({
                    contributor: Object.freeze({
                        pluginId: contributor.pluginId,
                        contributionId: declaration.id,
                        immutableGenerationId: contributor.immutableGenerationId,
                    }),
                    protocol: Object.freeze({
                        id: declaration.protocol.id,
                        version: declaration.protocol.version,
                    }),
                    operations,
                }));
            }
        }

        assertFixtureCurrent(signal);
        return Object.freeze({
            generation: syntheticImmutableGenerationId,
            contributions: Object.freeze(contributions) as readonly TContribution[],
        });
    }

    /**
     * Fixture issuance deliberately selects a handle the structural fixture
     * already admitted. It never accepts a caller-provided Action or
     * generation, and it validates the private binding before returning the
     * original opaque object.
     */
    function issueAdmittedTargetedOperation<
        TContribution,
        TRole extends string,
    >(
        request: PluginTestkitAdmittedTargetedOperationRequest<TContribution, TRole>,
    ): PluginTestkitAdmittedTargetedOperation<TContribution, TRole> {
        const contributor = actionTargetsByTestkit.get(request.contributor.testkit);
        if (!contributor || !fixtureContributorTargets.includes(contributor)) {
            throw fixtureUnavailable();
        }
        const snapshot = readTargetedContributionFixture(request.point);
        const admitted = snapshot.contributions
            .map(readFixtureAdmittedContribution)
            .find((candidate) => candidate !== null
                && candidate.contributor.pluginId === contributor.pluginId
                && candidate.contributor.contributionId === request.contributor.contributionId
                && candidate.contributor.immutableGenerationId === contributor.immutableGenerationId);
        const operation = admitted?.operations[request.role];
        const binding = readAdmittedTargetedOperationBinding(operation);
        if (!operation || !binding
            || operation.identity.target.pluginId !== manifest.id
            || operation.identity.point.pointId !== request.point.id
            || !sameFixtureProtocol(operation.identity.point.protocol, request.point.protocol)
            || operation.identity.contributor.pluginId !== contributor.pluginId
            || operation.identity.contributor.contributionId !== request.contributor.contributionId
            || operation.identity.contributor.immutableGenerationId !== contributor.immutableGenerationId
            || operation.identity.role !== request.role
            || binding.contributorImmutableGenerationId !== contributor.immutableGenerationId
            || binding.targetPluginId !== manifest.id
            || binding.targetImmutableGenerationId !== syntheticImmutableGenerationId) {
            throw fixtureUnavailable();
        }
        return operation as PluginTestkitAdmittedTargetedOperation<TContribution, TRole>;
    }

    function readFixtureAdmittedContribution(
        value: unknown,
    ): TestkitFixtureAdmittedContribution | null {
        if (value === null || typeof value !== 'object') return null;
        const candidate = value as Readonly<Record<string, unknown>>;
        const contributor = candidate.contributor;
        const operations = candidate.operations;
        if (contributor === null || typeof contributor !== 'object'
            || operations === null || typeof operations !== 'object'
            || Array.isArray(operations)) {
            return null;
        }
        const contributorRecord = contributor as Readonly<Record<string, unknown>>;
        if (typeof contributorRecord.pluginId !== 'string'
            || typeof contributorRecord.contributionId !== 'string'
            || typeof contributorRecord.immutableGenerationId !== 'string') {
            return null;
        }
        return value as TestkitFixtureAdmittedContribution;
    }

    function createFixtureTargetedContributionsService(): TargetedContributionsService {
        return Object.freeze({
            observeForSelf<TContribution>(
                point: TargetedContributionPointRef<TContribution>,
                options: Readonly<{ onInvalidated: () => void }>,
            ): TargetedContributionObservation<TContribution> {
                readFixturePoint(point);
                let disposed = false;
                let invalidationScheduled = false;
                const unsubscribeCurrentness = fixtureContributorTargets.map((contributor) => (
                    contributor.subscribeCurrentness(scheduleInvalidation)
                ));

                function dispose(): void {
                    if (disposed) return;
                    disposed = true;
                    invocationLifetime.signal.removeEventListener('abort', dispose);
                    for (const unsubscribe of unsubscribeCurrentness) unsubscribe();
                }

                function scheduleInvalidation(): void {
                    if (disposed || invalidationScheduled) return;
                    invalidationScheduled = true;
                    queueMicrotask(() => {
                        invalidationScheduled = false;
                        if (disposed) return;
                        if (state !== 'active' || invocationLifetime.signal.aborted) {
                            dispose();
                            return;
                        }
                        try {
                            options.onInvalidated();
                        } catch {
                            // A target callback cannot break testkit retirement.
                        }
                    });
                }

                invocationLifetime.signal.addEventListener('abort', dispose, { once: true });
                return Object.freeze({
                    dispose,
                    async readCurrent(options?: PluginCancellationOptions) {
                        if (disposed) throw fixtureStaleGeneration();
                        return readTargetedContributionFixture(point, options?.signal);
                    },
                });
            },
        });
    }

    function createInvocationServices(
        invocationServices: PluginTestServicesFixture | undefined,
        source: TestkitActionServiceSource,
    ): PluginServices {
        const fixture = invocationServices === undefined
            ? defaultServicesFixture
            : { ...defaultServicesFixture, ...invocationServices };
        const actions = actionTargets.size === 0
            ? undefined
            : createTestkitActionsService(fixture, source);
        const targetedContributions = fixtureContributorTargets.length === 0
            ? undefined
            : createFixtureTargetedContributionsService();
        if (actions === undefined && targetedContributions === undefined) {
            return invocationServices === undefined && defaultServices !== undefined
                ? defaultServices
                : createPluginServices(fixture);
        }
        return createPluginServices(fixture, actions, targetedContributions);
    }

    function createTestkitActionsService(
        fixture: PluginTestServicesFixture,
        source: TestkitActionServiceSource,
    ): ActionsService {
        const fixtureActions = fixtureService(fixture, 'actions') as ActionsService;
        const executeContributed = async (
            action: PluginContributionRef,
            input: JsonValue,
            signal: AbortSignal,
            captureExecutionOrigin: boolean,
            expectedExecutionOrigin?: PluginMachineExecutionOriginV1,
            admittedTargetedOperation?: Readonly<{
                contributorImmutableGenerationId: string;
            }>,
        ): Promise<TestkitActionTargetInvocationResult> => {
            const caller = resolvePluginActionCaller(source);
            if (!caller) {
                throw createPluginActionHandlerNotStartedError({
                    code: 'plugin_action_caller_unavailable',
                    message: 'Plugin contributed Action calls require current host-stamped caller provenance',
                });
            }
            const target = actionTargets.get(action.pluginId);
            if (!target) {
                throw createPluginActionHandlerNotStartedError({
                    code: 'plugin_action_unavailable',
                    message: `Plugin contributed Action target '${action.pluginId}' is unavailable`,
                });
            }
            const result = await target.invokeFromPlugin({
                localId: action.localId,
                input,
                caller,
                ...(captureExecutionOrigin ? { captureExecutionOrigin: true as const } : {}),
                ...(expectedExecutionOrigin === undefined ? {} : { expectedExecutionOrigin }),
                ...(admittedTargetedOperation === undefined
                    ? {}
                    : { admittedTargetedOperation }),
                signal,
            });
            throwIfContributedActionCallerInactive(source, signal, caller);
            return result;
        };
        const requireCurrentAdmittedTargetedOperationBinding = (
            operation: unknown,
        ): TestkitAdmittedTargetedOperationBinding => {
            const binding = readAdmittedTargetedOperationBinding(operation);
            if (!binding || binding.targetPluginId !== manifest.id) {
                throw invalidAdmittedTargetedOperationHandle();
            }
            if (binding.targetImmutableGenerationId !== syntheticImmutableGenerationId) {
                throw createPluginActionHandlerNotStartedError({
                    code: 'plugin_action_generation_retired',
                    message: 'Admitted targeted operation target generation is no longer current',
                });
            }
            return binding;
        };
        const execute = async (
            actionOrRef: string | PluginContributionRef,
            input: unknown,
            options?: PluginCancellationOptions,
        ): Promise<unknown> => {
            const signal = composeActionSignal(source.signal, options?.signal);
            throwIfActionInvocationInactive(signal);
            if (typeof actionOrRef === 'string') {
                return await fixtureActions.execute(actionOrRef as never, input as never, { signal });
            }

            const action = readPluginContributionRef(actionOrRef);
            if (!action) {
                throw createPluginActionHandlerNotStartedError({
                    code: 'plugin_action_unavailable',
                    message: 'Plugin contributed Action target is invalid',
                });
            }
            const result = await executeContributed(action, input as JsonValue, signal, false);
            return result.value;
        };
        const executeWithExecutionOrigin = async (
            action: PluginContributionRef,
            input: JsonValue,
            options?: ContributedActionExecutionWithOriginOptions,
        ): Promise<ContributedActionExecutionWithOriginResult> => {
            const signal = composeActionSignal(source.signal, options?.signal);
            throwIfActionInvocationInactive(signal);
            const result = await executeContributed(
                action,
                input,
                signal,
                true,
                readExpectedExecutionOrigin(options?.expectedExecutionOrigin),
            );
            if (!result.executionOrigin) {
                throw new PluginError({
                    code: 'plugin_action_execution_origin_unavailable',
                    message: 'Current target execution origin is unavailable',
                });
            }
            return Object.freeze({
                result: result.value ?? null,
                executionOrigin: result.executionOrigin,
            });
        };
        const executeAdmittedTargetedOperation = async <
            TInput extends JsonValue,
            TResult extends JsonValue | void,
        >(
            operation: AdmittedTargetedOperationExecutionHandle<TInput, TResult>,
            input: NoInfer<TInput>,
            options?: PluginCancellationOptions,
        ): Promise<TResult> => {
            const binding = requireCurrentAdmittedTargetedOperationBinding(operation);
            const signal = composeActionSignal(source.signal, options?.signal);
            throwIfActionInvocationInactive(signal);
            const result = await executeContributed(
                binding.action,
                parseAdmittedTargetedOperationInput(binding.targetProtocol, input),
                signal,
                false,
                undefined,
                Object.freeze({
                    contributorImmutableGenerationId: binding.contributorImmutableGenerationId,
                }),
            );
            return parseAdmittedTargetedOperationResult(
                binding.targetProtocol,
                result.value,
            ) as TResult;
        };
        const executeAdmittedTargetedOperationWithExecutionOrigin = async <
            TInput extends JsonValue,
            TResult extends JsonValue | void,
        >(
            operation: AdmittedTargetedOperationExecutionHandle<TInput, TResult>,
            input: NoInfer<TInput>,
            options?: ContributedActionExecutionWithOriginOptions,
        ): Promise<Readonly<{
            result: TResult;
            executionOrigin: PluginMachineExecutionOriginV1;
        }>> => {
            const binding = requireCurrentAdmittedTargetedOperationBinding(operation);
            const signal = composeActionSignal(source.signal, options?.signal);
            throwIfActionInvocationInactive(signal);
            const result = await executeContributed(
                binding.action,
                parseAdmittedTargetedOperationInput(binding.targetProtocol, input),
                signal,
                true,
                readExpectedExecutionOrigin(options?.expectedExecutionOrigin),
                Object.freeze({
                    contributorImmutableGenerationId: binding.contributorImmutableGenerationId,
                }),
            );
            if (!result.executionOrigin) {
                throw new PluginError({
                    code: 'plugin_action_execution_origin_unavailable',
                    message: 'Current target execution origin is unavailable',
                });
            }
            return Object.freeze({
                result: parseAdmittedTargetedOperationResult(
                    binding.targetProtocol,
                    result.value,
                ) as TResult,
                executionOrigin: result.executionOrigin,
            });
        };
        return Object.freeze({
            execute,
            executeAdmittedTargetedOperation,
            executeWithExecutionOrigin,
            executeAdmittedTargetedOperationWithExecutionOrigin,
        }) as ActionsService;
    }

    async function invokeRegisteredAction(
        invocationOptions: TestkitRegisteredActionInvocation,
    ): Promise<JsonValue | null> {
        const preHandlerFailure = (input: Readonly<{
            code: string;
            message: string;
        }>): PluginError => invocationOptions.contributedTarget === true
            ? createPluginActionHandlerNotStartedError(input)
            : new PluginError(input);
        if (state !== 'active') {
            throw preHandlerFailure({
                code: invocationOptions.contributedTarget === true
                    ? 'plugin_action_generation_retired'
                    : 'plugin_testkit_disposed',
                message: `Plugin '${manifest.id}' testkit is ${state}`,
            });
        }
        const definition = actionDefinitions.get(invocationOptions.localId);
        if (invocationOptions.contributedTarget === true
            && !definition?.surfaces.includes('plugin')) {
            throw preHandlerFailure({
                code: 'plugin_action_unavailable',
                message: `Plugin Action '${manifest.id}/actions/${invocationOptions.localId}' is not available to plugin callers`,
            });
        }
        const handler = registrationValue(
            registrations,
            'actions',
            invocationOptions.localId,
        ) as ActionHandler | undefined;
        const invocation = actionInvocations.get(invocationOptions.localId);
        if (!handler || !invocation) {
            throw preHandlerFailure({
                code: 'plugin_action_undeclared_id',
                message: `Plugin '${manifest.id}' has no registered action '${invocationOptions.localId}'`,
            });
        }
        const messageAction = invocationOptions.messageAction === undefined
            ? undefined
            : Object.freeze(MessageActionAvailableSnapshotV1Schema.parse(invocationOptions.messageAction));
        const result = await invocation.invoke(invocationOptions.input, {
            ...(invocationOptions.signal ? { signal: invocationOptions.signal } : {}),
            handler: async ({ input, qualifiedId, signal }) => {
                const context = Object.freeze({
                    plugin: Object.freeze({ id: manifest.id, version: manifest.version }),
                    contribution: Object.freeze({ id: invocationOptions.localId, qualifiedId }),
                    surface: invocationOptions.surface,
                    ...(invocationOptions.caller === undefined ? {} : { caller: invocationOptions.caller }),
                    ...(invocationOptions.sessionId === undefined
                        ? {}
                        : { session: Object.freeze({ id: invocationOptions.sessionId }) }),
                    ...(messageAction === undefined ? {} : { messageAction }),
                    signal,
                    services: createInvocationServices(invocationOptions.services, {
                        localId: invocationOptions.localId,
                        qualifiedId,
                        surface: invocationOptions.surface,
                        ...(invocationOptions.caller === undefined ? {} : { caller: invocationOptions.caller }),
                        ...(invocationOptions.sessionId === undefined
                            ? {}
                            : { sessionId: invocationOptions.sessionId }),
                        signal,
                    }),
                    ui: invocationOptions.presentation ?? defaultPresentation,
                });
                return await handler(input, context);
            },
        });
        if (result.status === 'executed') return result.value;
        // The canonical projection carries the target's own `retryable` signal
        // and published payload, so an author's test observes the same failure
        // contract a real plugin-to-plugin call delivers.
        const errorData = {
            code: result.code,
            message: result.message,
            ...(result.status !== 'failed' || result.retryable === undefined
                ? {}
                : { retryable: result.retryable }),
            ...(result.status === 'failed'
                ? readPluginActionFailureAuthorPayload(result.data)
                : {}),
        };
        const hostProvedNotStarted = result.status === 'unavailable'
            && result.actionHandlerInvocation === 'notStarted';
        throw hostProvedNotStarted
            ? createPluginActionHandlerNotStartedError(errorData)
            : new PluginError(errorData);
    }

    const actionTarget = Object.freeze({
        pluginId: manifest.id,
        immutableGenerationId: syntheticImmutableGenerationId,
        manifest,
        isCurrent(): boolean {
            return state === 'active' && !invocationLifetime.signal.aborted;
        },
        subscribeCurrentness(listener: () => void): () => void {
            currentnessListeners.add(listener);
            return () => {
                currentnessListeners.delete(listener);
            };
        },
        isAdmittedActionAvailable(localId: PluginContributionLocalId): boolean {
            return state === 'active'
                && !invocationLifetime.signal.aborted
                && actionDefinitions.get(localId)?.surfaces.includes('plugin') === true
                && actionInvocations.has(localId);
        },
        async invokeFromPlugin(
            targetInvocation: TestkitActionTargetInvocation,
        ): Promise<TestkitActionTargetInvocationResult> {
            if (targetInvocation.admittedTargetedOperation !== undefined
                && (state !== 'active'
                    || invocationLifetime.signal.aborted
                    || targetInvocation.admittedTargetedOperation.contributorImmutableGenerationId
                        !== syntheticImmutableGenerationId)) {
                throw createPluginActionHandlerNotStartedError({
                    code: 'plugin_action_generation_retired',
                    message: 'The admitted contributor generation is no longer current',
                });
            }
            const materialization = PluginMachineMaterializationRefV1Schema.safeParse(
                targetInvocation.caller.materialization,
            );
            if (!materialization.success
                || materialization.data.pluginId !== targetInvocation.caller.pluginId) {
                throw createPluginActionHandlerNotStartedError({
                    code: 'plugin_action_caller_unavailable',
                    message: 'Plugin contributed Action calls require current host-stamped caller provenance',
                });
            }
            const requiresExecutionOrigin = targetInvocation.captureExecutionOrigin === true
                || targetInvocation.expectedExecutionOrigin !== undefined;
            const beforeExecutionOrigin = requiresExecutionOrigin
                ? resolveCurrentPluginExecutionOrigin()
                : null;
            if (requiresExecutionOrigin && !beforeExecutionOrigin) {
                throw createPluginActionHandlerNotStartedError({
                    code: 'plugin_action_execution_origin_unavailable',
                    message: 'Current target execution origin is unavailable',
                });
            }
            if (beforeExecutionOrigin !== null
                && targetInvocation.expectedExecutionOrigin !== undefined
                && !arePluginMachineExecutionOriginsEqual(
                    targetInvocation.expectedExecutionOrigin,
                    beforeExecutionOrigin,
                )) {
                throw createPluginActionHandlerNotStartedError({
                    code: 'plugin_action_execution_origin_mismatch',
                    message: 'Expected target execution origin does not match the current target',
                });
            }
            const value = await invokeRegisteredAction({
                localId: targetInvocation.localId,
                input: targetInvocation.input,
                surface: 'plugin',
                signal: targetInvocation.signal,
                caller: targetInvocation.caller,
                contributedTarget: true,
            });
            if (!beforeExecutionOrigin) return Object.freeze({ value });
            const afterExecutionOrigin = resolveCurrentPluginExecutionOrigin();
            if (!afterExecutionOrigin) {
                throw new PluginError({
                    code: 'plugin_action_execution_origin_unavailable',
                    message: 'Current target execution origin is unavailable',
                });
            }
            if (!arePluginMachineExecutionOriginsEqual(beforeExecutionOrigin, afterExecutionOrigin)
                || (targetInvocation.expectedExecutionOrigin !== undefined
                    && !arePluginMachineExecutionOriginsEqual(
                        targetInvocation.expectedExecutionOrigin,
                        afterExecutionOrigin,
                    ))) {
                throw new PluginError({
                    code: 'plugin_action_execution_origin_changed',
                    message: 'Target execution origin changed while the contributed Action was running',
                });
            }
            return Object.freeze({ value, executionOrigin: afterExecutionOrigin });
        },
    } satisfies TestkitActionTarget);

    const testkit: PluginTestkit = Object.freeze({
        registrations(): readonly PluginTestkitRegistration[] {
            return Object.freeze(registrations.map(({ family, localId }) => (
                Object.freeze({ family, localId })
            )));
        },
        registration<F extends keyof PluginTestkitRegistrationByFamily>(
            family: F,
            localId: PluginContributionLocalId,
        ): PluginTestkitRegistrationByFamily[F] | undefined {
            return registrationValue(registrations, family, localId);
        },
        async invokeAction(
            localId: PluginContributionLocalId,
            actionInput: JsonValue,
            invocationOptions: PluginTestkitInvokeActionOptions = {},
        ) {
            return await invokeRegisteredAction({
                localId,
                input: actionInput,
                surface: invocationOptions.surface ?? 'cli',
                ...(invocationOptions.signal ? { signal: invocationOptions.signal } : {}),
                ...(invocationOptions.sessionId === undefined
                    ? {}
                    : { sessionId: invocationOptions.sessionId }),
                ...(invocationOptions.messageAction === undefined
                    ? {}
                    : { messageAction: invocationOptions.messageAction }),
                ...(invocationOptions.services === undefined
                    ? {}
                    : { services: invocationOptions.services }),
                ...(invocationOptions.presentation === undefined
                    ? {}
                    : { presentation: invocationOptions.presentation }),
            });
        },
        readTargetedContributionFixture,
        issueAdmittedTargetedOperation,
        dispose,
    });
    actionTargetsByTestkit.set(testkit, actionTarget);
    return testkit;
}
