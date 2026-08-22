import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import type { Page, Response } from '@playwright/test';

import {
  computePluginUiArtifactFileSetSha256DigestV1,
  PluginUiArtifactsManifestV1Schema,
} from '@happier-dev/protocol/plugins/ui';

import type { CliTestLaunchSpec } from '../process/cliLaunchSpec';
import type {
  PackedAuthorCandidate,
  PackedAuthorDirectArtifactsSmoke,
  PackedNovelConnectedAccountQaHandoff,
} from '../../../scripts/plugin-platform/run-packed-author-ui-compat.mjs';
import { selectPrimaryAppScriptUrl } from '../process/uiWebHtml';

export type PackedUcxWebQaArtifactBasis =
  | 'candidate_manifest'
  | 'row_local_natural';

export type PackedUcxWebQaAttestation = Readonly<{
  artifactBasis: PackedUcxWebQaArtifactBasis;
  artifactRunId: string | null;
  sdkPackageName: '@happier-dev/plugin-sdk';
  sdkVersion: string;
  sdkIntegrity: string;
  pluginUiPackageName: '@happier-dev/plugin-ui';
  pluginUiVersion: string;
  pluginUiSdkVersion: string;
  pluginUiIntegrity: string;
  cliPackageName: '@happier-dev/cli';
  cliVersion: string;
  cliIntegrity: string;
  cliEntrypoint: string;
}>;

export type PackedCandidateBrowserQaAttestation =
  PackedUcxWebQaAttestation & Readonly<{
  artifactBasis: 'candidate_manifest';
  artifactRunId: string;
  runId: string;
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
  cleanup: () => Promise<void>;
  attestation: PackedCandidateBrowserQaAttestation;
}>;

export type PreparedPackedUcxWebQa = Readonly<{
  candidate: PackedAuthorDirectArtifactsSmoke;
  cliLaunchSpec: CliTestLaunchSpec;
  cleanup: () => Promise<void>;
  attestation: PackedUcxWebQaAttestation;
}>;

export type LoadedBrowserModuleAttestation = Readonly<{
  digest: string;
  scriptPaths: readonly string[];
  primaryBundleUrl: string;
  moduleProbes: readonly Readonly<{
    url: string;
    path: string;
    sha256: string;
  }>[];
}>;

export type ObservedLoadedBrowserModuleResponses = ReadonlyMap<string, Uint8Array>;

export type LoadedBrowserModuleResponseObserver = Readonly<{
  observedResponses: () => Promise<ObservedLoadedBrowserModuleResponses>;
  dispose: () => void;
}>;

export type PackedCandidateBrowserUcxContributorAttestation = Readonly<{
  v1: Readonly<{
    archiveSha256: string;
    appliedGeneration: string;
  }>;
  v2: Readonly<{
    archiveSha256: string;
    appliedGeneration: string;
  }>;
}>;

export type PackedCandidateBrowserQaCompletion = Readonly<{
  normalTriageLocalAgentJourneyCompleted: boolean;
  contributorDisabledAndRetired: boolean;
  contributorTrustRevokedAndReinstalled: boolean;
  contributorUninstalledAndRetired: boolean;
}>;

function requireNonEmptyAttestationValue(value: string, label: string): string {
  if (!value.trim()) throw new Error(`Packed candidate browser attestation omitted ${label}`);
  return value;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength
    && left.every((value, index) => value === right[index]);
}

/**
 * Captures response bytes actually delivered for scripts in every main-frame
 * document in one packed browser QA row. A URL must remain byte-identical
 * throughout that row, so a mutable response cannot be mistaken for the
 * bundle that earlier lifecycle checks executed.
 */
