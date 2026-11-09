import { describe, expect, it } from 'vitest';
import { Session } from 'node:inspector/promises';
import { buildProviderAccountUsageRecordId, ProviderAccountUsageSnapshotV1Schema } from './providerAccountUsagePrimitives.js';
import { buildProviderAccountUsagePageProjectionV1, packProviderAccountUsagePageProjectionV1, unpackProviderAccountUsagePageProjectionV1, StoredProviderAccountUsagePageProjectionV1Schema, ProviderAccountUsagePageProjectionMetadataV1Schema, ProviderAccountUsagePageProjectionWriteV1Schema, PROVIDER_ACCOUNT_USAGE_PAGE_ENCODING } from './providerAccountUsagePageProjection.js';
import { openProviderAccountUsagePageProjectionV1, openProviderAccountUsagePageProjectionReadV1, sealProviderAccountUsagePageProjectionV1 } from './providerAccountUsagePageProjectionCrypto.js';
import { sealAccountScopedBlobCiphertext } from '../crypto/accountScopedCipher.js';
import { deriveProviderAccountUsagePace, deriveProviderAccountUsageUnusedCapacity, deriveProviderAccountUsageEarlierWindowCurves, hasProviderAccountUsageWitnessedReset } from './deriveProviderAccountUsagePace.js';
import { projectProviderAccountUsageQuotaReadV1 } from './providerAccountUsageHistory.js';

const recordKey = { providerId: 'test', accountSubjectId: 'account', subjectKind: 'account' as const, quotaScope: 'account' as const };
const sample = (at: number, used: number, reset = 1000) => ProviderAccountUsageSnapshotV1Schema.parse({
  v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey, providerId: 'test',
  accountSubject: { kind: 'providerSubject', id: 'account' }, observedAtMs: at, fetchedAtMs: at,
  staleAfterMs: 5000, source: 'providerHttp', confidence: 'confirmed', planLabel: 'Standard',
  subscription: { status: 'subscribed', renewal: 'on', observedAtMs: at, staleAfterMs: 5000 },
  meters: [{ meterId: 'week', label: 'Weekly', used, limit: 100, remaining: 100 - used, unit: 'requests',
    utilizationPct: used, resetsAt: reset, windowDurationMs: 1000, status: 'ok', details: {} }],
});
const history = { entries: [sample(100, 10), sample(500, 50), sample(1000, 80), sample(1100, 10, 2000)]
  .map((snapshot, index) => ({ id: String(index), observedAtMs: snapshot.fetchedAtMs, snapshot })), nextCursor: null };
const range = { startAtMs: 0, endAtMs: 1200 };
const material = { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) };

