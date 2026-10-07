import type { ServerFetch } from '@/sync/http/client';
import type { HomeQrEnrollmentTarget } from '@/auth/flows/qrStart';
import { parseHomeQrPairingStatusV2, type HomeQrPairingStatusV2 } from '@happier-dev/protocol/crypto/qrProvisioningV2';

export type PairingStartResponse = Readonly<{
    pairId: string;
    expiresAt: string;
}>;

export type PairingStatus = HomeQrPairingStatusV2;

export type PairingRequestOk = Readonly<{ state: 'requested' }>;

export type PairingRequestErrorReason = 'not_found' | 'already_requested' | 'invalid_public_key' | 'invalid_target' | 'http_error';

export type PairingRequestResult =
    | Readonly<{ ok: true; data: PairingRequestOk }>
    | Readonly<{ ok: false; reason: PairingRequestErrorReason; status: number }>;

export type PairingConsumeResult =
    | Readonly<{ ok: true }>
    | Readonly<{ ok: false; reason: 'not_found' | 'already_decided' | 'invalid_target' | 'http_error'; status: number }>;

export type PairingStartResult =
    | Readonly<{ ok: true; data: PairingStartResponse }>
    | Readonly<{ ok: false; reason: 'pair_id_conflict' | 'invalid_target' | 'http_error'; status: number }>;

export type PairingStatusResult =
    | Readonly<{ ok: true; data: PairingStatus }>
    | Readonly<{ ok: false; reason: 'not_found' | 'invalid_target' | 'invalid_response' | 'http_error'; status: number }>;

/**
 * Explicit Home endpoint for pairing calls. When supplied, requests are bound to that
 * endpoint; Home-authenticated calls use that Home's own stored credentials and the
 * focused-Home wrapper is never consulted.
 */
export type PairingCallTarget = HomeQrEnrollmentTarget;

async function safeReadJson(res: Response): Promise<unknown> {
    try {
        return await res.json();
    } catch {
        return null;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

/**
 * Resolve the request function for one pairing call. Explicit targets never fall back to
 * the focused-Home selector; unauthenticated calls never attach credentials.
 */
function resolvePairingRequest(target: PairingCallTarget, authenticated = false): ServerFetch | null {
    const endpointUrl = target.endpointUrl.trim().replace(/\/+$/, '');
    try {
        const parsed = new URL(endpointUrl);
        if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username || parsed.password) {
            return null;
        }
    } catch {
        return null;
    }
    return target.createRequest({
        ...(target.serverId ? { serverId: target.serverId } : {}),
        // Authenticated trusted-device calls resolve the target Home's stored credential;
        // unauthenticated joining-device calls carry no bearer material at all.
        ...(authenticated ? {} : { credentials: null }),
    });
}

export type PairingStartParams =
    | Readonly<{ direction: 'trusted_home_displays'; secretHash: string }>
    | Readonly<{
        direction: 'requester_displays';
        secretHash: string;
        pairId: string;
        expiresAtMs: number;
    }>;

export async function pairingStart(
    params: PairingStartParams,
    target: PairingCallTarget,
    options: Readonly<{ signal?: AbortSignal }> = {},
): Promise<PairingStartResult> {
    const request = resolvePairingRequest(target, true);
    if (!request) return { ok: false, reason: 'invalid_target', status: 0 };
    const res = await request(
        '/v1/auth/pairing/start',
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(params),
            ...(options.signal ? { signal: options.signal } : {}),
        },
        { includeAuth: true },
    );
    if (!res.ok) {
        if (res.status === 409) {
            const json = await safeReadJson(res);
            if (isRecord(json) && hasExactKeys(json, ['error']) && json.error === 'pair_id_conflict') {
                return { ok: false, reason: 'pair_id_conflict', status: 409 };
            }
        }
        return { ok: false, reason: 'http_error', status: res.status };
    }
    const json = await safeReadJson(res);
    if (
        !isRecord(json)
        || typeof json.pairId !== 'string'
        || typeof json.expiresAt !== 'string'
        || !hasExactKeys(json, ['pairId', 'expiresAt'])
    ) {
        return { ok: false, reason: 'http_error', status: 502 };
    }
    return { ok: true, data: { pairId: json.pairId, expiresAt: json.expiresAt } };
}

