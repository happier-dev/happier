import { getAgentCore, getAgentModelConfig, getAgentStaticModels } from '@happier-dev/agents';
import { buildBackendTargetKeyV2, readBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import type { SettingsMutationServices } from '@/components/settings/catalog/settingDeclarations';
import { getEnabledAgentIds } from '@/agents/catalog/enabled';
import { getResolvedBackendCatalogEntries } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { loadDaemonMergedProjectionCacheEntry, readReusableDaemonMergedProjectionCacheEntry } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { buildScmDiffSummaryModelProfiles } from '@/settings/scmDiffSummary/models';
import { decodeScmDiffSummaryModelOverride } from '@/settings/scmDiffSummary/settings';
import { buildDynamicModelProbeCacheKey } from '@/sync/domains/models/dynamicModelProbeCacheKey';
import { readDynamicModelProbeCache } from '@/sync/domains/models/dynamicModelProbeCache';
import { discoverMachineModels } from '@/sync/ops/modelDiscovery';
import { NEW_SESSION_MODEL_PROBE_TIMEOUT_MS } from '@/components/sessions/new/modules/newSessionCapabilityProbeTimeoutMs';
import { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } from '@/sync/domains/machines/administration/selectionPreferences';
import { resolveFreshMachineAdministrationExecutionTarget } from '@/sync/domains/machines/administration/useTargetSelection';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { areAccountSettingsJsonValuesEqual } from '@/sync/domains/settings/accountSettingsStructuralEquality';
import { storage } from '@/sync/domains/state/storage';
import type { captureLazyActionAccountContext } from './actionAccountContext';
import { readAcpCatalogInContext } from '@/sync/api/account/apiAcpCatalog';
import { isAcpCatalogCaptureCurrent } from '@/sync/store/settings/acpCatalogSnapshot';

type ActionAccount = Awaited<ReturnType<typeof captureLazyActionAccountContext>>;

/** Settings admission reads the picker's catalog/probe owners under its captured Account. */
export function createScmDiffSummarySettingsCatalogReader(account: ActionAccount | null): NonNullable<SettingsMutationServices['readScmDiffSummaryCatalog']> {
    return async (settings, storedValue) => {
        if (!account) return null;
        account.assertCurrent();
        const { catalog } = await readAcpCatalogInContext(account);
        account.assertCurrent();
        if (catalog.status !== 'ready') return null;
        const selected = decodeScmDiffSummaryModelOverride(storedValue);
        if (!selected?.backendTargetKey) return null;
        const selectionKey = MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.sourceControl;
        const selectedMachine = storage.getState().settings.machineAdministrationTargetsLocalV1[selectionKey] ?? null;
        const executionTarget = resolveFreshMachineAdministrationExecutionTarget(selectedMachine);
        const machineId = executionTarget && areServerProfileIdentifiersEquivalent(executionTarget.serverId, account.serverId)
            ? executionTarget.machine.id : null;
        const params = { serverId: account.serverId, accountLifetime: account.accountLifetime };
        const projection = machineId ? await loadDaemonMergedProjectionCacheEntry({ ...params, machineId, reuseFreshReady: true }) : null;
        account.assertCurrent();
        const inputs = projection?.kind === 'ready' ? projection.inputs : null;
        const entry = getResolvedBackendCatalogEntries({
            enabledAgentIds: getEnabledAgentIds({ backendEnabledByTargetKey: settings.backendEnabledByTargetKey }),
            acpCatalogSnapshot: catalog, backendEnabledByTargetKey: settings.backendEnabledByTargetKey,
            discoveredBackendIds: inputs?.discoveredBackendIds,
            mergedProviderProjectionById: inputs?.mergedProviderProjectionById,
            mergedBackendProjectionById: inputs?.mergedBackendProjectionById,
        }).find(candidate => candidate.backendTargetKey === selected.backendTargetKey);
        if (!entry) return null;
        const backendTarget = readBackendTargetRefV2(entry.backendTarget);
        const core = getAgentCore(entry.agentId);
        const modelConfig = getAgentModelConfig(entry.agentId);
        const cacheKey = buildDynamicModelProbeCacheKey({ machineId, targetKey: buildBackendTargetKeyV2(backendTarget),
            serverId: account.serverId, providerConnectionId: null });
        const probe = machineId && cacheKey && modelConfig?.dynamicProbe !== 'static-only' && modelConfig?.supportsSelection !== false
            ? await discoverMachineModels({ cacheKey, agentType: entry.agentId, machineId, serverId: account.serverId,
                backendTarget, timeoutMs: NEW_SESSION_MODEL_PROBE_TIMEOUT_MS,
                capabilityParams: { timeoutMs: NEW_SESSION_MODEL_PROBE_TIMEOUT_MS } }) : null;
        account.assertCurrent();
        const models = probe?.kind === 'success' ? probe.value.availableModels : getAgentStaticModels(entry.agentId, { catalogOnly: true });
        const profiles = buildScmDiffSummaryModelProfiles({ backendTarget, models,
            agentFormats: entry.kind === 'builtInAgent' ? core?.structuredOutput?.formats : null });
        return { profiles, isCurrent: current => {
            const cached = inputs && machineId ? readReusableDaemonMergedProjectionCacheEntry({ ...params, machineId }) : null;
            return account.accountLifetime.isCurrent() && isAcpCatalogCaptureCurrent(account.accountLifetime.scope, catalog)
                && areAccountSettingsJsonValuesEqual(current.backendEnabledByTargetKey, settings.backendEnabledByTargetKey)
                && areAccountSettingsJsonValuesEqual(storage.getState().settings.machineAdministrationTargetsLocalV1[selectionKey] ?? null, selectedMachine)
                && (!inputs || cached?.kind === 'ready' && cached.inputs === inputs)
                && (!probe || cacheKey !== null && readDynamicModelProbeCache(cacheKey) === probe);
        } };
    };
}
