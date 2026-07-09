import type { PluginHookIdV1 } from '@happier-dev/protocol';
import type { PluginHandlerServicesV1 } from '@happier-dev/plugin-sdk';
import type {
    ResolvedContributionProvenance,
    ResolvedContributionSource,
    ResolvedHookRegistration,
} from '@/plugins/projection/registry/types';

import type {
    PluginApiActionRegistration,
    PluginApiCommandRegistration,
    PluginApiHookRegistration,
    PluginApiLifecycleHandlerRegistration,
    PluginApiToolRegistration,
} from '../api/types';
import type {
    PluginActionHandler,
    PluginRuntimeHookHandler,
    PluginSdkActionHandler,
    ResolvedPluginHookHandler,
    ResolvedPluginLifecycleHandler,
} from '../types';

export type ActivatedHandlerRegistry = Readonly<{
    actionHandlersByActionId: ReadonlyMap<string, PluginActionHandler>;
    hookHandlersByHookId: ReadonlyMap<string, readonly ResolvedPluginHookHandler[]>;
    lifecycleHandlersByEvent: ReadonlyMap<string, readonly ResolvedPluginLifecycleHandler[]>;
}>;

type HandlerRegistryLifetime = Readonly<{
    isHandlerActive?: () => boolean;
    isLifecycleHandlerActive?: () => boolean;
}>;

function assertHandlerActive(
    lifetime: HandlerRegistryLifetime,
    pluginId: string,
    kind: 'action' | 'hook' | 'lifecycle',
): void {
    const isActive = kind === 'lifecycle'
        ? lifetime.isLifecycleHandlerActive ?? lifetime.isHandlerActive
        : lifetime.isHandlerActive;
    if (isActive && !isActive()) {
        throw new Error(`Plugin '${pluginId}' ${kind} handler is no longer active`);
    }
}

function createActionHandler(
    lifetime: HandlerRegistryLifetime,
    pluginId: string,
    registration: PluginApiActionRegistration | PluginApiToolRegistration | PluginApiCommandRegistration,
    handlerServices?: PluginHandlerServicesV1,
): PluginActionHandler {
    return async (request) => {
        assertHandlerActive(lifetime, pluginId, 'action');
        const handler = registration.handler as PluginSdkActionHandler;
        if (!handlerServices) {
            return await handler(request as Parameters<PluginSdkActionHandler>[0]);
        }
        return await handler({
            ...request,
            context: {
                ...request.context,
                ...handlerServices,
            },
        });
    };
}

