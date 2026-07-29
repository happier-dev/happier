import {
    AGENT_SESSION_RUNTIME_EVENT_KINDS_V1,
    HAPPIER_HOST_EVENT_PREFIX_V1,
    type ParsedPluginEventContributionV1,
    PluginContributionIdentityV1Schema,
    PluginContributionLocalIdSchema,
    type PluginPermissionDeclarationV1,
    readHostEventNamespaceV1,
} from '@happier-dev/protocol';
import { PluginError, type Disposable, type JsonValue, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { type PluginContributionRef, type PluginEventEmitResult, type PluginEventsService } from '@happier-dev/plugin-sdk/runtime';

import type { HostRuntimeLimitMeasurementRecorder } from '@/agent/runtime/state/runtimeLimitMeasurement';

import { validatePluginEventPayloadSchema } from '../../context/eventPayloadSchema';
import {
    clonePluginPlainData,
    PLUGIN_RUNTIME_JSON_VALUE_LIMITS,
} from '../../plainData';
import type { PluginInvocationServicesSeed } from './types';

export const STABLE_PLUGIN_EVENT_QUEUE_LIMITS = Object.freeze({
    pendingDeliveriesPerSubscription: 256,
    pendingBytesPerSubscription: 1024 * 1024,
});

const RESERVED_RUNTIME_EVENT_IDS = new Set<string>(AGENT_SESSION_RUNTIME_EVENT_KINDS_V1);

type DeliveredPluginEvent = Readonly<{
    ref: PluginContributionRef;
    payload: JsonValue;
    sequence: number;
}>;

type EventPublicationIdentity = Readonly<{
    pluginId: string;
    pluginVersion: string;
    contributionId: string;
    contributionQualifiedId: string;
    generation: string;
    correlationId: string;
    surface: PluginInvocationServicesSeed['surface'];
}>;

type BrokerPublication = Readonly<{
    event: DeliveredPluginEvent;
    identity: EventPublicationIdentity;
}>;

type BrokerSubscription = {
    readonly ref: PluginContributionRef;
    readonly identity: EventPublicationIdentity;
    readonly listener: (event: DeliveredPluginEvent) => void | Promise<void>;
    readonly isCurrent: () => boolean;
    readonly priority: number;
    readonly orderKey: string;
    readonly queue: Array<Readonly<{ publication: BrokerPublication; bytes: number }>>;
    pendingDeliveries: number;
    pendingBytes: number;
    processing: boolean;
    disposed: boolean;
};

export type StablePluginEventsBroker = Readonly<{
    emit(publication: Omit<BrokerPublication, 'event'> & Readonly<{
        event: Omit<DeliveredPluginEvent, 'sequence'>;
    }>): Promise<PluginEventEmitResult>;
    subscribe(params: Readonly<{
        ref: PluginContributionRef;
        identity: EventPublicationIdentity;
        listener: (event: DeliveredPluginEvent) => void | Promise<void>;
        isCurrent: () => boolean;
        priority?: number;
        orderKey?: string;
    }>): Disposable;
}>;

function eventError(code: string, message: string): PluginError {
    return new PluginError({ code, message });
}

function sameRef(left: PluginContributionRef, right: PluginContributionRef): boolean {
    return left.pluginId === right.pluginId && left.localId === right.localId;
}

function readEventRef(value: unknown): PluginContributionRef {
    try {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            throw eventError('plugin_events_invalid_ref', 'Plugin event reference is invalid');
        }
        const pluginId = Reflect.get(value, 'pluginId');
        const localId = Reflect.get(value, 'localId');
        if (typeof pluginId !== 'string' || typeof localId !== 'string') {
            throw eventError('plugin_events_invalid_ref', 'Plugin event reference is invalid');
        }
        if (readHostEventNamespaceV1(`${pluginId}/${localId}`) !== null) {
            throw eventError('plugin_events_reserved', `Plugin event target '${pluginId}/${localId}' uses the reserved host namespace`);
        }
        const parsed = PluginContributionIdentityV1Schema.safeParse({ pluginId, localId });
        if (!parsed.success) {
            throw eventError('plugin_events_invalid_ref', 'Plugin event reference is invalid');
        }
        return Object.freeze(parsed.data);
    } catch (error) {
        if (error instanceof PluginError) throw error;
        throw eventError('plugin_events_invalid_ref', 'Plugin event reference is invalid');
    }
}