export function observeLoadedBrowserModuleResponses(
  page: Pick<Page, 'mainFrame' | 'on' | 'off'>,
): LoadedBrowserModuleResponseObserver {
  const observedResponses = new Map<string, Uint8Array>();
  let conflictingResponseUrl: string | null = null;
  let unavailableResponseUrl: string | null = null;
  const pendingCaptures = new Set<Promise<void>>();

  const onResponse = (response: Response) => {
    if (
      response.frame() !== page.mainFrame()
      || response.request().resourceType() !== 'script'
      || !response.ok()
    ) {
      return;
    }
    const responseUrl = response.url();
    const capture = response.body()
      .then((body) => {
        const bytes = Uint8Array.from(body);
        const existingBytes = observedResponses.get(responseUrl);
        if (existingBytes && !sameBytes(existingBytes, bytes)) {
          conflictingResponseUrl = responseUrl;
          return;
        }
        observedResponses.set(responseUrl, bytes);
      })
      .catch(() => {
        unavailableResponseUrl ??= responseUrl;
      })
      .finally(() => {
        pendingCaptures.delete(capture);
      });
    pendingCaptures.add(capture);
  };

  page.on('response', onResponse);

  return Object.freeze({
    observedResponses: async () => {
      while (pendingCaptures.size > 0) {
        await Promise.all([...pendingCaptures]);
      }
      if (conflictingResponseUrl !== null) {
        throw new Error(
          `Packed candidate browser observed conflicting script responses for the loaded QA row: ${conflictingResponseUrl}`,
        );
      }
      if (unavailableResponseUrl !== null) {
        throw new Error(
          `Packed candidate browser could not capture script response bytes for the loaded QA row: ${unavailableResponseUrl}`,
        );
      }
      return new Map(observedResponses);
    },
    dispose: () => {
      page.off('response', onResponse);
    },
  });
}

/**
 * Attests scripts in the real browser document against bytes captured from the
 * document's own response stream.
 */
export async function attestLoadedBrowserModules(
  page: Pick<Page, 'locator'>,
  observedResponses: ObservedLoadedBrowserModuleResponses,
): Promise<LoadedBrowserModuleAttestation> {
  const scriptUrls = await page.locator('script[src]').evaluateAll((scripts) => (
    Array.from(new Set(scripts
      .map((script) => (script as HTMLScriptElement).src)
      .filter((src) => src.startsWith('http://') || src.startsWith('https://'))))
      .sort()
  ));
  if (scriptUrls.length === 0) {
    throw new Error('Packed candidate browser runtime did not expose a loaded script');
  }
  const primaryBundleUrl = selectPrimaryAppScriptUrl(scriptUrls);
  if (!primaryBundleUrl) {
    throw new Error('Packed candidate browser runtime did not expose a loaded primary script');
  }
  const digest = createHash('sha256');
  const scriptPaths: string[] = [];
  const moduleProbes: Array<Readonly<{
    url: string;
    path: string;
    sha256: string;
  }>> = [];
  for (const scriptUrl of scriptUrls) {
    const bytes = observedResponses.get(scriptUrl);
    if (!bytes) {
      throw new Error(
        `Packed candidate browser did not observe response bytes for loaded script: ${scriptUrl}`,
      );
    }
    const path = new URL(scriptUrl).pathname;
    const sha256 = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    scriptPaths.push(path);
    moduleProbes.push(Object.freeze({ url: scriptUrl, path, sha256 }));
    digest.update(`${path}\0${bytes.byteLength}\0`);
    digest.update(bytes);
    digest.update('\0');
  }
  return Object.freeze({
    digest: `sha256:${digest.digest('hex')}`,
    scriptPaths: Object.freeze(scriptPaths),
    primaryBundleUrl,
    moduleProbes: Object.freeze(moduleProbes),
  });
}

