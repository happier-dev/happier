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