function encodedPublicationBytes(publication: BrokerPublication): number {
    return Buffer.byteLength(JSON.stringify(publication), 'utf8');
}

function readSubscriptionQueueHighWater(
    subscriptions: readonly BrokerSubscription[],
): Readonly<{ queuedItems: number; queuedBytes: number }> {
    let queuedItems = 0;
    let queuedBytes = 0;
    for (const subscription of subscriptions) {
        queuedItems = Math.max(queuedItems, subscription.pendingDeliveries);
        queuedBytes = Math.max(queuedBytes, subscription.pendingBytes);
    }
    return { queuedItems, queuedBytes };
}

function readAttemptedSubscriptionQueueHighWater(
    subscriptions: readonly BrokerSubscription[],
    publicationBytes: number,
): Readonly<{ queuedItems: number; queuedBytes: number }> {
    let queuedItems = 0;
    let queuedBytes = 0;
    for (const subscription of subscriptions) {
        queuedItems = Math.max(queuedItems, subscription.pendingDeliveries + 1);
        queuedBytes = Math.max(queuedBytes, subscription.pendingBytes + publicationBytes);
    }
    return { queuedItems, queuedBytes };
}

export function measureStablePluginEventPublicationBytes(sample: Readonly<{
    ref: PluginContributionRef;
    payload: JsonValue;
    identity: EventPublicationIdentity;
    sequence?: number;
}>): number {
    return encodedPublicationBytes({
        event: {
            ref: sample.ref,
            payload: sample.payload,
            sequence: sample.sequence ?? 1,
        },
        identity: sample.identity,
    });
}

