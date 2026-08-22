import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import { createRunDirs } from '../../runDir';
import { startServerLight, type StartedServer } from '../../process/serverLight';
import { createTestAuth } from '../../auth';
import { createSessionWithCiphertexts, fetchMessagesSince, fetchSessionV2 } from '../../sessions';
import { envFlag } from '../../env';
import { writeTestManifestForServer } from '../../manifestForServer';
import type {
  DaemonRunnerContinuityManifestEvidence,
  DaemonRunnerLaunchEntrypointKind,
  TestManifest,
} from '../../manifest';
import { runLoggedCommand, spawnLoggedProcess, type SpawnedProcess } from '../../process/spawnProcess';
import { repoRootDir } from '../../paths';
import { decryptLegacyBase64, encryptLegacyBase64 } from '../../messageCrypto';
import { writeCliSessionAttachFile } from '../../cliAttachFile';
import { startTestDaemon, stopDaemonFromHomeDir, type StartedDaemon } from '../../daemon/daemon';
import { sleep } from '../../timing';
import { createUserScopedSocketCollector } from '../../socketClient';
import { which, yarnCommand } from '../../process/commands';
import { ensureCliDistBuilt, ensureCliSharedDepsBuilt } from '../../process/cliDist';
import {
  resolveCliTestLaunchSpec,
  shouldUseCliSourceEntrypoint,
  type CliTestLaunchSpec,
} from '../../process/cliLaunchSpec';
import { enqueuePendingQueueV2, listPendingQueueV2 } from '../../pendingQueueV2';
import { seedCliAuthForTestAccount } from '../../cliAuth';
import {
  createRuntimeLimitMeasurementCaptureFromEnv,
  recordJsonlTraceMeasurements,
} from '../../../../scripts/plugin-platform/runtime-limit-measurement.mjs';

import { runWithFlakeRetry } from './flakeRetry';
import {
  launchProviderHarnessSession,
  spawnProviderHarnessDirectProcessWithLaunchSpec,
} from './launchProviderHarnessSession';
import { providerTraceProtocolMatches } from './providerTraceProtocolMatcher';
import { resolveProviderCliSpawnSpec } from './resolveProviderCliSpawnSpec';
import { runDaemonRunnerContinuityAToBToC } from './daemonRunnerContinuity';

import type {
  ProviderContractMatrixResult,
  ProviderFixtureExamples,
  ProviderFixtures,
  ProviderScenario,
  ProviderTraceEvent,
  ProviderUnderTest,
} from '../types';
import {
  diffProviderBaseline,
  loadProviderBaseline,
  providerBaselinePath,
  selectBaselineFixtureKeysFromScenario,
  writeProviderBaseline,
} from '../baselines';
import { validateNormalizedToolFixturesV2 } from '../toolSchemas/validateToolSchemas';
import { checkMaxTraceEvents, filterImportedTraceEvents, scenarioSatisfiedByTrace } from '../satisfaction/traceSatisfaction';
import { scenarioSatisfiedByMessages } from '../satisfaction/messageSatisfaction';
import { loadProvidersFromCliSpecs } from '../specs/providerSpecs';
import { waitForAcpSidechainMessages } from '../assertions';
import { resolveProviderAuthOverlay } from './providerAuthOverlay';
import { applyCliDevTsxTsconfigEnv, applyHomeIsolationEnv } from './harnessEnv';
import { resolveAcpToolPermissionPromptExpectation } from '../permissions/acpPermissionPrompts';
import { stopOpenCodeManagedServerFromHomeDir } from '../opencode/stopOpenCodeManagedServerFromHomeDir';
import { normalizeDecodedTranscriptValue } from '../normalizeDecodedTranscriptValue';
import { registerOpenCodeManagedServerHomeForCleanup } from './opencodeManagedServerCleanupRegistry';
import { shouldPrepareProviderCliDist } from './cliDistPreparationPolicy';
import {
  buildProviderCliCommandArgs,
  buildProviderDevCommandArgs,
  resolveAllowPermissionAutoApproveInYolo as resolveAllowPermissionAutoApproveInYoloFromCommandArgs,
  resolveCodexCliPermissionArgs,
  resolveProviderModelCliArgs,
  resolveYoloCliArgs,
  resolveYoloForScenario,
} from './commandArgs';
import { formatProviderSkipWarning, resetProviderFailureReport, writeProviderFailureReport } from './failureReports';
import { parseScenarioFilter, resolveScenarioById, resolveScenariosForProvider, selectScenariosFromRegistry } from './scenarioSelection';
import {
  appendProviderTokenTelemetryEntries,
  ensureProviderTokenTelemetryEntries,
  extractProviderTokenTelemetryEntries,
  resolveProviderTokenLedgerPath,
  type ProviderTokenTelemetryEntryV1,
} from './tokenLedger';
import {
  extractProviderTerminalFailure,
  extractFatalAgentErrorMessage,
  formatProviderTerminalFailure,
  formatFatalProviderAssistantError,
  isSkippableProviderUnavailabilityError,
  readCompletedTurnId,
  readFatalProviderErrorFromCliLogs,
  resolveTaskCompleteBaselineAtStepStart,
  resolveCliDistPreflightAllowRebuild,
  resolveCliDistAvailabilityWaitMs,
  resolveCliDistBuildTimeoutMs,
  resolveScenarioWaitMs,
  resolveProviderInactivityTimeoutMs,
  resolveProviderPermissionBlockTimeoutMs,
  resolvePendingDrainTimeoutMs,
  resolveResumeSessionMode,
  resolveSessionActiveWaitMs,
  shouldEnqueueNextStepAfterSatisfaction,
  shouldStartProviderDaemon,
  shouldAssertPendingDrain,
  shouldAutoApprovePermissionRequest,
  waitForSessionActiveBestEffort,
} from './harnessSignals';

export {
  buildProviderCliCommandArgs,
  buildProviderDevCommandArgs,
  resolveCodexCliPermissionArgs,
  resolveProviderModelCliArgs,
  resolveYoloCliArgs,
  resolveYoloForScenario,
} from './commandArgs';

export {
  formatProviderSkipWarning,
  resetProviderFailureReport,
  writeProviderFailureReport,
} from './failureReports';

export {
  parseScenarioFilter,
  resolveScenarioById,
  resolveScenariosForProvider,
  selectScenariosFromRegistry,
} from './scenarioSelection';

export {
  ensureProviderTokenTelemetryEntries,
  extractProviderTokenTelemetryEntries,
  type ProviderTokenTelemetryEntryV1,
} from './tokenLedger';

export {
  extractProviderTerminalFailure,
  extractFatalAgentErrorMessage,
  formatProviderTerminalFailure,
  formatFatalProviderAssistantError,
  isSkippableProviderUnavailabilityError,
  readFatalProviderErrorFromCliLogs,
  resolveCliDistPreflightAllowRebuild,
  resolveCliDistAvailabilityWaitMs,
  resolveCliDistBuildTimeoutMs,
  resolveScenarioWaitMs,
  resolveProviderInactivityTimeoutMs,
  resolveProviderPermissionBlockTimeoutMs,
  resolvePendingDrainTimeoutMs,
  resolveResumeSessionMode,
  resolveSessionActiveWaitMs,
  shouldAssertPendingDrain,
  shouldAutoApprovePermissionRequest,
  waitForSessionActiveBestEffort,
} from './harnessSignals';

type ToolTraceEventV1 = ProviderTraceEvent;

const run = createRunDirs({ runLabel: 'providers' });
const shouldLogProviderProgress = envFlag('HAPPIER_E2E_PROVIDER_LOG_PROGRESS', false);

export function findFirstToolCallIdByName(events: Array<Pick<ToolTraceEventV1, 'kind' | 'payload'>>, toolName: string): string | null {
  for (const e of events) {
    if (e.kind !== 'tool-call') continue;
    const payload = e.payload && typeof e.payload === 'object' ? (e.payload as Record<string, unknown>) : null;
    const name = payload?.name;
    if (typeof name !== 'string' || name !== toolName) continue;
    const callId = payload?.callId ?? payload?.id ?? payload?.toolCallId;
    if (typeof callId === 'string' && callId.length > 0) return callId;
  }
  return null;
}

function findPermissionRequestIdsFromTrace(events: ToolTraceEventV1[]): Array<{ id: string; toolName: string | null }> {
  const out: Array<{ id: string; toolName: string | null }> = [];
  const seen = new Set<string>();

  for (const e of events) {
    if (e?.kind !== 'permission-request') continue;
    const payload = e?.payload ?? null;
    const id = typeof (payload as any)?.permissionId === 'string'
      ? String((payload as any).permissionId)
      : typeof (payload as any)?.id === 'string'
        ? String((payload as any).id)
        : null;
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const toolNameRaw = (payload as any)?.toolName;
    const toolName = typeof toolNameRaw === 'string' && toolNameRaw.trim().length > 0 ? toolNameRaw.trim() : null;
    out.push({ id, toolName });
  }

  return out;
}

type PermissionRpcSocket = {
  rpcCall: <T = unknown>(method: string, payload: string) => Promise<T>;
};