export async function pairingStatus(
    params: { pairId: string },
    target: PairingCallTarget,
    options: Readonly<{ signal?: AbortSignal }> = {},
): Promise<PairingStatusResult> {
    const request = resolvePairingRequest(target, true);
    if (!request) return { ok: false, reason: 'invalid_target', status: 0 };
    const res = await request(`/v1/auth/pairing/status?pairId=${encodeURIComponent(params.pairId)}`, options.signal ? { signal: options.signal } : undefined, {
        includeAuth: true,
    });
    if (!res.ok) {
        if (res.status === 404) {
            return { ok: false, reason: 'not_found', status: 404 };
        }
        return { ok: false, reason: 'http_error', status: res.status };
    }
    const status = parseHomeQrPairingStatusV2(await safeReadJson(res));
    return status
        ? { ok: true, data: status }
        : { ok: false, reason: 'invalid_response', status: 502 };
}

export async function pairingRequest(params: {
    pairId: string;
    secret: string;
    publicKey: string;
    deviceLabel?: string;
    homeServerIdentityId: string;
    expiresAtMs: number;
    bindingProof: string;
}, target: PairingCallTarget, options: Readonly<{ signal?: AbortSignal }> = {}): Promise<PairingRequestResult> {
    if (options.signal?.aborted) return { ok: false, reason: 'http_error', status: 0 };
    const request = resolvePairingRequest(target);
    if (!request) return { ok: false, reason: 'invalid_target', status: 0 };
    const res = await request(
        '/v1/auth/pairing/request',
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                pairId: params.pairId,
                secret: params.secret,
                publicKey: params.publicKey,
                ...(params.deviceLabel ? { deviceLabel: params.deviceLabel } : null),
                homeServerIdentityId: params.homeServerIdentityId,
                expiresAtMs: params.expiresAtMs,
                bindingProof: params.bindingProof,
            }),
            ...(options.signal ? { signal: options.signal } : {}),
        },
        { includeAuth: false },
    );

    if (res.ok) {
        const json = await safeReadJson(res);
        if (isRecord(json) && json.state === 'requested' && hasExactKeys(json, ['state'])) {
            return { ok: true, data: { state: 'requested' } };
        }
        return { ok: false, reason: 'http_error', status: 502 };
    }

    if (res.status === 404) {
        return { ok: false, reason: 'not_found', status: 404 };
    }

    if (res.status === 403) {
        const json = await safeReadJson(res);
        if (
            isRecord(json)
            && hasExactKeys(json, ['error'])
            && (json.error === 'wrong_home' || json.error === 'wrong_expiry')
        ) {
            return { ok: false, reason: 'invalid_target', status: 403 };
        }
        return { ok: false, reason: 'http_error', status: 403 };
    }

    if (res.status === 401 || res.status === 409) {
        const json = await safeReadJson(res);
        if (isRecord(json) && hasExactKeys(json, ['error']) && json.error === 'already_requested') {
            return { ok: false, reason: 'already_requested', status: res.status };
        }
        if (isRecord(json) && hasExactKeys(json, ['error']) && json.error === 'Invalid public key') {
            return { ok: false, reason: 'invalid_public_key', status: 401 };
        }
        return { ok: false, reason: 'http_error', status: 401 };
    }

    return { ok: false, reason: 'http_error', status: res.status };
}

export async function pairingConsume(
    params: { pairId: string; intent?: 'reject' | 'cancel' },
    target: PairingCallTarget,
    options: Readonly<{ signal?: AbortSignal }> = {},
): Promise<PairingConsumeResult> {
    const request = resolvePairingRequest(target, true);
    if (!request) return { ok: false, reason: 'invalid_target', status: 0 };
    const res = await request(
        '/v1/auth/pairing/consume',
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                pairId: params.pairId,
                ...(params.intent ? { intent: params.intent } : null),
            }),
            ...(options.signal ? { signal: options.signal } : {}),
        },
        { includeAuth: true },
    );
    if (res.ok) {
        const json = await safeReadJson(res);
        return isRecord(json) && json.success === true && hasExactKeys(json, ['success'])
            ? { ok: true }
            : { ok: false, reason: 'http_error', status: 502 };
    }
    if (res.status === 404) {
        return { ok: false, reason: 'not_found', status: 404 };
    }
    if (res.status === 409) {
        const json = await safeReadJson(res);
        if (isRecord(json) && json.error === 'already_decided' && hasExactKeys(json, ['error'])) {
            return { ok: false, reason: 'already_decided', status: 409 };
        }
    }
    return { ok: false, reason: 'http_error', status: res.status };
}
