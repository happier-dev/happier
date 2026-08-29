import { spawnSync } from 'node:child_process';
import { existsSync as defaultExistsSync, realpathSync as defaultRealpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  sanitizePackedAuthorArtifactEnv,
} from './run-packed-author-ui-compat.mjs';

export const PACKED_MANAGED_PROVIDER_REQUIRED_STAGE_IDS = Object.freeze([
  'candidate-artifact-integrity',
  'candidate-package-identity',
  'standalone-cli-artifact-integrity',
  'standalone-cli-artifact-identity',
  'standalone-cli-private-extract',
  'public-provider-explicit-start',
  'public-provider-catalog-probe',
  'isolated-runtime',
  'public-provider-session-demand',
  'pre-session-demand-no-provider-effect',
  'canonical-session-created',
  'public-purpose-binding-authorized',
  'public-session-admitted-before-provider-attempt',
  'current-auth-provider-attempt',
  'public-session-failure-cleanup',
  'cleanup',
]);

export const PACKED_MANAGED_PROVIDER_CANDIDATE_HANDOFF_STAGE_IDS =
Object.freeze([
  'candidate-external-agent-provider-author',
  'candidate-external-agent-provider-pack',
  'candidate-external-agent-provider-reviewed-install',
  'candidate-generation-handoff',
  'candidate-exactly-once-turns',
  'candidate-provider-hard-revoke',
  'candidate-handoff-cleanup',
]);

export const PACKED_CHANNEL_PROVIDER_REQUIRED_STAGE_IDS = Object.freeze([
  'candidate-artifact-integrity',
  'candidate-package-identity',
  'standalone-cli-artifact-integrity',
  'standalone-cli-artifact-identity',
  'standalone-cli-private-extract',
  'public-channel-artifact-closure',
  'daemon-reviewed-archive-install',
  'cold-core-setup-discovery',
  'plugin-demand-activation-caller-stamp',
  'strict-channel-action-contracts',
  'dynamic-resource-reread',
  'post-adoption-background-network',
  'channel-custody-and-stop',
  'disable-reenable-restart',
  'failed-replacement-lkg',
  'retired-generation-inert',
  'archive-uninstall-cleanup',
  'cleanup',
]);

function fail(code) {
  throw new Error(code);
}

