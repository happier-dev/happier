import { describe, expect, it } from 'vitest';
import {
  buildProviderAccountUsageRecordId,
  ProviderAccountUsageSnapshotV1Schema,
  ProviderAccountUsageSnapshotV1StoredSchema,
} from './providerAccountUsagePrimitives.js';

describe('retained Provider account usage snapshots', () => {
  it('projects known facts while preserving record correspondence and strict fresh admission', () => {
    const recordKey = { providerId: 'provider', accountSubjectId: 'subject',
      subjectKind: 'account' as const, quotaScope: 'account' as const };
    const canonical = ProviderAccountUsageSnapshotV1Schema.parse({ v: 1,
      recordId: buildProviderAccountUsageRecordId(recordKey), recordKey,
      providerId: 'provider', accountSubject: { kind: 'providerSubject', id: 'subject' },
      observedAtMs: 1, fetchedAtMs: 2, staleAfterMs: 10,
      source: 'providerHttp', confidence: 'confirmed', meters: [{ meterId: 'balance', label: 'Balance',
        used: null, remaining: -0.0123, limit: null, unit: 'usd', utilizationPct: null,
        resetsAt: null, status: 'ok' }] });
    expect(canonical.meters[0]?.currency).toBe('USD');
    const retained = { ...canonical, retired: true,
      meters: canonical.meters.map(({ currency: _currency, ...meter }) => meter),
      recordKey: { ...canonical.recordKey, retired: true },
      accountSubject: { ...canonical.accountSubject, retired: true } };
    expect(ProviderAccountUsageSnapshotV1StoredSchema.parse(retained)).toEqual(canonical);
    expect(ProviderAccountUsageSnapshotV1Schema.safeParse(retained).success).toBe(false);
    expect(ProviderAccountUsageSnapshotV1StoredSchema.safeParse({ ...retained,
      accountSubject: { ...retained.accountSubject, id: 'foreign' } }).success).toBe(false);
    expect(ProviderAccountUsageSnapshotV1StoredSchema.safeParse({ ...retained,
      observedAtMs: -1 }).success).toBe(false);
  });
});
