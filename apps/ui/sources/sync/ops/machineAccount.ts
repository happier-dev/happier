import { serverFetch } from '@/sync/http/client';

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
