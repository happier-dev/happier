import { expect, it, vi } from 'vitest';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import type { UsageQueryBatchResult } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { computePluginUiArtifactSha256DigestV1 } from '@happier-dev/protocol/plugins/ui/artifactIntegrity';
import { createUsageQueryResourceContent, encodeUsageQueryResource } from './usageQueryResourceEncoding';

it('encodes an admitted batch identity once while returning independently mutable transport bytes', () => {
    const query = normalizeUsageQuery({ period: { startMs: 0, endMs: 100 } });
    const batch: UsageQueryBatchResult = { v: 1, results: [{ key: 'retained', requestedQuery: query,
        shownQuery: query, sources: [], pending: false }] };
    const expected = JSON.stringify(batch);
    const encode = vi.spyOn(TextEncoder.prototype, 'encode');
    try {
        const first = encodeUsageQueryResource(batch);
        expect(new TextDecoder().decode(first.bytes)).toBe(expected);
        encode.mockClear();
        first.bytes.fill(0);
        const revisited = encodeUsageQueryResource(batch);
        expect(new TextDecoder().decode(revisited.bytes)).toBe(expected);
        expect(encode.mock.calls, 'a warm remount must do zero native encoding passes for retained data').toHaveLength(0);
    } finally { encode.mockRestore(); }
});

it('recreates collected transport bytes with the same Unicode JSON and digest after later source progress', async () => {
    const { Session: InspectorSession } = await import('node:inspector');
    const query = normalizeUsageQuery({ period: { startMs: 0, endMs: 100 } });
    const unicode = 'λ-🌍-' + String.fromCharCode(0, 0x22, 0x5c, 0xd800, 0xdc00, 0xffff);
    const batch: UsageQueryBatchResult = { v: 1, results: [{ key: unicode, requestedQuery: query, shownQuery: query,
        comparison: { query, source: { source: 'comparison', status: 'pending' } }, sources: [], pending: true }] };
    const expectedBytes = new TextEncoder().encode(JSON.stringify(batch));
    const digest = computePluginUiArtifactSha256DigestV1(expectedBytes);
    const { content, bytes } = (() => {
        const encoded = encodeUsageQueryResource(batch).bytes;
        const content = createUsageQueryResourceContent(batch, encoded, digest);
        expect(content.bytes).toBe(encoded);
        expect(content.bytes).toBe(encoded);
        return { content, bytes: new WeakRef(encoded) };
    })();
    const settled: UsageQueryBatchResult = { ...batch, results: [{ ...batch.results[0]!, pending: false,
        comparison: { ...batch.results[0]!.comparison!, source: { source: 'comparison', status: 'available' } } }] };
    const settledBytes = encodeUsageQueryResource(settled).bytes;
    const settledContent = createUsageQueryResourceContent(settled, settledBytes, computePluginUiArtifactSha256DigestV1(settledBytes));
    const inspector = new InspectorSession();
    inspector.connect();
    try {
        await new Promise<void>(resolve => setImmediate(resolve));
        await new Promise<void>((resolve, reject) => inspector.post('HeapProfiler.collectGarbage', error => error ? reject(error) : resolve()));
        expect(bytes.deref() === undefined, 'retaining Resource content must not retain its complete buffer').toBe(true);
        const rematerialized = content.bytes;
        expect(rematerialized).toEqual(expectedBytes);
        expect(content.bytes).toBe(rematerialized);
        expect(content.digest).toBe(computePluginUiArtifactSha256DigestV1(rematerialized));
        expect(new TextDecoder().decode(settledContent.bytes)).toBe(JSON.stringify(settled));
        expect(settledContent.digest).not.toBe(content.digest);
    } finally { inspector.disconnect(); }
});