export function buildPackedCandidateBrowserQaRunOutcome(input: Readonly<{
  attestation: PackedUcxWebQaAttestation;
  loadedModules: LoadedBrowserModuleAttestation;
  normalTriageLocalAgentJourneyLoadedModules: LoadedBrowserModuleAttestation | null;
  ucxContributor: PackedCandidateBrowserUcxContributorAttestation;
  completion: PackedCandidateBrowserQaCompletion;
}>): Readonly<Record<string, boolean | number | string | null>> {
  if (input.loadedModules.scriptPaths.length === 0) {
    throw new Error('Packed candidate browser attestation omitted loaded script paths');
  }
  if (input.ucxContributor.v1.archiveSha256 === input.ucxContributor.v2.archiveSha256) {
    throw new Error('UCX contributor v1 and v2 archive identities must differ');
  }
  if (
    input.completion.normalTriageLocalAgentJourneyCompleted !== true
    || input.completion.contributorDisabledAndRetired !== true
    || input.completion.contributorTrustRevokedAndReinstalled !== true
    || input.completion.contributorUninstalledAndRetired !== true
  ) {
    throw new Error('packed_candidate_browser_qa_terminal_completion_incomplete');
  }
  const normalTriageLocalAgentJourneyLoadedModules =
    input.normalTriageLocalAgentJourneyLoadedModules;
  if (normalTriageLocalAgentJourneyLoadedModules === null) {
    throw new Error('packed_candidate_browser_qa_normal_triage_loaded_identity_missing');
  }
  if (normalTriageLocalAgentJourneyLoadedModules.scriptPaths.length === 0) {
    throw new Error('Packed candidate browser normal Triage attestation omitted loaded script paths');
  }
  if (
    !normalTriageLocalAgentJourneyLoadedModules.primaryBundleUrl
    || !normalTriageLocalAgentJourneyLoadedModules.moduleProbes.some(
      (probe) => probe.url === normalTriageLocalAgentJourneyLoadedModules.primaryBundleUrl,
    )
  ) {
    throw new Error('Packed candidate browser normal Triage attestation omitted loaded primary bundle identity');
  }
  if (
    !input.loadedModules.primaryBundleUrl
    || !input.loadedModules.moduleProbes.some(
      (probe) => probe.url === input.loadedModules.primaryBundleUrl,
    )
  ) {
    throw new Error('Packed candidate browser attestation omitted loaded primary bundle identity');
  }
  const outcome: Record<string, boolean | number | string | null> = {
    proofVersion: 1,
    loadedHostPlatform: 'web',
    loadedHostRuntime: 'metro',
    loadedModuleSha256: requireNonEmptyAttestationValue(
      input.loadedModules.digest,
      'loaded module digest',
    ),
    loadedModulePathsJson: JSON.stringify(input.loadedModules.scriptPaths),
    loadedWebBundleUrl: input.loadedModules.primaryBundleUrl,
    loadedWebBundleRevision: requireNonEmptyAttestationValue(
      input.loadedModules.digest,
      'loaded web bundle revision',
    ),
    loadedWebModuleProbeJson: JSON.stringify(input.loadedModules.moduleProbes),
    packageArtifactBasis: input.attestation.artifactBasis,
    packageArtifactRunId: input.attestation.artifactRunId,
    packageSdkPackageName: input.attestation.sdkPackageName,
    packageSdkVersion: input.attestation.sdkVersion,
    packageSdkIntegrity: input.attestation.sdkIntegrity,
    packagePluginUiPackageName: input.attestation.pluginUiPackageName,
    packagePluginUiVersion: input.attestation.pluginUiVersion,
    packagePluginUiSdkVersion: input.attestation.pluginUiSdkVersion,
    packagePluginUiIntegrity: input.attestation.pluginUiIntegrity,
    packageCliPackageName: input.attestation.cliPackageName,
    packageCliVersion: input.attestation.cliVersion,
    packageCliIntegrity: input.attestation.cliIntegrity,
    candidateRunId: null,
    ucxContributorV1ArchiveSha256: requireNonEmptyAttestationValue(
      input.ucxContributor.v1.archiveSha256,
      'UCX contributor v1 archive digest',
    ),
    ucxContributorV1AppliedGeneration: requireNonEmptyAttestationValue(
      input.ucxContributor.v1.appliedGeneration,
      'UCX contributor v1 applied generation',
    ),
    ucxContributorV2ArchiveSha256: requireNonEmptyAttestationValue(
      input.ucxContributor.v2.archiveSha256,
      'UCX contributor v2 archive digest',
    ),
    ucxContributorV2AppliedGeneration: requireNonEmptyAttestationValue(
      input.ucxContributor.v2.appliedGeneration,
      'UCX contributor v2 applied generation',
    ),
    normalTriageLocalAgentJourneyCompleted: true,
    normalTriageLocalAgentJourneyLoadedModuleSha256: requireNonEmptyAttestationValue(
      normalTriageLocalAgentJourneyLoadedModules.digest,
      'normal Triage loaded module digest',
    ),
    normalTriageLocalAgentJourneyLoadedModulePathsJson: JSON.stringify(
      normalTriageLocalAgentJourneyLoadedModules.scriptPaths,
    ),
    normalTriageLocalAgentJourneyLoadedWebBundleUrl:
      normalTriageLocalAgentJourneyLoadedModules.primaryBundleUrl,
    normalTriageLocalAgentJourneyLoadedWebBundleRevision: requireNonEmptyAttestationValue(
      normalTriageLocalAgentJourneyLoadedModules.digest,
      'normal Triage loaded web bundle revision',
    ),
    normalTriageLocalAgentJourneyLoadedWebModuleProbeJson: JSON.stringify(
      normalTriageLocalAgentJourneyLoadedModules.moduleProbes,
    ),
    contributorDisabledAndRetired: true,
    contributorTrustRevokedAndReinstalled: true,
    contributorUninstalledAndRetired: true,
  };
  if (input.attestation.artifactBasis === 'candidate_manifest') {
    const candidateAttestation = input.attestation as PackedCandidateBrowserQaAttestation;
    outcome.candidateRunId = requireNonEmptyAttestationValue(
      candidateAttestation.artifactRunId,
      'candidate run id',
    );
    outcome.candidateSdkPackageName = candidateAttestation.sdkPackageName;
    outcome.candidateSdkVersion = candidateAttestation.sdkVersion;
    outcome.candidateSdkIntegrity = candidateAttestation.sdkIntegrity;
    outcome.candidatePluginUiPackageName = candidateAttestation.pluginUiPackageName;
    outcome.candidatePluginUiVersion = candidateAttestation.pluginUiVersion;
    outcome.candidatePluginUiSdkVersion = candidateAttestation.pluginUiSdkVersion;
    outcome.candidatePluginUiIntegrity = candidateAttestation.pluginUiIntegrity;
    outcome.candidateCliPackageName = candidateAttestation.cliPackageName;
    outcome.candidateCliVersion = candidateAttestation.cliVersion;
    outcome.candidateCliIntegrity = candidateAttestation.cliIntegrity;
    outcome.candidateInspectorWebArtifactDigest =
      candidateAttestation.inspectorWebArtifactDigest;
  }
  return Object.freeze(outcome);
}

