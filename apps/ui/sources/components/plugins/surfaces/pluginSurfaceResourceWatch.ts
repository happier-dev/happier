import {
    PluginUiDisposeHostResourceRequestV1Schema,
    PluginUiResourceSubscriptionRequestV1Schema,
    type PluginUiHostApiRequestEnvelopeV1,
    type PluginUiJsonValueV1,
    type PluginUiResourceSubscriptionEventV1,
} from '@happier-dev/protocol/plugins/ui';

import {
    mapMachinePluginUiResourceTransportFailure,
    machinePluginUiResourceWatchClose,
    machinePluginUiResourceWatchNext,
    machinePluginUiResourceWatchOpen,
} from '@/sync/ops/machineContributionRegistryProjection';

import type { PluginUiResourceClient } from '@happier-dev/plugin-ui/advanced';

import {
    composePluginSurfaceResourceSignal,
    readPluginSurfaceResourceReference,
    type PluginContextualResourceBinding,
} from './pluginSurfaceResourceRead';
import type { PluginSurfaceHostApiRequestOptions } from './createPluginSurfaceHostApi';

/**
 * The mounted `watchResource` / `disposeHostResource` handlers (§3.6, EU-4b).
 *
 * `readResource` remains the single snapshot authority; this module carries the
 * bounded invalidation SIGNAL only. It owns no cache, no second resource
 * registry and no event queue: admission, per-observer delivery accounting,
 * digest suppression and the queue/byte bounds all live in the daemon, and
 * delivery into the surface reuses the mount's existing subscription registry
 * through the `deliver` sink rather than standing up a second one.
 *
 * **Resynchronization** is this module's real responsibility. `open` answers
 * with the digest the daemon currently observes; the handler keeps that as the
 * subscription's last known good, and whenever the daemon-side subscription is
 * replaced — a reconnect after a transport outage, or a daemon that no longer
 * knows the id — it re-opens and publishes an invalidation when the digest
 * moved. An observer therefore converges on last-known-good plus one re-read
 * instead of a silent stale view.
 */

export type PluginSurfaceResourceWatchTransport = Readonly<{
    open: typeof machinePluginUiResourceWatchOpen;
    next: typeof machinePluginUiResourceWatchNext;
    close: typeof machinePluginUiResourceWatchClose;
}>;

/** Backoff after a transport outage, capped so a long outage costs one poll per interval. */
const RECONNECT_BACKOFF_MS = [250, 1_000, 2_500, 5_000] as const;

type JsonRecord = Readonly<Record<string, PluginUiJsonValueV1>>;
type PluginSurfaceResourceDigest = Extract<
    PluginUiResourceSubscriptionEventV1,
    { kind: 'invalidated' }
>['digest'];

function readJsonRecord(value: PluginUiJsonValueV1 | undefined): JsonRecord | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as JsonRecord
        : null;
}

function errorPayload(
    code: 'unavailable' | 'invalid_payload',
    reason: string,
): PluginUiJsonValueV1 {
    return { code, diagnostics: [reason] };
}

function resourceAbortPayload(isCurrent: (() => boolean) | undefined): PluginUiJsonValueV1 {
    return errorPayload(
        'unavailable',
        isCurrent?.() === false ? 'plugin_surface_retired' : 'plugin_resource_aborted',
    );
}

function invalidatedEvent(
    subscriptionId: string,
    digest: PluginSurfaceResourceDigest,
): PluginUiResourceSubscriptionEventV1 {
    return { version: 1, subscriptionId, kind: 'invalidated', digest };
}

function terminalEvent(
    subscriptionId: string,
    code: 'unavailable' | 'denied' | 'stale_surface' | 'expired_resource',
    reason: string,
): PluginUiResourceSubscriptionEventV1 {
    return { version: 1, subscriptionId, kind: 'error', code, diagnostics: [reason] };
}

type ActiveWatch = {
    readonly subscriptionId: string;
    readonly resourceId: string;
    readonly deliver: (event: PluginUiResourceSubscriptionEventV1) => void;
    readonly controller: AbortController;
    lastDigest: PluginSurfaceResourceDigest;
    closed: boolean;
};

