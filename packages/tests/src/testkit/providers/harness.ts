import { mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

import { createRunDirs } from '../runDir';
import { startServerLight, type StartedServer } from '../process/serverLight';
import { createTestAuth } from '../auth';
import { createSessionWithCiphertexts, fetchMessagesSince, fetchSessionV2 } from '../sessions';
import { envFlag } from '../env';
import { writeTestManifestForServer } from '../manifestForServer';
import { runLoggedCommand, spawnLoggedProcess, type SpawnedProcess } from '../process/spawnProcess';
import { repoRootDir } from '../paths';
import { decryptLegacyBase64, encryptLegacyBase64 } from '../messageCrypto';
import { writeCliSessionAttachFile } from '../cliAttachFile';
import { stopDaemonFromHomeDir } from '../daemon/daemon';
import { sleep } from '../timing';
import { createUserScopedSocketCollector, type CapturedEvent } from '../socketClient';
import { parsePositiveInt } from '../numbers';
import { which, yarnCommand } from '../process/commands';
import { ensureCliDistBuilt, ensureCliSharedDepsBuilt } from '../process/cliDist';
import { fetchJson } from '../http';
import { enqueuePendingQueueV2, listPendingQueueV2 } from '../pendingQueueV2';
import { seedCliAuthForServer } from '../cliAuth';

import type { ProviderContractMatrixResult, ProviderFixtureExamples, ProviderFixtures, ProviderScenario, ProviderUnderTest } from './types';
import {
  diffProviderBaseline,
  loadProviderBaseline,
  providerBaselinePath,
  selectBaselineFixtureKeysFromScenario,
  writeProviderBaseline,
} from './baselines';
import { validateNormalizedToolFixturesV2 } from './validateToolSchemas';
import { checkMaxTraceEvents, scenarioSatisfiedByTrace } from './traceSatisfaction';
import { loadProvidersFromCliSpecs } from './providerSpecs';
import { waitForAcpSidechainMessages } from './assertions';
import { scenarioCatalog } from './scenarioCatalog';
import { resolveProviderAuthOverlay } from './providerAuthOverlay';
import { applyHomeIsolationEnv } from './harnessEnv';
import { resolveAcpToolPermissionPromptExpectation } from './acpPermissionPrompts';
import {
  extractFatalAgentErrorMessage,
  isSkippableProviderUnavailabilityError,
  readFatalProviderErrorFromCliLogs,
  resolveCliDistPreflightAllowRebuild,
  resolveCliDistAvailabilityWaitMs,
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

export {
  extractFatalAgentErrorMessage,
  isSkippableProviderUnavailabilityError,
  readFatalProviderErrorFromCliLogs,
  resolveCliDistPreflightAllowRebuild,
  resolveCliDistAvailabilityWaitMs,
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

type ToolTraceEventV1 = {
  v: number;
  ts: number;
  direction: string;
  sessionId: string;
  protocol: string;
  provider?: string;
  kind: string;
  payload: any;
  localId?: string;
};

export type ProviderTokenTelemetryEntryV1 = {
  v: 1;
  providerId: string;
  scenarioId: string;
  phase: 'single' | 'phase1' | 'phase2';
  sessionId: string;
  key: string;
  timestamp: number;
  tokens: Record<string, number>;
  modelId: string | null;
  source: 'socket-ephemeral-usage';
};

type ProviderTokenTelemetryReportV1 = {
  v: 1;
  runId: string;
  generatedAt: number;
  entries: ProviderTokenTelemetryEntryV1[];
};

const run = createRunDirs({ runLabel: 'providers' });

function formatProviderSkipWarning(params: { providerId: string; reason: string }): string {
  const cleaned = params.reason.replace(/\s+/g, ' ').trim();
  const compact = cleaned.length > 240 ? `${cleaned.slice(0, 237)}...` : cleaned;
  return `[providers] skipping ${params.providerId}: ${compact}`;
}

type ProviderFailureReportV1 = {
  v: 1;
  providerId: string;
  scenarioId: string;
  error: string;
  ts: number;
};

function providerFailureReportPathFromEnv(): string | null {
  const raw = (
    process.env.HAPPIER_E2E_PROVIDER_FAILURE_REPORT_PATH ??
    process.env.HAPPY_E2E_PROVIDER_FAILURE_REPORT_PATH ??
    ''
  ).trim();
  return raw.length > 0 ? raw : null;
}

async function resetProviderFailureReport(): Promise<void> {
  const reportPath = providerFailureReportPathFromEnv();
  if (!reportPath) return;
  await rm(reportPath, { force: true }).catch(() => undefined);
}

async function writeProviderFailureReport(params: {
  providerId: string;
  scenarioId: string;
  error: string;
}): Promise<void> {
  const reportPath = providerFailureReportPathFromEnv();
  if (!reportPath) return;
  const payload: ProviderFailureReportV1 = {
    v: 1,
    providerId: params.providerId,
    scenarioId: params.scenarioId,
    error: params.error,
    ts: Date.now(),
  };
  await writeFile(reportPath, JSON.stringify(payload, null, 2), 'utf8').catch(() => undefined);
}

function providerTokenTelemetryReportPath(): string {
  const raw = (
    process.env.HAPPIER_E2E_PROVIDER_TOKEN_LEDGER_PATH ??
    process.env.HAPPY_E2E_PROVIDER_TOKEN_LEDGER_PATH ??
    ''
  ).trim();
  if (raw.length > 0) return resolve(raw);
  return resolve(join(run.runDir, 'provider-token-ledger.v1.json'));
}

function normalizeTokenNumberMap(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) continue;
    out[key] = value;
  }
  return out;
}

export function extractProviderTokenTelemetryEntries(params: {
  providerId: string;
  scenarioId: string;
  phase: 'single' | 'phase1' | 'phase2';
  sessionId: string;
  modelId: string | null;
  events: CapturedEvent[];
}): ProviderTokenTelemetryEntryV1[] {
  const out: ProviderTokenTelemetryEntryV1[] = [];
  for (const event of params.events) {
    if (event.kind !== 'ephemeral') continue;
    const payload = event.payload as Record<string, unknown> | undefined;
    if (!payload || payload.type !== 'usage') continue;

    const keyRaw = typeof payload.key === 'string' ? payload.key.trim() : '';
    const key = keyRaw.length > 0 ? keyRaw : 'unknown';
    const timestamp = typeof payload.timestamp === 'number' && Number.isFinite(payload.timestamp) ? payload.timestamp : event.at;
    const tokens = normalizeTokenNumberMap(payload.tokens);

    out.push({
      v: 1,
      providerId: params.providerId,
      scenarioId: params.scenarioId,
      phase: params.phase,
      sessionId: params.sessionId,
      key,
      timestamp,
      tokens,
      modelId: params.modelId,
      source: 'socket-ephemeral-usage',
    });
  }
  return out;
}

async function appendProviderTokenTelemetryEntries(entries: ProviderTokenTelemetryEntryV1[]): Promise<void> {
  if (!Array.isArray(entries) || entries.length === 0) return;
  const reportPath = providerTokenTelemetryReportPath();
  let existingEntries: ProviderTokenTelemetryEntryV1[] = [];
  try {
    const raw = await readFileText(reportPath);
    const parsed = JSON.parse(raw) as Partial<ProviderTokenTelemetryReportV1>;
    if (parsed && parsed.v === 1 && Array.isArray(parsed.entries)) {
      existingEntries = parsed.entries as ProviderTokenTelemetryEntryV1[];
    }
  } catch {
    // Best-effort merge.
  }

  const next: ProviderTokenTelemetryReportV1 = {
    v: 1,
    runId: run.runId,
    generatedAt: Date.now(),
    entries: [...existingEntries, ...entries],
  };
  await writeFile(reportPath, JSON.stringify(next, null, 2) + '\n', 'utf8');
}

export function findFirstToolCallIdByName(events: Array<Pick<ToolTraceEventV1, 'kind' | 'payload'>>, toolName: string): string | null {
  for (const e of events) {
    if (e.kind !== 'tool-call') continue;
    const name = e.payload?.name;
    if (typeof name !== 'string' || name !== toolName) continue;
    const callId = e.payload?.callId ?? e.payload?.id ?? e.payload?.toolCallId;
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

function resolveYoloForScenario(scenario: ProviderScenario): boolean {
  if (typeof scenario.yolo === 'boolean') return scenario.yolo;
  return envFlag('HAPPIER_E2E_PROVIDER_YOLO_DEFAULT', true);
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
  if (params.scenario.allowPermissionAutoApproveInYolo === true) return true;
  if (!params.yolo || params.provider.protocol !== 'acp') return false;

  const mode = resolveScenarioPermissionMode({
    scenarioMeta: params.scenarioMeta,
    yolo: params.yolo,
  });
  return resolveAcpToolPermissionPromptExpectation({
    acpPermissions: params.provider.permissions?.acp,
    mode,
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

export function resolveCodexCliPermissionArgs(params: {
  providerSubcommand: string;
  yolo: boolean;
  scenarioMeta: Record<string, unknown>;
}): string[] {
  if (params.providerSubcommand !== 'codex') return [];

  const raw = params.scenarioMeta.permissionMode;
  const modeFromMeta = typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null;
  const mode = modeFromMeta ?? (params.yolo ? 'yolo' : null);
  if (!mode) return [];

  const updatedAtRaw = params.scenarioMeta.permissionModeUpdatedAt;
  const updatedAt = typeof updatedAtRaw === 'number' && Number.isFinite(updatedAtRaw) && updatedAtRaw > 0
    ? Math.floor(updatedAtRaw)
    : Date.now();

  return ['--permission-mode', mode, '--permission-mode-updated-at', String(updatedAt)];
}

export function resolveYoloCliArgs(params: {
  providerSubcommand: string;
  yolo: boolean;
  hasExplicitPermissionModeArgs: boolean;
}): string[] {
  if (!params.yolo) return [];
  if (
    params.hasExplicitPermissionModeArgs &&
    ['codex', 'opencode', 'kilo', 'gemini', 'qwen', 'kimi', 'auggie'].includes(params.providerSubcommand)
  ) {
    return [];
  }
  return ['--yolo'];
}

function normalizeProviderModelEnvSuffix(providerId: string): string {
  return providerId
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function parseProviderModelOverridesMap(raw: string | undefined, providerId: string): string | null {
  const source = typeof raw === 'string' ? raw.trim() : '';
  if (!source) return null;
  const target = providerId.trim().toLowerCase();
  if (!target) return null;

  const entries = source
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  for (const entry of entries) {
    const splitIndex = entry.indexOf('=');
    if (splitIndex <= 0) continue;
    const key = entry.slice(0, splitIndex).trim().toLowerCase();
    const value = entry.slice(splitIndex + 1).trim();
    if (key === target && value.length > 0) return value;
  }
  return null;
}

export function resolveProviderModelCliArgs(params: {
  providerId: string;
  env?: NodeJS.ProcessEnv;
  nowMs?: () => number;
}): string[] {
  const env = params.env ?? process.env;
  const providerSuffix = normalizeProviderModelEnvSuffix(params.providerId);
  const providerModel =
    env[`HAPPIER_E2E_PROVIDER_MODEL_${providerSuffix}`] ??
    env[`HAPPY_E2E_PROVIDER_MODEL_${providerSuffix}`] ??
    null;
  const mappedModel =
    parseProviderModelOverridesMap(
      env.HAPPIER_E2E_PROVIDER_MODELS ?? env.HAPPY_E2E_PROVIDER_MODELS,
      params.providerId,
    ) ?? null;
  const globalModel = env.HAPPIER_E2E_PROVIDER_MODEL ?? env.HAPPY_E2E_PROVIDER_MODEL ?? null;
  const model = [providerModel, mappedModel, globalModel]
    .find((candidate) => typeof candidate === 'string' && candidate.trim().length > 0)
    ?.trim();
  if (!model) return [];

  const now = Math.floor((params.nowMs ?? Date.now)());
  return ['--model', model, '--model-updated-at', String(now)];
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

function resolveScenarioById(params: { provider: ProviderUnderTest; id: string; expectedTier?: 'smoke' | 'extended' }): ProviderScenario {
  const factory = scenarioCatalog[params.id];
  if (!factory) throw new Error(`Unknown scenario id: ${params.id}`);
  const scenario = factory(params.provider);
  if (!scenario || typeof scenario !== 'object') throw new Error(`Scenario factory returned invalid scenario: ${params.id}`);
  if (scenario.id !== params.id) throw new Error(`Scenario factory returned mismatched id: expected ${params.id}, got ${scenario.id}`);
  if (params.expectedTier) {
    const tier = (scenario.tier ?? 'extended') as 'smoke' | 'extended';
    if (tier !== params.expectedTier) {
      throw new Error(`Scenario tier mismatch (${params.id}): expected ${params.expectedTier}, got ${tier}`);
    }
  }
  return scenario;
}

export function resolveScenariosForProvider(params: { provider: ProviderUnderTest; tier: 'smoke' | 'extended' }): ProviderScenario[] {
  const ids = (() => {
    const registry = params.provider.scenarioRegistry as any;
    const tiersByAuthMode = registry?.tiersByAuthMode as
      | { host?: { smoke: string[]; extended: string[] }; env?: { smoke: string[]; extended: string[] } }
      | undefined;
    if (!tiersByAuthMode) return params.provider.scenarioRegistry.tiers[params.tier] ?? [];

    // Best-effort: select the auth mode using the same overlay selection logic as the harness
    // uses later when spawning the provider. This keeps scenario selection consistent with the
    // chosen authentication mechanism (API key vs host-local CLI auth).
    const baseEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...(params.provider.cli.env ?? {}),
      ...Object.fromEntries(
        Object.entries(params.provider.cli.envFrom ?? {}).flatMap(([dest, src]) => {
          const value = typeof process.env[src] === 'string' ? process.env[src]!.trim() : '';
          return value ? [[dest, value]] : [];
        }),
      ),
    };
    const { mode } = resolveProviderAuthOverlay({ auth: params.provider.auth, baseEnv });

    const override = (tiersByAuthMode as any)?.[mode]?.[params.tier] as string[] | undefined;
    return override ?? params.provider.scenarioRegistry.tiers[params.tier] ?? [];
  })();
  return ids.map((id) => resolveScenarioById({ provider: params.provider, id, expectedTier: params.tier }));
}

export function selectScenariosFromRegistry(params: {
  scenarios: ProviderScenario[];
  registry: ProviderUnderTest['scenarioRegistry'];
  tier: 'smoke' | 'extended';
}): ProviderScenario[] {
  const ids = params.registry.tiers[params.tier] ?? [];
  const byId = new Map(params.scenarios.map((s) => [s.id, s] as const));
  const selected: ProviderScenario[] = [];

  for (const id of ids) {
    const s = byId.get(id);
    if (!s) throw new Error(`Scenario registry references unknown scenario id: ${id}`);
    const t = (s.tier ?? 'extended') as 'smoke' | 'extended';
    if (t !== params.tier) {
      throw new Error(`Scenario registry references scenario with mismatched tier (${id}): expected ${params.tier}, got ${t}`);
    }
    selected.push(s);
  }

  return selected;
}

function parseScenarioFilter(): { ids: Set<string> | null; tier: 'smoke' | 'extended' | null } {
  const rawIds =
    typeof (process.env.HAPPIER_E2E_PROVIDER_SCENARIOS ?? process.env.HAPPY_E2E_PROVIDER_SCENARIOS) === 'string'
      ? (process.env.HAPPIER_E2E_PROVIDER_SCENARIOS ?? process.env.HAPPY_E2E_PROVIDER_SCENARIOS)?.trim() ?? ''
      : '';
  if (rawIds) {
    const ids = new Set(rawIds.split(',').map((s) => s.trim()).filter((s) => s.length > 0));
    return { ids: ids.size ? ids : null, tier: null };
  }

  const rawTier =
    typeof (process.env.HAPPIER_E2E_PROVIDER_SCENARIO_TIER ?? process.env.HAPPY_E2E_PROVIDER_SCENARIO_TIER) === 'string'
      ? (process.env.HAPPIER_E2E_PROVIDER_SCENARIO_TIER ?? process.env.HAPPY_E2E_PROVIDER_SCENARIO_TIER)?.trim() ?? ''
      : '';
  if (!rawTier) return { ids: null, tier: null };
  const tier = rawTier === 'smoke' || rawTier === 'extended' ? rawTier : null;
  return { ids: null, tier };
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

  if (scenario.setup) {
    await scenario.setup({ workspaceDir });
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
        hasExplicitPermissionModeArgs:
          cliPermissionArgs.length > 0 ||
          (typeof scenarioMeta.permissionMode === 'string' && scenarioMeta.permissionMode.trim().length > 0),
      });
      const modelCliArgs = resolveProviderModelCliArgs({
        providerId: provider.id,
      });
      const modelIdFromCliArgs = resolveModelIdFromCliArgs(modelCliArgs);

      const attachFile = await writeCliSessionAttachFile({
        cliHome,
        sessionId: params.sessionId,
        secret,
      encryptionVariant: 'legacy',
    });

      const cliEnv: NodeJS.ProcessEnv = {
        ...authedCliEnv,
        HAPPIER_SESSION_ATTACH_FILE: attachFile,
        HAPPIER_STACK_TOOL_TRACE_FILE: params.traceFile,
      };

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
        },
      );

      const proc: SpawnedProcess = spawnLoggedProcess({
        command: yarnCommand(),
        args: [
          '-s',
          'workspace',
          '@happier-dev/cli',
          'dev',
          provider.cli.subcommand,
          '--existing-session',
          params.sessionId,
          ...yoloCliArgs,
          ...cliPermissionArgs,
          ...modelCliArgs,
          ...(params.extraCliArgs ?? []),
          ...(provider.cli.extraArgs ?? []),
        ],
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

      let traceRaw = '';
      let traceEvents: ToolTraceEventV1[] = [];
      const satisfactionScenario = {
        requiredFixtureKeys: scenario.requiredFixtureKeys ?? [],
        requiredAnyFixtureKeys: scenario.requiredAnyFixtureKeys,
        requiredTraceSubstrings: params.traceSubstringsOverride ?? scenario.requiredTraceSubstrings,
      };
      const inactivityTimeoutMs = resolveProviderInactivityTimeoutMs(
        process.env.HAPPIER_E2E_PROVIDER_NO_ACTIVITY_TIMEOUT_MS ?? process.env.HAPPY_E2E_PROVIDER_NO_ACTIVITY_TIMEOUT_MS,
        maxWaitMs,
        provider.id,
      );
      const permissionBlockTimeoutMs = resolveProviderPermissionBlockTimeoutMs(
        process.env.HAPPIER_E2E_PROVIDER_PERMISSION_BLOCK_TIMEOUT_MS ??
          process.env.HAPPY_E2E_PROVIDER_PERMISSION_BLOCK_TIMEOUT_MS,
        maxWaitMs,
      );

      let satisfied = false;
      while (Date.now() - startedWaitAt < maxWaitMs) {
        const fatalFromLogs = await readFatalProviderErrorFromCliLogs({ cliHome });
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
                return [decryptLegacyBase64(m.content.c, secret)];
              } catch {
                return [];
              }
            });
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

          const relevant = traceEvents.filter(
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
            if (scenarioSatisfiedByTrace(relevant as any, satisfaction)) {
              stepIndex++;
              const nextStep = steps[stepIndex]!;
              await enqueuePrompt(nextStep.prompt({ workspaceDir }), resolveMeta(nextStep.messageMeta));
            }
          }

          if (scenarioSatisfiedByTrace(relevant as any, satisfactionScenario)) {
            if (scenario.postSatisfy) {
              await runPostSatisfyWithPermissionPump(async () => {
                if (scenario.postSatisfy?.run) {
                  await scenario.postSatisfy.run({
                    workspaceDir,
                    baseUrl: server.baseUrl,
                    token: auth.token,
                    sessionId: params.sessionId,
                    secret,
                    cliHome,
                  });
                }

                const toolName = scenario.postSatisfy?.waitForAcpSidechainFromToolName;
                if (typeof toolName === 'string' && toolName.trim().length > 0) {
                  const sidechainId = findFirstToolCallIdByName(relevant as any, toolName);
                  if (sidechainId) {
                    await waitForAcpSidechainMessages({
                      baseUrl: server.baseUrl,
                      token: auth.token,
                      sessionId: params.sessionId,
                      secret,
                      sidechainId,
                      timeoutMs: scenario.postSatisfy.timeoutMs,
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
        throw new Error(
          `Timed out waiting for scenario satisfaction after ${maxWaitMs}ms (${provider.id}.${scenario.id}): ` +
          `requiredFixtureKeys=${requiredFixtureKeys.join(',') || '(none)'} ` +
          `requiredAnyFixtureKeys=${requiredAnyFixtureKeys.map((bucket) => `[${bucket.join('|')}]`).join(',') || '(none)'} ` +
          `requiredTraceSubstrings=${requiredTraceSubstrings.join(',') || '(none)'}`,
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
        const tokenTelemetryEntries = extractProviderTokenTelemetryEntries({
          providerId: String(provider.id),
          scenarioId: scenario.id,
          phase: params.phase,
          sessionId: params.sessionId,
          modelId,
          events: socketEvents,
        });

        return { traceRaw: finalRaw, traceEvents: finalEvents, tokenTelemetryEntries };
      } finally {
        try {
          uiSocket?.close();
        } catch {
          // ignore
        }
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
    await (await import('node:fs/promises')).writeFile(mergedTraceFile, mergedTraceRaw, 'utf8');

    await appendProviderTokenTelemetryEntries([
      ...phase1.tokenTelemetryEntries,
      ...phase2.tokenTelemetryEntries,
    ]);
  } else {
    await appendProviderTokenTelemetryEntries([...phase1.tokenTelemetryEntries]);
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
    const relevant = traceEvents.filter(
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
}

async function runProviderWithRetry(params: {
  provider: ProviderUnderTest;
  scenario: ProviderScenario;
  server: StartedServer;
  testDir: string;
}): Promise<void> {
  const allowFlakeRetry = envFlag('HAPPIER_E2E_PROVIDER_FLAKE_RETRY', false);
  if (!allowFlakeRetry) {
    await runOneScenario(params);
    return;
  }
  try {
    await runOneScenario(params);
  } catch (e1: any) {
    try {
      await runOneScenario(params);
    } catch {
      throw e1;
    }
    throw new Error(`FLAKY: provider scenario passed on retry (${params.provider.id}.${params.scenario.id})`);
  }
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
      for (const scenario of scenarios) {
        const testDir = run.testDir(`${provider.id}.${scenario.id}`);
        try {
          await runProviderWithRetry({ provider, scenario, server, testDir });
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