function isPathWithin(rootPath, candidatePath) {
  const rel = relative(rootPath, candidatePath);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export function assertPackedManagedStandaloneCliArchiveIdentity({
  archivePath,
  candidateCliVersion,
  entries,
  platform = process.platform,
  arch = process.arch,
}) {
  const os = platform === 'win32' ? 'windows' : String(platform);
  const normalizedArch = arch === 'x86_64' || arch === 'amd64'
    ? 'x64'
    : arch === 'aarch64'
      ? 'arm64'
      : String(arch);
  const version = String(candidateCliVersion ?? '');
  const artifactRootName = `happier-v${version}-${os}-${normalizedArch}`;
  const archiveName = `${artifactRootName}.tar.gz`;
  if (
    !version
    || basename(String(archivePath ?? '')) !== archiveName
    || !Array.isArray(entries)
    || entries.some((entry) => (
      typeof entry?.path !== 'string'
      || (entry.path !== artifactRootName && !entry.path.startsWith(`${artifactRootName}/`))
    ))
  ) {
    fail('packed_managed_provider_standalone_cli_identity_mismatch');
  }
  const executableName = os === 'windows' ? 'happier.exe' : 'happier';
  const wrapperName = os === 'windows'
    ? 'happier-cliproxyapi-managed.exe'
    : 'happier-cliproxyapi-managed';
  const executableRelativePath = `${artifactRootName}/${executableName}`;
  const wrapperRelativePath = `${artifactRootName}/tools/unpacked/${wrapperName}`;
  const requiredFiles = [
    executableRelativePath,
    wrapperRelativePath,
    `${artifactRootName}/tools/unpacked/CLIProxyAPI-LICENSE`,
    `${artifactRootName}/tools/unpacked/CLIProxyAPI-THIRD-PARTY-NOTICES`,
  ];
  const files = new Set(
    entries
      .filter((entry) => entry.kind === 'file')
      .map((entry) => entry.path),
  );
  if (!files.has(executableRelativePath)) {
    fail('packed_managed_provider_standalone_cli_executable_missing');
  }
  if (!files.has(wrapperRelativePath)) {
    fail('packed_managed_provider_standalone_cli_wrapper_missing');
  }
  if (requiredFiles.some((path) => !files.has(path))) {
    fail('packed_managed_provider_standalone_cli_attribution_missing');
  }
  return Object.freeze({
    product: 'happier',
    version,
    os,
    arch: normalizedArch,
    archiveName,
    artifactRootName,
    executableRelativePath,
    wrapperRelativePath,
  });
}

export function resolvePackedManagedWrapperExecutable({
  standaloneCliExecutable,
  standaloneCliExtractRoot,
  platform = process.platform,
  existsSync = defaultExistsSync,
  realpathSync = defaultRealpathSync,
}) {
  const extractRoot = resolve(String(standaloneCliExtractRoot ?? ''));
  const executable = resolve(String(standaloneCliExecutable ?? ''));
  if (!standaloneCliExtractRoot || !standaloneCliExecutable) {
    fail('packed_managed_provider_standalone_cli_paths_required');
  }
  const wrapperExecutable = resolve(
    dirname(executable),
    'tools',
    'unpacked',
    `happier-cliproxyapi-managed${platform === 'win32' ? '.exe' : ''}`,
  );
  if (!existsSync(wrapperExecutable)) {
    fail('packed_managed_provider_wrapper_absent_from_standalone_cli');
  }
  const physicalRoot = resolve(realpathSync(extractRoot));
  const physicalExecutable = resolve(realpathSync(executable));
  const physicalWrapper = resolve(realpathSync(wrapperExecutable));
  if (
    !isPathWithin(physicalRoot, physicalExecutable)
    || !isPathWithin(physicalRoot, physicalWrapper)
  ) {
    fail('packed_managed_provider_wrapper_escaped_candidate');
  }
  return wrapperExecutable;
}

function readFlagValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    fail(`packed_managed_provider_${flag.slice(2).replaceAll('-', '_')}_value_required`);
  }
  return value;
}

/**
 * @param {readonly string[]} argv
 * @returns {
 *   | { mode: 'recipe' | 'current-source' | 'current-source-channel', candidateManifestPath: null }
 *   | { mode: 'run' | 'channel', candidateManifestPath: string, enableOpenCodeLive: false, workRoot?: string }
 * }
 */
export function parsePackedManagedProviderArgs(argv) {
  let recipe = false;
  let currentSource = false;
  let channel = false;
  let candidateManifestPath = null;
  let enableOpenCodeLive = false;
  let workRoot = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--recipe') {
      if (recipe) fail('packed_managed_provider_recipe_repeated');
      recipe = true;
      continue;
    }
    if (argument === '--channel') {
      if (channel) fail('packed_managed_provider_channel_repeated');
      channel = true;
      continue;
    }
    if (argument === '--current-source') {
      if (currentSource) fail('packed_managed_provider_current_source_repeated');
      currentSource = true;
      continue;
    }
    if (argument === '--candidate') {
      if (candidateManifestPath) fail('packed_managed_provider_candidate_repeated');
      candidateManifestPath = readFlagValue(argv, index, argument);
      index += 1;
      continue;
    }
    if (argument === '--work-root') {
      if (workRoot) fail('packed_managed_provider_work_root_repeated');
      workRoot = readFlagValue(argv, index, argument);
      index += 1;
      continue;
    }
    if (argument === '--opencode-live') {
      fail('packed_managed_provider_opencode_live_not_supported');
    }
    fail(`packed_managed_provider_unknown_argument:${argument}`);
  }
  if (recipe) {
    if (
      currentSource
      || channel
      || candidateManifestPath
      || workRoot
      || enableOpenCodeLive
    ) {
      fail('packed_managed_provider_recipe_must_be_candidate_free');
    }
    return { mode: 'recipe', candidateManifestPath: null };
  }
  if (currentSource) {
    if (candidateManifestPath || workRoot || enableOpenCodeLive) {
      fail('packed_managed_provider_current_source_must_be_candidate_free');
    }
    return {
      mode: channel ? 'current-source-channel' : 'current-source',
      candidateManifestPath: null,
    };
  }
  if (!candidateManifestPath) fail('packed_managed_provider_candidate_required');
  return {
    mode: channel ? 'channel' : 'run',
    candidateManifestPath,
    enableOpenCodeLive,
    ...(workRoot ? { workRoot } : {}),
  };
}

