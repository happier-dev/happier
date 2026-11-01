import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

type ProjectionCurrentness = Readonly<{
    projectionRevision: number;
    locale: string;
    accountScope?: ServerAccountScope | null;
}>;

/** The Machine writer and connection lifecycle own invalidation, not elapsed time. */
export function matchesProjectionCurrentness(entry: ProjectionCurrentness, current: ProjectionCurrentness): boolean {
    return entry.projectionRevision === current.projectionRevision && entry.locale === current.locale
        && (entry.accountScope === current.accountScope
            || areServerAccountScopesEqual(entry.accountScope ?? null, current.accountScope ?? null));
}

/** Only a caller's explicit freshness requirement imposes an age boundary. */
export function entryIsFresh(entry: Readonly<{ fetchedAtMs: number }>, staleMs?: number): boolean {
    if (staleMs === undefined) return true;
    const ageMs = Date.now() - entry.fetchedAtMs;
    return ageMs >= 0 && ageMs <= staleMs;
}
