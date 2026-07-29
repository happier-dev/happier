import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CANDIDATE_COMPILE_ONLY_TARGETS,
  CANDIDATE_NATIVE_TARGETS,
  CANDIDATE_PRODUCT_STAGE_IDS,
  buildCandidatePlatformQaRecipe,
  prepareCandidatePlatformQa,
  resolveCandidatePlatformQaPlan,
  resolveCandidatePlatformTarget,
  runCandidatePlatformQa,
} from '../pipeline/release-validation/candidate-platform-qa.mjs';
import {
  PACKED_AUTHOR_NATIVE_TARGETS,
} from '../../packages/tests/scripts/plugin-platform/run-packed-author-ui-compat.mjs';

const EXPECTED_NATIVE_TARGETS = [
  'linux-x64',
  'linux-arm64',
  'darwin-x64',
  'darwin-arm64',
  'windows-x64',
];

test('candidate platform QA owns five native consumers and keeps Windows ARM64 compile-only', () => {
  assert.deepEqual(
    CANDIDATE_NATIVE_TARGETS.map((target) => target.id),
    EXPECTED_NATIVE_TARGETS,
  );
  assert.deepEqual(
    CANDIDATE_NATIVE_TARGETS.map((target) => target.id),
    PACKED_AUTHOR_NATIVE_TARGETS,
  );
  assert.deepEqual(
    CANDIDATE_COMPILE_ONLY_TARGETS.map((target) => target.id),
    ['windows-arm64'],
  );
  assert.equal(resolveCandidatePlatformTarget('windows-arm64').kind, 'compile-only');
  assert.throws(
    () => resolveCandidatePlatformQaPlan({
      candidateManifestPath: '/candidate/run/candidate.json',
      expectedTarget: 'windows-arm64',
      platform: 'win32',
      arch: 'arm64',
      repoRoot: '/repo',
    }),
    /compile-only/u,
  );
});

test('candidate platform recipe transfers one whole portable run root and fans out the canonical consumers', () => {
  const recipe = buildCandidatePlatformQaRecipe({ repoRoot: '/repo' });

  assert.equal(recipe.kind, 'exact_candidate_platform_qa_recipe');
  assert.equal(recipe.candidateTransfer.unit, 'whole-run-root');
  assert.equal(recipe.candidateTransfer.manifestOnlyAllowed, false);
  assert.equal(recipe.candidateTransfer.pathsResolveFromManifestDirectory, true);
  assert.equal(recipe.candidateTransfer.mayRewriteManifest, false);
  assert.deepEqual(
    recipe.nativeTargets.map((target) => target.id),
    EXPECTED_NATIVE_TARGETS,
  );
  assert.deepEqual(
    recipe.compileOnlyTargets.map((target) => target.id),
    ['windows-arm64'],
  );
  assert.deepEqual(recipe.nativeStageIds, [
    'candidate-integrity-native-binary-voice-notary',
    'candidate-direct-install-reinstall',
    'released-dev-candidate-rollback-candidate',
    'packed-managed-provider',
  ]);
  assert.equal(recipe.cleanup.candidateRunRootRetainedUntilFanoutComplete, true);
  assert.equal(recipe.cleanup.runnerMayDeleteSharedCandidateRunRoot, false);
});

test('candidate platform recipe requires a genuine Intel host for Darwin x64', () => {
  const target = resolveCandidatePlatformTarget('darwin-x64');
  assert.equal(target.kind, 'native');
  assert.equal(target.hardwareClass, 'intel-mac');
  assert.equal(target.rosettaAccepted, false);

  assert.throws(
    () => resolveCandidatePlatformQaPlan({
      candidateManifestPath: '/candidate/run/candidate.json',
      expectedTarget: 'darwin-x64',
      platform: 'darwin',
      arch: 'x64',
      hostFacts: {
        darwinArm64Hardware: true,
        darwinTranslated: true,
      },
      repoRoot: '/repo',
    }),
    /Intel macOS host/u,
  );
});

test('candidate platform plan rejects an emulated Windows x64 consumer', () => {
  assert.throws(
    () => resolveCandidatePlatformQaPlan({
      candidateManifestPath: 'C:\\candidate\\run\\candidate.json',
      expectedTarget: 'windows-x64',
      platform: 'win32',
      arch: 'x64',
      hostFacts: {
        windowsHardwareArch: 'ARM64',
      },
      repoRoot: 'C:\\repo',
    }),
    /native x64 Windows hardware/u,
  );
});

