import { serverFetch } from '@/sync/http/client';
import {
    readProviderSettingsMutationBasisV1,
    removeProviderMachineStateV1,
    writeProviderSettingsToAccountSettingsV1,
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
        error: 'provider_cleanup_pending' | 'provider_settings_unreadable';
        machineRevoked: true;
        providerCleanup: 'pending';
        retryable: boolean;
    }>
    | Extract<MachineRevokeFromAccountResult, { ok: false }>;

/**
 * Coordinates the irreversible server revoke with the encrypted account-
 * settings CAS owner. The server cannot decrypt Provider settings, so cleanup
 * intentionally follows revocation: a cleanup failure is safe, explicit, and
 * retryable, while a settings write never happens for a failed revoke.
 *
 * Revoking a machine is a client-only flow — it can remove the last reachable
 * machine, so the CLI Provider settings owner is not callable here. Both writers
 * therefore consume the SAME Protocol mutation-basis decision: a Provider
 * subtree this build cannot fully parse is left byte-for-byte untouched and the
 * cleanup is reported pending, instead of being rewritten from the reader's
 * recovered defaults.
 */
export async function machineRevokeWithProviderCleanup(
    machineId: string,
    dependencies: Readonly<{
        revoke(id: string): Promise<MachineRevokeFromAccountResult>;
        mutateAccountSettings(
            mutate: (raw: Readonly<Record<string, unknown>>) => Record<string, unknown>,
        ): Promise<void>;
    }>,
): Promise<MachineRevokeWithProviderCleanupResult> {
    const id = String(machineId ?? '').trim();
    if (!id) return { ok: false, status: 400, error: 'machine_id_required' };
    const revoked = await dependencies.revoke(id);
    const machineAlreadyRevoked = !revoked.ok && revoked.status === 410 && revoked.error === 'machine_revoked';
    if (!revoked.ok && !machineAlreadyRevoked) return revoked;

    let cleanupNeeded = false;
    let settingsUnreadable = false;
    try {
        await dependencies.mutateAccountSettings((raw) => {
            const basis = readProviderSettingsMutationBasisV1(raw);
            if (basis.status === 'refused') {
                settingsUnreadable = true;
                return raw as Record<string, unknown>;
            }
            settingsUnreadable = false;
            const next = removeProviderMachineStateV1(basis.settings, id);
            cleanupNeeded = JSON.stringify(next) !== JSON.stringify(basis.settings);
            return cleanupNeeded
                ? writeProviderSettingsToAccountSettingsV1(raw, next)
                : raw as Record<string, unknown>;
        });
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
    if (settingsUnreadable) {
        return {
            ok: false,
            status: 409,
            error: 'provider_settings_unreadable',
            machineRevoked: true,
            providerCleanup: 'pending',
            retryable: false,
        };
    }
    return {
        ok: true,
        machineAlreadyRevoked,
        providerCleanup: cleanupNeeded ? 'complete' : 'not_needed',
    };
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