it('encodes native JSON by accounting and envelope sections and preserves exact Unicode bytes', () => {
    const query = normalizeUsageQuery({ period: { startMs: 0, endMs: 100 } });
    const tokens = { input: 1, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 1 };
    const cost = { reportedUsd: 1, estimatedUsd: 0, currency: 'USD' };
    const unicode = String.fromCharCode(0, 0x22, 0x5c, 0x7f, 0x80, 0x7ff, 0x800, 0xd7ff, 0xd800, 0x20, 0xdc00, 0xe000, 0xffff)
        + String.fromCodePoint(0x10000, 0x10ffff);
    const accounting = { v: 1 as const, totals: { eventCount: 1000, tokens, cost },
        contributions: Array.from({ length: 1000 }, (_, index) => ({ id: `${index}-λ-🌍-\ud800-${unicode}`, observedAtMs: 1,
            sessionId: null, turnId: null, agentId: null, modelId: null, machineId: null, projectKey: null,
            workspaceId: null, source: null, tokens, cost })) };
    const batch: UsageQueryBatchResult = { v: 1, results: [{ key: 'query', requestedQuery: query, shownQuery: query,
        accounting, sources: [], pending: false }] };
    const encode = vi.spyOn(TextEncoder.prototype, 'encode');
    const encodeInto = vi.spyOn(TextEncoder.prototype, 'encodeInto');
    try {
        const first = encodeUsageQueryResource(batch);
        expect(new TextDecoder().decode(first.bytes)).toBe(JSON.stringify(batch));
        expect(encode.mock.calls.reduce((count, [input]) => count + (input?.length ?? 0), 0),
            'native encoding visits the shared requested/shown query once, with members rather than scalar/key calls').toBe(
            JSON.stringify(batch).length - JSON.stringify(query).length);
        expect(encodeInto.mock.calls.length, 'native serialization must not cross the UTF-8 boundary for every key and scalar').toBe(0);
        encode.mockClear();
        const changed: UsageQueryBatchResult = { ...batch, results: [{ ...batch.results[0]!, accounting: {
            ...accounting, totals: { ...accounting.totals, eventCount: 1001 },
        } }] };
        const second = encodeUsageQueryResource(changed);
        expect(new TextDecoder().decode(second.bytes)).toBe(JSON.stringify(changed));
        expect(encode.mock.calls.reduce((count, [input]) => count + (input?.length ?? 0), 0)).toBe(
            JSON.stringify(changed).length - 2 * JSON.stringify(query).length - JSON.stringify(batch.results[0]!.sources).length);
        encode.mockClear();
        const third: UsageQueryBatchResult = { ...changed, results: [{ ...changed.results[0]!, accounting: {
            ...changed.results[0]!.accounting!, contributions: accounting.contributions.map((row, index) => index === 0
                ? { ...row, id: 'changed-λ-🌍' } : row),
        } }] };
        const thirdBytes = encodeUsageQueryResource(third);
        expect(new TextDecoder().decode(thirdBytes.bytes)).toBe(JSON.stringify(third));
        expect(encode.mock.calls.reduce((count, [input]) => count + (input?.length ?? 0), 0)).toBe(
            JSON.stringify(third).length - 2 * JSON.stringify(query).length - JSON.stringify(batch.results[0]!.sources).length);
        const mixed: UsageQueryBatchResult = { ...batch, results: [batch.results[0]!, {
            ...batch.results[0]!, key: 'comparison', accounting: undefined, costFactTotals: undefined,
            comparison: { query, accounting, source: { source: 'comparison', status: 'available' } },
        }] };
        encode.mockClear();
        const mixedBytes = encodeUsageQueryResource(mixed).bytes;
        expect(new TextDecoder().decode(mixedBytes)).toBe(JSON.stringify(mixed));
        expect(encode.mock.calls.reduce((count, [input]) => count + (input?.length ?? 0), 0),
            'shared accounting is reused at both placements while omitted fields and envelope order remain native JSON').toBe(
            JSON.stringify(mixed).length - 2 * JSON.stringify(accounting).length - 5 * JSON.stringify(query).length
                - 2 * JSON.stringify(batch.results[0]!.sources).length);
        // Native TextEncoder polyfills need not implement encodeInto.
        const descriptor = Object.getOwnPropertyDescriptor(TextEncoder.prototype, 'encodeInto');
        Object.defineProperty(TextEncoder.prototype, 'encodeInto', { configurable: true, value: undefined });
        try {
            expect(new TextDecoder().decode(encodeUsageQueryResource(batch).bytes))
                .toBe(new TextDecoder().decode(first.bytes));
        } finally {
            if (descriptor) Object.defineProperty(TextEncoder.prototype, 'encodeInto', descriptor);
            else Reflect.deleteProperty(TextEncoder.prototype, 'encodeInto');
        }
        // The complete Resource owns its output bytes; callers cannot mutate the retained fragment.
        first.bytes.fill(0);
        expect(new TextDecoder().decode(encodeUsageQueryResource(batch).bytes)).toBe(JSON.stringify(batch));
    } finally { encode.mockRestore(); encodeInto.mockRestore(); }
});


