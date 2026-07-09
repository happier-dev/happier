import {
    ProviderAccountUsageSnapshotV1Schema,
    type ConnectedServiceUsageSourceV1,
    type ProviderAccountUsageSnapshotV1,
} from '@happier-dev/protocol';
import {
    ProviderAccountUsageAdoptionV1Schema,
    type ProviderAccountUsageAdoptionV1,
} from './adoption';

import type { ProviderAccountUsagePersistenceScheduler } from './persistence';
import {
    type ProviderAccountUsageObservation,
    type ProviderAccountUsageStore,
} from './store';

type TrackedSessionLike = Readonly<{
    happySessionId?: unknown;
}>;

function normalizeSessionId(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function findTrackedSession(
    children: ReadonlyArray<TrackedSessionLike | unknown>,
    sessionId: string,
): TrackedSessionLike | null {
    const normalized = normalizeSessionId(sessionId);
    if (!normalized) return null;
    return (children as ReadonlyArray<TrackedSessionLike>)
        .find((child) => normalizeSessionId(child.happySessionId) === normalized) ?? null;
}

export async function recordProviderAccountUsageSnapshotForSession(input: Readonly<{
    getChildren: () => ReadonlyArray<TrackedSessionLike | unknown>;
    store: Pick<ProviderAccountUsageStore, 'recordSnapshot' | 'resolveRecordId'>;
    persistence: Pick<ProviderAccountUsagePersistenceScheduler, 'recordInBandSnapshot'> | null;
    publishRecordId?: (input: Readonly<{ sessionId: string; recordId: string }>) => Promise<void>;
    observation?: Readonly<{
        sources?: readonly ConnectedServiceUsageSourceV1[];
    }>;
    sessionId: string;
    snapshot: ProviderAccountUsageSnapshotV1;
}>): Promise<
    | Readonly<{ status: 'recorded'; recordId: string; persisted: boolean }>
    | Readonly<{ status: 'session_not_found' }>
> {
    const tracked = findTrackedSession(input.getChildren(), input.sessionId);
    if (!tracked) return { status: 'session_not_found' };

    const snapshot = ProviderAccountUsageSnapshotV1Schema.parse(input.snapshot);
    const observation: ProviderAccountUsageObservation = {
        ...(input.observation?.sources ? { sources: input.observation.sources } : {}),
    };
    const recorded = input.store.recordSnapshot(snapshot, observation);

    let persisted = false;
    if (input.persistence) {
        try {
            const persistedSnapshot = input.store.resolveRecordId(recorded.recordId) ?? snapshot;
            await input.persistence.recordInBandSnapshot(
                persistedSnapshot,
                input.observation?.sources?.length ? { sources: input.observation.sources } : undefined,
            );
            persisted = true;
        } catch {
            persisted = false;
        }
    }

    if (persisted) {
        try {
            await input.publishRecordId?.({
                sessionId: input.sessionId,
                recordId: recorded.recordId,
            });
        } catch {
            // Session metadata refs are a best-effort projection over the canonical persisted record.
        }
    }

    return { status: 'recorded', recordId: recorded.recordId, persisted };
}

export async function recordProviderAccountUsageAdoptionForSession(input: Readonly<{
    getChildren: () => ReadonlyArray<TrackedSessionLike | unknown>;
    store: Pick<ProviderAccountUsageStore, 'applyAdoption' | 'resolveRecordId'>;
    persistence: Pick<ProviderAccountUsagePersistenceScheduler, 'recordInBandSnapshot'> | null;
    publishRecordId?: (input: Readonly<{ sessionId: string; recordId: string }>) => Promise<void>;
    sessionId: string;
    adoption: ProviderAccountUsageAdoptionV1;
}>): Promise<
    | Readonly<{ status: 'adopted' | 'already_adopted'; fromRecordId: string; toRecordId: string; persisted: boolean }>
    | Readonly<{ status: 'session_not_found' }>
> {
    const tracked = findTrackedSession(input.getChildren(), input.sessionId);
    if (!tracked) return { status: 'session_not_found' };
    const adoption = ProviderAccountUsageAdoptionV1Schema.parse(input.adoption);
    const applied = input.store.applyAdoption(adoption);
    let persisted = false;
    const snapshot = input.store.resolveRecordId(applied.toRecordId);
    if (snapshot && input.persistence) {
        try {
            await input.persistence.recordInBandSnapshot(snapshot);
            persisted = true;
        } catch {
            persisted = false;
        }
    }
    if (persisted) {
        try {
            await input.publishRecordId?.({
                sessionId: input.sessionId,
                recordId: applied.toRecordId,
            });
        } catch {
            // Usage display metadata is a best-effort projection over the canonical persisted record.
        }
    }
    return {
        status: applied.status,
        fromRecordId: applied.fromRecordId,
        toRecordId: applied.toRecordId,
        persisted,
    };
}
