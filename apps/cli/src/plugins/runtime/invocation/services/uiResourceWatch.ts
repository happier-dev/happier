import { PluginError, type Disposable } from '@happier-dev/plugin-sdk';
import {
    DAEMON_PLUGIN_UI_RESOURCE_WATCH_DEFAULT_WAIT_MS,
    DAEMON_PLUGIN_UI_RESOURCE_WATCH_MAX_WAIT_MS,
    DAEMON_PLUGIN_UI_RESOURCE_WATCH_MIN_WAIT_MS,
} from '@happier-dev/protocol';
import type { PluginResourceContextV1 } from '@happier-dev/protocol';
import {
    PluginUiResourceSubscriptionEventV1Schema,
    type PluginUiResourceSubscriptionEventV1,
} from '@happier-dev/protocol/plugins/ui';

import type { HostRuntimeLimitMeasurementRecorder } from '@/agent/runtime/state/runtimeLimitMeasurement';

import { createStablePluginEventsBroker, type StablePluginEventsBroker } from './events';
import type { StablePluginResourcesOwner } from './resources';

/**
 * The daemon half of the plugin UI live-resource transport (§3.6, EU-4b).
 *
 * It owns exactly one thing: turning the canonical producer's invalidation —
 * `ResourcesService.watch`, whose per-watcher delivery accounting, coalescing
 * and digest suppression already hold — into a signal one long-polling app
 * surface can take, with the same bounds the rest of the plugin runtime uses.
 *
 * **No second broker.** Delivery serialization, the per-subscription queue and
 * byte ceilings (`STABLE_PLUGIN_EVENT_QUEUE_LIMITS`), the runtime-limit
 * measurement seam and `isCurrent()` disposal all come from
 * `createStablePluginEventsBroker`. It is its OWN instance of that canonical
 * factory rather than the plugin event-contribution instance: the broker matches
 * subscriptions on `{ pluginId, localId }` alone, so sharing the instance would
 * let a plugin's declared event deliver a fabricated invalidation to a
 * `watchResource` observer.
 *
 * **No payload channel.** The event carries a digest and nothing else; the
 * observer re-reads through `readResource`, which stays the single snapshot
 * authority. That is also why a dropped delivery under backpressure cannot
 * strand an observer: the broker only refuses an emit when that subscription
 * already holds ≥1 undelivered signal, and every delivery is a re-read
 * instruction that returns the CURRENT bytes.
 */

/**
 * How long a subscription may go unpolled before the next transport call
 * reclaims it. Deliberately not a timer: an app that navigated away or reloaded
 * without closing stops polling, and the sweep runs on whatever call comes
 * next — including the re-open that reload performs. Sized well above the
 * maximum long-poll budget so a slow client is never reclaimed mid-poll.
 */
const UI_RESOURCE_WATCH_IDLE_RECLAIM_MS = DAEMON_PLUGIN_UI_RESOURCE_WATCH_MAX_WAIT_MS * 3;

export type PluginUiResourceWatchPollResult =
    | Readonly<{ status: 'event'; event: PluginUiResourceSubscriptionEventV1 }>
    | Readonly<{ status: 'idle' }>;

export type PluginUiResourceWatchOwner = Readonly<{
    /**
     * Establish one daemon-side subscription and answer with the digest this
     * generation currently observes. The digest is the resynchronization
     * baseline: a late mount, a reconnect or a replaced subscription compares it
     * against its last known good and re-reads when they differ, so no observer
     * converges on a silent stale view.
     */
    open(params: Readonly<{
        subscriptionId: string;
        callerPluginId: string;
        resourceId: string;
        /** Host-stamped only; required by contextual dynamic Resources. */
        context?: PluginResourceContextV1;
    }>): Promise<Readonly<{ subscriptionId: string; digest: string }>>;
    next(params: Readonly<{
        callerPluginId: string;
        subscriptionId: string;
        waitMs?: number;
        signal?: AbortSignal;
    }>): Promise<PluginUiResourceWatchPollResult>;
    close(params: Readonly<{ callerPluginId: string; subscriptionId: string }>): boolean;
    /** Retire every subscription when the plugin generation is replaced. */
    retire(): void;
}>;

function fail(code: string, message: string): never {
    throw new PluginError({ code, message });
}

function invalidatedEvent(subscriptionId: string, digest: string): PluginUiResourceSubscriptionEventV1 {
    return PluginUiResourceSubscriptionEventV1Schema.parse({
        version: 1,
        subscriptionId,
        kind: 'invalidated',
        digest,
    });
}

