import { serverFetch } from '@/sync/http/client';

export type MachineRevokeFromAccountResult =
    | { ok: true }
    | { ok: false; status: number; error: string };

export async function machineRevokeFromAccount(machineId: string): Promise<MachineRevokeFromAccountResult> {
    const id = String(machineId ?? '').trim();
    if (!id) return { ok: false, status: 400, error: 'machine_id_required' };

    const response = await serverFetch(`/v1/machines/${encodeURIComponent(id)}/revoke`, {
        method: 'POST',
    });

    if (response.ok) {
        return { ok: true };
    }

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

