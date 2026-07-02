import type {
    PluginEventEmitInputV1,
    PluginEventListenerV1,
    PluginEventsServiceV1,
    SubscriptionV1,
} from '@happier-dev/plugin-sdk';
import {
    isPluginEventLocalIdV1,
    qualifyPluginEventIdV1,
    readHostEventNamespaceV1,
    RuntimeEventV1Schema,
    type EventSelectorV1,
    type EventSourceV1,
    type PluginPermissionCapabilityV1,
    type PluginPermissionDeclarationV1,
    type RuntimeEventV1,
    type TypedEventV1,
} from '@happier-dev/protocol';

import { PluginContextServiceError } from './errors';
import { validatePluginEventPayloadSchema } from './eventPayloadSchema';

type EventSubscriptionSelector = string | EventSelectorV1;

export type PluginEventSubscriberError = Readonly<{
    eventId: string;
    pluginId?: string;
    error: unknown;
}>;

export type PluginEventsBroker = Readonly<{
    emit: (event: TypedEventV1) => Promise<void>;
    subscribe: (
        selector: EventSubscriptionSelector,
        listener: PluginEventListenerV1,
        pluginId?: string,
        options?: PluginEventSubscriptionOptions,
    ) => SubscriptionV1;
}>;

export type CreatePluginEventsBrokerParams = Readonly<{
    onSubscriberError?: (error: PluginEventSubscriberError) => void;
}>;

export type PluginEventDeclaration = Readonly<{
    id: string;
    payloadSchema?: Readonly<Record<string, unknown>>;
}>;

type PluginEventSubscriptionOptions = Readonly<{
    canDeliver?: (event: TypedEventV1) => boolean;
}>;

type EventSubscription = Readonly<{
    selector: EventSubscriptionSelector;
    listener: PluginEventListenerV1;
    pluginId?: string;
    canDeliver?: (event: TypedEventV1) => boolean;
}>;

export type CreatePluginEventsServiceParams = Readonly<{
    pluginId: string;
    declaredEventIds?: readonly string[];
    eventDeclarations?: readonly PluginEventDeclaration[];
    availablePluginIds?: ReadonlySet<string> | readonly string[];
    canSubscribe?: (eventName: string) => boolean;
    broker?: PluginEventsBroker;
    addDisposable?: (disposable: () => void) => unknown;
}>;

const RESERVED_HOST_EVENT_PREFIXES = [
    '@happier/runtime/',
    '@happier/lifecycle/',
    '@happier/session/',
] as const;
type ReservedHostEventPrefix = typeof RESERVED_HOST_EVENT_PREFIXES[number];
const RESERVED_HOST_EVENT_NAMESPACE_PREFIX = '@happier/';

const RESERVED_HOST_EVENT_SUBSCRIBE_PERMISSIONS = Object.freeze({
    '@happier/runtime/': 'events.runtime.subscribe',
    '@happier/lifecycle/': 'events.lifecycle.subscribe',
    '@happier/session/': 'events.session.subscribe',
} satisfies Readonly<Record<ReservedHostEventPrefix, PluginPermissionCapabilityV1>>);

function isReservedHostEventName(eventName: string): boolean {
    return readHostEventNamespaceV1(eventName) !== null;
}

function usesReservedHostNamespace(eventName: string): boolean {
    return eventName.startsWith(RESERVED_HOST_EVENT_NAMESPACE_PREFIX);
}

function normalizeEventName(name: string): string {
    const trimmed = name.trim();
    if (!trimmed) {
        throw new PluginContextServiceError('PLUGIN_EVENTS_INVALID_NAME', 'Plugin event name must be non-empty');
    }
    return trimmed;
}

function normalizeEventInput(input: PluginEventEmitInputV1): Readonly<{ id: string; payload: unknown }> {
    if (!input || typeof input !== 'object') {
        throw new PluginContextServiceError('PLUGIN_EVENTS_INVALID_INPUT', 'Plugin event emit input must be an object');
    }
    return {
        id: normalizeEventName(input.id),
        payload: input.payload,
    };
}