it('serializes retained accounting rows once across independent source revisions and includes changed facts', () => {
    // This Account's measured usage census has 32,975 events. Each source
    // revision shares the immutable accounting already admitted for that read.
    const eventCount = 32_975;
    const query = normalizeUsageQuery({ period: { startMs: 0, endMs: 100 } });
    let factVisits = 0;
    const tokens = { input: 1, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0,
        get total() { factVisits++; return 1; } };
    const cost = { reportedUsd: 0.000000013, estimatedUsd: 0, currency: 'USD' };
    const accounting = { v: 1 as const, totals: { eventCount, tokens, cost },
        contributions: Array.from({ length: eventCount }, (_, index) => ({ id: String(index), observedAtMs: 1,
            sessionId: null, turnId: null, agentId: null, modelId: null, machineId: null, projectKey: null,
            workspaceId: null, source: null, tokens, cost })) };
    const slice = { key: 'query', requestedQuery: query, shownQuery: query, accounting,
        sources: [{ source: 'accounting', status: 'available' as const }, { source: 'quota', status: 'pending' as const }], pending: true };
    const batch: UsageQueryBatchResult = { v: 1, results: [slice] };
    const expectedInitial = JSON.stringify(batch);
    const encode = vi.spyOn(TextEncoder.prototype, 'encode');
    try {
        factVisits = 0;
        expect(new TextDecoder().decode(encodeUsageQueryResource(batch).bytes)).toBe(expectedInitial);
        expect(factVisits).toBe(eventCount + 1);
        const settled: UsageQueryBatchResult = { ...batch, results: [{ ...slice,
            sources: [slice.sources[0]!, { source: 'quota', status: 'available' }], pending: false }] };
        const expectedSettled = JSON.stringify(settled);
        encode.mockClear();
        factVisits = 0;
        expect(new TextDecoder().decode(encodeUsageQueryResource(settled).bytes)).toBe(expectedSettled);
        expect(factVisits, 'a changed independent source must not revisit the retained accounting population').toBe(0);
        expect(encode.mock.calls.reduce((count, [input]) => count + (input?.length ?? 0), 0),
            'independent source progress must encode only the changed envelope, reusing admitted accounting UTF-8').toBe(
            expectedSettled.length - JSON.stringify(accounting).length - 2 * JSON.stringify(query).length);
        encode.mockClear();
        const changed: UsageQueryBatchResult = { ...settled, results: [{ ...settled.results[0]!, accounting: {
            ...accounting, totals: { ...accounting.totals, eventCount: eventCount + 1 },
        } }] };
        const expectedChanged = JSON.stringify(changed);
        factVisits = 0;
        expect(new TextDecoder().decode(encodeUsageQueryResource(changed).bytes)).toBe(expectedChanged);
        expect(factVisits, 'a genuinely replaced accounting answer must reach the Resource').toBe(eventCount + 1);
        expect(encode.mock.calls.reduce((count, [input]) => count + (input?.length ?? 0), 0),
            'replaced accounting must cross the native UTF-8 boundary with the changed envelope').toBe(
            expectedChanged.length - 2 * JSON.stringify(query).length - JSON.stringify(settled.results[0]!.sources).length);
    } finally { encode.mockRestore(); }
});


