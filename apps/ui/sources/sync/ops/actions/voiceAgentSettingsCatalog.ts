import type { SettingsMutationServices } from '@/components/settings/catalog/settingDeclarations';
import { getEnabledAgentIds } from '@/agents/catalog/enabled';
import { getResolvedBackendCatalogEntries } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { loadDaemonMergedProjectionCacheEntry, readReusableDaemonMergedProjectionCacheEntry } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { DAEMON_AGENT_CATALOG_SECTIONS } from '@/agents/backendCatalog/agentCatalogSections';
import { areAccountSettingsJsonValuesEqual } from '@/sync/domains/settings/accountSettingsStructuralEquality';
import { storage } from '@/sync/domains/state/storage';
import { resolveVoiceExecutionMachineIdFromState } from '@/voice/settings/executionMachine';
import type { captureLazyActionAccountContext } from './actionAccountContext';
import { readAcpCatalogInContext } from '@/sync/api/account/apiAcpCatalog';
import { isAcpCatalogCaptureCurrent } from '@/sync/store/settings/acpCatalogSnapshot';
import { resolveVoiceAgentCatalogSelectionV1 } from '@happier-dev/protocol/voice/settings/voiceAgentSelection';

type ActionAccount = Awaited<ReturnType<typeof captureLazyActionAccountContext>>;

/** The existing catalog/cache owner, bound to the Action's captured Home/Account and Voice computer. */
export function createVoiceAgentSettingsCatalogReader(account: ActionAccount | null): NonNullable<SettingsMutationServices['readAgentCatalog']> {
    return async (settings, selectedValue) => {
        if (!account) return null;
        account.assertCurrent();
        const bundledEntries = getResolvedBackendCatalogEntries({
            enabledAgentIds: getEnabledAgentIds(settings), backendEnabledByTargetKey: settings.backendEnabledByTargetKey,
        }).map(entry => entry.agentCatalogEntry);
        if (selectedValue && resolveVoiceAgentCatalogSelectionV1(bundledEntries, selectedValue)) {
            return { entries: bundledEntries, isCurrent: current => account.accountLifetime.isCurrent()
                && areAccountSettingsJsonValuesEqual(current.backendEnabledByTargetKey, settings.backendEnabledByTargetKey) };
        }
        const { catalog } = await readAcpCatalogInContext(account);
        account.assertCurrent();
        const state = storage.getState();
        const machineId = resolveVoiceExecutionMachineIdFromState({ ...state, settings });
        const params = { machineId, serverId: account.serverId, accountLifetime: account.accountLifetime, sections: DAEMON_AGENT_CATALOG_SECTIONS };
        const projection = machineId ? await loadDaemonMergedProjectionCacheEntry({ ...params, machineId, reuseFreshReady: true }) : null;
        account.assertCurrent();
        const inputs = projection?.kind === 'ready' ? projection.inputs : null;
        const resolvedEntries = getResolvedBackendCatalogEntries({
            enabledAgentIds: getEnabledAgentIds({ backendEnabledByTargetKey: settings.backendEnabledByTargetKey }),
            acpCatalogSnapshot: catalog,
            backendEnabledByTargetKey: settings.backendEnabledByTargetKey,
            mergedProviderProjectionById: inputs?.mergedProviderProjectionById ?? null,
            mergedBackendProjectionById: inputs?.mergedBackendProjectionById ?? null,
            discoveredBackendIds: inputs?.discoveredBackendIds,
        }).filter(entry => entry.kind !== 'pluginBackend' || entry.agentCatalogEntry.identity !== null
            && entry.agentCatalogEntry.projectionGeneration !== null);
        const entries = resolvedEntries.map(entry => entry.agentCatalogEntry);
        const selectedEntry = selectedValue ? resolveVoiceAgentCatalogSelectionV1(entries, selectedValue) : null;
        // Only configured ACP choices depend on that independent Account row.
        const requiresAcpCatalog = selectedValue === undefined || resolvedEntries.some(entry =>
            entry.kind === 'configuredBackend' && entry.agentCatalogEntry === selectedEntry);
        return {
            entries,
            isCurrent: (current) => {
                const cached = inputs && machineId ? readReusableDaemonMergedProjectionCacheEntry({ ...params, machineId }) : null;
                return account.accountLifetime.isCurrent()
                    && (!requiresAcpCatalog || catalog.status === 'ready'
                        && isAcpCatalogCaptureCurrent(account.accountLifetime.scope, catalog))
                    && areAccountSettingsJsonValuesEqual(current.voice.executionMachine, settings.voice.executionMachine)
                    && areAccountSettingsJsonValuesEqual(current.backendEnabledByTargetKey, settings.backendEnabledByTargetKey)
                    && (!inputs || cached?.kind === 'ready' && cached.inputs === inputs);
            },
        };
    };
}
