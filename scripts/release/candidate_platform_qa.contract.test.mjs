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

async function captureCandidateForTest(candidate, options) {
  return {
    candidate,
    cleanup: async () => await options.rmImpl('/private'),
    manifestPath: '/private/candidate.json',
    root: '/private',
  };
}

async function ignoreCapturedCandidateCleanupForTest() {}

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
      payloadPublicationAdmission: 'pre-activation',
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
  assert.deepEqual(recipe.payloadPublicationAdmission, {
    owner:
      'scripts/release/qualified-connected-accounts-v4-activation-admission.mjs',
    requiredStatus: 'pre-activation',
    localInstallStateIsAuthority: false,
    postActivationAction: 'forward-fix',
  });
  assert.deepEqual(recipe.nativeStageIds, [
    'candidate-integrity-native-binary-voice-notary',
    'candidate-direct-install-reinstall',
    'released-dev-candidate-previous-payload-candidate',
    'packed-managed-provider',
    'packed-plugins-dev',
  ]);
  assert.equal(
    recipe.productQa.deviceScope,
    'one isolated iOS simulator and one isolated Android emulator manual plus device-code acceptance',
  );
  assert.equal(
    recipe.productQa.allProductConsumersReachTerminalBeforeCleanup,
    true,
  );
  assert.equal(
    Object.hasOwn(
      recipe.productQa,
      'bothConsumersReachTerminalBeforeCleanup',
    ),
    false,
  );
  assert.match(
    recipe.cleanup.packedNovelHandoffRemovalOwner,
    /every product consumer reaches a terminal result/u,
  );
  assert.match(
    recipe.cleanup.triageGithubVoiceHandoffRemovalOwner,
    /every product consumer reaches a terminal result/u,
  );
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
      payloadPublicationAdmission: 'pre-activation',
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
      payloadPublicationAdmission: 'pre-activation',
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

test('candidate platform plan refuses previous-payload reversion after semantic activation', () => {
  assert.throws(
    () => resolveCandidatePlatformQaPlan({
      candidateManifestPath: '/candidate/run/candidate.json',
      expectedTarget: 'linux-x64',
      payloadPublicationAdmission: 'post-activation-compatible',
      platform: 'linux',
      arch: 'x64',
      repoRoot: '/repo',
    }),
    /pre-activation payload-publication admission/i,
  );
});

test('native plan serializes full verification before installer effects and uses the exact candidate throughout', () => {
  const plan = resolveCandidatePlatformQaPlan({
    candidateManifestPath: '/transferred/run/candidate.json',
    expectedTarget: 'linux-arm64',
    payloadPublicationAdmission: 'pre-activation',
    platform: 'linux',
    arch: 'arm64',
    repoRoot: '/repo',
  });

  assert.equal(plan.candidateManifestPath, '/transferred/run/candidate.json');
  assert.equal(plan.candidateRunRoot, '/transferred/run');
  assert.deepEqual(plan.steps.map((step) => step.id), [
    'candidate-integrity-native-binary-voice-notary',
    'candidate-direct-install-reinstall',
    'released-dev-candidate-previous-payload-candidate',
    'packed-managed-provider',
    'packed-plugins-dev',
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
    plan.steps[2].args.slice(-12),
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
      '--payload-publication-admission',
      'pre-activation',
    ],
  );
  assert.equal(
    plan.steps[3].args.at(-1),
    '/transferred/run/candidate.json',
  );
  assert.equal(
    plan.steps[4].args.at(-1),
    '/transferred/run/candidate.json',
  );
});

