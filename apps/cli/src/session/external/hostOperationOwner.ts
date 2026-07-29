import {
    ExternalSessionsSourceSchema,
    type ExternalSessionsSource,
} from '@happier-dev/protocol';
import { PluginError } from '@happier-dev/plugin-sdk';

import { EXTERNAL_SESSIONS_INVOCATION_POLICY } from './agentExternalSessionsInvocation';
import type {
    ExternalSessionFollowHostOperation,
    ExternalSessionFollowHostOperationRequest,
} from './followHostOperation';
import type {
    ExternalSessionTakeoverHostOperation,
    ExternalSessionTakeoverHostOperationRequest,
} from './takeoverHostOperation';
import type {
    HostExternalSessionFollowTargetResolution,
    HostExternalSessionRef,
    HostExternalTranscriptFollowResult,
} from './privateContract';

export type ExternalSessionFollowTargetHostOperationRequest = Readonly<{
    pluginId: string;
    contributionId: string;
    generationId: string;
    sessionId: string;
    machineId: string;
    accountRevision: string;
    remoteSessionId: string;
    signal?: AbortSignal;
    isCurrent(): boolean;
}>;

export type ExternalSessionFollowTargetHostOperation = Readonly<{
    execute(
        request: ExternalSessionFollowTargetHostOperationRequest,
    ): Promise<HostExternalSessionFollowTargetResolution>;
}>;

export type ExternalSessionHostOperationSet = Readonly<{
    followTargetOperation?: ExternalSessionFollowTargetHostOperation | null;
    followOperation: ExternalSessionFollowHostOperation | null;
    takeoverOperation: ExternalSessionTakeoverHostOperation | null;
}>;

export type ExternalSessionHostOperationBinding = Readonly<{
    pluginId: string;
    agentId: string;
    generationId: string;
    sessionId: string;
    machineId: string;
    readAccountRevision(): string | null;
    sessionSignal?: AbortSignal;
    generationRetirementSignal?: AbortSignal;
    isGenerationCurrent(): boolean;
}>;

export type BoundExternalSessionTakeoverRequest = Readonly<{
    ref: HostExternalSessionRef;
    source: ExternalSessionsSource;
    signal?: AbortSignal;
}>;

export type BoundExternalSessionFollowRequest = Readonly<{
    ref: HostExternalSessionRef;
    source: ExternalSessionsSource;
    options: ExternalSessionFollowHostOperationRequest['options'];
    listener: ExternalSessionFollowHostOperationRequest['listener'];
}>;

export type BoundExternalSessionProviderSessionFollowRequest = Readonly<{
    agentId: string;
    providerSessionId: string;
    options: ExternalSessionFollowHostOperationRequest['options'];
    listener: ExternalSessionFollowHostOperationRequest['listener'];
}>;

export type ExternalSessionHostOperationPort = Readonly<{
    executeTakeover(
        request: BoundExternalSessionTakeoverRequest,
    ): ReturnType<ExternalSessionTakeoverHostOperation['execute']>;
    executeFollow(
        request: BoundExternalSessionFollowRequest,
    ): Promise<HostExternalTranscriptFollowResult>;
    executeProviderSessionFollow(
        request: BoundExternalSessionProviderSessionFollowRequest,
    ): Promise<HostExternalTranscriptFollowResult>;
    retire(): Promise<void>;
}>;

export type ExternalSessionHostOperationInstallation = Readonly<{
    dispose(): Promise<void>;
}>;

export type ExternalSessionHostOperationOwner = Readonly<{
    bind(
        binding: ExternalSessionHostOperationBinding,
    ): ExternalSessionHostOperationPort;
    install(
        operations: ExternalSessionHostOperationSet,
    ): Promise<ExternalSessionHostOperationInstallation>;
    retire(): Promise<void>;
}>;

type ActiveFollow = Readonly<{
    dispose(): Promise<void>;
}>;

type OwnerGeneration = {
    readonly operations: ExternalSessionHostOperationSet;
    readonly retirement: AbortController;
    readonly activeFollows: Set<ActiveFollow>;
    retirementPromise: Promise<void> | null;
};