type WatchOpenResult =
    | Readonly<{ ok: true; digest: PluginSurfaceResourceDigest }>
    | Readonly<{ ok: false; terminal: boolean; reason: string }>;

/**
 * A reconnect wait belongs to the watch lifetime just like its long poll. The
 * default clears its actual timer synchronously on retirement; injected test
 * delays receive the same signal so they cannot model an uncancellable branch.
 */
function waitForReconnectBackoff(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
        if (signal.aborted) {
            resolve();
            return;
        }
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const settle = (): void => {
            if (settled) return;
            settled = true;
            if (timer !== null) clearTimeout(timer);
            signal.removeEventListener('abort', settle);
            resolve();
        };
        timer = setTimeout(settle, ms);
        signal.addEventListener('abort', settle, { once: true });
        // The signal could have retired between the first check and listener
        // installation. Resolve through the same cleanup path in that case.
        if (signal.aborted) settle();
    });
}

type ContextualResourceWatchOwner = Readonly<{
    open(params: Readonly<{
        subscriptionId: string;
        resourceId: string;
        deliver: (event: PluginUiResourceSubscriptionEventV1) => void;
        signal?: AbortSignal;
    }>): Promise<WatchOpenResult>;
    retire(subscriptionId: string): void;
    dispose(): void;
}>;

/**
 * The common mounted/contextual Resource watch lifecycle. It keeps the one
 * transport/reconnect owner while callers choose only their input adapter:
 * a Surface envelope or a host-stamped contextual Resource binding.
 */
