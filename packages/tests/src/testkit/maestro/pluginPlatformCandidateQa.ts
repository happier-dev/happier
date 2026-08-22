import { mkdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import {
  assertPackedCliEntrypoint,
  assertPackedNovelConnectedAccountQaCandidate,
  assertPackedPluginUiSdkDependency,
  assertPackedPackageIdentity,
  capturePackedAuthorCandidateArtifacts,
  loadPackedAuthorCandidateManifest,
  loadPackedNovelConnectedAccountQaHandoff,
  materializePackedCli,
  readPackedPackageManifest,
  type PackedAuthorCandidate,
  type PackedNovelConnectedAccountQaHandoff,
} from '../../../scripts/plugin-platform/run-packed-author-ui-compat.mjs';
import {
  attestPackedInspectorArtifacts,
  type PackedInspectorArtifactAttestation,
} from '../pluginPlatform/packedCandidateBrowserQa';
import {
  readPluginInstallReviewRequiredEnvelope,
  type PluginInstallationReviewFacts,
} from '../pluginPlatform/authenticatedInstallReview';
import type { NativeTriageGithubVoiceQaInput } from './mobilePluginPlatformCandidateInput';

export const G5_GENERATED_INPUTS_AUTHORIZATION = 'G5_GENERATED_INPUTS_GREEN' as const;

export type InspectorNativeArtifactIdentity =
  PackedInspectorArtifactAttestation['platforms']['ios'];

type CandidateQaDeps = Readonly<{
  loadCandidate: (manifestPath: string) => Promise<PackedAuthorCandidate>;
  removeCapturedRoot: typeof rm;
  readPackedPackageManifest: typeof readPackedPackageManifest;
  materializePackedCli: typeof materializePackedCli;
  attestPackedInspectorArtifacts: typeof attestPackedInspectorArtifacts;
}>;

type PackedNovelConnectedAccountQaDeviceHandoff = Readonly<{
  plugin: Readonly<{
    archivePath: string;
    service: Readonly<{
      pluginId: string;
      localId: string;
    }>;
    authenticationModeIds: readonly string[];
  }>;
  publicAuthoring: Readonly<{
    pluginId: string;
    version: string;
    archivePath: string;
    archive: Readonly<{
      integrity: string;
      sha256: string;
      sizeBytes: number;
      archivePath: string;
    }>;
    hostedWeb: Readonly<{
      contributionId: string;
      entry: string;
      digest: string;
      files: readonly Readonly<{
        relativePath: string;
        digest: string;
        byteSize: number;
      }>[];
    }>;
  }>;
  consumers: Readonly<{
    browser: Readonly<{
      root: string;
      happyHomeDir: string;
      databasePath: string;
    }>;
    device: Readonly<{
      root: string;
      happyHomeDir: string;
      databasePath: string;
    }>;
  }>;
  oauth: Readonly<{
    authorizationOriginConfigurationFieldId: string;
    callbackUrl: string;
    authorizePath: string;
    transport: string;
  }>;
}>;

type PackedNovelConnectedAccountQaDeviceDeps = Readonly<{
  loadHandoff: (
    input: Readonly<{ manifestPath: string }>,
  ) => Promise<PackedNovelConnectedAccountQaDeviceHandoff>;
  assertCandidate: (input: Readonly<{
    handoff: PackedNovelConnectedAccountQaDeviceHandoff;
    candidate: PackedAuthorCandidate;
  }>) => void;
}>;

const defaultDeps: CandidateQaDeps = {
  loadCandidate: async (manifestPath) => await loadPackedAuthorCandidateManifest([
    '--candidate',
    manifestPath,
  ]),
  removeCapturedRoot: rm,
  readPackedPackageManifest,
  materializePackedCli,
  attestPackedInspectorArtifacts,
};

export type PreparedPluginPlatformCandidateQa = Readonly<{
  candidate: PackedAuthorCandidate;
  cliEntrypoint: string;
  cleanup: () => Promise<void>;
  inspectorArtifacts: Readonly<{
    ios: InspectorNativeArtifactIdentity;
    android: InspectorNativeArtifactIdentity;
  }>;
}>;

export type PreparedPackedNovelConnectedAccountDeviceQa = Readonly<{
  pluginArchivePath: string;
  service:
    PackedNovelConnectedAccountQaDeviceHandoff['plugin']['service'];
  authenticationModeIds:
    PackedNovelConnectedAccountQaDeviceHandoff['plugin']['authenticationModeIds'];
  isolation:
    PackedNovelConnectedAccountQaDeviceHandoff['consumers']['device'];
  oauth: PackedNovelConnectedAccountQaDeviceHandoff['oauth'];
  publicAuthoring:
    PackedNovelConnectedAccountQaDeviceHandoff['publicAuthoring'];
}>;

const defaultPackedNovelConnectedAccountQaDeviceDeps:
PackedNovelConnectedAccountQaDeviceDeps = {
  loadHandoff: loadPackedNovelConnectedAccountQaHandoff,
  assertCandidate: ({ handoff, candidate }) => {
    assertPackedNovelConnectedAccountQaCandidate({
      handoff: handoff as PackedNovelConnectedAccountQaHandoff,
      candidate,
    });
  },
};

export async function preparePackedNovelConnectedAccountDeviceQa(
  input: Readonly<{
    candidate: PackedAuthorCandidate;
    handoffManifestPath: string;
    deps?: PackedNovelConnectedAccountQaDeviceDeps;
  }>,
): Promise<PreparedPackedNovelConnectedAccountDeviceQa> {
  const deps =
    input.deps ?? defaultPackedNovelConnectedAccountQaDeviceDeps;
  const handoff = await deps.loadHandoff({
    manifestPath: input.handoffManifestPath,
  });
  deps.assertCandidate({
    handoff,
    candidate: input.candidate,
  });
  return Object.freeze({
    pluginArchivePath: handoff.plugin.archivePath,
    service: handoff.plugin.service,
    authenticationModeIds: handoff.plugin.authenticationModeIds,
    isolation: handoff.consumers.device,
    oauth: handoff.oauth,
    publicAuthoring: handoff.publicAuthoring,
  });
}

async function prepareVerifiedPluginPlatformCandidateQa(input: Readonly<{
  candidate: PackedAuthorCandidate;
  cleanup: () => Promise<void>;
  workDir: string;
  deps?: Partial<CandidateQaDeps>;
}>): Promise<PreparedPluginPlatformCandidateQa> {
  const candidate = input.candidate;
  const deps = { ...defaultDeps, ...(input.deps ?? {}) };
  await mkdir(input.workDir, { recursive: true });
  const [sdkPackageManifest, pluginUiPackageManifest, cliPackageManifest] = await Promise.all([
    deps.readPackedPackageManifest(
      candidate.sdk.tarballPath,
      join(input.workDir, 'sdk-artifact'),
    ),
    deps.readPackedPackageManifest(
      candidate.pluginUi.tarballPath,
      join(input.workDir, 'plugin-ui-artifact'),
    ),
    deps.readPackedPackageManifest(
      candidate.cli.tarballPath,
      join(input.workDir, 'cli-artifact'),
    ),
  ]);
  assertPackedPackageIdentity(sdkPackageManifest, candidate.sdk, 'Packed SDK');
  assertPackedPackageIdentity(
    pluginUiPackageManifest,
    candidate.pluginUi,
    'Packed Plugin UI',
  );
  assertPackedPluginUiSdkDependency(pluginUiPackageManifest, candidate.sdk);
  assertPackedPackageIdentity(cliPackageManifest, candidate.cli, 'Packed CLI');
  assertPackedCliEntrypoint(cliPackageManifest, candidate.cli);

  const cliInstallRoot = join(input.workDir, 'candidate-cli-install');
  const cliEntrypoint = await deps.materializePackedCli({
    cliArtifact: candidate.cli,
    installRoot: cliInstallRoot,
  });
  const exactInspectorGraph = await deps.attestPackedInspectorArtifacts({ cliEntrypoint });
  const inspectorArtifacts = Object.freeze({
    ios: exactInspectorGraph.platforms.ios,
    android: exactInspectorGraph.platforms.android,
  });
  return Object.freeze({
    candidate,
    cleanup: input.cleanup,
    cliEntrypoint,
    inspectorArtifacts,
  });
}

export async function preparePluginPlatformCandidateQa(input: Readonly<{
  authorization: string;
  candidateManifestPath: string;
  workDir: string;
  deps?: Partial<CandidateQaDeps>;
}>): Promise<PreparedPluginPlatformCandidateQa> {
  if (input.authorization !== G5_GENERATED_INPUTS_AUTHORIZATION) {
    throw new Error(
      `Native Plugin Platform QA is blocked until literal ${G5_GENERATED_INPUTS_AUTHORIZATION} candidate authorization.`,
    );
  }
  const candidateManifestPath = resolve(input.candidateManifestPath);
  const deps = { ...defaultDeps, ...(input.deps ?? {}) };
  const candidate = await deps.loadCandidate(candidateManifestPath);
  await mkdir(input.workDir, { recursive: true });
  const captured = await capturePackedAuthorCandidateArtifacts(candidate, {
    manifestPath: candidateManifestPath,
    destinationParent: input.workDir,
    selection: { packages: ['sdk', 'pluginUi', 'cli'] },
    rmImpl: deps.removeCapturedRoot,
  });
  const cleanup = captured.cleanup;
  try {
    return await prepareVerifiedPluginPlatformCandidateQa({
      candidate: captured.candidate,
      cleanup,
      workDir: input.workDir,
      deps,
    });
  } catch (error) {
    let cleanupFailed = false;
    let firstCleanupError: unknown = null;
    try {
      await cleanup();
    } catch (cleanupError) {
      cleanupFailed = true;
      firstCleanupError = cleanupError;
    }
    if (cleanupFailed) {
      try {
        await cleanup();
      } catch (secondCleanupError) {
        throw new AggregateError(
          [error, firstCleanupError, secondCleanupError],
          'Plugin Platform mobile candidate preparation and private capture cleanup failed twice',
        );
      }
    }
    throw error;
  }
}

export async function resolveReusablePackedCliEntrypoint(input: Readonly<{
  installRoot: string;
  cliArtifact: PackedAuthorCandidate['cli'];
}>): Promise<string> {
  const packageRoot = resolve(
    input.installRoot,
    'node_modules',
    ...input.cliArtifact.packageName.split('/'),
  );
  const packageManifest = JSON.parse(
    await readFile(join(packageRoot, 'package.json'), 'utf8'),
  );
  assertPackedPackageIdentity(packageManifest, input.cliArtifact, 'Reusable packed CLI');
  assertPackedCliEntrypoint(packageManifest, input.cliArtifact);

  const packageRelativeEntrypoint = input.cliArtifact.entrypoint.slice('package/'.length);
  const resolvedPackageRoot = await realpath(packageRoot);
  const resolvedEntrypoint = await realpath(join(packageRoot, packageRelativeEntrypoint));
  const relativeEntrypoint = relative(resolvedPackageRoot, resolvedEntrypoint);
  const entrypointStats = await stat(resolvedEntrypoint);
  if (
    !entrypointStats.isFile()
    || isAbsolute(relativeEntrypoint)
    || relativeEntrypoint === '..'
    || relativeEntrypoint.startsWith(`..${sep}`)
  ) {
    throw new Error('Reusable packed CLI entrypoint must be contained by its package root.');
  }
  return resolvedEntrypoint;
}

function parseReviewRequiredCliOutput(stdout: string): Readonly<{
  pendingChangeId: string;
  review: PluginInstallationReviewFacts;
}> {
  const lines = stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  let envelope: unknown = null;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      envelope = JSON.parse(lines[index] ?? '');
      break;
    } catch {
      // Candidate CLI diagnostics may precede the final JSON envelope.
    }
  }
  return readPluginInstallReviewRequiredEnvelope(envelope);
}