function createSyntheticHookRegistration(params: Readonly<{
    pluginId: string;
    provenance: ResolvedContributionProvenance;
    source: ResolvedContributionSource;
    manifestPath: string;
    manifestDigest: string;
    daemonEntryPath: string;
    registration: PluginApiHookRegistration;
}>): ResolvedHookRegistration {
    return {
        provenance: params.provenance,
        source: params.source,
        pluginId: params.pluginId,
        manifestPath: params.manifestPath,
        manifestDigest: params.manifestDigest,
        daemonEntryPath: params.daemonEntryPath,
        sourceSpec: {
            kind: 'path',
            locator: params.manifestPath,
            trustPolicy: 'local_trusted',
            installPolicy: 'link',
        },
        definition: {
            hookApiVersion: 1,
            id: params.registration.hookId,
            category: params.registration.category ?? 'lifecycle',
            scope: params.registration.scope ?? 'session',
            ...(params.registration.filters ? { filters: params.registration.filters } : {}),
            executionKind: params.registration.executionKind ?? 'observe',
            priority: params.registration.priority,
            handler: {
                target: 'plugin',
            },
        },
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readHookEventPayload(event: unknown): unknown {
    return isRecord(event) && Object.prototype.hasOwnProperty.call(event, 'payload')
        ? event.payload
        : event;
}

type ErasedActivationHookHandler = (
    payload: unknown,
    context: Readonly<{ hookId: PluginHookIdV1 }>,
) => unknown | Promise<unknown>;

function createRuntimeHookHandler(
    lifetime: HandlerRegistryLifetime,
    pluginId: string,
    registration: PluginApiHookRegistration,
    handlerServices?: PluginHandlerServicesV1,
): PluginRuntimeHookHandler {
    return async (event, context) => {
        assertHandlerActive(lifetime, pluginId, 'hook');
        const payload = readHookEventPayload(event);
        // Hook events are validated by hook id before dispatch; this erases the SDK-specific handler at the dispatch boundary.
        const handler = registration.handler as ErasedActivationHookHandler;
        const contextRecord = isRecord(context) ? context : {};
        return await handler(payload, {
            ...contextRecord,
            ...(handlerServices ?? {}),
            hookId: registration.hookId,
        });
    };
}

function createLifecycleHandler(
    lifetime: HandlerRegistryLifetime,
    pluginId: string,
    registration: PluginApiLifecycleHandlerRegistration,
): ResolvedPluginLifecycleHandler['handler'] {
    return async (...args) => {
        assertHandlerActive(lifetime, pluginId, 'lifecycle');
        return await registration.handler(...args);
    };
}

export function createActivatedHandlerRegistry(params: Readonly<{
    lifetime?: HandlerRegistryLifetime;
    entries: readonly Readonly<{
        pluginId: string;
        provenance: ResolvedContributionProvenance;
        source: ResolvedContributionSource;
        manifestPath: string;
        manifestDigest: string;
        daemonEntryPath: string;
        actions: readonly PluginApiActionRegistration[];
        tools: readonly PluginApiToolRegistration[];
        commands: readonly PluginApiCommandRegistration[];
        hooks: readonly PluginApiHookRegistration[];
        lifecycleHandlers: readonly PluginApiLifecycleHandlerRegistration[];
        handlerServices?: PluginHandlerServicesV1;
    }>[];
}>): ActivatedHandlerRegistry {
    const actionHandlersByActionId = new Map<string, PluginActionHandler>();
    const hookHandlersMutable = new Map<string, ResolvedPluginHookHandler[]>();
    const lifecycleHandlersMutable = new Map<string, ResolvedPluginLifecycleHandler[]>();
    const lifetime = params.lifetime ?? {};
    let hookRegistrationIndex = 0;

    for (const entry of params.entries) {
        for (const registration of entry.actions) {
            actionHandlersByActionId.set(registration.id, createActionHandler(lifetime, entry.pluginId, registration, entry.handlerServices));
        }
        for (const registration of entry.tools) {
            actionHandlersByActionId.set(registration.id, createActionHandler(lifetime, entry.pluginId, registration, entry.handlerServices));
        }
        for (const registration of entry.commands) {
            actionHandlersByActionId.set(registration.id, createActionHandler(lifetime, entry.pluginId, registration, entry.handlerServices));
        }

        for (const registration of entry.hooks) {
            const registrationIndex = hookRegistrationIndex++;
            const resolved: ResolvedPluginHookHandler = {
                pluginId: entry.pluginId,
                hookId: registration.hookId,
                priority: registration.priority ?? 0,
                registrationIndex,
                manifestPath: entry.manifestPath,
                manifestDigest: entry.manifestDigest,
                daemonEntryPath: entry.daemonEntryPath,
                exportName: '<activation>',
                registration: createSyntheticHookRegistration({
                    pluginId: entry.pluginId,
                    provenance: entry.provenance,
                    source: entry.source,
                    manifestPath: entry.manifestPath,
                    manifestDigest: entry.manifestDigest,
                    daemonEntryPath: entry.daemonEntryPath,
                    registration,
                }),
                handler: createRuntimeHookHandler(lifetime, entry.pluginId, registration, entry.handlerServices),
            };
            const existing = hookHandlersMutable.get(registration.hookId);
            if (existing) {
                existing.push(resolved);
            } else {
                hookHandlersMutable.set(registration.hookId, [resolved]);
            }
        }

        for (const registration of entry.lifecycleHandlers) {
            const registrationId = registration.id?.trim().length
                ? registration.id.trim()
                : null;
            if (registrationId === null) {
                throw new Error(`Plugin '${entry.pluginId}' lifecycle handler for event '${registration.event}' must declare a stable lifecycle handler id`);
            }
            const resolved: ResolvedPluginLifecycleHandler = {
                pluginId: entry.pluginId,
                lifecycleEvent: registration.event,
                registrationId,
                priority: registration.priority ?? 0,
                manifestPath: entry.manifestPath,
                manifestDigest: entry.manifestDigest,
                daemonEntryPath: entry.daemonEntryPath,
                sourceKind: entry.source.kind,
                handler: createLifecycleHandler(lifetime, entry.pluginId, registration),
            };
            const existing = lifecycleHandlersMutable.get(registration.event);
            if (existing) {
                existing.push(resolved);
            } else {
                lifecycleHandlersMutable.set(registration.event, [resolved]);
            }
        }

    }

    const hookHandlersByHookId = new Map<string, readonly ResolvedPluginHookHandler[]>();
    for (const [hookId, handlers] of hookHandlersMutable.entries()) {
        hookHandlersByHookId.set(
            hookId,
            Object.freeze([...handlers].sort((left, right) => (
                left.priority - right.priority
                || left.pluginId.localeCompare(right.pluginId)
                || left.registrationIndex - right.registrationIndex
            ))),
        );
    }

    const lifecycleHandlersByEvent = new Map<string, readonly ResolvedPluginLifecycleHandler[]>();
    for (const [event, handlers] of lifecycleHandlersMutable.entries()) {
        lifecycleHandlersByEvent.set(
            event,
            Object.freeze([...handlers].sort((left, right) => right.priority - left.priority || left.pluginId.localeCompare(right.pluginId))),
        );
    }

    return {
        actionHandlersByActionId,
        hookHandlersByHookId,
        lifecycleHandlersByEvent,
    };
}
