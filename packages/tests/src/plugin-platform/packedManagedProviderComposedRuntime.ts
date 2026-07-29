import { once } from 'node:events';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
} from 'node:http';
import {
  TLSSocket,
} from 'node:tls';
import { spawn, spawnSync } from 'node:child_process';
import {
  access,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import {
  readProcessIdentityByPid,
} from '../../../../apps/cli/src/daemon/processIdentity';
import {
  buildConnectedServiceCredentialRecord,
  createProviderConnectionSecurityFingerprintV1,
  createProviderEndpointSetFingerprintV1,
  DEFAULT_PROVIDER_SETTINGS_V1,
  PROVIDER_CONNECTION_SECURITY_CONTRACT_VERSION_V1,
  ProviderConnectionIdSchema,
  ProviderSettingsV1Schema,
  resolveProviderBindingCompatibilityWithFingerprintV1,
  sealAccountScopedBlobCiphertext,
  type AgentProviderRequirementsV1,
  type ProviderManagedDeploymentSecurityFactsV1,
  type ProviderModelDescriptorV1,
  type ProviderSettingsV1,
} from '@happier-dev/protocol';
import {
  readConnectedAccountRequestAuthCapabilityFile,
  type ConnectedAccountRequestAuthCapabilityDocumentV2,
} from '@happier-dev/plugin-sdk/experimental/cloud/request-auth';

import { MANAGED_PROVIDER_IMPLEMENTATION } from '../../../plugins/cliproxyapi/src/managed';
import {
  CLIPROXYAPI_PROVIDER_CONTRIBUTION,
} from '../../../plugins/cliproxyapi/src/provider/contribution';
import type {
  PackedManagedProviderPreparedInput,
} from '../../scripts/plugin-platform/run-packed-managed-provider.mjs';
import {
  readEncryptedAccountSettingsV2OrEmpty,
  upsertEncryptedAccountSettingsV2,
} from '../testkit/accountSettings';
import { createTestAuth, type TestAuth } from '../testkit/auth';
import { seedCliAuthForServer } from '../testkit/cliAuth';
import {
  decryptLegacyBase64,
  encryptLegacyBase64,
} from '../testkit/messageCrypto';
import {
  enqueuePendingQueueV2,
  listPendingQueueV2,
} from '../testkit/pendingQueueV2';
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
import { waitFor } from '../testkit/timing';
import { postEncryptedUiTextMessage } from '../testkit/uiMessages';
import {
  fetchAllMessages,
  fetchSessionV2,
} from '../testkit/sessions';
import {
  sanitizePackedAuthorArtifactEnv,
} from '../../scripts/plugin-platform/run-packed-author-ui-compat.mjs';
import {
  redactHarnessLogText,
} from '../testkit/process/harnessLogRedaction';
import {
  createEphemeralTlsServerFixture,
} from '../testkit/tls/ephemeralTlsServerFixture.mjs';
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
const MANAGED_CODEX_BASE_PATH = '/backend-api/codex';
type SessionMarker = Readonly<{
  path: string;
  pid: number;
  processStartTimeMs: number;
  processCommandHash: string;
  happySessionId: string;
  managedLocalServiceRunAttachment: Readonly<{
    process: Readonly<{
      pid: number;
      processStartTimeMs: number;
      processCommandHash: string;
    }>;
    endpoint: Readonly<{ host: '127.0.0.1' | '::1'; port: number }>;
    materialization: Readonly<{
      rootDir: string;
      materializationId: string;
    }>;
  }>;
}>;

type ManagedConfig = Readonly<{
  materializationId: string;
  gateway: Readonly<{
    downstreamBearer: string;
    authEntries: readonly Readonly<{
      purpose: typeof OPENAI_PURPOSE;
    }>[];
  }>;
  requestAuth: Readonly<{
    capabilityPath: string;
  }>;
}>;

type SeededCredential = Readonly<{
  credentialRevision: string;
  accessTokenFingerprint: string;
}>;

type RecordedBrokerLookup = Readonly<{
  startedAtMs: number;
  endedAtMs: number;
  status: number;
  purpose: Readonly<{
    consumer: Readonly<{ pluginId: string; localId: string }>;
    purpose: string;
  }> | null;
  credentialRevision: string | null;
  accessTokenFingerprint: string | null;
  capabilityFingerprint: string | null;
}>;

type RecordedDaemonSessionStarted = Readonly<{
  sessionId: string | null;
  startedAtMs: number;
  acknowledgedAtMs: number;
  status: number;
}>;

export type PackedManagedProviderDaemonControlRecordingProxy = Readonly<{
  port: number;
  entries(): readonly RecordedBrokerLookup[];
  sessionStartedEntries(): readonly RecordedDaemonSessionStarted[];
  retarget(targetPort: number): void;
  holdNextLookup(
    purpose: NonNullable<RecordedBrokerLookup['purpose']>,
  ): Readonly<{
    started: Promise<void>;
    completed: Promise<void>;
    release(): void;
  }>;
  clear(): void;
  stop(): Promise<void>;
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

type InitializedRuntime = Readonly<{
  inputRoot: string;
  testDir: string;
  happyHomeDir: string;
  workspaceDir: string;
  openCodeStateDir: string;
  server: StartedServer;
  serverProxy: HttpRequestRecordingProxy;
  connectProxy: TlsRecordingProxy;
  auth: TestAuth;
  accountSecret: Uint8Array;
  machineId: string;
  daemon: StartedDaemon;
  daemonEnv: NodeJS.ProcessEnv;
  credential: SeededCredential;
  brokerProxy: PackedManagedProviderDaemonControlRecordingProxy;
  managedRequestAuthOrigin: string;
  managedConnectionSecurityFingerprint: string;
  stockListenerBefore: StockListenerSnapshot;
  stockPortObserver: PackedManagedProviderStockPortObserver;
  setSessionCreationDelay: (delayMs: number) => void;
}>;

type StoppableRuntimeResource = Readonly<{
  stop(): Promise<unknown>;
}>;

export type PackedManagedProviderRuntimeResources = Readonly<{
  daemon?: StoppableRuntimeResource | null;
  brokerProxy?: StoppableRuntimeResource | null;
  serverProxy?: StoppableRuntimeResource | null;
  connectProxy?: StoppableRuntimeResource | null;
  server?: StoppableRuntimeResource | null;
  stockPortObserver?: StoppableRuntimeResource | null;
}>;

export async function cleanupPackedManagedProviderRuntimeResources(
  resources: PackedManagedProviderRuntimeResources,
): Promise<void> {
  const errors: unknown[] = [];
  for (const resource of [
    resources.daemon,
    resources.brokerProxy,
    resources.serverProxy,
    resources.connectProxy,
    resources.server,
    resources.stockPortObserver,
  ]) {
    if (!resource) continue;
    try {
      await resource.stop();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      'packed managed composed runtime cleanup failed',
    );
  }
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

type RecordedTlsUpstreamRequest = Readonly<{
  connectTarget: string;
  method: string;
  path: string;
  observedAtMs: number;
  body: string;
  authorizationFingerprint: string | null;
  accountHeader: string | null;
}>;

type TlsRecordingProxy = Readonly<{
  url: string;
  caCertPath: string;
  entries: () => readonly RecordedTlsUpstreamRequest[];
  connectTargets: () => readonly string[];
  holdNextRequestBodyContaining(
    value: string,
  ): Readonly<{
    release(): void;
    completed: Promise<void>;
  }>;
  clear: () => void;
  stop: () => Promise<void>;
}>;

type StockListenerSnapshot = Readonly<{
  port: 8317;
  identity: string;
}>;

function assert(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function listFilesRecursively(root: string): Promise<readonly string[]> {
  const result: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else result.push(path);
    }
  };
  await visit(root);
  return result.sort();
}

function scalarHeader(
  value: string | readonly string[] | undefined,
): string | null {
  if (typeof value === 'string') return value;
  return value?.[0] ?? null;
}

function authorizationFingerprint(
  value: string | readonly string[] | undefined,
): string | null {
  const header = scalarHeader(value);
  if (!header) return null;
  const bearer = /^Bearer\s+(.+)$/iu.exec(header);
  return fingerprintSecret(bearer?.[1] ?? header);
}

export async function startPackedManagedProviderTlsRecordingProxy():
Promise<TlsRecordingProxy> {
  const tlsFixture = await createEphemeralTlsServerFixture({
    additionalDnsNames: ['chatgpt.com'],
  });
  const requests: RecordedTlsUpstreamRequest[] = [];
  const connectTargets: string[] = [];
  const holds: Array<{
    bodyValue: string;
    matched: boolean;
    release(): void;
    released: Promise<void>;
    complete(): void;
    completed: Promise<void>;
  }> = [];
  const sockets = new Set<import('node:stream').Duplex>();
  const targetsBySocket = new WeakMap<object, string>();
  const decryptedServer = createServer(async (request, response) => {
    const body = await readRequestBody(request)
      .catch(() => Buffer.alloc(0));
    const entry: RecordedTlsUpstreamRequest = {
      connectTarget: targetsBySocket.get(request.socket) ?? '',
      method: request.method ?? '',
      path: request.url ?? '',
      observedAtMs: Date.now(),
      body: body.toString('utf8'),
      authorizationFingerprint:
        authorizationFingerprint(request.headers.authorization),
      accountHeader:
        scalarHeader(request.headers['chatgpt-account-id'])
        ?? scalarHeader(request.headers['x-openai-account-id'])
        ?? scalarHeader(request.headers['openai-account-id']),
    };
    requests.push(entry);
    const hold = holds.find(
      (candidate) =>
        !candidate.matched && entry.body.includes(candidate.bodyValue),
    );
    if (hold) {
      hold.matched = true;
      await hold.released;
    }
    response.statusCode = hold ? 400 : 502;
    response.setHeader('content-type', 'application/json');
    const finished = once(response, 'finish').catch(() => {});
    response.end(JSON.stringify({
      error: {
        type: hold
          ? 'packed_managed_provider_held_attempt_completed'
          : 'packed_managed_provider_upstream_observed',
        message: 'The isolated test observer does not forward upstream.',
      },
    }));
    await finished;
    hold?.complete();
  });
  const server = createServer((_request, response) => {
    response.statusCode = 400;
    response.end('CONNECT required');
  });
  let stopPromise: Promise<void> | null = null;
  const stopProxy = (): Promise<void> => {
    stopPromise ??= (async () => {
      for (const hold of holds) hold.release();
      const closed = server.listening
        ? new Promise<void>((resolveClosed) => {
          server.close(() => resolveClosed());
        })
        : Promise.resolve();
      for (const socket of sockets) socket.destroy();
      try {
        await closed;
      } finally {
        await tlsFixture.cleanup();
      }
    })().catch((error) => {
      stopPromise = null;
      throw error;
    });
    return stopPromise;
  };
  server.on('connect', (request, socket, head) => {
    const connectTarget = request.url ?? '';
    connectTargets.push(connectTarget);
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length > 0) socket.unshift(head);
    const tlsSocket = new TLSSocket(socket, {
      isServer: true,
      secureContext: tlsFixture.secureContext,
      ALPNProtocols: ['http/1.1'],
    });
    sockets.add(tlsSocket);
    targetsBySocket.set(tlsSocket, connectTarget);
    tlsSocket.once('close', () => sockets.delete(tlsSocket));
    tlsSocket.once('secure', () => {
      decryptedServer.emit('connection', tlsSocket);
    });
    tlsSocket.once('error', () => {
      tlsSocket.destroy();
    });
  });
  let address;
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    address = server.address();
    assert(
      address && typeof address === 'object',
      'packed_managed_provider_connect_proxy_address_missing',
    );
  } catch (error) {
    await stopProxy();
    throw error;
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    entries: () => requests.map((entry) => ({ ...entry })),
    connectTargets: () => [...connectTargets],
    caCertPath: tlsFixture.caCertificatePath,
    holdNextRequestBodyContaining: (bodyValue) => {
      assert(
        bodyValue.length > 0,
        'packed_managed_provider_upstream_hold_value_missing',
      );
      let release!: () => void;
      const released = new Promise<void>((resolveRelease) => {
        release = resolveRelease;
      });
      let complete!: () => void;
      const completed = new Promise<void>((resolveCompleted) => {
        complete = resolveCompleted;
      });
      const hold = {
        bodyValue,
        matched: false,
        release,
        released,
        complete,
        completed,
      };
      holds.push(hold);
      return {
        release,
        completed,
      };
    },
    clear: () => {
      requests.length = 0;
      connectTargets.length = 0;
    },
    stop: stopProxy,
  };
}

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