test('native plan serializes full verification before installer effects and uses the exact candidate throughout', () => {
  const plan = resolveCandidatePlatformQaPlan({
    candidateManifestPath: '/transferred/run/candidate.json',
    expectedTarget: 'linux-arm64',
    platform: 'linux',
    arch: 'arm64',
    repoRoot: '/repo',
  });

  assert.equal(plan.candidateManifestPath, '/transferred/run/candidate.json');
  assert.equal(plan.candidateRunRoot, '/transferred/run');
  assert.deepEqual(plan.steps.map((step) => step.id), [
    'candidate-integrity-native-binary-voice-notary',
    'candidate-direct-install-reinstall',
    'released-dev-candidate-rollback-candidate',
    'packed-managed-provider',
  ]);
  assert.deepEqual(
    plan.steps[0].args,
    [
      '/repo/scripts/pipeline/release-validation/validate-release.mjs',
      '--suite',
      'binary-smoke',
      '--platform',
      'linux',
      '--source',
      'local-build',
      '--ref',
      '/transferred/run/candidate.json',
    ],
  );
  assert.deepEqual(
    plan.steps[2].args.slice(-10),
    [
      '--from-source',
      'published-channel',
      '--from-ref',
      'dev',
      '--to-source',
      'local-build',
      '--to-ref',
      '/transferred/run/candidate.json',
      '--release-channel',
      'dev',
    ],
  );
  assert.equal(
    plan.steps[3].args.at(-1),
    '/transferred/run/candidate.json',
  );
});

test('preparation consumes the canonical candidate loader and rejects a missing native archive before effects', async () => {
  const calls = [];
  const candidate = {
    standaloneCli: {
      archives: [
        {
          os: 'linux',
          arch: 'x64',
          archivePath: '/transferred/run/native/happier-linux-x64.tar.gz',
        },
      ],
    },
  };

  const prepared = await prepareCandidatePlatformQa({
    candidateManifestPath: '/transferred/run/candidate.json',
    expectedTarget: 'linux-x64',
    platform: 'linux',
    arch: 'x64',
    repoRoot: '/repo',
  }, {
    loadCandidateImpl: async (argv, options) => {
      calls.push({ argv, options });
      return candidate;
    },
  });

  assert.deepEqual(calls, [{
    argv: ['--candidate', '/transferred/run/candidate.json'],
    options: { cwd: '/repo' },
  }]);
  assert.equal(prepared.candidate, candidate);

  await assert.rejects(
    prepareCandidatePlatformQa({
      candidateManifestPath: '/transferred/run/candidate.json',
      expectedTarget: 'windows-x64',
      platform: 'win32',
      arch: 'x64',
      repoRoot: '/repo',
    }, {
      loadCandidateImpl: async () => candidate,
    }),
    /does not contain native target windows-x64/u,
  );
});

