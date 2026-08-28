import {
    ExternalSessionRefSchema,
    ExternalSessionsSourceSchema,
    type ExternalSessionsSource,
} from '@happier-dev/protocol';
import { measureSerializedValidatedStrictPluginJsonUtf8Bytes } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { isPluginError, PluginError } from '@happier-dev/plugin-sdk';

import {
    createExternalSessionFollowCleanupCustody,
    isExternalSessionFollowCleanupDeadline,
} from './followCleanupSettlement';
import {
    EXTERNAL_SESSION_FOLLOW_LISTENER_TIMEOUT_MS,
    settleFollowListenerBounded,
} from './followListenerSettlement';
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

const MAX_FOLLOW_EVENT_SERIALIZED_BYTES = 1024 * 1024;
export const EXTERNAL_SESSION_FOLLOW_DISPOSE_TIMEOUT_MS = 5_000;
/**
 * Transport bound for a follow-close request, one round trip of slack over the
 * dispose boundary this owner promises. Every carrier that closes a follow over
 * a runner/daemon transport uses it, so no carrier can wait on the platform
 * default (minutes) while a caller believes disposal is bounded.
 */
export const EXTERNAL_SESSION_FOLLOW_CLOSE_TRANSPORT_TIMEOUT_MS =
    EXTERNAL_SESSION_FOLLOW_DISPOSE_TIMEOUT_MS + 1_000;

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
    // The canonical source parser already enforces the strict-JSON shape and
    // the serialized-byte budget this owner used to re-measure, so a second
    // walk here can only ever agree with it.
    const parsedSource = ExternalSessionsSourceSchema.safeParse(target.source);
    if (!parsedSource.success) return null;
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

/**
 * Sizes an admitted follow event through the canonical iterative Protocol byte
 * owner. Recursive serialization would reclassify a valid deep transcript event
 * as invalid, so the declared byte ceiling stays the only bound.
 */
function assertFollowEventBounded(
    event: Parameters<
        ExternalSessionFollowHostOperationRequest['listener']
    >[0],
): void {
    let serializedBytes: number;
    try {
        serializedBytes = measureSerializedValidatedStrictPluginJsonUtf8Bytes(
            event,
            'External Session follow event',
            MAX_FOLLOW_EVENT_SERIALIZED_BYTES,
        );
    } catch {
        return fail('plugin_external_follow_event_invalid');
    }
    if (serializedBytes > MAX_FOLLOW_EVENT_SERIALIZED_BYTES) {
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
                    let disposal: Promise<void> | null = null;
                    const cleanupCustody =
                        createExternalSessionFollowCleanupCustody(
                            EXTERNAL_SESSION_FOLLOW_DISPOSE_TIMEOUT_MS,
                        );
                    type FollowSubscription = Extract<
                        HostExternalTranscriptFollowResult,
                        { status: 'following' }
                    >['subscription'];
                    let subscription: FollowSubscription | null = null;
                    /**
                     * The handle the newest settled disposal actually released.
                     * `null` after a disposal that ran before acquisition had one,
                     * which is how a late acquisition is recognized.
                     */
                    let disposedSubscription: FollowSubscription | null = null;
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
                    const startDisposal = (
                        admitDisposedAcknowledgement: boolean,
                    ): Promise<void> => {
                        explicitDisposePending = admitDisposedAcknowledgement;
                        if (!admitDisposedAcknowledgement) {
                            disposed = true;
                        }
                        const attempt = (async () => {
                            activeSignal.removeEventListener(
                                'abort',
                                onLifecycleAbort,
                            );
                            const currentSubscription = subscription;
                            try {
                                if (currentSubscription) {
                                    try {
                                        await cleanupCustody.settle(
                                            async () =>
                                                await currentSubscription
                                                    .dispose(),
                                        );
                                    } catch (error) {
                                        // An explicit caller disposal owns this
                                        // outcome: cleanup that failed, or that
                                        // has not settled by the ceiling, is not
                                        // disposal, so the handle stays in the
                                        // owner's active sets below and the
                                        // exact cleanup is retried. Owner-driven
                                        // retirement is the final bounded
                                        // lifecycle fence instead — generation
                                        // replacement and daemon shutdown must
                                        // not be blocked by one plugin disposer
                                        // that never answers — so it surrenders
                                        // the handle at the ceiling while still
                                        // reporting a disposer that rejected.
                                        if (
                                            admitDisposedAcknowledgement
                                            || !isExternalSessionFollowCleanupDeadline(
                                                error,
                                            )
                                        ) {
                                            throw error;
                                        }
                                    }
                                }
                                disposedSubscription = currentSubscription;
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
                        disposal = attempt;
                        return attempt;
                    };
                    const settleDisposal = async (
                        admitDisposedAcknowledgement: boolean,
                    ): Promise<void> => {
                        for (;;) {
                            const attempt = disposal
                                ?? startDisposal(admitDisposedAcknowledgement);
                            try {
                                await attempt;
                            } catch (error) {
                                if (disposal === attempt) {
                                    disposal = null;
                                }
                                throw error;
                            }
                            if (
                                disposal !== attempt
                                || subscription === null
                                || disposedSubscription === subscription
                            ) {
                                return;
                            }
                            // Retirement can settle while acquisition is still in
                            // flight, in which case that disposal had no handle to
                            // release. The subscription acquisition then hands back
                            // is still this follow's to clean up, so it is admitted
                            // back into the same state machine instead of being
                            // disposed outside the owner. The decision is made only
                            // once the previous attempt has settled, so a concurrent
                            // caller joins that attempt instead of starting a second
                            // physical disposal of the same handle.
                            disposal = null;
                            bindingFollows.add(active);
                            generation.activeFollows.add(active);
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
                                await settleFollowListenerBounded(
                                    Promise.resolve().then(async () =>
                                        await request.listener(event)),
                                    EXTERNAL_SESSION_FOLLOW_LISTENER_TIMEOUT_MS,
                                    activeSignal,
                                );
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
                        // Late settlement is retired through `ActiveFollow`, not
                        // disposed beside it: a pre-ceiling cleanup rejection then
                        // keeps the exact handle discoverable through the owner for
                        // retry instead of dropping it.
                        await active.retire();
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