export async function autoResolvePendingPermissionRequests(params: {
  pendingPermissionIds: Array<{ id: string; toolName: string | null }>;
  approvedPermissionIds: Set<string>;
  yolo: boolean;
  allowPermissionAutoApproveInYolo: boolean;
  decision: 'approved' | 'approved_for_session' | 'approved_execpolicy_amendment' | 'denied' | 'abort';
  answers?: Readonly<Record<string, string | readonly string[]>>;
  sessionId: string;
  secret: Uint8Array;
  uiSocket: PermissionRpcSocket;
  rpcTimeoutMs?: number;
}): Promise<{
  blockedInYolo: Array<{ id: string; toolName: string | null }>;
  approvedIds: string[];
}> {
  const approved =
    params.decision === 'approved' ||
    params.decision === 'approved_for_session' ||
    params.decision === 'approved_execpolicy_amendment';
  const blockedInYolo: Array<{ id: string; toolName: string | null }> = [];
  const approvedIds: string[] = [];
  const rpcTimeoutMs = Math.max(1_000, Math.min(params.rpcTimeoutMs ?? 10_000, 60_000));

  for (const req of params.pendingPermissionIds) {
    if (!req?.id) continue;
    if (params.approvedPermissionIds.has(req.id)) continue;
    if (
      !shouldAutoApprovePermissionRequest({
        yolo: params.yolo,
        toolName: req.toolName,
        allowPermissionAutoApproveInYolo: params.allowPermissionAutoApproveInYolo,
      })
    ) {
      blockedInYolo.push(req);
      continue;
    }

    const payload = encryptLegacyBase64({
      id: req.id,
      approved,
      decision: params.decision,
      ...(params.answers === undefined ? null : { answers: params.answers }),
    }, params.secret);
    try {
      const result = await Promise.race([
        params.uiSocket.rpcCall<any>(`${params.sessionId}:permission`, payload),
        sleep(rpcTimeoutMs).then(() => ({ ok: false, error: 'timeout' })),
      ]);
      if (result && typeof result === 'object' && (result as any).ok === true) {
        params.approvedPermissionIds.add(req.id);
        approvedIds.push(req.id);
      }
    } catch {
      // best-effort; next polling pass can retry
    }
  }

  return { blockedInYolo, approvedIds };
}

function normalizeAcpPermissionMode(raw: unknown): 'default' | 'safe-yolo' | 'read-only' | 'yolo' | 'plan' | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (value === 'default' || value === 'safe-yolo' || value === 'read-only' || value === 'yolo' || value === 'plan') {
    return value;
  }
  return null;
}

function resolveScenarioPermissionMode(params: {
  scenarioMeta: Record<string, unknown>;
  yolo: boolean;
}): 'default' | 'safe-yolo' | 'read-only' | 'yolo' | 'plan' {
  return normalizeAcpPermissionMode(params.scenarioMeta.permissionMode) ?? (params.yolo ? 'yolo' : 'default');
}

export function resolveAllowPermissionAutoApproveInYolo(params: {
  provider: ProviderUnderTest;
  scenario: ProviderScenario;
  scenarioMeta: Record<string, unknown>;
  yolo: boolean;
}): boolean {
  return resolveAllowPermissionAutoApproveInYoloFromCommandArgs({
    provider: params.provider,
    scenario: params.scenario,
    scenarioMeta: params.scenarioMeta,
    yolo: params.yolo,
    resolvePromptExpectation: ({ acpPermissions, mode }) => resolveAcpToolPermissionPromptExpectation({
      acpPermissions,
      mode,
    }),
  });
}

export async function mirrorHostAuthStateForProvider(params: {
  providerSubcommand: string;
  mode: 'env' | 'host';
  hostHomeDir: string | undefined;
  cliHome: string;
}): Promise<void> {
  // Host auth mode now executes against host HOME directly (no isolated HOME rewrite),
  // so copying provider auth state into cliHome is unnecessary and can explode runtime/storage.
  // Keep as an explicit no-op to preserve the call site and test intent.
  void params.providerSubcommand;
  void params.mode;
  void params.hostHomeDir;
  void params.cliHome;
}

function resolveLastCliFlagValue(args: readonly string[], flag: string): string | null {
  for (let index = args.length - 2; index >= 0; index -= 1) {
    if (args[index] !== flag) continue;
    const value = args[index + 1];
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
  }
  return null;
}

function resolveModelIdFromCliArgs(args: readonly string[]): string | null {
  return resolveLastCliFlagValue(args, '--model');
}

function resolvePositiveTimestampFromCliArgs(args: readonly string[], flag: string): number | undefined {
  const raw = resolveLastCliFlagValue(args, flag);
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

function resolveModelIdFromMetadataSnapshot(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const record = metadata as Record<string, unknown>;

  const canonical = record.sessionModelsV1;
  if (canonical && typeof canonical === 'object' && !Array.isArray(canonical)) {
    const current = (canonical as Record<string, unknown>).currentModelId;
    if (typeof current === 'string' && current.trim().length > 0) return current.trim();
  }

  const acp = record.acpSessionModelsV1;
  if (acp && typeof acp === 'object' && !Array.isArray(acp)) {
    const current = (acp as Record<string, unknown>).currentModelId;
    if (typeof current === 'string' && current.trim().length > 0) return current.trim();
  }

  const override = record.modelOverrideV1;
  if (override && typeof override === 'object' && !Array.isArray(override)) {
    const modelId = (override as Record<string, unknown>).modelId;
    if (typeof modelId === 'string' && modelId.trim().length > 0) return modelId.trim();
  }

  return null;
}

function readJsonlEvents(raw: string): ToolTraceEventV1[] {
  const lines = raw.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  const out: ToolTraceEventV1[] = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line) as ToolTraceEventV1);
    } catch {
      // ignore
    }
  }
  return out;
}

async function waitForSessionActiveAtBump(params: {
  baseUrl: string;
  token: string;
  sessionId: string;
  initialActiveAt: number;
  timeoutMs: number;
}): Promise<void> {
  // Deprecated: keepAlive writes may be rate-limited server-side and not bump `activeAt` quickly.
  // Keep the function for now to avoid breaking imports if referenced; prefer RPC readiness checks instead.
  const startedAt = Date.now();
  while (Date.now() - startedAt < params.timeoutMs) {
    const snap = await fetchSessionV2(params.baseUrl, params.token, params.sessionId);
    if (typeof snap.activeAt === 'number' && snap.activeAt > params.initialActiveAt) return;
    await sleep(500);
  }
}

async function waitForSessionActive(params: {
  baseUrl: string;
  token: string;
  sessionId: string;
  timeoutMs: number;
}): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < params.timeoutMs) {
    const snap = await fetchSessionV2(params.baseUrl, params.token, params.sessionId);
    if (snap.active === true) return;
    await sleep(250);
  }
  throw new Error('Timed out waiting for session to become active');
}

function isProviderReadyEventMessage(message: unknown): boolean {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return false;
  const record = message as Record<string, unknown>;
  if (record.role !== 'agent') return false;
  const content = record.content;
  if (!content || typeof content !== 'object' || Array.isArray(content)) return false;
  const contentRecord = content as Record<string, unknown>;
  if (contentRecord.type !== 'event') return false;
  const data = contentRecord.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  return (data as Record<string, unknown>).type === 'ready';
}

async function waitForProviderReady(params: {
  baseUrl: string;
  token: string;
  sessionId: string;
  secret: Uint8Array;
  timeoutMs: number;
}): Promise<void> {
  const startedAt = Date.now();
  let afterSeq = 0;
  while (Date.now() - startedAt < params.timeoutMs) {
    const newMessages = await fetchMessagesSince({
      baseUrl: params.baseUrl,
      token: params.token,
      sessionId: params.sessionId,
      afterSeq,
    }).catch(() => []);

    if (newMessages.length > 0) {
      afterSeq = Math.max(afterSeq, ...newMessages.map((m) => m.seq));
      const decoded = newMessages.flatMap((m) => {
        try {
          return [decryptLegacyBase64(m.content.c, params.secret)];
        } catch {
          return [];
        }
      });
      if (decoded.some(isProviderReadyEventMessage)) return;
    }

    await sleep(250);
  }
  throw new Error(`Timed out waiting for provider ready event (${params.sessionId})`);
}

async function waitForPermissionRpcReady(params: {
  baseUrl: string;
  token: string;
  sessionId: string;
  secret: Uint8Array;
  timeoutMs: number;
}): Promise<{ socket: ReturnType<typeof createUserScopedSocketCollector> }> {
  const socket = createUserScopedSocketCollector(params.baseUrl, params.token);
  socket.connect();
  const startedConnectAt = Date.now();
  while (!socket.isConnected() && Date.now() - startedConnectAt < 15_000) {
    await sleep(50);
  }

  // Historically we probed `${sessionId}:permission` and required `{ ok: true }`.
  //
  // In practice, providers may only return `{ ok: true }` when a specific permission request exists,
  // and return no/empty output when the request id is unknown. That makes a "probe" unreliable and
  // can prevent provider tests from ever enqueueing the first user message.
  //
  // The harness only needs a connected user-scoped socket here (used later for permission decisions),
  // and we only attempt to decide permissions after we observe a permission request from tooltrace.
  // By then, the permission RPC will be registered (otherwise the provider couldn't have requested permission).
  const startedAt = Date.now();
  while (!socket.isConnected() && Date.now() - startedAt < params.timeoutMs) {
    await sleep(50);
  }
  if (!socket.isConnected()) {
    socket.close();
    throw new Error('Timed out waiting for user socket to connect');
  }

  return { socket };
}

async function enqueuePendingQueueV2Item(params: {
  baseUrl: string;
  token: string;
  sessionId: string;
  localId: string;
  encryptedMessage: string;
  timeoutMs: number;
}): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < params.timeoutMs) {
    const res = await enqueuePendingQueueV2({
      baseUrl: params.baseUrl,
      token: params.token,
      sessionId: params.sessionId,
      localId: params.localId,
      ciphertext: params.encryptedMessage,
      timeoutMs: 20_000,
    }).catch(() => null);

    if (res && res.status === 200) {
      return;
    }

    await sleep(100);
  }

  throw new Error('Timed out enqueueing pending queue v2 item');
}

async function waitForPendingQueueV2Drain(params: {
  baseUrl: string;
  token: string;
  sessionId: string;
  timeoutMs: number;
}): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < params.timeoutMs) {
    const res = await listPendingQueueV2({ baseUrl: params.baseUrl, token: params.token, sessionId: params.sessionId }).catch(() => null);
    if (res && res.status === 200 && Array.isArray(res.data?.pending) && res.data.pending.length === 0) return;
    await sleep(250);
  }
  throw new Error('Timed out waiting for pending queue v2 to drain');
}