function normalizeSelectorInput(selector: EventSubscriptionSelector): EventSubscriptionSelector {
    if (typeof selector === 'string') {
        return normalizeEventName(selector);
    }
    const ids = selector.ids?.map(normalizeEventName);
    const pluginId = typeof selector.pluginId === 'string' ? selector.pluginId.trim() : undefined;
    const pathPrefix = typeof selector.pathPrefix === 'string' ? selector.pathPrefix.trim() : undefined;
    if (!pluginId && !pathPrefix && (!ids || ids.length === 0)) {
        throw new PluginContextServiceError('PLUGIN_EVENTS_INVALID_SELECTOR', 'Plugin event selector must specify pluginId, pathPrefix, or ids');
    }
    return Object.freeze({
        ...(pluginId ? { pluginId } : {}),
        ...(pathPrefix ? { pathPrefix } : {}),
        ...(ids && ids.length > 0 ? { ids } : {}),
    });
}

function pluginIdFromFullEventId(eventName: string): string | null {
    if (usesReservedHostNamespace(eventName)) {
        return null;
    }
    const separatorIndex = eventName.indexOf('/');
    if (separatorIndex <= 0) {
        return null;
    }
    return eventName.slice(0, separatorIndex);
}

function toReadonlySet(values: ReadonlySet<string> | readonly string[] | undefined): ReadonlySet<string> | null {
    if (!values) {
        return null;
    }
    return values instanceof Set ? values : new Set(values);
}

function assertFinalDirectEventSelectorId(eventName: string): void {
    if (usesReservedHostNamespace(eventName)) {
        if (!isReservedHostEventName(eventName)) {
            throw new PluginContextServiceError(
                'PLUGIN_EVENTS_INVALID_ID',
                `Plugin event '${eventName}' must use slash grammar; dot-style ids are not supported`,
            );
        }
        return;
    }

    const separatorIndex = eventName.indexOf('/');
    if (separatorIndex === -1) {
        if (eventName.includes('.')) {
            throw new PluginContextServiceError(
                'PLUGIN_EVENTS_INVALID_ID',
                `Plugin event '${eventName}' must use slash grammar; dot-style ids are not supported`,
            );
        }
        return;
    }

    if (
        separatorIndex <= 0
        || separatorIndex === eventName.length - 1
        || !isPluginEventLocalIdV1(eventName.slice(separatorIndex + 1))
    ) {
        throw new PluginContextServiceError(
            'PLUGIN_EVENTS_INVALID_ID',
            `Plugin event '${eventName}' must use slash grammar; dot-style ids are not supported`,
        );
    }
}

function assertFinalPathPrefixSelector(prefix: string): void {
    if (usesReservedHostNamespace(prefix)) {
        if (RESERVED_HOST_EVENT_PREFIXES.some((reservedPrefix) => prefix === reservedPrefix)) {
            return;
        }
        assertFinalDirectEventSelectorId(prefix);
        return;
    }

    const separatorIndex = prefix.indexOf('/');
    if (separatorIndex <= 0) {
        throw new PluginContextServiceError(
            'PLUGIN_EVENTS_INVALID_ID',
            `Plugin event '${prefix}' must use slash grammar; dot-style ids are not supported`,
        );
    }
    if (separatorIndex === prefix.length - 1) {
        return;
    }
    const localPrefix = prefix.slice(separatorIndex + 1);
    const normalizedLocalPrefix = localPrefix.endsWith('/')
        ? localPrefix.slice(0, -1)
        : localPrefix;
    if (!normalizedLocalPrefix || !isPluginEventLocalIdV1(normalizedLocalPrefix)) {
        throw new PluginContextServiceError(
            'PLUGIN_EVENTS_INVALID_ID',
            `Plugin event '${prefix}' must use slash grammar; dot-style ids are not supported`,
        );
    }
}

