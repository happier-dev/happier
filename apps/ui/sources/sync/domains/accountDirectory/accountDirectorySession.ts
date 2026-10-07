import {
    AccountDirectoryCapabilitiesSchema,
    type AccountDirectoryCapabilities,
} from '@happier-dev/protocol/features/payload/capabilities/accountDirectoryCapabilities';
import {
    createAccountDirectoryClient,
    type AccountDirectoryClient,
    type AccountDirectoryHomeEntryV1,
    type AccountDirectoryMeResponseV1,
    type HomeConnectionDescriptorV1,
} from '@/sync/api/accountDirectory/accountDirectoryClient';
import type { AccountDirectoryCredentialCustody, AccountDirectoryCredentialTarget } from '@/auth/storage/tokenStorage';
import type { AccountDirectoryAuthTransport } from '@/auth/accountDirectory/accountDirectoryAuthClient';
import {
    normalizeAccountDirectoryEndpoint,
} from '@/auth/accountDirectory/accountDirectoryCredentialStorage';
import type { AccountServiceDirectoryAdoptionResult } from '@happier-dev/cli-common/accountService';

export type AccountDirectorySessionStatus = 'idle' | 'loading' | 'ready' | 'stale' | 'unsupported' | 'error';
export type AccountDirectoryReconciliationResult =
    | Readonly<{ kind: 'not_run' }>
    | Readonly<{
        kind: 'snapshot_unavailable';
        snapshotStatus: Exclude<AccountDirectorySessionStatus, 'ready'>;
        error: unknown | null;
    }>
    | AccountServiceDirectoryAdoptionResult;
export type AccountDirectorySessionSnapshot = Readonly<{
    endpoint: string;
    status: AccountDirectorySessionStatus;
    homes: readonly AccountDirectoryHomeEntryV1[];
    preferredHomeServerIdentityId: string | null;
    refreshedAtMs: number | null;
    error: unknown | null;
    reconciliation: AccountDirectoryReconciliationResult;
    /** Who is signed in (`/me`), read with the Homes; the last known answer survives a failed read. */
    account: AccountDirectoryMeResponseV1 | null;
}>;

type SessionOptions = Readonly<{
    client?: AccountDirectoryClient;
    capability: AccountDirectoryCapabilities;
    keyAuthSecret?: Uint8Array;
    transport?: AccountDirectoryAuthTransport;
    credentialCustody?: AccountDirectoryCredentialCustody;
}>;

export function createAccountDirectoryServiceKey(target: Readonly<{
    endpoint: string;
    serverIdentityId?: string | null;
}>): string {
    const endpoint = normalizeAccountDirectoryEndpoint(target.endpoint);
    const serverIdentityId = target.serverIdentityId?.trim() ?? '';
    return `${endpoint}\u0000${serverIdentityId}`;
}

export function parseAccountDirectoryCapability(value: unknown): AccountDirectoryCapabilities | null {
    const parsed = AccountDirectoryCapabilitiesSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
}

function initialSnapshot(endpoint: string): AccountDirectorySessionSnapshot {
    return {
        endpoint,
        status: 'idle',
        homes: [],
        preferredHomeServerIdentityId: null,
        refreshedAtMs: null,
        error: null,
        reconciliation: { kind: 'not_run' },
        account: null,
    };
}

export class AccountDirectorySession {
    private readonly listeners = new Set<(snapshot: AccountDirectorySessionSnapshot) => void>();
    private readonly client: AccountDirectoryClient;
    private readonly capability: AccountDirectoryCapabilities | null;
    private snapshotValue: AccountDirectorySessionSnapshot;
    private refreshPromise: Promise<AccountDirectorySessionSnapshot> | null = null;
    private lifecycleRevision = 0;
    private readonly credentialTarget: AccountDirectoryCredentialTarget;
    private keyAuthSecret: Uint8Array | null;

    constructor(target: AccountDirectoryCredentialTarget, options: SessionOptions) {
        const normalized = normalizeAccountDirectoryEndpoint(target.endpoint);
        if (!normalized) throw new Error('Invalid Account Service endpoint');
        const serverIdentityId = target.serverIdentityId.trim();
        if (!serverIdentityId) throw new Error('Account Service identity is required');
        this.credentialTarget = { endpoint: normalized, serverIdentityId };
        this.keyAuthSecret = options.keyAuthSecret?.slice() ?? null;
        this.snapshotValue = initialSnapshot(normalized);
        this.client = options.client ?? createAccountDirectoryClient(
            this.credentialTarget,
            options.transport,
            options.credentialCustody,
        );
        this.capability = parseAccountDirectoryCapability(options.capability);
    }

    get snapshot(): AccountDirectorySessionSnapshot {
        return this.snapshotValue;
    }

    get supportsHomeEnrollment(): boolean {
        return this.capability?.homeEnrollment === true;
    }

    get serviceKey(): string {
        return createAccountDirectoryServiceKey(this.credentialTarget);
    }

    captureLifecycle(): () => boolean {
        const revision = this.lifecycleRevision;
        return () => revision === this.lifecycleRevision && this.client.isCurrent();
    }

    takeKeyAuthSecret(): Uint8Array | null {
        const secret = this.keyAuthSecret;
        this.keyAuthSecret = null;
        return secret;
    }

