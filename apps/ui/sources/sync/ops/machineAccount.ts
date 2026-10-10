import { serverFetch, type ServerFetch } from '@/sync/http/client';
import { composeProviderSettingsV1, splitProviderSettingsV1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { readProviderCatalogInContext, writeProviderCatalogAndPublishInContext } from '@/sync/api/account/apiProviderCatalog';
import { captureLazyActionAccountContext, type LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { hasProviderMachineStateV1, removeProviderMachineStateV1 } from '@happier-dev/protocol/providers/settings/operationsV1';
import {
    areAccountSettingsScopesEqual,
    type AccountSettingsScope,
} from '@/sync/domains/settings/scope/accountSettingsScope';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';

export type MachineRevokeFromAccountResult =
    | { ok: true }
    | { ok: false; status: number; error: string };

export type MachineReplacementAccountResult =
    | { ok: true }
    | { ok: false; status: number; error: string };

async function readMachineAccountError(response: Response): Promise<{ ok: false; status: number; error: string }> {
    try {
        const body: unknown = await response.json();
        const error = (body && typeof body === 'object' && 'error' in body && typeof body.error === 'string')
            ? body.error
            : `http_${response.status}`;
        return { ok: false, status: response.status, error };
    } catch {
        return { ok: false, status: response.status, error: `http_${response.status}` };
    }
}

export async function machineRevokeFromAccount(machineId: string, request: ServerFetch = serverFetch): Promise<MachineRevokeFromAccountResult> {
    const id = String(machineId ?? '').trim();
    if (!id) return { ok: false, status: 400, error: 'machine_id_required' };

    const response = await request(`/v1/machines/${encodeURIComponent(id)}/revoke`, {
        method: 'POST',
    });

    if (response.ok) {
        return { ok: true };
    }

    return readMachineAccountError(response);
}

export type MachineRevokeWithProviderCleanupResult =
    | Readonly<{ ok: true; machineAlreadyRevoked: boolean; providerCleanup: 'complete' | 'not_needed' }>
    | Readonly<{
        ok: false;
        status: number;
        error: 'provider_cleanup_pending' | 'provider_settings_unreadable';
        machineRevoked: true;
        providerCleanup: 'pending';
        retryable: boolean;
    }>
    | Extract<MachineRevokeFromAccountResult, { ok: false }>;

function pendingProviderCleanup(unreadable = false): Extract<MachineRevokeWithProviderCleanupResult, { machineRevoked: true }> {
    return {
        ok: false, status: unreadable ? 409 : 503,
        error: unreadable ? 'provider_settings_unreadable' : 'provider_cleanup_pending',
        machineRevoked: true, providerCleanup: 'pending', retryable: !unreadable,
    };
}

/**
 * Revoke and private Provider cleanup borrow one captured Home/Account. The
 * last Machine may be unreachable after revoke, so the client retains this
 * authority rather than handing cleanup to a daemon. Only a complete catalog
 * may authorize one row CAS; a conflict or unknown receipt requires an explicit
 * retry from the current row, never a blind replay or a root Settings rewrite.
 */
export async function machineRevokeWithProviderCleanup(
    machineId: string,
    expectedSettingsScope: AccountSettingsScope | null,
): Promise<MachineRevokeWithProviderCleanupResult> {
    const id = String(machineId ?? '').trim();
    if (!id) return { ok: false, status: 400, error: 'machine_id_required' };
    if (!expectedSettingsScope
        || !areAccountSettingsScopesEqual(getActiveServerAccountScope(), expectedSettingsScope)) {
        return { ok: false, status: 409, error: 'account_settings_scope_changed' };
    }
    let context: LazyActionAccountContext;
    try {
        context = await captureLazyActionAccountContext(expectedSettingsScope.serverId);
    } catch {
        return { ok: false, status: 409, error: 'account_settings_scope_changed' };
    }
    try {
        if (context.accountId !== expectedSettingsScope.accountId) {
            return { ok: false, status: 409, error: 'account_settings_scope_changed' };
        }
        const revoked = await machineRevokeFromAccount(id, context.request);
        const machineAlreadyRevoked = !revoked.ok && revoked.status === 410 && revoked.error === 'machine_revoked';
        if (!revoked.ok && !machineAlreadyRevoked) return revoked;

        try {
            const captured = await readProviderCatalogInContext(context);
            if (captured.status !== 'ready') {
                return pendingProviderCleanup(captured.status === 'partial'
                    || captured.status === 'unavailable' && captured.reason === 'invalid-stored-content');
            }
            const settings = composeProviderSettingsV1(captured.catalog, {});
            if (!hasProviderMachineStateV1(settings, id)) {
                return { ok: true, machineAlreadyRevoked, providerCleanup: 'not_needed' };
            }
            const catalog = splitProviderSettingsV1(removeProviderMachineStateV1(settings, id)).catalog;
            const mutation = await writeProviderCatalogAndPublishInContext(context, {
                catalog, expectedRevision: captured.revision,
            });
            return mutation.status === 'updated'
                ? { ok: true, machineAlreadyRevoked, providerCleanup: 'complete' }
                : pendingProviderCleanup();
        } catch {
            return pendingProviderCleanup();
        }
    } finally {
        context.dispose();
    }
}

export async function machineReplaceInAccount(params: Readonly<{
    oldMachineId: string;
    replacementMachineId: string;
    confirmActiveOldMachine?: boolean;
}>): Promise<MachineReplacementAccountResult> {
    const oldMachineId = String(params.oldMachineId ?? '').trim();
    if (!oldMachineId) return { ok: false, status: 400, error: 'machine_id_required' };

    const replacementMachineId = String(params.replacementMachineId ?? '').trim();
    if (!replacementMachineId) return { ok: false, status: 400, error: 'replacement_machine_id_required' };

    const response = await serverFetch(`/v1/machines/${encodeURIComponent(oldMachineId)}/replacement`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            replacementMachineId,
            ...(params.confirmActiveOldMachine ? { confirmActiveOldMachine: true } : {}),
        }),
    });

    if (response.ok) {
        return { ok: true };
    }

    return readMachineAccountError(response);
}

export async function machineClearReplacementFromAccount(machineId: string): Promise<MachineReplacementAccountResult> {
    const id = String(machineId ?? '').trim();
    if (!id) return { ok: false, status: 400, error: 'machine_id_required' };

    const response = await serverFetch(`/v1/machines/${encodeURIComponent(id)}/replacement`, {
        method: 'DELETE',
    });

    if (response.ok) {
        return { ok: true };
    }

    return readMachineAccountError(response);
}