function terminalErrorEvent(
    subscriptionId: string,
    code: 'unavailable' | 'denied' | 'stale_surface' | 'expired_resource',
    diagnostics: readonly string[],
): PluginUiResourceSubscriptionEventV1 {
    return PluginUiResourceSubscriptionEventV1Schema.parse({
        version: 1,
        subscriptionId,
        kind: 'error',
        code,
        diagnostics: [...diagnostics],
    });
}

function normalizeWaitMs(value: number | undefined): number {
    if (value === undefined) return DAEMON_PLUGIN_UI_RESOURCE_WATCH_DEFAULT_WAIT_MS;
    if (!Number.isSafeInteger(value)) {
        return fail('plugin_resource_options_invalid', 'Resource watch poll budget is invalid');
    }
    return Math.min(
        DAEMON_PLUGIN_UI_RESOURCE_WATCH_MAX_WAIT_MS,
        Math.max(DAEMON_PLUGIN_UI_RESOURCE_WATCH_MIN_WAIT_MS, value),
    );
}

function boundedId(value: unknown, message: string): string {
    if (typeof value !== 'string' || value.trim() !== value || value.length === 0 || value.length > 256) {
        return fail('plugin_resource_options_invalid', message);
    }
    return value;
}

type PendingSignal = Readonly<{
    event: PluginUiResourceSubscriptionEventV1;
    /** Releases the broker listener that produced this signal, so its queue slot frees. */
    release: () => void;
}>;

type UiResourceWatch = {
    readonly key: string;
    readonly subscriptionId: string;
    readonly pluginId: string;
    readonly resourceId: string;
    /** Owns the bound Resource context for this exact open watch lifetime. */
    readonly bindingController: AbortController;
    producer: Disposable | null;
    brokerSubscription: Disposable | null;
    /**
     * At most ONE undelivered signal lives here: the broker's drain awaits its
     * listener before shifting the next publication, so everything beyond the
     * signal in flight waits in the broker's own bounded queue rather than in a
     * second unbounded buffer this owner would have to bound itself.
     */
    pending: PendingSignal | null;
    waiter: ((result: PluginUiResourceWatchPollResult) => void) | null;
    lastPolledAtMs: number;
    /** The sole terminal fact, retained for an open continuation after release. */
    terminal: PluginUiResourceWatchPollResult | null;
    closed: boolean;
};

