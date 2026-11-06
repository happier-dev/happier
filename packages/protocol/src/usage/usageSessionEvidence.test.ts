import { describe, expect, it } from 'vitest';
import { normalizeUsageQuery } from '../inputs/usageQuery.js';
import * as evidence from './usageSessionEvidence.js';

describe('Usage Session evidence demand', () => {
    it('decodes one header and individually admitted result records across fragmented lines', () => {
        const query = normalizeUsageQuery({ period: { startMs: 100, endMs: 200 } });
        const requests = [{ query, sessionIds: ['session-🌍'] }];
        const part = { sessionId: 'session-🌍', detail: { status: 404, body: { error: 'Session not found' } } };
        const headers: unknown[] = [], results: unknown[] = [];
        const decoder = evidence.createUsageSessionEvidenceStreamDecoder({ onRequests: value => headers.push(value),
            onResult: value => results.push(value) });
        const wire = `${JSON.stringify({ requests })}\r\n\n${JSON.stringify(part)}`;
        for (let index = 0; index < wire.length; index += 3) decoder.write(wire.slice(index, index + 3));
        decoder.finish();
        expect(headers).toEqual([requests]);
        expect(results).toEqual([part]);
    });

    it('rejects missing headers, duplicate headers, malformed records and truncated records', () => {
        for (const wire of ['', '{}\n', '{"requests":[]}\n{"requests":[]}\n',
            '{"requests":[]}\n{"sessionId":5}\n', '{"requests":[]}\n{"sessionId":']) {
            const decoder = evidence.createUsageSessionEvidenceStreamDecoder({ onRequests: () => {}, onResult: () => {} });
            expect(() => { decoder.write(wire); decoder.finish(); }).toThrow();
        }
        const headers: unknown[] = [];
        const empty = evidence.createUsageSessionEvidenceStreamDecoder({ onRequests: value => headers.push(value), onResult: () => {} });
        empty.write('{"requests":[]}\n');
        empty.finish();
        expect(headers).toEqual([[]]);
    });

    it('delivers aggregate results incrementally and propagates consumer failures', () => {
        let count = 0;
        const decoder = evidence.createUsageSessionEvidenceStreamDecoder({ onRequests: () => {}, onResult: () => { count += 1; } });
        decoder.write('{"requests":[]}\n');
        const line = JSON.stringify({ sessionId: 'session', detail: { status: 404, body: { error: 'Session not found' } } }) + '\n';
        for (let index = 0; index < 10_000; index += 1) decoder.write(line);
        expect(count).toBe(10_000);
        decoder.finish();
        const failure = new Error('consumer closed');
        const rejected = evidence.createUsageSessionEvidenceStreamDecoder({ onRequests: () => { throw failure; }, onResult: () => {} });
        expect(() => rejected.write('{"requests":[]}\n')).toThrow(failure);
    });

    it('reuses identical admitted Session evidence across presentation changes while isolating periods and membership', () => {
        const base = normalizeUsageQuery({ period: { relative: 'all' } });
        const key = evidence.getUsageSessionEvidenceDemandKey(base, 1000, ['b', 'a', 'a']);
        expect(evidence.getUsageSessionEvidenceDemandKey(normalizeUsageQuery({ ...base, metric: 'cost', granularity: 'hour' }), 1000, ['a', 'b'])).toBe(key);
        expect(evidence.getUsageSessionEvidenceDemandKey(base, 1001, ['a', 'b'])).toBe(key);
        expect(evidence.getUsageSessionEvidenceDemandKey(base, 1000, ['a'])).not.toBe(key);
        expect(evidence.getUsageSessionEvidenceDemandKey(normalizeUsageQuery({ ...base, includeTranscriptEvidence: false }), 1000, ['a', 'b'])).not.toBe(key);
        expect(evidence.getUsageSessionEvidenceDemandKey(normalizeUsageQuery({ ...base, machines: ['a'] }), 1000, undefined)).not.toBe(
            evidence.getUsageSessionEvidenceDemandKey(normalizeUsageQuery({ ...base, machines: ['b'] }), 1000, undefined));
        expect(evidence.getUsageSessionEvidenceDemandKey(normalizeUsageQuery({ ...base, agents: ['claude'] }), 1000, [])).not.toBe(
            evidence.getUsageSessionEvidenceDemandKey(normalizeUsageQuery({ ...base, agents: ['codex'] }), 1000, []));
        expect(evidence.getUsageSessionEvidenceDemandKey(base, 1000, undefined)).not.toBe(evidence.getUsageSessionEvidenceDemandKey(base, 1000, []));
        const withoutDetail = normalizeUsageQuery({ ...base, includeSessionEvidence: false });
        expect(evidence.getUsageSessionEvidenceDemandKey(withoutDetail, 1000, ['a', 'b'])).toBe(
            evidence.getUsageSessionEvidenceDemandKey(normalizeUsageQuery({ ...withoutDetail, includeTranscriptEvidence: false }), 1000, ['b', 'a']));
    });

    it.each(['today', '7days'] as const)('reuses full Session histories as the %s read clock advances within its canonical start', relative => {
        const query = normalizeUsageQuery({ period: { relative }, timeZoneOffsetMinutes: 330 });
        const nowMs = Date.UTC(2026, 10, 5, 9);
        expect(evidence.getUsageSessionEvidenceDemandKey(query, nowMs + 60_000, ['session']))
            .toBe(evidence.getUsageSessionEvidenceDemandKey(query, nowMs, ['session']));
    });

    it('isolates changed canonical starts and named windows without imposing a day expiry on All', () => {
        const beforeLocalMidnight = Date.UTC(2026, 10, 5, 18, 29, 59);
        const afterLocalMidnight = beforeLocalMidnight + 2000;
        for (const relative of ['today', '7days'] as const) {
            const query = normalizeUsageQuery({ period: { relative }, timeZoneOffsetMinutes: 330 });
            expect(evidence.getUsageSessionEvidenceDemandKey(query, afterLocalMidnight, ['session']))
                .not.toBe(evidence.getUsageSessionEvidenceDemandKey(query, beforeLocalMidnight, ['session']));
        }
        const all = normalizeUsageQuery({ period: { relative: 'all' } });
        expect(evidence.getUsageSessionEvidenceDemandKey(all, afterLocalMidnight, ['session']))
            .toBe(evidence.getUsageSessionEvidenceDemandKey(all, beforeLocalMidnight, ['session']));
        // At the epoch both starts resolve to zero, but their window intents differ.
        expect(evidence.getUsageSessionEvidenceDemandKey(all, 1000, ['session']))
            .not.toBe(evidence.getUsageSessionEvidenceDemandKey(normalizeUsageQuery({ period: { relative: 'today' } }), 1000, ['session']));
    });

    it('preserves exact numeric epoch, custom and open-ended demand bounds', () => {
        const key = (period: { startMs?: number; endMs?: number }, nowMs = 1000) =>
            evidence.getUsageSessionEvidenceDemandKey(normalizeUsageQuery({ period }), nowMs, ['session']);
        expect(key({ startMs: 0, endMs: 1000 }, 1001)).toBe(key({ startMs: 0, endMs: 1000 }));
        expect(key({ startMs: 0, endMs: 1001 })).not.toBe(key({ startMs: 0, endMs: 1000 }));
        expect(key({ startMs: 100, endMs: 1000 })).not.toBe(key({ startMs: 0, endMs: 1000 }));
        expect(key({ startMs: 0 }, 1001)).not.toBe(key({ startMs: 0 }, 1000));
        expect(key({}, 1001)).not.toBe(key({}, 1000));
    });
});
