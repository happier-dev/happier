import { PluginError, type Disposable } from '@happier-dev/plugin-sdk';
import { DAEMON_PLUGIN_UI_RESOURCE_WATCH_DEFAULT_WAIT_MS, DAEMON_PLUGIN_UI_RESOURCE_WATCH_MAX_WAIT_MS, DAEMON_PLUGIN_UI_RESOURCE_WATCH_MIN_WAIT_MS } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type { DaemonPluginUiResourceWatchNextResponse } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type { PluginResourceContextV1 } from '@happier-dev/protocol';
import { PluginUiResourceSubscriptionEventV1Schema } from '@happier-dev/protocol/plugins/ui/subscriptions';
import type { PluginUiResourceSubscriptionEventV1 } from '@happier-dev/protocol/plugins/ui';
import type { PluginUiReadAuthorityReferenceV1 } from '@happier-dev/protocol/plugins/ui/client';
import type { PluginUiHostReadReferenceV1 } from '@happier-dev/protocol/plugins/ui/client';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';

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
 * **No payload channel.** Resource events carry a digest; admitted Action
 * dependencies carry only the private `readInvalidated` signal. The
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
    | Readonly<{ status: 'event'; event: Extract<DaemonPluginUiResourceWatchNextResponse, { ok: true; status: 'event' }>['event'] }>
    | Readonly<{ status: 'idle' }>;

export type HostResourceWatchError = Pick<Extract<PluginUiResourceSubscriptionEventV1, { kind: 'error' }>, 'code' | 'diagnostics'>;
export type PluginUiResourceWatchOwner = Readonly<{
    /** Host Account demand shares this transport owner without a plugin occurrence. */
    openHost(params: Readonly<{
        accountId: string;
        subscriptionId: string;
        resource: PluginUiHostReadReferenceV1;
        bind(signal: AbortSignal, emit: (digest: string) => void,
            end: (error?: HostResourceWatchError) => void): Promise<Disposable & Readonly<{ digest: string }>>;
    }>): Promise<Readonly<{ subscriptionId: string; digest: string }>>;
    /**
     * Establish one daemon-side subscription and answer with the digest this
     * occurrenceId currently observes. The digest is the resynchronization
     * baseline: a late mount, a reconnect or a replaced subscription compares it
     * against its last known good and re-reads when they differ, so no observer
     * converges on a silent stale view.
     */
    open(params: Readonly<{
        subscriptionId: string;
        callerPluginId: string;
        resourceId?: string;
        readAuthority?: PluginUiReadAuthorityReferenceV1['readAuthority'];
        /** Host-private binding admitted through the same Action ingress as a finite read. */
        bindRead?(signal: AbortSignal, invalidate: () => void, retire: () => void): Promise<Disposable>;
        /** Host-stamped only; required by contextual dynamic Resources. */
        context?: PluginResourceContextV1;
    }>): Promise<Readonly<{ subscriptionId: string; digest?: string }>>;
    next(params: Readonly<({ callerPluginId: string } | { hostAccountId: string }) & {
        subscriptionId: string;
        resource?: PluginUiHostReadReferenceV1;
        waitMs?: number;
        signal?: AbortSignal;
    }>): Promise<PluginUiResourceWatchPollResult>;
    close(params: Readonly<({ callerPluginId: string } | { hostAccountId: string }) & {
        subscriptionId: string;
        /** Omitted only for owner-local cleanup, which discloses no Resource data. */
        resource?: PluginUiHostReadReferenceV1;
    }>): boolean | Promise<boolean>;
    /** Home access-loss cleanup for one requester's open-ended host demand. */
    retireHostAccount(accountId: string): Promise<void>;
    /** Retire subscriptions owned by the named plugin occurrences. */
    retirePlugins(pluginIds: readonly string[]): void;
    /** Retire every subscription when the registry shuts down. */
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
    event: Extract<PluginUiResourceWatchPollResult, { status: 'event' }>['event'];
    /** Releases the broker listener that produced this signal, so its queue slot frees. */
    release: () => void;
}>;

type UiResourceWatch = {
    readonly key: string;
    readonly subscriptionId: string;
    readonly pluginId?: string;
    readonly hostAccountId?: string;
    readonly hostResource?: PluginUiHostReadReferenceV1;
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
    cleanup?: Promise<void>;
};