export function createStablePluginEventsBroker(params?: Readonly<{
    onListenerError?: (error: Readonly<{
        publication: BrokerPublication;
        subscriptionIdentity: EventPublicationIdentity;
        error: unknown;
    }>) => void;
    recordRuntimeLimitMeasurement?: HostRuntimeLimitMeasurementRecorder;
}>): StablePluginEventsBroker {
    const subscriptions = new Set<BrokerSubscription>();
    const recordRuntimeLimitMeasurement = params?.recordRuntimeLimitMeasurement;
    let sequence = 0;

    const disposeSubscription = (subscription: BrokerSubscription): void => {
        if (subscription.disposed) return;
        subscription.disposed = true;
        subscription.queue.length = 0;
        subscription.pendingDeliveries = 0;
        subscription.pendingBytes = 0;
        subscriptions.delete(subscription);
    };

    const drain = (subscription: BrokerSubscription): void => {
        if (subscription.processing || subscription.disposed) return;
        subscription.processing = true;
        void (async () => {
            try {
                while (!subscription.disposed) {
                    const queued = subscription.queue.shift();
                    if (!queued) return;
                    if (!subscription.isCurrent()) {
                        disposeSubscription(subscription);
                        return;
                    }
                    try {
                        await subscription.listener(queued.publication.event);
                    } catch (error) {
                        try {
                            params?.onListenerError?.({
                                publication: queued.publication,
                                subscriptionIdentity: subscription.identity,
                                error,
                            });
                        } catch {
                            // Listener diagnostics are failure-isolated from broker delivery.
                        }
                    } finally {
                        if (!subscription.disposed) {
                            subscription.pendingDeliveries -= 1;
                            subscription.pendingBytes -= queued.bytes;
                        }
                    }
                }
            } finally {
                subscription.processing = false;
                if (!subscription.disposed && subscription.queue.length > 0) drain(subscription);
            }
        })();
    };

    return Object.freeze({
        async emit(input): Promise<PluginEventEmitResult> {
            if (!Number.isSafeInteger(sequence + 1)) {
                throw eventError('plugin_events_sequence_exhausted', 'Plugin event broker sequence is exhausted');
            }
            const nextSequence = sequence + 1;
            const event = Object.freeze({
                ref: Object.freeze({ ...input.event.ref }),
                payload: input.event.payload,
                sequence: nextSequence,
            });
            const targets: BrokerSubscription[] = [];
            for (const subscription of subscriptions) {
                if (!subscription.isCurrent()) {
                    disposeSubscription(subscription);
                    continue;
                }
                if (sameRef(subscription.ref, event.ref)) targets.push(subscription);
            }
            targets.sort((left, right) => (
                left.priority - right.priority
                || left.orderKey.localeCompare(right.orderKey)
            ));
            const publication = Object.freeze({
                event,
                identity: input.identity,
            });
            const bytes = targets.length > 0 ? encodedPublicationBytes(publication) : 0;
            if (bytes > STABLE_PLUGIN_EVENT_QUEUE_LIMITS.pendingBytesPerSubscription) {
                if (recordRuntimeLimitMeasurement) {
                    const highWater = readAttemptedSubscriptionQueueHighWater(targets, bytes);
                    recordRuntimeLimitMeasurement(Object.freeze({
                        family: 'plugin-event-broker',
                        ...highWater,
                        backpressured: true,
                    }));
                }
                throw eventError('plugin_event_backpressure', 'Plugin event exceeds the per-subscription byte limit');
            }
            const exceedsLimit = targets.some((subscription) => (
                subscription.pendingDeliveries + 1 > STABLE_PLUGIN_EVENT_QUEUE_LIMITS.pendingDeliveriesPerSubscription
                || subscription.pendingBytes + bytes > STABLE_PLUGIN_EVENT_QUEUE_LIMITS.pendingBytesPerSubscription
            ));
            if (exceedsLimit) {
                if (recordRuntimeLimitMeasurement) {
                    const highWater = readAttemptedSubscriptionQueueHighWater(targets, bytes);
                    recordRuntimeLimitMeasurement(Object.freeze({
                        family: 'plugin-event-broker',
                        ...highWater,
                        backpressured: true,
                    }));
                }
                throw eventError('plugin_event_backpressure', 'Plugin event queue capacity is unavailable');
            }
            sequence = nextSequence;
            for (const subscription of targets) {
                subscription.queue.push(Object.freeze({ publication, bytes }));
                subscription.pendingDeliveries += 1;
                subscription.pendingBytes += bytes;
            }
            if (targets.length > 0 && recordRuntimeLimitMeasurement) {
                const highWater = readSubscriptionQueueHighWater(targets);
                recordRuntimeLimitMeasurement(Object.freeze({
                    family: 'plugin-event-broker',
                    ...highWater,
                    backpressured: false,
                    sequence,
                }));
            }
            for (const subscription of targets) drain(subscription);
            return Object.freeze({
                status: 'admitted',
                sequence,
                subscriberCount: targets.length,
            });
        },
        subscribe(subscriptionParams): Disposable {
            const subscription: BrokerSubscription = {
                ref: Object.freeze({ ...subscriptionParams.ref }),
                identity: subscriptionParams.identity,
                listener: subscriptionParams.listener,
                isCurrent: subscriptionParams.isCurrent,
                priority: subscriptionParams.priority ?? 0,
                orderKey: subscriptionParams.orderKey ?? '',
                queue: [],
                pendingDeliveries: 0,
                pendingBytes: 0,
                processing: false,
                disposed: false,
            };
            subscriptions.add(subscription);
            return Object.freeze({
                dispose() {
                    disposeSubscription(subscription);
                },
            });
        },
    });
}

