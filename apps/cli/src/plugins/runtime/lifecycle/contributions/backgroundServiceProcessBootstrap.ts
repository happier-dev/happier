import { loadAdmittedPluginProcessRegistrations as loadAdmittedPlugins } from '../activation/admittedProcessPlugins';
import type { BackgroundServiceContext, BackgroundServiceRunner } from '@happier-dev/plugin-sdk/background-services';
import type { JsonValue } from '@happier-dev/protocol';

import { resolveAgentContributionQualifiedId } from '@/plugins/projection/registry/agentRoutingIdentity';
import type { AdmittedBackgroundServicePlugin } from './backgroundServiceProcessSource';
import { createBackgroundServiceProcessServices, type PreparedBackgroundServiceProcessOperationServices } from './backgroundServiceProcessServices';
import type { CreateAgentInvocationServices } from '../../invocation/services/types';


export type BackgroundServiceProcessBootstrap = Readonly<{
    entry: 'plugin';
    payload: Readonly<{
        pluginId: string;
        localId: string;
        generation: number;
        plugins: readonly AdmittedBackgroundServicePlugin[];
    }>;
}> | Readonly<{
    entry: 'host';
    entryId: 'memory-indexer';
    payload: JsonValue;
    plugins?: readonly AdmittedBackgroundServicePlugin[];
}>;

export type HostBackgroundServiceProcessContext = Readonly<{
    signal: AbortSignal;
    services: Readonly<Record<string, unknown>>;
    agentRuntimesByAgentId?: ReadonlyMap<string, Pick<
        import('./targetAgents').AgentRuntimeRegistrationLease,
        'pluginId' | 'pluginVersion' | 'agentId' | 'localAgentId' | 'occurrenceId' | 'sourceCustody' | 'externalSessions' | 'isCurrent' | 'retirementSignal'
    >>;
}>;

export type BackgroundServiceProcessHostEntryLoader = (
    entryId: 'memory-indexer',
) => Promise<Readonly<{
    run(context: HostBackgroundServiceProcessContext, payload: JsonValue): Promise<void>;
}>>;

export type BackgroundServiceProcessPluginHost = Readonly<{
    prepareAgentInvocationServices(
        input: BackgroundServiceProcessAgentInvocationRequest,
    ): Promise<PreparedBackgroundServiceProcessOperationServices>;
}>;

export type BackgroundServiceProcessAgentInvocationRequest = Pick<
    Parameters<CreateAgentInvocationServices>[0],
    'pluginId' | 'pluginVersion' | 'agentId' | 'occurrenceId' | 'correlationId' | 'cwd' | 'providerBindingActive' | 'signal'
>;