async function readFileText(filePath: string): Promise<string> {
  const { readFile } = await import('node:fs/promises');
  return await readFile(filePath, 'utf8');
}

async function runOneScenario(params: {
  provider: ProviderUnderTest;
  scenario: ProviderScenario;
  server: StartedServer;
  testDir: string;
  cliLaunchSpec?: CliTestLaunchSpec;
  launchEntrypointKind?: DaemonRunnerLaunchEntrypointKind;
}): Promise<void> {
  const { provider, scenario, server, testDir } = params;
  const candidateCliLaunchSpec = params.cliLaunchSpec;
  const candidateLaunchEntrypointKind = params.launchEntrypointKind;

  const cliHome = resolve(join(testDir, 'cli-home'));
  const workspaceDir = resolve(join(testDir, 'workspace'));
  await mkdir(cliHome, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });
  const measurement = createRuntimeLimitMeasurementCaptureFromEnv({
    env: process.env.HAPPIER_RA21_MEASUREMENT_DIR
      ? {
          ...process.env,
          HAPPIER_RA21_MEASUREMENT_DIR: join(
            process.env.HAPPIER_RA21_MEASUREMENT_DIR,
            `${provider.id}.${scenario.id}`,
          ),
          HAPPIER_RA21_PROVIDER_ID: provider.id,
        }
      : process.env,
    runnerId: 'provider-scenario-runner',
    scenarioId: scenario.id,
  });

  const unregisterOpenCodeManagedServerCleanup = provider.id === 'opencode_server'
    ? registerOpenCodeManagedServerHomeForCleanup(cliHome)
    : null;
  let daemonRunnerContinuityEvidence: DaemonRunnerContinuityManifestEvidence | undefined;
  let scenarioManifestSessionIds: string[] = [];
  let writeScenarioManifest: ((update: Readonly<{
    status: NonNullable<TestManifest['results']>['status'];
    endedAt?: string;
    failureClassification?: NonNullable<TestManifest['results']>['failureClassification'];
  }>) => void) | null = null;

  try {
  if (scenario.setup) {
    await scenario.setup({ workspaceDir, cliHome });
  }

  const startedAt = new Date().toISOString();

  const auth = await createTestAuth(server.baseUrl);

  // Legacy encryption is the simplest way to run real provider flows without requiring dataKey provisioning yet.
  const secret = auth.accountSigningSeed;
  await seedCliAuthForTestAccount({ cliHome, serverUrl: server.baseUrl, auth, mode: 'legacy' });

  const metadataCiphertextBase64 = encryptLegacyBase64(
    {
      path: workspaceDir,
      host: 'e2e',
      name: `providers-${provider.id}`,
      flavor: provider.cli.subcommand,
    },
    secret,
  );

  const { sessionId } = await createSessionWithCiphertexts({
    baseUrl: server.baseUrl,
    token: auth.token,
    tag: `e2e-${provider.id}-${scenario.id}-${randomUUID()}`,
    metadataCiphertextBase64,
    agentStateCiphertextBase64: null,
  });
  const sessionIdPhase1 = sessionId;
  let sessionIdPhase2: string | null = null;

  const fixturesFile = resolve(join(testDir, 'tooltrace.fixtures.v1.json'));
  const traceFileMerged = resolve(join(testDir, 'tooltrace.jsonl'));
  const traceFilePhase1 = scenario.resume ? resolve(join(testDir, 'tooltrace.phase1.jsonl')) : traceFileMerged;
  const traceFilePhase2 = scenario.resume ? resolve(join(testDir, 'tooltrace.phase2.jsonl')) : null;

  scenarioManifestSessionIds = [sessionIdPhase1];
  const scenarioManifestEnv = {
    HAPPIER_E2E_PROVIDERS: process.env.HAPPIER_E2E_PROVIDERS ?? process.env.HAPPY_E2E_PROVIDERS,
    [provider.enableEnvVar]: process.env[provider.enableEnvVar],
    HAPPIER_E2E_PROVIDER_WAIT_MS: process.env.HAPPIER_E2E_PROVIDER_WAIT_MS ?? process.env.HAPPY_E2E_PROVIDER_WAIT_MS,
    HAPPIER_E2E_PROVIDER_FLAKE_RETRY:
      process.env.HAPPIER_E2E_PROVIDER_FLAKE_RETRY ?? process.env.HAPPY_E2E_PROVIDER_FLAKE_RETRY,
  };
  writeScenarioManifest = (update) => {
    writeTestManifestForServer({
      testDir,
      server,
      startedAt,
      runId: run.runId,
      testName: `${provider.id}.${scenario.id}`,
      sessionIds: scenarioManifestSessionIds,
      env: scenarioManifestEnv,
      manifest: {
        results: {
          status: update.status,
          startedAt,
          ...(update.endedAt !== undefined ? { endedAt: update.endedAt } : {}),
          ...(update.failureClassification !== undefined
            ? { failureClassification: update.failureClassification }
            : {}),
          ...(daemonRunnerContinuityEvidence !== undefined
            ? { daemonRunnerContinuity: daemonRunnerContinuityEvidence }
            : {}),
        },
      },
    });
  };
  writeScenarioManifest({ status: 'running' });

  const baseCliEnvNoIsolation: NodeJS.ProcessEnv = {
    ...process.env,
    CI: '1',
    HAPPIER_HOME_DIR: cliHome,
    HAPPIER_SERVER_URL: server.baseUrl,
    HAPPIER_WEBAPP_URL: server.baseUrl,
    HAPPIER_STACK_TOOL_TRACE: '1',
    ...Object.fromEntries(
      Object.entries(provider.cli.envFrom ?? {}).flatMap(([dest, src]) => {
        const value = typeof process.env[src] === 'string' ? process.env[src]!.trim() : '';
        return value ? [[dest, value]] : [];
      }),
    ),
    ...(provider.cli.env ?? {}),
  };

  const { env: authedCliEnvNoIsolation, mode } = resolveProviderAuthOverlay({
    auth: provider.auth,
    baseEnv: baseCliEnvNoIsolation,
  });

  await mirrorHostAuthStateForProvider({
    providerSubcommand: provider.cli.subcommand,
    mode,
    hostHomeDir: process.env.HOME,
    cliHome,
  });

  const authedCliEnv: NodeJS.ProcessEnv = applyHomeIsolationEnv({
    cliHome,
    env: authedCliEnvNoIsolation,
    mode,
  });

  for (const envName of provider.requiredEnv ?? []) {
    const value = (authedCliEnv[envName] ?? '').toString().trim();
    if (!value) {
      throw new Error(`Missing required env for provider ${provider.id}: ${envName}`);
    }
  }

  const yolo = resolveYoloForScenario(scenario);

    async function runPhase(params: {
      sessionId: string;
      traceFile: string;
      promptText: string;
      phase: 'single' | 'phase1' | 'phase2';
      traceSubstringsOverride?: string[];
      extraCliArgs?: string[];
      stdoutPath: string;
      stderrPath: string;
    }): Promise<{ traceRaw: string; traceEvents: ToolTraceEventV1[]; tokenTelemetryEntries: ProviderTokenTelemetryEntryV1[] }> {
      const resolveMeta = (metaLike: ProviderScenario['messageMeta'] | undefined): Record<string, unknown> => {
        if (!metaLike) return {};
        try {
          if (typeof metaLike === 'function') {
            const resolved = metaLike({ workspaceDir });
            if (resolved && typeof resolved === 'object' && !Array.isArray(resolved)) return resolved as Record<string, unknown>;
            return {};
          }
          if (metaLike && typeof metaLike === 'object' && !Array.isArray(metaLike)) return metaLike as Record<string, unknown>;
          return {};
        } catch {
          return {};
        }
      };

      const scenarioMeta = resolveMeta(scenario.messageMeta);
      // Some providers (notably Codex ACP) need permission mode at process start to configure their
      // underlying sandbox/approval policy. For those providers, also pass the mode via CLI args
      // when present in message metadata.
      const cliPermissionArgs = resolveCodexCliPermissionArgs({
        providerSubcommand: provider.cli.subcommand,
        yolo,
        scenarioMeta,
      });
      const yoloCliArgs = resolveYoloCliArgs({
        providerSubcommand: provider.cli.subcommand,
        yolo,
        hasExplicitPermissionModeArgs: cliPermissionArgs.length > 0,
      });
      const modelCliArgs = resolveProviderModelCliArgs({
        providerId: provider.id,
      });
      const scenarioCliArgs: string[] = (() => {
        const raw = scenario.cliArgs;
        if (!raw) return [];
        try {
          const resolved = typeof raw === 'function' ? raw({ workspaceDir }) : raw;
          if (!Array.isArray(resolved)) return [];
          return resolved.map((v) => (typeof v === 'string' ? v.trim() : '')).filter((v) => v.length > 0);
        } catch {
          return [];
        }
      })();

      const effectiveModelCliArgs = [...modelCliArgs, ...scenarioCliArgs];
      const modelIdFromCliArgs = resolveModelIdFromCliArgs(effectiveModelCliArgs);
      const modelUpdatedAtFromCliArgs = resolvePositiveTimestampFromCliArgs(
        effectiveModelCliArgs,
        '--model-updated-at',
      );
      const resumeId = resolveLastCliFlagValue(params.extraCliArgs ?? [], '--resume');
      const rawPermissionMode = scenarioMeta.permissionMode;
      const permissionMode =
        typeof rawPermissionMode === 'string' && rawPermissionMode.trim().length > 0
          ? rawPermissionMode.trim()
          : yolo
            ? 'yolo'
            : undefined;
      const rawPermissionModeUpdatedAt = scenarioMeta.permissionModeUpdatedAt;
      const permissionModeUpdatedAt =
        typeof rawPermissionModeUpdatedAt === 'number'
        && Number.isFinite(rawPermissionModeUpdatedAt)
        && rawPermissionModeUpdatedAt > 0
          ? Math.floor(rawPermissionModeUpdatedAt)
          : permissionMode
            ? Date.now()
            : undefined;

      const attachFile = provider.protocol === 'acp'
        ? null
        : await writeCliSessionAttachFile({
            cliHome,
            sessionId: params.sessionId,
            secret,
            encryptionVariant: 'legacy',
          });

      const cliEnv: NodeJS.ProcessEnv = applyCliDevTsxTsconfigEnv({
        repoRootDir: repoRootDir(),
        env: {
          ...authedCliEnv,
          ...(attachFile ? { HAPPIER_SESSION_ATTACH_FILE: attachFile } : {}),
          HAPPIER_STACK_TOOL_TRACE_FILE: params.traceFile,
        },
      });

      if (!candidateCliLaunchSpec && shouldPrepareProviderCliDist(cliEnv)) {
        // Built-entrypoint mode can start the daemon through spawnHappyCLI. Re-check dist before each
        // phase, but do not rebuild it here because that could invalidate imports in running daemons.
        await ensureCliDistBuilt(
          { testDir, env: cliEnv },
          {
            allowRebuild: false,
            waitForAvailabilityMs: resolveCliDistAvailabilityWaitMs(
              process.env.HAPPIER_E2E_CLI_DIST_WAIT_MS ?? process.env.HAPPY_E2E_CLI_DIST_WAIT_MS,
            ),
            buildTimeoutMs: resolveCliDistBuildTimeoutMs(
              process.env.HAPPIER_E2E_CLI_DIST_BUILD_TIMEOUT_MS ?? process.env.HAPPY_E2E_CLI_DIST_BUILD_TIMEOUT_MS,
            ),
          },
        );
      }

      let daemon: StartedDaemon | null = null;
      let retainedContinuityDaemonA: StartedDaemon | null = null;
      if (
        shouldStartProviderDaemon({
          providerProtocol: provider.protocol,
          hasPostSatisfyRunHook: typeof scenario.postSatisfy?.run === 'function',
          requiresDaemonRunnerContinuity: scenario.daemonRunnerContinuity !== undefined,
        })
      ) {
        const daemonDir = resolve(join(testDir, 'daemon'));
        await mkdir(daemonDir, { recursive: true });
        daemon = await startTestDaemon({
          testDir: daemonDir,
          happyHomeDir: cliHome,
          env: cliEnv,
          ...(scenario.daemonRunnerContinuity ? { cleanupDescendantsOnExit: false } : {}),
          ...(candidateCliLaunchSpec ? { cliLaunchSpec: candidateCliLaunchSpec } : {}),
        });
      }

      const launched = await launchProviderHarnessSession({
        providerId: String(provider.id),
        agentId: provider.cli.subcommand,
        providerProtocol: provider.protocol,
        launchViaDaemon: scenario.daemonRunnerContinuity !== undefined,
        daemon,
        directory: workspaceDir,
        existingSessionId: params.sessionId,
        ...(resumeId ? { resume: resumeId } : {}),
        ...(permissionMode ? { permissionMode } : {}),
        ...(permissionModeUpdatedAt !== undefined ? { permissionModeUpdatedAt } : {}),
        ...(modelIdFromCliArgs ? { modelId: modelIdFromCliArgs } : {}),
        ...(modelUpdatedAtFromCliArgs !== undefined ? { modelUpdatedAt: modelUpdatedAtFromCliArgs } : {}),
        environmentVariables: cliEnv,
        spawnDirect: async () => await spawnProviderHarnessDirectProcessWithLaunchSpec({
          resolveLaunchSpec: async () => shouldUseCliSourceEntrypoint(cliEnv)
            ? await resolveCliTestLaunchSpec(
                { testDir: resolve(testDir, 'provider-cli-source'), env: cliEnv },
                {
                  snapshotDir: resolve(testDir, 'provider-cli-source', 'snapshot'),
                  preferSourceEntrypoint: true,
                  skipDistIntegrityCheck: true,
                  skipSourceFreshnessCheck: true,
                },
              )
            : null,
          spawn: (sourceLaunchSpec) => {
            const providerCommandParams = {
              providerSubcommand: provider.cli.subcommand,
              sessionId: params.sessionId,
              yoloCliArgs,
              permissionCliArgs: cliPermissionArgs,
              modelCliArgs,
              extraCliArgs: params.extraCliArgs ?? [],
              scenarioCliArgs,
              providerCliExtraArgs: provider.cli.extraArgs ?? [],
            } as const;
            const baseCommand = sourceLaunchSpec?.command ?? yarnCommand();
            const baseArgs = sourceLaunchSpec
              ? [...sourceLaunchSpec.args, ...buildProviderCliCommandArgs(providerCommandParams)]
              : buildProviderDevCommandArgs(providerCommandParams);

            return spawnLoggedProcess({
              ...resolveProviderCliSpawnSpec({
                platform: process.platform,
                scriptPath: which('script'),
                baseCommand,
                baseArgs,
                scenario,
              }),
              cwd: sourceLaunchSpec?.cwd ?? repoRootDir(),
              env: { ...cliEnv, ...sourceLaunchSpec?.env },
              stdoutPath: params.stdoutPath,
              stderrPath: params.stderrPath,
              cleanup: sourceLaunchSpec?.cleanup,
            });
          },
        }),
      });
      const proc: SpawnedProcess | null = launched.process;

      let uiSocket: Awaited<ReturnType<typeof waitForPermissionRpcReady>>['socket'] | null = null;
      let phaseError: unknown = null;
      try {
      // Wait for the provider client to be connected before posting the first prompt.
      // Even in YOLO scenarios, we may need to resolve *session-level* permission prompts
      // (e.g. ACP history import) to make resume flows deterministic.
      uiSocket = (
        await waitForPermissionRpcReady({
          baseUrl: server.baseUrl,
          token: auth.token,
          sessionId: params.sessionId,
          secret,
          timeoutMs: 60_000,
        })
      ).socket;

      const maxWaitMs = resolveScenarioWaitMs({
        scenarioWaitMs: scenario.waitMs,
        globalWaitMsRaw: process.env.HAPPIER_E2E_PROVIDER_WAIT_MS ?? process.env.HAPPY_E2E_PROVIDER_WAIT_MS,
      });
      await waitForSessionActiveBestEffort({
        yolo,
        wait: () => waitForSessionActive({
          baseUrl: server.baseUrl,
          token: auth.token,
          sessionId: params.sessionId,
          timeoutMs: resolveSessionActiveWaitMs(
            process.env.HAPPIER_E2E_PROVIDER_WAIT_MS ?? process.env.HAPPY_E2E_PROVIDER_WAIT_MS,
          ),
        }),
      });

      // If YOLO is disabled for this scenario, auto-approve any permission requests.
        const approvedPermissionIds = new Set<string>();
        const permissionDecision = scenario.permissionAutoDecision ?? 'approved';
        const allowPermissionAutoApproveInYolo = resolveAllowPermissionAutoApproveInYolo({
          provider,
          scenario,
          scenarioMeta,
          yolo,
        });

        const autoResolveFromTrace = async (
          relevant: ToolTraceEventV1[],
          rpcTimeoutMs?: number,
        ): Promise<Array<{ id: string; toolName: string | null }>> => {
          if (!uiSocket) return [];
          const pendingPermissionIds = findPermissionRequestIdsFromTrace(relevant as any);
          const result = await autoResolvePendingPermissionRequests({
            pendingPermissionIds,
            approvedPermissionIds,
            yolo,
            allowPermissionAutoApproveInYolo,
            decision: permissionDecision,
            answers: scenario.permissionAutoAnswers,
            sessionId: params.sessionId,
            secret,
            uiSocket,
            rpcTimeoutMs,
          });
          return result.blockedInYolo;
        };

        const autoResolveFromAgentState = async (): Promise<void> => {
          if (!uiSocket) return;
          try {
            const snap = await fetchSessionV2(server.baseUrl, auth.token, params.sessionId);
            const state = snap.agentState ? (decryptLegacyBase64(snap.agentState, secret) as any) : null;
            const requests = state && typeof state === 'object' ? (state as any).requests : null;
            if (!requests || typeof requests !== 'object') return;
            const pendingPermissionIds = Object.entries(requests).flatMap(([id, req]) => {
              if (typeof id !== 'string' || id.length === 0 || approvedPermissionIds.has(id)) return [];
              const tool = req && typeof req === 'object' ? (req as any).tool : null;
              const toolName = typeof tool === 'string' && tool.trim().length > 0 ? tool.trim() : null;
              return [{ id, toolName }];
            });
            if (pendingPermissionIds.length === 0) return;
            await autoResolvePendingPermissionRequests({
              pendingPermissionIds,
              approvedPermissionIds,
              yolo,
              allowPermissionAutoApproveInYolo,
              decision: permissionDecision,
              sessionId: params.sessionId,
              secret,
              uiSocket,
            });
          } catch {
            // ignore
          }
        };

        const runPostSatisfyWithPermissionPump = async (runPostSatisfy: () => Promise<void>): Promise<void> => {
          if (!uiSocket) {
            await runPostSatisfy();
            return;
          }
          let done = false;
          let runError: unknown = null;
          const runner = (async () => {
            try {
              await runPostSatisfy();
            } catch (error) {
              runError = error;
            } finally {
              done = true;
            }
          })();

          while (!done) {
            if (existsSync(params.traceFile)) {
              const currentRaw = await readFileText(params.traceFile).catch(() => '');
              const currentEvents = readJsonlEvents(currentRaw);
              const relevant = currentEvents.filter(
                (event) =>
                  event?.v === 1 &&
                  providerTraceProtocolMatches({
                    providerId: provider.id,
                    providerProtocol: provider.protocol,
                    eventProtocol: event.protocol,
                  }) &&
                  (typeof event.provider === 'string' ? event.provider === provider.traceProvider : false),
              );
              await autoResolveFromTrace(relevant, 5_000);
            }
            await autoResolveFromAgentState();
            await sleep(250);
          }

          await runner;
          if (runError) throw runError;
        };

        const steps = Array.isArray(scenario.steps) && scenario.steps.length > 0
          ? scenario.steps
          : [{ id: 'main', prompt: () => params.promptText }];

      const enqueuePrompt = async (promptText: string, extraMeta?: Record<string, unknown>) => {
        const promptLocalId = randomUUID();
        const prompt = {
          role: 'user',
          content: { type: 'text', text: promptText },
          localId: promptLocalId,
          meta: {
            source: 'ui',
            sentFrom: 'e2e',
            ...scenarioMeta,
            ...(extraMeta ?? {}),
          },
        };

        const promptCiphertext = encryptLegacyBase64(prompt, secret);
        await enqueuePendingQueueV2Item({
          baseUrl: server.baseUrl,
          token: auth.token,
          sessionId: params.sessionId,
          localId: promptLocalId,
          encryptedMessage: promptCiphertext,
          timeoutMs: 30_000,
        });
      };

      let stepIndex = 0;
      if (provider.protocol === 'claude') {
        // Claude does not always replay historical messages on initial attach. When possible,
        // wait for the CLI to emit a ready event before enqueueing the first prompt so the
        // onUserMessage bridge is definitely attached. Best-effort to avoid deadlocks if the
        // provider does not emit the event in a particular build/configuration.
        await waitForProviderReady({
          baseUrl: server.baseUrl,
          token: auth.token,
          sessionId: params.sessionId,
          secret,
          timeoutMs: 20_000,
        }).catch(() => undefined);
      }
      const sessionBeforePrompt = await fetchSessionV2(server.baseUrl, auth.token, params.sessionId);
      const messageSeqBeforePrompt = sessionBeforePrompt.seq;
      await enqueuePrompt(
        steps[0]!.prompt({ workspaceDir }),
        resolveMeta(steps[0]!.messageMeta),
      );

      const startedWaitAt = Date.now();
      let lastSeenMessageSeq = 0;
      let lastMessagePollAt = 0;
      let lastProviderActivityAt = Date.now();
      const messageSignatureById = new Map<string, string>();
      const messageUpdateLookbackSeq = 50;
      let lastTraceRawLength = -1;
      let lastRelevantTraceCount = -1;
	      let blockedPermissionSinceAt: number | null = null;
	      let blockedPermissionSnapshot = '';
	      const decodedMessagesSeen: unknown[] = [];
	      let taskCompleteCountAtCurrentStepStart: number | null = resolveTaskCompleteBaselineAtStepStart({
	        providerProtocol: provider.protocol,
	        allowInFlightSteer: steps[0]?.allowInFlightSteer,
	        traceEvents: [],
	        decodedMessagesSeen: [],
	      });
	      let completedTurnIdAtCurrentStepStart = readCompletedTurnId(sessionBeforePrompt);

      let traceRaw = '';
      let traceEvents: ToolTraceEventV1[] = [];
      const satisfactionScenario = {
        requiredFixtureKeys: scenario.requiredFixtureKeys ?? [],
        requiredAnyFixtureKeys: scenario.requiredAnyFixtureKeys,
        requiredTraceSubstrings: params.traceSubstringsOverride ?? scenario.requiredTraceSubstrings,
        requiredMessageSubstrings: scenario.requiredMessageSubstrings,
      };
      const inactivityTimeoutMs = resolveProviderInactivityTimeoutMs(
        process.env.HAPPIER_E2E_PROVIDER_NO_ACTIVITY_TIMEOUT_MS ?? process.env.HAPPY_E2E_PROVIDER_NO_ACTIVITY_TIMEOUT_MS,
        maxWaitMs,
        provider.id,
        scenario.inactivityTimeoutMs,
      );
      const permissionBlockTimeoutMs = resolveProviderPermissionBlockTimeoutMs(
        process.env.HAPPIER_E2E_PROVIDER_PERMISSION_BLOCK_TIMEOUT_MS ??
          process.env.HAPPY_E2E_PROVIDER_PERMISSION_BLOCK_TIMEOUT_MS,
        maxWaitMs,
      );

      let satisfied = false;
      while (Date.now() - startedWaitAt < maxWaitMs) {
	        const fatalFromLogs = await readFatalProviderErrorFromCliLogs({
	          cliHome,
	          extraLogPaths: [params.stdoutPath, params.stderrPath],
	        });
        if (fatalFromLogs) {
          throw new Error(`Fatal provider runtime error (${provider.id}.${scenario.id}): ${fatalFromLogs}`);
        }

        if (Date.now() - lastMessagePollAt >= 1_000) {
          lastMessagePollAt = Date.now();
          const pollAfterSeq = Math.max(0, lastSeenMessageSeq - messageUpdateLookbackSeq);
          const newMessages = await fetchMessagesSince({
            baseUrl: server.baseUrl,
            token: auth.token,
            sessionId: params.sessionId,
            afterSeq: pollAfterSeq,
          }).catch(() => []);

          if (newMessages.length > 0) {
            const resolveMessageId = (m: { localId: string | null; seq: number }): string =>
              typeof m.localId === 'string' && m.localId.length > 0 ? `local:${m.localId}` : `seq:${m.seq}`;

            const windowIds = new Set<string>();
            const changedMessages = newMessages.filter((m) => {
              const id = resolveMessageId(m);
              windowIds.add(id);
              const signature = `${m.seq}:${m.content?.t ?? ''}:${m.content?.c ?? ''}`;
              const prev = messageSignatureById.get(id);
              if (prev === signature) return false;
              messageSignatureById.set(id, signature);
              return true;
            });

            for (const id of messageSignatureById.keys()) {
              if (!windowIds.has(id)) {
                messageSignatureById.delete(id);
              }
            }

            lastSeenMessageSeq = Math.max(lastSeenMessageSeq, ...newMessages.map((m) => m.seq));
            const decodedMessageRows = changedMessages.flatMap((m) => {
              try {
                return [{
                  seq: m.seq,
                  value: normalizeDecodedTranscriptValue(decryptLegacyBase64(m.content.c, secret)),
                }];
              } catch {
                return [];
              }
            });
            const decodedMessages = decodedMessageRows.map((message) => message.value);
            const fatal = extractFatalAgentErrorMessage(decodedMessages);
            if (fatal) {
              throw new Error(
                formatFatalProviderAssistantError({
                  providerId: provider.id,
                  scenarioId: scenario.id,
                  fatal,
                  env: process.env,
                }),
              );
            }
            const terminalFailure = extractProviderTerminalFailure({
              afterSeq: messageSeqBeforePrompt,
              messages: decodedMessageRows,
            });
            if (terminalFailure) {
              throw new Error(formatProviderTerminalFailure({
                providerId: provider.id,
                scenarioId: scenario.id,
                failure: terminalFailure,
              }));
            }
            if (changedMessages.length > 0) {
              lastProviderActivityAt = Date.now();
            }
            if (decodedMessages.length > 0) {
              decodedMessagesSeen.push(...decodedMessages);
              if (decodedMessagesSeen.length > 2_000) {
                decodedMessagesSeen.splice(0, decodedMessagesSeen.length - 2_000);
              }
            }
          }
        }

        // Prefer resolving permission prompts using tool-trace events, not agentState polling.
        // We have observed provider runs where agentState polling stalls due to socket hiccups; tool-trace
        // is written locally by the CLI and is our most reliable source for permission ids.
        if (existsSync(params.traceFile)) {
          traceRaw = await readFileText(params.traceFile).catch(() => '');
          traceEvents = readJsonlEvents(traceRaw);

          const relevant = filterImportedTraceEvents(traceEvents).filter(
            (e) =>
              e?.v === 1 &&
              providerTraceProtocolMatches({
                providerId: provider.id,
                providerProtocol: provider.protocol,
                eventProtocol: e.protocol,
              }) &&
              (typeof e.provider === 'string' ? e.provider === provider.traceProvider : false),
          );
          if (traceRaw.length !== lastTraceRawLength || relevant.length !== lastRelevantTraceCount) {
            lastTraceRawLength = traceRaw.length;
            lastRelevantTraceCount = relevant.length;
            lastProviderActivityAt = Date.now();
          }

          const blockedInYolo = await autoResolveFromTrace(relevant);

          if (blockedInYolo.length > 0) {
            if (blockedPermissionSinceAt == null) blockedPermissionSinceAt = Date.now();
            blockedPermissionSnapshot = blockedInYolo
              .map((req) => `${req.id}:${req.toolName ?? 'unknown'}`)
              .slice(0, 8)
              .join(', ');
          } else {
            blockedPermissionSinceAt = null;
            blockedPermissionSnapshot = '';
          }

	          // Multi-step scenarios: enqueue the next step once the current step's satisfaction criteria are met.
	          if (steps.length > 1 && stepIndex < steps.length - 1) {
	            const step = steps[stepIndex];
	            const satisfaction = step?.satisfaction ?? null;
	            if (!satisfaction) {
	              throw new Error(`Scenario ${provider.id}.${scenario.id} step ${step?.id ?? String(stepIndex)} is missing satisfaction criteria`);
	            }
	            if (
	              scenarioSatisfiedByTrace(relevant as any, satisfaction) &&
	              scenarioSatisfiedByMessages({ decodedMessages: decodedMessagesSeen, socketEvents: uiSocket?.getEvents() ?? [] }, satisfaction)
	            ) {
	              const currentSessionSnapshot = await fetchSessionV2(
	                server.baseUrl,
	                auth.token,
	                params.sessionId,
	              );
	              const okToEnqueueNext = shouldEnqueueNextStepAfterSatisfaction({
	                providerProtocol: provider.protocol,
	                allowInFlightSteer: step?.allowInFlightSteer,
	                traceEvents: relevant,
	                decodedMessagesSeen,
	                taskCompleteCountAtStepSatisfaction: taskCompleteCountAtCurrentStepStart,
	                completedTurnIdAtStepStart: completedTurnIdAtCurrentStepStart,
	                currentSessionSnapshot,
	              });
	              if (okToEnqueueNext) {
	                stepIndex++;
	                const nextStep = steps[stepIndex]!;
	                await enqueuePrompt(nextStep.prompt({ workspaceDir }), resolveMeta(nextStep.messageMeta));
	                taskCompleteCountAtCurrentStepStart = resolveTaskCompleteBaselineAtStepStart({
	                  providerProtocol: provider.protocol,
	                  allowInFlightSteer: nextStep.allowInFlightSteer,
	                  traceEvents: relevant,
	                  decodedMessagesSeen,
	                });
	                completedTurnIdAtCurrentStepStart = readCompletedTurnId(currentSessionSnapshot);
	              }
	            }
	          }

          if (
            scenarioSatisfiedByTrace(relevant as any, satisfactionScenario) &&
            scenarioSatisfiedByMessages({ decodedMessages: decodedMessagesSeen, socketEvents: uiSocket?.getEvents() ?? [] }, satisfactionScenario)
          ) {
            const postSatisfy = scenario.postSatisfy;
            const daemonRunnerContinuity = scenario.daemonRunnerContinuity;
            if (postSatisfy || daemonRunnerContinuity) {
              await runPostSatisfyWithPermissionPump(async () => {
                if (postSatisfy?.run) {
                  await postSatisfy.run({
                    workspaceDir,
                    baseUrl: server.baseUrl,
                    token: auth.token,
                    sessionId: params.sessionId,
                    secret,
                    cliHome,
                    traceFile: params.traceFile,
                  });
                }

                const toolName = postSatisfy?.waitForAcpSidechainFromToolName;
                if (typeof toolName === 'string' && toolName.trim().length > 0) {
                  const sidechainId = findFirstToolCallIdByName(relevant as any, toolName);
                  if (sidechainId) {
                    await waitForAcpSidechainMessages({
                      baseUrl: server.baseUrl,
                      token: auth.token,
                      sessionId: params.sessionId,
                      secret,
                      sidechainId,
                      timeoutMs: postSatisfy?.timeoutMs ?? 120_000,
                    });
                  }
                }

                if (daemonRunnerContinuity) {
                  if (!daemon) {
                    throw new Error(
                      `Daemon runner continuity requires a running daemon (${provider.id}.${scenario.id})`,
                    );
                  }
                  const [phaseB, phaseC] = daemonRunnerContinuity.phases;
                  const retainedPluginLifecycle = daemonRunnerContinuity.retainedPluginLifecycle;
                  retainedContinuityDaemonA = daemon;
                  daemonRunnerContinuityEvidence = await runDaemonRunnerContinuityAToBToC({
                    daemonA: daemon,
                    testDir: resolve(join(testDir, 'daemon-continuity')),
                    happyHomeDir: cliHome,
                    daemonEnv: cliEnv,
                    baseUrl: server.baseUrl,
                    token: auth.token,
                    sessionId: params.sessionId,
                    secret,
                    launchEntrypointKind: candidateLaunchEntrypointKind
                      ?? (shouldUseCliSourceEntrypoint(cliEnv) ? 'source' : 'not_proven'),
                    ...(candidateCliLaunchSpec ? { cliLaunchSpec: candidateCliLaunchSpec } : {}),
                    phases: [
                      {
                        id: phaseB.id,
                        prompt: phaseB.prompt({ workspaceDir }),
                        requiredAssistantSubstring: phaseB.requiredAssistantSubstring,
                        effect: phaseB.effect({ workspaceDir }),
                      },
                      {
                        id: phaseC.id,
                        prompt: phaseC.prompt({ workspaceDir }),
                        requiredAssistantSubstring: phaseC.requiredAssistantSubstring,
                        effect: phaseC.effect({ workspaceDir }),
                      },
                    ],
                    ...(daemonRunnerContinuity.identityEvidence
                      ? { identityEvidence: daemonRunnerContinuity.identityEvidence }
                      : {}),
                    ...(retainedPluginLifecycle
                      ? {
                          observeRetainedPluginLifecycle: async () => (
                            await retainedPluginLifecycle.observe({
                              workspaceDir,
                              baseUrl: server.baseUrl,
                              token: auth.token,
                              sessionId: params.sessionId,
                              secret,
                              cliHome,
                            })
                          ),
                        }
                      : {}),
                    ...(daemonRunnerContinuity.timeoutMs !== undefined
                      ? { timeoutMs: daemonRunnerContinuity.timeoutMs }
                      : {}),
                    onReplacementDaemon: async (replacementDaemon) => {
                      const retiredDaemon = daemon;
                      daemon = replacementDaemon;
                      if (retiredDaemon && retiredDaemon !== retainedContinuityDaemonA) {
                        await retiredDaemon.proc.stop();
                      }
                    },
                  });
                  writeScenarioManifest?.({ status: 'running' });
                }
              });
            }
            satisfied = true;
            break;
          }
        }

        if (Date.now() - lastProviderActivityAt >= inactivityTimeoutMs) {
          throw new Error(
            `No provider activity for ${inactivityTimeoutMs}ms (${provider.id}.${scenario.id}): ` +
              `lastSeenMessageSeq=${lastSeenMessageSeq}, traceBytes=${Math.max(0, lastTraceRawLength)}, ` +
              `relevantTraceEvents=${Math.max(0, lastRelevantTraceCount)}`,
          );
        }
        if (blockedPermissionSinceAt != null && Date.now() - blockedPermissionSinceAt >= permissionBlockTimeoutMs) {
          throw new Error(
            `Permission requests remained blocked for ${permissionBlockTimeoutMs}ms (${provider.id}.${scenario.id}) ` +
              `while yolo auto-approve is disabled: ${blockedPermissionSnapshot || 'unknown requests'}`,
          );
        }

        await autoResolveFromAgentState();

        await sleep(1_000);
      }

      if (!satisfied) {
        const requiredFixtureKeys = satisfactionScenario.requiredFixtureKeys ?? [];
        const requiredAnyFixtureKeys = satisfactionScenario.requiredAnyFixtureKeys ?? [];
        const requiredTraceSubstrings = satisfactionScenario.requiredTraceSubstrings ?? [];
        const requiredMessageSubstrings = satisfactionScenario.requiredMessageSubstrings ?? [];
        throw new Error(
          `Timed out waiting for scenario satisfaction after ${maxWaitMs}ms (${provider.id}.${scenario.id}): ` +
          `requiredFixtureKeys=${requiredFixtureKeys.join(',') || '(none)'} ` +
          `requiredAnyFixtureKeys=${requiredAnyFixtureKeys.map((bucket) => `[${bucket.join('|')}]`).join(',') || '(none)'} ` +
          `requiredTraceSubstrings=${requiredTraceSubstrings.join(',') || '(none)'} ` +
          `requiredMessageSubstrings=${requiredMessageSubstrings.join(',') || '(none)'}`,
        );
      }

        if (!existsSync(params.traceFile)) {
          throw new Error('Tool trace file was not created (did provider connect and produce tool events?)');
        }

        const assertPendingDrain = shouldAssertPendingDrain({
          assertPendingDrain: scenario.assertPendingDrain,
        });
        if (assertPendingDrain) {
          const pendingDrainTimeoutMs = resolvePendingDrainTimeoutMs({
            providerId: provider.id,
            scenarioMeta,
          });
          await waitForPendingQueueV2Drain({
            baseUrl: server.baseUrl,
            token: auth.token,
            sessionId: params.sessionId,
            timeoutMs: pendingDrainTimeoutMs,
          });
        }

        const finalRaw = await readFileText(params.traceFile).catch(() => '');
        const finalEvents = readJsonlEvents(finalRaw);
        let modelId: string | null = modelIdFromCliArgs;
        try {
          const snap = await fetchSessionV2(server.baseUrl, auth.token, params.sessionId);
          const metadata = decryptLegacyBase64(snap.metadata, secret);
          modelId = resolveModelIdFromMetadataSnapshot(metadata) ?? modelIdFromCliArgs;
        } catch {
          // best-effort telemetry enrichment
        }

        const socketEvents = uiSocket?.getEvents() ?? [];
        const extractedTokenTelemetryEntries = await extractProviderTokenTelemetryEntries({
          providerId: String(provider.id),
          scenarioId: scenario.id,
          phase: params.phase,
          sessionId: params.sessionId,
          modelId,
          events: socketEvents,
          secret,
          baseUrl: server.baseUrl,
          token: auth.token,
          allowSessionMessageTokenCountFallback: provider.protocol === 'acp',
        });
        const tokenTelemetryEntries = ensureProviderTokenTelemetryEntries({
          providerId: String(provider.id),
          scenarioId: scenario.id,
          phase: params.phase,
          sessionId: params.sessionId,
          modelId,
          extracted: extractedTokenTelemetryEntries,
        });

        return { traceRaw: finalRaw, traceEvents: finalEvents, tokenTelemetryEntries };
      } catch (error) {
        phaseError = error;
        throw error;
      } finally {
        try {
          uiSocket?.close();
        } catch {
          // ignore
        }
        const cleanupErrors: Error[] = [];
        const runCleanup = async (cleanup: () => void | Promise<void>) => {
          try {
            await cleanup();
          } catch (error) {
            cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
          }
        };
        if (daemon) await runCleanup(() => daemon!.stop());
        if (retainedContinuityDaemonA && retainedContinuityDaemonA !== daemon) {
          await runCleanup(() => retainedContinuityDaemonA!.proc.stop());
        }
        if (proc) await runCleanup(() => proc.stop());
        await runCleanup(() => stopDaemonFromHomeDir(cliHome));
        if (cleanupErrors.length > 0) {
          const errors = phaseError === null
            ? cleanupErrors
            : [phaseError instanceof Error ? phaseError : new Error(String(phaseError)), ...cleanupErrors];
          if (errors.length === 1) throw errors[0];
          throw new AggregateError(
            errors,
            `Provider scenario execution and teardown failed: ${errors.map((error) => error.message).join('; ')}`,
          );
        }
      }
    }

  const hasSteps = Array.isArray(scenario.steps) && scenario.steps.length > 0;
  if (!hasSteps && !scenario.prompt) {
    throw new Error(`Scenario ${provider.id}.${scenario.id} is missing both prompt and steps`);
  }

  const phase1PromptText = scenario.prompt ? scenario.prompt({ workspaceDir }) : '';
  if (phase1PromptText) {
    const envelope = { text: phase1PromptText };
    measurement?.capture.recordEnvelope({
      direction: 'send',
      family: 'prompt',
      decodedValue: envelope,
      encodedValue: JSON.stringify(envelope),
    });
  }
  const phase1 = await runPhase({
    sessionId: sessionIdPhase1,
    traceFile: traceFilePhase1,
    phase: scenario.resume ? 'phase1' : 'single',
    promptText: phase1PromptText,
    stdoutPath: resolve(join(testDir, 'cli.phase1.stdout.log')),
    stderrPath: resolve(join(testDir, 'cli.phase1.stderr.log')),
  });

  let mergedTraceFile = traceFilePhase1;
  let mergedTraceRaw = phase1.traceRaw;
  let resumeIdForVerify: string | null = null;
  if (scenario.resume && traceFilePhase2) {
    const snap = await fetchSessionV2(server.baseUrl, auth.token, sessionIdPhase1);
    const metadata = decryptLegacyBase64(snap.metadata, secret) as any;
    const resumeIdRaw = metadata && typeof metadata === 'object' ? (metadata as any)[scenario.resume.metadataKey] : null;
    const resumeId = typeof resumeIdRaw === 'string' ? resumeIdRaw.trim() : '';
    if (!resumeId) {
      throw new Error(`Resume scenario missing metadata field ${scenario.resume.metadataKey} after phase 1`);
    }
    resumeIdForVerify = resumeId;

    if (resolveResumeSessionMode(scenario.resume) === 'fresh') {
      const created = await createSessionWithCiphertexts({
        baseUrl: server.baseUrl,
        token: auth.token,
        tag: `e2e-${provider.id}-${scenario.id}-resume-${randomUUID()}`,
        metadataCiphertextBase64,
        agentStateCiphertextBase64: null,
      });
      sessionIdPhase2 = created.sessionId;
      scenarioManifestSessionIds = [sessionIdPhase1, sessionIdPhase2];
      writeScenarioManifest?.({ status: 'running' });
    } else {
      sessionIdPhase2 = sessionIdPhase1;
    }

    const phase2PromptText = scenario.resume.prompt({ workspaceDir });
    if (phase2PromptText) {
      const envelope = { text: phase2PromptText };
      measurement?.capture.recordEnvelope({
        direction: 'send',
        family: 'resume-prompt',
        decodedValue: envelope,
        encodedValue: JSON.stringify(envelope),
      });
    }
    const phase2 = await runPhase({
      sessionId: sessionIdPhase2 ?? sessionIdPhase1,
      traceFile: traceFilePhase2,
      phase: 'phase2',
      promptText: phase2PromptText,
      traceSubstringsOverride: scenario.resume.requiredTraceSubstrings,
      extraCliArgs: ['--resume', resumeId],
      stdoutPath: resolve(join(testDir, 'cli.phase2.stdout.log')),
      stderrPath: resolve(join(testDir, 'cli.phase2.stderr.log')),
    });

    // Merge tool traces from both phases for fixture extraction + baseline drift checks.
    mergedTraceFile = traceFileMerged;
    mergedTraceRaw = `${phase1.traceRaw.trimEnd()}\n${phase2.traceRaw.trimEnd()}\n`;
    await writeFile(mergedTraceFile, mergedTraceRaw, 'utf8');

    await appendProviderTokenTelemetryEntries({
      entries: [
        ...phase1.tokenTelemetryEntries,
        ...phase2.tokenTelemetryEntries,
      ],
      reportPath: resolveProviderTokenLedgerPath(run.runDir),
      runId: run.runId,
    });
  } else {
    await appendProviderTokenTelemetryEntries({
      entries: [...phase1.tokenTelemetryEntries],
      reportPath: resolveProviderTokenLedgerPath(run.runDir),
      runId: run.runId,
    });
  }

  if (!existsSync(mergedTraceFile)) {
    throw new Error('Tool trace file was not created (did provider connect and produce tool events?)');
  }

  const decodeStartedAt = measurement ? performance.now() : null;
  const traceEvents = readJsonlEvents(mergedTraceRaw);
  if (measurement && decodeStartedAt !== null) {
    recordJsonlTraceMeasurements(measurement.capture, {
      traceRaw: mergedTraceRaw,
      traceEvents,
      decodeDurationMs: performance.now() - decodeStartedAt,
    });
  }

  // Extract fixtures using the same repo logic used for curated allowlists.
  await runLoggedCommand({
    command: yarnCommand(),
    args: ['-s', 'workspace', '@happier-dev/cli', 'tool:trace:extract', '--out', fixturesFile, mergedTraceFile],
    cwd: repoRootDir(),
    env: { ...process.env, CI: '1' },
    stdoutPath: resolve(join(testDir, 'tooltrace.extract.stdout.log')),
    stderrPath: resolve(join(testDir, 'tooltrace.extract.stderr.log')),
    timeoutMs: 120_000,
  });

  const fixturesRaw = await readFileText(fixturesFile);
  const fixturesUnknown: unknown = JSON.parse(fixturesRaw);
  const fixturesRecord = fixturesUnknown as { v?: unknown; examples?: unknown; [k: string]: unknown };
  const examplesUnknown = fixturesRecord.examples;
  if (
    fixturesRecord.v !== 1 ||
    !examplesUnknown ||
    typeof examplesUnknown !== 'object' ||
    Array.isArray(examplesUnknown)
  ) {
    throw new Error('Invalid fixtures JSON (expected v=1 + examples)');
  }
  for (const [key, value] of Object.entries(examplesUnknown as Record<string, unknown>)) {
    if (!Array.isArray(value)) {
      throw new Error(`Invalid fixtures JSON (expected examples.${key} to be an array)`);
    }
  }
  const fixtures: ProviderFixtures = { ...fixturesRecord, examples: examplesUnknown as ProviderFixtureExamples };
  const fixturesExamples = fixtures.examples;
  if (!fixturesExamples) {
    throw new Error('Invalid fixtures JSON (expected examples)');
  }

  // Optional: cap the amount of provider activity for deterministic scenarios.
  if (scenario.maxTraceEvents) {
      const relevant = filterImportedTraceEvents(traceEvents).filter(
        (e) =>
          e?.v === 1 &&
          providerTraceProtocolMatches({
            providerId: provider.id,
            providerProtocol: provider.protocol,
            eventProtocol: e.protocol,
          }) &&
        (typeof e.provider === 'string' ? e.provider === provider.traceProvider : false),
    );
    const cap = checkMaxTraceEvents(relevant as any, scenario.maxTraceEvents);
    if (!cap.ok) {
      throw new Error(`Scenario exceeded maxTraceEvents (${provider.id}.${scenario.id}): ${cap.reason}`);
    }
  }

  // Validate that tool-call/tool-result payloads match the shared normalized V2 schemas.
  // This is forward-compatible (unknown tool names are allowed as long as `_happier` parses).
  const schemaValidation = validateNormalizedToolFixturesV2({ fixturesExamples: fixturesExamples });
  if (!schemaValidation.ok) {
    throw new Error(`Normalized tool schema validation failed: ${schemaValidation.reason}`);
  }

  const keys = Object.keys(fixturesExamples);
  for (const required of scenario.requiredFixtureKeys ?? []) {
    if (!keys.includes(required)) {
      throw new Error(`Missing required fixture key: ${required}`);
    }
  }

  for (const bucket of scenario.requiredAnyFixtureKeys ?? []) {
    const ok = bucket.some((k) => keys.includes(k));
    if (!ok) {
      throw new Error(`Missing required fixture key (any): ${bucket.join(' OR ')}`);
    }
  }

  const updateBaselines = envFlag('HAPPIER_E2E_PROVIDER_UPDATE_BASELINES', false);
  if (updateBaselines) {
    const baselineKeys = selectBaselineFixtureKeysFromScenario({
      scenario,
      observedFixtureKeys: keys,
    });
    await writeProviderBaseline({
      providerId: provider.id,
      scenarioId: scenario.id,
      fixtureKeys: baselineKeys,
      fixturesExamples: fixturesExamples,
    });
  } else {
    const baseline = await loadProviderBaseline(provider.id, scenario.id);
    if (baseline) {
      const strictKeys = envFlag('HAPPIER_E2E_PROVIDER_STRICT_KEYS', false);
      const diff = diffProviderBaseline({
        baseline,
        observedFixtureKeys: keys,
        observedExamples: fixturesExamples,
        scenario,
        allowExtraKeys: !strictKeys,
      });
      if (!diff.ok) {
        throw new Error(
          `${diff.reason}. To update: HAPPIER_E2E_PROVIDER_UPDATE_BASELINES=1 (baseline: ${providerBaselinePath(provider.id, scenario.id)})`,
        );
      }
    }
  }

  if (scenario.verify) {
    await scenario.verify({
      workspaceDir,
      fixtures,
      traceEvents,
      baseUrl: server.baseUrl,
      token: auth.token,
      sessionId: sessionIdPhase1,
      resumeSessionId: sessionIdPhase2,
      secret,
      resumeId: resumeIdForVerify,
    });
  }
  if (measurement) {
    await measurement.capture.writeArtifact({ artifactDir: measurement.artifactDir });
  }
  writeScenarioManifest?.({
    status: 'passed',
    endedAt: new Date().toISOString(),
    failureClassification: 'none',
  });
  } catch (error) {
    writeScenarioManifest?.({
      status: 'failed',
      endedAt: new Date().toISOString(),
      failureClassification: 'unknown',
    });
    throw error;
  } finally {
    // OpenCode server-native backend starts a detached managed `opencode serve` process.
    // Provider harness runs each scenario with its own isolated happy home; without cleanup,
    // we'd accumulate one server process per scenario and eventually hit resource exhaustion.
    if (provider.id === 'opencode_server') {
      await stopOpenCodeManagedServerFromHomeDir(cliHome).catch(() => {});
      unregisterOpenCodeManagedServerCleanup?.();
    }
  }
}

