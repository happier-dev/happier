import { z } from 'zod/mini';
export * from './providerAccountUsagePageProjection.js';
import { getProviderAccountUsageQuotaPageFactsV1, getProviderAccountUsageQuotaHistoryV1, type PackedProviderAccountUsagePageProjectionV1Schema } from './providerAccountUsagePageProjection.js';
import { serializeProviderAccountUsageSnapshotMaterialV1 } from './providerAccountUsagePrimitives.js';
import { parseBuiltInLegacyProviderAccountUsageSnapshotV1 } from './legacyConnectedServiceCompatibility.js';
export { ProviderAccountUsageHistoryCursorV1Schema, ProviderAccountUsageHistoryWitnessV1Schema } from './providerAccountUsagePrimitives.js';
import { QualifiedProviderAccountUsageRecordResponseV4Schema } from './qualifiedConnectedAccountProjectionsV4.js';
import { deriveProviderAccountUsagePace, deriveProviderAccountUsageUnusedCapacity, resolveProviderAccountUsagePaceWindow } from './deriveProviderAccountUsagePace.js';
import type { UsagePacingTargetsV1Schema } from '../account/settings/usagePacingPreferencesV1.js';
import type { AccountScopedCryptoMaterial } from '../crypto/accountScopedCipher.js';
import type { ProviderAccountUsageSnapshotV1 } from './providerAccountUsagePrimitives.js';
import { openProviderAccountUsageEncryptedContentV4 } from './accountUsage.js';
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

export function projectProviderAccountUsageQuotaReadV1(input: Readonly<{ input: ConnectedServiceQuotaGetInputV1; current: ProviderAccountUsageSnapshotV1 | null; history?: z.infer<typeof OpenedProviderAccountUsageHistoryPageV1Schema>; pageProjection?: z.infer<typeof PackedProviderAccountUsagePageProjectionV1Schema>; pageFacts?: ConnectedServiceQuotaGetResultV1['pageFacts']; /** New page following an already coalesced prefix from this same read. */ appendHistory?: z.infer<typeof OpenedProviderAccountUsageHistoryPageV1Schema>; nowMs: number; targets?: z.infer<typeof UsagePacingTargetsV1Schema>; waitingWork?: ProviderAccountUsageWaitingWorkV1; coalesceHistory?: boolean }>): ConnectedServiceQuotaGetResultV1 {
  const history = input.pageProjection ? getProviderAccountUsageQuotaHistoryV1(input) : input.appendHistory ? appendCoalescedHistory(input.history, input.appendHistory)
    : input.history && input.coalesceHistory ? coalesceHistory(input.history) : input.history;
  const snapshots = history?.entries.map(entry => entry.snapshot);
  const result: ConnectedServiceQuotaGetResultV1 = { source: input.input.source, current: input.current,
    ...(history ? { history } : {}), ...(input.pageFacts ? { pageFacts: input.pageFacts } : {}),
    unusedCapacity: deriveProviderAccountUsageUnusedCapacity({ history: snapshots, partial: history?.nextCursor != null, nowMs: input.nowMs }),
    pace: input.current?.meters.map(meter => ({ meterId: meter.meterId, value: deriveProviderAccountUsagePace({ snapshot: input.current!, meterId: meter.meterId, nowMs: input.nowMs, history: snapshots }) })) ?? [], targets: input.targets ?? [], waitingWork: input.waitingWork ?? { status: 'unavailable', reason: 'read_failed' } };
  // Current/history are already admitted by the record/page openers (or the
  // current-snapshot cache). Re-parsing them here clones the whole accumulated
  // history on every progressive page. Derived fields also stay typed; the
  // outward Action boundary validates serialized results.
  if (!input.input.projection) return result;
  const { history: _history, ...page } = result;
  const pageFacts = input.pageFacts ?? getProviderAccountUsageQuotaPageFactsV1(result);
  return { ...page, ...(pageFacts ? { pageFacts } : {}) };
}

/** Canonical equality basis for history projection and observation-writer HMACs. */
export function serializeProviderAccountUsageHistoryMaterialV1(snapshot: ProviderAccountUsageSnapshotV1): string {
    // A timestamp-only run can cross a real window boundary. Preserve the
    // terminal witness and both sides instead of folding away valid evidence.
    const phases = snapshot.meters.map(meter => {
      const window = resolveProviderAccountUsagePaceWindow(snapshot, meter.meterId);
      if (!window) return null;
      const at = snapshot.observedAtMs;
      return at < window.windowStartAtMs ? 'before' : at === window.windowStartAtMs ? 'start'
        : at < window.resetAtMs ? 'within' : at === window.resetAtMs ? 'reset' : 'after';
    });
    return JSON.stringify([serializeProviderAccountUsageSnapshotMaterialV1(snapshot), phases]);
}

/** Keep both witnessed ends of unchanged runs: slopes, reset boundaries and latest witnesses survive. */
function coalesceHistory(history: z.infer<typeof OpenedProviderAccountUsageHistoryPageV1Schema>) {
  const entries: typeof history.entries = [];
  let material: string | undefined;
  let runLength = 0;
  for (const entry of history.entries) {
    const next = serializeProviderAccountUsageHistoryMaterialV1(entry.snapshot);
    if (next !== material) { entries.push(entry); material = next; runLength = 1; }
    else if (++runLength === 2) entries.push(entry);
    else entries[entries.length - 1] = entry;
  }
  return { entries, nextCursor: history.nextCursor };
}

