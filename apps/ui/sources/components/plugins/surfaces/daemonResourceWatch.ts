import { PluginUiArtifactDigestV1Schema, type PluginUiResourceSubscriptionEventV1, type PluginUiHostApiErrorPayloadV1 } from '@happier-dev/protocol/plugins/ui';
import { mapMachinePluginUiResourceTransportFailure, machinePluginUiResourceWatchClose, machinePluginUiResourceWatchNext, machinePluginUiResourceWatchOpen } from '@/sync/ops/machineContributionRegistryProjection';
import { readPluginResourceStoreSnapshot, type PluginContextualResourceBinding } from './pluginSurfaceResourceRead';
import { readPluginSurfaceHostApiFailureMetadata } from './createPluginSurfaceHostApi';
import type { PluginUiReadAuthorityReferenceV1 } from '@happier-dev/protocol/plugins/ui/client';
import type { DaemonPluginStructuredMessageActionExecuteRequest } from '@happier-dev/protocol/plugins/actions/daemonInvocationV1';

type ActionReadWatch = Readonly<{
    request: DaemonPluginStructuredMessageActionExecuteRequest;
    invalidate(): void;
}>;

export type PluginSurfaceResourceWatchTransport = Readonly<{
    open: typeof machinePluginUiResourceWatchOpen;
    next: typeof machinePluginUiResourceWatchNext;
    close: typeof machinePluginUiResourceWatchClose;
}>;
const RECONNECT_BACKOFF_MS = [250, 1_000, 2_500, 5_000] as const;
type PluginSurfaceResourceDigest = Extract<PluginUiResourceSubscriptionEventV1, { kind: 'invalidated' }>['digest'];

export function invalidatedEvent(
    subscriptionId: string,
    digest: PluginSurfaceResourceDigest,
): PluginUiResourceSubscriptionEventV1 {
    return { version: 1, subscriptionId, kind: 'invalidated', digest };
}

export function terminalEvent(
    subscriptionId: string,
    code: 'unavailable' | 'denied' | 'stale_surface' | 'expired_resource',
    reason: string,
): PluginUiResourceSubscriptionEventV1 {
    return { version: 1, subscriptionId, kind: 'error', code, diagnostics: [reason] };
}

type ActiveWatch = {
    readonly subscriptionId: string;
    readonly resourceId: string;
    readonly readAuthority?: PluginUiReadAuthorityReferenceV1['readAuthority'];
    readonly actionRead?: ActionReadWatch;
    readonly deliver: (event: PluginUiResourceSubscriptionEventV1) => void;
    readonly controller: AbortController;
    lastDigest: PluginSurfaceResourceDigest | null;
    closed: boolean;
    releaseStore?: () => void;
};

