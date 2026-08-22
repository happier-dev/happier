import {
    ExternalSessionRefSchema,
    ExternalSessionsSourceSchema,
    type ExternalSessionsSource,
} from '@happier-dev/protocol';
import { isPluginError, PluginError } from '@happier-dev/plugin-sdk';

import { EXTERNAL_SESSIONS_INVOCATION_POLICY } from './agentExternalSessionsInvocation';
import type {
    ExternalSessionFollowHostOperation,
    ExternalSessionFollowHostOperationRequest,
} from './followHostOperation';
import type {
    HostExternalSessionFollowTargetResolution,
    HostExternalSessionRef,
    HostExternalTranscriptFollowResult,
} from './privateContract';
import type { ExternalSessionExecutionSurface } from './providerOps';
import type {
    ConfiguredExternalSessionSourceAgentContribution,
} from './configuredSourceMaterializer';

export type ExternalSessionFollowTargetHostOperationRequest = Readonly<{
    pluginId: string;
    contributionId: string;
    generationId: string;
    sessionId: string;
    machineId: string;
    accountRevision: string;
    remoteSessionId: string;
    admissionDeadlineAtMs?: number;
    signal?: AbortSignal;
    isCurrent(): boolean;
    providerOps?: Required<Pick<
        ExternalSessionExecutionSurface,
        | 'validateSource'
        | 'resolveLinkIdentity'
        | 'pageTranscript'
        | 'readAfterTranscript'
    >>;
    agentContribution?: ConfiguredExternalSessionSourceAgentContribution;
}>;

export type ExternalSessionFollowTargetHostOperation = Readonly<{
    execute(
        request: ExternalSessionFollowTargetHostOperationRequest,
    ): Promise<HostExternalSessionFollowTargetResolution>;
}>;

export type ExternalSessionHostOperationSet = Readonly<{
    followTargetOperation?: ExternalSessionFollowTargetHostOperation | null;
    followOperation: ExternalSessionFollowHostOperation | null;
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
    agentContribution?: ConfiguredExternalSessionSourceAgentContribution;
}>;

export type BoundExternalSessionFollowRequest = Readonly<{
    ref: HostExternalSessionRef;
    source: ExternalSessionsSource;
    options: ExternalSessionFollowHostOperationRequest['options'];
    listener: ExternalSessionFollowHostOperationRequest['listener'];
    providerOps?: Required<Pick<
        ExternalSessionExecutionSurface,
        'pageTranscript' | 'readAfterTranscript'
    >>;
}>;

export type BoundExternalSessionProviderSessionFollowRequest = Readonly<{
    agentId: string;
    providerSessionId: string;
    options: ExternalSessionFollowHostOperationRequest['options'];
    listener: ExternalSessionFollowHostOperationRequest['listener'];
    providerOps?: Required<Pick<
        ExternalSessionExecutionSurface,
        | 'validateSource'
        | 'resolveLinkIdentity'
        | 'pageTranscript'
        | 'readAfterTranscript'
    >>;
}>;

export type ExternalSessionHostOperationPort = Readonly<{
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
    /**
     * Whether a follow can actually run right now. The owner is constructed
     * unconditionally at daemon startup, but a generation is installed into it only
     * during machine-RPC registration — so the owner *existing* does not mean follow
     * is runnable. Capability reporting must read this live rather than infer
     * runnability from the presence of a `followTranscript` function reference.
     */
    canFollowNow(): boolean;
    retire(): Promise<void>;
}>;

type ActiveFollow = Readonly<{
    dispose(): Promise<void>;
    retire(): Promise<void>;
}>;

type OwnerGeneration = {
    readonly operations: ExternalSessionHostOperationSet;
    readonly retirement: AbortController;
    readonly activeFollows: Set<ActiveFollow>;
    retirementPromise: Promise<void> | null;
};

