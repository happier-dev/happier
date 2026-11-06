import { describe, expect, it } from 'vitest';
import { executeUsageAction } from './usageActions.js';
import { normalizeUsageQuery } from '../../inputs/usageQuery.js';
import { resolveUsagePageAggregation } from '../../usage/resolveUsagePageAggregation.js';
import { UsageAnalyticsQueryResponseSchema } from '../../usage/usageAnalyticsContracts.js';
import { createActionExecutor } from '../actionExecutor.js';
import { getActionSpec } from '../actionSpecs.js';
import type { ActionExecutorDeps } from './types.js';
import { clientActionUnavailable } from '../clientDispatchV1.js';
import { projectPublicProfile } from '../../account/projectPublicProfile.js';
import { DEFAULT_PUBLIC_PROFILE_POLICY_V1 } from '../../account/publicProfile.js';
import { UsageRecapExportResultSchema } from '../../usage/usageRecap.js';

const query = normalizeUsageQuery({ period: { startMs: 100, endMs: 900 } });
const response = UsageAnalyticsQueryResponseSchema.parse({ v: 1, totals: { eventCount: 1,
  tokens: { input: 10, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 12 },
  cost: { reportedUsd: 1, estimatedUsd: 0, currency: 'USD' } } });

// Authenticated read/client renderer ports are the boundaries under test;
// unrelated executor families are unreachable in these checked partial fixtures.
describe('usage recap Action composition', () => {
  it('requests selected recap facts independently of the originating widget demand', async () => {
    const result = await executeUsageAction('usage.recap.private.compose', {
      query: { ...query, includeAccounting: false, includeInsights: false, includeActivity: false,
        includeSeries: false, includeSessionEvidence: false, includeTranscriptEvidence: false,
        includeWorkEvidence: false, includeLeaders: true, includeComparison: true, includeQuotaHistory: true },
      selectedFields: ['tokens', 'activeDays', 'streak', 'modelMix', 'agentMix', 'cache', 'rhythm', 'parallel', 'night', 'work', 'coach', 'highlights'],
    }, { query: async request => {
      const demanded = request.queries[0]!;
      expect(demanded).toMatchObject({ includeAccounting: true, includeInsights: true, includeActivity: true,
        includeSeries: true, includeSessionEvidence: true, includeTranscriptEvidence: true,
        includeWorkEvidence: true, includeLeaders: false, includeComparison: false, includeQuotaHistory: false,
        includeContributions: false, includeModelTimeline: false, includeMessageStats: false, breakdown: ['agent', 'model'] });
      return resolveUsagePageAggregation({ queries: request.queries,
        accounting: [{ query: demanded, value: response, status: 'available' }] });
    } }, {});
    expect(result).toMatchObject({ ok: true, result: { kind: 'composed', facts: { tokens: { total: 12 } } } });
  });
  it('does not acquire unrelated evidence for a tokens-only recap', async () => {
    const result = await executeUsageAction('usage.recap.private.compose', { query, selectedFields: ['tokens'] }, {
      query: async request => {
        const demanded = request.queries[0]!;
        expect(demanded).toMatchObject({ includeAccounting: true, includeInsights: false, includeActivity: false,
          includeSeries: false, includeSessionEvidence: false, includeTranscriptEvidence: false,
          includeWorkEvidence: false, includeLeaders: false, includeComparison: false, includeQuotaHistory: false,
          includeContributions: false, includeModelTimeline: false, includeMessageStats: false, breakdown: [] });
        return resolveUsagePageAggregation({ queries: request.queries,
          accounting: [{ query: demanded, value: response, status: 'available' }] });
      },
    }, {});
    expect(result).toMatchObject({ ok: true, result: { kind: 'composed', facts: { tokens: { total: 12 } } } });
  });
  it('refuses mismatched query results at read admission before composing private facts', async () => {
    const different = normalizeUsageQuery({ ...query, machines: ['other-machine'] });
    for (const mismatched of [
      resolveUsagePageAggregation({ queries: [different], accounting: [{ query: different, value: response, status: 'available' }] }),
      (() => {
        const batch = resolveUsagePageAggregation({ queries: [query], accounting: [{ query, value: response, status: 'available' }] });
        return { ...batch, results: batch.results.map(slice => ({ ...slice, shownQuery: different })) };
      })(),
    ]) {
      expect(await executeUsageAction('usage.recap.private.compose', { query, selectedFields: ['tokens'] },
        { query: async () => mismatched }, {})).toMatchObject({ ok: false, errorCode: 'usage_query_result_invalid' });
    }
  });
  it('keeps a rejected query issue path and code without returning its data', async () => {
    const raw = resolveUsagePageAggregation({ queries: [query], accounting: [{ query, value: response, status: 'available' }] });
    const rejected = { ...raw, results: raw.results.map(slice => ({ ...slice, shownQuery: normalizeUsageQuery({ ...query, machines: ['private-machine-value'] }) })) };
    const result = await executeUsageAction('usage.recap.private.compose', { query, selectedFields: ['tokens'] },
      { query: async () => rejected }, {});
    expect(result).toMatchObject({ ok: false, errorCode: 'usage_query_result_invalid', details: { issues: [
      { code: 'custom', path: ['results', 0, 'shownQuery'] },
    ] } });
    expect(JSON.stringify(result)).not.toContain('private-machine-value');
  });
  it('composes an admitted public source without querying private Usage or accepting dollars and caller DTOs', async () => {
    const view = projectPublicProfile({ context: { handle: 'owner', identity: {},
      service: { displayName: 'Home', publicBaseUrl: 'https://home.test' },
      urls: { page: 'https://home.test/@owner', json: 'https://home.test/v1/public/profiles/owner',
        badgeBase: 'https://home.test/@owner/badge', card: 'https://home.test/@owner/card.svg', og: 'https://home.test/@owner/og.png', report: 'mailto:operator@home.test' } },
      policy: { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1, fields: { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1.fields, tokens: false } },
      metadata: {}, layout: { v: 1, items: [] }, appearance: { theme: 'auto', atmosphere: { source: 'none' } },
      snapshot: { v: 1, computedAtMs: 900, period: { startMs: 100, endMs: 900, timeZoneOffsetMinutes: 0 },
        coverage: { status: 'partial', method: 'runtime' }, fieldCoverage: {},
        facts: { tokens: 987654321, activeDays: 3, highlights: [{ kind: 'active_days', count: 3 }], agentMix: [{ agentId: 'codex', share: 1, tokens: 987654321,
          coverage: { status: 'partial', method: 'runtime' } }] } },
    });
    if (!view) throw new Error('Expected public fixture');
    const deps: Partial<ActionExecutorDeps> = { usageActions: {
      query: async () => { throw new Error('Public recap must never read private Usage'); },
      readPublicProfile: async () => ({ kind: 'published', view }),
    } };
    const executor = createActionExecutor(deps as ActionExecutorDeps);
    const input = { source: { kind: 'public_profile' }, selectedFields: ['tokens', 'activeDays', 'agentMix'] };
    const result = await executor.execute('usage.recap.compose', input, { surface: 'ui' });
    expect(result).toMatchObject({ ok: true, result: { kind: 'composed', source: 'public_profile', asOfMs: null, facts: {},
      unavailableFields: ['tokens'], publicSnapshot: { facts: { activeDays: 3, agentMix: [{ share: 1 }] } } } });
    expect(JSON.stringify(result)).not.toContain('987654321');
    const highlights = await executor.execute('usage.recap.compose', { source: { kind: 'public_profile' },
      selectedFields: ['highlights'] }, { surface: 'ui' });
    expect(highlights).toMatchObject({ ok: true, result: { kind: 'composed', unavailableFields: [],
      publicSnapshot: { facts: { highlights: [{ kind: 'active_days', count: 3 }] } } } });
    expect(highlights).not.toHaveProperty('result.publicSnapshot.facts.activeDays');
    expect(await executor.execute('usage.recap.compose', { ...input, selectedFields: ['dollars'] }, { surface: 'ui' }))
      .toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(await executor.execute('usage.recap.compose', { ...input, source: { kind: 'public_profile', view } }, { surface: 'ui' }))
      .toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    const headless = createActionExecutor({ usageActions: { query: deps.usageActions!.query } } as ActionExecutorDeps);
    expect(await headless.execute('usage.recap.compose', input, { surface: 'ui' }))
      .toMatchObject({ ok: true, result: { kind: 'unavailable', reason: 'public_profile_source_unavailable' } });
  });
  it('delivers only a recap rendered from admitted facts and preserves platform cancellation', async () => {
    const deps: Partial<ActionExecutorDeps> = {
      isActionApprovalRequired: () => false,
      isApprovalExecutionOriginCurrent: async () => true,
      usageActions: {
        query: async request => resolveUsagePageAggregation({ queries: request.queries,
          accounting: [{ query: request.queries[0]!, value: response, status: 'available', asOfMs: 900 }] }),
        renderRecap: async () => ({ kind: 'rendered', base64: 'iVBORw==' }),
        deliverRecap: async (file, intent) => {
          expect(file).toMatchObject({ mediaType: 'image/png', base64: 'iVBORw==', selectedFields: ['tokens'] });
          expect(intent).toBe('share');
          return { kind: 'cancelled' };
        },
      },
    };
    const executor = createActionExecutor(deps as ActionExecutorDeps);
    const input = { query, selectedFields: ['tokens'], intent: 'share' };
    const context = { surface: 'ui' as const, actionCaller: { kind: 'host' as const } };
    expect(await executor.execute('usage.recap.private.deliver', input, context)).toMatchObject({ ok: true,
      result: { kind: 'cancelled', compose: { kind: 'composed', facts: { tokens: { total: 12 } } } } });
    expect(await executor.execute('usage.recap.private.deliver', { ...input, base64: 'forged' }, context))
      .toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(await executor.execute('usage.recap.private.deliver', { ...input, path: '/private/file.png' }, context))
      .toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
  });

  it.each([{ kind: 'delivered' }, { kind: 'failed', reason: 'outcome_unobservable', handoff: 'presented' }] as const)(
    'preserves the device delivery outcome %j after the effect settles during cancellation', async delivered => {
      const controller = new AbortController();
      let effects = 0;
      const result = await executeUsageAction('usage.recap.private.deliver', {
        query, intent: 'share', selectedFields: ['tokens'],
      }, {
        query: async request => resolveUsagePageAggregation({ queries: request.queries,
          accounting: [{ query: request.queries[0]!, value: response, status: 'available' }] }),
        renderRecap: async () => ({ kind: 'rendered', base64: 'iVBORw==' }),
        deliverRecap: async () => { effects += 1; controller.abort(); return delivered; },
      }, { signal: controller.signal });
      expect(effects).toBe(1);
      expect(result).toMatchObject({ ok: true, result: delivered });
    },
  );

  it('refuses delivery after render cancellation and reports headless unavailability with safe composed data', async () => {
    const controller = new AbortController();
    let effects = 0;
    const ports = {
      query: async (request: Parameters<NonNullable<ActionExecutorDeps['usageActions']>['query']>[0]) =>
        resolveUsagePageAggregation({ queries: request.queries,
          accounting: [{ query: request.queries[0]!, value: response, status: 'available' as const }] }),
      renderRecap: async () => { controller.abort(); return { kind: 'rendered' as const, base64: 'iVBORw==' }; },
      deliverRecap: async () => { effects += 1; return { kind: 'delivered' as const }; },
    };
    expect(await executeUsageAction('usage.recap.private.deliver', { query, intent: 'copy', selectedFields: ['tokens'] }, ports,
      { signal: controller.signal })).toMatchObject({ ok: false, errorCode: 'cancelled' });
    expect(effects).toBe(0);
    expect(await executeUsageAction('usage.recap.private.deliver', { query, intent: 'save', selectedFields: ['tokens'] },
      { query: ports.query }, {})).toMatchObject({ ok: true, result: { kind: 'unavailable', reason: 'render_target_unavailable',
        compose: { kind: 'composed', facts: { tokens: { total: 12 } } } } });
  });
  it('demands only selected mix populations instead of inheriting unrelated widget breakdowns', async () => {
    const result = await executeUsageAction('usage.recap.private.compose', {
      query: { ...query, breakdown: ['source'] }, selectedFields: ['agentMix', 'modelMix'],
    }, {
      query: async request => {
        const demanded = request.queries[0]!;
        expect(demanded.breakdown).toEqual(['agent', 'model']);
        return resolveUsagePageAggregation({ queries: request.queries,
          accounting: [{ query: demanded, status: 'available', value: { ...response, breakdowns: {
            agent: [{ key: 'agent', tokens: response.totals.tokens, cost: response.totals.cost, eventCount: 1 }],
            model: [{ key: 'model', tokens: response.totals.tokens, cost: response.totals.cost, eventCount: 1 }],
          } } }] });
      },
    }, {});
    expect(result).toMatchObject({ ok: true, result: { kind: 'composed', unavailableFields: [],
      facts: { agentMix: [{ tokens: 12 }], modelMix: [{ tokens: 12 }] } } });
  });
  it('returns the same selected compose data and explicit image unavailability to a headless caller', async () => {
    const result = await executeUsageAction('usage.recap.private.export',
      { query, style: 'sigil', format: 'story', selectedFields: ['tokens'] }, {
        query: async request => resolveUsagePageAggregation({ queries: request.queries,
          accounting: [{ query: request.queries[0]!, value: response, status: 'available', asOfMs: 900 }] }),
      }, {});
    expect(result).toMatchObject({ ok: true, result: { kind: 'unavailable', reason: 'render_target_unavailable',
      compose: { kind: 'composed', style: 'sigil', format: 'story', selectedFields: ['tokens'], asOfMs: 900,
        facts: { tokens: { total: 12 } } } } });
    expect(JSON.stringify(result)).not.toContain('reportedUsd');
    if (!result.ok) throw new Error('Expected a headless recap result');
    expect(getActionSpec('usage.recap.private.export').outputSchema!.parse(result.result)).toEqual(result.result);
  });

  it('renders only the authorized selected compose model into strict file bytes, retaining its manifest and as-of', async () => {
    let pixelsInput: unknown;
    const result = await executeUsageAction('usage.recap.private.export',
      { query, style: 'terminal', format: 'link-preview', selectedFields: ['tokens', 'modelMix'] }, {
        query: async request => resolveUsagePageAggregation({ queries: request.queries,
          accounting: [{ query: request.queries[0]!, value: response, status: 'available', asOfMs: 900 }] }),
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
    expect(getActionSpec('usage.recap.private.export').outputSchema!.parse(result.result)).toEqual(result.result);
  });

  it('accepts equivalent manifest ordering at the export boundary while keeping strict file and compose privacy shapes', async () => {
    const result = await executeUsageAction('usage.recap.private.export', {
      query, selectedFields: ['tokens', 'modelMix'],
    }, {
      query: async request => resolveUsagePageAggregation({ queries: request.queries,
        accounting: [{ query: request.queries[0]!, value: response, status: 'available', asOfMs: 900 }] }),
      renderRecap: async () => ({ kind: 'rendered', base64: 'iVBORw==' }),
    }, {});
    if (!result.ok) throw new Error('Expected exported recap');
    const exported = UsageRecapExportResultSchema.parse(result.result);
    if (exported.kind !== 'exported' || exported.compose.kind !== 'composed') throw new Error('Expected composed image');
    expect(UsageRecapExportResultSchema.safeParse({ ...exported,
      file: { ...exported.file, selectedFields: [...exported.file.selectedFields].reverse() },
    }).success).toBe(true);
    for (const file of [{ ...exported.file, fileName: '../private.png' }, { ...exported.file, base64: 'not base64' },
      { ...exported.file, path: '/private.png' }]) {
      expect(UsageRecapExportResultSchema.safeParse({ ...exported, file }).success).toBe(false);
    }
    expect(UsageRecapExportResultSchema.safeParse({ ...exported, compose: { ...exported.compose,
      facts: { ...exported.compose.facts, modelMix: [{ tokens: 12, events: 1, name: 'unselected-name' }] },
    } }).success).toBe(false);
  });

  it('retires PNG bytes if rendering finishes after cancellation', async () => {
    const controller = new AbortController();
    const result = await executeUsageAction('usage.recap.private.export', { query, selectedFields: ['tokens'] }, {
      query: async request => resolveUsagePageAggregation({ queries: request.queries,
        accounting: [{ query: request.queries[0]!, value: response, status: 'available' }] }),
      renderRecap: async () => { controller.abort(); return { kind: 'rendered', base64: 'iVBORw==' }; },
    }, { signal: controller.signal });
    expect(result).toEqual({ ok: false, errorCode: 'cancelled', error: 'cancelled' });
  });
  it('admits client placement before dispatch and retains compose-only fallback without a connected client', async () => {
    const deps: Partial<ActionExecutorDeps> = {
      isActionApprovalRequired: () => false,
      isApprovalExecutionOriginCurrent: async () => true,
      usageActions: { query: async (request: Parameters<NonNullable<ActionExecutorDeps['usageActions']>['query']>[0]) =>
        resolveUsagePageAggregation({ queries: request.queries, accounting: [{ query: request.queries[0]!, value: response, status: 'available' }] }) },
    };
    const headless = createActionExecutor(deps as ActionExecutorDeps);
    const input = { query, selectedFields: ['tokens'] };
    const context = { surface: 'agent' as const, authority: 'account_automation' as const, actionCaller: { kind: 'host' as const } };
    expect(await headless.execute('usage.recap.private.export', input, context)).toMatchObject({ ok: true,
      result: { kind: 'unavailable', reason: 'render_target_unavailable', compose: { kind: 'composed', facts: { tokens: { total: 12 } } } } });
    const clientDeps: Partial<ActionExecutorDeps> = { ...deps, clientActionExecute: async (request: Parameters<NonNullable<ActionExecutorDeps['clientActionExecute']>>[0]) => {
      expect(request.actionId).toBe('usage.recap.private.export');
      return executeUsageAction('usage.recap.private.export', request.input, { ...deps.usageActions!,
        renderRecap: async () => ({ kind: 'rendered', base64: 'iVBORw==' }) }, request.context);
    } };
    const client = createActionExecutor(clientDeps as ActionExecutorDeps);
    expect(await client.execute('usage.recap.private.export', input, context)).toMatchObject({ ok: true, result: { kind: 'exported', file: { base64: 'iVBORw==' } } });
    expect(await client.execute('usage.recap.private.export', { ...input, node: 'forged' }, context)).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(await headless.execute('usage.recap.private.export', input, { ...context, surface: 'rpc' })).toMatchObject({ ok: false });
  });
  it('returns the compose model when the actual client dispatcher declares no client, never rendering on its headless host', async () => {
    const deps: Partial<ActionExecutorDeps> = {
      isActionApprovalRequired: () => false, isApprovalExecutionOriginCurrent: async () => true,
      clientActionExecute: async ({ actionId }: Parameters<NonNullable<ActionExecutorDeps['clientActionExecute']>>[0]) => clientActionUnavailable(actionId),
      usageActions: {
        query: async (request: Parameters<NonNullable<ActionExecutorDeps['usageActions']>['query']>[0]) =>
          resolveUsagePageAggregation({ queries: request.queries, accounting: [{ query: request.queries[0]!, value: response, status: 'available' }] }),
        renderRecap: async () => { throw new Error('A headless host must not render'); },
      },
    };
    const executor = createActionExecutor(deps as ActionExecutorDeps);
    expect(await executor.execute('usage.recap.private.export', { query, selectedFields: ['tokens'] },
      { surface: 'agent', authority: 'account_automation', actionCaller: { kind: 'host' } })).toMatchObject({ ok: true,
      result: { kind: 'unavailable', reason: 'render_target_unavailable', compose: { kind: 'composed', facts: { tokens: { total: 12 } } } } });
    expect(await executor.execute('usage.recap.private.export', { query, selectedFields: ['tokens'] },
      { surface: 'cli', authority: 'account_automation', actionCaller: { kind: 'host' } }))
      .toMatchObject({ ok: true, result: { kind: 'unavailable', reason: 'render_target_unavailable',
        compose: { kind: 'composed', facts: { tokens: { total: 12 } } } } });
  });
  it('retains denied and uncertain client dispatch outcomes instead of falling back to another read', async () => {
    for (const errorCode of ['denied', 'outcome_uncertain']) {
      const refused = { ok: false as const, errorCode, error: errorCode };
      // Authentication/connected-client transport are genuine system boundaries.
      const deps: Partial<ActionExecutorDeps> = { isActionApprovalRequired: () => false,
        isApprovalExecutionOriginCurrent: async () => true, clientActionExecute: async () => refused,
        usageActions: { query: async () => { throw new Error('A terminal refusal must not reread'); } },
      };
      const executor = createActionExecutor(deps as ActionExecutorDeps);
      expect(await executor.execute('usage.recap.private.export', { query },
        { surface: 'agent', authority: 'account_automation', actionCaller: { kind: 'host' } })).toEqual(refused);
    }
  });
  it('reads the exact admitted query at the incumbent batch boundary and returns a private data preview', async () => {
    const result = await executeUsageAction('usage.recap.private.compose', { query, selectedFields: ['tokens', 'parallel', 'night'] }, {
      // Query is the authenticated transport boundary; all composition beneath it is real.
      query: async request => resolveUsagePageAggregation({ queries: request.queries,
        accounting: [{ query: request.queries[0]!, value: response, status: 'available', asOfMs: 900 }],
        howYouWork: [{ query: request.queries[0]!, nightHours: { startHour: 22, endHour: 6 }, detail: { status: 'partial',
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
    const result = await executeUsageAction('usage.recap.private.compose', { query }, {
      query: async request => { controller.abort(); return resolveUsagePageAggregation({ queries: request.queries,
        accounting: [{ query: request.queries[0]!, value: response, status: 'available' }] }); },
    }, { signal: controller.signal });
    expect(result).toEqual({ ok: false, errorCode: 'cancelled', error: 'cancelled' });
  });
});