const MAX_ACTIVE_FOLLOWS_PER_BINDING = 64;
const MAX_FOLLOW_EVENT_SERIALIZED_BYTES = 1024 * 1024;
const MAX_REMOTE_SESSION_ID_CODE_UNITS = 2_000;
const EXTERNAL_SESSION_FOLLOW_DISPOSE_TIMEOUT_MS = 5_000;

function fail(code: string): never {
    throw new PluginError({ code, message: code });
}

function unavailableFollow(code: string): HostExternalTranscriptFollowResult {
    return Object.freeze({ status: 'unavailable', code });
}

function isCanonicalBoundedRemoteSessionId(value: unknown): value is string {
    return typeof value === 'string'
        && value.length > 0
        && value.length <= MAX_REMOTE_SESSION_ID_CODE_UNITS
        && value === value.trim();
}

function readResolvedFollowTarget(
    value: unknown,
): Extract<
    HostExternalSessionFollowTargetResolution,
    { status: 'resolved' }
> | null {
    if (!value || typeof value !== 'object') return null;
    const target = value as Readonly<Record<string, unknown>>;
    if (
        target.status !== 'resolved'
        || !target.ref
        || typeof target.ref !== 'object'
    ) {
        return null;
    }
    const ref = target.ref as Readonly<Record<string, unknown>>;
    if (
        typeof ref.agentId !== 'string'
        || ref.agentId.length === 0
        || ref.agentId !== ref.agentId.trim()
        || typeof ref.sourceId !== 'string'
        || ref.sourceId.length === 0
        || ref.sourceId !== ref.sourceId.trim()
        || ref.sourceId.length > MAX_REMOTE_SESSION_ID_CODE_UNITS
        || !isCanonicalBoundedRemoteSessionId(ref.remoteSessionId)
    ) {
        return null;
    }
    const parsedSource = ExternalSessionsSourceSchema.safeParse(target.source);
    if (!parsedSource.success) return null;
    try {
        const serialized = JSON.stringify(parsedSource.data);
        if (
            serialized === undefined
            || Buffer.byteLength(serialized, 'utf8')
                > EXTERNAL_SESSIONS_INVOCATION_POLICY.sourceMaxSerializedBytes
        ) {
            return null;
        }
    } catch {
        return null;
    }
    return Object.freeze({
        status: 'resolved',
        ref: Object.freeze({
            agentId: ref.agentId,
            sourceId: ref.sourceId,
            remoteSessionId: ref.remoteSessionId,
        }),
        source: parsedSource.data,
    });
}

function readUnavailableFollowTarget(
    value: unknown,
): Extract<
    HostExternalSessionFollowTargetResolution,
    { status: 'unavailable' }
> | null {
    if (!value || typeof value !== 'object') return null;
    const target = value as Readonly<Record<string, unknown>>;
    if (
        target.status !== 'unavailable'
        || typeof target.code !== 'string'
        || target.code.length === 0
        || target.code.length > 256
        || target.code !== target.code.trim()
    ) {
        return null;
    }
    return Object.freeze({
        status: 'unavailable',
        code: target.code,
    });
}

function readIdentity(value: string, code: string): string {
    const normalized = value.trim();
    return normalized || fail(code);
}

function readCurrentAccountRevision(
    readAccountRevision: () => string | null,
): string {
    try {
        return readIdentity(
            readAccountRevision() ?? '',
            'plugin_external_operation_identity_invalid',
        );
    } catch (error) {
        if (error instanceof PluginError) throw error;
        return fail('plugin_external_operation_identity_invalid');
    }
}

function assertFollowEventBounded(
    event: Parameters<
        ExternalSessionFollowHostOperationRequest['listener']
    >[0],
): void {
    let serialized: string;
    try {
        serialized = JSON.stringify(event);
    } catch {
        return fail('plugin_external_follow_event_invalid');
    }
    if (
        Buffer.byteLength(serialized, 'utf8')
        > MAX_FOLLOW_EVENT_SERIALIZED_BYTES
    ) {
        fail('plugin_external_follow_event_too_large');
    }
}

function createOwnerGeneration(
    operations: ExternalSessionHostOperationSet,
): OwnerGeneration {
    return {
        operations: Object.freeze({
            followTargetOperation:
                operations.followTargetOperation ?? null,
            followOperation: operations.followOperation,
            takeoverOperation: operations.takeoverOperation,
        }),
        retirement: new AbortController(),
        activeFollows: new Set(),
        retirementPromise: null,
    };
}

