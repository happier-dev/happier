import {
    isTokenOnlyAuthCredentials,
    type AuthCredentials,
} from '@/auth/storage/tokenStorage';
import {
    getQualifiedConnectedAccountQuotaV4,
} from '@/sync/api/account/apiQualifiedConnectedAccountsV4';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import type { ExpectedActiveServerFetchBasis } from '@/sync/http/client';
import { openQualifiedConnectedAccountQuotaResponseV4, type QualifiedConnectedAccountQuotaSnapshotV4, type QualifiedConnectedAccountQuotaResponseV4 } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import type { QualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import type { ProviderAccountUsageRecordId } from '@happier-dev/protocol/connect/account-usage-primitives';
import { CONNECTED_SERVICE_CONFIGURATION_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/connect/configurationActionsV1';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } from '@/sync/domains/machines/administration/selectionPreferences';
import { doesMachineAdministrationTargetMatchActiveAccount, resolveFreshMachineAdministrationExecutionTarget } from '@/sync/domains/machines/administration/useTargetSelection';
import { storage } from '@/sync/domains/state/storageStore';
import { parseToken } from '@/utils/auth/parseToken';

export type QualifiedConnectedAccountQuotaTransportContext = Readonly<{
    credentials: AuthCredentials;
    ref: QualifiedConnectedAccountRef;
    serverBasis: ExpectedActiveServerFetchBasis;
    /** Null explicitly disables detail refresh; omission uses the exact persisted Account choice. */
    refreshMachineId?: string | null;
}>;

export async function readQualifiedConnectedAccountQuota(
    context: QualifiedConnectedAccountQuotaTransportContext,
): Promise<Readonly<{
    snapshot: QualifiedConnectedAccountQuotaSnapshotV4;
    recordId: ProviderAccountUsageRecordId;
    status: QualifiedConnectedAccountQuotaResponseV4['metadata']['status'];
}> | null> {
    // The server serves and scopes the read; the opened response is checked against `ref`.
    const response = await getQualifiedConnectedAccountQuotaV4(
        context.credentials,
        context.ref,
        { expectedActiveServer: context.serverBasis },
    );
    if (!response) return null;
    const material = isTokenOnlyAuthCredentials(context.credentials)
        ? null
        : resolveAccountScopedCryptoMaterialFromCredentials(
            context.credentials,
        );
    const opened = openQualifiedConnectedAccountQuotaResponseV4({
        response,
        expectedRef: context.ref,
        material,
    });
    if (!opened) {
        throw Object.assign(
            new Error('qualified_connected_account_quota_invalid'),
            { code: 'qualified_connected_account_quota_invalid' },
        );
    }
    return { snapshot: opened, recordId: response.sourceResolution.recordId, status: response.metadata.status };
}

export async function refreshQualifiedConnectedAccountQuota(
    context: QualifiedConnectedAccountQuotaTransportContext,
): Promise<void> {
    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
    const active = getActiveServerSnapshot();
    if (active.generation !== context.serverBasis.generation
        || !areServerProfileIdentifiersEquivalent(active.serverId, context.serverBasis.serverId)) {
        throw Object.assign(new Error('STALE_SERVER_GENERATION'), { code: 'STALE_SERVER_GENERATION' });
    }
    const selected = storage.getState().settings.machineAdministrationTargetsLocalV1[
        MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.connectedAccounts
    ] ?? null;
    const target = doesMachineAdministrationTargetMatchActiveAccount({
        target: selected, activeAccountServerId: context.serverBasis.serverId,
    }) ? resolveFreshMachineAdministrationExecutionTarget(selected) : null;
    if (!target || context.refreshMachineId === null
        || (context.refreshMachineId !== undefined && context.refreshMachineId !== target.machine.id)) {
        throw Object.assign(new Error('connected_account_service_identity_unsupported'), { code: 'connected_account_service_identity_unsupported' });
    }
    // The shared Action owns V4 operation admission and the HTTP mutation;
    // every list/detail/sidebar caller reaches this same exact-target dispatch.
    const result = await createDefaultActionExecutor().execute('connectedServices.quota.refresh', {
        account: context.ref, machineId: target.machine.id,
    }, { surface: 'ui', authority: 'present_user', serverId: context.serverBasis.serverId,
        expectedAccountId: parseToken(context.credentials.token) });
    if (!result.ok) throw Object.assign(new Error(result.error), { code: result.errorCode });
    if (!CONNECTED_SERVICE_CONFIGURATION_ACTION_OUTPUT_SCHEMAS_V1['connectedServices.quota.refresh'].safeParse(result.result).success) {
        throw Object.assign(new Error('connected_account_quota_refresh_unavailable'), { code: 'connected_account_quota_refresh_unavailable' });
    }
}
