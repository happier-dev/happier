import {
    AGENT_SESSION_RUNTIME_EVENT_KINDS_V1,
    HAPPIER_HOST_EVENT_PREFIX_V1,
    HostEventTargetV1Schema,
    hostEventIdForSemanticEventV1,
    parseHostEventPayloadV1,
    type HostEventEnvelopeV1,
    type HostEventIdV1,
    type HostEventTargetV1,
    type HostSemanticEventV1,
    type ParsedPluginEventContributionV1,
    PluginContributionIdentityV1Schema,
    PluginContributionLocalIdSchema,
    readHostEventNamespaceV1,
} from '@happier-dev/protocol';
import { isPluginError, PluginError, type Disposable, type JsonValue, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type {
    HostEvents,
    PluginEventEmitResult,
    PluginEvents,
} from '@happier-dev/plugin-sdk/events';
import type {
    PluginContributionRef } from '@happier-dev/plugin-sdk';

import type { HostRuntimeLimitMeasurementRecorder } from '@/agent/runtime/state/runtimeLimitMeasurement';

import { validatePluginEventPayloadSchema } from '../../context/eventPayloadSchema';
import { clonePluginPlainData } from '../../plainData';
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
    readonly isEffectCapable: () => boolean;
    readonly priority: number;
    readonly orderKey: string;
    readonly queue: Array<Readonly<{ publication: BrokerPublication; bytes: number }>>;
    pendingDeliveries: number;
    pendingBytes: number;
    processing: boolean;
    disposed: boolean;
};