function createContextualResourceWatchOwner(input: Readonly<{
    pluginId: string;
    resource: PluginContextualResourceBinding;
    isCurrent?: () => boolean;
    transport?: Partial<PluginSurfaceResourceWatchTransport>;
    /** Injected only so the pump's backoff is deterministic in tests. */
    delayMs?: (ms: number, signal: AbortSignal) => Promise<void>;
}>): ContextualResourceWatchOwner {
    const open = input.transport?.open ?? machinePluginUiResourceWatchOpen;
    const next = input.transport?.next ?? machinePluginUiResourceWatchNext;
    const close = input.transport?.close ?? machinePluginUiResourceWatchClose;
    const delay = input.delayMs ?? waitForReconnectBackoff;
    const watches = new Map<string, ActiveWatch>();
    let disposed = false;

    const isCurrent = (): boolean => !disposed && input.isCurrent?.() !== false;

    const daemon = Object.freeze({
        machineId: input.resource.machineId,
        serverId: input.resource.serverId ?? null,
        expectedGeneration: input.resource.expectedGeneration,
    });

    async function openAtDaemon(
        subscriptionId: string,
        resourceId: string,
        signal?: AbortSignal,
    ): Promise<WatchOpenResult> {
        const outcome = await open(daemon.machineId, {
            serverId: daemon.serverId,
            expectedGeneration: daemon.expectedGeneration,
            callerPluginId: input.pluginId,
            subscriptionId,
            resource: { pluginId: input.pluginId, localId: resourceId },
            ...(input.resource.context === undefined ? {} : { context: input.resource.context }),
            ...(input.resource.timeoutMs === undefined ? {} : { timeoutMs: input.resource.timeoutMs }),
            ...(signal === undefined ? {} : { signal }),
        });
        if (!outcome.supported) {
            const transportFailure = mapMachinePluginUiResourceTransportFailure(outcome.reason);
            return {
                ok: false,
                terminal: !transportFailure.retryable,
                reason: transportFailure.code,
            };
        }
        if (!outcome.result.ok) {
            return {
                ok: false,
                // A declaration or generation failure is settled: re-opening
                // would ask the same question and get the same answer.
                terminal: outcome.result.reason !== 'unavailable',
                reason: outcome.result.code,
            };
        }
        return { ok: true, digest: outcome.result.digest };
    }

    /**
     * The long-poll pump for one subscription. It is the only place that decides
     * whether an outcome is a change, a retry or the end of the subscription.
     */
    function pump(watch: ActiveWatch): void {
        void (async () => {
            let consecutiveFailures = 0;
            while (!watch.closed && isCurrent()) {
                const outcome = await next(daemon.machineId, {
                    serverId: daemon.serverId,
                    expectedGeneration: daemon.expectedGeneration,
                    callerPluginId: input.pluginId,
                    subscriptionId: watch.subscriptionId,
                    signal: watch.controller.signal,
                });
                if (watch.closed || !isCurrent()) return;

                if (outcome.supported && outcome.result.ok) {
                    consecutiveFailures = 0;
                    if (outcome.result.status === 'idle') continue;
                    const event = outcome.result.event;
                    if (event.kind === 'invalidated') {
                        watch.lastDigest = event.digest;
                        watch.deliver(event);
                        continue;
                    }
                    watch.closed = true;
                    watches.delete(watch.subscriptionId);
                    watch.deliver(event);
                    return;
                }
                if (outcome.supported && !outcome.result.ok && outcome.result.reason === 'stale_generation') {
                    watch.closed = true;
                    watches.delete(watch.subscriptionId);
                    watch.deliver(terminalEvent(watch.subscriptionId, 'expired_resource', outcome.result.code));
                    return;
                }
                if (!outcome.supported) {
                    const transportFailure = mapMachinePluginUiResourceTransportFailure(outcome.reason);
                    if (!transportFailure.retryable) {
                        watch.closed = true;
                        watches.delete(watch.subscriptionId);
                        watch.deliver(terminalEvent(watch.subscriptionId, 'unavailable', transportFailure.code));
                        return;
                    }
                }

                // Everything else — a transport outage, or a daemon that no
                // longer knows this subscription — is a RESYNCHRONIZATION, not a
                // failure: re-open and tell the observer only when the digest it
                // last held actually moved.
                await delay(
                    RECONNECT_BACKOFF_MS[
                        Math.min(consecutiveFailures, RECONNECT_BACKOFF_MS.length - 1)
                    ]!,
                    watch.controller.signal,
                );
                consecutiveFailures += 1;
                if (watch.closed || !isCurrent()) return;
                const reopened = await openAtDaemon(
                    watch.subscriptionId,
                    watch.resourceId,
                    watch.controller.signal,
                );
                if (watch.closed || !isCurrent()) return;
                if (!reopened.ok) {
                    if (!reopened.terminal) continue;
                    watch.closed = true;
                    watches.delete(watch.subscriptionId);
                    watch.deliver(terminalEvent(watch.subscriptionId, 'unavailable', reopened.reason));
                    return;
                }
                consecutiveFailures = 0;
                if (reopened.digest !== watch.lastDigest) {
                    watch.lastDigest = reopened.digest;
                    watch.deliver(invalidatedEvent(watch.subscriptionId, reopened.digest));
                }
            }
        })();
    }

    function retire(subscriptionId: string): void {
        const watch = watches.get(subscriptionId);
        if (!watch) return;
        watch.closed = true;
        // A daemon `next` may remain parked for its full long-poll budget.
        // Closing the remote subscription alone cannot release that local RPC;
        // this watch-owned controller does so synchronously on every retire.
        watch.controller.abort();
        watches.delete(subscriptionId);
        void close(daemon.machineId, {
            serverId: daemon.serverId,
            callerPluginId: input.pluginId,
            subscriptionId,
            ...(input.resource.timeoutMs === undefined ? {} : { timeoutMs: input.resource.timeoutMs }),
        });
    }

    return Object.freeze({
        async open(params): Promise<WatchOpenResult> {
            if (!isCurrent()) {
                return { ok: false, terminal: true, reason: 'plugin_surface_retired' };
            }
            // Re-establishing an id retires the predecessor first, so one
            // client never runs two pumps for one Resource subscription.
            retire(params.subscriptionId);
            let opened: WatchOpenResult;
            try {
                opened = await openAtDaemon(params.subscriptionId, params.resourceId, params.signal);
            } catch (error) {
                if (params.signal?.aborted) {
                    return { ok: false, terminal: true, reason: 'plugin_resource_aborted' };
                }
                throw error;
            }
            if (params.signal?.aborted) {
                if (opened.ok) {
                    void close(daemon.machineId, {
                        serverId: daemon.serverId,
                        callerPluginId: input.pluginId,
                        subscriptionId: params.subscriptionId,
                    });
                }
                return { ok: false, terminal: true, reason: 'plugin_resource_aborted' };
            }
            if (!opened.ok) return opened;
            if (!isCurrent()) {
                void close(daemon.machineId, {
                    serverId: daemon.serverId,
                    callerPluginId: input.pluginId,
                    subscriptionId: params.subscriptionId,
                });
                return { ok: false, terminal: true, reason: 'plugin_surface_retired' };
            }
            const watch: ActiveWatch = {
                subscriptionId: params.subscriptionId,
                resourceId: params.resourceId,
                deliver: params.deliver,
                controller: new AbortController(),
                lastDigest: opened.digest,
                closed: false,
            };
            watches.set(params.subscriptionId, watch);
            pump(watch);
            return opened;
        },
        retire,
        dispose: (): void => {
            if (disposed) return;
            disposed = true;
            for (const subscriptionId of [...watches.keys()]) retire(subscriptionId);
        },
    });
}