export function buildPackedManagedProviderRecipe({ packageRoot }) {
  return Object.freeze({
    schemaVersion: 1,
    kind: 'packed_managed_provider_current_source_recipe',
    packageRoot: resolve(packageRoot),
    command:
      'yarn workspace @happier-dev/tests test:plugin-platform:packed-managed-provider',
    inputs: Object.freeze({
      source:
        'the current checkout through the normal development CLI snapshot and canonical npm pack owners',
    }),
    resources: Object.freeze({
      workRoot: 'one new private temporary root',
      externalAuthoring:
        'public-only external Agent generations use the current packed SDK and current development CLI snapshot',
      server: 'one server-light SQLite process on a dynamically reserved loopback port',
      daemon: 'one current development CLI snapshot daemon with an isolated HAPPIER_HOME_DIR and lifecycle scope',
      agentWorkspace: 'one private empty workspace',
      opencodeState: 'one isolated XDG/config root; ambient OpenCode state is forbidden',
      externalBoundaries:
        'the installed external Agent and public External Sessions lifecycle remain real',
      dynamicPortsOnly: true,
      cliSourceFallback: false,
    }),
    environment: Object.freeze({
      required: Object.freeze([
        'HAPPIER_FEATURE_PROVIDERS__ENABLED=1',
        'HAPPIER_FEATURE_LOCAL_SERVICES_MANAGED__ENABLED=0',
      ]),
      forbidden: Object.freeze([
        'HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT',
        'HAPPIER_CLI_SUBPROCESS_ALLOW_TSX_FALLBACK',
        'HAPPIER_OPENCODE_SERVER_URL',
      ]),
    }),
  });
}

export function buildPackedManagedProviderEntrypointInvocation({
  packageRoot,
  parsed,
}) {
  if (
    parsed?.mode !== 'run'
    && parsed?.mode !== 'channel'
    && parsed?.mode !== 'current-source'
    && parsed?.mode !== 'current-source-channel'
  ) {
    fail('packed_managed_provider_continuity_requires_candidate');
  }
  if (
    parsed.mode !== 'current-source'
    && parsed.mode !== 'current-source-channel'
    && !parsed.candidateManifestPath
  ) {
    fail('packed_managed_provider_continuity_requires_candidate');
  }
  const resolvedPackageRoot = resolve(packageRoot);
  return Object.freeze({
    command: process.execPath,
    args: Object.freeze([
      resolve(resolvedPackageRoot, 'scripts/runTsxEntrypoint.mjs'),
      'src/plugin-platform/runPackedManagedProviderContinuity.ts',
      ...(parsed.mode === 'current-source' || parsed.mode === 'current-source-channel'
        ? ['--current-source', ...(parsed.mode === 'current-source-channel' ? ['--channel'] : [])]
        : [
          ...(parsed.mode === 'channel' ? ['--channel'] : []),
          '--candidate',
          parsed.candidateManifestPath,
          ...(parsed.workRoot ? ['--work-root', parsed.workRoot] : []),
        ]),
    ]),
    cwd: resolvedPackageRoot,
  });
}

function stage(id, status = 'passed', evidence = undefined) {
  return Object.freeze({
    id,
    status,
    ...(evidence === undefined ? {} : { evidence }),
  });
}