async function readRequestBody(
  request: import('node:http').IncomingMessage,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    assert(
      length <= 512 * 1024,
      'packed_managed_provider_broker_request_too_large',
    );
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function forwardedHeaders(
  headers: IncomingHttpHeaders,
  bodyLength: number,
): IncomingHttpHeaders {
  const result = { ...headers };
  delete result.host;
  delete result.connection;
  delete result['content-length'];
  return {
    ...result,
    'content-length': String(bodyLength),
    host: '127.0.0.1',
  };
}

function parseLookupPurpose(body: Buffer): RecordedBrokerLookup['purpose'] {
  try {
    const raw = JSON.parse(body.toString('utf8')) as {
      purpose?: {
        consumer?: { pluginId?: unknown; localId?: unknown };
        purpose?: unknown;
      };
    };
    const purpose = raw.purpose;
    if (
      typeof purpose?.consumer?.pluginId !== 'string'
      || typeof purpose.consumer.localId !== 'string'
      || typeof purpose.purpose !== 'string'
    ) {
      return null;
    }
    return {
      consumer: {
        pluginId: purpose.consumer.pluginId,
        localId: purpose.consumer.localId,
      },
      purpose: purpose.purpose,
    };
  } catch {
    return null;
  }
}

function parseSessionStartedSessionId(body: Buffer): string | null {
  try {
    const raw = JSON.parse(body.toString('utf8')) as {
      sessionId?: unknown;
    };
    return typeof raw.sessionId === 'string' && raw.sessionId.trim().length > 0
      ? raw.sessionId
      : null;
  } catch {
    return null;
  }
}

function sameRequestAuthPurpose(
  left: NonNullable<RecordedBrokerLookup['purpose']>,
  right: NonNullable<RecordedBrokerLookup['purpose']>,
): boolean {
  return left.consumer.pluginId === right.consumer.pluginId
    && left.consumer.localId === right.consumer.localId
    && left.purpose === right.purpose;
}

export async function startPackedManagedProviderDaemonControlRecordingProxy(
  targetPort: number,
): Promise<PackedManagedProviderDaemonControlRecordingProxy> {
  let currentTargetPort = targetPort;
  const entries: RecordedBrokerLookup[] = [];
  const sessionStartedEntries: RecordedDaemonSessionStarted[] = [];
  const sockets = new Set<import('node:net').Socket>();
  const lookupHolds: Array<{
    purpose: NonNullable<RecordedBrokerLookup['purpose']>;
    claimed: boolean;
    started: Promise<void>;
    completed: Promise<void>;
    markStarted(): void;
    markCompleted(): void;
    release(): void;
    released: Promise<void>;
  }> = [];
  const server = createServer(async (request, response) => {
    const startedAtMs = Date.now();
    const requestBody = await readRequestBody(request).catch(() => Buffer.alloc(0));
    const isLookup =
      request.method === 'POST'
      && request.url === '/connected-accounts/request-auth/lookup';
    const isSessionStarted =
      request.method === 'POST'
      && request.url === '/session-started';
    const purpose = isLookup ? parseLookupPurpose(requestBody) : null;
    const sessionId = isSessionStarted
      ? parseSessionStartedSessionId(requestBody)
      : null;
    const rawCapability =
      request.headers['x-happier-connected-account-capability'];
    const capability =
      typeof rawCapability === 'string'
        ? rawCapability
        : Array.isArray(rawCapability)
          ? rawCapability[0] ?? null
          : null;
    const hold = purpose
      ? lookupHolds.find((candidate) =>
        !candidate.claimed
        && sameRequestAuthPurpose(candidate.purpose, purpose))
        ?? null
      : null;
    if (hold) {
      hold.claimed = true;
      hold.markStarted();
      await hold.released;
    }
    const upstream = httpRequest({
      host: '127.0.0.1',
      port: currentTargetPort,
      method: request.method,
      path: request.url,
      headers: forwardedHeaders(request.headers, requestBody.length),
    }, (upstreamResponse) => {
      const responseChunks: Buffer[] = [];
      upstreamResponse.on('data', (chunk: Buffer | string) => {
        responseChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      upstreamResponse.once('end', () => {
        const responseBody = Buffer.concat(responseChunks);
        response.writeHead(
          upstreamResponse.statusCode ?? 502,
          upstreamResponse.headers,
        );
        response.end(responseBody);
        if (isLookup) {
          let credentialRevision: string | null = null;
          let accessTokenFingerprint: string | null = null;
          try {
            const raw = JSON.parse(responseBody.toString('utf8')) as {
              value?: {
                accessToken?: unknown;
                credentialContext?: { credentialRevision?: unknown };
              };
            };
            if (typeof raw.value?.accessToken === 'string') {
              accessTokenFingerprint = fingerprintSecret(raw.value.accessToken);
            }
            if (
              typeof raw.value?.credentialContext?.credentialRevision
                === 'string'
            ) {
              credentialRevision =
                raw.value.credentialContext.credentialRevision;
            }
          } catch {
            // Non-success request-auth envelopes contain no credential evidence.
          }
          entries.push({
            startedAtMs,
            endedAtMs: Date.now(),
            status: upstreamResponse.statusCode ?? 502,
            purpose,
            credentialRevision,
            accessTokenFingerprint,
            capabilityFingerprint:
              capability ? fingerprintSecret(capability) : null,
          });
        }
        if (isSessionStarted) {
          sessionStartedEntries.push({
            sessionId,
            startedAtMs,
            acknowledgedAtMs: Date.now(),
            status: upstreamResponse.statusCode ?? 502,
          });
        }
        hold?.markCompleted();
      });
    });
    upstream.once('error', () => {
      response.statusCode = 502;
      response.end('request-auth recording proxy upstream failed');
      hold?.markCompleted();
    });
    upstream.end(requestBody);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(
    address && typeof address === 'object' && address.port !== 8317,
    'packed_managed_provider_broker_proxy_port_invalid',
  );
  return {
    port: address.port,
    entries: () => entries.map((entry) => ({
      ...entry,
      purpose: entry.purpose
        ? { ...entry.purpose, consumer: { ...entry.purpose.consumer } }
        : null,
    })),
    sessionStartedEntries: () =>
      sessionStartedEntries.map((entry) => ({ ...entry })),
    retarget: (nextTargetPort) => {
      assert(
        Number.isInteger(nextTargetPort)
          && nextTargetPort > 0
          && nextTargetPort <= 65_535
          && nextTargetPort !== address.port,
        'packed_managed_provider_broker_proxy_target_invalid',
      );
      currentTargetPort = nextTargetPort;
    },
    holdNextLookup: (purpose) => {
      let resolveStarted!: () => void;
      let resolveCompleted!: () => void;
      let resolveReleased!: () => void;
      let didStart = false;
      let didComplete = false;
      let didRelease = false;
      const started = new Promise<void>((resolvePromise) => {
        resolveStarted = resolvePromise;
      });
      const completed = new Promise<void>((resolvePromise) => {
        resolveCompleted = resolvePromise;
      });
      const released = new Promise<void>((resolvePromise) => {
        resolveReleased = resolvePromise;
      });
      const hold = {
        purpose,
        claimed: false,
        started,
        completed,
        markStarted: () => {
          if (didStart) return;
          didStart = true;
          resolveStarted();
        },
        markCompleted: () => {
          if (didComplete) return;
          didComplete = true;
          resolveCompleted();
        },
        release: () => {
          if (didRelease) return;
          didRelease = true;
          resolveReleased();
        },
        released,
      };
      lookupHolds.push(hold);
      return {
        started,
        completed,
        release: hold.release,
      };
    },
    clear: () => {
      entries.length = 0;
      sessionStartedEntries.length = 0;
    },
    stop: async () => {
      for (const hold of lookupHolds) hold.release();
      const closed = once(server, 'close').catch(() => {});
      server.close();
      for (const socket of sockets) socket.destroy();
      await closed;
    },
  };
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

function managedDeploymentSecurityFacts():
ProviderManagedDeploymentSecurityFactsV1 {
  return {
    implementationIdentity: {
      pluginId: 'happier.provider.cliproxyapi',
      localId: 'cliproxyapi',
    },
    managedEndpoint: {
      localService: {
        ...MANAGED_PROVIDER_IMPLEMENTATION.facet.managedEndpoint.localService,
        launch: {
          ...MANAGED_PROVIDER_IMPLEMENTATION.facet.managedEndpoint.localService
            .launch,
          directorySegments: [
            ...MANAGED_PROVIDER_IMPLEMENTATION.facet.managedEndpoint
              .localService.launch.directorySegments,
          ],
        },
        launchMode: {
          ...MANAGED_PROVIDER_IMPLEMENTATION.facet.managedEndpoint.localService
            .launchMode,
          environment: {
            inject: [
              ...(
                MANAGED_PROVIDER_IMPLEMENTATION.facet.managedEndpoint
                  .localService.launchMode.environment?.inject
                ?? []
              ),
            ],
          },
        },
      },
      protocols: [
        ...MANAGED_PROVIDER_IMPLEMENTATION.facet.managedEndpoint.protocols,
      ],
    },
    connectedAccounts:
      MANAGED_PROVIDER_IMPLEMENTATION.facet.connectedAccounts.map(
        (declaration) => ({
          ...declaration,
          service: { ...declaration.service },
          materializationKinds: [...declaration.materializationKinds],
        }),
      ),
    requestAuthUses:
      MANAGED_PROVIDER_IMPLEMENTATION.facet.requestAuthUses.map((use) => ({
        ...use,
        materialization: {
          ...use.materialization,
          headerNames: [...use.materialization.headerNames],
        },
      })),
  };
}

const OPENCODE_PROVIDER_REQUIREMENTS: AgentProviderRequirementsV1 = {
  acceptsProtocols: ['openai-responses', 'openai-chat'],
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
    }, {
      protocol: 'openai-chat',
      destination: {
        kind: 'httpHeader',
        names: 'anyValidated',
        formats: ['raw', 'bearer'],
      },
    }],
  },
  authIsolation: {
    suppressConnectedServiceIds: [
      'openai-codex',
      'openai',
      'claude-subscription',
      'anthropic',
    ],
    ownedEnvKeys: [
      'HAPPIER_OPENCODE_PROVIDER_API_KEY',
      'OPENCODE_AUTH_CONTENT',
      'OPENCODE_CONFIG_CONTENT',
      'OPENAI_API_KEY',
      'ANTHROPIC_API_KEY',
    ],
  },
  materialization: 'configFile',
  applyPolicy: 'restart_session',
  supportsFreeformModelIds: true,
};

const MODEL: ProviderModelDescriptorV1 = {
  id: MODEL_ID,
  name: 'Packed managed live model',
  capabilities: {
    toolRoundTrips: 'supported',
    reasoningControls: 'supported',
  },
};

function buildProviderSettings(
  machineId: string,
  connectionSecurityFingerprint: string,
): ProviderSettingsV1 {
  const now = Date.now();
  const base = ProviderSettingsV1Schema.parse({
    ...DEFAULT_PROVIDER_SETTINGS_V1,
    connections: [{
      v: 1,
      id: CONNECTION_ID,
      source: {
        kind: 'contribution',
        contributionKey: CONTRIBUTION_KEY,
      },
      deployment: { kind: 'managedLocal' },
      role: 'default',
      displayName: 'CLIProxyAPI',
      displayNameMode: 'automatic',
      purposeBindingDefaults: {
        'openai-upstream': {
          kind: 'account',
          account: {
            service: {
              pluginId: 'happier.agent.codex',
              localId: 'openai-codex',
            },
            accountId: 'work',
          },
        },
      },
      revision: 1,
      createdAt: now,
      updatedAt: now,
    }],
    manualModelsByConnectionId: {
      [CONNECTION_ID]: [{
        id: MODEL.id,
        name: MODEL.name,
        addedAt: now,
      }],
    },
  });
  const endpointSetFingerprint = createProviderEndpointSetFingerprintV1({
    endpoints: [],
  });
  const compatibility = resolveProviderBindingCompatibilityWithFingerprintV1({
    agentTargetKey: AGENT_TARGET_KEY,
    adapterVersion: 1,
    endpoints: CLIPROXYAPI_PROVIDER_CONTRIBUTION.endpointTemplates,
    credential: CLIPROXYAPI_PROVIDER_CONTRIBUTION.credential,
    agent: OPENCODE_PROVIDER_REQUIREMENTS,
    model: MODEL,
  });
  assert(
    compatibility.result.status !== 'incompatible',
    'packed_managed_provider_opencode_binding_unsupported',
  );
  return ProviderSettingsV1Schema.parse({
    ...base,
    machineGrants: [{
      v: 1,
      machineId,
      connectionId: CONNECTION_ID,
      endpointSetFingerprint,
      connectionSecurityFingerprint,
      confirmedAt: now,
    }],
    experimentalBindingConfirmations:
      compatibility.result.status === 'experimental'
        ? [{
            v: 1,
            connectionId: CONNECTION_ID,
            agentTargetKey: AGENT_TARGET_KEY,
            modelId:
              compatibility.result.confirmationScope.kind === 'model'
                ? MODEL.id
                : null,
            compatibilityFingerprint:
              compatibility.compatibilityFingerprint,
            confirmedAt: now,
          }]
        : [],
  });
}

async function seedCredential(params: Readonly<{
  serverBaseUrl: string;
  authToken: string;
  accountSecret: Uint8Array;
}>): Promise<SeededCredential> {
  const accessToken =
    `packed-live-${randomBytes(24).toString('base64url')}`;
  const record = buildConnectedServiceCredentialRecord({
    now: Date.now(),
    serviceId: 'openai-codex',
    profileId: 'work',
    kind: 'oauth',
    expiresAt: Date.now() + 60 * 60 * 1000,
    oauth: {
      accessToken,
      refreshToken: `packed-refresh-${randomBytes(24).toString('base64url')}`,
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
  }>(
    `${params.serverBaseUrl}/v2/connect/openai-codex/profiles/work/credential`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${params.authToken}`,
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
    },
  );
  assert(
    response.status === 200
      && response.data?.success === true
      && typeof response.data.credentialRevision === 'string',
    'packed_managed_provider_credential_seed_failed',
  );
  return {
    credentialRevision: response.data.credentialRevision,
    accessTokenFingerprint: fingerprintSecret(accessToken),
  };
}

async function initializeRuntime(
  input: PackedManagedProviderPreparedInput,
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
      && configuredServerPort !== 8317,
    'packed_managed_provider_isolated_server_port_invalid',
  );
  const featureEnv: NodeJS.ProcessEnv = {
    HAPPIER_FEATURE_PROVIDERS__ENABLED: '1',
    HAPPIER_FEATURE_LOCAL_SERVICES_MANAGED__ENABLED: '1',
  };
  let server: StartedServer | null = null;
  let serverProxy: HttpRequestRecordingProxy | null = null;
  let connectProxy: TlsRecordingProxy | null = null;
  let stockPortObserver: PackedManagedProviderStockPortObserver | null = null;
  let daemon: StartedDaemon | null = null;
  let brokerProxy: PackedManagedProviderDaemonControlRecordingProxy | null = null;
  let daemonStartupAttempted = false;
  try {
    server = await startServerLight({
    testDir,
    dbProvider: 'sqlite',
    extraEnv: featureEnv,
    __portAllocator: async () => configuredServerPort,
  });
  let sessionCreationDelayMs = 0;
  serverProxy = await startHttpRequestRecordingProxy({
    targetBaseUrl: server.baseUrl,
    delayRequestMs: (request) =>
      isSessionCreationRequest(request) ? sessionCreationDelayMs : 0,
  });
  connectProxy = await startPackedManagedProviderTlsRecordingProxy();
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
  const currentSettings = await readEncryptedAccountSettingsV2OrEmpty({
    baseUrl: server.baseUrl,
    token: auth.token,
    secret: accountSecret,
  });
  const managedSecurityFacts = managedDeploymentSecurityFacts();
  const managedConnectionSecurityFingerprint =
    createProviderConnectionSecurityFingerprintV1({
      securityContractVersion:
        PROVIDER_CONNECTION_SECURITY_CONTRACT_VERSION_V1,
      endpoints: [],
      catalogProbes: CLIPROXYAPI_PROVIDER_CONTRIBUTION.catalog.probes,
      availabilityProbe:
        CLIPROXYAPI_PROVIDER_CONTRIBUTION.discovery.availabilityProbe,
      credentialTransports:
        CLIPROXYAPI_PROVIDER_CONTRIBUTION.credential.transports,
      managedDeployment: managedSecurityFacts,
    });
  const managedRequestAuthUse =
    managedSecurityFacts.requestAuthUses.find(
      (use) => use.purpose === OPENAI_PURPOSE.purpose,
    );
  assert(
    managedRequestAuthUse !== undefined,
    'packed_managed_provider_openai_request_auth_use_missing',
  );
  await upsertEncryptedAccountSettingsV2({
    baseUrl: server.baseUrl,
    token: auth.token,
    secret: accountSecret,
    expectedVersion: currentSettings.settingsVersion,
    settings: {
      ...currentSettings.settings,
      providerSettingsV1: buildProviderSettings(
        seeded.machineId,
        managedConnectionSecurityFingerprint,
      ),
    },
  });

  const sanitizedBaseEnv = sanitizePackedAuthorArtifactEnv(
    sanitizeDaemonEnvForSpawn(process.env),
  );
  const daemonEnv: NodeJS.ProcessEnv = {
    ...sanitizedBaseEnv,
    ...featureEnv,
    CI: '1',
    HAPPIER_VARIANT: 'dev',
    HAPPIER_DISABLE_CAFFEINATE: '1',
    HAPPIER_HOME_DIR: happyHomeDir,
    HAPPIER_SERVER_URL: serverProxy.baseUrl,
    HAPPIER_WEBAPP_URL: serverProxy.baseUrl,
    HAPPIER_DAEMON_HEARTBEAT_INTERVAL: '5000',
    HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED: '0',
    HTTPS_PROXY: connectProxy.url,
    https_proxy: connectProxy.url,
    SSL_CERT_FILE: connectProxy.caCertPath,
    NODE_EXTRA_CA_CERTS: connectProxy.caCertPath,
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
  const startedDaemon = await startTestDaemon({
    testDir,
    happyHomeDir,
    env: daemonEnv,
    cliLaunchSpec: {
      command: input.prepared.cliLaunchSpec.command,
      args: [...input.prepared.cliLaunchSpec.args],
      cwd: input.prepared.cliLaunchSpec.cwd,
      env: {
        ...input.prepared.cliLaunchSpec.env,
        ...daemonEnv,
      },
    },
    cleanupDescendantsOnExit: true,
    startupTimeoutMs: 120_000,
  });
  daemon = startedDaemon;
  stockPortObserver.observeOwnedProcess(startedDaemon.state.pid);
  await stockPortObserver.snapshot();
  await waitFor(async () => {
    assertPackedManagedProviderCandidateDaemonRunning({
      exitCode: startedDaemon.proc.child.exitCode,
      signalCode: startedDaemon.proc.child.signalCode,
    });
    const response = await daemonControlPostJson({
      port: startedDaemon.state.httpPort,
      path: '/list',
      controlToken: startedDaemon.state.controlToken,
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
  assert(
    startedDaemon.state.httpPort !== 8317
      && new URL(server.baseUrl).port !== '8317'
      && new URL(serverProxy.baseUrl).port !== '8317'
      && new URL(connectProxy.url).port !== '8317',
    'packed_managed_provider_stock_port_collision',
  );
  brokerProxy = await startPackedManagedProviderDaemonControlRecordingProxy(
      startedDaemon.state.httpPort,
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
    auth,
    accountSecret,
    machineId: seeded.machineId,
    daemon: startedDaemon,
    daemonEnv,
    credential,
    brokerProxy,
    managedRequestAuthOrigin:
      managedRequestAuthUse.materialization.origin,
    managedConnectionSecurityFingerprint,
    stockListenerBefore,
    stockPortObserver,
    setSessionCreationDelay: (delayMs) => {
      sessionCreationDelayMs = delayMs;
    },
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
        daemon,
        brokerProxy,
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

async function readSessionMarkers(
  happyHomeDir: string,
): Promise<readonly SessionMarker[]> {
  const files = (await listFilesRecursively(join(happyHomeDir, 'tmp')))
    .filter((path) => /[\\/]pid-\d+\.json$/u.test(path));
  const markers: SessionMarker[] = [];
  for (const path of files) {
    try {
      const value = JSON.parse(await readFile(path, 'utf8')) as {
        pid?: unknown;
        processStartTimeMs?: unknown;
        processCommandHash?: unknown;
        happySessionId?: unknown;
        managedLocalServiceRunAttachment?: {
          process?: {
            pid?: unknown;
            processStartTimeMs?: unknown;
            processCommandHash?: unknown;
          };
          endpoint?: { host?: unknown; port?: unknown };
          materialization?: {
            rootDir?: unknown;
            materializationId?: unknown;
          };
        };
      };
      const attachment = value.managedLocalServiceRunAttachment;
      if (
        typeof value.pid !== 'number'
        || typeof value.processStartTimeMs !== 'number'
        || typeof value.processCommandHash !== 'string'
        || typeof value.happySessionId !== 'string'
        || typeof attachment?.process?.pid !== 'number'
        || typeof attachment.process.processStartTimeMs !== 'number'
        || typeof attachment.process.processCommandHash !== 'string'
        || (
          attachment?.endpoint?.host !== '127.0.0.1'
          && attachment?.endpoint?.host !== '::1'
        )
        || typeof attachment.endpoint.port !== 'number'
        || typeof attachment.materialization?.rootDir !== 'string'
        || typeof attachment.materialization.materializationId !== 'string'
      ) {
        continue;
      }
      markers.push({
        path,
        pid: value.pid,
        processStartTimeMs: value.processStartTimeMs,
        processCommandHash: value.processCommandHash,
        happySessionId: value.happySessionId,
        managedLocalServiceRunAttachment: {
          process: {
            pid: attachment.process.pid,
            processStartTimeMs: attachment.process.processStartTimeMs,
            processCommandHash: attachment.process.processCommandHash,
          },
          endpoint: {
            host: attachment.endpoint.host,
            port: attachment.endpoint.port,
          },
          materialization: {
            rootDir: attachment.materialization.rootDir,
            materializationId:
              attachment.materialization.materializationId,
          },
        },
      });
    } catch {
      // A marker replacement can be observed between directory enumeration and read.
    }
  }
  return markers;
}

async function waitForProvisionalMarker(
  runtime: InitializedRuntime,
): Promise<SessionMarker> {
  let observed: SessionMarker | null = null;
  await waitFor(async () => {
    observed = (await readSessionMarkers(runtime.happyHomeDir))
      .find((marker) => marker.happySessionId === `PID-${marker.pid}`)
      ?? null;
    return observed !== null;
  }, {
    timeoutMs: 60_000,
    intervalMs: 10,
    context: 'packed managed provisional session marker',
  });
  assert(observed, 'packed_managed_provider_provisional_marker_missing');
  return observed;
}

async function waitForCanonicalMarker(
  runtime: InitializedRuntime,
  sessionId: string,
): Promise<SessionMarker> {
  let observed: SessionMarker | null = null;
  await waitFor(async () => {
    observed = (await readSessionMarkers(runtime.happyHomeDir))
      .find((marker) => marker.happySessionId === sessionId)
      ?? null;
    return observed !== null;
  }, {
    timeoutMs: 30_000,
    intervalMs: 25,
    context: `packed managed canonical marker ${sessionId}`,
  });
  assert(observed, 'packed_managed_provider_canonical_marker_missing');
  return observed;
}

async function readManagedConfig(marker: SessionMarker): Promise<ManagedConfig> {
  const path = join(
    marker.managedLocalServiceRunAttachment.materialization.rootDir,
    'cliproxyapi-managed.json',
  );
  const value = JSON.parse(await readFile(path, 'utf8')) as ManagedConfig;
  assert(
    value.materializationId
      === marker.managedLocalServiceRunAttachment.materialization
        .materializationId,
    'packed_managed_provider_materialization_identity_mismatch',
  );
  assert(
    typeof value.gateway?.downstreamBearer === 'string'
      && value.gateway.downstreamBearer.length > 0
      && typeof value.requestAuth?.capabilityPath === 'string',
    'packed_managed_provider_private_config_invalid',
  );
  return value;
}

async function routeRequestAuthThroughRecordingProxy(
  runtime: InitializedRuntime,
  capabilityPath: string,
  expectedState: Pick<DaemonState, 'httpPort'> = runtime.daemon.state,
): Promise<void> {
  const capability = await readCapability(capabilityPath);
  assert(
    capability.httpPort === expectedState.httpPort,
    'packed_managed_provider_request_auth_transport_identity_mismatch',
  );
  runtime.brokerProxy.retarget(expectedState.httpPort);
  await writeJsonAtomically(
    capabilityPath,
    {
      ...capability,
      httpPort: runtime.brokerProxy.port,
    },
  );
  const recorded = await readCapability(capabilityPath);
  assert(
    recorded.httpPort === runtime.brokerProxy.port
      && recorded.httpPort !== 8317,
    'packed_managed_provider_broker_proxy_transport_install_failed',
  );
}

async function wrapperHealthStatus(marker: SessionMarker): Promise<number> {
  const { host, port } =
    marker.managedLocalServiceRunAttachment.endpoint;
  const urlHost = host === '::1' ? '[::1]' : host;
  try {
    const response = await fetch(`http://${urlHost}:${port}/healthz`, {
      signal: AbortSignal.timeout(5_000),
    });
    await response.body?.cancel();
    return response.status;
  } catch {
    return 0;
  }
}

export async function readPackedManagedProviderRequestAuthCapability(
  path: string,
): Promise<ConnectedAccountRequestAuthCapabilityDocumentV2> {
  const value =
    await readConnectedAccountRequestAuthCapabilityFile(path);
  assert(
    value !== null,
    'packed_managed_provider_request_auth_capability_invalid',
  );
  return value;
}

const readCapability =
  readPackedManagedProviderRequestAuthCapability;

async function waitForAgentCapabilityPath(
  runtime: InitializedRuntime,
  managedCapabilityPath: string,
): Promise<string> {
  let result: string | null = null;
  await waitFor(async () => {
    result = (await listAgentCapabilityPaths(
      runtime,
      managedCapabilityPath,
    ))[0] ?? null;
    return result !== null;
  }, {
    timeoutMs: 30_000,
    intervalMs: 10,
    context: 'packed managed Agent request-auth capability',
  });
  assert(result, 'packed_managed_provider_agent_capability_missing');
  return result;
}

type CapabilityDocument = Awaited<ReturnType<typeof readCapability>>;

type RequestAuthCapabilityPair = Readonly<{
  managed: Readonly<CapabilityDocument & { path: string }>;
  agent: Readonly<CapabilityDocument & { path: string }>;
}>;

async function listAgentCapabilityPaths(
  runtime: InitializedRuntime,
  managedCapabilityPath: string,
): Promise<readonly string[]> {
  const root = join(
    runtime.happyHomeDir,
    'daemon',
    'connected-services',
    'materialized',
  );
  return (await listFilesRecursively(root)).filter((path) =>
    path.endsWith(`${join('.happier', 'request-auth-capability.json')}`)
    && resolve(path) !== resolve(managedCapabilityPath));
}

async function readRequestAuthCapabilityPair(input: Readonly<{
  runtime: InitializedRuntime;
  managedCapabilityPath: string;
  expectedAgentCapabilityPath?: string;
}>): Promise<RequestAuthCapabilityPair> {
  const agentCapabilityPath = input.expectedAgentCapabilityPath
    ?? await waitForAgentCapabilityPath(
      input.runtime,
      input.managedCapabilityPath,
    );
  const agentCapabilityPaths = await listAgentCapabilityPaths(
    input.runtime,
    input.managedCapabilityPath,
  );
  assert(
    agentCapabilityPaths.length === 1
      && resolve(agentCapabilityPaths[0]!) === resolve(agentCapabilityPath),
    'packed_managed_provider_agent_capability_path_not_deterministic',
  );
  const [managed, agent] = await Promise.all([
    readCapability(input.managedCapabilityPath),
    readCapability(agentCapabilityPath),
  ]);
  return {
    managed: {
      path: input.managedCapabilityPath,
      ...managed,
    },
    agent: {
      path: agentCapabilityPath,
      ...agent,
    },
  };
}

function spawnRequest(
  runtime: InitializedRuntime,
): Readonly<{
  body: Readonly<Record<string, unknown>>;
  promptSentinel: string;
}> {
  const spawnNonce = randomUUID();
  const promptSentinel = `packed-managed-first-prompt:${spawnNonce}`;
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
          providerConnectionId: CONNECTION_ID,
          modelId: MODEL_ID,
        },
      },
      pendingFirstInput: {
        text: `Reply with exactly ${promptSentinel}.`,
        localId: `spawn-first-turn:${spawnNonce}`,
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

async function stopSessionAndObserveCleanup(params: Readonly<{
  runtime: InitializedRuntime;
  sessionId: string;
  marker: SessionMarker;
  agentCapabilityPath: string | null;
  managedCapabilityPath: string;
  requestStop?: boolean;
}>): Promise<Readonly<{
  agentCapabilityAbsent: boolean;
  managedCapabilityAbsent: boolean;
  providerMaterializationAbsent: boolean;
  sessionMarkerAbsent: boolean;
  wrapperStopped: boolean;
  wrapperPidExited: boolean;
}>> {
  if (params.requestStop !== false) {
    await daemonControlPostJson({
      port: params.runtime.daemon.state.httpPort,
      path: '/stop-session',
      controlToken: params.runtime.daemon.state.controlToken,
      body: { sessionId: params.sessionId },
      timeoutMs: 60_000,
    }).catch(() => ({ status: 500, data: null }));
  }
  const materializationRoot =
    params.marker.managedLocalServiceRunAttachment.materialization.rootDir;
  const noAgentCapability = async (): Promise<boolean> => {
    if (params.agentCapabilityPath !== null) {
      return !(await pathExists(params.agentCapabilityPath));
    }
    const connectedMaterializationRoot = join(
      params.runtime.happyHomeDir,
      'daemon',
      'connected-services',
      'materialized',
    );
    return !(await listFilesRecursively(connectedMaterializationRoot))
      .some((path) =>
        path.endsWith(join('.happier', 'request-auth-capability.json')));
  };
  await waitFor(async () =>
    !(await pathExists(params.managedCapabilityPath))
      && await noAgentCapability()
      && !(await pathExists(materializationRoot))
      && !(await pathExists(params.marker.path))
      && await wrapperHealthStatus(params.marker) === 0
      && !isProcessAlive(
        params.marker.managedLocalServiceRunAttachment.process.pid,
      ), {
    timeoutMs: 60_000,
    intervalMs: 100,
    context: `packed managed cleanup for ${params.sessionId}`,
  });
  return {
    agentCapabilityAbsent: await noAgentCapability(),
    managedCapabilityAbsent:
      !(await pathExists(params.managedCapabilityPath)),
    providerMaterializationAbsent:
      !(await pathExists(materializationRoot)),
    sessionMarkerAbsent: !(await pathExists(params.marker.path)),
    wrapperStopped: await wrapperHealthStatus(params.marker) === 0,
    wrapperPidExited: !isProcessAlive(
      params.marker.managedLocalServiceRunAttachment.process.pid,
    ),
  };
}

async function waitForSessionCreationDelayToEngage(
  runtime: InitializedRuntime,
  previousCount: number,
): Promise<void> {
  await waitFor(async () =>
    runtime.serverProxy.count(isSessionCreationRequest) > previousCount, {
    timeoutMs: 60_000,
    intervalMs: 10,
    context: 'packed managed delayed canonical session creation request',
  });
}

async function probeFreshManagedSpawn(
  runtime: InitializedRuntime,
): Promise<PackedManagedProviderFreshSpawnObservation> {
  runtime.connectProxy.clear();
  runtime.brokerProxy.clear();
  const request = spawnRequest(runtime);
  const freshSpawnStartedAtMs = Date.now();
  const priorSessionCreates =
    runtime.serverProxy.count(isSessionCreationRequest);
  runtime.setSessionCreationDelay(2_000);
  let spawnSettled = false;
  const spawnPromise = daemonControlPostJson<{
    success?: boolean;
    sessionId?: string;
    error?: string;
    errorCode?: string;
  }>({
    port: runtime.daemon.state.httpPort,
    path: '/spawn-session',
    controlToken: runtime.daemon.state.controlToken,
    body: request.body,
    timeoutMs: 150_000,
  }).finally(() => {
    spawnSettled = true;
  });

  let provisionalMarker: SessionMarker | null = null;
  let config: ManagedConfig | null = null;
  let agentCapabilityPath: string | null = null;
  let canonicalMarker: SessionMarker | null = null;
  let returnedSessionId: string | null = null;
  try {
    await waitForSessionCreationDelayToEngage(runtime, priorSessionCreates);
    provisionalMarker = await waitForProvisionalMarker(runtime);
    runtime.stockPortObserver.observeOwnedProcess(provisionalMarker.pid);
    runtime.stockPortObserver.observeOwnedProcess(
      provisionalMarker.managedLocalServiceRunAttachment.process.pid,
    );
    await runtime.stockPortObserver.snapshot();
    config = await readManagedConfig(provisionalMarker);
    const wrapperReadyBeforeCanonicalSession =
      await wrapperHealthStatus(provisionalMarker) === 200;
    const capabilityPresentBeforeCanonicalSession =
      await pathExists(config.requestAuth.capabilityPath);
    const agentCapabilityPresentBeforeCanonicalSession =
      (await listAgentCapabilityPaths(
        runtime,
        config.requestAuth.capabilityPath,
      )).length > 0;
    assert(
      provisionalMarker.managedLocalServiceRunAttachment.endpoint.port !== 8317
        && runtime.daemon.state.httpPort !== 8317
        && runtime.brokerProxy.port !== 8317,
      'packed_managed_provider_live_port_collision',
    );
    await routeRequestAuthThroughRecordingProxy(
      runtime,
      config.requestAuth.capabilityPath,
    );
    const requestAuthRequestsBeforeCanonicalSession =
      runtime.brokerProxy.entries().length;
    const upstreamRequestsBeforeCanonicalSession =
      runtime.connectProxy.connectTargets()
        .filter((target) =>
          isManagedCodexUpstreamTarget(
            target,
            runtime.managedRequestAuthOrigin,
          )).length;
    assert(
      requestAuthRequestsBeforeCanonicalSession === 0
        && upstreamRequestsBeforeCanonicalSession === 0,
      'packed_managed_provider_effect_attempted_before_canonical_session',
    );
    const currentCredential = await seedCredential({
      serverBaseUrl: runtime.server.baseUrl,
      authToken: runtime.auth.token,
      accountSecret: runtime.accountSecret,
    });
    assert(
      currentCredential.credentialRevision
        !== runtime.credential.credentialRevision,
      'packed_managed_provider_credential_revision_not_rotated',
    );
    runtime.setSessionCreationDelay(0);

    let capabilitiesActivatedAtMs = 0;
    await waitFor(async () => {
      if (!(await pathExists(config!.requestAuth.capabilityPath))) return false;
      try {
        agentCapabilityPath = await waitForAgentCapabilityPath(
          runtime,
          config!.requestAuth.capabilityPath,
        );
        const [managedCapabilityStat, agentCapabilityStat] =
          await Promise.all([
            stat(config!.requestAuth.capabilityPath),
            stat(agentCapabilityPath),
          ]);
        capabilitiesActivatedAtMs = Math.floor(Math.max(
          managedCapabilityStat.mtimeMs,
          agentCapabilityStat.mtimeMs,
        ));
        return true;
      } catch {
        return false;
      }
    }, {
      timeoutMs: 60_000,
      intervalMs: 5,
      context: 'packed managed capabilities before spawn acknowledgement',
    });
    assert(
      agentCapabilityPath,
      'packed_managed_provider_agent_capability_not_observed',
    );
    const managedCapability =
      await readCapability(config.requestAuth.capabilityPath);
    const agentCapability = await readCapability(agentCapabilityPath);
    assert(
      !spawnSettled,
      'packed_managed_provider_capabilities_activated_after_spawn_ack',
    );
    const response = await spawnPromise;
    const spawnAcknowledgedAtMs = Date.now();
    assert(
      response.status === 200
        && response.data?.success === true
        && typeof response.data.sessionId === 'string'
        && response.data.sessionId.length > 0,
      `packed_managed_provider_fresh_spawn_failed:${response.status}:${response.data?.error ?? response.data?.errorCode ?? 'unknown'}`,
    );
    const canonicalSessionId = response.data.sessionId;
    assert(
      typeof canonicalSessionId === 'string'
        && canonicalSessionId.length > 0,
      'packed_managed_provider_spawn_response_session_id_missing',
    );
    returnedSessionId = canonicalSessionId;
    canonicalMarker = await waitForCanonicalMarker(
      runtime,
      canonicalSessionId,
    );
    const findFirstInputLookups = (): Readonly<{
      managed: RecordedBrokerLookup | null;
      agent: RecordedBrokerLookup | null;
    }> => {
      const entries = runtime.brokerProxy.entries();
      const managed = entries.find((entry) =>
        entry.capabilityFingerprint
          === fingerprintSecret(managedCapability.capability)
        && entry.purpose?.consumer.pluginId
          === OPENAI_PURPOSE.consumer.pluginId
        && entry.purpose.consumer.localId === OPENAI_PURPOSE.consumer.localId
        && entry.purpose.purpose === OPENAI_PURPOSE.purpose) ?? null;
      const agent = entries.find((entry) =>
        entry.capabilityFingerprint
          === fingerprintSecret(agentCapability.capability)
        && entry.purpose?.consumer.pluginId
          === OPENCODE_PURPOSE.consumer.pluginId
        && entry.purpose.consumer.localId === OPENCODE_PURPOSE.consumer.localId
        && entry.purpose.purpose === OPENCODE_PURPOSE.purpose) ?? null;
      return { managed, agent };
    };
    await waitFor(async () => {
      const lookups = findFirstInputLookups();
      return lookups.managed !== null && lookups.agent !== null;
    }, {
      timeoutMs: 60_000,
      intervalMs: 20,
      context: 'packed managed first-input request-auth broker traversal',
    });
    const { managed: managedLookup, agent: agentLookup } =
      findFirstInputLookups();
    assert(
      managedLookup
        && agentLookup
        && managedLookup.status === 200
        && agentLookup.status === 200
        && managedLookup.credentialRevision
          === currentCredential.credentialRevision
        && agentLookup.credentialRevision
          === currentCredential.credentialRevision
        && managedLookup.accessTokenFingerprint
          === currentCredential.accessTokenFingerprint
        && agentLookup.accessTokenFingerprint
          === currentCredential.accessTokenFingerprint,
      'packed_managed_provider_current_credential_not_observed_at_broker',
    );
    await waitFor(async () =>
      runtime.connectProxy.entries().some((entry) =>
        isManagedCodexUpstreamTarget(
          entry.connectTarget,
          runtime.managedRequestAuthOrigin,
        )
        && entry.body.includes(request.promptSentinel)), {
      timeoutMs: 30_000,
      intervalMs: 20,
      context: 'packed managed first-prompt decrypted upstream request',
    });
    const sessionCreation = runtime.serverProxy.entries()
      .filter((entry) =>
        isSessionCreationRequest(entry)
        && entry.id > priorSessionCreates)
      .at(-1);
    assert(
      sessionCreation !== undefined
        && sessionCreation.endedAtMs !== null
        && sessionCreation.statusCode !== null
        && sessionCreation.statusCode >= 200
        && sessionCreation.statusCode < 300,
      'packed_managed_provider_canonical_webhook_ack_unobserved',
    );
    const daemonWebhookAcknowledgement =
      runtime.brokerProxy.sessionStartedEntries()
        .filter((entry) =>
          entry.sessionId === canonicalSessionId
          && entry.status >= 200
          && entry.status < 300)
        .at(-1);
    assert(
      daemonWebhookAcknowledgement !== undefined,
      'packed_managed_provider_daemon_webhook_ack_unobserved',
    );
    const providerAttempt = runtime.connectProxy.entries()
      .find((entry) =>
        isManagedCodexUpstreamTarget(
          entry.connectTarget,
          runtime.managedRequestAuthOrigin,
        )
        && entry.body.includes(request.promptSentinel));
    assert(
      providerAttempt
        && !providerAttempt.connectTarget.includes(':8317')
        && providerAttempt.path.startsWith(`${MANAGED_CODEX_BASE_PATH}/`)
        && providerAttempt.authorizationFingerprint
          === currentCredential.accessTokenFingerprint
        && providerAttempt.authorizationFingerprint
          === managedLookup.accessTokenFingerprint
        && daemonWebhookAcknowledgement.acknowledgedAtMs
          >= sessionCreation.endedAtMs
        && capabilitiesActivatedAtMs
          <= daemonWebhookAcknowledgement.acknowledgedAtMs
        && managedLookup.startedAtMs
          >= daemonWebhookAcknowledgement.acknowledgedAtMs
        && agentLookup.startedAtMs
          >= daemonWebhookAcknowledgement.acknowledgedAtMs
        && capabilitiesActivatedAtMs <= managedLookup.startedAtMs
        && capabilitiesActivatedAtMs <= agentLookup.startedAtMs
        && providerAttempt.observedAtMs >= agentLookup.endedAtMs
        && providerAttempt.observedAtMs >= managedLookup.endedAtMs,
      'packed_managed_provider_first_input_order_unproven',
    );
    const liveHealth = await wrapperHealthStatus(canonicalMarker);
    const materializationRoot =
      canonicalMarker.managedLocalServiceRunAttachment.materialization.rootDir;
    const providerMaterializationPresentAfterSpawnAcknowledgement =
      await pathExists(materializationRoot);
    const sessionMarkerPresentAfterSpawnAcknowledgement =
      await pathExists(canonicalMarker.path);
    const cleanup = await stopSessionAndObserveCleanup({
      runtime,
      sessionId: canonicalSessionId,
      marker: canonicalMarker,
      agentCapabilityPath,
      managedCapabilityPath: config.requestAuth.capabilityPath,
    });
    const stockNetworkAfter =
      await runtime.stockPortObserver.snapshot();
    const stockListenerAfter = captureStockListenerSnapshot();

    return {
      spawnRequestIncludedSessionId:
        Object.prototype.hasOwnProperty.call(request.body, 'sessionId'),
      returnedSessionId: canonicalSessionId,
      markerSessionId: canonicalMarker.happySessionId,
      wrapperReadyBeforeCanonicalSession,
      capabilityPresentBeforeCanonicalSession,
      agentCapabilityPresentBeforeCanonicalSession,
      requestAuthRequestsBeforeCanonicalSession,
      upstreamRequestsBeforeCanonicalSession,
      managedPurpose: managedLookup.purpose!.purpose,
      agentPurpose: agentLookup.purpose!.purpose,
      managedCapabilityScopeDigest: managedCapability.subjectScopeDigest,
      agentCapabilityScopeDigest: agentCapability.subjectScopeDigest,
      credentialRevision: currentCredential.credentialRevision,
      leaseCredentialRevision: managedLookup.credentialRevision ?? '',
      managedLeaseAccessTokenFingerprint:
        managedLookup.accessTokenFingerprint ?? '',
      upstreamAuthorizationFingerprint:
        providerAttempt.authorizationFingerprint ?? '',
      managedRequestAuthOrigin:
        runtime.managedRequestAuthOrigin,
      managedConnectionSecurityFingerprint:
        runtime.managedConnectionSecurityFingerprint,
      upstreamConnectTarget: providerAttempt.connectTarget,
      currentAccessTokenFingerprint:
        currentCredential.accessTokenFingerprint,
      promptSentinelObserved:
        providerAttempt.body.includes(request.promptSentinel),
      upstreamRequestPath: providerAttempt.path,
      timeline: {
        freshSpawnStartedAtMs,
        canonicalSessionRegisteredAtMs: sessionCreation.endedAtMs,
        canonicalWebhookAcknowledgedAtMs:
          daemonWebhookAcknowledgement.acknowledgedAtMs,
        capabilitiesActivatedAtMs,
        spawnAcknowledgedAtMs,
        agentRequestAuthLookupAtMs: agentLookup.startedAtMs,
        agentRequestAuthLookupCompletedAtMs: agentLookup.endedAtMs,
        managedRequestAuthLookupAtMs: managedLookup.startedAtMs,
        managedRequestAuthLookupCompletedAtMs: managedLookup.endedAtMs,
        providerAttemptAtMs: providerAttempt.observedAtMs,
      },
      observedPorts: {
        server: Number(new URL(runtime.server.baseUrl).port),
        serverProxy: Number(new URL(runtime.serverProxy.baseUrl).port),
        daemon: runtime.daemon.state.httpPort,
        brokerProxy: runtime.brokerProxy.port,
        upstreamProxy: Number(new URL(runtime.connectProxy.url).port),
        wrapper:
          canonicalMarker.managedLocalServiceRunAttachment.endpoint.port,
      },
      stockPortRequestCount:
        runtime.connectProxy.connectTargets()
          .filter((target) => target.includes(':8317')).length,
      stockPortOsConnectionAttemptCount:
        stockNetworkAfter.ownedConnectionAttemptCount,
      stockListenerIdentityBefore: runtime.stockListenerBefore.identity,
      stockListenerIdentityAfter: stockListenerAfter.identity,
      wrapperHealthStatus: liveHealth,
      wrapperAliveAfterSpawnAcknowledgement: liveHealth === 200,
      providerMaterializationPresentAfterSpawnAcknowledgement,
      sessionMarkerPresentAfterSpawnAcknowledgement,
      cleanup,
    };
  } catch (error) {
    runtime.setSessionCreationDelay(0);
    const response = await spawnPromise.catch(() => null);
    const sessionId = returnedSessionId
      ?? (
        response?.status === 200
        && typeof response.data?.sessionId === 'string'
          ? response.data.sessionId
          : null
      );
    if (sessionId && provisionalMarker && config) {
      await stopSessionAndObserveCleanup({
        runtime,
        sessionId,
        marker: canonicalMarker ?? provisionalMarker,
        agentCapabilityPath,
        managedCapabilityPath: config.requestAuth.capabilityPath,
      }).catch(() => {});
    }
    throw error;
  } finally {
    runtime.setSessionCreationDelay(0);
  }
}

type ObservedManagedProcessIdentity = Readonly<{
  pid: number;
  command: string;
  executablePath: string;
  processStartTimeMs: number;
}>;

type ManagedProcessIdentityEvidence = Readonly<{
  pid: number;
  executablePath: string;
  processStartTimeMs: number;
}>;

type PackedManagedProviderCapabilityRotationEvidence = Readonly<{
  managedCapabilityPathStable: boolean;
  agentCapabilityPathStable: boolean;
  managedCapabilityRotated: boolean;
  agentCapabilityRotated: boolean;
  oldManagedCapabilityStatus: number;
  freshManagedCapabilityStatus: number;
  oldAgentCapabilityStatus: number;
  freshAgentCapabilityStatus: number;
  capabilityInvalidReadCount: number;
  currentDaemonTupleRecovered: boolean;
}>;

export type PackedManagedProviderContinuityContractEvidence = Readonly<{
  gracefulTakeover: PackedManagedProviderCapabilityRotationEvidence;
  preLeaseCrash: Readonly<{
    replacement: PackedManagedProviderCapabilityRotationEvidence;
    responseStatus: number;
    managedBrokerAttemptCount: number;
    managedBrokerUnauthorizedCount: number;
    agentBrokerAttemptCount: number;
    agentBrokerUnauthorizedCount: number;
    agentPendingLocalId: string;
    agentCommittedLocalIdCount: number;
    agentTurnFailedCount: number;
    agentLatestTurnStatus:
      'in_progress' | 'completed' | 'cancelled' | 'failed' | null;
    agentTransportUnavailableObserved: boolean;
    agentFailedTurnFalselyCompleted: boolean;
    upstreamEffectCount: number;
    replayAttemptCount: number;
    tupleChangedBeforeRefusal: boolean;
  }>;
  postLeaseCrash: Readonly<{
    replacement: PackedManagedProviderCapabilityRotationEvidence;
    upstreamAttemptCount: number;
    authorizationFingerprintMatched: boolean;
    responseCompletedAfterCrash: boolean;
    replayAttemptCount: number;
  }>;
  idleNextInput: Readonly<{
    pendingLocalId: string;
    committedLocalIdCount: number;
    upstreamAttemptCount: number;
    agentBrokerStatuses: readonly number[];
    managedBrokerStatuses: readonly number[];
    brokerUnauthorizedCount: number;
    replayAttemptCount: number;
    turnFailedCount: number;
    latestTurnStatus: 'in_progress' | 'completed' | 'cancelled' | 'failed' | null;
    failedTurnFalselyCompleted: boolean;
    currentCapabilityDaemonTupleUsed: boolean;
  }>;
}>;

function assertCapabilityRotationEvidence(
  evidence: PackedManagedProviderCapabilityRotationEvidence,
  code: string,
): void {
  assert(
    evidence.managedCapabilityPathStable
      && evidence.agentCapabilityPathStable
      && evidence.managedCapabilityRotated
      && evidence.agentCapabilityRotated
      && evidence.oldManagedCapabilityStatus === 401
      && evidence.freshManagedCapabilityStatus === 200
      && evidence.oldAgentCapabilityStatus === 401
      && evidence.freshAgentCapabilityStatus === 200
      && evidence.capabilityInvalidReadCount === 0
      && evidence.currentDaemonTupleRecovered,
    code,
  );
}

export function assertPackedManagedProviderContinuityContract(
  evidence: PackedManagedProviderContinuityContractEvidence,
): void {
  assertCapabilityRotationEvidence(
    evidence.gracefulTakeover,
    'packed_managed_provider_graceful_paired_capability_rotation_unproven',
  );
  assertCapabilityRotationEvidence(
    evidence.preLeaseCrash.replacement,
    'packed_managed_provider_pre_lease_replacement_rotation_unproven',
  );
  assert(
    evidence.preLeaseCrash.responseStatus === 503
      && evidence.preLeaseCrash.managedBrokerAttemptCount === 1
      && evidence.preLeaseCrash.managedBrokerUnauthorizedCount === 1
      && evidence.preLeaseCrash.agentBrokerAttemptCount === 1
      && evidence.preLeaseCrash.agentBrokerUnauthorizedCount === 1
      && evidence.preLeaseCrash.agentPendingLocalId.trim().length > 0
      && evidence.preLeaseCrash.agentCommittedLocalIdCount === 1
      && evidence.preLeaseCrash.agentTurnFailedCount === 1
      && evidence.preLeaseCrash.agentLatestTurnStatus === 'failed'
      && evidence.preLeaseCrash.agentTransportUnavailableObserved
      && !evidence.preLeaseCrash.agentFailedTurnFalselyCompleted
      && evidence.preLeaseCrash.upstreamEffectCount === 0
      && evidence.preLeaseCrash.replayAttemptCount === 0
      && evidence.preLeaseCrash.tupleChangedBeforeRefusal,
    'packed_managed_provider_pre_lease_publication_gap_contract_failed',
  );
  assertCapabilityRotationEvidence(
    evidence.postLeaseCrash.replacement,
    'packed_managed_provider_post_lease_replacement_rotation_unproven',
  );
  assert(
    evidence.postLeaseCrash.upstreamAttemptCount === 1
      && evidence.postLeaseCrash.authorizationFingerprintMatched
      && evidence.postLeaseCrash.responseCompletedAfterCrash
      && evidence.postLeaseCrash.replayAttemptCount === 0,
    'packed_managed_provider_post_lease_attempt_contract_failed',
  );
  const idle = evidence.idleNextInput;
  assert(
    idle.pendingLocalId.trim().length > 0
      && idle.committedLocalIdCount === 1
      && idle.upstreamAttemptCount === 1
      && idle.agentBrokerStatuses.length === 1
      && idle.agentBrokerStatuses[0] === 200
      && idle.managedBrokerStatuses.length === 1
      && idle.managedBrokerStatuses[0] === 200
      && idle.brokerUnauthorizedCount === 0
      && idle.replayAttemptCount === 0
      && idle.turnFailedCount === 1
      && idle.latestTurnStatus === 'failed'
      && !idle.failedTurnFalselyCompleted
      && idle.currentCapabilityDaemonTupleUsed,
    'packed_managed_provider_idle_pending_input_contract_failed',
  );
}

export type PackedManagedProviderContinuityObservation = Readonly<{
  sessionId: string;
  contract: PackedManagedProviderContinuityContractEvidence;
  initial: Readonly<{
    daemon: ManagedProcessIdentityEvidence;
    agent: ManagedProcessIdentityEvidence;
    wrapper: ManagedProcessIdentityEvidence;
    attachment: SessionMarker['managedLocalServiceRunAttachment'];
    materializationId: string;
    managedCapabilityPath: string;
    agentCapabilityPath: string;
    capabilityFingerprint: string;
    agentCapabilityFingerprint: string;
  }>;
  gracefulTakeover: Readonly<{
    daemon: ManagedProcessIdentityEvidence;
    agent: ManagedProcessIdentityEvidence;
    wrapper: ManagedProcessIdentityEvidence;
    sameAgentPid: boolean;
    sameWrapperPid: boolean;
    sameAttachment: boolean;
    wrapperHealthy: boolean;
    capabilityRotated: boolean;
    oldCapabilityStatus: number;
    freshCapabilityStatus: number;
    capabilityInvalidReadCount: number;
    startupUpstreamAttempts: number;
    startupSessionCreates: number;
  }>;
  unexpectedReplacement: Readonly<{
    daemon: ManagedProcessIdentityEvidence;
    agent: ManagedProcessIdentityEvidence;
    wrapper: ManagedProcessIdentityEvidence;
    sameAgentPid: boolean;
    sameWrapperPid: boolean;
    sameAttachment: boolean;
    wrapperHealthy: boolean;
    capabilityRotated: boolean;
    oldCapabilityStatus: number;
    freshCapabilityStatus: number;
    capabilityInvalidReadCount: number;
    startupUpstreamAttempts: number;
    startupSessionCreates: number;
    authorityGapRequestStatus: number;
    heldAfterLeaseUpstreamAttempts: number;
    heldAfterLeaseAuthorizationFingerprintMatched: boolean;
    heldAfterLeaseResponseCompletedAfterCrash: boolean;
    heldAfterLeaseReplayAttempts: number;
  }>;
  canary: Readonly<{
    submittedThroughSurvivingAgent: boolean;
    upstreamAttemptCount: number;
    authorizationFingerprintMatched: boolean;
    promptSentinelObserved: boolean;
  }>;
  permanentCleanup: Readonly<{
    agentExited: boolean;
    wrapperExited: boolean;
    markerAbsent: boolean;
    capabilityAbsent: boolean;
    materializationAbsent: boolean;
  }>;
}>;

async function processIdentity(
  pid: number,
): Promise<ObservedManagedProcessIdentity> {
  const observed = await readProcessIdentityByPid(pid);
  assert(
    observed
      && observed.pid === pid
      && typeof observed.processStartTimeMs === 'number'
      && Number.isInteger(observed.processStartTimeMs)
      && observed.processStartTimeMs >= 0
      && typeof observed.executablePath === 'string'
      && observed.executablePath.trim().length > 0,
    'packed_managed_provider_exact_process_identity_unavailable',
  );
  return {
    pid,
    command: observed.command.trim(),
    executablePath: observed.executablePath,
    processStartTimeMs: observed.processStartTimeMs,
  };
}

function exactProcessIdentity(
  left: ObservedManagedProcessIdentity,
  right: ObservedManagedProcessIdentity,
): boolean {
  return left.pid === right.pid
    && left.command === right.command
    && sameExecutablePath(left.executablePath, right.executablePath)
    && left.processStartTimeMs === right.processStartTimeMs;
}

function processIdentityEvidence(
  identity: ObservedManagedProcessIdentity,
): ManagedProcessIdentityEvidence {
  return {
    pid: identity.pid,
    executablePath: identity.executablePath,
    processStartTimeMs: identity.processStartTimeMs,
  };
}

function sameExecutablePath(left: string, right: string): boolean {
  const canonicalize = (path: string): string => {
    const canonical = resolve(path.trim());
    return process.platform === 'win32'
      ? canonical.toLowerCase()
      : canonical;
  };
  return canonicalize(left) === canonicalize(right);
}

function exactAttachment(
  left: SessionMarker['managedLocalServiceRunAttachment'],
  right: SessionMarker['managedLocalServiceRunAttachment'],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function waitForProcessExit(pid: number, timeoutMs = 30_000): Promise<void> {
  await waitFor(() => !isProcessAlive(pid), {
    timeoutMs,
    intervalMs: 25,
    context: `process ${pid} exit`,
  });
}

function candidateDaemonEnv(runtime: InitializedRuntime): NodeJS.ProcessEnv {
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
  env?: NodeJS.ProcessEnv;
}>): Promise<ReturnType<typeof spawn>> {
  const child = spawn(
    input.prepared.prepared.cliLaunchSpec.command,
    [
      ...input.prepared.prepared.cliLaunchSpec.args,
      ...input.args,
    ],
    {
      cwd: input.prepared.prepared.cliLaunchSpec.cwd,
      env: {
        ...input.prepared.prepared.cliLaunchSpec.env,
        ...candidateDaemonEnv(input.runtime),
        ...input.env,
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
      `packed_managed_provider_candidate_command_failed:${code ?? signal ?? 'unknown'}`,
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
    context: `replacement daemon after ${previousPid}`,
  });
  assert(replacement, 'packed_managed_provider_replacement_daemon_missing');
  return replacement;
}

async function waitForRotatedCapabilityPair(input: Readonly<{
  runtime: InitializedRuntime;
  previous: RequestAuthCapabilityPair;
}>): Promise<RequestAuthCapabilityPair> {
  let replacement: RequestAuthCapabilityPair | null = null;
  await waitFor(async () => {
    try {
      const current = await readRequestAuthCapabilityPair({
        runtime: input.runtime,
        managedCapabilityPath: input.previous.managed.path,
        expectedAgentCapabilityPath: input.previous.agent.path,
      });
      if (
        current.managed.capability === input.previous.managed.capability
        || current.agent.capability === input.previous.agent.capability
      ) {
        return false;
      }
      replacement = current;
      return true;
    } catch {
      return false;
    }
  }, {
    timeoutMs: 120_000,
    intervalMs: 10,
    context: 'paired request-auth capability rotation',
  });
  assert(
    replacement,
    'packed_managed_provider_paired_capabilities_not_rotated',
  );
  return replacement;
}

function startCapabilityReadMonitor(path: string): Readonly<{
  stop(): Promise<number>;
}> {
  let stopped = false;
  let invalidReadCount = 0;
  const promise = (async () => {
    while (!stopped) {
      try {
        await readCapability(path);
      } catch {
        invalidReadCount += 1;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 2));
    }
  })();
  return {
    stop: async () => {
      stopped = true;
      await promise;
      return invalidReadCount;
    },
  };
}

function startCapabilityPairReadMonitor(
  pair: RequestAuthCapabilityPair,
): Readonly<{ stop(): Promise<number> }> {
  const managed = startCapabilityReadMonitor(pair.managed.path);
  const agent = startCapabilityReadMonitor(pair.agent.path);
  return {
    stop: async () => {
      const invalid = await Promise.all([
        managed.stop(),
        agent.stop(),
      ]);
      return invalid[0] + invalid[1];
    },
  };
}

async function lookupRequestAuth(input: Readonly<{
  state: DaemonState;
  capability: string;
  purpose: typeof OPENAI_PURPOSE | typeof OPENCODE_PURPOSE;
}>): Promise<Readonly<{
  status: number;
  accessTokenFingerprint: string | null;
  errorCode: string | null;
}>> {
  const response = await fetch(
    `http://127.0.0.1:${input.state.httpPort}/connected-accounts/request-auth/lookup`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-happier-connected-account-capability': input.capability,
      },
      body: JSON.stringify({ purpose: input.purpose }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  const body = await response.json().catch(() => null) as {
    value?: { accessToken?: unknown };
    error?: { code?: unknown };
  } | null;
  const accessToken =
    typeof body?.value?.accessToken === 'string'
      ? body.value.accessToken
      : null;
  return {
    status: response.status,
    accessTokenFingerprint:
      accessToken ? fingerprintSecret(accessToken) : null,
    errorCode:
      typeof body?.error?.code === 'string' ? body.error.code : null,
  };
}

async function lookupCapabilityPair(input: Readonly<{
  state: DaemonState;
  pair: RequestAuthCapabilityPair;
}>): Promise<Readonly<{
  managed: Awaited<ReturnType<typeof lookupRequestAuth>>;
  agent: Awaited<ReturnType<typeof lookupRequestAuth>>;
}>> {
  const [managed, agent] = await Promise.all([
    lookupRequestAuth({
      state: input.state,
      capability: input.pair.managed.capability,
      purpose: OPENAI_PURPOSE,
    }),
    lookupRequestAuth({
      state: input.state,
      capability: input.pair.agent.capability,
      purpose: OPENCODE_PURPOSE,
    }),
  ]);
  return { managed, agent };
}

async function observeReplacement(input: Readonly<{
  runtime: InitializedRuntime;
  sessionId: string;
  marker: SessionMarker;
  config: ManagedConfig;
  previousCapabilities: RequestAuthCapabilityPair;
  previousDaemonPid: number;
  startupSessionCreateCount: number;
  replace: () => Promise<void>;
  afterAuthorityObserved?: (observation: Readonly<{
    state: DaemonState;
    capabilities: RequestAuthCapabilityPair;
  }>) => Promise<void>;
}>): Promise<Readonly<{
  state: DaemonState;
  daemon: ObservedManagedProcessIdentity;
  agent: ObservedManagedProcessIdentity;
  wrapper: ObservedManagedProcessIdentity;
  marker: SessionMarker;
  capabilities: RequestAuthCapabilityPair;
  oldLookups: Awaited<ReturnType<typeof lookupCapabilityPair>>;
  freshLookups: Awaited<ReturnType<typeof lookupCapabilityPair>>;
  capabilityInvalidReadCount: number;
  currentDaemonTupleRecovered: boolean;
  startupUpstreamAttempts: number;
  startupSessionCreates: number;
}>> {
  input.runtime.connectProxy.clear();
  const monitor = startCapabilityPairReadMonitor(input.previousCapabilities);
  let monitorStopped = false;
  try {
    await input.replace();
    const state = await waitForReplacementDaemon(
      input.runtime,
      input.previousDaemonPid,
    );
    input.runtime.stockPortObserver.observeOwnedProcess(state.pid);
    input.runtime.stockPortObserver.observeOwnedProcess(input.marker.pid);
    input.runtime.stockPortObserver.observeOwnedProcess(
      input.marker.managedLocalServiceRunAttachment.process.pid,
    );
    const stockNetwork = await input.runtime.stockPortObserver.snapshot();
    assert(
      stockNetwork.ownedConnectionAttemptCount === 0,
      'packed_managed_provider_replacement_touched_stock_port',
    );
    const capabilities = await waitForRotatedCapabilityPair({
      runtime: input.runtime,
      previous: input.previousCapabilities,
    });
    const capabilityInvalidReadCount = await monitor.stop();
    monitorStopped = true;
    const marker = await waitForCanonicalMarker(
      input.runtime,
      input.sessionId,
    );
    const currentDaemonTupleRecovered =
      capabilities.managed.httpPort === state.httpPort
      && capabilities.agent.httpPort === state.httpPort;
    const [oldLookups, freshLookups] = await Promise.all([
      lookupCapabilityPair({
        state,
        pair: input.previousCapabilities,
      }),
      lookupCapabilityPair({
        state,
        pair: capabilities,
      }),
    ]);
    await routeRequestAuthThroughRecordingProxy(
      input.runtime,
      input.config.requestAuth.capabilityPath,
      state,
    );
    await input.afterAuthorityObserved?.({ state, capabilities });
    // Give a replay/prompt writer triggered by startup a bounded chance to
    // surface after authority has committed, instead of sampling only at the
    // instant the capability file rotates.
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
    const [daemon, agent, wrapper] = await Promise.all([
      processIdentity(state.pid),
      processIdentity(marker.pid),
      processIdentity(
        marker.managedLocalServiceRunAttachment.process.pid,
      ),
    ]);
    return {
      state,
      daemon,
      agent,
      wrapper,
      marker,
      capabilities,
      oldLookups,
      freshLookups,
      capabilityInvalidReadCount,
      currentDaemonTupleRecovered,
      startupUpstreamAttempts: input.runtime.connectProxy.entries().length,
      startupSessionCreates:
        input.runtime.serverProxy.count(isSessionCreationRequest)
        - input.startupSessionCreateCount,
    };
  } finally {
    if (!monitorStopped) await monitor.stop();
  }
}

function capabilityRotationEvidence(input: Readonly<{
  previous: RequestAuthCapabilityPair;
  replacement: Awaited<ReturnType<typeof observeReplacement>>;
}>): PackedManagedProviderCapabilityRotationEvidence {
  return {
    managedCapabilityPathStable:
      resolve(input.replacement.capabilities.managed.path)
      === resolve(input.previous.managed.path),
    agentCapabilityPathStable:
      resolve(input.replacement.capabilities.agent.path)
      === resolve(input.previous.agent.path),
    managedCapabilityRotated:
      input.replacement.capabilities.managed.capability
      !== input.previous.managed.capability,
    agentCapabilityRotated:
      input.replacement.capabilities.agent.capability
      !== input.previous.agent.capability,
    oldManagedCapabilityStatus:
      input.replacement.oldLookups.managed.status,
    freshManagedCapabilityStatus:
      input.replacement.freshLookups.managed.status,
    oldAgentCapabilityStatus:
      input.replacement.oldLookups.agent.status,
    freshAgentCapabilityStatus:
      input.replacement.freshLookups.agent.status,
    capabilityInvalidReadCount:
      input.replacement.capabilityInvalidReadCount,
    currentDaemonTupleRecovered:
      input.replacement.currentDaemonTupleRecovered,
  };
}

function isTurnFailedTranscriptMessage(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const content = record.content;
  if (!content || typeof content !== 'object' || Array.isArray(content)) {
    return false;
  }
  const contentRecord = content as Record<string, unknown>;
  const data = contentRecord.data;
  return !!data
    && typeof data === 'object'
    && !Array.isArray(data)
    && (data as Record<string, unknown>).type === 'turn_failed';
}

export async function probePackedManagedProviderDaemonContinuity(
  runtime: InitializedRuntime,
  prepared: PackedManagedProviderPreparedInput,
): Promise<PackedManagedProviderContinuityObservation> {
  runtime.connectProxy.clear();
  const request = spawnRequest(runtime);
  const spawnResponse = await daemonControlPostJson<{
    success?: boolean;
    sessionId?: string;
  }>({
    port: runtime.daemon.state.httpPort,
    path: '/spawn-session',
    controlToken: runtime.daemon.state.controlToken,
    body: request.body,
    timeoutMs: 150_000,
  });
  assert(
    spawnResponse.status === 200
      && spawnResponse.data?.success === true
      && typeof spawnResponse.data.sessionId === 'string',
    'packed_managed_provider_continuity_spawn_failed',
  );
  const sessionId = spawnResponse.data.sessionId;
  const marker = await waitForCanonicalMarker(runtime, sessionId);
  const config = await readManagedConfig(marker);
  const capabilities = await readRequestAuthCapabilityPair({
    runtime,
    managedCapabilityPath: config.requestAuth.capabilityPath,
  });
  await waitFor(async () =>
    runtime.connectProxy.entries().some((entry) =>
      entry.body.includes(request.promptSentinel)), {
    timeoutMs: 60_000,
    intervalMs: 20,
    context: 'managed continuity initial isolated upstream attempt',
  });
  const [initialDaemon, initialAgent, initialWrapper] = await Promise.all([
    processIdentity(runtime.daemon.state.pid),
    processIdentity(marker.pid),
    processIdentity(
      marker.managedLocalServiceRunAttachment.process.pid,
    ),
  ]);
  assert(
    sameExecutablePath(
      initialDaemon.executablePath,
      prepared.prepared.standaloneCliArtifact.executablePath,
    )
      && sameExecutablePath(
        initialWrapper.executablePath,
        prepared.prepared.wrapperExecutable,
      )
      && marker.managedLocalServiceRunAttachment.process.pid
        === initialWrapper.pid
      && marker.processStartTimeMs === initialAgent.processStartTimeMs
      && marker.managedLocalServiceRunAttachment.process.processStartTimeMs
        === initialWrapper.processStartTimeMs
      && /^[0-9a-f]{64}$/u.test(marker.processCommandHash)
      && /^[0-9a-f]{64}$/u.test(
        marker.managedLocalServiceRunAttachment.process.processCommandHash,
      )
      && marker.managedLocalServiceRunAttachment.materialization.materializationId
        === config.materializationId
      && marker.managedLocalServiceRunAttachment.endpoint.port !== 8317,
    'packed_managed_provider_initial_runtime_identity_mismatch',
  );
  const startupSessionCreateCount =
    runtime.serverProxy.count(isSessionCreationRequest);

  const graceful = await observeReplacement({
    runtime,
    sessionId,
    marker,
    config,
    previousCapabilities: capabilities,
    previousDaemonPid: runtime.daemon.state.pid,
    startupSessionCreateCount,
    replace: async () => {
      await runCandidateCommand({
        runtime,
        prepared,
        args: ['daemon', 'restart', '--takeover', '--json'],
        waitForExit: true,
      });
    },
  });
  const gracefulRotation = capabilityRotationEvidence({
    previous: capabilities,
    replacement: graceful,
  });
  assert(
    graceful.oldLookups.managed.status === 401
      && graceful.oldLookups.managed.errorCode === 'request_auth_unauthorized'
      && graceful.freshLookups.managed.status === 200
      && graceful.oldLookups.agent.status === 401
      && graceful.oldLookups.agent.errorCode === 'request_auth_unauthorized'
      && graceful.freshLookups.agent.status === 200,
    'packed_managed_provider_graceful_capability_rotation_failed',
  );
  const gracefulWrapperHealthy =
    await wrapperHealthStatus(graceful.marker) === 200;
  assert(
    sameExecutablePath(
      graceful.daemon.executablePath,
      prepared.prepared.standaloneCliArtifact.executablePath,
    )
      && exactProcessIdentity(graceful.agent, initialAgent)
      && exactProcessIdentity(graceful.wrapper, initialWrapper)
      && graceful.marker.processCommandHash === marker.processCommandHash
      && exactAttachment(
        marker.managedLocalServiceRunAttachment,
        graceful.marker.managedLocalServiceRunAttachment,
      )
      && gracefulWrapperHealthy
      && graceful.capabilityInvalidReadCount === 0
      && graceful.startupUpstreamAttempts === 0
      && graceful.startupSessionCreates === 0,
    'packed_managed_provider_graceful_continuity_mismatch',
  );

  runtime.connectProxy.clear();
  runtime.brokerProxy.clear();
  await waitFor(async () => {
    const session = await fetchSessionV2(
      runtime.server.baseUrl,
      runtime.auth.token,
      sessionId,
    );
    return session.latestTurnStatus !== 'in_progress';
  }, {
    timeoutMs: 30_000,
    intervalMs: 100,
    context: 'managed publication-gap surviving Agent idle',
  });
  const messagesBeforePreLeaseCrash = await fetchAllMessages(
    runtime.server.baseUrl,
    runtime.auth.token,
    sessionId,
  );
  const messageSeqBeforePreLeaseCrash = Math.max(
    0,
    ...messagesBeforePreLeaseCrash.map((message) => message.seq),
  );
  const preLeaseSentinel =
    `packed-managed-publication-gap:${randomUUID()}`;
  const preLeaseAgentSentinel =
    `ordinary-agent-publication-gap:${randomUUID()}`;
  const preLeaseAgentPendingLocalId =
    `pending-during-replacement:${randomUUID()}`;
  const preLeaseManagedHold =
    runtime.brokerProxy.holdNextLookup(OPENAI_PURPOSE);
  const preLeaseAgentHold =
    runtime.brokerProxy.holdNextLookup(OPENCODE_PURPOSE);
  let preLeaseResponseStatus: number | null = null;
  let preLeaseManagedBrokerAttemptCount = 0;
  let preLeaseManagedBrokerUnauthorizedCount = 0;
  let preLeaseAgentBrokerAttemptCount = 0;
  let preLeaseAgentBrokerUnauthorizedCount = 0;
  let preLeaseAgentCommittedLocalIdCount = 0;
  let preLeaseAgentTurnFailedCount = 0;
  let preLeaseAgentLatestTurnStatus:
    PackedManagedProviderContinuityContractEvidence['preLeaseCrash']['agentLatestTurnStatus']
    = null;
  let preLeaseAgentTransportUnavailableObserved = false;
  let preLeaseUpstreamEffectCount = 0;
  let preLeaseReplayAttemptCount = 0;
  let preLeaseTupleChangedBeforeRefusal = false;
  const preLeaseResponsePromise = fetch(
    `http://127.0.0.1:${marker.managedLocalServiceRunAttachment.endpoint.port}/v1/responses`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.gateway.downstreamBearer}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL_ID,
        input: `Reply with exactly ${preLeaseSentinel}.`,
      }),
      signal: AbortSignal.timeout(60_000),
    },
  );
  const preLeaseAgentPendingResponse = await enqueuePendingQueueV2({
    baseUrl: runtime.server.baseUrl,
    token: runtime.auth.token,
    sessionId,
    localId: preLeaseAgentPendingLocalId,
    ciphertext: encryptLegacyBase64({
      role: 'user',
      content: {
        type: 'text',
        text: `Reply with exactly ${preLeaseAgentSentinel}.`,
      },
      localId: preLeaseAgentPendingLocalId,
      meta: {
        source: 'ui',
        sentFrom: 'packed-managed-continuity-publication-gap',
      },
    }, runtime.accountSecret),
    messageRole: 'user',
    timeoutMs: 30_000,
  });
  assert(
    preLeaseAgentPendingResponse.status === 200,
    'packed_managed_provider_publication_gap_pending_enqueue_failed',
  );
  await Promise.all([
    preLeaseManagedHold.started,
    preLeaseAgentHold.started,
  ]);
  const preLeaseReplacement = await observeReplacement({
    runtime,
    sessionId,
    marker: graceful.marker,
    config,
    previousCapabilities: graceful.capabilities,
    previousDaemonPid: graceful.state.pid,
    startupSessionCreateCount,
    replace: async () => {
      const crashTarget = await processIdentity(graceful.state.pid);
      assert(
        exactProcessIdentity(crashTarget, graceful.daemon),
        'packed_managed_provider_pre_lease_daemon_identity_changed',
      );
      process.kill(graceful.state.pid, 'SIGKILL');
      await waitForProcessExit(graceful.state.pid);
      await runCandidateCommand({
        runtime,
        prepared,
        args: ['daemon', 'start-sync', '--takeover'],
        waitForExit: false,
      });
    },
    afterAuthorityObserved: async ({ capabilities: replacement }) => {
      preLeaseTupleChangedBeforeRefusal =
        replacement.managed.capability
        !== graceful.capabilities.managed.capability;
      preLeaseManagedHold.release();
      preLeaseAgentHold.release();
      const response = await preLeaseResponsePromise;
      preLeaseResponseStatus = response.status;
      await response.body?.cancel();
      await Promise.all([
        preLeaseManagedHold.completed,
        preLeaseAgentHold.completed,
      ]);
      await waitFor(async () => {
        const [messages, pending, session] = await Promise.all([
          fetchAllMessages(
            runtime.server.baseUrl,
            runtime.auth.token,
            sessionId,
          ),
          listPendingQueueV2({
            baseUrl: runtime.server.baseUrl,
            token: runtime.auth.token,
            sessionId,
          }),
          fetchSessionV2(
            runtime.server.baseUrl,
            runtime.auth.token,
            sessionId,
          ),
        ]);
        preLeaseAgentCommittedLocalIdCount = messages
          .filter((message) =>
            message.localId === preLeaseAgentPendingLocalId)
          .length;
        preLeaseAgentTurnFailedCount = messages
          .filter((message) => message.seq > messageSeqBeforePreLeaseCrash)
          .map((message) =>
            decryptLegacyBase64(
              message.content.c,
              runtime.accountSecret,
            ))
          .filter(isTurnFailedTranscriptMessage)
          .length;
        preLeaseAgentLatestTurnStatus = session.latestTurnStatus;
        const preview =
          session.lastRuntimeIssue?.sanitizedPreview?.toLowerCase() ?? '';
        preLeaseAgentTransportUnavailableObserved =
          preview.includes('request_auth_unavailable')
          || /\b503\b/u.test(preview);
        return preLeaseAgentCommittedLocalIdCount === 1
          && pending.status === 200
          && Array.isArray(pending.data.pending)
          && pending.data.pending.length === 0
          && preLeaseAgentTurnFailedCount === 1
          && preLeaseAgentLatestTurnStatus === 'failed'
          && preLeaseAgentTransportUnavailableObserved;
      }, {
        timeoutMs: 60_000,
        intervalMs: 100,
        context: 'ordinary Agent publication-gap Pending failure',
      });
      const gapEntries = runtime.brokerProxy.entries()
        .filter((entry) => entry.purpose !== null);
      const managedGapEntries = gapEntries.filter((entry) =>
          entry.purpose?.consumer.pluginId
            === OPENAI_PURPOSE.consumer.pluginId
          && entry.purpose.consumer.localId
            === OPENAI_PURPOSE.consumer.localId
          && entry.purpose.purpose === OPENAI_PURPOSE.purpose);
      const agentGapEntries = gapEntries.filter((entry) =>
        entry.purpose?.consumer.pluginId
          === OPENCODE_PURPOSE.consumer.pluginId
        && entry.purpose.consumer.localId
          === OPENCODE_PURPOSE.consumer.localId
        && entry.purpose.purpose === OPENCODE_PURPOSE.purpose);
      preLeaseManagedBrokerAttemptCount = managedGapEntries.length;
      preLeaseManagedBrokerUnauthorizedCount =
        managedGapEntries.filter((entry) => entry.status === 401).length;
      preLeaseAgentBrokerAttemptCount = agentGapEntries.length;
      preLeaseAgentBrokerUnauthorizedCount =
        agentGapEntries.filter((entry) => entry.status === 401).length;
      preLeaseUpstreamEffectCount = runtime.connectProxy.entries()
        .filter((entry) =>
          entry.body.includes(preLeaseSentinel)
          || entry.body.includes(preLeaseAgentSentinel))
        .length;
      preLeaseReplayAttemptCount = Math.max(
        0,
        gapEntries.length - 2,
      );
    },
  }).finally(() => {
    preLeaseManagedHold.release();
    preLeaseAgentHold.release();
  });
  const preLeaseRotation = capabilityRotationEvidence({
    previous: graceful.capabilities,
    replacement: preLeaseReplacement,
  });
  assert(
    preLeaseReplacement.oldLookups.managed.status === 401
      && preLeaseReplacement.freshLookups.managed.status === 200
      && preLeaseReplacement.oldLookups.agent.status === 401
      && preLeaseReplacement.freshLookups.agent.status === 200
      && preLeaseResponseStatus !== null
      && preLeaseUpstreamEffectCount === 0
      && preLeaseReplayAttemptCount === 0,
    'packed_managed_provider_pre_lease_replacement_mismatch',
  );

  const unexpectedPreviousPid = preLeaseReplacement.state.pid;
  const heldAfterLeaseSentinel =
    `packed-managed-held-after-lease:${randomUUID()}`;
  const heldAfterLease =
    runtime.connectProxy.holdNextRequestBodyContaining(
      heldAfterLeaseSentinel,
    );
  let heldAfterLeaseUpstreamAttempts = 0;
  let heldAfterLeaseAuthorizationFingerprintMatched = false;
  let heldAfterLeaseResponseCompletedAfterCrash = false;
  let heldAfterLeaseReplayAttempts = 0;
  void heldAfterLease.completed.then(() => {
    heldAfterLeaseResponseCompletedAfterCrash = true;
  });
  const unexpected = await observeReplacement({
    runtime,
    sessionId,
    marker: preLeaseReplacement.marker,
    config,
    previousCapabilities: preLeaseReplacement.capabilities,
    previousDaemonPid: unexpectedPreviousPid,
    startupSessionCreateCount,
    replace: async () => {
      try {
        await postEncryptedUiTextMessage({
          baseUrl: runtime.server.baseUrl,
          token: runtime.auth.token,
          sessionId,
          secret: runtime.accountSecret,
          text: `Reply with exactly ${heldAfterLeaseSentinel}.`,
          timeoutMs: 30_000,
        });
        await waitFor(() =>
          runtime.connectProxy.entries().some((entry) =>
            entry.body.includes(heldAfterLeaseSentinel)), {
          timeoutMs: 30_000,
          intervalMs: 20,
          context: 'managed held-after-lease upstream attempt',
        });
        const heldEntries = runtime.connectProxy.entries()
          .filter((entry) => entry.body.includes(heldAfterLeaseSentinel));
        heldAfterLeaseUpstreamAttempts = heldEntries.length;
        heldAfterLeaseAuthorizationFingerprintMatched =
          heldEntries.length === 1
          && typeof preLeaseReplacement.freshLookups.managed
            .accessTokenFingerprint === 'string'
          && heldEntries[0]?.authorizationFingerprint
            === preLeaseReplacement.freshLookups.managed
              .accessTokenFingerprint;
        assert(
          heldAfterLeaseUpstreamAttempts === 1
            && heldAfterLeaseAuthorizationFingerprintMatched,
          'packed_managed_provider_held_after_lease_not_authorized_once',
        );

        const crashTarget = await processIdentity(unexpectedPreviousPid);
        assert(
          exactProcessIdentity(crashTarget, preLeaseReplacement.daemon),
          'packed_managed_provider_unexpected_daemon_identity_changed',
        );
        process.kill(unexpectedPreviousPid, 'SIGKILL');
        await waitForProcessExit(unexpectedPreviousPid);
        assert(
          isProcessAlive(marker.pid)
            && isProcessAlive(
              marker.managedLocalServiceRunAttachment.process.pid,
            ),
          'packed_managed_provider_crash_killed_surviving_process',
        );
        heldAfterLease.release();
        await waitFor(() => heldAfterLeaseResponseCompletedAfterCrash, {
          timeoutMs: 30_000,
          intervalMs: 20,
          context: 'managed held-after-lease response completion',
        });
        await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
        heldAfterLeaseReplayAttempts = Math.max(
          0,
          runtime.connectProxy.entries()
            .filter((entry) =>
              entry.body.includes(heldAfterLeaseSentinel))
            .length - 1,
        );
        assert(
          heldAfterLeaseReplayAttempts === 0,
          'packed_managed_provider_held_after_lease_replayed',
        );

        // Everything recorded before this clear belongs to the one
        // already-authorized attempt. Subsequent entries are replacement
        // startup/replay effects and must remain absent.
        runtime.connectProxy.clear();
        await runCandidateCommand({
          runtime,
          prepared,
          args: ['daemon', 'start-sync', '--takeover'],
          waitForExit: false,
        });
      } finally {
        heldAfterLease.release();
      }
    },
  });
  const unexpectedRotation = capabilityRotationEvidence({
    previous: preLeaseReplacement.capabilities,
    replacement: unexpected,
  });
  assert(
    unexpected.oldLookups.managed.status === 401
      && unexpected.oldLookups.managed.errorCode === 'request_auth_unauthorized'
      && unexpected.freshLookups.managed.status === 200
      && unexpected.oldLookups.agent.status === 401
      && unexpected.oldLookups.agent.errorCode === 'request_auth_unauthorized'
      && unexpected.freshLookups.agent.status === 200,
    'packed_managed_provider_unexpected_capability_rotation_failed',
  );
  const unexpectedWrapperHealthy =
    await wrapperHealthStatus(unexpected.marker) === 200;
  assert(
    sameExecutablePath(
      unexpected.daemon.executablePath,
      prepared.prepared.standaloneCliArtifact.executablePath,
    )
      && exactProcessIdentity(unexpected.agent, initialAgent)
      && exactProcessIdentity(unexpected.wrapper, initialWrapper)
      && unexpected.marker.processCommandHash === marker.processCommandHash
      && exactAttachment(
        marker.managedLocalServiceRunAttachment,
        unexpected.marker.managedLocalServiceRunAttachment,
      )
      && unexpectedWrapperHealthy
      && unexpected.capabilityInvalidReadCount === 0
      && unexpected.startupUpstreamAttempts === 0
      && unexpected.startupSessionCreates === 0
      && heldAfterLeaseUpstreamAttempts === 1
      && heldAfterLeaseAuthorizationFingerprintMatched
      && heldAfterLeaseResponseCompletedAfterCrash
      && heldAfterLeaseReplayAttempts === 0,
    'packed_managed_provider_unexpected_continuity_mismatch',
  );

  await waitFor(async () => {
    const session = await fetchSessionV2(
      runtime.server.baseUrl,
      runtime.auth.token,
      sessionId,
    );
    return session.latestTurnStatus !== 'in_progress';
  }, {
    timeoutMs: 30_000,
    intervalMs: 100,
    context: 'managed post-reattach surviving Agent idle',
  });
  const messagesBeforeCanary = await fetchAllMessages(
    runtime.server.baseUrl,
    runtime.auth.token,
    sessionId,
  );
  const messageSeqBeforeCanary = Math.max(
    0,
    ...messagesBeforeCanary.map((message) => message.seq),
  );
  runtime.connectProxy.clear();
  runtime.brokerProxy.clear();
  const canarySentinel = `packed-managed-post-reattach:${randomUUID()}`;
  const canaryFailure =
    runtime.connectProxy.holdNextRequestBodyContaining(canarySentinel);
  const pendingLocalId = `pending-after-replacement:${randomUUID()}`;
  const pendingMessage = {
    role: 'user',
    content: {
      type: 'text',
      text: `Reply with exactly ${canarySentinel}.`,
    },
    localId: pendingLocalId,
    meta: {
      source: 'ui',
      sentFrom: 'packed-managed-continuity',
    },
  };
  const pendingResponse = await enqueuePendingQueueV2({
    baseUrl: runtime.server.baseUrl,
    token: runtime.auth.token,
    sessionId,
    localId: pendingLocalId,
    ciphertext: encryptLegacyBase64(
      pendingMessage,
      runtime.accountSecret,
    ),
    messageRole: 'user',
    timeoutMs: 30_000,
  });
  assert(
    pendingResponse.status === 200,
    'packed_managed_provider_post_reattach_pending_enqueue_failed',
  );
  await waitFor(async () =>
    runtime.connectProxy.entries().some((entry) =>
      entry.body.includes(canarySentinel)), {
    timeoutMs: 30_000,
    intervalMs: 20,
    context: 'managed post-reattach isolated canary',
  });
  canaryFailure.release();
  await canaryFailure.completed;
  const canaryEntries = runtime.connectProxy.entries()
    .filter((entry) => entry.body.includes(canarySentinel));
  let committedLocalIdCount = 0;
  let latestTurnStatus:
    PackedManagedProviderContinuityContractEvidence['idleNextInput']['latestTurnStatus']
    = null;
  let canaryTurnFailedCount = 0;
  await waitFor(async () => {
    const [messages, pending, session] = await Promise.all([
      fetchAllMessages(
        runtime.server.baseUrl,
        runtime.auth.token,
        sessionId,
      ),
      listPendingQueueV2({
        baseUrl: runtime.server.baseUrl,
        token: runtime.auth.token,
        sessionId,
      }),
      fetchSessionV2(
        runtime.server.baseUrl,
        runtime.auth.token,
        sessionId,
      ),
    ]);
    committedLocalIdCount = messages
      .filter((message) => message.localId === pendingLocalId).length;
    canaryTurnFailedCount = messages
      .filter((message) => message.seq > messageSeqBeforeCanary)
      .map((message) =>
        decryptLegacyBase64(message.content.c, runtime.accountSecret))
      .filter(isTurnFailedTranscriptMessage)
      .length;
    latestTurnStatus = session.latestTurnStatus;
    return committedLocalIdCount === 1
      && pending.status === 200
      && Array.isArray(pending.data.pending)
      && pending.data.pending.length === 0
      && latestTurnStatus === 'failed'
      && canaryTurnFailedCount === 1;
  }, {
    timeoutMs: 60_000,
    intervalMs: 100,
    context: 'managed post-reattach Pending settlement',
  });
  const canaryBrokerEntries = runtime.brokerProxy.entries();
  const agentBrokerEntries = canaryBrokerEntries.filter((entry) =>
    entry.purpose?.consumer.pluginId === OPENCODE_PURPOSE.consumer.pluginId
    && entry.purpose.consumer.localId === OPENCODE_PURPOSE.consumer.localId
    && entry.purpose.purpose === OPENCODE_PURPOSE.purpose);
  const managedBrokerEntries = canaryBrokerEntries.filter((entry) =>
    entry.purpose?.consumer.pluginId === OPENAI_PURPOSE.consumer.pluginId
    && entry.purpose.consumer.localId === OPENAI_PURPOSE.consumer.localId
    && entry.purpose.purpose === OPENAI_PURPOSE.purpose);
  const canaryBrokerUnauthorizedCount = canaryBrokerEntries
    .filter((entry) => entry.status === 401).length;
  const canaryCurrentCapabilityDaemonTupleUsed =
    agentBrokerEntries.length === 1
    && agentBrokerEntries[0]?.capabilityFingerprint
      === fingerprintSecret(unexpected.capabilities.agent.capability)
    && managedBrokerEntries.length === 1
    && managedBrokerEntries[0]?.capabilityFingerprint
      === fingerprintSecret(unexpected.capabilities.managed.capability);
  assert(
    canaryEntries.length === 1
      && canaryEntries[0]?.authorizationFingerprint
        === unexpected.freshLookups.managed.accessTokenFingerprint
      && committedLocalIdCount === 1,
    'packed_managed_provider_post_reattach_canary_mismatch',
  );
  const contract: PackedManagedProviderContinuityContractEvidence = {
    gracefulTakeover: gracefulRotation,
    preLeaseCrash: {
      replacement: preLeaseRotation,
      responseStatus: preLeaseResponseStatus ?? 0,
      managedBrokerAttemptCount: preLeaseManagedBrokerAttemptCount,
      managedBrokerUnauthorizedCount:
        preLeaseManagedBrokerUnauthorizedCount,
      agentBrokerAttemptCount: preLeaseAgentBrokerAttemptCount,
      agentBrokerUnauthorizedCount:
        preLeaseAgentBrokerUnauthorizedCount,
      agentPendingLocalId: preLeaseAgentPendingLocalId,
      agentCommittedLocalIdCount:
        preLeaseAgentCommittedLocalIdCount,
      agentTurnFailedCount: preLeaseAgentTurnFailedCount,
      agentLatestTurnStatus: preLeaseAgentLatestTurnStatus,
      agentTransportUnavailableObserved:
        preLeaseAgentTransportUnavailableObserved,
      agentFailedTurnFalselyCompleted:
        preLeaseAgentTurnFailedCount > 0
        && preLeaseAgentLatestTurnStatus === 'completed',
      upstreamEffectCount: preLeaseUpstreamEffectCount,
      replayAttemptCount: preLeaseReplayAttemptCount,
      tupleChangedBeforeRefusal: preLeaseTupleChangedBeforeRefusal,
    },
    postLeaseCrash: {
      replacement: unexpectedRotation,
      upstreamAttemptCount: heldAfterLeaseUpstreamAttempts,
      authorizationFingerprintMatched:
        heldAfterLeaseAuthorizationFingerprintMatched,
      responseCompletedAfterCrash:
        heldAfterLeaseResponseCompletedAfterCrash,
      replayAttemptCount: heldAfterLeaseReplayAttempts,
    },
    idleNextInput: {
      pendingLocalId,
      committedLocalIdCount,
      upstreamAttemptCount: canaryEntries.length,
      agentBrokerStatuses:
        agentBrokerEntries.map((entry) => entry.status),
      managedBrokerStatuses:
        managedBrokerEntries.map((entry) => entry.status),
      brokerUnauthorizedCount: canaryBrokerUnauthorizedCount,
      replayAttemptCount: Math.max(0, canaryEntries.length - 1),
      turnFailedCount: canaryTurnFailedCount,
      latestTurnStatus,
      failedTurnFalselyCompleted:
        canaryTurnFailedCount > 0 && latestTurnStatus === 'completed',
      currentCapabilityDaemonTupleUsed:
        canaryCurrentCapabilityDaemonTupleUsed,
    },
  };
  assertPackedManagedProviderContinuityContract(contract);

  await daemonControlPostJson({
    port: unexpected.state.httpPort,
    path: '/stop-session',
    controlToken: unexpected.state.controlToken,
    body: { sessionId },
    timeoutMs: 60_000,
  });
  await waitFor(async () =>
    !isProcessAlive(marker.pid)
      && !isProcessAlive(
        marker.managedLocalServiceRunAttachment.process.pid,
      )
      && !(await pathExists(marker.path))
      && !(await pathExists(config.requestAuth.capabilityPath))
      && !(await pathExists(
        marker.managedLocalServiceRunAttachment.materialization.rootDir,
      )), {
    timeoutMs: 60_000,
    intervalMs: 100,
    context: 'managed continuity permanent cleanup',
  });

  return {
    sessionId,
    contract,
    initial: {
      daemon: processIdentityEvidence(initialDaemon),
      agent: processIdentityEvidence(initialAgent),
      wrapper: processIdentityEvidence(initialWrapper),
      attachment: marker.managedLocalServiceRunAttachment,
      materializationId: config.materializationId,
      managedCapabilityPath: capabilities.managed.path,
      agentCapabilityPath: capabilities.agent.path,
      capabilityFingerprint:
        fingerprintSecret(capabilities.managed.capability),
      agentCapabilityFingerprint:
        fingerprintSecret(capabilities.agent.capability),
    },
    gracefulTakeover: {
      daemon: processIdentityEvidence(graceful.daemon),
      agent: processIdentityEvidence(graceful.agent),
      wrapper: processIdentityEvidence(graceful.wrapper),
      sameAgentPid: graceful.marker.pid === marker.pid,
      sameWrapperPid:
        graceful.marker.managedLocalServiceRunAttachment.process.pid
        === marker.managedLocalServiceRunAttachment.process.pid,
      sameAttachment: exactAttachment(
        marker.managedLocalServiceRunAttachment,
        graceful.marker.managedLocalServiceRunAttachment,
      ),
      wrapperHealthy: gracefulWrapperHealthy,
      capabilityRotated:
        graceful.capabilities.managed.capability
        !== capabilities.managed.capability,
      oldCapabilityStatus: graceful.oldLookups.managed.status,
      freshCapabilityStatus: graceful.freshLookups.managed.status,
      capabilityInvalidReadCount: graceful.capabilityInvalidReadCount,
      startupUpstreamAttempts: graceful.startupUpstreamAttempts,
      startupSessionCreates: graceful.startupSessionCreates,
    },
    unexpectedReplacement: {
      daemon: processIdentityEvidence(unexpected.daemon),
      agent: processIdentityEvidence(unexpected.agent),
      wrapper: processIdentityEvidence(unexpected.wrapper),
      sameAgentPid: unexpected.marker.pid === marker.pid,
      sameWrapperPid:
        unexpected.marker.managedLocalServiceRunAttachment.process.pid
        === marker.managedLocalServiceRunAttachment.process.pid,
      sameAttachment: exactAttachment(
        marker.managedLocalServiceRunAttachment,
        unexpected.marker.managedLocalServiceRunAttachment,
      ),
      wrapperHealthy: unexpectedWrapperHealthy,
      capabilityRotated:
        unexpected.capabilities.managed.capability
        !== preLeaseReplacement.capabilities.managed.capability,
      oldCapabilityStatus: unexpected.oldLookups.managed.status,
      freshCapabilityStatus: unexpected.freshLookups.managed.status,
      capabilityInvalidReadCount: unexpected.capabilityInvalidReadCount,
      startupUpstreamAttempts: unexpected.startupUpstreamAttempts,
      startupSessionCreates: unexpected.startupSessionCreates,
      authorityGapRequestStatus: preLeaseResponseStatus ?? 0,
      heldAfterLeaseUpstreamAttempts,
      heldAfterLeaseAuthorizationFingerprintMatched,
      heldAfterLeaseResponseCompletedAfterCrash,
      heldAfterLeaseReplayAttempts,
    },
    canary: {
      submittedThroughSurvivingAgent: true,
      upstreamAttemptCount: canaryEntries.length,
      authorizationFingerprintMatched:
        canaryEntries.length === 1
        && canaryEntries[0]?.authorizationFingerprint
          === unexpected.freshLookups.managed.accessTokenFingerprint,
      promptSentinelObserved:
        canaryEntries.length === 1
        && canaryEntries[0]!.body.includes(canarySentinel),
    },
    permanentCleanup: {
      agentExited: !isProcessAlive(marker.pid),
      wrapperExited:
        !isProcessAlive(
          marker.managedLocalServiceRunAttachment.process.pid,
        ),
      markerAbsent: !(await pathExists(marker.path)),
      capabilityAbsent:
        !(await pathExists(config.requestAuth.capabilityPath)),
      materializationAbsent:
        !(await pathExists(
          marker.managedLocalServiceRunAttachment.materialization.rootDir,
        )),
    },
  };
}