function resourceClientFailure(
    code: string,
    message: string,
    options?: Readonly<{ retryable?: boolean }>,
): never {
    throw Object.assign(new Error(message), {
        code,
        ...(options?.retryable === undefined ? {} : { retryable: options.retryable }),
    });
}

/**
 * Bind the canonical daemon watch lifecycle to one host-owned contextual
 * Resource client. The prefix is an ephemeral mount identity only; it is not
 * a resource cache, Session registry, or plugin-visible Activity id.
 */
export function createPluginContextualResourceWatchClient(input: Readonly<{
    pluginId: string;
    resource: PluginContextualResourceBinding;
    subscriptionIdPrefix: string;
    isCurrent?: () => boolean;
    transport?: Partial<PluginSurfaceResourceWatchTransport>;
    delayMs?: (ms: number, signal: AbortSignal) => Promise<void>;
}>): Readonly<{
    watchResource: NonNullable<PluginUiResourceClient['watchResource']>;
}> {
    const owner = createContextualResourceWatchOwner(input);
    let nextSubscription = 0;
    return Object.freeze({
        async watchResource(resource, listener, options) {
            const reference = readPluginSurfaceResourceReference(input.pluginId, resource);
            if (!reference) {
                return resourceClientFailure('plugin_resource_request_invalid', 'Resource reference is invalid');
            }
            if (reference.pluginId !== input.pluginId) {
                return resourceClientFailure('plugin_resource_not_found', 'Resource is not declared for this plugin');
            }
            if (typeof listener !== 'function') {
                return resourceClientFailure('plugin_resource_options_invalid', 'Resource watch listener is invalid');
            }
            const signal = options?.signal;
            if (signal?.aborted) {
                return resourceClientFailure('plugin_resource_aborted', 'Resource watch was aborted');
            }
            if (input.isCurrent?.() === false) {
                return resourceClientFailure('plugin_surface_retired', 'Resource surface is retired');
            }
            const subscriptionId = `${input.subscriptionIdPrefix}:${++nextSubscription}`;
            const onAbort = (): void => { owner.retire(subscriptionId); };
            signal?.addEventListener('abort', onAbort, { once: true });
            const opened = await owner.open({
                subscriptionId,
                resourceId: reference.localId,
                deliver: listener,
                ...(signal === undefined ? {} : { signal }),
            });
            if (!opened.ok) {
                signal?.removeEventListener('abort', onAbort);
                return resourceClientFailure(
                    opened.reason,
                    opened.reason,
                    { retryable: !opened.terminal },
                );
            }
            if (signal?.aborted || input.isCurrent?.() === false) {
                signal?.removeEventListener('abort', onAbort);
                owner.retire(subscriptionId);
                return resourceClientFailure('plugin_resource_aborted', 'Resource watch was aborted');
            }
            let disposed = false;
            return Object.freeze({
                // The daemon open response is the canonical current digest at
                // this admission boundary. The generic Resource owner uses it
                // only to prove an in-flight snapshot read already converged;
                // it never treats this signal as Resource bytes.
                admittedDigest: opened.digest,
                dispose(): void {
                    if (disposed) return;
                    disposed = true;
                    signal?.removeEventListener('abort', onAbort);
                    owner.retire(subscriptionId);
                },
            });
        },
    } satisfies Readonly<{
        watchResource: NonNullable<PluginUiResourceClient['watchResource']>;
    }>);
}

