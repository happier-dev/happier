export type PendingTerminalPairing = Readonly<{
    secretB64Url: string;
    createdAtMs: number;
    expiresAtMs: number;
}>;

export type PendingTerminalConnect = Readonly<{
    publicKeyB64Url: string;
    serverUrl: string;
    pairing?: PendingTerminalPairing;
    supportsTokenOnly?: true;
}>;

export type PendingTerminalConnectRecord = Readonly<{
    publicKeyB64Url: string;
    serverUrl: string;
    pairing?: PendingTerminalPairing;
    supportsTokenOnly?: true;
    createdAtMs: number;
}>;

const DEFAULT_TTL_MS = 10 * 60 * 1000;

function readTtlFromEnv(): number {
    const raw = String(process.env.EXPO_PUBLIC_PENDING_TERMINAL_CONNECT_TTL_MS ?? '').trim();
    if (!raw) return DEFAULT_TTL_MS;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) return DEFAULT_TTL_MS;
    return Math.floor(value);
}

const ttlMs = readTtlFromEnv();

export function toRecord(value: PendingTerminalConnect): PendingTerminalConnectRecord | null {
    const publicKeyB64Url = String(value?.publicKeyB64Url ?? '').trim();
    const serverUrl = String(value?.serverUrl ?? '').trim();
    if (!publicKeyB64Url || !serverUrl) return null;
    const pairing =
        value.pairing
        && String(value.pairing.secretB64Url ?? '').trim()
        && Number.isSafeInteger(value.pairing.createdAtMs)
        && Number.isSafeInteger(value.pairing.expiresAtMs)
        && value.pairing.createdAtMs >= 0
        && value.pairing.expiresAtMs > value.pairing.createdAtMs
            ? {
                secretB64Url: value.pairing.secretB64Url.trim(),
                createdAtMs: value.pairing.createdAtMs,
                expiresAtMs: value.pairing.expiresAtMs,
            }
            : undefined;
    return {
        publicKeyB64Url,
        serverUrl,
        ...(pairing ? { pairing } : {}),
        ...(pairing && value.supportsTokenOnly === true ? { supportsTokenOnly: true } : {}),
        createdAtMs: Date.now(),
    };
}

export function fromRecord(value: unknown): PendingTerminalConnect | null {
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    const publicKeyB64Url = String(record.publicKeyB64Url ?? '').trim();
    const serverUrl = String(record.serverUrl ?? '').trim();
    const createdAtMs = Number(record.createdAtMs ?? 0);
    if (!publicKeyB64Url || !serverUrl || !Number.isFinite(createdAtMs) || createdAtMs <= 0) return null;
    if (Date.now() - createdAtMs > ttlMs) return null;
    const pairingRecord =
        record.pairing && typeof record.pairing === 'object'
            ? record.pairing as Record<string, unknown>
            : null;
    const pairingSecret = String(pairingRecord?.secretB64Url ?? '').trim();
    const pairingCreatedAtMs = Number(pairingRecord?.createdAtMs);
    const pairingExpiresAtMs = Number(pairingRecord?.expiresAtMs);
    const pairing =
        pairingSecret
        && Number.isSafeInteger(pairingCreatedAtMs)
        && Number.isSafeInteger(pairingExpiresAtMs)
        && pairingCreatedAtMs >= 0
        && pairingExpiresAtMs > pairingCreatedAtMs
            ? {
                secretB64Url: pairingSecret,
                createdAtMs: pairingCreatedAtMs,
                expiresAtMs: pairingExpiresAtMs,
            }
            : undefined;
    return {
        publicKeyB64Url,
        serverUrl,
        ...(pairing ? { pairing } : {}),
        ...(pairing && record.supportsTokenOnly === true ? { supportsTokenOnly: true } : {}),
    };
}
