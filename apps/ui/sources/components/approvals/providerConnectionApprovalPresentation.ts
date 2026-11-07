import { PROVIDER_ACTION_INPUT_SCHEMAS_V1 } from '@happier-dev/protocol/providers/providerActionsV1';
import { resolveAuthCredentialsScopeKey } from '@/auth/storage/resolveAuthCredentialsScopeKey';
import { readCachedDaemonMergedProjectionCacheEntry } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { PROVIDER_DECLARATION_CONTEXT_SECTIONS, readAccountProviderDeclaration, providerDeclarationContext } from '@/providers/catalog/accountProviderDeclarations';
import { presentDetectedProvider } from '@/providers/connection/detectedProviderPresentation';
import { getProviderConnectionCheckSnapshot, providerConnectionCheckQueryKey } from '@/sync/store/settings/providerCatalogSnapshot';
import { resolveServerScopedMachine } from '@/sync/domains/machines/resolveServerScopedMachine';
import { storage } from '@/sync/domains/state/storage';
import type { LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { getSettledMachineDisplayName } from '@/utils/sessions/machineDisplayNames';

/** Reuse the exact detected detail already admitted for this credential and Machine, without another read. */
export function readDetectedProviderConfirmation(actionId: string, input: unknown,
    account: LazyActionAccountContext): ReturnType<typeof presentDetectedProvider> | null {
    if (actionId !== 'providers.connections.enable_detected') return null;
    const parsed = PROVIDER_ACTION_INPUT_SCHEMAS_V1[actionId].safeParse(input);
    if (!parsed.success) return null;
    account.assertCurrent();
    const { machineId, candidateId } = parsed.data;
    const data = getProviderConnectionCheckSnapshot({ serverId: account.serverId, accountId: account.accountId },
        resolveAuthCredentialsScopeKey(account.credentials), providerConnectionCheckQueryKey(machineId));
    const candidate = data?.discoveryCandidates.find(row => row.machineId === machineId && row.candidateId === candidateId);
    if (!candidate) return null;
    const projection = readCachedDaemonMergedProjectionCacheEntry({ machineId, serverId: account.serverId,
        sections: PROVIDER_DECLARATION_CONTEXT_SECTIONS });
    const declaration = readAccountProviderDeclaration(candidate.contributionKey,
        providerDeclarationContext(machineId, projection?.kind === 'ready' ? projection.inputs.pluginProjectionV2 : null))
        ?? readAccountProviderDeclaration(candidate.contributionKey, { kind: 'account' });
    const machine = resolveServerScopedMachine(storage.getState(), account.serverId, machineId);
    return presentDetectedProvider(candidate, getSettledMachineDisplayName(machine) ?? machineId, declaration?.definition.catalog);
}
