import { afterEach, describe, expect, it } from 'vitest';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { UsageRecapExportResultSchema, type UsageAnalyticsQueryResponse } from '@happier-dev/protocol';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { standardCleanup } from '@/dev/testkit';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { createDefaultActionExecutor } from './defaultActionExecutor';

let home: Awaited<ReturnType<typeof serveAccountHomes>> | undefined;
afterEach(() => { standardCleanup(); retireActiveServerAccountScopeLifetime(); home?.dispose(); home = undefined; });
const accounting: UsageAnalyticsQueryResponse = { v: 1, totals: { eventCount: 1,
  tokens: { input: 10, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 12 },
  cost: { reportedUsd: 99, estimatedUsd: 0, currency: 'USD' } },
  breakdowns: { model: [{ key: 'private-id', label: 'Private Model', eventCount: 1,
    tokens: { input: 10, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 12 }, cost: { reportedUsd: 99, estimatedUsd: 0, currency: 'USD' } }] } };
async function context(denied = false) {
  home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://recap-export.test', accountId: 'account-a' }],
    route: request => request.path === '/v2/usage/query'
      ? denied ? new Response('denied', { status: 403 }) : Response.json(accounting) : undefined });
  const focused = home.homes.a!;
  publishAppliedActiveServerSnapshot({ serverId: focused.id, serverUrl: focused.serverUrl, generation: 0 });
  return { surface: 'ui' as const, actionCaller: { kind: 'host' as const }, serverId: focused.id, expectedAccountId: 'account-a' };
}
const input = { query: normalizeUsageQuery({ period: { startMs: 100, endMs: 900 } }), style: 'holo', format: 'square', selectedFields: ['tokens', 'modelMix'] };

describe('recap export through the real captured UI Account Action', () => {
  it('renders the authorized selected query and delivers the same strict PNG result used by local surfaces', async () => {
    const caller = await context();
    let painted: unknown;
    // Rasterization is the client/platform boundary, never substituted Usage or Action logic.
    const executor = createDefaultActionExecutor({ usageRecapRender: async compose => {
      painted = compose;
      return { kind: 'rendered', base64: 'iVBORw==' };
    } });
    const executed = await executor.execute('usage.recap.export', input, caller);
    expect(executed.ok).toBe(true);
    if (!executed.ok) throw new Error(executed.errorCode);
    const result = UsageRecapExportResultSchema.parse(executed.result);
    expect(result).toMatchObject({ kind: 'exported', compose: painted,
      file: { mediaType: 'image/png', base64: 'iVBORw==', selectedFields: ['tokens', 'modelMix'] } });
    expect(JSON.stringify(result)).not.toMatch(/Private Model|private-id|reportedUsd|USD/);
  });
  it('withdraws PNG bytes if the real Account lifetime retires while rendering', async () => {
    const caller = await context();
    const executor = createDefaultActionExecutor({ usageRecapRender: async () => {
      retireActiveServerAccountScopeLifetime();
      return { kind: 'rendered', base64: 'iVBORw==' };
    } });
    const executed = await executor.execute('usage.recap.export', input, caller);
    expect(executed).toMatchObject({ ok: false, errorCode: 'action_account_scope_changed' });
    expect(JSON.stringify(executed)).not.toContain('iVBORw==');
  });
  it('does not render or return file bytes for an accounting permission denial', async () => {
    const caller = await context(true);
    const executor = createDefaultActionExecutor({ usageRecapRender: async () => { throw new Error('denied facts must not render'); } });
    const executed = await executor.execute('usage.recap.export', input, caller);
    expect(executed).toMatchObject({ ok: false, errorCode: 'denied' });
    expect(JSON.stringify(executed)).not.toContain('base64');
  });
});