function validateCandidatePreparation(prepared, input) {
  if (prepared?.currentSource === true) {
    if (
      prepared?.candidate?.sdk?.packageName !== '@happier-dev/plugin-sdk'
      || prepared?.candidate?.cli?.packageName !== '@happier-dev/cli'
      || typeof prepared.wrapperExecutable !== 'string'
      || prepared.wrapperExecutable.length === 0
      || typeof prepared.cliLaunchSpec?.command !== 'string'
      || prepared.cliLaunchSpec.command.length === 0
    ) {
      fail('packed_managed_provider_current_source_preparation_mismatch');
    }
    return;
  }
  if (
    prepared?.verifiedCandidateIntegrity !== true
    || prepared?.candidate?.sdk?.packageName !== '@happier-dev/plugin-sdk'
    || prepared?.candidate?.cli?.packageName !== '@happier-dev/cli'
  ) {
    fail('packed_managed_provider_candidate_integrity_mismatch');
  }
  if (prepared.verifiedCandidatePackageIdentity !== true) {
    fail('packed_managed_provider_candidate_identity_mismatch');
  }
  const artifact = prepared.standaloneCliArtifact;
  const boundArtifact = prepared.candidate.standaloneCli?.archives?.find(
    (candidateArtifact) => (
      candidateArtifact.os === artifact?.os
      && candidateArtifact.arch === artifact?.arch
    ),
  );
  if (
    prepared.verifiedStandaloneCliIntegrity !== true
    || !boundArtifact
    || artifact?.sha256 !== boundArtifact.sha256
    || resolve(String(artifact?.sourceArchivePath ?? artifact?.archivePath ?? ''))
      !== resolve(String(boundArtifact.archivePath ?? ''))
  ) {
    fail('packed_managed_provider_standalone_cli_integrity_mismatch');
  }
  if (
    prepared.verifiedStandaloneCliIdentity !== true
    || artifact?.product !== 'happier'
    || artifact?.version !== prepared.candidate.cli.version
  ) {
    fail('packed_managed_provider_standalone_cli_identity_mismatch');
  }
  const entrypoint = String(artifact?.executablePath ?? '');
  const launchArgs = prepared.cliLaunchSpec?.args;
  if (
    !entrypoint
    || prepared.cliLaunchSpec?.command !== entrypoint
    || !Array.isArray(launchArgs)
    || launchArgs.length !== 0
    || entrypoint.includes('/apps/cli/dist.staging')
    || entrypoint.includes('/apps/cli/src/')
    || entrypoint.includes('/node_modules/@happier-dev/cli/')
    || !isPathWithin(resolve(String(artifact.extractRoot ?? '')), resolve(entrypoint))
  ) {
    fail('packed_managed_provider_standalone_cli_launch_mismatch');
  }
  const wrapperExecutable = String(prepared.wrapperExecutable ?? '');
  if (
    !isPathWithin(resolve(String(artifact.extractRoot ?? '')), resolve(wrapperExecutable))
    || !/[\\/]tools[\\/]unpacked[\\/]happier-cliproxyapi-managed(?:\.exe)?$/u.test(wrapperExecutable)
  ) {
    fail('packed_managed_provider_standalone_cli_wrapper_identity_mismatch');
  }
}

function validateWrapperConformance(evidence) {
  if (
    evidence?.publicExplicitStart !== true
    || evidence?.publicCatalogProbe !== true
    || evidence?.catalogOwnerReleased !== true
    || evidence?.publicCredentialLeakObserved !== false
    || evidence?.providerAttemptedBeforeSessionDemand !== false
  ) {
    fail('packed_managed_provider_public_activation_conformance_mismatch');
  }
}

