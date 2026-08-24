export const ACCOUNT_SESSION_DRAFT_KV_PREFIX = '@happier/account/session-draft/v1/';
export const ACCOUNT_SCOPED_KV_MAX_PERSISTED_KEY_UTF8_BYTES = 191;

export type ReservedAccountScopedKvRow = Readonly<{
    kind: 'accountSessionDraft';
}>;

export function classifyReservedAccountScopedKvKey(key: string): ReservedAccountScopedKvRow | null {
    return key.startsWith(ACCOUNT_SESSION_DRAFT_KV_PREFIX)
        ? { kind: 'accountSessionDraft' }
        : null;
}

export function isPublicAccountScopedKvKey(key: string): boolean {
    return classifyReservedAccountScopedKvKey(key) === null;
}
