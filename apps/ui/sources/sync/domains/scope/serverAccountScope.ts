export type ServerAccountScope = Readonly<{
    serverId: string;
    accountId: string;
}>;

function normalizeServerAccountScopePart(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

export function createServerAccountScope(serverId: unknown, accountId: unknown): ServerAccountScope | null {
    const normalizedServerId = normalizeServerAccountScopePart(serverId);
    const normalizedAccountId = normalizeServerAccountScopePart(accountId);
    if (!normalizedServerId || !normalizedAccountId) return null;
    return {
        serverId: normalizedServerId,
        accountId: normalizedAccountId,
    };
}

export function areServerAccountScopesEqual(
    a: ServerAccountScope | null | undefined,
    b: ServerAccountScope | null | undefined,
): boolean {
    if (!a || !b) return false;
    return a.serverId === b.serverId && a.accountId === b.accountId;
}

function encodeScopePart(value: string): string {
    return `${value.length}:${value}`;
}

export function serverAccountScopeKeySuffix(scope: ServerAccountScope): string {
    return `${encodeScopePart(scope.serverId)}${encodeScopePart(scope.accountId)}`;
}

export function serverAccountScopedStorageKey(prefix: string, scope: ServerAccountScope): string {
    return `${prefix}:${serverAccountScopeKeySuffix(scope)}`;
}