function validateManagedSequence(evidence) {
  if (
    evidence?.freshSession !== true
    || evidence?.agentId !== 'opencode'
    || evidence?.publicActivationReason !== 'sessionDemand'
    || typeof evidence?.canonicalSessionId !== 'string'
    || evidence.canonicalSessionId.trim().length === 0
  ) {
    fail('packed_managed_provider_fresh_session_mismatch');
  }
  const timeline = evidence.timeline;
  if (
    !timeline
    || !Object.values(timeline).every((value) => (
      Number.isInteger(value) && value > 0
    ))
    || timeline.freshSpawnStartedAtMs
      > timeline.canonicalSessionRegisteredAtMs
    || timeline.canonicalSessionRegisteredAtMs
      > timeline.providerAttemptAtMs
    || timeline.freshSpawnStartedAtMs > timeline.spawnAcknowledgedAtMs
  ) {
    fail('packed_managed_provider_sequence_mismatch');
  }
  if (
    evidence.preSessionDemandCredentialReleased !== false
    || evidence.preSessionDemandUpstreamAttempted !== false
  ) {
    fail('packed_managed_provider_pre_activation_effect');
  }
  if (
    !Number.isInteger(evidence.connectionRevision)
    || evidence.connectionRevision <= 0
  ) {
    fail('packed_managed_provider_connection_revision_missing');
  }
  if (
    !Array.isArray(evidence.purposes)
    || !evidence.purposes.some((value) => /happier\.agent\.opencode\/opencode:/u.test(value))
    || !evidence.purposes.some((value) => /happier\.provider\.cliproxyapi\/cliproxyapi:/u.test(value))
  ) {
    fail('packed_managed_provider_purpose_binding_mismatch');
  }
  let managedConnectTarget = null;
  try {
    const managedOrigin = new URL(evidence.managedRequestAuthOrigin);
    if (
      managedOrigin.protocol === 'https:'
      && managedOrigin.username.length === 0
      && managedOrigin.password.length === 0
      && managedOrigin.pathname === '/'
      && managedOrigin.search.length === 0
      && managedOrigin.hash.length === 0
    ) {
      managedConnectTarget =
        `${managedOrigin.hostname.toLowerCase()}:${managedOrigin.port || '443'}`;
    }
  } catch {
    managedConnectTarget = null;
  }
  if (
    evidence.managedRequestAuthOrigin !== 'https://chatgpt.com'
    || managedConnectTarget !== 'chatgpt.com:443'
    || evidence.upstreamConnectTarget !== managedConnectTarget
    || typeof evidence.upstreamRequestPath !== 'string'
    || !evidence.upstreamRequestPath.startsWith('/backend-api/codex/')
  ) {
    fail('packed_managed_provider_managed_origin_mismatch');
  }
  if (
    typeof evidence.currentCredentialRevision !== 'string'
    || typeof evidence.currentAccessTokenFingerprint !== 'string'
    || !/^sha256:[a-f0-9]{64}$/u.test(
      evidence.currentAccessTokenFingerprint,
    )
    || evidence.upstreamAuthorizationFingerprint
      !== evidence.currentAccessTokenFingerprint
    || evidence.promptSentinelObserved !== true
    || !/^sha256:[a-f0-9]{64}$/u.test(
      evidence.stockListenerIdentityBefore,
    )
    || evidence.stockListenerIdentityAfter
      !== evidence.stockListenerIdentityBefore
    || evidence.stockPortRequestCount !== 0
    || evidence.stockPortOsConnectionAttemptCount !== 0
    || !evidence.observedPorts
    || Object.values(evidence.observedPorts).some((port) => (
      !Number.isInteger(port) || port <= 0 || port === 8317
    ))
  ) {
    fail('packed_managed_provider_current_auth_mismatch');
  }
}

function validateActivationFailureCleanup(evidence) {
  if (
    evidence?.activationFailedBeforeAck !== true
    || evidence?.firstInputDispatched !== false
    || evidence?.providerAttempted !== false
    || evidence?.publicSessionCleanupComplete !== true
    || evidence?.sessionProviderExited !== true
  ) {
    fail('packed_managed_provider_public_session_cleanup_mismatch');
  }
}

