import {
    PluginUiArtifactDigestV1Schema,
    PluginUiDisposeHostResourceRequestV1Schema,
    PluginUiResourceSubscriptionRequestV1Schema,
    type PluginUiJsonValueV1,
    type PluginUiResourceSubscriptionEventV1,
} from '@happier-dev/protocol/plugins/ui';

import { mergeAbortSignals } from '@/utils/runtime/abortSignals';

import type { PluginUiResourceClient, PluginUiResourceStore } from '@happier-dev/plugin-ui/advanced';
import { pluginUiResourceReferenceKey } from '@happier-dev/plugin-ui/advanced';
import { subscribeMachineContributionRegistryProjectionInvalidation } from '@/sync/ops/machineContributionRegistryProjectionRevision';
import { PluginUiHostReadReferenceV1Schema } from '@happier-dev/protocol/plugins/ui/client';

import {
    readPluginSurfaceResourceReference,
    readPluginResourceStoreSnapshot,
    type PluginContextualResourceBinding,
    type PluginResourceHostRequest,
} from './pluginSurfaceResourceRead';
import {
    createPluginSurfaceHostApiError,
    type PluginSurfaceHostApiRequestOptions,
} from './createPluginSurfaceHostApi';
import { createContextualResourceWatchOwner, invalidatedEvent, terminalEvent, type PluginSurfaceResourceWatchTransport } from './daemonResourceWatch';
export type { PluginSurfaceResourceWatchTransport } from './daemonResourceWatch';

/**
 * The mounted `watchResource` / `disposeHostResource` handlers (§3.6, EU-4b).
 *
 * This module carries invalidation signals, never Resource values. Declared
 * resources keep the existing daemon watch lifecycle; admitted host reads
 * subscribe to the same Account Resource entry as host widgets. Both deliver
 * through the mount's existing subscription sink without a value cache or poll
 * loop for host reads.
 *
 * **Resynchronization** is this module's real responsibility. `open` answers
 * with the digest the daemon currently observes; the handler keeps that as the
 * subscription's last known good, and whenever the daemon-side subscription is
 * replaced — a reconnect after a transport outage, or a daemon that no longer
 * knows the id — it re-opens and publishes an invalidation when the digest
 * moved. An observer therefore converges on last-known-good plus one re-read
 * instead of a silent stale view.
 */

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
    return createPluginSurfaceHostApiError(code, [reason]);
}

