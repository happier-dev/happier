import { afterEach, expect, it, vi } from 'vitest';
import fastify from 'fastify';

import { createActionExecutor } from '@happier-dev/protocol';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { buildProviderAccountUsageRecordId, ProviderAccountUsageSnapshotV1Schema } from '@happier-dev/protocol/connect/account-usage-primitives';
import { QualifiedProviderAccountUsageHistoryRequestV4Schema } from '@happier-dev/protocol/connect/providerAccountUsageHistory';
import { getUsageQueryKey, normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { UsageQueryBatchResultSchema } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';

import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createAccountServerActionDeps } from './accountServerActionDeps';

afterEach(() => { vi.restoreAllMocks(); resetActiveAccountSettingsSnapshotForTests(); });

it('keeps each quota period and its continuation independent in a mixed Usage batch', async () => {
  const app = fastify();
  const source = { bindingKind: 'account' as const,
    ref: { service: { pluginId: 'example.usage', localId: 'quota' }, accountId: 'work' } };
  const recordKey = { providerId: 'test', accountSubjectId: 'subject', subjectKind: 'account' as const, quotaScope: 'account' as const };
  const sample = (at: number) => ProviderAccountUsageSnapshotV1Schema.parse({ v: 1,
    recordId: buildProviderAccountUsageRecordId(recordKey), recordKey, providerId: 'test',
    accountSubject: { kind: 'providerSubject', id: 'subject' }, observedAtMs: at, fetchedAtMs: at,
    staleAfterMs: 1000, source: 'providerHttp', confidence: 'confirmed', state: 'loaded_data', meters: [] });
  const current = sample(350);
  const record = (at: number) => ({ content: { t: 'plain', v: sample(at) },
    metadata: { fetchedAt: at, staleAfterMs: 1000, status: 'ok' }, sources: [source] });
  const historyRanges: unknown[] = [];
  app.get('/v1/account/encryption/currentness', async () => ({ mode: 'plain', version: 1,
    signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }));
  app.get('/v2/account/settings', async () => ({ content: { t: 'plain', v: {} }, version: 1 }));
  app.get('/v1/account/profile', async () => ({ id: 'account', connectedAccountsV4: [{ ref: source.ref,
    status: 'connected', authenticationModeId: null, revisionSemantics: 'revisioned',
    credentialRevision: 'csr_abcdefghijklmnopqrstuvwxyz', configurationReady: true, configurationRevision: '1', scopes: [] }],
    connectedAccountGroupsV4: [] }));
  app.get('/v4/connect/qualified/provider-account-usage/sources/resolve', async () => ({
    source, recordId: current.recordId, providerAccountId: 'subject', fetchedAt: 350, staleAfterMs: 1000 }));
  app.get('/v4/connect/qualified/provider-account-usage/record', async () => record(350));
  app.get('/v4/connect/qualified/provider-account-usage/history', async request => {
    const raw = request.query as { query: string };
    const query = QualifiedProviderAccountUsageHistoryRequestV4Schema.parse(JSON.parse(raw.query));
    if (!('history' in query)) throw new Error('Expected finite history');
    historyRanges.push(query.history.range);
    const entries = [150, 250, 350].filter(at => at >= query.history.range.startAtMs && at < query.history.range.endAtMs)
      .map(at => ({ id: `history-${at}`, observedAtMs: at, record: record(at) }));
    return { entries, nextCursor: entries.length ? { id: entries.at(-1)!.id, observedAtMs: entries.at(-1)!.observedAtMs } : null };
  });
  app.get('/v4/connect/qualified/provider-account-usage/day-summaries', async () => ({ summaries: [], missingDays: [] }));
  app.post('/v2/pending/reset-starts/read', async () => ({ entries: [] }));
  const cleanup = installAxiosFastifyAdapter({ app, origin: 'http://usage-periods.test' });
  const credentials = { token: 'owner-token', encryption: null };
  const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
    ...createAccountServerActionDeps({ token: credentials.token, credentials, serverId: 'home', serverHttpBaseUrl: 'http://usage-periods.test' }),
    readActionsSettings: () => ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { 'usage.query': ['cli'] } }),
  });
  const query = (startMs: number, endMs: number) => normalizeUsageQuery({ period: { startMs, endMs },
    includeAccounting: false, includeQuotaHistory: true, includeSessionEvidence: false, includeWorkEvidence: false });
  const first = query(100, 200);
  const second = query(200, 400);
  const samePeriod = normalizeUsageQuery({ ...second, metric: 'cost' });
  const head = normalizeUsageQuery({ ...first, includeQuotaHistory: false });
  try {
    const result = await executor.execute('usage.query', { queries: [first, second, samePeriod, head] }, { surface: 'cli', serverId: 'home' });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const slices = UsageQueryBatchResultSchema.parse(result.ok ? result.result : undefined).results;
    const read = (selected: typeof first) => slices.find(slice => slice.key === getUsageQueryKey(selected))!.quota![0]!;
    expect(read(first).history).toMatchObject({ entries: [{ observedAtMs: 150 }], nextCursor: { observedAtMs: 150 } });
    expect(read(first).history!.entries).toHaveLength(1);
    expect(read(second).history).toMatchObject({ entries: [{ observedAtMs: 250 }, { observedAtMs: 350 }], nextCursor: { observedAtMs: 350 } });
    expect(read(second).history!.entries).toHaveLength(2);
    expect(read(samePeriod)).toEqual(read(second));
    expect(read(head).history).toBeUndefined();
    expect(historyRanges).toEqual(expect.arrayContaining([{ startAtMs: 100, endAtMs: 200 }, { startAtMs: 200, endAtMs: 400 }]));
    expect(historyRanges).toHaveLength(2);
  } finally { cleanup(); await app.close(); }
});