function validatePackedChannelProviderLifecycle(evidence) {
  const archive = evidence?.archive;
  if (
    archive?.hostRuntime !== 'daemonArchive'
    || archive?.reviewedInstall !== true
    || archive?.publicOnlyArtifact !== true
    || archive?.publicDependencyClosure !== true
  ) {
    fail('packed_channel_provider_archive_lifecycle_mismatch');
  }

  const discovery = evidence?.discovery;
  if (
    discovery?.corePluginId !== 'happier.channels'
    || discovery?.providerPluginId !== 'acme.channels.out-of-tree-socket'
    || discovery?.actionLocalId !== 'fixture/setup'
    || discovery?.targetSurface !== 'plugin'
    || discovery?.coldCatalogBeforeProviderActivation !== true
    || discovery?.demandedActivation !== true
    || discovery?.caller?.kind !== 'plugin'
    || discovery.caller.pluginId !== 'happier.channels'
  ) {
    fail('packed_channel_provider_cold_discovery_mismatch');
  }
  if (
    discovery.strictInputRejectedBeforeHandler !== true
    || discovery.strictResultRejectedBeforeCore !== true
  ) {
    fail('packed_channel_provider_action_contract_mismatch');
  }

  const resource = evidence?.resource;
  if (
    resource?.localId !== 'status-v1'
    || resource?.readObserved !== true
    || resource?.watchSubscribed !== true
    || resource?.invalidationDropped !== true
    || resource?.rereadConverged !== true
  ) {
    fail('packed_channel_provider_resource_reread_mismatch');
  }

  const background = evidence?.background;
  if (
    background?.startedAfterAdoption !== true
    || background?.normalizedNetworkClientObserved !== true
    || background?.socketConnectCountBeforeAdoption !== 0
  ) {
    fail('packed_channel_provider_background_lifecycle_mismatch');
  }
  if (
    background.observationIngressCustodied !== true
    || background.outboundDeliveryCustodied !== true
    || background.historyGapReported !== true
    || background.confirmedStopReported !== true
  ) {
    fail('packed_channel_provider_custody_mismatch');
  }

  const lifecycle = evidence?.lifecycle;
  if (
    lifecycle?.disableAbortedGeneration !== true
    || lifecycle?.reenableSocketCount !== 1
    || lifecycle?.daemonRestartSocketCount !== 1
  ) {
    fail('packed_channel_provider_socket_lifecycle_mismatch');
  }
  if (
    lifecycle.failedReplacementRetainedLkg !== true
    || lifecycle.retiredGenerationReportInert !== true
    || lifecycle.uninstalledCleanly !== true
  ) {
    fail('packed_channel_provider_generation_lifecycle_mismatch');
  }
}

function validatePackedChannelProviderCandidatePreparation(prepared, input) {
  validateCandidatePreparation(prepared, input);
  const channelsProtocol = prepared.candidate.channelsProtocol;
  if (
    channelsProtocol?.packageName !== '@happier-dev/channels-protocol'
    || typeof channelsProtocol.version !== 'string'
    || typeof channelsProtocol.integrity !== 'string'
    || !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(channelsProtocol.integrity)
    || typeof channelsProtocol.tarballPath !== 'string'
    || channelsProtocol.tarballPath.length === 0
  ) {
    fail('packed_channel_provider_channels_protocol_candidate_mismatch');
  }
}