export function createStablePluginUiResourceWatchOwner(params: Readonly<{
    resources?: StablePluginResourcesOwner;
    observeReadAuthority?(input: Readonly<{
        authority: PluginUiReadAuthorityReferenceV1['readAuthority'];
        context?: PluginResourceContextV1;
        signal: AbortSignal;
        retire(): void;
    }>): Disposable | Promise<Disposable>;
    isPluginConsumerCurrent: (pluginId: string) => boolean;
    readPluginOccurrenceId: (pluginId: string) => string | null;
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
        return `plugin\u0000${pluginId}\u0000${subscriptionId}`;
    }
    function requestedWatchKey(input: { callerPluginId: string } | { hostAccountId: string }, subscriptionId: string): string {
        return 'hostAccountId' in input ? `host\u0000${input.hostAccountId}\u0000${subscriptionId}`
            : watchKey(boundedId(input.callerPluginId, 'Resource watch caller is invalid'), subscriptionId);
    }

    function settleWaiter(watch: UiResourceWatch, result: PluginUiResourceWatchPollResult): void {
        const waiter = watch.waiter;
        if (!waiter) return;
        watch.waiter = null;
        waiter(result);
    }

    function releaseWatch(watch: UiResourceWatch, terminal: PluginUiResourceWatchPollResult | null): void {
        if (watch.closed) {
            if ((!terminal || terminal.status === 'idle') && watches.get(watch.key) === watch) watches.delete(watch.key);
            return;
        }
        watch.terminal = terminal;
        watch.closed = true;
        // Keep the existing terminal slot until a later poll takes its error.
        // An authority withdrawal must not disappear between polling requests.
        if ((!terminal || terminal.status !== 'event' || terminal.event.kind !== 'error' || watch.waiter)
            && watches.get(watch.key) === watch) watches.delete(watch.key);
        const pending = watch.pending;
        watch.pending = null;
        pending?.release();
        watch.bindingController.abort();
        const producer = watch.producer;
        watch.producer = null;
        try { watch.cleanup = Promise.resolve(producer?.dispose()); void watch.cleanup.catch(() => {}); }
        catch { /* Retirement has already withdrawn this subscription. */ }
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
        return !retired && !watch.closed && (watch.hostAccountId !== undefined || watch.pluginId !== undefined && params.isPluginConsumerCurrent(watch.pluginId));
    }

    /**
     * The broker listener. It parks until the signal is taken by a poll (or the
     * subscription retires), which is what makes the broker's per-subscription
     * queue the real bound: a producer that outruns the app fills that bounded
     * queue and is refused there, instead of accumulating in this owner.
     */
    function handOff(watch: UiResourceWatch, event: Extract<PluginUiResourceWatchPollResult, { status: 'event' }>['event']): Promise<void> {
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
        async openHost(openParams) {
            if (retired) fail('plugin_resource_service_unavailable', 'Resource owner is retired');
            sweepIdle();
            const accountId = openParams.accountId;
            const subscriptionId = boundedId(openParams.subscriptionId, 'Resource watch subscription id is invalid');
            const key = requestedWatchKey({ hostAccountId: accountId }, subscriptionId);
            const existing = watches.get(key);
            if (existing) releaseWatch(existing, { status: 'idle' });
            const watch: UiResourceWatch = { key, subscriptionId, hostAccountId: accountId, hostResource: openParams.resource, resourceId: openParams.resource.hostRead,
                bindingController: new AbortController(), producer: null, brokerSubscription: null, pending: null,
                waiter: null, lastPolledAtMs: nowMs(), terminal: null, closed: false };
            watches.set(key, watch);
            let observedDigest: string | undefined;
            const publish = (digest: string) => {
                if (!isWatchCurrent(watch) || observedDigest === digest) return;
                observedDigest = digest;
                // Binding can observe before it returns its admitted baseline.
                // Keep the latest fact here, then compare it to that baseline.
                if (!watch.producer) return;
                const event = invalidatedEvent(subscriptionId, digest);
                if (watch.waiter) settleWaiter(watch, { status: 'event', event });
                else {
                    // Invalidation is payload-free: one pending signal always asks for current bytes.
                    watch.pending?.release();
                    watch.pending = { event, release() {} };
                }
            };
            try {
                const producer = await openParams.bind(watch.bindingController.signal, publish,
                    error => releaseWatch(watch, { status: 'event', event: terminalErrorEvent(subscriptionId,
                    error?.code ?? 'expired_resource', error?.diagnostics ?? ['service_unavailable']) }));
                if (!isWatchCurrent(watch)) {
                    await producer.dispose();
                    fail('service_unavailable', 'Service Resource retired during admission');
                }
                watch.producer = producer;
                const duringBind = observedDigest;
                observedDigest = producer.digest;
                if (duringBind !== undefined) publish(duringBind);
                return { subscriptionId, digest: producer.digest };
            } catch (error) { releaseWatch(watch, null); throw error; }
        },
        async open(openParams) {
            if (retired) fail('plugin_generation_stale', 'Plugin occurrenceId is stale');
            sweepIdle();
            const pluginId = boundedId(openParams.callerPluginId, 'Resource watch caller is invalid');
            const subscriptionId = boundedId(openParams.subscriptionId, 'Resource watch subscription id is invalid');
            if (openParams.readAuthority || openParams.bindRead) {
                const authority = openParams.readAuthority;
                if (!params.isPluginConsumerCurrent(pluginId) || (authority
                    ? authority.consumer.pluginId !== pluginId || !params.observeReadAuthority
                    : !openParams.bindRead)) fail('plugin_action_read_observation_unavailable', 'Read authority is unavailable');
                const key = watchKey(pluginId, subscriptionId);
                const existing = watches.get(key);
                if (existing) releaseWatch(existing, { status: 'idle' });
                const watch: UiResourceWatch = { key, subscriptionId, pluginId, resourceId: authority?.consumer.localId
                    ?? boundedId(openParams.resourceId, 'Observed Action id is invalid'),
                    bindingController: new AbortController(), producer: null, brokerSubscription: null, pending: null,
                    waiter: null, lastPolledAtMs: nowMs(), terminal: null, closed: false };
                watches.set(key, watch);
                try {
                    const retire = () => releaseWatch(watch, { status: 'event', event: terminalErrorEvent(subscriptionId,
                        'expired_resource', ['plugin_read_authority_retired']) });
                    let invalidate = () => {};
                    if (openParams.bindRead) {
                        const occurrenceId = params.readPluginOccurrenceId(pluginId);
                        if (!occurrenceId) fail('plugin_generation_stale', 'Plugin occurrence is stale');
                        const identity = { pluginId, pluginVersion: '0.0.0', contributionId: watch.resourceId,
                            contributionQualifiedId: `${pluginId}/${watch.resourceId}`, occurrenceId,
                            correlationId: `${pluginId}/${watch.resourceId}#${subscriptionId}`, surface: 'ui' as const };
                        const ref = { pluginId, localId: subscriptionId };
                        watch.brokerSubscription = broker.subscribe({ ref, identity, isCurrent: () => isWatchCurrent(watch),
                            listener: () => handOff(watch, { version: 1, subscriptionId, kind: 'readInvalidated' }) });
                        invalidate = () => {
                            if (!isWatchCurrent(watch)) return;
                            void broker.emit({ event: { ref, payload: {} }, identity }).catch(() => {
                                // The incumbent queue already retains a current-read invalidation.
                            });
                        };
                    }
                    const producer = openParams.bindRead
                        ? await openParams.bindRead(watch.bindingController.signal, invalidate, retire)
                        : await params.observeReadAuthority!({ authority: authority!, signal: watch.bindingController.signal,
                            ...(openParams.context === undefined ? {} : { context: openParams.context }), retire });
                    if (!isWatchCurrent(watch)) {
                        await producer.dispose();
                        fail('plugin_action_generation_retired', 'Read authority retired during admission');
                    }
                    watch.producer = producer;
                    return Object.freeze({ subscriptionId });
                } catch (error) { releaseWatch(watch, null); throw error; }
            }
            const resourceId = boundedId(openParams.resourceId, 'Resource watch resource id is invalid');
            const resources = params.resources;
            if (!params.isPluginConsumerCurrent(pluginId) || !resources?.hasPlugin(pluginId)) {
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
                    fail('plugin_generation_stale', 'Plugin occurrenceId is stale');
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
                service = await resources.bindForResource({
                    pluginId,
                    resourceId,
                    signal: bindingController.signal,
                    isOccurrenceCurrent: isBindingCurrent,
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
            const occurrenceId = params.readPluginOccurrenceId(pluginId);
            if (!occurrenceId) {
                releaseWatch(watch, null);
                fail('plugin_generation_stale', 'Plugin occurrence is stale');
            }

            const identity = Object.freeze({
                pluginId,
                pluginVersion: '0.0.0',
                contributionId: resourceId,
                contributionQualifiedId: `${pluginId}/resources/${encodeURIComponent(resourceId)}`,
                occurrenceId,
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
                const producer = await service.watch(resourceId, (change) => {
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
                    return fail('plugin_generation_stale', 'Plugin occurrenceId is stale');
                }
                return Object.freeze({ subscriptionId, digest: baseline.digest });
            } catch (error) {
                releaseWatch(watch, null);
                throw error;
            }
        },
        async next(nextParams) {
            sweepIdle();
            const subscriptionId = boundedId(nextParams.subscriptionId, 'Resource watch subscription id is invalid');
            const watch = watches.get(requestedWatchKey(nextParams, subscriptionId));
            if (!watch) {
                fail(
                    'plugin_resource_subscription_unknown',
                    'Resource watch subscription is not established for this plugin',
                );
            }
            if (watch.hostAccountId !== undefined && (!nextParams.resource || !sameStrictJsonValue(watch.hostResource, nextParams.resource))) {
                fail('plugin_resource_subscription_unknown', 'Resource watch reference does not match its admitted subscription');
            }
            if (watch.waiter) {
                fail('plugin_resource_subscription_busy', 'Resource watch subscription already has a poll in flight');
            }
            watch.lastPolledAtMs = nowMs();
            if (nextParams.signal?.aborted) {
                releaseWatch(watch, null);
                if (watch.hostAccountId !== undefined) await watch.cleanup;
                return { status: 'idle' };
            }
            if (watch.terminal) {
                if (watch.hostAccountId !== undefined) await watch.cleanup;
                const terminal = watch.terminal;
                watch.terminal = null;
                watches.delete(watch.key);
                return terminal;
            }
            if (!isWatchCurrent(watch)) {
                releaseWatch(watch, null);
                if (watch.hostAccountId !== undefined) await watch.cleanup;
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
            const result = await new Promise<PluginUiResourceWatchPollResult>((resolve) => {
                let settled = false;
                const settle = (result: PluginUiResourceWatchPollResult): void => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    nextParams.signal?.removeEventListener('abort', onAbort);
                    if (watch.waiter === settle) watch.waiter = null;
                    resolve(result);
                };
                const onAbort = (): void => {
                    settle({ status: 'idle' });
                    // The transport owning this poll is gone and no further
                    // call from this surface may ever arrive, so release the
                    // exact watch now: the producer stops observing and the
                    // subscription leaves the map. A client that still wants
                    // the resource re-opens, which is the documented reconnect
                    // path — this owner adds no timer sweeper or count cap.
                    releaseWatch(watch, null);
                };
                const timer = setTimeout(() => { settle({ status: 'idle' }); }, waitMs);
                timer.unref?.();
                nextParams.signal?.addEventListener('abort', onAbort, { once: true });
                watch.waiter = settle;
            });
            if (watch.hostAccountId !== undefined && watch.closed) await watch.cleanup;
            return result;
        },
        close(closeParams) {
            const subscriptionId = boundedId(closeParams.subscriptionId, 'Resource watch subscription id is invalid');
            const watch = watches.get(requestedWatchKey(closeParams, subscriptionId));
            if (!watch) return false;
            if (watch.hostAccountId !== undefined && closeParams.resource && !sameStrictJsonValue(watch.hostResource, closeParams.resource)) return false;
            releaseWatch(watch, { status: 'idle' });
            if (watch.hostAccountId !== undefined) return (watch.cleanup ?? Promise.resolve()).then(() => true);
            return true;
        },
        async retireHostAccount(accountId) {
            const cleanup: Promise<void>[] = [];
            for (const watch of watches.values()) {
                if (watch.hostAccountId !== accountId) continue;
                releaseWatch(watch, {
                    status: 'event',
                    event: terminalErrorEvent(watch.subscriptionId, 'expired_resource', []),
                });
                if (watch.cleanup) cleanup.push(watch.cleanup);
            }
            await Promise.all(cleanup);
        },
        retirePlugins(pluginIds) {
            const retiredPluginIds = new Set(pluginIds);
            if (retiredPluginIds.size === 0) return;
            for (const watch of [...watches.values()]) {
                if (!watch.pluginId || !retiredPluginIds.has(watch.pluginId)) continue;
                releaseWatch(watch, {
                    status: 'event',
                    event: terminalErrorEvent(watch.subscriptionId, 'stale_surface', ['plugin_generation_stale']),
                });
            }
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