type EventDeclarationMap = ReadonlyMap<string, readonly ParsedPluginEventContributionV1[]>;

export type PluginInvocationEventsHost = Readonly<{
    broker: StablePluginEventsBroker;
    declarationsByPluginId: EventDeclarationMap;
    permissionDeclarationsByPluginId: ReadonlyMap<string, readonly PluginPermissionDeclarationV1[]>;
    activePluginIds: ReadonlySet<string>;
}>;

function readPublishedEvent(
    declarations: EventDeclarationMap,
    ref: PluginContributionRef,
): Extract<ParsedPluginEventContributionV1, Readonly<{ kind: 'event' }>> | null {
    const declaration = declarations.get(ref.pluginId)?.find((candidate) => (
        candidate.kind === 'event' && candidate.id === ref.localId
    ));
    return declaration?.kind === 'event' ? declaration : null;
}

function hasDeclaredSubscription(
    declarations: EventDeclarationMap,
    pluginId: string,
    ref: PluginContributionRef,
): boolean {
    return declarations.get(pluginId)?.some((candidate) => (
        candidate.kind === 'subscription'
        && (typeof candidate.event === 'string'
            ? pluginId === ref.pluginId && candidate.event === ref.localId
            : candidate.event.pluginId === ref.pluginId && candidate.event.localId === ref.localId)
    )) === true;
}

function hasCrossPluginRight(
    permissions: ReadonlyMap<string, readonly PluginPermissionDeclarationV1[]>,
    pluginId: string,
    targetPluginId: string,
): boolean {
    if (pluginId === targetPluginId) return true;
    return permissions.get(pluginId)?.some((permission) => (
        permission.capability === 'events.plugin.subscribe'
        && permission.scope === targetPluginId
    )) === true;
}

function readJsonPayload(payload: unknown): JsonValue {
    try {
        return clonePluginPlainData(payload, {
            path: 'payload',
            limits: PLUGIN_RUNTIME_JSON_VALUE_LIMITS,
            invalid: (message) => eventError('plugin_events_invalid_payload', message),
            limitExceeded: (message) => eventError('plugin_events_invalid_payload', message),
        }) as JsonValue;
    } catch (error) {
        if (error instanceof PluginError) throw error;
        throw eventError('plugin_events_invalid_payload', 'Plugin event payload must contain bounded strict JSON data');
    }
}

export type DeclaredEventSubscriptionRegistration = Readonly<{
    pluginId: string;
    pluginVersion: string;
    generation: string;
    localId: string;
    handler(payload: JsonValue, context: PluginInvocationContext): unknown;
}>;

function resolveDeclaredSubscriptionRef(
    pluginId: string,
    declaration: Extract<ParsedPluginEventContributionV1, Readonly<{ kind: 'subscription' }>>,
): PluginContributionRef {
    return typeof declaration.event === 'string'
        ? Object.freeze({ pluginId, localId: declaration.event })
        : Object.freeze({ ...declaration.event });
}

