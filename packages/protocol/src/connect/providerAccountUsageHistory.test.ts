import { describe, expect, it, vi } from 'vitest';
import { buildProviderAccountUsageRecordId, ProviderAccountUsageSnapshotV1Schema } from './providerAccountUsagePrimitives.js';
import { sealProviderAccountUsageSnapshot } from './accountUsage.js';
import { ConnectedServiceQuotaGetResultV1Schema, QualifiedProviderAccountUsageHistoryResponseV4Schema,
  openProviderAccountUsageHistoryPageV4, openProviderAccountUsageRecordV4, projectProviderAccountUsageQuotaReadV1,
  buildProviderAccountUsagePageProjectionV1, packProviderAccountUsagePageProjectionV1 } from './providerAccountUsageHistory.js';
import { QualifiedProviderAccountUsageRecordResponseV4Schema } from './qualifiedConnectedAccountProjectionsV4.js';
import { buildProviderAccountUsageDaySummaryV1 } from './providerAccountUsageDaySummary.js';

describe('opened accepted provider history', () => {
  const recordKey = { providerId: 'test', accountSubjectId: 'account', subjectKind: 'account' as const, quotaScope: 'account' as const };
  const snapshot = ProviderAccountUsageSnapshotV1Schema.parse({ v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey, providerId: 'test', accountSubject: { kind: 'providerSubject', id: 'account' }, observedAtMs: 100, fetchedAtMs: 100, staleAfterMs: 1000, source: 'providerHttp', confidence: 'confirmed', meters: [], subscription: { status: 'subscribed', renewal: 'off', observedAtMs: 100, staleAfterMs: 1000, currentPeriodEndAtMs: 200 } });
  const material = { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) };
  const metadata = { fetchedAt: 100, staleAfterMs: 1000, status: 'ok' as const };
  it('does not settle legacy projection history from an empty summary response', () => {
    const source = { ref: { service: { pluginId: 'example.usage', localId: 'usage' }, accountId: 'account' }, bindingKind: 'account' as const };
    const input = { source, projection: { range: { startAtMs: 0, endAtMs: 2000 }, resolution: 'accepted_observations' as const } };
    for (const daySummaries of [undefined, []]) {
      const pending = projectProviderAccountUsageQuotaReadV1({ input, current: snapshot, daySummaries, nowMs: 150 });
      expect(pending.unusedCapacity).toEqual({ historyStatus: 'not_loaded', windows: [] });
      expect(pending.pageFacts).toBeUndefined();
      const complete = projectProviderAccountUsageQuotaReadV1({ input, current: snapshot, daySummaries,
        history: { entries: [], nextCursor: null }, nowMs: 150 });
      expect(complete.unusedCapacity).toEqual({ historyStatus: 'returned_page', windows: [] });
      expect(complete.pageFacts?.historyStatus).toBe('complete');
      const partial = projectProviderAccountUsageQuotaReadV1({ input, current: snapshot, daySummaries,
        history: { entries: [], nextCursor: { id: 'pending', observedAtMs: 100 } }, nowMs: 150 });
      expect(partial.unusedCapacity?.historyStatus).toBe('partial');
      expect(partial.pageFacts?.historyStatus).toBe('partial');
    }
  });
  it('projects summary days and ended windows while deriving exact recent pace independently', () => {
    const source = { ref: { service: { pluginId: 'example.usage', localId: 'usage' }, accountId: 'account' }, bindingKind: 'account' as const };
    const sample = (at: number, used: number, resetAtMs = 2000) => ProviderAccountUsageSnapshotV1Schema.parse({ ...snapshot,
      subscription: undefined, state: 'loaded_data', observedAtMs: at, fetchedAtMs: at,
      meters: [{ meterId: 'week', label: 'Weekly', used, limit: 100, utilizationPct: used, unit: 'requests', resetsAt: resetAtMs,
        windowDurationMs: 1000, status: 'ok', details: {} }] });
    const ended = sample(1000, 40, 1000);
    const first = sample(1100, 10); const next = sample(1200, 30); const current = sample(1250, 40);
    const summary = buildProviderAccountUsageDaySummaryV1({ recordId: snapshot.recordId, dayStartAtMs: 0,
      snapshots: [ended, first, next, current] });
    const history = { entries: [ended, first, next, current].map((snapshot, index) => ({ id: String(index), observedAtMs: snapshot.fetchedAtMs, snapshot })), nextCursor: null };
    const expected = projectProviderAccountUsageQuotaReadV1({ input: { source }, current, history, nowMs: 1250 });
    const input = { input: { source, projection: { range: { startAtMs: 0, endAtMs: 3000 }, resolution: 'accepted_observations' as const } }, current,
      daySummaries: [summary], recentHistory: history, missingDays: [], nowMs: 1250 };
    const projected = projectProviderAccountUsageQuotaReadV1(input);
    expect(projected.pace).toEqual(expected.pace);
    expect(projected.pace[0]!.value).toMatchObject({ status: 'available', sampleCount: 3,
      empiricalRange: { min: 1, max: 1.6 }, observedCurve: [
        { observedAtMs: 1100, usedFraction: .1 }, { observedAtMs: 1200, usedFraction: .3 }, { observedAtMs: 1250, usedFraction: .4 },
      ] });
    expect(projected.pageFacts).toMatchObject({ historyStatus: 'complete', resetWitness: { id: '3', observedAtMs: 1250 },
      dayQuotaHistory: [{ windows: [{ peakUsed: 40 }, { peakUsed: 40 }] }],
      earlierCurves: [{ meterId: 'week', value: { status: 'unavailable', reason: 'not_loaded' } }],
      witnessedResets: [{ meterId: 'week', resetAtMs: 1000 }] });
    expect(projected.unusedCapacity).toEqual({ historyStatus: 'not_loaded', windows: [] });
    expect(projected.history).toBeUndefined();
    expect(projected.pageProjection).toBeUndefined();
    expect(ConnectedServiceQuotaGetResultV1Schema.safeParse(projected).success).toBe(true);
    const partial = projectProviderAccountUsageQuotaReadV1({ ...input, missingDays: [{ dayStartAtMs: 0 }] });
    expect(partial.pageFacts?.historyStatus).toBe('partial');
    expect(partial.unusedCapacity?.historyStatus).toBe('not_loaded');
    expect(partial.pace).toEqual(expected.pace);
    const incompatibleSummary = { ...summary, windows: summary.windows.map(window => ({ ...window,
      lastSnapshot: { ...window.lastSnapshot, meters: window.lastSnapshot.meters.map(meter => ({ ...meter, limit: 200 })) },
    })) };
    expect(projectProviderAccountUsageQuotaReadV1({ ...input, daySummaries: [incompatibleSummary] }).pace).toEqual(expected.pace);
    const retained = buildProviderAccountUsageDaySummaryV1({ recordId: snapshot.recordId, dayStartAtMs: 0, snapshots: [ended, first, next] });
    expect(projectProviderAccountUsageQuotaReadV1({ ...input, daySummaries: [retained], recentHistory: { ...history,
      entries: history.entries.filter(entry => entry.snapshot !== next) } }).pace).toEqual(expected.pace);
    const unproven = projectProviderAccountUsageQuotaReadV1({ ...input, recentHistory: undefined,
      recentHistorySelection: { status: 'unavailable' as const, reason: 'unproven_clock_bounds' as const } });
    expect(unproven.pace[0]!.value).toEqual({ status: 'unavailable', reason: 'not_loaded' });
    expect(unproven.pageFacts?.historyStatus).toBe('partial');
    const unknown = { ...current, meters: [{ ...current.meters[0]!, windowDurationMs: undefined }] };
    expect(projectProviderAccountUsageQuotaReadV1({ ...input, current: unknown }).pace[0]!.value)
      .toEqual({ status: 'unavailable', reason: 'unknown_window' });
    const denominatorChanged = { ...first, meters: [{ ...first.meters[0]!, limit: 200 }] };
    const incompatible = { ...history, entries: [{ ...history.entries[1]!, snapshot: denominatorChanged }, ...history.entries.slice(2)] };
    expect(projectProviderAccountUsageQuotaReadV1({ ...input, recentHistory: incompatible }).pace[0]!.value)
      .toEqual({ status: 'unavailable', reason: 'denominator_changed' });
    const changedReset = { ...first, meters: [{ ...first.meters[0]!, resetsAt: 3000 }] };
    expect(projectProviderAccountUsageQuotaReadV1({ ...input, recentHistory: { ...history,
      entries: [{ ...history.entries[1]!, snapshot: changedReset }, ...history.entries.slice(2)] } }).pace[0]!.value)
      .toEqual({ status: 'unavailable', reason: 'reset_changed' });
    // Exact detail for PastCycleRow preserves WEB's sampleCount and exclusion
    // falsifier while the bounded daily read leaves ended facts unloaded.
    for (const changedDenominator of [false, true]) {
      const earlier = sample(100, 10, 1000);
      const middle = sample(500, 20, 1000);
      if (changedDenominator) middle.meters[0]!.limit = 200;
      const full = { ...history, entries: [earlier, middle, ended, first, next, current]
        .map((snapshot, index) => ({ id: `ended-${index}`, observedAtMs: snapshot.fetchedAtMs, snapshot })) };
      const fullRead = projectProviderAccountUsageQuotaReadV1({ input: input.input, current, history: full, nowMs: 1250 });
      const dailyInput = { ...input,
        daySummaries: [buildProviderAccountUsageDaySummaryV1({ recordId: snapshot.recordId, dayStartAtMs: 0,
          snapshots: full.entries.map(entry => entry.snapshot) })],
        recentHistory: { ...full, entries: full.entries.filter(entry => entry.snapshot.fetchedAtMs >= 1000) } };
      const exact = projectProviderAccountUsageQuotaReadV1({ ...dailyInput, history: full,
        exactHistoryRange: input.input.projection.range });
      expect.soft(exact.unusedCapacity, `ended facts, denominator changed=${changedDenominator}`).toEqual(fullRead.unusedCapacity);
      expect(projectProviderAccountUsageQuotaReadV1(dailyInput).unusedCapacity).toEqual({ historyStatus: 'not_loaded', windows: [] });
    }
  });
  it.each(['history', 'pageProjection'] as const)('keeps explicit %s earlier curves alongside exact recent pace', kind => {
    const source = { ref: { service: { pluginId: 'example.usage', localId: 'usage' }, accountId: 'account' }, bindingKind: 'account' as const };
    const sample = (at: number, used: number, resetsAt: number) => ProviderAccountUsageSnapshotV1Schema.parse({ ...snapshot,
      observedAtMs: at, fetchedAtMs: at, subscription: undefined, state: 'loaded_data',
      meters: [{ meterId: 'week', label: 'Weekly', used, limit: 100, utilizationPct: used, unit: 'requests',
        resetsAt, windowDurationMs: 1000, status: 'ok', details: {} }] });
    const samples = [sample(100, 10, 1000), sample(500, 20, 1000), sample(1000, 40, 1000), sample(1250, 5, 2000)];
    const current = samples.at(-1)!;
    const range = { startAtMs: 0, endAtMs: 2000 };
    const input = { source, projection: { range, resolution: 'accepted_observations' as const } };
    const history = { entries: samples.map((snapshot, index) => ({ id: String(index), observedAtMs: snapshot.fetchedAtMs, snapshot })), nextCursor: null };
    const exact = kind === 'history' ? { history } : { pageProjection: packProviderAccountUsagePageProjectionV1(
      buildProviderAccountUsagePageProjectionV1({ recordId: current.recordId, range, history })) };
    const recentHistory = { entries: history.entries.slice(-1), nextCursor: null };
    const full = projectProviderAccountUsageQuotaReadV1({ input, current, ...exact, nowMs: 1250 });
    const recent = projectProviderAccountUsageQuotaReadV1({ input, current, recentHistory, nowMs: 1250 });
    const mixed = projectProviderAccountUsageQuotaReadV1({ input, current, ...exact, recentHistory, nowMs: 1250 });
    expect(full.pageFacts?.earlierCurves[0]?.value).toMatchObject({ status: 'available', curves: [{ points: [
      { elapsedFraction: .1, usedFraction: .1 }, { elapsedFraction: .5, usedFraction: .2 }, { elapsedFraction: 1, usedFraction: .4 },
    ] }] });
    expect(mixed.unusedCapacity).toEqual(full.unusedCapacity);
    expect(mixed.pageFacts?.earlierCurves).toEqual(full.pageFacts?.earlierCurves);
    expect(mixed.pace).toEqual(recent.pace);
    expect(recent.pageFacts?.earlierCurves[0]?.value).toEqual({ status: 'unavailable', reason: 'not_loaded' });
    expect(recent.unusedCapacity).toEqual({ historyStatus: 'not_loaded', windows: [] });
    expect(mixed.pageFacts?.resetWitness).toEqual(recent.pageFacts?.resetWitness);
    const incompleteDaily = projectProviderAccountUsageQuotaReadV1({ input, current, ...exact,
      recentHistorySelection: { status: 'unavailable', reason: 'unproven_clock_bounds' },
      missingDays: [{ dayStartAtMs: 0 }], nowMs: 1250 });
    expect(incompleteDaily.unusedCapacity).toEqual(full.unusedCapacity);
    expect(incompleteDaily.pageFacts?.earlierCurves).toEqual(full.pageFacts?.earlierCurves);
    const retainedCurrent = sample(2250, 5, 3000);
    const retainedSummary = buildProviderAccountUsageDaySummaryV1({ recordId: current.recordId, dayStartAtMs: 0,
      snapshots: [sample(900, 40, 1000), sample(1900, 50, 2000), retainedCurrent] });
    const retainedRange = { startAtMs: 1000, endAtMs: 3000 };
    const retainedHistory = { entries: [{ id: 'current-only', observedAtMs: retainedCurrent.fetchedAtMs, snapshot: retainedCurrent }], nextCursor: null };
    const retainedExact = kind === 'history' ? { history: retainedHistory, exactHistoryRange: retainedRange }
      : { pageProjection: packProviderAccountUsagePageProjectionV1(buildProviderAccountUsagePageProjectionV1({ recordId: current.recordId,
        range: retainedRange, history: retainedHistory })) };
    const retainedExpected = projectProviderAccountUsageQuotaReadV1({ input: { source, history: { range: retainedRange, pageSize: 100 } },
      current: retainedCurrent, history: retainedHistory, daySummaries: [retainedSummary], nowMs: 2250 });
    const retainedMixed = projectProviderAccountUsageQuotaReadV1({ input: { source, projection: { range: { startAtMs: 0, endAtMs: 4000 }, resolution: 'accepted_observations' } },
      current: retainedCurrent, ...retainedExact, recentHistory: retainedHistory, daySummaries: [retainedSummary], nowMs: 2250 });
    expect(retainedMixed.unusedCapacity).toEqual(retainedExpected.unusedCapacity);
    expect(retainedMixed.unusedCapacity?.windows.map(value => value.window.resetAtMs)).toEqual([2000]);
    if (kind === 'history') {
      const requestScoped = projectProviderAccountUsageQuotaReadV1({ input: { source, history: { range: retainedRange, pageSize: 100 } },
        current: retainedCurrent, history: retainedHistory, recentHistory: retainedHistory, daySummaries: [retainedSummary], nowMs: 2250 });
      expect(requestScoped.unusedCapacity).toEqual(retainedExpected.unusedCapacity);
      const unscoped = projectProviderAccountUsageQuotaReadV1({ input, current: retainedCurrent, history: retainedHistory,
        recentHistory: retainedHistory, daySummaries: [retainedSummary], nowMs: 2250 });
      expect(unscoped.unusedCapacity).toEqual({ historyStatus: 'returned_page', windows: [] });
    }
  });
  it('opens page payloads without re-admitting each HTTP-admitted record envelope', () => {
    const page = QualifiedProviderAccountUsageHistoryResponseV4Schema.parse({ entries: [{ id: 'witness', observedAtMs: 100,
      record: { content: { t: 'plain', v: snapshot }, metadata, sources: [] } }], nextCursor: null });
    const parse = vi.spyOn(QualifiedProviderAccountUsageRecordResponseV4Schema, 'parse');
    try {
      const opened = openProviderAccountUsageHistoryPageV4({ recordId: snapshot.recordId, accountMode: 'plain', page });
      expect(opened.entries[0]!.snapshot).toEqual(snapshot);
      expect(parse.mock.calls.length).toBe(0);
      expect(() => openProviderAccountUsageHistoryPageV4({ recordId: snapshot.recordId, accountMode: 'plain',
        page: { ...page, entries: [{ ...page.entries[0]!, record: { ...page.entries[0]!.record,
          content: { t: 'plain', v: { ...snapshot, providerId: 'wrong' } } } }] } })).toThrow();
    } finally { parse.mockRestore(); }
  });
  it('sets up one encrypted history key per page while authenticating every record and facet', () => {
    const machineKey = new Uint8Array(32).fill(7);
    const sealingMaterial = { type: 'dataKey' as const, machineKey };
    const encoder = new TextEncoder();
    let nonce = 0;
    const observations = [4, 16].map(recordCount => {
      const expectedEntries = Array.from({ length: recordCount }, (_, index) => {
        const at = snapshot.fetchedAtMs + index;
        return { id: `witness-${index}`, observedAtMs: at, snapshot: ProviderAccountUsageSnapshotV1Schema.parse({
          ...snapshot,
          observedAtMs: at,
          fetchedAtMs: at,
          subscription: index % 2 === 1 ? { ...snapshot.subscription, observedAtMs: at } : undefined,
          recoveryCreditDetails: index % 4 === 0 ? { grant: { remainingCount: index + 1 } } : undefined,
        }) };
      });
      const entries = expectedEntries.map(({ id, observedAtMs, snapshot }) => {
        const sealed = sealProviderAccountUsageSnapshot({ material: sealingMaterial, snapshot,
          randomBytes: length => new Uint8Array(length).fill(++nonce) });
        return { id, observedAtMs, record: { metadata: { ...metadata, fetchedAt: observedAtMs }, sources: [],
          content: { t: 'encrypted' as const, c: sealed.ciphertext, subscription: sealed.subscription,
            recoveryCreditDetails: sealed.recoveryCreditDetails } } };
      });
      const lastEntry = entries.at(-1)!;
      const nextCursor = { id: lastEntry.id, observedAtMs: lastEntry.observedAtMs };
      const page = QualifiedProviderAccountUsageHistoryResponseV4Schema.parse({ entries, nextCursor });
      let keyReads = 0;
      // On this data-key path, the cipher reads material.machineKey to derive the blob-kind key.
      // The getter returns the real key so every envelope still traverses the real authenticated open.
      const openingMaterial = { type: 'dataKey' as const, get machineKey() { keyReads++; return machineKey; } };
      const input = { recordId: snapshot.recordId, accountMode: 'e2ee' as const, page };
      const opened = openProviderAccountUsageHistoryPageV4({ ...input, material: openingMaterial });
      expect(opened).toEqual({ entries: expectedEntries, nextCursor });
      expect(() => openProviderAccountUsageHistoryPageV4({ ...input, accountMode: 'plain' }))
        .toThrowError(expect.objectContaining({ code: 'provider_account_usage_content_mode_mismatch' }));
      const subscription = lastEntry.record.content.subscription!;
      const { ciphertext } = subscription;
      const at = Math.floor(ciphertext.length / 2);
      const tampered = ciphertext.slice(0, at) + (ciphertext[at] === 'A' ? 'B' : 'A') + ciphertext.slice(at + 1);
      const tamperedPage = QualifiedProviderAccountUsageHistoryResponseV4Schema.parse({ nextCursor,
        entries: [...entries.slice(0, -1), { ...lastEntry, record: { ...lastEntry.record,
          content: { ...lastEntry.record.content, subscription: { ...subscription, ciphertext: tampered } } } }] });
      expect(() => openProviderAccountUsageHistoryPageV4({ ...input, material: sealingMaterial, page: tamperedPage }))
        .toThrowError(expect.objectContaining({ code: 'provider_account_usage_content_unavailable' }));
      return { recordCount, keyReads, decodedPageBytes: encoder.encode(JSON.stringify(page)).byteLength,
        subscriptionFacets: entries.filter(entry => entry.record.content.subscription).length,
        recoveryFacets: entries.filter(entry => entry.record.content.recoveryCreditDetails).length };
    });
    console.info(JSON.stringify({ kind: 'usage-history-key-setup', observations }));
    expect(observations.map(observation => observation.keyReads)).toEqual([1, 1]);
  });
  it('projects retained plain fields through the same stored reader as encrypted snapshots while keeping writes strict', () => {
    const retained = { ...snapshot, retired: true, recordKey: { ...snapshot.recordKey, retired: true },
      accountSubject: { ...snapshot.accountSubject, retired: true }, subscription: { ...snapshot.subscription, retired: true } };
    expect(ProviderAccountUsageSnapshotV1Schema.safeParse(retained).success).toBe(false);
    expect(openProviderAccountUsageRecordV4({ recordId: snapshot.recordId, accountMode: 'plain',
      record: { content: { t: 'plain', v: retained }, metadata, sources: [] } })).toEqual(snapshot);
    expect(() => openProviderAccountUsageRecordV4({ recordId: snapshot.recordId, accountMode: 'plain',
      record: { content: { t: 'plain', v: { ...retained, providerId: 'other' } }, metadata, sources: [] } })).toThrow();
    expect(() => openProviderAccountUsageRecordV4({ recordId: snapshot.recordId, accountMode: 'plain',
      record: { content: { t: 'plain', v: retained }, metadata: { ...metadata, fetchedAt: 101 }, sources: [] } }))
      .toThrowError(expect.objectContaining({ code: 'provider_account_usage_identity_mismatch' }));
  });
  it('composes only the admitted user price and never trusts a provider-supplied entered amount', () => {
    const price = { amount: 17, currency: 'EUR', enteredAtMs: 100 };
    const record = { content: { t: 'plain' as const, v: { ...snapshot,
      subscription: { ...snapshot.subscription, enteredMonthlyPrice: { ...price, amount: 999 } } } }, metadata, sources: [] };
    expect(openProviderAccountUsageRecordV4({ recordId: snapshot.recordId, accountMode: 'plain', record }).subscription?.enteredMonthlyPrice).toBeUndefined();
    expect(openProviderAccountUsageRecordV4({ recordId: snapshot.recordId, accountMode: 'plain', record, enteredMonthlyPrice: price }).subscription?.enteredMonthlyPrice).toEqual(price);
  });
  it.each(['plain', 'e2ee'] as const)('retains a user price without inventing provider subscription evidence in %s mode', accountMode => {
    const { subscription: _subscription, ...withoutSubscription } = snapshot;
    const price = { amount: 1.23, currency: 'USD', enteredAtMs: 100 };
    const sealed = sealProviderAccountUsageSnapshot({ material, snapshot: withoutSubscription, randomBytes: n => new Uint8Array(n).fill(3) });
    const content = accountMode === 'plain' ? { t: 'plain' as const, v: withoutSubscription }
      : { t: 'encrypted' as const, c: sealed.ciphertext, subscription: sealed.subscription, recoveryCreditDetails: sealed.recoveryCreditDetails };
    const record = { content, metadata, sources: [] };
    const opened = openProviderAccountUsageRecordV4({ recordId: snapshot.recordId, accountMode, material, record, enteredMonthlyPrice: price });
    expect(opened.subscription).toEqual({ status: 'unavailable', renewal: 'unknown', observedAtMs: snapshot.observedAtMs,
      staleAfterMs: snapshot.staleAfterMs, enteredMonthlyPrice: price });
    expect(openProviderAccountUsageRecordV4({ recordId: snapshot.recordId, accountMode, material, record }).subscription).toBeUndefined();
    expect(ProviderAccountUsageSnapshotV1Schema.safeParse(opened).success).toBe(true);
  });
  it('projects a current-only quota read with its configured advisory targets', () => {
    const source = { ref: { service: { pluginId: 'example.usage', localId: 'usage' }, accountId: 'account' }, bindingKind: 'account' as const };
    expect(projectProviderAccountUsageQuotaReadV1({ input: { source }, current: snapshot, nowMs: 100, targets: [{ id: 'personal', scope: { kind: 'personal' }, utilizationFraction: .8 }] })).toMatchObject({ current: snapshot, targets: [{ id: 'personal' }] });
  });
  it('reuses admitted history without revalidating its material against the same-run full-result parser', () => {
    const source = { ref: { service: { pluginId: 'example.usage', localId: 'usage' }, accountId: 'account' }, bindingKind: 'account' as const };
    // An accessor observes real schema traversal; no parser or domain owner is mocked.
    let materialReads = 0;
    const admitted = { ...snapshot, accountLabel: 'Accepted account' };
    const materialBytes = new TextEncoder().encode(JSON.stringify(admitted)).byteLength;
    Object.defineProperty(admitted, 'accountLabel', { enumerable: true, get() { materialReads++; return 'Accepted account'; } });
    const history = { entries: Array.from({ length: 512 }, (_, index) => ({ id: String(index), observedAtMs: 100, snapshot: admitted })), nextCursor: null };
    const projected = projectProviderAccountUsageQuotaReadV1({ input: { source }, current: null, history, nowMs: 100 });
    const projectionReads = materialReads;
    materialReads = 0;
    // The loaded predecessor validates the complete result at this point. Keep
    // that actual schema as the comparator, including its fresh snapshot clones.
    const revalidated = ConnectedServiceQuotaGetResultV1Schema.parse(projected);
    const fullResultReads = materialReads;
    expect(projectionReads).toBe(0);
    expect(fullResultReads).toBe(history.entries.length);
    expect(projected.history).toBe(history);
    expect(projected.history!.entries[0]!.snapshot).toBe(admitted);
    expect(revalidated.history!.entries[0]!.snapshot).not.toBe(admitted);
    const payloadBytes = new TextEncoder().encode(JSON.stringify(projected)).byteLength;
    expect(new TextEncoder().encode(JSON.stringify(revalidated)).byteLength).toBe(payloadBytes);
    console.info(JSON.stringify({ projectionMaterialReads: projectionReads, fullResultMaterialReads: fullResultReads,
      projectionRevalidatedMaterialBytes: projectionReads * materialBytes,
      fullResultRevalidatedMaterialBytes: fullResultReads * materialBytes, payloadBytes }));
  });
  it('folds unchanged observation runs to their actual endpoints without erasing reset or entitlement changes', () => {
    const source = { ref: { service: { pluginId: 'example.usage', localId: 'usage' }, accountId: 'account' }, bindingKind: 'account' as const };
    const sample = (at: number, used: number, resetAt = 1000, planLabel = 'Standard') => ProviderAccountUsageSnapshotV1Schema.parse({ ...snapshot,
      subscription: undefined, planLabel, state: 'loaded_data', observedAtMs: at, fetchedAtMs: at,
      meters: [{ meterId: 'week', label: 'Weekly', used, remaining: 100 - used, limit: 100, unit: 'requests',
        utilizationPct: used, resetsAt: resetAt, windowDurationMs: 1000, status: 'ok', details: {} }] });
    const samples = [sample(100, 20), sample(200, 20), sample(300, 20), sample(400, 40), sample(500, 40),
      sample(600, 40), sample(700, 40, 1000, 'Premium'), sample(1000, 40, 1000, 'Premium'),
      sample(1100, 5, 2000, 'Premium')];
    const history = { entries: samples.map((snapshot, index) => ({ id: String(index), observedAtMs: snapshot.fetchedAtMs, snapshot })), nextCursor: { id: '8', observedAtMs: 1100 } };
    const input = { input: { source }, current: samples.at(-1)!, history, nowMs: 1100, coalesceHistory: true };
    const projected = projectProviderAccountUsageQuotaReadV1(input);
    expect(projected.history?.entries.map(entry => entry.id)).toEqual(['0', '2', '3', '5', '6', '7', '8']);
    expect(projected.history?.nextCursor).toEqual(history.nextCursor);
    expect(projected.unusedCapacity).toMatchObject({ historyStatus: 'partial', windows: [{ value: { status: 'insufficient_basis', reason: 'entitlement_changed' } }] });
    // Ordinary page reads retain every accepted observation and its immutable witness.
    expect(projectProviderAccountUsageQuotaReadV1({ ...input, coalesceHistory: false }).history?.entries).toEqual(history.entries);
    let progressive: typeof projected.history;
    for (const entry of history.entries) {
      progressive = projectProviderAccountUsageQuotaReadV1({ ...input, history: progressive, coalesceHistory: false,
        appendHistory: { entries: [entry], nextCursor: entry === history.entries.at(-1) ? history.nextCursor
          : { id: entry.id, observedAtMs: entry.observedAtMs } } }).history;
    }
    expect(progressive).toEqual(projected.history);
  });
  it('appends a progressive page without traversing the already compacted prefix again', () => {
    const source = { ref: { service: { pluginId: 'example.usage', localId: 'usage' }, accountId: 'account' }, bindingKind: 'account' as const };
    let materialReads = 0;
    const entries = Array.from({ length: 1024 }, (_, index) => {
      const admitted = { ...snapshot, observedAtMs: index + 1, fetchedAtMs: index + 1, planLabel: String(index) };
      Object.defineProperty(admitted, 'accountLabel', { enumerable: true, get() { materialReads++; return null; } });
      return { id: String(index), observedAtMs: index + 1, snapshot: admitted };
    });
    const next = { id: '1024', observedAtMs: 1025, snapshot: { ...snapshot, observedAtMs: 1025, fetchedAtMs: 1025, planLabel: '1023' } };
    const input = { input: { source }, current: null, nowMs: 2000,
      history: { entries, nextCursor: { id: '1023', observedAtMs: 1024 } },
      appendHistory: { entries: [next], nextCursor: null }, coalesceHistory: true };
    const projected = projectProviderAccountUsageQuotaReadV1(input);
    const prefixMaterialReads = materialReads;
    expect(projected.history?.entries).toEqual([...entries, next]);
    expect(projected.history?.nextCursor).toBeNull();
    // Observe input traversal, not mocked internal calls or wall-clock thresholds.
    expect(prefixMaterialReads).toBe(2);
    expect(projected.history?.entries[0]).toBe(entries[0]);
    console.info(JSON.stringify({ admittedPrefixEntries: entries.length, appendedEntries: 1, prefixMaterialReads }));
  });
  it('keeps terminal reset observations inside an otherwise unchanged run', () => {
    const source = { ref: { service: { pluginId: 'example.usage', localId: 'usage' }, accountId: 'account' }, bindingKind: 'account' as const };
    const samples = [100, 200, 500, 750, 1000, 1100, 1200].map(at => ProviderAccountUsageSnapshotV1Schema.parse({ ...snapshot,
      subscription: undefined, observedAtMs: at, fetchedAtMs: at, state: 'loaded_data',
      meters: [{ meterId: 'week', label: 'Weekly', used: 40, limit: 100, remaining: 60, unit: 'requests',
        utilizationPct: 40, resetsAt: 1000, windowDurationMs: 1000, status: 'ok', details: {} }] }));
    const input = { input: { source }, current: null, nowMs: 1500, coalesceHistory: true,
      history: { entries: samples.map(snapshot => ({ id: String(snapshot.observedAtMs), observedAtMs: snapshot.observedAtMs, snapshot })), nextCursor: null } };
    expect(projectProviderAccountUsageQuotaReadV1(input).history?.entries.map(entry => entry.observedAtMs)).toEqual([100, 750, 1000, 1100, 1200]);
  });
  it('projects ended unused amounts only in a witnessed denomination, with terminal and estimated history distinct', () => {
    const source = { ref: { service: { pluginId: 'example.usage', localId: 'usage' }, accountId: 'account' }, bindingKind: 'account' as const };
    const sample = (at: number, used: number) => ProviderAccountUsageSnapshotV1Schema.parse({ ...snapshot,
      state: 'loaded_data', observedAtMs: at, fetchedAtMs: at, subscription: undefined,
      meters: [{ meterId: 'week', label: 'Weekly', used, limit: 100, remaining: 100 - used,
        unit: 'requests', utilizationPct: used, resetsAt: 1000, windowDurationMs: 1000, status: 'ok', details: {} }] });
    const read = (samples: ReturnType<typeof sample>[]) => projectProviderAccountUsageQuotaReadV1({ input: { source },
      current: null, nowMs: 1500, history: { entries: samples.map((snapshot, index) => ({ id: String(index), observedAtMs: snapshot.fetchedAtMs, snapshot })), nextCursor: null } });
    expect(read([sample(500, 20), sample(1000, 40)])).toMatchObject({ unusedCapacity: { historyStatus: 'returned_page',
      windows: [{ value: { status: 'available', unusedAmount: 60, unusedFraction: .6, unit: 'requests',
        method: 'terminal_observation', qualification: 'confirmed', observedAtMs: 1000, sampleCount: 2 } }] } });
    expect(read([sample(250, 10), sample(500, 20)])).toMatchObject({ unusedCapacity: {
      windows: [{ value: { status: 'available', unusedAmount: 60, method: 'linear_pace_at_last_observation', qualification: 'estimated' } }] } });
    const changed = sample(1000, 40); changed.meters[0]!.limit = 200;
    expect(read([sample(500, 20), changed])).toMatchObject({ unusedCapacity: { windows: [{ value: { status: 'insufficient_basis', reason: 'denominator_changed' } }] } });
    const percentOnly = sample(1000, 40); Object.assign(percentOnly.meters[0]!, { used: null, remaining: null, limit: null, utilizationPct: 40 });
    expect(read([percentOnly])).toMatchObject({ unusedCapacity: { windows: [{ value: { status: 'insufficient_basis', reason: 'unknown_denominator' } }] } });
    expect(projectProviderAccountUsageQuotaReadV1({ input: { source }, current: snapshot, nowMs: 1500 })).toMatchObject({ unusedCapacity: { historyStatus: 'not_loaded', windows: [] } });
  });
  it('opens keyless plain history and preserves protected subscription through the canonical sealed opener', () => {
    const priced = ProviderAccountUsageSnapshotV1Schema.parse({ ...snapshot, recoveryCreditDetails: { grant: { remainingCount: 2, appliesToProviderLimitIds: ['five_hour'], unavailableReason: 'cooldown' } }, subscription: { ...snapshot.subscription,
      currentPeriodStartAtMs: 0, monetaryFacts: [
        { kind: 'paid', amount: 16, currency: 'USD', period: { startAtMs: 0, endAtMs: 200 }, source: { kind: 'provider', id: 'test-receipt', version: 'v1' }, effectiveAtMs: 0, asOfMs: 100 },
        { kind: 'list', amount: 20, currency: 'USD', period: { startAtMs: 0, endAtMs: 200 }, source: { kind: 'published', id: 'https://example.test/pricing', version: 'test-vector-v1' }, effectiveAtMs: 0, asOfMs: 100 },
      ] } });
    expect(openProviderAccountUsageRecordV4({ recordId: priced.recordId, accountMode: 'plain', record: { content: { t: 'plain', v: priced }, metadata, sources: [] } })).toEqual(priced);
    const sealed = sealProviderAccountUsageSnapshot({ snapshot: priced, material, randomBytes: length => new Uint8Array(length).fill(2) });
    expect(openProviderAccountUsageRecordV4({ recordId: priced.recordId, accountMode: 'e2ee', material, record: { content: { t: 'encrypted', c: sealed.ciphertext, subscription: sealed.subscription, recoveryCreditDetails: sealed.recoveryCreditDetails }, metadata, sources: [] } })).toEqual(priced);
  });
  it('refuses mode mismatch, wrong-key and tampered subscription rather than returning empty history', () => {
    const plain = { content: { t: 'plain' as const, v: snapshot }, metadata, sources: [] };
    expect(() => openProviderAccountUsageRecordV4({ recordId: snapshot.recordId, accountMode: 'e2ee', material, record: plain })).toThrow();
    const sealed = sealProviderAccountUsageSnapshot({ snapshot, material, randomBytes: length => new Uint8Array(length).fill(2) });
    const record = { content: { t: 'encrypted' as const, c: sealed.ciphertext, subscription: sealed.subscription }, metadata, sources: [] };
    expect(() => openProviderAccountUsageRecordV4({ recordId: snapshot.recordId, accountMode: 'plain', record })).toThrow();
    expect(() => openProviderAccountUsageRecordV4({ recordId: snapshot.recordId, accountMode: 'e2ee', material: { type: 'legacy', secret: new Uint8Array(32).fill(8) }, record })).toThrow();
    expect(() => openProviderAccountUsageRecordV4({ recordId: snapshot.recordId, accountMode: 'e2ee', material, record: { ...record, content: { ...record.content, subscription: { ...sealed.subscription!, observedAtMs: 101 } } } })).toThrow();
  });
});