function resourceAbortPayload(isCurrent: (() => boolean) | undefined): PluginUiJsonValueV1 {
    return errorPayload(
        'unavailable',
        isCurrent?.() === false ? 'plugin_surface_retired' : 'plugin_resource_aborted',
    );
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
    pluginId?: string;
    resource: PluginContextualResourceBinding;
    subscriptionIdPrefix: string;
    isCurrent?: () => boolean;
    transport?: Partial<PluginSurfaceResourceWatchTransport>;
    delayMs?: (ms: number, signal: AbortSignal) => Promise<void>;
}>): Readonly<{
    watchResource: NonNullable<PluginUiResourceClient['watchResource']>;
    onWatchRecovery: NonNullable<PluginUiResourceClient['onWatchRecovery']>;
}> {
    const owner = createContextualResourceWatchOwner(input);
    let nextSubscription = 0;
    return Object.freeze({
        onWatchRecovery(listener) {
            const machineId = input.resource.machineId;
            const release = machineId === null ? () => {} : subscribeMachineContributionRegistryProjectionInvalidation({
                machineId, serverId: input.resource.serverId ?? null,
            }, listener);
            return { dispose: release };
        },
        async watchResource(resource, listener, options) {
            const host = 'hostResource' in input.resource ? input.resource.hostResource : null;
            const hostReference = host ? PluginUiHostReadReferenceV1Schema.safeParse(resource) : null;
            if (host && (!hostReference?.success
                || pluginUiResourceReferenceKey(hostReference.data, null) !== pluginUiResourceReferenceKey(host, null)))
                return resourceClientFailure('plugin_resource_request_invalid', 'Host Resource reference is not current');
            const reference = host ? { localId: host.hostRead } : input.pluginId ? readPluginSurfaceResourceReference(input.pluginId, resource) : null;
            if (!reference) {
                return resourceClientFailure('plugin_resource_request_invalid', 'Resource reference is invalid');
            }
            if (!host && 'pluginId' in reference && reference.pluginId !== input.pluginId) {
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
                    { ...opened.metadata, retryable: !opened.terminal },
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
        onWatchRecovery: NonNullable<PluginUiResourceClient['onWatchRecovery']>;
    }>);
}

export function createPluginSurfaceResourceWatchHandlers(input: Readonly<{
    pluginId: string;
    resource?: PluginContextualResourceBinding;
    hostResourceStore?: PluginUiResourceStore;
    isDaemonAvailable?: () => boolean;
    /** Publishes one event into the mount's existing subscription registry. */
    deliver: (event: PluginUiResourceSubscriptionEventV1) => void;
    isCurrent?: () => boolean;
    /** The bound controller's one mount lifetime; absent for direct unit composition. */
    lifetimeSignal?: AbortSignal;
    transport?: Partial<PluginSurfaceResourceWatchTransport>;
    /** Injected only so the pump's backoff is deterministic in tests. */
    delayMs?: (ms: number, signal: AbortSignal) => Promise<void>;
}>) {
    let resource = input.resource;
    const createOwner = (binding: PluginContextualResourceBinding | undefined) => binding
        ? createContextualResourceWatchOwner({ ...input, resource: binding }) : null;
    let owner = createOwner(resource);
    const hostWatches = new Map<string, () => void>();
    return Object.freeze({
        updateResource(next: PluginContextualResourceBinding | undefined): void {
            if (next === resource) return;
            owner?.dispose();
            resource = next;
            owner = createOwner(next);
        },
        watchResource: async (
            request: PluginResourceHostRequest,
            options?: PluginSurfaceHostApiRequestOptions,
        ): Promise<PluginUiJsonValueV1> => {
            const payload = readJsonRecord(request.payload);
            const parsed = payload
                ? PluginUiResourceSubscriptionRequestV1Schema.safeParse(payload)
                : null;
            if (!parsed?.success) {
                return errorPayload('invalid_payload', 'plugin_surface_resource_subscription_payload_invalid');
            }
            const hostReference = PluginUiHostReadReferenceV1Schema.safeParse(parsed.data.resource);
            if (hostReference.success && input.hostResourceStore) {
                const { subscriptionId } = parsed.data;
                hostWatches.get(subscriptionId)?.();
                const merged = mergeAbortSignals([input.lifetimeSignal, options?.signal]);
                const signal = merged.signal;
                if (signal?.aborted || input.isCurrent?.() === false) { merged.dispose(); return resourceAbortPayload(input.isCurrent); }
                const entry = input.hostResourceStore.getEntry(hostReference.data);
                let lastDigest: PluginSurfaceResourceDigest | undefined;
                let established = false;
                let release = () => {};
                const close = () => {
                    release(); merged.dispose(); signal?.removeEventListener('abort', close);
                    if (hostWatches.get(subscriptionId) === close) hostWatches.delete(subscriptionId);
                };
                hostWatches.set(subscriptionId, close);
                release = entry.subscribe(() => {
                    if (!established || signal?.aborted || input.isCurrent?.() === false) return;
                    const snapshot = entry.getSnapshot();
                    if (!snapshot.value && snapshot.error) {
                        input.deliver(terminalEvent(subscriptionId, 'denied', snapshot.error.code ?? 'plugin_resource_unavailable'));
                        close();
                    } else if (snapshot.value) {
                        const digest = PluginUiArtifactDigestV1Schema.safeParse(snapshot.digest);
                        if (!digest.success) {
                            input.deliver(terminalEvent(subscriptionId, 'unavailable', 'plugin_resource_digest_invalid'));
                            close();
                        } else if (digest.data !== lastDigest) {
                            lastDigest = digest.data;
                            input.deliver(invalidatedEvent(subscriptionId, digest.data));
                        }
                    }
                }, true);
                signal?.addEventListener('abort', close, { once: true });
                try {
                    const snapshot = await readPluginResourceStoreSnapshot(entry, signal);
                    if (signal?.aborted || input.isCurrent?.() === false) { close(); return resourceAbortPayload(input.isCurrent); }
                    if (!snapshot.value) { close(); return errorPayload('unavailable', snapshot.error?.code ?? 'plugin_resource_unavailable'); }
                    const digest = PluginUiArtifactDigestV1Schema.safeParse(snapshot.digest);
                    if (!digest.success) { close(); return errorPayload('unavailable', 'plugin_resource_digest_invalid'); }
                    lastDigest = digest.data;
                    established = true;
                    return { subscriptionId, digest: digest.data };
                } catch (error) {
                    close();
                    return errorPayload('unavailable', error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
                        ? error.code : 'plugin_resource_unavailable');
                }
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
            // One issued watch retains its admitted owner across awaits. A
            // committed binding update may retire it, never redirect it.
            const admittedOwner = owner;
            if (!admittedOwner || input.isDaemonAvailable?.() === false) return errorPayload('unavailable', 'plugin_resource_transport_unavailable');
            if (input.isCurrent?.() === false) {
                return errorPayload('unavailable', 'plugin_surface_retired');
            }
            const mergedSignal = mergeAbortSignals([input.lifetimeSignal, options?.signal]);
            const signal = mergedSignal.signal;
            try {
                if (signal?.aborted) return resourceAbortPayload(input.isCurrent);
                const subscriptionId = parsed.data.subscriptionId;
                const opened = await admittedOwner.open({
                    subscriptionId,
                    resourceId: reference.localId,
                    deliver: input.deliver,
                    ...(signal === undefined ? {} : { signal }),
                });
                if (signal?.aborted) return resourceAbortPayload(input.isCurrent);
                if (!opened.ok) return errorPayload('unavailable', opened.reason);
                if (input.isCurrent?.() === false) {
                    admittedOwner.retire(subscriptionId);
                    return resourceAbortPayload(input.isCurrent);
                }
                // The establishment result is the resynchronization baseline the
                // author can compare against its own last read.
                return { subscriptionId, ...(opened.digest === undefined ? {} : { digest: opened.digest }) };
            } finally {
                // The established watch pumps on its own controller, so this
                // composition is only live while `owner.open` awaits the daemon.
                // Releasing it here keeps one long-lived mount lifetime from
                // accumulating a listener per author subscription.
                mergedSignal.dispose();
            }
        },
        disposeHostResource: async (request: PluginResourceHostRequest): Promise<PluginUiJsonValueV1> => {
            const parsed = PluginUiDisposeHostResourceRequestV1Schema.safeParse(readJsonRecord(request.payload));
            if (!parsed.success) {
                return errorPayload('invalid_payload', 'plugin_surface_resource_subscription_payload_invalid');
            }
            owner?.retire(parsed.data.subscriptionId);
            hostWatches.get(parsed.data.subscriptionId)?.();
            // This is a transport-control operation, not an author-visible
            // result. The hosted wire acknowledges it separately.
            return null;
        },
        dispose: () => { owner?.dispose(); for (const close of [...hostWatches.values()]) close(); },
    });
}