async function runProviderWithRetry(params: {
  provider: ProviderUnderTest;
  scenario: ProviderScenario;
  server: StartedServer;
  testDir: string;
  cliLaunchSpec?: CliTestLaunchSpec;
  launchEntrypointKind?: DaemonRunnerLaunchEntrypointKind;
  allowFlakeRetry?: boolean;
}): Promise<void> {
  const allowFlakeRetry = params.allowFlakeRetry
    ?? envFlag('HAPPIER_E2E_PROVIDER_FLAKE_RETRY', false);
  await runWithFlakeRetry({
    enabled: allowFlakeRetry,
    flakyErrorMessage: `FLAKY: provider scenario passed on retry (${params.provider.id}.${params.scenario.id})`,
    runOnce: async (attempt) => {
      const attemptDir = attempt === 1 ? params.testDir : `${params.testDir}.retry1`;
      await runOneScenario({ ...params, testDir: attemptDir });
    },
  });
}

export type ProviderContractMatrixOptions = Readonly<{
  providerIds?: readonly string[];
  scenarioIds?: readonly string[];
  cliLaunchSpec?: CliTestLaunchSpec;
  launchEntrypointKind?: DaemonRunnerLaunchEntrypointKind;
  skipWorkspacePreparation?: boolean;
  allowFlakeRetry?: boolean;
}>;

