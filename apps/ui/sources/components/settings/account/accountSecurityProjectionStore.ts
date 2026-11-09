import type { AccountSecurityGetResponseV1 } from '@happier-dev/protocol/auth/accountSecurity';

/**
 * The one client-side holder of the Account Security projection (encryption mode, sign-in email,
 * password enrolment) for the signed-in Account on the focused Home.
 *
 * Every reader goes through `readAccountSecurityProjection`, so concurrent readers of the same scope
 * (the Account page and the security page, or a remount) share one request, and a page that opens
 * after a read starts from the last-known answer instead of an empty section. It is memory-only and
 * holds one scope: a projection read for one Account/Home is never offered to another.
 */
type Entry = {
    scopeKey: string;
    projection: AccountSecurityGetResponseV1 | null;
    inFlight: Promise<AccountSecurityGetResponseV1> | null;
    /** Sequence of the newest read; only the newest read may replace the last-known answer. */
    latest: number;
};

let entry: Entry | null = null;

export function accountSecurityProjectionScopeKey(serverId: string, accountId: string): string {
    return `${serverId}\u0000${accountId}`;
}

/** The last projection read for this exact scope, or null. */
export function getLastKnownAccountSecurityProjection(scopeKey: string): AccountSecurityGetResponseV1 | null {
    return entry?.scopeKey === scopeKey ? entry.projection : null;
}

/**
 * Reads the projection for `scopeKey`, joining a read already in flight for the same scope. The
 * answer becomes the scope's last-known projection. A failure leaves the last-known answer in place
 * for the caller to decide how to present it; it never clears it to an empty state.
 */
export function readAccountSecurityProjection(
    scopeKey: string,
    read: () => Promise<AccountSecurityGetResponseV1>,
    options: Readonly<{ fresh?: boolean }> = {},
): Promise<AccountSecurityGetResponseV1> {
    if (entry?.scopeKey !== scopeKey) entry = { scopeKey, projection: null, inFlight: null, latest: 0 };
    const current = entry;
    // A read after a mutation must not join a read that started before it.
    if (current.inFlight && options.fresh !== true) return current.inFlight;
    const sequence = ++current.latest;
    const request = read().then((projection) => {
        if (entry === current && current.latest === sequence) current.projection = projection;
        return projection;
    }).finally(() => {
        if (current.inFlight === request) current.inFlight = null;
    });
    current.inFlight = request;
    return request;
}

/** Test seam: forget every held projection. */
export function resetAccountSecurityProjectionStoreForTests(): void {
    entry = null;
}