export async function runPackedManagedProviderVertical(input, deps) {
  const stages = [];
  let prepared = null;
  let runError = null;
  try {
    if (input.enableOpenCodeLive) {
      fail('packed_managed_provider_opencode_live_not_supported');
    }
    prepared = await deps.prepareCandidate(input);
    validateCandidatePreparation(prepared, input);
    stages.push(stage('candidate-artifact-integrity', 'passed', {
      sdkIntegrity: prepared.candidate.sdk.integrity,
      cliIntegrity: prepared.candidate.cli.integrity,
    }));
    stages.push(stage('candidate-package-identity'));
    stages.push(stage('standalone-cli-artifact-integrity', 'passed', {
      ...(prepared.currentSource === true
        ? { source: 'current-source' }
        : { sha256: prepared.standaloneCliArtifact.sha256 }),
    }));
    stages.push(stage('standalone-cli-artifact-identity', 'passed', {
      product: prepared.standaloneCliArtifact.product,
      version: prepared.standaloneCliArtifact.version,
      os: prepared.standaloneCliArtifact.os,
      arch: prepared.standaloneCliArtifact.arch,
    }));
    stages.push(stage('standalone-cli-private-extract', 'passed', {
      entrypoint: prepared.standaloneCliArtifact.executablePath,
      wrapperExecutable: prepared.wrapperExecutable,
    }));

    const wrapperConformance = await deps.runPackagedWrapperConformance({
      ...input,
      prepared,
    });
    validateWrapperConformance(wrapperConformance);
    stages.push(stage('public-provider-explicit-start'));
    stages.push(stage('public-provider-catalog-probe'));

    const managed = await deps.runFreshManagedSequence({
      ...input,
      prepared,
    });
    validateManagedSequence(managed);
    stages.push(stage('isolated-runtime'));
    stages.push(stage('public-provider-session-demand', 'passed', {
      agentId: managed.agentId,
    }));
    stages.push(stage('pre-session-demand-no-provider-effect'));
    stages.push(stage('canonical-session-created', 'passed', {
      sessionId: managed.canonicalSessionId,
    }));
    stages.push(stage('public-purpose-binding-authorized', 'passed', {
      purposes: managed.purposes,
      connectionRevision: managed.connectionRevision,
      timeline: managed.timeline,
    }));
    stages.push(stage('public-session-admitted-before-provider-attempt'));
    stages.push(stage('current-auth-provider-attempt', 'passed', {
      credentialRevision: managed.currentCredentialRevision,
      accessTokenFingerprint: managed.upstreamAuthorizationFingerprint,
      upstreamRequestPath: managed.upstreamRequestPath,
      promptSentinelObserved: managed.promptSentinelObserved,
    }));

    const cleanupProbe = await deps.runActivationFailureCleanupProbe({
      ...input,
      prepared,
    });
    validateActivationFailureCleanup(cleanupProbe);
    stages.push(stage('public-session-failure-cleanup'));

  } catch (error) {
    runError = error;
    throw error;
  } finally {
    try {
      await deps.cleanup({ ...input, prepared, runError });
      if (!runError) stages.push(stage('cleanup'));
    } catch (cleanupError) {
      if (runError) {
        runError.cleanupError = cleanupError;
      } else {
        throw cleanupError;
      }
    }
  }

  if (
    stages.length !== PACKED_MANAGED_PROVIDER_REQUIRED_STAGE_IDS.length
    || stages.some((value, index) => value.id !== PACKED_MANAGED_PROVIDER_REQUIRED_STAGE_IDS[index])
  ) {
    fail('packed_managed_provider_stage_coverage_mismatch');
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: 'packed_managed_provider_vertical',
    status: 'passed',
    candidate: Object.freeze({
      runId: prepared.candidate.runId,
      sdk: prepared.candidate.sdk,
      cli: prepared.candidate.cli,
    }),
    standaloneCliArtifact: Object.freeze({
      product: prepared.standaloneCliArtifact.product,
      version: prepared.standaloneCliArtifact.version,
      os: prepared.standaloneCliArtifact.os,
      arch: prepared.standaloneCliArtifact.arch,
      archivePath: prepared.standaloneCliArtifact.archivePath,
      sha256: prepared.standaloneCliArtifact.sha256,
      executablePath: prepared.standaloneCliArtifact.executablePath,
      wrapperExecutable: prepared.wrapperExecutable,
    }),
    stages: Object.freeze(stages),
    blockers: Object.freeze([]),
  });
}