export type PackedManagedProviderRecoveryRefusalObservation = Readonly<{
  sessionId: string;
  daemon: ManagedProcessIdentityEvidence;
  agent: ManagedProcessIdentityEvidence;
  wrapper: ManagedProcessIdentityEvidence;
  agentStayedExact: boolean;
  wrapperStayedExact: boolean;
  wrapperStayedHealthy: boolean;
  wrapperWasNotReplaced: boolean;
  singleTrackedSession: boolean;
  capabilityWasNotRotated: boolean;
  staleCapabilityStatus: number;
  staleCapabilityErrorCode: string | null;
  wrapperRefusalStatus: number;
  daemonRemainedAvailable: boolean;
  startupUpstreamAttempts: number;
  startupSessionCreates: number;
  typedRecoveryFailureObserved: boolean;
  agentExitedAfterExplicitCleanup: boolean;
  productDidNotKillUnprovedWrapper: boolean;
  guardedFixtureCleanup: Readonly<{
    wrapperIdentityReverified: boolean;
    wrapperExited: boolean;
    markerAbsent: boolean;
    capabilityAbsent: boolean;
    materializationAbsent: boolean;
  }>;
}>;

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  const temporaryPath = `${path}.continuity-qa-${randomUUID()}`;
  await writeFile(temporaryPath, `${JSON.stringify(value)}\n`, {
    mode: 0o600,
  });
  await rename(temporaryPath, path);
}