type WatchOpenResult =
    | Readonly<{ ok: true; digest?: PluginSurfaceResourceDigest }>
    | Readonly<{ ok: false; terminal: boolean; reason: string;
        metadata?: Pick<PluginUiHostApiErrorPayloadV1, 'layer' | 'phase'> }>;

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
        readAuthority?: PluginUiReadAuthorityReferenceV1['readAuthority'];
        actionRead?: ActionReadWatch;
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
export function createContextualResourceWatchOwner(input: Readonly<{
    pluginId?: string;
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
        expectedCallerOccurrenceId: input.resource.expectedCallerOccurrenceId,
    });
    const accountTarget = input.resource.accountId ? { accountId: input.resource.accountId } : {};
    const requireMachineId = (): string => {
        if (daemon.machineId === null) throw Object.assign(new Error('Resource requires a Machine'), { code: 'plugin_resource_transport_unavailable' });
        return daemon.machineId;
    };
    const pluginBinding = () => {
        if (!input.pluginId || !daemon.expectedCallerOccurrenceId)
            throw Object.assign(new Error('Resource caller is unavailable'), { code: 'plugin_resource_not_found' });
        return { callerPluginId: input.pluginId, expectedCallerOccurrenceId: daemon.expectedCallerOccurrenceId };
    };

    async function openAtDaemon(
        subscriptionId: string,
        resourceId: string,
        signal?: AbortSignal,
        readAuthority?: PluginUiReadAuthorityReferenceV1['readAuthority'],
        actionRead?: ActionReadWatch,
    ): Promise<WatchOpenResult> {
        const outcome = await open(requireMachineId(), {
            serverId: daemon.serverId,
            ...accountTarget,
            subscriptionId,
            ...('hostResource' in input.resource ? { resource: input.resource.hostResource }
                : { ...pluginBinding(), resource: actionRead ? { actionRead: actionRead.request }
                    : readAuthority ? { readAuthority } : { pluginId: pluginBinding().callerPluginId, localId: resourceId } }),
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
                metadata: { layer: 'transport', phase: 'invocation' },
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
        if (readAuthority || actionRead) return { ok: true };
        const digest = PluginUiArtifactDigestV1Schema.safeParse(outcome.result.digest);
        return digest.success ? { ok: true, digest: digest.data }
            : { ok: false, terminal: true, reason: 'plugin_resource_digest_invalid' };
    }

    /**
     * The long-poll pump for one subscription. It is the only place that decides
     * whether an outcome is a change, a retry or the end of the subscription.
     */
    function pump(watch: ActiveWatch): void {
        void (async () => {
            let consecutiveFailures = 0;
            while (!watch.closed && isCurrent()) {
                const outcome = await next(requireMachineId(), {
                    serverId: daemon.serverId,
                    ...accountTarget,
                    ...('hostResource' in input.resource ? { resource: input.resource.hostResource } : pluginBinding()),
                    subscriptionId: watch.subscriptionId,
                    signal: watch.controller.signal,
                });
                if (watch.closed || !isCurrent()) return;
                if (input.resource.store && !watch.readAuthority && !watch.actionRead) { retireOrdinaryWatches(); return; }

                if (outcome.supported && outcome.result.ok) {
                    consecutiveFailures = 0;
                    if (outcome.result.status === 'idle') continue;
                    const event = outcome.result.event;
                    if (event.kind === 'readInvalidated') {
                        if (watch.actionRead) { watch.actionRead.invalidate(); continue; }
                        retire(watch.subscriptionId);
                        watch.deliver(terminalEvent(watch.subscriptionId, 'unavailable', 'plugin_resource_event_invalid'));
                        return;
                    }
                    if (event.kind === 'invalidated') {
                        if (watch.actionRead) {
                            retire(watch.subscriptionId);
                            watch.deliver(terminalEvent(watch.subscriptionId, 'expired_resource', 'plugin_action_read_observation_lost'));
                            return;
                        }
                        watch.lastDigest = event.digest;
                        watch.deliver(event);
                        continue;
                    }
                    watch.closed = true;
                    watches.delete(watch.subscriptionId);
                    watch.deliver(event);
                    return;
                }
                if (outcome.supported && !outcome.result.ok && outcome.result.reason === 'stale_occurrence') {
                    watch.closed = true;
                    watches.delete(watch.subscriptionId);
                    watch.deliver(terminalEvent(watch.subscriptionId, 'expired_resource', outcome.result.code));
                    return;
                }
                if (watch.readAuthority || watch.actionRead) {
                    // No credential revision crosses this seam. A delivery gap
                    // withdraws retained authority instead of inventing sameness.
                    retire(watch.subscriptionId);
                    watch.deliver(terminalEvent(watch.subscriptionId, 'expired_resource', watch.actionRead
                        ? 'plugin_action_read_observation_lost' : 'plugin_read_authority_observation_lost'));
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
                if (input.resource.store) { retireOrdinaryWatches(); return; }
                const reopened = await openAtDaemon(
                    watch.subscriptionId,
                    watch.resourceId,
                    watch.controller.signal,
                );
                if (watch.closed || !isCurrent()) return;
                if (input.resource.store) { retireOrdinaryWatches(); return; }
                if (!reopened.ok) {
                    if (!reopened.terminal) continue;
                    watch.closed = true;
                    watches.delete(watch.subscriptionId);
                    watch.deliver(terminalEvent(watch.subscriptionId, 'unavailable', reopened.reason));
                    return;
                }
                consecutiveFailures = 0;
                if (reopened.digest !== undefined && reopened.digest !== watch.lastDigest) {
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
        if (watch.releaseStore) { watch.releaseStore(); return; }
        void close(requireMachineId(), {
            serverId: daemon.serverId,
            ...accountTarget,
            ...('hostResource' in input.resource ? { resource: input.resource.hostResource }
                : { callerPluginId: pluginBinding().callerPluginId }),
            subscriptionId,
            ...(input.resource.timeoutMs === undefined ? {} : { timeoutMs: input.resource.timeoutMs }),
        });
    }

    function retireOrdinaryWatches(): void {
        for (const watch of [...watches.values()]) {
            if (watch.releaseStore || watch.readAuthority || watch.actionRead) continue;
            retire(watch.subscriptionId);
            watch.deliver(terminalEvent(watch.subscriptionId, 'unavailable', 'plugin_resource_not_found'));
        }
    }
    const releaseNamespaceAdmission = input.resource.onDeclaredNamespaceAdmission?.(retireOrdinaryWatches);

    return Object.freeze({
        async open(params): Promise<WatchOpenResult> {
            if (!isCurrent()) {
                return { ok: false, terminal: true, reason: 'plugin_surface_retired' };
            }
            // Re-establishing an id retires the predecessor first, so one
            // client never runs two pumps for one Resource subscription.
            retire(params.subscriptionId);
            if (input.resource.store && !params.readAuthority && !params.actionRead) {
                let entry;
                try { entry = input.resource.store.getEntry({ pluginId: pluginBinding().callerPluginId, localId: params.resourceId }); }
                catch (error) {
                    return { ok: false, terminal: true, reason: error && typeof error === 'object'
                        && 'code' in error && typeof error.code === 'string' ? error.code : 'plugin_resource_unavailable' };
                }
                const watch: ActiveWatch = { subscriptionId: params.subscriptionId, resourceId: params.resourceId,
                    deliver: params.deliver, controller: new AbortController(), lastDigest: null, closed: false };
                let established = false;
                const changed = (): void => {
                    if (!established || watch.closed || !isCurrent()) return;
                    const snapshot = entry.getSnapshot();
                    if (snapshot.pending !== 'idle') return;
                    if (snapshot.error) {
                        watch.deliver(terminalEvent(watch.subscriptionId, 'unavailable', snapshot.error.code ?? 'plugin_resource_unavailable'));
                        retire(watch.subscriptionId);
                    } else {
                        // The generic store admits opaque digests; this strict Protocol crossing does not.
                        const digest = PluginUiArtifactDigestV1Schema.safeParse(snapshot.digest);
                        if (!digest.success) {
                            watch.deliver(terminalEvent(watch.subscriptionId, 'unavailable', 'plugin_resource_digest_invalid'));
                            retire(watch.subscriptionId);
                        } else if (watch.lastDigest !== digest.data) {
                            watch.lastDigest = digest.data;
                            watch.deliver(invalidatedEvent(watch.subscriptionId, digest.data));
                        }
                    }
                };
                watch.releaseStore = entry.subscribe(changed, true);
                watches.set(params.subscriptionId, watch);
                try {
                    await readPluginResourceStoreSnapshot(entry, params.signal);
                    const snapshot = entry.getSnapshot();
                    if (!isCurrent() || params.signal?.aborted || snapshot.error || !snapshot.value) {
                        retire(params.subscriptionId);
                        return { ok: false, terminal: snapshot.error?.retryable !== true,
                            reason: snapshot.error?.code ?? 'plugin_resource_unavailable',
                            metadata: readPluginSurfaceHostApiFailureMetadata(snapshot.error?.details) };
                    }
                    const digest = PluginUiArtifactDigestV1Schema.safeParse(snapshot.digest);
                    if (!digest.success) {
                        retire(params.subscriptionId);
                        return { ok: false, terminal: true, reason: 'plugin_resource_digest_invalid' };
                    }
                    watch.lastDigest = digest.data;
                    established = true;
                    return { ok: true, digest: digest.data };
                } catch {
                    retire(params.subscriptionId);
                    return { ok: false, terminal: true, reason: 'plugin_resource_aborted' };
                }
            }
            let opened: WatchOpenResult;
            try {
                opened = await openAtDaemon(params.subscriptionId, params.resourceId, params.signal, params.readAuthority, params.actionRead);
            } catch (error) {
                if (params.signal?.aborted) {
                    return { ok: false, terminal: true, reason: 'plugin_resource_aborted' };
                }
                throw error;
            }
            if (params.signal?.aborted || input.resource.store && !params.readAuthority && !params.actionRead) {
                if (opened.ok) {
                    void close(requireMachineId(), {
                        serverId: daemon.serverId,
                        ...accountTarget,
                        ...('hostResource' in input.resource ? { resource: input.resource.hostResource } : pluginBinding()),
                        subscriptionId: params.subscriptionId,
                    });
                }
                return { ok: false, terminal: true, reason: 'plugin_resource_aborted' };
            }
            if (!opened.ok) return opened;
            if (!isCurrent()) {
                void close(requireMachineId(), {
                    serverId: daemon.serverId,
                    ...accountTarget,
                    ...('hostResource' in input.resource ? { resource: input.resource.hostResource } : pluginBinding()),
                    subscriptionId: params.subscriptionId,
                });
                return { ok: false, terminal: true, reason: 'plugin_surface_retired' };
            }
            const watch: ActiveWatch = {
                subscriptionId: params.subscriptionId,
                resourceId: params.resourceId,
                ...(params.readAuthority === undefined ? {} : { readAuthority: params.readAuthority }),
                ...(params.actionRead === undefined ? {} : { actionRead: params.actionRead }),
                deliver: params.deliver,
                controller: new AbortController(),
                lastDigest: opened.digest ?? null,
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
            releaseNamespaceAdmission?.();
            for (const watch of [...watches.values()]) {
                retire(watch.subscriptionId);
                if (watch.readAuthority || watch.actionRead) watch.deliver(terminalEvent(watch.subscriptionId, 'expired_resource', watch.actionRead
                    ? 'plugin_action_read_observation_lost' : 'plugin_read_authority_observation_lost'));
            }
        },
    });
}