test('candidate platform plan reaches the approved external dev, Resources browser, and Voice packed gates', () => {
  const nativePlan = resolveCandidatePlatformQaPlan({
    candidateManifestPath: '/transferred/run/candidate.json',
    expectedTarget: 'linux-arm64',
    payloadPublicationAdmission: 'pre-activation',
    platform: 'linux',
    arch: 'arm64',
    repoRoot: '/repo',
  });
  const productPlan = resolveCandidatePlatformQaPlan({
    candidateManifestPath: '/transferred/run/candidate.json',
    expectedTarget: 'darwin-arm64',
    payloadPublicationAdmission: 'pre-activation',
    packedNovelHandoffManifestPath:
      '/handoff/packed-novel-connected-account-qa.json',
    triageGithubVoiceHandoffManifestPath:
      '/handoff/triage-github-voice-qa.json',
    platform: 'darwin',
    arch: 'arm64',
    repoRoot: '/repo',
  });

  assert.deepEqual(nativePlan.steps.map((step) => step.id), [
    'candidate-integrity-native-binary-voice-notary',
    'candidate-direct-install-reinstall',
    'released-dev-candidate-previous-payload-candidate',
    'packed-managed-provider',
    'packed-plugins-dev',
  ]);
  assert.equal(
    nativePlan.steps[4].args.includes('test:plugin-platform:plugins-dev'),
    true,
  );
  assert.equal(
    nativePlan.steps[4].args.at(-1),
    '/transferred/run/candidate.json',
  );
  assert.deepEqual(productPlan.productSteps.map((step) => step.id), [
    'packed-novel-browser-oauth',
    'packed-resources-browser',
    'packed-voice',
    'packed-novel-device-manual-device-ios',
    'packed-novel-device-manual-device-android',
  ]);
  assert.equal(
    productPlan.productSteps[1].args.includes(
      'test:plugin-platform:candidate-resources-browser',
    ),
    true,
  );
  assert.equal(
    productPlan.productSteps[1].args.at(-1),
    '/transferred/run/candidate.json',
  );
  assert.equal(
    productPlan.productSteps[2].args.includes(
      'test:plugin-platform:packed-voice',
    ),
    true,
  );
  assert.equal(
    productPlan.productSteps[2].envPatch
      .HAPPIER_E2E_PACKED_NOVEL_QA_HANDOFF_MANIFEST,
    '/handoff/packed-novel-connected-account-qa.json',
  );
});

test('candidate platform product QA refuses to run without the Triage/GitHub/Voice handoff', () => {
  assert.throws(
    () => resolveCandidatePlatformQaPlan({
      candidateManifestPath: '/transferred/run/candidate.json',
      expectedTarget: 'darwin-arm64',
      payloadPublicationAdmission: 'pre-activation',
      packedNovelHandoffManifestPath:
        '/handoff/packed-novel-connected-account-qa.json',
      platform: 'darwin',
      arch: 'arm64',
      repoRoot: '/repo',
    }),
    /Triage\/GitHub\/Voice handoff is required/u,
  );
});

test('preparation consumes the canonical candidate loader and rejects a missing native archive before effects', async () => {
  const calls = [];
  const cleanup = [];
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
    payloadPublicationAdmission: 'pre-activation',
    platform: 'linux',
    arch: 'x64',
    repoRoot: '/repo',
  }, {
    loadCandidateImpl: async (argv, options) => {
      calls.push({ argv, options });
      return candidate;
    },
    captureCandidateImpl: captureCandidateForTest,
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
      payloadPublicationAdmission: 'pre-activation',
      platform: 'win32',
      arch: 'x64',
      repoRoot: '/repo',
    }, {
      loadCandidateImpl: async () => candidate,
      captureCandidateImpl: captureCandidateForTest,
      removeCapturedRootImpl: async (root) => cleanup.push(root),
    }),
    /does not contain native target windows-x64/u,
  );
  assert.deepEqual(cleanup, ['/private']);
});