async function readManagedRecoveryFailureFromLogs(
  happyHomeDir: string,
): Promise<boolean> {
  const paths = await listFilesRecursively(join(happyHomeDir, 'logs'));
  for (const path of paths) {
    if (!path.endsWith('.log')) continue;
    const text = await readFile(path, 'utf8').catch(() => '');
    if (
      text.includes('runtime_reattach_failed')
      && text.includes('process_identity_mismatch')
    ) {
      return true;
    }
  }
  return false;
}

async function terminateExactFixtureProcess(
  identity: ObservedManagedProcessIdentity,
): Promise<void> {
  if (!isProcessAlive(identity.pid)) return;
  assert(
    exactProcessIdentity(await processIdentity(identity.pid), identity),
    'packed_managed_provider_fixture_process_identity_changed',
  );
  process.kill(identity.pid, 'SIGTERM');
  await waitForProcessExit(identity.pid, 10_000).catch(async () => {
    assert(
      exactProcessIdentity(await processIdentity(identity.pid), identity),
      'packed_managed_provider_fixture_process_identity_changed',
    );
    process.kill(identity.pid, 'SIGKILL');
    await waitForProcessExit(identity.pid, 10_000);
  });
}

async function cleanupRecoveryRefusalFixture(input: Readonly<{
  runtime: InitializedRuntime;
  sessionId: string;
  marker: SessionMarker;
  config: ManagedConfig;
  originalMarker: unknown;
  agent: ObservedManagedProcessIdentity;
  wrapper: ObservedManagedProcessIdentity;
}>): Promise<void> {
  const errors: unknown[] = [];
  const attempt = async (operation: () => Promise<void>): Promise<void> => {
    try {
      await operation();
    } catch (error) {
      errors.push(error);
    }
  };
  await attempt(async () => {
    await writeJsonAtomically(input.marker.path, input.originalMarker);
  });
  await attempt(async () => {
    const daemon = await readDaemonState(input.runtime.happyHomeDir);
    if (!daemon || !isProcessAlive(daemon.pid)) return;
    await daemonControlPostJson({
      port: daemon.httpPort,
      path: '/stop-session',
      controlToken: daemon.controlToken,
      body: { sessionId: input.sessionId },
      timeoutMs: 10_000,
    });
  });
  await attempt(async () => {
    await terminateExactFixtureProcess(input.agent);
  });
  await attempt(async () => {
    await terminateExactFixtureProcess(input.wrapper);
  });
  await attempt(async () => {
    await Promise.all([
      rm(input.marker.managedLocalServiceRunAttachment.materialization.rootDir, {
        recursive: true,
        force: true,
      }),
      rm(input.marker.path, { force: true }),
      rm(input.config.requestAuth.capabilityPath, { force: true }),
    ]);
  });
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      'packed managed recovery-refusal fixture cleanup failed',
    );
  }
}

