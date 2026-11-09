import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { kvGet, kvMutate, type KvItem } from '@/sync/api/account/apiKv';
import { AccountStoredJsonContentModeMismatchError, encodeAccountStoredJsonContent } from '@/sync/encryption/accountStoredJsonContent';
import { openAccountKvJsonRow } from '@happier-dev/protocol/crypto/accountKvCipher';
import { createUiAccountKvCipher } from '@/sync/encryption/accountKvCipher';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import { isRawAccountStorageEncryption, resolveAccountStorageContext, type AccountStorageContext } from '@/sync/encryption/accountStorageContext';
import type { ServerFetch } from '@/sync/http/client';
import type { AccountEncryptionIdentity } from '@happier-dev/sync-client';

export type AccountKvJsonSnapshot = Readonly<{ value: unknown | null; version: number; tombstone?: true }>;
export type AccountKvJsonCompareAndSetResult = Readonly<{ success: true; version: number }>
    | (AccountKvJsonSnapshot & Readonly<{ success: false }>);
export type AccountKvJsonTransport = Readonly<{
    read: () => Promise<AccountKvJsonSnapshot>;
    compareAndSet: (value: unknown, version: number) => Promise<AccountKvJsonCompareAndSetResult>;
}>;

export class AccountKvScopeRetiredError extends Error {
    readonly code = 'account_kv_scope_retired';
    constructor() {
        super('The captured Account KV scope retired');
        this.name = 'AccountKvScopeRetiredError';
    }
}

/** All ordinary raw-JSON KV readers share lossless, version-CAS legacy re-sealing. */
export async function openUiAccountKvJsonRow(params: Readonly<{
    credentials: AuthCredentials;
    context: AccountStorageContext;
    row: Readonly<{ key: string; value: string | null; version: number }>;
    request: ServerFetch;
    requireCurrent: () => void;
}>): Promise<AccountKvJsonSnapshot> {
    const cipher = (context: AccountStorageContext) => createUiAccountKvCipher(context.mode, context.mode === 'plain' ? null
        : resolveAccountScopedCryptoMaterialFromCredentials(params.credentials));
    return await openAccountKvJsonRow({ row: params.row,
        cipher: {
            open: cipher(params.context).open,
            seal: async value => {
                // A legacy read becomes a write here. Its fresh sealing
                // authority cannot come from a still-unpublished socket fact.
                params.requireCurrent();
                const current = await resolveAccountStorageContext(params.credentials, {
                    request: params.request, encryption: params.context.encryption, usage: 'fresh-authority',
                });
                params.requireCurrent();
                if (current.mode !== params.context.mode) throw new AccountStoredJsonContentModeMismatchError();
                return await cipher(current).seal(value);
            },
        },
        requireCurrent: params.requireCurrent,
        compareAndSet: async (value, version) => {
            const result = await kvMutate(params.credentials, [{ key: params.row.key, value, version }], { request: params.request, retry: 'none' });
            if (result.success) {
                const row = result.results.find(row => row.key === params.row.key);
                if (!row) throw new Error('KV re-seal omitted its result');
                return { success: true, version: row.version };
            }
            const row = result.errors.find(row => row.key === params.row.key);
            if (!row) throw new Error('KV re-seal omitted its conflict');
            return { success: false, value: row.value, version: row.version };
        },
    });
}

/** Domain owners supply record parsing and reconciliation; this owner handles only opaque JSON/CAS. */
export function createAccountKvJsonTransport(params: Readonly<{
    credentials: AuthCredentials;
    key: string;
    request: ServerFetch;
    shouldContinue: () => boolean;
    encryption?: AccountStorageContext['encryption'];
    /** Share the containing read's identity; CAS and legacy re-sealing always acquire fresh authority. */
    readIdentity?: () => Promise<AccountEncryptionIdentity>;
}>): AccountKvJsonTransport {
    const checkCurrent = () => {
        if (!params.shouldContinue()) throw new AccountKvScopeRetiredError();
    };
    const whileCurrent = async <T,>(operation: () => Promise<T>): Promise<T> => {
        checkCurrent();
        try { return await operation(); }
        finally { checkCurrent(); }
    };
    const request: ServerFetch = (path, init, options) => whileCurrent(() => params.request(path, init, options));
    const requestOptions = { request, retry: 'none' as const };
    const decode = (row: Pick<KvItem, 'key' | 'version'> & Readonly<{ value: string | null }>, context: AccountStorageContext) =>
        openUiAccountKvJsonRow({ credentials: params.credentials, row, context, request, requireCurrent: checkCurrent });
    return {
        async read() {
            checkCurrent();
            const context = await whileCurrent(() => resolveAccountStorageContext(params.credentials, { request: params.request, usage: 'identity',
                ...(params.readIdentity ? { readIdentity: params.readIdentity } : {}),
                ...(params.encryption !== undefined ? { encryption: params.encryption } : {}) }));
            checkCurrent();
            const item = await kvGet(params.credentials, params.key, requestOptions);
            checkCurrent();
            if (!item) return { value: null, version: -1 };
            return await decode(item, context);
        },
        async compareAndSet(value, version) {
            checkCurrent();
            const context = await whileCurrent(() => resolveAccountStorageContext(params.credentials, { ...requestOptions, usage: 'fresh-authority',
                ...(params.encryption !== undefined ? { encryption: params.encryption } : {}) }));
            checkCurrent();
            const encoded = await whileCurrent(() => encodeAccountStoredJsonContent({
                mode: context.mode,
                value,
                encryption: isRawAccountStorageEncryption(context.encryption) ? context.encryption : null,
            }));
            checkCurrent();
            // Currentness was checked immediately before issuance. Preserve an
            // acknowledged write's receipt even if its captured scope then retires.
            const result = await kvMutate(params.credentials, [{ key: params.key, value: encoded, version }], {
                ...requestOptions, request: params.request,
            });
            if (result.success) {
                const stored = result.results.find(item => item.key === params.key);
                if (!stored) throw new Error('KV mutation omitted its result');
                return { success: true, version: stored.version };
            }
            checkCurrent();
            const conflict = result.errors.find(item => item.key === params.key);
            if (!conflict) throw new Error('KV mutation omitted its conflict');
            return { success: false, ...await decode(conflict, context) };
        },
    };
}