type PackedNovelConnectedAccountQaConsumerHandoff = Readonly<{
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
  publicAuthoring:
    PackedNovelConnectedAccountQaConsumerHandoff['publicAuthoring'];
  authorization: PackedNovelConnectedAccountAuthorizationServer;
  authorizationOriginConfiguration: Readonly<{
    'authorization-origin': string;
  }>;
}>;

type PackedArtifactMaterializationDeps = Readonly<{
  readFile: (path: string) => Promise<Uint8Array>;
  mkdir?: (
    path: string,
    options: Readonly<{ recursive: true }>,
  ) => Promise<unknown>;
  mkdtemp?: (prefix: string) => Promise<string>;
  rm?: (
    path: string,
    options: Readonly<{ recursive: true; force: true }>,
  ) => Promise<void>;
  writeFile?: (
    path: string,
    bytes: Uint8Array,
    options: Readonly<{ flag: 'wx'; mode: number }>,
  ) => Promise<void>;
  readPackedPackageManifest: (
    tarballPath: string,
    extractionRoot: string,
  ) => Promise<Record<string, unknown>>;
  assertPackedPackageIdentity: (
    packageManifest: unknown,
    artifact:
      | PackedAuthorCandidate['sdk']
      | PackedAuthorCandidate['pluginUi']
      | PackedAuthorCandidate['cli'],
    label: string,
  ) => void;
  assertPackedPluginUiSdkDependency: (
    packageManifest: unknown,
    sdkArtifact: PackedAuthorCandidate['sdk'],
  ) => void;
  assertPackedCliEntrypoint: (
    packageManifest: unknown,
    artifact: PackedAuthorCandidate['cli'],
  ) => void;
  materializePackedCli: (params: Readonly<{
    cliArtifact: PackedAuthorCandidate['cli'];
    installRoot: string;
  }>) => Promise<string>;
}>;

