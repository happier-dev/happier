import { describe, expect, it } from 'vitest';
import { executeUsageAction } from './usageActions.js';
import { normalizeUsageQuery } from '../../inputs/usageQuery.js';
import { resolveUsagePageAggregation } from '../../usage/resolveUsagePageAggregation.js';
import type { UsageAnalyticsQueryResponse } from '../../usage/usageAnalyticsContracts.js';
import { createActionExecutor } from '../actionExecutor.js';
import type { ActionExecutorDeps } from './types.js';
import { clientActionUnavailable } from '../clientDispatchV1.js';

const query = normalizeUsageQuery({ period: { startMs: 100, endMs: 900 } });
const response: UsageAnalyticsQueryResponse = { v: 1, totals: { eventCount: 1,
  tokens: { input: 10, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 12 },
  cost: { reportedUsd: 1, estimatedUsd: 0, currency: 'USD' } } };

describe('usage recap Action composition', () => {
  it('returns the same selected compose data and explicit image unavailability to a headless caller', async () => {
    const result = await executeUsageAction('usage.recap.export',
      { query, style: 'sigil', format: 'story', selectedFields: ['tokens'] }, {
        query: async request => resolveUsagePageAggregation({ queries: request.queries,
          accounting: [{ query, value: response, status: 'available', asOfMs: 900 }] }),
      }, {});
    expect(result).toMatchObject({ ok: true, result: { kind: 'unavailable', reason: 'render_target_unavailable',
      compose: { kind: 'composed', style: 'sigil', format: 'story', selectedFields: ['tokens'], asOfMs: 900,
        facts: { tokens: { total: 12 } } } } });
    expect(JSON.stringify(result)).not.toContain('reportedUsd');
  });

  it('renders only the authorized selected compose model into strict file bytes, retaining its manifest and as-of', async () => {
    let pixelsInput: unknown;
    const result = await executeUsageAction('usage.recap.export',
      { query, style: 'terminal', format: 'link-preview', selectedFields: ['tokens', 'modelMix'] }, {
        query: async request => resolveUsagePageAggregation({ queries: request.queries,
          accounting: [{ query, value: response, status: 'available', asOfMs: 900 }] }),
        // Text/font rasterization is the genuine client renderer boundary.
        renderRecap: async composed => { pixelsInput = composed; return { kind: 'rendered', base64: 'iVBORw==' }; },
      }, {});
    expect(pixelsInput).toMatchObject({ kind: 'composed', style: 'terminal', format: 'link-preview',
      selectedFields: ['tokens', 'modelMix'], facts: { tokens: { total: 12 } } });
    expect(JSON.stringify(pixelsInput)).not.toMatch(/reportedUsd|private|USD/);
    expect(result).toMatchObject({ ok: true, result: { kind: 'exported', file: {
      v: 1, mediaType: 'image/png', base64: 'iVBORw==', selectedFields: ['tokens', 'modelMix'], asOfMs: 900,
    } } });
    if (!result.ok || typeof result.result !== 'object' || result.result === null || !('file' in result.result)) throw new Error('missing image');
    expect(JSON.stringify(result.result)).not.toContain('reportedUsd');
  });

  it('retires PNG bytes if rendering finishes after cancellation', async () => {
    const controller = new AbortController();
    const result = await executeUsageAction('usage.recap.export', { query, selectedFields: ['tokens'] }, {
      query: async request => resolveUsagePageAggregation({ queries: request.queries,
        accounting: [{ query, value: response, status: 'available' }] }),
      renderRecap: async () => { controller.abort(); return { kind: 'rendered', base64: 'iVBORw==' }; },
    }, { signal: controller.signal });
    expect(result).toEqual({ ok: false, errorCode: 'cancelled', error: 'cancelled' });
  });
  it('admits client placement before dispatch and retains compose-only fallback without a connected client', async () => {
    const deps = {
      isActionApprovalRequired: () => false,
      isApprovalExecutionOriginCurrent: async () => true,
      usageActions: { query: async (request: Parameters<NonNullable<ActionExecutorDeps['usageActions']>['query']>[0]) =>
        resolveUsagePageAggregation({ queries: request.queries, accounting: [{ query, value: response, status: 'available' }] }) },
    };
    // Other Action family ports are unreachable in this owner-focused fixture.
    const headless = createActionExecutor(deps as unknown as ActionExecutorDeps);
    const input = { query, selectedFields: ['tokens'] };
    const context = { surface: 'agent' as const, authority: 'account_automation' as const, actionCaller: { kind: 'host' as const } };
    expect(await headless.execute('usage.recap.export', input, context)).toMatchObject({ ok: true,
      result: { kind: 'unavailable', reason: 'render_target_unavailable', compose: { kind: 'composed', facts: { tokens: { total: 12 } } } } });
    const client = createActionExecutor({ ...deps, clientActionExecute: async (request: Parameters<NonNullable<ActionExecutorDeps['clientActionExecute']>>[0]) => {
      expect(request.actionId).toBe('usage.recap.export');
      return executeUsageAction('usage.recap.export', request.input, { ...deps.usageActions,
        renderRecap: async () => ({ kind: 'rendered', base64: 'iVBORw==' }) }, request.context);
    } } as unknown as ActionExecutorDeps);
    expect(await client.execute('usage.recap.export', input, context)).toMatchObject({ ok: true, result: { kind: 'exported', file: { base64: 'iVBORw==' } } });
    expect(await client.execute('usage.recap.export', { ...input, node: 'forged' }, context)).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(await headless.execute('usage.recap.export', input, { ...context, surface: 'rpc' })).toMatchObject({ ok: false });
  });
  it('returns the compose model when the actual client dispatcher declares no client, never rendering on its headless host', async () => {
    // Other Action family ports are unreachable in this owner-focused fixture.
    const executor = createActionExecutor({
      isActionApprovalRequired: () => false, isApprovalExecutionOriginCurrent: async () => true,
      clientActionExecute: async ({ actionId }: Parameters<NonNullable<ActionExecutorDeps['clientActionExecute']>>[0]) => clientActionUnavailable(actionId),
      usageActions: {
        query: async (request: Parameters<NonNullable<ActionExecutorDeps['usageActions']>['query']>[0]) =>
          resolveUsagePageAggregation({ queries: request.queries, accounting: [{ query, value: response, status: 'available' }] }),
        renderRecap: async () => { throw new Error('A headless host must not render'); },
      },
    } as unknown as ActionExecutorDeps);
    expect(await executor.execute('usage.recap.export', { query, selectedFields: ['tokens'] },
      { surface: 'cli', authority: 'account_automation', actionCaller: { kind: 'host' } })).toMatchObject({ ok: true,
      result: { kind: 'unavailable', reason: 'render_target_unavailable', compose: { kind: 'composed', facts: { tokens: { total: 12 } } } } });
  });
  it('retains denied and uncertain client dispatch outcomes instead of falling back to another read', async () => {
    for (const errorCode of ['denied', 'outcome_uncertain']) {
      const refused = { ok: false as const, errorCode, error: errorCode };
      // Authentication/connected-client transport are genuine system boundaries.
      const executor = createActionExecutor({ isActionApprovalRequired: () => false,
        isApprovalExecutionOriginCurrent: async () => true, clientActionExecute: async () => refused,
        usageActions: { query: async () => { throw new Error('A terminal refusal must not reread'); } },
      } as unknown as ActionExecutorDeps);
      expect(await executor.execute('usage.recap.export', { query },
        { surface: 'agent', authority: 'account_automation', actionCaller: { kind: 'host' } })).toEqual(refused);
    }
  });
  it('reads the exact admitted query at the incumbent batch boundary and returns a private data preview', async () => {
    const result = await executeUsageAction('usage.recap.compose', { query, selectedFields: ['tokens', 'parallel', 'night'] }, {
      // Query is the authenticated transport boundary; all composition beneath it is real.
      query: async request => resolveUsagePageAggregation({ queries: request.queries,
        accounting: [{ query, value: response, status: 'available', asOfMs: 900 }],
        howYouWork: [{ query, nightHours: { startHour: 22, endHour: 6 }, detail: { status: 'partial',
          permissions: [], acceptedInputs: [], facts: [{ workId: 'private-work', machineId: 'private-machine', agentId: 'agent',
            evidenceId: 'private-evidence', kind: 'busy', startMs: 200, endMs: 500 }] } }] }),
    }, {});
    expect(result).toMatchObject({ ok: true, result: { kind: 'composed', style: 'daybreak', format: 'square',
      period: { startMs: 100, endMs: 900 }, coverage: { intervals: { detailStatus: 'partial' } },
      facts: { tokens: { total: 12 }, parallel: { sumAgentMs: 300, unionElapsedMs: 300, maximumConcurrency: 1 },
        night: { observedBusyMs: 300 } } } });
    expect(JSON.stringify(result)).not.toContain('reportedUsd');
    expect(JSON.stringify(result)).not.toContain('private-work');
  });

  it('does not disclose a read completed after authority retirement cancels its context', async () => {
    const controller = new AbortController();
    const result = await executeUsageAction('usage.recap.compose', { query }, {
      query: async request => { controller.abort(); return resolveUsagePageAggregation({ queries: request.queries,
        accounting: [{ query, value: response, status: 'available' }] }); },
    }, { signal: controller.signal });
    expect(result).toEqual({ ok: false, errorCode: 'cancelled', error: 'cancelled' });
  });
});
