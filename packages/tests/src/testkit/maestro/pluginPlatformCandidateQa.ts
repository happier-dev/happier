import { mkdir, readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import {
  assertPackedAuthorCandidateManifestArtifacts,
  assertPackedCliEntrypoint,
  assertPackedNovelConnectedAccountQaCandidate,
  assertPackedPackageIdentity,
  loadPackedNovelConnectedAccountQaHandoff,
  materializePackedCli,
  parseCandidateManifest,
  readPackedPackageManifest,
  sha512Sri,
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

export const G5_GENERATED_INPUTS_AUTHORIZATION = 'G5_GENERATED_INPUTS_GREEN' as const;

export type InspectorNativeArtifactIdentity =
  PackedInspectorArtifactAttestation['platforms']['ios'];

type CandidateQaDeps = Readonly<{
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
  readPackedPackageManifest,
  materializePackedCli,
  attestPackedInspectorArtifacts,
};

export type PreparedPluginPlatformCandidateQa = Readonly<{
  candidate: PackedAuthorCandidate;
  cliEntrypoint: string;
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
  });
}

async function verifyCandidateArtifact(
  artifact: PackedAuthorCandidate['sdk'] | PackedAuthorCandidate['cli'],
  label: string,
): Promise<void> {
  const actualIntegrity = sha512Sri(await readFile(artifact.tarballPath));
  if (actualIntegrity !== artifact.integrity) {
    throw new Error(
      `${label} tarball integrity mismatch: expected ${artifact.integrity}, received ${actualIntegrity}`,
    );
  }
}

async function prepareVerifiedPluginPlatformCandidateQa(input: Readonly<{
  candidate: PackedAuthorCandidate;
  workDir: string;
  deps?: Partial<CandidateQaDeps>;
}>): Promise<PreparedPluginPlatformCandidateQa> {
  const candidate = input.candidate;
  await Promise.all([
    verifyCandidateArtifact(candidate.sdk, 'SDK'),
    verifyCandidateArtifact(candidate.cli, 'CLI'),
  ]);

  const deps = { ...defaultDeps, ...(input.deps ?? {}) };
  await mkdir(input.workDir, { recursive: true });
  const [sdkPackageManifest, cliPackageManifest] = await Promise.all([
    deps.readPackedPackageManifest(
      candidate.sdk.tarballPath,
      join(input.workDir, 'sdk-artifact'),
    ),
    deps.readPackedPackageManifest(
      candidate.cli.tarballPath,
      join(input.workDir, 'cli-artifact'),
    ),
  ]);
  assertPackedPackageIdentity(sdkPackageManifest, candidate.sdk, 'Packed SDK');
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
  return Object.freeze({ candidate, cliEntrypoint, inspectorArtifacts });
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
  const candidate = parseCandidateManifest(
    await readFile(candidateManifestPath, 'utf8'),
    candidateManifestPath,
  );
  await assertPackedAuthorCandidateManifestArtifacts(candidate, {
    manifestPath: candidateManifestPath,
  });
  return await prepareVerifiedPluginPlatformCandidateQa({
    candidate,
    workDir: input.workDir,
    deps: input.deps,
  });
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
  runFlow: (flowPath: string) => Promise<{ exitCode: number }>;
  runCli: (args: readonly string[]) => Promise<string>;
  decideInstallReview: (input: Readonly<{
    pendingChangeId: string;
    review: PluginInstallationReviewFacts;
  }>) => Promise<void>;
  stopDaemon: () => Promise<void>;
  startDaemon: () => Promise<void>;
}>): Promise<number> {
  const runRequiredFlow = async (flowPath: string): Promise<number> => {
    const result = await input.runFlow(flowPath);
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
  let exitCode = await runRequiredFlow(
    'suites/mobile-e2e/flows/plugin-platform-candidate/online-install-and-inspector.yaml',
  );
  if (exitCode !== 0) return exitCode;

  await installWithPresentUserReview(input.updateArchivePath);
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
