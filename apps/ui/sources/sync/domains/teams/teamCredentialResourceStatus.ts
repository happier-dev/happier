import type { ScopedSnapshotError } from '@/sync/domains/scope/scopedSnapshotFacts';

/** The catalog owns currentness; missing data never establishes Home reachability. */
export type TeamCredentialResourceStatus =
    | Readonly<{ kind: 'pending' }>
    | Readonly<{ kind: 'current' }>
    | Readonly<{ kind: 'failed'; code: string; reason?: ScopedSnapshotError['kind'] }>
    | Readonly<{ kind: 'homeUnreachable' }>;

export type TeamCredentialResourceStatusByKey = ReadonlyMap<string, TeamCredentialResourceStatus>;
