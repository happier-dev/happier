#!/usr/bin/env node

// @ts-check

import { execFileSync, spawnSync } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  PACKED_AUTHOR_NATIVE_TARGETS,
  capturePackedAuthorCandidateArtifacts,
  cleanupPackedNovelConnectedAccountQaHandoff,
  loadPackedAuthorCandidateManifest,
} from '../../../packages/tests/scripts/plugin-platform/run-packed-author-ui-compat.mjs';
import {
  cleanupPackedTriageGithubVoiceQaHandoff,
} from '../../../packages/tests/scripts/plugin-platform/triage-github-voice-qa-handoff.mjs';
import {
  resolveYarnCommandInvocation,
} from '../../workspaces/execYarnCommand.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const WINDOWS_TERMINAL_SCENARIO_IDS = Object.freeze([
  'new-window-exact-child',
  'named-window-reuse',
  'duplicate-or-ambiguous-fail-closed',
  'required-ack-self-exit',
  'no-webhook-exact-cancellation',
]);

function nativeTarget(input) {
  return Object.freeze({
    kind: 'native',
    rosettaAccepted: false,
    ...input,
  });
}

export const CANDIDATE_NATIVE_TARGETS = Object.freeze(
  PACKED_AUTHOR_NATIVE_TARGETS.map((id) => {
    const [os, arch] = id.split('-');
    return nativeTarget({
      id,
      os,
      platform: os === 'windows' ? 'win32' : os,
      arch,
      hardwareClass:
        os === 'darwin'
          ? arch === 'x64'
            ? 'intel-mac'
            : 'apple-silicon-mac'
          : `${os}-${arch}`,
    });
  }),
);

export const CANDIDATE_COMPILE_ONLY_TARGETS = Object.freeze([
  Object.freeze({
    id: 'windows-arm64',
    kind: 'compile-only',
    os: 'windows',
    platform: 'win32',
    arch: 'arm64',
    archivePublished: false,
    nativeCandidateConsumer: false,
    sourceOwner:
      '.github/workflows/tests.yml#managed-provider-wrapper-platforms',
    buildOwner:
      'packages/plugins/cliproxyapi/managed-runtime/tools/build/main.go',
  }),
]);

export const CANDIDATE_PLATFORM_NATIVE_STAGE_IDS = Object.freeze([
  'candidate-integrity-native-binary-voice-notary',
  'candidate-direct-install-reinstall',
  'released-dev-candidate-previous-payload-candidate',
  'packed-managed-provider',
  'packed-plugins-dev',
]);

export const CANDIDATE_PRODUCT_STAGE_IDS = Object.freeze([
  'packed-novel-browser-oauth',
  'packed-resources-browser',
  'packed-voice',
  'packed-novel-device-manual-device-ios',
  'packed-novel-device-manual-device-android',
]);

function fail(message) {
  throw new Error(`candidate-platform-qa: ${message}`);
}

export function resolveCandidatePlatformTarget(rawTarget) {
  const targetId = String(rawTarget ?? '').trim().toLowerCase();
  const target = [
    ...CANDIDATE_NATIVE_TARGETS,
    ...CANDIDATE_COMPILE_ONLY_TARGETS,
  ].find((entry) => entry.id === targetId);
  if (!target) {
    fail(
      `expected target must be one of ${JSON.stringify([
        ...CANDIDATE_NATIVE_TARGETS,
        ...CANDIDATE_COMPILE_ONLY_TARGETS,
      ].map((entry) => entry.id))}`,
    );
  }
  return target;
}

