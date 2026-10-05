import type { SettingsMutationServices } from '@/components/settings/catalog/settingDeclarations';
import { getEnabledAgentIds } from '@/agents/catalog/enabled';
import { getResolvedAgentCatalogEntries } from '@/agents/backendCatalog/agentCatalogProjection';
import { loadDaemonMergedProjectionCacheEntry, readReusableDaemonMergedProjectionCacheEntry } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { areAccountSettingsJsonValuesEqual } from '@/sync/domains/settings/accountSettingsStructuralEquality';
import { storage } from '@/sync/domains/state/storage';
import { resolveVoiceExecutionMachineIdFromState } from '@/voice/settings/executionMachine';
import type { captureLazyActionAccountContext } from './actionAccountContext';

type ActionAccount = Pick<Awaited<ReturnType<typeof captureLazyActionAccountContext>>,
    'serverId' | 'accountLifetime' | 'assertCurrent' | 'readLiveSettings'>;

/** The existing catalog/cache owner, bound to the Action's captured Home/Account and Voice computer. */
export function createVoiceAgentSettingsCatalogReader(account: ActionAccount | null): NonNullable<SettingsMutationServices['readAgentCatalog']> {
    return async (settings) => {
        if (!account || account.readLiveSettings() === null) return null;
        account.assertCurrent();
        const state = storage.getState();
        const machineId = resolveVoiceExecutionMachineIdFromState({ ...state, settings });
        const params = { machineId, serverId: account.serverId, accountLifetime: account.accountLifetime };
        const projection = machineId ? await loadDaemonMergedProjectionCacheEntry({ ...params, machineId, reuseFreshReady: true }) : null;
        account.assertCurrent();
        const inputs = projection?.kind === 'ready' ? projection.inputs : null;
        const entries = getResolvedAgentCatalogEntries({
            enabledAgentIds: getEnabledAgentIds({ backendEnabledByTargetKey: settings.backendEnabledByTargetKey }),
            acpCatalogSettingsV1: settings.acpCatalogSettingsV1,
            backendEnabledByTargetKey: settings.backendEnabledByTargetKey,
            mergedProviderProjectionById: inputs?.mergedProviderProjectionById ?? null,
            mergedBackendProjectionById: inputs?.mergedBackendProjectionById ?? null,
        }).filter((entry) => entry.enabled !== false && (entry.isBuiltIn || (entry.identity !== null && entry.backendTargetKey !== null && entry.projectionGeneration !== null)));
        return {
            entries,
            isCurrent: (current) => {
                const cached = inputs && machineId ? readReusableDaemonMergedProjectionCacheEntry({ ...params, machineId }) : null;
                return account.accountLifetime.isCurrent()
                    && account.readLiveSettings() !== null
                    && areAccountSettingsJsonValuesEqual(current.voice.executionMachine, settings.voice.executionMachine)
                    && areAccountSettingsJsonValuesEqual(current.backendEnabledByTargetKey, settings.backendEnabledByTargetKey)
                    && areAccountSettingsJsonValuesEqual(current.acpCatalogSettingsV1, settings.acpCatalogSettingsV1)
                    && (!inputs || cached?.kind === 'ready' && cached.inputs === inputs);
            },
        };
    };
}