export function createPluginSurfaceResourceWatchHandlers(input: Readonly<{
    pluginId: string;
    resource: PluginContextualResourceBinding;
    /** Publishes one event into the mount's existing subscription registry. */
    deliver: (event: PluginUiResourceSubscriptionEventV1) => void;
    isCurrent?: () => boolean;
    /** The bound controller's one mount lifetime; absent for direct unit composition. */
    lifetimeSignal?: AbortSignal;
    transport?: Partial<PluginSurfaceResourceWatchTransport>;
    /** Injected only so the pump's backoff is deterministic in tests. */
    delayMs?: (ms: number, signal: AbortSignal) => Promise<void>;
}>) {
    const owner = createContextualResourceWatchOwner(input);
    return Object.freeze({
        watchResource: async (
            request: PluginUiHostApiRequestEnvelopeV1,
            options?: PluginSurfaceHostApiRequestOptions,
        ): Promise<PluginUiJsonValueV1> => {
            const payload = readJsonRecord(request.payload);
            const parsed = payload
                ? PluginUiResourceSubscriptionRequestV1Schema.safeParse(payload)
                : null;
            if (!parsed?.success) {
                return errorPayload('invalid_payload', 'plugin_surface_resource_subscription_payload_invalid');
            }
            const reference = readPluginSurfaceResourceReference(
                input.pluginId,
                parsed.data.resource as PluginUiJsonValueV1,
            );
            if (!reference) {
                return errorPayload('invalid_payload', 'plugin_surface_resource_subscription_payload_invalid');
            }
            if (reference.pluginId !== input.pluginId) {
                return errorPayload('unavailable', 'plugin_resource_not_found');
            }
            if (input.isCurrent?.() === false) {
                return errorPayload('unavailable', 'plugin_surface_retired');
            }
            const signal = composePluginSurfaceResourceSignal(input.lifetimeSignal, options?.signal);
            if (signal?.aborted) return resourceAbortPayload(input.isCurrent);
            const subscriptionId = parsed.data.subscriptionId;
            const opened = await owner.open({
                subscriptionId,
                resourceId: reference.localId,
                deliver: input.deliver,
                ...(signal === undefined ? {} : { signal }),
            });
            if (signal?.aborted) return resourceAbortPayload(input.isCurrent);
            if (!opened.ok) return errorPayload('unavailable', opened.reason);
            if (input.isCurrent?.() === false) {
                owner.retire(subscriptionId);
                return resourceAbortPayload(input.isCurrent);
            }
            // The establishment result is the resynchronization baseline the
            // author can compare against its own last read.
            return { subscriptionId, digest: opened.digest };
        },
        disposeHostResource: async (request: PluginUiHostApiRequestEnvelopeV1): Promise<PluginUiJsonValueV1> => {
            const parsed = PluginUiDisposeHostResourceRequestV1Schema.safeParse(readJsonRecord(request.payload));
            if (!parsed.success) {
                return errorPayload('invalid_payload', 'plugin_surface_resource_subscription_payload_invalid');
            }
            owner.retire(parsed.data.subscriptionId);
            // This is a transport-control operation, not an author-visible
            // result. The hosted wire acknowledges it separately.
            return null;
        },
        dispose: owner.dispose,
    });
}
