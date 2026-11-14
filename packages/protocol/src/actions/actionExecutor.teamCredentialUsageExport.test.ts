import { describe, expect, it } from 'vitest';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { TeamCredentialUsageQueryResultV1Schema } from '../teams/credentials/usageV1.js';
import { UsageFileResultSchema } from '../usage/usageExport.js';
import { UiActionDispatchRequestV1Schema, parseClientActionDispatchResult } from './clientDispatchV1.js';

const tokens = { input: 10, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 12 };
const totals = { eventCount: 1, requestCount: 1, tokens, cost: { reportedUsd: 0, estimatedUsd: 2, effectiveUsd: 2, currency: 'USD' } };
const result = TeamCredentialUsageQueryResultV1Schema.parse({ v: 1, totals,
  coverage: { requestAdmissionCount: 1, agentObservationCount: 1, externalTerminalObservationCount: 0,
    directRecordedUseOnly: false, requestCountCoverage: 'complete', tokenCoverage: 'complete',
    costCoverage: 'complete', unobservedExternalRequestCount: 0 },
  series: [], breakdown: [{ key: 'first', label: 'First', totals }], nextCursor: 'next', limits: [] });
const query = { resourceId: 'resource-1', startMs: 0, endMs: 1000, granularity: 'day', costMode: 'estimated', breakdown: 'model' } as const;
const context = { surface: 'agent', serverId: 'home-1', expectedAccountId: 'alice' } as const;

describe('Team credential usage export Action', () => {
  it('delivers the export query to its keyholding client without a resource display name', async () => {
    const delivered: unknown[] = [];
    const clientFile = UsageFileResultSchema.parse({
      v: 1,
      mediaType: 'text/csv',
      fileName: 'team-credential-usage.csv',
      base64: 'YQ==',
      fields: ['totals'],
      asOfMs: null,
    });
    // The connected app is the real cross-process boundary; Action admission and
    // the strict client carrier remain under the production executor.
    const clientActionExecute: NonNullable<ActionExecutorDeps['clientActionExecute']> = async invocation => {
      const { execute: _execute, executeChild: _executeChild, ...request } = invocation;
      const wire = UiActionDispatchRequestV1Schema.parse({ v: 1, ...request,
        context: { surface: invocation.context.surface, authority: invocation.context.authority } });
      delivered.push(wire);
      expect(wire.input).toEqual({ query, breakdownRowCount: 2 });
      expect(wire.input).not.toHaveProperty('resourceName');
      return parseClientActionDispatchResult(wire.actionId, { v: 1,
        execution: { ok: true, result: clientFile } })!;
    };

    const exported = await createActionExecutor({ clientActionExecute } as ActionExecutorDeps)
      .execute('teams.credentials.usage.export', { query, breakdownRowCount: 2 }, {
        ...context,
        authority: 'account_automation',
        bypassApprovals: true,
      });

    expect(exported).toEqual({ ok: true, result: clientFile });
    expect(delivered).toHaveLength(1);
  });

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

  it('requires the export root and its Machine target grant before client delivery', async () => {
    const granted = { ...context, externalActionTarget: { kind: 'machine' as const, machineId: 'machine-1' },
      externalActionCredential: { accountId: 'alice', principalId: 'token', credentialId: 'token', grant: {
        v: 1 as const, actions: { families: [], ids: ['teams.credentials.usage.export'] },
        targets: { sessions: [], machines: ['machine-1'] }, approve: false, origins: [], models: null,
        permissionModes: null, create: null,
      } } };
    let deliveries = 0;
    const clientFile = UsageFileResultSchema.parse({
      v: 1, mediaType: 'text/csv', fileName: 'team-credential-usage.csv', base64: 'YQ==', fields: ['totals'], asOfMs: null,
    });
    const executor = createActionExecutor({ clientActionExecute: async () => {
      deliveries += 1;
      return { ok: true, result: clientFile };
    } } as ActionExecutorDeps);
    expect(await executor.execute('teams.credentials.usage.export', { query }, granted))
      .toMatchObject({ ok: true });
    expect(deliveries).toBe(1);
    for (const denied of [
      { ...granted, externalActionTarget: { kind: 'machine' as const, machineId: 'other-machine' } },
      { ...granted, externalActionCredential: { ...granted.externalActionCredential,
        grant: { ...granted.externalActionCredential.grant, actions: { families: [], ids: ['teams.credentials.usage.query'] } } } },
    ]) expect(await executor.execute('teams.credentials.usage.export', { query }, denied))
      .toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
    expect(deliveries).toBe(1);
  });
});