type HostBrokerSubscription = {
    readonly target: Readonly<{
        eventId: HostEventTargetV1['eventId'];
        scope:
            | Readonly<{ kind: 'session'; sessionId: string }>
            | Readonly<{ kind: 'event-session' }>
            | Readonly<{ kind: 'account' }>;
    }>;
    readonly listener: (event: HostEventEnvelopeV1) => void | Promise<void>;
    readonly isCurrent: () => boolean;
    readonly isEffectCapable: () => boolean;
    readonly queue: Array<Readonly<{ event: HostEventEnvelopeV1; bytes: number }>>;
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
        isEffectCapable?: () => boolean;
        priority?: number;
        orderKey?: string;
    }>): Disposable;
    publishHostEvent(event: HostSemanticEventV1): void;
    publishHostEventEnvelope(event: HostEventEnvelopeV1): void;
    subscribeHost(params: Readonly<{
        target: HostEventTargetV1;
        currentSessionId?: string;
        bindCurrentSessionToEvent?: true;
        listener: (event: HostEventEnvelopeV1) => void | Promise<void>;
        isCurrent: () => boolean;
        isEffectCapable?: () => boolean;
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
        if (isPluginError(error)) throw error;
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
    onHostListenerError?: (error: Readonly<{
        event: HostEventEnvelopeV1;
        error: unknown;
    }>) => void;
    onHostDeliveryDropped?: (diagnostic: Readonly<{
        eventId: HostEventEnvelopeV1['eventId'];
        reason: 'delivery_limit' | 'byte_limit';
    }>) => void;
}>): StablePluginEventsBroker {
    const subscriptions = new Set<BrokerSubscription>();
    const hostSubscriptions = new Set<HostBrokerSubscription>();
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
                    if (!subscription.isEffectCapable()) {
                        subscription.pendingDeliveries -= 1;
                        subscription.pendingBytes -= queued.bytes;
                        continue;
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

    const disposeHostSubscription = (subscription: HostBrokerSubscription): void => {
        if (subscription.disposed) return;
        subscription.disposed = true;
        subscription.queue.length = 0;
        subscription.pendingDeliveries = 0;
        subscription.pendingBytes = 0;
        hostSubscriptions.delete(subscription);
    };

    const drainHost = (subscription: HostBrokerSubscription): void => {
        if (subscription.processing || subscription.disposed) return;
        subscription.processing = true;
        void (async () => {
            try {
                while (!subscription.disposed) {
                    const queued = subscription.queue.shift();
                    if (!queued) return;
                    if (!subscription.isCurrent()) {
                        disposeHostSubscription(subscription);
                        return;
                    }
                    if (!subscription.isEffectCapable()) {
                        subscription.pendingDeliveries -= 1;
                        subscription.pendingBytes -= queued.bytes;
                        continue;
                    }
                    try {
                        await subscription.listener(queued.event);
                    } catch (error) {
                        try {
                            params?.onHostListenerError?.({ event: queued.event, error });
                        } catch {
                            // Host Event diagnostics are failure-isolated from lifecycle producers.
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
                if (!subscription.disposed && subscription.queue.length > 0) drainHost(subscription);
            }
        })();
    };

    const publishHostEventEnvelope = (input: HostEventEnvelopeV1): void => {
        const target = HostEventTargetV1Schema.safeParse({
            eventId: input.eventId,
            scope: input.scope,
        });
        if (!target.success || target.data.scope.kind === 'current-session') {
            throw eventError('plugin_host_events_invalid_event', 'Host Event envelope is invalid');
        }
        const payload = parseHostEventPayloadV1(input.eventId, input.payload);
        const event = Object.freeze({
            eventId: input.eventId,
            scope: Object.freeze({ ...input.scope }),
            payload,
        }) as HostEventEnvelopeV1;
        const bytes = Buffer.byteLength(JSON.stringify(event), 'utf8');
        for (const subscription of hostSubscriptions) {
            if (!subscription.isCurrent()) {
                disposeHostSubscription(subscription);
                continue;
            }
            if (!subscription.isEffectCapable()) continue;
            if (subscription.target.eventId !== event.eventId) continue;
            if (
                subscription.target.scope.kind === 'session'
                && (
                    event.scope.kind !== 'session'
                    || subscription.target.scope.sessionId !== event.scope.sessionId
                )
            ) continue;
            if (
                subscription.target.scope.kind === 'account'
                && event.scope.kind !== 'account'
            ) continue;
            const reason = bytes > STABLE_PLUGIN_EVENT_QUEUE_LIMITS.pendingBytesPerSubscription
                ? 'byte_limit' as const
                : subscription.pendingDeliveries + 1 > STABLE_PLUGIN_EVENT_QUEUE_LIMITS.pendingDeliveriesPerSubscription
                    || subscription.pendingBytes + bytes > STABLE_PLUGIN_EVENT_QUEUE_LIMITS.pendingBytesPerSubscription
                    ? 'delivery_limit' as const
                    : null;
            if (reason) {
                try {
                    params?.onHostDeliveryDropped?.({ eventId: event.eventId, reason });
                } catch {
                    // Dropped-delivery diagnostics never affect the canonical producer.
                }
                continue;
            }
            subscription.queue.push(Object.freeze({ event, bytes }));
            subscription.pendingDeliveries += 1;
            subscription.pendingBytes += bytes;
            drainHost(subscription);
        }
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
                if (!subscription.isEffectCapable()) continue;
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
                isEffectCapable:
                    subscriptionParams.isEffectCapable
                    ?? (() => true),
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
        publishHostEvent(input): void {
            const eventId = hostEventIdForSemanticEventV1(input);
            const payload = parseHostEventPayloadV1(eventId, input);
            if (!('sessionId' in payload)) {
                throw eventError('plugin_host_events_invalid_event', 'Runtime Host Event has no Session scope');
            }
            const sessionId = payload.sessionId;
            publishHostEventEnvelope(Object.freeze({
                eventId,
                scope: { kind: 'session' as const, sessionId },
                payload,
            }) as HostEventEnvelopeV1);
        },
        publishHostEventEnvelope(input): void {
            publishHostEventEnvelope(input);
        },
        subscribeHost(subscriptionParams): Disposable {
            const parsed = HostEventTargetV1Schema.safeParse(subscriptionParams.target);
            if (!parsed.success) {
                throw eventError('plugin_host_events_invalid_target', 'Host Event subscription target is invalid');
            }
            const target: HostBrokerSubscription['target'] | null = parsed.data.scope.kind === 'current-session'
                ? subscriptionParams.currentSessionId
                    ? Object.freeze({
                        eventId: parsed.data.eventId,
                        scope: Object.freeze({ kind: 'session' as const, sessionId: subscriptionParams.currentSessionId }),
                    })
                    : subscriptionParams.bindCurrentSessionToEvent
                        ? Object.freeze({
                            eventId: parsed.data.eventId,
                            scope: Object.freeze({ kind: 'event-session' as const }),
                        })
                        : null
                : parsed.data.scope.kind === 'account'
                    ? Object.freeze({
                        eventId: parsed.data.eventId,
                        scope: Object.freeze({ kind: 'account' as const }),
                    })
                    : Object.freeze({
                    eventId: parsed.data.eventId,
                    scope: Object.freeze({
                        kind: 'session' as const,
                        sessionId: parsed.data.scope.sessionId,
                    }),
                    });
            if (!target) {
                throw eventError('plugin_host_events_current_session_unavailable', 'A current-session Host Event target requires a bound session');
            }
            const subscription: HostBrokerSubscription = {
                target,
                listener: subscriptionParams.listener,
                isCurrent: subscriptionParams.isCurrent,
                isEffectCapable:
                    subscriptionParams.isEffectCapable
                    ?? (() => true),
                queue: [],
                pendingDeliveries: 0,
                pendingBytes: 0,
                processing: false,
                disposed: false,
            };
            hostSubscriptions.add(subscription);
            return Object.freeze({
                dispose() {
                    disposeHostSubscription(subscription);
                },
            });
        },
    });
}

type EventDeclarationMap = ReadonlyMap<string, readonly ParsedPluginEventContributionV1[]>;

export type PluginInvocationEventsHost = Readonly<{
    broker: StablePluginEventsBroker;
    declarationsByPluginId: EventDeclarationMap;
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
        && candidate.target.kind === 'plugin'
        && (typeof candidate.target.event === 'string'
            ? pluginId === ref.pluginId && candidate.target.event === ref.localId
            : candidate.target.event.pluginId === ref.pluginId && candidate.target.event.localId === ref.localId)
    )) === true;
}

function readJsonPayload(payload: unknown): JsonValue {
    try {
        return clonePluginPlainData(payload, {
            path: 'payload',
            invalid: (message) => eventError('plugin_events_invalid_payload', message),
        }) as JsonValue;
    } catch (error) {
        if (isPluginError(error)) throw error;
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
    if (declaration.target.kind !== 'plugin') {
        throw eventError('plugin_events_invalid_target', 'Plugin event subscription target is not a plugin event');
    }
    return typeof declaration.target.event === 'string'
        ? Object.freeze({ pluginId, localId: declaration.target.event })
        : Object.freeze({ ...declaration.target.event });
}

/** Bind committed manifest subscription registrations to the canonical daemon-local broker. */
export function bindDeclaredEventSubscriptions(params: Readonly<{
    host: PluginInvocationEventsHost;
    registrations: readonly DeclaredEventSubscriptionRegistration[];
    isGenerationCurrent(registration: DeclaredEventSubscriptionRegistration): boolean;
    isEffectCapable?(registration: DeclaredEventSubscriptionRegistration): boolean;
    createContext(input: Readonly<{
        pluginId: string;
        pluginVersion: string;
        generation: string;
        localId: string;
        sessionId?: string;
        signal: AbortSignal;
    }>): Readonly<{
        context: PluginInvocationContext;
        complete(): void;
    }>;
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
            if (declaration.target.kind === 'host') {
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
                const isEffectCapable = (): boolean => (
                    isCurrent()
                    && (params.isEffectCapable?.(registration) ?? true)
                );
                const disposable = params.host.broker.subscribeHost({
                    target: HostEventTargetV1Schema.parse({
                        eventId: declaration.target.eventId,
                        scope: declaration.target.scope,
                    }),
                    bindCurrentSessionToEvent: true,
                    isCurrent,
                    isEffectCapable,
                    async listener(event) {
                        if (!isEffectCapable()) return;
                        if (declaration.filterSchema) {
                            const filter = validatePluginEventPayloadSchema({
                                payloadSchema: declaration.filterSchema,
                                payload: event.payload,
                            });
                            if (!filter.success) return;
                        }
                        const invocation = params.createContext({
                            pluginId: registration.pluginId,
                            pluginVersion: registration.pluginVersion,
                            generation: registration.generation,
                            localId: registration.localId,
                            ...(event.scope.kind === 'session'
                                ? { sessionId: event.scope.sessionId }
                                : {}),
                            signal: controller.signal,
                        });
                        try {
                            if (!isEffectCapable()) return;
                            await registration.handler(event.payload as JsonValue, invocation.context);
                        } finally {
                            invocation.complete();
                        }
                    },
                });
                bindings.push(Object.freeze({ controller, disposable }));
                continue;
            }
            const ref = resolveDeclaredSubscriptionRef(registration.pluginId, declaration);
            if (!params.host.activePluginIds.has(ref.pluginId) || !readPublishedEvent(params.host.declarationsByPluginId, ref)) {
                throw eventError(
                    'plugin_events_target_unavailable',
                    `Plugin event target '${ref.pluginId}/${ref.localId}' is unavailable`,
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
            const isEffectCapable = (): boolean => (
                isCurrent()
                && (params.isEffectCapable?.(registration) ?? true)
            );
            const disposable = params.host.broker.subscribe({
                ref,
                identity,
                priority: declaration.priority ?? 0,
                orderKey: `${registration.pluginId}\u0000${registration.localId}`,
                isCurrent,
                isEffectCapable,
                async listener(event) {
                    if (!isEffectCapable()) return;
                    if (declaration.filterSchema) {
                        const filter = validatePluginEventPayloadSchema({
                            payloadSchema: declaration.filterSchema,
                            payload: event.payload,
                        });
                        if (!filter.success) return;
                    }
                    const invocation = params.createContext({
                        pluginId: registration.pluginId,
                        pluginVersion: registration.pluginVersion,
                        generation: registration.generation,
                        localId: registration.localId,
                        signal: controller.signal,
                    });
                    try {
                        if (!isEffectCapable()) return;
                        await registration.handler(event.payload, invocation.context);
                    } finally {
                        invocation.complete();
                    }
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

export function createPluginInvocationPluginEventsService(params: Readonly<{
    seed: PluginInvocationServicesSeed;
}> & PluginInvocationEventsHost): PluginEvents {
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
            const disposable = params.broker.subscribe({
                ref: normalizedRef,
                identity,
                listener: listener as (event: DeliveredPluginEvent) => void | Promise<void>,
                isCurrent: () => !params.seed.signal.aborted && params.seed.isGenerationCurrent(),
            });
            const abort = () => { void disposable.dispose(); };
            params.seed.signal.addEventListener('abort', abort, { once: true });
            if (params.seed.signal.aborted || !params.seed.isGenerationCurrent()) {
                params.seed.signal.removeEventListener('abort', abort);
                try {
                    void disposable.dispose();
                } catch {
                    // The generation fence is authoritative even if best-effort cleanup fails.
                }
                throw eventError('plugin_events_generation_retired', 'Plugin event invocation generation is no longer current');
            }
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

export function createPluginInvocationHostEventsService(params: Readonly<{
    seed: PluginInvocationServicesSeed;
    broker: StablePluginEventsBroker;
}>): HostEvents {
    return Object.freeze({
        subscribe<Id extends HostEventIdV1>(
            target: HostEventTargetV1<Id>,
            listener: (event: HostEventEnvelopeV1<Id>) => void | Promise<void>,
        ): Disposable {
            if (params.seed.signal.aborted || !params.seed.isGenerationCurrent()) {
                throw eventError('plugin_events_generation_retired', 'Plugin event invocation generation is no longer current');
            }
            if (typeof listener !== 'function') {
                throw eventError('plugin_host_events_invalid_listener', 'Host Event listener must be callable');
            }
            const disposable = params.broker.subscribeHost({
                target,
                ...(params.seed.session ? { currentSessionId: params.seed.session.id } : {}),
                listener: (event) => listener(event as HostEventEnvelopeV1<Id>),
                isCurrent: () => !params.seed.signal.aborted && params.seed.isGenerationCurrent(),
            });
            const abort = () => { void disposable.dispose(); };
            params.seed.signal.addEventListener('abort', abort, { once: true });
            if (params.seed.signal.aborted || !params.seed.isGenerationCurrent()) {
                params.seed.signal.removeEventListener('abort', abort);
                try {
                    void disposable.dispose();
                } catch {
                    // The generation fence is authoritative even if best-effort cleanup fails.
                }
                throw eventError('plugin_events_generation_retired', 'Plugin event invocation generation is no longer current');
            }
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