test('runner executes the canonical stages serially and never removes the shared candidate root', async () => {
  const invocations = [];
  const candidate = {
    standaloneCli: {
      archives: [{
        os: 'linux',
        arch: 'x64',
        archivePath: '/transferred/run/native/happier-linux-x64.tar.gz',
      }],
    },
  };

  const result = await runCandidatePlatformQa({
    candidateManifestPath: '/transferred/run/candidate.json',
    expectedTarget: 'linux-x64',
    platform: 'linux',
    arch: 'x64',
    repoRoot: '/repo',
  }, {
    loadCandidateImpl: async () => candidate,
    runStepImpl: (step) => {
      invocations.push(step);
    },
  });

  assert.deepEqual(invocations.map((step) => step.id), [
    'candidate-integrity-native-binary-voice-notary',
    'candidate-direct-install-reinstall',
    'released-dev-candidate-rollback-candidate',
    'packed-managed-provider',
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.candidateRunRoot, '/transferred/run');
  assert.equal(result.candidateRunRootRemoved, false);
});

test('runner stops at the first failed canonical stage and cannot continue to installer effects after failed verification', async () => {
  const invocations = [];
  const candidate = {
    standaloneCli: {
      archives: [{
        os: 'linux',
        arch: 'x64',
        archivePath: '/transferred/run/native/happier-linux-x64.tar.gz',
      }],
    },
  };

  await assert.rejects(
    runCandidatePlatformQa({
      candidateManifestPath: '/transferred/run/candidate.json',
      expectedTarget: 'linux-x64',
      platform: 'linux',
      arch: 'x64',
      repoRoot: '/repo',
    }, {
      loadCandidateImpl: async () => candidate,
      runStepImpl: (step) => {
        invocations.push(step.id);
        throw new Error('candidate matrix verification failed');
      },
    }),
    /candidate matrix verification failed/u,
  );
  assert.deepEqual(invocations, [
    'candidate-integrity-native-binary-voice-notary',
  ]);
});

test('packed novel product fanout runs both consumers to terminal results before marker-authorized cleanup', async () => {
  const events = [];
  const candidate = {
    standaloneCli: {
      archives: [{
        os: 'darwin',
        arch: 'arm64',
        archivePath:
          '/transferred/run/native/happier-darwin-arm64.tar.gz',
      }],
    },
  };

  await assert.rejects(
    runCandidatePlatformQa({
      candidateManifestPath: '/transferred/run/candidate.json',
      expectedTarget: 'darwin-arm64',
      packedNovelHandoffManifestPath:
        '/handoff/packed-novel-connected-account-qa.json',
      platform: 'darwin',
      arch: 'arm64',
      repoRoot: '/repo',
    }, {
      loadCandidateImpl: async () => candidate,
      runStepImpl: (step) => {
        events.push(step.id);
        if (step.id === CANDIDATE_PRODUCT_STAGE_IDS[0]) {
          throw new Error('browser failed');
        }
      },
      cleanupPackedNovelHandoffImpl: async ({ manifestPath }) => {
        events.push(`cleanup:${manifestPath}`);
      },
    }),
    /browser failed/u,
  );
  assert.deepEqual(events.slice(-3), [
    'packed-novel-browser-oauth',
    'packed-novel-device-manual-device',
    'cleanup:/handoff/packed-novel-connected-account-qa.json',
  ]);
});

test('Darwin arm64 product plan gives the same exact handoff to real browser OAuth and one isolated iOS device run', () => {
  const plan = resolveCandidatePlatformQaPlan({
    candidateManifestPath: '/transferred/run/candidate.json',
    expectedTarget: 'darwin-arm64',
    packedNovelHandoffManifestPath:
      '/handoff/packed-novel-connected-account-qa.json',
    platform: 'darwin',
    arch: 'arm64',
    repoRoot: '/repo',
  });

  assert.equal(
    plan.packedNovelHandoffManifestPath,
    '/handoff/packed-novel-connected-account-qa.json',
  );
  assert.deepEqual(
    plan.productSteps.map((step) => step.id),
    CANDIDATE_PRODUCT_STAGE_IDS,
  );
  assert.deepEqual(plan.productSteps[0].args.slice(-4), [
    '--candidate',
    '/transferred/run/candidate.json',
    '--novel-handoff',
    '/handoff/packed-novel-connected-account-qa.json',
  ]);
  assert.equal(
    plan.productSteps[1].envPatch
      .HAPPIER_E2E_PLUGIN_PLATFORM_CANDIDATE,
    '/transferred/run/candidate.json',
  );
  assert.equal(
    plan.productSteps[1].envPatch
      .HAPPIER_E2E_PACKED_NOVEL_QA_HANDOFF_MANIFEST,
    '/handoff/packed-novel-connected-account-qa.json',
  );
  assert.equal(
    plan.productSteps[1].args.includes(
      'test:mobile:e2e:ios:plugin-platform-candidate',
    ),
    true,
  );
});

test('native failure skips product consumers, cleans the retained handoff exactly once, and preserves cleanup failure beside the primary error', async () => {
  const events = [];
  const candidate = {
    standaloneCli: {
      archives: [{
        os: 'darwin',
        arch: 'arm64',
        archivePath:
          '/transferred/run/native/happier-darwin-arm64.tar.gz',
      }],
    },
  };

  await assert.rejects(
    runCandidatePlatformQa({
      candidateManifestPath: '/transferred/run/candidate.json',
      expectedTarget: 'darwin-arm64',
      packedNovelHandoffManifestPath:
        '/handoff/packed-novel-connected-account-qa.json',
      platform: 'darwin',
      arch: 'arm64',
      repoRoot: '/repo',
    }, {
      loadCandidateImpl: async () => candidate,
      runStepImpl: (step) => {
        events.push(step.id);
        throw new Error('native verification failed');
      },
      cleanupPackedNovelHandoffImpl: async ({ manifestPath }) => {
        events.push(`cleanup:${manifestPath}`);
        throw new Error('handoff cleanup failed');
      },
    }),
    (error) => {
      assert.equal(error instanceof AggregateError, true);
      assert.deepEqual(
        error.errors.map((entry) => entry.message),
        ['native verification failed', 'handoff cleanup failed'],
      );
      return true;
    },
  );
  assert.deepEqual(events, [
    'candidate-integrity-native-binary-voice-notary',
    'cleanup:/handoff/packed-novel-connected-account-qa.json',
  ]);
});

test('Windows Terminal interactive supplement requires exact child custody and forbids shared-window termination', () => {
  const recipe = buildCandidatePlatformQaRecipe({ repoRoot: '/repo' });
  const interactive = recipe.windowsTerminalInteractive;

  assert.equal(interactive.requiredTarget, 'windows-x64');
  assert.equal(interactive.requiresExplorerDesktop, true);
  assert.equal(interactive.sshOrSessionZeroAccepted, false);
  assert.deepEqual(interactive.scenarios.map((scenario) => scenario.id), [
    'new-window-exact-child',
    'named-window-reuse',
    'duplicate-or-ambiguous-fail-closed',
    'required-ack-self-exit',
    'no-webhook-exact-cancellation',
  ]);
  for (const scenario of interactive.scenarios) {
    assert.equal(scenario.mayTerminateWindowsTerminal, false);
    assert.equal(scenario.sharedWindowMustRemainOpen, true);
  }
  assert.deepEqual(interactive.cancellationAuthority, [
    'agent-pid',
    'process-start-time',
    'full-command-hash',
  ]);
  assert.equal(interactive.consoleFallbackAfterCommittedDispatch, false);
});