function buildWindowsTerminalInteractiveRecipe() {
  return Object.freeze({
    requiredTarget: 'windows-x64',
    requiresExplorerDesktop: true,
    sshOrSessionZeroAccepted: false,
    requestedTerminalMode: 'windows_terminal',
    cancellationAuthority: Object.freeze([
      'agent-pid',
      'process-start-time',
      'full-command-hash',
    ]),
    consoleFallbackAfterCommittedDispatch: false,
    scenarios: Object.freeze(WINDOWS_TERMINAL_SCENARIO_IDS.map((id) => Object.freeze({
      id,
      canonicalEntryPoint:
        'daemon-hosted packaged Agent session with requested Windows Terminal mode',
      mayTerminateWindowsTerminal: false,
      sharedWindowMustRemainOpen: true,
      exactAgentProcessMustBeObserved: id !== 'duplicate-or-ambiguous-fail-closed',
      ambiguousCustodyMustFailClosed: id === 'duplicate-or-ambiguous-fail-closed',
      requiredAckSelfExit:
        id === 'required-ack-self-exit'
        || id === 'no-webhook-exact-cancellation',
      noWebhook:
        id === 'no-webhook-exact-cancellation',
      windowSelector:
        id === 'new-window-exact-child'
          ? 'new'
          : id === 'named-window-reuse'
            ? 'one stable bounded test-only window name reused by two launches'
            : 'scenario-owned',
    }))),
    requiredObservations: Object.freeze([
      'full packaged executable and argv contain the unique launch correlation',
      'canonical webhook promotes the exact Agent PID before request-auth activation',
      'required acknowledgement precedes runtime construction and first input',
      'zero credential release, runtime input, or upstream effect before acknowledgement',
      'exact cancellation retires only the owned Agent tree',
      'the shared Windows Terminal process and unrelated tabs remain alive',
    ]),
    forbiddenActions: Object.freeze([
      'terminate wt.exe',
      'terminate WindowsTerminal.exe',
      'close a shared Windows Terminal window as cleanup',
      'kill an unreadable, duplicate, or ambiguous Agent candidate',
      'fall back to Console after Windows Terminal dispatch may have committed',
    ]),
  });
}

export function buildCandidatePlatformQaRecipe({
  repoRoot = REPO_ROOT,
} = {}) {
  return Object.freeze({
    schemaVersion: 1,
    kind: 'exact_candidate_platform_qa_recipe',
    command:
      'node scripts/pipeline/release-validation/candidate-platform-qa.mjs --candidate <transferred-run-root>/candidate.json --expected-target <native-target> --payload-publication-admission pre-activation [--packed-novel-handoff <retained-handoff-root>/packed-novel-connected-account-qa.json --triage-github-voice-handoff <retained-handoff-root>/triage-github-voice-qa.json]',
    repoRoot: resolve(repoRoot),
    candidateTransfer: Object.freeze({
      unit: 'whole-run-root',
      manifestOnlyAllowed: false,
      pathsResolveFromManifestDirectory: true,
      mayRelocateRunRoot: true,
      mayRewriteManifest: false,
      mayRebuildOrReplaceArtifacts: false,
      firstConsumer:
        'canonical candidate loader followed by complete checksum/minisign matrix verification',
    }),
    payloadPublicationAdmission: Object.freeze({
      owner:
        'scripts/release/qualified-connected-accounts-v4-activation-admission.mjs',
      requiredStatus: 'pre-activation',
      localInstallStateIsAuthority: false,
      postActivationAction: 'forward-fix',
    }),
    nativeTargets: CANDIDATE_NATIVE_TARGETS,
    compileOnlyTargets: CANDIDATE_COMPILE_ONLY_TARGETS,
    nativeStageIds: CANDIDATE_PLATFORM_NATIVE_STAGE_IDS,
    productQa: Object.freeze({
      requiredTarget: 'darwin-arm64',
      stageIds: CANDIDATE_PRODUCT_STAGE_IDS,
      browserScope: 'real Chromium OAuth popup and callback',
      deviceScope:
        'one isolated iOS simulator and one isolated Android emulator manual plus device-code acceptance',
      oauthOnDevice: false,
      sameHandoffManifestRequired: true,
      allProductConsumersReachTerminalBeforeCleanup: true,
    }),
    runnerPrerequisites: Object.freeze({
      nodeMajor: 22,
      yarnVersion: '1.22.22',
      common: Object.freeze(['node', 'yarn']),
      posix: Object.freeze(['bash', 'curl', 'tar', 'unzip']),
      windows: Object.freeze(['powershell.exe', 'tar.exe']),
      network:
        'required for the released-dev predecessor and installer/update/payload-reversion lane',
      signingSecrets:
        'not consumed by candidate runners; all signatures/notary evidence are immutable candidate inputs',
    }),
    cleanup: Object.freeze({
      executorScratchCleanupRequired: true,
      candidateRunRootRetainedUntilFanoutComplete: true,
      runnerMayDeleteSharedCandidateRunRoot: false,
      candidateRunRootRemovalOwner:
        'the outer fanout/operator after every native and interactive lane reaches a terminal result',
      packedNovelHandoffRemovalOwner:
        'candidate-platform-qa marker-authorized cleanup in an outer finally after native failure or every product consumer reaches a terminal result',
      triageGithubVoiceHandoffRemovalOwner:
        'candidate-platform-qa marker-authorized cleanup in the same outer finally after native failure or every product consumer reaches a terminal result',
      windowsTerminalCleanup:
        'exact Agent PID/start-time/command-hash only; never wt.exe, WindowsTerminal.exe, a shared window, or an ambiguous candidate',
    }),
    windowsTerminalInteractive:
      buildWindowsTerminalInteractiveRecipe(),
  });
}

