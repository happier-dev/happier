import test from 'node:test';
import assert from 'node:assert/strict';

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { analyzeReleasePublicApiComparisons, buildReleaseChangeAnalysis } from './analyze-release-change.mjs';
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
    releaseChannel: 'preview',
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
    releaseChannel: 'stable',
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
    releaseChannel: 'preview',
  });
  const output = renderReleaseChangeAnalysisGitHubOutput(analysis);
  assert.match(output, /risk_cli_upgrade=true/);
  assert.match(output, /risk_session_continuity=false/);
  assert.match(output, /compatibility_analysis_required=true/);
});

test('release change analysis carries owner-produced public API comparison facts for editorial classification', () => {
  const publicApiComparisons = [{
    component: 'plugin_sdk',
    packageName: '@happier-dev/plugin-sdk',
    sourceVersion: '0.0.0',
    sourcePosture: 'developer_preview',
    comparison: {
      status: 'comparison',
      disposition: { humanReviewRequired: true },
    },
  }];
  const analysis = buildReleaseChangeAnalysis({
    base: 'base',
    head: 'head',
    paths: ['packages/plugin-sdk/src/index.ts'],
    profileId: 'integrated',
    hasCliCandidate: false,
    hasServerCandidate: false,
    hasPublishedRelayPredecessor: false,
    releaseChannel: 'preview',
    publicApiComparisons,
  });

  assert.deepEqual(analysis.publicApiComparisons, publicApiComparisons);
  assert.equal(analysis.publicApiHumanReviewRequired, true);
  assert.equal(analysis.publicSdkReleaseApprovalRequired, true);
  assert.match(renderReleaseChangeAnalysisGitHubOutput(analysis), /public_api_human_review_required=true/);
  assert.match(renderReleaseChangeAnalysisGitHubOutput(analysis), /public_sdk_release_approval_required=true/);
});

test('prepublish-hold packages require explicit first-publication approval without treating additions as breaking', () => {
  const analysis = buildReleaseChangeAnalysis({
    base: 'base',
    head: 'head',
    paths: ['packages/plugin-sdk/src/index.ts'],
    profileId: 'integrated',
    hasCliCandidate: false,
    hasServerCandidate: false,
    hasPublishedRelayPredecessor: false,
    releaseChannel: 'preview',
    publicApiComparisons: [{
      component: 'plugin_sdk',
      packageName: '@happier-dev/plugin-sdk',
      sourceVersion: '0.0.0',
      sourcePosture: 'prepublish_hold',
      humanReviewRequired: false,
      comparison: { status: 'dormant_pre_baseline', disposition: { humanReviewRequired: false } },
    }],
  });

  assert.equal(analysis.publicApiHumanReviewRequired, false);
  assert.equal(analysis.publicSdkReleaseApprovalRequired, true);
});

test('release analysis prepares comparisons for every public package whose candidate bytes are affected', async () => {
  const root = await mkdtemp(join(tmpdir(), 'release-analysis-public-api-'));
  try {
    for (const [directory, manifest] of [
      ['packages/plugin-sdk', { name: '@happier-dev/plugin-sdk', version: '0.0.0', happier: { publicSdkRelease: { posture: 'prepublish_hold' } } }],
      ['packages/plugin-ui', { name: '@happier-dev/plugin-ui', version: '0.0.0', happier: { publicSdkRelease: { posture: 'prepublish_hold' } } }],
      ['packages/sdk', { name: '@happier-dev/sdk', version: '0.0.0', happier: { publicSdkRelease: { posture: 'developer_preview' } } }],
    ]) {
      await mkdir(join(root, directory), { recursive: true });
      await writeFile(join(root, directory, 'package.json'), JSON.stringify(manifest));
    }
    const observed = [];
    const comparisons = await analyzeReleasePublicApiComparisons({
      paths: ['packages/cli-common/src/firstPartyRuntime/installVersionedPayload.ts'],
      repositoryRoot: root,
      releaseChannel: 'preview',
      verifyCurrentRecords: false,
      analyzeCurrentPublicApiForEditorialImpl: async (input) => {
        observed.push(input);
        return {
          sourceVersion: input.sourceVersion,
          releaseChannel: input.releaseChannel,
          comparison: {
            status: 'comparison',
            disposition: { humanReviewRequired: input.profileId === 'plugin-sdk' },
          },
        };
      },
    });

    assert.deepEqual(observed.map((input) => input.profileId), ['plugin-sdk', 'plugin-ui']);
    assert.deepEqual(observed.map((input) => input.releaseChannel), ['preview', 'preview']);
    assert.deepEqual(observed.map((input) => input.verifyCurrentRecords), [false, false]);
    assert.deepEqual(comparisons.map((comparison) => comparison.packageName), [
      '@happier-dev/plugin-sdk',
      '@happier-dev/plugin-ui',
    ]);
    assert.deepEqual(comparisons.map((comparison) => comparison.humanReviewRequired), [true, false]);
    assert.deepEqual(comparisons.map((comparison) => comparison.sourcePosture), ['prepublish_hold', 'prepublish_hold']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
