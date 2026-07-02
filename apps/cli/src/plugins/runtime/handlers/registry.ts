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
    PluginHookHandler,
    ResolvedPluginHookHandler,
    ResolvedPluginLifecycleHandler,
} from '../types';

export type ActivatedHandlerRegistry = Readonly<{
    actionHandlersByActionId: ReadonlyMap<string, PluginActionHandler>;
    hookHandlersByHookId: ReadonlyMap<string, readonly ResolvedPluginHookHandler[]>;
    lifecycleHandlersByEvent: ReadonlyMap<string, readonly ResolvedPluginLifecycleHandler[]>;
}>;

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

export function createActivatedHandlerRegistry(params: Readonly<{
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
    }>[];
}>): ActivatedHandlerRegistry {
    const actionHandlersByActionId = new Map<string, PluginActionHandler>();
    const hookHandlersMutable = new Map<string, ResolvedPluginHookHandler[]>();
    const lifecycleHandlersMutable = new Map<string, ResolvedPluginLifecycleHandler[]>();
    let hookRegistrationIndex = 0;

    for (const entry of params.entries) {
        for (const registration of entry.actions) {
            actionHandlersByActionId.set(registration.id, registration.handler);
        }
        for (const registration of entry.tools) {
            actionHandlersByActionId.set(registration.id, registration.handler);
        }
        for (const registration of entry.commands) {
            actionHandlersByActionId.set(registration.actionId ?? registration.id, registration.handler);
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
                handler: registration.handler,
            };
            const existing = hookHandlersMutable.get(registration.hookId);
            if (existing) {
                existing.push(resolved);
            } else {
                hookHandlersMutable.set(registration.hookId, [resolved]);
            }
        }

        for (const [index, registration] of entry.lifecycleHandlers.entries()) {
            const registrationId = registration.id?.trim().length
                ? registration.id.trim()
                : `${entry.pluginId}:${registration.event}:${index}`;
            const resolved: ResolvedPluginLifecycleHandler = {
                pluginId: entry.pluginId,
                lifecycleEvent: registration.event,
                registrationId,
                priority: registration.priority ?? 0,
                manifestPath: entry.manifestPath,
                manifestDigest: entry.manifestDigest,
                daemonEntryPath: entry.daemonEntryPath,
                sourceKind: entry.source.kind,
                handler: registration.handler,
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
                right.priority - left.priority
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
