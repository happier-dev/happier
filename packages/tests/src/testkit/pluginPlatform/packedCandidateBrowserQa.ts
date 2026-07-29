import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import {
  computePluginUiArtifactFileSetSha256DigestV1,
  PluginUiArtifactsManifestV1Schema,
} from '@happier-dev/protocol/plugins/ui';

import type { CliTestLaunchSpec } from '../process/cliLaunchSpec';
import type {
  PackedAuthorCandidate,
  PackedNovelConnectedAccountQaHandoff,
} from '../../../scripts/plugin-platform/run-packed-author-ui-compat.mjs';

export type PackedCandidateBrowserQaAttestation = Readonly<{
  runId: string;
  sdkPackageName: '@happier-dev/plugin-sdk';
  sdkVersion: string;
  sdkIntegrity: string;
  cliPackageName: '@happier-dev/cli';
  cliVersion: string;
  cliIntegrity: string;
  cliEntrypoint: string;
  inspectorContributionId: 'inspector-app-native';
  inspectorWebArtifactDigest: string;
  inspectorIosArtifactDigest: string;
  inspectorAndroidArtifactDigest: string;
  inspectorRepackContainerName: 'happier_inspector_inspector_app_native';
  inspectorRepackModulePath: './renderSurface';
  inspectorRepackExportName: 'renderSurface';
  inspectorPlatforms: PackedInspectorArtifactAttestation['platforms'];
}>;

export type PreparedPackedCandidateBrowserQa = Readonly<{
  candidate: PackedAuthorCandidate;
  cliLaunchSpec: CliTestLaunchSpec;
  attestation: PackedCandidateBrowserQaAttestation;
}>;

