import { describe, expect, it } from 'vitest';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { decodeBase64 } from '../crypto/base64.js';
import { TeamCredentialUsageQueryResultV1Schema } from '../teams/credentials/usageV1.js';
import { UsageFileResultSchema } from '../usage/usageExport.js';

const tokens = { input: 10, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 12 };
const totals = { eventCount: 1, requestCount: 1, tokens, cost: { reportedUsd: 0, estimatedUsd: 2, effectiveUsd: 2, currency: 'USD' } };
const result = TeamCredentialUsageQueryResultV1Schema.parse({ v: 1, totals,
  coverage: { requestAdmissionCount: 1, agentObservationCount: 1, externalTerminalObservationCount: 0,
    directRecordedUseOnly: false, requestCountCoverage: 'complete', tokenCoverage: 'complete',
    costCoverage: 'complete', unobservedExternalRequestCount: 0 },
  series: [], breakdown: [{ key: 'first', label: 'First', totals }], nextCursor: 'next', limits: [] });
const query = { resourceId: 'resource-1', startMs: 0, endMs: 1000, granularity: 'day', costMode: 'estimated', breakdown: 'model' } as const;
const context = { surface: 'cli', serverId: 'home-1', expectedAccountId: 'alice' } as const;

describe('Team credential usage export Action', () => {
  it.each([{ kind: 'team', teamId: 'team-1' }, { kind: 'home' }] as const)(
    'answers the same $kind subject on the agent surface and preserves refusal', async subject => {
      const requests: unknown[] = [];
      let denied = false;
      // Home-domain transport is the network boundary; the real executor owns admission and codecs.
      const executor = createActionExecutor({ homeDomainAction: async request => {
        requests.push(request.input);
        return denied ? { ok: false, errorCode: 'forbidden', error: 'forbidden' } : result;
      } } as ActionExecutorDeps);
      const input = { subject, startMs: 0, endMs: 1000, granularity: 'day' };
      expect(await executor.execute('teams.credentials.usage.query', input, { ...context, surface: 'agent' }))
        .toMatchObject({ ok: true, result });
      expect(requests).toEqual([{ ...input, costMode: 'auto' }]);
      denied = true;
      expect(await executor.execute('teams.credentials.usage.query', input, { ...context, surface: 'agent' }))
        .toMatchObject({ ok: false, errorCode: 'forbidden' });
    },
  );

  it('exports only the selected ranked rows through the existing authorized usage read', async () => {
    const requests: { actionId: string; input: unknown }[] = [];
    // Home-domain transport is the network boundary; admission, schemas and CSV remain real.
    const executor = createActionExecutor({ homeDomainAction: async request => {
      requests.push({ actionId: request.actionId, input: request.input });
      expect(request.context.serverId).toBe('home-1');
      expect(request.context.expectedAccountId).toBe('alice');
      return 'cursor' in (request.input as typeof query) ? { ...result,
        totals: { ...totals, tokens: { ...tokens, total: 24 } },
        breakdown: [{ key: 'first', label: 'Updated first', totals },
          { key: 'second', label: 'Second', totals }, { key: 'third', label: 'Third', totals }], nextCursor: null } : result;
    } } as ActionExecutorDeps);
    const exported = await executor.execute('teams.credentials.usage.export', {
      query, resourceName: 'Shared model', breakdownRowCount: 2,
    }, context);
    expect(exported).toMatchObject({ ok: true });
    if (!exported.ok) return;
    const file = UsageFileResultSchema.parse(exported.result);
    expect(file).toMatchObject({ mediaType: 'text/csv', fields: ['totals', 'coverage', 'breakdowns'], asOfMs: null });
    const csv = new TextDecoder().decode(decodeBase64(file.base64));
    const [header, total] = csv.trim().split('\n').map(row => row.split(','));
    expect(total?.[header!.indexOf('tokens')]).toBe('24');
    expect(csv).toContain('Updated first');
    expect(csv).toContain('Second');
    expect(csv).not.toContain('Third');
    expect(csv).toContain('loaded_pages');
    expect(requests).toEqual([
      { actionId: 'teams.credentials.usage.query', input: query },
      { actionId: 'teams.credentials.usage.query', input: { ...query, cursor: 'next' } },
    ]);
  });

  it('keeps a typed query refusal from producing any file bytes', async () => {
    const executor = createActionExecutor({ homeDomainAction: async () => ({ ok: false,
      errorCode: 'credential_scope_denied', error: 'credential_scope_denied' }) } as ActionExecutorDeps);
    expect(await executor.execute('teams.credentials.usage.export', { query, resourceName: 'Shared model' }, context))
      .toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
  });

  it('requires the export root and its Machine target grant without requiring a second query Action grant', async () => {
    const granted = { ...context, externalActionTarget: { kind: 'machine' as const, machineId: 'machine-1' },
      externalActionCredential: { accountId: 'alice', principalId: 'token', credentialId: 'token', grant: {
        v: 1 as const, actions: { families: [], ids: ['teams.credentials.usage.export'] },
        targets: { sessions: [], machines: ['machine-1'] }, approve: false, origins: [], models: null,
        permissionModes: null, create: null,
      } } };
    let reads = 0;
    const executor = createActionExecutor({ homeDomainAction: async () => { reads++; return result; } } as ActionExecutorDeps);
    expect(await executor.execute('teams.credentials.usage.export', { query, resourceName: 'Shared model' }, granted))
      .toMatchObject({ ok: true });
    expect(reads).toBe(1);
    for (const denied of [
      { ...granted, externalActionTarget: { kind: 'machine' as const, machineId: 'other-machine' } },
      { ...granted, externalActionCredential: { ...granted.externalActionCredential,
        grant: { ...granted.externalActionCredential.grant, actions: { families: [], ids: ['teams.credentials.usage.query'] } } } },
    ]) expect(await executor.execute('teams.credentials.usage.export', { query, resourceName: 'Shared model' }, denied))
      .toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
    expect(reads).toBe(1);
  });

  it('reports a complete first page honestly and stops disclosure after cancellation', async () => {
    const controller = new AbortController();
    const executor = createActionExecutor({ homeDomainAction: async () => ({ ...result, nextCursor: null }) } as ActionExecutorDeps);
    const exported = await executor.execute('teams.credentials.usage.export', { query, resourceName: 'Shared model' }, context);
    expect(exported.ok).toBe(true);
    if (exported.ok) expect(new TextDecoder().decode(decodeBase64(UsageFileResultSchema.parse(exported.result).base64)))
      .toContain(',complete\n');
    const retired = createActionExecutor({ homeDomainAction: async () => { controller.abort(); return result; } } as ActionExecutorDeps);
    expect(await retired.execute('teams.credentials.usage.export', { query, resourceName: 'Shared model' }, { ...context, signal: controller.signal }))
      .toMatchObject({ ok: false, errorCode: 'cancelled' });
  });
});