export async function runPluginPlatformCandidateQaPhases(input: Readonly<{
  pluginId: string;
  installArchivePath: string;
  updateArchivePath: string;
  targeted?: Readonly<{
    targetArchivePath: string;
    contributorPluginId: string;
    contributorV1ArchivePath: string;
    contributorV2ArchivePath: string;
  }>;
  triageGithubVoice?: NativeTriageGithubVoiceQaInput;
  runFlow: (flowPath: string, extraEnv?: NodeJS.ProcessEnv) => Promise<{ exitCode: number }>;
  runCli: (args: readonly string[]) => Promise<string>;
  requestPluginChange?: (request: Readonly<{
    kind: 'forgetTrust';
    pluginId: string;
  }>) => Promise<unknown>;
  decideInstallReview: (input: Readonly<{
    pendingChangeId: string;
    review: PluginInstallationReviewFacts;
  }>) => Promise<void>;
  stopDaemon: () => Promise<void>;
  startDaemon: () => Promise<void>;
}>): Promise<number> {
  if (input.targeted && !input.triageGithubVoice) {
    throw new Error('Targeted Plugin Platform QA requires the schema-v2 Triage GitHub Voice handoff');
  }

  const runRequiredFlow = async (
    flowPath: string,
    extraEnv?: NodeJS.ProcessEnv,
  ): Promise<number> => {
    const result = await input.runFlow(flowPath, extraEnv);
    return result.exitCode;
  };

  const installWithPresentUserReview = async (archivePath: string): Promise<void> => {
    const reviewRequired = parseReviewRequiredCliOutput(await input.runCli([
      'plugins',
      'install',
      archivePath,
      '--kind',
      'archive',
      '--json',
    ]));
    await input.decideInstallReview(reviewRequired);
  };

  await installWithPresentUserReview(input.installArchivePath);
  if (input.targeted) {
    await installWithPresentUserReview(input.targeted.targetArchivePath);
    await installWithPresentUserReview(input.targeted.contributorV1ArchivePath);
    let exitCode = await runRequiredFlow(
      'suites/mobile-e2e/flows/plugin-platform-candidate/ucx-baseline-navigation.yaml',
    );
    if (exitCode !== 0) return exitCode;
    const triageGithubVoice = input.triageGithubVoice;
    if (!triageGithubVoice) {
      throw new Error('Targeted Plugin Platform QA requires the schema-v2 Triage GitHub Voice handoff');
    }
    exitCode = await runRequiredFlow(
      'suites/mobile-e2e/flows/plugin-platform-candidate/ucx-normal-triage-voice.yaml',
      {
        HAPPIER_E2E_TRIAGE_GITHUB_VOICE_QA_GITHUB_TOKEN: triageGithubVoice.githubToken,
        HAPPIER_E2E_TRIAGE_GITHUB_VOICE_QA_SCOPE_TITLE: triageGithubVoice.githubScopeTitle,
        HAPPIER_E2E_TRIAGE_GITHUB_VOICE_QA_ISSUE_A_TITLE: triageGithubVoice.issueATitle,
        HAPPIER_E2E_TRIAGE_GITHUB_VOICE_QA_ISSUE_B_TITLE: triageGithubVoice.issueBTitle,
        HAPPIER_E2E_TRIAGE_GITHUB_VOICE_QA_VOICE_ADAPTER_ID:
          triageGithubVoice.voice.adapterId,
        HAPPIER_E2E_TRIAGE_GITHUB_VOICE_QA_VOICE_CONVERSATION_MODE:
          triageGithubVoice.voice.conversationMode,
        HAPPIER_E2E_TRIAGE_GITHUB_VOICE_QA_VOICE_AGENT_ID:
          triageGithubVoice.voice.agentId,
        HAPPIER_E2E_TRIAGE_GITHUB_VOICE_QA_VOICE_STT_PROVIDER_ID:
          triageGithubVoice.voice.sttProviderId,
        HAPPIER_E2E_TRIAGE_GITHUB_VOICE_QA_VOICE_MICROPHONE_FIXTURE_PATH:
          triageGithubVoice.voice.microphoneFixturePath,
      },
    );
    if (exitCode !== 0) return exitCode;
  }
  let exitCode = await runRequiredFlow(
    'suites/mobile-e2e/flows/plugin-platform-candidate/online-install-and-inspector.yaml',
  );
  if (exitCode !== 0) return exitCode;

  await installWithPresentUserReview(input.updateArchivePath);
  if (input.targeted) {
    await installWithPresentUserReview(input.targeted.contributorV2ArchivePath);
  }
  exitCode = await runRequiredFlow(
    'suites/mobile-e2e/flows/plugin-platform-candidate/updated-cache-replacement.yaml',
  );
  if (exitCode !== 0) return exitCode;

  await input.stopDaemon();
  try {
    exitCode = await runRequiredFlow(
      'suites/mobile-e2e/flows/plugin-platform-candidate/offline-read-only.yaml',
    );
  } finally {
    await input.startDaemon();
  }
  if (exitCode !== 0) return exitCode;

  exitCode = await runRequiredFlow(
    'suites/mobile-e2e/flows/plugin-platform-candidate/reconnected.yaml',
  );
  if (exitCode !== 0) return exitCode;

  if (input.targeted) {
    await input.runCli([
      'plugins',
      'disable',
      input.targeted.contributorPluginId,
      '--json',
    ]);
    exitCode = await runRequiredFlow(
      'suites/mobile-e2e/flows/plugin-platform-candidate/trust-revoked.yaml',
    );
    if (exitCode !== 0) return exitCode;

    await input.runCli([
      'plugins',
      'enable',
      input.targeted.contributorPluginId,
      '--json',
    ]);
    exitCode = await runRequiredFlow(
      'suites/mobile-e2e/flows/plugin-platform-candidate/reconnected.yaml',
    );
    if (exitCode !== 0) return exitCode;

    if (!input.requestPluginChange) {
      throw new Error('Targeted Plugin Platform QA requires the canonical daemon plugin-change owner');
    }
    const change = await input.requestPluginChange({
      kind: 'forgetTrust',
      pluginId: input.targeted.contributorPluginId,
    });
    if (
      !change
      || typeof change !== 'object'
      || Array.isArray(change)
      || (change as { kind?: unknown }).kind !== 'committed'
      || (change as { pluginId?: unknown }).pluginId !== input.targeted.contributorPluginId
    ) {
      throw new Error(`Targeted plugin trust revocation did not commit: ${JSON.stringify(change)}`);
    }
    exitCode = await runRequiredFlow(
      'suites/mobile-e2e/flows/plugin-platform-candidate/trust-revoked.yaml',
    );
    if (exitCode !== 0) return exitCode;

    await installWithPresentUserReview(input.targeted.contributorV2ArchivePath);
    exitCode = await runRequiredFlow(
      'suites/mobile-e2e/flows/plugin-platform-candidate/reconnected.yaml',
    );
    if (exitCode !== 0) return exitCode;

    await input.runCli([
      'plugins',
      'uninstall',
      input.targeted.contributorPluginId,
      '--json',
    ]);
    exitCode = await runRequiredFlow(
      'suites/mobile-e2e/flows/plugin-platform-candidate/trust-revoked.yaml',
    );
    if (exitCode !== 0) return exitCode;
  }

  await input.runCli(['plugins', 'rollback', input.pluginId, '--json']);
  exitCode = await runRequiredFlow(
    'suites/mobile-e2e/flows/plugin-platform-candidate/rolled-back.yaml',
  );
  if (exitCode !== 0) return exitCode;

  await input.runCli(['plugins', 'uninstall', input.pluginId, '--json']);
  return await runRequiredFlow(
    'suites/mobile-e2e/flows/plugin-platform-candidate/uninstalled.yaml',
  );
}
