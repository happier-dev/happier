import {
  ProviderAccountUsageAdoptionV1Schema,
  ProviderAccountUsageSnapshotV1Schema,
  normalizeProviderAccountUsageAliases,
  type ProviderAccountUsageAdoptionV1,
  type ProviderAccountUsageSnapshotV1,
} from '@happier-dev/protocol';

import type { TrackedSession } from '@/daemon/types';
import type { ProviderAccountUsagePersistenceScheduler } from './persistence';
import type { ProviderAccountUsageStore } from './store';

function normalizeSessionId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function findTrackedSession(
  children: ReadonlyArray<TrackedSession | unknown>,
  sessionId: string,
): TrackedSession | null {
  const normalized = normalizeSessionId(sessionId);
  if (!normalized) return null;
  return (children as ReadonlyArray<TrackedSession>)
    .find((child) => normalizeSessionId(child.happySessionId) === normalized) ?? null;
}

export async function recordProviderAccountUsageSnapshotForSession(input: Readonly<{
  getChildren: () => ReadonlyArray<TrackedSession | unknown>;
  store: ProviderAccountUsageStore;
  persistence: Pick<ProviderAccountUsagePersistenceScheduler, 'recordInBandSnapshot'> | null;
  publishRecordId?: (input: Readonly<{ sessionId: string; recordId: string }>) => Promise<void>;
  sessionId: string;
  snapshot: ProviderAccountUsageSnapshotV1;
}>): Promise<
  | Readonly<{ status: 'recorded'; recordId: string; persisted: boolean }>
  | Readonly<{ status: 'session_not_found' }>
> {
  const tracked = findTrackedSession(input.getChildren(), input.sessionId);
  if (!tracked) return { status: 'session_not_found' };
  const parsed = ProviderAccountUsageSnapshotV1Schema.parse(input.snapshot);
  const snapshot = ProviderAccountUsageSnapshotV1Schema.parse({
    ...parsed,
    aliases: normalizeProviderAccountUsageAliases([
      ...parsed.aliases,
      {
        kind: 'runtimeSession',
        providerId: parsed.providerId,
        sessionId: input.sessionId,
        accountSubjectId: parsed.recordKey.accountSubjectId,
      },
    ]),
  });
  const recorded = input.store.recordSnapshot(snapshot);
  let persisted = false;
  if (input.persistence) {
    try {
      await input.persistence.recordInBandSnapshot(input.store.resolveRecordId(recorded.recordId) ?? snapshot);
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
      // Usage display metadata is a best-effort projection over the canonical persisted record.
    }
  }
  return { status: 'recorded', recordId: recorded.recordId, persisted };
}

export async function recordProviderAccountUsageAdoptionForSession(input: Readonly<{
  getChildren: () => ReadonlyArray<TrackedSession | unknown>;
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
