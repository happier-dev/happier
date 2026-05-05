import type { PluginEventListenerV1, PluginEventsServiceV1, SubscriptionV1 } from '@happier-dev/plugin-sdk';
import type { PluginPermissionCapabilityV1 } from '@happier-dev/protocol';

import { PluginContextServiceError } from './errors';

export type PluginEventsBroker = Readonly<{
    emit: (eventName: string, payload: unknown) => Promise<void>;
    subscribe: (eventName: string, listener: PluginEventListenerV1) => SubscriptionV1;
}>;

export type CreatePluginEventsServiceParams = Readonly<{
    pluginId: string;
    canSubscribe?: (eventName: string) => boolean;
    broker?: PluginEventsBroker;
}>;

const RESERVED_HOST_EVENT_PREFIXES = [
    '@happier/runtime/',
    '@happier/lifecycle/',
    '@happier/session/',
] as const;
type ReservedHostEventPrefix = typeof RESERVED_HOST_EVENT_PREFIXES[number];

const RESERVED_HOST_EVENT_SUBSCRIBE_PERMISSIONS = Object.freeze({
    '@happier/runtime/': 'runtime.subscribe',
    '@happier/lifecycle/': 'lifecycle.subscribe',
    '@happier/session/': 'session.subscribe',
} satisfies Readonly<Record<ReservedHostEventPrefix, PluginPermissionCapabilityV1>>);

function isReservedHostEventName(eventName: string): boolean {
    return RESERVED_HOST_EVENT_PREFIXES.some((prefix) => eventName.startsWith(prefix));
}

function normalizeEventName(name: string): string {
    const trimmed = name.trim();
    if (!trimmed) {
        throw new PluginContextServiceError('PLUGIN_EVENTS_INVALID_NAME', 'Plugin event name must be non-empty');
    }
    return trimmed;
}

export function canPluginSubscribeToEvent(params: Readonly<{
    pluginId: string;
    eventName: string;
    permissions?: ReadonlySet<PluginPermissionCapabilityV1 | string>;
}>): boolean {
    if (params.eventName.startsWith(`${params.pluginId}.`)) {
        return true;
    }
    for (const prefix of RESERVED_HOST_EVENT_PREFIXES) {
        if (params.eventName.startsWith(prefix)) {
            return params.permissions?.has(RESERVED_HOST_EVENT_SUBSCRIBE_PERMISSIONS[prefix]) === true;
        }
    }
    return params.permissions?.has('events.subscribe') === true;
}

export function createPluginEventsBroker(): PluginEventsBroker {
    const listenersByEventName = new Map<string, Set<PluginEventListenerV1>>();

    return Object.freeze({
        async emit(eventName: string, payload: unknown): Promise<void> {
            const listeners = listenersByEventName.get(eventName);
            if (!listeners || listeners.size === 0) {
                return;
            }
            await Promise.all([...listeners].map((listener) => listener(Object.freeze({ name: eventName, payload }))));
        },
        subscribe(name: string, listener: PluginEventListenerV1): SubscriptionV1 {
            const eventName = normalizeEventName(name);
            const listeners = listenersByEventName.get(eventName) ?? new Set<PluginEventListenerV1>();
            listeners.add(listener);
            listenersByEventName.set(eventName, listeners);
            return Object.freeze({
                unsubscribe: () => {
                    listeners.delete(listener);
                    if (listeners.size === 0) {
                        listenersByEventName.delete(eventName);
                    }
                },
            });
        },
    });
}

const DEFAULT_PLUGIN_EVENTS_BROKER = createPluginEventsBroker();

export async function publishHostPluginEvent(name: string, payload?: unknown): Promise<void> {
    const eventName = normalizeEventName(name);
    if (!isReservedHostEventName(eventName)) {
        throw new PluginContextServiceError(
            'PLUGIN_EVENTS_HOST_NAMESPACE_REQUIRED',
            `Host events must use a reserved host event namespace: '${eventName}'`,
        );
    }
    await DEFAULT_PLUGIN_EVENTS_BROKER.emit(eventName, payload);
}

export function createPluginEventsService(params: CreatePluginEventsServiceParams): PluginEventsServiceV1 {
    const broker = params.broker ?? DEFAULT_PLUGIN_EVENTS_BROKER;

    return Object.freeze({
        async emit(name: string, payload?: unknown): Promise<void> {
            const eventName = normalizeEventName(name);
            if (isReservedHostEventName(eventName)) {
                throw new PluginContextServiceError(
                    'PLUGIN_EVENTS_RESERVED_NAMESPACE',
                    `Plugin '${params.pluginId}' cannot emit reserved host event '${eventName}'`,
                );
            }
            if (!eventName.startsWith(`${params.pluginId}.`)) {
                throw new PluginContextServiceError(
                    'PLUGIN_EVENTS_PREFIX_REQUIRED',
                    `Plugin emitted events must be prefixed with '${params.pluginId}.'`,
                );
            }

            await broker.emit(eventName, payload);
        },
        subscribe(name: string, listener: PluginEventListenerV1): SubscriptionV1 {
            const eventName = normalizeEventName(name);
            if (params.canSubscribe?.(eventName) !== true) {
                throw new PluginContextServiceError(
                    'PLUGIN_EVENTS_SUBSCRIBE_PERMISSION_DENIED',
                    `Plugin '${params.pluginId}' cannot subscribe to '${eventName}' without a matching event capability`,
                );
            }

            return broker.subscribe(eventName, listener);
        },
    });
}