test('runner executes the canonical stages serially and never removes the shared candidate root', async () => {
  const invocations = [];
  const cleanup = [];
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
    payloadPublicationAdmission: 'pre-activation',
    platform: 'linux',
    arch: 'x64',
    repoRoot: '/repo',
  }, {
    loadCandidateImpl: async () => candidate,
    captureCandidateImpl: async (_sourceCandidate, options) => ({
      candidate: {
        ...candidate,
        standaloneCli: {
          ...candidate.standaloneCli,
          archives: [{
            ...candidate.standaloneCli.archives[0],
            archivePath: '/private/native/happier-linux-x64.tar.gz',
          }],
        },
      },
      cleanup: async () => await options.rmImpl('/private'),
      manifestPath: '/private/candidate.json',
      root: '/private',
    }),
    removeCapturedRootImpl: async (root) => cleanup.push(root),
    runStepImpl: (step) => {
      invocations.push(step);
    },
  });

  assert.deepEqual(invocations.map((step) => step.id), [
    'candidate-integrity-native-binary-voice-notary',
    'candidate-direct-install-reinstall',
    'released-dev-candidate-previous-payload-candidate',
    'packed-managed-provider',
    'packed-plugins-dev',
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.candidateRunRoot, '/transferred/run');
  assert.equal(result.candidateRunRootRemoved, false);
  assert.deepEqual(cleanup, ['/private']);
  for (const step of invocations) {
    const serialized = JSON.stringify(step);
    assert.doesNotMatch(serialized, /\/transferred\/run\/candidate\.json/u);
    assert.match(serialized, /\/private\/candidate\.json/u);
  }
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
      payloadPublicationAdmission: 'pre-activation',
      platform: 'linux',
      arch: 'x64',
      repoRoot: '/repo',
    }, {
      loadCandidateImpl: async () => candidate,
      captureCandidateImpl: captureCandidateForTest,
      removeCapturedRootImpl: ignoreCapturedCandidateCleanupForTest,
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

test('packed novel product fanout runs Android after an iOS failure before marker-authorized cleanup', async () => {
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
      payloadPublicationAdmission: 'pre-activation',
      packedNovelHandoffManifestPath:
        '/handoff/packed-novel-connected-account-qa.json',
      triageGithubVoiceHandoffManifestPath:
        '/handoff/triage-github-voice-qa.json',
      platform: 'darwin',
      arch: 'arm64',
      repoRoot: '/repo',
    }, {
      loadCandidateImpl: async () => candidate,
      captureCandidateImpl: captureCandidateForTest,
      removeCapturedRootImpl: ignoreCapturedCandidateCleanupForTest,
      runStepImpl: (step) => {
        events.push(step.id);
        if (step.id === 'packed-novel-device-manual-device-ios') {
          throw new Error('iOS device failed');
        }
      },
      cleanupPackedNovelHandoffImpl: async ({ manifestPath }) => {
        events.push(`cleanup:${manifestPath}`);
      },
      cleanupPackedTriageGithubVoiceHandoffImpl: async ({ manifestPath }) => {
        events.push(`cleanup-triage:${manifestPath}`);
      },
    }),
    /iOS device failed/u,
  );
  assert.deepEqual(events.slice(-4), [
    'packed-novel-device-manual-device-ios',
    'packed-novel-device-manual-device-android',
    'cleanup-triage:/handoff/triage-github-voice-qa.json',
    'cleanup:/handoff/packed-novel-connected-account-qa.json',
  ]);
});

