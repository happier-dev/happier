import { once } from 'node:events';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmod,
  copyFile,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
  mkdir,
  open,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  readProcessIdentityByPid,
} from '../../../../apps/cli/src/daemon/processIdentity';
import {
  listProcessSnapshot,
} from '../../../../apps/cli/src/daemon/processSnapshotCache';
import {
  buildConnectedServiceCredentialRecord,
  CONNECTED_ACCOUNT_REQUEST_AUTH_LOOKUP_PATH,
  DaemonPluginUiResourceReadResponseSchema,
  DaemonPluginUiResourceWatchCloseResponseSchema,
  DaemonPluginUiResourceWatchNextResponseSchema,
  DaemonPluginUiResourceWatchOpenResponseSchema,
  ExternalSessionMaterializeActionResultV1Schema,
  ExternalSessionOperationActionResultV1Schema,
  ExternalSessionOperationReferenceV1Schema,
  ExternalSessionRefSchema,
  ProviderConnectionIdSchema,
  RestartSessionRunnerResultV1Schema,
  sealAccountScopedBlobCiphertext,
  SessionRunnerRuntimeStateV1Schema,
} from '@happier-dev/protocol';
import {
  PLUGIN_ACTION_OUTPUT_SCHEMAS,
} from '@happier-dev/protocol/actions';
import {
  DaemonProviderConnectionMutationResponseV1Schema,
  DaemonProviderConnectionsDescribeResponseV1Schema,
  DaemonProviderModelsResponseV1Schema,
  DaemonProviderProbeResponseV1Schema,
  RPC_METHODS,
  type DaemonProviderConnectionViewV1,
} from '@happier-dev/protocol/rpc';
import {
  readConnectedAccountRequestAuthCapabilityFile,
  type ConnectedAccountRequestAuthCapabilityDocumentV2,
} from '@happier-dev/agents/request-auth';
import {
  CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_HEADER,
} from '@happier-dev/protocol/connect/connected-account-request-auth';
import type {
  PackedChannelProviderLifecycleEvidence,
  PackedManagedProviderPreparedInput,
} from '../../scripts/plugin-platform/run-packed-managed-provider.mjs';
import { createTestAuth, type TestAuth } from '../testkit/auth';
import { seedCliAuthForServer } from '../testkit/cliAuth';
import {
  resolveObservedProcessExecutablePath,
} from '../testkit/providers/identity/processCommand';
import {
  startConnectedAccountTlsRecordingProxy,
  type ConnectedAccountTlsRecordingProxy,
  type RecordedConnectedAccountTlsRequest,
} from '../testkit/providers/connectedAccountTlsRecordingProxy';
import { daemonControlPostJson } from '../testkit/daemon/controlServerClient';
import {
  readDaemonState,
  startTestDaemon,
  sanitizeDaemonEnvForSpawn,
  type DaemonState,
  type StartedDaemon,
} from '../testkit/daemon/daemon';
import { fetchJson } from '../testkit/http';
import {
  startHttpRequestRecordingProxy,
  type HttpRequestRecordingProxy,
  type RecordedHttpProxyRequest,
} from '../testkit/httpRequestRecordingProxy';
import {
  startServerLight,
  type StartedServer,
} from '../testkit/process/serverLight';
import {
  collectDescendantPids,
  isProcessAlive,
} from '../testkit/process/processTree';
import { sleep, waitFor } from '../testkit/timing';
import { postEncryptedUiTextMessage } from '../testkit/uiMessages';
import { callEncryptedMachineRpc } from '../testkit/memoryRpc';
import {
  createUserScopedSocketCollector,
  type SocketCollector,
} from '../testkit/socketClient';
import {
  materializePackedCli,
  parseSuccessfulCommandEnvelope,
  readPackedPackageManifest,
  runPackedCliJson,
  runPackedReviewedPluginInstall,
  sanitizePackedAuthorArtifactEnv,
  startCandidateRegistry,
  type PackedPluginInstallReview,
} from '../../scripts/plugin-platform/run-packed-author-ui-compat.mjs';
import { exportPackSandboxTarball } from '../../../../apps/stack/scripts/pack.mjs';
import {
  redactHarnessLogText,
} from '../testkit/process/harnessLogRedaction';
import {
  resolveCliTestLaunchSpec,
  type CliTestLaunchSpec,
} from '../testkit/process/cliLaunchSpec';
import type {
  RetainedPluginLifecycleManifestEvidence,
} from '../testkit/manifest';
import {
  decideAuthenticatedPluginInstallReview,
} from '../testkit/pluginPlatform/authenticatedInstallReview';
import {
  projectRetainedPluginLifecycleEvidence,
  waitForRunnerDaemonServiceAuthority,
  type RunnerDaemonServiceAuthority,
} from '../testkit/providers/harness/daemonRunnerContinuity';
import {
  extractAssistantCandidateTextsFromDecryptedRecord,
  waitForAssistantMessageContaining,
} from '../testkit/providers/scenarios/sessionRuntime';
import { decryptLegacyBase64 } from '../testkit/messageCrypto';
import { fetchAllMessages, fetchSessionV2 } from '../testkit/sessions';
import {
  normalizeDecodedTranscriptValue,
} from '../testkit/providers/normalizeDecodedTranscriptValue';
import {
  readCompletedTurnId,
} from '../testkit/providers/harness/harnessSignals';
import {
  createArchiveBoundPackedChannelProviderFixture,
} from './archiveBoundChannelProviderFixture.mjs';
import {
  startPackedChannelProviderLoopback,
} from './packedChannelProviderLoopback.mjs';

export { createArchiveBoundPackedChannelProviderFixture } from './archiveBoundChannelProviderFixture.mjs';
import type {
  PackedManagedProviderActivationFailureObservation,
  PackedManagedProviderFreshSpawnObservation,
} from './packedManagedProviderLiveScenario';
import type {
  PackedManagedProviderFailureDiagnostics,
} from './runPackedManagedProviderVertical';

const CONNECTION_ID = ProviderConnectionIdSchema.parse(
  'pc_packed_cliproxyapi',
);
const CONTRIBUTION_KEY = 'happier.provider.cliproxyapi/cliproxyapi';
const AGENT_TARGET_KEY = 'backend:opencode';
const MODEL_ID = 'gpt-5.5';
const STOCK_CLIPROXYAPI_PORT = 8317 as const;
const OPENAI_PURPOSE = Object.freeze({
  consumer: Object.freeze({
    pluginId: 'happier.provider.cliproxyapi',
    localId: 'cliproxyapi',
  }),
  purpose: 'openai-upstream',
});
const OPENCODE_PURPOSE = Object.freeze({
  consumer: Object.freeze({
    pluginId: 'happier.agent.opencode',
    localId: 'opencode',
  }),
  purpose: 'openai-codex-model-request',
});
const CANDIDATE_HANDOFF_AGENT_PLUGIN_ID =
  'acme.packed-managed-public-agent';
const CANDIDATE_HANDOFF_PROVIDER_PLUGIN_ID =
  'acme.packed-managed-public-provider';
const CANDIDATE_HANDOFF_AGENT_ID = 'packed-managed-public-agent';
const CANDIDATE_HANDOFF_PROVIDER_ID = 'gateway';
const CANDIDATE_HANDOFF_PROVIDER_CONTRIBUTION_KEY =
  `${CANDIDATE_HANDOFF_PROVIDER_PLUGIN_ID}/${CANDIDATE_HANDOFF_PROVIDER_ID}`;
const CANDIDATE_HANDOFF_CONNECTION_ID = ProviderConnectionIdSchema.parse(
  'pc_packed_public_handoff',
);
const CANDIDATE_HANDOFF_MODEL_ID = 'gpt-packed-public-handoff';
const CANDIDATE_HANDOFF_AGENT_TARGET_KEY =
  `backend:${CANDIDATE_HANDOFF_AGENT_ID}`;
const CANDIDATE_HANDOFF_PROVIDER_BINARY_NAME =
  'happier-cliproxyapi-managed';
const CANDIDATE_HANDOFF_PROVIDER_SERVICE_ID =
  'packed-public-provider-managed';
const CANDIDATE_HANDOFF_PROVIDER_ENDPOINT_ID = 'responses';
const CANDIDATE_HANDOFF_PROVIDER_BEARER_ENV =
  'PACKED_PUBLIC_PROVIDER_BEARER';
const CANDIDATE_HANDOFF_PROVIDER_ENDPOINT_ENV =
  'PACKED_PUBLIC_PROVIDER_ENDPOINT';
const CANDIDATE_HANDOFF_REQUEST_AUTH_CAPABILITY_ENV =
  'HAPPIER_CLIPROXYAPI_REQUEST_AUTH_CAPABILITY_PATH';
const CANDIDATE_HANDOFF_AGENT_CLI_PATH_ENV =
  'HAPPIER_PACKED_MANAGED_PUBLIC_AGENT_PATH';
const PACKED_CHANNEL_PROVIDER_PLUGIN_ID =
  'acme.channels.out-of-tree-socket';
const PACKED_CHANNELS_CORE_PLUGIN_ID = 'happier.channels';
const PACKED_CHANNEL_PROVIDER_CONTRIBUTION_ID = 'fixture-socket';
const PACKED_CHANNEL_PROVIDER_STRICT_RESULT_SENTINEL =
  'packed-channel-provider-strict-result';
const PACKED_CHANNEL_CONNECTION_CREATE_ACTION_ID =
  `${PACKED_CHANNELS_CORE_PLUGIN_ID}/connection/create-v1`;
const PACKED_CHANNEL_CONNECTION_UPDATE_ACTION_ID =
  `${PACKED_CHANNELS_CORE_PLUGIN_ID}/connection/update-v1`;
const PACKED_CHANNEL_CONNECTION_DELETE_ACTION_ID =
  `${PACKED_CHANNELS_CORE_PLUGIN_ID}/connection/delete-v1`;
const PACKED_CHANNEL_BINDING_CREATE_ACTION_ID =
  `${PACKED_CHANNELS_CORE_PLUGIN_ID}/binding/create-v1`;

const candidateHandoffAgentDeclaration = Object.freeze({
  title: 'Packed public Agent',
  runtime: { kind: 'custom' },
  primary: 'sessions',
  cli: {
    executable: {
      binaryName: 'happier',
      sourcePreference: 'system-first',
      acceptsJavaScriptFileOverride: false,
    },
    install: { managed: null, manual: { kind: 'none' } },
    auth: {
      support: 'unsupported',
      loginLaunches: [],
    },
  },
  capabilities: {
    surfaces: ['terminal', 'externalSessions'],
    sessions: {
      open: ['create'],
      delivery: ['newTurn'],
      cancel: false,
    },
  },
  providerRequirements: {
    acceptsProtocols: ['openai-responses'],
    required: { streaming: true, toolRoundTrips: true },
    credentialSupport: {
      supportsNoAuth: true,
      apiKeyTransports: [{
        protocol: 'openai-responses',
        destination: {
          kind: 'httpHeader',
          names: 'anyValidated',
          formats: ['raw', 'bearer'],
        },
      }],
    },
    authIsolation: {
      suppressConnectedServiceIds: [],
      ownedEnvKeys: [
        CANDIDATE_HANDOFF_PROVIDER_BEARER_ENV,
        CANDIDATE_HANDOFF_PROVIDER_ENDPOINT_ENV,
      ],
    },
    materialization: 'spawnEnv',
    applyPolicy: 'restart_session',
    supportsFreeformModelIds: true,
  },
  surfaces: {
    externalSession: {
      externalLinkedTakeover: { writerSafety: 'native_prevention' },
      sources: [{
        sourceKind: 'packedCandidate',
        schema: {
          fields: [
            { kind: 'literal', name: 'kind', value: 'packedCandidate' },
            { kind: 'string', name: 'scope', min: 1, max: 256, nullish: true },
          ],
        },
        key: {
          segments: [
            { kind: 'literal', value: 'packedCandidate' },
            { kind: 'field', field: 'scope' },
          ],
        },
        instances: [{ kind: 'default', constants: {} }],
      }],
    },
  },
});
export type PackedManagedProviderObservedCandidateProcess = Readonly<{
  pid: number;
  processStartTimeMs: number;
  executablePath: string;
  command: string;
}>;

type ObservedCandidateProcess =
  PackedManagedProviderObservedCandidateProcess;

export type PackedManagedProviderProcessStartCollector = Readonly<{
  observe(): Promise<readonly ObservedCandidateProcess[]>;
  snapshot(): readonly ObservedCandidateProcess[];
  stop(): Promise<readonly ObservedCandidateProcess[]>;
}>;

type SeededCredential = Readonly<{
  credentialRevision: string;
  accessTokenFingerprint: string;
  accessToken: string;
}>;

type PrivateCandidateWrapperIdentity = Readonly<{
  pid: number;
  processStartTimeMs: number;
  commandFingerprint: string;
  snapshotFingerprint: string;
}>;

type PrivateRequestAuthLookup = Readonly<{
  status: number;
  credentialRevision: string | null;
  accessTokenFingerprint: string | null;
}>;

type PrivateRequestAuthCapability = Readonly<{
  path: string;
  document: ConnectedAccountRequestAuthCapabilityDocumentV2;
  lookup: PrivateRequestAuthLookup;
}>;

type StockPortObserverSnapshot = Readonly<{
  ownedConnectionAttemptCount: number;
  observedOwnedPids: readonly number[];
}>;

export type PackedManagedProviderStockPortObserver = Readonly<{
  observeOwnedProcess(pid: number): void;
  snapshot(): Promise<StockPortObserverSnapshot>;
  stop(): Promise<StockPortObserverSnapshot>;
}>;

type PublicProviderSetup = Readonly<{
  connection: DaemonProviderConnectionViewV1;
  explicitProcess: ObservedCandidateProcess;
}>;

type ActivePublicSession = Readonly<{
  sessionId: string;
  providerProcess: ObservedCandidateProcess;
  providerProcessStarts: PackedManagedProviderProcessStartCollector;
  promptSentinel: string;
}>;

type CandidateHandoffGeneration = 'G' | 'H' | 'R' | 'P' | 'Q';

type CandidateHandoffCliRunResult = Readonly<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}>;

type CandidateHandoffCliRunner = (input: Readonly<{
  cliEntrypoint: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  args: readonly string[];
}>) => Promise<CandidateHandoffCliRunResult>;

type PackedCliJsonEnvelope = Readonly<{
  data?: unknown;
}>;

type CandidateHandoffAuthoring = Readonly<{
  cliEntrypoint: string;
  env: NodeJS.ProcessEnv;
  fixtureRoot: string;
  agentRoot: string;
  providerRoot: string;
  registry: Readonly<{ origin: string; close(): Promise<void> }>;
  runCli?: CandidateHandoffCliRunner;
}>;

type CandidateHandoffPackedGeneration = Readonly<{
  archivePath: string;
  archiveSha256: string;
  immutableGenerationId: string;
  installedArchiveMatchedPackedBytes: boolean;
}>;

type CandidateHandoffCustody = Readonly<{
  authority: RunnerDaemonServiceAuthority;
  providerImmutableGenerationId: string;
  markerPath: string;
}>;

type CandidateHandoffTurnWitness = Readonly<{
  sessionId: string;
  sentinel: string;
  expectedAgentGeneration: 'G' | 'H';
  completedTurnId: string;
}>;

type CandidateHandoffTurnObservation = Readonly<{
  completedTurnId: string;
  witness: CandidateHandoffTurnWitness;
  evidence: PackedManagedProviderExactlyOnceTurnEvidence;
}>;

type CandidateHandoffSession = Readonly<{
  active: ActivePublicSession;
  custody: CandidateHandoffCustody;
  firstTurn: PackedManagedProviderExactlyOnceTurnEvidence;
  firstTurnWitness: CandidateHandoffTurnWitness;
  firstCompletedTurnId: string;
  descendantPids: readonly number[];
  capabilityPaths: readonly string[];
}>;

type CandidateHandoffExternalSessionsPublicPhase = Readonly<{
  generation: 'G' | 'H';
  phase: 'snapshot' | 'final';
  candidate: Readonly<{
    agentId: string;
    sourceId: string;
    remoteSessionId: string;
  }>;
  publicRef: Readonly<{
    agentId: string;
    sourceId: string;
    remoteSessionId: string;
  }>;
  capabilities: CandidateHandoffExternalSessionsCapabilities;
  candidateTitle: string | null;
  candidateCursor: string | null;
  transcriptItemId: string | null;
  tailCursor: string | null;
  follow: Readonly<{
    startingCursor: string | null;
    events: readonly string[];
    itemId: string | null;
    listenerSettled: boolean;
    disposedTerminalAcknowledgements: number;
    postTerminalEventCount: number;
    disposed: boolean;
  }>;
  attachedSessionId?: string;
  backgroundFollowEnabled?: unknown;
  backgroundFollowDisabled?: unknown;
  takeover?: unknown;
  materialize?: unknown;
  status?: unknown;
  recovery?: unknown;
  handoff?: Readonly<{
    publicGCursorRetirementCode: string | null;
    publicGFollowCursorRetirementCode: string | null;
    publicGFollow: Readonly<{
      dataEventCount: number;
      terminalAcknowledgements: number;
      postTerminalEventCount: number;
    }>;
  }>;
}>;

export type PackedCurrentSourceExternalSessionsObservation = Readonly<{
  sourceCli: 'source-snapshot';
  archives: Readonly<{
    agentGPackedAndReviewed: true;
    agentHPackedAndReviewed: true;
  }>;
  publicExternalSessions: Readonly<{
    currentGeneration: 'H';
    publicGRefRoutedToH: true;
    publicGListCursorRetired: true;
    publicGFollowCursorRetired: true;
    recipientSafeProjection: true;
  }>;
}>;

export const PACKED_CURRENT_SOURCE_EXTERNAL_SESSIONS_STAGES = [
  'input-root',
  'directories',
  'server',
  'auth-seed',
  'cli-snapshot',
  'daemon',
  'sdk-registry',
  'plugins-create',
  'author-source',
  'author-install',
  'generation-g',
  'public-g',
  'generation-h',
  'public-h',
  'handoff-contract',
  'cleanup',
] as const;

export type PackedCurrentSourceExternalSessionsStage =
  (typeof PACKED_CURRENT_SOURCE_EXTERNAL_SESSIONS_STAGES)[number];

export class PackedCurrentSourceExternalSessionsExecutionError extends Error {
  readonly stage: PackedCurrentSourceExternalSessionsStage;

  constructor(input: Readonly<{
    stage: PackedCurrentSourceExternalSessionsStage;
    cause: unknown;
  }>) {
    super('packed_current_source_external_sessions_execution_failed', {
      cause: input.cause,
    });
    this.name = 'PackedCurrentSourceExternalSessionsExecutionError';
    this.stage = input.stage;
  }
}

type CandidateHandoffExternalSessionsCapabilities = Readonly<{
  list: Readonly<{ status: 'available' }>;
  attach: Readonly<{ status: 'available' }>;
  takeover: Readonly<{
    status: 'available';
    storageModes: readonly ['external-linked', 'persisted'];
  }>;
  transcript: Readonly<{ status: 'available' }>;
  follow: Readonly<{ status: 'available' }>;
}>;

type InitializedRuntime = {
  inputRoot: string;
  testDir: string;
  happyHomeDir: string;
  workspaceDir: string;
  openCodeStateDir: string;
  server: StartedServer;
  serverProxy: HttpRequestRecordingProxy;
  connectProxy: TlsRecordingProxy;
  trustedCertificatePath: string;
  auth: TestAuth;
  accountSecret: Uint8Array;
  machineId: string;
  daemon: StartedDaemon;
  currentDaemonState: DaemonState;
  daemonEnv: NodeJS.ProcessEnv;
  credential: SeededCredential;
  ui: SocketCollector;
  stockListenerBefore: StockListenerSnapshot;
  stockPortObserver: PackedManagedProviderStockPortObserver;
  providerSetup: PublicProviderSetup | null;
  activeSession: ActivePublicSession | null;
  candidateHandoffSessions: ActivePublicSession[];
};

type StoppableRuntimeResource = Readonly<{
  stop(): Promise<unknown>;
}>;

export type PackedManagedProviderRuntimeResources = Readonly<{
  ui?: Readonly<{ close(): void }> | null;
  daemon?: StoppableRuntimeResource | null;
  serverProxy?: StoppableRuntimeResource | null;
  connectProxy?: StoppableRuntimeResource | null;
  server?: StoppableRuntimeResource | null;
  stockPortObserver?: StoppableRuntimeResource | null;
}>;

export type PackedManagedProviderCleanupTask = Readonly<{
  run(): unknown | Promise<unknown>;
}>;

async function collectPackedManagedProviderCleanupErrors(
  tasks: readonly PackedManagedProviderCleanupTask[],
): Promise<unknown[]> {
  const errors: unknown[] = [];
  for (const task of tasks) {
    try {
      await task.run();
    } catch (error) {
      if (error instanceof AggregateError) errors.push(...error.errors);
      else errors.push(error);
    }
  }
  return errors;
}

export async function cleanupPackedManagedProviderTasks(
  tasks: readonly PackedManagedProviderCleanupTask[],
): Promise<void> {
  const errors = await collectPackedManagedProviderCleanupErrors(tasks);
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      'packed managed composed runtime cleanup failed',
    );
  }
}

export async function cleanupPackedManagedProviderRuntimeResources(
  resources: PackedManagedProviderRuntimeResources,
): Promise<void> {
  await cleanupPackedManagedProviderTasks([
    { run: () => resources.ui?.close() },
    ...[
      resources.daemon,
      resources.serverProxy,
      resources.connectProxy,
      resources.server,
      resources.stockPortObserver,
    ].filter((resource): resource is StoppableRuntimeResource => resource !== null
      && resource !== undefined)
      .map((resource) => ({ run: async () => await resource.stop() })),
  ]);
}

const DAEMON_FAILURE_LOG_READ_LIMIT_BYTES = 8_192;
const DAEMON_FAILURE_LOG_TAIL_LIMIT = 4_000;

function redactDaemonFailureLogText(raw: string): string {
  return redactHarnessLogText(raw)
    .split(/\r?\n/u)
    .map((line) => {
      if (
        /\b(?:config|configuration|env|environment)\s*[:=]/iu.test(line)
      ) {
        return '[REDACTED config/environment diagnostic line]';
      }
      return line.replace(
        /(\b[A-Z][A-Z0-9_]{2,}\s*=).*/u,
        '$1[REDACTED]',
      );
    })
    .join('\n');
}

async function readSecretSafeDaemonFailureLog(
  path: string,
): Promise<Readonly<{ byteCount: number; tail: string | null }>> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(path, 'r');
    const { size } = await handle.stat();
    const length = Math.min(size, DAEMON_FAILURE_LOG_READ_LIMIT_BYTES);
    const bytes = Buffer.alloc(length);
    if (length > 0) {
      await handle.read(bytes, 0, length, size - length);
    }
    const rawTail = bytes.toString('utf8');
    const safeTail = size > length
      ? (() => {
          const firstLineBreak = /\r\n|\r|\n/u.exec(rawTail);
          return firstLineBreak
            ? rawTail.slice(firstLineBreak.index + firstLineBreak[0].length)
            : '';
        })()
      : rawTail;
    const redacted = redactDaemonFailureLogText(
      safeTail,
    ).trim();
    return {
      byteCount: size,
      tail: redacted.length > 0
        ? redacted.slice(-DAEMON_FAILURE_LOG_TAIL_LIMIT)
        : null,
    };
  } catch {
    return { byteCount: 0, tail: null };
  } finally {
    await handle?.close().catch(() => {});
  }
}

function readDiagnosticMatch(
  message: string,
  pattern: RegExp,
): string | null {
  return pattern.exec(message)?.[1] ?? null;
}

function readDiagnosticBoolean(
  message: string,
  key: string,
): boolean | null {
  const value = readDiagnosticMatch(
    message,
    new RegExp(`\\b${key}=(yes|no)\\b`, 'u'),
  );
  return value === 'yes' ? true : value === 'no' ? false : null;
}

function readDiagnosticInteger(
  message: string,
  pattern: RegExp,
): number | null {
  const value = readDiagnosticMatch(message, pattern);
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export type PackedManagedProviderCandidateDaemonStartupError = Error & {
  readonly packedManagedProviderFailureDiagnostics:
    PackedManagedProviderFailureDiagnostics;
};

export async function createPackedManagedProviderCandidateDaemonStartupError(
  input: Readonly<{
    cause: unknown;
    stdoutPath: string;
    stderrPath: string;
  }>,
): Promise<PackedManagedProviderCandidateDaemonStartupError> {
  const message = input.cause instanceof Error
    ? input.cause.message
    : String(input.cause);
  const exitCode = readDiagnosticInteger(
    message,
    /Daemon exited before writing daemon\.state\.json \(code=(-?\d+)\)/u,
  );
  const signalCode = readDiagnosticMatch(
    message,
    /Daemon exited before writing daemon\.state\.json \(signal=([A-Z0-9]+)\)/u,
  );
  const code = exitCode !== null || signalCode !== null
    ? 'packed_managed_provider_candidate_daemon_exited_before_state'
    : message.includes('Timed out during daemon startup')
      ? 'packed_managed_provider_candidate_daemon_startup_timed_out'
      : 'packed_managed_provider_candidate_daemon_startup_failed';
  const [stdout, stderr] = await Promise.all([
    readSecretSafeDaemonFailureLog(input.stdoutPath),
    readSecretSafeDaemonFailureLog(input.stderrPath),
  ]);
  const packedManagedProviderFailureDiagnostics:
    PackedManagedProviderFailureDiagnostics = {
      schemaVersion: 1,
      code,
      phase: readDiagnosticMatch(message, /\bphase=([A-Za-z][A-Za-z0-9]*)\b/u),
      process: {
        exitCode,
        signalCode,
      },
      daemonState: {
        everWritten: readDiagnosticBoolean(
          message,
          'daemonStateEverWritten',
        ),
        everRemoved: readDiagnosticBoolean(
          message,
          'daemonStateEverRemoved',
        ),
        lastCandidateCount: readDiagnosticInteger(
          message,
          /\bdaemonStateLastCandidateCount=(\d+)\b/u,
        ),
      },
      logs: {
        stdout,
        stderr,
      },
    };
  return Object.assign(
    new Error(code, { cause: input.cause }),
    { packedManagedProviderFailureDiagnostics },
  );
}

const CANDIDATE_DAEMON_EXITED_BEFORE_CONTROL_READY =
  'packed_managed_provider_candidate_daemon_exited_before_control_ready';

export function assertPackedManagedProviderCandidateDaemonRunning(
  outcome: Readonly<{
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
  }>,
): void {
  if (outcome.exitCode !== null || outcome.signalCode !== null) {
    throw new Error(CANDIDATE_DAEMON_EXITED_BEFORE_CONTROL_READY);
  }
}

type RecordedTlsUpstreamRequest = RecordedConnectedAccountTlsRequest;
type TlsRecordingProxy = ConnectedAccountTlsRecordingProxy;

type StockListenerSnapshot = Readonly<{
  port: 8317;
  identity: string;
}>;

function assert(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code);
}

type PackedChannelProviderLoopback = Readonly<{
  origin: string;
  socketUrl: string;
  pairingCode: string;
  caCertificatePath: string;
  observerSocketCount(): number;
  receivedFrameKinds(): readonly string[];
  sendObservation(): void;
  sendHistoryGap(): void;
  closeObserverSockets(): void;
  waitForObserverSocketCount(
    expected: number,
    context: string,
  ): Promise<void>;
  stop(): Promise<void>;
}>;

function captureStockListenerSnapshot(): StockListenerSnapshot {
  let command: string;
  let args: string[];
  if (process.platform === 'win32') {
    command = join(
      process.env.SystemRoot ?? 'C:\\Windows',
      'System32',
      'netstat.exe',
    );
    args = ['-ano', '-p', 'tcp'];
  } else {
    command = [
      '/usr/sbin/lsof',
      '/usr/bin/lsof',
    ].find((candidate) => existsSync(candidate)) ?? '';
    args = [
      '-nP',
      `-iTCP:${STOCK_CLIPROXYAPI_PORT}`,
      '-sTCP:LISTEN',
      '-Fpcfn',
    ];
  }
  assert(
    command.length > 0 && existsSync(command),
    'packed_managed_provider_stock_listener_inspector_unavailable',
  );
  const observed = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
  });
  if (
    observed.error
    || (
      process.platform === 'win32'
        ? observed.status !== 0
        : (
            observed.status !== 0
            && observed.status !== 1
          )
          || (observed.status === 1 && observed.stderr.trim().length > 0)
    )
  ) {
    throw new Error(
      'packed_managed_provider_stock_listener_inspection_failed',
      { cause: observed.error ?? observed.stderr },
    );
  }
  const normalized = observed.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => (
      line.length > 0
      && (
        process.platform !== 'win32'
        || (
          /\sLISTENING\s/iu.test(` ${line} `)
          && new RegExp(
            String.raw`(?:^|\s)(?:\[[^\]]+\]|[^:\s]+):${STOCK_CLIPROXYAPI_PORT}(?:\s|$)`,
            'u',
          ).test(line)
        )
      )
    ))
    .sort()
    .join('\n');
  return {
    port: STOCK_CLIPROXYAPI_PORT,
    identity: fingerprintSecret(normalized || 'absent'),
  };
}

type ObservedTcpConnection = Readonly<{
  pid: number;
  endpoint: string;
  state: string;
}>;

async function runPassiveNetworkCommand(
  command: string,
  args: readonly string[],
): Promise<Readonly<{
  status: number | null;
  stdout: string;
  stderr: string;
}>> {
  return await new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(command, [...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
    }, 10_000);
    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      rejectCommand(error);
    });
    child.once('close', (status) => {
      clearTimeout(timeout);
      resolveCommand({
        status,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

function parseLsofTcpConnections(
  stdout: string,
  port: number,
): readonly ObservedTcpConnection[] {
  const connections: ObservedTcpConnection[] = [];
  let pid: number | null = null;
  let endpoint: string | null = null;
  let state: string | null = null;
  const flush = () => {
    if (
      pid !== null
      && endpoint
      && state !== 'LISTEN'
      && (
        endpoint.includes(`:${port}`)
        || endpoint.includes(`.${port}`)
      )
    ) {
      connections.push({
        pid,
        endpoint,
        state: state ?? '',
      });
    }
    endpoint = null;
    state = null;
  };
  for (const line of stdout.split(/\r?\n/u)) {
    if (line.startsWith('p')) {
      flush();
      const parsed = Number.parseInt(line.slice(1), 10);
      pid = Number.isInteger(parsed) && parsed > 0 ? parsed : null;
    } else if (line.startsWith('f')) {
      flush();
    } else if (line.startsWith('n')) {
      endpoint = line.slice(1).trim();
    } else if (line.startsWith('TST=')) {
      state = line.slice(4).trim().toUpperCase();
    }
  }
  flush();
  return connections;
}

function parseNetstatTcpConnections(
  stdout: string,
  port: number,
): readonly ObservedTcpConnection[] {
  const connections: ObservedTcpConnection[] = [];
  for (const rawLine of stdout.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!/^tcp/u.test(line)) continue;
    const columns = line.split(/\s+/u);
    const local = columns[3] ?? '';
    const remote = columns[4] ?? '';
    const state = (columns[5] ?? '').toUpperCase();
    if (
      state === 'LISTEN'
      || state === 'LISTENING'
      || (
        !local.includes(`.${port}`)
        && !local.includes(`:${port}`)
        && !remote.includes(`.${port}`)
        && !remote.includes(`:${port}`)
      )
    ) {
      continue;
    }
    const namedProcessColumn = columns
      .slice(6)
      .find((column) => /:\d+$/u.test(column));
    const namedProcessMatch = namedProcessColumn
      ? /:(\d+)$/u.exec(namedProcessColumn)
      : null;
    const trailingPid = /^\d+$/u.test(columns.at(-1) ?? '')
      ? columns.at(-1)
      : null;
    const pid = Number.parseInt(
      namedProcessMatch?.[1] ?? trailingPid ?? '',
      10,
    );
    if (!Number.isInteger(pid) || pid <= 0) continue;
    connections.push({
      pid,
      endpoint: `${local}->${remote}`,
      state,
    });
  }
  return connections;
}

async function captureStockTcpConnections(
  port: number,
  includeClosedKernelRows: boolean,
): Promise<readonly ObservedTcpConnection[]> {
  if (process.platform === 'win32') {
    const command = join(
      process.env.SystemRoot ?? 'C:\\Windows',
      'System32',
      'netstat.exe',
    );
    const observed = await runPassiveNetworkCommand(
      command,
      ['-ano', '-p', 'tcp'],
    );
    assert(
      observed.status === 0,
      'packed_managed_provider_stock_network_observer_failed',
    );
    return parseNetstatTcpConnections(observed.stdout, port);
  }

  const lsof = [
    '/usr/sbin/lsof',
    '/usr/bin/lsof',
  ].find((candidate) => existsSync(candidate)) ?? '';
  assert(
    lsof.length > 0,
    'packed_managed_provider_stock_network_observer_unavailable',
  );
  const live = await runPassiveNetworkCommand(
    lsof,
    ['-nP', `-iTCP:${port}`, '-FpcfnT'],
  );
  assert(
    live.status === 0 || live.status === 1,
    'packed_managed_provider_stock_network_observer_failed',
  );
  const connections = [...parseLsofTcpConnections(live.stdout, port)];
  if (includeClosedKernelRows && process.platform === 'darwin') {
    const netstat = await runPassiveNetworkCommand(
      '/usr/sbin/netstat',
      ['-anv', '-p', 'tcp'],
    );
    assert(
      netstat.status === 0,
      'packed_managed_provider_stock_network_observer_failed',
    );
    connections.push(
      ...parseNetstatTcpConnections(netstat.stdout, port),
    );
  }
  return connections;
}

export async function startPackedManagedProviderStockPortObserver(
  params: Readonly<{
    port: number;
    initialOwnedPids?: readonly number[];
  }>,
): Promise<PackedManagedProviderStockPortObserver> {
  assert(
    Number.isInteger(params.port) && params.port > 0,
    'packed_managed_provider_stock_network_observer_port_invalid',
  );
  const ownedRoots = new Set<number>();
  const ownedPids = new Set<number>();
  const observedConnections = new Map<string, ObservedTcpConnection>();
  let stopped = false;
  let captureInFlight: Promise<void> | null = null;
  let pollingError: unknown = null;

  const observeOwnedProcess = (pid: number): void => {
    if (!Number.isInteger(pid) || pid <= 0) return;
    ownedRoots.add(pid);
    ownedPids.add(pid);
    for (const descendant of collectDescendantPids(pid)) {
      ownedPids.add(descendant);
    }
  };
  for (const pid of params.initialOwnedPids ?? []) {
    observeOwnedProcess(pid);
  }

  const capture = async (includeClosedKernelRows: boolean): Promise<void> => {
    if (captureInFlight) {
      await captureInFlight;
    }
    const operation = (async () => {
      for (const root of ownedRoots) {
        observeOwnedProcess(root);
      }
      const connections = await captureStockTcpConnections(
        params.port,
        includeClosedKernelRows,
      );
      for (const connection of connections) {
        observedConnections.set(
          `${connection.pid}:${connection.endpoint}:${connection.state}`,
          connection,
        );
      }
    })();
    captureInFlight = operation;
    try {
      await operation;
    } finally {
      if (captureInFlight === operation) captureInFlight = null;
    }
  };
  const result = (): StockPortObserverSnapshot => {
    const observedOwnedPids = [...ownedPids].sort((left, right) => left - right);
    const ownedConnectionAttemptCount = [
      ...observedConnections.values(),
    ].filter((connection) => ownedPids.has(connection.pid)).length;
    return {
      ownedConnectionAttemptCount,
      observedOwnedPids,
    };
  };
  const polling = (async () => {
    while (!stopped) {
      await capture(false);
      if (!stopped) {
        await new Promise<void>((resolveDelay) => {
          setTimeout(resolveDelay, 100);
        });
      }
    }
  })().catch((error) => {
    pollingError = error;
  });

  await capture(false);
  return {
    observeOwnedProcess,
    snapshot: async () => {
      if (pollingError) throw pollingError;
      await capture(true);
      if (pollingError) throw pollingError;
      return result();
    },
    stop: async () => {
      stopped = true;
      await polling;
      if (pollingError) throw pollingError;
      await capture(true);
      return result();
    },
  };
}

function fingerprintSecret(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function connectTargetForRequestAuthOrigin(origin: string): string {
  const parsed = new URL(origin);
  assert(
    parsed.protocol === 'https:'
      && parsed.username.length === 0
      && parsed.password.length === 0
      && parsed.pathname === '/'
      && parsed.search.length === 0
      && parsed.hash.length === 0,
    'packed_managed_provider_request_auth_origin_invalid',
  );
  return `${parsed.hostname.toLowerCase()}:${parsed.port || '443'}`;
}

function isManagedCodexUpstreamTarget(
  target: string,
  requestAuthOrigin: string,
): boolean {
  return target.toLowerCase()
    === connectTargetForRequestAuthOrigin(requestAuthOrigin);
}

function isSessionCreationRequest(request: RecordedHttpProxyRequest): boolean {
  return request.method === 'POST'
    && /^\/v1\/sessions(?:\?|$)/u.test(request.path);
}


const MANAGED_REQUEST_AUTH_ORIGIN = 'https://chatgpt.com';

type PublicRpcSchema<T> = Readonly<{
  safeParse(input: unknown):
    | Readonly<{ success: true; data: T }>
    | Readonly<{ success: false; error?: unknown }>;
}>;

async function callProviderRpc<T>(
  runtime: InitializedRuntime,
  method: string,
  req: unknown,
  schema: PublicRpcSchema<T>,
): Promise<T> {
  return await callEncryptedMachineRpc({
    ui: runtime.ui,
    machineId: runtime.machineId,
    method,
    req,
    secret: runtime.accountSecret,
    schema,
    timeoutMs: 60_000,
  });
}

async function seedCredential(params: Readonly<{
  serverBaseUrl: string;
  authToken: string;
  accountSecret: Uint8Array;
}>): Promise<SeededCredential> {
  const accessToken = 'packed-live-' + randomBytes(24).toString('base64url');
  const record = buildConnectedServiceCredentialRecord({
    now: Date.now(),
    serviceId: 'openai-codex',
    profileId: 'work',
    kind: 'oauth',
    expiresAt: Date.now() + 60 * 60 * 1000,
    oauth: {
      accessToken,
      refreshToken: 'packed-refresh-' + randomBytes(24).toString('base64url'),
      idToken: null,
      scope: null,
      tokenType: 'Bearer',
      providerAccountId: 'packed-account',
      providerEmail: 'packed@example.test',
    },
  });
  const ciphertext = sealAccountScopedBlobCiphertext({
    kind: 'connected_service_credential',
    material: { type: 'legacy', secret: params.accountSecret },
    payload: record,
    randomBytes: (length) => randomBytes(length),
  });
  const response = await fetchJson<{
    success?: boolean;
    credentialRevision?: string;
  }>(params.serverBaseUrl
    + '/v2/connect/openai-codex/profiles/work/credential', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + params.authToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      sealed: { format: 'account_scoped_v1', ciphertext },
      metadata: {
        kind: 'oauth',
        providerEmail: 'packed@example.test',
        providerAccountId: 'packed-account',
        expiresAt: record.expiresAt,
      },
    }),
    timeoutMs: 20_000,
  });
  assert(
    response.status === 200
      && response.data?.success === true
      && typeof response.data.credentialRevision === 'string',
    'packed_managed_provider_credential_seed_failed',
  );
  return {
    credentialRevision: response.data.credentialRevision,
    accessTokenFingerprint: fingerprintSecret(accessToken),
    accessToken,
  };
}

function sameCandidateProcess(
  left: ObservedCandidateProcess,
  right: ObservedCandidateProcess,
): boolean {
  return left.pid === right.pid
    && left.processStartTimeMs === right.processStartTimeMs
    && resolve(left.executablePath) === resolve(right.executablePath);
}

async function observeCandidateWrapperIdentity(
  process: ObservedCandidateProcess,
): Promise<PrivateCandidateWrapperIdentity> {
  return {
    pid: process.pid,
    processStartTimeMs: process.processStartTimeMs,
    commandFingerprint: fingerprintSecret(process.command),
    snapshotFingerprint: await sha256File(process.executablePath),
  };
}

function sameCandidateWrapperIdentity(
  left: PrivateCandidateWrapperIdentity,
  right: PrivateCandidateWrapperIdentity,
): boolean {
  return left.pid === right.pid
    && left.processStartTimeMs === right.processStartTimeMs
    && left.commandFingerprint === right.commandFingerprint
    && left.snapshotFingerprint === right.snapshotFingerprint;
}

export function sameCandidateRunnerIdentity(
  left: RunnerDaemonServiceAuthority['runner'],
  right: RunnerDaemonServiceAuthority['runner'],
): boolean {
  return left.pid === right.pid
    && left.processStartTimeMs === right.processStartTimeMs
    && left.processCommandHash === right.processCommandHash
    && left.snapshotIdentity === right.snapshotIdentity;
}

function candidateProcessStartKey(
  process: ObservedCandidateProcess,
): string {
  return String(process.pid) + ':' + String(process.processStartTimeMs);
}

function fingerprintCandidateProcess(
  process: ObservedCandidateProcess,
): string {
  return fingerprintSecret(JSON.stringify({
    pid: process.pid,
    processStartTimeMs: process.processStartTimeMs,
    executablePath: process.executablePath,
  }));
}

export async function startPackedManagedProviderProcessStartCollector(
  input: Readonly<{
    baseline: readonly ObservedCandidateProcess[];
    sample: () => Promise<readonly ObservedCandidateProcess[]>;
    observeRelatedProcesses?: () => Promise<void>;
    intervalMs?: number;
  }>,
): Promise<PackedManagedProviderProcessStartCollector> {
  const baselineKeys = new Set(input.baseline.map(candidateProcessStartKey));
  const observed = new Map<string, ObservedCandidateProcess>();
  const intervalMs = input.intervalMs ?? 25;
  let stopped = false;
  let observationError: unknown = null;
  let queued: Promise<void> = Promise.resolve();
  let stopPromise: Promise<readonly ObservedCandidateProcess[]> | null = null;

  const snapshot = (): readonly ObservedCandidateProcess[] =>
    [...observed.values()].sort((left, right) =>
      left.processStartTimeMs - right.processStartTimeMs
      || left.pid - right.pid);
  const observe = async (): Promise<readonly ObservedCandidateProcess[]> => {
    queued = queued.then(async () => {
      if (observationError) return;
      try {
        await input.observeRelatedProcesses?.();
        for (const process of await input.sample()) {
          const key = candidateProcessStartKey(process);
          if (!baselineKeys.has(key)) observed.set(key, process);
        }
      } catch (error) {
        observationError = error;
      }
    });
    await queued;
    if (observationError) throw observationError;
    return snapshot();
  };

  await observe();
  const sampling = (async () => {
    while (!stopped) {
      await sleep(intervalMs);
      if (stopped) break;
      try {
        await observe();
      } catch {
        break;
      }
    }
  })();

  return {
    observe,
    snapshot,
    stop: async () => {
      stopPromise ??= (async () => {
        try {
          await observe();
        } finally {
          stopped = true;
          await sampling;
        }
        if (observationError) throw observationError;
        return snapshot();
      })();
      return await stopPromise;
    },
  };
}

async function listCandidateWrapperProcesses(
  input: PackedManagedProviderPreparedInput,
): Promise<readonly ObservedCandidateProcess[]> {
  const expectedPath = resolve(input.prepared.wrapperExecutable);
  const expectedName = basename(expectedPath).toLowerCase();
  const result: ObservedCandidateProcess[] = [];
  for (const entry of await listProcessSnapshot({ ttlMs: 0 })) {
    const command = String(entry.cmd ?? '').trim();
    const name = String(entry.name ?? '').trim().toLowerCase();
    if (!command.toLowerCase().includes(expectedName) && name !== expectedName) {
      continue;
    }
    const identity = await readProcessIdentityByPid(entry.pid);
    const processStartTimeMs = identity?.processStartTimeMs;
    const executablePath = identity
      ? resolveObservedProcessExecutablePath(identity.command)
      : null;
    if (
      !identity
      || typeof processStartTimeMs !== 'number'
      || !Number.isInteger(processStartTimeMs)
      || typeof executablePath !== 'string'
      || resolve(executablePath) !== expectedPath
    ) {
      continue;
    }
    result.push({
      pid: identity.pid,
      processStartTimeMs,
      executablePath: resolve(executablePath),
      command: identity.command,
    });
  }
  return result.sort((left, right) => left.pid - right.pid);
}

function waitForNewCandidateProcess(
  collector: PackedManagedProviderProcessStartCollector,
  context: string,
): Promise<ObservedCandidateProcess>;
function waitForNewCandidateProcess(
  input: PackedManagedProviderPreparedInput,
  previous: readonly ObservedCandidateProcess[],
  context: string,
): Promise<ObservedCandidateProcess>;
async function waitForNewCandidateProcess(
  collectorOrInput:
    | PackedManagedProviderProcessStartCollector
    | PackedManagedProviderPreparedInput,
  previousOrContext: readonly ObservedCandidateProcess[] | string,
  explicitContext?: string,
): Promise<ObservedCandidateProcess> {
  const ownsCollector = typeof previousOrContext !== 'string';
  const collector = ownsCollector
    ? await startPackedManagedProviderProcessStartCollector({
        baseline: previousOrContext,
        sample: async () => await listCandidateWrapperProcesses(
          collectorOrInput as PackedManagedProviderPreparedInput,
        ),
      })
    : collectorOrInput as PackedManagedProviderProcessStartCollector;
  const context = ownsCollector
    ? explicitContext ?? 'packed managed Provider process'
    : previousOrContext;
  let observed: ObservedCandidateProcess | null = null;
  try {
    await waitFor(async () => {
      const added = await collector.observe();
      assert(
        added.length <= 1,
        'packed_managed_provider_duplicate_candidate_process_start',
      );
      if (added.length === 0) return false;
      observed = added[0] ?? null;
      return observed !== null;
    }, {
      timeoutMs: 60_000,
      intervalMs: 50,
      failFast: true,
      context,
    });
  } finally {
    if (ownsCollector) {
      assert(
        (await collector.stop()).length <= 1,
        'packed_managed_provider_duplicate_candidate_process_start',
      );
    }
  }
  assert(observed, 'packed_managed_provider_candidate_process_missing');
  return observed;
}

type PublicSessionChild = Readonly<{
  startedBy: string;
  happySessionId: string;
  pid: number;
}>;

async function readPublicSessionChildren(
  runtime: InitializedRuntime,
): Promise<readonly PublicSessionChild[]> {
  const response = await daemonControlPostJson<{
    children?: Array<{
      startedBy?: string;
      happySessionId?: string;
      pid?: number;
    }>;
  }>({
    port: runtime.currentDaemonState.httpPort,
    path: '/list',
    controlToken: runtime.currentDaemonState.controlToken,
    body: {},
    timeoutMs: 10_000,
  });
  assert(
    response.status === 200 && Array.isArray(response.data?.children),
    'packed_managed_provider_public_session_list_failed',
  );
  return response.data.children.flatMap((child) =>
    typeof child.startedBy === 'string'
      && typeof child.happySessionId === 'string'
      && typeof child.pid === 'number'
      ? [{
          startedBy: child.startedBy,
          happySessionId: child.happySessionId,
          pid: child.pid,
        }]
      : []);
}

type RuntimeInitializationOptions = Readonly<{
  additionalTrustedCertificatePaths?: readonly string[];
}>;

async function writePackedManagedProviderTrustedCertificateBundle(input: Readonly<{
  testDir: string;
  certificatePaths: readonly string[];
}>): Promise<string> {
  const certificatePaths = [...new Set(input.certificatePaths)];
  assert(
    certificatePaths.length > 0,
    'packed_managed_provider_trusted_certificate_bundle_empty',
  );
  const certificatePath = join(
    input.testDir,
    'trusted-test-certificates.pem',
  );
  const certificates = await Promise.all(certificatePaths.map(
    async (path) => await readFile(path),
  ));
  await writeFile(
    certificatePath,
    Buffer.concat(certificates.flatMap((certificate) => [
      certificate,
      Buffer.from('\n'),
    ])),
    { mode: 0o600 },
  );
  await chmod(certificatePath, 0o600);
  return certificatePath;
}

async function initializeRuntime(
  input: PackedManagedProviderPreparedInput,
  options: RuntimeInitializationOptions = {},
): Promise<InitializedRuntime> {
  const stockListenerBefore = captureStockListenerSnapshot();
  const inputRoot = resolve(
    input.prepared.standaloneCliArtifact.extractRoot,
    'composed-live',
  );
  const testDir = join(inputRoot, 'harness');
  const happyHomeDir = join(inputRoot, 'home');
  const workspaceDir = join(inputRoot, 'workspace');
  const openCodeStateDir = join(inputRoot, 'opencode');
  await Promise.all([
    mkdir(testDir, { recursive: true, mode: 0o700 }),
    mkdir(happyHomeDir, { recursive: true, mode: 0o700 }),
    mkdir(workspaceDir, { recursive: true, mode: 0o700 }),
    mkdir(openCodeStateDir, { recursive: true, mode: 0o700 }),
  ]);
  const configuredServerPort = Number(
    input.prepared.cliLaunchSpec.env?.HAPPIER_PACKED_MANAGED_SERVER_PORT,
  );
  assert(
    Number.isInteger(configuredServerPort)
      && configuredServerPort > 0
      && configuredServerPort !== STOCK_CLIPROXYAPI_PORT,
    'packed_managed_provider_isolated_server_port_invalid',
  );
  const featureEnv: NodeJS.ProcessEnv = {
    HAPPIER_FEATURE_PROVIDERS__ENABLED: '1',
    HAPPIER_FEATURE_LOCAL_SERVICES_MANAGED__ENABLED: '0',
  };
  let server: StartedServer | null = null;
  let serverProxy: HttpRequestRecordingProxy | null = null;
  let connectProxy: TlsRecordingProxy | null = null;
  let stockPortObserver: PackedManagedProviderStockPortObserver | null = null;
  let daemon: StartedDaemon | null = null;
  let ui: SocketCollector | null = null;
  let daemonStartupAttempted = false;
  try {
    server = await startServerLight({
      testDir,
      dbProvider: 'sqlite',
      extraEnv: featureEnv,
      __portAllocator: async () => configuredServerPort,
    });
    serverProxy = await startHttpRequestRecordingProxy({
      targetBaseUrl: server.baseUrl,
    });
    connectProxy = await startConnectedAccountTlsRecordingProxy();
    const trustedCertificatePath =
      await writePackedManagedProviderTrustedCertificateBundle({
        testDir,
        certificatePaths: [
          connectProxy.caCertPath,
          ...(options.additionalTrustedCertificatePaths ?? []),
        ],
      });
    const auth = await createTestAuth(server.baseUrl);
    const accountSecret = Uint8Array.from(randomBytes(32));
    const seeded = await seedCliAuthForServer({
      cliHome: happyHomeDir,
      serverUrl: serverProxy.baseUrl,
      token: auth.token,
      secret: accountSecret,
    });
    const credential = await seedCredential({
      serverBaseUrl: server.baseUrl,
      authToken: auth.token,
      accountSecret,
    });
    const daemonEnv: NodeJS.ProcessEnv = {
      ...sanitizePackedAuthorArtifactEnv(
        sanitizeDaemonEnvForSpawn(process.env),
      ),
      ...featureEnv,
      CI: '1',
      HAPPIER_VARIANT: 'dev',
      HAPPIER_DISABLE_CAFFEINATE: '1',
      HAPPIER_HOME_DIR: happyHomeDir,
      HAPPIER_SERVER_URL: serverProxy.baseUrl,
      HAPPIER_WEBAPP_URL: serverProxy.baseUrl,
      HAPPIER_DAEMON_HEARTBEAT_INTERVAL: '5000',
      HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED: '0',
      [CANDIDATE_HANDOFF_AGENT_CLI_PATH_ENV]:
        input.prepared.standaloneCliArtifact.executablePath,
      HTTPS_PROXY: connectProxy.url,
      https_proxy: connectProxy.url,
      SSL_CERT_FILE: trustedCertificatePath,
      NODE_EXTRA_CA_CERTS: trustedCertificatePath,
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
      XDG_CONFIG_HOME: join(openCodeStateDir, 'config'),
      XDG_DATA_HOME: join(openCodeStateDir, 'data'),
      XDG_STATE_HOME: join(openCodeStateDir, 'state'),
      XDG_CACHE_HOME: join(openCodeStateDir, 'cache'),
    };
    stockPortObserver = await startPackedManagedProviderStockPortObserver({
      port: STOCK_CLIPROXYAPI_PORT,
    });
    daemonStartupAttempted = true;
    daemon = await startTestDaemon({
      testDir,
      happyHomeDir,
      env: daemonEnv,
      cliLaunchSpec: {
        command: input.prepared.cliLaunchSpec.command,
        args: [...input.prepared.cliLaunchSpec.args],
        cwd: input.prepared.cliLaunchSpec.cwd,
        env: { ...input.prepared.cliLaunchSpec.env, ...daemonEnv },
      },
      cleanupDescendantsOnExit: true,
      startupTimeoutMs: 120_000,
    });
    stockPortObserver.observeOwnedProcess(daemon.state.pid);
    await stockPortObserver.snapshot();
    await waitFor(async () => {
      assertPackedManagedProviderCandidateDaemonRunning({
        exitCode: daemon?.proc.child.exitCode ?? null,
        signalCode: daemon?.proc.child.signalCode ?? null,
      });
      const response = await daemonControlPostJson({
        port: daemon!.state.httpPort,
        path: '/list',
        controlToken: daemon!.state.controlToken,
        body: {},
      });
      return response.status === 200;
    }, {
      timeoutMs: 30_000,
      intervalMs: 100,
      context: 'packed managed candidate daemon control readiness',
      shouldRetryOnError: (error) =>
        !(error instanceof Error
          && error.message === CANDIDATE_DAEMON_EXITED_BEFORE_CONTROL_READY),
    });
    ui = createUserScopedSocketCollector(server.baseUrl, auth.token, {
      captureEvents: false,
    });
    ui.connect();
    await waitFor(() => ui?.isConnected() === true, {
      timeoutMs: 20_000,
      context: 'packed managed public RPC socket',
    });
    assert(
      daemon.state.httpPort !== STOCK_CLIPROXYAPI_PORT
        && new URL(server.baseUrl).port !== String(STOCK_CLIPROXYAPI_PORT)
        && new URL(serverProxy.baseUrl).port !== String(STOCK_CLIPROXYAPI_PORT)
        && new URL(connectProxy.url).port !== String(STOCK_CLIPROXYAPI_PORT),
      'packed_managed_provider_stock_port_collision',
    );
    return {
      inputRoot,
      testDir,
      happyHomeDir,
      workspaceDir,
      openCodeStateDir,
      server,
      serverProxy,
      connectProxy,
      trustedCertificatePath,
      auth,
      accountSecret,
      machineId: seeded.machineId,
      daemon,
      currentDaemonState: daemon.state,
      daemonEnv,
      credential,
      ui,
      stockListenerBefore,
      stockPortObserver,
      providerSetup: null,
      activeSession: null,
      candidateHandoffSessions: [],
    };
  } catch (error) {
    const failure = daemonStartupAttempted && daemon === null
      ? await createPackedManagedProviderCandidateDaemonStartupError({
          cause: error,
          stdoutPath: join(testDir, 'daemon.stdout.log'),
          stderrPath: join(testDir, 'daemon.stderr.log'),
        })
      : error;
    try {
      await cleanupPackedManagedProviderRuntimeResources({
        ui,
        daemon,
        serverProxy,
        connectProxy,
        server,
        stockPortObserver,
      });
    } catch (cleanupError) {
      if (failure && typeof failure === 'object') {
        Object.assign(failure, { cleanupError });
      }
    }
    throw failure;
  }
}

async function describePublicProviders(runtime: InitializedRuntime) {
  return await callProviderRpc(
    runtime,
    RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE,
    { machineId: runtime.machineId },
    DaemonProviderConnectionsDescribeResponseV1Schema,
  );
}

async function waitForCanonicalPublicSessionIdentity(input: Readonly<{
  runtime: InitializedRuntime;
  sessionId: string;
  phase: 'a' | 'b' | 'c';
}>): Promise<PublicSessionChild> {
  let observed: PublicSessionChild | null = null;
  await waitFor(async () => {
    observed = (await readPublicSessionChildren(input.runtime))
      .find((child) => child.happySessionId === input.sessionId) ?? null;
    return observed !== null;
  }, {
    timeoutMs: 60_000,
    intervalMs: 50,
    context: `packed managed canonical public session identity ${input.phase}`,
  });
  assert(
    observed,
    `packed_managed_provider_public_session_identity_missing:${input.phase}`,
  );
  return observed;
}

async function probePublicProviderActivation(
  runtime: InitializedRuntime,
  input: PackedManagedProviderPreparedInput,
): Promise<import('./packedManagedProviderLiveScenario')
  .PackedManagedProviderWrapperObservation> {
  const beforeProcesses = await listCandidateWrapperProcesses(input);
  runtime.connectProxy.clear();
  const explicitStart = await callProviderRpc(
    runtime,
    RPC_METHODS.DAEMON_PROVIDERS_CONNECTION_MUTATE,
    {
      action: 'startLocal',
      machineId: runtime.machineId,
      connectionId: CONNECTION_ID,
      contributionKey: CONTRIBUTION_KEY,
    },
    DaemonProviderConnectionMutationResponseV1Schema,
  );
  assert(
    explicitStart.status === 'success'
      && explicitStart.action === 'startLocal'
      && explicitStart.phase === 'running'
      && explicitStart.contributionKey === CONTRIBUTION_KEY,
    'packed_managed_provider_public_explicit_start_failed',
  );
  const explicitProcess = await waitForNewCandidateProcess(
    input,
    beforeProcesses,
    'packed managed explicit-start process',
  );
  let candidateId: string | null = null;
  let describePayload: unknown = null;
  await waitFor(async () => {
    const described = await describePublicProviders(runtime);
    describePayload = described;
    if (described.status !== 'success') return false;
    const candidate = described.discoveryCandidates.find((entry) =>
      entry.contributionKey === CONTRIBUTION_KEY
      && typeof entry.candidateId === 'string');
    candidateId = candidate?.candidateId ?? null;
    return candidateId !== null;
  }, {
    timeoutMs: 60_000,
    intervalMs: 100,
    context: 'packed managed public discovery candidate',
  });
  assert(candidateId, 'packed_managed_provider_public_discovery_missing');
  const enabled = await callProviderRpc(
    runtime,
    RPC_METHODS.DAEMON_PROVIDERS_CONNECTION_MUTATE,
    {
      action: 'enableDetected',
      machineId: runtime.machineId,
      connectionId: CONNECTION_ID,
      candidateId,
      displayName: null,
      savedSecretId: null,
    },
    DaemonProviderConnectionMutationResponseV1Schema,
  );
  assert(
    enabled.status === 'success' && enabled.action === 'enableDetected',
    'packed_managed_provider_public_enable_detected_failed',
  );
  const purpose = enabled.connection.managedLocalOption
    ?.connectedAccountPurposes.find((entry) =>
      entry.purpose === OPENAI_PURPOSE.purpose);
  assert(
    purpose
      && purpose.service.pluginId === 'happier.agent.codex'
      && purpose.service.localId === 'openai-codex',
    'packed_managed_provider_public_purpose_declaration_missing',
  );
  const updated = await callProviderRpc(
    runtime,
    RPC_METHODS.DAEMON_PROVIDERS_CONNECTION_MUTATE,
    {
      action: 'update',
      machineId: runtime.machineId,
      connectionId: CONNECTION_ID,
      expectedRevision: enabled.connection.revision,
      deployment: {
        kind: 'managedLocal',
        purposeBindingDefaults: {
          [OPENAI_PURPOSE.purpose]: {
            kind: 'account',
            account: {
              service: {
                pluginId: purpose.service.pluginId,
                localId: purpose.service.localId,
              },
              accountId: 'work',
            },
          },
        },
      },
    },
    DaemonProviderConnectionMutationResponseV1Schema,
  );
  assert(
    updated.status === 'success' && updated.action === 'update',
    'packed_managed_provider_public_deployment_update_failed',
  );
  const granted = await callProviderRpc(
    runtime,
    RPC_METHODS.DAEMON_PROVIDERS_CONNECTION_MUTATE,
    {
      action: 'setEnabled',
      machineId: runtime.machineId,
      connectionId: CONNECTION_ID,
      enabled: true,
      scope: 'machine',
    },
    DaemonProviderConnectionMutationResponseV1Schema,
  );
  assert(
    granted.status === 'success'
      && granted.action === 'setEnabled'
      && granted.connection.authorized,
    'packed_managed_provider_public_machine_grant_failed',
  );
  const beforeCatalogProcesses = await listCandidateWrapperProcesses(input);
  const catalog = await callProviderRpc(
    runtime,
    RPC_METHODS.DAEMON_PROVIDERS_PROBE,
    { connectionId: CONNECTION_ID, machineId: runtime.machineId },
    DaemonProviderProbeResponseV1Schema,
  );
  assert(
    catalog.status === 'success'
      && catalog.models.some((model) => model.id === MODEL_ID),
    'packed_managed_provider_public_catalog_probe_failed',
  );
  const models = await callProviderRpc(
    runtime,
    RPC_METHODS.DAEMON_PROVIDERS_MODELS,
    { connectionId: CONNECTION_ID, machineId: runtime.machineId },
    DaemonProviderModelsResponseV1Schema,
  );
  assert(
    models.status === 'success'
      && models.models.some((model) => model.id === MODEL_ID),
    'packed_managed_provider_public_catalog_projection_failed',
  );
  await waitFor(async () => {
    const after = await listCandidateWrapperProcesses(input);
    return after.length === beforeCatalogProcesses.length
      && after.every((process) => beforeCatalogProcesses.some((before) =>
        sameCandidateProcess(before, process)));
  }, {
    timeoutMs: 30_000,
    intervalMs: 50,
    context: 'packed managed catalog owner release',
  });
  const publicPayload = JSON.stringify([
    explicitStart,
    describePayload,
    enabled,
    updated,
    granted,
    catalog,
    models,
  ]);
  const publicObservationContainsCredential =
    publicPayload.includes(runtime.credential.accessToken);
  const providerAttemptedBeforeSessionDemand =
    runtime.connectProxy.entries().some((entry) =>
      isManagedCodexUpstreamTarget(
        entry.connectTarget,
        MANAGED_REQUEST_AUTH_ORIGIN,
      ));
  runtime.providerSetup = {
    connection: granted.connection,
    explicitProcess,
  };
  return {
    publicActivationReasons: ['explicitStartLocal', 'catalogProbe'],
    explicitStartContributionKey: explicitStart.contributionKey,
    explicitStartPhase: explicitStart.phase,
    catalogConnectionId: CONNECTION_ID,
    catalogModelIds: catalog.models.map((model) => model.id),
    catalogRequestFingerprint: catalog.requestFingerprint,
    catalogOwnerReleased: true,
    publicObservationContainsCredential,
    providerAttemptedBeforeSessionDemand,
    credentialSentinelObserved: publicObservationContainsCredential,
  };
}

function spawnRequest(
  runtime: InitializedRuntime,
  connectionId = CONNECTION_ID,
): Readonly<{
  body: Readonly<Record<string, unknown>>;
  promptSentinel: string;
}> {
  const spawnNonce = randomUUID();
  const promptSentinel = 'packed-managed-first-prompt:' + spawnNonce;
  return {
    promptSentinel,
    body: {
      directory: runtime.workspaceDir,
      spawnNonce,
      agent: 'opencode',
      backendTarget: {
        kind: 'backend',
        backendId: 'opencode',
        sourceKind: 'built_in',
      },
      terminal: { mode: 'plain' },
      modelSelection: {
        v: 1,
        updatedAt: Date.now(),
        ref: {
          agentTargetKey: AGENT_TARGET_KEY,
          providerConnectionId: connectionId,
          modelId: MODEL_ID,
        },
      },
      pendingFirstInput: {
        text: 'Reply with exactly ' + promptSentinel + '.',
        localId: 'spawn-first-turn:' + spawnNonce,
      },
      environmentVariables: {
        CI: '1',
        HAPPIER_HOME_DIR: runtime.happyHomeDir,
        HAPPIER_SERVER_URL: runtime.serverProxy.baseUrl,
        HAPPIER_WEBAPP_URL: runtime.serverProxy.baseUrl,
        HAPPIER_VARIANT: 'dev',
        HAPPIER_DISABLE_CAFFEINATE: '1',
        HTTPS_PROXY: runtime.connectProxy.url,
        https_proxy: runtime.connectProxy.url,
        SSL_CERT_FILE: runtime.connectProxy.caCertPath,
        NODE_EXTRA_CA_CERTS: runtime.connectProxy.caCertPath,
        NO_PROXY: '127.0.0.1,localhost',
        no_proxy: '127.0.0.1,localhost',
        XDG_CONFIG_HOME: join(runtime.openCodeStateDir, 'config'),
        XDG_DATA_HOME: join(runtime.openCodeStateDir, 'data'),
        XDG_STATE_HOME: join(runtime.openCodeStateDir, 'state'),
        XDG_CACHE_HOME: join(runtime.openCodeStateDir, 'cache'),
      },
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': { source: 'connected', profileId: 'work' },
        },
      },
    },
  };
}

type SpawnedPublicSession = Readonly<{
  active: ActivePublicSession;
  promptSentinel: string;
  spawnRequestIncludedSessionId: boolean;
  freshSpawnStartedAtMs: number;
  canonicalSessionRegisteredAtMs: number;
  spawnAcknowledgedAtMs: number;
  providerAttempt: RecordedTlsUpstreamRequest;
  upstreamRequestsBeforeCanonicalSession: number;
}>;

async function spawnPublicSession(
  runtime: InitializedRuntime,
  input: PackedManagedProviderPreparedInput,
  connectionId = CONNECTION_ID,
): Promise<SpawnedPublicSession> {
  const knownProcesses = await listCandidateWrapperProcesses(input);
  const providerProcessStarts =
    await startPackedManagedProviderProcessStartCollector({
      baseline: knownProcesses,
      sample: async () => await listCandidateWrapperProcesses(input),
    });
  try {
  const priorSessionCreates = runtime.serverProxy.entries()
    .filter(isSessionCreationRequest).length;
  const request = spawnRequest(runtime, connectionId);
  const freshSpawnStartedAtMs = Date.now();
  const response = await daemonControlPostJson<{
    success?: boolean;
    sessionId?: string;
    error?: string;
    errorCode?: string;
  }>({
    port: runtime.currentDaemonState.httpPort,
    path: '/spawn-session',
    controlToken: runtime.currentDaemonState.controlToken,
    body: request.body,
    timeoutMs: 150_000,
  });
  const spawnAcknowledgedAtMs = Date.now();
  assert(
    response.status === 200
      && response.data?.success === true
      && typeof response.data.sessionId === 'string'
      && response.data.sessionId.length > 0,
    'packed_managed_provider_public_session_spawn_failed:'
      + String(response.status)
      + ':'
      + String(response.data?.error ?? response.data?.errorCode ?? 'unknown'),
  );
  const sessionId = response.data.sessionId;
  await waitFor(async () => (await readPublicSessionChildren(runtime))
    .some((child) => child.happySessionId === sessionId), {
    timeoutMs: 60_000,
    intervalMs: 50,
    context: 'packed managed public session registration',
  });
  const providerProcess = await waitForNewCandidateProcess(
    providerProcessStarts,
    'packed managed session-demand provider process',
  );
  runtime.stockPortObserver.observeOwnedProcess(providerProcess.pid);
  await waitFor(() => runtime.connectProxy.entries().some((entry) =>
    isManagedCodexUpstreamTarget(
      entry.connectTarget,
      MANAGED_REQUEST_AUTH_ORIGIN,
    ) && entry.body.includes(request.promptSentinel)), {
    timeoutMs: 60_000,
    intervalMs: 25,
    context: 'packed managed public session provider attempt',
  });
  const providerAttempt = runtime.connectProxy.entries().find((entry) =>
    isManagedCodexUpstreamTarget(
      entry.connectTarget,
      MANAGED_REQUEST_AUTH_ORIGIN,
    ) && entry.body.includes(request.promptSentinel));
  assert(
    providerAttempt,
    'packed_managed_provider_public_provider_attempt_missing',
  );
  const sessionCreation = runtime.serverProxy.entries()
    .filter(isSessionCreationRequest)
    .slice(priorSessionCreates)
    .find((entry) =>
      entry.endedAtMs !== null
      && entry.statusCode !== null
      && entry.statusCode >= 200
      && entry.statusCode < 300);
  assert(
    sessionCreation?.endedAtMs,
    'packed_managed_provider_public_session_registration_missing',
  );
  const upstreamRequestsBeforeCanonicalSession =
    runtime.connectProxy.entries().filter((entry) =>
      isManagedCodexUpstreamTarget(
        entry.connectTarget,
        MANAGED_REQUEST_AUTH_ORIGIN,
      ) && entry.observedAtMs < sessionCreation.endedAtMs!).length;
  assert(
    (await providerProcessStarts.observe()).length === 1,
    'packed_managed_provider_duplicate_candidate_process_start',
  );
  return {
    active: {
      sessionId,
      providerProcess,
      providerProcessStarts,
      promptSentinel: request.promptSentinel,
    },
    promptSentinel: request.promptSentinel,
    spawnRequestIncludedSessionId:
      Object.prototype.hasOwnProperty.call(request.body, 'sessionId'),
    freshSpawnStartedAtMs,
    canonicalSessionRegisteredAtMs: sessionCreation.endedAtMs,
    spawnAcknowledgedAtMs,
    providerAttempt,
    upstreamRequestsBeforeCanonicalSession,
  };
  } catch (error) {
    await providerProcessStarts.stop().catch(() => undefined);
    throw error;
  }
}

async function probeFreshManagedSpawn(
  runtime: InitializedRuntime,
  input: PackedManagedProviderPreparedInput,
): Promise<PackedManagedProviderFreshSpawnObservation> {
  assert(runtime.providerSetup, 'packed_managed_provider_public_setup_missing');
  runtime.connectProxy.clear();
  const spawned = await spawnPublicSession(runtime, input);
  runtime.activeSession = spawned.active;
  const publicSession = (await readPublicSessionChildren(runtime))
    .find((child) => child.happySessionId === spawned.active.sessionId);
  assert(
    publicSession,
    'packed_managed_provider_public_session_identity_missing',
  );
  const connection = runtime.providerSetup.connection;
  const managedPurpose = connection.deployment.kind === 'managedLocal'
    ? connection.deployment.effects?.connectedAccountPurposes.find(
        (entry) => entry.purpose === OPENAI_PURPOSE.purpose)
    : null;
  assert(
    managedPurpose?.target.kind === 'account'
      && managedPurpose.target.account.accountId === 'work',
    'packed_managed_provider_public_purpose_binding_missing',
  );
  const stockNetworkAfter = await runtime.stockPortObserver.snapshot();
  const stockListenerAfter = captureStockListenerSnapshot();
  const providerProcessStarts =
    await spawned.active.providerProcessStarts.observe();
  return {
    publicActivationReason: 'sessionDemand',
    spawnRequestIncludedSessionId: spawned.spawnRequestIncludedSessionId,
    returnedSessionId: spawned.active.sessionId,
    publicSessionId: publicSession.happySessionId,
    upstreamRequestsBeforeCanonicalSession:
      spawned.upstreamRequestsBeforeCanonicalSession,
    managedPurpose: managedPurpose.purpose,
    agentPurpose: OPENCODE_PURPOSE.purpose,
    connectionRevision: connection.revision,
    credentialRevision: runtime.credential.credentialRevision,
    upstreamAuthorizationFingerprint:
      spawned.providerAttempt.authorizationFingerprint ?? '',
    managedRequestAuthOrigin: MANAGED_REQUEST_AUTH_ORIGIN,
    upstreamConnectTarget: spawned.providerAttempt.connectTarget,
    currentAccessTokenFingerprint: runtime.credential.accessTokenFingerprint,
    promptSentinelObserved:
      spawned.providerAttempt.body.includes(spawned.promptSentinel),
    upstreamRequestPath: spawned.providerAttempt.path,
    timeline: {
      freshSpawnStartedAtMs: spawned.freshSpawnStartedAtMs,
      canonicalSessionRegisteredAtMs:
        spawned.canonicalSessionRegisteredAtMs,
      spawnAcknowledgedAtMs: spawned.spawnAcknowledgedAtMs,
      providerAttemptAtMs: spawned.providerAttempt.observedAtMs,
    },
    observedPorts: {
      server: Number(new URL(runtime.server.baseUrl).port),
      serverProxy: Number(new URL(runtime.serverProxy.baseUrl).port),
      daemon: runtime.currentDaemonState.httpPort,
      upstreamProxy: Number(new URL(runtime.connectProxy.url).port),
    },
    stockPortRequestCount: runtime.connectProxy.connectTargets()
      .filter((target) => target.includes(':8317')).length,
    stockPortOsConnectionAttemptCount:
      stockNetworkAfter.ownedConnectionAttemptCount,
    stockListenerIdentityBefore: runtime.stockListenerBefore.identity,
    stockListenerIdentityAfter: stockListenerAfter.identity,
    providerProcess: {
      pid: spawned.active.providerProcess.pid,
      executablePath: spawned.active.providerProcess.executablePath,
      executableMatchedCandidate:
        resolve(spawned.active.providerProcess.executablePath)
          === resolve(input.prepared.wrapperExecutable),
    },
    providerProcessCountForSessionDemand: providerProcessStarts.length,
  };
}

async function stopPublicSession(params: Readonly<{
  runtime: InitializedRuntime;
  session: ActivePublicSession;
  expectedProviderProcessStartCount?: number;
  stopProviderProcessStartCollector?: boolean;
}>): Promise<Readonly<{
  sessionAbsent: boolean;
  providerExited: boolean;
  noPostStopProviderAttempt: boolean;
  providerStartCount: number;
}>> {
  const beforeAttempts = params.runtime.connectProxy.entries().length;
  await daemonControlPostJson({
    port: params.runtime.currentDaemonState.httpPort,
    path: '/stop-session',
    controlToken: params.runtime.currentDaemonState.controlToken,
    body: { sessionId: params.session.sessionId },
    timeoutMs: 60_000,
  }).catch(() => ({ status: 500, data: null }));
  let providerStarts: readonly ObservedCandidateProcess[] = [];
  try {
    await waitFor(async () => {
      const children = await readPublicSessionChildren(params.runtime)
        .catch(() => []);
      return !children.some((child) =>
        child.happySessionId === params.session.sessionId)
        && !isProcessAlive(params.session.providerProcess.pid);
    }, {
      timeoutMs: 60_000,
      intervalMs: 50,
      context: 'packed managed public session cleanup',
    });
  } finally {
    providerStarts = params.stopProviderProcessStartCollector === false
      ? await params.session.providerProcessStarts.observe()
      : await params.session.providerProcessStarts.stop();
  }
  assert(
    providerStarts.length
      === (params.expectedProviderProcessStartCount ?? 1),
    'packed_managed_provider_duplicate_candidate_process_start',
  );
  return {
    sessionAbsent: !(await readPublicSessionChildren(params.runtime))
      .some((child) => child.happySessionId === params.session.sessionId),
    providerExited: !isProcessAlive(params.session.providerProcess.pid),
    noPostStopProviderAttempt:
      params.runtime.connectProxy.entries().length === beforeAttempts,
    providerStartCount: providerStarts.length,
  };
}

async function probeInvalidSessionDemand(
  runtime: InitializedRuntime,
  input: PackedManagedProviderPreparedInput,
): Promise<Readonly<{
  refused: boolean;
  spawnAcknowledged: boolean;
  firstInputDispatched: boolean;
  providerAttemptStarted: boolean;
  failedSessionAbsent: boolean;
}>> {
  const invalidConnectionId =
    ProviderConnectionIdSchema.parse('pc_packed_missing');
  const priorChildren = await readPublicSessionChildren(runtime);
  const priorProcesses = await listCandidateWrapperProcesses(input);
  const priorAttemptCount = runtime.connectProxy.entries().length;
  const request = spawnRequest(runtime, invalidConnectionId);
  const response = await daemonControlPostJson<{
    success?: boolean;
    sessionId?: string;
  }>({
    port: runtime.currentDaemonState.httpPort,
    path: '/spawn-session',
    controlToken: runtime.currentDaemonState.controlToken,
    body: request.body,
    timeoutMs: 90_000,
  });
  const childrenAfter = await readPublicSessionChildren(runtime);
  const processesAfter = await listCandidateWrapperProcesses(input);
  const attemptsAfter = runtime.connectProxy.entries();
  return {
    refused: response.status !== 200 || response.data?.success !== true,
    spawnAcknowledged:
      response.status === 200 && response.data?.success === true,
    firstInputDispatched: attemptsAfter.some((entry) =>
      entry.body.includes(request.promptSentinel)),
    providerAttemptStarted: attemptsAfter.length !== priorAttemptCount,
    failedSessionAbsent:
      childrenAfter.length === priorChildren.length
      && childrenAfter.every((child) => priorChildren.some((before) =>
        before.happySessionId === child.happySessionId))
      && processesAfter.length === priorProcesses.length
      && processesAfter.every((process) => priorProcesses.some((before) =>
        sameCandidateProcess(before, process))),
  };
}

async function probeActivationFailureCleanup(
  runtime: InitializedRuntime,
  input: PackedManagedProviderPreparedInput,
): Promise<PackedManagedProviderActivationFailureObservation> {
  const active = runtime.activeSession;
  assert(active, 'packed_managed_provider_active_public_session_missing');
  const invalid = await probeInvalidSessionDemand(runtime, input);
  const cleaned = await stopPublicSession({ runtime, session: active });
  runtime.activeSession = null;
  const stockNetworkAfter = await runtime.stockPortObserver.snapshot();
  const stockListenerAfter = captureStockListenerSnapshot();
  return {
    publicActivationReason: 'sessionDemand',
    activationRefused: invalid.refused,
    spawnAcknowledged: invalid.spawnAcknowledged,
    firstInputDispatched: invalid.firstInputDispatched,
    providerAttemptStarted: invalid.providerAttemptStarted,
    stockPortOsConnectionAttemptCount:
      stockNetworkAfter.ownedConnectionAttemptCount,
    stockListenerIdentityBefore: runtime.stockListenerBefore.identity,
    stockListenerIdentityAfter: stockListenerAfter.identity,
    cleanup: {
      failedSessionAbsent: invalid.failedSessionAbsent,
      activeSessionAbsent: cleaned.sessionAbsent,
      sessionProviderExited: cleaned.providerExited,
      noPostStopProviderAttempt: cleaned.noPostStopProviderAttempt,
    },
  };
}

async function updateCandidateHandoffPackageManifest(input: Readonly<{
  pluginRoot: string;
  version: string;
  includeTools: boolean;
}>): Promise<void> {
  const path = join(input.pluginRoot, 'package.json');
  const manifest = JSON.parse(await readFile(path, 'utf8')) as Record<
    string,
    unknown
  >;
  const files = Array.isArray(manifest.files)
    ? manifest.files.filter((value): value is string =>
      typeof value === 'string')
    : [];
  manifest.version = input.version;
  manifest.files = [...new Set([
    ...files,
    'dist',
    '.happier-plugin',
    ...(input.includeTools ? ['tools'] : []),
  ])];
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

export async function writeCandidateHandoffAgentSource(input: Readonly<{
  pluginRoot: string;
  version: string;
  generation: Extract<CandidateHandoffGeneration, 'G' | 'H' | 'R'>;
}>): Promise<void> {
  await updateCandidateHandoffPackageManifest({
    pluginRoot: input.pluginRoot,
    version: input.version,
    includeTools: false,
  });
  await mkdir(join(input.pluginRoot, 'src'), { recursive: true });
  await mkdir(join(input.pluginRoot, '.happier-plugin'), { recursive: true });
  if (input.generation === 'R') {
    await writeFile(
      join(input.pluginRoot, '.happier-plugin', 'plugin.json'),
      `${JSON.stringify({
        schemaVersion: 2,
        id: CANDIDATE_HANDOFF_AGENT_PLUGIN_ID,
        version: input.version,
        displayName: 'Packed public Agent removed contribution',
        engines: { happier: '^0.2.0' },
        runtime: { apiVersion: 1 },
        entrypoints: { daemon: './dist/index.js' },
        hostAccess: { required: [], optional: [] },
        contributes: { agents: [], providers: [] },
      }, null, 2)}\n`,
      'utf8',
    );
    await writeFile(join(input.pluginRoot, 'src', 'index.ts'), [
      "import { definePlugin } from '@happier-dev/plugin-sdk';",
      '',
      'const plugin = definePlugin({',
      `  id: ${JSON.stringify(CANDIDATE_HANDOFF_AGENT_PLUGIN_ID)},`,
      `  version: ${JSON.stringify(input.version)},`,
      "  displayName: 'Packed public Agent removed contribution',",
      "  engines: { happier: '^0.2.0' },",
      "  entrypoints: { daemon: './dist/index.js' },",
      '  hostAccess: { required: [], optional: [] },',
      '});',
      '',
      'export const manifest = plugin.manifest;',
      'export const activate = plugin.activate;',
      '',
    ].join('\n'), 'utf8');
    return;
  }
  await writeFile(
    join(input.pluginRoot, '.happier-plugin', 'plugin.json'),
    `${JSON.stringify({
      schemaVersion: 2,
      id: CANDIDATE_HANDOFF_AGENT_PLUGIN_ID,
      version: input.version,
      displayName: `Packed public Agent ${input.generation}`,
      engines: { happier: '^0.2.0' },
      runtime: { apiVersion: 1 },
      entrypoints: { daemon: './dist/index.js' },
      hostAccess: { required: [], optional: [] },
      contributes: {
        providers: [],
        actions: [{
          id: 'external-sessions-acceptance',
          title: 'Packed External Sessions acceptance',
          scopes: ['global'],
          surfaces: ['cli'],
          execution: { target: 'daemon' },
          dangerLevel: 'externalSideEffect',
          confirmation: {
            title: 'Run packed External Sessions acceptance?',
            body: 'Runs the packed External Sessions acceptance flow.',
            confirmLabel: 'Run acceptance',
          },
        }],
        commands: [{
          id: 'external-sessions-acceptance-command',
          title: 'Packed External Sessions acceptance',
          path: ['packed-candidate', 'external-sessions'],
          action: 'external-sessions-acceptance',
        }],
        agents: [{
          id: CANDIDATE_HANDOFF_AGENT_ID,
          ...candidateHandoffAgentDeclaration,
        }],
      },
    }, null, 2)}\n`,
    'utf8',
  );
  await writeFile(join(input.pluginRoot, 'src', 'agentRuntime.ts'), [
    "import { createHash } from 'node:crypto';",
    "import type { AgentRuntimeFactory, AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';",
    "import type { AgentExternalSessionObservationContribution, AgentExternalSessionsContribution, AgentExternalSessionsResolvedIdentity } from '@happier-dev/plugin-sdk/sessions/external';",
    '',
    `export const packedAgentGeneration = ${JSON.stringify(input.generation)} as const;`,
    '',
    'export const externalSessions = {',
    '  async resolveSource(request) {',
    "    return { ok: true, value: { source: { kind: 'packedCandidate', scope: request.source.scope } } };",
    '  },',
    '  async listCandidates() {',
    "    return { ok: true, value: { candidates: [{ remoteSessionId: 'packed-logical-session', title: `Packed ${packedAgentGeneration}`, updatedAtMs: 1, linkData: { scope: 'shared', generation: packedAgentGeneration } }], nextCursor: `packed-${packedAgentGeneration}-cursor` } };",
    '  },',
    '  async resolveLinkIdentity(request) {',
    "    return { ok: true, value: { source: { kind: 'packedCandidate', scope: request.source.scope }, remoteSessionId: request.remoteSessionId, linkData: { scope: request.source.scope, generation: packedAgentGeneration } } };",
    '  },',
    '  async resolveLinkedIdentity(request) {',
    "    return { ok: true, value: { source: { kind: 'packedCandidate', scope: request.source.scope }, remoteSessionId: request.remoteSessionId, linkData: request.linkData } };",
    '  },',
    '  async pageTranscript() {',
    "    return { ok: true, value: { items: [{ id: `packed-page-${packedAgentGeneration}`, createdAtMs: 1, messageRole: 'agent', raw: { role: 'agent', content: { type: 'output', data: { type: 'message', message: `Packed ${packedAgentGeneration} transcript` } } } }], nextCursor: null, tailCursor: `packed-${packedAgentGeneration}-tail`, hasMore: false } };",
    '  },',
    '  async readAfterTranscript() {',
    "    return { ok: true, value: { outcome: 'advanced', items: [{ id: `packed-follow-${packedAgentGeneration}`, createdAtMs: 2, messageRole: 'agent', raw: { role: 'agent', content: { type: 'output', data: { type: 'message', message: `Packed ${packedAgentGeneration} follow` } } } }], nextCursor: `packed-${packedAgentGeneration}-next`, boundary: `packed-${packedAgentGeneration}-next` } };",
    '  },',
    '} satisfies AgentExternalSessionsContribution;',
    '',
    'function packedExternalSessionObservationKey(value: unknown): string {',
    "  return createHash('sha256').update(JSON.stringify(value) ?? 'null', 'utf8').digest('base64url');",
    '}',
    '',
    'function describePackedExternalSessionObservation(identity: AgentExternalSessionsResolvedIdentity) {',
    '  const opaqueIdentity = packedExternalSessionObservationKey({',
    '    source: identity.source,',
    '    remoteSessionId: identity.remoteSessionId,',
    '    linkData: identity.linkData,',
    '  });',
    '  return {',
    '    resourceKey: `packed-candidate-observation-resource-v1:${opaqueIdentity}`,',
    '    linkKey: `packed-candidate-observation-link-v1:${opaqueIdentity}`,',
    '  };',
    '}',
    '',
    'function packedExternalSessionObservationLinkKeyForResource(resourceKey: string): string {',
    "  const resourceKeyPrefix = 'packed-candidate-observation-resource-v1:';",
    "  const linkKeyPrefix = 'packed-candidate-observation-link-v1:';",
    '  const opaqueIdentity = resourceKey.startsWith(resourceKeyPrefix)',
    '    ? resourceKey.slice(resourceKeyPrefix.length)',
    "    : '';",
    "  if (!opaqueIdentity) throw new Error('packed_external_session_observation_resource_invalid');",
    '  return `${linkKeyPrefix}${opaqueIdentity}`;',
    '}',
    '',
    'export const externalSessionObservation = {',
    '  describeResource(identity) {',
    '    return describePackedExternalSessionObservation(identity);',
    '  },',
    '  observeResource(request) {',
    '    request.signal.throwIfAborted();',
    '    request.requestTranscriptRefresh(packedExternalSessionObservationLinkKeyForResource(request.resourceKey));',
    '    return Object.freeze({ dispose() {} });',
    '  },',
    '  reconcileResource(request) {',
    '    request.signal.throwIfAborted();',
    "    if (request.purpose === 'resource_descriptors') {",
    '      const outcomes = request.links.map((link) => ({',
    "        kind: 'described' as const,",
    '        descriptor: {',
    '          resourceKey: request.resourceKey,',
    '          linkKey: link.linkKey,',
    "          changeObservation: 'observe_resource' as const,",
    '        },',
    '      }));',
    '      request.signal.throwIfAborted();',
    "      return { purpose: 'resource_descriptors' as const, outcomes };",
    '    }',
    '    const observedAtMs = Date.now();',
    '    const outcomes = request.links.map((link) => ({',
    '      linkKey: link.linkKey,',
    "      facts: (['liveness', 'turn_phase', 'boundary'] as const).map((axis) => ({",
    "        kind: 'unsupported' as const,",
    '        axis,',
    "        evidenceClass: 'reconciliation' as const,",
    '        observedAtMs,',
    '      })),',
    '    }));',
    '    request.signal.throwIfAborted();',
    "    return { purpose: 'observation_evidence' as const, outcomes };",
    '  },',
    '} satisfies AgentExternalSessionObservationContribution;',
    '',
    'export const createPackedAgentRuntime: AgentRuntimeFactory = () => ({',
    '  surfaces: {',
    '    terminal: {',
    '      resolveLaunch() {',
    '        return {',
    "          argv: ['--version'],",
    "          process: { stdio: 'pipe', windowsHide: true },",
    '        };',
    '      },',
    '    },',
    '  },',
    '  sessions: {',
    '    async open(request) {',
    '      const listeners = new Set<(event: AgentSessionRuntimeEvent) => void>();',
    '      let sequence = 0;',
    '      const emit = (event: AgentSessionRuntimeEvent): void => {',
    '        for (const listener of listeners) listener(event);',
    '      };',
    '      return {',
    '        async send(sendRequest) {',
    `          const endpoint = request.launchEnvironment?.values[${JSON.stringify(CANDIDATE_HANDOFF_PROVIDER_ENDPOINT_ENV)}];`,
    `          const credential = request.launchEnvironment?.values[${JSON.stringify(CANDIDATE_HANDOFF_PROVIDER_BEARER_ENV)}];`,
    "          if (!endpoint || !credential) throw new Error('Packed public Agent requires Provider endpoint and bearer');",
    "          const response = await fetch(new URL('responses', endpoint.endsWith('/') ? endpoint : `${endpoint}/`), {",
    "            method: 'POST',",
    "            headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },",
    `            body: JSON.stringify({ model: ${JSON.stringify(CANDIDATE_HANDOFF_MODEL_ID)}, input: sendRequest.input.text, stream: false }),`,
    '          });',
    '          await response.arrayBuffer();',
    '          const turnId = sendRequest.delivery.turnId;',
    '          emit({',
    "            kind: 'message-delta',",
    '            sequence: ++sequence,',
    '            sessionId: request.sessionId,',
    '            emittedAtMs: Date.now(),',
    "            channel: 'assistant',",
    '            turnId,',
    '            text: `${packedAgentGeneration}:${sendRequest.input.text}`,',
    '          });',
    '          emit({',
    "            kind: 'turn-complete',",
    '            sequence: ++sequence,',
    '            sessionId: request.sessionId,',
    '            emittedAtMs: Date.now(),',
    '            turnId,',
    '          });',
    "          return { status: 'admitted' };",
    '        },',
    '        watch(listener) {',
    '          listeners.add(listener);',
    '          return { dispose() { listeners.delete(listener); } };',
    '        },',
    '        async dispose() { listeners.clear(); },',
    '      };',
    '    },',
    '  },',
    '});',
    '',
  ].join('\n'), 'utf8');
  await writeFile(join(input.pluginRoot, 'src', 'index.ts'), [
    "import { definePlugin, type PluginInvocationContext } from '@happier-dev/plugin-sdk';",
    "import type { AgentProviderBindingAdapter } from '@happier-dev/plugin-sdk/agents/runtime';",
    "import { createPackedAgentRuntime, externalSessions, externalSessionObservation, packedAgentGeneration } from './agentRuntime.js';",
    '',
    'const providerBinding = Object.freeze({',
    '  v: 1,',
    '  adapterVersion: 1,',
    "  prepare() { return { v: 1, materialization: 'spawnEnv' }; },",
    '  materialize(input) {',
    "    if (input.credential.kind !== 'apiKey') throw new Error('Packed public Agent requires managed host bearer');",
    "    return { v: 1, kind: 'spawnEnv', env: [",
    `      { name: ${JSON.stringify(CANDIDATE_HANDOFF_PROVIDER_BEARER_ENV)}, value: input.credential.value, source: 'provider' },`,
    `      { name: ${JSON.stringify(CANDIDATE_HANDOFF_PROVIDER_ENDPOINT_ENV)}, value: input.binding.endpoint.normalizedUrl, source: 'provider' },`,
    '    ] };',
    '  },',
    '}) satisfies AgentProviderBindingAdapter;',
    '',
    'function packedExternalSessionsCapabilitiesAreAvailable(value: unknown): boolean {',
    '  if (!value || typeof value !== \'object\' || Array.isArray(value)) return false;',
    '  const capabilities = value as Record<string, unknown>;',
    "  const expectedKeys = ['attach', 'follow', 'list', 'takeover', 'transcript'];",
    '  if (Object.keys(capabilities).sort().join(\',\') !== expectedKeys.join(\',\')) return false;',
    '  const isAvailable = (operation: unknown): boolean => (',
    '    Boolean(operation)',
    "    && typeof operation === 'object'",
    '    && !Array.isArray(operation)',
    "    && Object.keys(operation).length === 1",
    "    && Reflect.get(operation, 'status') === 'available'",
    '  );',
    '  if (!isAvailable(capabilities.list) || !isAvailable(capabilities.attach) || !isAvailable(capabilities.transcript) || !isAvailable(capabilities.follow)) return false;',
    '  const takeover = capabilities.takeover;',
    "  if (!takeover || typeof takeover !== 'object' || Array.isArray(takeover)) return false;",
    '  const takeoverRecord = takeover as Record<string, unknown>;',
    "  if (Object.keys(takeoverRecord).sort().join(',') !== 'status,storageModes' || takeoverRecord.status !== 'available') return false;",
    '  const storageModes = takeoverRecord.storageModes;',
    "  return Array.isArray(storageModes) && storageModes.length === 2 && storageModes[0] === 'external-linked' && storageModes[1] === 'persisted';",
    '}',
    '',
    'export async function runPackedExternalSessionsAcceptance(context: PluginInvocationContext) {',
    "  const capabilities = await context.services.sessions.external.capabilities();",
    "  if (!packedExternalSessionsCapabilitiesAreAvailable(capabilities)) throw new Error('packed_external_capabilities_unavailable');",
    "  const previousPhase = await context.services.storage.daemon.get('packed-external-sessions-public-phase');",
    '  const listed = await context.services.sessions.external.list({ agentId: ' + JSON.stringify(CANDIDATE_HANDOFF_AGENT_ID) + ', limit: 1 });',
    "  const candidate = listed.items[0]; if (!candidate) throw new Error('packed_external_candidate_missing');",
    "  const previous = previousPhase && typeof previousPhase === 'object' && !Array.isArray(previousPhase) ? previousPhase as Record<string, unknown> : null;",
    "  const previousRefRecord = previous && typeof previous.ref === 'object' && previous.ref !== null && !Array.isArray(previous.ref) ? previous.ref as Record<string, unknown> : null;",
    "  const previousRef = previousRefRecord && typeof previousRefRecord.agentId === 'string' && typeof previousRefRecord.sourceId === 'string' && typeof previousRefRecord.remoteSessionId === 'string' ? { agentId: previousRefRecord.agentId, sourceId: previousRefRecord.sourceId, remoteSessionId: previousRefRecord.remoteSessionId } : null;",
    '  if (packedAgentGeneration === \'H\') {',
    "    if (!previousRef) throw new Error('packed_external_public_g_ref_missing');",
    "    if (previousRef.agentId !== candidate.ref.agentId || previousRef.sourceId !== candidate.ref.sourceId || previousRef.remoteSessionId !== candidate.ref.remoteSessionId) throw new Error('packed_external_public_g_ref_tuple_changed');",
    '  }',
    '  const publicRef = previousRef ?? candidate.ref;',
    '  const attached = await context.services.sessions.external.attach(publicRef);',
    "  const transcript = await context.services.sessions.external.readTranscript(publicRef, { mode: 'page', direction: 'older', limit: 1 });",
    "  if (transcript.mode !== 'page') throw new Error('packed_external_transcript_mode');",
    '  const events: string[] = [];',
    '  let followDataEvent: unknown = null;',
    '  let followListenerSettled = false;',
    '  let disposedTerminalAcknowledgements = 0;',
    '  let postTerminalEventCount = 0;',
    '  let followTerminalAcknowledged = false;',
    '  const publicGFollow = { dataEventCount: 0, terminalAcknowledgements: 0, postTerminalEventCount: 0 };',
    '  let publicGFollowTerminal = false;',
    '  let publicGFollowCursor: string | null = transcript.tailCursor ?? null;',
    '  let publicGFollowPersistence: Promise<void> = Promise.resolve();',
    "  const persistPublicGFollow = (): Promise<void> => { const phase = { ref: candidate.ref, listCursor: listed.nextCursor, followCursor: publicGFollowCursor, publicGFollow }; publicGFollowPersistence = publicGFollowPersistence.then(async () => { await context.services.storage.daemon.set('packed-external-sessions-public-phase', phase); }); return publicGFollowPersistence; };",
    '  let acknowledgeFollowData: (() => void) | undefined;',
    '  const firstFollowData = new Promise<void>((resolve) => { acknowledgeFollowData = resolve; });',
    "  const followed = await context.services.sessions.external.followTranscript(publicRef, transcript.tailCursor ? { cursor: transcript.tailCursor } : {}, async (event) => { events.push(event.kind); if (packedAgentGeneration === 'G') { if (publicGFollowTerminal) publicGFollow.postTerminalEventCount += 1; if (event.kind === 'data') publicGFollow.dataEventCount += 1; if (event.kind === 'terminated') { publicGFollow.terminalAcknowledgements += 1; publicGFollowTerminal = true; } } else { if (followTerminalAcknowledged) postTerminalEventCount += 1; if (event.kind === 'terminated' && event.reason === 'disposed') { disposedTerminalAcknowledgements += 1; followTerminalAcknowledged = true; } } if (event.kind === 'data') { followDataEvent = event; await Promise.resolve(); followListenerSettled = true; acknowledgeFollowData?.(); } if (packedAgentGeneration === 'G') await persistPublicGFollow(); });",
    "  if (followed.status !== 'following') throw new Error(`packed_external_follow_unavailable:${followed.code}`);",
    "  if (packedAgentGeneration === 'G' && publicGFollowCursor === null) { publicGFollowCursor = followed.startingCursor; await persistPublicGFollow(); }",
    '  let followAcknowledgementTimer: ReturnType<typeof setTimeout> | undefined;',
    "  try { await Promise.race([firstFollowData, new Promise<void>((_resolve, reject) => { followAcknowledgementTimer = setTimeout(() => reject(new Error('packed_external_follow_ack_timeout')), 5_000); })]); } finally { if (followAcknowledgementTimer) clearTimeout(followAcknowledgementTimer); }",
    "  if (packedAgentGeneration === 'G') { await publicGFollowPersistence; if (!followListenerSettled || publicGFollow.dataEventCount < 1 || publicGFollow.terminalAcknowledgements !== 0 || publicGFollow.postTerminalEventCount !== 0) throw new Error('packed_external_public_g_follow_invalid'); return { phase: 'snapshot', capabilities, listPage: listed, transcriptPage: transcript, publicRef, follow: { startingCursor: followed.startingCursor, events, dataEvent: followDataEvent, listenerSettled: true, disposedTerminalAcknowledgements: 0, postTerminalEventCount: 0, disposed: false } }; }",
    '  await followed.subscription.dispose();',
    '  await followed.subscription.dispose();',
    "  if (!followListenerSettled || disposedTerminalAcknowledgements !== 1 || postTerminalEventCount !== 0) throw new Error('packed_external_follow_dispose_not_settled');",
    "  const previousListCursor = previous && typeof previous.listCursor === 'string' ? previous.listCursor : null;",
    "  const previousFollowCursor = previous && typeof previous.followCursor === 'string' ? previous.followCursor : null;",
    '  let publicGCursorRetirementCode: string | null = null;',
    "  if (previousListCursor) { try { await context.services.sessions.external.list({ agentId: " + JSON.stringify(CANDIDATE_HANDOFF_AGENT_ID) + ", cursor: previousListCursor, limit: 1 }); } catch (error) { publicGCursorRetirementCode = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : null; } }",
    '  let publicGFollowCursorRetirementCode: string | null = null;',
    "  if (previousFollowCursor) { const staleFollow = await context.services.sessions.external.followTranscript(publicRef, { cursor: previousFollowCursor }, async () => {}); if (staleFollow.status === 'following') await staleFollow.subscription.dispose(); else publicGFollowCursorRetirementCode = staleFollow.code; }",
    "  if (publicGCursorRetirementCode !== 'plugin_external_cursor_invalid' || publicGFollowCursorRetirementCode !== 'plugin_external_cursor_invalid') throw new Error('packed_external_public_g_resources_not_retired');",
    "  const publicGFollowRecord = previous && typeof previous.publicGFollow === 'object' && previous.publicGFollow !== null && !Array.isArray(previous.publicGFollow) ? previous.publicGFollow as Record<string, unknown> : null;",
    "  const publicGFollowEvidence = publicGFollowRecord && typeof publicGFollowRecord.dataEventCount === 'number' && Number.isSafeInteger(publicGFollowRecord.dataEventCount) && typeof publicGFollowRecord.terminalAcknowledgements === 'number' && Number.isSafeInteger(publicGFollowRecord.terminalAcknowledgements) && typeof publicGFollowRecord.postTerminalEventCount === 'number' && Number.isSafeInteger(publicGFollowRecord.postTerminalEventCount) ? { dataEventCount: publicGFollowRecord.dataEventCount, terminalAcknowledgements: publicGFollowRecord.terminalAcknowledgements, postTerminalEventCount: publicGFollowRecord.postTerminalEventCount } : null;",
    "  if (!publicGFollowEvidence || publicGFollowEvidence.dataEventCount < 1 || publicGFollowEvidence.terminalAcknowledgements !== 1 || publicGFollowEvidence.postTerminalEventCount !== 0) throw new Error('packed_external_public_g_follow_invalid');",
    '  let backgroundFollowEnabled: unknown = null;',
    '  let backgroundFollowDisabled: unknown = null;',
    '  let backgroundFollowPrimaryFailure: unknown = null;',
    '  let backgroundFollowEnableFailed = false;',
    '  try {',
    "    const backgroundFollowEnabledResult = await context.services.actions.execute('sessions.external.backgroundFollow.set', { sessionId: attached.sessionId, enabled: true });",
    '    backgroundFollowEnabled = backgroundFollowEnabledResult;',
    "    if (!backgroundFollowEnabledResult.ok || backgroundFollowEnabledResult.enabled !== true || backgroundFollowEnabledResult.leaseActive !== true) throw new Error('packed_external_background_follow_enable_invalid');",
    '  } catch (error) {',
    '    backgroundFollowEnableFailed = true;',
    '    backgroundFollowPrimaryFailure = error;',
    '  } finally {',
    '    try {',
    "      const backgroundFollowDisabledResult = await context.services.actions.execute('sessions.external.backgroundFollow.set', { sessionId: attached.sessionId, enabled: false });",
    '      backgroundFollowDisabled = backgroundFollowDisabledResult;',
    "      if (!backgroundFollowDisabledResult.ok || backgroundFollowDisabledResult.enabled !== false || backgroundFollowDisabledResult.leaseActive !== false) throw new Error('packed_external_background_follow_disable_invalid');",
    '    } catch (cleanupError) {',
    '      if (backgroundFollowEnableFailed) {',
    "        throw new AggregateError([backgroundFollowPrimaryFailure, cleanupError], 'packed_external_background_follow_enable_and_cleanup_failed');",
    '      }',
    '      throw cleanupError;',
    '    }',
    '  }',
    '  if (backgroundFollowEnableFailed) throw backgroundFollowPrimaryFailure;',
    "  const takeover = await context.services.sessions.external.takeover(publicRef, { targetStorageMode: 'external-linked', idempotencyKey: `packed-takeover-${packedAgentGeneration}` });",
    "  const status = await context.services.actions.execute('sessions.external.operation.status.get', takeover);",
    "  const recovery = await context.services.actions.execute('sessions.external.operation.resume', status.ok ? status.operation : takeover);",
    "  const materialize = await context.services.actions.execute('sessions.external.materialize.start', { request: { v: 1, idempotencyKey: `packed-materialize-${packedAgentGeneration}`, sessionId: attached.sessionId, plan: 'materialize', targetStorageMode: 'external-linked', targetRuntimeMode: null } });",
    "  return { phase: 'final', capabilities, listPage: listed, transcriptPage: transcript, publicRef, follow: { startingCursor: followed.startingCursor, events, dataEvent: followDataEvent, listenerSettled: true, disposedTerminalAcknowledgements, postTerminalEventCount, disposed: true }, attachedSessionId: attached.sessionId, backgroundFollowEnabled, backgroundFollowDisabled, takeover, materialize, status, recovery, handoff: { publicGCursorRetirementCode, publicGFollowCursorRetirementCode, publicGFollow: publicGFollowEvidence } };",
    '}',
    '',
    'const plugin = definePlugin({',
    `  id: ${JSON.stringify(CANDIDATE_HANDOFF_AGENT_PLUGIN_ID)},`,
    `  version: ${JSON.stringify(input.version)},`,
    `  displayName: ${JSON.stringify(`Packed public Agent ${input.generation}`)},`,
    "  engines: { happier: '^0.2.0' },",
    "  entrypoints: { daemon: './dist/index.js' },",
    '  hostAccess: { required: [], optional: [] },',
    '  actions: {',
    "    'external-sessions-acceptance': {",
    "      title: 'Packed External Sessions acceptance',",
    "      scopes: ['global'],",
    "      surfaces: ['cli'],",
    "      execution: { target: 'daemon' },",
    "      dangerLevel: 'externalSideEffect',",
    "      confirmation: { title: 'Run packed External Sessions acceptance?', body: 'Runs the packed External Sessions acceptance flow.', confirmLabel: 'Run acceptance' },",
    '      async run(_input, context) {',
    '        return await runPackedExternalSessionsAcceptance(context);',
    '      },',
    '    },',
    '  },',
    '  commands: {',
    "    'external-sessions-acceptance-command': { title: 'Packed External Sessions acceptance', path: ['packed-candidate', 'external-sessions'], action: 'external-sessions-acceptance' },",
    '  },',
    '  agents: {',
    `    ${JSON.stringify(CANDIDATE_HANDOFF_AGENT_ID)}: {`,
    `      declaration: ${JSON.stringify(candidateHandoffAgentDeclaration)},`,
    '      factory: createPackedAgentRuntime,',
    '      externalSessions,',
    '      externalSessionObservation,',
    '      providerBinding,',
    "      sessionRunnerFactory: { module: './agentRuntime.js', export: 'createPackedAgentRuntime', runtimeApiVersion: 1, externalSessionsExport: 'externalSessions' },",
    '    },',
    '  },',
    '});',
    '',
    'export const manifest = plugin.manifest;',
    'export const activate = plugin.activate;',
    '',
  ].join('\n'), 'utf8');
}

async function writeCandidateHandoffProviderSource(input: Readonly<{
  pluginRoot: string;
  version: string;
  generation: Extract<CandidateHandoffGeneration, 'P' | 'Q'>;
  wrapperExecutable: string;
}>): Promise<void> {
  await updateCandidateHandoffPackageManifest({
    pluginRoot: input.pluginRoot,
    version: input.version,
    includeTools: true,
  });
  await mkdir(join(input.pluginRoot, 'src'), { recursive: true });
  await mkdir(join(input.pluginRoot, '.happier-plugin'), { recursive: true });
  const toolsRoot = join(input.pluginRoot, 'tools', 'unpacked');
  await rm(toolsRoot, { recursive: true, force: true });
  await mkdir(toolsRoot, { recursive: true });
  const wrapperName = basename(input.wrapperExecutable);
  await copyFile(input.wrapperExecutable, join(toolsRoot, wrapperName));
  await chmod(join(toolsRoot, wrapperName), 0o755);
  for (const name of [
    'CLIProxyAPI-LICENSE',
    'CLIProxyAPI-THIRD-PARTY-NOTICES',
  ]) {
    await copyFile(join(resolve(input.wrapperExecutable, '..'), name),
      join(toolsRoot, name));
  }
  const providerDeclaration = {
    v: 1,
    id: CANDIDATE_HANDOFF_PROVIDER_ID,
    name: 'Packed public Provider',
    kind: 'aggregator',
    credential: {
      kind: 'apiKey',
      required: false,
      slotId: 'apiKey',
      transports: [{
        id: 'runtime-bearer',
        protocols: ['openai-responses'],
        uses: ['runtime'],
        destination: {
          kind: 'httpHeader',
          name: 'authorization',
          format: 'bearer',
        },
      }],
    },
    endpointTemplates: [{
      id: CANDIDATE_HANDOFF_PROVIDER_ENDPOINT_ID,
      protocol: 'openai-responses',
      baseUrl: 'https://example.test/v1',
      capabilities: {
        streaming: 'supported',
        toolRoundTrips: 'supported',
        statefulResponses: 'unknown',
        reasoningControls: 'supported',
      },
    }],
    catalog: {
      source: 'static',
      manualModelPolicy: 'allowed',
      staticModels: [{
        id: CANDIDATE_HANDOFF_MODEL_ID,
        name: 'Packed public model',
        capabilities: {
          toolRoundTrips: 'supported',
          reasoningControls: 'supported',
        },
      }],
    },
    managedRuntime: {
      kind: 'managed',
      connectedAccounts: [{
        purpose: 'openai-upstream',
        service: {
          pluginId: 'happier.agent.codex',
          localId: 'openai-codex',
        },
        required: false,
        materializationKinds: ['httpHeaders'],
      }],
      requestAuthUses: [{
        purpose: 'openai-upstream',
        materialization: {
          kind: 'httpHeaders',
          origin: 'https://chatgpt.com',
          headerNames: ['authorization', 'chatgpt-account-id'],
        },
      }],
      endpointTemplateIds: [CANDIDATE_HANDOFF_PROVIDER_ENDPOINT_ID],
    },
  };
  await writeFile(
    join(input.pluginRoot, '.happier-plugin', 'plugin.json'),
    `${JSON.stringify({
      schemaVersion: 2,
      id: CANDIDATE_HANDOFF_PROVIDER_PLUGIN_ID,
      version: input.version,
      displayName: `Packed public Provider ${input.generation}`,
      engines: { happier: '^0.2.0' },
      runtime: { apiVersion: 1 },
      entrypoints: { daemon: './dist/index.js' },
      hostAccess: { required: [], optional: [] },
      contributes: {
        agents: [],
        providers: [providerDeclaration],
      },
    }, null, 2)}\n`,
    'utf8',
  );
  await writeFile(join(input.pluginRoot, 'src', 'index.ts'), [
    "import { definePlugin } from '@happier-dev/plugin-sdk';",
    "import type { ManagedServiceSpec } from '@happier-dev/plugin-sdk/managed-services';",
    "import type { ManagedProviderRuntime } from '@happier-dev/plugin-sdk/providers';",
    '',
    `export const packedProviderGeneration = ${JSON.stringify(input.generation)} as const;`,
    'const serviceSpec = Object.freeze({',
    `  id: ${JSON.stringify(CANDIDATE_HANDOFF_PROVIDER_SERVICE_ID)},`,
    `  requestAuth: { kind: 'connectedAccountCapabilityPath', injectEnvironmentKey: ${JSON.stringify(CANDIDATE_HANDOFF_REQUEST_AUTH_CAPABILITY_ENV)} },`,
    '  clientAccess: {',
    "    kind: 'hostBearer',",
    `    injectEnvironmentKey: ${JSON.stringify(CANDIDATE_HANDOFF_PROVIDER_BEARER_ENV)},`,
    "    headerName: 'authorization',",
    "    scheme: 'Bearer',",
    '  },',
    '  mode: {',
    "    kind: 'spawn',",
    '    launch: {',
    `      executable: { kind: 'packaged-runtime-binary', directorySegments: ['tools', 'unpacked'], executableBaseName: ${JSON.stringify(CANDIDATE_HANDOFF_PROVIDER_BINARY_NAME)} },`,
    "      env: { HOST: '127.0.0.1', PACKED_PROVIDER_GENERATION: packedProviderGeneration },",
    '    },',
    "    endpoint: { kind: 'assignAndInject', host: '127.0.0.1', port: { kind: 'allocated' }, inject: { portEnvironmentKey: 'PORT' } },",
    '  },',
    "  healthCheck: { kind: 'http', target: { kind: 'servicePath', path: '/healthz' } },",
    '}) satisfies ManagedServiceSpec;',
    '',
    "const start: ManagedProviderRuntime['start'] = async (request, context) => {",
    '  const service = await context.managedServices.supervise(serviceSpec, { signal: context.signal });',
    '  try {',
    '    const snapshot = await service.waitUntilHealthy({ signal: context.signal });',
    "    if (snapshot.state !== 'healthy' || snapshot.baseUrl === null) throw new Error('Packed public Provider did not become healthy');",
    '  } catch (error) {',
    '    await service.dispose();',
    '    throw error;',
    '  }',
    '  return {',
    '    service,',
    "    endpoints: request.endpointTemplateIds.map((endpointTemplateId) => ({ endpointTemplateId, endpoint: { kind: 'servicePath', path: '/v1' } })),",
    '  };',
    '};',
    'const runtime: ManagedProviderRuntime = Object.freeze({ start });',
    '',
    'const plugin = definePlugin({',
    `  id: ${JSON.stringify(CANDIDATE_HANDOFF_PROVIDER_PLUGIN_ID)},`,
    `  version: ${JSON.stringify(input.version)},`,
    `  displayName: ${JSON.stringify(`Packed public Provider ${input.generation}`)},`,
    "  engines: { happier: '^0.2.0' },",
    "  entrypoints: { daemon: './dist/index.js' },",
    '  hostAccess: { required: [], optional: [] },',
    '  providers: {',
    `    ${JSON.stringify(CANDIDATE_HANDOFF_PROVIDER_ID)}: {`,
    '      declaration: {',
    "        v: 1, name: 'Packed public Provider', kind: 'aggregator',",
    "        credential: { kind: 'apiKey', required: false, slotId: 'apiKey', transports: [{ id: 'runtime-bearer', protocols: ['openai-responses'], uses: ['runtime'], destination: { kind: 'httpHeader', name: 'authorization', format: 'bearer' } }] },",
    `        endpointTemplates: [{ id: ${JSON.stringify(CANDIDATE_HANDOFF_PROVIDER_ENDPOINT_ID)}, protocol: 'openai-responses', baseUrl: 'https://example.test/v1', capabilities: { streaming: 'supported', toolRoundTrips: 'supported', statefulResponses: 'unknown', reasoningControls: 'supported' } }],`,
    `        catalog: { source: 'static', manualModelPolicy: 'allowed', staticModels: [{ id: ${JSON.stringify(CANDIDATE_HANDOFF_MODEL_ID)}, name: 'Packed public model', capabilities: { toolRoundTrips: 'supported', reasoningControls: 'supported' } }] },`,
    '        managedRuntime: {',
    "          kind: 'managed',",
    `          connectedAccounts: [{ purpose: 'openai-upstream', service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, required: false, materializationKinds: ['httpHeaders'] }],`,
    `          requestAuthUses: [{ purpose: 'openai-upstream', materialization: { kind: 'httpHeaders', origin: 'https://chatgpt.com', headerNames: ['authorization', 'chatgpt-account-id'] } }],`,
    `          endpointTemplateIds: [${JSON.stringify(CANDIDATE_HANDOFF_PROVIDER_ENDPOINT_ID)}],`,
    '        },',
    '      },',
    '      runtime,',
    '    },',
    '  },',
    '});',
    '',
    'export const manifest = plugin.manifest;',
    'export const activate = plugin.activate;',
    '',
  ].join('\n'), 'utf8');
}

type PackedChannelProviderAuthoring = Readonly<{
  cliEntrypoint: string;
  env: NodeJS.ProcessEnv;
  fixtureRoot: string;
  pluginRoot: string;
  sourcePath: string;
  archivePath: string;
  immutableGenerationId: string;
  registry: Awaited<ReturnType<typeof startCandidateRegistry>>;
}>;

function hasArchiveBoundPackedChannelProviderAccess(
  manifest: unknown,
  origin: string,
): boolean {
  if (!isRecord(manifest) || !isRecord(manifest.hostAccess)) return false;
  const required = manifest.hostAccess.required;
  if (!Array.isArray(required)) return false;
  const access = required.find((candidate) => (
    isRecord(candidate)
      && candidate.id === 'fixture-network-client'
  ));
  if (!isRecord(access) || !isRecord(access.scope)) return false;
  const targets = access.scope.targets;
  return Array.isArray(targets)
    && targets.length === 1
    && isRecord(targets[0])
    && targets[0].kind === 'fixedOrigin'
    && targets[0].origin === origin
    && Array.isArray(access.scope.transports)
    && access.scope.transports.length === 1
    && access.scope.transports[0] === 'websocket'
    && access.scope.privateNetwork === true;
}

async function stagePackedChannelProviderFixture(input: Readonly<{
  fixtureRoot: string;
  origin: string;
}>): Promise<string> {
  const sourceFixtureRoot = fileURLToPath(new URL(
    '../../fixtures/plugin-platform/out-of-tree-channel-socket-provider/',
    import.meta.url,
  ));
  const pluginRoot = join(input.fixtureRoot, 'provider');
  const sourcePath = join(sourceFixtureRoot, 'src', 'index.mjs');
  const manifestPath = join(
    sourceFixtureRoot,
    '.happier-plugin',
    'plugin.json',
  );
  const [source, manifestText] = await Promise.all([
    readFile(sourcePath, 'utf8'),
    readFile(manifestPath, 'utf8'),
  ]);
  const staged = createArchiveBoundPackedChannelProviderFixture({
    source,
    manifest: JSON.parse(manifestText) as unknown,
    origin: input.origin,
    strictResultSentinel: PACKED_CHANNEL_PROVIDER_STRICT_RESULT_SENTINEL,
  });
  await Promise.all([
    mkdir(join(pluginRoot, 'src'), { recursive: true, mode: 0o700 }),
    mkdir(join(pluginRoot, 'assets'), { recursive: true, mode: 0o700 }),
    mkdir(join(pluginRoot, '.happier-plugin'), {
      recursive: true,
      mode: 0o700,
    }),
  ]);
  await Promise.all([
    copyFile(
      join(sourceFixtureRoot, 'package.json'),
      join(pluginRoot, 'package.json'),
    ),
    copyFile(
      join(sourceFixtureRoot, 'assets', 'brand.png'),
      join(pluginRoot, 'assets', 'brand.png'),
    ),
    writeFile(join(pluginRoot, 'src', 'index.mjs'), staged.source, {
      mode: 0o600,
    }),
    writeFile(
      join(pluginRoot, '.happier-plugin', 'plugin.json'),
      `${JSON.stringify(staged.manifest, null, 2)}\n`,
      { mode: 0o600 },
    ),
  ]);
  return pluginRoot;
}

function packedChannelProviderReviewDecision(runtime: InitializedRuntime) {
  return async (input: Readonly<{
    happyHomeDir: string;
    pendingChangeId: string;
    review: PackedPluginInstallReview;
  }>) => {
    assert(
      input.happyHomeDir === runtime.happyHomeDir
        && input.review.pluginId === PACKED_CHANNEL_PROVIDER_PLUGIN_ID,
      'packed_channel_provider_review_identity_mismatch',
    );
    return await decideAuthenticatedPluginInstallReview({
      cliHomeDir: input.happyHomeDir,
      serverUrl: runtime.server.baseUrl,
      pendingChangeId: input.pendingChangeId,
      optionalSelections: input.review.optionalHostAccess.map((access) => ({
        accessId: access.id,
        selected: false,
      })),
      confirmPresentUser: async () => true,
    });
  };
}

async function preparePackedChannelProviderAuthoring(input: Readonly<{
  runtime: InitializedRuntime;
  prepared: PackedManagedProviderPreparedInput;
  loopback: PackedChannelProviderLoopback;
}>): Promise<PackedChannelProviderAuthoring> {
  const fixtureRoot = join(input.runtime.inputRoot, 'packed-channel-provider-author');
  await mkdir(fixtureRoot, { recursive: true, mode: 0o700 });
  const channelsProtocol = input.prepared.prepared.candidate.channelsProtocol;
  assert(
    channelsProtocol,
    'packed_channel_provider_channels_protocol_candidate_missing',
  );
  const [sdkBytes, channelsProtocolBytes, sdkManifest, channelsProtocolManifest] =
    await Promise.all([
      readFile(input.prepared.prepared.candidate.sdk.tarballPath),
      readFile(channelsProtocol.tarballPath),
      readPackedPackageManifest(
        input.prepared.prepared.candidate.sdk.tarballPath,
        join(fixtureRoot, 'candidate-sdk-manifest'),
      ),
      readPackedPackageManifest(
        channelsProtocol.tarballPath,
        join(fixtureRoot, 'candidate-channels-protocol-manifest'),
      ),
    ]);
  const registry = await startCandidateRegistry({
    packages: [
      {
        ...input.prepared.prepared.candidate.sdk,
        bytes: sdkBytes,
        packageManifest: sdkManifest,
      },
      {
        ...channelsProtocol,
        bytes: channelsProtocolBytes,
        packageManifest: channelsProtocolManifest,
      },
    ],
  });
  try {
    const env = {
      ...candidateDaemonEnv(input.runtime),
      CI: '1',
    };
    const pluginRoot = await stagePackedChannelProviderFixture({
      fixtureRoot,
      origin: input.loopback.origin,
    });
    const cliEntrypoint = await materializePackedCli({
      cliArtifact: input.prepared.prepared.candidate.cli,
      installRoot: join(fixtureRoot, 'candidate-cli-install'),
      env,
    });
    await runPackedCliJson({
      cliEntrypoint,
      cwd: fixtureRoot,
      env,
      args: [
        'plugins',
        'author',
        'install',
        pluginRoot,
        '--sdk-registry',
        registry.origin,
        '--json',
      ],
    }, 'plugins_dev_install');
    await runPackedCliJson({
      cliEntrypoint,
      cwd: fixtureRoot,
      env,
      args: ['plugins', 'author', 'typecheck', pluginRoot, '--json'],
    }, 'plugins_dev_typecheck');
    const archivePath = join(
      fixtureRoot,
      'out-of-tree-channel-socket-provider.happier-plugin.tgz',
    );
    await runPackedCliJson({
      cliEntrypoint,
      cwd: fixtureRoot,
      env,
      args: ['plugins', 'pack', pluginRoot, '--out', archivePath, '--json'],
    }, 'plugins_pack');
    const packedManifest = await readPackedPackageManifest(
      archivePath,
      join(fixtureRoot, 'packed-channel-provider-manifest'),
    );
    assert(
      hasArchiveBoundPackedChannelProviderAccess(
        packedManifest,
        input.loopback.origin,
      ),
      'packed_channel_provider_archive_loopback_access_mismatch',
    );
    const archiveBytes = await readFile(archivePath);
    const archiveIntegrity = `sha256-${createHash('sha256')
      .update(archiveBytes)
      .digest('base64')}`;
    const installed = await runPackedReviewedPluginInstall({
      cliEntrypoint,
      cwd: fixtureRoot,
      env,
      args: ['plugins', 'install', archivePath, '--json'],
      decideInstallReview: packedChannelProviderReviewDecision(input.runtime),
    });
    assert(
      installed.change.kind === 'committed'
        && typeof installed.change.appliedGeneration === 'string'
        && installed.change.appliedGeneration.length > 0
        && installed.change.appliedGeneration === installed.change.desiredGeneration
        && installed.review.source.kind === 'archive'
        && resolve(installed.review.source.locator) === resolve(archivePath)
        && installed.review.source.integrity === archiveIntegrity,
      'packed_channel_provider_reviewed_archive_install_not_committed',
    );
    return {
      cliEntrypoint,
      env,
      fixtureRoot,
      pluginRoot,
      sourcePath: join(pluginRoot, 'src', 'index.mjs'),
      archivePath,
      immutableGenerationId: installed.change.appliedGeneration,
      registry,
    };
  } catch (error) {
    await registry.close().catch(() => undefined);
    throw error;
  }
}

function candidateHandoffReviewDecision(runtime: InitializedRuntime) {
  return async (input: Readonly<{
    happyHomeDir: string;
    pendingChangeId: string;
    review: Readonly<{
      pluginId: string;
      optionalHostAccess: readonly Readonly<{ id: string }>[];
    }>;
  }>) => {
    assert(
      input.happyHomeDir === runtime.happyHomeDir
        && (
          input.review.pluginId === CANDIDATE_HANDOFF_AGENT_PLUGIN_ID
          || input.review.pluginId === CANDIDATE_HANDOFF_PROVIDER_PLUGIN_ID
        ),
      'packed_managed_provider_candidate_review_identity_mismatch',
    );
    return await decideAuthenticatedPluginInstallReview({
      cliHomeDir: input.happyHomeDir,
      serverUrl: runtime.server.baseUrl,
      pendingChangeId: input.pendingChangeId,
      optionalSelections: input.review.optionalHostAccess.map((access) => ({
        accessId: access.id,
        selected: false,
      })),
      confirmPresentUser: async () => true,
    });
  };
}

async function prepareCandidateHandoffAuthoring(
  runtime: InitializedRuntime,
  input: PackedManagedProviderPreparedInput,
): Promise<CandidateHandoffAuthoring> {
  const fixtureRoot = join(runtime.inputRoot, 'candidate-handoff-author');
  const agentRoot = join(fixtureRoot, 'agent');
  const providerRoot = join(fixtureRoot, 'provider');
  await mkdir(fixtureRoot, { recursive: true, mode: 0o700 });
  const sdkBytes = await readFile(input.prepared.candidate.sdk.tarballPath);
  const sdkManifest = await readPackedPackageManifest(
    input.prepared.candidate.sdk.tarballPath,
    join(fixtureRoot, 'candidate-sdk-manifest'),
  );
  const registry = await startCandidateRegistry({
    packages: [{ ...input.prepared.candidate.sdk, bytes: sdkBytes, packageManifest: sdkManifest }],
  });
  try {
    const env = {
      ...candidateDaemonEnv(runtime),
      CI: '1',
    };
    const cliEntrypoint = await materializePackedCli({
      cliArtifact: input.prepared.candidate.cli,
      installRoot: join(fixtureRoot, 'candidate-cli-install'),
      env,
    });
    for (const spec of [
      { root: agentRoot, id: CANDIDATE_HANDOFF_AGENT_PLUGIN_ID },
      { root: providerRoot, id: CANDIDATE_HANDOFF_PROVIDER_PLUGIN_ID },
    ]) {
      await runPackedCliJson({
        cliEntrypoint,
        cwd: fixtureRoot,
        env,
        args: [
          'plugins',
          'create',
          spec.root,
          '--id',
          spec.id,
          '--json',
        ],
      }, 'plugins_create');
    }
    await writeCandidateHandoffAgentSource({
      pluginRoot: agentRoot,
      version: '1.0.0',
      generation: 'G',
    });
    await writeCandidateHandoffProviderSource({
      pluginRoot: providerRoot,
      version: '1.0.0',
      generation: 'P',
      wrapperExecutable: input.prepared.wrapperExecutable,
    });
    for (const pluginRoot of [agentRoot, providerRoot]) {
      await runPackedCliJson({
        cliEntrypoint,
        cwd: fixtureRoot,
        env,
        args: [
          'plugins',
          'author',
          'install',
          pluginRoot,
          '--sdk-registry',
          registry.origin,
          '--json',
        ],
      }, 'plugins_dev_install');
    }
    return {
      cliEntrypoint,
      env,
      fixtureRoot,
      agentRoot,
      providerRoot,
      registry,
    };
  } catch (error) {
    await registry.close().catch(() => undefined);
    throw error;
  }
}

async function packAndInstallCandidateHandoffGeneration(input: Readonly<{
  runtime?: InitializedRuntime;
  prepared?: PackedManagedProviderPreparedInput;
  authoring: CandidateHandoffAuthoring;
  reviewDecision?: ReturnType<typeof candidateHandoffReviewDecision>;
  family: 'agent' | 'provider';
  generation: CandidateHandoffGeneration;
  version: string;
}>): Promise<CandidateHandoffPackedGeneration> {
  const pluginRoot = input.family === 'agent'
    ? input.authoring.agentRoot
    : input.authoring.providerRoot;
  if (input.family === 'agent') {
    assert(
      input.generation === 'G'
        || input.generation === 'H'
        || input.generation === 'R',
      'packed_managed_provider_candidate_agent_generation_invalid',
    );
    await writeCandidateHandoffAgentSource({
      pluginRoot,
      version: input.version,
      generation: input.generation,
    });
  } else {
    const prepared = input.prepared;
    assert(
      prepared,
      'packed_managed_provider_candidate_provider_preparation_missing',
    );
    assert(
      input.generation === 'P' || input.generation === 'Q',
      'packed_managed_provider_candidate_provider_generation_invalid',
    );
    await writeCandidateHandoffProviderSource({
      pluginRoot,
      version: input.version,
      generation: input.generation,
      wrapperExecutable: prepared.prepared.wrapperExecutable,
    });
  }
  const sources = await Promise.all([
    readFile(join(pluginRoot, 'src', 'index.ts'), 'utf8'),
    ...(input.family === 'agent'
      ? [readFile(join(pluginRoot, 'src', 'agentRuntime.ts'), 'utf8')]
      : []),
  ]);
  assert(
    sources.every((source) =>
      !/from\s+['"]@\//u.test(source)
      && !/packages\/(?:plugin-sdk|protocol)|apps\/cli|\.\.\//u.test(source)
      && [...source.matchAll(/from\s+['"]([^'"]+)['"]/gu)]
        .every((match) => match[1]?.startsWith('@happier-dev/plugin-sdk')
          || match[1]?.startsWith('./'))),
    'packed_managed_provider_candidate_public_surface_bypass',
  );
  const authoredManifest = JSON.parse(await readFile(
    join(pluginRoot, '.happier-plugin', 'plugin.json'),
    'utf8',
  )) as Readonly<{
    contributes?: Readonly<{
      agents?: readonly unknown[];
      providers?: readonly unknown[];
    }>;
  }>;
  assert(
    input.family === 'agent'
      ? authoredManifest.contributes?.agents?.length
        === (input.generation === 'R' ? 0 : 1)
        && authoredManifest.contributes?.providers?.length === 0
      : authoredManifest.contributes?.providers?.length === 1
        && authoredManifest.contributes?.agents?.length === 0,
    'packed_managed_provider_candidate_contribution_split_mismatch',
  );
  if (input.family === 'provider') {
    const prepared = input.prepared;
    assert(
      prepared,
      'packed_managed_provider_candidate_provider_preparation_missing',
    );
    assert(
      await sha256File(join(
        pluginRoot,
        'tools',
        'unpacked',
        basename(prepared.prepared.wrapperExecutable),
      )) === await sha256File(prepared.prepared.wrapperExecutable),
      'packed_managed_provider_candidate_wrapper_bytes_mismatch',
    );
  }
  for (const operation of ['typecheck', 'build'] as const) {
    await runCandidateHandoffCliJson({
      authoring: input.authoring,
      args: ['plugins', 'author', operation, pluginRoot, '--json'],
      expectedKind: `plugins_dev_${operation}`,
    });
  }
  const archivePath = join(
    input.authoring.fixtureRoot,
    `${input.family}-${input.generation.toLowerCase()}.happier-plugin.tgz`,
  );
  await runCandidateHandoffCliJson({
    authoring: input.authoring,
    args: ['plugins', 'pack', pluginRoot, '--out', archivePath, '--json'],
    expectedKind: 'plugins_pack',
  });
  const packedArchiveBytes = await readFile(archivePath);
  const packedArchiveSha256 = createHash('sha256')
    .update(packedArchiveBytes)
    .digest('hex');
  const packedArchiveIntegrity = `sha256-${createHash('sha256')
    .update(packedArchiveBytes)
    .digest('base64')}`;
  const reviewDecision = input.reviewDecision ?? (() => {
    assert(
      input.runtime,
      'packed_managed_provider_candidate_install_runtime_missing',
    );
    return candidateHandoffReviewDecision(input.runtime);
  })();
  const installed = await runPackedReviewedPluginInstall({
    cliEntrypoint: input.authoring.cliEntrypoint,
    cwd: input.authoring.fixtureRoot,
    env: input.authoring.env,
    args: ['plugins', 'install', archivePath, '--json'],
    decideInstallReview: reviewDecision,
    ...(input.authoring.runCli
      ? { runCli: input.authoring.runCli }
      : {}),
  });
  const installedArchiveMatchedPackedBytes =
    installed.review.source.kind === 'archive'
    && resolve(installed.review.source.locator) === resolve(archivePath)
    && installed.review.source.integrity === packedArchiveIntegrity;
  assert(
    installed.change.kind === 'committed'
      && typeof installed.change.appliedGeneration === 'string'
      && installed.change.appliedGeneration.length > 0
      && installed.change.appliedGeneration
        === installed.change.desiredGeneration
      && await sha256File(archivePath) === packedArchiveSha256
      && installedArchiveMatchedPackedBytes,
    'packed_managed_provider_candidate_install_not_committed',
  );
  return {
    archivePath,
    archiveSha256: `sha256:${packedArchiveSha256}`,
    immutableGenerationId: installed.change.appliedGeneration,
    installedArchiveMatchedPackedBytes,
  };
}

async function sha256File(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function listCandidateHandoffWrapperProcesses(
  input: PackedManagedProviderPreparedInput,
): Promise<readonly ObservedCandidateProcess[]> {
  const expectedName = basename(input.prepared.wrapperExecutable)
    .toLowerCase();
  const expectedDigest = await sha256File(input.prepared.wrapperExecutable);
  const observed: ObservedCandidateProcess[] = [];
  for (const entry of await listProcessSnapshot({ ttlMs: 0 })) {
    const command = String(entry.cmd ?? '').trim();
    const name = String(entry.name ?? '').trim().toLowerCase();
    if (!command.toLowerCase().includes(expectedName) && name !== expectedName) {
      continue;
    }
    const identity = await readProcessIdentityByPid(entry.pid);
    const processStartTimeMs = identity?.processStartTimeMs;
    const executablePath = identity
      ? resolveObservedProcessExecutablePath(identity.command)
      : null;
    if (
      !identity
      || typeof processStartTimeMs !== 'number'
      || !Number.isInteger(processStartTimeMs)
      || typeof executablePath !== 'string'
    ) {
      continue;
    }
    const executableDigest = await sha256File(executablePath)
      .catch(() => null);
    if (executableDigest !== expectedDigest) continue;
    observed.push({
      pid: identity.pid,
      processStartTimeMs,
      executablePath: resolve(executablePath),
      command: identity.command,
    });
  }
  return observed.sort((left, right) => left.pid - right.pid);
}

async function setupCandidateHandoffProvider(
  runtime: InitializedRuntime,
  input: PackedManagedProviderPreparedInput,
): Promise<void> {
  const baseline = await listCandidateHandoffWrapperProcesses(input);
  const explicitStart = await callProviderRpc(
    runtime,
    RPC_METHODS.DAEMON_PROVIDERS_CONNECTION_MUTATE,
    {
      action: 'startLocal',
      machineId: runtime.machineId,
      connectionId: CANDIDATE_HANDOFF_CONNECTION_ID,
      contributionKey: CANDIDATE_HANDOFF_PROVIDER_CONTRIBUTION_KEY,
    },
    DaemonProviderConnectionMutationResponseV1Schema,
  );
  assert(
    explicitStart.status === 'success'
      && explicitStart.action === 'startLocal'
      && explicitStart.contributionKey
        === CANDIDATE_HANDOFF_PROVIDER_CONTRIBUTION_KEY,
    'packed_managed_provider_candidate_explicit_start_failed',
  );
  let candidateId: string | null = null;
  await waitFor(async () => {
    const described = await describePublicProviders(runtime);
    candidateId = described.status === 'success'
      ? described.discoveryCandidates.find((candidate) =>
        candidate.contributionKey
          === CANDIDATE_HANDOFF_PROVIDER_CONTRIBUTION_KEY)
        ?.candidateId ?? null
      : null;
    return candidateId !== null;
  }, {
    timeoutMs: 60_000,
    intervalMs: 100,
    context: 'packed candidate Provider discovery',
  });
  assert(candidateId, 'packed_managed_provider_candidate_discovery_missing');
  const enabled = await callProviderRpc(
    runtime,
    RPC_METHODS.DAEMON_PROVIDERS_CONNECTION_MUTATE,
    {
      action: 'enableDetected',
      machineId: runtime.machineId,
      connectionId: CANDIDATE_HANDOFF_CONNECTION_ID,
      candidateId,
      displayName: 'Packed public handoff',
      savedSecretId: null,
    },
    DaemonProviderConnectionMutationResponseV1Schema,
  );
  assert(
    enabled.status === 'success' && enabled.action === 'enableDetected',
    'packed_managed_provider_candidate_enable_detected_failed',
  );
  const purpose = enabled.connection.managedLocalOption
    ?.connectedAccountPurposes.find((entry) =>
      entry.purpose === OPENAI_PURPOSE.purpose);
  assert(
    purpose?.service.pluginId === 'happier.agent.codex'
      && purpose.service.localId === 'openai-codex',
    'packed_managed_provider_candidate_purpose_missing',
  );
  const updated = await callProviderRpc(
    runtime,
    RPC_METHODS.DAEMON_PROVIDERS_CONNECTION_MUTATE,
    {
      action: 'update',
      machineId: runtime.machineId,
      connectionId: CANDIDATE_HANDOFF_CONNECTION_ID,
      expectedRevision: enabled.connection.revision,
      deployment: {
        kind: 'managedLocal',
        purposeBindingDefaults: {
          [OPENAI_PURPOSE.purpose]: {
            kind: 'account',
            account: {
              service: {
                pluginId: purpose.service.pluginId,
                localId: purpose.service.localId,
              },
              accountId: 'work',
            },
          },
        },
      },
    },
    DaemonProviderConnectionMutationResponseV1Schema,
  );
  assert(
    updated.status === 'success' && updated.action === 'update',
    'packed_managed_provider_candidate_deployment_update_failed',
  );
  const granted = await callProviderRpc(
    runtime,
    RPC_METHODS.DAEMON_PROVIDERS_CONNECTION_MUTATE,
    {
      action: 'setEnabled',
      machineId: runtime.machineId,
      connectionId: CANDIDATE_HANDOFF_CONNECTION_ID,
      enabled: true,
      scope: 'machine',
    },
    DaemonProviderConnectionMutationResponseV1Schema,
  );
  assert(
    granted.status === 'success'
      && granted.action === 'setEnabled'
      && granted.connection.authorized,
    'packed_managed_provider_candidate_machine_grant_failed',
  );
  await waitFor(async () => {
    const after = await listCandidateHandoffWrapperProcesses(input);
    return after.length === baseline.length
      && after.every((process) => baseline.some((before) =>
        sameCandidateProcess(before, process)));
  }, {
    timeoutMs: 60_000,
    intervalMs: 50,
    context: 'packed candidate Provider setup owner release',
  });
}

function candidateHandoffSpawnRequest(runtime: InitializedRuntime): Readonly<{
  body: Readonly<Record<string, unknown>>;
  promptSentinel: string;
}> {
  const spawnNonce = randomUUID();
  const promptSentinel = `packed-candidate-handoff:${spawnNonce}`;
  return {
    promptSentinel,
    body: {
      directory: runtime.workspaceDir,
      spawnNonce,
      agent: CANDIDATE_HANDOFF_AGENT_ID,
      backendTarget: {
        kind: 'backend',
        backendId: CANDIDATE_HANDOFF_AGENT_ID,
        sourceKind: 'built_in',
      },
      terminal: { mode: 'plain' },
      modelSelection: {
        v: 1,
        updatedAt: Date.now(),
        ref: {
          agentTargetKey: CANDIDATE_HANDOFF_AGENT_TARGET_KEY,
          providerConnectionId: CANDIDATE_HANDOFF_CONNECTION_ID,
          modelId: CANDIDATE_HANDOFF_MODEL_ID,
        },
      },
      pendingFirstInput: {
        text: promptSentinel,
        localId: `packed-candidate-handoff:${spawnNonce}`,
      },
      environmentVariables: {
        CI: '1',
        HAPPIER_HOME_DIR: runtime.happyHomeDir,
        HAPPIER_SERVER_URL: runtime.serverProxy.baseUrl,
        HAPPIER_WEBAPP_URL: runtime.serverProxy.baseUrl,
        HAPPIER_VARIANT: 'dev',
        HAPPIER_DISABLE_CAFFEINATE: '1',
        HTTPS_PROXY: runtime.connectProxy.url,
        https_proxy: runtime.connectProxy.url,
        SSL_CERT_FILE: runtime.connectProxy.caCertPath,
        NODE_EXTRA_CA_CERTS: runtime.connectProxy.caCertPath,
        NO_PROXY: '127.0.0.1,localhost',
        no_proxy: '127.0.0.1,localhost',
      },
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': { source: 'connected', profileId: 'work' },
        },
      },
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

const PACKED_CANDIDATE_PUBLIC_EXTERNAL_SESSIONS_PRIVATE_KEYS = new Set([
  'accountId',
  'claim',
  'custody',
  'fence',
  'generation',
  'linkData',
  'linkMetadata',
  'machineId',
  'operationClaim',
  'operationClaimId',
  'operationRecord',
  'operationRow',
  'path',
  'raw',
  'resolvedSource',
  'runtime',
  'runtimeDescriptor',
  'source',
  'sourcePath',
  'staging',
  'stagingPath',
]);

/**
 * The generated packed action is intentionally a public-SDK consumer. Keep
 * its observed result free of daemon/plugin-private owner metadata so this
 * vertical cannot accidentally prove a private route instead.
 */
export function assertPackedCandidatePublicExternalSessionsPrivacy(
  value: unknown,
): void {
  const visited = new Set<object>();
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }
    if (!isRecord(candidate)) return;
    if (visited.has(candidate)) return;
    visited.add(candidate);
    for (const [key, nested] of Object.entries(candidate)) {
      if (PACKED_CANDIDATE_PUBLIC_EXTERNAL_SESSIONS_PRIVATE_KEYS.has(key)) {
        throw new Error(
          'packed managed public External Sessions leaked private metadata',
        );
      }
      visit(nested);
    }
  };
  visit(value);
}

function samePackedCandidatePublicExternalSessionRef(
  left: CandidateHandoffExternalSessionsPublicPhase['publicRef'],
  right: CandidateHandoffExternalSessionsPublicPhase['publicRef'],
): boolean {
  return left.agentId === right.agentId
    && left.sourceId === right.sourceId
    && left.remoteSessionId === right.remoteSessionId;
}

async function runCandidateHandoffCliJson(input: Readonly<{
  authoring: CandidateHandoffAuthoring;
  args: readonly string[];
  expectedKind: string;
}>): Promise<PackedCliJsonEnvelope> {
  if (!input.authoring.runCli) {
    return await runPackedCliJson({
      cliEntrypoint: input.authoring.cliEntrypoint,
      cwd: input.authoring.fixtureRoot,
      env: input.authoring.env,
      args: [...input.args],
    }, input.expectedKind);
  }
  const result = await input.authoring.runCli({
    cliEntrypoint: input.authoring.cliEntrypoint,
    cwd: input.authoring.fixtureRoot,
    env: input.authoring.env,
    args: input.args,
  });
  assert(
    result.code === 0 && result.signal === null,
    `packed_managed_provider_candidate_cli_command_failed:${input.expectedKind}`,
  );
  return parseSuccessfulCommandEnvelope(result.stdout, input.expectedKind);
}

async function invokeCandidateHandoffExternalSessionsPublicPhase(input: Readonly<{
  authoring: CandidateHandoffAuthoring;
  expectedGeneration: 'G' | 'H';
  expectedPhase: 'snapshot' | 'final';
  expectedPublicGFollow?: 'retired';
  expectedPublicRef?: Readonly<{
    agentId: string;
    sourceId: string;
    remoteSessionId: string;
  }>;
}>): Promise<CandidateHandoffExternalSessionsPublicPhase> {
  const envelope = await runCandidateHandoffCliJson({
    authoring: input.authoring,
    args: ['packed-candidate', 'external-sessions', '--json'],
    expectedKind: 'plugin_command',
  });
  const rawData: unknown = envelope.data;
  const data = isRecord(rawData) ? rawData : null;
  const result = data && isRecord(data.result) ? data.result : null;
  if (result) assertPackedCandidatePublicExternalSessionsPrivacy(result);
  const capabilities = parsePackedCandidatePublicExternalSessionsCapabilities(
    result?.capabilities,
  );
  const listPage = parsePackedCandidatePublicListPage(result?.listPage);
  const transcriptPage = parsePackedCandidatePublicTranscriptPage(
    result?.transcriptPage,
  );
  const follow = result && isRecord(result.follow) ? result.follow : null;
  const followDataEvent = parsePackedCandidatePublicFollowDataEvent(
    follow?.dataEvent,
  );
  const candidate = listPage?.items[0] ?? null;
  const transcriptItem = transcriptPage?.items[0] ?? null;
  const followItem = followDataEvent?.items[0] ?? null;
  const publicRef = result && ExternalSessionRefSchema.safeParse(result.publicRef)
    .success
    ? result.publicRef as CandidateHandoffExternalSessionsPublicPhase['publicRef']
    : null;
  const commonResultKeys = [
    'phase',
    'capabilities',
    'listPage',
    'transcriptPage',
    'publicRef',
    'follow',
  ] as const;
  const exactResultKeys = input.expectedPhase === 'snapshot'
    ? commonResultKeys
    : [
      ...commonResultKeys,
      'attachedSessionId',
      'backgroundFollowEnabled',
      'backgroundFollowDisabled',
      'takeover',
      'materialize',
      'status',
      'recovery',
      'handoff',
    ] as const;
  assert(
    result
      && hasExactCandidateHandoffKeys(result, exactResultKeys)
      && result.phase === input.expectedPhase
      && capabilities
      && listPage
      && transcriptPage
      && follow
      && followDataEvent
      && candidate
      && transcriptItem
      && followItem
      && publicRef
      && (!input.expectedPublicRef
        || samePackedCandidatePublicExternalSessionRef(
          publicRef,
          input.expectedPublicRef,
        ))
      && hasExactCandidateHandoffKeys(
        follow,
        [
          'startingCursor',
          'events',
          'dataEvent',
          'listenerSettled',
          'disposedTerminalAcknowledgements',
          'postTerminalEventCount',
          'disposed',
        ],
      )
      && (typeof follow.startingCursor === 'string'
        || follow.startingCursor === null)
      && Array.isArray(follow.events)
      && follow.events.every((event: unknown) =>
        typeof event === 'string')
      && follow.events.includes('data')
      && follow.listenerSettled === true
      && follow.postTerminalEventCount === 0
      && (
        input.expectedPhase === 'snapshot'
          ? follow.events.filter((event: unknown) => event === 'terminated')
            .length === 0
            && follow.disposedTerminalAcknowledgements === 0
            && follow.disposed === false
          : follow.events.filter((event: unknown) => event === 'terminated')
            .length === 1
            && follow.disposedTerminalAcknowledgements === 1
            && follow.disposed === true
      )
      && (
        input.expectedPhase === 'snapshot'
        || (
          typeof result.attachedSessionId === 'string'
          && isPackedCandidateBackgroundFollowActionResult(
            result.backgroundFollowEnabled,
            true,
          )
          && isPackedCandidateBackgroundFollowActionResult(
            result.backgroundFollowDisabled,
            false,
          )
          && isCandidateHandoffOperationReference(result.takeover)
          && isPackedCandidateMaterializeActionResult(result.materialize)
          && isPackedCandidateOperationActionResult(result.status)
          && isPackedCandidateOperationActionResult(result.recovery)
          && isRecord(result.handoff)
          && hasExactCandidateHandoffKeys(
            result.handoff,
            [
              'publicGCursorRetirementCode',
              'publicGFollowCursorRetirementCode',
              'publicGFollow',
            ],
          )
          && (typeof result.handoff.publicGCursorRetirementCode === 'string'
            || result.handoff.publicGCursorRetirementCode === null)
          && (
            typeof result.handoff.publicGFollowCursorRetirementCode === 'string'
            || result.handoff.publicGFollowCursorRetirementCode === null
          )
          && isRecord(result.handoff.publicGFollow)
          && hasExactCandidateHandoffKeys(
            result.handoff.publicGFollow,
            [
              'dataEventCount',
              'terminalAcknowledgements',
              'postTerminalEventCount',
            ],
          )
          && typeof result.handoff.publicGFollow.dataEventCount === 'number'
          && Number.isSafeInteger(result.handoff.publicGFollow.dataEventCount)
          && result.handoff.publicGFollow.dataEventCount >= 1
          && typeof result.handoff.publicGFollow.terminalAcknowledgements
            === 'number'
          && Number.isSafeInteger(
            result.handoff.publicGFollow.terminalAcknowledgements,
          )
          && typeof result.handoff.publicGFollow.postTerminalEventCount
            === 'number'
          && Number.isSafeInteger(
            result.handoff.publicGFollow.postTerminalEventCount,
          )
          && result.handoff.publicGFollow.postTerminalEventCount === 0
          && (
            input.expectedPublicGFollow === undefined
            || result.handoff.publicGFollow.terminalAcknowledgements === 1
          )
        )
      ),
    'packed_managed_provider_candidate_external_sessions_public_phase_invalid',
  );
  return {
    generation: input.expectedGeneration,
    phase: input.expectedPhase,
    capabilities,
    candidate: candidate.ref,
    publicRef,
    candidateTitle: candidate.title ?? null,
    candidateCursor: listPage.nextCursor,
    transcriptItemId: transcriptItem.id,
    tailCursor: transcriptPage.tailCursor ?? null,
    follow: {
      startingCursor: follow.startingCursor as string | null,
      events: follow.events as readonly string[],
      itemId: followItem.id,
      listenerSettled: true,
      disposedTerminalAcknowledgements:
        follow.disposedTerminalAcknowledgements as number,
      postTerminalEventCount: follow.postTerminalEventCount as number,
      disposed: follow.disposed as boolean,
    },
    ...(input.expectedPhase === 'final'
      ? {
        attachedSessionId: result.attachedSessionId as string,
        backgroundFollowEnabled: result.backgroundFollowEnabled,
        backgroundFollowDisabled: result.backgroundFollowDisabled,
        takeover: result.takeover,
        materialize: result.materialize,
        status: result.status,
        recovery: result.recovery,
        handoff: result.handoff as NonNullable<
          CandidateHandoffExternalSessionsPublicPhase['handoff']
        >,
      }
      : {}),
  };
}

const CURRENT_SOURCE_PACKED_EXTERNAL_SESSIONS_REPOSITORY_ROOT = fileURLToPath(
  new URL('../../../../', import.meta.url),
);

async function runCurrentSourcePackedExternalSessionsCli(input: Readonly<{
  cliLaunchSpec: CliTestLaunchSpec;
  cwd: string;
  env: NodeJS.ProcessEnv;
  args: readonly string[];
}>): Promise<CandidateHandoffCliRunResult> {
  return await new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(
      input.cliLaunchSpec.command,
      [...input.cliLaunchSpec.args, ...input.args],
      {
        cwd: input.cwd,
        env: {
          ...input.env,
          ...(input.cliLaunchSpec.env ?? {}),
          CI: '1',
          HAPPIER_SESSION_AUTOSTART_DAEMON: '0',
          HAPPIER_DISABLE_CAFFEINATE: '1',
          HAPPIER_VARIANT: 'dev',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    const stdout = child.stdout;
    const stderr = child.stderr;
    if (!stdout || !stderr) {
      child.kill();
      rejectCommand(
        new Error('packed_current_source_external_sessions_cli_stdio_missing'),
      );
      return;
    }
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    stdout.on('data', (chunk: Buffer | string) => {
      stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    stderr.on('data', (chunk: Buffer | string) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.once('error', rejectCommand);
    child.once('close', (code, signal) => {
      resolveCommand({
        code,
        signal,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    });
  });
}

async function runCurrentSourcePackedExternalSessionsCliJson(input: Readonly<{
  cliLaunchSpec: CliTestLaunchSpec;
  cwd: string;
  env: NodeJS.ProcessEnv;
  args: readonly string[];
  expectedKind: string;
}>): Promise<PackedCliJsonEnvelope> {
  const result = await runCurrentSourcePackedExternalSessionsCli(input);
  assert(
    result.code === 0 && result.signal === null,
    `packed_current_source_external_sessions_cli_command_failed:${input.expectedKind}`,
  );
  return parseSuccessfulCommandEnvelope(result.stdout, input.expectedKind);
}

async function startCurrentSourcePluginSdkRegistry(
  inputRoot: string,
): Promise<Awaited<ReturnType<typeof startCandidateRegistry>>> {
  const sdkOutputRoot = join(inputRoot, 'current-source-sdk');
  await mkdir(sdkOutputRoot, { recursive: true, mode: 0o700 });
  const packed = await exportPackSandboxTarball({
    monorepoRoot: CURRENT_SOURCE_PACKED_EXTERNAL_SESSIONS_REPOSITORY_ROOT,
    packageRelDir: 'packages/plugin-sdk',
    destinationDir: sdkOutputRoot,
  });
  const tarballName = typeof packed?.tarball?.name === 'string'
    ? packed.tarball.name
    : '';
  assert(
    tarballName.length > 0
      && tarballName === basename(tarballName)
      && tarballName.endsWith('.tgz'),
    'packed_current_source_external_sessions_sdk_pack_identity_invalid',
  );
  const tarballPath = join(sdkOutputRoot, tarballName);
  const [bytes, manifest] = await Promise.all([
    readFile(tarballPath),
    readPackedPackageManifest(
      tarballPath,
      join(sdkOutputRoot, 'manifest'),
    ),
  ]);
  assert(
    manifest.name === '@happier-dev/plugin-sdk'
      && typeof manifest.version === 'string'
      && manifest.version.length > 0,
    'packed_current_source_external_sessions_sdk_package_identity_invalid',
  );
  return await startCandidateRegistry({
    packages: [{
      packageName: '@happier-dev/plugin-sdk',
      version: manifest.version,
      integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
      bytes,
      packageManifest: manifest,
    }],
  });
}

/**
 * Runs the existing public G→H External Sessions archive fixture against a
 * current-source CLI snapshot. This is deliberately separate from the
 * release-candidate vertical: it proves the moving-source public SDK path and
 * never claims a native standalone artifact, signing, or notarization fact.
 */
export async function runPackedCurrentSourceExternalSessions(): Promise<
  PackedCurrentSourceExternalSessionsObservation
> {
  let inputRoot: string;
  try {
    inputRoot = await mkdtemp(join(
      tmpdir(),
      'happier-packed-current-source-external-sessions-',
    ));
  } catch (cause) {
    throw new PackedCurrentSourceExternalSessionsExecutionError({
      stage: 'input-root',
      cause,
    });
  }
  const testDir = join(inputRoot, 'harness');
  const happyHomeDir = join(inputRoot, 'home');
  const workspaceDir = join(inputRoot, 'workspace');
  const fixtureRoot = join(inputRoot, 'external-author');
  const agentRoot = join(fixtureRoot, 'agent');
  const providerRoot = join(fixtureRoot, 'provider');
  let cliLaunchSpec: CliTestLaunchSpec | null = null;
  let server: StartedServer | null = null;
  let daemon: StartedDaemon | null = null;
  let registry: Awaited<ReturnType<typeof startCandidateRegistry>> | null = null;
  let observation: PackedCurrentSourceExternalSessionsObservation | null = null;
  let primaryError: PackedCurrentSourceExternalSessionsExecutionError | null = null;
  let currentStage: PackedCurrentSourceExternalSessionsStage = 'directories';

  try {
    await Promise.all([
      mkdir(testDir, { recursive: true, mode: 0o700 }),
      mkdir(happyHomeDir, { recursive: true, mode: 0o700 }),
      mkdir(workspaceDir, { recursive: true, mode: 0o700 }),
      mkdir(fixtureRoot, { recursive: true, mode: 0o700 }),
    ]);
    const featureEnv: NodeJS.ProcessEnv = {
      HAPPIER_FEATURE_PROVIDERS__ENABLED: '1',
      HAPPIER_FEATURE_LOCAL_SERVICES_MANAGED__ENABLED: '0',
      HAPPIER_E2E_CLI_SNAPSHOT_NODE_MODULES_MODE: 'copy',
    };
    currentStage = 'server';
    server = await startServerLight({
      testDir,
      dbProvider: 'sqlite',
      extraEnv: featureEnv,
    });
    currentStage = 'auth-seed';
    const auth = await createTestAuth(server.baseUrl);
    const accountSecret = Uint8Array.from(randomBytes(32));
    await seedCliAuthForServer({
      cliHome: happyHomeDir,
      serverUrl: server.baseUrl,
      token: auth.token,
      secret: accountSecret,
    });
    const daemonEnv: NodeJS.ProcessEnv = {
      ...sanitizePackedAuthorArtifactEnv(
        sanitizeDaemonEnvForSpawn(process.env),
      ),
      ...featureEnv,
      CI: '1',
      HAPPIER_VARIANT: 'dev',
      HAPPIER_DISABLE_CAFFEINATE: '1',
      HAPPIER_HOME_DIR: happyHomeDir,
      HAPPIER_SERVER_URL: server.baseUrl,
      HAPPIER_WEBAPP_URL: server.baseUrl,
      HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED: '0',
    };
    currentStage = 'cli-snapshot';
    cliLaunchSpec = await resolveCliTestLaunchSpec(
      { testDir, env: daemonEnv },
      {
        snapshotDir: join(inputRoot, 'cli-source-snapshot'),
        preferSourceEntrypoint: true,
      },
    );
    currentStage = 'daemon';
    daemon = await startTestDaemon({
      testDir,
      happyHomeDir,
      env: daemonEnv,
      cliLaunchSpec,
      cleanupDescendantsOnExit: true,
      startupTimeoutMs: 120_000,
    });
    currentStage = 'sdk-registry';
    registry = await startCurrentSourcePluginSdkRegistry(inputRoot);

    currentStage = 'plugins-create';
    await runCurrentSourcePackedExternalSessionsCliJson({
      cliLaunchSpec,
      cwd: fixtureRoot,
      env: daemonEnv,
      args: [
        'plugins',
        'create',
        agentRoot,
        '--id',
        CANDIDATE_HANDOFF_AGENT_PLUGIN_ID,
        '--json',
      ],
      expectedKind: 'plugins_create',
    });
    currentStage = 'author-source';
    await writeCandidateHandoffAgentSource({
      pluginRoot: agentRoot,
      version: '1.0.0',
      generation: 'G',
    });
    currentStage = 'author-install';
    await runCurrentSourcePackedExternalSessionsCliJson({
      cliLaunchSpec,
      cwd: fixtureRoot,
      env: daemonEnv,
      args: [
        'plugins',
        'author',
        'install',
        agentRoot,
        '--sdk-registry',
        registry.origin,
        '--json',
      ],
      expectedKind: 'plugins_dev_install',
    });
    const sourceCliLaunchSpec = cliLaunchSpec;
    assert(
      sourceCliLaunchSpec,
      'packed_current_source_external_sessions_cli_launch_spec_missing',
    );
    const cliEntrypoint = sourceCliLaunchSpec.args.at(-1) ?? '';
    assert(
      cliEntrypoint.length > 0,
      'packed_current_source_external_sessions_cli_entrypoint_missing',
    );
    const authoring: CandidateHandoffAuthoring = {
      cliEntrypoint,
      env: daemonEnv,
      fixtureRoot,
      agentRoot,
      providerRoot,
      registry,
      runCli: async (input) => await runCurrentSourcePackedExternalSessionsCli({
        cliLaunchSpec: sourceCliLaunchSpec,
        cwd: input.cwd,
        env: input.env,
        args: input.args,
      }),
    };
    const reviewDecision: ReturnType<typeof candidateHandoffReviewDecision> =
      async (input) => {
        assert(
          input.happyHomeDir === happyHomeDir
            && input.review.pluginId === CANDIDATE_HANDOFF_AGENT_PLUGIN_ID,
          'packed_current_source_external_sessions_review_identity_mismatch',
        );
        return await decideAuthenticatedPluginInstallReview({
          cliHomeDir: input.happyHomeDir,
          serverUrl: server!.baseUrl,
          pendingChangeId: input.pendingChangeId,
          optionalSelections: input.review.optionalHostAccess.map((access) => ({
            accessId: access.id,
            selected: false,
          })),
          confirmPresentUser: async () => true,
        });
      };
    currentStage = 'generation-g';
    const agentG = await packAndInstallCandidateHandoffGeneration({
      authoring,
      reviewDecision,
      family: 'agent',
      generation: 'G',
      version: '1.0.0',
    });
    currentStage = 'public-g';
    const externalSessionsGPhase =
      await invokeCandidateHandoffExternalSessionsPublicPhase({
        authoring,
        expectedGeneration: 'G',
        expectedPhase: 'snapshot',
      });
    currentStage = 'generation-h';
    const agentH = await packAndInstallCandidateHandoffGeneration({
      authoring,
      reviewDecision,
      family: 'agent',
      generation: 'H',
      version: '2.0.0',
    });
    currentStage = 'public-h';
    const externalSessionsHPhase =
      await invokeCandidateHandoffExternalSessionsPublicPhase({
        authoring,
        expectedGeneration: 'H',
        expectedPhase: 'final',
        expectedPublicGFollow: 'retired',
        expectedPublicRef: externalSessionsGPhase.publicRef,
      });
    currentStage = 'handoff-contract';
    assert(
      agentG.installedArchiveMatchedPackedBytes
        && agentH.installedArchiveMatchedPackedBytes
        && agentG.archiveSha256 !== agentH.archiveSha256
        && derivePackedCandidatePublicGeneration({
          expectedGeneration: 'G',
          candidateTitle: externalSessionsGPhase.candidateTitle,
          transcriptItemId: externalSessionsGPhase.transcriptItemId,
          followItemId: externalSessionsGPhase.follow.itemId,
        }) === 'G'
        && derivePackedCandidatePublicGeneration({
          expectedGeneration: 'H',
          candidateTitle: externalSessionsHPhase.candidateTitle,
          transcriptItemId: externalSessionsHPhase.transcriptItemId,
          followItemId: externalSessionsHPhase.follow.itemId,
        }) === 'H'
        && externalSessionsHPhase.handoff?.publicGCursorRetirementCode
          === 'plugin_external_cursor_invalid'
        && externalSessionsHPhase.handoff?.publicGFollowCursorRetirementCode
          === 'plugin_external_cursor_invalid',
      'packed_current_source_external_sessions_public_handoff_invalid',
    );
    observation = {
      sourceCli: 'source-snapshot',
      archives: {
        agentGPackedAndReviewed: true,
        agentHPackedAndReviewed: true,
      },
      publicExternalSessions: {
        currentGeneration: 'H',
        publicGRefRoutedToH: true,
        publicGListCursorRetired: true,
        publicGFollowCursorRetired: true,
        recipientSafeProjection: true,
      },
    };
  } catch (error) {
    primaryError = error instanceof PackedCurrentSourceExternalSessionsExecutionError
      ? error
      : new PackedCurrentSourceExternalSessionsExecutionError({
        stage: currentStage,
        cause: error,
      });
  }

  const cleanupErrors = await collectPackedManagedProviderCleanupErrors([
    ...(registry ? [{ run: async () => await registry!.close() }] : []),
    ...(daemon ? [{ run: async () => await daemon!.stop() }] : []),
    ...(!daemon && cliLaunchSpec?.cleanup
      ? [{ run: async () => await cliLaunchSpec!.cleanup!() }]
      : []),
    ...(server ? [{ run: async () => await server!.stop() }] : []),
    { run: async () => await rm(inputRoot, { recursive: true, force: true }) },
  ]);
  if (primaryError) {
    if (cleanupErrors.length > 0) {
      throw new PackedCurrentSourceExternalSessionsExecutionError({
        stage: primaryError.stage,
        cause: new AggregateError(
          [primaryError.cause, ...cleanupErrors],
          'packed current-source External Sessions proof failed during cleanup',
        ),
      });
    }
    throw primaryError;
  }
  if (cleanupErrors.length > 0) {
    throw new PackedCurrentSourceExternalSessionsExecutionError({
      stage: 'cleanup',
      cause: new AggregateError(
        cleanupErrors,
        'packed current-source External Sessions cleanup failed',
      ),
    });
  }
  if (!observation) {
    throw new PackedCurrentSourceExternalSessionsExecutionError({
      stage: 'handoff-contract',
      cause: new Error(
        'packed_current_source_external_sessions_observation_missing',
      ),
    });
  }
  return observation;
}

function isCandidateHandoffOperationReference(value: unknown): boolean {
  return ExternalSessionOperationReferenceV1Schema.safeParse(value).success;
}

function isPackedCandidateBackgroundFollowActionResult(
  value: unknown,
  expectedEnabled: boolean,
): boolean {
  const parsed = PLUGIN_ACTION_OUTPUT_SCHEMAS[
    'sessions.external.backgroundFollow.set'
  ].safeParse(value);
  return parsed.success
    && isRecord(parsed.data)
    && parsed.data.ok === true
    && parsed.data.enabled === expectedEnabled
    && parsed.data.leaseActive === expectedEnabled;
}

export function isPackedCandidateMaterializeActionResult(
  value: unknown,
): boolean {
  const parsed = ExternalSessionMaterializeActionResultV1Schema.safeParse(
    value,
  );
  return parsed.success && parsed.data.ok;
}

export function isPackedCandidateOperationActionResult(
  value: unknown,
): boolean {
  const parsed = ExternalSessionOperationActionResultV1Schema.safeParse(value);
  return parsed.success && parsed.data.ok;
}

export function isPackedCandidateRetiredListCursorEvidence(
  value: unknown,
): boolean {
  return isRecord(value)
    && value.code === 'plugin_external_cursor_invalid';
}

export function isPackedCandidateRetiredFollowCursorEvidence(
  value: unknown,
): boolean {
  return isRecord(value)
    && value.status === 'unavailable'
    && value.code === 'plugin_external_cursor_invalid';
}

type PackedCandidatePublicCandidate = Readonly<{
  ref: Readonly<{
    agentId: string;
    sourceId: string;
    remoteSessionId: string;
  }>;
  title?: string;
  updatedAtMs?: number;
  capabilities: readonly ('attach' | 'transcript' | 'follow')[];
  takeover:
    | Readonly<{ status: 'unavailable'; code: string }>
    | Readonly<{
      status: 'available';
      storageModes: readonly ('external-linked' | 'persisted')[];
    }>;
}>;

type PackedCandidatePublicListPage = Readonly<{
  items: readonly PackedCandidatePublicCandidate[];
  nextCursor: string | null;
}>;

type PackedCandidatePublicTranscriptItem = Readonly<{
  id: string;
  timestampMs?: number;
  kind: 'user' | 'agent' | 'system' | 'event';
  data: unknown;
}>;

type PackedCandidatePublicTranscriptPage = Readonly<{
  mode: 'page';
  items: readonly PackedCandidatePublicTranscriptItem[];
  nextCursor: string | null;
  tailCursor?: string | null;
  hasMore?: boolean;
  truncated?: boolean;
}>;

type PackedCandidatePublicFollowDataEvent = Readonly<{
  kind: 'data';
  items: readonly PackedCandidatePublicTranscriptItem[];
  fromCursor: string | null;
  nextCursor: string;
}>;

function hasExactCandidateHandoffKeys(
  value: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && keys.every((key) => allowed.has(key));
}

function parsePackedCandidatePublicExternalSessionsCapabilities(
  value: unknown,
): CandidateHandoffExternalSessionsCapabilities | null {
  if (
    !isRecord(value)
    || !hasExactCandidateHandoffKeys(value, [
      'list',
      'attach',
      'takeover',
      'transcript',
      'follow',
    ])
  ) {
    return null;
  }
  const parseAvailable = (
    operation: unknown,
  ): Readonly<{ status: 'available' }> | null => (
    isRecord(operation)
    && hasExactCandidateHandoffKeys(operation, ['status'])
    && operation.status === 'available'
      ? { status: 'available' }
      : null
  );
  const list = parseAvailable(value.list);
  const attach = parseAvailable(value.attach);
  const transcript = parseAvailable(value.transcript);
  const follow = parseAvailable(value.follow);
  const takeover = isRecord(value.takeover)
    && hasExactCandidateHandoffKeys(value.takeover, ['status', 'storageModes'])
    && value.takeover.status === 'available'
    && Array.isArray(value.takeover.storageModes)
    && value.takeover.storageModes.length === 2
    && value.takeover.storageModes[0] === 'external-linked'
    && value.takeover.storageModes[1] === 'persisted'
    ? {
      status: 'available' as const,
      storageModes: ['external-linked', 'persisted'] as const,
    }
    : null;
  return list && attach && takeover && transcript && follow
    ? { list, attach, takeover, transcript, follow }
    : null;
}

function parsePackedCandidatePublicTakeoverCapability(
  value: unknown,
): PackedCandidatePublicCandidate['takeover'] | null {
  if (!isRecord(value)) return null;
  if (
    value.status === 'unavailable'
    && hasExactCandidateHandoffKeys(value, ['status', 'code'])
    && typeof value.code === 'string'
  ) {
    return value as PackedCandidatePublicCandidate['takeover'];
  }
  if (
    value.status === 'available'
    && hasExactCandidateHandoffKeys(value, ['status', 'storageModes'])
    && Array.isArray(value.storageModes)
    && value.storageModes.every((mode) =>
      mode === 'external-linked' || mode === 'persisted')
  ) {
    return value as PackedCandidatePublicCandidate['takeover'];
  }
  return null;
}

function parsePackedCandidatePublicCandidate(
  value: unknown,
): PackedCandidatePublicCandidate | null {
  if (
    !isRecord(value)
    || !hasExactCandidateHandoffKeys(
      value,
      ['ref', 'capabilities', 'takeover'],
      ['title', 'updatedAtMs'],
    )
    || !ExternalSessionRefSchema.safeParse(value.ref).success
    || (value.title !== undefined && typeof value.title !== 'string')
    || (value.updatedAtMs !== undefined
      && !Number.isSafeInteger(value.updatedAtMs))
    || !Array.isArray(value.capabilities)
    || !value.capabilities.every((capability) =>
      capability === 'attach'
      || capability === 'transcript'
      || capability === 'follow')
    || parsePackedCandidatePublicTakeoverCapability(value.takeover) === null
  ) {
    return null;
  }
  return value as PackedCandidatePublicCandidate;
}

function parsePackedCandidatePublicListPage(
  value: unknown,
): PackedCandidatePublicListPage | null {
  if (
    !isRecord(value)
    || !hasExactCandidateHandoffKeys(value, ['items', 'nextCursor'])
    || !Array.isArray(value.items)
    || !value.items.every((candidate) =>
      parsePackedCandidatePublicCandidate(candidate) !== null)
    || (typeof value.nextCursor !== 'string' && value.nextCursor !== null)
  ) {
    return null;
  }
  return value as PackedCandidatePublicListPage;
}

export function isPackedCandidatePublicListPage(value: unknown): boolean {
  return parsePackedCandidatePublicListPage(value) !== null;
}

function parsePackedCandidatePublicTranscriptItem(
  value: unknown,
): PackedCandidatePublicTranscriptItem | null {
  if (
    !isRecord(value)
    || !hasExactCandidateHandoffKeys(
      value,
      ['id', 'kind', 'data'],
      ['timestampMs'],
    )
    || typeof value.id !== 'string'
    || !['user', 'agent', 'system', 'event'].includes(String(value.kind))
    || (value.timestampMs !== undefined
      && !Number.isSafeInteger(value.timestampMs))
  ) {
    return null;
  }
  return value as PackedCandidatePublicTranscriptItem;
}

function parsePackedCandidatePublicTranscriptPage(
  value: unknown,
): PackedCandidatePublicTranscriptPage | null {
  if (
    !isRecord(value)
    || !hasExactCandidateHandoffKeys(
      value,
      ['mode', 'items', 'nextCursor'],
      ['tailCursor', 'hasMore', 'truncated'],
    )
    || value.mode !== 'page'
    || !Array.isArray(value.items)
    || !value.items.every((item) =>
      parsePackedCandidatePublicTranscriptItem(item) !== null)
    || (typeof value.nextCursor !== 'string' && value.nextCursor !== null)
    || (value.tailCursor !== undefined
      && typeof value.tailCursor !== 'string'
      && value.tailCursor !== null)
    || (value.hasMore !== undefined && typeof value.hasMore !== 'boolean')
    || (value.truncated !== undefined && typeof value.truncated !== 'boolean')
  ) {
    return null;
  }
  return value as PackedCandidatePublicTranscriptPage;
}

function parsePackedCandidatePublicFollowDataEvent(
  value: unknown,
): PackedCandidatePublicFollowDataEvent | null {
  if (
    !isRecord(value)
    || !hasExactCandidateHandoffKeys(
      value,
      ['kind', 'items', 'fromCursor', 'nextCursor'],
    )
    || value.kind !== 'data'
    || !Array.isArray(value.items)
    || !value.items.every((item) =>
      parsePackedCandidatePublicTranscriptItem(item) !== null)
    || (typeof value.fromCursor !== 'string' && value.fromCursor !== null)
    || typeof value.nextCursor !== 'string'
  ) {
    return null;
  }
  return value as PackedCandidatePublicFollowDataEvent;
}

export function derivePackedCandidatePublicGeneration(input: Readonly<{
  expectedGeneration: 'G' | 'H';
  candidateTitle: string | null;
  transcriptItemId: string | null;
  followItemId: string | null;
}>): 'G' | 'H' | null {
  const generation = input.expectedGeneration;
  return input.candidateTitle === `Packed ${generation}`
    && input.transcriptItemId === `packed-page-${generation}`
    && input.followItemId === `packed-follow-${generation}`
    ? generation
    : null;
}

async function waitForCandidateHandoffCustody(input: Readonly<{
  runtime: InitializedRuntime;
  sessionId: string;
}>): Promise<CandidateHandoffCustody> {
  const authority = await waitForRunnerDaemonServiceAuthority({
    happyHomeDir: input.runtime.happyHomeDir,
    sessionId: input.sessionId,
  });
  let providerImmutableGenerationId: string | null = null;
  let markerPath: string | null = null;
  await waitFor(async () => {
    for (const base of [
      'daemon-sessions',
      'daemon-sessions.dev',
      'daemon-sessions.preview',
    ]) {
      const directory = join(input.runtime.happyHomeDir, 'tmp', base);
      for (const name of await readdir(directory).catch(() => [])) {
        if (!name.startsWith('pid-') || !name.endsWith('.json')) continue;
        const path = join(directory, name);
        const marker = await readFile(path, 'utf8')
          .then((contents) => JSON.parse(contents) as unknown)
          .catch(() => null);
        if (!isRecord(marker) || marker.happySessionId !== input.sessionId) {
          continue;
        }
        const retention = isRecord(marker.runnerManagedDependencyRetentionV1)
          ? marker.runnerManagedDependencyRetentionV1
          : null;
        const adopted = isRecord(retention?.adoptedManagedProviderAuthority)
          ? retention.adoptedManagedProviderAuthority
          : null;
        if (
          adopted?.pluginId === CANDIDATE_HANDOFF_PROVIDER_PLUGIN_ID
          && typeof adopted.immutableGenerationId === 'string'
          && adopted.immutableGenerationId.length > 0
        ) {
          providerImmutableGenerationId = adopted.immutableGenerationId;
          markerPath = path;
          return true;
        }
      }
    }
    return false;
  }, {
    timeoutMs: 60_000,
    intervalMs: 50,
    context: `packed candidate Provider custody for ${input.sessionId}`,
  });
  assert(
    providerImmutableGenerationId && markerPath,
    'packed_managed_provider_candidate_custody_missing',
  );
  return {
    authority,
    providerImmutableGenerationId,
    markerPath,
  };
}

async function listRequestAuthCapabilityPaths(
  root: string,
): Promise<readonly string[]> {
  const paths: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })
      .catch(() => [])) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (
        entry.isFile()
        && entry.name === 'capability.json'
        && path.includes('request-auth')
      ) {
        paths.push(path);
      }
    }
  };
  await visit(root);
  return paths.sort();
}

async function waitForRetainedProviderClaimFingerprint(input: Readonly<{
  runtime: InitializedRuntime;
  sessionId: string;
}>): Promise<string> {
  let fingerprint: string | null = null;
  await waitFor(async () => {
    for (const base of [
      'daemon-sessions',
      'daemon-sessions.dev',
      'daemon-sessions.preview',
    ]) {
      const directory = join(input.runtime.happyHomeDir, 'tmp', base);
      for (const name of await readdir(directory).catch(() => [])) {
        if (!name.startsWith('pid-') || !name.endsWith('.json')) continue;
        const marker = await readFile(join(directory, name), 'utf8')
          .then((contents) => JSON.parse(contents) as unknown)
          .catch(() => null);
        if (!isRecord(marker) || marker.happySessionId !== input.sessionId) {
          continue;
        }
        const retention = isRecord(marker.runnerManagedDependencyRetentionV1)
          ? marker.runnerManagedDependencyRetentionV1
          : null;
        const claim = isRecord(retention?.adoptedManagedProviderAuthority)
          ? retention.adoptedManagedProviderAuthority
          : null;
        if (
          claim?.pluginId === OPENAI_PURPOSE.consumer.pluginId
          && typeof claim.immutableGenerationId === 'string'
          && claim.immutableGenerationId.length > 0
        ) {
          fingerprint = fingerprintSecret(JSON.stringify(claim));
          return true;
        }
      }
    }
    return false;
  }, {
    timeoutMs: 60_000,
    intervalMs: 50,
    context: `retained packed Provider claim for ${input.sessionId}`,
  });
  assert(fingerprint, 'packed_managed_provider_retained_p_claim_missing');
  return fingerprint;
}

async function lookupRequestAuthCapability(input: Readonly<{
  capability: string;
  httpPort: number;
}>): Promise<PrivateRequestAuthLookup> {
  const response = await fetchJson<unknown>(
    `http://127.0.0.1:${input.httpPort}${CONNECTED_ACCOUNT_REQUEST_AUTH_LOOKUP_PATH}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_HEADER]: input.capability,
      },
      body: JSON.stringify({ purpose: OPENAI_PURPOSE }),
      timeoutMs: 5_000,
    },
  );
  const value = isRecord(response.data) && response.data.ok === true
    && isRecord(response.data.value)
    ? response.data.value
    : null;
  const credentialContext = isRecord(value?.credentialContext)
    ? value.credentialContext
    : null;
  const accessToken = typeof value?.accessToken === 'string'
    ? value.accessToken
    : null;
  return {
    status: response.status,
    credentialRevision: typeof credentialContext?.credentialRevision === 'string'
      ? credentialContext.credentialRevision
      : null,
    accessTokenFingerprint: accessToken
      ? fingerprintSecret(accessToken)
      : null,
  };
}

function sameRequestAuthCapabilityPaths(
  left: readonly PrivateRequestAuthCapability[],
  right: readonly PrivateRequestAuthCapability[],
): boolean {
  return sameStringList(
    left.map((capability) => capability.path),
    right.map((capability) => capability.path),
  );
}

function sameStringList(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function requestAuthCapabilitiesRotated(
  previous: readonly PrivateRequestAuthCapability[],
  current: readonly PrivateRequestAuthCapability[],
): boolean {
  return sameRequestAuthCapabilityPaths(previous, current)
    && previous.every((capability, index) =>
      capability.document.capability !== current[index]?.document.capability);
}

async function waitForCurrentOpenAiRequestAuthCapability(input: Readonly<{
  runtime: InitializedRuntime;
  httpPort: number;
  expectedCredentialRevision?: string;
}>): Promise<readonly PrivateRequestAuthCapability[]> {
  let current: readonly PrivateRequestAuthCapability[] | null = null;
  await waitFor(async () => {
    const observed: PrivateRequestAuthCapability[] = [];
    for (const path of await listRequestAuthCapabilityPaths(
      input.runtime.happyHomeDir,
    )) {
      const document = await readConnectedAccountRequestAuthCapabilityFile(path);
      if (!document || document.httpPort !== input.httpPort) continue;
      const lookup = await lookupRequestAuthCapability({
        capability: document.capability,
        httpPort: document.httpPort,
      });
      if (
        lookup.status !== 200
        || !lookup.credentialRevision
        || !lookup.accessTokenFingerprint
      ) {
        continue;
      }
      observed.push({ path, document, lookup });
    }
    observed.sort((left, right) => left.path.localeCompare(right.path));
    if (
      observed.length !== 1
      || (
        input.expectedCredentialRevision
        && observed.some((capability) =>
          capability.lookup.credentialRevision
            !== input.expectedCredentialRevision)
      )
    ) {
      return false;
    }
    current = observed;
    return true;
  }, {
    timeoutMs: 60_000,
    intervalMs: 50,
    context: 'current packed Provider request-auth capability',
  });
  assert(
    current,
    'packed_managed_provider_current_request_auth_capability_missing',
  );
  return current;
}

type CanonicalAssistantTranscriptOutput = Readonly<{
  logicalId: string;
  texts: readonly string[];
}>;

async function readCanonicalAssistantTranscriptOutputs(input: Readonly<{
  runtime: InitializedRuntime;
  sessionId: string;
}>): Promise<readonly CanonicalAssistantTranscriptOutput[]> {
  const logicalOutputs = new Map<string, Set<string>>();
  for (const row of await fetchAllMessages(
    input.runtime.server.baseUrl,
    input.runtime.auth.token,
    input.sessionId,
  )) {
    try {
      const decrypted = decryptLegacyBase64(
        row.content.c,
        input.runtime.accountSecret,
      ) as Record<string, unknown> | null;
      if (!decrypted || typeof decrypted !== 'object') continue;
      const texts = extractAssistantCandidateTextsFromDecryptedRecord(
        decrypted,
      );
      if (texts.length === 0) continue;
      const meta = isRecord(decrypted.meta) ? decrypted.meta : null;
      const segment = isRecord(meta?.happierStreamSegmentV1)
        ? meta.happierStreamSegmentV1
        : null;
      const logicalId = (
        typeof segment?.segmentLocalId === 'string'
          ? segment.segmentLocalId
          : null
      ) || (
        typeof meta?.happierStreamKey === 'string'
          ? meta.happierStreamKey
          : null
      ) || row.localId || `seq:${row.seq}`;
      const output = logicalOutputs.get(logicalId) ?? new Set<string>();
      texts.forEach((text) => output.add(text));
      logicalOutputs.set(logicalId, output);
    } catch {
      // Malformed rows cannot provide positive exactly-once evidence.
    }
  }
  return [...logicalOutputs].map(([logicalId, texts]) => ({
    logicalId,
    texts: [...texts],
  }));
}

async function countCanonicalAssistantTranscriptOutputs(input: Readonly<{
  runtime: InitializedRuntime;
  sessionId: string;
  sentinel: string;
}>): Promise<number> {
  const outputs = await readCanonicalAssistantTranscriptOutputs(input);
  return outputs.filter((output) => output.texts.some((text) =>
    text.includes(input.sentinel))).length;
}

async function observeCandidateHandoffOutputs(input: Readonly<{
  runtime: InitializedRuntime;
  sessionId: string;
  sentinel: string;
}>): Promise<Readonly<{
  outputCount: number;
  observedAgentGeneration: 'G' | 'H';
}>> {
  const logicalOutputs = new Set<string>();
  const observedGenerations = new Set<'G' | 'H'>();
  for (const output of await readCanonicalAssistantTranscriptOutputs(input)) {
    for (const generation of ['G', 'H'] as const) {
      if (!output.texts.includes(`${generation}:${input.sentinel}`)) continue;
      logicalOutputs.add(`${output.logicalId}:${generation}`);
      observedGenerations.add(generation);
    }
  }
  assert(
    observedGenerations.size === 1,
    'packed_managed_provider_candidate_agent_generation_output_invalid',
  );
  const [observedAgentGeneration] = [...observedGenerations];
  assert(
    observedAgentGeneration,
    'packed_managed_provider_candidate_agent_generation_output_missing',
  );
  return {
    outputCount: logicalOutputs.size,
    observedAgentGeneration,
  };
}

async function countCanonicalTerminalEvents(input: Readonly<{
  runtime: InitializedRuntime;
  sessionId: string;
  turnId: string;
}>): Promise<number> {
  const terminalRows = new Set<string>();
  for (const row of await fetchAllMessages(
    input.runtime.server.baseUrl,
    input.runtime.auth.token,
    input.sessionId,
  )) {
    try {
      const decrypted = decryptLegacyBase64(
        row.content.c,
        input.runtime.accountSecret,
      );
      const normalized = normalizeDecodedTranscriptValue(decrypted);
      const record = isRecord(normalized) ? normalized : null;
      if (record?.type !== 'task_complete' || record.id !== input.turnId) {
        continue;
      }
      terminalRows.add(row.localId || `seq:${row.seq}`);
    } catch {
      // Malformed rows cannot provide positive exactly-once evidence.
    }
  }
  return terminalRows.size;
}

async function observeCandidateHandoffTurn(input: Readonly<{
  runtime: InitializedRuntime;
  sessionId: string;
  sentinel: string;
  expectedAgentGeneration: 'G' | 'H';
  previousCompletedTurnId: string | null;
}>): Promise<CandidateHandoffTurnObservation> {
  await waitForAssistantMessageContaining({
    baseUrl: input.runtime.server.baseUrl,
    token: input.runtime.auth.token,
    sessionId: input.sessionId,
    secret: input.runtime.accountSecret,
    requiredSubstring: input.sentinel,
    timeoutMs: 60_000,
  });
  let completedTurnId: string | null = null;
  await waitFor(async () => {
    completedTurnId = readCompletedTurnId(await fetchSessionV2(
      input.runtime.server.baseUrl,
      input.runtime.auth.token,
      input.sessionId,
    ).catch(() => null));
    return completedTurnId !== null
      && completedTurnId !== input.previousCompletedTurnId;
  }, {
    timeoutMs: 60_000,
    intervalMs: 50,
    context: `packed candidate completed turn for ${input.sessionId}`,
  });
  assert(completedTurnId, 'packed_managed_provider_candidate_turn_missing');
  const output = await observeCandidateHandoffOutputs(input);
  const evidence = {
    expectedAgentGeneration: input.expectedAgentGeneration,
    observedAgentGeneration: output.observedAgentGeneration,
    effectCount: input.runtime.connectProxy.entries().filter((entry) =>
      entry.body.includes(input.sentinel)).length,
    outputCount: output.outputCount,
    terminalCount: await countCanonicalTerminalEvents({
      runtime: input.runtime,
      sessionId: input.sessionId,
      turnId: completedTurnId,
    }),
  };
  assertPackedExactlyOnceTurn(
    evidence,
    'packed_managed_provider_candidate_turn_not_exactly_once',
  );
  return {
    completedTurnId,
    witness: {
      sessionId: input.sessionId,
      sentinel: input.sentinel,
      expectedAgentGeneration: input.expectedAgentGeneration,
      completedTurnId,
    },
    evidence,
  };
}

async function recountCandidateHandoffTurn(
  runtime: InitializedRuntime,
  witness: CandidateHandoffTurnWitness,
): Promise<PackedManagedProviderExactlyOnceTurnEvidence> {
  const output = await observeCandidateHandoffOutputs({
    runtime,
    sessionId: witness.sessionId,
    sentinel: witness.sentinel,
  });
  return {
    expectedAgentGeneration: witness.expectedAgentGeneration,
    observedAgentGeneration: output.observedAgentGeneration,
    effectCount: runtime.connectProxy.entries().filter((entry) =>
      entry.body.includes(witness.sentinel)).length,
    outputCount: output.outputCount,
    terminalCount: await countCanonicalTerminalEvents({
      runtime,
      sessionId: witness.sessionId,
      turnId: witness.completedTurnId,
    }),
  };
}

type PackedManagedProviderContinuityTurnEvidence = Readonly<{
  effectCount: number;
  outputCount: number;
  terminalCount: number;
}>;

type PackedManagedProviderContinuityTurnWitness = Readonly<{
  sessionId: string;
  sentinel: string;
  completedTurnId: string;
}>;

type PackedManagedProviderContinuityTurnObservation = Readonly<{
  witness: PackedManagedProviderContinuityTurnWitness;
  evidence: PackedManagedProviderContinuityTurnEvidence;
}>;

function assertPackedManagedProviderContinuityTurn(
  evidence: PackedManagedProviderContinuityTurnEvidence,
  errorCode: string,
): void {
  assert(
    evidence.effectCount === 1
      && evidence.outputCount === 1
      && evidence.terminalCount === 1,
    errorCode,
  );
}

async function observePackedManagedProviderContinuityTurn(input: Readonly<{
  runtime: InitializedRuntime;
  sessionId: string;
  sentinel: string;
  previousCompletedTurnId: string | null;
}>): Promise<PackedManagedProviderContinuityTurnObservation> {
  await waitForAssistantMessageContaining({
    baseUrl: input.runtime.server.baseUrl,
    token: input.runtime.auth.token,
    sessionId: input.sessionId,
    secret: input.runtime.accountSecret,
    requiredSubstring: input.sentinel,
    timeoutMs: 60_000,
  });
  let completedTurnId: string | null = null;
  await waitFor(async () => {
    completedTurnId = readCompletedTurnId(await fetchSessionV2(
      input.runtime.server.baseUrl,
      input.runtime.auth.token,
      input.sessionId,
    ).catch(() => null));
    return completedTurnId !== null
      && completedTurnId !== input.previousCompletedTurnId;
  }, {
    timeoutMs: 60_000,
    intervalMs: 50,
    context: `packed managed continuity completed turn for ${input.sessionId}`,
  });
  assert(
    completedTurnId,
    'packed_managed_provider_continuity_turn_missing',
  );
  const evidence = {
    effectCount: input.runtime.connectProxy.entries().filter((entry) =>
      entry.body.includes(input.sentinel)).length,
    outputCount: await countCanonicalAssistantTranscriptOutputs(input),
    terminalCount: await countCanonicalTerminalEvents({
      runtime: input.runtime,
      sessionId: input.sessionId,
      turnId: completedTurnId,
    }),
  };
  assertPackedManagedProviderContinuityTurn(
    evidence,
    'packed_managed_provider_continuity_turn_not_exactly_once',
  );
  return {
    witness: {
      sessionId: input.sessionId,
      sentinel: input.sentinel,
      completedTurnId,
    },
    evidence,
  };
}

async function recountPackedManagedProviderContinuityTurn(
  runtime: InitializedRuntime,
  witness: PackedManagedProviderContinuityTurnWitness,
): Promise<PackedManagedProviderContinuityTurnEvidence> {
  return {
    effectCount: runtime.connectProxy.entries().filter((entry) =>
      entry.body.includes(witness.sentinel)).length,
    outputCount: await countCanonicalAssistantTranscriptOutputs({
      runtime,
      sessionId: witness.sessionId,
      sentinel: witness.sentinel,
    }),
    terminalCount: await countCanonicalTerminalEvents({
      runtime,
      sessionId: witness.sessionId,
      turnId: witness.completedTurnId,
    }),
  };
}

async function updateCandidateHandoffDescendantCensus(input: Readonly<{
  runtime: InitializedRuntime;
  sessionIds: readonly string[];
  observedPids: Set<number>;
}>): Promise<void> {
  const expectedSessionIds = new Set(input.sessionIds);
  const children = await readPublicSessionChildren(input.runtime)
    .catch(() => []);
  for (const child of children) {
    if (expectedSessionIds.has(child.happySessionId)) {
      input.observedPids.add(child.pid);
    }
  }
  for (const pid of [...input.observedPids]) {
    if (!isProcessAlive(pid)) continue;
    for (const descendantPid of collectDescendantPids(pid)) {
      input.observedPids.add(descendantPid);
    }
  }
}

async function spawnCandidateHandoffSession(input: Readonly<{
  runtime: InitializedRuntime;
  prepared: PackedManagedProviderPreparedInput;
  expectedAgentGeneration: string;
  expectedAgentRuntimeGeneration: 'G' | 'H';
  expectedProviderGeneration: string;
  capabilityBaseline: readonly string[];
  candidateSessionIds: string[];
  observedDescendantPids: Set<number>;
  providerProcessStarts?: PackedManagedProviderProcessStartCollector;
  expectedPriorProviderProcessStartCount: number;
}>): Promise<CandidateHandoffSession> {
  const baselineProcesses = await listCandidateHandoffWrapperProcesses(
    input.prepared,
  );
  const ownsProviderProcessStarts = !input.providerProcessStarts;
  const providerProcessStarts = input.providerProcessStarts
    ?? await startPackedManagedProviderProcessStartCollector({
      baseline: baselineProcesses,
      sample: async () =>
        await listCandidateHandoffWrapperProcesses(input.prepared),
      observeRelatedProcesses: async () =>
        await updateCandidateHandoffDescendantCensus({
          runtime: input.runtime,
          sessionIds: input.candidateSessionIds,
          observedPids: input.observedDescendantPids,
        }),
      intervalMs: 50,
    });
  try {
    const request = candidateHandoffSpawnRequest(input.runtime);
    const response = await daemonControlPostJson<{
      success?: boolean;
      sessionId?: string;
      error?: string;
      errorCode?: string;
    }>({
      port: input.runtime.currentDaemonState.httpPort,
      path: '/spawn-session',
      controlToken: input.runtime.currentDaemonState.controlToken,
      body: request.body,
      timeoutMs: 150_000,
    });
    assert(
      response.status === 200
        && response.data?.success === true
        && typeof response.data.sessionId === 'string',
      'packed_managed_provider_candidate_session_spawn_failed:'
        + String(response.data?.error ?? response.data?.errorCode ?? 'unknown'),
    );
    const sessionId = response.data.sessionId;
    input.candidateSessionIds.push(sessionId);
    await updateCandidateHandoffDescendantCensus({
      runtime: input.runtime,
      sessionIds: input.candidateSessionIds,
      observedPids: input.observedDescendantPids,
    });
    await waitFor(async () => (await readPublicSessionChildren(input.runtime))
      .some((child) => child.happySessionId === sessionId), {
      timeoutMs: 60_000,
      intervalMs: 50,
      context: 'packed candidate Session registration',
    });
    const providerProcessObservation: {
      current: ObservedCandidateProcess | null;
    } = { current: null };
    await waitFor(async () => {
      const starts = await providerProcessStarts.observe();
      assert(
        starts.length <= input.expectedPriorProviderProcessStartCount + 1,
        'packed_managed_provider_duplicate_candidate_process_start',
      );
      providerProcessObservation.current =
        starts[input.expectedPriorProviderProcessStartCount] ?? null;
      return providerProcessObservation.current !== null;
    }, {
      timeoutMs: 60_000,
      intervalMs: 50,
      failFast: true,
      context: 'packed candidate Session Provider process',
    });
    const providerProcess = providerProcessObservation.current;
    assert(
      providerProcess !== null,
      'packed_managed_provider_candidate_process_missing',
    );
    input.runtime.stockPortObserver.observeOwnedProcess(providerProcess.pid);
    await waitFor(() => input.runtime.connectProxy.entries().some((entry) =>
      entry.body.includes(request.promptSentinel)), {
      timeoutMs: 60_000,
      intervalMs: 25,
      context: 'packed candidate Session Provider effect',
    });
    const custody = await waitForCandidateHandoffCustody({
      runtime: input.runtime,
      sessionId,
    });
    assert(
      custody.authority.retainedAgent.pluginId
        === CANDIDATE_HANDOFF_AGENT_PLUGIN_ID
        && custody.authority.retainedAgent.localAgentId
          === CANDIDATE_HANDOFF_AGENT_ID
        && custody.authority.retainedAgent.immutableGenerationId
          === input.expectedAgentGeneration
        && custody.providerImmutableGenerationId
          === input.expectedProviderGeneration,
      'packed_managed_provider_candidate_runtime_generation_mismatch',
    );
    const firstTurn = await observeCandidateHandoffTurn({
      runtime: input.runtime,
      sessionId,
      sentinel: request.promptSentinel,
      expectedAgentGeneration: input.expectedAgentRuntimeGeneration,
      previousCompletedTurnId: null,
    });
    assert(
      (await providerProcessStarts.observe()).length
        === input.expectedPriorProviderProcessStartCount + 1,
      'packed_managed_provider_candidate_duplicate_provider_start',
    );
    const capabilityPaths = (await listRequestAuthCapabilityPaths(
      input.runtime.happyHomeDir,
    )).filter((path) => !input.capabilityBaseline.includes(path));
    assert(
      capabilityPaths.length > 0,
      'packed_managed_provider_candidate_capability_missing',
    );
    const descendantPids = [
      custody.authority.runner.pid,
      ...collectDescendantPids(custody.authority.runner.pid),
    ];
    const active: ActivePublicSession = {
      sessionId,
      providerProcess,
      providerProcessStarts,
      promptSentinel: request.promptSentinel,
    };
    input.runtime.candidateHandoffSessions.push(active);
    return {
      active,
      custody,
      firstTurn: firstTurn.evidence,
      firstTurnWitness: firstTurn.witness,
      firstCompletedTurnId: firstTurn.completedTurnId,
      descendantPids,
      capabilityPaths,
    };
  } catch (error) {
    if (ownsProviderProcessStarts) {
      await providerProcessStarts.stop().catch(() => undefined);
    }
    throw error;
  }
}

async function sendCandidateHandoffTurn(input: Readonly<{
  runtime: InitializedRuntime;
  session: CandidateHandoffSession;
  generation: 'G' | 'H';
}>): Promise<CandidateHandoffTurnObservation> {
  const sentinel = `packed-candidate-${input.generation.toLowerCase()}-later:${randomUUID()}`;
  await postEncryptedUiTextMessage({
    baseUrl: input.runtime.server.baseUrl,
    token: input.runtime.auth.token,
    sessionId: input.session.active.sessionId,
    secret: input.runtime.accountSecret,
    text: sentinel,
    timeoutMs: 20_000,
  });
  await waitFor(() => input.runtime.connectProxy.entries().some((entry) =>
    entry.body.includes(sentinel)), {
    timeoutMs: 60_000,
    intervalMs: 25,
    context: 'packed candidate retained Session Provider effect',
  });
  return await observeCandidateHandoffTurn({
    runtime: input.runtime,
    sessionId: input.session.active.sessionId,
    sentinel,
    expectedAgentGeneration: input.generation,
    previousCompletedTurnId: input.session.firstCompletedTurnId,
  });
}

async function readCandidateHandoffRunnerStatus(input: Readonly<{
  runtime: InitializedRuntime;
  sessionId: string;
}>) {
  return await callEncryptedMachineRpc({
    ui: input.runtime.ui,
    machineId: input.runtime.machineId,
    method: RPC_METHODS.DAEMON_SESSION_RUNNER_STATUS_GET,
    req: { sessionId: input.sessionId },
    secret: input.runtime.accountSecret,
    schema: SessionRunnerRuntimeStateV1Schema,
  });
}

async function waitForCandidateHandoffRunnerStatus(input: Readonly<{
  runtime: InitializedRuntime;
  sessionId: string;
  context: string;
  matches(
    status: Awaited<ReturnType<typeof readCandidateHandoffRunnerStatus>>,
  ): boolean;
}>): Promise<Awaited<ReturnType<typeof readCandidateHandoffRunnerStatus>>> {
  let matched:
    Awaited<ReturnType<typeof readCandidateHandoffRunnerStatus>> | null = null;
  await waitFor(async () => {
    const status = await readCandidateHandoffRunnerStatus(input);
    if (!input.matches(status)) return false;
    matched = status;
    return true;
  }, {
    timeoutMs: 60_000,
    intervalMs: 50,
    context: input.context,
  });
  assert(matched, 'packed_managed_provider_candidate_runner_status_missing');
  return matched;
}

async function restartCandidateHandoffRunner(input: Readonly<{
  runtime: InitializedRuntime;
  sessionId: string;
}>) {
  return await callEncryptedMachineRpc({
    ui: input.runtime.ui,
    machineId: input.runtime.machineId,
    method: RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART,
    req: {
      sessionId: input.sessionId,
      mode: 'if_stale' as const,
      reason: 'ui_stale_runner_banner' as const,
    },
    secret: input.runtime.accountSecret,
    schema: RestartSessionRunnerResultV1Schema,
    timeoutMs: 90_000,
  });
}

async function waitForCandidateHandoffCustodyGeneration(input: Readonly<{
  runtime: InitializedRuntime;
  sessionId: string;
  agentImmutableGenerationId: string;
  providerImmutableGenerationId: string;
}>): Promise<CandidateHandoffCustody> {
  let matched: CandidateHandoffCustody | null = null;
  await waitFor(async () => {
    const custody = await waitForCandidateHandoffCustody({
      runtime: input.runtime,
      sessionId: input.sessionId,
    });
    if (
      custody.authority.retainedAgent.immutableGenerationId
        !== input.agentImmutableGenerationId
      || custody.providerImmutableGenerationId
        !== input.providerImmutableGenerationId
    ) {
      return false;
    }
    matched = custody;
    return true;
  }, {
    timeoutMs: 60_000,
    intervalMs: 50,
    context: `packed candidate current custody for ${input.sessionId}`,
  });
  assert(matched, 'packed_managed_provider_candidate_current_custody_missing');
  return matched;
}

async function retainedProviderAuthorityPresent(input: Readonly<{
  runtime: InitializedRuntime;
  sessionId: string;
  authorityPath: string;
  pluginId: string;
}>): Promise<boolean> {
  if (existsSync(input.authorityPath)) return true;
  for (const base of [
    'daemon-sessions',
    'daemon-sessions.dev',
    'daemon-sessions.preview',
  ]) {
    const directory = join(input.runtime.happyHomeDir, 'tmp', base);
    for (const name of await readdir(directory).catch(() => [])) {
      if (!name.startsWith('pid-') || !name.endsWith('.json')) continue;
      const marker = await readFile(join(directory, name), 'utf8')
        .then((contents) => JSON.parse(contents) as unknown)
        .catch(() => null);
      if (!isRecord(marker) || marker.happySessionId !== input.sessionId) {
        continue;
      }
      const retention = isRecord(marker.runnerManagedDependencyRetentionV1)
        ? marker.runnerManagedDependencyRetentionV1
        : null;
      const adopted = isRecord(retention?.adoptedManagedProviderAuthority)
        ? retention.adoptedManagedProviderAuthority
        : null;
      if (adopted?.pluginId === input.pluginId) return true;
    }
  }
  return false;
}

async function candidateHandoffRetainedProviderAuthorityPresent(
  runtime: InitializedRuntime,
  sessionId: string,
  authorityPath: string,
): Promise<boolean> {
  return await retainedProviderAuthorityPresent({
    runtime,
    sessionId,
    authorityPath,
    pluginId: CANDIDATE_HANDOFF_PROVIDER_PLUGIN_ID,
  });
}

async function listCandidateHandoffAuthorityArtifacts(
  runtime: InitializedRuntime,
  sessionIds: readonly string[],
): Promise<readonly string[]> {
  const expectedSessionIds = new Set(sessionIds);
  const paths = new Set<string>();
  for (const base of [
    'daemon-sessions',
    'daemon-sessions.dev',
    'daemon-sessions.preview',
  ]) {
    const directory = join(runtime.happyHomeDir, 'tmp', base);
    for (const name of await readdir(directory).catch(() => [])) {
      if (!name.startsWith('pid-') || !name.endsWith('.json')) continue;
      const markerPath = join(directory, name);
      const marker = await readFile(markerPath, 'utf8')
        .then((contents) => JSON.parse(contents) as unknown)
        .catch(() => null);
      if (
        !isRecord(marker)
        || typeof marker.happySessionId !== 'string'
        || !expectedSessionIds.has(marker.happySessionId)
      ) {
        continue;
      }
      paths.add(markerPath);
      if (
        typeof marker.agentRuntimeDaemonServiceAuthorityFilePath === 'string'
      ) {
        paths.add(marker.agentRuntimeDaemonServiceAuthorityFilePath);
      }
    }
  }
  return [...paths].sort();
}

export function countCandidateHandoffRevokedSentinelEffects(
  entries: readonly Readonly<{ body: string }>[],
  sentinels: readonly string[],
): number {
  return entries.filter((entry) => sentinels.some((sentinel) =>
    entry.body.includes(sentinel))).length;
}

async function enqueueRevokedCandidateSessionInput(input: Readonly<{
  runtime: InitializedRuntime;
  sessionId: string;
  phase: 'takeover' | 'reenable' | 'retrust';
}>): Promise<string> {
  const sentinel = `packed-candidate-revoked-${input.phase}:${randomUUID()}`;
  await postEncryptedUiTextMessage({
    baseUrl: input.runtime.server.baseUrl,
    token: input.runtime.auth.token,
    sessionId: input.sessionId,
    secret: input.runtime.accountSecret,
    text: sentinel,
    timeoutMs: 20_000,
  }).catch(() => undefined);
  return sentinel;
}

async function observeRevokedPublicSession(input: Readonly<{
  runtime: InitializedRuntime;
  sessionId: string;
  authorityPath: string;
  pluginId: string;
  sentinels: readonly string[];
  providerProcessStarts: PackedManagedProviderProcessStartCollector;
}>): Promise<Readonly<{
  effectCount: number;
  authorityObserved: boolean;
  providerProcessStartCount: number;
}>> {
  return {
    effectCount: countCandidateHandoffRevokedSentinelEffects(
      input.runtime.connectProxy.entries(),
      input.sentinels,
    ),
    authorityObserved: await retainedProviderAuthorityPresent({
      runtime: input.runtime,
      sessionId: input.sessionId,
      authorityPath: input.authorityPath,
      pluginId: input.pluginId,
    }),
    providerProcessStartCount:
      (await input.providerProcessStarts.observe()).length,
  };
}

async function stopCandidateHandoffSession(input: Readonly<{
  runtime: InitializedRuntime;
  session: CandidateHandoffSession;
  expectedProviderProcessStartCount?: number;
  stopProviderProcessStartCollector?: boolean;
}>): Promise<Awaited<ReturnType<typeof stopPublicSession>>> {
  const cleanup = await stopPublicSession({
    runtime: input.runtime,
    session: input.session.active,
    expectedProviderProcessStartCount:
      input.expectedProviderProcessStartCount,
    stopProviderProcessStartCollector:
      input.stopProviderProcessStartCollector,
  });
  const index = input.runtime.candidateHandoffSessions.indexOf(
    input.session.active,
  );
  if (index >= 0) input.runtime.candidateHandoffSessions.splice(index, 1);
  return cleanup;
}

async function probePackedCandidateAgentProviderHandoff(
  runtime: InitializedRuntime,
  input: PackedManagedProviderPreparedInput,
): Promise<PackedManagedProviderCandidateHandoffObservation> {
  const initialCapabilityPaths = await listRequestAuthCapabilityPaths(
    runtime.happyHomeDir,
  );
  const initialCandidateProcesses = await listCandidateHandoffWrapperProcesses(
    input,
  );
  const candidateSessionIds: string[] = [];
  const observedDescendantPids = new Set<number>();
  let authoring: CandidateHandoffAuthoring | null = null;
  let retained: CandidateHandoffSession | null = null;
  let fresh: CandidateHandoffSession | null = null;
  let externalSessionsGPhase:
    CandidateHandoffExternalSessionsPublicPhase | null = null;
  let externalSessionsHPhase:
    CandidateHandoffExternalSessionsPublicPhase | null = null;
  let externalSessionsHReacquiredPhase:
    CandidateHandoffExternalSessionsPublicPhase | null = null;
  let providerProcessStarts:
    PackedManagedProviderProcessStartCollector | null = null;
  let providerProcessStartsStopped = false;
  let observation: PackedManagedProviderCandidateHandoffObservation | null = null;
  let hasPrimaryFailure = false;
  let primaryFailure: unknown = null;
  try {
    authoring = await prepareCandidateHandoffAuthoring(runtime, input);
    const agentG = await packAndInstallCandidateHandoffGeneration({
      runtime,
      prepared: input,
      authoring,
      family: 'agent',
      generation: 'G',
      version: '1.0.0',
    });
    const providerP = await packAndInstallCandidateHandoffGeneration({
      runtime,
      prepared: input,
      authoring,
      family: 'provider',
      generation: 'P',
      version: '1.0.0',
    });
    await setupCandidateHandoffProvider(runtime, input);
    externalSessionsGPhase =
      await invokeCandidateHandoffExternalSessionsPublicPhase({
        authoring,
        expectedGeneration: 'G',
        expectedPhase: 'snapshot',
      });
    retained = await spawnCandidateHandoffSession({
      runtime,
      prepared: input,
      expectedAgentGeneration: agentG.immutableGenerationId,
      expectedAgentRuntimeGeneration: 'G',
      expectedProviderGeneration: providerP.immutableGenerationId,
      capabilityBaseline: initialCapabilityPaths,
      candidateSessionIds,
      observedDescendantPids,
      expectedPriorProviderProcessStartCount: 0,
    });
    providerProcessStarts = retained.active.providerProcessStarts;
    const handoffProviderProcessStarts = retained.active.providerProcessStarts;

    const agentH = await packAndInstallCandidateHandoffGeneration({
      runtime,
      prepared: input,
      authoring,
      family: 'agent',
      generation: 'H',
      version: '2.0.0',
    });
    const providerQ = await packAndInstallCandidateHandoffGeneration({
      runtime,
      prepared: input,
      authoring,
      family: 'provider',
      generation: 'Q',
      version: '2.0.0',
    });
    externalSessionsHPhase =
      await invokeCandidateHandoffExternalSessionsPublicPhase({
        authoring,
        expectedGeneration: 'H',
        expectedPhase: 'final',
        expectedPublicGFollow: 'retired',
        expectedPublicRef: externalSessionsGPhase.publicRef,
      });
    const retainedAfterUpdate = await waitForCandidateHandoffCustody({
      runtime,
      sessionId: retained.active.sessionId,
    });
    const retainedProcessAfterUpdate = (
      await listCandidateHandoffWrapperProcesses(input)
    ).find((process) =>
      process.pid === retained?.active.providerProcess.pid);
    assert(
      retainedAfterUpdate.authority.retainedAgent
        .immutableGenerationId === agentG.immutableGenerationId
        && retainedAfterUpdate.providerImmutableGenerationId
          === providerP.immutableGenerationId
        && retainedProcessAfterUpdate
        && sameCandidateProcess(
          retained.active.providerProcess,
          retainedProcessAfterUpdate,
        )
        && isProcessAlive(retained.active.providerProcess.pid),
      'packed_managed_provider_candidate_retained_generation_changed',
    );
    const noReplayAfterGenerationAdoption = {
      retainedInitialTurn: await recountCandidateHandoffTurn(
        runtime,
        retained.firstTurnWitness,
      ),
    };
    const retainedBeforeSafeRestart = retained;
    const busySentinel = `packed-candidate-g-busy:${randomUUID()}`;
    const busyHold = runtime.connectProxy.holdNextRequestBodyContaining(
      busySentinel,
    );
    await postEncryptedUiTextMessage({
      baseUrl: runtime.server.baseUrl,
      token: runtime.auth.token,
      sessionId: retained.active.sessionId,
      secret: runtime.accountSecret,
      text: busySentinel,
      timeoutMs: 20_000,
    });
    await waitFor(() => runtime.connectProxy.entries().some((entry) =>
      entry.body.includes(busySentinel)), {
      timeoutMs: 60_000,
      intervalMs: 25,
      context: 'packed candidate busy retained Session Provider effect',
    });
    const busyStatus = await waitForCandidateHandoffRunnerStatus({
      runtime,
      sessionId: retained.active.sessionId,
      context: 'packed candidate stale busy runner status',
      matches: (status) =>
        status.versionState === 'stale'
        && status.plannedRestart.supported
        && !status.plannedRestart.eligible
        && status.plannedRestart.disabledReason === 'turn_in_progress',
    });
    const busyCustodyBefore = await waitForCandidateHandoffCustody({
      runtime,
      sessionId: retained.active.sessionId,
    });
    const busyProviderProcessBefore = retained.active.providerProcess;
    const busyProviderStartsBefore = await providerProcessStarts.observe();
    let busyRestart:
      Awaited<ReturnType<typeof restartCandidateHandoffRunner>>;
    let busyCustodyAfter: CandidateHandoffCustody;
    let busyProviderStartsAfter: readonly ObservedCandidateProcess[];
    let busyProviderProcessAfter: ObservedCandidateProcess | undefined;
    let runnerIdentityUnchangedAfterBusyResult = false;
    try {
      busyRestart = await restartCandidateHandoffRunner({
        runtime,
        sessionId: retained.active.sessionId,
      });
      busyCustodyAfter = await waitForCandidateHandoffCustody({
        runtime,
        sessionId: retained.active.sessionId,
      });
      busyProviderStartsAfter = await providerProcessStarts.observe();
      busyProviderProcessAfter = (
        await listCandidateHandoffWrapperProcesses(input)
      ).find((process) => process.pid === busyProviderProcessBefore.pid);
      runnerIdentityUnchangedAfterBusyResult = sameCandidateRunnerIdentity(
        busyCustodyBefore.authority.runner,
        busyCustodyAfter.authority.runner,
      );
      assert(
        busyRestart.status === 'busy'
          && busyRestart.reasonCode === 'turn_in_progress'
          && runnerIdentityUnchangedAfterBusyResult
          && busyCustodyAfter.authority.retainedAgent
            .immutableGenerationId
            === busyCustodyBefore.authority.retainedAgent
              .immutableGenerationId
          && busyCustodyAfter.providerImmutableGenerationId
            === busyCustodyBefore.providerImmutableGenerationId
          && busyProviderProcessAfter
          && sameCandidateProcess(
            busyProviderProcessBefore,
            busyProviderProcessAfter,
          )
          && busyProviderStartsAfter.length
            === busyProviderStartsBefore.length,
        'packed_managed_provider_candidate_busy_restart_mutated_runtime',
      );
    } finally {
      busyHold.release();
    }
    await busyHold.completed;
    const retainedLaterTurnObservation = await observeCandidateHandoffTurn({
      runtime,
      sessionId: retained.active.sessionId,
      sentinel: busySentinel,
      expectedAgentGeneration: 'G',
      previousCompletedTurnId: retained.firstCompletedTurnId,
    });
    await sleep(750);
    const postBusyStatus = await readCandidateHandoffRunnerStatus({
      runtime,
      sessionId: retained.active.sessionId,
    });
    const postBusyCustody = await waitForCandidateHandoffCustody({
      runtime,
      sessionId: retained.active.sessionId,
    });
    const postBusyStarts = await providerProcessStarts.observe();
    const postBusyProviderProcess = (
      await listCandidateHandoffWrapperProcesses(input)
    ).find((process) => process.pid === busyProviderProcessBefore.pid);
    const runnerIdentityUnchangedAfterHeldTurn = sameCandidateRunnerIdentity(
      busyCustodyBefore.authority.runner,
      postBusyCustody.authority.runner,
    );
    const noDeferredRestartAfterTurn =
      postBusyStatus.versionState === 'stale'
      && postBusyStatus.plannedRestart.eligible
      && runnerIdentityUnchangedAfterHeldTurn
      && postBusyCustody.authority.retainedAgent
        .immutableGenerationId === agentG.immutableGenerationId
      && postBusyCustody.providerImmutableGenerationId
        === providerP.immutableGenerationId
      && postBusyStarts.length === busyProviderStartsBefore.length
      && Boolean(
        postBusyProviderProcess
        && sameCandidateProcess(
          busyProviderProcessBefore,
          postBusyProviderProcess,
        ),
      );
    assert(
      noDeferredRestartAfterTurn,
      'packed_managed_provider_candidate_busy_restart_was_deferred',
    );

    const idleStatus = await waitForCandidateHandoffRunnerStatus({
      runtime,
      sessionId: retained.active.sessionId,
      context: 'packed candidate stale idle runner status',
      matches: (status) =>
        status.versionState === 'stale'
        && status.plannedRestart.supported
        && status.plannedRestart.eligible,
    });
    const idleRestart = await restartCandidateHandoffRunner({
      runtime,
      sessionId: retained.active.sessionId,
    });
    assert(
      idleRestart.status === 'restarted',
      'packed_managed_provider_candidate_idle_restart_not_restarted',
    );
    let restartedProviderProcess: ObservedCandidateProcess | null = null;
    await waitFor(async () => {
      const starts = await handoffProviderProcessStarts.observe();
      restartedProviderProcess = starts[1] ?? null;
      return starts.length === 2
        && restartedProviderProcess !== null
        && !isProcessAlive(busyProviderProcessBefore.pid);
    }, {
      timeoutMs: 60_000,
      intervalMs: 50,
      context: 'packed candidate explicitly restarted Provider process',
    });
    assert(
      restartedProviderProcess,
      'packed_managed_provider_candidate_restarted_provider_missing',
    );
    const restartedCustody = await waitForCandidateHandoffCustodyGeneration({
      runtime,
      sessionId: retained.active.sessionId,
      agentImmutableGenerationId: agentH.immutableGenerationId,
      providerImmutableGenerationId: providerQ.immutableGenerationId,
    });
    await waitForCandidateHandoffRunnerStatus({
      runtime,
      sessionId: retained.active.sessionId,
      context: 'packed candidate restarted current runner status',
      matches: (status) => status.versionState === 'current',
    });
    const noReplayAfterIdleRestart = {
      retainedInitialTurn: await recountCandidateHandoffTurn(
        runtime,
        retained.firstTurnWitness,
      ),
      retainedUpdateTurn: await recountCandidateHandoffTurn(
        runtime,
        retainedLaterTurnObservation.witness,
      ),
    };
    const restartedActive: ActivePublicSession = {
      ...retained.active,
      providerProcess: restartedProviderProcess,
    };
    const retainedActiveIndex = runtime.candidateHandoffSessions.indexOf(
      retained.active,
    );
    if (retainedActiveIndex >= 0) {
      runtime.candidateHandoffSessions[retainedActiveIndex] = restartedActive;
    }
    const restartedCapabilityPaths = (
      await listRequestAuthCapabilityPaths(runtime.happyHomeDir)
    ).filter((path) => !initialCapabilityPaths.includes(path));
    retained = {
      ...retained,
      active: restartedActive,
      custody: restartedCustody,
      firstCompletedTurnId: retainedLaterTurnObservation.completedTurnId,
      descendantPids: [...new Set([
        ...retained.descendantPids,
        restartedCustody.authority.runner.pid,
        ...collectDescendantPids(restartedCustody.authority.runner.pid),
      ])],
      capabilityPaths: [...new Set([
        ...retained.capabilityPaths,
        ...restartedCapabilityPaths,
      ])],
    };
    const restartedLaterTurn = await sendCandidateHandoffTurn({
      runtime,
      session: retained,
      generation: 'H',
    });
    const providerStartsBeforeFreshDemand =
      await providerProcessStarts.observe();
    assert(
      providerStartsBeforeFreshDemand.length === 2,
      'packed_managed_provider_candidate_provider_started_before_fresh_demand',
    );

    const qCapabilityBaseline = await listRequestAuthCapabilityPaths(
      runtime.happyHomeDir,
    );
    fresh = await spawnCandidateHandoffSession({
      runtime,
      prepared: input,
      expectedAgentGeneration: agentH.immutableGenerationId,
      expectedAgentRuntimeGeneration: 'H',
      expectedProviderGeneration: providerQ.immutableGenerationId,
      capabilityBaseline: qCapabilityBaseline,
      candidateSessionIds,
      observedDescendantPids,
      providerProcessStarts,
      expectedPriorProviderProcessStartCount: 2,
    });
    const noReplayAfterNewProviderAdmission = {
      retainedInitialTurn: await recountCandidateHandoffTurn(
        runtime,
        retained.firstTurnWitness,
      ),
      retainedUpdateTurn: await recountCandidateHandoffTurn(
        runtime,
        retainedLaterTurnObservation.witness,
      ),
      restartedCurrentTurn: await recountCandidateHandoffTurn(
        runtime,
        restartedLaterTurn.witness,
      ),
      newSessionFirstTurn: await recountCandidateHandoffTurn(
        runtime,
        fresh.firstTurnWitness,
      ),
    };
    const providerStartsAfterFreshDemand = await providerProcessStarts.observe();
    assert(
      providerStartsAfterFreshDemand.length === 3,
      'packed_managed_provider_candidate_fresh_provider_start_count_mismatch',
    );
    assert(
      !sameCandidateProcess(
        retained.active.providerProcess,
        fresh.active.providerProcess,
      ),
      'packed_managed_provider_candidate_provider_q_not_distinct',
    );
    const freshCleanup = await stopCandidateHandoffSession({
      runtime,
      session: fresh,
      expectedProviderProcessStartCount: 3,
      stopProviderProcessStartCollector: false,
    });
    assert(
      freshCleanup.providerExited
        && isProcessAlive(retained.active.providerProcess.pid),
      'packed_managed_provider_candidate_q_cleanup_stopped_p',
    );

    await packAndInstallCandidateHandoffGeneration({
      runtime,
      prepared: input,
      authoring,
      family: 'agent',
      generation: 'R',
      version: '3.0.0',
    });
    const removedStatus = await waitForCandidateHandoffRunnerStatus({
      runtime,
      sessionId: retained.active.sessionId,
      context: 'packed candidate removed Agent runner status',
      matches: (status) =>
        status.versionState === 'stale'
        && status.plannedRestart.supported
        && !status.plannedRestart.eligible
        && status.plannedRestart.disabledReason === 'unsupported_backend',
    });
    const removedCustodyBefore = await waitForCandidateHandoffCustody({
      runtime,
      sessionId: retained.active.sessionId,
    });
    const removedProviderProcessBefore = retained.active.providerProcess;
    const removedProviderStartsBefore = await providerProcessStarts.observe();
    const removedRestart = await restartCandidateHandoffRunner({
      runtime,
      sessionId: retained.active.sessionId,
    });
    const removedCustodyAfter = await waitForCandidateHandoffCustody({
      runtime,
      sessionId: retained.active.sessionId,
    });
    const removedProviderStartsAfter = await providerProcessStarts.observe();
    const removedProviderProcessAfter = (
      await listCandidateHandoffWrapperProcesses(input)
    ).find((process) => process.pid === removedProviderProcessBefore.pid);
    assert(
      removedRestart.status === 'ineligible'
        && removedRestart.reasonCode === 'unsupported_backend'
        && removedCustodyAfter.authority.retainedAgent
          .immutableGenerationId
          === removedCustodyBefore.authority.retainedAgent
            .immutableGenerationId
        && removedCustodyAfter.providerImmutableGenerationId
          === removedCustodyBefore.providerImmutableGenerationId
        && removedProviderProcessAfter
        && sameCandidateProcess(
          removedProviderProcessBefore,
          removedProviderProcessAfter,
        )
        && removedProviderStartsAfter.length
          === removedProviderStartsBefore.length,
      'packed_managed_provider_candidate_removed_restart_mutated_runtime',
    );
    const removedRetainedTurn = await sendCandidateHandoffTurn({
      runtime,
      session: retained,
      generation: 'H',
    });
    const safeRestart: PackedManagedProviderSafeRestartContractEvidence = {
      busy: {
        statusVersionState: 'stale',
        plannedRestartEligible: false,
        plannedRestartDisabledReason: 'turn_in_progress',
        restartStatus: busyRestart.status,
        restartReasonCode: busyRestart.reasonCode ?? 'turn_in_progress',
        agentRuntimeUnchanged:
          busyCustodyAfter.authority.retainedAgent
            .immutableGenerationId
          === busyCustodyBefore.authority.retainedAgent
            .immutableGenerationId,
        runnerIdentityUnchangedAfterBusyResult,
        runnerIdentityUnchangedAfterHeldTurn,
        providerProcessUnchanged: Boolean(
          busyProviderProcessAfter
          && sameCandidateProcess(
            busyProviderProcessBefore,
            busyProviderProcessAfter,
          ),
        ),
        providerProcessStartCountBefore: busyProviderStartsBefore.length,
        providerProcessStartCountAfter: busyProviderStartsAfter.length,
        noDeferredRestartAfterTurn,
      },
      idle: {
        statusVersionStateBefore: 'stale',
        plannedRestartEligibleBefore: true,
        restartStatus: idleRestart.status,
        movedToCurrentAgentRuntime:
          restartedCustody.authority.retainedAgent
            .immutableGenerationId === agentH.immutableGenerationId,
        providerProcessReplaced: !sameCandidateProcess(
          busyProviderProcessBefore,
          restartedProviderProcess,
        ),
        laterTurn: restartedLaterTurn.evidence,
      },
      removed: {
        statusVersionState: 'stale',
        plannedRestartEligible: false,
        plannedRestartDisabledReason: 'unsupported_backend',
        restartStatus: removedRestart.status,
        restartReasonCode: removedRestart.reasonCode ?? 'unsupported_backend',
        agentRuntimeUnchanged:
          removedCustodyAfter.authority.retainedAgent
            .immutableGenerationId
          === removedCustodyBefore.authority.retainedAgent
            .immutableGenerationId,
        providerProcessUnchanged: Boolean(
          removedProviderProcessAfter
          && sameCandidateProcess(
            removedProviderProcessBefore,
            removedProviderProcessAfter,
          ),
        ),
        providerProcessStartCountBefore: removedProviderStartsBefore.length,
        providerProcessStartCountAfter: removedProviderStartsAfter.length,
        retainedRuntimeContinued:
          removedRetainedTurn.evidence.observedAgentGeneration === 'H'
          && removedRetainedTurn.evidence.effectCount === 1
          && removedRetainedTurn.evidence.outputCount === 1
          && removedRetainedTurn.evidence.terminalCount === 1,
        laterTurn: removedRetainedTurn.evidence,
      },
    };
    assertPackedManagedProviderSafeRestartContract(safeRestart);

    const agentRetirementUninstall = await runPackedCliJson({
      cliEntrypoint: authoring.cliEntrypoint,
      cwd: authoring.fixtureRoot,
      env: authoring.env,
      args: [
        'plugins',
        'uninstall',
        CANDIDATE_HANDOFF_AGENT_PLUGIN_ID,
        '--json',
      ],
    }, 'plugins_uninstall');
    assert(
      agentRetirementUninstall.data?.desiredGeneration === null
        && agentRetirementUninstall.data?.appliedGeneration === null,
      'packed_managed_provider_candidate_agent_retirement_uninstall_incomplete',
    );
    const agentHReinstall = await runPackedReviewedPluginInstall({
      cliEntrypoint: authoring.cliEntrypoint,
      cwd: authoring.fixtureRoot,
      env: authoring.env,
      args: ['plugins', 'install', agentH.archivePath, '--json'],
      decideInstallReview: candidateHandoffReviewDecision(runtime),
    });
    const agentHReinstalledAndRetrusted = agentHReinstall.change.kind
      === 'committed'
      && agentHReinstall.change.appliedGeneration
        === agentHReinstall.change.desiredGeneration
      && typeof agentHReinstall.change.appliedGeneration === 'string'
      && agentHReinstall.review.source.kind === 'archive'
      && resolve(agentHReinstall.review.source.locator) === resolve(agentH.archivePath);
    externalSessionsHReacquiredPhase =
      await invokeCandidateHandoffExternalSessionsPublicPhase({
        authoring,
        expectedGeneration: 'H',
        expectedPhase: 'final',
        expectedPublicGFollow: 'retired',
        expectedPublicRef: externalSessionsGPhase.publicRef,
      });

    await runPackedCliJson({
      cliEntrypoint: authoring.cliEntrypoint,
      cwd: authoring.fixtureRoot,
      env: authoring.env,
      args: [
        'plugins',
        'disable',
        CANDIDATE_HANDOFF_PROVIDER_PLUGIN_ID,
        '--json',
      ],
    }, 'plugins_disable');
    await waitFor(() => !isProcessAlive(retained!.active.providerProcess.pid), {
      timeoutMs: 60_000,
      intervalMs: 50,
      context: 'packed candidate Provider P hard revoke',
    });
    await waitFor(async () =>
      !(await candidateHandoffRetainedProviderAuthorityPresent(
        runtime,
        retained!.active.sessionId,
        retained!.custody.authority.path,
      )), {
      timeoutMs: 60_000,
      intervalMs: 50,
      context: 'packed candidate retained Provider authority revoke',
    });
    let reenabledAndRetrusted = false;
    const revokedSentinels: string[] = [];
    let retainedProviderResurrectionCount = 0;
    let retainedProviderAuthorityResurrectionCount = 0;
    let revokeWindowProviderProcessStartCount = 0;
    const rescanRevokedSession = async (): Promise<void> => {
      assert(
        providerProcessStarts,
        'packed_managed_provider_candidate_process_observer_missing',
      );
      const observation = await observeRevokedPublicSession({
        runtime,
        sessionId: retained!.active.sessionId,
        authorityPath: retained!.custody.authority.path,
        pluginId: CANDIDATE_HANDOFF_PROVIDER_PLUGIN_ID,
        sentinels: revokedSentinels,
        providerProcessStarts,
      });
      retainedProviderResurrectionCount = observation.effectCount;
      retainedProviderAuthorityResurrectionCount ||= Number(
        observation.authorityObserved,
      );
      revokeWindowProviderProcessStartCount = Math.max(
        0,
        observation.providerProcessStartCount
          - providerStartsAfterFreshDemand.length,
      );
    };
    const enqueueAndRescanRevokedSession = async (
      phase: 'takeover' | 'reenable' | 'retrust',
    ): Promise<void> => {
      revokedSentinels.push(await enqueueRevokedCandidateSessionInput({
        runtime,
        sessionId: retained!.active.sessionId,
        phase,
      }));
      await rescanRevokedSession();
    };
    await rescanRevokedSession();
    const previousDaemon = runtime.currentDaemonState;
    const takeover = runCandidateCommand({
      runtime,
      prepared: input,
      args: ['daemon', 'restart', '--takeover', '--json'],
      waitForExit: true,
    });
    const replacement = await waitForReplacementDaemon(
      runtime,
      previousDaemon.pid,
    );
    await takeover;
    runtime.currentDaemonState = replacement;
    runtime.stockPortObserver.observeOwnedProcess(replacement.pid);
    await rescanRevokedSession();
    await enqueueAndRescanRevokedSession('takeover');
    await runPackedCliJson({
      cliEntrypoint: authoring.cliEntrypoint,
      cwd: authoring.fixtureRoot,
      env: authoring.env,
      args: [
        'plugins',
        'enable',
        CANDIDATE_HANDOFF_PROVIDER_PLUGIN_ID,
        '--json',
      ],
    }, 'plugins_enable');
    await rescanRevokedSession();
    await enqueueAndRescanRevokedSession('reenable');
    await runPackedCliJson({
      cliEntrypoint: authoring.cliEntrypoint,
      cwd: authoring.fixtureRoot,
      env: authoring.env,
      args: [
        'plugins',
        'uninstall',
        CANDIDATE_HANDOFF_PROVIDER_PLUGIN_ID,
        '--json',
      ],
    }, 'plugins_uninstall');
    await rescanRevokedSession();
    const retrusted = await runPackedReviewedPluginInstall({
      cliEntrypoint: authoring.cliEntrypoint,
      cwd: authoring.fixtureRoot,
      env: authoring.env,
      args: ['plugins', 'install', providerQ.archivePath, '--json'],
      decideInstallReview: candidateHandoffReviewDecision(runtime),
    });
    reenabledAndRetrusted = retrusted.change.kind === 'committed'
      && retrusted.change.appliedGeneration
        === retrusted.change.desiredGeneration
      && typeof retrusted.change.appliedGeneration === 'string';
    await rescanRevokedSession();
    await enqueueAndRescanRevokedSession('retrust');
    await rescanRevokedSession();
    assert(
      reenabledAndRetrusted
        && retainedProviderResurrectionCount === 0
        && retainedProviderAuthorityResurrectionCount === 0
        && revokeWindowProviderProcessStartCount === 0
        && !isProcessAlive(retained.active.providerProcess.pid),
      'packed_managed_provider_candidate_provider_p_resurrected',
    );

    await rescanRevokedSession();
    const retainedCleanup = await stopCandidateHandoffSession({
      runtime,
      session: retained,
      expectedProviderProcessStartCount: 3,
      stopProviderProcessStartCollector: false,
    });
    await rescanRevokedSession();
    assert(
      retainedCleanup.sessionAbsent && retainedCleanup.providerExited,
      'packed_managed_provider_candidate_retained_cleanup_failed',
    );
    const deletedConnection = await callProviderRpc(
      runtime,
      RPC_METHODS.DAEMON_PROVIDERS_CONNECTION_MUTATE,
      {
        action: 'delete',
        machineId: runtime.machineId,
        connectionId: CANDIDATE_HANDOFF_CONNECTION_ID,
      },
      DaemonProviderConnectionMutationResponseV1Schema,
    );
    assert(
      deletedConnection.status === 'success'
        && deletedConnection.action === 'delete'
        && deletedConnection.deletedConnectionId
          === CANDIDATE_HANDOFF_CONNECTION_ID,
      'packed_managed_provider_candidate_connection_cleanup_failed',
    );
    const agentUninstall = await runPackedCliJson({
      cliEntrypoint: authoring.cliEntrypoint,
      cwd: authoring.fixtureRoot,
      env: authoring.env,
      args: [
        'plugins',
        'uninstall',
        CANDIDATE_HANDOFF_AGENT_PLUGIN_ID,
        '--json',
      ],
    }, 'plugins_uninstall');
    const providerUninstall = await runPackedCliJson({
      cliEntrypoint: authoring.cliEntrypoint,
      cwd: authoring.fixtureRoot,
      env: authoring.env,
      args: [
        'plugins',
        'uninstall',
        CANDIDATE_HANDOFF_PROVIDER_PLUGIN_ID,
        '--json',
      ],
    }, 'plugins_uninstall');
    assert(
      agentUninstall.data?.desiredGeneration === null
        && agentUninstall.data?.appliedGeneration === null
        && providerUninstall.data?.desiredGeneration === null
        && providerUninstall.data?.appliedGeneration === null,
      'packed_managed_provider_candidate_uninstall_incomplete',
    );

    const externalCapabilityPaths = [...new Set([
      ...retainedBeforeSafeRestart.capabilityPaths,
      ...retained.capabilityPaths,
      ...fresh.capabilityPaths,
    ])];
    const knownAuthorityAndMarkerPaths = [...new Set([
      retainedBeforeSafeRestart.custody.authority.path,
      retainedBeforeSafeRestart.custody.markerPath,
      retained.custody.authority.path,
      retained.custody.markerPath,
      fresh.custody.authority.path,
      fresh.custody.markerPath,
    ])];
    for (const pid of [
      ...retained.descendantPids,
      ...fresh.descendantPids,
    ]) {
      observedDescendantPids.add(pid);
    }
    await waitFor(async () => {
      await rescanRevokedSession();
      await updateCandidateHandoffDescendantCensus({
        runtime,
        sessionIds: candidateSessionIds,
        observedPids: observedDescendantPids,
      });
      const currentAuthorityArtifacts =
        await listCandidateHandoffAuthorityArtifacts(
          runtime,
          candidateSessionIds,
        );
      const currentCapabilityPaths = await listRequestAuthCapabilityPaths(
        runtime.happyHomeDir,
      );
      const currentProviderProcesses =
        await listCandidateHandoffWrapperProcesses(input);
      const unexpectedProviderProcesses = currentProviderProcesses.filter(
        (process) => !initialCandidateProcesses.some((baseline) =>
          sameCandidateProcess(process, baseline)),
      );
      const currentChildren = await readPublicSessionChildren(runtime)
        .catch(() => []);
      return knownAuthorityAndMarkerPaths.every((path) => !existsSync(path))
        && currentAuthorityArtifacts.length === 0
        && externalCapabilityPaths.every((path) => !existsSync(path))
        && currentCapabilityPaths.every((path) =>
          initialCapabilityPaths.includes(path))
        && currentChildren.every((child) =>
          !candidateSessionIds.includes(child.happySessionId))
        && [...observedDescendantPids]
          .every((pid) => !isProcessAlive(pid))
        && unexpectedProviderProcesses.length === 0;
    }, {
      timeoutMs: 60_000,
      intervalMs: 50,
      context: 'packed candidate final authority and process cleanup',
    });
    await rescanRevokedSession();
    const finalProviderStarts = await providerProcessStarts.stop();
    providerProcessStartsStopped = true;
    assert(
      finalProviderStarts.length === 3,
      'packed_managed_provider_candidate_revoke_window_provider_restart',
    );
    const children = await readPublicSessionChildren(runtime);
    const finalAuthorityArtifacts = await listCandidateHandoffAuthorityArtifacts(
      runtime,
      candidateSessionIds,
    );
    const finalCapabilityPaths = await listRequestAuthCapabilityPaths(
      runtime.happyHomeDir,
    );
    const finalProviderProcesses =
      await listCandidateHandoffWrapperProcesses(input);
    const finalUnexpectedProviderProcesses = finalProviderProcesses.filter(
      (process) => !initialCandidateProcesses.some((baseline) =>
        sameCandidateProcess(process, baseline)),
    );
    const lifecycle = projectRetainedPluginLifecycleEvidence({
      agent: {
        generations: {
          retainedSessionBeforeUpdate:
            retainedBeforeSafeRestart.custody.authority.retainedAgent
              .immutableGenerationId,
          retainedSessionAfterUpdate:
            retainedAfterUpdate.authority.retainedAgent
              .immutableGenerationId,
          newSessionAfterUpdate:
            fresh.custody.authority.retainedAgent
              .immutableGenerationId,
        },
        retainedLaterTurn: 'completed',
        newSessionFirstTurn: 'completed',
      },
      provider: {
        generations: {
          retainedHandleBeforeUpdate:
            retainedBeforeSafeRestart.custody.providerImmutableGenerationId,
          retainedHandleAfterUpdate:
            retainedAfterUpdate.providerImmutableGenerationId,
          newClaimAfterUpdate:
            fresh.custody.providerImmutableGenerationId,
        },
        retainedHandleUse: 'continued',
        newClaim: 'admitted',
      },
    });
    assert(
      externalSessionsGPhase
        && externalSessionsHPhase
        && externalSessionsHReacquiredPhase
        && externalSessionsGPhase.generation === 'G'
        && externalSessionsHPhase.generation === 'H'
        && externalSessionsHReacquiredPhase.generation === 'H'
        && externalSessionsGPhase.candidateCursor
        && externalSessionsGPhase.tailCursor
        && externalSessionsHPhase.handoff
        && externalSessionsHReacquiredPhase.handoff,
      'packed_managed_provider_candidate_external_sessions_phases_missing',
    );
    const observedExternalSessionsGGeneration =
      derivePackedCandidatePublicGeneration({
        expectedGeneration: 'G',
        candidateTitle: externalSessionsGPhase.candidateTitle,
        transcriptItemId: externalSessionsGPhase.transcriptItemId,
        followItemId: externalSessionsGPhase.follow.itemId,
      });
    const observedExternalSessionsHGeneration =
      derivePackedCandidatePublicGeneration({
        expectedGeneration: 'H',
        candidateTitle: externalSessionsHPhase.candidateTitle,
        transcriptItemId: externalSessionsHPhase.transcriptItemId,
        followItemId: externalSessionsHPhase.follow.itemId,
      });
    const observedExternalSessionsHReacquiredGeneration =
      derivePackedCandidatePublicGeneration({
        expectedGeneration: 'H',
        candidateTitle: externalSessionsHReacquiredPhase.candidateTitle,
        transcriptItemId: externalSessionsHReacquiredPhase.transcriptItemId,
        followItemId: externalSessionsHReacquiredPhase.follow.itemId,
      });
    assert(
      observedExternalSessionsGGeneration === 'G'
        && observedExternalSessionsHGeneration === 'H'
        && observedExternalSessionsHReacquiredGeneration === 'H',
      'packed_managed_provider_candidate_external_sessions_generation_witness_mismatch',
    );
    const externalSessionsEvidence = {
      publicFlow: {
        capabilities: [
          externalSessionsGPhase,
          externalSessionsHPhase,
          externalSessionsHReacquiredPhase,
        ].every(
          ({ capabilities }) =>
            capabilities.list.status === 'available'
            && capabilities.attach.status === 'available'
            && capabilities.transcript.status === 'available'
            && capabilities.follow.status === 'available'
            && capabilities.takeover.status === 'available'
            && capabilities.takeover.storageModes[0] === 'external-linked'
            && capabilities.takeover.storageModes[1] === 'persisted',
        ),
        list:
          externalSessionsHPhase.candidate.agentId
            === CANDIDATE_HANDOFF_AGENT_ID
          && observedExternalSessionsHGeneration === 'H',
        attach: typeof externalSessionsHPhase.attachedSessionId === 'string',
        backgroundFollowEnabled:
          isPackedCandidateBackgroundFollowActionResult(
            externalSessionsHPhase.backgroundFollowEnabled,
            true,
          ),
        backgroundFollowDisabled:
          isPackedCandidateBackgroundFollowActionResult(
            externalSessionsHPhase.backgroundFollowDisabled,
            false,
          ),
        read: typeof externalSessionsHPhase.transcriptItemId === 'string',
        followAcknowledged:
          externalSessionsHPhase.follow.events.includes('data')
          && externalSessionsHPhase.follow.listenerSettled,
        followListenerSettled: externalSessionsHPhase.follow.listenerSettled,
        followDisposed:
          externalSessionsHPhase.follow.disposed
          && externalSessionsHPhase.follow.disposedTerminalAcknowledgements
            === 1,
        followDisposedTerminalAcknowledged:
          externalSessionsHPhase.follow.disposedTerminalAcknowledgements === 1,
        publicOutputPrivateMetadataAbsent: true,
        takeover: isCandidateHandoffOperationReference(
          externalSessionsHPhase.takeover,
        ),
        materialize: isPackedCandidateMaterializeActionResult(
          externalSessionsHPhase.materialize,
        ),
        recipientSafeStatus: isPackedCandidateOperationActionResult(
          externalSessionsHPhase.status,
        ),
        recipientSafeRecovery: isPackedCandidateOperationActionResult(
          externalSessionsHPhase.recovery,
        ),
      },
      generationHandoff: {
        newPublicOperationsObservedGeneration:
          observedExternalSessionsHGeneration,
        newPublicSnapshotObservedGeneration:
          observedExternalSessionsHGeneration,
        publicGCursorRetired: isPackedCandidateRetiredListCursorEvidence({
          code: externalSessionsHPhase.handoff.publicGCursorRetirementCode,
        }),
        publicGFollowCursorRetired:
          isPackedCandidateRetiredFollowCursorEvidence({
            status: 'unavailable',
            code:
              externalSessionsHPhase.handoff.publicGFollowCursorRetirementCode,
          }),
        publicGRefRoutedToH: samePackedCandidatePublicExternalSessionRef(
          externalSessionsGPhase.publicRef,
          externalSessionsHPhase.publicRef,
        ),
        publicGFollowRetiredOnHReplacement:
          externalSessionsHPhase.handoff.publicGFollow.dataEventCount >= 1
          && externalSessionsHPhase.handoff.publicGFollow
            .terminalAcknowledgements === 1
          && externalSessionsHPhase.handoff.publicGFollow
            .postTerminalEventCount === 0,
        publicGFollowRetiredExactlyOnce:
          externalSessionsHReacquiredPhase.handoff.publicGFollow
            .terminalAcknowledgements === 1,
        publicGFollowNoPostRetirementEvents:
          externalSessionsHReacquiredPhase.handoff.publicGFollow
            .postTerminalEventCount === 0,
        hReinstalledAndRetrusted: agentHReinstalledAndRetrusted,
        reinstalledHFollowReacquired:
          observedExternalSessionsHReacquiredGeneration === 'H'
          && externalSessionsHReacquiredPhase.follow.events.includes('data')
          && externalSessionsHReacquiredPhase.follow.listenerSettled
          && externalSessionsHReacquiredPhase.follow.disposed
          && externalSessionsHReacquiredPhase.follow
            .disposedTerminalAcknowledgements === 1
          && externalSessionsHReacquiredPhase.follow.postTerminalEventCount
            === 0,
      },
      artifacts: {
        agentGArchiveSha256: agentG.archiveSha256,
        agentHArchiveSha256: agentH.archiveSha256,
        providerPArchiveSha256: providerP.archiveSha256,
        providerQArchiveSha256: providerQ.archiveSha256,
        installedArchivesMatchPackedBytes: [
          agentG,
          agentH,
          providerP,
          providerQ,
        ].every((generation) =>
          generation.installedArchiveMatchedPackedBytes),
      },
    } satisfies NonNullable<
      PackedManagedProviderCandidateHandoffContractEvidence['externalSessions']
    >;
    const contract: PackedManagedProviderCandidateHandoffContractEvidence = {
      authoring: {
        exactCandidateSdk: true,
        exactCandidateCli: true,
        exactCandidateStandaloneCli: true,
        externalAgentPublicOnly: true,
        externalProviderPublicOnly: true,
        providerPackageHasNoAgentLocator: true,
      },
      lifecycle,
      custody: {
        retainedProviderSameProcessAfterUpdate: true,
        newProviderDistinctProcess: !sameCandidateProcess(
          retainedBeforeSafeRestart.active.providerProcess,
          fresh.active.providerProcess,
        ),
        newProviderExitedWhileRetainedAlive:
          freshCleanup.providerExited,
        providerProcessStartCountBeforeFreshDemand:
          providerStartsBeforeFreshDemand.length,
        providerProcessStartCountAfterFreshDemand:
          providerStartsAfterFreshDemand.length,
        providerProcessIdentityFingerprints: {
          retainedBeforeUpdate: fingerprintCandidateProcess(
            retainedBeforeSafeRestart.active.providerProcess,
          ),
          retainedAfterUpdate: fingerprintCandidateProcess(
            retainedProcessAfterUpdate,
          ),
          newSessionAfterUpdate: fingerprintCandidateProcess(
            fresh.active.providerProcess,
          ),
        },
        distinctProviderProcessCount: 3,
      },
      turns: {
        retainedInitialTurn: retained.firstTurn,
        retainedLaterTurn: retainedLaterTurnObservation.evidence,
        newSessionFirstTurn: fresh.firstTurn,
      },
      cumulativeNoReplay: {
        afterGenerationAdoption: noReplayAfterGenerationAdoption,
        afterIdleRestart: noReplayAfterIdleRestart,
        afterNewProviderAdmission: noReplayAfterNewProviderAdmission,
      },
      externalSessions: externalSessionsEvidence,
      safeRestart,
      hardRevoke: {
        retainedProviderExited:
          !isProcessAlive(retained.active.providerProcess.pid),
        daemonTakeoverCount: 1,
        reenabledAndRetrusted,
        retainedProviderResurrectionCount,
        retainedProviderAuthorityResurrectionCount,
        revokeWindowProviderProcessStartCount,
      },
      cleanup: {
        sessionsPresent: children.filter((child) =>
          child.happySessionId === retained?.active.sessionId
          || child.happySessionId === fresh?.active.sessionId).length,
        descendantProcessesAlive: [...observedDescendantPids]
          .filter(isProcessAlive).length,
        providerProcessesAlive: finalUnexpectedProviderProcesses.length,
        authorityFilesPresent: new Set([
          ...knownAuthorityAndMarkerPaths.filter(existsSync),
          ...finalAuthorityArtifacts.filter(existsSync),
        ]).size,
        capabilityFilesPresent: finalCapabilityPaths.filter((path) =>
          !initialCapabilityPaths.includes(path)).length,
      },
    };
    assertPackedManagedProviderCandidateHandoffContract(contract);
    observation = { contract };
  } catch (error) {
    hasPrimaryFailure = true;
    primaryFailure = error;
  }
  const cleanupErrors = await collectPackedManagedProviderCleanupErrors([
    ...(fresh && runtime.candidateHandoffSessions.includes(fresh.active)
      ? [{
        run: async () => await stopCandidateHandoffSession({
          runtime,
          session: fresh,
        }),
      }]
      : []),
    ...(retained && runtime.candidateHandoffSessions.includes(retained.active)
      ? [{
        run: async () => await stopCandidateHandoffSession({
          runtime,
          session: retained,
        }),
      }]
      : []),
    ...(providerProcessStarts && !providerProcessStartsStopped
      ? [{ run: async () => await providerProcessStarts.stop() }]
      : []),
    ...(authoring ? [{ run: async () => await authoring.registry.close() }] : []),
  ]);
  if (hasPrimaryFailure && cleanupErrors.length > 0) {
    throw new AggregateError(
      [primaryFailure, ...cleanupErrors],
      'packed managed candidate handoff failed during cleanup',
    );
  }
  if (hasPrimaryFailure) throw primaryFailure;
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      cleanupErrors,
      'packed managed candidate handoff cleanup failed',
    );
  }
  assert(observation, 'packed_managed_provider_candidate_handoff_missing');
  return observation;
}

export type PackedManagedProviderContinuityContractEvidence = Readonly<{
  publicActivationReasons: readonly [
    'explicitStartLocal',
    'catalogProbe',
    'sessionDemand',
  ];
  sessionP: Readonly<{
    providerStartCount: number;
    sameProviderProcessAcrossTakeovers: boolean;
    sameRunnerIdentityAcrossTakeovers: boolean;
    sameWrapperIdentityAcrossTakeovers: boolean;
    sameRetainedProviderClaimAcrossTakeovers: boolean;
    samePublicProviderSessionIdentityAcrossTakeovers: boolean;
    daemonTakeoverCount: 2;
    providerAttemptCount: number;
    canonicalSessionCreateCount: number;
    turns: Readonly<{
      b: PackedManagedProviderContinuityTurnEvidence;
      c: PackedManagedProviderContinuityTurnEvidence;
      bAfterC: PackedManagedProviderContinuityTurnEvidence;
      cAfterC: PackedManagedProviderContinuityTurnEvidence;
      bAfterHardRevoke: PackedManagedProviderContinuityTurnEvidence;
      cAfterHardRevoke: PackedManagedProviderContinuityTurnEvidence;
    }>;
    requestAuth: Readonly<{
      capabilityPathStableAcrossTakeovers: boolean;
      capabilityRotatedFromAToB: boolean;
      capabilityRotatedFromBToC: boolean;
      aCapabilityStatusUnderB: number;
      bCapabilityStatusUnderB: number;
      bCapabilityStatusUnderC: number;
      cCapabilityStatusUnderC: number;
      selectedCredentialRevisionRotated: boolean;
      currentCredentialRevisionObserved: boolean;
      wrapperEffectCountForRotatedCredential: number;
      wrapperUsedCurrentCredential: boolean;
    }>;
  }>;
  sessionQ: Readonly<{
    providerStartCount: number;
    distinctProviderProcess: boolean;
    providerAttemptCount: number;
    canonicalSessionCreateCount: number;
    providerExited: boolean;
  }>;
  retainedSessionP: Readonly<{
    publicSessionPresent: boolean;
    providerProcessAlive: boolean;
  }>;
  hardRevoke: Readonly<{
    retainedProviderExited: boolean;
    retainedProviderAuthorityRevoked: boolean;
    daemonTakeoverCount: 1;
    reenabled: boolean;
    retainedProviderResurrectionEffectCount: number;
    retainedProviderAuthorityResurrectionCount: number;
    revokeWindowProviderProcessStartCount: number;
  }>;
}>;

type PackedManagedProviderExactlyOnceTurnEvidence = Readonly<{
  expectedAgentGeneration: 'G' | 'H';
  observedAgentGeneration: 'G' | 'H';
  effectCount: number;
  outputCount: number;
  terminalCount: number;
}>;

export type PackedManagedProviderSafeRestartContractEvidence = Readonly<{
  busy: Readonly<{
    statusVersionState: 'stale';
    plannedRestartEligible: false;
    plannedRestartDisabledReason: 'turn_in_progress';
    restartStatus: 'busy';
    restartReasonCode: 'turn_in_progress';
    agentRuntimeUnchanged: boolean;
    runnerIdentityUnchangedAfterBusyResult: boolean;
    runnerIdentityUnchangedAfterHeldTurn: boolean;
    providerProcessUnchanged: boolean;
    providerProcessStartCountBefore: number;
    providerProcessStartCountAfter: number;
    noDeferredRestartAfterTurn: boolean;
  }>;
  idle: Readonly<{
    statusVersionStateBefore: 'stale';
    plannedRestartEligibleBefore: true;
    restartStatus: 'restarted';
    movedToCurrentAgentRuntime: boolean;
    providerProcessReplaced: boolean;
    laterTurn: PackedManagedProviderExactlyOnceTurnEvidence;
  }>;
  removed: Readonly<{
    statusVersionState: 'stale';
    plannedRestartEligible: false;
    plannedRestartDisabledReason: 'unsupported_backend';
    restartStatus: 'ineligible';
    restartReasonCode: 'unsupported_backend';
    agentRuntimeUnchanged: boolean;
    providerProcessUnchanged: boolean;
    providerProcessStartCountBefore: number;
    providerProcessStartCountAfter: number;
    retainedRuntimeContinued: boolean;
    laterTurn: PackedManagedProviderExactlyOnceTurnEvidence;
  }>;
}>;

export function assertPackedManagedProviderSafeRestartContract(
  evidence: PackedManagedProviderSafeRestartContractEvidence,
): void {
  assert(
    evidence.busy.statusVersionState === 'stale'
      && evidence.busy.plannedRestartEligible === false
      && evidence.busy.plannedRestartDisabledReason === 'turn_in_progress'
      && evidence.busy.restartStatus === 'busy'
      && evidence.busy.restartReasonCode === 'turn_in_progress'
      && evidence.busy.agentRuntimeUnchanged
      && evidence.busy.runnerIdentityUnchangedAfterBusyResult
      && evidence.busy.runnerIdentityUnchangedAfterHeldTurn
      && evidence.busy.providerProcessUnchanged
      && evidence.busy.providerProcessStartCountBefore === 1
      && evidence.busy.providerProcessStartCountAfter === 1
      && evidence.busy.noDeferredRestartAfterTurn,
    'packed_managed_provider_candidate_busy_restart_mismatch',
  );
  assert(
    evidence.idle.statusVersionStateBefore === 'stale'
      && evidence.idle.plannedRestartEligibleBefore
      && evidence.idle.restartStatus === 'restarted'
      && evidence.idle.movedToCurrentAgentRuntime
      && evidence.idle.providerProcessReplaced,
    'packed_managed_provider_candidate_idle_restart_mismatch',
  );
  assertPackedExactlyOnceTurn(
    evidence.idle.laterTurn,
    'packed_managed_provider_candidate_restarted_turn_not_exactly_once',
  );
  assert(
    evidence.removed.statusVersionState === 'stale'
      && evidence.removed.plannedRestartEligible === false
      && evidence.removed.plannedRestartDisabledReason
        === 'unsupported_backend'
      && evidence.removed.restartStatus === 'ineligible'
      && evidence.removed.restartReasonCode === 'unsupported_backend'
      && evidence.removed.agentRuntimeUnchanged
      && evidence.removed.providerProcessUnchanged
      && evidence.removed.providerProcessStartCountBefore === 3
      && evidence.removed.providerProcessStartCountAfter === 3
      && evidence.removed.retainedRuntimeContinued,
    'packed_managed_provider_candidate_removed_restart_mismatch',
  );
  assertPackedExactlyOnceTurn(
    evidence.removed.laterTurn,
    'packed_managed_provider_candidate_removed_turn_not_exactly_once',
  );
}

export type PackedManagedProviderCandidateHandoffContractEvidence = Readonly<{
  authoring: Readonly<{
    exactCandidateSdk: boolean;
    exactCandidateCli: boolean;
    exactCandidateStandaloneCli: boolean;
    externalAgentPublicOnly: boolean;
    externalProviderPublicOnly: boolean;
    providerPackageHasNoAgentLocator: boolean;
  }>;
  lifecycle: RetainedPluginLifecycleManifestEvidence;
  custody: Readonly<{
    retainedProviderSameProcessAfterUpdate: boolean;
    newProviderDistinctProcess: boolean;
    newProviderExitedWhileRetainedAlive: boolean;
    providerProcessStartCountBeforeFreshDemand: number;
    providerProcessStartCountAfterFreshDemand: number;
    providerProcessIdentityFingerprints: Readonly<{
      retainedBeforeUpdate: string;
      retainedAfterUpdate: string;
      newSessionAfterUpdate: string;
    }>;
    distinctProviderProcessCount: 3;
  }>;
  turns: Readonly<{
    retainedInitialTurn: PackedManagedProviderExactlyOnceTurnEvidence;
    retainedLaterTurn: PackedManagedProviderExactlyOnceTurnEvidence;
    newSessionFirstTurn: PackedManagedProviderExactlyOnceTurnEvidence;
  }>;
  cumulativeNoReplay: Readonly<{
    afterGenerationAdoption: Readonly<{
      retainedInitialTurn: PackedManagedProviderExactlyOnceTurnEvidence;
    }>;
    afterIdleRestart: Readonly<{
      retainedInitialTurn: PackedManagedProviderExactlyOnceTurnEvidence;
      retainedUpdateTurn: PackedManagedProviderExactlyOnceTurnEvidence;
    }>;
    afterNewProviderAdmission: Readonly<{
      retainedInitialTurn: PackedManagedProviderExactlyOnceTurnEvidence;
      retainedUpdateTurn: PackedManagedProviderExactlyOnceTurnEvidence;
      restartedCurrentTurn: PackedManagedProviderExactlyOnceTurnEvidence;
      newSessionFirstTurn: PackedManagedProviderExactlyOnceTurnEvidence;
    }>;
  }>;
  externalSessions?: Readonly<{
    publicFlow: Readonly<{
      capabilities: boolean;
      list: boolean;
      attach: boolean;
      backgroundFollowEnabled: boolean;
      backgroundFollowDisabled: boolean;
      read: boolean;
      followAcknowledged: boolean;
      followListenerSettled: boolean;
      followDisposed: boolean;
      followDisposedTerminalAcknowledged: boolean;
      publicOutputPrivateMetadataAbsent: boolean;
      takeover: boolean;
      materialize: boolean;
      recipientSafeStatus: boolean;
      recipientSafeRecovery: boolean;
    }>;
    generationHandoff: Readonly<{
      newPublicOperationsObservedGeneration: 'H';
      newPublicSnapshotObservedGeneration: 'H';
      publicGCursorRetired: boolean;
      publicGFollowCursorRetired: boolean;
      publicGRefRoutedToH: boolean;
      publicGFollowRetiredOnHReplacement: boolean;
      publicGFollowRetiredExactlyOnce: boolean;
      publicGFollowNoPostRetirementEvents: boolean;
      hReinstalledAndRetrusted: boolean;
      reinstalledHFollowReacquired: boolean;
    }>;
    artifacts: Readonly<{
      agentGArchiveSha256: string;
      agentHArchiveSha256: string;
      providerPArchiveSha256: string;
      providerQArchiveSha256: string;
      installedArchivesMatchPackedBytes: boolean;
    }>;
  }>;
  safeRestart: PackedManagedProviderSafeRestartContractEvidence;
  hardRevoke: Readonly<{
    retainedProviderExited: boolean;
    daemonTakeoverCount: 1;
    reenabledAndRetrusted: boolean;
    retainedProviderResurrectionCount: number;
    retainedProviderAuthorityResurrectionCount: number;
    revokeWindowProviderProcessStartCount: number;
  }>;
  cleanup: Readonly<{
    sessionsPresent: number;
    descendantProcessesAlive: number;
    providerProcessesAlive: number;
    authorityFilesPresent: number;
    capabilityFilesPresent: number;
  }>;
}>;

export type PackedManagedProviderCandidateHandoffObservation = Readonly<{
  contract: PackedManagedProviderCandidateHandoffContractEvidence;
}>;

function assertPackedExactlyOnceTurn(
  evidence: PackedManagedProviderExactlyOnceTurnEvidence,
  code: string,
): void {
  assert(
    evidence.expectedAgentGeneration === evidence.observedAgentGeneration
      && evidence.effectCount === 1
      && evidence.outputCount === 1
      && evidence.terminalCount === 1,
    code,
  );
}

export function assertPackedManagedProviderCandidateHandoffContract(
  evidence: PackedManagedProviderCandidateHandoffContractEvidence,
): void {
  assert(
    evidence.authoring.exactCandidateSdk
      && evidence.authoring.exactCandidateCli
      && evidence.authoring.exactCandidateStandaloneCli
      && evidence.authoring.externalAgentPublicOnly
      && evidence.authoring.externalProviderPublicOnly
      && evidence.authoring.providerPackageHasNoAgentLocator,
    'packed_managed_provider_candidate_authoring_mismatch',
  );
  assert(
    evidence.lifecycle.agent.distinctGenerationCount === 2
      && evidence.lifecycle.agent.retainedLaterTurn === 'completed'
      && evidence.lifecycle.agent.newSessionFirstTurn === 'completed'
      && evidence.lifecycle.agent.generations
        .retainedSessionBeforeUpdate
        === evidence.lifecycle.agent.generations
          .retainedSessionAfterUpdate
      && evidence.lifecycle.agent.generations
        .retainedSessionBeforeUpdate
        !== evidence.lifecycle.agent.generations
          .newSessionAfterUpdate
      && evidence.lifecycle.provider.distinctGenerationCount === 2
      && evidence.lifecycle.provider.retainedHandleUse === 'continued'
      && evidence.lifecycle.provider.newClaim === 'admitted'
      && evidence.lifecycle.provider.generations
        .retainedHandleBeforeUpdate
        === evidence.lifecycle.provider.generations
          .retainedHandleAfterUpdate
      && evidence.lifecycle.provider.generations
        .retainedHandleBeforeUpdate
        !== evidence.lifecycle.provider.generations
          .newClaimAfterUpdate,
    'packed_managed_provider_candidate_generation_handoff_mismatch',
  );
  assert(
    evidence.custody.retainedProviderSameProcessAfterUpdate
      && evidence.custody.newProviderDistinctProcess
      && evidence.custody.newProviderExitedWhileRetainedAlive
      && evidence.custody.providerProcessStartCountBeforeFreshDemand === 2
      && evidence.custody.providerProcessStartCountAfterFreshDemand === 3
      && evidence.custody.distinctProviderProcessCount === 3
      && evidence.custody.providerProcessIdentityFingerprints
        .retainedBeforeUpdate
        === evidence.custody.providerProcessIdentityFingerprints
          .retainedAfterUpdate
      && evidence.custody.providerProcessIdentityFingerprints
        .retainedBeforeUpdate
        !== evidence.custody.providerProcessIdentityFingerprints
          .newSessionAfterUpdate
      && Object.values(
        evidence.custody.providerProcessIdentityFingerprints,
      ).every((fingerprint) => /^sha256:[a-f0-9]{64}$/u.test(fingerprint)),
    'packed_managed_provider_candidate_custody_mismatch',
  );
  assertPackedExactlyOnceTurn(
    evidence.turns.retainedInitialTurn,
    'packed_managed_provider_candidate_initial_turn_not_exactly_once',
  );
  assertPackedExactlyOnceTurn(
    evidence.turns.retainedLaterTurn,
    'packed_managed_provider_candidate_retained_turn_not_exactly_once',
  );
  assertPackedExactlyOnceTurn(
    evidence.turns.newSessionFirstTurn,
    'packed_managed_provider_candidate_new_turn_not_exactly_once',
  );
  assertPackedExactlyOnceTurn(
    evidence.cumulativeNoReplay.afterGenerationAdoption.retainedInitialTurn,
    'packed_managed_provider_candidate_initial_turn_replayed_after_adoption',
  );
  assertPackedExactlyOnceTurn(
    evidence.cumulativeNoReplay.afterIdleRestart.retainedInitialTurn,
    'packed_managed_provider_candidate_initial_turn_replayed_after_restart',
  );
  assertPackedExactlyOnceTurn(
    evidence.cumulativeNoReplay.afterIdleRestart.retainedUpdateTurn,
    'packed_managed_provider_candidate_update_turn_replayed_after_restart',
  );
  assertPackedExactlyOnceTurn(
    evidence.cumulativeNoReplay.afterNewProviderAdmission.retainedInitialTurn,
    'packed_managed_provider_candidate_initial_turn_replayed_after_new_claim',
  );
  assertPackedExactlyOnceTurn(
    evidence.cumulativeNoReplay.afterNewProviderAdmission.retainedUpdateTurn,
    'packed_managed_provider_candidate_update_turn_replayed_after_new_claim',
  );
  assertPackedExactlyOnceTurn(
    evidence.cumulativeNoReplay.afterNewProviderAdmission
      .restartedCurrentTurn,
    'packed_managed_provider_candidate_restarted_turn_replayed_after_new_claim',
  );
  assertPackedExactlyOnceTurn(
    evidence.cumulativeNoReplay.afterNewProviderAdmission.newSessionFirstTurn,
    'packed_managed_provider_candidate_new_turn_replayed_after_new_claim',
  );
  assertPackedManagedProviderSafeRestartContract(evidence.safeRestart);
  const externalSessions = evidence.externalSessions;
  assert(
    externalSessions !== undefined
      && Object.values(externalSessions.publicFlow).every(Boolean)
      && externalSessions.generationHandoff
        .newPublicOperationsObservedGeneration === 'H'
      && externalSessions.generationHandoff
        .newPublicSnapshotObservedGeneration === 'H'
      && externalSessions.generationHandoff.publicGCursorRetired
      && externalSessions.generationHandoff.publicGFollowCursorRetired
      && externalSessions.generationHandoff.publicGRefRoutedToH
      && externalSessions.generationHandoff.publicGFollowRetiredOnHReplacement
      && externalSessions.generationHandoff.publicGFollowRetiredExactlyOnce
      && externalSessions.generationHandoff.publicGFollowNoPostRetirementEvents
      && externalSessions.generationHandoff.hReinstalledAndRetrusted
      && externalSessions.generationHandoff.reinstalledHFollowReacquired
      && [
        externalSessions.artifacts.agentGArchiveSha256,
        externalSessions.artifacts.agentHArchiveSha256,
        externalSessions.artifacts.providerPArchiveSha256,
        externalSessions.artifacts.providerQArchiveSha256,
      ].every((fingerprint) => /^sha256:[a-f0-9]{64}$/u.test(fingerprint))
      && externalSessions.artifacts.agentGArchiveSha256
        !== externalSessions.artifacts.agentHArchiveSha256
      && externalSessions.artifacts.providerPArchiveSha256
        !== externalSessions.artifacts.providerQArchiveSha256
      && externalSessions.artifacts.installedArchivesMatchPackedBytes,
    'packed_managed_provider_candidate_external_sessions_mismatch',
  );
  assert(
    evidence.hardRevoke.retainedProviderExited
      && evidence.hardRevoke.daemonTakeoverCount === 1
      && evidence.hardRevoke.reenabledAndRetrusted
      && evidence.hardRevoke.retainedProviderResurrectionCount === 0
      && evidence.hardRevoke.retainedProviderAuthorityResurrectionCount === 0
      && evidence.hardRevoke.revokeWindowProviderProcessStartCount === 0,
    'packed_managed_provider_candidate_hard_revoke_mismatch',
  );
  assert(
    evidence.cleanup.sessionsPresent === 0
      && evidence.cleanup.descendantProcessesAlive === 0
      && evidence.cleanup.providerProcessesAlive === 0
      && evidence.cleanup.authorityFilesPresent === 0
      && evidence.cleanup.capabilityFilesPresent === 0,
    'packed_managed_provider_candidate_cleanup_mismatch',
  );
}

export function assertPackedManagedProviderContinuityContract(
  evidence: PackedManagedProviderContinuityContractEvidence,
): void {
  assert(
    evidence.publicActivationReasons.length === 3
      && evidence.publicActivationReasons[0] === 'explicitStartLocal'
      && evidence.publicActivationReasons[1] === 'catalogProbe'
      && evidence.publicActivationReasons[2] === 'sessionDemand',
    'packed_managed_provider_continuity_activation_reasons_mismatch',
  );
  assert(
    evidence.sessionP.providerStartCount === 1
      && evidence.sessionP.sameProviderProcessAcrossTakeovers
      && evidence.sessionP.sameRunnerIdentityAcrossTakeovers
      && evidence.sessionP.sameWrapperIdentityAcrossTakeovers
      && evidence.sessionP.sameRetainedProviderClaimAcrossTakeovers
      && evidence.sessionP.samePublicProviderSessionIdentityAcrossTakeovers
      && evidence.sessionP.daemonTakeoverCount === 2
      && evidence.sessionP.providerAttemptCount === 3
      && evidence.sessionP.canonicalSessionCreateCount === 1,
    'packed_managed_provider_session_p_continuity_mismatch',
  );
  for (const [phase, turn] of Object.entries(evidence.sessionP.turns)) {
    assertPackedManagedProviderContinuityTurn(
      turn,
      `packed_managed_provider_session_p_${phase}_turn_not_exactly_once`,
    );
  }
  assert(
    evidence.sessionP.requestAuth.capabilityPathStableAcrossTakeovers
      && evidence.sessionP.requestAuth.capabilityRotatedFromAToB
      && evidence.sessionP.requestAuth.capabilityRotatedFromBToC
      && evidence.sessionP.requestAuth.aCapabilityStatusUnderB === 401
      && evidence.sessionP.requestAuth.bCapabilityStatusUnderB === 200
      && evidence.sessionP.requestAuth.bCapabilityStatusUnderC === 401
      && evidence.sessionP.requestAuth.cCapabilityStatusUnderC === 200
      && evidence.sessionP.requestAuth.selectedCredentialRevisionRotated
      && evidence.sessionP.requestAuth.currentCredentialRevisionObserved
      && evidence.sessionP.requestAuth.wrapperEffectCountForRotatedCredential
        === 1
      && evidence.sessionP.requestAuth.wrapperUsedCurrentCredential,
    'packed_managed_provider_session_p_request_auth_continuity_mismatch',
  );
  assert(
    evidence.sessionQ.providerStartCount === 1
      && evidence.sessionQ.distinctProviderProcess
      && evidence.sessionQ.providerAttemptCount === 1
      && evidence.sessionQ.canonicalSessionCreateCount === 1
      && evidence.sessionQ.providerExited,
    'packed_managed_provider_session_q_isolation_mismatch',
  );
  assert(
    evidence.retainedSessionP.publicSessionPresent
      && evidence.retainedSessionP.providerProcessAlive,
    'packed_managed_provider_session_p_not_retained',
  );
  assert(
    evidence.hardRevoke.retainedProviderExited
      && evidence.hardRevoke.retainedProviderAuthorityRevoked
      && evidence.hardRevoke.daemonTakeoverCount === 1
      && evidence.hardRevoke.reenabled
      && evidence.hardRevoke.retainedProviderResurrectionEffectCount === 0
      && evidence.hardRevoke.retainedProviderAuthorityResurrectionCount === 0
      && evidence.hardRevoke.revokeWindowProviderProcessStartCount === 0,
    'packed_managed_provider_session_p_hard_revoke_mismatch',
  );
}

export type PackedManagedProviderContinuityObservation = Readonly<{
  contract: PackedManagedProviderContinuityContractEvidence;
  sessionP: Readonly<{
    sessionId: string;
    providerPid: number;
    providerExecutablePath: string;
  }>;
  daemonPids: readonly [number, number, number];
  sessionQ: Readonly<{
    sessionId: string;
    providerPid: number;
    providerExecutablePath: string;
  }>;
}>;

function candidateDaemonEnv(
  runtime: InitializedRuntime,
): NodeJS.ProcessEnv {
  return sanitizeDaemonEnvForSpawn({
    ...runtime.daemonEnv,
    HAPPIER_HOME_DIR: runtime.happyHomeDir,
    HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: runtime.happyHomeDir,
    HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: runtime.happyHomeDir,
  });
}

async function runCandidateCommand(input: Readonly<{
  runtime: InitializedRuntime;
  prepared: PackedManagedProviderPreparedInput;
  args: readonly string[];
  waitForExit: boolean;
}>): Promise<ReturnType<typeof spawn>> {
  const child = spawn(
    input.prepared.prepared.cliLaunchSpec.command,
    [...input.prepared.prepared.cliLaunchSpec.args, ...input.args],
    {
      cwd: input.prepared.prepared.cliLaunchSpec.cwd,
      env: {
        ...input.prepared.prepared.cliLaunchSpec.env,
        ...candidateDaemonEnv(input.runtime),
      },
      stdio: 'ignore',
      windowsHide: true,
    },
  );
  await once(child, 'spawn');
  if (input.waitForExit) {
    const [code, signal] = await once(child, 'exit') as [
      number | null,
      NodeJS.Signals | null,
    ];
    assert(
      code === 0 && signal === null,
      'packed_managed_provider_candidate_command_failed:'
        + String(code ?? signal ?? 'unknown'),
    );
  }
  return child;
}

async function waitForReplacementDaemon(
  runtime: InitializedRuntime,
  previousPid: number,
): Promise<DaemonState> {
  let replacement: DaemonState | null = null;
  await waitFor(async () => {
    const state = await readDaemonState(runtime.happyHomeDir);
    if (
      !state
      || state.pid === previousPid
      || state.pid <= 1
      || state.httpPort <= 0
      || !isProcessAlive(state.pid)
    ) {
      return false;
    }
    const ping = await daemonControlPostJson({
      port: state.httpPort,
      path: '/ping',
      controlToken: state.controlToken,
      body: {},
      timeoutMs: 2_000,
    }).catch(() => ({ status: 0, data: null }));
    if (ping.status !== 200) return false;
    replacement = state;
    return true;
  }, {
    timeoutMs: 120_000,
    intervalMs: 50,
    context: 'replacement daemon after ' + String(previousPid),
  });
  assert(replacement, 'packed_managed_provider_replacement_daemon_missing');
  return replacement;
}

async function sendContinuityPrompt(
  runtime: InitializedRuntime,
  sessionId: string,
  label: string,
): Promise<string> {
  const sentinel =
    'packed-managed-continuity-' + label + ':' + randomUUID();
  await postEncryptedUiTextMessage({
    baseUrl: runtime.server.baseUrl,
    token: runtime.auth.token,
    sessionId,
    secret: runtime.accountSecret,
    text: 'Reply with exactly ' + sentinel + '.',
    timeoutMs: 20_000,
  });
  await waitFor(() => runtime.connectProxy.entries().some((entry) =>
    entry.body.includes(sentinel)), {
    timeoutMs: 60_000,
    intervalMs: 25,
    context: 'packed managed continuity provider attempt ' + label,
  });
  return sentinel;
}

export async function probePackedManagedProviderDaemonContinuity(
  runtime: InitializedRuntime,
  input: PackedManagedProviderPreparedInput,
): Promise<PackedManagedProviderContinuityObservation> {
  const sessionP = runtime.activeSession;
  assert(sessionP, 'packed_managed_provider_continuity_session_p_missing');
  const pInitial = sessionP.providerProcess;
  const publicSessionA = await waitForCanonicalPublicSessionIdentity({
    runtime,
    sessionId: sessionP.sessionId,
    phase: 'a',
  });
  const canonicalCreatesBefore = runtime.serverProxy.entries()
    .filter(isSessionCreationRequest).length;
  const daemonPids: number[] = [runtime.currentDaemonState.pid];
  const continuitySentinels: string[] = [];
  const runnerA = await waitForRunnerDaemonServiceAuthority({
    happyHomeDir: runtime.happyHomeDir,
    sessionId: sessionP.sessionId,
  });
  const retainedProviderClaimA = await waitForRetainedProviderClaimFingerprint({
    runtime,
    sessionId: sessionP.sessionId,
  });
  const wrapperA = await observeCandidateWrapperIdentity(pInitial);
  const requestAuthA = await waitForCurrentOpenAiRequestAuthCapability({
    runtime,
    httpPort: runtime.currentDaemonState.httpPort,
  });
  const [requestAuthCapabilityA] = requestAuthA;
  assert(
    requestAuthCapabilityA,
    'packed_managed_provider_request_auth_capability_a_missing',
  );
  const restartRetainedP = async () => {
    const previousDaemon = runtime.currentDaemonState;
    const takeover = runCandidateCommand({
      runtime,
      prepared: input,
      args: ['daemon', 'restart', '--takeover', '--json'],
      waitForExit: true,
    });
    const replacement =
      await waitForReplacementDaemon(runtime, previousDaemon.pid);
    await takeover;
    runtime.currentDaemonState = replacement;
    runtime.stockPortObserver.observeOwnedProcess(replacement.pid);
    daemonPids.push(replacement.pid);
    const currentP = (await listCandidateWrapperProcesses(input))
      .find((process) => process.pid === pInitial.pid);
    assert(
      currentP,
      'packed_managed_provider_session_p_provider_missing_after_takeover',
    );
    assert(
      sameCandidateProcess(currentP, pInitial),
      'packed_managed_provider_session_p_provider_restarted',
    );
    assert(
      (await sessionP.providerProcessStarts.observe()).length === 1,
      'packed_managed_provider_duplicate_candidate_process_start',
    );
    return {
      authority: await waitForRunnerDaemonServiceAuthority({
        happyHomeDir: runtime.happyHomeDir,
        sessionId: sessionP.sessionId,
      }),
      retainedProviderClaim:
        await waitForRetainedProviderClaimFingerprint({
          runtime,
          sessionId: sessionP.sessionId,
        }),
      wrapper: await observeCandidateWrapperIdentity(currentP),
      requestAuth: await waitForCurrentOpenAiRequestAuthCapability({
        runtime,
        httpPort: runtime.currentDaemonState.httpPort,
      }),
    };
  };
  const phaseB = await restartRetainedP();
  const publicSessionB = await waitForCanonicalPublicSessionIdentity({
    runtime,
    sessionId: sessionP.sessionId,
    phase: 'b',
  });
  const [requestAuthCapabilityB] = phaseB.requestAuth;
  assert(
    requestAuthCapabilityB,
    'packed_managed_provider_request_auth_capability_b_missing',
  );
  const requestAuthAUnderB = await lookupRequestAuthCapability({
    capability: requestAuthCapabilityA.document.capability,
    httpPort: runtime.currentDaemonState.httpPort,
  });
  const completedTurnIdBeforeB = readCompletedTurnId(await fetchSessionV2(
    runtime.server.baseUrl,
    runtime.auth.token,
    sessionP.sessionId,
  ).catch(() => null));
  const sentinelB = await sendContinuityPrompt(
    runtime,
    sessionP.sessionId,
    'b',
  );
  continuitySentinels.push(sentinelB);
  const turnB = await observePackedManagedProviderContinuityTurn({
    runtime,
    sessionId: sessionP.sessionId,
    sentinel: sentinelB,
    previousCompletedTurnId: completedTurnIdBeforeB,
  });
  const phaseC = await restartRetainedP();
  const publicSessionC = await waitForCanonicalPublicSessionIdentity({
    runtime,
    sessionId: sessionP.sessionId,
    phase: 'c',
  });
  const [requestAuthCapabilityC] = phaseC.requestAuth;
  assert(
    requestAuthCapabilityC,
    'packed_managed_provider_request_auth_capability_c_missing',
  );
  const requestAuthBUnderC = await lookupRequestAuthCapability({
    capability: requestAuthCapabilityB.document.capability,
    httpPort: runtime.currentDaemonState.httpPort,
  });
  const previousCredential = runtime.credential;
  const rotatedCredential = await seedCredential({
    serverBaseUrl: runtime.server.baseUrl,
    authToken: runtime.auth.token,
    accountSecret: runtime.accountSecret,
  });
  runtime.credential = rotatedCredential;
  const requestAuthAfterCredentialRotation =
    await waitForCurrentOpenAiRequestAuthCapability({
      runtime,
      httpPort: runtime.currentDaemonState.httpPort,
      expectedCredentialRevision: rotatedCredential.credentialRevision,
    });
  const [requestAuthCapabilityAfterCredentialRotation] =
    requestAuthAfterCredentialRotation;
  assert(
    requestAuthCapabilityAfterCredentialRotation,
    'packed_managed_provider_request_auth_rotated_credential_missing',
  );
  const completedTurnIdBeforeC = readCompletedTurnId(await fetchSessionV2(
    runtime.server.baseUrl,
    runtime.auth.token,
    sessionP.sessionId,
  ).catch(() => null));
  const sentinelC = await sendContinuityPrompt(
    runtime,
    sessionP.sessionId,
    'c',
  );
  continuitySentinels.push(sentinelC);
  const turnC = await observePackedManagedProviderContinuityTurn({
    runtime,
    sessionId: sessionP.sessionId,
    sentinel: sentinelC,
    previousCompletedTurnId: completedTurnIdBeforeC,
  });
  const knownBeforeQ = await listCandidateWrapperProcesses(input);
  const spawnedQ = await spawnPublicSession(runtime, input);
  const qProcess = spawnedQ.active.providerProcess;
  assert(
    !knownBeforeQ.some((process) => sameCandidateProcess(process, qProcess))
      && !sameCandidateProcess(pInitial, qProcess),
    'packed_managed_provider_session_q_provider_not_distinct',
  );
  const qCleanup = await stopPublicSession({
    runtime,
    session: spawnedQ.active,
  });
  const childrenBeforeHardRevoke = await readPublicSessionChildren(runtime);
  const retainedProviderAliveBeforeHardRevoke = isProcessAlive(pInitial.pid);
  const bAfterC = await recountPackedManagedProviderContinuityTurn(
    runtime,
    turnB.witness,
  );
  const cAfterC = await recountPackedManagedProviderContinuityTurn(
    runtime,
    turnC.witness,
  );
  assertPackedManagedProviderContinuityTurn(
    bAfterC,
    'packed_managed_provider_session_p_b_turn_replayed_after_c',
  );
  assertPackedManagedProviderContinuityTurn(
    cAfterC,
    'packed_managed_provider_session_p_c_turn_replayed_after_c',
  );

  const providerStartsBeforeHardRevoke =
    (await sessionP.providerProcessStarts.observe()).length;
  const hardRevokeAuthorityPath = phaseC.authority.path;
  await runCandidateCommand({
    runtime,
    prepared: input,
    args: [
      'plugins',
      'disable',
      OPENAI_PURPOSE.consumer.pluginId,
      '--json',
    ],
    waitForExit: true,
  });
  await waitFor(() => !isProcessAlive(pInitial.pid), {
    timeoutMs: 60_000,
    intervalMs: 50,
    context: 'packed managed original Provider P hard revoke',
  });
  await waitFor(async () => !(await retainedProviderAuthorityPresent({
    runtime,
    sessionId: sessionP.sessionId,
    authorityPath: hardRevokeAuthorityPath,
    pluginId: OPENAI_PURPOSE.consumer.pluginId,
  })), {
    timeoutMs: 60_000,
    intervalMs: 50,
    context: 'packed managed original Provider P authority revoke',
  });
  const revokedSentinels: string[] = [];
  let retainedProviderResurrectionEffectCount = 0;
  let retainedProviderAuthorityResurrectionCount = 0;
  let revokeWindowProviderProcessStartCount = 0;
  const rescanRevokedOriginalP = async (): Promise<void> => {
    const observation = await observeRevokedPublicSession({
      runtime,
      sessionId: sessionP.sessionId,
      authorityPath: hardRevokeAuthorityPath,
      pluginId: OPENAI_PURPOSE.consumer.pluginId,
      sentinels: revokedSentinels,
      providerProcessStarts: sessionP.providerProcessStarts,
    });
    retainedProviderResurrectionEffectCount = observation.effectCount;
    retainedProviderAuthorityResurrectionCount ||= Number(
      observation.authorityObserved,
    );
    revokeWindowProviderProcessStartCount = Math.max(
      0,
      observation.providerProcessStartCount - providerStartsBeforeHardRevoke,
    );
  };
  const enqueueAndRescanRevokedOriginalP = async (
    phase: 'takeover' | 'reenable',
  ): Promise<void> => {
    revokedSentinels.push(await enqueueRevokedCandidateSessionInput({
      runtime,
      sessionId: sessionP.sessionId,
      phase,
    }));
    await rescanRevokedOriginalP();
  };
  await rescanRevokedOriginalP();
  const preRevokeTakeoverDaemon = runtime.currentDaemonState;
  const hardRevokeTakeover = runCandidateCommand({
    runtime,
    prepared: input,
    args: ['daemon', 'restart', '--takeover', '--json'],
    waitForExit: true,
  });
  const hardRevokeReplacement = await waitForReplacementDaemon(
    runtime,
    preRevokeTakeoverDaemon.pid,
  );
  await hardRevokeTakeover;
  runtime.currentDaemonState = hardRevokeReplacement;
  runtime.stockPortObserver.observeOwnedProcess(hardRevokeReplacement.pid);
  await rescanRevokedOriginalP();
  await enqueueAndRescanRevokedOriginalP('takeover');
  await runCandidateCommand({
    runtime,
    prepared: input,
    args: [
      'plugins',
      'enable',
      OPENAI_PURPOSE.consumer.pluginId,
      '--json',
    ],
    waitForExit: true,
  });
  await rescanRevokedOriginalP();
  await enqueueAndRescanRevokedOriginalP('reenable');
  await rescanRevokedOriginalP();
  const bAfterHardRevoke = await recountPackedManagedProviderContinuityTurn(
    runtime,
    turnB.witness,
  );
  const cAfterHardRevoke = await recountPackedManagedProviderContinuityTurn(
    runtime,
    turnC.witness,
  );
  assertPackedManagedProviderContinuityTurn(
    bAfterHardRevoke,
    'packed_managed_provider_session_p_b_turn_replayed_after_hard_revoke',
  );
  assertPackedManagedProviderContinuityTurn(
    cAfterHardRevoke,
    'packed_managed_provider_session_p_c_turn_replayed_after_hard_revoke',
  );
  assert(
    retainedProviderResurrectionEffectCount === 0
      && retainedProviderAuthorityResurrectionCount === 0
      && revokeWindowProviderProcessStartCount === 0
      && !isProcessAlive(pInitial.pid),
    'packed_managed_provider_session_p_resurrected_after_hard_revoke',
  );
  const retainedProviderAuthorityRevoked =
    !(await retainedProviderAuthorityPresent({
      runtime,
      sessionId: sessionP.sessionId,
      authorityPath: hardRevokeAuthorityPath,
      pluginId: OPENAI_PURPOSE.consumer.pluginId,
    }));
  const canonicalCreatesAfter = runtime.serverProxy.entries()
    .filter(isSessionCreationRequest).length;
  const pAttempts = runtime.connectProxy.entries().filter((entry) =>
    entry.body.includes(sessionP.promptSentinel)
      || continuitySentinels.some((sentinel) =>
        entry.body.includes(sentinel))).length;
  const qAttempts = runtime.connectProxy.entries().filter((entry) =>
    entry.body.includes(spawnedQ.promptSentinel)).length;
  const rotatedCredentialEntries = runtime.connectProxy.entries().filter(
    (entry) => entry.body.includes(sentinelC),
  );
  await sessionP.providerProcessStarts.observe();
  const contract: PackedManagedProviderContinuityContractEvidence = {
    publicActivationReasons: [
      'explicitStartLocal',
      'catalogProbe',
      'sessionDemand',
    ],
    sessionP: {
      get providerStartCount() {
        return sessionP.providerProcessStarts.snapshot().length;
      },
      sameProviderProcessAcrossTakeovers: retainedProviderAliveBeforeHardRevoke,
      sameRunnerIdentityAcrossTakeovers:
        sameCandidateRunnerIdentity(runnerA.runner, phaseB.authority.runner)
        && sameCandidateRunnerIdentity(
          phaseB.authority.runner,
          phaseC.authority.runner,
        ),
      sameWrapperIdentityAcrossTakeovers:
        sameCandidateWrapperIdentity(wrapperA, phaseB.wrapper)
        && sameCandidateWrapperIdentity(phaseB.wrapper, phaseC.wrapper),
      sameRetainedProviderClaimAcrossTakeovers:
        retainedProviderClaimA === phaseB.retainedProviderClaim
        && phaseB.retainedProviderClaim === phaseC.retainedProviderClaim,
      samePublicProviderSessionIdentityAcrossTakeovers:
        publicSessionA.happySessionId === sessionP.sessionId
        && publicSessionA.happySessionId === publicSessionB.happySessionId
        && publicSessionB.happySessionId === publicSessionC.happySessionId,
      daemonTakeoverCount: 2,
      providerAttemptCount: pAttempts,
      canonicalSessionCreateCount: canonicalCreatesBefore,
      turns: {
        b: turnB.evidence,
        c: turnC.evidence,
        bAfterC,
        cAfterC,
        bAfterHardRevoke,
        cAfterHardRevoke,
      },
      requestAuth: {
        capabilityPathStableAcrossTakeovers:
          sameRequestAuthCapabilityPaths(requestAuthA, phaseB.requestAuth)
          && sameRequestAuthCapabilityPaths(
            phaseB.requestAuth,
            phaseC.requestAuth,
          ),
        capabilityRotatedFromAToB: requestAuthCapabilitiesRotated(
          requestAuthA,
          phaseB.requestAuth,
        ),
        capabilityRotatedFromBToC: requestAuthCapabilitiesRotated(
          phaseB.requestAuth,
          phaseC.requestAuth,
        ),
        aCapabilityStatusUnderB: requestAuthAUnderB.status,
        bCapabilityStatusUnderB: requestAuthCapabilityB.lookup.status,
        bCapabilityStatusUnderC: requestAuthBUnderC.status,
        cCapabilityStatusUnderC: requestAuthCapabilityC.lookup.status,
        selectedCredentialRevisionRotated:
          previousCredential.credentialRevision
            !== rotatedCredential.credentialRevision,
        currentCredentialRevisionObserved:
          requestAuthCapabilityAfterCredentialRotation.lookup
            .credentialRevision === rotatedCredential.credentialRevision
          && requestAuthCapabilityAfterCredentialRotation.lookup
            .accessTokenFingerprint
            === rotatedCredential.accessTokenFingerprint,
        wrapperEffectCountForRotatedCredential: rotatedCredentialEntries.length,
        wrapperUsedCurrentCredential:
          rotatedCredentialEntries.length === 1
          && rotatedCredentialEntries[0]?.authorizationFingerprint
            === rotatedCredential.accessTokenFingerprint,
      },
    },
    sessionQ: {
      providerStartCount: qCleanup.providerStartCount,
      distinctProviderProcess: !sameCandidateProcess(pInitial, qProcess),
      providerAttemptCount: qAttempts,
      canonicalSessionCreateCount:
        canonicalCreatesAfter - canonicalCreatesBefore,
      providerExited: qCleanup.providerExited,
    },
    retainedSessionP: {
      publicSessionPresent: childrenBeforeHardRevoke.some((child) =>
        child.happySessionId === sessionP.sessionId),
      providerProcessAlive: retainedProviderAliveBeforeHardRevoke,
    },
    hardRevoke: {
      retainedProviderExited: !isProcessAlive(pInitial.pid),
      retainedProviderAuthorityRevoked,
      daemonTakeoverCount: 1,
      reenabled: true,
      retainedProviderResurrectionEffectCount,
      retainedProviderAuthorityResurrectionCount,
      revokeWindowProviderProcessStartCount,
    },
  };
  assertPackedManagedProviderContinuityContract(contract);
  assert(
    daemonPids.length === 3,
    'packed_managed_provider_daemon_takeover_count_mismatch',
  );
  return {
    contract,
    sessionP: {
      sessionId: sessionP.sessionId,
      providerPid: pInitial.pid,
      providerExecutablePath: pInitial.executablePath,
    },
    daemonPids: [daemonPids[0]!, daemonPids[1]!, daemonPids[2]!],
    sessionQ: {
      sessionId: spawnedQ.active.sessionId,
      providerPid: qProcess.pid,
      providerExecutablePath: qProcess.executablePath,
    },
  };
}

export type PackedManagedProviderRecoveryRefusalObservation = Readonly<{
  publicActivationReason: 'sessionDemand';
  activationRefused: boolean;
  spawnAcknowledged: boolean;
  providerStarted: boolean;
  upstreamAttempted: boolean;
  activeSessionPreserved: boolean;
}>;

export async function probePackedManagedProviderRecoveryRefusal(
  runtime: InitializedRuntime,
  input: PackedManagedProviderPreparedInput,
): Promise<PackedManagedProviderRecoveryRefusalObservation> {
  const active = runtime.activeSession;
  assert(active, 'packed_managed_provider_recovery_active_session_missing');
  const beforeAttempts = runtime.connectProxy.entries().length;
  const beforeProcesses = await listCandidateWrapperProcesses(input);
  const invalid = await probeInvalidSessionDemand(runtime, input);
  const afterProcesses = await listCandidateWrapperProcesses(input);
  const children = await readPublicSessionChildren(runtime);
  return {
    publicActivationReason: 'sessionDemand',
    activationRefused: invalid.refused,
    spawnAcknowledged: invalid.spawnAcknowledged,
    providerStarted: afterProcesses.length !== beforeProcesses.length,
    upstreamAttempted:
      runtime.connectProxy.entries().length !== beforeAttempts,
    activeSessionPreserved:
      children.some((child) => child.happySessionId === active.sessionId)
      && isProcessAlive(active.providerProcess.pid),
  };
}

type PackedChannelCatalogEntry = Readonly<{
  pluginId: string;
  desiredGeneration: string | null;
  appliedGeneration: string | null;
  projectionGeneration: string;
  raw: Readonly<Record<string, unknown>>;
}>;

type PackedChannelResourceRead = Readonly<{
  digest: string;
  value: unknown;
}>;

type PackedChannelActionAttempt = Readonly<Record<string, unknown>>;

function readPackedChannelCatalogString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0
    ? value
    : null;
}

function readPackedChannelCatalogProjectionGeneration(
  value: Readonly<Record<string, unknown>>,
): string {
  const contributionProjection = isRecord(value.contributions)
    ? value.contributions
    : isRecord(value.contributionIntrospection)
      ? value.contributionIntrospection
      : null;
  const generation = contributionProjection?.generation;
  assert(
    (typeof generation === 'number' && Number.isInteger(generation))
      || (typeof generation === 'string' && generation.length > 0),
    'packed_channel_provider_catalog_projection_generation_missing',
  );
  return String(generation);
}

async function readPackedChannelCatalog(
  runtime: InitializedRuntime,
): Promise<readonly PackedChannelCatalogEntry[]> {
  const response = await daemonControlPostJson<unknown>({
    port: runtime.currentDaemonState.httpPort,
    path: '/plugins/catalog/read',
    controlToken: runtime.currentDaemonState.controlToken,
    body: {},
    timeoutMs: 30_000,
  });
  assert(
    response.status === 200
      && isRecord(response.data)
      && response.data.kind === 'available'
      && Array.isArray(response.data.plugins),
    'packed_channel_provider_catalog_read_failed',
  );
  return response.data.plugins.flatMap((candidate) => {
    if (!isRecord(candidate)) return [];
    const pluginId = readPackedChannelCatalogString(candidate.pluginId);
    if (!pluginId) return [];
    return [{
      pluginId,
      desiredGeneration: readPackedChannelCatalogString(
        candidate.desiredGeneration,
      ),
      appliedGeneration: readPackedChannelCatalogString(
        candidate.appliedGeneration,
      ),
      projectionGeneration:
        readPackedChannelCatalogProjectionGeneration(candidate),
      raw: candidate,
    }];
  });
}

function requirePackedChannelCatalogEntry(
  entries: readonly PackedChannelCatalogEntry[],
  pluginId: string,
): PackedChannelCatalogEntry {
  const entry = entries.find((candidate) => candidate.pluginId === pluginId);
  assert(entry, `packed_channel_provider_catalog_entry_missing:${pluginId}`);
  return entry;
}

function catalogHasPackedChannelContribution(
  entry: PackedChannelCatalogEntry,
  localId: string,
): boolean {
  const projection = isRecord(entry.raw.contributions)
    ? entry.raw.contributions
    : isRecord(entry.raw.contributionIntrospection)
      ? entry.raw.contributionIntrospection
      : null;
  const contributions = projection?.contributions;
  if (!Array.isArray(contributions)) return false;
  return contributions.some((candidate) => {
    if (!isRecord(candidate) || !isRecord(candidate.contribution)) return false;
    return candidate.contribution.pluginId === entry.pluginId
      && candidate.contribution.localId === localId;
  });
}

async function readPackedChannelResource(input: Readonly<{
  runtime: InitializedRuntime;
  expectedGeneration: string;
  callerPluginId: string;
  localId: string;
}>): Promise<PackedChannelResourceRead> {
  const response = await callProviderRpc(
    input.runtime,
    RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ,
    {
      machineId: input.runtime.machineId,
      expectedGeneration: input.expectedGeneration,
      callerPluginId: input.callerPluginId,
      resource: { pluginId: input.callerPluginId, localId: input.localId },
      context: { kind: 'global' },
    },
    DaemonPluginUiResourceReadResponseSchema,
  );
  if (!response.ok) {
    throw new Error(
      `packed_channel_provider_resource_read_failed:${response.code}`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(response.bytesBase64, 'base64').toString('utf8'));
  } catch {
    throw new Error('packed_channel_provider_resource_read_invalid_json');
  }
  return { digest: response.digest, value };
}

async function openPackedChannelResourceWatch(input: Readonly<{
  runtime: InitializedRuntime;
  expectedGeneration: string;
  callerPluginId: string;
  localId: string;
}>): Promise<string> {
  const subscriptionId = `packed-channel-resource-${randomUUID()}`;
  const response = await callProviderRpc(
    input.runtime,
    RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_OPEN,
    {
      machineId: input.runtime.machineId,
      expectedGeneration: input.expectedGeneration,
      callerPluginId: input.callerPluginId,
      subscriptionId,
      resource: { pluginId: input.callerPluginId, localId: input.localId },
      context: { kind: 'global' },
    },
    DaemonPluginUiResourceWatchOpenResponseSchema,
  );
  assert(
    response.ok && response.subscriptionId === subscriptionId,
    'packed_channel_provider_resource_watch_open_failed',
  );
  return subscriptionId;
}

async function nextPackedChannelResourceWatch(input: Readonly<{
  runtime: InitializedRuntime;
  expectedGeneration: string;
  callerPluginId: string;
  subscriptionId: string;
}>) {
  return await callProviderRpc(
    input.runtime,
    RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_NEXT,
    {
      machineId: input.runtime.machineId,
      expectedGeneration: input.expectedGeneration,
      callerPluginId: input.callerPluginId,
      subscriptionId: input.subscriptionId,
      waitMs: 25_000,
    },
    DaemonPluginUiResourceWatchNextResponseSchema,
  );
}

async function closePackedChannelResourceWatch(input: Readonly<{
  runtime: InitializedRuntime;
  callerPluginId: string;
  subscriptionId: string;
}>): Promise<void> {
  const response = await callProviderRpc(
    input.runtime,
    RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_CLOSE,
    {
      machineId: input.runtime.machineId,
      callerPluginId: input.callerPluginId,
      subscriptionId: input.subscriptionId,
    },
    DaemonPluginUiResourceWatchCloseResponseSchema,
  );
  assert(
    response.ok && response.closed,
    'packed_channel_provider_resource_watch_close_failed',
  );
}

async function executePackedChannelAction(input: Readonly<{
  runtime: InitializedRuntime;
  actionId: string;
  actionInput: unknown;
  expectedContributorImmutableGenerationId?: string;
}>): Promise<PackedChannelActionAttempt> {
  const response = await daemonControlPostJson<unknown>({
    port: input.runtime.currentDaemonState.httpPort,
    path: '/plugins/actions/execute',
    controlToken: input.runtime.currentDaemonState.controlToken,
    body: {
      actionId: input.actionId,
      input: input.actionInput,
      surface: 'cli',
      ...(input.expectedContributorImmutableGenerationId === undefined
        ? {}
        : {
          expectedContributorImmutableGenerationId:
            input.expectedContributorImmutableGenerationId,
        }),
    },
    timeoutMs: 90_000,
  });
  assert(
    response.status === 200 && isRecord(response.data),
    `packed_channel_provider_action_request_failed:${input.actionId}`,
  );
  return response.data;
}

function requirePackedChannelActionSuccess(
  attempt: PackedChannelActionAttempt,
  actionId: string,
): unknown {
  const result = isRecord(attempt.result) ? attempt.result : null;
  assert(
    attempt.matched === true && result?.ok === true,
    `packed_channel_provider_action_failed:${actionId}:`
      + String(result?.errorCode ?? 'unknown'),
  );
  return result.result;
}

function assertPackedChannelActionFailure(
  attempt: PackedChannelActionAttempt,
  actionId: string,
  expectedCode: string,
): void {
  const result = isRecord(attempt.result) ? attempt.result : null;
  assert(
    attempt.matched === true
      && result?.ok === false
      && result.errorCode === expectedCode,
    `packed_channel_provider_action_failure_mismatch:${actionId}:`
      + String(result?.errorCode ?? 'unknown'),
  );
}

function requirePackedChannelActionRecord(
  value: unknown,
  actionId: string,
): Readonly<Record<string, unknown>> {
  assert(
    isRecord(value),
    `packed_channel_provider_action_result_invalid:${actionId}`,
  );
  return value;
}

function packedChannelProviderSelection(input: Readonly<{
  coreGeneration: string;
  providerGeneration: string;
}>) {
  return {
    target: {
      pluginId: PACKED_CHANNELS_CORE_PLUGIN_ID,
      immutableGenerationId: input.coreGeneration,
    },
    point: {
      pointId: 'providers',
      protocol: { id: 'happier.channels/providers', version: 1 },
    },
    contributor: {
      pluginId: PACKED_CHANNEL_PROVIDER_PLUGIN_ID,
      contributionId: PACKED_CHANNEL_PROVIDER_CONTRIBUTION_ID,
      immutableGenerationId: input.providerGeneration,
    },
  };
}

function packedChannelConnectionCreateInput(input: Readonly<{
  coreGeneration: string;
  providerGeneration: string;
  providerSetupInput: unknown;
}>) {
  return {
    providerSelection: packedChannelProviderSelection({
      coreGeneration: input.coreGeneration,
      providerGeneration: input.providerGeneration,
    }),
    providerSetupInput: input.providerSetupInput,
    credentialRef: null,
    selectedTransport: 'socket',
    maximumObservationAgeMs: 60_000,
  };
}

function readPackedChannelConnectionRows(
  resource: PackedChannelResourceRead,
): readonly Readonly<Record<string, unknown>>[] {
  assert(
    isRecord(resource.value) && Array.isArray(resource.value.connections),
    'packed_channel_provider_connections_resource_invalid',
  );
  return resource.value.connections.flatMap((candidate) =>
    isRecord(candidate) ? [candidate] : []);
}

function requirePackedChannelConnectionRow(input: Readonly<{
  resource: PackedChannelResourceRead;
  connectionId: string;
}>): Readonly<Record<string, unknown>> {
  const row = readPackedChannelConnectionRows(input.resource)
    .find((candidate) => candidate.connectionId === input.connectionId);
  assert(
    row,
    `packed_channel_provider_connection_row_missing:${input.connectionId}`,
  );
  assert(
    typeof row.revision === 'number' && Number.isInteger(row.revision),
    `packed_channel_provider_connection_revision_invalid:${input.connectionId}`,
  );
  return row;
}

async function packPackedChannelProviderArchive(input: Readonly<{
  authoring: PackedChannelProviderAuthoring;
  label: string;
}>): Promise<string> {
  const archivePath = join(
    input.authoring.fixtureRoot,
    `out-of-tree-channel-socket-provider-${input.label}.happier-plugin.tgz`,
  );
  await runPackedCliJson({
    cliEntrypoint: input.authoring.cliEntrypoint,
    cwd: input.authoring.fixtureRoot,
    env: input.authoring.env,
    args: ['plugins', 'pack', input.authoring.pluginRoot, '--out', archivePath, '--json'],
  }, 'plugins_pack');
  return archivePath;
}

async function installPackedChannelProviderArchive(input: Readonly<{
  runtime: InitializedRuntime;
  authoring: PackedChannelProviderAuthoring;
  archivePath: string;
}>) {
  return await runPackedReviewedPluginInstall({
    cliEntrypoint: input.authoring.cliEntrypoint,
    cwd: input.authoring.fixtureRoot,
    env: input.authoring.env,
    args: ['plugins', 'install', input.archivePath, '--json'],
    decideInstallReview: packedChannelProviderReviewDecision(input.runtime),
  });
}

async function runPackedChannelProviderLifecycleProbe(input: Readonly<{
  runtime: InitializedRuntime;
  prepared: PackedManagedProviderPreparedInput;
  loopback: PackedChannelProviderLoopback;
}>): Promise<PackedChannelProviderLifecycleEvidence> {
  let authoring: PackedChannelProviderAuthoring | null = null;
  let sourceBeforeReplacement: string | null = null;
  try {
    authoring = await preparePackedChannelProviderAuthoring({
      runtime: input.runtime,
      prepared: input.prepared,
      loopback: input.loopback,
    });

    const [packageText, stagedSource] = await Promise.all([
      readFile(join(authoring.pluginRoot, 'package.json'), 'utf8'),
      readFile(authoring.sourcePath, 'utf8'),
    ]);
    const packageManifest = JSON.parse(packageText) as unknown;
    assert(
      isRecord(packageManifest) && isRecord(packageManifest.dependencies),
      'packed_channel_provider_public_package_manifest_invalid',
    );
    assert(
      JSON.stringify(Object.keys(packageManifest.dependencies).sort())
        === JSON.stringify([
          '@happier-dev/channels-protocol',
          '@happier-dev/plugin-sdk',
        ]),
      'packed_channel_provider_public_dependency_closure_invalid',
    );
    const sourceImports = [...stagedSource.matchAll(
      /\bfrom\s+['"]([^'"]+)['"]/gu,
    )].map((match) => match[1]);
    assert(
      sourceImports.length > 0
        && sourceImports.every((specifier) => (
          specifier.startsWith('@happier-dev/plugin-sdk')
            || specifier.startsWith('@happier-dev/channels-protocol')
        )),
      'packed_channel_provider_public_source_imports_invalid',
    );

    const initialCatalog = await readPackedChannelCatalog(input.runtime);
    const initialFixture = requirePackedChannelCatalogEntry(
      initialCatalog,
      PACKED_CHANNEL_PROVIDER_PLUGIN_ID,
    );
    const initialCore = requirePackedChannelCatalogEntry(
      initialCatalog,
      PACKED_CHANNELS_CORE_PLUGIN_ID,
    );
    assert(
      initialFixture.appliedGeneration === authoring.immutableGenerationId
        && initialFixture.desiredGeneration === authoring.immutableGenerationId,
      'packed_channel_provider_initial_archive_generation_mismatch',
    );
    assert(
      initialCore.appliedGeneration !== null,
      'packed_channel_provider_core_generation_missing',
    );
    assert(
      catalogHasPackedChannelContribution(
        initialFixture,
        PACKED_CHANNEL_PROVIDER_CONTRIBUTION_ID,
      ),
      'packed_channel_provider_cold_contribution_missing',
    );
    const socketConnectCountBeforeAdoption =
      input.loopback.observerSocketCount();
    assert(
      socketConnectCountBeforeAdoption === 0,
      'packed_channel_provider_socket_started_before_adoption',
    );

    await readPackedChannelResource({
      runtime: input.runtime,
      expectedGeneration: initialFixture.projectionGeneration,
      callerPluginId: PACKED_CHANNEL_PROVIDER_PLUGIN_ID,
      localId: 'status-v1',
    });

    const invalidInputAttempt = await executePackedChannelAction({
      runtime: input.runtime,
      actionId: PACKED_CHANNEL_CONNECTION_CREATE_ACTION_ID,
      actionInput: packedChannelConnectionCreateInput({
        coreGeneration: initialCore.appliedGeneration,
        providerGeneration: authoring.immutableGenerationId,
        providerSetupInput: {},
      }),
    });
    assertPackedChannelActionFailure(
      invalidInputAttempt,
      PACKED_CHANNEL_CONNECTION_CREATE_ACTION_ID,
      'plugin_action_input_schema_invalid',
    );

    const invalidResultAttempt = await executePackedChannelAction({
      runtime: input.runtime,
      actionId: PACKED_CHANNEL_CONNECTION_CREATE_ACTION_ID,
      actionInput: packedChannelConnectionCreateInput({
        coreGeneration: initialCore.appliedGeneration,
        providerGeneration: authoring.immutableGenerationId,
        providerSetupInput: {
          socketUrl: input.loopback.socketUrl,
          pairingCode: PACKED_CHANNEL_PROVIDER_STRICT_RESULT_SENTINEL,
        },
      }),
    });
    assertPackedChannelActionFailure(
      invalidResultAttempt,
      PACKED_CHANNEL_CONNECTION_CREATE_ACTION_ID,
      'plugin_action_result_schema_invalid',
    );

    const catalogAfterContractChecks = await readPackedChannelCatalog(
      input.runtime,
    );
    const fixtureAfterContractChecks = requirePackedChannelCatalogEntry(
      catalogAfterContractChecks,
      PACKED_CHANNEL_PROVIDER_PLUGIN_ID,
    );
    const coreAfterContractChecks = requirePackedChannelCatalogEntry(
      catalogAfterContractChecks,
      PACKED_CHANNELS_CORE_PLUGIN_ID,
    );
    assert(
      coreAfterContractChecks.appliedGeneration !== null,
      'packed_channel_provider_core_generation_missing_after_contract_checks',
    );
    const connectionsBeforeCreate = await readPackedChannelResource({
      runtime: input.runtime,
      expectedGeneration: coreAfterContractChecks.projectionGeneration,
      callerPluginId: PACKED_CHANNELS_CORE_PLUGIN_ID,
      localId: 'connections-v1',
    });
    assert(
      !readPackedChannelConnectionRows(connectionsBeforeCreate).some(
        (connection) =>
          connection.providerPluginId === PACKED_CHANNEL_PROVIDER_PLUGIN_ID,
      ),
      'packed_channel_provider_strict_result_persisted_connection',
    );

    const watchSubscriptionId = await openPackedChannelResourceWatch({
      runtime: input.runtime,
      expectedGeneration: fixtureAfterContractChecks.projectionGeneration,
      callerPluginId: PACKED_CHANNEL_PROVIDER_PLUGIN_ID,
      localId: 'status-v1',
    });
    let resourceWatchClosed = false;
    try {
      const watchNext = nextPackedChannelResourceWatch({
        runtime: input.runtime,
        expectedGeneration: fixtureAfterContractChecks.projectionGeneration,
        callerPluginId: PACKED_CHANNEL_PROVIDER_PLUGIN_ID,
        subscriptionId: watchSubscriptionId,
      });
      const createAttempt = await executePackedChannelAction({
        runtime: input.runtime,
        actionId: PACKED_CHANNEL_CONNECTION_CREATE_ACTION_ID,
        actionInput: packedChannelConnectionCreateInput({
          coreGeneration: coreAfterContractChecks.appliedGeneration,
          providerGeneration: authoring.immutableGenerationId,
          providerSetupInput: {
            socketUrl: input.loopback.socketUrl,
            pairingCode: input.loopback.pairingCode,
          },
        }),
      });
      const createResult = requirePackedChannelActionRecord(
        requirePackedChannelActionSuccess(
          createAttempt,
          PACKED_CHANNEL_CONNECTION_CREATE_ACTION_ID,
        ),
        PACKED_CHANNEL_CONNECTION_CREATE_ACTION_ID,
      );
      assert(
        (createResult.kind === 'created' || createResult.kind === 'rejoined')
          && typeof createResult.connectionId === 'string'
          && createResult.connectionId.length > 0,
        'packed_channel_provider_connection_create_result_invalid',
      );
      const connectionId = createResult.connectionId;

      const invalidation = await watchNext;
      assert(
        invalidation.ok
          && invalidation.status === 'event'
          && isRecord(invalidation.event)
          && !Object.hasOwn(invalidation.event, 'bytes')
          && !Object.hasOwn(invalidation.event, 'bytesBase64'),
        'packed_channel_provider_resource_invalidation_payload_leaked',
      );
      await closePackedChannelResourceWatch({
        runtime: input.runtime,
        callerPluginId: PACKED_CHANNEL_PROVIDER_PLUGIN_ID,
        subscriptionId: watchSubscriptionId,
      });
      resourceWatchClosed = true;

      await input.loopback.waitForObserverSocketCount(
        1,
        'post-adoption',
      );
      await waitFor(async () => {
        const catalog = await readPackedChannelCatalog(input.runtime);
        const fixture = requirePackedChannelCatalogEntry(
          catalog,
          PACKED_CHANNEL_PROVIDER_PLUGIN_ID,
        );
        const status = await readPackedChannelResource({
          runtime: input.runtime,
          expectedGeneration: fixture.projectionGeneration,
          callerPluginId: PACKED_CHANNEL_PROVIDER_PLUGIN_ID,
          localId: 'status-v1',
        });
        return isRecord(status.value)
          && Array.isArray(status.value.activeConnectionIds)
          && status.value.activeConnectionIds.includes(connectionId);
      }, {
        timeoutMs: 30_000,
        intervalMs: 50,
        context: 'packed channel provider status after connection adoption',
      });
      await waitFor(
        () => input.loopback.receivedFrameKinds().includes('subscribe'),
        {
          timeoutMs: 30_000,
          intervalMs: 50,
          context: 'packed channel provider host websocket subscription',
        },
      );

      if (input.runtime.providerSetup === null) {
        await probePublicProviderActivation(input.runtime, input.prepared);
      }
      if (input.runtime.activeSession === null) {
        await probeFreshManagedSpawn(input.runtime, input.prepared);
      }
      const activeSession = input.runtime.activeSession;
      assert(
        activeSession,
        'packed_channel_provider_active_session_missing',
      );

      const coreForBinding = requirePackedChannelCatalogEntry(
        await readPackedChannelCatalog(input.runtime),
        PACKED_CHANNELS_CORE_PLUGIN_ID,
      );
      const connectionForBinding = requirePackedChannelConnectionRow({
        resource: await readPackedChannelResource({
          runtime: input.runtime,
          expectedGeneration: coreForBinding.projectionGeneration,
          callerPluginId: PACKED_CHANNELS_CORE_PLUGIN_ID,
          localId: 'connections-v1',
        }),
        connectionId,
      });
      const bindingAttempt = await executePackedChannelAction({
        runtime: input.runtime,
        actionId: PACKED_CHANNEL_BINDING_CREATE_ACTION_ID,
        actionInput: {
          connectionId,
          expectedConnectionRevision: connectionForBinding.revision,
          endpointSelection: {
            query: 'fixture:room',
            selected: {
              kind: 'direct',
              audience: 'direct',
              id: 'fixture:room',
            },
          },
          principalSelection: {
            query: 'fixture:human',
            selected: [{ id: 'fixture:human', kind: 'human' }],
          },
          target: {
            kind: 'session',
            sessionId: activeSession.sessionId,
            policy: {
              deliveryMode: 'repliesOnly',
              permissionCeiling: 'yolo',
              approvals: { kind: 'off' },
              newSession: { kind: 'off' },
            },
          },
          enabled: true,
        },
      });
      const bindingResult = requirePackedChannelActionRecord(
        requirePackedChannelActionSuccess(
          bindingAttempt,
          PACKED_CHANNEL_BINDING_CREATE_ACTION_ID,
        ),
        PACKED_CHANNEL_BINDING_CREATE_ACTION_ID,
      );
      assert(
        bindingResult.kind === 'created',
        'packed_channel_provider_binding_create_result_invalid',
      );

      input.loopback.sendObservation();
      await waitFor(() => input.runtime.connectProxy.entries().some((entry) =>
        entry.body.includes('fixture loopback observation')),
      {
        timeoutMs: 60_000,
        intervalMs: 50,
        context: 'packed channel provider inbound observation custody',
      });
      const outboundSentinel = `packed-channel-outbound:${randomUUID()}`;
      await postEncryptedUiTextMessage({
        baseUrl: input.runtime.server.baseUrl,
        token: input.runtime.auth.token,
        sessionId: activeSession.sessionId,
        secret: input.runtime.accountSecret,
        text: `Reply with exactly ${outboundSentinel}.`,
        timeoutMs: 20_000,
      });
      await waitFor(() => input.runtime.connectProxy.entries().some((entry) =>
        entry.body.includes(outboundSentinel)), {
        timeoutMs: 60_000,
        intervalMs: 50,
        context: 'packed channel provider outbound source custody',
      });
      await waitFor(
        () => input.loopback.receivedFrameKinds().includes('deliver'),
        {
          timeoutMs: 60_000,
          intervalMs: 50,
          context: 'packed channel provider outbound delivery custody',
        },
      );

      const coreBeforeDisable = requirePackedChannelCatalogEntry(
        await readPackedChannelCatalog(input.runtime),
        PACKED_CHANNELS_CORE_PLUGIN_ID,
      );
      const connectionBeforeDisable = requirePackedChannelConnectionRow({
        resource: await readPackedChannelResource({
          runtime: input.runtime,
          expectedGeneration: coreBeforeDisable.projectionGeneration,
          callerPluginId: PACKED_CHANNELS_CORE_PLUGIN_ID,
          localId: 'connections-v1',
        }),
        connectionId,
      });
      const disableResult = requirePackedChannelActionRecord(
        requirePackedChannelActionSuccess(
          await executePackedChannelAction({
            runtime: input.runtime,
            actionId: PACKED_CHANNEL_CONNECTION_UPDATE_ACTION_ID,
            actionInput: {
              connectionId,
              expectedRevision: connectionBeforeDisable.revision,
              enabled: false,
              maximumObservationAgeMs:
                connectionBeforeDisable.maximumObservationAgeMs,
            },
          }),
          PACKED_CHANNEL_CONNECTION_UPDATE_ACTION_ID,
        ),
        PACKED_CHANNEL_CONNECTION_UPDATE_ACTION_ID,
      );
      assert(
        disableResult.kind === 'updated',
        'packed_channel_provider_disable_result_invalid',
      );
      await input.loopback.waitForObserverSocketCount(0, 'disable');

      const coreBeforeEnable = requirePackedChannelCatalogEntry(
        await readPackedChannelCatalog(input.runtime),
        PACKED_CHANNELS_CORE_PLUGIN_ID,
      );
      const connectionBeforeEnable = requirePackedChannelConnectionRow({
        resource: await readPackedChannelResource({
          runtime: input.runtime,
          expectedGeneration: coreBeforeEnable.projectionGeneration,
          callerPluginId: PACKED_CHANNELS_CORE_PLUGIN_ID,
          localId: 'connections-v1',
        }),
        connectionId,
      });
      const enableResult = requirePackedChannelActionRecord(
        requirePackedChannelActionSuccess(
          await executePackedChannelAction({
            runtime: input.runtime,
            actionId: PACKED_CHANNEL_CONNECTION_UPDATE_ACTION_ID,
            actionInput: {
              connectionId,
              expectedRevision: connectionBeforeEnable.revision,
              enabled: true,
              maximumObservationAgeMs:
                connectionBeforeEnable.maximumObservationAgeMs,
            },
          }),
          PACKED_CHANNEL_CONNECTION_UPDATE_ACTION_ID,
        ),
        PACKED_CHANNEL_CONNECTION_UPDATE_ACTION_ID,
      );
      assert(
        enableResult.kind === 'updated',
        'packed_channel_provider_enable_result_invalid',
      );
      await input.loopback.waitForObserverSocketCount(1, 'reenable');

      const previousDaemon = input.runtime.currentDaemonState;
      const restart = runCandidateCommand({
        runtime: input.runtime,
        prepared: input.prepared,
        args: ['daemon', 'restart', '--takeover', '--json'],
        waitForExit: true,
      });
      const replacementDaemon = await waitForReplacementDaemon(
        input.runtime,
        previousDaemon.pid,
      );
      await restart;
      input.runtime.currentDaemonState = replacementDaemon;
      input.runtime.stockPortObserver.observeOwnedProcess(replacementDaemon.pid);
      await input.loopback.waitForObserverSocketCount(1, 'daemon-restart');

      sourceBeforeReplacement = await readFile(authoring.sourcePath, 'utf8');
      const failingSource = sourceBeforeReplacement.replace(
        'export const activate = plugin.activate;',
        "export const activate = async () => { throw new Error('packed channel replacement activation failure'); };",
      );
      assert(
        failingSource !== sourceBeforeReplacement,
        'packed_channel_provider_failure_fixture_activation_export_missing',
      );
      await writeFile(authoring.sourcePath, failingSource, { mode: 0o600 });
      const failedReplacementArchive = await packPackedChannelProviderArchive({
        authoring,
        label: 'failed-replacement',
      });
      const failedReplacement = await installPackedChannelProviderArchive({
        runtime: input.runtime,
        authoring,
        archivePath: failedReplacementArchive,
      });
      assert(
        isRecord(failedReplacement.change)
          && failedReplacement.change.kind === 'failed',
        'packed_channel_provider_failed_replacement_not_rejected',
      );
      const catalogAfterFailedReplacement = await readPackedChannelCatalog(
        input.runtime,
      );
      const fixtureAfterFailedReplacement = requirePackedChannelCatalogEntry(
        catalogAfterFailedReplacement,
        PACKED_CHANNEL_PROVIDER_PLUGIN_ID,
      );
      assert(
        fixtureAfterFailedReplacement.appliedGeneration
          === authoring.immutableGenerationId,
        'packed_channel_provider_failed_replacement_lkg_not_retained',
      );

      const replacementSource = `${sourceBeforeReplacement}\n// archive-bound replacement ${randomUUID()}\n`;
      await writeFile(authoring.sourcePath, replacementSource, { mode: 0o600 });
      const replacementArchive = await packPackedChannelProviderArchive({
        authoring,
        label: 'replacement',
      });
      const replacement = await installPackedChannelProviderArchive({
        runtime: input.runtime,
        authoring,
        archivePath: replacementArchive,
      });
      assert(
        isRecord(replacement.change)
          && replacement.change.kind === 'committed'
          && typeof replacement.change.appliedGeneration === 'string'
          && replacement.change.appliedGeneration.length > 0
          && replacement.change.appliedGeneration
            !== authoring.immutableGenerationId,
        'packed_channel_provider_replacement_not_committed',
      );
      await input.loopback.waitForObserverSocketCount(0, 'replacement');
      const catalogAfterReplacement = await readPackedChannelCatalog(
        input.runtime,
      );
      const fixtureAfterReplacement = requirePackedChannelCatalogEntry(
        catalogAfterReplacement,
        PACKED_CHANNEL_PROVIDER_PLUGIN_ID,
      );
      assert(
        fixtureAfterReplacement.projectionGeneration
          !== fixtureAfterContractChecks.projectionGeneration,
        'packed_channel_provider_replacement_projection_generation_unchanged',
      );
      const retiredRead = await callProviderRpc(
        input.runtime,
        RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ,
        {
          machineId: input.runtime.machineId,
          expectedGeneration: fixtureAfterContractChecks.projectionGeneration,
          callerPluginId: PACKED_CHANNEL_PROVIDER_PLUGIN_ID,
          resource: {
            pluginId: PACKED_CHANNEL_PROVIDER_PLUGIN_ID,
            localId: 'status-v1',
          },
          context: { kind: 'global' },
        },
        DaemonPluginUiResourceReadResponseSchema,
      );
      assert(
        !retiredRead.ok
          && retiredRead.code === 'plugin_generation_stale'
          && retiredRead.reason === 'stale_generation',
        'packed_channel_provider_retired_resource_read_not_fenced',
      );

      await runPackedCliJson({
        cliEntrypoint: authoring.cliEntrypoint,
        cwd: authoring.fixtureRoot,
        env: authoring.env,
        args: [
          'plugins',
          'uninstall',
          PACKED_CHANNEL_PROVIDER_PLUGIN_ID,
          '--json',
        ],
      }, 'plugins_uninstall');
      await waitFor(async () => !(await readPackedChannelCatalog(input.runtime))
        .some((entry) => entry.pluginId === PACKED_CHANNEL_PROVIDER_PLUGIN_ID), {
        timeoutMs: 30_000,
        intervalMs: 50,
        context: 'packed channel provider replacement uninstall',
      });

      const reinstalled = await installPackedChannelProviderArchive({
        runtime: input.runtime,
        authoring,
        archivePath: authoring.archivePath,
      });
      assert(
        isRecord(reinstalled.change)
          && reinstalled.change.kind === 'committed'
          && reinstalled.change.appliedGeneration
            === authoring.immutableGenerationId,
        'packed_channel_provider_original_archive_not_reinstalled',
      );
      await input.loopback.waitForObserverSocketCount(1, 'original-reinstall');

      // A history gap deliberately excludes this socket connection from the
      // provider's list/read reconciliation projection. Exercise reinstallation
      // before reporting that terminal condition, otherwise the canonical core
      // correctly keeps every provider generation stopped.
      const coreBeforeHistoryGap = requirePackedChannelCatalogEntry(
        await readPackedChannelCatalog(input.runtime),
        PACKED_CHANNELS_CORE_PLUGIN_ID,
      );
      input.loopback.sendHistoryGap();
      await waitFor(async () => {
        const row = requirePackedChannelConnectionRow({
          resource: await readPackedChannelResource({
            runtime: input.runtime,
            expectedGeneration: coreBeforeHistoryGap.projectionGeneration,
            callerPluginId: PACKED_CHANNELS_CORE_PLUGIN_ID,
            localId: 'connections-v1',
          }),
          connectionId,
        });
        const attention = isRecord(row.attention) ? row.attention : null;
        return isRecord(attention?.historyGap)
          && attention.historyGap.reason === 'providerHistoryUnavailable';
      }, {
        timeoutMs: 60_000,
        intervalMs: 50,
        context: 'packed channel provider history-gap report',
      });
      await input.loopback.waitForObserverSocketCount(0, 'history-gap');

      const coreBeforeDelete = requirePackedChannelCatalogEntry(
        await readPackedChannelCatalog(input.runtime),
        PACKED_CHANNELS_CORE_PLUGIN_ID,
      );
      const connectionBeforeDelete = requirePackedChannelConnectionRow({
        resource: await readPackedChannelResource({
          runtime: input.runtime,
          expectedGeneration: coreBeforeDelete.projectionGeneration,
          callerPluginId: PACKED_CHANNELS_CORE_PLUGIN_ID,
          localId: 'connections-v1',
        }),
        connectionId,
      });
      const deleteResult = requirePackedChannelActionRecord(
        requirePackedChannelActionSuccess(
          await executePackedChannelAction({
            runtime: input.runtime,
            actionId: PACKED_CHANNEL_CONNECTION_DELETE_ACTION_ID,
            actionInput: {
              connectionId,
              expectedRevision: connectionBeforeDelete.revision,
            },
          }),
          PACKED_CHANNEL_CONNECTION_DELETE_ACTION_ID,
        ),
        PACKED_CHANNEL_CONNECTION_DELETE_ACTION_ID,
      );
      assert(
        deleteResult.kind === 'deleteFinalizing',
        'packed_channel_provider_delete_stop_not_confirmed',
      );
      await input.loopback.waitForObserverSocketCount(0, 'delete');

      await runPackedCliJson({
        cliEntrypoint: authoring.cliEntrypoint,
        cwd: authoring.fixtureRoot,
        env: authoring.env,
        args: [
          'plugins',
          'uninstall',
          PACKED_CHANNEL_PROVIDER_PLUGIN_ID,
          '--json',
        ],
      }, 'plugins_uninstall');
      await waitFor(async () => !(await readPackedChannelCatalog(input.runtime))
        .some((entry) => entry.pluginId === PACKED_CHANNEL_PROVIDER_PLUGIN_ID), {
        timeoutMs: 30_000,
        intervalMs: 50,
        context: 'packed channel provider final uninstall',
      });

      return {
        archive: {
          hostRuntime: 'daemonArchive',
          reviewedInstall: true,
          publicOnlyArtifact: true,
          publicDependencyClosure: true,
        },
        discovery: {
          corePluginId: PACKED_CHANNELS_CORE_PLUGIN_ID,
          providerPluginId: PACKED_CHANNEL_PROVIDER_PLUGIN_ID,
          actionLocalId: 'fixture/setup',
          targetSurface: 'plugin',
          coldCatalogBeforeProviderActivation: true,
          demandedActivation: true,
          caller: { kind: 'plugin', pluginId: PACKED_CHANNELS_CORE_PLUGIN_ID },
          strictInputRejectedBeforeHandler: true,
          strictResultRejectedBeforeCore: true,
        },
        resource: {
          localId: 'status-v1',
          readObserved: true,
          watchSubscribed: true,
          invalidationDropped: true,
          rereadConverged: true,
        },
        background: {
          startedAfterAdoption: true,
          normalizedNetworkClientObserved: true,
          socketConnectCountBeforeAdoption,
          observationIngressCustodied: true,
          outboundDeliveryCustodied: true,
          historyGapReported: true,
          confirmedStopReported: true,
        },
        lifecycle: {
          disableAbortedGeneration: true,
          reenableSocketCount: 1,
          daemonRestartSocketCount: 1,
          failedReplacementRetainedLkg: true,
          retiredGenerationReportInert: true,
          uninstalledCleanly: true,
        },
      };
    } finally {
      if (!resourceWatchClosed) {
        await closePackedChannelResourceWatch({
          runtime: input.runtime,
          callerPluginId: PACKED_CHANNEL_PROVIDER_PLUGIN_ID,
          subscriptionId: watchSubscriptionId,
        }).catch(() => undefined);
      }
    }
  } finally {
    if (authoring && sourceBeforeReplacement !== null) {
      await writeFile(authoring.sourcePath, sourceBeforeReplacement, {
        mode: 0o600,
      }).catch(() => undefined);
    }
    await authoring?.registry.close().catch(() => undefined);
  }
}

export async function startPackedManagedProviderComposedRuntime(): Promise<
  Readonly<{
    probePublicProviderActivation(
      input: PackedManagedProviderPreparedInput,
    ): Promise<import('./packedManagedProviderLiveScenario')
      .PackedManagedProviderWrapperObservation>;
    probeFreshManagedSpawn(
      input: PackedManagedProviderPreparedInput,
    ): Promise<PackedManagedProviderFreshSpawnObservation>;
    probeActivationFailureCleanup(
      input: PackedManagedProviderPreparedInput,
    ): Promise<PackedManagedProviderActivationFailureObservation>;
    probeManagedDaemonContinuity(
      input: PackedManagedProviderPreparedInput,
    ): Promise<PackedManagedProviderContinuityObservation>;
    probeCandidateExternalAgentProviderHandoff(
      input: PackedManagedProviderPreparedInput,
    ): Promise<PackedManagedProviderCandidateHandoffObservation>;
    probeManagedRecoveryRefusal(
      input: PackedManagedProviderPreparedInput,
    ): Promise<PackedManagedProviderRecoveryRefusalObservation>;
    probePackedChannelProviderLifecycle(
      input: PackedManagedProviderPreparedInput,
    ): Promise<PackedChannelProviderLifecycleEvidence>;
    cleanup(): Promise<void>;
  }>
> {
  let runtime: InitializedRuntime | null = null;
  const ensureRuntime = async (
    input: PackedManagedProviderPreparedInput,
    options: RuntimeInitializationOptions = {},
  ): Promise<InitializedRuntime> => {
    if (runtime !== null) {
      assert(
        (options.additionalTrustedCertificatePaths?.length ?? 0) === 0,
        'packed_channel_provider_loopback_requires_fresh_runtime',
      );
      return runtime;
    }
    runtime = await initializeRuntime(input, options);
    return runtime;
  };
  return {
    probePublicProviderActivation: async (input) =>
      await probePublicProviderActivation(await ensureRuntime(input), input),
    probeFreshManagedSpawn: async (input) =>
      await probeFreshManagedSpawn(await ensureRuntime(input), input),
    probeActivationFailureCleanup: async (input) =>
      await probeActivationFailureCleanup(await ensureRuntime(input), input),
    probeManagedDaemonContinuity: async (input) =>
      await probePackedManagedProviderDaemonContinuity(
        await ensureRuntime(input),
        input,
      ),
    probeCandidateExternalAgentProviderHandoff: async (input) =>
      await probePackedCandidateAgentProviderHandoff(
        await ensureRuntime(input),
        input,
      ),
    probeManagedRecoveryRefusal: async (input) =>
      await probePackedManagedProviderRecoveryRefusal(
        await ensureRuntime(input),
        input,
      ),
    probePackedChannelProviderLifecycle: async (input) => {
      const loopback = await startPackedChannelProviderLoopback();
      try {
        return await runPackedChannelProviderLifecycleProbe({
          runtime: await ensureRuntime(input, {
            additionalTrustedCertificatePaths: [loopback.caCertificatePath],
          }),
          prepared: input,
          loopback,
        });
      } finally {
        await loopback.stop();
      }
    },
    cleanup: async () => {
      if (!runtime) return;
      const activeRuntime = runtime;
      const activeSession = activeRuntime.activeSession;
      const cleanupTasks: PackedManagedProviderCleanupTask[] = [
        ...activeRuntime.candidateHandoffSessions.splice(0).map((session) => ({
          run: async () => await stopPublicSession({
            runtime: activeRuntime,
            session,
          }),
        })),
        ...(activeSession
          ? [{
            run: async () => {
              try {
                await stopPublicSession({
                  runtime: activeRuntime,
                  session: activeSession,
                });
              } finally {
                activeRuntime.activeSession = null;
              }
            },
          }]
          : []),
        {
          run: async () => await cleanupPackedManagedProviderRuntimeResources({
            ui: activeRuntime.ui,
            daemon: activeRuntime.daemon,
            serverProxy: activeRuntime.serverProxy,
            connectProxy: activeRuntime.connectProxy,
            server: activeRuntime.server,
            stockPortObserver: activeRuntime.stockPortObserver,
          }),
        },
      ];
      try {
        await cleanupPackedManagedProviderTasks(cleanupTasks);
      } finally {
        runtime = null;
      }
    },
  };
}
