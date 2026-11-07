import { ExternalSessionRefSchema } from '@happier-dev/protocol/sessions/external/sourceCatalog';
import { ExternalSessionsSourceSchema } from '@happier-dev/protocol/sessions/external/sourceCatalog';
import { PluginAgentExternalSessionLinkDataSchema } from '@happier-dev/protocol/plugins/contributions/agentExternalSessions';
import type { ExternalSessionsSource } from '@happier-dev/protocol';
import type { StoredCredentials } from '@/persistence';
import { isPluginError, PluginError } from '@happier-dev/plugin-sdk';

import { settleFollowListener } from './followListenerSettlement';
import type {
    ExternalSessionFollowHostOperation,
    ExternalSessionFollowHostOperationRequest,
} from './followHostOperation';
import type {
    HostExternalSessionFollowTargetResolution,
    HostExternalSessionFollowTarget,
    HostExternalSessionRef,
    HostExternalTranscriptFollowResult,
} from './privateContract';
import type { ExternalSessionExecutionSurface } from './providerOps';
import type {
    ConfiguredExternalSessionSourceAgentContribution,
} from './configuredSourceMaterializer';

/** Captured by the installed daemon host from the exact Session's private custody; never runner wire data. */
export type ExternalSessionHostAccountContext = Readonly<{
    credentials: StoredCredentials;
    agentSettings: unknown;
    serverId: string;
    activeServerDir: string;
}>;

export type ExternalSessionFollowTargetHostOperationRequest = Readonly<{
    accountContext?: ExternalSessionHostAccountContext;
    pluginId: string;
    contributionId: string;
    occurrenceId: string;
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
    occurrenceId: string;
    sessionId: string;
    machineId: string;
    readAccountRevision(): string | null;
    sessionSignal?: AbortSignal;
    occurrenceRetirementSignal?: AbortSignal;
    isOccurrenceCurrent(): boolean;
    agentContribution?: ConfiguredExternalSessionSourceAgentContribution;
}>;

export type BoundExternalSessionFollowRequest = Readonly<{
    providerSessionTarget?: Pick<HostExternalSessionFollowTarget, 'linkData'>;
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
    ): ExternalSessionHostOperationPort & Readonly<{
        isCurrent(): boolean;
        waitForRebind(signal?: AbortSignal): Promise<boolean>;
    }>;
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

function fail(code: string): never {
    throw new PluginError({ code, message: code });
}