export async function probePackedManagedProviderRecoveryRefusal(
  runtime: InitializedRuntime,
  prepared: PackedManagedProviderPreparedInput,
): Promise<PackedManagedProviderRecoveryRefusalObservation> {
  const currentState = await readDaemonState(runtime.happyHomeDir);
  assert(
    currentState && isProcessAlive(currentState.pid),
    'packed_managed_provider_refusal_daemon_missing',
  );
  const initialDaemon = await processIdentity(currentState.pid);
  assert(
    sameExecutablePath(
      initialDaemon.executablePath,
      prepared.prepared.standaloneCliArtifact.executablePath,
    ),
    'packed_managed_provider_refusal_daemon_identity_mismatch',
  );
  runtime.connectProxy.clear();
  const request = spawnRequest(runtime);
  const {
    pendingFirstInput: _omittedPendingFirstInput,
    ...idleSpawnBody
  } = request.body;
  const spawnResponse = await daemonControlPostJson<{
    success?: boolean;
    sessionId?: string;
  }>({
    port: currentState.httpPort,
    path: '/spawn-session',
    controlToken: currentState.controlToken,
    body: idleSpawnBody,
    timeoutMs: 150_000,
  });
  assert(
    spawnResponse.status === 200
      && spawnResponse.data?.success === true
      && typeof spawnResponse.data.sessionId === 'string',
    'packed_managed_provider_refusal_spawn_failed',
  );
  const sessionId = spawnResponse.data.sessionId;
  const marker = await waitForCanonicalMarker(runtime, sessionId);
  const config = await readManagedConfig(marker);
  const capability = await readCapability(
    config.requestAuth.capabilityPath,
  );
  const [initialAgent, initialWrapper] = await Promise.all([
    processIdentity(marker.pid),
    processIdentity(
      marker.managedLocalServiceRunAttachment.process.pid,
    ),
  ]);
  assert(
    marker.processStartTimeMs === initialAgent.processStartTimeMs
      && marker.managedLocalServiceRunAttachment.process.processStartTimeMs
        === initialWrapper.processStartTimeMs
      && /^[0-9a-f]{64}$/u.test(marker.processCommandHash)
      && /^[0-9a-f]{64}$/u.test(
        marker.managedLocalServiceRunAttachment.process.processCommandHash,
      ),
    'packed_managed_provider_refusal_initial_identity_mismatch',
  );
  const startupSessionCreateCount =
    runtime.serverProxy.count(isSessionCreationRequest);
  const originalMarker = JSON.parse(await readFile(marker.path, 'utf8')) as {
    managedLocalServiceRunAttachment?: {
      process?: { processCommandHash?: unknown };
    };
  };
  assert(
    originalMarker.managedLocalServiceRunAttachment?.process
      ?.processCommandHash
      === marker.managedLocalServiceRunAttachment.process.processCommandHash,
    'packed_managed_provider_refusal_marker_identity_missing',
  );
  const corruptedMarker = structuredClone(originalMarker);
  corruptedMarker.managedLocalServiceRunAttachment!.process!
    .processCommandHash = '0'.repeat(64);
  await writeJsonAtomically(marker.path, corruptedMarker);
  try {
    runtime.connectProxy.clear();

    const crashTarget = await processIdentity(currentState.pid);
    assert(
      exactProcessIdentity(crashTarget, initialDaemon),
      'packed_managed_provider_refusal_daemon_identity_changed',
    );
    process.kill(currentState.pid, 'SIGKILL');
    await waitForProcessExit(currentState.pid);
    assert(
      isProcessAlive(marker.pid)
        && isProcessAlive(
          marker.managedLocalServiceRunAttachment.process.pid,
        ),
      'packed_managed_provider_refusal_crash_killed_fixture',
    );
    await runCandidateCommand({
      runtime,
      prepared,
      args: ['daemon', 'start-sync', '--takeover'],
      waitForExit: false,
      env: { DEBUG: '1' },
    });
    const replacement = await waitForReplacementDaemon(
      runtime,
      currentState.pid,
    );
    runtime.stockPortObserver.observeOwnedProcess(replacement.pid);
    const staleLookup = await lookupRequestAuth({
      state: replacement,
      capability: capability.capability,
      purpose: OPENAI_PURPOSE,
    });
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
    const capabilityAfterFailure = await readCapability(
      config.requestAuth.capabilityPath,
    );
    const [finalAgentIdentity, finalWrapperIdentity] = await Promise.all([
      processIdentity(marker.pid),
      processIdentity(
        marker.managedLocalServiceRunAttachment.process.pid,
      ),
    ]);
    const agentStayedExact =
      exactProcessIdentity(finalAgentIdentity, initialAgent);
    const wrapperStayedExact =
      exactProcessIdentity(finalWrapperIdentity, initialWrapper);
    const wrapperStayedHealthy =
      await wrapperHealthStatus(marker) === 200;
    const wrapperWasNotReplaced = wrapperStayedExact;
    const refusalSentinel =
      `packed-managed-recovery-refusal:${randomUUID()}`;
    const wrapperRefusal = await fetch(
      `http://127.0.0.1:${marker.managedLocalServiceRunAttachment.endpoint.port}/v1/responses`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.gateway.downstreamBearer}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: MODEL_ID,
          input: `Reply with exactly ${refusalSentinel}.`,
        }),
        signal: AbortSignal.timeout(30_000),
      },
    );
    await wrapperRefusal.body?.cancel();
    const daemonList = await daemonControlPostJson<{
      children?: readonly Readonly<{
        happySessionId?: unknown;
        pid?: unknown;
      }>[];
    }>({
      port: replacement.httpPort,
      path: '/list',
      controlToken: replacement.controlToken,
      body: {},
      timeoutMs: 5_000,
    }).catch(() => ({ status: 0, data: null }));
    const listedSessionChildren = daemonList.data?.children?.filter(
      (child) => child.happySessionId === sessionId,
    ) ?? [];
    const sessionMarkers = (await readSessionMarkers(runtime.happyHomeDir))
      .filter((candidate) => candidate.happySessionId === sessionId);
    const singleTrackedSession =
      listedSessionChildren.length === 1
      && listedSessionChildren[0]?.pid === marker.pid
      && sessionMarkers.length === 1
      && sessionMarkers[0]?.path === marker.path;
    const typedRecoveryFailureObserved =
      await readManagedRecoveryFailureFromLogs(runtime.happyHomeDir);
    const stockNetwork = await runtime.stockPortObserver.snapshot();
    const startupSessionCreates =
      runtime.serverProxy.count(isSessionCreationRequest)
      - startupSessionCreateCount;
    assert(
      agentStayedExact
        && wrapperStayedExact
        && wrapperStayedHealthy
        && wrapperWasNotReplaced
        && singleTrackedSession
        && capabilityAfterFailure.capability === capability.capability
        && staleLookup.status === 401
        && staleLookup.errorCode === 'request_auth_unauthorized'
        && wrapperRefusal.status >= 400
        && daemonList.status === 200
        && runtime.connectProxy.entries().length === 0
        && startupSessionCreates === 0
        && typedRecoveryFailureObserved
        && stockNetwork.ownedConnectionAttemptCount === 0,
      'packed_managed_provider_refusal_scope_mismatch',
    );

    // Restore only the isolated marker bytes so the session owner can stop its
    // runner normally. Recovery is intentionally not retried on this daemon.
    await writeJsonAtomically(marker.path, originalMarker);
    await daemonControlPostJson({
      port: replacement.httpPort,
      path: '/stop-session',
      controlToken: replacement.controlToken,
      body: { sessionId },
      timeoutMs: 60_000,
    }).catch(() => ({ status: 0, data: null }));
    await waitFor(() => !isProcessAlive(marker.pid), {
      timeoutMs: 60_000,
      intervalMs: 100,
      context: 'managed recovery-refusal Agent cleanup',
    });
    const productDidNotKillUnprovedWrapper =
      isProcessAlive(initialWrapper.pid);

    // This process is deliberately outside the replacement daemon's ownership
    // after proof refusal. The harness therefore performs an exact PID/start/
    // command recheck before test-fixture cleanup; no PID-only kill is allowed.
    const wrapperIdentityReverified =
      productDidNotKillUnprovedWrapper
      && exactProcessIdentity(
        await processIdentity(initialWrapper.pid),
        initialWrapper,
      );
    assert(
      productDidNotKillUnprovedWrapper && wrapperIdentityReverified,
      'packed_managed_provider_refusal_fixture_cleanup_guard_failed',
    );
    await terminateExactFixtureProcess(initialWrapper);
    await Promise.all([
      rm(marker.managedLocalServiceRunAttachment.materialization.rootDir, {
        recursive: true,
        force: true,
      }),
      rm(marker.path, { force: true }),
      rm(config.requestAuth.capabilityPath, { force: true }),
    ]);
    const guardedFixtureCleanup = {
      wrapperIdentityReverified,
      wrapperExited: !isProcessAlive(initialWrapper.pid),
      markerAbsent: !(await pathExists(marker.path)),
      capabilityAbsent:
        !(await pathExists(config.requestAuth.capabilityPath)),
      materializationAbsent:
        !(await pathExists(
          marker.managedLocalServiceRunAttachment.materialization.rootDir,
        )),
    };
    assert(
      Object.values(guardedFixtureCleanup).every(Boolean),
      'packed_managed_provider_refusal_fixture_cleanup_incomplete',
    );

    return {
      sessionId,
      daemon: processIdentityEvidence(
        await processIdentity(replacement.pid),
      ),
      agent: processIdentityEvidence(finalAgentIdentity),
      wrapper: processIdentityEvidence(finalWrapperIdentity),
      agentStayedExact,
      wrapperStayedExact,
      wrapperStayedHealthy,
      wrapperWasNotReplaced,
      singleTrackedSession,
      capabilityWasNotRotated:
        capabilityAfterFailure.capability === capability.capability,
      staleCapabilityStatus: staleLookup.status,
      staleCapabilityErrorCode: staleLookup.errorCode,
      wrapperRefusalStatus: wrapperRefusal.status,
      daemonRemainedAvailable: daemonList.status === 200,
      startupUpstreamAttempts: runtime.connectProxy.entries().length,
      startupSessionCreates,
      typedRecoveryFailureObserved,
      agentExitedAfterExplicitCleanup: !isProcessAlive(marker.pid),
      productDidNotKillUnprovedWrapper,
      guardedFixtureCleanup,
    };
  } catch (error) {
    try {
      await cleanupRecoveryRefusalFixture({
        runtime,
        sessionId,
        marker,
        config,
        originalMarker,
        agent: initialAgent,
        wrapper: initialWrapper,
      });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'packed managed recovery-refusal probe and cleanup failed',
      );
    }
    throw error;
  }
}