function normalizeHostFacts({
  platform,
  hostFacts,
  env = process.env,
}) {
  if (hostFacts) return hostFacts;
  if (platform === 'win32') {
    const hardwareArch = String(
      env.PROCESSOR_ARCHITEW6432
      ?? env.PROCESSOR_ARCHITECTURE
      ?? '',
    ).trim().toUpperCase();
    return {
      windowsHardwareArch: hardwareArch || null,
    };
  }
  if (platform !== 'darwin') return {};
  const readSysctlBoolean = (name) => {
    const result = spawnSync('/usr/sbin/sysctl', ['-n', name], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (result.status !== 0) return false;
    return String(result.stdout ?? '').trim() === '1';
  };
  return {
    darwinArm64Hardware: readSysctlBoolean('hw.optional.arm64'),
    darwinTranslated: readSysctlBoolean('sysctl.proc_translated'),
  };
}

function assertNativeHost(target, {
  platform,
  arch,
  hostFacts,
}) {
  if (platform !== target.platform || arch !== target.arch) {
    fail(
      `${target.id} must execute natively on ${target.platform}/${target.arch}; current host is ${platform}/${arch}`,
    );
  }
  if (
    target.id === 'darwin-x64'
    && (
      hostFacts?.darwinArm64Hardware === true
      || hostFacts?.darwinTranslated === true
    )
  ) {
    fail('darwin-x64 requires a genuine Intel macOS host; Rosetta is not accepted');
  }
  if (
    target.id === 'windows-x64'
    && String(hostFacts?.windowsHardwareArch ?? '').toUpperCase() === 'ARM64'
  ) {
    fail('windows-x64 requires native x64 Windows hardware; ARM64 emulation is not accepted');
  }
}

function buildNodeValidationStep({
  id,
  args,
  repoRoot,
}) {
  return Object.freeze({
    id,
    command: process.execPath,
    args: Object.freeze([
      resolve(
        repoRoot,
        'scripts',
        'pipeline',
        'release-validation',
        'validate-release.mjs',
      ),
      ...args,
    ]),
    cwd: repoRoot,
  });
}

export function resolveCandidatePlatformQaPlan({
  candidateManifestPath,
  expectedTarget,
  payloadPublicationAdmission,
  packedNovelHandoffManifestPath,
  triageGithubVoiceHandoffManifestPath,
  platform = process.platform,
  arch = process.arch,
  hostFacts,
  repoRoot = REPO_ROOT,
}) {
  if (payloadPublicationAdmission !== 'pre-activation') {
    fail(
      'exact previous-payload reversion QA requires canonical pre-activation payload-publication admission; ' +
      'post-activation old-server, old-daemon, and loaded-runtime rollback are unsupported',
    );
  }
  const target = resolveCandidatePlatformTarget(expectedTarget);
  if (target.kind === 'compile-only') {
    fail(
      `${target.id} is compile-only and has no native candidate archive or candidate execution lane`,
    );
  }
  const resolvedRepoRoot = resolve(repoRoot);
  const resolvedCandidateManifestPath =
    resolve(resolvedRepoRoot, String(candidateManifestPath ?? '').trim());
  if (!String(candidateManifestPath ?? '').trim()) {
    fail('candidate manifest path is required');
  }
  assertNativeHost(target, {
    platform,
    arch,
    hostFacts: normalizeHostFacts({
      platform,
      hostFacts,
    }),
  });
  const packedNovelHandoffValue =
    String(packedNovelHandoffManifestPath ?? '').trim();
  const resolvedPackedNovelHandoffManifestPath =
    packedNovelHandoffValue
      ? resolve(resolvedRepoRoot, packedNovelHandoffValue)
      : null;
  const triageGithubVoiceHandoffValue =
    String(triageGithubVoiceHandoffManifestPath ?? '').trim();
  const resolvedTriageGithubVoiceHandoffManifestPath =
    triageGithubVoiceHandoffValue
      ? resolve(resolvedRepoRoot, triageGithubVoiceHandoffValue)
      : null;
  if (
    resolvedPackedNovelHandoffManifestPath
    && !resolvedTriageGithubVoiceHandoffManifestPath
  ) {
    fail('Triage/GitHub/Voice handoff is required for packed novel product QA');
  }
  if (
    resolvedTriageGithubVoiceHandoffManifestPath
    && !resolvedPackedNovelHandoffManifestPath
  ) {
    fail('Triage/GitHub/Voice handoff requires packed novel product QA');
  }
  if (
    resolvedPackedNovelHandoffManifestPath
    && target.id !== 'darwin-arm64'
  ) {
    fail(
      'packed novel browser/device product QA requires the native darwin-arm64 runner',
    );
  }

  const commonExactCandidateArgs = [
    '--platform',
    target.platform,
    '--source',
    'local-build',
    '--ref',
    resolvedCandidateManifestPath,
  ];
  const packedManagedInvocation = resolveYarnCommandInvocation(
    [
      'workspace',
      '@happier-dev/tests',
      'test:plugin-platform:packed-managed-provider',
      '--candidate',
      resolvedCandidateManifestPath,
    ],
    {
      platform,
      npmExecPath: '',
      processExecPath: process.execPath,
    },
  );
  const packedPluginsDevInvocation = resolveYarnCommandInvocation(
    [
      'workspace',
      '@happier-dev/tests',
      'test:plugin-platform:plugins-dev',
      '--candidate',
      resolvedCandidateManifestPath,
    ],
    {
      platform,
      npmExecPath: '',
      processExecPath: process.execPath,
    },
  );
  const packedResourcesBrowserInvocation =
    resolvedPackedNovelHandoffManifestPath
      ? resolveYarnCommandInvocation(
        [
          'workspace',
          '@happier-dev/tests',
          'test:plugin-platform:candidate-resources-browser',
          '--candidate',
          resolvedCandidateManifestPath,
        ],
        {
          platform,
          npmExecPath: '',
          processExecPath: process.execPath,
        },
      )
      : null;
  const packedVoiceInvocation =
    resolvedPackedNovelHandoffManifestPath
      ? resolveYarnCommandInvocation(
        [
          'workspace',
          '@happier-dev/tests',
          'test:plugin-platform:packed-voice',
        ],
        {
          platform,
          npmExecPath: '',
          processExecPath: process.execPath,
        },
      )
      : null;
  const packedNovelIosDeviceInvocation =
    resolvedPackedNovelHandoffManifestPath
      ? resolveYarnCommandInvocation(
        [
          'workspace',
          '@happier-dev/tests',
          'test:mobile:e2e:ios:plugin-platform-candidate',
        ],
        {
          platform,
          npmExecPath: '',
          processExecPath: process.execPath,
        },
      )
      : null;
  const packedNovelAndroidDeviceInvocation =
    resolvedPackedNovelHandoffManifestPath
      ? resolveYarnCommandInvocation(
        [
          'workspace',
          '@happier-dev/tests',
          'test:mobile:e2e:android:plugin-platform-candidate',
        ],
        {
          platform,
          npmExecPath: '',
          processExecPath: process.execPath,
        },
      )
      : null;
  const packedNovelDeviceEnvPatch =
    resolvedPackedNovelHandoffManifestPath
      ? Object.freeze({
        HAPPIER_E2E_PLUGIN_PLATFORM_CANDIDATE:
          resolvedCandidateManifestPath,
        HAPPIER_E2E_PLUGIN_PLATFORM_G5_AUTHORIZATION:
          'G5_GENERATED_INPUTS_GREEN',
        HAPPIER_E2E_PACKED_NOVEL_QA_HANDOFF_MANIFEST:
          resolvedPackedNovelHandoffManifestPath,
        HAPPIER_E2E_TRIAGE_GITHUB_VOICE_QA_HANDOFF_MANIFEST:
          resolvedTriageGithubVoiceHandoffManifestPath,
      })
      : null;

  return Object.freeze({
    schemaVersion: 1,
    kind: 'exact_candidate_platform_qa_plan',
    target,
    candidateManifestPath: resolvedCandidateManifestPath,
    candidateRunRoot: dirname(resolvedCandidateManifestPath),
    packedNovelHandoffManifestPath:
      resolvedPackedNovelHandoffManifestPath,
    triageGithubVoiceHandoffManifestPath:
      resolvedTriageGithubVoiceHandoffManifestPath,
    steps: Object.freeze([
      buildNodeValidationStep({
        id: CANDIDATE_PLATFORM_NATIVE_STAGE_IDS[0],
        repoRoot: resolvedRepoRoot,
        args: [
          '--suite',
          'binary-smoke',
          ...commonExactCandidateArgs,
        ],
      }),
      buildNodeValidationStep({
        id: CANDIDATE_PLATFORM_NATIVE_STAGE_IDS[1],
        repoRoot: resolvedRepoRoot,
        args: [
          '--suite',
          'installers-smoke',
          ...commonExactCandidateArgs,
          '--release-channel',
          'dev',
        ],
      }),
      buildNodeValidationStep({
        id: CANDIDATE_PLATFORM_NATIVE_STAGE_IDS[2],
        repoRoot: resolvedRepoRoot,
        args: [
          '--suite',
          'installers-smoke',
          '--platform',
          target.platform,
          '--from-source',
          'published-channel',
          '--from-ref',
          'dev',
          '--to-source',
          'local-build',
          '--to-ref',
          resolvedCandidateManifestPath,
          '--release-channel',
          'dev',
          '--payload-publication-admission',
          payloadPublicationAdmission,
        ],
      }),
      Object.freeze({
        id: CANDIDATE_PLATFORM_NATIVE_STAGE_IDS[3],
        command: packedManagedInvocation.command,
        args: Object.freeze(packedManagedInvocation.args),
        cwd: resolvedRepoRoot,
        ...(packedManagedInvocation.windowsVerbatimArguments
          ? {
              windowsVerbatimArguments:
                packedManagedInvocation.windowsVerbatimArguments,
            }
          : {}),
      }),
      Object.freeze({
        id: CANDIDATE_PLATFORM_NATIVE_STAGE_IDS[4],
        command: packedPluginsDevInvocation.command,
        args: Object.freeze(packedPluginsDevInvocation.args),
        cwd: resolvedRepoRoot,
        ...(packedPluginsDevInvocation.windowsVerbatimArguments
          ? {
              windowsVerbatimArguments:
                packedPluginsDevInvocation.windowsVerbatimArguments,
            }
          : {}),
      }),
    ]),
    productSteps: Object.freeze(
      resolvedPackedNovelHandoffManifestPath
        ? [
            Object.freeze({
              id: CANDIDATE_PRODUCT_STAGE_IDS[0],
              command: process.execPath,
              args: Object.freeze([
                resolve(
                  resolvedRepoRoot,
                  'packages',
                  'tests',
                  'scripts',
                  'plugin-platform',
                  'run-packed-candidate-browser-qa.mjs',
                ),
                '--candidate',
                resolvedCandidateManifestPath,
                '--novel-handoff',
                resolvedPackedNovelHandoffManifestPath,
                '--triage-github-voice-handoff',
                resolvedTriageGithubVoiceHandoffManifestPath,
              ]),
              cwd: resolvedRepoRoot,
            }),
            Object.freeze({
              id: CANDIDATE_PRODUCT_STAGE_IDS[1],
              command: packedResourcesBrowserInvocation.command,
              args: Object.freeze(packedResourcesBrowserInvocation.args),
              cwd: resolvedRepoRoot,
              ...(packedResourcesBrowserInvocation.windowsVerbatimArguments
                ? {
                    windowsVerbatimArguments:
                      packedResourcesBrowserInvocation.windowsVerbatimArguments,
                  }
                : {}),
            }),
            Object.freeze({
              id: CANDIDATE_PRODUCT_STAGE_IDS[2],
              command: packedVoiceInvocation.command,
              args: Object.freeze(packedVoiceInvocation.args),
              cwd: resolvedRepoRoot,
              envPatch: Object.freeze({
                HAPPIER_E2E_PACKED_NOVEL_QA_HANDOFF_MANIFEST:
                  resolvedPackedNovelHandoffManifestPath,
              }),
              ...(packedVoiceInvocation.windowsVerbatimArguments
                ? {
                    windowsVerbatimArguments:
                      packedVoiceInvocation.windowsVerbatimArguments,
                  }
                : {}),
            }),
            Object.freeze({
              id: CANDIDATE_PRODUCT_STAGE_IDS[3],
              command: packedNovelIosDeviceInvocation.command,
              args: Object.freeze(packedNovelIosDeviceInvocation.args),
              cwd: resolvedRepoRoot,
              envPatch: packedNovelDeviceEnvPatch,
              ...(packedNovelIosDeviceInvocation.windowsVerbatimArguments
                ? {
                    windowsVerbatimArguments:
                      packedNovelIosDeviceInvocation.windowsVerbatimArguments,
                  }
                : {}),
            }),
            Object.freeze({
              id: CANDIDATE_PRODUCT_STAGE_IDS[4],
              command: packedNovelAndroidDeviceInvocation.command,
              args: Object.freeze(packedNovelAndroidDeviceInvocation.args),
              cwd: resolvedRepoRoot,
              envPatch: packedNovelDeviceEnvPatch,
              ...(packedNovelAndroidDeviceInvocation.windowsVerbatimArguments
                ? {
                    windowsVerbatimArguments:
                      packedNovelAndroidDeviceInvocation.windowsVerbatimArguments,
                  }
                : {}),
            }),
          ]
        : [],
    ),
  });
}

export async function prepareCandidatePlatformQa(input, {
  loadCandidateImpl = loadPackedAuthorCandidateManifest,
  captureCandidateImpl = capturePackedAuthorCandidateArtifacts,
  removeCapturedRootImpl = async (root) => await rm(root, { recursive: true, force: true }),
} = {}) {
  let captured = null;
  try {
    const sourcePlan = resolveCandidatePlatformQaPlan(input);
    const sourceCandidate = await loadCandidateImpl(
      ['--candidate', sourcePlan.candidateManifestPath],
      { cwd: sourcePlan.steps[0].cwd },
    );
    captured = await captureCandidateImpl(sourceCandidate, {
      manifestPath: sourcePlan.candidateManifestPath,
      destinationParent: tmpdir(),
      selection: 'all',
      writeManifest: true,
      rmImpl: removeCapturedRootImpl,
    });
    if (!captured.manifestPath) {
      fail('complete candidate capture did not produce a private manifest');
    }
    const privatePlan = resolveCandidatePlatformQaPlan({
      ...input,
      candidateManifestPath: captured.manifestPath,
    });
    const plan = Object.freeze({
      ...privatePlan,
      candidateRunRoot: sourcePlan.candidateRunRoot,
    });
    const candidate = captured.candidate;
    const nativeArchive = candidate?.standaloneCli?.archives?.find(
      (artifact) => (
        artifact.os === plan.target.os
        && artifact.arch === plan.target.arch
      ),
    );
    if (!nativeArchive) {
      fail(`candidate does not contain native target ${plan.target.id}`);
    }
    return Object.freeze({
      candidate,
      cleanup: captured.cleanup,
      captureRoot: captured.root,
      nativeArchive,
      plan,
      target: plan.target,
    });
  } catch (error) {
    if (captured) {
      try {
        await captured.cleanup();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Candidate platform QA preparation and private capture cleanup failed',
        );
      }
    }
    throw error;
  }
}

