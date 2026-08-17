import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { digest } from '@/platform/digest';
import { getRandomBytes } from '@/platform/cryptoRandom';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

import {
    readDeviceLocalStorageString,
    writeDeviceLocalStorageString,
} from './deviceLocalStorage';

const DEVICE_LOCAL_SETTINGS_SECRET_KEY_PREFIX = 'device-local-settings-secret-key:v1';
const DEVICE_LOCAL_SETTINGS_SECRET_KEY_BYTES = 32;

type StoredDeviceLocalSecretKeyV1 = Readonly<{
    v: 1;
    key: string;
}>;

export class DeviceLocalSecretKeyUnavailableError extends Error {
    readonly code = 'local_secret_unavailable' as const;

    constructor(readonly reason: 'stored_key_corrupt') {
        super('Device-local settings secret key is unavailable');
        this.name = 'DeviceLocalSecretKeyUnavailableError';
    }
}

type StoredDeviceLocalSecretKeyParseResult =
    | Readonly<{ status: 'missing' }>
    | Readonly<{ status: 'available'; key: Uint8Array }>
    | Readonly<{ status: 'corrupt' }>;

const pendingResolutionByStorageKey = new Map<string, Promise<Uint8Array | null>>();

function parseStoredDeviceLocalSecretKey(raw: string | null): StoredDeviceLocalSecretKeyParseResult {
    if (raw === null) return { status: 'missing' };
    try {
        const parsed = JSON.parse(raw) as Partial<StoredDeviceLocalSecretKeyV1>;
        if (parsed.v !== 1 || typeof parsed.key !== 'string') return { status: 'corrupt' };
        const key = decodeBase64(parsed.key, 'base64');
        return key.length === DEVICE_LOCAL_SETTINGS_SECRET_KEY_BYTES
            ? { status: 'available', key }
            : { status: 'corrupt' };
    } catch {
        return { status: 'corrupt' };
    }
}

async function resolveStorageKey(scope: ServerAccountScope): Promise<string> {
    const identity = new TextEncoder().encode(`${scope.serverId}\u0000${scope.accountId}`);
    const scopeDigest = await digest('SHA-256', identity);
    return `${DEVICE_LOCAL_SETTINGS_SECRET_KEY_PREFIX}:${encodeBase64(scopeDigest, 'base64url')}`;
}

async function resolveForStorageKey(storageKey: string): Promise<Uint8Array | null> {
    let raw: string | null;
    try {
        raw = await readDeviceLocalStorageString(storageKey);
    } catch {
        return null;
    }

    const existing = parseStoredDeviceLocalSecretKey(raw);
    if (existing.status === 'available') return existing.key;
    if (existing.status === 'corrupt') {
        throw new DeviceLocalSecretKeyUnavailableError('stored_key_corrupt');
    }

    try {
        const created = getRandomBytes(DEVICE_LOCAL_SETTINGS_SECRET_KEY_BYTES);
        if (created.length !== DEVICE_LOCAL_SETTINGS_SECRET_KEY_BYTES) {
            throw new Error('Device-local random source returned an invalid key length');
        }
        const stored: StoredDeviceLocalSecretKeyV1 = {
            v: 1,
            key: encodeBase64(created, 'base64'),
        };
        await writeDeviceLocalStorageString(storageKey, JSON.stringify(stored));
        return created;
    } catch {
        // Missing local custody never grants permission to persist a raw secret.
        return null;
    }
}

export async function resolveDeviceLocalSettingsSecretsKey(
    scope: ServerAccountScope,
): Promise<Uint8Array | null> {
    const storageKey = await resolveStorageKey(scope);
    const pending = pendingResolutionByStorageKey.get(storageKey);
    if (pending) return await pending;

    const resolution = resolveForStorageKey(storageKey);
    pendingResolutionByStorageKey.set(storageKey, resolution);
    try {
        return await resolution;
    } finally {
        if (pendingResolutionByStorageKey.get(storageKey) === resolution) {
            pendingResolutionByStorageKey.delete(storageKey);
        }
    }
}