async function sabotageCapabilityParent(capabilityPath: string): Promise<void> {
  const parent = dirname(capabilityPath);
  const displaced = `${parent}.packed-displaced-${randomUUID()}`;
  if (await pathExists(parent)) {
    await rename(parent, displaced);
  }
  await writeFile(parent, 'activation must fail closed', { mode: 0o600 });
}

async function probeActivationFailureCleanup(
  runtime: InitializedRuntime,
): Promise<PackedManagedProviderActivationFailureObservation> {
  runtime.connectProxy.clear();
  runtime.brokerProxy.clear();
  const priorSessionCreates =
    runtime.serverProxy.count(isSessionCreationRequest);
  runtime.setSessionCreationDelay(5_000);
  const request = spawnRequest(runtime);
  const spawnPromise = daemonControlPostJson<{
    success?: boolean;
    sessionId?: string;
    error?: string;
    errorCode?: string;
  }>({
    port: runtime.daemon.state.httpPort,
    path: '/spawn-session',
    controlToken: runtime.daemon.state.controlToken,
    body: request.body,
    timeoutMs: 150_000,
  });
  const provisionalMarker = await waitForProvisionalMarker(runtime);
  runtime.stockPortObserver.observeOwnedProcess(provisionalMarker.pid);
  runtime.stockPortObserver.observeOwnedProcess(
    provisionalMarker.managedLocalServiceRunAttachment.process.pid,
  );
  await runtime.stockPortObserver.snapshot();
  const config = await readManagedConfig(provisionalMarker);
  await waitForSessionCreationDelayToEngage(runtime, priorSessionCreates);
  assert(
    await wrapperHealthStatus(provisionalMarker) === 200,
    'packed_managed_provider_failure_probe_wrapper_not_ready',
  );
  assert(
    !(await pathExists(config.requestAuth.capabilityPath)),
    'packed_managed_provider_failure_probe_capability_already_active',
  );
  assert(
    (await listAgentCapabilityPaths(
      runtime,
      config.requestAuth.capabilityPath,
    )).length === 0,
    'packed_managed_provider_failure_probe_agent_capability_already_active',
  );
  await sabotageCapabilityParent(config.requestAuth.capabilityPath);
  runtime.setSessionCreationDelay(0);
  const response = await spawnPromise.catch(() => null);
  const activationRefused =
    response === null
    || response.status >= 400
    || response.data?.success !== true;
  const cleanup = await stopSessionAndObserveCleanup({
    runtime,
    sessionId:
      response?.data?.sessionId
      ?? provisionalMarker.happySessionId,
    marker: provisionalMarker,
    agentCapabilityPath: null,
    managedCapabilityPath: config.requestAuth.capabilityPath,
    requestStop: false,
  });
  const stockNetworkAfter = await runtime.stockPortObserver.snapshot();
  const stockListenerAfter = captureStockListenerSnapshot();
  return {
    activationRefused,
    spawnAcknowledged:
      response?.status === 200 && response.data?.success === true,
    firstInputDispatched: runtime.brokerProxy.entries().length > 0,
    providerAttemptStarted:
      runtime.connectProxy.connectTargets()
        .some((target) =>
          isManagedCodexUpstreamTarget(
            target,
            runtime.managedRequestAuthOrigin,
          )),
    stockPortOsConnectionAttemptCount:
      stockNetworkAfter.ownedConnectionAttemptCount,
    stockListenerIdentityBefore: runtime.stockListenerBefore.identity,
    stockListenerIdentityAfter: stockListenerAfter.identity,
    cleanup,
  };
}

