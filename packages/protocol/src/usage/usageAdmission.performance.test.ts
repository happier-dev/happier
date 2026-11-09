import { describe, expect, it, vi } from 'vitest';
import { buildProviderAccountUsageRecordId, ProviderAccountUsageSnapshotV1Schema } from '../connect/providerAccountUsagePrimitives.js';
import { buildProviderAccountUsagePageProjectionV1,
  ProviderAccountUsagePageProjectionV1Schema } from '../connect/providerAccountUsagePageProjection.js';
import { openProviderAccountUsagePageProjectionV1, sealProviderAccountUsagePageProjectionV1 } from '../connect/providerAccountUsagePageProjectionCrypto.js';
import { projectProviderAccountUsageQuotaReadV1 } from '../connect/providerAccountUsageHistory.js';
import { ProviderAccountUsagePaceV1Schema } from '../connect/deriveProviderAccountUsagePace.js';
import { normalizeUsageQuery } from '../inputs/usageQuery.js';
import { projectUsagePlanInsights } from './usagePlanInsights.js';
import { applyUsageCoachPreferences, evaluateUsageCoach } from './coach/evaluateUsageCoach.js';
import { UsageCoachEvaluationSchema } from './coach/coachFinding.js';
import { UsagePromptCompositionSchema } from './coach/usagePromptComposition.js';
import { UsageAnalyticsQueryResponseSchema } from './usageAnalyticsContracts.js';
import { resolveUsagePageAggregation } from './resolveUsagePageAggregation.js';
import { UsageWorkProjectionSchema } from './usageOutcomeAllocation.js';
import { resolveUsageHowYouWork, UsageHowYouWorkSchema } from './resolveUsageHowYouWork.js';
import { UsageCoachDigestSuggestionSchema } from './coach/coachDigestSuggestion.js';

