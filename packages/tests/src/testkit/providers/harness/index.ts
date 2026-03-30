import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

import { createRunDirs } from '../../runDir';
import { startServerLight, type StartedServer } from '../../process/serverLight';
import { createTestAuth } from '../../auth';
import { createSessionWithCiphertexts, fetchMessagesSince, fetchSessionV2 } from '../../sessions';
import { envFlag } from '../../env';
import { writeTestManifestForServer } from '../../manifestForServer';
import { runLoggedCommand, spawnLoggedProcess, type SpawnedProcess } from '../../process/spawnProcess';
import { repoRootDir } from '../../paths';
import { decryptLegacyBase64, encryptLegacyBase64 } from '../../messageCrypto';
import { writeCliSessionAttachFile } from '../../cliAttachFile';
import { startTestDaemon, stopDaemonFromHomeDir, type StartedDaemon } from '../../daemon/daemon';
import { sleep } from '../../timing';
import { createUserScopedSocketCollector } from '../../socketClient';
import { which, yarnCommand } from '../../process/commands';
import { ensureCliDistBuilt, ensureCliSharedDepsBuilt } from '../../process/cliDist';
import { enqueuePendingQueueV2, listPendingQueueV2 } from '../../pendingQueueV2';
import { seedCliAuthForServer } from '../../cliAuth';