export async function runPackedChannelProviderVertical(input, deps) {
  const stages = [];
  let prepared = null;
  let runError = null;
  try {
    if (input.enableOpenCodeLive) {
      fail('packed_channel_provider_opencode_live_not_supported');
    }
    prepared = await deps.prepareCandidate(input);
    validatePackedChannelProviderCandidatePreparation(prepared, input);
    stages.push(stage('candidate-artifact-integrity', 'passed', {
      sdkIntegrity: prepared.candidate.sdk.integrity,
      channelsProtocolIntegrity: prepared.candidate.channelsProtocol.integrity,
      cliIntegrity: prepared.candidate.cli.integrity,
    }));
    stages.push(stage('candidate-package-identity'));
    stages.push(stage('standalone-cli-artifact-integrity', 'passed', {
      sha256: prepared.standaloneCliArtifact.sha256,
    }));
    stages.push(stage('standalone-cli-artifact-identity', 'passed', {
      product: prepared.standaloneCliArtifact.product,
      version: prepared.standaloneCliArtifact.version,
      os: prepared.standaloneCliArtifact.os,
      arch: prepared.standaloneCliArtifact.arch,
    }));
    stages.push(stage('standalone-cli-private-extract', 'passed', {
      entrypoint: prepared.standaloneCliArtifact.executablePath,
    }));

    const lifecycleEvidence = await deps.runPackedChannelProviderLifecycle({
      ...input,
      prepared,
    });
    validatePackedChannelProviderLifecycle(lifecycleEvidence);
    stages.push(stage('public-channel-artifact-closure'));
    stages.push(stage('daemon-reviewed-archive-install'));
    stages.push(stage('cold-core-setup-discovery', 'passed', {
      actionLocalId: lifecycleEvidence.discovery.actionLocalId,
      providerPluginId: lifecycleEvidence.discovery.providerPluginId,
    }));
    stages.push(stage('plugin-demand-activation-caller-stamp', 'passed', {
      caller: lifecycleEvidence.discovery.caller,
    }));
    stages.push(stage('strict-channel-action-contracts'));
    stages.push(stage('dynamic-resource-reread'));
    stages.push(stage('post-adoption-background-network'));
    stages.push(stage('channel-custody-and-stop'));
    stages.push(stage('disable-reenable-restart'));
    stages.push(stage('failed-replacement-lkg'));
    stages.push(stage('retired-generation-inert'));
    stages.push(stage('archive-uninstall-cleanup'));
  } catch (error) {
    runError = error;
    throw error;
  } finally {
    try {
      await deps.cleanup({ ...input, prepared, runError });
      if (!runError) stages.push(stage('cleanup'));
    } catch (cleanupError) {
      if (runError) {
        runError.cleanupError = cleanupError;
      } else {
        throw cleanupError;
      }
    }
  }

  if (
    stages.length !== PACKED_CHANNEL_PROVIDER_REQUIRED_STAGE_IDS.length
    || stages.some((value, index) => value.id !== PACKED_CHANNEL_PROVIDER_REQUIRED_STAGE_IDS[index])
  ) {
    fail('packed_channel_provider_stage_coverage_mismatch');
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: 'packed_channel_provider_vertical',
    status: 'passed',
    candidate: Object.freeze({
      runId: prepared.candidate.runId,
      sdk: prepared.candidate.sdk,
      channelsProtocol: prepared.candidate.channelsProtocol,
      cli: prepared.candidate.cli,
    }),
    standaloneCliArtifact: Object.freeze({
      product: prepared.standaloneCliArtifact.product,
      version: prepared.standaloneCliArtifact.version,
      os: prepared.standaloneCliArtifact.os,
      arch: prepared.standaloneCliArtifact.arch,
      archivePath: prepared.standaloneCliArtifact.archivePath,
      sha256: prepared.standaloneCliArtifact.sha256,
      executablePath: prepared.standaloneCliArtifact.executablePath,
    }),
    stages: Object.freeze(stages),
    blockers: Object.freeze([]),
  });
}

function runCli() {
  const parsed = parsePackedManagedProviderArgs(process.argv.slice(2));
  const packageRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
  if (parsed.mode === 'recipe') {
    process.stdout.write(`${JSON.stringify(buildPackedManagedProviderRecipe({ packageRoot }), null, 2)}\n`);
    return;
  }
  const invocation = buildPackedManagedProviderEntrypointInvocation({
    packageRoot,
    parsed,
  });
  const result = spawnSync(
    invocation.command,
    invocation.args,
    {
      cwd: invocation.cwd,
      env: sanitizePackedAuthorArtifactEnv(process.env),
      stdio: 'inherit',
    },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

const currentFilePath = fileURLToPath(import.meta.url);
const entrypointPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (entrypointPath === currentFilePath) {
  runCli();
}
