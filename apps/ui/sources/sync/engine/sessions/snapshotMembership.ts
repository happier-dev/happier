type MembershipSubject = Readonly<{
    id: string;
    archivedAt?: number | null;
    meaningfulActivityAt?: number | null;
    access?: Readonly<{ role?: string; sources?: readonly Readonly<{ kind: string }>[] }> | null;
    effectiveAccess?: Readonly<{ level: string; sources: readonly Readonly<{ kind: string }>[] }>;
}>;

export type SessionReadObservation = Readonly<{
    session: MembershipSubject;
    observationCursor?: number;
}>;

export type SessionSnapshotObservation = Readonly<{
    observationCursor?: number;
    hasNext: boolean;
    nextCursor: string | null;
    metadataUpgradeRequiredCount?: number;
    append?: boolean;
}>;

/** Capture the exact response's observation without deriving access from list omissions. */
export function createSessionReadObservation() {
    let read: SessionReadObservation | undefined;
    return {
        observe: (next: SessionReadObservation): void => { read = next; },
        read: () => read,
    };
}

/** Ordinary pages add known Sessions; only access pushes or exact refusals retire them. */
export function reconcileSessionSnapshotMembership(params: Readonly<{
    previous: ReadonlySet<string>;
    sessionIds: readonly string[];
}>): Set<string> {
    const next = new Set(params.previous);
    for (const id of params.sessionIds) next.add(id);
    return next;
}
