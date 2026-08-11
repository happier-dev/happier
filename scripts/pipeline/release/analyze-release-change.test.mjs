import test from 'node:test';
import assert from 'node:assert/strict';

import { buildReleaseChangeAnalysis } from './analyze-release-change.mjs';
import { renderReleaseChangeAnalysisGitHubOutput } from './analyze-release-change.mjs';

test('release change analysis separates fast admission from seam-selected heavy validation', () => {
  const analysis = buildReleaseChangeAnalysis({
    base: 'a'.repeat(40),
    head: 'b'.repeat(40),
    paths: ['apps/server/prisma/migrations/20260811_account/migration.sql'],
    profileId: 'integrated',
    hasCliCandidate: false,
    hasServerCandidate: true,
    hasPublishedRelayPredecessor: true,
  });

  assert.equal(analysis.kind, 'happier.release-change-analysis.v1');
  assert.equal(analysis.compatibilityAnalysisRequired, true);
  assert.deepEqual(analysis.requiredFastSuites, ['binary-smoke']);
  assert.deepEqual(analysis.requiredHeavySuites, ['docker-release-assets', 'mysql-contract']);
  assert.equal(analysis.risks.sessionContinuity, false);
});

test('release change analysis does not charge a UI-only release for relay upgrade scenarios', () => {
  const analysis = buildReleaseChangeAnalysis({
    base: 'a'.repeat(40),
    head: 'b'.repeat(40),
    paths: ['apps/ui/sources/components/SessionCard.tsx'],
    profileId: 'stable',
    hasCliCandidate: false,
    hasServerCandidate: true,
    hasPublishedRelayPredecessor: true,
  });

  assert.equal(analysis.compatibilityAnalysisRequired, false);
  assert.deepEqual(analysis.requiredFastSuites, ['binary-smoke']);
  assert.deepEqual(analysis.requiredHeavySuites, []);
  assert.ok(analysis.skippedHeavySuites.includes('docker-release-assets'));
});

test('release change analysis projects workflow risk outputs from the canonical analysis', () => {
  const analysis = buildReleaseChangeAnalysis({
    base: 'base',
    head: 'head',
    paths: ['apps/cli/src/daemon/service/install.ts'],
    profileId: 'integrated',
    hasCliCandidate: true,
    hasServerCandidate: false,
    hasPublishedRelayPredecessor: false,
  });
  const output = renderReleaseChangeAnalysisGitHubOutput(analysis);
  assert.match(output, /risk_cli_upgrade=true/);
  assert.match(output, /risk_session_continuity=false/);
  assert.match(output, /compatibility_analysis_required=true/);
});