function normalizePluginAuthoredEventId(params: Readonly<{
    pluginId: string;
    eventId: string;
    declaredEventIds: ReadonlySet<string>;
}>): Readonly<{ fullId: string; localId: string }> {
    const eventId = normalizeEventName(params.eventId);
    if (usesReservedHostNamespace(eventId)) {
        throw new PluginContextServiceError(
            'PLUGIN_EVENTS_RESERVED_NAMESPACE',
            `Plugin '${params.pluginId}' cannot emit reserved host event '${eventId}'`,
        );
    }
    const owner = pluginIdFromFullEventId(eventId);
    if (!owner && eventId.includes('.')) {
        throw new PluginContextServiceError(
            'PLUGIN_EVENTS_INVALID_ID',
            `Plugin event '${eventId}' must use slash grammar; dot-style ids are not supported`,
        );
    }
    if (owner && owner !== params.pluginId) {
        throw new PluginContextServiceError(
            'PLUGIN_EVENTS_PREFIX_REQUIRED',
            `Plugin emitted events must resolve under '${params.pluginId}/'`,
        );
    }
    const localId = eventId.startsWith(`${params.pluginId}/`)
        ? eventId.slice(params.pluginId.length + 1)
        : eventId;
    const fullId = qualifyPluginEventIdV1(params.pluginId, localId);
    if (!params.declaredEventIds.has(localId)) {
        throw new PluginContextServiceError(
            'PLUGIN_EVENTS_UNDECLARED_EVENT',
            `Plugin '${params.pluginId}' must declare event '${localId}' before emitting it`,
        );
    }
    return { fullId, localId };
}

function matchesEventSelector(selector: EventSubscriptionSelector, event: TypedEventV1): boolean {
    if (typeof selector === 'string') {
        return selector === event.id;
    }
    if (selector.ids && selector.ids.includes(event.id)) {
        return true;
    }
    if (selector.pathPrefix && event.id.startsWith(selector.pathPrefix)) {
        return true;
    }
    if (selector.pluginId && event.id.startsWith(`${selector.pluginId}/`)) {
        return true;
    }
    return false;
}

function createTypedEvent(params: Readonly<{
    id: string;
    payload: unknown;
    source: EventSourceV1;
}>): TypedEventV1 {
    return Object.freeze({
        id: params.id,
        payload: params.payload,
        envelope: Object.freeze({
            emittedAt: new Date().toISOString(),
            source: params.source,
        }),
    });
}

function normalizeServiceSubscribeSelector(params: Readonly<{
    pluginId: string;
    selector: string | EventSelectorV1;
    declaredEventIds: ReadonlySet<string>;
}>): EventSubscriptionSelector {
    if (typeof params.selector === 'string') {
        const normalizedSelector = normalizeEventName(params.selector);
        if (params.declaredEventIds.has(normalizedSelector)) {
            return qualifyPluginEventIdV1(params.pluginId, normalizedSelector);
        }
        assertFinalDirectEventSelectorId(normalizedSelector);
        return normalizedSelector;
    }
    return normalizeSelectorInput({
        ...params.selector,
        ids: params.selector.ids?.map((id) => (
            params.declaredEventIds.has(id) ? qualifyPluginEventIdV1(params.pluginId, id) : id
        )),
    });
}

function readSubscriptionPermissionTargets(selector: EventSubscriptionSelector): readonly string[] {
    if (typeof selector === 'string') {
        return [selector];
    }
    if (selector.ids && selector.ids.length > 0) {
        return selector.ids;
    }
    if (selector.pathPrefix) {
        return [selector.pathPrefix];
    }
    if (selector.pluginId) {
        return [`${selector.pluginId}/`];
    }
    return [];
}

function readCrossPluginSubscriptionTargets(selector: EventSubscriptionSelector, callerPluginId: string): readonly string[] {
    const targets = typeof selector === 'string'
        ? [selector]
        : [
            ...(selector.ids ?? []),
            ...(selector.pathPrefix ? [selector.pathPrefix] : []),
            ...(selector.pluginId ? [`${selector.pluginId}/`] : []),
        ];
    return Object.freeze(
        Array.from(new Set(targets.flatMap((target) => {
            const targetPluginId = pluginIdFromFullEventId(target);
            return targetPluginId && targetPluginId !== callerPluginId ? [targetPluginId] : [];
        }))),
    );
}

