import {
    createAccountDirectoryClient,
    type AccountDirectoryClient,
    type AccountDirectoryHomeEntryV1,
    type AccountDirectoryMeResponseV1,
} from '@/sync/api/accountDirectory/accountDirectoryClient';
import {
    accountDirectoryCredentialStorage,
    normalizeAccountDirectoryEndpoint,
} from '@/auth/accountDirectory/accountDirectoryCredentialStorage';

export type AccountDirectorySessionStatus = 'idle' | 'loading' | 'ready' | 'stale' | 'unsupported' | 'error';
export type AccountDirectorySessionSnapshot = Readonly<{
    endpoint: string;
    status: AccountDirectorySessionStatus;
    account: AccountDirectoryMeResponseV1 | null;
    homes: readonly AccountDirectoryHomeEntryV1[];
    preferredHomeServerIdentityId: string | null;
    refreshedAtMs: number | null;
    error: unknown | null;
}>;

type SessionOptions = Readonly<{
    client?: AccountDirectoryClient;
    capability?: Readonly<{ version?: number; homeDirectory?: boolean; homeEnrollment?: boolean }>;
}>;

function initialSnapshot(endpoint: string): AccountDirectorySessionSnapshot {
    return {
        endpoint,
        status: 'idle',
        account: null,
        homes: [],
        preferredHomeServerIdentityId: null,
        refreshedAtMs: null,
        error: null,
    };
}

export class AccountDirectorySession {
    private readonly listeners = new Set<(snapshot: AccountDirectorySessionSnapshot) => void>();
    private readonly client: AccountDirectoryClient;
    private readonly capability: SessionOptions['capability'];
    private snapshotValue: AccountDirectorySessionSnapshot;
    private refreshPromise: Promise<AccountDirectorySessionSnapshot> | null = null;

    constructor(endpoint: string, options: SessionOptions = {}) {
        const normalized = normalizeAccountDirectoryEndpoint(endpoint);
        if (!normalized) throw new Error('Invalid Account Service endpoint');
        this.snapshotValue = initialSnapshot(normalized);
        this.client = options.client ?? createAccountDirectoryClient(normalized);
        this.capability = options.capability;
    }

    get snapshot(): AccountDirectorySessionSnapshot {
        return this.snapshotValue;
    }

    subscribe(listener: (snapshot: AccountDirectorySessionSnapshot) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private update(next: AccountDirectorySessionSnapshot): void {
        this.snapshotValue = next;
        for (const listener of this.listeners) listener(next);
    }

    async refresh(): Promise<AccountDirectorySessionSnapshot> {
        if (this.refreshPromise) return await this.refreshPromise;
        if (this.capability && (this.capability.version !== 1 || this.capability.homeDirectory !== true)) {
            this.update({ ...this.snapshotValue, status: 'unsupported', error: null });
            return this.snapshotValue;
        }

        this.update({ ...this.snapshotValue, status: 'loading', error: null });
        this.refreshPromise = (async () => {
            try {
                const [account, homes] = await Promise.all([
                    this.client.getMe(),
                    this.client.listHomes(),
                ]);
                const next: AccountDirectorySessionSnapshot = {
                    ...this.snapshotValue,
                    status: 'ready',
                    account,
                    homes: homes.homes,
                    preferredHomeServerIdentityId: homes.preferredHomeServerIdentityId ?? null,
                    refreshedAtMs: Date.now(),
                    error: null,
                };
                this.update(next);
                return next;
            } catch (error) {
                const next: AccountDirectorySessionSnapshot = {
                    ...this.snapshotValue,
                    status: this.snapshotValue.homes.length > 0 ? 'stale' : 'error',
                    error,
                };
                this.update(next);
                return next;
            } finally {
                this.refreshPromise = null;
            }
        })();
        return await this.refreshPromise;
    }

    async logout(): Promise<boolean> {
        const removed = await accountDirectoryCredentialStorage.remove(this.snapshotValue.endpoint);
        this.update({ ...this.snapshotValue, account: null, status: 'idle', error: null });
        return removed;
    }
}

export function createAccountDirectorySession(endpoint: string, options?: SessionOptions): AccountDirectorySession {
    return new AccountDirectorySession(endpoint, options);
}
