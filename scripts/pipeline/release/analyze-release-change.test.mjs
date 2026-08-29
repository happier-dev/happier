import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildReleaseChangeAnalysis } from './analyze-release-change.mjs';
import { renderReleaseChangeAnalysisGitHubOutput } from './analyze-release-change.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

test('release change analysis separates fast admission from seam-selected heavy validation', () => {
  const analysis = buildReleaseChangeAnalysis({
    base: 'a'.repeat(40),
    head: 'b'.repeat(40),
    releaseChannel: 'preview',
    paths: ['apps/server/prisma/migrations/20260811_account/migration.sql'],
    profileId: 'integrated',
    hasCliCandidate: false,
    hasServerCandidate: true,
    hasPublishedRelayPredecessor: true,
  });

  assert.equal(analysis.kind, 'happier.release-change-analysis.v1');
  assert.equal(analysis.releaseChannel, 'preview');
  assert.equal(analysis.publicApiHumanReviewRequired, false);
  assert.equal(analysis.publicSdkReleaseApprovalRequired, false);
  assert.deepEqual(analysis.publicApiComparisons, []);
  assert.equal(analysis.compatibilityAnalysisRequired, true);
  assert.deepEqual(analysis.requiredFastSuites, ['binary-smoke']);
  assert.deepEqual(analysis.requiredHeavySuites, ['docker-release-assets', 'mysql-contract']);
  assert.equal(analysis.risks.sessionContinuity, false);
});

test('release change analysis does not charge a UI-only release for relay upgrade scenarios', () => {
  const analysis = buildReleaseChangeAnalysis({
    base: 'a'.repeat(40),
    head: 'b'.repeat(40),
    releaseChannel: 'stable',
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
    releaseChannel: 'dev',
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

test('release analyze CLI accepts a channel and emits the strict hmaint v1 envelope', () => {
  const output = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'run.mjs'),
      'release-analyze',
      '--base', 'HEAD',
      '--head', 'HEAD',
      '--channel', 'preview',
      '--profile', 'integrated',
      '--has-cli-candidate', 'false',
      '--has-server-candidate', 'false',
      '--has-published-relay-predecessor', 'false',
      '--repository-root', repoRoot,
    ],
    { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const analysis = JSON.parse(output);

  assert.equal(analysis.releaseChannel, 'preview');
  assert.equal(analysis.publicApiHumanReviewRequired, false);
  assert.equal(analysis.publicSdkReleaseApprovalRequired, false);
  assert.deepEqual(analysis.publicApiComparisons, []);
});
