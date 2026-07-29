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
  'packaged-wrapper-token-free-conformance',
  'isolated-runtime',
  'fresh-managed-spawn',
  'pre-activation-request-auth-refusal',
  'canonical-session-created',
  'exact-purpose-capabilities-activated',
  'webhook-ack-before-first-input',
  'current-auth-provider-attempt',
  'activation-failure-cleanup',
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

export function parsePackedManagedProviderArgs(argv) {
  let recipe = false;
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
      candidateManifestPath
      || workRoot
      || enableOpenCodeLive
    ) {
      fail('packed_managed_provider_recipe_must_be_candidate_free');
    }
    return { mode: 'recipe', candidateManifestPath: null };
  }
  if (!candidateManifestPath) fail('packed_managed_provider_candidate_required');
  return {
    mode: 'run',
    candidateManifestPath,
    enableOpenCodeLive,
    ...(workRoot ? { workRoot } : {}),
  };
}

export function buildPackedManagedProviderRecipe({ packageRoot }) {
  return Object.freeze({
    schemaVersion: 1,
    kind: 'packed_managed_provider_recipe',
    packageRoot: resolve(packageRoot),
    command:
      'yarn workspace @happier-dev/tests test:plugin-platform:packed-managed-provider --candidate <candidate-manifest.json>',
    requiredStageIds: PACKED_MANAGED_PROVIDER_REQUIRED_STAGE_IDS,
    inputs: Object.freeze({
      candidateManifest:
        'one exact candidate manifest from the canonical candidate creator binding the sole SDK, CLI, and five-target standalone CLI archive matrix to one run',
      candidateArchives: 'read-only; SHA-512 SRI and package identity are reverified',
      standaloneCliArtifact:
        'the candidate-manifest-bound host-native happier release archive built by the canonical CLI binary/component-artifact owner; exact path, SHA-256, product, version, platform, archive layout, executable, and bundled managed wrapper are reverified',
    }),
    resources: Object.freeze({
      workRoot: 'one new private temporary root',
      candidateInstall: 'one private exact-tarball install beneath workRoot for candidate package verification only',
      standaloneCliExtract:
        'one private extraction of the separate exact host-native CLI binary artifact beneath workRoot',
      server: 'one server-light SQLite process on a dynamically reserved loopback port',
      daemon: 'one exact standalone CLI artifact daemon with an isolated HAPPIER_HOME_DIR and lifecycle scope',
      wrapper: 'one standalone-artifact-owned CLIProxyAPI managed wrapper on 127.0.0.1:45000-45999',
      agentWorkspace: 'one private empty workspace',
      opencodeState: 'one isolated XDG/config root; ambient OpenCode state is forbidden',
      externalBoundaries:
        'a loopback request-auth forwarding recorder and TLS upstream observer; the Agent, managed Provider wrapper, and canonical activation path remain real',
      dynamicPortsOnly: true,
      stockCliProxyApiPort: 8317,
      stockCliProxyApiPolicy: 'must-not-connect-or-mutate',
      cliSourceFallback: false,
    }),
    environment: Object.freeze({
      required: Object.freeze([
        'HAPPIER_FEATURE_PROVIDERS__ENABLED=1',
        'HAPPIER_FEATURE_LOCAL_SERVICES_MANAGED__ENABLED=1',
      ]),
      forbidden: Object.freeze([
        'HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT',
        'HAPPIER_CLI_SUBPROCESS_ALLOW_TSX_FALLBACK',
        'HAPPIER_OPENCODE_SERVER_URL',
      ]),
    }),
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
    evidence?.tokenFreeReadiness !== true
    || evidence?.preActivationLookupRefused !== true
    || evidence?.preActivationCredentialReleased !== false
    || evidence?.preActivationUpstreamAttempted !== false
  ) {
    fail('packed_managed_provider_wrapper_conformance_mismatch');
  }
}

function validateManagedSequence(evidence) {
  if (
    evidence?.freshSession !== true
    || evidence?.agentId !== 'opencode'
    || evidence?.canonicalSessionIdBeforeWebhook !== null
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
      > timeline.canonicalWebhookAcknowledgedAtMs
    || timeline.freshSpawnStartedAtMs > timeline.capabilitiesActivatedAtMs
    || timeline.capabilitiesActivatedAtMs > timeline.canonicalWebhookAcknowledgedAtMs
    || timeline.capabilitiesActivatedAtMs > timeline.spawnAcknowledgedAtMs
    || timeline.canonicalWebhookAcknowledgedAtMs > timeline.spawnAcknowledgedAtMs
    || timeline.canonicalWebhookAcknowledgedAtMs > timeline.agentRequestAuthLookupAtMs
    || timeline.canonicalWebhookAcknowledgedAtMs > timeline.managedRequestAuthLookupAtMs
    || timeline.agentRequestAuthLookupAtMs
      > timeline.agentRequestAuthLookupCompletedAtMs
    || timeline.managedRequestAuthLookupAtMs
      > timeline.managedRequestAuthLookupCompletedAtMs
    || timeline.agentRequestAuthLookupCompletedAtMs
      > timeline.providerAttemptAtMs
    || timeline.managedRequestAuthLookupCompletedAtMs
      > timeline.providerAttemptAtMs
  ) {
    fail('packed_managed_provider_sequence_mismatch');
  }
  if (
    evidence.preActivationCredentialReleased !== false
    || evidence.preActivationUpstreamAttempted !== false
    || evidence.preActivationAgentCapabilityPresent !== false
  ) {
    fail('packed_managed_provider_pre_activation_effect');
  }
  if (
    !Array.isArray(evidence.capabilityScopeDigests)
    || evidence.capabilityScopeDigests.length !== 2
    || evidence.capabilityScopeDigests.some((value) =>
      !/^[a-f0-9]{64}$/u.test(value))
    || new Set(evidence.capabilityScopeDigests).size !== 2
  ) {
    fail('packed_managed_provider_missing_agent_request_auth');
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
    || !/^connection-security:v1:[A-Za-z0-9_-]{43}$/u.test(
      evidence.managedConnectionSecurityFingerprint,
    )
    || typeof evidence.upstreamRequestPath !== 'string'
    || !evidence.upstreamRequestPath.startsWith('/backend-api/codex/')
  ) {
    fail('packed_managed_provider_managed_origin_mismatch');
  }
  if (
    typeof evidence.currentCredentialRevision !== 'string'
    || evidence.managedLeaseCredentialRevision
      !== evidence.currentCredentialRevision
    || typeof evidence.currentAccessTokenFingerprint !== 'string'
    || !/^sha256:[a-f0-9]{64}$/u.test(
      evidence.currentAccessTokenFingerprint,
    )
    || evidence.managedLeaseAccessTokenFingerprint
      !== evidence.currentAccessTokenFingerprint
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
    || evidence?.wrapperStopped !== true
    || evidence?.capabilityRetired !== true
    || evidence?.materializationRemoved !== true
  ) {
    fail('packed_managed_provider_activation_failure_cleanup_mismatch');
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
      wrapperExecutable: prepared.wrapperExecutable,
    }));

    const wrapperConformance = await deps.runPackagedWrapperConformance({
      ...input,
      prepared,
    });
    validateWrapperConformance(wrapperConformance);
    stages.push(stage('packaged-wrapper-token-free-conformance'));

    const managed = await deps.runFreshManagedSequence({
      ...input,
      prepared,
    });
    validateManagedSequence(managed);
    stages.push(stage('isolated-runtime'));
    stages.push(stage('fresh-managed-spawn', 'passed', {
      agentId: managed.agentId,
    }));
    stages.push(stage('pre-activation-request-auth-refusal'));
    stages.push(stage('canonical-session-created', 'passed', {
      sessionId: managed.canonicalSessionId,
    }));
    stages.push(stage('exact-purpose-capabilities-activated', 'passed', {
      purposes: managed.purposes,
      subjectScopeDigests: managed.capabilityScopeDigests,
      timeline: managed.timeline,
    }));
    stages.push(stage('webhook-ack-before-first-input'));
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
    stages.push(stage('activation-failure-cleanup'));

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

function runCli() {
  const parsed = parsePackedManagedProviderArgs(process.argv.slice(2));
  const packageRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
  if (parsed.mode === 'recipe') {
    process.stdout.write(`${JSON.stringify(buildPackedManagedProviderRecipe({ packageRoot }), null, 2)}\n`);
    return;
  }
  const result = spawnSync(
    process.execPath,
    [
      resolve(packageRoot, 'scripts/runTsxEntrypoint.mjs'),
      'src/plugin-platform/runPackedManagedProviderVertical.ts',
      '--candidate',
      parsed.candidateManifestPath,
      ...(parsed.workRoot ? ['--work-root', parsed.workRoot] : []),
    ],
    {
      cwd: packageRoot,
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
