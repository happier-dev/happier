import type { SettingsMutationServices } from '@/components/settings/catalog/settingDeclarations';
import { getEnabledAgentIds } from '@/agents/catalog/enabled';
import { getResolvedAgentCatalogEntries } from '@/agents/backendCatalog/agentCatalogProjection';
import { loadDaemonMergedProjectionCacheEntry, readReusableDaemonMergedProjectionCacheEntry } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { areAccountSettingsJsonValuesEqual } from '@/sync/domains/settings/accountSettingsStructuralEquality';
import { storage } from '@/sync/domains/state/storage';
import { resolveVoiceExecutionMachineIdFromState } from '@/voice/settings/executionMachine';
import type { captureLazyActionAccountContext } from './actionAccountContext';
import { readAcpCatalogInContext } from '@/sync/api/account/apiAcpCatalog';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import { isAcpCatalogCaptureCurrent } from '@/sync/store/settings/acpCatalogSnapshot';

type ActionAccount = Awaited<ReturnType<typeof captureLazyActionAccountContext>>;

/** The existing catalog/cache owner, bound to the Action's captured Home/Account and Voice computer. */
export function createVoiceAgentSettingsCatalogReader(account: ActionAccount | null): NonNullable<SettingsMutationServices['readAgentCatalog']> {
    return async (settings) => {
        if (!account) return null;
        account.assertCurrent();
        const { catalog } = await readAcpCatalogInContext(account);
        account.assertCurrent();
        if (catalog.status !== 'ready') return null;
        const state = storage.getState();
        const machineId = resolveVoiceExecutionMachineIdFromState({ ...state, settings });
        const params = { machineId, serverId: account.serverId, accountLifetime: account.accountLifetime };
        const projection = machineId ? await loadDaemonMergedProjectionCacheEntry({ ...params, machineId, reuseFreshReady: true }) : null;
        account.assertCurrent();
        const inputs = projection?.kind === 'ready' ? projection.inputs : null;
        const entries = getResolvedAgentCatalogEntries({
            enabledAgentIds: getEnabledAgentIds({ backendEnabledByTargetKey: settings.backendEnabledByTargetKey }),
            acpCatalogSnapshot: catalog,
            backendEnabledByTargetKey: settings.backendEnabledByTargetKey,
            mergedProviderProjectionById: inputs?.mergedProviderProjectionById ?? null,
            mergedBackendProjectionById: inputs?.mergedBackendProjectionById ?? null,
        }).filter((entry) => entry.enabled !== false && (entry.isBuiltIn
            || catalog.record.definitions.some(definition => entry.backendTargetKey === resolveBackendTargetKeyV2({
                kind: 'backend', backendId: definition.id, configuredBackendId: definition.id,
            }))
            || (entry.identity !== null && entry.backendTargetKey !== null && entry.projectionGeneration !== null)));
        return {
            entries,
            isCurrent: (current) => {
                const cached = inputs && machineId ? readReusableDaemonMergedProjectionCacheEntry({ ...params, machineId }) : null;
                return account.accountLifetime.isCurrent()
                    && isAcpCatalogCaptureCurrent(account.accountLifetime.scope, catalog)
                    && areAccountSettingsJsonValuesEqual(current.voice.executionMachine, settings.voice.executionMachine)
                    && areAccountSettingsJsonValuesEqual(current.backendEnabledByTargetKey, settings.backendEnabledByTargetKey)
                    && (!inputs || cached?.kind === 'ready' && cached.inputs === inputs);
            },
        };
    };
}