describe('admitted Usage data stays typed inside the process', () => {
  it('composes 45k accepted observations into Plans without parsing the expanded history again', () => {
    const recordKey = { providerId: 'test', accountSubjectId: 'account', subjectKind: 'account' as const, quotaScope: 'account' as const };
    const recordId = buildProviderAccountUsageRecordId(recordKey);
    const duration = 86_400_000;
    const start = 1_792_000_000_000;
    const snapshot = ProviderAccountUsageSnapshotV1Schema.parse({ v: 1, recordId, recordKey, providerId: 'test',
      accountSubject: { kind: 'providerSubject', id: 'account' }, observedAtMs: start, fetchedAtMs: start,
      staleAfterMs: duration, source: 'providerHttp', confidence: 'confirmed',
      meters: [{ meterId: 'day', label: 'Daily', used: 0, limit: 100, utilizationPct: 0,
        unit: 'requests', resetsAt: start + duration, windowDurationMs: duration, status: 'ok', details: {} }] });
    const entries = Array.from({ length: 45_000 }, (_, index) => {
      const at = start + index * 1000;
      const used = index / 1000;
      return { id: `witness-${index}`, observedAtMs: at, snapshot: { ...snapshot, observedAtMs: at, fetchedAtMs: at,
        meters: snapshot.meters.map(meter => ({ ...meter, used, utilizationPct: used })) } };
    });
    const range = { startAtMs: start, endAtMs: start + duration };
    const validation = vi.spyOn(ProviderAccountUsagePageProjectionV1Schema, 'parse');
    const paceValidation = vi.spyOn(ProviderAccountUsagePaceV1Schema._zod, 'run');
    try {
      const started = performance.now();
      const projection = buildProviderAccountUsagePageProjectionV1({ recordId, range, history: { entries, nextCursor: null } });
      const content = sealProviderAccountUsagePageProjectionV1({ projection, accountMode: 'plain' });
      const opened = openProviderAccountUsagePageProjectionV1({ recordId, accountMode: 'plain', content });
      const source = { bindingKind: 'account' as const, ref: { service: { pluginId: 'example.usage', localId: 'usage' }, accountId: 'account' } };
      const current = opened.history.entries.at(-1)!.snapshot;
      const read = projectProviderAccountUsageQuotaReadV1({ input: { source, projection: { range, resolution: 'accepted_observations' } },
        current, history: opened.history, nowMs: current.observedAtMs });
      const insights = projectUsagePlanInsights({ query: normalizeUsageQuery({ period: { startMs: range.startAtMs, endMs: range.endAtMs } }),
        nowMs: current.observedAtMs, quota: [read] });
      console.info(JSON.stringify({ admission45kPlans: true, elapsedMs: performance.now() - started,
        expandedProjectionParses: validation.mock.calls.length, expandedRowsParsed: validation.mock.calls.reduce((n, [value]) =>
          n + (value && typeof value === 'object' && 'history' in value && value.history && typeof value.history === 'object'
            && 'entries' in value.history && Array.isArray(value.history.entries) ? value.history.entries.length : 0), 0),
        paceParses: paceValidation.mock.calls.length }));
      expect(opened).toEqual(projection);
      // The sample exactly at the window start has zero elapsed time, so it
      // cannot witness a rate; all remaining samples participate unchanged.
      expect(read.pace[0]!.value).toMatchObject({ status: 'available', sampleCount: 44_999 });
      expect(insights.accounts[0]!.weather[0]).toMatchObject({ status: 'available', sampleCount: 44_999 });
      expect(projection.history.entries[0]!.snapshot === entries[0]!.snapshot).toBe(true);
      expect(validation.mock.calls.length).toBe(0);
      expect(paceValidation.mock.calls.length).toBe(0);
    } finally { validation.mockRestore(); paceValidation.mockRestore(); }
  }, 60_000);

  it('evaluates and applies preferences to 45k admitted Coach facts without reparsing facts or findings', () => {
    const row = UsagePromptCompositionSchema.parse({ v: 1, evidenceId: 'prompt', sessionId: 'session', turnId: 'turn', inputId: 'input',
      observedAtMs: 1, boundary: 'host_pre_dispatch', deliveryKind: 'newTurn', coverage: 'host_only',
      components: Array.from({ length: 2 }, () => ({ sourceId: '1'.repeat(64), kind: 'instructions', digest: 'a'.repeat(64),
        location: 'system', byteLength: 20, tokenCount: null, tokenizerId: null, cacheClass: 'unknown', overlap: 'none' })),
      nativePrefix: null, contextWindowTokens: null });
    const composition = Array.from({ length: 45_000 }, (_, index) => ({ ...row, evidenceId: `prompt-${index}`, observedAtMs: index + 1 }));
    const facts = vi.spyOn(UsagePromptCompositionSchema, 'parse');
    const findings = vi.spyOn(UsageCoachEvaluationSchema, 'parse');
    try {
      const started = performance.now();
      const evaluation = evaluateUsageCoach({ queryKey: 'q', period: { startMs: 0, endMs: 45_001 }, asOfMs: 45_000,
        currentness: 'current', composition, compositionCoverage: 'partial' });
      const preferred = applyUsageCoachPreferences(evaluation, { suppressions: [] }, 45_000);
      expect(preferred, 'unchanged preferences retain the admitted finding tree without a whole-value equality pass').toBe(evaluation);
      console.info(JSON.stringify({ admission45kCoach: true, elapsedMs: performance.now() - started,
        compositionParses: facts.mock.calls.length, evaluationParses: findings.mock.calls.length }));
      const finding = preferred.findings.find(value => value.detectorId === 'duplicated_instructions')!;
      expect(finding.evidence).toHaveLength(45_000);
      expect(finding.evidenceSeries![0]!.points).toHaveLength(45_000);
      // Validation belongs at the outgoing Action/Resource boundary, and still accepts the real output.
      const validated = UsageCoachEvaluationSchema.safeParse(preferred);
      expect(validated.success).toBe(true);
      expect(facts.mock.calls.length).toBe(0);
      expect(findings.mock.calls.length).toBe(0);
    } finally { facts.mockRestore(); findings.mockRestore(); }
  }, 60_000);

  it('composes admitted accounting and private detail without reparsing derived Work, history or digest recipes', () => {
    const period = { startMs: 0, endMs: 45_001 };
    const tokens = { input: 1, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 1 };
    const cost = { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' };
    const accounting = UsageAnalyticsQueryResponseSchema.parse({ v: 1,
      totals: { eventCount: 45_000, tokens: { ...tokens, input: 45_000, total: 45_000 }, cost },
      contributions: Array.from({ length: 45_000 }, (_, index) => ({ id: String(index), observedAtMs: index + 1,
        sessionId: null, turnId: null, agentId: null, modelId: null, machineId: null, projectKey: null,
        workspaceId: null, source: null, tokens, cost })) });
    const phaseEvents = Array.from({ length: 45_000 }, (_, index) => ({ evidenceId: String(index), observedAtMs: index + 1,
      sessionId: 'session', turnId: null, kind: 'read' as const, method: 'tool_classification' as const }));
    const workParse = vi.spyOn(UsageWorkProjectionSchema, 'parse');
    const detailParse = vi.spyOn(UsageHowYouWorkSchema, 'parse');
    const digestParse = vi.spyOn(UsageCoachDigestSuggestionSchema, 'parse');
    try {
      const started = performance.now();
      const query = normalizeUsageQuery({ period, includeSessionEvidence: false });
      const batch = resolveUsagePageAggregation({ queries: [query], accounting: [{ query, value: accounting, status: 'available' }] });
      const detail = resolveUsageHowYouWork({ period, timeZoneOffsetMinutes: 0, detail: { status: 'partial', phaseEvents } });
      console.info(JSON.stringify({ admission45kDetails: true, elapsedMs: performance.now() - started,
        workParses: workParse.mock.calls.length, detailParses: detailParse.mock.calls.length, digestParses: digestParse.mock.calls.length }));
      expect(batch.results[0]!.work!.allocations).toHaveLength(45_000);
      expect(detail.autopsy!.events).toHaveLength(45_000);
      expect(UsageWorkProjectionSchema.safeParse(batch.results[0]!.work).success).toBe(true);
      expect(UsageHowYouWorkSchema.safeParse(detail).success).toBe(true);
      expect(workParse.mock.calls.length).toBe(0);
      expect(detailParse.mock.calls.length).toBe(0);
      expect(digestParse.mock.calls.length).toBe(0);
      expect(batch.results[0]!.work!.allocations[0]!.contribution === batch.results[0]!.accounting!.contributions![0]).toBe(true);
    } finally { workParse.mockRestore(); detailParse.mockRestore(); digestParse.mockRestore(); }
  }, 60_000);
});