type PackedNovelConnectedAccountQaConsumerHandoff = Readonly<{
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

type PackedNovelConnectedAccountQaConsumerDeps = Readonly<{
  loadHandoff: (
    input: Readonly<{ manifestPath: string }>,
  ) => Promise<PackedNovelConnectedAccountQaConsumerHandoff>;
  assertCandidate: (input: Readonly<{
    handoff: PackedNovelConnectedAccountQaConsumerHandoff;
    candidate: PackedAuthorCandidate;
  }>) => void;
  startAuthorizationServer: () => Promise<
    PackedNovelConnectedAccountAuthorizationServer
  >;
}>;

type PackedNovelConnectedAccountAuthorizationServer = Readonly<{
  origin: string;
  caCertificatePath: string;
  callbackUrl: string;
  getRequestSummary: () => Readonly<{
    authorizationRedirects: number;
    rejectedRequests: number;
  }>;
  close: () => Promise<void>;
}>;

export type PreparedPackedNovelConnectedAccountBrowserQa = Readonly<{
  pluginArchivePath: string;
  service: PackedNovelConnectedAccountQaConsumerHandoff['plugin']['service'];
  authenticationModeIds:
    PackedNovelConnectedAccountQaConsumerHandoff['plugin']['authenticationModeIds'];
  isolation:
    PackedNovelConnectedAccountQaConsumerHandoff['consumers']['browser'];
  oauth: PackedNovelConnectedAccountQaConsumerHandoff['oauth'];
  authorization: PackedNovelConnectedAccountAuthorizationServer;
  authorizationOriginConfiguration: Readonly<{
    'authorization-origin': string;
  }>;
}>;

type PackedCandidateBrowserQaDeps = Readonly<{
  readFile: (path: string) => Promise<Uint8Array>;
  parseCandidateManifest: (raw: string, manifestPath: string) => PackedAuthorCandidate;
  assertCandidateManifestArtifacts: (
    candidate: PackedAuthorCandidate,
    options: Readonly<{ manifestPath: string }>,
  ) => Promise<void>;
  readPackedPackageManifest: (
    tarballPath: string,
    extractionRoot: string,
  ) => Promise<Record<string, unknown>>;
  assertPackedPackageIdentity: (
    packageManifest: unknown,
    artifact: PackedAuthorCandidate['sdk'] | PackedAuthorCandidate['cli'],
    label: string,
  ) => void;
  assertPackedCliEntrypoint: (
    packageManifest: unknown,
    artifact: PackedAuthorCandidate['cli'],
  ) => void;
  materializePackedCli: (params: Readonly<{
    cliArtifact: PackedAuthorCandidate['cli'];
    installRoot: string;
  }>) => Promise<string>;
  attestPackedInspectorArtifacts: typeof attestPackedInspectorArtifacts;
}>;

async function loadDefaultDeps(): Promise<PackedCandidateBrowserQaDeps> {
  // Keep Playwright discovery isolated from the large Vertical A runner's
  // transitive CLI imports. The canonical parser/materializer is loaded only
  // after an explicit candidate manifest opts into candidate QA.
  const candidateRunnerUrl = new URL(
    [
      '..',
      '..',
      '..',
      'scripts',
      'plugin-platform',
      'run-packed-author-ui-compat.mjs',
    ].join('/'),
    import.meta.url,
  ).href;
  const candidateModule = await import(candidateRunnerUrl);
  return {
    readFile,
    parseCandidateManifest: candidateModule.parseCandidateManifest,
    assertCandidateManifestArtifacts:
      candidateModule.assertPackedAuthorCandidateManifestArtifacts,
    readPackedPackageManifest: candidateModule.readPackedPackageManifest,
    assertPackedPackageIdentity: candidateModule.assertPackedPackageIdentity,
    assertPackedCliEntrypoint: candidateModule.assertPackedCliEntrypoint,
    materializePackedCli: candidateModule.materializePackedCli,
    attestPackedInspectorArtifacts,
  };
}

async function loadPackedNovelConnectedAccountQaConsumerDeps():
Promise<PackedNovelConnectedAccountQaConsumerDeps> {
  const candidateModule = await import(
    '../../../scripts/plugin-platform/run-packed-author-ui-compat.mjs'
  );
  return {
    loadHandoff:
      candidateModule.loadPackedNovelConnectedAccountQaHandoff,
    assertCandidate: ({ handoff, candidate }) => {
      candidateModule.assertPackedNovelConnectedAccountQaCandidate({
        handoff: handoff as PackedNovelConnectedAccountQaHandoff,
        candidate,
      });
    },
    startAuthorizationServer:
      candidateModule.startPackedNovelConnectedAccountAuthorizationServer,
  };
}

export async function preparePackedNovelConnectedAccountBrowserQa(
  input: Readonly<{
    candidate: PackedAuthorCandidate;
    handoffManifestPath: string;
    deps?: PackedNovelConnectedAccountQaConsumerDeps;
  }>,
): Promise<PreparedPackedNovelConnectedAccountBrowserQa> {
  const deps =
    input.deps ?? await loadPackedNovelConnectedAccountQaConsumerDeps();
  const handoff = await deps.loadHandoff({
    manifestPath: input.handoffManifestPath,
  });
  deps.assertCandidate({
    handoff,
    candidate: input.candidate,
  });
  const authorization = await deps.startAuthorizationServer();
  if (authorization.callbackUrl !== handoff.oauth.callbackUrl) {
    await authorization.close();
    throw new Error(
      'packed_novel_browser_authorization_callback_mismatch',
    );
  }
  return Object.freeze({
    pluginArchivePath: handoff.plugin.archivePath,
    service: handoff.plugin.service,
    authenticationModeIds: handoff.plugin.authenticationModeIds,
    isolation: handoff.consumers.browser,
    oauth: handoff.oauth,
    authorization,
    authorizationOriginConfiguration: Object.freeze({
      'authorization-origin': authorization.origin,
    }),
  });
}

type PackedInspectorArtifactIdentity = Readonly<{
  artifactDigest: string;
  builtWith: Readonly<{
    bundler: 'vite' | 'repack';
    version: string;
  }>;
  hostUiApiVersion: string;
  compat: Readonly<{
    react: string;
    reactNative: string;
    expoRuntime?: string;
    hermes?: string;
  }>;
}>;

export type PackedInspectorArtifactAttestation = Readonly<{
  contributionId: 'inspector-app-native';
  webArtifactDigest: string;
  iosArtifactDigest: string;
  androidArtifactDigest: string;
  repackContainerName: 'happier_inspector_inspector_app_native';
  repackModulePath: './renderSurface';
  repackExportName: 'renderSurface';
  platforms: Readonly<{
    web: PackedInspectorArtifactIdentity;
    ios: PackedInspectorArtifactIdentity;
    android: PackedInspectorArtifactIdentity;
  }>;
}>;

export type CandidateInspectorRuntimeAttestation = Readonly<{
  cliVersion: string;
  projectionGeneration: number;
  inspectorWebArtifactDigest: string;
  inspectorRuntimeState: 'loadable';
  inspectorRuntimeDecision: 'load';
  inspectorSurfaceAvailable: true;
}>;

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function recordAt(value: unknown, path: readonly string[]): Readonly<Record<string, unknown>> | null {
  let current = asRecord(value);
  for (const key of path) {
    current = asRecord(current?.[key]);
    if (!current) return null;
  }
  return current;
}

export function attestCandidateInspectorRuntime(params: Readonly<{
  expectedCliVersion: string;
  expectedInspectorWebArtifactDigest: string;
  daemonState: unknown;
  projectionResponse: unknown;
}>): CandidateInspectorRuntimeAttestation {
  const daemonState = asRecord(params.daemonState);
  if (daemonState?.startedWithCliVersion !== params.expectedCliVersion) {
    throw new Error('packed_candidate_daemon_cli_version_mismatch');
  }
  const projection = recordAt(params.projectionResponse, ['projection']);
  const generation = projection?.generation;
  if (typeof generation !== 'number' || !Number.isInteger(generation) || generation < 0) {
    throw new Error('packed_candidate_plugin_ui_projection_generation_missing');
  }
  const entries = recordAt(projection, ['familiesById', 'pluginUi', 'entriesById']);
  const bundle = asRecord(entries?.['reactNativeBundle:happier.inspector:inspector-renderer']);
  const artifactGraph = recordAt(bundle, ['artifactGraph']);
  const runtime = recordAt(bundle, ['runtime']);
  const decision = recordAt(runtime, ['decision']);
  const cacheIdentity = recordAt(runtime, ['cacheIdentity']);
  const loadPolicy = recordAt(runtime, ['loadPolicy']);
  if (
    artifactGraph?.contributionId !== 'inspector-app-native'
    || artifactGraph.platform !== 'web'
  ) {
    throw new Error('packed_candidate_inspector_runtime_graph_missing');
  }
  if (
    artifactGraph.digest !== params.expectedInspectorWebArtifactDigest
    || cacheIdentity?.artifactDigest !== params.expectedInspectorWebArtifactDigest
  ) {
    throw new Error('packed_candidate_inspector_runtime_digest_mismatch');
  }
  if (
    runtime?.state !== 'loadable'
    || decision?.state !== 'load'
    || loadPolicy?.source !== 'installedArtifact'
    || cacheIdentity?.projectionGeneration !== generation
  ) {
    throw new Error('packed_candidate_inspector_runtime_not_loadable');
  }
  const surface = asRecord(entries?.['surfacePlacement:happier.inspector:inspector-app']);
  const renderer = recordAt(surface, ['renderer']);
  const availability = recordAt(surface, ['availability']);
  if (
    surface?.placement !== 'app.rightSidebarTab'
    || renderer?.kind !== 'reactNative'
    || renderer.contributionId !== 'inspector-renderer'
    || availability?.state !== 'available'
  ) {
    throw new Error('packed_candidate_inspector_surface_unavailable');
  }

  return Object.freeze({
    cliVersion: params.expectedCliVersion,
    projectionGeneration: generation,
    inspectorWebArtifactDigest: params.expectedInspectorWebArtifactDigest,
    inspectorRuntimeState: 'loadable',
    inspectorRuntimeDecision: 'load',
    inspectorSurfaceAvailable: true,
  });
}

const INSPECTOR_PACKAGE_RELATIVE_ROOT = join(
  'node_modules',
  '@happier-dev',
  'plugins-inspector',
  'dist',
  'happier-plugin-ui',
);

export async function attestPackedInspectorArtifacts(
  input: Readonly<{ cliEntrypoint: string }>,
  deps: Readonly<{ readFile: (path: string) => Promise<Uint8Array> }> = { readFile },
): Promise<PackedInspectorArtifactAttestation> {
  const cliPackageRoot = resolve(dirname(input.cliEntrypoint), '..');
  const artifactRoot = join(cliPackageRoot, INSPECTOR_PACKAGE_RELATIVE_ROOT);
  const rawGraph = await deps.readFile(join(artifactRoot, 'ui-artifacts.json'));
  const graph = PluginUiArtifactsManifestV1Schema.parse(
    JSON.parse(Buffer.from(rawGraph).toString('utf8')),
  );
  const entries = graph.entries.filter(
    (entry) => entry.contributionId === 'inspector-app-native'
      && entry.tier === 'reactNative',
  );
  if (
    entries.length !== 3
    || !entries.some((entry) => entry.platform === 'web')
    || !entries.some((entry) => entry.platform === 'ios')
    || !entries.some((entry) => entry.platform === 'android')
  ) {
    throw new Error('packed_candidate_inspector_platform_graph_incomplete');
  }

  for (const entry of entries) {
    if (!entry.files.some((file) => file.relativePath === entry.entry)) {
      throw new Error(`packed_candidate_inspector_entry_file_missing:${entry.platform}`);
    }
    const verifiedFiles: Array<Readonly<{ relativePath: string; bytes: Uint8Array }>> = [];
    for (const file of entry.files) {
      const bytes = await deps.readFile(join(artifactRoot, file.relativePath));
      const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
      if (digest !== file.digest) {
        throw new Error(
          `packed_candidate_inspector_file_digest_mismatch:${entry.platform}:${file.relativePath}`,
        );
      }
      if (bytes.byteLength !== file.byteSize) {
        throw new Error(
          `packed_candidate_inspector_file_size_mismatch:${entry.platform}:${file.relativePath}`,
        );
      }
      verifiedFiles.push({ relativePath: file.relativePath, bytes });
    }
    if (computePluginUiArtifactFileSetSha256DigestV1(verifiedFiles) !== entry.digest) {
      throw new Error(`packed_candidate_inspector_graph_digest_mismatch:${entry.platform}`);
    }
  }

  const web = entries.find((entry) => entry.platform === 'web');
  const ios = entries.find((entry) => entry.platform === 'ios');
  const android = entries.find((entry) => entry.platform === 'android');
  if (!web || !ios || !android) {
    throw new Error('packed_candidate_inspector_platform_graph_incomplete');
  }
  if (
    !web.compat.reactNative
    || !ios.compat.reactNative
    || !android.compat.reactNative
  ) {
    throw new Error('packed_candidate_inspector_react_native_compat_missing');
  }
  const expectedRepack = {
    containerName: 'happier_inspector_inspector_app_native',
    modulePath: './renderSurface',
    exportName: 'renderSurface',
  } as const;
  for (const entry of [ios, android]) {
    if (
      entry.repack?.containerName !== expectedRepack.containerName
      || entry.repack.modulePath !== expectedRepack.modulePath
      || entry.repack.exportName !== expectedRepack.exportName
    ) {
      throw new Error(`packed_candidate_inspector_repack_identity_mismatch:${entry.platform}`);
    }
  }

  return Object.freeze({
    contributionId: 'inspector-app-native',
    webArtifactDigest: web.digest,
    iosArtifactDigest: ios.digest,
    androidArtifactDigest: android.digest,
    repackContainerName: expectedRepack.containerName,
    repackModulePath: expectedRepack.modulePath,
    repackExportName: expectedRepack.exportName,
    platforms: Object.freeze({
      web: Object.freeze({
        artifactDigest: web.digest,
        builtWith: Object.freeze({ ...web.builtWith }),
        hostUiApiVersion: web.hostUiApiVersion,
        compat: Object.freeze({
          ...web.compat,
          reactNative: web.compat.reactNative,
        }),
      }),
      ios: Object.freeze({
        artifactDigest: ios.digest,
        builtWith: Object.freeze({ ...ios.builtWith }),
        hostUiApiVersion: ios.hostUiApiVersion,
        compat: Object.freeze({
          ...ios.compat,
          reactNative: ios.compat.reactNative,
        }),
      }),
      android: Object.freeze({
        artifactDigest: android.digest,
        builtWith: Object.freeze({ ...android.builtWith }),
        hostUiApiVersion: android.hostUiApiVersion,
        compat: Object.freeze({
          ...android.compat,
          reactNative: android.compat.reactNative,
        }),
      }),
    }),
  });
}

export function resolvePackedCandidateBrowserQaBeforeAllTimeoutMs(params: Readonly<{
  candidateManifestPath: string | null;
  uiBeforeAllTimeoutMs: number;
}>): number {
  return params.candidateManifestPath
    ? Math.max(params.uiBeforeAllTimeoutMs, 900_000)
    : params.uiBeforeAllTimeoutMs;
}

export function requirePackedCandidateManifestPath(
  env: NodeJS.ProcessEnv,
): string {
  const path = env.HAPPIER_PLUGIN_PLATFORM_CANDIDATE_MANIFEST?.trim();
  if (!path) {
    throw new Error('packed_candidate_browser_qa_manifest_required');
  }
  return resolve(path);
}

export function resolvePackedCandidateBrowserQaMaterializationRoot(params: Readonly<{
  env: NodeJS.ProcessEnv;
  defaultRoot: string;
}>): string {
  const explicitRoot =
    params.env.HAPPIER_E2E_PACKED_CANDIDATE_CLI_MATERIALIZATION_ROOT?.trim();
  return resolve(explicitRoot || params.defaultRoot);
}

function assertCandidateArtifactIntegrity(
  label: 'sdk' | 'cli',
  bytes: Uint8Array,
  expectedIntegrity: string,
): void {
  const actualIntegrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  if (actualIntegrity !== expectedIntegrity) {
    throw new Error(`packed_candidate_${label}_integrity_mismatch`);
  }
}

export async function preparePackedCandidateBrowserQa(params: Readonly<{
  candidateManifestPath: string;
  materializationRoot: string;
  deps?: PackedCandidateBrowserQaDeps;
}>): Promise<PreparedPackedCandidateBrowserQa> {
  const deps = params.deps ?? await loadDefaultDeps();
  const manifestBytes = await deps.readFile(params.candidateManifestPath);
  const candidate = deps.parseCandidateManifest(
    Buffer.from(manifestBytes).toString('utf8'),
    params.candidateManifestPath,
  );
  await deps.assertCandidateManifestArtifacts(candidate, {
    manifestPath: params.candidateManifestPath,
  });
  const [sdkBytes, cliBytes] = await Promise.all([
    deps.readFile(candidate.sdk.tarballPath),
    deps.readFile(candidate.cli.tarballPath),
  ]);

  assertCandidateArtifactIntegrity('sdk', sdkBytes, candidate.sdk.integrity);
  assertCandidateArtifactIntegrity('cli', cliBytes, candidate.cli.integrity);

  const [sdkPackageManifest, cliPackageManifest] = await Promise.all([
    deps.readPackedPackageManifest(
      candidate.sdk.tarballPath,
      join(params.materializationRoot, 'verify-sdk'),
    ),
    deps.readPackedPackageManifest(
      candidate.cli.tarballPath,
      join(params.materializationRoot, 'verify-cli'),
    ),
  ]);
  deps.assertPackedPackageIdentity(sdkPackageManifest, candidate.sdk, 'Packed SDK');
  deps.assertPackedPackageIdentity(cliPackageManifest, candidate.cli, 'Packed CLI');
  deps.assertPackedCliEntrypoint(cliPackageManifest, candidate.cli);

  const cliEntrypoint = await deps.materializePackedCli({
    cliArtifact: candidate.cli,
    installRoot: params.materializationRoot,
  });
  const inspector = await deps.attestPackedInspectorArtifacts({ cliEntrypoint });
  const cliLaunchSpec: CliTestLaunchSpec = Object.freeze({
    command: process.execPath,
    args: [cliEntrypoint],
    cwd: params.materializationRoot,
  });

  return Object.freeze({
    candidate,
    cliLaunchSpec,
    attestation: Object.freeze({
      runId: candidate.runId,
      sdkPackageName: candidate.sdk.packageName,
      sdkVersion: candidate.sdk.version,
      sdkIntegrity: candidate.sdk.integrity,
      cliPackageName: candidate.cli.packageName,
      cliVersion: candidate.cli.version,
      cliIntegrity: candidate.cli.integrity,
      cliEntrypoint,
      inspectorContributionId: inspector.contributionId,
      inspectorWebArtifactDigest: inspector.webArtifactDigest,
      inspectorIosArtifactDigest: inspector.iosArtifactDigest,
      inspectorAndroidArtifactDigest: inspector.androidArtifactDigest,
      inspectorRepackContainerName: inspector.repackContainerName,
      inspectorRepackModulePath: inspector.repackModulePath,
      inspectorRepackExportName: inspector.repackExportName,
      inspectorPlatforms: inspector.platforms,
    }),
  });
}