    subscribe(listener: (snapshot: AccountDirectorySessionSnapshot) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    async requestLoginAssertion(homeServerIdentityId: string, clientBoxPublicKeyBase64: string) {
        if (!this.supportsHomeEnrollment) {
            throw new Error('Account Service Home enrollment is unsupported');
        }
        return await this.client.requestLoginAssertion(homeServerIdentityId, { clientBoxPublicKeyBase64 });
    }

    /**
     * Reads who is signed in (`/me`) into the snapshot. It only presents the account, so a failed
     * read keeps the last known identity; Home flows that refresh the directory do not pay for it.
     */
    async refreshAccount(): Promise<AccountDirectoryMeResponseV1 | null> {
        const isCurrent = this.captureLifecycle();
        try {
            const account = await this.client.getMe();
            if (!isCurrent()) return this.snapshotValue.account;
            this.update({ ...this.snapshotValue, account });
            return account;
        } catch {
            return this.snapshotValue.account;
        }
    }

    /** Minimal authenticated account projection; the subject used for Home relationship provisioning. */
    async readAccountSummary(): Promise<AccountDirectoryMeResponseV1> {
        return await this.client.getMe();
    }

    /** Idempotent directory publication of one Home entry; requires the advertised Home directory capability. */
    async putHome(home: Readonly<{
        homeServerIdentityId: string;
        label: string;
        connectionDescriptor: HomeConnectionDescriptorV1;
    }>): Promise<AccountDirectoryHomeEntryV1> {
        if (this.capability?.homeDirectory !== true) {
            this.update({ ...this.snapshotValue, status: 'unsupported', error: null });
            throw new Error('Account Service Home directory is unsupported');
        }
        return await this.client.putHome(home);
    }

    /**
     * Publishes the destination Home's exact committed descriptor. Directory
     * persists and reads it back; only the Home allocates its revision.
     */
    async publishHomeDescriptor(home: Readonly<{
        homeServerIdentityId: string;
        label: string;
        connectionDescriptor: HomeConnectionDescriptorV1;
    }>) {
        if (this.capability?.homeDirectory !== true) {
            this.update({ ...this.snapshotValue, status: 'unsupported', error: null });
            throw new Error('Account Service Home directory is unsupported');
        }
        return await this.client.publishHomeDescriptor(home);
    }

    /** Fresh authoritative readback used to reconcile a lost publication response. */
    async readHomeDescriptor(homeServerIdentityId: string) {
        if (this.capability?.homeDirectory !== true) {
            this.update({ ...this.snapshotValue, status: 'unsupported', error: null });
            throw new Error('Account Service Home directory is unsupported');
        }
        return await this.client.readHomeDescriptor(homeServerIdentityId);
    }

    /** Updates only the Account Service recommendation; callers refresh the projection afterwards. */
    async setPreferredHome(homeServerIdentityId: string) {
        if (this.capability?.homeDirectory !== true) {
            this.update({ ...this.snapshotValue, status: 'unsupported', error: null });
            throw new Error('Account Service Home directory is unsupported');
        }
        return await this.client.setPreferredHome(homeServerIdentityId);
    }

    /** Removes only Directory metadata; local Home profiles and credentials are outside this owner. */
    async deleteHome(homeServerIdentityId: string) {
        if (this.capability?.homeDirectory !== true) {
            this.update({ ...this.snapshotValue, status: 'unsupported', error: null });
            throw new Error('Account Service Home directory is unsupported');
        }
        return await this.client.deleteHome(homeServerIdentityId);
    }

    private update(next: AccountDirectorySessionSnapshot): void {
        this.snapshotValue = next;
        for (const listener of this.listeners) listener(next);
    }

    /** Publishes the result of reconciling the current Directory snapshot into local Home profiles. */
    recordReconciliation(result: AccountDirectoryReconciliationResult): AccountDirectorySessionSnapshot {
        this.update({ ...this.snapshotValue, reconciliation: result });
        return this.snapshotValue;
    }

    async refresh(): Promise<AccountDirectorySessionSnapshot> {
        if (this.refreshPromise) return await this.refreshPromise;
        if (this.capability?.homeDirectory !== true) {
            this.update({ ...this.snapshotValue, status: 'unsupported', error: null });
            return this.snapshotValue;
        }

        const isCurrent = this.captureLifecycle();
        if (!isCurrent()) return this.snapshotValue;
        this.update({ ...this.snapshotValue, status: 'loading', error: null });
        this.refreshPromise = (async () => {
            try {
                const homes = await this.client.listHomes();
                if (!isCurrent()) return this.snapshotValue;
                const next: AccountDirectorySessionSnapshot = {
                    ...this.snapshotValue,
                    status: 'ready',
                    homes: homes.homes,
                    preferredHomeServerIdentityId: homes.preferredHomeServerIdentityId ?? null,
                    refreshedAtMs: Date.now(),
                    error: null,
                    reconciliation: { kind: 'not_run' },
                };
                this.update(next);
                return next;
            } catch (error) {
                if (!isCurrent()) return this.snapshotValue;
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
        this.lifecycleRevision += 1;
        this.keyAuthSecret?.fill(0);
        this.keyAuthSecret = null;
        const removed = await this.client.logout();
        this.update(initialSnapshot(this.snapshotValue.endpoint));
        return removed;
    }
}

export function createAccountDirectorySession(target: AccountDirectoryCredentialTarget, options: SessionOptions): AccountDirectorySession {
    return new AccountDirectorySession(target, options);
}
