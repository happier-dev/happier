import { expect, it } from 'vitest';
import type { UsageCoachFinding } from '@happier-dev/protocol/usage/coach/coachFinding';
import { projectUsageCoachFindings, readUsageCoachFailureMessage } from './usageCoachPresentation';
import type { UsageCoachSnapshot } from './usageCoachController';
import { McpRulesSetOutputV1Schema } from '@happier-dev/protocol/actions/specs/capabilityRules';

it('presents the mutation owner conflict carried by Coach Undo, without calling a refused Apply an undo conflict', () => {
  // The public Coach Action preserves MCP's typed refusal in details.
  const failure = { ok: false, errorCode: 'coach_owner_refused', error: 'coach_owner_refused',
    details: McpRulesSetOutputV1Schema.parse({ ok: false, code: 'conflict' }) } as const;
  expect(readUsageCoachFailureMessage({ evidenceKey: 'mcp', actionId: 'usage.coach.undo', failure }))
    .toBe('usage.board.coach.undoConflict');
  expect(readUsageCoachFailureMessage({ evidenceKey: 'mcp', actionId: 'usage.coach.apply', failure }))
    .toBe('usage.board.coach.actionFailed');
  expect(readUsageCoachFailureMessage({ evidenceKey: 'setting', actionId: 'usage.coach.undo',
    failure: { ok: false, errorCode: 'account_settings_mutation_conflict', error: 'account_settings_mutation_conflict' } }))
    .toBe('usage.board.coach.undoConflict');
  expect(readUsageCoachFailureMessage({ evidenceKey: 'mcp', actionId: 'usage.coach.undo',
    failure: { ...failure, details: McpRulesSetOutputV1Schema.parse({ ok: false, code: 'catalog_unavailable' }) } }))
    .toBe('usage.board.coach.actionFailed');
});

it('lets canonical snooze expiry and external restore govern mounted finding rows', () => {
  const evidenceKey = 'evidence';
  const finding: UsageCoachFinding = { detectorId: 'compaction_storms', evidenceKey, queryKey: 'query',
    period: { startMs: 0, endMs: 1000 }, asOfMs: 1000, currentness: 'current', coverage: 'partial',
    severity: 'info', classification: 'informational', summaryCode: 'compaction_thrash_observed',
    basis: { method: 'compaction_thrash_v1', kind: 'observation', citations: [{ url: 'https://example.com/compaction',
      sourceKind: 'vendor_docs', asOf: '2026-10-14' }], limitations: [], advice: [] },
    evidence: [{ kind: 'compaction', id: 'c1', observedAtMs: 10 }], measurements: [], remedy: null, action: null,
    state: { dismissed: false, snoozedUntilMs: 5000, applied: null } };
  const mounted: UsageCoachSnapshot = { pending: [], applied: [], digest: null,
    error: null, approval: null, retired: false };
  expect(projectUsageCoachFindings([finding], mounted, 4999).visible).toEqual([]);
  expect(projectUsageCoachFindings([finding], mounted, 5000).visible.map(row => row.evidenceKey)).toEqual([evidenceKey]);
  const dismissed = { ...finding, state: { ...finding.state, dismissed: true, snoozedUntilMs: null } };
  expect(projectUsageCoachFindings([dismissed], mounted, 10000).visible).toEqual([]);
  const restored = { ...dismissed, state: { ...dismissed.state, dismissed: false } };
  expect(projectUsageCoachFindings([restored], mounted, 10001).visible.map(row => row.evidenceKey)).toEqual([evidenceKey]);
});

it('folds a dense Coach trend into a readable sparkline that keeps every peak and names the largest sample', async () => {
  const { projectUsageCoachTrend } = await import('./usageCoachPresentation');
  // A context-growth sawtooth: hundreds of requests, each run climbing then resetting (acceptance 11-21 #12).
  const points = Array.from({ length: 600 }, (_, index) => ({ evidenceId: `r${index}`, observedAtMs: index * 1000,
    value: (index % 40) * 1000 + (index === 333 ? 90_000 : 0) }));
  const trend = projectUsageCoachTrend({ metric: 'context_window_tokens', unit: 'tokens', points }, 36)!;
  expect(trend.points.length).toBeLessThanOrEqual(36);
  expect(trend.points.length).toBeGreaterThan(1);
  expect(trend.points.map(point => point.x)).toEqual([...trend.points.map(point => point.x)].sort((a, b) => a - b));
  // The spike survives the fold, and it, not the last sample, is the one figure under the line.
  expect(Math.max(...trend.points.map(point => point.y))).toBe(103_000);
  expect(trend.peak).toEqual({ value: 103_000, observedAtMs: 333_000 });
  // A last sample of zero is never the caption ("Latest: 0 s waited").
  const waits = projectUsageCoachTrend({ metric: 'permission_wait', unit: 'milliseconds', points: [
    { evidenceId: 'a', observedAtMs: 0, value: 4000 }, { evidenceId: 'b', observedAtMs: 10, value: 0 }] }, 36)!;
  expect(waits.peak.value).toBe(4000);
  // One sample is an observation, not a trend.
  expect(projectUsageCoachTrend({ metric: 'permission_wait', unit: 'milliseconds', points: [points[0]!] }, 36)).toBeNull();
});