it('reuses comparison accounting across changed envelopes and admits its replacement without retaining envelope fields', () => {
    const query = normalizeUsageQuery({ period: { startMs: 100, endMs: 200 } });
    const previousQuery = normalizeUsageQuery({ period: { startMs: 0, endMs: 100 } });
    let factVisits = 0;
    const tokens = { input: 1, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0,
        get total() { factVisits++; return 1; } };
    const cost = { reportedUsd: 0.000000013, estimatedUsd: 0, currency: 'USD' };
    const accounting = { v: 1 as const, totals: { eventCount: 32_975, tokens, cost },
        contributions: Array.from({ length: 32_975 }, (_, index) => ({ id: String(index), observedAtMs: 1,
            sessionId: null, turnId: null, agentId: null, modelId: null, machineId: null, projectKey: null,
            workspaceId: null, source: null, tokens, cost })) };
    const comparison: NonNullable<UsageQueryBatchResult['results'][number]['comparison']> = {
        query: previousQuery, accounting, source: { source: 'comparison', status: 'pending' },
    };
    const batch: UsageQueryBatchResult = { v: 1, results: [{ key: 'query', requestedQuery: query, shownQuery: query,
        comparison, sources: [], pending: true }] };
    const expectedInitial = JSON.stringify(batch);
    factVisits = 0;
    expect(new TextDecoder().decode(encodeUsageQueryResource(batch).bytes)).toBe(expectedInitial);
    expect(factVisits).toBe(32_976);
    // Only accounting is immutable/reused; the comparison envelope is read anew.
    comparison.source.status = 'available';
    const settled: UsageQueryBatchResult = { ...batch, results: [{ ...batch.results[0]!, pending: false }] };
    const expectedSettled = JSON.stringify(settled);
    factVisits = 0;
    expect(new TextDecoder().decode(encodeUsageQueryResource(settled).bytes)).toBe(expectedSettled);
    expect(factVisits, 'a source revision must not revisit retained comparison accounting').toBe(0);
    const changed: UsageQueryBatchResult = { ...settled, results: [{ ...settled.results[0]!, comparison: {
        ...comparison, accounting: { ...accounting, totals: { ...accounting.totals, eventCount: 32_976 } },
    } }] };
    const expectedChanged = JSON.stringify(changed);
    factVisits = 0;
    expect(new TextDecoder().decode(encodeUsageQueryResource(changed).bytes)).toBe(expectedChanged);
    expect(factVisits, 'replaced comparison accounting must reach the Resource').toBe(32_976);
});


it('serializes retained non-accounting members once and encodes only replacements across progress revisions', () => {
    const query = normalizeUsageQuery({ period: { startMs: 0, endMs: 100 } });
    let factVisits = 0;
    const totals = Array.from({ length: 1000 }, (_, index) => ({ kind: 'unpriced' as const, currency: 'USD', amountUsd: null,
        tokens: { input: 1, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0,
            get total() { factVisits++; return 1; } },
        eventCount: 1, asOfMs: index, complete: true, sources: ['runtime'] }));
    const slice = { key: 'query', requestedQuery: query, shownQuery: query, costFactTotals: totals,
        sources: [{ source: 'work', status: 'pending' as const }], pending: true };
    const batch: UsageQueryBatchResult = { v: 1, results: [slice] };
    const expectedInitial = JSON.stringify(batch);
    factVisits = 0;
    const initial = encodeUsageQueryResource(batch);
    expect(new TextDecoder().decode(initial.bytes)).toBe(expectedInitial);
    expect(factVisits).toBe(totals.length);
    const settled: UsageQueryBatchResult = { ...batch, results: [{ ...slice,
        sources: [{ source: 'work', status: 'unsupported' }], pending: false }] };
    const expectedSettled = JSON.stringify(settled);
    factVisits = 0;
    expect(new TextDecoder().decode(encodeUsageQueryResource(settled).bytes)).toBe(expectedSettled);
    expect(factVisits, 'source progress must not serialize retained non-accounting facts again').toBe(0);
    const changed: UsageQueryBatchResult = { ...settled, results: [{ ...settled.results[0]!,
        costFactTotals: totals.map((fact, index) => index === 0 ? { ...fact, eventCount: 2 } : fact) }] };
    const expectedChanged = JSON.stringify(changed);
    factVisits = 0;
    expect(new TextDecoder().decode(encodeUsageQueryResource(changed).bytes)).toBe(expectedChanged);
    expect(factVisits, 'a replaced member must cross serialization once with every valid fact').toBe(totals.length);
    const shared: UsageQueryBatchResult = { ...settled, results: [{ ...settled.results[0]!,
        comparison: { query, costFactTotals: totals, source: { source: 'comparison', status: 'available' } } }] };
    const expectedShared = JSON.stringify(shared);
    factVisits = 0;
    expect(new TextDecoder().decode(encodeUsageQueryResource(shared).bytes)).toBe(expectedShared);
    expect(factVisits, 'one admitted member can appear in the main and comparison result without another serialization').toBe(0);
    // Retained fragments are private: mutating a previously returned complete body cannot corrupt them.
    initial.bytes.fill(0);
    expect(new TextDecoder().decode(encodeUsageQueryResource(batch).bytes)).toBe(expectedInitial);
});