function unavailableFollow(code: string): HostExternalTranscriptFollowResult {
    return Object.freeze({ status: 'unavailable', code, retryable: false });
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
        ...(target.linkData === undefined ? {} : {
            linkData: PluginAgentExternalSessionLinkDataSchema.parse(target.linkData),
        }),
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
    const generationWaiters = new Set<() => void>();

    const notifyGenerationWaiters = (): void => {
        for (const notify of [...generationWaiters]) notify();
    };

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
                occurrenceId: readIdentity(
                    identityInput.occurrenceId,
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
                occurrenceRetirementSignal:
                    identityInput.occurrenceRetirementSignal,
                isOccurrenceCurrent: identityInput.isOccurrenceCurrent,
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
                ...(identity.occurrenceRetirementSignal
                    ? [identity.occurrenceRetirementSignal]
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
                        identity.isOccurrenceCurrent() === true
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

            const port: ReturnType<ExternalSessionHostOperationOwner['bind']> = Object.freeze({
                isCurrent: isBindingCurrent,
                async waitForRebind(signal) {
                    const rebindIsReady = (): boolean => (
                        !retired
                        && currentGeneration !== null
                        && !currentGeneration.retirement.signal.aborted
                        && (
                            currentGeneration !== boundGeneration
                            || !isBindingCurrent()
                        )
                    );
                    if (
                        retired
                        || bindingRetirement.signal.aborted
                        || identity.sessionSignal?.aborted
                        || identity.occurrenceRetirementSignal?.aborted
                        || signal?.aborted
                    ) {
                        return false;
                    }
                    if (rebindIsReady()) return true;
                    return await new Promise<boolean>((resolve) => {
                        let settled = false;
                        const finish = (value: boolean): void => {
                            if (settled) return;
                            settled = true;
                            generationWaiters.delete(onGenerationChanged);
                            bindingRetirement.signal.removeEventListener('abort', onAbort);
                            identity.sessionSignal?.removeEventListener('abort', onAbort);
                            identity.occurrenceRetirementSignal?.removeEventListener('abort', onAbort);
                            signal?.removeEventListener('abort', onAbort);
                            resolve(value);
                        };
                        const onGenerationChanged = (): void => {
                            if (rebindIsReady()) finish(true);
                            else if (retired) finish(false);
                        };
                        const onAbort = (): void => finish(false);
                        generationWaiters.add(onGenerationChanged);
                        bindingRetirement.signal.addEventListener('abort', onAbort, { once: true });
                        identity.sessionSignal?.addEventListener('abort', onAbort, { once: true });
                        identity.occurrenceRetirementSignal?.addEventListener('abort', onAbort, { once: true });
                        signal?.addEventListener('abort', onAbort, { once: true });
                        onGenerationChanged();
                    });
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
                    if (boundGeneration === null) {
                        return unavailableFollow(
                            retired
                                ? 'plugin_generation_retired'
                                : 'plugin_external_follow_unavailable',
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
                    let listenerFailed = false;
                    const followRetirement = new AbortController();
                    const activeSignal = AbortSignal.any([
                        lifecycleSignal,
                        followRetirement.signal,
                        ...(request.options.signal
                            ? [request.options.signal]
                            : []),
                    ]);
                    const startDisposal = (): Promise<void> => {
                        disposed = true;
                        const attempt = (async () => {
                            activeSignal.removeEventListener(
                                'abort',
                                onLifecycleAbort,
                            );
                            followRetirement.abort();
                            const currentSubscription = subscription;
                            await currentSubscription?.dispose();
                            disposedSubscription = currentSubscription;
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
                    const settleDisposal = async (): Promise<void> => {
                        for (;;) {
                            const attempt = disposal
                                ?? startDisposal();
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
                            await settleDisposal();
                        },
                        async retire() {
                            await settleDisposal();
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
                            if (disposed || activeSignal.aborted) {
                                fail('plugin_external_follow_unavailable');
                            }
                            try {
                                await settleFollowListener(
                                    Promise.resolve().then(async () =>
                                        await request.listener(event)),
                                    activeSignal,
                                );
                            } catch (error) {
                                listenerFailed = true;
                                if (!disposed) {
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
                            occurrenceId: identity.occurrenceId,
                            sessionId: identity.sessionId,
                            machineId: identity.machineId,
                            ref: request.ref,
                            source: request.source,
                            ...(request.providerSessionTarget ? { providerSessionTarget: request.providerSessionTarget } : {}),
                            options: {
                                ...request.options,
                                signal: AbortSignal.any([
                                    followRetirement.signal,
                                    ...(request.options.signal ? [request.options.signal] : []),
                                ]),
                            },
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
                        // disposed beside it: a cleanup rejection then
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
                    if (boundGeneration === null) {
                        return unavailableFollow(
                            retired
                                ? 'plugin_generation_retired'
                                : 'plugin_external_follow_unavailable',
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
                        occurrenceId: identity.occurrenceId,
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
                        providerSessionTarget: { linkData: resolvedTarget.linkData },
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
            // Publish only after the prior owner physically releases its follows.
            // A concurrent install may publish while cleanup is awaited; retire
            // that owner as well before replacing it.
            while (currentGeneration) {
                const priorGeneration = currentGeneration;
                await retireOwnerGeneration(priorGeneration);
                if (currentGeneration === priorGeneration) currentGeneration = null;
            }
            if (retired) throw new Error('External Session host-operation owner is retired');
            const installedGeneration = createOwnerGeneration(operations);
            currentGeneration = installedGeneration;
            notifyGenerationWaiters();
            let disposed = false;
            return Object.freeze({
                async dispose() {
                    if (disposed) return;
                    await retireOwnerGeneration(installedGeneration);
                    disposed = true;
                    if (currentGeneration === installedGeneration) {
                        currentGeneration = null;
                    }
                },
            });
        },
        async retire() {
            retired = true;
            const priorGeneration = currentGeneration;
            try {
                if (priorGeneration) {
                    await retireOwnerGeneration(priorGeneration);
                    if (currentGeneration === priorGeneration) currentGeneration = null;
                }
            } finally {
                notifyGenerationWaiters();
            }
        },
    });
    return owner;
}