/** Bind committed manifest subscription registrations to the canonical daemon-local broker. */
export function bindDeclaredEventSubscriptions(params: Readonly<{
    host: PluginInvocationEventsHost;
    registrations: readonly DeclaredEventSubscriptionRegistration[];
    isGenerationCurrent(registration: DeclaredEventSubscriptionRegistration): boolean;
    createContext(input: Readonly<{
        pluginId: string;
        pluginVersion: string;
        generation: string;
        localId: string;
        signal: AbortSignal;
    }>): PluginInvocationContext;
}>): Disposable {
    const bindings: Array<Readonly<{ controller: AbortController; disposable: Disposable }>> = [];
    let disposed = false;

    try {
        for (const registration of params.registrations) {
            const declaration = params.host.declarationsByPluginId.get(registration.pluginId)?.find((candidate) => (
                candidate.kind === 'subscription' && candidate.id === registration.localId
            ));
            if (!declaration || declaration.kind !== 'subscription') {
                throw eventError(
                    'plugin_events_subscription_undeclared',
                    `Plugin subscription '${registration.pluginId}/${registration.localId}' is not declared`,
                );
            }
            const ref = resolveDeclaredSubscriptionRef(registration.pluginId, declaration);
            if (!params.host.activePluginIds.has(ref.pluginId) || !readPublishedEvent(params.host.declarationsByPluginId, ref)) {
                throw eventError(
                    'plugin_events_target_unavailable',
                    `Plugin event target '${ref.pluginId}/${ref.localId}' is unavailable`,
                );
            }
            if (!hasCrossPluginRight(params.host.permissionDeclarationsByPluginId, registration.pluginId, ref.pluginId)) {
                throw eventError(
                    'plugin_events_subscription_denied',
                    `Plugin subscription to '${ref.pluginId}/${ref.localId}' is denied`,
                );
            }
            const controller = new AbortController();
            const identity = Object.freeze({
                pluginId: registration.pluginId,
                pluginVersion: registration.pluginVersion,
                contributionId: registration.localId,
                contributionQualifiedId: `${registration.pluginId}/events/${encodeURIComponent(registration.localId)}`,
                generation: registration.generation,
                correlationId: `${registration.pluginId}/events/${registration.localId}`,
                surface: 'cli' as const,
            });
            const isCurrent = (): boolean => (
                !disposed
                && !controller.signal.aborted
                && params.isGenerationCurrent(registration)
            );
            const disposable = params.host.broker.subscribe({
                ref,
                identity,
                priority: declaration.priority ?? 0,
                orderKey: `${registration.pluginId}\u0000${registration.localId}`,
                isCurrent,
                async listener(event) {
                    if (!isCurrent()) return;
                    if (declaration.filterSchema) {
                        const filter = validatePluginEventPayloadSchema({
                            payloadSchema: declaration.filterSchema,
                            payload: event.payload,
                        });
                        if (!filter.success) return;
                    }
                    const context = params.createContext({
                        pluginId: registration.pluginId,
                        pluginVersion: registration.pluginVersion,
                        generation: registration.generation,
                        localId: registration.localId,
                        signal: controller.signal,
                    });
                    if (!isCurrent()) return;
                    await registration.handler(event.payload, context);
                },
            });
            bindings.push(Object.freeze({ controller, disposable }));
        }
    } catch (error) {
        disposed = true;
        for (const binding of bindings.reverse()) {
            binding.controller.abort();
            void binding.disposable.dispose();
        }
        throw error;
    }

    return Object.freeze({
        async dispose() {
            if (disposed) return;
            disposed = true;
            const errors: unknown[] = [];
            for (const binding of bindings.reverse()) {
                binding.controller.abort();
                try {
                    await binding.disposable.dispose();
                } catch (error) {
                    errors.push(error);
                }
            }
            if (errors.length === 1) throw errors[0];
            if (errors.length > 1) throw new AggregateError(errors, 'Plugin event subscription disposal failed');
        },
    });
}