const MAX_ACTIVE_FOLLOWS_PER_BINDING = 64;
const MAX_FOLLOW_EVENT_SERIALIZED_BYTES = 1024 * 1024;
const EXTERNAL_SESSION_FOLLOW_DISPOSE_TIMEOUT_MS = 5_000;

function fail(code: string): never {
    throw new PluginError({ code, message: code });
}

function unavailableFollow(code: string): HostExternalTranscriptFollowResult {
    return Object.freeze({ status: 'unavailable', code });
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
    const parsedRef = ExternalSessionRefSchema.safeParse(target.ref);
    if (!parsedRef.success) return null;
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
        ref: Object.freeze(parsedRef.data),
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
        if (isPluginError(error)) throw error;
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
    const attempt = generation.retirementPromise ??= (async () => {
        // Snapshot before aborting: the abort listener starts each follow's own
        // retirement, and a follow whose cleanup fails stays in `activeFollows`
        // so this snapshot (and every later retry) keeps exact custody of it.
        const activeFollows = Array.from(generation.activeFollows);
        generation.retirement.abort();
        await Promise.all(
            activeFollows.map(async (follow) => await follow.retire()),
        );
    })();
    try {
        await attempt;
    } catch (error) {
        // Follow subscription cleanup is allowed to reject once and succeed on
        // retry (`followHostOperation` proves that contract). Caching the rejected
        // attempt would make the exact same cleanup permanently unreachable.
        if (generation.retirementPromise === attempt) {
            generation.retirementPromise = null;
        }
        throw error;
    }
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
                agentContribution: identityInput.agentContribution,
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
                    activeFollows.map(async (follow) => await follow.retire()),
                );
            };

            const port: ExternalSessionHostOperationPort = Object.freeze({
                async executeFollow(request) {
                    if (request.ref.agentId !== identity.agentId) {
                        return unavailableFollow(
                            'plugin_external_follow_identity_mismatch',
                        );
                    }
                    if (request.options.signal?.aborted) {
                        return unavailableFollow('plugin_operation_aborted');
                    }
                    // A binding taken before any generation was installed is not a
                    // *retired* generation — it is a host that never had one. Reporting
                    // retirement here makes the failure unattributable, which is exactly
                    // how this defect stayed hidden behind a plausible-sounding code.
                    // A retired owner, by contrast, genuinely is retired.
                    if (boundGeneration === null) {
                        return unavailableFollow(
                            retired
                                ? 'plugin_generation_retired'
                                : 'plugin_external_follow_host_operations_uninstalled',
                        );
                    }
                    if (!isBindingCurrent()) {
                        return unavailableFollow('plugin_generation_retired');
                    }
                    const generation = boundGeneration;
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
                    let explicitDisposePending = false;
                    let disposedAcknowledgementSeen = false;
                    let listenerFailed = false;
                    const activeSignal = AbortSignal.any([
                        lifecycleSignal,
                        ...(request.options.signal
                            ? [request.options.signal]
                            : []),
                    ]);
                    const settleDisposal = async (
                        admitDisposedAcknowledgement: boolean,
                    ): Promise<void> => {
                        if (!disposal) {
                            explicitDisposePending =
                                admitDisposedAcknowledgement;
                            if (!admitDisposedAcknowledgement) {
                                disposed = true;
                            }
                            disposal = (async () => {
                                activeSignal.removeEventListener(
                                    'abort',
                                    onLifecycleAbort,
                                );
                                const currentSubscription = subscription;
                                try {
                                    await disposeFollowSubscriptionBounded(
                                        currentSubscription
                                            ? () => currentSubscription.dispose()
                                            : undefined,
                                    );
                                } finally {
                                    disposed = true;
                                    explicitDisposePending = false;
                                }
                                // Ownership is surrendered only once cleanup has
                                // actually settled. A rejecting disposer keeps this
                                // follow discoverable through the owner so binding
                                // and generation retirement retry the exact same
                                // cleanup instead of losing custody of it.
                                bindingFollows.delete(active);
                                generation.activeFollows.delete(active);
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
                    };
                    const active: ActiveFollow = Object.freeze({
                        async dispose() {
                            await settleDisposal(true);
                        },
                        async retire() {
                            await settleDisposal(false);
                        },
                    });
                    function onLifecycleAbort(): void {
                        // Abort-triggered retirement is owner-driven cleanup, not a
                        // caller promise: the daemon turns an unhandled rejection into
                        // `requestShutdown('exception')`, so one plugin disposer failing
                        // must not take the daemon down. The failure is not discarded —
                        // `settleDisposal` keeps this follow in the owner's active sets
                        // and clears its in-flight disposal, so the next owned retirement
                        // retries the exact same cleanup and surfaces the failure there.
                        void active.retire().catch(() => undefined);
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
                            const isDisposedAcknowledgement =
                                explicitDisposePending
                                && !disposedAcknowledgementSeen
                                && event.kind === 'terminated'
                                && event.reason === 'disposed';
                            if (
                                (explicitDisposePending
                                    && !isDisposedAcknowledgement)
                                || disposed
                                || activeSignal.aborted
                            ) {
                                fail('plugin_external_follow_unavailable');
                            }
                            if (isDisposedAcknowledgement) {
                                disposedAcknowledgementSeen = true;
                            }
                            try {
                                assertFollowEventBounded(event);
                                await request.listener(event);
                            } catch (error) {
                                listenerFailed = true;
                                if (!explicitDisposePending) {
                                    await active.retire();
                                }
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
                            ...(request.providerOps
                                ? { providerOps: request.providerOps }
                                : {}),
                        });
                    } catch (error) {
                        await active.retire();
                        throw error;
                    }
                    if (result.status !== 'following') {
                        await active.retire();
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
                        subscription: Object.freeze({
                            dispose: async () => await active.dispose(),
                        }),
                    });
                },
                async executeProviderSessionFollow(request) {
                    if (
                        request.agentId !== identity.agentId
                        || !ExternalSessionRefSchema.shape.remoteSessionId
                            .safeParse(request.providerSessionId).success
                    ) {
                        return unavailableFollow(
                            'plugin_external_follow_identity_mismatch',
                        );
                    }
                    if (request.options.signal?.aborted) {
                        return unavailableFollow('plugin_operation_aborted');
                    }
                    // Same distinction as executeFollow: never-installed is not retired.
                    if (boundGeneration === null) {
                        return unavailableFollow(
                            retired
                                ? 'plugin_generation_retired'
                                : 'plugin_external_follow_host_operations_uninstalled',
                        );
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
                        ...(request.options.admissionDeadlineAtMs === undefined
                            ? {}
                            : {
                                admissionDeadlineAtMs:
                                    request.options.admissionDeadlineAtMs,
                            }),
                        signal,
                        isCurrent: isBindingCurrent,
                        ...(request.providerOps
                            ? { providerOps: request.providerOps }
                            : {}),
                        ...(identity.agentContribution
                            ? { agentContribution: identity.agentContribution }
                            : {}),
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
                        ...(request.providerOps
                            ? { providerOps: request.providerOps }
                            : {}),
                    });
                },
                retire: retireBinding,
            });
            return port;
        },
        canFollowNow() {
            return !retired
                && currentGeneration !== null
                && !currentGeneration.retirement.signal.aborted
                && currentGeneration.operations.followOperation != null;
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
                try {
                    await retireOwnerGeneration(priorGeneration);
                } catch (error) {
                    // Installation failed, so the provisional replacement must not stay
                    // callable without a returned cleanup handle. Retire it and restore
                    // the prior (now aborted, so no longer runnable) generation as
                    // current: installing again retries the exact same prior cleanup.
                    if (currentGeneration === installedGeneration) {
                        currentGeneration = priorGeneration;
                    }
                    try {
                        await retireOwnerGeneration(installedGeneration);
                    } catch (replacementError) {
                        throw new AggregateError(
                            [error, replacementError],
                            'External Session host-operation installation failed',
                        );
                    }
                    throw error;
                }
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