export async function runProviderContractMatrix(
  options: ProviderContractMatrixOptions = {},
): Promise<ProviderContractMatrixResult> {
  if (!options.providerIds && !envFlag('HAPPIER_E2E_PROVIDERS', false)) {
    return { ok: true, skipped: { reason: 'providers disabled (set HAPPIER_E2E_PROVIDERS=1)' } };
  }

  await resetProviderFailureReport();

  const catalog = await loadProvidersFromCliSpecs();
  const requestedProviderIds = options.providerIds;
  if (requestedProviderIds?.length === 0) {
    return { ok: false, error: 'provider_contract_matrix_requested_providers_empty' };
  }
  if (requestedProviderIds) {
    const seen = new Set<string>();
    for (const providerId of requestedProviderIds) {
      if (seen.has(providerId)) {
        return {
          ok: false,
          error: `provider_contract_matrix_requested_provider_duplicate:${providerId}`,
        };
      }
      seen.add(providerId);
    }
  }
  const providersById = new Map(catalog.map((provider) => [provider.id, provider]));
  const missingProviderId = requestedProviderIds?.find((providerId) => !providersById.has(providerId));
  if (missingProviderId) {
    return {
      ok: false,
      error: `provider_contract_matrix_requested_provider_missing:${missingProviderId}`,
    };
  }
  const enabledProviders = requestedProviderIds
    ? requestedProviderIds.map((providerId) => providersById.get(providerId)!)
    : catalog.filter((provider) => envFlag(provider.enableEnvVar, false));
  if (enabledProviders.length === 0) {
    return { ok: true, skipped: { reason: 'no providers enabled (set HAPPIER_E2E_PROVIDER_*=1)' } };
  }

  let server: StartedServer | null = null;
  const skipWarnings: string[] = [];
  try {
    // Provider runs execute the CLI in dev mode (tsx). Ensure shared workspace packages are built so
    // `@happier-dev/*` ESM exports are up-to-date before starting provider processes.
    const setupDir = run.testDir('setup');
    if (!options.skipWorkspacePreparation) {
      await ensureCliSharedDepsBuilt({ testDir: setupDir, env: process.env });
    }
    if (!options.cliLaunchSpec && shouldPrepareProviderCliDist(process.env)) {
      await ensureCliDistBuilt(
        { testDir: setupDir, env: process.env },
        {
          allowRebuild: resolveCliDistPreflightAllowRebuild(),
          waitForAvailabilityMs: resolveCliDistAvailabilityWaitMs(
            process.env.HAPPIER_E2E_CLI_DIST_WAIT_MS ?? process.env.HAPPY_E2E_CLI_DIST_WAIT_MS,
          ),
          buildTimeoutMs: resolveCliDistBuildTimeoutMs(
            process.env.HAPPIER_E2E_CLI_DIST_BUILD_TIMEOUT_MS ?? process.env.HAPPY_E2E_CLI_DIST_BUILD_TIMEOUT_MS,
          ),
        },
      );
    }

    const runnableProviders: ProviderUnderTest[] = [];
    for (const provider of enabledProviders) {
      let missingReason: string | null = null;
      for (const required of provider.requiresBinaries ?? []) {
        if (typeof required === 'string') {
          const resolved = which(required);
          if (!resolved) {
            missingReason = `Missing required binary for provider ${provider.id}: ${required}`;
            break;
          }
          continue;
        }

        const override = typeof required.envOverride === 'string' ? (process.env[required.envOverride] ?? '').trim() : '';
        if (override) {
          if (required.requireExists && !existsSync(override)) {
            missingReason = `${required.envOverride} does not exist: ${override}`;
            break;
          }
          continue;
        }

        const resolved = which(required.bin);
        if (!resolved) {
          const hint = required.envOverride
            ? ` (or set ${required.envOverride}=/absolute/path/to/${required.bin})`
            : '';
          missingReason = `Missing required binary for provider ${provider.id}: ${required.bin}${hint}`;
          break;
        }
      }
      if (missingReason) {
        const warning = formatProviderSkipWarning({ providerId: provider.id, reason: missingReason });
        skipWarnings.push(warning);
        // eslint-disable-next-line no-console
        console.warn(warning);
        continue;
      }
      runnableProviders.push(provider);
    }

    if (runnableProviders.length === 0) {
      const reason = skipWarnings.length > 0
        ? `all enabled providers skipped (${skipWarnings.length})`
        : 'no runnable providers after preflight';
      return { ok: true, skipped: { reason } };
    }

    const serverDir = run.testDir('server');
    server = await startServerLight({ testDir: serverDir });

    const filter = parseScenarioFilter();

    for (const provider of runnableProviders) {
      const providerStartedAt = Date.now();
      let scenarios: ProviderScenario[];

      if (options.scenarioIds) {
        scenarios = options.scenarioIds.map((id) => resolveScenarioById({ provider, id }));
      } else if (filter.ids) {
        const ids = [...filter.ids];
        scenarios = ids.map((id) => resolveScenarioById({ provider, id }));
      } else if (filter.tier) {
        scenarios = resolveScenariosForProvider({ provider, tier: filter.tier });
      } else {
        // No explicit filter: run all scenarios listed in both tiers, preserving registry order.
        scenarios = [
          ...resolveScenariosForProvider({ provider, tier: 'smoke' }),
          ...resolveScenariosForProvider({ provider, tier: 'extended' }),
        ];
      }

      if (scenarios.length === 0) continue;

      let providerSkipped = false;
      if (shouldLogProviderProgress) {
        // eslint-disable-next-line no-console
        console.log(`[providers] start ${provider.id} scenarios=${scenarios.length}`);
      }
      for (const scenario of scenarios) {
        const testDir = run.testDir(`${provider.id}.${scenario.id}`);
        try {
          const scenarioStartedAt = Date.now();
          if (shouldLogProviderProgress) {
            // eslint-disable-next-line no-console
            console.log(`[providers] start ${provider.id}.${scenario.id}`);
          }
          await runProviderWithRetry({
            provider,
            scenario,
            server,
            testDir,
            ...(options.cliLaunchSpec ? { cliLaunchSpec: options.cliLaunchSpec } : {}),
            ...(options.launchEntrypointKind
              ? { launchEntrypointKind: options.launchEntrypointKind }
              : {}),
            ...(options.allowFlakeRetry === undefined
              ? {}
              : { allowFlakeRetry: options.allowFlakeRetry }),
          });
          if (shouldLogProviderProgress) {
            // eslint-disable-next-line no-console
            console.log(
              `[providers] done ${provider.id}.${scenario.id} elapsed=${Math.round((Date.now() - scenarioStartedAt) / 1000)}s`,
            );
          }
        } catch (e: any) {
          const reason = String(e?.message ?? e);
          if (isSkippableProviderUnavailabilityError(reason)) {
            const warning = formatProviderSkipWarning({ providerId: provider.id, reason });
            skipWarnings.push(warning);
            // eslint-disable-next-line no-console
            console.warn(warning);
            providerSkipped = true;
            break;
          }
          await writeProviderFailureReport({
            providerId: String(provider.id),
            scenarioId: scenario.id,
            error: reason,
          });
          throw e;
        }
      }
      if (shouldLogProviderProgress) {
        // eslint-disable-next-line no-console
        console.log(
          `[providers] done ${provider.id} elapsed=${Math.round((Date.now() - providerStartedAt) / 1000)}s`,
        );
      }
      if (providerSkipped) continue;
    }

    if (skipWarnings.length > 0) {
      // eslint-disable-next-line no-console
      console.warn(`[providers] completed with ${skipWarnings.length} skipped provider preflight/runtime checks`);
      return { ok: true, skipped: { reason: `skipped providers: ${skipWarnings.length}` } };
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  } finally {
    await server?.stop();
  }
}
