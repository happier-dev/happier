import { serverFetch } from '@/sync/http/client';
import {
    ProviderSettingsV1Schema,
    removeProviderMachineStateV1,
    type ProviderSettingsV1,
} from '@happier-dev/protocol';

export type MachineRevokeFromAccountResult =
    | { ok: true }
    | { ok: false; status: number; error: string };

export type MachineReplacementAccountResult =
    | { ok: true }
    | { ok: false; status: number; error: string };

async function readMachineAccountError(response: Response): Promise<{ ok: false; status: number; error: string }> {
    try {
        const body = await response.json();
        const error = (body && typeof body === 'object' && typeof (body as any).error === 'string')
            ? (body as any).error
            : `http_${response.status}`;
        return { ok: false, status: response.status, error };
    } catch {
        return { ok: false, status: response.status, error: `http_${response.status}` };
    }
}

export async function machineRevokeFromAccount(machineId: string): Promise<MachineRevokeFromAccountResult> {
    const id = String(machineId ?? '').trim();
    if (!id) return { ok: false, status: 400, error: 'machine_id_required' };

    const response = await serverFetch(`/v1/machines/${encodeURIComponent(id)}/revoke`, {
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
        error: string;
        machineRevoked: true;
        providerCleanup: 'pending';
        retryable: true;
    }>
    | Extract<MachineRevokeFromAccountResult, { ok: false }>;

/**
 * Coordinates the irreversible server revoke with the encrypted account-
 * settings CAS owner. The server cannot decrypt Provider settings, so cleanup
 * intentionally follows revocation: a cleanup failure is safe, explicit, and
 * retryable, while a settings write never happens for a failed revoke.
 */
export async function machineRevokeWithProviderCleanup(
    machineId: string,
    dependencies: Readonly<{
        revoke(id: string): Promise<MachineRevokeFromAccountResult>;
        mutateProviderSettings(
            mutate: (settings: ProviderSettingsV1) => ProviderSettingsV1,
        ): Promise<void>;
    }>,
): Promise<MachineRevokeWithProviderCleanupResult> {
    const id = String(machineId ?? '').trim();
    if (!id) return { ok: false, status: 400, error: 'machine_id_required' };
    const revoked = await dependencies.revoke(id);
    const machineAlreadyRevoked = !revoked.ok && revoked.status === 410 && revoked.error === 'machine_revoked';
    if (!revoked.ok && !machineAlreadyRevoked) return revoked;

    try {
        let cleanupNeeded = false;
        await dependencies.mutateProviderSettings((settings) => {
            const current = ProviderSettingsV1Schema.parse(settings);
            const next = removeProviderMachineStateV1(current, id);
            cleanupNeeded = JSON.stringify(next) !== JSON.stringify(current);
            return next;
        });
        return {
            ok: true,
            machineAlreadyRevoked,
            providerCleanup: cleanupNeeded ? 'complete' : 'not_needed',
        };
    } catch {
        return {
            ok: false,
            status: 503,
            error: 'provider_cleanup_pending',
            machineRevoked: true,
            providerCleanup: 'pending',
            retryable: true,
        };
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