function appendCoalescedHistory(previous: z.infer<typeof OpenedProviderAccountUsageHistoryPageV1Schema> | undefined,
  page: z.infer<typeof OpenedProviderAccountUsageHistoryPageV1Schema>) {
  // Only the final run can merge with the next page. Its two endpoints carry
  // every fact needed by the same canonical compactor, including reset phases.
  const prefix = previous?.entries ?? [];
  const frontier = coalesceHistory({ entries: [...prefix.slice(-2), ...page.entries], nextCursor: page.nextCursor });
  return { entries: [...prefix.slice(0, -2), ...frontier.entries], nextCursor: frontier.nextCursor };
}

export class ProviderAccountUsageReadErrorV1 extends Error {
  constructor(readonly code: 'provider_account_usage_content_mode_mismatch' | 'provider_account_usage_content_unavailable' | 'provider_account_usage_identity_mismatch') {
    super(code);
    this.name = 'ProviderAccountUsageReadErrorV1';
  }
}

export function openProviderAccountUsageRecordV4(input: Readonly<{ recordId: string; enteredMonthlyPrice?: ProviderAccountSubscriptionMonthlyPriceV1; accountMode: 'plain' | 'e2ee'; material?: AccountScopedCryptoMaterial; record: unknown }>): ProviderAccountUsageSnapshotV1 {
  const record = QualifiedProviderAccountUsageRecordResponseV4Schema.parse(input.record);
  return openAdmittedUsageRecord({ ...input, record });
}

/** Exact pages already admitted their envelopes at HTTP; payloads still open here. */
function openAdmittedUsageRecord(input: Readonly<{ recordId: string; enteredMonthlyPrice?: ProviderAccountSubscriptionMonthlyPriceV1;
  accountMode: 'plain' | 'e2ee'; material?: AccountScopedCryptoMaterial;
  record: z.infer<typeof QualifiedProviderAccountUsageRecordResponseV4Schema> }>): ProviderAccountUsageSnapshotV1 {
  const { record } = input;
  if ((input.accountMode === 'plain') !== (record.content.t === 'plain')) throw new ProviderAccountUsageReadErrorV1('provider_account_usage_content_mode_mismatch');
  let snapshot: ProviderAccountUsageSnapshotV1 | null;
  if (record.content.t === 'plain') {
    try { snapshot = parseBuiltInLegacyProviderAccountUsageSnapshotV1(record.content.v); }
    catch { snapshot = null; }
  } else {
    if (!input.material) throw new ProviderAccountUsageReadErrorV1('provider_account_usage_content_unavailable');
    snapshot = openProviderAccountUsageEncryptedContentV4({ material: input.material, content: record.content });
  }
  if (!snapshot) throw new ProviderAccountUsageReadErrorV1('provider_account_usage_content_unavailable');
  if (snapshot.recordId !== input.recordId || snapshot.fetchedAtMs !== record.metadata.fetchedAt || snapshot.staleAfterMs !== record.metadata.staleAfterMs) throw new ProviderAccountUsageReadErrorV1('provider_account_usage_identity_mismatch');
  return projectProviderAccountUsageEnteredPriceV1(snapshot, input.enteredMonthlyPrice);
}

/** Attach the independent admitted user price without inventing provider subscription evidence. */
export function projectProviderAccountUsageEnteredPriceV1(snapshot: ProviderAccountUsageSnapshotV1,
  enteredMonthlyPrice: ProviderAccountSubscriptionMonthlyPriceV1 | undefined): ProviderAccountUsageSnapshotV1 {
  // A provider observation cannot supply the independent user-owned price.
  if (snapshot.subscription || enteredMonthlyPrice) {
    const { enteredMonthlyPrice: _ignored, ...subscription } = snapshot.subscription ?? {
      status: 'unavailable' as const, renewal: 'unknown' as const,
      observedAtMs: snapshot.observedAtMs, staleAfterMs: snapshot.staleAfterMs,
    };
    return { ...snapshot, subscription: { ...subscription, ...(enteredMonthlyPrice ? { enteredMonthlyPrice } : {}) } };
  }
  return snapshot;
}

export function openProviderAccountUsageHistoryPageV4(input: Readonly<{ recordId: string; accountMode: 'plain' | 'e2ee'; material?: AccountScopedCryptoMaterial; page: z.infer<typeof QualifiedProviderAccountUsageHistoryResponseV4Schema> }>): z.infer<typeof OpenedProviderAccountUsageHistoryPageV1Schema> {
  return { entries: input.page.entries.map(entry => {
    const snapshot = openAdmittedUsageRecord({ ...input, record: entry.record });
    if (snapshot.fetchedAtMs !== entry.observedAtMs) throw new ProviderAccountUsageReadErrorV1('provider_account_usage_identity_mismatch');
    return { id: entry.id, observedAtMs: entry.observedAtMs, snapshot };
  }), nextCursor: input.page.nextCursor };
}