async function disposeFollowSubscriptionBounded(
    dispose: (() => void | Promise<void>) | undefined,
): Promise<void> {
    if (!dispose) return;
    const disposal = Promise.resolve().then(dispose);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        await Promise.race([
            disposal,
            new Promise<void>((resolve) => {
                timer = setTimeout(
                    resolve,
                    EXTERNAL_SESSION_FOLLOW_DISPOSE_TIMEOUT_MS,
                );
                timer.unref?.();
            }),
        ]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
    void disposal.catch(() => undefined);
}

async function retireOwnerGeneration(generation: OwnerGeneration): Promise<void> {
    generation.retirementPromise ??= (async () => {
        const activeFollows = Array.from(generation.activeFollows);
        generation.retirement.abort();
        await Promise.all(
            activeFollows.map(async (follow) => await follow.dispose()),
        );
    })();
    await generation.retirementPromise;
}

export function createExternalSessionHostOperationOwner(): ExternalSessionHostOperationOwner {
    let retired = false;
    let currentGeneration: OwnerGeneration | null = null;

    const owner: ExternalSessionHostOperationOwner = Object.freeze({
        bind(identityInput) {
            const accountRevision = readCurrentAccountRevision(
                identityInput.readAccountRevision,
            );
            const identity = Object.freeze({
                pluginId: readIdentity(
                    identityInput.pluginId,
                    'plugin_external_operation_identity_invalid',
                ),
                agentId: readIdentity(
                    identityInput.agentId,
                    'plugin_external_operation_identity_invalid',
                ),
                generationId: readIdentity(
                    identityInput.generationId,
                    'plugin_external_operation_identity_invalid',
                ),
                sessionId: readIdentity(
                    identityInput.sessionId,
                    'plugin_external_operation_identity_invalid',
                ),
                machineId: readIdentity(
                    identityInput.machineId,
                    'plugin_external_operation_identity_invalid',
                ),
                accountRevision,
                readAccountRevision: identityInput.readAccountRevision,
                sessionSignal: identityInput.sessionSignal,
                generationRetirementSignal:
                    identityInput.generationRetirementSignal,
                isGenerationCurrent: identityInput.isGenerationCurrent,
            });
            const boundGeneration = currentGeneration;
            const bindingRetirement = new AbortController();
            const bindingFollows = new Set<ActiveFollow>();
            const lifecycleSignal = AbortSignal.any([
                bindingRetirement.signal,
                ...(boundGeneration
                    ? [boundGeneration.retirement.signal]
                    : []),
                ...(identity.sessionSignal ? [identity.sessionSignal] : []),
                ...(identity.generationRetirementSignal
                    ? [identity.generationRetirementSignal]
                    : []),
            ]);

            const isBindingCurrent = (): boolean => {
                if (
                    retired
                    || boundGeneration === null
                    || currentGeneration !== boundGeneration
                    || lifecycleSignal.aborted
                ) {
                    return false;
                }
                try {
                    return (
                        identity.isGenerationCurrent() === true
                        && readCurrentAccountRevision(
                            identity.readAccountRevision,
                        )
                            === identity.accountRevision
                    );
                } catch {
                    return false;
                }
            };

            const retireBinding = async (): Promise<void> => {
                const activeFollows = Array.from(bindingFollows);
                bindingRetirement.abort();
                await Promise.all(
                    activeFollows.map(async (follow) => await follow.dispose()),
                );
            };

            const port: ExternalSessionHostOperationPort = Object.freeze({
                async executeTakeover(request) {
                    if (request.ref.agentId !== identity.agentId) {
                        fail('plugin_external_takeover_identity_mismatch');
                    }
                    if (request.signal?.aborted) {
                        fail('plugin_operation_aborted');
                    }
                    if (!isBindingCurrent()) {
                        fail('plugin_generation_retired');
                    }
                    const generation = boundGeneration;
                    if (!generation) {
                        fail('plugin_generation_retired');
                    }
                    const operation =
                        generation.operations.takeoverOperation;
                    if (!operation) {
                        fail('plugin_external_takeover_unavailable');
                    }
                    const signal = AbortSignal.any([
                        lifecycleSignal,
                        ...(request.signal ? [request.signal] : []),
                    ]);
                    const operationRequest:
                        ExternalSessionTakeoverHostOperationRequest = {
                            pluginId: identity.pluginId,
                            contributionId: identity.agentId,
                            generationId: identity.generationId,
                            accountRevision: identity.accountRevision,
                            sessionId: identity.sessionId,
                            machineId: identity.machineId,
                            ref: request.ref,
                            source: request.source,
                            signal,
                            isCurrent: isBindingCurrent,
                        };
                    // The delegated operation owns its takeover commit boundary.
                    // A successful return is never post-checked and relabeled here.
                    return await operation.execute(operationRequest);
                },
                async executeFollow(request) {
                    if (request.ref.agentId !== identity.agentId) {
                        return unavailableFollow(
                            'plugin_external_follow_identity_mismatch',
                        );
                    }
                    if (request.options.signal?.aborted) {
                        return unavailableFollow('plugin_operation_aborted');
                    }
                    if (!isBindingCurrent()) {
                        return unavailableFollow('plugin_generation_retired');
                    }
                    const generation = boundGeneration;
                    if (!generation) {
                        return unavailableFollow('plugin_generation_retired');
                    }
                    const operation = generation.operations.followOperation;
                    if (!operation) {
                        return unavailableFollow(
                            'plugin_external_follow_unavailable',
                        );
                    }
                    if (
                        bindingFollows.size
                        >= MAX_ACTIVE_FOLLOWS_PER_BINDING
                    ) {
                        return unavailableFollow(
                            'plugin_external_follow_limit_exceeded',
                        );
                    }

                    let disposal: Promise<void> | null = null;
                    let subscription:
                        Extract<
                            HostExternalTranscriptFollowResult,
                            { status: 'following' }
                        >['subscription']
                        | null = null;
                    let disposed = false;
                    let listenerFailed = false;
                    const activeSignal = AbortSignal.any([
                        lifecycleSignal,
                        ...(request.options.signal
                            ? [request.options.signal]
                            : []),
                    ]);
                    const active: ActiveFollow = Object.freeze({
                        async dispose() {
                            if (!disposal) {
                                disposal = (async () => {
                                    disposed = true;
                                    activeSignal.removeEventListener(
                                        'abort',
                                        onLifecycleAbort,
                                    );
                                    bindingFollows.delete(active);
                                    generation.activeFollows.delete(active);
                                    const currentSubscription = subscription;
                                    await disposeFollowSubscriptionBounded(
                                        currentSubscription
                                            ? () => currentSubscription.dispose()
                                            : undefined,
                                    );
                                })();
                            }
                            const disposalAttempt = disposal;
                            try {
                                await disposalAttempt;
                            } catch (error) {
                                if (disposal === disposalAttempt) {
                                    disposal = null;
                                }
                                throw error;
                            }
                        },
                    });
                    function onLifecycleAbort(): void {
                        void active.dispose();
                    }
                    bindingFollows.add(active);
                    generation.activeFollows.add(active);
                    activeSignal.addEventListener(
                        'abort',
                        onLifecycleAbort,
                        { once: true },
                    );

                    const listener:
                        ExternalSessionFollowHostOperationRequest['listener'] =
                        async (event) => {
                            if (disposed) {
                                fail('plugin_external_follow_unavailable');
                            }
                            try {
                                assertFollowEventBounded(event);
                                await request.listener(event);
                            } catch (error) {
                                listenerFailed = true;
                                await active.dispose();
                                throw error;
                            }
                        };

                    let result: HostExternalTranscriptFollowResult;
                    try {
                        result = await operation.execute({
                            pluginId: identity.pluginId,
                            contributionId: identity.agentId,
                            generationId: identity.generationId,
                            sessionId: identity.sessionId,
                            machineId: identity.machineId,
                            ref: request.ref,
                            source: request.source,
                            options: request.options,
                            listener,
                            retirementSignal: lifecycleSignal,
                            isCurrent: isBindingCurrent,
                        });
                    } catch (error) {
                        await active.dispose();
                        throw error;
                    }
                    if (result.status !== 'following') {
                        await active.dispose();
                        return result;
                    }
                    const resolvedSubscription = result.subscription;
                    subscription = resolvedSubscription;
                    if (
                        disposed
                        || listenerFailed
                        || activeSignal.aborted
                        || !isBindingCurrent()
                    ) {
                        await disposeFollowSubscriptionBounded(
                            () => resolvedSubscription.dispose(),
                        );
                        return unavailableFollow(
                            listenerFailed
                                ? 'plugin_external_follow_listener_failed'
                                : request.options.signal?.aborted
                                    ? 'plugin_operation_aborted'
                                    : 'plugin_generation_retired',
                        );
                    }
                    return Object.freeze({
                        status: 'following',
                        startingCursor: result.startingCursor,
                        subscription: active,
                    });
                },
                async executeProviderSessionFollow(request) {
                    if (
                        request.agentId !== identity.agentId
                        || !isCanonicalBoundedRemoteSessionId(
                            request.providerSessionId,
                        )
                    ) {
                        return unavailableFollow(
                            'plugin_external_follow_identity_mismatch',
                        );
                    }
                    if (request.options.signal?.aborted) {
                        return unavailableFollow('plugin_operation_aborted');
                    }
                    if (!isBindingCurrent()) {
                        return unavailableFollow('plugin_generation_retired');
                    }
                    if (
                        bindingFollows.size
                        >= MAX_ACTIVE_FOLLOWS_PER_BINDING
                    ) {
                        return unavailableFollow(
                            'plugin_external_follow_limit_exceeded',
                        );
                    }
                    const generation = boundGeneration;
                    if (!generation) {
                        return unavailableFollow('plugin_generation_retired');
                    }
                    const operation =
                        generation.operations.followTargetOperation;
                    if (!operation) {
                        return unavailableFollow(
                            'plugin_external_follow_unavailable',
                        );
                    }
                    const signal = AbortSignal.any([
                        lifecycleSignal,
                        ...(request.options.signal
                            ? [request.options.signal]
                            : []),
                    ]);
                    const target: unknown = await operation.execute({
                        pluginId: identity.pluginId,
                        contributionId: identity.agentId,
                        generationId: identity.generationId,
                        sessionId: identity.sessionId,
                        machineId: identity.machineId,
                        accountRevision: identity.accountRevision,
                        remoteSessionId: request.providerSessionId,
                        signal,
                        isCurrent: isBindingCurrent,
                    });
                    const unavailableTarget =
                        readUnavailableFollowTarget(target);
                    if (unavailableTarget) return unavailableTarget;
                    const resolvedTarget = readResolvedFollowTarget(target);
                    if (
                        !resolvedTarget
                        || signal.aborted
                        || !isBindingCurrent()
                    ) {
                        return unavailableFollow(
                            !resolvedTarget
                                ? 'plugin_external_follow_identity_unavailable'
                                : request.options.signal?.aborted
                                    ? 'plugin_operation_aborted'
                                    : 'plugin_generation_retired',
                        );
                    }
                    if (
                        resolvedTarget.ref.agentId !== identity.agentId
                        || resolvedTarget.ref.remoteSessionId
                            !== request.providerSessionId
                    ) {
                        return unavailableFollow(
                            'plugin_external_follow_identity_mismatch',
                        );
                    }
                    return await port.executeFollow({
                        ref: resolvedTarget.ref,
                        source: resolvedTarget.source,
                        options: request.options,
                        listener: request.listener,
                    });
                },
                retire: retireBinding,
            });
            return port;
        },
        async install(operations) {
            if (retired) {
                throw new Error(
                    'External Session host-operation owner is retired',
                );
            }
            const installedGeneration = createOwnerGeneration(operations);
            const priorGeneration = currentGeneration;
            currentGeneration = installedGeneration;
            if (priorGeneration) {
                await retireOwnerGeneration(priorGeneration);
            }
            let disposed = false;
            return Object.freeze({
                async dispose() {
                    if (disposed) return;
                    disposed = true;
                    if (currentGeneration === installedGeneration) {
                        currentGeneration = null;
                    }
                    await retireOwnerGeneration(installedGeneration);
                },
            });
        },
        async retire() {
            if (retired) return;
            retired = true;
            const priorGeneration = currentGeneration;
            currentGeneration = null;
            if (priorGeneration) {
                await retireOwnerGeneration(priorGeneration);
            }
        },
    });
    return owner;
}
