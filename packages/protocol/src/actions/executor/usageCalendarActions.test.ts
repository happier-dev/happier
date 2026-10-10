import { describe, expect, it } from 'vitest';
import { executeUsageAction } from './usageActions.js';
import { normalizeUsageQuery } from '../../inputs/usageQuery.js';
import { resolveUsagePageAggregation } from '../../usage/resolveUsagePageAggregation.js';
import { UsageFileResultSchema } from '../../usage/usageExport.js';
import { decodeBase64 } from '../../crypto/base64.js';
import type { ConnectedServiceQuotaGetResultV1 } from '../../connect/providerAccountUsageHistorySchemasV1.js';
import { buildProviderAccountUsageRecordId } from '../../connect/providerAccountUsagePrimitives.js';

const query = normalizeUsageQuery({ period: { startMs: 100, endMs: 200 }, timeZoneOffsetMinutes: -240 });
const account = { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'work' };
const resetAtMs = Date.UTC(2026, 9, 10, 4, 30);
const renewalAtMs = Date.UTC(2026, 9, 11, 4, 30);
const recordKey = { providerId: 'openai', accountSubjectId: 'work', subjectKind: 'account' as const, quotaScope: 'account' as const };
const quota: ConnectedServiceQuotaGetResultV1 = {
  source: { bindingKind: 'account', ref: account },
  current: { v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey, providerId: 'openai',
    accountSubject: { kind: 'providerSubject', id: 'work' }, observedAtMs: 100, fetchedAtMs: 100,
    source: 'providerHttp', confidence: 'confirmed', staleAfterMs: 1000, state: 'loaded_data',
    meters: [{ meterId: 'week', label: `Week\nBEGIN:VEVENT${'🗓️'.repeat(30)}`, used: 20, limit: 100, usedPct: 20, utilizationPct: 20, unit: 'count', status: 'ok', resetAtMs, resetsAt: resetAtMs }],
    subscription: { status: 'subscribed', observedAtMs: 100, staleAfterMs: 1000, renewal: 'on', currentPeriodEndAtMs: renewalAtMs } },
  pace: [], targets: [], waitingWork: { status: 'available', entries: [] },
};
const selectedEvents = [{ account, kind: 'reset', meterId: 'week' }, { account, kind: 'renewal' }] as const;
const read = (reads: readonly ConnectedServiceQuotaGetResultV1[]) => async (request: Parameters<typeof resolveUsagePageAggregation>[0]['queries']) =>
  resolveUsagePageAggregation({ queries: request, quota: { value: reads, status: 'available', asOfMs: 100 } });

describe('calendar export through admitted Usage Action reads', () => {
  it('returns only selected witnessed reset/renewal instants, stable identities and escaped calendar text', async () => {
    const result = await executeUsageAction('usage.calendar.export', { query, selectedEvents }, {
      query: async request => read([quota])(request.queries),
    }, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const file = UsageFileResultSchema.parse(result.result);
    expect(file).toMatchObject({ mediaType: 'text/calendar', fileName: 'usage-calendar.ics', fields: ['resets', 'renewals'], asOfMs: 100 });
    const text = new TextDecoder().decode(decodeBase64(file.base64));
    expect(text).toContain('DTSTART:20261010T043000Z\r\n');
    expect(text).toContain('DTSTART:20261011T043000Z\r\n');
    expect(text.match(/\r\nBEGIN:VEVENT\r\n/g)).toHaveLength(2);
    expect(text).toContain('Week\\nBEGIN:VEVENT');
    expect(text.split('\r\n').every(line => new TextEncoder().encode(line).length <= 75)).toBe(true);
    expect(text.replace(/\r\n /g, '')).toContain('🗓️'.repeat(30));
    const reversed = await executeUsageAction('usage.calendar.export', { query, selectedEvents: [...selectedEvents].reverse() }, {
      query: async request => read([quota])(request.queries),
    }, {});
    expect(reversed).toEqual(result);
    const refreshed = await executeUsageAction('usage.calendar.export', { query, selectedEvents }, {
      query: async request => read([{ ...quota, current: { ...quota.current!, observedAtMs: 150, fetchedAtMs: 150 } }])(request.queries),
    }, {});
    expect(refreshed.ok).toBe(true);
    if (!refreshed.ok) return;
    const refreshedText = new TextDecoder().decode(decodeBase64(UsageFileResultSchema.parse(refreshed.result).base64));
    expect(refreshedText.match(/UID:[^\r]+/g)).toEqual(text.match(/UID:[^\r]+/g));
    expect(text).not.toContain(account.accountId);
  });

  it('refuses missing dates and foreign selections instead of fabricating an empty calendar', async () => {
    const withoutDate = { ...quota, current: { ...quota.current!, meters: [{ ...quota.current!.meters[0]!, resetAtMs: null, resetsAt: null }] } };
    const outsideCalendarDate = { ...quota, current: { ...quota.current!, meters: [{ ...quota.current!.meters[0]!,
      resetAtMs: Date.UTC(10000, 0, 1), resetsAt: Date.UTC(10000, 0, 1) }] } };
    const invalidCalendarLabel = { ...quota, current: { ...quota.current!, meters: [{ ...quota.current!.meters[0]!, label: 'Week\u0000' }] } };
    for (const [reads, events] of [[ [withoutDate], [selectedEvents[0]] ], [ [outsideCalendarDate], [selectedEvents[0]] ],
      [ [invalidCalendarLabel], [selectedEvents[0]] ],
      [ [quota], [{ account: { ...account, accountId: 'foreign' }, kind: 'renewal' }] ]] as const) {
      expect(await executeUsageAction('usage.calendar.export', { query, selectedEvents: events }, {
        query: async request => read(reads)(request.queries),
      }, {})).toMatchObject({ ok: false, errorCode: 'usage_calendar_fact_unavailable' });
    }
  });

  it('retires calendar bytes when the captured read is cancelled', async () => {
    const controller = new AbortController();
    expect(await executeUsageAction('usage.calendar.export', { query, selectedEvents }, {
      query: async request => { controller.abort(); return read([quota])(request.queries); },
    }, { signal: controller.signal })).toMatchObject({ ok: false, errorCode: 'cancelled' });
  });

  it('uses the explicit retained-B port without stale query fallback and verifies its exact qualified source', async () => {
    const requested: unknown[] = [];
    const explicit = await executeUsageAction('usage.calendar.export', { query, selectedEvents }, {
      query: async () => { throw new Error('Calendar selected B does not require accounting'); },
      readQuota: async input => { requested.push(input); return quota; },
    }, {});
    expect(explicit.ok).toBe(true);
    expect(requested).toEqual([{ source: quota.source }]);
    for (const result of [{ ok: false, errorCode: 'denied', error: 'denied' },
      { ...quota, source: { ...quota.source, ref: { ...account, accountId: 'foreign' } } }] as const) {
      expect(await executeUsageAction('usage.calendar.export', { query, selectedEvents }, {
        query: async request => read([quota])(request.queries), readQuota: async () => result,
      }, {})).toMatchObject({ ok: false, errorCode: 'ok' in result ? 'denied' : 'usage_quota_result_invalid' });
    }
    const controller = new AbortController();
    expect(await executeUsageAction('usage.calendar.export', { query, selectedEvents }, {
      query: async request => read([quota])(request.queries),
      readQuota: async () => { controller.abort(); return quota; },
    }, { signal: controller.signal })).toMatchObject({ ok: false, errorCode: 'cancelled' });
  });
});