export async function startPackedManagedProviderComposedRuntime(): Promise<
Readonly<{
  probeFreshManagedSpawn(
    input: PackedManagedProviderPreparedInput,
  ): Promise<PackedManagedProviderFreshSpawnObservation>;
  probeActivationFailureCleanup(
    input: PackedManagedProviderPreparedInput,
  ): Promise<PackedManagedProviderActivationFailureObservation>;
  probeManagedDaemonContinuity(
    input: PackedManagedProviderPreparedInput,
  ): Promise<PackedManagedProviderContinuityObservation>;
  probeManagedRecoveryRefusal(
    input: PackedManagedProviderPreparedInput,
  ): Promise<PackedManagedProviderRecoveryRefusalObservation>;
  cleanup(): Promise<void>;
}>> {
  let runtime: InitializedRuntime | null = null;
  let initializedForExecutable: string | null = null;
  const requireRuntime = async (
    input: PackedManagedProviderPreparedInput,
  ): Promise<InitializedRuntime> => {
    if (
      initializedForExecutable
      && initializedForExecutable
        !== input.prepared.standaloneCliArtifact.executablePath
    ) {
      throw new Error(
        'packed_managed_provider_composed_runtime_candidate_changed',
      );
    }
    if (!runtime) {
      runtime = await initializeRuntime(input);
      initializedForExecutable =
        input.prepared.standaloneCliArtifact.executablePath;
    }
    return runtime;
  };

  return {
    probeFreshManagedSpawn: async (input) =>
      await probeFreshManagedSpawn(await requireRuntime(input)),
    probeActivationFailureCleanup: async (input) =>
      await probeActivationFailureCleanup(await requireRuntime(input)),
    probeManagedDaemonContinuity: async (input) =>
      await probePackedManagedProviderDaemonContinuity(
        await requireRuntime(input),
        input,
      ),
    probeManagedRecoveryRefusal: async (input) =>
      await probePackedManagedProviderRecoveryRefusal(
        await requireRuntime(input),
        input,
      ),
    cleanup: async () => {
      if (!runtime) return;
      const current = runtime;
      runtime = null;
      initializedForExecutable = null;
      await cleanupPackedManagedProviderRuntimeResources(current);
    },
  };
}