import { runWithFlakeRetry } from './flakeRetry';

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
import {
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
  extractFatalAgentErrorMessage,
  isSkippableProviderUnavailabilityError,
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
  extractFatalAgentErrorMessage,
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

    const payload = encryptLegacyBase64({ id: req.id, approved, decision: params.decision }, params.secret);
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

function resolveModelIdFromCliArgs(args: string[]): string | null {
  const index = args.indexOf('--model');
  if (index < 0) return null;
  const value = args[index + 1];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function resolveModelIdFromMetadataSnapshot(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const record = metadata as Record<string, unknown>;

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
}): Promise<void> {
  const { provider, scenario, server, testDir } = params;

  const cliHome = resolve(join(testDir, 'cli-home'));
  const workspaceDir = resolve(join(testDir, 'workspace'));
  await mkdir(cliHome, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });

  const unregisterOpenCodeManagedServerCleanup = provider.id === 'opencode_server'
    ? registerOpenCodeManagedServerHomeForCleanup(cliHome)
    : null;

  try {
  if (scenario.setup) {
    await scenario.setup({ workspaceDir, cliHome });
  }

  const startedAt = new Date().toISOString();

  const auth = await createTestAuth(server.baseUrl);

  // Legacy encryption is the simplest way to run real provider flows without requiring dataKey provisioning yet.
  const secret = Uint8Array.from(randomBytes(32));
  await seedCliAuthForServer({ cliHome, serverUrl: server.baseUrl, token: auth.token, secret });

  const metadataCiphertextBase64 = encryptLegacyBase64(
    { path: workspaceDir, host: 'e2e', name: `providers-${provider.id}`, createdAt: Date.now() },
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

  writeTestManifestForServer({
    testDir,
    server,
    startedAt,
    runId: run.runId,
    testName: `${provider.id}.${scenario.id}`,
    sessionIds: [sessionIdPhase1],
    env: {
      HAPPIER_E2E_PROVIDERS: process.env.HAPPIER_E2E_PROVIDERS ?? process.env.HAPPY_E2E_PROVIDERS,
      [provider.enableEnvVar]: process.env[provider.enableEnvVar],
      HAPPIER_E2E_PROVIDER_WAIT_MS: process.env.HAPPIER_E2E_PROVIDER_WAIT_MS ?? process.env.HAPPY_E2E_PROVIDER_WAIT_MS,
      HAPPIER_E2E_PROVIDER_FLAKE_RETRY:
        process.env.HAPPIER_E2E_PROVIDER_FLAKE_RETRY ?? process.env.HAPPY_E2E_PROVIDER_FLAKE_RETRY,
    },
  });

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
      const modelIdFromCliArgs = resolveModelIdFromCliArgs(modelCliArgs);

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

      const attachFile = await writeCliSessionAttachFile({
        cliHome,
        sessionId: params.sessionId,
        secret,
      encryptionVariant: 'legacy',
    });

      const cliEnv: NodeJS.ProcessEnv = applyCliDevTsxTsconfigEnv({
        repoRootDir: repoRootDir(),
        env: {
          ...authedCliEnv,
          HAPPIER_SESSION_ATTACH_FILE: attachFile,
          HAPPIER_STACK_TOOL_TRACE_FILE: params.traceFile,
        },
      });

      // Some code paths (daemon startup via spawnHappyCLI) execute the built CLI entrypoint.
      // Re-check dist before each phase, but do not rebuild it here. Rebuilding dist while other
      // providers are running can invalidate hashed chunk imports in already-running daemon processes.
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

      let daemon: StartedDaemon | null = null;
	      if (
	        shouldStartProviderDaemon({
	          providerProtocol: provider.protocol,
	          hasPostSatisfyRunHook: typeof scenario.postSatisfy?.run === 'function',
	        })
	      ) {
	        const daemonDir = resolve(join(testDir, 'daemon'));
	        await mkdir(daemonDir, { recursive: true });
	        daemon = await startTestDaemon({ testDir: daemonDir, happyHomeDir: cliHome, env: cliEnv });
	      }

      const proc: SpawnedProcess = spawnLoggedProcess({
        command: yarnCommand(),
        args: buildProviderDevCommandArgs({
          providerSubcommand: provider.cli.subcommand,
          sessionId: params.sessionId,
          yoloCliArgs,
          permissionCliArgs: cliPermissionArgs,
          modelCliArgs,
          extraCliArgs: params.extraCliArgs ?? [],
          scenarioCliArgs,
          providerCliExtraArgs: provider.cli.extraArgs ?? [],
        }),
        cwd: repoRootDir(),
      env: cliEnv,
      stdoutPath: params.stdoutPath,
      stderrPath: params.stderrPath,
    });

      let uiSocket: Awaited<ReturnType<typeof waitForPermissionRpcReady>>['socket'] | null = null;
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
                  event.protocol === provider.protocol &&
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
      await enqueuePrompt(
        steps[0]!.prompt({ workspaceDir }),
        resolveMeta(steps[0]!.messageMeta),
      );

      const startedWaitAt = Date.now();
      let lastSeenMessageSeq = 0;
      let lastMessagePollAt = 0;
      let lastProviderActivityAt = Date.now();
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
          const newMessages = await fetchMessagesSince({
            baseUrl: server.baseUrl,
            token: auth.token,
            sessionId: params.sessionId,
            afterSeq: lastSeenMessageSeq,
          }).catch(() => []);

          if (newMessages.length > 0) {
            lastProviderActivityAt = Date.now();
            lastSeenMessageSeq = Math.max(lastSeenMessageSeq, ...newMessages.map((m) => m.seq));
            const decodedMessages = newMessages.flatMap((m) => {
              try {
                return [normalizeDecodedTranscriptValue(decryptLegacyBase64(m.content.c, secret))];
              } catch {
                return [];
              }
            });
            if (decodedMessages.length > 0) {
              decodedMessagesSeen.push(...decodedMessages);
              if (decodedMessagesSeen.length > 2_000) {
                decodedMessagesSeen.splice(0, decodedMessagesSeen.length - 2_000);
              }
            }
            const fatal = extractFatalAgentErrorMessage(decodedMessages);
            if (fatal) {
              throw new Error(`Fatal provider assistant error (${provider.id}.${scenario.id}): ${fatal}`);
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
              e.protocol === provider.protocol &&
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
	              const okToEnqueueNext = shouldEnqueueNextStepAfterSatisfaction({
	                providerProtocol: provider.protocol,
	                allowInFlightSteer: step?.allowInFlightSteer,
	                traceEvents: relevant,
	                decodedMessagesSeen,
	                taskCompleteCountAtStepSatisfaction: taskCompleteCountAtCurrentStepStart,
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
	              }
	            }
	          }

          if (
            scenarioSatisfiedByTrace(relevant as any, satisfactionScenario) &&
            scenarioSatisfiedByMessages({ decodedMessages: decodedMessagesSeen, socketEvents: uiSocket?.getEvents() ?? [] }, satisfactionScenario)
          ) {
            const postSatisfy = scenario.postSatisfy;
            if (postSatisfy) {
              await runPostSatisfyWithPermissionPump(async () => {
                if (postSatisfy.run) {
                  await postSatisfy.run({
                    workspaceDir,
                    baseUrl: server.baseUrl,
                    token: auth.token,
                    sessionId: params.sessionId,
                    secret,
                    cliHome,
                  });
                }

                const toolName = postSatisfy.waitForAcpSidechainFromToolName;
                if (typeof toolName === 'string' && toolName.trim().length > 0) {
                  const sidechainId = findFirstToolCallIdByName(relevant as any, toolName);
                  if (sidechainId) {
                    await waitForAcpSidechainMessages({
                      baseUrl: server.baseUrl,
                      token: auth.token,
                      sessionId: params.sessionId,
                      secret,
                      sidechainId,
                      timeoutMs: postSatisfy.timeoutMs,
                    });
                  }
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
      } finally {
        try {
          uiSocket?.close();
        } catch {
          // ignore
        }
        await daemon?.stop().catch(() => {});
        await proc.stop();
        await stopDaemonFromHomeDir(cliHome).catch(() => {});
      }
    }

  const hasSteps = Array.isArray(scenario.steps) && scenario.steps.length > 0;
  if (!hasSteps && !scenario.prompt) {
    throw new Error(`Scenario ${provider.id}.${scenario.id} is missing both prompt and steps`);
  }

  const phase1 = await runPhase({
    sessionId: sessionIdPhase1,
    traceFile: traceFilePhase1,
    phase: scenario.resume ? 'phase1' : 'single',
    promptText: scenario.prompt ? scenario.prompt({ workspaceDir }) : '',
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
      writeTestManifestForServer({
        testDir,
        server,
        startedAt,
        runId: run.runId,
        testName: `${provider.id}.${scenario.id}`,
        sessionIds: [sessionIdPhase1, sessionIdPhase2],
        env: {
          HAPPIER_E2E_PROVIDERS: process.env.HAPPIER_E2E_PROVIDERS ?? process.env.HAPPY_E2E_PROVIDERS,
          [provider.enableEnvVar]: process.env[provider.enableEnvVar],
          HAPPIER_E2E_PROVIDER_WAIT_MS:
            process.env.HAPPIER_E2E_PROVIDER_WAIT_MS ?? process.env.HAPPY_E2E_PROVIDER_WAIT_MS,
          HAPPIER_E2E_PROVIDER_FLAKE_RETRY:
            process.env.HAPPIER_E2E_PROVIDER_FLAKE_RETRY ?? process.env.HAPPY_E2E_PROVIDER_FLAKE_RETRY,
        },
      });
    } else {
      sessionIdPhase2 = sessionIdPhase1;
    }

    const phase2 = await runPhase({
      sessionId: sessionIdPhase2 ?? sessionIdPhase1,
      traceFile: traceFilePhase2,
      phase: 'phase2',
      promptText: scenario.resume.prompt({ workspaceDir }),
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

  const traceEvents = readJsonlEvents(mergedTraceRaw);

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
          e.protocol === provider.protocol &&
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
}): Promise<void> {
  const allowFlakeRetry = envFlag('HAPPIER_E2E_PROVIDER_FLAKE_RETRY', false);
  await runWithFlakeRetry({
    enabled: allowFlakeRetry,
    flakyErrorMessage: `FLAKY: provider scenario passed on retry (${params.provider.id}.${params.scenario.id})`,
    runOnce: async (attempt) => {
      const attemptDir = attempt === 1 ? params.testDir : `${params.testDir}.retry1`;
      await runOneScenario({ ...params, testDir: attemptDir });
    },
  });
}

export async function runProviderContractMatrix(): Promise<ProviderContractMatrixResult> {
  if (!envFlag('HAPPIER_E2E_PROVIDERS', false)) {
    return { ok: true, skipped: { reason: 'providers disabled (set HAPPIER_E2E_PROVIDERS=1)' } };
  }

  await resetProviderFailureReport();

  const catalog = await loadProvidersFromCliSpecs();
  const enabledProviders = catalog.filter((p) => envFlag(p.enableEnvVar, false));
  if (enabledProviders.length === 0) {
    return { ok: true, skipped: { reason: 'no providers enabled (set HAPPIER_E2E_PROVIDER_*=1)' } };
  }

  let server: StartedServer | null = null;
  const skipWarnings: string[] = [];
  try {
    // Provider runs execute the CLI in dev mode (tsx). Ensure shared workspace packages are built so
    // `@happier-dev/*` ESM exports are up-to-date before starting provider processes.
    const setupDir = run.testDir('setup');
    await ensureCliSharedDepsBuilt({ testDir: setupDir, env: process.env });
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

      if (filter.ids) {
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
          await runProviderWithRetry({ provider, scenario, server, testDir });
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
