import { join } from 'node:path';
import axios from '@/api/client/credentialAxios';
import type { Disposable } from '@happier-dev/plugin-sdk';
import type { AgentExternalSessionSource, AgentExternalSessionsReadAccountingResult, AgentExternalSessionsResult } from '@happier-dev/plugin-sdk/sessions/external';
import { UsageSourceDeleteResultV1Schema } from '@happier-dev/protocol/usage/usageSources';
import type { UsageSourceDateRangeV1 } from '@happier-dev/protocol/usage/usageSources';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { fetchAccountProfile } from '@/api/accountProfile';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { acquireAuthoritativePluginRuntimeRegistryLease, tryAcquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { readRegistryCatalogHook } from '@/agent/catalog/runtimeEntry';
import { configuredExternalSessionSourceSettingsKeys, getActiveAccountSettingsSnapshot, subscribeActiveAccountSettingsKeys } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { configuredExternalSessionSourcesUseConnectedProfiles } from '@/session/external/configuredSourceMaterializer';
import { expandHomeDirPath } from '@/utils/path/expandHomeDirPath';
import type { DeviceLocalSecretStorage } from '@/daemon/deviceLocalSecretStorage';
import type { ExecutionBudgetRegistry } from '@/daemon/executionBudget/ExecutionBudgetRegistry';
import type { StoredCredentials } from '@/persistence';
import type { createExternalSessionObservationDaemonProjection } from '@/api/session/external/leases/createExternalSessionObservationDaemonProjection';
import { createUsageObservationPublisher } from '../createUsageObservationPublisher';
import { createNativeUsageCaptureStore, type NativeUsageCaptureAuthority, type NativeUsageCaptureSource } from './nativeUsageCaptureState';
import { createNativeUsageCollector } from './nativeUsageCollector';
import { discoverNativeUsageSourceMetadata, resolveNativeUsageSourceMetadata, type NativeUsageSourceBoundary } from './nativeUsageSourceDiscovery';
import { logger } from '@/ui/logger';
import { createNativeUsageProjectResolver } from './nativeUsageProjectResolver';

export type NativeUsageDaemonRuntimeInput = Readonly<{
    authority: NativeUsageCaptureAuthority;
    installationId: string;
    activeServerDir: string;
    serverHttpBaseUrl: string;
    token: string;
    storage: DeviceLocalSecretStorage;
    budgetRegistry: ExecutionBudgetRegistry;
    /** Capture Account Project key material once for this Machine lifetime. */
    readCredentials(): Promise<StoredCredentials | null>;
    observation: Pick<ReturnType<typeof createExternalSessionObservationDaemonProjection>, 'registerAccountingSource'>;
    invalidateSources?(): void;
}>;

/** Reads only the canonical source already admitted by durable capture custody. */
export async function readNativeUsageAccountingAtAdmission(input: Parameters<typeof resolveNativeUsageSourceMetadata>[0] & Readonly<{
    admittedSourceKey: string;
    cursor?: string;
    changedNativeSessionIds?: readonly string[];
}>): Promise<AgentExternalSessionsResult<AgentExternalSessionsReadAccountingResult>> {
    const admitted = await resolveNativeUsageSourceMetadata({ ...input, includeAccountingSource: false });
    if (!admitted) return { ok: false, code: 'unavailable' };
    return await input.boundary.externalSessions.readAccounting({ source: admitted.descriptor.source, cursor: input.cursor,
        ...(input.changedNativeSessionIds === undefined ? {} : { changedNativeSessionIds: input.changedNativeSessionIds }), signal: input.signal });
}

/** Captures one authenticated Machine lifetime; finite reads keep their admitted input. */
export function createNativeUsageDaemonRuntime(input: NativeUsageDaemonRuntimeInput) {
    const lifetime = new AbortController();
    let discovered = false;
    let sourceSettingsKeys: readonly string[] = [];
    // Capture private Account material once for Project reads. Every HTTP call
    // uses this Machine lifetime's bearer; the server owns token revocation.
    const capturedCredentials = input.readCredentials().then(value => value && readAccountIdFromToken(value.token) === input.authority.accountId
        ? { ...value, token: input.token } : null).catch(() => null);
    const acquireBoundary = async (agent: NativeUsageCaptureSource['agent']) => {
        const lease = tryAcquireAuthoritativePluginRuntimeRegistryLease();
        if (!lease) return null;
        try {
            const agents = lease.registry.contributes.agents;
            // Restored consent resumes through this boundary without a discovery request.
            sourceSettingsKeys = configuredExternalSessionSourceSettingsKeys(agents.flatMap(agent =>
                agent.richDefinition?.definition.surfaces?.externalSession.sources ?? []));
            const selected = agents.find(candidate => candidate.identity?.pluginId === agent.pluginId && candidate.identity.localId === agent.localId);
            if (!selected) return null;
            const catalogEntry = await readRegistryCatalogHook(lease.registry, selected.id, entry => entry);
            const runtime = lease.registry.agentRuntimesByAgentId.get(selected.id);
            if (!runtime?.externalSessions || !runtime.isCurrent() || runtime.retirementSignal.aborted) return null;
            const boundary: NativeUsageSourceBoundary = {
                catalogEntry,
                externalSessions: runtime.externalSessions, occurrenceId: runtime.occurrenceId,
                retirementSignal: runtime.retirementSignal, isCurrent: runtime.isCurrent,
            };
            return { agents, agentId: selected.id, boundary };
        } finally { await lease.release(); }
    };
    const metadata = async (source: NativeUsageCaptureSource, signal: AbortSignal, admittedSourceKey?: string) => {
        if (signal.aborted || lifetime.signal.aborted) return null;
        const acquired = await acquireBoundary(source.agent);
        if (!acquired) return null;
        const resolved = await resolveNativeUsageSourceMetadata({ ...acquired, source: source.source,
            activeServerDir: input.activeServerDir, signal, ...(admittedSourceKey ? { admittedSourceKey } : {}) });
        return resolved ? { ...acquired, ...resolved } : null;
    };
    const publisher = createUsageObservationPublisher({ token: input.token, apiServerUrl: input.serverHttpBaseUrl,
        emitLegacyUsageReport: () => false });
    const custodyKey = input.storage.deriveOpaqueIdentity({ purpose: 'usage_accounting_identity',
        value: JSON.stringify(['capture', input.authority.serverId, input.authority.accountId, input.authority.machineId]) });
    const collector = createNativeUsageCollector({
        authority: input.authority, storage: input.storage, budgetRegistry: input.budgetRegistry,
        onSourceSettled: () => {
            if (!lifetime.signal.aborted) input.invalidateSources?.();
        },
        resolveProject: createNativeUsageProjectResolver({ authority: input.authority, storage: input.storage,
            serverHttpBaseUrl: input.serverHttpBaseUrl, readCredentials: async () => await capturedCredentials }),
        store: createNativeUsageCaptureStore({ authority: input.authority, storage: input.storage,
            path: join(input.activeServerDir, 'usage', `${custodyKey}.sealed`) }),
        discoverSources: async () => {
            lifetime.signal.throwIfAborted();
            const lease = await acquireAuthoritativePluginRuntimeRegistryLease();
            let agents: typeof lease.registry.contributes.agents;
            try { agents = lease.registry.contributes.agents; } finally { await lease.release(); }
            sourceSettingsKeys = configuredExternalSessionSourceSettingsKeys(agents.flatMap(agent =>
                agent.richDefinition?.definition.surfaces?.externalSession.sources ?? []));
            const account = configuredExternalSessionSourcesUseConnectedProfiles(agents)
                ? await fetchAccountProfile({ token: input.token, signal: lifetime.signal })
                : { connectedServicesV2: [] };
            return await discoverNativeUsageSourceMetadata({ agents, account,
                agentSettings: getActiveAccountSettingsSnapshot()?.settings,
                activeServerId: input.authority.serverId, activeServerDir: input.activeServerDir,
                signal: lifetime.signal,
                resolveBoundary: async agentId => {
                    const agent = agents.find(candidate => candidate.id === agentId)?.identity;
                    return agent ? (await acquireBoundary(agent))?.boundary ?? null : null;
                },
            });
        },
        resolveRoot: async (source, root) => {
            const current = await metadata(source, lifetime.signal);
            if (!current) throw new Error('usage_source_unavailable');
            const field = current.metadata.accountingSource?.rootField;
            if (!field) throw new Error('usage_source_root_override_unsupported');
            const updated: Record<string, AgentExternalSessionSource[string]> = { ...source.source };
            if (root === null) delete updated[field];
            else updated[field] = expandHomeDirPath(root);
            const resolved = await resolveNativeUsageSourceMetadata({ ...current, source: { ...updated, kind: source.source.kind },
                activeServerDir: input.activeServerDir, signal: lifetime.signal });
            if (!resolved) throw new Error('usage_source_root_invalid');
            return { ...resolved.descriptor, rootKind: root === null ? 'default' as const : 'override' as const };
        },
        readAccounting: async (source, signal, changedNativeSessionIds) => {
            if (signal.aborted || lifetime.signal.aborted) return { ok: false, code: 'unavailable' };
            const acquired = await acquireBoundary(source.agent);
            if (!acquired) return { ok: false, code: 'unavailable' };
            return await readNativeUsageAccountingAtAdmission({ ...acquired, source: source.source, cursor: source.cursor,
                ...(changedNativeSessionIds === undefined ? {} : { changedNativeSessionIds }),
                admittedSourceKey: source.sourceKey, activeServerDir: input.activeServerDir,
                signal: AbortSignal.any([signal, lifetime.signal]) });
        },
        subscribeSource: async (source, onChange, signal) => {
            let demand: Disposable | null = null;
            let disposed = false;
            let refreshDemand: Promise<void> | null = null;
            let refreshRequested = false;
            const bind = async () => {
                const resolved = await metadata(source, signal, source.sourceKey);
                const observation = resolved?.metadata.accountingSource;
                if (!resolved || !observation) throw new Error('usage_source_observation_unavailable');
                if (disposed || signal.aborted || lifetime.signal.aborted) return;
                if (!resolved.boundary.isCurrent() || resolved.boundary.retirementSignal.aborted) throw new Error('usage_source_observation_unavailable');
                const next = await input.observation.registerAccountingSource({
                    resource: { pluginId: source.agent.pluginId, agentLocalId: source.agent.localId,
                        occurrenceId: resolved.boundary.occurrenceId, resourceKey: observation.resourceKey,
                        retirementSignal: AbortSignal.any([signal, lifetime.signal, resolved.boundary.retirementSignal]) },
                    source: resolved.descriptor.source, changeObservation: observation.changeObservation,
                    ...(observation.watchFileChanges ? { watchFileChanges: observation.watchFileChanges } : {}),
                    onChange: ({ reason, changedNativeSessionIds }) => {
                        if (disposed || signal.aborted || lifetime.signal.aborted) return;
                        onChange(changedNativeSessionIds);
                        if (reason !== 'topology_changed') return;
                        refresh();
                    },
                });
                if (disposed || signal.aborted || lifetime.signal.aborted) { await next.dispose(); return; }
                const previous = demand;
                demand = next;
                await previous?.dispose();
                return resolved.boundary.retirementSignal;
            };
            const refresh = () => {
                refreshRequested = true;
                if (refreshDemand) return;
                // Topology changes refresh this observation; the collector owns plugin retirement.
                refreshDemand = (async () => {
                    while (refreshRequested && !disposed && !signal.aborted && !lifetime.signal.aborted) {
                        refreshRequested = false;
                        await bind();
                    }
                })().finally(() => {
                    refreshDemand = null;
                });
                void refreshDemand.catch(error => logger.warn('[USAGE] Accounting observation refresh failed', {
                    code: error instanceof Error ? error.name : 'usage_source_failed',
                }));
            };
            const retirementSignal = await bind();
            return {
                retirementSignal,
                async dispose() { disposed = true; await refreshDemand?.catch(() => {}); await demand?.dispose(); },
            };
        },
        publisher: { publish: async observation => !lifetime.signal.aborted
            ? await publisher.publish(observation) : { status: 'failed' } },
        deleteHistory: async (source, dateRange) => {
            lifetime.signal.throwIfAborted();
            const response = await axios.post(`${input.serverHttpBaseUrl}/v2/usage-events/delete-native-history`, {
                machineId: input.authority.machineId, sourceRootKey: source.sourceId,
                ...(dateRange ? { dateRange } : {}),
            }, { headers: { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), Authorization: `Bearer ${input.token}` },
                signal: lifetime.signal });
            return UsageSourceDeleteResultV1Schema.parse(response.data);
        },
    });
    const initialized = collector.initialize();
    const report = (error: unknown) => logger.warn('[USAGE] Native accounting source update failed', {
        code: error instanceof Error ? error.name : 'usage_source_failed',
    });
    void initialized.catch(report);
    const refresh = () => {
        void initialized.then(async () => {
            if (lifetime.signal.aborted) return;
            const sources = await collector.get();
            if (discovered || sources.some(source => source.consent === 'enabled')) await collector.discover();
        }).catch(report);
    };
    const unsubscribeRegistry = pluginReloadController.subscribe(refresh);
    const unsubscribeSettings = subscribeActiveAccountSettingsKeys(() => ({ settings: sourceSettingsKeys }), refresh);
    return {
        owner: { serverId: input.authority.serverId, machineId: input.authority.machineId,
            installationId: input.installationId, custodianAccountId: input.authority.accountId,
            service: {
                async discover(signal?: AbortSignal) { await initialized; discovered = true; return await collector.discover(signal); },
                async get(sourceId?: string, signal?: AbortSignal) { await initialized; return await collector.get(sourceId, signal); },
                async setConsent(sourceId: string, enabled: boolean, signal?: AbortSignal) { await initialized; return await collector.setConsent(sourceId, enabled, signal); },
                async stop(sourceId: string, signal?: AbortSignal) { await initialized; return await collector.stop(sourceId, signal); },
                async setRoot(sourceId: string, root: string | null, signal?: AbortSignal) { await initialized; return await collector.setRoot(sourceId, root, signal); },
                async deleteHistory(sourceId: string, range?: UsageSourceDateRangeV1, signal?: AbortSignal) { await initialized; return await collector.deleteHistory(sourceId, range, signal); },
            } },
        async flushPending() { await initialized; await collector.flushPending(); },
        async dispose() { lifetime.abort(); unsubscribeRegistry(); unsubscribeSettings(); await initialized.catch(() => {}); await collector.dispose(); },
    };
}
