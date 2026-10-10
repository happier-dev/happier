import type { z } from 'zod';
import { ProviderAccountUsageSnapshotV1Schema } from './providerAccountUsagePrimitives.js';
export { ProviderAccountUsageHistoryCursorV1Schema, ProviderAccountUsageHistoryWitnessV1Schema } from './providerAccountUsagePrimitives.js';
import { QualifiedProviderAccountUsageRecordResponseV4Schema } from './qualifiedConnectedAccountProjectionsV4.js';
import { deriveProviderAccountUsagePace, deriveProviderAccountUsageUnusedCapacity } from './deriveProviderAccountUsagePace.js';
import type { UsagePacingTargetsV1Schema } from '../account/settings/usagePacingPreferencesV1.js';
import type { AccountScopedCryptoMaterial } from '../crypto/accountScopedCipher.js';
import type { ProviderAccountUsageSnapshotV1 } from './providerAccountUsagePrimitives.js';
import { openSealedProviderAccountUsageSnapshot } from './accountUsage.js';
import type { ProviderAccountSubscriptionMonthlyPriceV1 } from './accountSubscription.js';
import {
  ConnectedServiceQuotaGetResultV1Schema, OpenedProviderAccountUsageHistoryPageV1Schema,
  type ConnectedServiceQuotaGetInputV1, type ConnectedServiceQuotaGetResultV1,
  type ProviderAccountUsageWaitingWorkV1, type QualifiedProviderAccountUsageHistoryResponseV4Schema,
} from './providerAccountUsageHistorySchemasV1.js';
export {
  ProviderAccountUsageHistoryRangeV1Schema, ProviderAccountUsageHistoryRequestV1Schema,
  QualifiedProviderAccountUsageHistoryRequestV4Schema, QualifiedProviderAccountUsageHistoryResponseV4Schema,
  OpenedProviderAccountUsageHistoryPageV1Schema, ConnectedServiceQuotaGetInputV1Schema,
  ProviderAccountUsageWaitingWorkV1Schema, ConnectedServiceQuotaGetResultV1Schema,
  type ProviderAccountUsageHistoryRequestV1, type ProviderAccountUsageHistoryWitnessV1,
  type ConnectedServiceQuotaGetInputV1, type ConnectedServiceQuotaGetResultV1,
  type ProviderAccountUsageWaitingWorkV1,
} from './providerAccountUsageHistorySchemasV1.js';
export function projectProviderAccountUsageQuotaReadV1(input: Readonly<{ input: ConnectedServiceQuotaGetInputV1; current: ProviderAccountUsageSnapshotV1 | null; history?: z.infer<typeof OpenedProviderAccountUsageHistoryPageV1Schema>; nowMs: number; targets?: z.infer<typeof UsagePacingTargetsV1Schema>; waitingWork?: ProviderAccountUsageWaitingWorkV1 }>): ConnectedServiceQuotaGetResultV1 {
  return ConnectedServiceQuotaGetResultV1Schema.parse({ source: input.input.source, current: input.current,
    ...(input.history ? { history: input.history } : {}),
    unusedCapacity: deriveProviderAccountUsageUnusedCapacity({ history: input.history?.entries.map(entry => entry.snapshot), partial: input.history?.nextCursor != null, nowMs: input.nowMs }),
    pace: input.current?.meters.map(meter => ({ meterId: meter.meterId, value: deriveProviderAccountUsagePace({ snapshot: input.current!, meterId: meter.meterId, nowMs: input.nowMs, history: input.history?.entries.map(entry => entry.snapshot) }) })) ?? [], targets: input.targets ?? [], waitingWork: input.waitingWork ?? { status: 'unavailable', reason: 'read_failed' } });
}

export class ProviderAccountUsageReadErrorV1 extends Error {
  constructor(readonly code: 'provider_account_usage_content_mode_mismatch' | 'provider_account_usage_content_unavailable' | 'provider_account_usage_identity_mismatch') {
    super(code);
    this.name = 'ProviderAccountUsageReadErrorV1';
  }
}

export function openProviderAccountUsageRecordV4(input: Readonly<{ recordId: string; enteredMonthlyPrice?: ProviderAccountSubscriptionMonthlyPriceV1; accountMode: 'plain' | 'e2ee'; material?: AccountScopedCryptoMaterial; record: z.infer<typeof QualifiedProviderAccountUsageRecordResponseV4Schema> }>): ProviderAccountUsageSnapshotV1 {
  const record = QualifiedProviderAccountUsageRecordResponseV4Schema.parse(input.record);
  if ((input.accountMode === 'plain') !== (record.content.t === 'plain')) throw new ProviderAccountUsageReadErrorV1('provider_account_usage_content_mode_mismatch');
  let snapshot: ProviderAccountUsageSnapshotV1 | null;
  if (record.content.t === 'plain') {
    const parsed = ProviderAccountUsageSnapshotV1Schema.safeParse(record.content.v);
    snapshot = parsed.success ? parsed.data : null;
  } else {
    if (!input.material) throw new ProviderAccountUsageReadErrorV1('provider_account_usage_content_unavailable');
    snapshot = openSealedProviderAccountUsageSnapshot({ material: input.material, sealed: { format: 'account_scoped_v1', ciphertext: record.content.c, ...(record.content.subscription ? { subscription: record.content.subscription } : {}) } });
  }
  if (!snapshot) throw new ProviderAccountUsageReadErrorV1('provider_account_usage_content_unavailable');
  if (snapshot.recordId !== input.recordId || snapshot.fetchedAtMs !== record.metadata.fetchedAt || snapshot.staleAfterMs !== record.metadata.staleAfterMs) throw new ProviderAccountUsageReadErrorV1('provider_account_usage_identity_mismatch');
  // A provider observation cannot supply the independent user-owned price.
  if (snapshot.subscription) {
    const { enteredMonthlyPrice: _ignored, ...subscription } = snapshot.subscription;
    snapshot = { ...snapshot, subscription: { ...subscription, ...(input.enteredMonthlyPrice ? { enteredMonthlyPrice: input.enteredMonthlyPrice } : {}) } };
  }
  return snapshot;
}

export function openProviderAccountUsageHistoryPageV4(input: Readonly<{ recordId: string; accountMode: 'plain' | 'e2ee'; material?: AccountScopedCryptoMaterial; page: z.infer<typeof QualifiedProviderAccountUsageHistoryResponseV4Schema> }>): z.infer<typeof OpenedProviderAccountUsageHistoryPageV1Schema> {
  return OpenedProviderAccountUsageHistoryPageV1Schema.parse({ entries: input.page.entries.map(entry => {
    const snapshot = openProviderAccountUsageRecordV4({ ...input, record: entry.record });
    if (snapshot.fetchedAtMs !== entry.observedAtMs) throw new ProviderAccountUsageReadErrorV1('provider_account_usage_identity_mismatch');
    return { id: entry.id, observedAtMs: entry.observedAtMs, snapshot };
  }), nextCursor: input.page.nextCursor });
}