type PackedCandidateBrowserQaDeps = PackedArtifactMaterializationDeps & Readonly<{
  parseCandidateManifest: (raw: string, manifestPath: string) => PackedAuthorCandidate;
  assertCandidateManifestArtifacts: (
    candidate: PackedAuthorCandidate,
    options: Readonly<{ manifestPath: string }>,
  ) => Promise<void>;
  attestPackedInspectorArtifacts: typeof attestPackedInspectorArtifacts;
}>;

type PackedUcxWebQaDeps = PackedArtifactMaterializationDeps & Readonly<{
  loadNaturalArtifacts: (input: Readonly<{
    sdkTarballPath: string;
    pluginUiTarballPath: string;
    cliTarballPath: string;
  }>) => Promise<PackedAuthorDirectArtifactsSmoke>;
}>;

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

async function loadCandidateRunnerModule() {
  return await import(candidateRunnerUrl);
}

function createDefaultPackedArtifactMaterializationDeps(candidateModule: Awaited<ReturnType<typeof loadCandidateRunnerModule>>): PackedArtifactMaterializationDeps {
  return {
    readFile,
    mkdir,
    mkdtemp,
    rm,
    writeFile,
    readPackedPackageManifest: candidateModule.readPackedPackageManifest,
    assertPackedPackageIdentity: candidateModule.assertPackedPackageIdentity,
    assertPackedPluginUiSdkDependency:
      candidateModule.assertPackedPluginUiSdkDependency,
    assertPackedCliEntrypoint: candidateModule.assertPackedCliEntrypoint,
    materializePackedCli: candidateModule.materializePackedCli,
  };
}

async function loadDefaultDeps(): Promise<PackedCandidateBrowserQaDeps> {
  // Keep Playwright discovery isolated from the large Vertical A runner's
  // transitive CLI imports. The canonical parser/materializer is loaded only
  // after an explicit candidate manifest opts into candidate QA.
  const candidateModule = await loadCandidateRunnerModule();
  return {
    ...createDefaultPackedArtifactMaterializationDeps(candidateModule),
    parseCandidateManifest: candidateModule.parseCandidateManifest,
    assertCandidateManifestArtifacts:
      candidateModule.assertPackedAuthorCandidateManifestArtifacts,
    attestPackedInspectorArtifacts,
  };
}