describe('B page projection', () => {
  it('normalizes a shared admitted meter once while retaining every accepted observation', () => {
    const entries = Array.from({ length: 1000 }, (_, index) => {
      const snapshot = sample(100 + index, 10);
      return { id: String(index), observedAtMs: snapshot.fetchedAtMs, snapshot };
    });
    const projection = buildProviderAccountUsagePageProjectionV1({ recordId: entries[0]!.snapshot.recordId,
      range, history: { entries, nextCursor: null } });
    const packed = packProviderAccountUsagePageProjectionV1(projection);
    const opened = unpackProviderAccountUsagePageProjectionV1(packed);
    expect(new Set(opened.history.entries.map(entry => entry.snapshot.meters[0])).size).toBe(1);
    let enumerations = 0;
    // Transparent input instrumentation: retain the real packing/validation path
    // and count repeated object-rest work on the same admitted dictionary meter.
    const meter = new Proxy(opened.history.entries[0]!.snapshot.meters[0]!, {
      ownKeys(target) { enumerations++; return Reflect.ownKeys(target); },
    });
    for (const entry of opened.history.entries) entry.snapshot.meters[0] = meter;
    const repacked = packProviderAccountUsagePageProjectionV1(opened);
    expect(enumerations).toBe(1);
    expect(repacked).toEqual(packed);
    expect(unpackProviderAccountUsagePageProjectionV1(repacked)).toEqual(projection);
  });

  it('interns equal distinct meters and observes changed readings on the next packing invocation', () => {
    const shared = sample(100, 10).meters[0]!;
    const snapshots = [sample(100, 10), sample(200, 10), sample(300, 20)];
    snapshots[0]!.meters[0] = shared;
    snapshots[1]!.meters[0] = { ...shared };
    const projection = buildProviderAccountUsagePageProjectionV1({ recordId: snapshots[0]!.recordId, range,
      history: { entries: snapshots.map((snapshot, index) => ({ id: String(index), observedAtMs: snapshot.fetchedAtMs, snapshot })), nextCursor: null } });
    const first = packProviderAccountUsagePageProjectionV1(projection);
    expect(first.meters).toHaveLength(2);
    expect(unpackProviderAccountUsagePageProjectionV1(first).history.entries.map(entry => entry.snapshot.meters[0]!.used))
      .toEqual([10, 10, 20]);
    Object.assign(shared, { used: 30, remaining: 70, utilizationPct: 30 });
    const second = packProviderAccountUsagePageProjectionV1(projection);
    expect(second.meters).toHaveLength(3);
    expect(unpackProviderAccountUsagePageProjectionV1(second).history.entries.map(entry => entry.snapshot.meters[0]!.used))
      .toEqual([30, 10, 20]);
  });

  it.each(['plain', 'e2ee'] as const)('admits the HTTP %s read and refuses malformed envelopes and protected bodies', accountMode => {
    const projection = buildProviderAccountUsagePageProjectionV1({ recordId: history.entries[0]!.snapshot.recordId, range, history });
    const last = history.entries.at(-1)!;
    const content = sealProviderAccountUsagePageProjectionV1({ accountMode, material, projection,
      randomBytes: length => new Uint8Array(length).fill(9) });
    const stored = { encoding: PROVIDER_ACCOUNT_USAGE_PAGE_ENCODING, recordId: projection.recordId,
      demand: { range, resolution: projection.resolution }, observationCount: history.entries.length,
      frontier: { id: last.id, observedAtMs: last.observedAtMs }, content };
    const value = { projection: stored, complete: true };
    const open = (value: unknown) => openProviderAccountUsagePageProjectionReadV1({ value, recordId: projection.recordId, accountMode, material });
    expect(open(value).opened).toEqual(projection);
    expect(() => open({ ...value, unexpected: true })).toThrow();
    expect(() => open({ ...value, projection: { ...stored, content: { ...content, unexpected: true } } })).toThrow();
    const packed = sealProviderAccountUsagePageProjectionV1({ projection, accountMode: 'plain' });
    if (packed.t !== 'plain') throw new Error('Expected plain test data');
    for (const malformed of [{ ...packed.v, unexpected: true }, { ...packed.v, observations: [[0, [999], null, [['id', 1, 0, null]]]] }]) {
      const content = accountMode === 'plain' ? { t: 'plain', v: malformed } : { t: 'encrypted',
        c: sealAccountScopedBlobCiphertext({ kind: 'provider_account_usage_page_projection', material,
          randomBytes: length => new Uint8Array(length).fill(9), payload: malformed }) };
      expect(() => open({ ...value, projection: { ...stored, content } })).toThrow();
    }
    expect(() => openProviderAccountUsagePageProjectionReadV1({ value, recordId: projection.recordId,
      accountMode: accountMode === 'plain' ? 'e2ee' : 'plain', material })).toThrow();
  });
  it.each(['plain', 'e2ee'] as const)('admits a current protected %s body without an outer metadata marker, but requires the marker on writes', accountMode => {
    const projection = buildProviderAccountUsagePageProjectionV1({ recordId: history.entries[0]!.snapshot.recordId, range, history });
    const last = history.entries.at(-1)!;
    const stored = { recordId: projection.recordId, demand: { range, resolution: projection.resolution },
      frontier: { id: last.id, observedAtMs: last.observedAtMs }, observationCount: history.entries.length,
      content: sealProviderAccountUsagePageProjectionV1({ accountMode, material, projection, randomBytes: length => new Uint8Array(length).fill(9) }) };
    const admitted = ProviderAccountUsagePageProjectionMetadataV1Schema.parse(stored);
    expect(admitted).toEqual(stored);
    expect(openProviderAccountUsagePageProjectionV1({ recordId: projection.recordId, accountMode, material, content: admitted!.content })).toEqual(projection);
    expect(ProviderAccountUsagePageProjectionWriteV1Schema.safeParse(stored).success).toBe(false);
  });
  it('rejects unpacked development bodies through the current schema and retains mode and corruption failures', () => {
    const projection = buildProviderAccountUsagePageProjectionV1({ recordId: history.entries[0]!.snapshot.recordId, range, history });
    const content = { t: 'encrypted' as const, c: sealAccountScopedBlobCiphertext({ kind: 'provider_account_usage_page_projection',
      material, randomBytes: length => new Uint8Array(length).fill(9), payload: { ...projection } }) };
    expect(() => openProviderAccountUsagePageProjectionV1({ recordId: projection.recordId, accountMode: 'e2ee', material, content }))
      .toThrowError(expect.objectContaining({ name: '$ZodError' }));
    expect(() => openProviderAccountUsagePageProjectionV1({ recordId: 'other', accountMode: 'e2ee', material, content }))
      .toThrowError(expect.objectContaining({ name: '$ZodError' }));
    expect(ProviderAccountUsagePageProjectionMetadataV1Schema.safeParse({ recordId: projection.recordId,
      demand: { range, resolution: projection.resolution }, frontier: null, observationCount: 0,
      content: { t: 'plain', v: { v: 1, recordId: projection.recordId } } }).success).toBe(false);
    expect(() => openProviderAccountUsagePageProjectionV1({ recordId: projection.recordId, accountMode: 'plain', material, content }))
      .toThrow('provider_account_usage_content_mode_mismatch');
    expect(() => openProviderAccountUsagePageProjectionV1({ recordId: projection.recordId, accountMode: 'e2ee', material: { ...material, secret: new Uint8Array(32).fill(8) }, content }))
      .toThrow('provider_account_usage_content_unavailable');
    const malformed = { t: 'encrypted' as const, c: sealAccountScopedBlobCiphertext({ kind: 'provider_account_usage_page_projection',
      material, randomBytes: length => new Uint8Array(length).fill(9), payload: { v: 1, recordId: projection.recordId, encoding: PROVIDER_ACCOUNT_USAGE_PAGE_ENCODING } }) };
    expect(() => openProviderAccountUsagePageProjectionV1({ recordId: projection.recordId, accountMode: 'e2ee', material, content: malformed }))
      .toThrowError(expect.objectContaining({ name: '$ZodError' }));
    const unknownEnvelopeField = { ...content, unexpected: true };
    expect(() => openProviderAccountUsagePageProjectionV1({ recordId: projection.recordId, accountMode: 'e2ee', material, content: unknownEnvelopeField }))
      .toThrowError(expect.objectContaining({ name: '$ZodError' }));
    const packed = sealProviderAccountUsagePageProjectionV1({ projection, accountMode: 'plain' });
    if (packed.t !== 'plain') throw new Error('Expected plain fixture');
    const unknownBodyField = { t: 'encrypted' as const, c: sealAccountScopedBlobCiphertext({ kind: 'provider_account_usage_page_projection',
      material, randomBytes: length => new Uint8Array(length).fill(9), payload: { ...packed.v, unexpected: true } }) };
    expect(() => openProviderAccountUsagePageProjectionV1({ recordId: projection.recordId, accountMode: 'e2ee', material, content: unknownBodyField }))
      .toThrowError(expect.objectContaining({ name: '$ZodError' }));
  });
  it('losslessly opens changing meter readings and irregular poll runs in a 45k document without repeated material validation', async () => {
    const start = 1_792_000_000_000;
    const entries = Array.from({ length: 45_000 }, (_, index) => {
      const at = start + index * 15_000 + index % 7;
      const used = Math.floor(index / 20) % 100;
      const snapshot = sample(at, used, start + (Math.floor(index / 5760) + 1) * 86_400_000);
      snapshot.observedAtMs = at - index % 3;
      snapshot.meters = snapshot.meters.map(meter => ({ ...meter, windowDurationMs: 86_400_000,
        remainingPct: 100 - used, usedPct: used, details: { ...meter.details, remainingPct: 100 - used } }));
      return { id: `accepted-witness-${index}`, observedAtMs: at, snapshot };
    });
    const range = { startAtMs: start, endAtMs: entries.at(-1)!.observedAtMs + 1 };
    const projection = buildProviderAccountUsagePageProjectionV1({ recordId: entries[0]!.snapshot.recordId,
      range, history: { entries, nextCursor: null } });
    const content = sealProviderAccountUsagePageProjectionV1({ projection, accountMode: 'plain' });
    const bytes = new TextEncoder().encode(JSON.stringify(content)).byteLength;
    // The previous encoding repeats full meters and three absolute clocks.
    const previousTupleBytes = new TextEncoder().encode(JSON.stringify(entries.map(entry =>
      [entry.id, entry.observedAtMs, entry.snapshot.observedAtMs, entry.snapshot.fetchedAtMs, 0, [0], 0, entry.snapshot.subscription!.observedAtMs]))).byteLength;
    expect(bytes).toBeLessThan(previousTupleBytes / 2);
    const wireContent: typeof content = JSON.parse(JSON.stringify(content));
    const session = new Session();
    session.connect();
    await session.post('HeapProfiler.enable');
    await session.post('HeapProfiler.collectGarbage');
    await session.post('HeapProfiler.startSampling', { samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
    const started = performance.now();
    let opened: ReturnType<typeof openProviderAccountUsagePageProjectionV1>;
    try {
      opened = openProviderAccountUsagePageProjectionV1({ recordId: projection.recordId, accountMode: 'plain', content: wireContent });
      const elapsedMs = performance.now() - started;
      const { profile } = await session.post('HeapProfiler.stopSampling');
      const sum = (node: typeof profile.head): number => node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
      const allocatedBytes = sum(profile.head);
      console.info(JSON.stringify({ opening45k: true, bytes, elapsedMs, allocatedBytes }));
      // Allow one packed admission plus expansion of all 45k snapshots. The
      // reproduced repeated admissions allocate 288 MB for this 1.81 MB body.
      expect(allocatedBytes).toBeLessThan(bytes * 100);
    } finally { session.disconnect(); }
    expect(opened).toEqual(projection);
    const source = { ref: { service: { pluginId: 'example.usage', localId: 'usage' }, accountId: 'account' }, bindingKind: 'account' as const };
    const project = (history: typeof projection.history) => projectProviderAccountUsageQuotaReadV1({
      input: { source, projection: { range, resolution: 'accepted_observations' } }, current: entries.at(-1)!.snapshot,
      history, nowMs: entries.at(-1)!.observedAtMs });
    expect(project(opened.history)).toEqual(project(projection.history));
    console.info(JSON.stringify({ observations: entries.length, packedBytes: bytes, previousTupleBytes }));
  }, 60_000);
  it('returns only page-consumed facts while keeping every curve point, ended window and reset witness', () => {
    const source = { ref: { service: { pluginId: 'example.usage', localId: 'usage' }, accountId: 'account' }, bindingKind: 'account' as const };
    const current = history.entries.at(-1)!.snapshot;
    const input = { input: { source, projection: { range, resolution: 'accepted_observations' as const } }, current, history, nowMs: 1100 };
    const result = projectProviderAccountUsageQuotaReadV1(input);
    expect(result.pageProjection).toBeUndefined();
    expect(result.history).toBeUndefined();
    expect(result.pageFacts).toEqual({ historyStatus: 'complete', resetWitness: history.entries.at(-1),
      earlierCurves: [{ meterId: 'week', value: deriveProviderAccountUsageEarlierWindowCurves({ current, meterId: 'week', history: history.entries.map(entry => entry.snapshot) }) }],
      witnessedResets: [{ recordId: current.recordId, meterId: 'week', windowStartAtMs: 0, resetAtMs: 1000, windowDurationMs: 1000 }] });
    expect(result.unusedCapacity).toEqual(deriveProviderAccountUsageUnusedCapacity({ history: history.entries.map(entry => entry.snapshot), nowMs: 1100 }));
    const entries = Array.from({ length: 1000 }, (_, index) => ({ id: String(index), observedAtMs: index + 1,
      snapshot: sample(index + 1, 20) }));
    const large = projectProviderAccountUsageQuotaReadV1({ ...input, history: { entries, nextCursor: null } });
    expect(large.pageFacts?.earlierCurves[0]?.value).toMatchObject({ status: 'available' });
    const curves = large.pageFacts!.earlierCurves[0]!.value;
    if (curves.status !== 'available') throw new Error('Expected witnessed curves');
    expect(curves.curves[0]?.points).toHaveLength(1000);
    const pageBytes = new TextEncoder().encode(JSON.stringify(large)).byteLength;
    const exactBytes = new TextEncoder().encode(JSON.stringify({ entries })).byteLength;
    expect(pageBytes).toBeLessThan(exactBytes);
    console.info(JSON.stringify({ acceptedObservations: entries.length, curvePoints: curves.curves[0]?.points.length, pageBytes, exactBytes }));
  });
  it('rejects a plain projection whose declared coverage differs from its protected observations', () => {
    const projection = buildProviderAccountUsagePageProjectionV1({ recordId: history.entries[0]!.snapshot.recordId, range, history });
    const last = history.entries.at(-1)!;
    const stored = { recordId: projection.recordId, encoding: PROVIDER_ACCOUNT_USAGE_PAGE_ENCODING, demand: { range, resolution: projection.resolution },
      frontier: { id: last.id, observedAtMs: last.observedAtMs }, observationCount: history.entries.length,
      content: sealProviderAccountUsagePageProjectionV1({ accountMode: 'plain', projection }) };
    expect(StoredProviderAccountUsagePageProjectionV1Schema.safeParse(stored).success).toBe(true);
    for (const mismatch of [{ observationCount: 0 }, { frontier: null }, { frontier: { ...stored.frontier, id: 'other' } },
      { demand: { ...stored.demand, range: { ...range, endAtMs: range.endAtMs + 1 } } }]) {
      expect(StoredProviderAccountUsagePageProjectionV1Schema.safeParse({ ...stored, ...mismatch }).success).toBe(false);
    }
  });
  it.each(['plain', 'e2ee'] as const)('round trips every accepted fact and immutable witness in %s mode', accountMode => {
    const projection = buildProviderAccountUsagePageProjectionV1({ recordId: history.entries[0]!.snapshot.recordId, range, history });
    const content = sealProviderAccountUsagePageProjectionV1({ projection, accountMode, material,
      randomBytes: length => new Uint8Array(length).fill(9) });
    const opened = openProviderAccountUsagePageProjectionV1({ recordId: projection.recordId, accountMode, material, content });
    expect(opened).toEqual(projection);
    const snapshots = opened.history.entries.map(entry => entry.snapshot);
    expect(opened.history).toEqual(history);
    const current = snapshots.at(-1)!;
    const before = history.entries.map(entry => entry.snapshot);
    for (const values of [snapshots, before]) {
      expect(deriveProviderAccountUsagePace({ snapshot: current, meterId: 'week', nowMs: 1100, history: values }))
        .toEqual(deriveProviderAccountUsagePace({ snapshot: current, meterId: 'week', nowMs: 1100, history: before }));
      expect(deriveProviderAccountUsageUnusedCapacity({ history: values, nowMs: 1100 }))
        .toEqual(deriveProviderAccountUsageUnusedCapacity({ history: before, nowMs: 1100 }));
      expect(deriveProviderAccountUsageEarlierWindowCurves({ current, meterId: 'week', history: values }))
        .toEqual(deriveProviderAccountUsageEarlierWindowCurves({ current, meterId: 'week', history: before }));
      expect(hasProviderAccountUsageWitnessedReset({ previous: values[2]!, current, meterId: 'week', nowMs: 1100 })).toBe(true);
    }
    if (content.t === 'encrypted') expect(JSON.stringify(content)).not.toContain('Standard');
    expect(() => openProviderAccountUsagePageProjectionV1({ recordId: projection.recordId,
      accountMode: accountMode === 'plain' ? 'e2ee' : 'plain', material, content })).toThrow();
  });

  it('shares repeated material without deleting interior observations or manufacturing range completeness', () => {
    const repeated = { entries: Array.from({ length: 1000 }, (_, index) => ({ id: String(index), observedAtMs: index + 1, snapshot: sample(index + 1, 20) })), nextCursor: null };
    const projection = buildProviderAccountUsagePageProjectionV1({ recordId: repeated.entries[0]!.snapshot.recordId, range, history: repeated });
    const content = sealProviderAccountUsagePageProjectionV1({ projection, accountMode: 'plain' });
    expect(JSON.stringify(content).length).toBeLessThan(JSON.stringify(repeated).length / 3);
    const opened = openProviderAccountUsagePageProjectionV1({ recordId: projection.recordId, accountMode: 'plain', content });
    expect(opened.history).toEqual(repeated);
    // A page with thousands of timestamp-only observations must not expand the
    // same admitted meter tree into thousands of retained copies.
    expect(opened.history.entries[0]!.snapshot.meters[0]).toBe(opened.history.entries[999]!.snapshot.meters[0]);
    expect(() => buildProviderAccountUsagePageProjectionV1({ recordId: projection.recordId, range,
      history: { ...repeated, nextCursor: { id: '999', observedAtMs: 1000 } } })).toThrow();
  });

  it('preserves absent versus null meter facts and rejects invalid dictionary references or clocks', () => {
    const entries = [100, 200, 300].map((at, index) => {
      const snapshot = sample(at, 20);
      const { remaining: _remaining, ...meter } = snapshot.meters[0]!;
      snapshot.meters = [{ ...meter, ...(index === 0 ? {} : { remaining: index === 1 ? null : 80 }),
        ...(index === 0 ? {} : { resetAtMs: index === 1 ? null : 1000 }),
        details: index === 0 ? {} : { note: 'witnessed', remainingPct: index === 1 ? null : 80 } }];
      return { id: String(index), observedAtMs: at, snapshot };
    });
    const projection = buildProviderAccountUsagePageProjectionV1({ recordId: entries[0]!.snapshot.recordId, range,
      history: { entries, nextCursor: null } });
    const content = sealProviderAccountUsagePageProjectionV1({ projection, accountMode: 'plain' });
    if (content.t !== 'plain') throw new Error('Expected plain fixture');
    const open = (value: typeof content) => openProviderAccountUsagePageProjectionV1({
      recordId: projection.recordId, accountMode: 'plain', content: value });
    expect(open(JSON.parse(JSON.stringify(content)))).toEqual(projection);
    for (const mutate of [
      (value: typeof content) => { value.v.observations[0]![1][0] = value.v.meters.length; },
      (value: typeof content) => { value.v.meters[0]![0] = value.v.meterDefinitions.length; },
      (value: typeof content) => { value.v.observations[0]![3][0]![1] = -1; },
    ]) {
      const corrupt: typeof content = JSON.parse(JSON.stringify(content));
      mutate(corrupt);
      expect(() => open(corrupt)).toThrow();
      expect(() => unpackProviderAccountUsagePageProjectionV1(corrupt.v)).toThrow();
    }
    const unknownEnvelopeField = { ...content, unexpected: true };
    const unknownPackedField = { ...content.v, unexpected: true };
    expect(() => openProviderAccountUsagePageProjectionV1({ recordId: projection.recordId, accountMode: 'plain',
      content: unknownEnvelopeField })).toThrow();
    expect(() => unpackProviderAccountUsagePageProjectionV1(unknownPackedField)).toThrow();
  });

  it('omits per-fetch diagnostics from page history while preserving every displayed fact and witness', () => {
    const entries = Array.from({ length: 1000 }, (_, index) => {
      const snapshot = sample(index + 1, 20);
      return { id: String(index), observedAtMs: index + 1, snapshot: { ...snapshot,
        diagnostics: [{ kind: 'provider_http' as const, observedAtMs: index + 1,
          headers: { 'x-request-id': `request-${index}` }, status: 200 }] } };
    });
    const projection = buildProviderAccountUsagePageProjectionV1({ recordId: entries[0]!.snapshot.recordId, range,
      history: { entries, nextCursor: null } });
    const content = sealProviderAccountUsagePageProjectionV1({ projection, accountMode: 'plain' });
    const opened = openProviderAccountUsagePageProjectionV1({ recordId: projection.recordId, accountMode: 'plain', content });
    expect(opened.history.entries).toEqual(entries.map(({ snapshot: { diagnostics: _diagnostics, ...snapshot }, ...entry }) => ({ ...entry, snapshot })));
    expect(JSON.stringify(content).length).toBeLessThan(JSON.stringify(entries).length / 3);
    // The exact input remains available to the separate history/witness reader.
    expect(entries[999]!.snapshot.diagnostics[0]!.observedAtMs).toBe(1000);
  });
});