test('Darwin arm64 product plan gives both native product steps the same exact candidate, authorization, and handoff', () => {
  const plan = resolveCandidatePlatformQaPlan({
    candidateManifestPath: '/transferred/run/candidate.json',
    expectedTarget: 'darwin-arm64',
    payloadPublicationAdmission: 'pre-activation',
    packedNovelHandoffManifestPath:
      '/handoff/packed-novel-connected-account-qa.json',
    triageGithubVoiceHandoffManifestPath:
      '/handoff/triage-github-voice-qa.json',
    platform: 'darwin',
    arch: 'arm64',
    repoRoot: '/repo',
  });

  assert.equal(
    plan.packedNovelHandoffManifestPath,
    '/handoff/packed-novel-connected-account-qa.json',
  );
  assert.equal(
    plan.triageGithubVoiceHandoffManifestPath,
    '/handoff/triage-github-voice-qa.json',
  );
  assert.deepEqual(
    plan.productSteps.map((step) => step.id),
    CANDIDATE_PRODUCT_STAGE_IDS,
  );
  assert.deepEqual(plan.productSteps[0].args.slice(-6), [
    '--candidate',
    '/transferred/run/candidate.json',
    '--novel-handoff',
    '/handoff/packed-novel-connected-account-qa.json',
    '--triage-github-voice-handoff',
    '/handoff/triage-github-voice-qa.json',
  ]);
  assert.equal(
    plan.productSteps[1].args.at(-1),
    '/transferred/run/candidate.json',
  );
  assert.equal(
    plan.productSteps[1].args.includes(
      'test:plugin-platform:candidate-resources-browser',
    ),
    true,
  );
  assert.equal(
    plan.productSteps[2].envPatch
      .HAPPIER_E2E_PACKED_NOVEL_QA_HANDOFF_MANIFEST,
    '/handoff/packed-novel-connected-account-qa.json',
  );
  assert.equal(
    plan.productSteps[2].args.includes(
      'test:plugin-platform:packed-voice',
    ),
    true,
  );
  const deviceSteps = plan.productSteps.filter((step) => (
    step.id === 'packed-novel-device-manual-device-ios'
    || step.id === 'packed-novel-device-manual-device-android'
  ));
  assert.deepEqual(deviceSteps.map((step) => step.id), [
    'packed-novel-device-manual-device-ios',
    'packed-novel-device-manual-device-android',
  ]);
  assert.equal(
    deviceSteps[0].args.includes(
      'test:mobile:e2e:ios:plugin-platform-candidate',
    ),
    true,
  );
  assert.equal(
    deviceSteps[1].args.includes(
      'test:mobile:e2e:android:plugin-platform-candidate',
    ),
    true,
  );
  assert.deepEqual(
    deviceSteps.map((step) => step.envPatch),
    [
      {
        HAPPIER_E2E_PLUGIN_PLATFORM_CANDIDATE:
          '/transferred/run/candidate.json',
        HAPPIER_E2E_PLUGIN_PLATFORM_G5_AUTHORIZATION:
          'G5_GENERATED_INPUTS_GREEN',
        HAPPIER_E2E_PACKED_NOVEL_QA_HANDOFF_MANIFEST:
          '/handoff/packed-novel-connected-account-qa.json',
        HAPPIER_E2E_TRIAGE_GITHUB_VOICE_QA_HANDOFF_MANIFEST:
          '/handoff/triage-github-voice-qa.json',
      },
      {
        HAPPIER_E2E_PLUGIN_PLATFORM_CANDIDATE:
          '/transferred/run/candidate.json',
        HAPPIER_E2E_PLUGIN_PLATFORM_G5_AUTHORIZATION:
          'G5_GENERATED_INPUTS_GREEN',
        HAPPIER_E2E_PACKED_NOVEL_QA_HANDOFF_MANIFEST:
          '/handoff/packed-novel-connected-account-qa.json',
        HAPPIER_E2E_TRIAGE_GITHUB_VOICE_QA_HANDOFF_MANIFEST:
          '/handoff/triage-github-voice-qa.json',
      },
    ],
  );
});

test('native failure skips product consumers, cleans both retained handoffs exactly once, and preserves cleanup failure beside the primary error', async () => {
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
      payloadPublicationAdmission: 'pre-activation',
      packedNovelHandoffManifestPath:
        '/handoff/packed-novel-connected-account-qa.json',
      triageGithubVoiceHandoffManifestPath:
        '/handoff/triage-github-voice-qa.json',
      platform: 'darwin',
      arch: 'arm64',
      repoRoot: '/repo',
    }, {
      loadCandidateImpl: async () => candidate,
      captureCandidateImpl: captureCandidateForTest,
      removeCapturedRootImpl: ignoreCapturedCandidateCleanupForTest,
      runStepImpl: (step) => {
        events.push(step.id);
        throw new Error('native verification failed');
      },
      cleanupPackedNovelHandoffImpl: async ({ manifestPath }) => {
        events.push(`cleanup:${manifestPath}`);
        throw new Error('handoff cleanup failed');
      },
      cleanupPackedTriageGithubVoiceHandoffImpl: async ({ manifestPath }) => {
        events.push(`cleanup-triage:${manifestPath}`);
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
    'cleanup-triage:/handoff/triage-github-voice-qa.json',
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