async function loadDefaultUcxWebQaDeps(): Promise<PackedUcxWebQaDeps> {
  const candidateModule = await loadCandidateRunnerModule();
  return {
    ...createDefaultPackedArtifactMaterializationDeps(candidateModule),
    loadNaturalArtifacts: async ({
      sdkTarballPath,
      pluginUiTarballPath,
      cliTarballPath,
    }) => await candidateModule.loadPackedAuthorNaturalArtifacts([
      '--scenario',
      'vertical-a',
      '--sdk-tarball',
      sdkTarballPath,
      '--plugin-ui-tarball',
      pluginUiTarballPath,
      '--cli-tarball',
      cliTarballPath,
    ], {
      createRunId: () => 'ucx-web-row-local',
    }),
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
    publicAuthoring: handoff.publicAuthoring,
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

export type PackedPublicAuthoringHostedWebRuntimeAttestation = Readonly<{
  projectionGeneration: number;
  hostedWebDigest: string;
  runtimeState: 'available';
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

export function attestPackedPublicAuthoringHostedWebRuntime(params: Readonly<{
  publicAuthoring:
    PackedNovelConnectedAccountQaConsumerHandoff['publicAuthoring'];
  projectionResponse: unknown;
}>): PackedPublicAuthoringHostedWebRuntimeAttestation {
  const projection = recordAt(params.projectionResponse, ['projection']);
  const generation = projection?.generation;
  if (typeof generation !== 'number' || !Number.isInteger(generation) || generation < 0) {
    throw new Error('packed_public_authoring_hosted_web_projection_generation_missing');
  }
  const entryId = [
    'hostedWeb',
    params.publicAuthoring.pluginId,
    params.publicAuthoring.hostedWeb.contributionId,
  ].join(':');
  const entries = recordAt(projection, ['familiesById', 'pluginUi', 'entriesById']);
  const entry = asRecord(entries?.[entryId]);
  const artifactGraph = recordAt(entry, ['artifactGraph']);
  const runtime = recordAt(entry, ['runtime']);
  const runtimeMode = recordAt(entry, ['runtimeMode']);
  if (
    artifactGraph?.contributionId
      !== params.publicAuthoring.hostedWeb.contributionId
    || artifactGraph.tier !== 'hostedWeb'
  ) {
    throw new Error('packed_public_authoring_hosted_web_projection_graph_missing');
  }
  if (artifactGraph.digest !== params.publicAuthoring.hostedWeb.digest) {
    throw new Error('packed_public_authoring_hosted_web_projection_digest_mismatch');
  }
  if (
    runtime?.state !== 'available'
    || runtimeMode?.kind !== 'installedStaticAssets'
  ) {
    throw new Error('packed_public_authoring_hosted_web_projection_unavailable');
  }
  return Object.freeze({
    projectionGeneration: generation,
    hostedWebDigest: params.publicAuthoring.hostedWeb.digest,
    runtimeState: 'available',
  });
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
  const target = recordAt(surface, ['target']);
  if (
    surface?.container !== 'rightSidebarTab'
    || target?.kind !== 'app'
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
    !web.compat.react
    || !ios.compat.react
    || !android.compat.react
    || !web.compat.reactNative
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
          react: web.compat.react,
          reactNative: web.compat.reactNative,
        }),
      }),
      ios: Object.freeze({
        artifactDigest: ios.digest,
        builtWith: Object.freeze({ ...ios.builtWith }),
        hostUiApiVersion: ios.hostUiApiVersion,
        compat: Object.freeze({
          ...ios.compat,
          react: ios.compat.react,
          reactNative: ios.compat.reactNative,
        }),
      }),
      android: Object.freeze({
        artifactDigest: android.digest,
        builtWith: Object.freeze({ ...android.builtWith }),
        hostUiApiVersion: android.hostUiApiVersion,
        compat: Object.freeze({
          ...android.compat,
          react: android.compat.react,
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
  label: 'sdk' | 'plugin-ui' | 'cli',
  bytes: Uint8Array,
  expectedIntegrity: string,
): void {
  const actualIntegrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  if (actualIntegrity !== expectedIntegrity) {
    throw new Error(`packed_candidate_${label}_integrity_mismatch`);
  }
}

async function prepareVerifiedPackedUcxWebQa<
  TCandidate extends PackedAuthorDirectArtifactsSmoke,
>(params: Readonly<{
  candidate: TCandidate;
  materializationRoot: string;
  artifactBasis: PackedUcxWebQaArtifactBasis;
  artifactRunId: string | null;
  deps: PackedArtifactMaterializationDeps;
}>): Promise<Readonly<{
  candidate: TCandidate;
  cliLaunchSpec: CliTestLaunchSpec;
  cleanup: () => Promise<void>;
  attestation: PackedUcxWebQaAttestation;
}>> {
  const { candidate, deps } = params;
  const [sdkBytes, pluginUiBytes, cliBytes] = await Promise.all([
    deps.readFile(candidate.sdk.tarballPath),
    deps.readFile(candidate.pluginUi.tarballPath),
    deps.readFile(candidate.cli.tarballPath),
  ]);

  assertCandidateArtifactIntegrity('sdk', sdkBytes, candidate.sdk.integrity);
  assertCandidateArtifactIntegrity(
    'plugin-ui',
    pluginUiBytes,
    candidate.pluginUi.integrity,
  );
  assertCandidateArtifactIntegrity('cli', cliBytes, candidate.cli.integrity);

  const mkdirImpl = deps.mkdir ?? mkdir;
  const mkdtempImpl = deps.mkdtemp ?? mkdtemp;
  const rmImpl = deps.rm ?? rm;
  const writeFileImpl = deps.writeFile ?? writeFile;
  await mkdirImpl(params.materializationRoot, { recursive: true });
  const verifiedCandidateRoot = await mkdtempImpl(
    join(params.materializationRoot, 'verified-candidate-'),
  );
  let cleanupPromise: Promise<void> | null = null;
  const cleanup = (): Promise<void> => {
    cleanupPromise ??= rmImpl(
      verifiedCandidateRoot,
      { recursive: true, force: true },
    ).catch((error) => {
      cleanupPromise = null;
      throw error;
    });
    return cleanupPromise;
  };
  try {
    const verifiedSdkTarballPath = join(verifiedCandidateRoot, 'sdk.tgz');
    const verifiedPluginUiTarballPath = join(
      verifiedCandidateRoot,
      'plugin-ui.tgz',
    );
    const verifiedCliTarballPath = join(verifiedCandidateRoot, 'cli.tgz');
    await Promise.all([
      writeFileImpl(verifiedSdkTarballPath, sdkBytes, { flag: 'wx', mode: 0o600 }),
      writeFileImpl(verifiedPluginUiTarballPath, pluginUiBytes, { flag: 'wx', mode: 0o600 }),
      writeFileImpl(verifiedCliTarballPath, cliBytes, { flag: 'wx', mode: 0o600 }),
    ]);
    const verifiedCandidate = Object.freeze({
      ...candidate,
      sdk: Object.freeze({
        ...candidate.sdk,
        tarballPath: verifiedSdkTarballPath,
      }),
      pluginUi: Object.freeze({
        ...candidate.pluginUi,
        tarballPath: verifiedPluginUiTarballPath,
      }),
      cli: Object.freeze({
        ...candidate.cli,
        tarballPath: verifiedCliTarballPath,
      }),
    }) as TCandidate;

    const [sdkPackageManifest, pluginUiPackageManifest, cliPackageManifest] = await Promise.all([
      deps.readPackedPackageManifest(
        verifiedCandidate.sdk.tarballPath,
        join(params.materializationRoot, 'verify-sdk'),
      ),
      deps.readPackedPackageManifest(
        verifiedCandidate.pluginUi.tarballPath,
        join(params.materializationRoot, 'verify-plugin-ui'),
      ),
      deps.readPackedPackageManifest(
        verifiedCandidate.cli.tarballPath,
        join(params.materializationRoot, 'verify-cli'),
      ),
    ]);
    deps.assertPackedPackageIdentity(sdkPackageManifest, verifiedCandidate.sdk, 'Packed SDK');
    deps.assertPackedPackageIdentity(
      pluginUiPackageManifest,
      verifiedCandidate.pluginUi,
      'Packed Plugin UI',
    );
    deps.assertPackedPluginUiSdkDependency(
      pluginUiPackageManifest,
      verifiedCandidate.sdk,
    );
    deps.assertPackedPackageIdentity(cliPackageManifest, verifiedCandidate.cli, 'Packed CLI');
    deps.assertPackedCliEntrypoint(cliPackageManifest, verifiedCandidate.cli);

    const cliEntrypoint = await deps.materializePackedCli({
      cliArtifact: verifiedCandidate.cli,
      installRoot: params.materializationRoot,
    });
    const cliLaunchSpec: CliTestLaunchSpec = Object.freeze({
      command: process.execPath,
      args: [cliEntrypoint],
      cwd: params.materializationRoot,
    });

    return Object.freeze({
      candidate: verifiedCandidate,
      cleanup,
      cliLaunchSpec,
      attestation: Object.freeze({
        artifactBasis: params.artifactBasis,
        artifactRunId: params.artifactRunId,
        sdkPackageName: candidate.sdk.packageName,
        sdkVersion: candidate.sdk.version,
        sdkIntegrity: candidate.sdk.integrity,
        pluginUiPackageName: candidate.pluginUi.packageName,
        pluginUiVersion: candidate.pluginUi.version,
        pluginUiSdkVersion: candidate.pluginUi.pluginSdkVersion,
        pluginUiIntegrity: candidate.pluginUi.integrity,
        cliPackageName: candidate.cli.packageName,
        cliVersion: candidate.cli.version,
        cliIntegrity: candidate.cli.integrity,
        cliEntrypoint,
      }),
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
          'Packed candidate browser preparation and private capture cleanup failed twice',
        );
      }
    }
    throw error;
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
  const prepared = await prepareVerifiedPackedUcxWebQa({
    candidate,
    materializationRoot: params.materializationRoot,
    artifactBasis: 'candidate_manifest',
    artifactRunId: candidate.runId,
    deps,
  });
  try {
    const inspector = await deps.attestPackedInspectorArtifacts({
      cliEntrypoint: prepared.attestation.cliEntrypoint,
    });
    return Object.freeze({
      candidate: prepared.candidate,
      cleanup: prepared.cleanup,
      cliLaunchSpec: prepared.cliLaunchSpec,
      attestation: Object.freeze({
        ...prepared.attestation,
        artifactBasis: 'candidate_manifest',
        artifactRunId: candidate.runId,
        runId: candidate.runId,
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
  } catch (error) {
    await prepared.cleanup();
    throw error;
  }
}

export async function preparePackedUcxWebQa(params:
  | Readonly<{
    artifactBasis: 'candidate_manifest';
    candidateManifestPath: string;
    materializationRoot: string;
    deps?: PackedCandidateBrowserQaDeps;
  }>
  | Readonly<{
    artifactBasis: 'row_local_natural';
    sdkTarballPath: string;
    pluginUiTarballPath: string;
    cliTarballPath: string;
    materializationRoot: string;
    deps?: PackedUcxWebQaDeps;
  }>,
): Promise<PreparedPackedUcxWebQa> {
  if (params.artifactBasis === 'candidate_manifest') {
    return await preparePackedCandidateBrowserQa({
      candidateManifestPath: params.candidateManifestPath,
      materializationRoot: params.materializationRoot,
      ...(params.deps === undefined ? {} : { deps: params.deps }),
    });
  }

  const deps = params.deps ?? await loadDefaultUcxWebQaDeps();
  const candidate = await deps.loadNaturalArtifacts({
    sdkTarballPath: params.sdkTarballPath,
    pluginUiTarballPath: params.pluginUiTarballPath,
    cliTarballPath: params.cliTarballPath,
  });
  return await prepareVerifiedPackedUcxWebQa({
    candidate,
    materializationRoot: params.materializationRoot,
    artifactBasis: 'row_local_natural',
    artifactRunId: null,
    deps,
  });
}
