/** @moduleRealm daemon */
import type {
    PluginAccountCollectionDefinition,
    PluginAccountCollectionForDefinition,
} from './collections.js';
import { PluginError } from './errors.js';
import type { JsonValue } from './identity.js';
import type { DaemonDatabaseStorageScope } from './storage/database.js';

/** Every generic KV scope is host-authoritative; no replica merge model exists. */
export type StorageConsistency = Readonly<{ kind: 'authoritativeSerializable' }>;

export interface StorageTransaction {
    get<T extends JsonValue = JsonValue>(
        key: string,
        options?: { signal?: AbortSignal },
    ): Promise<T | null>;
    set(
        key: string,
        value: JsonValue,
        options?: { signal?: AbortSignal },
    ): Promise<void>;
    delete(key: string, options?: { signal?: AbortSignal }): Promise<void>;
}

export interface StorageScopeService extends StorageTransaction {
    consistency(): StorageConsistency;
    list(options?: {
        cursor?: string;
        limit?: number;
        prefix?: string;
        signal?: AbortSignal;
    }): Promise<{
        items: readonly Readonly<{ key: string }>[];
        nextCursor?: string;
    }>;
    transaction<T>(
        operation: (transaction: StorageTransaction) => Promise<T>,
        options?: { signal?: AbortSignal },
    ): Promise<T>;
}

/**
 * A retained Account-KV identity. A deleted entry is intentionally visible so
 * an author can use its version to revive that exact key without making stale
 * `expectedVersion: 'absent'` writes able to resurrect it.
 */
export type AccountKvEntry<TValue extends JsonValue = JsonValue> =
    | Readonly<{
        version: number;
        value: TValue;
    }>
    | Readonly<{
        version: number;
        deleted: true;
    }>;

export type AccountKvListItem = Readonly<{
    key: string;
}> & AccountKvEntry;

export interface AccountKvTransaction {
    get<TValue extends JsonValue = JsonValue>(
        key: string,
        options?: Readonly<{ signal?: AbortSignal }>,
    ): Promise<AccountKvEntry<TValue> | null>;
    set(
        key: string,
        value: JsonValue,
        options: Readonly<{ expectedVersion: number | 'absent'; signal?: AbortSignal }>,
    ): Promise<Readonly<{ version: number }>>;
    delete(
        key: string,
        options: Readonly<{ expectedVersion: number; signal?: AbortSignal }>,
    ): Promise<Readonly<{ version: number; deleted: true }>>;
}

/**
 * Account KV is distinct from generic daemon/session storage: it exposes
 * author-visible per-key CAS while the host retains one opaque Account-row
 * CAS internally for atomic persistence.
 */
export interface AccountKvService extends AccountKvTransaction {
    list(options?: Readonly<{
        cursor?: string;
        limit?: number;
        prefix?: string;
        signal?: AbortSignal;
    }>): Promise<Readonly<{
        items: readonly AccountKvListItem[];
        nextCursor?: string;
    }>>;
    transaction<T>(
        operation: (transaction: AccountKvTransaction) => Promise<T>,
        options?: Readonly<{ signal?: AbortSignal }>,
    ): Promise<T>;
}

/**
 * Account data is authenticated and Account-mode bound by the host. It is not
 * a Settings facade and never falls back to daemon-local storage.
 */
export interface PluginAccountStorageScope {
    readonly kv: AccountKvService;
    collection<TDefinition extends PluginAccountCollectionDefinition>(
        definition: TDefinition,
    ): PluginAccountCollectionForDefinition<TDefinition>;
}

/**
 * The context shape `requireAccountStorage` reads: any plugin value carrying
 * the services bag, which is what every Action handler and runtime already has.
 */
export type PluginAccountStorageConsumerContext = Readonly<{
    services: Readonly<{
        storage: Readonly<{
            account?: PluginAccountStorageScope;
        }>;
    }>;
}>;

/**
 * Narrow admitted Account storage, or fail closed with the caller's own error.
 *
 * A plugin that declares Account storage as required is normally refused by the
 * host before its code runs when that capability is unavailable, so this guard
 * is for the malformed direct invocation that arrives anyway. It lives here
 * because three first-party plugins had each written a byte-identical copy of
 * it; the one thing that ever differed between them was the error identity,
 * which is why that stays the caller's rather than being flattened into a
 * single shared code.
 */
export function requireAccountStorage(
    context: PluginAccountStorageConsumerContext,
    failure: Readonly<{ code: string; message: string }>,
): PluginAccountStorageScope {
    const account = context.services.storage.account;
    if (account === undefined) throw new PluginError(failure);
    return account;
}

export interface StorageService {
    readonly ephemeral: StorageScopeService;
    readonly daemonSession: StorageScopeService;
    readonly daemon: DaemonDatabaseStorageScope;
    /** Present only when Account Data is admitted and currently available. */
    readonly account?: PluginAccountStorageScope;
}