export function canPluginSubscribeToEvent(params: Readonly<{
    pluginId: string;
    eventName: string;
    permissions?: ReadonlySet<PluginPermissionCapabilityV1 | string>;
    permissionDeclarations?: readonly PluginPermissionDeclarationV1[];
}>): boolean {
    if (params.eventName.startsWith(`${params.pluginId}/`)) {
        return true;
    }
    for (const prefix of RESERVED_HOST_EVENT_PREFIXES) {
        if (params.eventName.startsWith(prefix)) {
            const hasPermission = params.permissions?.has(RESERVED_HOST_EVENT_SUBSCRIBE_PERMISSIONS[prefix]) === true;
            return hasPermission && (params.eventName === prefix || isReservedHostEventName(params.eventName));
        }
    }
    if (usesReservedHostNamespace(params.eventName)) {
        return false;
    }
    const targetPluginId = pluginIdFromFullEventId(params.eventName);
    if (!targetPluginId) {
        return false;
    }
    return params.permissionDeclarations?.some((declaration) => (
        declaration.capability === 'events.plugin.subscribe'
        && declaration.scope === targetPluginId
    )) === true;
}

export function createPluginEventsBroker(params?: CreatePluginEventsBrokerParams): PluginEventsBroker {
    const subscriptions = new Set<EventSubscription>();
    let sequence = 0;

    function deliverToSubscription(subscription: EventSubscription, event: TypedEventV1): void {
        if (!matchesEventSelector(subscription.selector, event)) {
            return;
        }
        try {
            if (subscription.canDeliver && !subscription.canDeliver(event)) {
                subscriptions.delete(subscription);
                return;
            }
        } catch (error) {
            subscriptions.delete(subscription);
            params?.onSubscriberError?.({
                eventId: event.id,
                pluginId: subscription.pluginId,
                error,
            });
            return;
        }
        void Promise.resolve()
            .then(() => subscription.listener(event))
            .catch((error: unknown) => {
                params?.onSubscriberError?.({
                    eventId: event.id,
                    pluginId: subscription.pluginId,
                    error,
                });
            });
    }

    return Object.freeze({
        async emit(event: TypedEventV1): Promise<void> {
            const deliveredEvent = Object.freeze({
                ...event,
                envelope: Object.freeze({
                    ...event.envelope,
                    sequence: event.envelope.sequence ?? sequence++,
                }),
            }) satisfies TypedEventV1;
            for (const subscription of subscriptions) {
                deliverToSubscription(subscription, deliveredEvent);
            }
        },
        subscribe(
            selector: EventSubscriptionSelector,
            listener: PluginEventListenerV1,
            pluginId?: string,
            options?: PluginEventSubscriptionOptions,
        ): SubscriptionV1 {
            const subscription = Object.freeze({
                selector: normalizeSelectorInput(selector),
                listener,
                ...(pluginId ? { pluginId } : {}),
                ...(options?.canDeliver ? { canDeliver: options.canDeliver } : {}),
            });
            subscriptions.add(subscription);
            let unsubscribed = false;
            return Object.freeze({
                unsubscribe: () => {
                    if (unsubscribed) {
                        return;
                    }
                    unsubscribed = true;
                    subscriptions.delete(subscription);
                },
            });
        },
    });
}

const DEFAULT_PLUGIN_EVENTS_BROKER = createPluginEventsBroker();

function normalizeDeclaredEventId(id: string): string {
    const eventId = normalizeEventName(id);
    if (!isPluginEventLocalIdV1(eventId)) {
        throw new PluginContextServiceError(
            'PLUGIN_EVENTS_INVALID_ID',
            `Plugin event '${eventId}' must use slash grammar; dot-style ids are not supported`,
        );
    }
    return eventId;
}

function readDeclaredEventState(params: CreatePluginEventsServiceParams): Readonly<{
    ids: ReadonlySet<string>;
    payloadSchemas: ReadonlyMap<string, Readonly<Record<string, unknown>>>;
}> {
    const ids = new Set<string>();
    const payloadSchemas = new Map<string, Readonly<Record<string, unknown>>>();
    for (const id of params.declaredEventIds ?? []) {
        ids.add(normalizeDeclaredEventId(id));
    }
    for (const declaration of params.eventDeclarations ?? []) {
        const localId = normalizeDeclaredEventId(declaration.id);
        ids.add(localId);
        if (declaration.payloadSchema) {
            payloadSchemas.set(localId, declaration.payloadSchema);
        }
    }
    return Object.freeze({
        ids,
        payloadSchemas,
    });
}