export function createPluginInvocationEventsService(params: Readonly<{
    seed: PluginInvocationServicesSeed;
}> & PluginInvocationEventsHost): PluginEventsService {
    const ensureCurrent = (signal?: AbortSignal): void => {
        if (signal?.aborted || params.seed.signal.aborted || !params.seed.isGenerationCurrent()) {
            throw eventError('plugin_events_generation_retired', 'Plugin event invocation generation is no longer current');
        }
    };
    const identity = Object.freeze({
        pluginId: params.seed.plugin.id,
        pluginVersion: params.seed.plugin.version,
        contributionId: params.seed.contribution.id,
        contributionQualifiedId: params.seed.contribution.qualifiedId,
        generation: params.seed.generation,
        correlationId: params.seed.correlationId,
        surface: params.seed.surface,
    });
    return Object.freeze({
        async emit<T extends JsonValue>(
            eventId: string,
            payload: T,
            options?: { signal?: AbortSignal },
        ): Promise<PluginEventEmitResult> {
            ensureCurrent(options?.signal);
            if (typeof eventId !== 'string') {
                throw eventError('plugin_events_invalid_ref', 'Plugin event id is invalid');
            }
            if (eventId.startsWith(HAPPIER_HOST_EVENT_PREFIX_V1)) {
                throw eventError('plugin_events_reserved', `Plugin event '${eventId}' uses the reserved host namespace`);
            }
            if (RESERVED_RUNTIME_EVENT_IDS.has(eventId)) {
                throw eventError('plugin_events_reserved', `Plugin event '${eventId}' uses a reserved agent runtime event id`);
            }
            if (!PluginContributionLocalIdSchema.safeParse(eventId).success) {
                throw eventError('plugin_events_invalid_ref', 'Plugin event id is invalid');
            }
            const ref = Object.freeze({ pluginId: params.seed.plugin.id, localId: eventId });
            const declaration = readPublishedEvent(params.declarationsByPluginId, ref);
            if (!declaration) {
                throw eventError('plugin_events_undeclared', `Plugin event '${eventId}' is not declared by '${params.seed.plugin.id}'`);
            }
            const normalizedPayload = readJsonPayload(payload);
            if (declaration.payloadSchema) {
                const validation = validatePluginEventPayloadSchema({
                    payloadSchema: declaration.payloadSchema,
                    payload: normalizedPayload,
                });
                if (!validation.success) {
                    throw eventError('plugin_events_invalid_payload', validation.message);
                }
            }
            ensureCurrent(options?.signal);
            return await params.broker.emit({ event: { ref, payload: normalizedPayload }, identity });
        },
        subscribe<T extends JsonValue>(
            ref: PluginContributionRef,
            listener: (event: Readonly<{ ref: PluginContributionRef; payload: T; sequence: number }>) => void | Promise<void>,
        ): Disposable {
            ensureCurrent();
            if (typeof listener !== 'function') {
                throw eventError('plugin_events_invalid_listener', 'Plugin event listener must be callable');
            }
            const normalizedRef = readEventRef(ref);
            if (RESERVED_RUNTIME_EVENT_IDS.has(normalizedRef.localId)) {
                throw eventError('plugin_events_reserved', `Plugin event '${normalizedRef.localId}' uses a reserved agent runtime event id`);
            }
            if (!params.activePluginIds.has(normalizedRef.pluginId) || !readPublishedEvent(params.declarationsByPluginId, normalizedRef)) {
                throw eventError('plugin_events_target_unavailable', `Plugin event target '${normalizedRef.pluginId}/${normalizedRef.localId}' is unavailable`);
            }
            if (!hasDeclaredSubscription(params.declarationsByPluginId, params.seed.plugin.id, normalizedRef)) {
                throw eventError('plugin_events_subscription_undeclared', `Plugin subscription to '${normalizedRef.pluginId}/${normalizedRef.localId}' is not declared`);
            }
            if (!hasCrossPluginRight(
                params.permissionDeclarationsByPluginId,
                params.seed.plugin.id,
                normalizedRef.pluginId,
            )) {
                throw eventError('plugin_events_subscription_denied', `Plugin subscription to '${normalizedRef.pluginId}/${normalizedRef.localId}' is denied`);
            }
            const disposable = params.broker.subscribe({
                ref: normalizedRef,
                identity,
                listener: listener as (event: DeliveredPluginEvent) => void | Promise<void>,
                isCurrent: () => !params.seed.signal.aborted && params.seed.isGenerationCurrent(),
            });
            const abort = () => { void disposable.dispose(); };
            params.seed.signal.addEventListener('abort', abort, { once: true });
            let disposed = false;
            return Object.freeze({
                dispose() {
                    if (disposed) return;
                    disposed = true;
                    params.seed.signal.removeEventListener('abort', abort);
                    return disposable.dispose();
                },
            });
        },
    });
}