function defaultRunStep(step) {
  execFileSync(step.command, step.args, {
    cwd: step.cwd,
    env: {
      ...process.env,
      ...(step.envPatch ?? {}),
    },
    stdio: 'inherit',
    ...(step.windowsVerbatimArguments
      ? { windowsVerbatimArguments: step.windowsVerbatimArguments }
      : {}),
  });
}

export async function runCandidatePlatformQa(input, {
  loadCandidateImpl = loadPackedAuthorCandidateManifest,
  captureCandidateImpl = capturePackedAuthorCandidateArtifacts,
  runStepImpl = defaultRunStep,
  removeCapturedRootImpl = async (root) => await rm(root, { recursive: true, force: true }),
  cleanupPackedNovelHandoffImpl =
    cleanupPackedNovelConnectedAccountQaHandoff,
  cleanupPackedTriageGithubVoiceHandoffImpl =
    cleanupPackedTriageGithubVoiceQaHandoff,
} = {}) {
  const packedNovelHandoffValue =
    String(input.packedNovelHandoffManifestPath ?? '').trim();
  const cleanupManifestPath = packedNovelHandoffValue
    ? resolve(input.repoRoot ?? REPO_ROOT, packedNovelHandoffValue)
    : null;
  const triageGithubVoiceHandoffValue =
    String(input.triageGithubVoiceHandoffManifestPath ?? '').trim();
  const triageGithubVoiceCleanupManifestPath = triageGithubVoiceHandoffValue
    ? resolve(input.repoRoot ?? REPO_ROOT, triageGithubVoiceHandoffValue)
    : null;
  let prepared = null;
  const failures = [];
  let packedNovelHandoffRemoved = false;
  let triageGithubVoiceHandoffRemoved = false;
  let consumerRootRemoved = false;
  try {
    prepared = await prepareCandidatePlatformQa(input, {
      loadCandidateImpl,
      captureCandidateImpl,
      removeCapturedRootImpl,
    });
    for (const step of prepared.plan.steps) {
      await runStepImpl(step);
    }
    for (const step of prepared.plan.productSteps) {
      try {
        await runStepImpl(step);
      } catch (error) {
        failures.push(error);
      }
    }
  } catch (error) {
    failures.push(error);
  } finally {
    if (prepared) {
      try {
        await prepared.cleanup();
        consumerRootRemoved = true;
      } catch (error) {
        failures.push(error);
      }
    }
    if (triageGithubVoiceCleanupManifestPath) {
      try {
        await cleanupPackedTriageGithubVoiceHandoffImpl({
          manifestPath: triageGithubVoiceCleanupManifestPath,
        });
        triageGithubVoiceHandoffRemoved = true;
      } catch (error) {
        failures.push(error);
      }
    }
    if (cleanupManifestPath) {
      try {
        await cleanupPackedNovelHandoffImpl({
          manifestPath: cleanupManifestPath,
        });
        packedNovelHandoffRemoved = true;
      } catch (error) {
        failures.push(error);
      }
    }
  }
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(
      failures,
      `candidate-platform-qa failures: ${failures.map(
        (error) => error instanceof Error ? error.message : String(error),
      ).join('; ')}`,
    );
  }
  if (!prepared) {
    fail('preparation did not produce a candidate plan');
  }
  return Object.freeze({
    ok: true,
    target: prepared.target.id,
    candidateRunRoot: prepared.plan.candidateRunRoot,
    candidateRunRootRemoved: false,
    consumerRootRemoved,
    completedStageIds: CANDIDATE_PLATFORM_NATIVE_STAGE_IDS,
    completedProductStageIds: prepared.plan.productSteps.map(
      (step) => step.id,
    ),
    packedNovelHandoffRemoved,
    triageGithubVoiceHandoffRemoved,
  });
}

function parseCandidatePlatformQaArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      recipe: { type: 'boolean', default: false },
      candidate: { type: 'string', default: '' },
      'expected-target': { type: 'string', default: '' },
      'packed-novel-handoff': { type: 'string', default: '' },
      'triage-github-voice-handoff': { type: 'string', default: '' },
      'payload-publication-admission': { type: 'string', default: '' },
    },
    allowPositionals: false,
  });
  const candidate = String(values.candidate ?? '').trim();
  const expectedTarget =
    String(values['expected-target'] ?? '').trim();
  const packedNovelHandoff =
    String(values['packed-novel-handoff'] ?? '').trim();
  const triageGithubVoiceHandoff =
    String(values['triage-github-voice-handoff'] ?? '').trim();
  const payloadPublicationAdmission =
    String(values['payload-publication-admission'] ?? '').trim();
  if (values.recipe === true) {
    if (
      candidate
      || expectedTarget
      || packedNovelHandoff
      || triageGithubVoiceHandoff
      || payloadPublicationAdmission
    ) {
      fail('--recipe is candidate-free and cannot be combined with execution arguments');
    }
    return { mode: 'recipe' };
  }
  if (!candidate || !expectedTarget) {
    fail('--candidate and --expected-target are required');
  }
  if (!payloadPublicationAdmission) {
    fail('--payload-publication-admission is required');
  }
  if (packedNovelHandoff && !triageGithubVoiceHandoff) {
    fail('--triage-github-voice-handoff is required with --packed-novel-handoff');
  }
  if (triageGithubVoiceHandoff && !packedNovelHandoff) {
    fail('--triage-github-voice-handoff requires --packed-novel-handoff');
  }
  return {
    mode: 'run',
    candidateManifestPath: candidate,
    expectedTarget,
    payloadPublicationAdmission,
    ...(packedNovelHandoff
      ? { packedNovelHandoffManifestPath: packedNovelHandoff }
      : {}),
    ...(triageGithubVoiceHandoff
      ? { triageGithubVoiceHandoffManifestPath: triageGithubVoiceHandoff }
      : {}),
  };
}

async function main() {
  const parsed = parseCandidatePlatformQaArgs(
    process.argv.slice(2),
  );
  if (parsed.mode === 'recipe') {
    process.stdout.write(
      `${JSON.stringify(buildCandidatePlatformQaRecipe(), null, 2)}\n`,
    );
    return;
  }
  const result = await runCandidatePlatformQa({
    candidateManifestPath: parsed.candidateManifestPath,
    expectedTarget: parsed.expectedTarget,
    payloadPublicationAdmission: parsed.payloadPublicationAdmission,
    ...(parsed.packedNovelHandoffManifestPath
      ? {
          packedNovelHandoffManifestPath:
            parsed.packedNovelHandoffManifestPath,
        }
      : {}),
    ...(parsed.triageGithubVoiceHandoffManifestPath
      ? {
          triageGithubVoiceHandoffManifestPath:
            parsed.triageGithubVoiceHandoffManifestPath,
        }
      : {}),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const isMain =
  process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  await main();
}