export function createStablePluginUiResourceWatchOwner(params: Readonly<{
    generation: string;
    resources: StablePluginResourcesOwner;
    isPluginConsumerCurrent: (pluginId: string) => boolean;
    /** Injectable only so a composed host can share one broker factory; defaults to its own instance. */
    broker?: StablePluginEventsBroker;
    recordRuntimeLimitMeasurement?: HostRuntimeLimitMeasurementRecorder;
    nowMs?: () => number;
}>): PluginUiResourceWatchOwner {
    const nowMs = params.nowMs ?? (() => Date.now());
    const broker = params.broker ?? createStablePluginEventsBroker({
        ...(params.recordRuntimeLimitMeasurement
            ? { recordRuntimeLimitMeasurement: params.recordRuntimeLimitMeasurement }
            : {}),
    });
    const watches = new Map<string, UiResourceWatch>();
    let retired = false;

    function watchKey(pluginId: string, subscriptionId: string): string {
        return `${pluginId}\u0000${subscriptionId}`;
    }

    function settleWaiter(watch: UiResourceWatch, result: PluginUiResourceWatchPollResult): void {
        const waiter = watch.waiter;
        if (!waiter) return;
        watch.waiter = null;
        waiter(result);
    }

    function releaseWatch(watch: UiResourceWatch, terminal: PluginUiResourceWatchPollResult | null): void {
        if (watch.closed) return;
        watch.terminal = terminal;
        watch.closed = true;
        watches.delete(watch.key);
        const pending = watch.pending;
        watch.pending = null;
        pending?.release();
        watch.bindingController.abort();
        const producer = watch.producer;
        watch.producer = null;
        producer?.dispose();
        const brokerSubscription = watch.brokerSubscription;
        watch.brokerSubscription = null;
        void brokerSubscription?.dispose();
        if (terminal) settleWaiter(watch, terminal);
    }

    /**
     * Reclaim subscriptions whose client stopped polling. Lazy on purpose: the
     * only client that can leak one is a client that is gone, and the call that
     * matters — its own reload's `open` — is exactly when this runs.
     */
    function sweepIdle(): void {
        const deadline = nowMs() - UI_RESOURCE_WATCH_IDLE_RECLAIM_MS;
        for (const watch of [...watches.values()]) {
            if (watch.waiter === null && watch.lastPolledAtMs < deadline) {
                releaseWatch(watch, null);
            }
        }
    }

    function isWatchCurrent(watch: UiResourceWatch): boolean {
        return !retired && !watch.closed && params.isPluginConsumerCurrent(watch.pluginId);
    }

    /**
     * The broker listener. It parks until the signal is taken by a poll (or the
     * subscription retires), which is what makes the broker's per-subscription
     * queue the real bound: a producer that outruns the app fills that bounded
     * queue and is refused there, instead of accumulating in this owner.
     */
    function handOff(watch: UiResourceWatch, event: PluginUiResourceSubscriptionEventV1): Promise<void> {
        return new Promise<void>((resolve) => {
            if (watch.closed) {
                resolve();
                return;
            }
            if (watch.waiter) {
                settleWaiter(watch, { status: 'event', event });
                resolve();
                return;
            }
            // At most one signal can be here: the broker's drain awaits this
            // listener before shifting its next publication, so a second signal
            // cannot arrive until this one is taken.
            watch.pending = Object.freeze({ event, release: resolve });
        });
    }

    return Object.freeze({
        async open(openParams) {
            if (retired) fail('plugin_generation_stale', 'Plugin generation is stale');
            sweepIdle();
            const pluginId = boundedId(openParams.callerPluginId, 'Resource watch caller is invalid');
            const subscriptionId = boundedId(openParams.subscriptionId, 'Resource watch subscription id is invalid');
            const resourceId = boundedId(openParams.resourceId, 'Resource watch resource id is invalid');
            if (!params.isPluginConsumerCurrent(pluginId) || !params.resources.hasPlugin(pluginId)) {
                fail('plugin_resource_service_unavailable', 'Committed plugin resources are unavailable');
            }
            const key = watchKey(pluginId, subscriptionId);
            const existing = watches.get(key);
            // Re-opening the same id is the reconnect path, not a conflict: the
            // predecessor is retired before its replacement is established so a
            // reload never leaves two producers observing for one surface.
            if (existing) releaseWatch(existing, { status: 'idle' });

            const bindingController = new AbortController();
            const isBindingCurrent = () => !retired && params.isPluginConsumerCurrent(pluginId);
            const assertBindingCurrent = (): void => {
                if (bindingController.signal.aborted) {
                    fail('plugin_resource_aborted', 'Resource watch binding was aborted');
                }
                if (!isBindingCurrent()) {
                    fail('plugin_generation_stale', 'Plugin generation is stale');
                }
            };
            assertBindingCurrent();
            let boundWatch: UiResourceWatch | null = null;
            const endUnavailableSessionResourceWatch = (): void => {
                const watch = boundWatch;
                if (!watch) return;
                releaseWatch(watch, {
                    status: 'event',
                    event: terminalErrorEvent(
                        watch.subscriptionId,
                        'unavailable',
                        ['plugin_resource_session_access_unavailable'],
                    ),
                });
            };
            let service: Awaited<ReturnType<StablePluginResourcesOwner['bindForResource']>>;
            try {
                service = await params.resources.bindForResource({
                    pluginId,
                    resourceId,
                    signal: bindingController.signal,
                    isGenerationCurrent: isBindingCurrent,
                    ...(openParams.context === undefined ? {} : { context: openParams.context }),
                    ...(openParams.context?.kind === 'session'
                        ? { onSessionResourceUnavailable: endUnavailableSessionResourceWatch }
                        : {}),
                });
                assertBindingCurrent();
            } catch (error) {
                bindingController.abort();
                throw error;
            }

            const watch: UiResourceWatch = {
                key,
                subscriptionId,
                pluginId,
                resourceId,
                bindingController,
                producer: null,
                brokerSubscription: null,
                pending: null,
                waiter: null,
                lastPolledAtMs: nowMs(),
                terminal: null,
                closed: false,
            };
            boundWatch = watch;
            watches.set(key, watch);

            const identity = Object.freeze({
                pluginId,
                pluginVersion: '0.0.0',
                contributionId: resourceId,
                contributionQualifiedId: `${pluginId}/resources/${encodeURIComponent(resourceId)}`,
                generation: params.generation,
                correlationId: `${pluginId}/resources/${resourceId}#${subscriptionId}`,
                surface: 'ui' as const,
            });
            // One broker subscription per UI subscription, keyed by the
            // subscription id rather than the resource id, so an invalidation
            // owed to one mounted surface is never fanned out to another
            // surface's poll.
            const ref = Object.freeze({ pluginId, localId: subscriptionId });
            watch.brokerSubscription = broker.subscribe({
                ref,
                identity,
                isCurrent: () => isWatchCurrent(watch),
                listener: async (delivered) => {
                    const payload = delivered.payload as Readonly<{ digest?: unknown }>;
                    if (typeof payload?.digest !== 'string') return;
                    await handOff(watch, invalidatedEvent(subscriptionId, payload.digest));
                },
            });
            try {
                const producer = service.watch(resourceId, (change) => {
                    void broker.emit({ event: { ref, payload: { digest: change.digest } }, identity })
                        .catch(() => {
                            // Backpressure is the bound doing its job. The refused
                            // signal cannot strand the observer: it is only refused
                            // when an undelivered one is already queued, and every
                            // delivery makes the observer re-read the CURRENT bytes.
                        });
                });
                if (watch.closed) {
                    producer.dispose();
                    return fail('plugin_resource_session_access_unavailable', 'Session-scoped Resource access is unavailable');
                }
                watch.producer = producer;
                // A contextual Resource may not have a snapshot before this
                // exact watch owns it. Read after subscription establishment so
                // the live context survives only for this watch/read pair and
                // the returned baseline is real producer bytes, never a fake
                // empty digest from `describe`.
                const baseline = await service.read(resourceId);
                if (!isWatchCurrent(watch)) {
                    const terminal = watch.terminal;
                    if (
                        terminal?.status === 'event'
                        && terminal.event.kind === 'error'
                        && (terminal.event.code === 'unavailable' || terminal.event.code === 'denied')
                    ) {
                        return fail(
                            'plugin_resource_session_access_unavailable',
                            'Session-scoped Resource access is unavailable',
                        );
                    }
                    releaseWatch(watch, null);
                    return fail('plugin_generation_stale', 'Plugin generation is stale');
                }
                return Object.freeze({ subscriptionId, digest: baseline.digest });
            } catch (error) {
                releaseWatch(watch, null);
                throw error;
            }
        },
        async next(nextParams) {
            sweepIdle();
            const pluginId = boundedId(nextParams.callerPluginId, 'Resource watch caller is invalid');
            const subscriptionId = boundedId(nextParams.subscriptionId, 'Resource watch subscription id is invalid');
            const watch = watches.get(watchKey(pluginId, subscriptionId));
            if (!watch) {
                fail(
                    'plugin_resource_subscription_unknown',
                    'Resource watch subscription is not established for this plugin',
                );
            }
            if (watch.waiter) {
                fail('plugin_resource_subscription_busy', 'Resource watch subscription already has a poll in flight');
            }
            watch.lastPolledAtMs = nowMs();
            if (!isWatchCurrent(watch)) {
                releaseWatch(watch, null);
                return {
                    status: 'event',
                    event: terminalErrorEvent(subscriptionId, 'stale_surface', ['plugin_generation_stale']),
                };
            }
            const pending = watch.pending;
            if (pending) {
                watch.pending = null;
                pending.release();
                return { status: 'event', event: pending.event };
            }
            const waitMs = normalizeWaitMs(nextParams.waitMs);
            return await new Promise<PluginUiResourceWatchPollResult>((resolve) => {
                let settled = false;
                const settle = (result: PluginUiResourceWatchPollResult): void => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    nextParams.signal?.removeEventListener('abort', onAbort);
                    if (watch.waiter === settle) watch.waiter = null;
                    resolve(result);
                };
                const onAbort = (): void => { settle({ status: 'idle' }); };
                const timer = setTimeout(() => { settle({ status: 'idle' }); }, waitMs);
                timer.unref?.();
                nextParams.signal?.addEventListener('abort', onAbort, { once: true });
                watch.waiter = settle;
            });
        },
        close(closeParams) {
            const pluginId = boundedId(closeParams.callerPluginId, 'Resource watch caller is invalid');
            const subscriptionId = boundedId(closeParams.subscriptionId, 'Resource watch subscription id is invalid');
            const watch = watches.get(watchKey(pluginId, subscriptionId));
            if (!watch) return false;
            releaseWatch(watch, { status: 'idle' });
            return true;
        },
        retire() {
            if (retired) return;
            retired = true;
            for (const watch of [...watches.values()]) {
                releaseWatch(watch, {
                    status: 'event',
                    event: terminalErrorEvent(watch.subscriptionId, 'stale_surface', ['plugin_generation_stale']),
                });
            }
        },
    });
}
