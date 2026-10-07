import { HomeConnectionDescriptorV1Schema, type HomeConnectionDescriptorV1 } from '@happier-dev/protocol/auth/accountDirectory';
import { normalizeServerIdentityIdCapability } from '@happier-dev/protocol/features/payload/capabilities/serverIdentityCapabilities';
import {
    createServerAccountScope,
    type ServerAccountScope,
} from '@/sync/domains/scope/serverAccountScope';
import { createServerUrlComparableKey } from '@/sync/domains/server/url/serverUrlCanonical';

export type PendingTerminalPairing = Readonly<{
    secretB64Url: string;
    createdAtMs: number;
    expiresAtMs: number;
}>;

export type PendingTerminalConnect = Readonly<{
    publicKeyB64Url: string;
    serverUrl: string;
    serverIdentityId: string;
    pairing?: PendingTerminalPairing;
    supportsTokenOnly?: true;
    homeConnectionDescriptor?: HomeConnectionDescriptorV1;
}>;

export type PendingTerminalConnectRecord = Readonly<{
    publicKeyB64Url: string;
    serverUrl: string;
    serverIdentityId: string;
    pairing?: PendingTerminalPairing;
    supportsTokenOnly?: true;
    homeConnectionDescriptor?: HomeConnectionDescriptorV1;
    createdAtMs: number;
}>;

export type PendingTerminalConnectPreAuthEnvelope = Readonly<{
    record: PendingTerminalConnectRecord;
    claimedScope?: ServerAccountScope;
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

export function toRecord(
    value: PendingTerminalConnect,
    createdAtMs: number = Date.now(),
): PendingTerminalConnectRecord | null {
    const publicKeyB64Url = String(value?.publicKeyB64Url ?? '').trim();
    const serverUrl = String(value?.serverUrl ?? '').trim();
    const serverIdentityId = normalizeServerIdentityIdCapability(value?.serverIdentityId);
    if (!publicKeyB64Url || !serverUrl || !serverIdentityId || !Number.isFinite(createdAtMs) || createdAtMs <= 0) return null;
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
    if (value.pairing && !pairing) return null;
    if (pairing && pairing.expiresAtMs <= Date.now()) return null;
    const descriptor = value.homeConnectionDescriptor === undefined
        ? undefined
        : HomeConnectionDescriptorV1Schema.safeParse(value.homeConnectionDescriptor);
    if (descriptor && !descriptor.success) return null;
    if (descriptor?.success && descriptor.data.homeServerIdentityId !== serverIdentityId) return null;
    if (descriptor?.success && !pairing) return null;
    if (
        descriptor?.success
        && createServerUrlComparableKey(descriptor.data.canonicalServerUrl) !== createServerUrlComparableKey(serverUrl)
    ) return null;
    return {
        publicKeyB64Url,
        serverUrl,
        serverIdentityId,
        ...(pairing ? { pairing } : {}),
        ...(pairing && value.supportsTokenOnly === true ? { supportsTokenOnly: true } : {}),
        ...(descriptor?.success ? { homeConnectionDescriptor: descriptor.data } : {}),
        createdAtMs,
    };
}

export function parsePendingTerminalConnectRecord(value: unknown): PendingTerminalConnectRecord | null {
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    const publicKeyB64Url = String(record.publicKeyB64Url ?? '').trim();
    const serverUrl = String(record.serverUrl ?? '').trim();
    const serverIdentityId = normalizeServerIdentityIdCapability(record.serverIdentityId);
    const createdAtMs = Number(record.createdAtMs ?? 0);
    if (!publicKeyB64Url || !serverUrl || !serverIdentityId || !Number.isFinite(createdAtMs) || createdAtMs <= 0) return null;
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
    if (pairingRecord && !pairing) return null;
    if (pairing && pairing.expiresAtMs <= Date.now()) return null;
    const descriptor = record.homeConnectionDescriptor === undefined
        ? undefined
        : HomeConnectionDescriptorV1Schema.safeParse(record.homeConnectionDescriptor);
    if (descriptor && !descriptor.success) return null;
    if (descriptor?.success && descriptor.data.homeServerIdentityId !== serverIdentityId) return null;
    if (descriptor?.success && !pairing) return null;
    if (
        descriptor?.success
        && createServerUrlComparableKey(descriptor.data.canonicalServerUrl) !== createServerUrlComparableKey(serverUrl)
    ) return null;
    return {
        publicKeyB64Url,
        serverUrl,
        serverIdentityId,
        ...(pairing ? { pairing } : {}),
        ...(pairing && record.supportsTokenOnly === true ? { supportsTokenOnly: true } : {}),
        ...(descriptor?.success ? { homeConnectionDescriptor: descriptor.data } : {}),
        createdAtMs,
    };
}

export function fromRecord(value: unknown): PendingTerminalConnect | null {
    const record = parsePendingTerminalConnectRecord(value);
    if (!record) return null;
    const { createdAtMs: _, ...pending } = record;
    return pending;
}

export function parsePendingTerminalConnectPreAuthEnvelope(
    value: unknown,
): PendingTerminalConnectPreAuthEnvelope | null {
    if (!value || typeof value !== 'object') return null;
    const source = value as Record<string, unknown>;
    const record = parsePendingTerminalConnectRecord(source.record);
    if (!record) return null;
    if (source.claimedScope === undefined) return { record };
    if (!source.claimedScope || typeof source.claimedScope !== 'object') return null;
    const claimed = source.claimedScope as Record<string, unknown>;
    const claimedScope = createServerAccountScope(claimed.serverId, claimed.accountId);
    return claimedScope ? { record, claimedScope } : null;
}

export function pendingTerminalConnectFromParsedRecord(
    record: PendingTerminalConnectRecord,
): PendingTerminalConnect {
    const { createdAtMs: _, ...pending } = record;
    return pending;
}

export function arePendingTerminalConnectRecordsSameRequest(
    left: PendingTerminalConnectRecord,
    right: PendingTerminalConnectRecord,
): boolean {
    const { createdAtMs: _leftCreatedAtMs, ...leftRequest } = left;
    const { createdAtMs: _rightCreatedAtMs, ...rightRequest } = right;
    return JSON.stringify(leftRequest) === JSON.stringify(rightRequest);
}
