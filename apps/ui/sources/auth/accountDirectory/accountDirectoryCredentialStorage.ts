import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import {
    readDeviceLocalStorageString,
    removeDeviceLocalStorageString,
    writeDeviceLocalStorageString,
} from '@/auth/storage/deviceLocalStorage';

/** Dedicated namespace; never share this key with Home credentials or OAuth continuations. */
export const ACCOUNT_DIRECTORY_CREDENTIALS_STORAGE_KEY = 'account_directory_auth_credentials';

type StoredCredentials = Readonly<{ token: string }>;
type StoredRecord = Readonly<{
    endpoint: string;
    credentials: StoredCredentials;
    updatedAt: number;
}>;

function normalizeEndpoint(value: string): string | null {
    const raw = String(value ?? '').trim();
    if (!raw) return null;
    try {
        const url = new URL(raw);
        if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
        url.hash = '';
        url.username = '';
        url.password = '';
        url.pathname = url.pathname.replace(/\/+$/, '');
        return url.toString().replace(/\/$/, '');
    } catch {
        return null;
    }
}

function isCredentials(value: unknown): value is StoredCredentials {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const token = (value as Record<string, unknown>).token;
    return typeof token === 'string' && token.trim().length > 0;
}

function parseRecords(value: unknown): StoredRecord[] {
    if (!Array.isArray(value)) return [];
    const records: StoredRecord[] = [];
    for (const candidate of value) {
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
        const row = candidate as Record<string, unknown>;
        const endpoint = typeof row.endpoint === 'string' ? normalizeEndpoint(row.endpoint) : null;
        const updatedAt = typeof row.updatedAt === 'number' && Number.isFinite(row.updatedAt)
            ? row.updatedAt
            : 0;
        if (!endpoint || !isCredentials(row.credentials)) continue;
        records.push({ endpoint, credentials: { token: row.credentials.token }, updatedAt });
    }
    return records;
}

async function readRecords(): Promise<StoredRecord[]> {
    const raw = await readDeviceLocalStorageString(ACCOUNT_DIRECTORY_CREDENTIALS_STORAGE_KEY);
    if (!raw) return [];
    try {
        return parseRecords(JSON.parse(raw));
    } catch {
        return [];
    }
}

async function writeRecords(records: readonly StoredRecord[]): Promise<boolean> {
    try {
        if (records.length === 0) {
            await removeDeviceLocalStorageString(ACCOUNT_DIRECTORY_CREDENTIALS_STORAGE_KEY);
        } else {
            await writeDeviceLocalStorageString(
                ACCOUNT_DIRECTORY_CREDENTIALS_STORAGE_KEY,
                JSON.stringify(records),
            );
        }
        return true;
    } catch {
        return false;
    }
}

export const accountDirectoryCredentialStorage = {
    async get(endpoint: string): Promise<AuthCredentials | null> {
        const normalized = normalizeEndpoint(endpoint);
        if (!normalized) return null;
        const record = (await readRecords()).find((candidate) => candidate.endpoint === normalized);
        return record ? { token: record.credentials.token } : null;
    },

    async set(endpoint: string, credentials: AuthCredentials): Promise<boolean> {
        const normalized = normalizeEndpoint(endpoint);
        if (!normalized || !isCredentials(credentials)) return false;
        const records = (await readRecords()).filter((candidate) => candidate.endpoint !== normalized);
        records.push({
            endpoint: normalized,
            credentials: { token: credentials.token },
            updatedAt: Date.now(),
        });
        // Keep the dedicated vault bounded; Account Service selection is one endpoint at a time,
        // while retaining a small set lets users switch custom relays without overwriting tokens.
        records.sort((left, right) => right.updatedAt - left.updatedAt);
        records.splice(16);
        return await writeRecords(records);
    },

    async remove(endpoint: string): Promise<boolean> {
        const normalized = normalizeEndpoint(endpoint);
        if (!normalized) return false;
        const records = await readRecords();
        const next = records.filter((candidate) => candidate.endpoint !== normalized);
        if (next.length === records.length) return true;
        return await writeRecords(next);
    },

    async clear(): Promise<boolean> {
        return await writeRecords([]);
    },
};

export function normalizeAccountDirectoryEndpoint(endpoint: string): string | null {
    return normalizeEndpoint(endpoint);
}
