import type { SettingsMutationServices } from '@/components/settings/catalog/settingDeclarations';
import { decodeScmDiffSummaryModelOverride, ScmDiffSummaryModelCatalogObservationV1Schema } from '@happier-dev/protocol/actions/settings/scmDiffSummarySettings';
import type { ScmDiffSummaryModelSelector } from '@happier-dev/protocol/scm/diffSummary';
import { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1, readSelectedMachineAdministrationTarget } from '@/sync/domains/machines/administration/selectionPreferences';
import { readMachineAdministrationTargetObservation } from '@/sync/domains/state/machineAdministrationUiState';
import { resolveFreshMachineAdministrationExecutionTarget } from '@/sync/domains/machines/administration/useTargetSelection';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { areAccountSettingsJsonValuesEqual } from '@/sync/domains/settings/accountSettingsStructuralEquality';
import { storage } from '@/sync/domains/state/storage';
import type { captureLazyActionAccountContext } from './actionAccountContext';
import { createUiAccountAction } from './accountActionDeps';

type ActionAccount = Awaited<ReturnType<typeof captureLazyActionAccountContext>>;

/** The machine's generation catalog is also the picker and Settings admission observation. */
export async function readScmDiffSummaryModelCatalogForMachine(account: ActionAccount, machineId: string, signal?: AbortSignal,
    request?: Readonly<{ discoveryTargetKey?: string | null; modelSelector?: ScmDiffSummaryModelSelector | null }>) {
    account.assertCurrent();
    const result = await createUiAccountAction({ account })({ actionId: 'agents.models.list',
        input: { purpose: 'scm_diff_summary', machineId,
            ...(request?.discoveryTargetKey ? { discoveryTargetKey: request.discoveryTargetKey } : {}),
            ...(request?.modelSelector ? { modelSelector: request.modelSelector } : {}) },
        context: { serverId: account.serverId, runtimeAccountId: account.accountId, surface: 'ui',
            authority: 'account_automation', actionCaller: { kind: 'host' }, externalActionTarget: { kind: 'machine', machineId } },
        ...(signal ? { signal } : {}) });
    account.assertCurrent();
    const parsed = ScmDiffSummaryModelCatalogObservationV1Schema.safeParse(result && typeof result === 'object'
        && 'scmDiffSummaryCatalog' in result ? result.scmDiffSummaryCatalog : null);
    return parsed.success ? parsed.data : null;
}

/** No UI-side static model or native-auth fallback can authorize a summary selection. */
export function createScmDiffSummarySettingsCatalogReader(account: ActionAccount | null): NonNullable<SettingsMutationServices['readScmDiffSummaryCatalog']> {
    return async (settings, storedValue) => {
        if (!account) return null;
        account.assertCurrent();
        const selectionKey = MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.sourceControl;
        const readSelectedTarget = () => readSelectedMachineAdministrationTarget(storage.getState().settings.machineAdministrationTargetsLocalV1,
            selectionKey, readMachineAdministrationTargetObservation(account.accountLifetime.scope, selectionKey));
        const selectedMachine = readSelectedTarget();
        const executionTarget = resolveFreshMachineAdministrationExecutionTarget(selectedMachine, { accountScope: account.accountLifetime.scope });
        if (!executionTarget || !areServerProfileIdentifiersEquivalent(executionTarget.serverId, account.serverId)) return null;
        const catalog = await readScmDiffSummaryModelCatalogForMachine(account, executionTarget.machine.id, undefined,
            { modelSelector: decodeScmDiffSummaryModelOverride(storedValue) });
        if (!catalog) return null;
        return { profiles: storedValue ? catalog.profiles : catalog.automaticProfiles, isCurrent: current => account.accountLifetime.isCurrent()
                && areAccountSettingsJsonValuesEqual(current.backendEnabledByTargetKey, settings.backendEnabledByTargetKey)
                && areAccountSettingsJsonValuesEqual(readSelectedTarget(), selectedMachine) };
    };
}