/** Child-side execution consumes inherited admission and performs no store/publication lifecycle. */
export async function resolveBackgroundServiceProcessBootstrap(
    bootstrap: BackgroundServiceProcessBootstrap,
    options: Readonly<{ loadHostEntry?: BackgroundServiceProcessHostEntryLoader }> = {},
): Promise<Readonly<{
    run(context: BackgroundServiceContext | HostBackgroundServiceProcessContext): Promise<void>;
    dispose(): Promise<void>;
}>> {
    const plugins = bootstrap.entry === 'plugin' ? bootstrap.payload.plugins : bootstrap.plugins ?? [];
    let currentContext: BackgroundServiceContext | HostBackgroundServiceProcessContext | undefined;
    const localAgentServices = new Set<ReturnType<typeof createBackgroundServiceProcessServices>>();
    const createAgentInvocationServices: CreateAgentInvocationServices = async (input) => {
        const context = currentContext;
        if (!context || context.signal.aborted
            || !plugins.some(({ target, occurrenceId }) => target.pluginId === input.pluginId && occurrenceId === input.occurrenceId)) {
            throw new Error('background_service_process_agent_context_unavailable');
        }
        const host = Reflect.get(context.services, '__backgroundServiceProcessPlugins') as BackgroundServiceProcessPluginHost | undefined;
        if (!host) throw new Error('background_service_process_agent_services_unavailable');
        const signal = AbortSignal.any([context.signal, input.signal]);
        const prepared = await host.prepareAgentInvocationServices({
            pluginId: input.pluginId, pluginVersion: input.pluginVersion,
            agentId: input.agentId, occurrenceId: input.occurrenceId,
            correlationId: input.correlationId, cwd: input.cwd,
            providerBindingActive: input.providerBindingActive,
            signal,
        });
        let local: ReturnType<typeof createBackgroundServiceProcessServices>;
        try {
            signal.throwIfAborted();
            const admittedAgent = registry?.agentRuntimesByAgentId.get(input.agentId);
            if (!admittedAgent || admittedAgent.pluginId !== input.pluginId || admittedAgent.occurrenceId !== input.occurrenceId) {
                throw new Error('background_service_process_agent_context_unavailable');
            }
            local = createBackgroundServiceProcessServices({
                metadata: {
                    plugin: { id: input.pluginId, version: input.pluginVersion },
                    contribution: {
                        id: admittedAgent.localAgentId,
                        qualifiedId: resolveAgentContributionQualifiedId({ pluginId: input.pluginId, localId: admittedAgent.localAgentId }),
                    },
                },
                signal,
                localPolicy: prepared.localPolicy,
                clientServices: prepared.services,
            });
        } catch (error) {
            if (!context.signal.aborted) await prepared.dispose();
            throw error;
        }
        let disposal: Promise<void> | undefined;
        const owned = { services: local.services, dispose: () => {
            disposal ??= (async () => {
                signal.removeEventListener('abort', onAbort);
                await local.dispose();
                // Run cancellation already closes the whole bridge and releases its scopes.
                if (!context.signal.aborted) await prepared.dispose();
                localAgentServices.delete(owned);
            })();
            return disposal;
        } };
        const onAbort = () => { void owned.dispose().catch(() => {}); };
        localAgentServices.add(owned);
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) { await owned.dispose(); signal.throwIfAborted(); }
        return local.services;
    };
    const run = async (
        context: BackgroundServiceContext | HostBackgroundServiceProcessContext,
        operation: () => Promise<void>,
    ) => {
        currentContext = context;
        try { await operation(); }
        finally {
            currentContext = undefined;
            await Promise.all([...localAgentServices].map((services) => services.dispose()));
            localAgentServices.clear();
        }
    };
    const registry = plugins.length > 0
        ? await loadAdmittedPlugins(plugins, bootstrap.entry === 'plugin' ? bootstrap.payload.generation : 0, createAgentInvocationServices)
        : null;
    const readers: HostBackgroundServiceProcessContext['agentRuntimesByAgentId'] = registry
        ? new Map([...registry.agentRuntimesByAgentId].map(([id, lease]) => [id, Object.freeze({
            pluginId: lease.pluginId, pluginVersion: lease.pluginVersion,
            agentId: lease.agentId, localAgentId: lease.localAgentId,
            occurrenceId: lease.occurrenceId, sourceCustody: lease.sourceCustody,
            externalSessions: lease.externalSessions, isCurrent: lease.isCurrent,
            retirementSignal: lease.retirementSignal,
        })]))
        : undefined;
    if (bootstrap.entry === 'plugin') {
        const selected = registry?.targetRegistrations.find(({ pluginId, registration }) => (
            pluginId === bootstrap.payload.pluginId
            && registration.family === 'backgroundServices'
            && registration.localId === bootstrap.payload.localId
        ));
        if (!selected || selected.registration.family !== 'backgroundServices') {
            await registry?.dispose();
            throw new Error('background_service_process_runner_unavailable');
        }
        const runner: BackgroundServiceRunner = selected.registration.value;
        return {
            run: async (context) => {
                if (!('plugin' in context)) throw new Error('background_service_process_plugin_context_unavailable');
                await run(context, () => runner(context));
            },
            dispose: async () => { await registry?.dispose(); },
        };
    }
    try {
        if (!options.loadHostEntry) throw new Error('background_service_process_host_entry_unavailable');
        const entry = await options.loadHostEntry(bootstrap.entryId);
        return {
            run: async (context) => await run(context, () => entry.run({
                signal: context.signal,
                services: Object.fromEntries(Object.entries(context.services)),
                ...(readers ? { agentRuntimesByAgentId: readers } : {}),
            }, bootstrap.payload)),
            dispose: async () => { await registry?.dispose(); },
        };
    } catch (error) {
        await registry?.dispose();
        throw error;
    }
}
