import { serverFetch } from '@/sync/http/client';

export type PairingStartResponse = Readonly<{
    pairId: string;
    expiresAt: string;
}>;

export type PairingStatus =
    | Readonly<{
        state: 'pending';
        pairId: string;
        expiresAt: string;
    }>
    | Readonly<{
        state: 'requested';
        pairId: string;
        expiresAt: string;
        requestedPublicKey: string;
        requestedDeviceLabel: string | null;
        confirmCode: string;
    }>;

export type PairingRequestOk = Readonly<{ state: 'requested'; confirmCode: string }>;

export type PairingRequestErrorReason = 'not_found' | 'already_requested' | 'invalid_public_key' | 'http_error';

export type PairingRequestResult =
    | Readonly<{ ok: true; data: PairingRequestOk }>
    | Readonly<{ ok: false; reason: PairingRequestErrorReason; status: number }>;

export type PairingConsumeResult =
    | Readonly<{ ok: true }>
    | Readonly<{ ok: false; reason: 'not_found' | 'http_error'; status: number }>;

export type PairingStartResult =
    | Readonly<{ ok: true; data: PairingStartResponse }>
    | Readonly<{ ok: false; reason: 'http_error'; status: number }>;

export type PairingStatusResult =
    | Readonly<{ ok: true; data: PairingStatus }>
    | Readonly<{ ok: false; reason: 'not_found' | 'http_error'; status: number }>;

async function safeReadJson(res: Response): Promise<any | null> {
    try {
        return await res.json();
    } catch {
        return null;
    }
}

export async function pairingStart(params: { secretHash: string }): Promise<PairingStartResult> {
    const res = await serverFetch(
        '/v1/auth/pairing/start',
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ secretHash: params.secretHash }),
        },
        { includeAuth: true },
    );
    if (!res.ok) {
        return { ok: false, reason: 'http_error', status: res.status };
    }
    const json = await safeReadJson(res);
    if (!json || typeof json.pairId !== 'string' || typeof json.expiresAt !== 'string') {
        return { ok: false, reason: 'http_error', status: 502 };
    }
    return { ok: true, data: { pairId: json.pairId, expiresAt: json.expiresAt } };
}

export async function pairingStatus(params: { pairId: string }): Promise<PairingStatusResult> {
    const res = await serverFetch(`/v1/auth/pairing/status?pairId=${encodeURIComponent(params.pairId)}`, undefined, {
        includeAuth: true,
    });
    if (!res.ok) {
        if (res.status === 404) {
            return { ok: false, reason: 'not_found', status: 404 };
        }
        return { ok: false, reason: 'http_error', status: res.status };
    }
    const json = await safeReadJson(res);
    if (!json || (json.state !== 'pending' && json.state !== 'requested') || typeof json.pairId !== 'string') {
        return { ok: false, reason: 'http_error', status: 502 };
    }
    return { ok: true, data: json };
}

export async function pairingRequest(params: {
    pairId: string;
    secret: string;
    publicKey: string;
    deviceLabel?: string;
}): Promise<PairingRequestResult> {
    const res = await serverFetch(
        '/v1/auth/pairing/request',
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                pairId: params.pairId,
                secret: params.secret,
                publicKey: params.publicKey,
                ...(params.deviceLabel ? { deviceLabel: params.deviceLabel } : null),
            }),
        },
        { includeAuth: false },
    );

    if (res.ok) {
        const json = await safeReadJson(res);
        if (json && json.state === 'requested' && typeof json.confirmCode === 'string') {
            return { ok: true, data: { state: 'requested', confirmCode: json.confirmCode } };
        }
        return { ok: false, reason: 'http_error', status: 502 };
    }

    if (res.status === 404) {
        return { ok: false, reason: 'not_found', status: 404 };
    }

    if (res.status === 401) {
        const json = await safeReadJson(res);
        if (json?.error === 'already_requested') {
            return { ok: false, reason: 'already_requested', status: 401 };
        }
        if (json?.error === 'Invalid public key') {
            return { ok: false, reason: 'invalid_public_key', status: 401 };
        }
        return { ok: false, reason: 'http_error', status: 401 };
    }

    return { ok: false, reason: 'http_error', status: res.status };
}

export async function pairingConsume(params: { pairId: string }): Promise<PairingConsumeResult> {
    const res = await serverFetch(
        '/v1/auth/pairing/consume',
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pairId: params.pairId }),
        },
        { includeAuth: true },
    );
    if (res.ok) {
        return { ok: true };
    }
    if (res.status === 404) {
        return { ok: false, reason: 'not_found', status: 404 };
    }
    return { ok: false, reason: 'http_error', status: res.status };
}