export async function publishHostPluginEvent(name: string, payload?: unknown): Promise<void> {
    const eventName = normalizeEventName(name);
    const namespace = readHostEventNamespaceV1(eventName);
    if (!namespace) {
        throw new PluginContextServiceError(
            'PLUGIN_EVENTS_HOST_NAMESPACE_REQUIRED',
            `Host events must use a reserved host event namespace: '${eventName}'`,
        );
    }
    await DEFAULT_PLUGIN_EVENTS_BROKER.emit(createTypedEvent({
        id: eventName,
        payload,
        source: {
            kind: 'host',
            namespace,
        },
    }));
}

export async function publishRuntimePluginEvent(event: RuntimeEventV1): Promise<void> {
    const parsed = RuntimeEventV1Schema.parse(event);
    await publishHostPluginEvent(`@happier/runtime/${parsed.kind}`, parsed);
}

export function createPluginEventsService(params: CreatePluginEventsServiceParams): PluginEventsServiceV1 {
    const broker = params.broker ?? DEFAULT_PLUGIN_EVENTS_BROKER;
    const declaredEventState = readDeclaredEventState(params);
    const declaredEventIds = declaredEventState.ids;
    const availablePluginIds = toReadonlySet(params.availablePluginIds);

    return Object.freeze({
        async emit(input: PluginEventEmitInputV1): Promise<void> {
            const event = normalizeEventInput(input);
            const eventName = normalizePluginAuthoredEventId({
                pluginId: params.pluginId,
                eventId: event.id,
                declaredEventIds,
            });
            const payloadSchema = declaredEventState.payloadSchemas.get(eventName.localId);
            if (payloadSchema) {
                const validation = validatePluginEventPayloadSchema({
                    payloadSchema,
                    payload: event.payload,
                });
                if (!validation.success) {
                    throw new PluginContextServiceError(
                        'PLUGIN_EVENTS_INVALID_PAYLOAD',
                        `Plugin '${params.pluginId}' emitted invalid payload for event '${eventName.localId}': ${validation.message}`,
                    );
                }
            }
            await broker.emit(createTypedEvent({
                id: eventName.fullId,
                payload: event.payload,
                source: {
                    kind: 'plugin',
                    pluginId: params.pluginId,
                },
            }));
        },
        subscribe(selector: string | EventSelectorV1, listener: PluginEventListenerV1): SubscriptionV1 {
            const normalizedSelector = normalizeServiceSubscribeSelector({
                pluginId: params.pluginId,
                selector,
                declaredEventIds,
            });
            if (typeof normalizedSelector !== 'string' && normalizedSelector.ids) {
                for (const id of normalizedSelector.ids) {
                    assertFinalDirectEventSelectorId(id);
                }
            }
            if (typeof normalizedSelector !== 'string' && normalizedSelector.pathPrefix) {
                assertFinalPathPrefixSelector(normalizedSelector.pathPrefix);
            }
            if (availablePluginIds) {
                const missingTarget = readCrossPluginSubscriptionTargets(normalizedSelector, params.pluginId)
                    .find((targetPluginId) => !availablePluginIds.has(targetPluginId));
                if (missingTarget) {
                    throw new PluginContextServiceError(
                        'PLUGIN_EVENTS_TARGET_UNAVAILABLE',
                        `Plugin event subscription target '${missingTarget}' is not installed or unavailable`,
                    );
                }
            }
            const deniedTarget = readSubscriptionPermissionTargets(normalizedSelector)
                .find((target) => params.canSubscribe?.(target) !== true);
            if (deniedTarget) {
                throw new PluginContextServiceError(
                    'PLUGIN_EVENTS_SUBSCRIBE_PERMISSION_DENIED',
                    `Plugin '${params.pluginId}' cannot subscribe to '${deniedTarget}' without a matching event capability`,
                );
            }

            const subscription = broker.subscribe(
                normalizedSelector,
                listener,
                params.pluginId,
                {
                    canDeliver: (event) => params.canSubscribe?.(event.id) === true,
                },
            );
            let unsubscribed = false;
            const scopedSubscription = Object.freeze({
                unsubscribe: () => {
                    if (unsubscribed) {
                        return;
                    }
                    unsubscribed = true;
                    subscription.unsubscribe();
                },
            });
            params.addDisposable?.(() => {
                scopedSubscription.unsubscribe();
            });
            return scopedSubscription;
        },
    });
}
