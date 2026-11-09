import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';

import type { AgentMessage } from '@/agent/core/AgentMessage';
import type {
  ExecutionRunHostRuntime,
  ExecutionRunHostRuntimeMessageHandler,
} from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';
import { createTestExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/testkit';
import { resolveCliEngineRegistry, type ResolvedCliEngineRegistry } from '@/agent/runtime/registry/engineRegistry';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import type { ExecutionRunHostBridge } from '@/agent/runtime/bridges/executionRun/ExecutionRunHostBridge';
import type { ACPMessageData } from '@/api/session/sessionMessageTypes';
import {
  createScmCapabilities,
  accountSettingsParse,
  FeaturesResponseSchema,
  SCM_OPERATION_ERROR_CODES,
  type ActionId,
  type ActionExecutorDeps,
  type ApprovalRequestV1,
  type BackendTargetRefV1,
  type ExecutionRunGetResponse,
  type ExecutionRunPublicState,
  type ExecutionRunStartResponse,
} from '@happier-dev/protocol';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { createExecutionRunRpcApprovalDeps } from './executionRuns/createExecutionRunRpcApprovalDeps';
import type { Credentials } from '@/persistence';

import { createEncryptedRpcTestClient as createEncryptedRpcTestClientBase } from './encryptedRpc.testkit';
import { registerExecutionRunHandlers as registerExecutionRunHandlersBase } from './executionRuns';
import type { RpcActionExecutor } from './_actionDispatchAdapter';
import { buildExecutionRunProfileCatalog } from '@/agent/executionRuns/profiles/intentRegistry';
import { ExecutionBudgetRegistry } from '@/daemon/executionBudget/ExecutionBudgetRegistry';
import { configuration, reloadConfiguration } from '@/configuration';
import { seedTestServerProfile } from '@/testkit/serverProfiles';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { projectAccountRowsReadHttpResponse } from '@/workspaces/projectAccountRows.testkit';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { clearActiveAccountSettingsSnapshot, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { runGit } from '@/scm/rpc/__tests__/testRpcHarness';
import { createScmBackendRegistry, type ScmBackendRegistry } from '@/scm/registry';
import type { ScmBackend, ScmRepoDetection } from '@/scm/types';
import { createMutableApiSessionClientFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createRepositoryCheckpointPromptLifecycle } from '@/agent/runtime/checkpoints/repositoryCheckpointPromptLifecycle';
import { captureScmComparison } from '@/scm/comparisons/captureScmComparison';
import * as sessionRpcTransport from '@/session/transport/rpc/sessionRpc';
import { waitForExecutionRun } from '@/session/services/executionRuns';
import { ExecutionRunWaitResultSchema } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { createSessionRunReportPolicyReader } from '@/api/sessionFollowCreationPreferences';
import { DEFAULT_SESSION_AUTO_FOLLOW_PREFERENCES_V1, DEFAULT_SESSION_FOLLOW_CREATION_POLICIES_V1 } from '@happier-dev/protocol/sessions/follow/accountFollow';

type TestExecutionRunRuntimeFactory = (opts: Readonly<{
  runId?: string;
  backendId: string;
  backendTarget?: BackendTargetRefV1;
  permissionMode: string;
  modelId?: string;
  accountSettings?: Readonly<Record<string, unknown>> | null;
  start?: unknown;
}>) => ExecutionRunHostRuntime;

const runtimeFactoryState = vi.hoisted(() => ({
  current: null as TestExecutionRunRuntimeFactory | null,
}));

const bridgeLifecycleHookMockState = vi.hoisted(() => ({
  dispatchBridgeLifecycleHookEvent: vi.fn().mockResolvedValue(undefined),
}));

const scmBackendRegistryMockState = vi.hoisted(() => ({
  current: null as ScmBackendRegistry | null,
}));

let defaultExecutionRunTestCwd = '';
let defaultExecutionRunTestHome = '';
let executionRunTestEngineRegistry: ResolvedCliEngineRegistry;
const executionRunTestManagers: ExecutionRunHostBridge[] = [];

vi.mock('@/agent/runtime/bridges/executionRun/createExecutionRunBridgeRuntime', () => ({
  createExecutionRunBridgeRuntime: vi.fn((opts: Parameters<TestExecutionRunRuntimeFactory>[0]) => {
    const factory = runtimeFactoryState.current;
    if (!factory) {
      throw new Error('Missing test execution-run runtime factory');
    }
    return factory(opts);
  }),
}));

vi.mock('@/plugins/runtime/hooks/execution/dispatchBridgeLifecycleHookEvent', () => ({
  dispatchBridgeLifecycleHookEvent: bridgeLifecycleHookMockState.dispatchBridgeLifecycleHookEvent,
}));

vi.mock('@/scm/scmBackendCatalog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/scm/scmBackendCatalog')>();
  return {
    ...actual,
    runWithScmBackendRegistryLease: async <T>(
      registry: ScmBackendRegistry | undefined,
      run: (registry: ScmBackendRegistry) => Promise<T>,
    ) => {
      const resolvedRegistry = registry ?? scmBackendRegistryMockState.current;
      if (!resolvedRegistry) {
        throw new Error('Missing test SCM backend registry');
      }
      return await run(resolvedRegistry);
    },
  };
});

vi.mock('@/persistence', async importOriginal => ({
  ...await importOriginal<typeof import('@/persistence')>(),
  readCredentials: vi.fn(),
  readStoredCredentials: vi.fn(async () => null),
  readDaemonState: vi.fn(async () => null),
}));

// The daemon is outside this Session RPC owner; keep its admission parser real.
vi.mock('@/daemon/controlHttp', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/daemon/controlHttp')>();
  const { EXECUTION_RUN_ADMISSION_PATH } = await import('@/daemon/lifecycle/admissionDrain');
  return {
    ...actual,
    daemonPost: async (...args: Parameters<typeof actual.daemonPost>) => args[0] === EXECUTION_RUN_ADMISSION_PATH
      ? { admitted: true }
      : actual.daemonPost(...args),
  };
});

vi.mock('@/session/transport/http/sessionsHttp', () => ({
  fetchSessionById: vi.fn(),
}));

vi.mock('@/session/replay/fetchEncryptedTranscriptMessages', () => ({
  fetchEncryptedTranscriptMessages: vi.fn(),
}));

vi.mock('@/session/replay/summary/runReplaySummaryForDialog', () => ({
  runReplaySummaryForDialog: vi.fn(),
}));

const approvalStoreMockState = vi.hoisted(() => ({
  approvalsUpdate: vi.fn(),
  approvalsGet: vi.fn(),
}));

vi.mock('@/session/actions/approvals/artifactStore', () => ({
  createCliApprovalsArtifactStore: vi.fn(() => ({
    approvalsList: vi.fn(),
    approvalsCreate: vi.fn(),
    approvalsGet: approvalStoreMockState.approvalsGet,
    approvalsUpdate: approvalStoreMockState.approvalsUpdate,
  })),
}));

const voiceEnabledServerSnapshot = {
  status: 'ready',
  features: FeaturesResponseSchema.parse({
    features: {
      voice: { enabled: true },
    },
    capabilities: {},
  }),
} as const satisfies CliServerFeaturesSnapshot;

// Current Voice launch reads the exact Session and Account prompt sources before
// provider start. Seed those real owners and replace only the HTTP boundary.
async function prepareTranscriptCommitLaunch(): Promise<{ credentials: { token: string; encryption: null }; dispose(): void }> {
  transcriptLaunch?.dispose();
  const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'execution-run-test-account' })).toString('base64url')}.signature`, encryption: null };
  setActiveAccountSettingsSnapshot({
    source: 'network', settings: accountSettingsParse({}), rawSettings: {},
    settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [],
    scopeKey: resolveAccountSettingsScopeKey(credentials),
    promptLibraryCatalog: { status: 'ready', rows: [{ revision: 1,
      record: { key: 'voice', value: { v: 1, scope: { kind: 'voice' }, entries: [] } } }],
      tombstones: [], diagnostics: [] },
  });
  const { fetchSessionById } = await import('@/session/transport/http/sessionsHttp');
  vi.mocked(fetchSessionById).mockImplementation(async ({ sessionId }) => createSessionRecordFixture({
    id: sessionId, encryptionMode: 'plain',
    metadata: JSON.stringify(createTestMetadata({ path: defaultExecutionRunTestCwd, machineId: 'execution-run-machine' })),
  }));
  const get = vi.spyOn(axios, 'get').mockImplementation(async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
    if (path !== '/v1/account/encryption/currentness') {
      throw new Error(`Unexpected transcript launch HTTP read: ${url}`);
    }
    return { status: 200, data: { mode: 'plain', version: 0, signingKeyFingerprint: null,
      contentKeyFingerprint: null, updatedAt: 0 } };
  });
  const post = vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
    if (new URL(String(url)).pathname.startsWith('/v1/account/project-rows/')) {
      return projectAccountRowsReadHttpResponse([], String(url), body);
    }
    throw new Error(`Unexpected transcript launch HTTP write: ${url}`);
  });
  return { credentials, dispose: () => { get.mockRestore(); post.mockRestore(); clearActiveAccountSettingsSnapshot(); } };
}

const createEncryptedRpcTestClient = createEncryptedRpcTestClientBase;

function createDetachedRunRpcTestClient(options: Parameters<typeof createEncryptedRpcTestClientBase>[0]) {
  const machineId = 'execution-run-machine';
  const client = createEncryptedRpcTestClientBase(options);
  // These owner tests enter through the in-process transport with already
  // admitted Machine facts; raw encrypted admission has separate composed coverage.
  return { ...client, async call<TResponse, TRequest>(method: string, request: TRequest): Promise<TResponse> {
    return await client.manager.invokeLocal(method, request, { rpcContext: {
      verifyMachineAdmissionCurrent: async () => true,
      machineAdmission: { actorAccountId: 'execution-run-test-account', custodianAccountId: 'execution-run-test-account',
        machineId, installationId: 'execution-run-installation', role: 'manage', encryptionMode: 'plain' },
    } }) as TResponse;
  } };
}

let transcriptLaunch: Awaited<ReturnType<typeof prepareTranscriptCommitLaunch>> | null = null;
afterEach(async () => {
  await Promise.all(executionRunTestManagers.splice(0).map(manager => manager.dispose()));
  transcriptLaunch?.dispose(); transcriptLaunch = null;
  vi.unstubAllEnvs();
  reloadConfiguration();
  rmSync(defaultExecutionRunTestHome, { recursive: true, force: true });
});

type TestExecutionRunHandlerContext = Parameters<typeof registerExecutionRunHandlersBase>[1] & Readonly<{
  createBackend?: TestExecutionRunRuntimeFactory;
  actionExecutor?: RpcActionExecutor;
  actionApprovalDeps?: Pick<
    ActionExecutorDeps,
    'approvalsCreate' | 'approvalsUpdate' | 'approvalsWaitForDecision' | 'approvalsResolveBlockingDecision'
  >;
}>;

const registerExecutionRunHandlers = (
  rpc: Parameters<typeof registerExecutionRunHandlersBase>[0],
  ctx: TestExecutionRunHandlerContext,
) => {
  const { createBackend, ...baseCtx } = ctx;
  const cwd = baseCtx.cwd === process.cwd() ? defaultExecutionRunTestCwd : baseCtx.cwd;
  runtimeFactoryState.current = createBackend ?? (() => {
    throw new Error('Missing test execution-run runtime factory');
  });
  registerExecutionRunHandlersBase(rpc, {
    serverId: 'srv_execution_run_test',
    machineId: 'execution-run-machine',
    runtimeAccountId: 'execution-run-test-account',
    ...baseCtx,
    cwd,
    readPromptCredentials: baseCtx.readPromptCredentials ?? (async () => transcriptLaunch?.credentials ?? null),
    getServerFeaturesSnapshot: baseCtx.getServerFeaturesSnapshot ?? (() => voiceEnabledServerSnapshot),
    // The Account run-report preference read is an HTTP boundary; the default Account choice is Important.
    resolveRunReportPolicy: baseCtx.resolveRunReportPolicy ?? (async () => ({ preset: 'important' })),
    resolveExecutionRunProfileCatalog: baseCtx.resolveExecutionRunProfileCatalog ?? (() => ({
      profileCatalog: baseCtx.executionRunProfileCatalog ?? buildExecutionRunProfileCatalog(),
      engineRegistry: executionRunTestEngineRegistry,
      // The substituted Agent process exposes this native model-catalog fact.
      // The host still runs its real structured-output admission policy.
      readNativeOfferedModel: async ({ modelId }) => ({
        id: modelId, name: modelId, capabilities: { structuredOutput: 'supported' },
      }),
    })),
    onManagerCreated: manager => {
      executionRunTestManagers.push(manager);
      baseCtx.onManagerCreated?.(manager);
    },
  });
};

beforeAll(async () => {
  defaultExecutionRunTestCwd = mkdtempSync(join(tmpdir(), 'happier-execution-runs-default-workspace-'));
  runGit(defaultExecutionRunTestCwd, ['init', '--initial-branch=main']);
  executionRunTestEngineRegistry = await resolveCliEngineRegistry({
    contributes: createResolvedContributionRegistry({}),
  });
});

afterAll(() => {
  if (defaultExecutionRunTestCwd) {
    rmSync(defaultExecutionRunTestCwd, { recursive: true, force: true });
    defaultExecutionRunTestCwd = '';
  }
});

beforeEach(async () => {
  defaultExecutionRunTestHome = mkdtempSync(join(tmpdir(), 'happier-execution-runs-home-'));
  vi.stubEnv('HAPPIER_HOME_DIR', defaultExecutionRunTestHome);
  reloadConfiguration();
  await seedTestServerProfile({ id: configuration.activeServerId, homeId: 'srv_execution_run_test', serverUrl: configuration.serverUrl });
  runtimeFactoryState.current = null;
  scmBackendRegistryMockState.current = createScmBackendRegistry([createTestGitScmBackend()]);
  bridgeLifecycleHookMockState.dispatchBridgeLifecycleHookEvent.mockReset();
  bridgeLifecycleHookMockState.dispatchBridgeLifecycleHookEvent.mockResolvedValue(undefined);
  approvalStoreMockState.approvalsUpdate.mockReset();
  approvalStoreMockState.approvalsGet.mockReset();
  approvalStoreMockState.approvalsUpdate.mockResolvedValue({ ok: true });
  approvalStoreMockState.approvalsGet.mockResolvedValue(null);
  const { readCredentials, readStoredCredentials } = await import('@/persistence');
  const { fetchSessionById } = await import('@/session/transport/http/sessionsHttp');
  const { fetchEncryptedTranscriptMessages } = await import('@/session/replay/fetchEncryptedTranscriptMessages');
  const { runReplaySummaryForDialog } = await import('@/session/replay/summary/runReplaySummaryForDialog');
  vi.mocked(readCredentials).mockReset();
  vi.mocked(readStoredCredentials).mockReset();
  vi.mocked(readStoredCredentials).mockResolvedValue(null);
  vi.mocked(fetchSessionById).mockReset();
  vi.mocked(fetchEncryptedTranscriptMessages).mockReset();
  vi.mocked(runReplaySummaryForDialog).mockReset();
  transcriptLaunch = await prepareTranscriptCommitLaunch();
});

function tryRunGit(cwd: string, args: string[]): string | null {
  try {
    return runGit(cwd, args);
  } catch {
    return null;
  }
}

function detectTestGitRepo(cwd: string): ScmRepoDetection {
  const rootPath = tryRunGit(cwd, ['rev-parse', '--show-toplevel']);
  if (!rootPath) {
    return { isRepo: false, rootPath: null, mode: null };
  }
  return { isRepo: true, rootPath, mode: '.git' };
}

function parseGitNumstatByPath(
  raw: string,
): ReadonlyMap<string, Readonly<{ pendingAdded: number; pendingRemoved: number }>> {
  const statsByPath = new Map<string, Readonly<{ pendingAdded: number; pendingRemoved: number }>>();
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const [addedRaw, removedRaw, path] = line.split('\t');
    if (!path) continue;
    const added = Number.parseInt(addedRaw ?? '', 10);
    const removed = Number.parseInt(removedRaw ?? '', 10);
    statsByPath.set(path, {
      pendingAdded: Number.isFinite(added) && added >= 0 ? added : 0,
      pendingRemoved: Number.isFinite(removed) && removed >= 0 ? removed : 0,
    });
  }
  return statsByPath;
}

type ScmBackendPromiseResult<TKey extends keyof ScmBackend> =
  ScmBackend[TKey] extends (...args: any[]) => Promise<infer TResult> ? TResult : never;

function unsupportedTestScmOperation<TKey extends keyof ScmBackend>(): Promise<ScmBackendPromiseResult<TKey>> {
  return Promise.resolve({
    success: false,
    errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
    error: 'Unsupported in test SCM backend',
  } as ScmBackendPromiseResult<TKey>);
}

function createTestGitScmBackend(): ScmBackend {
  const backend: ScmBackend = {
    id: 'git',
    selection: {
      modeSelectionScores: { '.git': 200 },
      preferenceAllowedModes: ['.git'],
    },
    async detectRepo({ cwd }) {
      return detectTestGitRepo(cwd);
    },
    getCapabilities() {
      return createScmCapabilities();
    },
    async describeBackend({ context }) {
      return {
        success: true,
        backendId: 'git',
        repoMode: context.detection.mode ?? undefined,
        isRepo: context.detection.isRepo,
        capabilities: createScmCapabilities(),
      };
    },
    async statusSnapshot({ context }) {
      const rootPath = context.detection.rootPath ?? context.cwd;
      const branch = tryRunGit(context.cwd, ['branch', '--show-current']) || null;
      const statusRaw = tryRunGit(context.cwd, ['status', '--porcelain=v1']) ?? '';
      const pendingStatsByPath = parseGitNumstatByPath(
        tryRunGit(context.cwd, ['diff', '--no-renames', '--numstat']) ?? '',
      );
      const entries = statusRaw
        .split('\n')
        .map((line) => line.trimEnd())
        .filter(Boolean)
        .map((line) => {
          const indexStatus = line[0] ?? ' ';
          const workingStatus = line[1] ?? ' ';
          const path = line.slice(3).trim();
          const stats = pendingStatsByPath.get(path) ?? { pendingAdded: 0, pendingRemoved: 0 };
          const kind: 'added' | 'untracked' | 'modified' = indexStatus === 'A'
            ? 'added'
            : workingStatus === '?'
              ? 'untracked'
              : 'modified';
          return {
            path,
            previousPath: null,
            kind,
            includeStatus: indexStatus.trim() || ' ',
            pendingStatus: workingStatus.trim() || ' ',
            hasIncludedDelta: indexStatus.trim().length > 0 && indexStatus !== '?',
            hasPendingDelta: workingStatus.trim().length > 0 || workingStatus === '?',
            stats: {
              includedAdded: 0,
              includedRemoved: 0,
              pendingAdded: stats.pendingAdded,
              pendingRemoved: stats.pendingRemoved,
              isBinary: false,
            },
          };
        });

      return {
        success: true,
        snapshot: {
          projectKey: `test-git:${rootPath}`,
          fetchedAt: Date.now(),
          repo: {
            isRepo: true,
            rootPath,
            backendId: 'git',
            mode: '.git',
            worktrees: [],
            remotes: [],
          },
          capabilities: createScmCapabilities(),
          branch: {
            head: branch,
            upstream: null,
            ahead: 0,
            behind: 0,
            detached: false,
          },
          stashCount: 0,
          hasConflicts: false,
          entries,
          totals: {
            includedFiles: entries.filter((entry) => entry.hasIncludedDelta).length,
            pendingFiles: entries.filter((entry) => entry.hasPendingDelta).length,
            untrackedFiles: entries.filter((entry) => entry.kind === 'added' && entry.pendingStatus === '?').length,
            includedAdded: 0,
            includedRemoved: 0,
            pendingAdded: entries.reduce((sum, entry) => sum + entry.stats.pendingAdded, 0),
            pendingRemoved: entries.reduce((sum, entry) => sum + entry.stats.pendingRemoved, 0),
          },
        },
      };
    },
    async diffFile({ context, request }) {
      const diff = tryRunGit(context.cwd, ['diff', '--', request.path]) ?? '';
      return { success: true, diff };
    },
    diffCommit: () => unsupportedTestScmOperation<'diffCommit'>(),
    changeInclude: () => unsupportedTestScmOperation<'changeInclude'>(),
    changeExclude: () => unsupportedTestScmOperation<'changeExclude'>(),
    changeDiscard: () => unsupportedTestScmOperation<'changeDiscard'>(),
    commitCreate: () => unsupportedTestScmOperation<'commitCreate'>(),
    commitBackout: () => unsupportedTestScmOperation<'commitBackout'>(),
    logList: () => unsupportedTestScmOperation<'logList'>(),
    branchList: () => unsupportedTestScmOperation<'branchList'>(),
    branchCreate: () => unsupportedTestScmOperation<'branchCreate'>(),
    branchCheckout: () => unsupportedTestScmOperation<'branchCheckout'>(),
    branchMerge: () => unsupportedTestScmOperation<'branchMerge'>(),
    branchRebase: () => unsupportedTestScmOperation<'branchRebase'>(),
    branchOperationContinue: () => unsupportedTestScmOperation<'branchOperationContinue'>(),
    branchOperationAbort: () => unsupportedTestScmOperation<'branchOperationAbort'>(),
    worktreeCreate: () => unsupportedTestScmOperation<'worktreeCreate'>(),
    worktreeRemove: () => unsupportedTestScmOperation<'worktreeRemove'>(),
    worktreePrune: () => unsupportedTestScmOperation<'worktreePrune'>(),
    remoteAdd: () => unsupportedTestScmOperation<'remoteAdd'>(),
    remoteSetUrl: () => unsupportedTestScmOperation<'remoteSetUrl'>(),
    remoteRemove: () => unsupportedTestScmOperation<'remoteRemove'>(),
    remoteFetch: () => unsupportedTestScmOperation<'remoteFetch'>(),
    remotePull: () => unsupportedTestScmOperation<'remotePull'>(),
    remotePush: () => unsupportedTestScmOperation<'remotePush'>(),
    remotePublish: () => unsupportedTestScmOperation<'remotePublish'>(),
    stashList: () => unsupportedTestScmOperation<'stashList'>(),
    stashDrop: () => unsupportedTestScmOperation<'stashDrop'>(),
    stashPop: () => unsupportedTestScmOperation<'stashPop'>(),
    stashApply: () => unsupportedTestScmOperation<'stashApply'>(),
    stashShow: () => unsupportedTestScmOperation<'stashShow'>(),
  };
  return backend;
}

function createApprovalRequest(
  overrides: Partial<ApprovalRequestV1> = {},
): ApprovalRequestV1 {
  return {
    v: 1,
    status: 'open',
    createdAtMs: 1,
    updatedAtMs: 1,
    createdBy: { surface: 'system', sessionId: 'sess_1' },
    requestedSurface: 'rpc',
    approval: { flow: 'blocking', result: 'required' },
    actionId: 'execution.run.list',
    actionArgs: { limit: 10 },
    summary: 'Approve listing execution runs',
    preview: { actionId: 'execution.run.list', actionArgs: { limit: 10 } },
    ...overrides,
  };
}

function createApprovalCredentials(): Credentials {
  return {
    token: 'token',
    encryption: {
      type: 'legacy',
      secret: new Uint8Array(32).fill(1),
    },
  };
}

async function expectPromisePending(promise: Promise<unknown>): Promise<void> {
  const settled = await Promise.race([
    promise.then(() => true, () => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 20)),
  ]);
  expect(settled).toBe(false);
}

function createStaticBackend(responseText: string, providerSessionId?: string): ExecutionRunHostRuntime {
  let runtime: ReturnType<typeof createTestExecutionRunHostRuntime>;
  runtime = createTestExecutionRunHostRuntime({
    providerSessionId,
    onSendPrompt() {
      runtime.emitMessage({ type: 'model-output', fullText: responseText } as AgentMessage);
    },
    onWaitForTurnCompletion() {},
  });
  return runtime;
}

function createCapturingStaticBackend(
  responseText: string,
  capture: { lastPrompt: string },
): ExecutionRunHostRuntime {
  let runtime: ReturnType<typeof createTestExecutionRunHostRuntime>;
  runtime = createTestExecutionRunHostRuntime({
    onSendPrompt(_sessionId, prompt) {
      capture.lastPrompt = prompt;
      runtime.emitMessage({ type: 'model-output', fullText: responseText } as AgentMessage);
    },
    onWaitForTurnCompletion() {},
  });
  return runtime;
}

async function waitForExecutionRunTerminalState(
  client: ReturnType<typeof createEncryptedRpcTestClient>,
  runId: string,
): Promise<any> {
  const manager = executionRunTestManagers.find(candidate => candidate.get(runId));
  if (!manager) throw new Error(`Execution run was not registered: ${runId}`);
  await manager.waitForTerminal(runId);
  return await client.call(SESSION_RPC_METHODS.EXECUTION_RUN_GET, { runId, includeStructured: true });
}

function createDelayedBackend(responseText: string, delayMs: number): ExecutionRunHostRuntime {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let done: Promise<void> | null = null;
  let resolveDone: (() => void) | null = null;
  let runtime: ReturnType<typeof createTestExecutionRunHostRuntime>;
  runtime = createTestExecutionRunHostRuntime({
    onSendPrompt() {
      done = new Promise((resolve) => {
        resolveDone = resolve;
        timer = setTimeout(() => {
          runtime.emitMessage({ type: 'model-output', fullText: responseText } as AgentMessage);
          resolve();
        }, delayMs);
      });
    },
    onCancel() {
      if (timer) clearTimeout(timer);
      resolveDone?.();
    },
    onDispose() {
      if (timer) clearTimeout(timer);
      resolveDone?.();
    },
    async onWaitForTurnCompletion() {
      await (done ?? Promise.resolve());
    },
  });
  return runtime;
}

function createPendingBackend(): ExecutionRunHostRuntime {
  let done: Promise<void> | null = null;
  let resolveDone: (() => void) | null = null;

  return createTestExecutionRunHostRuntime({
    onSendPrompt() {
      done = new Promise((resolve) => {
        resolveDone = resolve;
      });
    },
    onCancel() {
      resolveDone?.();
    },
    onDispose() {
      resolveDone?.();
    },
    async onWaitForTurnCompletion() {
      await (done ?? Promise.resolve());
    },
  });
}

function createNeverResolvingBackend(): ExecutionRunHostRuntime {
  let done: Promise<void> | null = null;
  let sendCount = 0;

  let runtime: ReturnType<typeof createTestExecutionRunHostRuntime>;
  runtime = createTestExecutionRunHostRuntime({
    runtimeId: 'child_session_stuck',
    async onSendPrompt() {
      sendCount += 1;
      // First prompt returns immediately but never completes, simulating a stuck in-flight turn.
      // The second prompt never resolves, simulating a backend that cannot acknowledge a cancel+send.
      if (sendCount >= 2) {
        await new Promise<void>(() => {
          // intentionally never resolve/reject
        });
        return;
      }
      done = new Promise<void>(() => {
        // intentionally never resolve/reject
      });
      runtime.emitMessage({ type: 'model-output', fullText: '' } as AgentMessage);
    },
    onCancel() {},
    async onWaitForTurnCompletion() {
      await (done ?? Promise.resolve());
    },
  });
  return runtime;
}

function createResumableBackendFactory(responseText: string): () => ExecutionRunHostRuntime {
  return () => {
    let runtime: ReturnType<typeof createTestExecutionRunHostRuntime>;
    runtime = createTestExecutionRunHostRuntime({
      runtimeId: 'child_session_resumable',
      providerSessionId: 'provider_session_resumable',
      resumeSupported: true,
      onSendPrompt() {
        runtime.emitMessage({ type: 'model-output', fullText: responseText } as AgentMessage);
      },
    });
    return runtime;
  };
}

function createSequencedBackend(params: {
  responses: ReadonlyArray<{ text: string; delayMs: number | null }>;
  supportsSteer?: boolean;
  cancelRejects?: boolean;
  completionRejectMessage?: string;
}): { backend: ExecutionRunHostRuntime; events: { sendPrompts: string[]; steerPrompts: string[]; cancelCount: number } } {
  const events = { sendPrompts: [] as string[], steerPrompts: [] as string[], cancelCount: 0 };

  let turnIndex = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let done: Promise<void> | null = null;
  let resolveDone: (() => void) | null = null;
  let rejectDone: ((e: Error) => void) | null = null;

  let backend: ReturnType<typeof createTestExecutionRunHostRuntime>;
  backend = createTestExecutionRunHostRuntime({
    onSendPrompt(_sessionId, prompt) {
      events.sendPrompts.push(prompt);
      const response = params.responses[Math.min(turnIndex, params.responses.length - 1)];
      turnIndex += 1;

      done = new Promise((resolve, reject) => {
        resolveDone = resolve;
        rejectDone = (e) => reject(e);
        if (response.delayMs === null) return;
        timer = setTimeout(() => {
          if (typeof params.completionRejectMessage === 'string' && params.completionRejectMessage.trim().length > 0) {
            reject(new Error(params.completionRejectMessage));
            return;
          }
          backend.emitMessage({ type: 'model-output', fullText: response.text } as AgentMessage);
          resolve();
        }, response.delayMs);
      });
    },
    onCancel() {
      events.cancelCount += 1;
      if (timer) clearTimeout(timer);
      if (params.cancelRejects) {
        rejectDone?.(new Error('Turn cancelled'));
      } else {
        resolveDone?.();
      }
    },
    onDispose() {
      if (timer) clearTimeout(timer);
      resolveDone?.();
    },
    ...(params.supportsSteer
      ? {
          onSendSteerPrompt(_sessionId: string, prompt: string) {
            events.steerPrompts.push(prompt);
          },
        }
      : {}),
    async onWaitForTurnCompletion() {
      await (done ?? Promise.resolve());
    },
  });

  return { backend, events };
}

const executionRunRpcActionBindings = [
  [SESSION_RPC_METHODS.EXECUTION_RUN_START, 'execution.run.start'],
  [SESSION_RPC_METHODS.EXECUTION_RUN_LIST, 'execution.run.list'],
  [SESSION_RPC_METHODS.EXECUTION_RUN_GET, 'execution.run.get'],
  [SESSION_RPC_METHODS.EXECUTION_RUN_SEND, 'execution.run.send'],
  [SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE, 'execution.run.ensure'],
  [SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START, 'execution.run.ensure_or_start'],
  [SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START_PROVIDER_SAFE_V1, 'execution.run.ensure_or_start'],
  [SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START, 'execution.run.stream.start'],
  [SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_READ, 'execution.run.stream.read'],
  [SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_CANCEL, 'execution.run.stream.cancel'],
  [SESSION_RPC_METHODS.EXECUTION_RUN_STOP, 'execution.run.stop'],
  [SESSION_RPC_METHODS.EXECUTION_RUN_ACTION, 'execution.run.action'],
] as const satisfies readonly (readonly [string, ActionId])[];

describe('executionRuns session RPC handlers', () => {
  it('composes the wait contract from the registered producer to the CLI consumer', async () => {
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'wait-account' })).toString('base64url')}.signature`;
    const get = vi.spyOn(axios, 'get');
    const priorGet = get.getMockImplementation()!;
    get.mockImplementation(async (url, options) => String(url).endsWith('/v2/account/session-follow-preferences')
      ? { status: 200, data: { ...DEFAULT_SESSION_AUTO_FOLLOW_PREFERENCES_V1,
          ...DEFAULT_SESSION_FOLLOW_CREATION_POLICIES_V1 } }
      : priorGet(url, options));
    let finishTurn: (() => void) | undefined;
    let enteredTurn: (() => void) | undefined;
    const turnEntered = new Promise<void>(resolve => { enteredTurn = resolve; });
    const turnFinished = new Promise<void>(resolve => { finishTurn = resolve; });
    let backend: ReturnType<typeof createTestExecutionRunHostRuntime>;
    backend = createTestExecutionRunHostRuntime({
      onSendPrompt() { enteredTurn?.(); },
      async onWaitForTurnCompletion() {
        await turnFinished;
        backend.emitMessage({ type: 'model-output', fullText: 'Review complete' });
      },
      onDispose() { finishTurn?.(); },
    });
    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1', callerAuthority: 'present_user',
      registerHandlers: rpc => registerExecutionRunHandlers(rpc, {
        sessionId: 'sess_1', cwd: process.cwd(), parentProvider: 'claude',
        createBackend: () => backend, sendAcp: async () => {},
        resolveRunReportPolicy: createSessionRunReportPolicyReader({ serverId: 'wait-home',
          serverHttpBaseUrl: 'https://wait.test', accountId: 'wait-account',
          readCredentials: async () => ({ token, encryption: null }), isCurrent: () => true }),
      }),
    });
    const started = await client.call<ExecutionRunStartResponse, unknown>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'task', modelSelection: null,
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, instructions: 'Review the change.',
      permissionMode: 'read_only', retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response',
    });
    expect(started.runId, JSON.stringify(started)).toMatch(/^run_/);
    await turnEntered;
    // Substitute only the network boundary; registration, Action executor,
    // bridge, observer, encrypted codec and strict consumer all remain real.
    const transport = vi.spyOn(sessionRpcTransport, 'callSessionRpc').mockImplementation(async params => {
      expect(params.method).toBe(`sess_1:${SESSION_RPC_METHODS.EXECUTION_RUN_WAIT}`);
      return await client.call(SESSION_RPC_METHODS.EXECUTION_RUN_WAIT, params.request);
    });
    const observe = (timeoutMs: number | null) => waitForExecutionRun({
      token: 'token', sessionId: 'sess_1', mode: 'plain', ctx: null,
      runId: started.runId, timeoutMs,
    });
    try {
      const timedOut = await client.call<unknown, unknown>(SESSION_RPC_METHODS.EXECUTION_RUN_WAIT, {
        runId: started.runId, timeoutSeconds: 1,
      });
      expect(timedOut, JSON.stringify(timedOut)).toMatchObject({
        ok: true, status: 'running', disposition: 'observation_timeout', runId: started.runId,
      });
      expect(ExecutionRunWaitResultSchema.safeParse(timedOut).success).toBe(true);
      // Deliver the captured real timeout frame through the network substitute;
      // no hand-written timeout fixture can drift from the registered producer.
      transport.mockResolvedValueOnce(timedOut);
      expect(await observe(null)).toEqual(timedOut);
      vi.stubEnv('HAPPIER_FEATURE_EXECUTION_RUNS__ENABLED', '0');
      const refused = await observe(null);
      expect(refused).toMatchObject({ ok: false, code: 'execution_run_not_allowed' });
      expect(refused).not.toMatchObject({ code: 'execution_run_wait_result_invalid' });
      vi.stubEnv('HAPPIER_FEATURE_EXECUTION_RUNS__ENABLED', '1');
      finishTurn?.();
      const completed = await observe(null);
      expect(completed).toMatchObject({ ok: true, status: 'succeeded',
        result: { run: { runId: started.runId, status: 'succeeded' }, latestToolResult: 'Review complete' } });
      expect(ExecutionRunWaitResultSchema.safeParse(completed).success).toBe(true);
    } finally {
      finishTurn?.();
      transport.mockRestore();
    }
  });

  it('registers the host-private live broker authority resolver on the Session runtime', async () => {
    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: () => createStaticBackend('unused'),
          sendAcp: async () => {},
        });
      },
    });

    await expect(client.call(
      SESSION_RPC_METHODS.EXECUTION_RUN_BROKER_AUTHORITY_RESOLVE_V1,
      {
        v: 1,
        executionRunId: 'missing-run',
        expectedOccurrenceId: null,
      },
    )).resolves.toEqual({ status: 'not_current', reason: 'not_found' });
  });

  it('dispatches all public execution-run RPC methods through the shared action adapter seam', async () => {
    const calls: Array<{
      actionId: ActionId;
      input: unknown;
      context: unknown;
    }> = [];
    const actionExecutor: RpcActionExecutor = {
      execute: async (actionId, input, context) => {
        calls.push({ actionId, input, context });
        return { ok: true, result: { handledActionId: actionId } };
      },
    };

    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: () => createStaticBackend('unused'),
          sendAcp: async () => {},
          actionExecutor,
          serverId: undefined,
          machineId: undefined,
          runtimeAccountId: undefined,
        });
      },
    });

    for (const [method, actionId] of executionRunRpcActionBindings) {
      const input = { marker: actionId };
      await expect(client.call<unknown, unknown>(method, input)).resolves.toEqual({ handledActionId: actionId });
    }

    expect(calls).toEqual(executionRunRpcActionBindings.map(([, actionId], index) => ({
      actionId,
      input: { marker: actionId },
      context: {
        actionRequestId: `sess_1:test-request:${index + 1}`,
        authority: 'account_automation',
        defaultSessionId: 'sess_1',
        // The RPC handler serves no Session-list corpus, so it stamps the
        // fail-closed value the shared list-access guard reads.
        sessionListAccess: 'unavailable',
        signal: expect.any(AbortSignal),
        requestStartedAtMs: expect.any(Number),
        surface: 'rpc',
      },
    })));
  });

  it('keeps execution-run RPC method binding delegated to the generic action-spec registrar', () => {
    const source = readFileSync(
      new URL('./executionRuns/actionRpcRegistration.ts', import.meta.url),
      'utf8',
    );

    expect(source.match(/registerActionSpecRpcHandlers\(/g) ?? []).toHaveLength(1);
    expect(source).not.toContain('dispatchPublicAction(');
    expect(source).not.toContain('EXECUTION_RUN_RPC_METHODS');
  });

  it('installs exact retained Run turn cancellation only after its runtime consumer is present', async () => {
    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: () => createStaticBackend('unused'),
          sendAcp: async () => {},
        });
      },
    });

    await expect(client.call(SESSION_RPC_METHODS.EXECUTION_RUN_CANCEL_TURN_V1, {
      runId: 'run_1', turnId: 'turn_1',
    })).resolves.toMatchObject({ ok: false, errorCode: 'execution_run_invalid_action_input' });
  });

  it('honors canonical action policy when dispatching public execution-run RPC calls', async () => {
    const previousActionsSettings = process.env.HAPPIER_ACTIONS_SETTINGS_V1;
    process.env.HAPPIER_ACTIONS_SETTINGS_V1 = JSON.stringify({
      v: 1,
      actions: {
        'execution.run.list': { enabled: true, disabledSurfaces: ['rpc'], disabledPlacements: [] },
      },
    });

    try {
      const client = createEncryptedRpcTestClient({
        scopePrefix: 'sess_1',
        registerHandlers: (rpc) => {
          registerExecutionRunHandlers(rpc, {
            sessionId: 'sess_1',
            cwd: process.cwd(),
            parentProvider: 'claude',
            createBackend: () => createStaticBackend('unused'),
            sendAcp: async () => {},
          });
        },
      });

      const listed = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_LIST, { limit: 1 });

      expect(listed).toEqual({
        ok: false,
        error: 'action_disabled',
        errorCode: 'action_disabled',
      });
    } finally {
      if (previousActionsSettings === undefined) {
        delete process.env.HAPPIER_ACTIONS_SETTINGS_V1;
      } else {
        process.env.HAPPIER_ACTIONS_SETTINGS_V1 = previousActionsSettings;
      }
    }
  });

  it('returns retained approval identity for result-bearing execution-run RPC reads without waiting', async () => {
    const previousActionsSettings = process.env.HAPPIER_ACTIONS_SETTINGS_V1;
    process.env.HAPPIER_ACTIONS_SETTINGS_V1 = JSON.stringify({
      v: 1,
      actions: {
        'execution.run.list': { enabled: true, disabledSurfaces: [], disabledPlacements: [], approvalRequiredSurfaces: ['rpc'] },
      },
    });

    try {
      const approvalsCreate = vi.fn<NonNullable<ActionExecutorDeps['approvalsCreate']>>(
        async () => ({ artifactId: 'approval_1' }),
      );
      const approvalsWaitForDecision = vi.fn<NonNullable<ActionExecutorDeps['approvalsWaitForDecision']>>(async ({ request }) => ({
        decision: 'approve',
        request: {
          ...request,
          status: 'approved',
          decision: { kind: 'approve', decidedAtMs: 2 },
          updatedAtMs: 2,
        },
      }));
      const approvalsUpdate = vi.fn<NonNullable<ActionExecutorDeps['approvalsUpdate']>>(async () => ({ ok: true }));
      const approvalsResolveBlockingDecision = vi.fn<NonNullable<ActionExecutorDeps['approvalsResolveBlockingDecision']>>(
        async () => ({ resolved: false }),
      );

      const client = createEncryptedRpcTestClient({
        scopePrefix: 'sess_1',
        registerHandlers: (rpc) => {
          registerExecutionRunHandlers(rpc, {
            sessionId: 'sess_1',
            serverId: 'home-stable-1',
            runtimeAccountId: 'account-1',
            machineId: 'machine-1',
            cwd: process.cwd(),
            parentProvider: 'claude',
            createBackend: () => createStaticBackend('unused'),
            sendAcp: async () => {},
            actionApprovalDeps: {
              approvalsCreate,
              approvalsUpdate,
              approvalsWaitForDecision,
              approvalsResolveBlockingDecision,
              isApprovalExecutionOriginCurrent: async () => true,
            },
          });
        },
      });

      const listed = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_LIST, { limit: 1 });

      expect(listed).toEqual({ kind: 'approval_request_created', actionId: 'execution.run.list', artifactId: 'approval_1' });
      expect(approvalsCreate).toHaveBeenCalledOnce();
      expect(approvalsCreate).toHaveBeenCalledWith(expect.objectContaining({
        request: expect.objectContaining({
          v: 2,
          executionOriginV1: expect.objectContaining({
            serverId: 'home-stable-1',
            accountId: 'account-1',
            machineId: 'machine-1',
            sessionId: 'sess_1',
            actionId: 'execution.run.list',
            requestId: 'sess_1:test-request:1',
          }),
        }),
      }));
      expect(approvalsWaitForDecision).not.toHaveBeenCalled();
      expect(approvalsUpdate).not.toHaveBeenCalled();
    } finally {
      if (previousActionsSettings === undefined) {
        delete process.env.HAPPIER_ACTIONS_SETTINGS_V1;
      } else {
        process.env.HAPPIER_ACTIONS_SETTINGS_V1 = previousActionsSettings;
      }
    }
  });

  it('fails a blocking execution-run RPC approval closed without a stable Home binding', async () => {
    const previousActionsSettings = process.env.HAPPIER_ACTIONS_SETTINGS_V1;
    process.env.HAPPIER_ACTIONS_SETTINGS_V1 = JSON.stringify({
      v: 1,
      actions: {
        'execution.run.list': { enabled: true, disabledSurfaces: [], disabledPlacements: [], approvalRequiredSurfaces: ['rpc'] },
      },
    });
    try {
      const approvalsCreate = vi.fn<NonNullable<ActionExecutorDeps['approvalsCreate']>>(
        async () => ({ artifactId: 'approval_must_not_be_created' }),
      );
      const client = createEncryptedRpcTestClient({
        scopePrefix: 'sess_1',
        registerHandlers: (rpc) => {
          registerExecutionRunHandlers(rpc, {
            sessionId: 'sess_1',
            serverId: undefined,
            runtimeAccountId: 'account-1',
            cwd: process.cwd(),
            parentProvider: 'claude',
            createBackend: () => createStaticBackend('unused'),
            sendAcp: async () => {},
            actionApprovalDeps: { approvalsCreate },
          });
        },
      });

      await expect(client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_LIST, { limit: 1 }))
        .resolves.toMatchObject({ ok: false, errorCode: 'approval_origin_unavailable' });
      expect(approvalsCreate).not.toHaveBeenCalled();
    } finally {
      if (previousActionsSettings === undefined) {
        delete process.env.HAPPIER_ACTIONS_SETTINGS_V1;
      } else {
        process.env.HAPPIER_ACTIONS_SETTINGS_V1 = previousActionsSettings;
      }
    }
  });

  it.each([1, 2] as const)('keeps V%s execution-run RPC approval updates claimed by the explicit decision seam', async (version) => {
    const deps = createExecutionRunRpcApprovalDeps({
      readCredentials: async () => createApprovalCredentials(),
    });
    // V2 narrows the Action id to the current catalog; the V1 builder carries the
    // wider historical union, so the replayed id is restated at the V2 boundary.
    const request = version === 1 ? createApprovalRequest() : {
      ...createApprovalRequest(),
      v: 2 as const,
      actionId: 'execution.run.list' as const,
      executionOriginV1: {
        v: 1 as const,
        authority: 'account_automation' as const,
        surface: 'rpc' as const,
        caller: { kind: 'host' as const },
        serverId: 'server-1',
        sessionId: 'sess_1',
        actionId: 'execution.run.list' as const,
        requestId: 'request-1',
      },
    };
    const pending = deps.approvalsWaitForDecision?.({
      artifactId: 'approval_execution_run_intermediate',
      request,
    });
    if (!pending || !deps.approvalsUpdate || !deps.approvalsResolveBlockingDecision) {
      throw new Error('expected execution-run approval deps');
    }

    const approvedRequest = {
      ...request,
      status: 'approved' as const,
      updatedAtMs: 2,
      decision: { kind: 'approve' as const, decidedAtMs: 2 },
    };
    await deps.approvalsUpdate({
      artifactId: 'approval_execution_run_intermediate',
      request: approvedRequest,
      serverId: null,
    });

    await expectPromisePending(pending);

    await expect(deps.approvalsResolveBlockingDecision({
      artifactId: 'approval_execution_run_intermediate',
      decision: 'approve',
      decisionAuthority: 'present_user',
      request: approvedRequest,
      serverId: null,
    })).resolves.toEqual({ resolved: true });
    await expect(pending).resolves.toMatchObject({ decision: 'approve' });
  });

  it('wakes execution-run RPC blocking approval waiters on terminal updates', async () => {
    const deps = createExecutionRunRpcApprovalDeps({
      readCredentials: async () => createApprovalCredentials(),
    });
    const pending = deps.approvalsWaitForDecision?.({
      artifactId: 'approval_execution_run_terminal',
      request: createApprovalRequest(),
    });
    if (!pending || !deps.approvalsUpdate) {
      throw new Error('expected execution-run approval deps');
    }

    await deps.approvalsUpdate({
      artifactId: 'approval_execution_run_terminal',
      request: createApprovalRequest({
        status: 'executed',
        updatedAtMs: 3,
        decision: { kind: 'approve', decidedAtMs: 2 },
        execution: { executedAtMs: 3, ok: true, result: { runs: [] } },
      }),
      serverId: null,
    });

    await expect(pending).resolves.toMatchObject({
      decision: 'approve',
      request: {
        status: 'executed',
        execution: { ok: true, result: { runs: [] } },
      },
    });
  });

  it('does not materialize the full execution-run public list for bounded list RPC calls', async () => {
    const { ExecutionRunHostBridge } = await import('@/agent/runtime/bridges/executionRun/ExecutionRunHostBridge');
    const listPublic = vi.spyOn(ExecutionRunHostBridge.prototype, 'listPublic');

    try {
      const client = createEncryptedRpcTestClient({
        scopePrefix: 'sess_1',
        registerHandlers: (rpc) => {
          registerExecutionRunHandlers(rpc, {
            sessionId: 'sess_1',
            cwd: process.cwd(),
            parentProvider: 'claude',
            createBackend: () => createStaticBackend('unused'),
            sendAcp: async () => {},
          });
        },
      });

      await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_LIST, { limit: 1 });

      expect(listPublic).not.toHaveBeenCalled();
    } finally {
      listPublic.mockRestore();
    }
  });

  it('passes resolved account settings into built-in backend creation', async () => {
    const createBackend = vi.fn(() => createStaticBackend('ok'));

    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend,
          sendAcp: async () => {},
          resolveAccountSettings: async () => ({ codexBackendMode: 'mcp' }),
        });
      },
    });

    await client.call<ExecutionRunStartResponse, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'delegate',
      modelSelection: null,
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      instructions: 'Delegate.',
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'bounded',
      ioMode: 'request_response',
    });

    expect(createBackend).toHaveBeenCalledWith(expect.objectContaining({
      backendId: 'codex',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      accountSettings: { codexBackendMode: 'mcp' },
    }));
  });

  it('starts and lists a review run', async () => {
    const sent: Array<{ body: ACPMessageData; meta?: Record<string, unknown> }> = [];

    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: () =>
            createStaticBackend(
              JSON.stringify({
                findings: [
                  { id: 'f1', title: 'Example', severity: 'low', category: 'style', summary: 'One paragraph.' },
                ],
                summary: 'Summary.',
              }),
            ),
          sendAcp: async (_provider: string, body: ACPMessageData, opts?: { meta?: Record<string, unknown> }) => {
            sent.push({ body, meta: opts?.meta });
          },
        });
      },
    });

    const started = await client.call<ExecutionRunStartResponse, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'review',
      modelSelection: null,
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Review.',
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'bounded',
      ioMode: 'request_response',
    });
    expect(started.runId, JSON.stringify(started)).toMatch(/^run_/);

    // Bounded runs execute asynchronously; wait a tick so static backends can complete before GET assertions.
    await new Promise((r) => setTimeout(r, 5));

    const listed = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_LIST, {});
    expect(listed.runs?.length ?? 0).toBe(1);
    expect(listed.runs?.[0]?.retentionPolicy).toBe('resumable');
    expect(listed.runs?.[0]?.runClass).toBe('bounded');
    expect(listed.runs?.[0]?.ioMode).toBe('request_response');
    expect(listed.runs?.[0]?.permissionMode).toBe('read_only');

    const got = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_GET, { runId: started.runId });
    expect(got.run?.runId).toBe(started.runId);
    expect(got.run?.retentionPolicy).toBe('resumable');
    expect(got.run?.runClass).toBe('bounded');
    expect(got.run?.ioMode).toBe('request_response');
    expect(got.run?.permissionMode).toBe('read_only');
    expect(got.latestToolResult?.summary).toBe('Summary.');
    expect(got.latestToolResult?.findingsDigest?.total).toBe(1);

    // Transcript emission happened.
    expect(sent.some((m: any) => m?.body?.type === 'tool-call')).toBe(true);
    expect(sent.some((m: any) => m?.body?.type === 'tool-result')).toBe(true);
    const sidechainMsg = sent.find((m: any) => m?.body?.type === 'message' && typeof m?.body?.sidechainId === 'string');
    expect(sidechainMsg?.body?.sidechainId).toBe(started.callId);
  });

	  it('publishes public state updates via onExecutionRunPublicStateUpdated', async () => {
    const updates: ExecutionRunPublicState[] = [];
    let resolveTerminal!: (run: ExecutionRunPublicState) => void;
    const terminalPublished = new Promise<ExecutionRunPublicState>(resolve => { resolveTerminal = resolve; });

	    const client = createEncryptedRpcTestClient({
	      scopePrefix: 'sess_1',
	      registerHandlers: (rpc) => {
	        registerExecutionRunHandlers(rpc, {
	          sessionId: 'sess_1',
	          cwd: process.cwd(),
	          parentProvider: 'claude',
	          createBackend: () =>
	            createStaticBackend(
	              JSON.stringify({
	                findings: [],
	                summary: 'Ok.',
	              }),
	            ),
	          sendAcp: async () => {},
	          onExecutionRunPublicStateUpdated: (run: ExecutionRunPublicState) => {
	            updates.push(run);
	            if (run.status !== 'running') resolveTerminal(run);
	          },
	        });
	      },
	    });

    const started = await client.call<ExecutionRunStartResponse, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'review',
      modelSelection: null,
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Review.',
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'bounded',
      ioMode: 'request_response',
    });

    expect(updates.some((run) => run.runId === started.runId && run.status === 'running')).toBe(true);

    const terminal = await terminalPublished;
    expect(terminal.runId).toBe(started.runId);
    expect(terminal.status).toBe('succeeded');
    expect(updates).toContain(terminal);
  });

  it('applies execution.run.list filters on the canonical handler path', async () => {
    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: (opts) =>
            opts.backendId === 'claude'
              ? createPendingBackend()
              : createStaticBackend(JSON.stringify({ findings: [], summary: 'done' })),
          sendAcp: async () => {},
        });
      },
    });

    const running = await client.call<ExecutionRunStartResponse, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'review',
      modelSelection: null,
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Review.',
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'bounded',
      ioMode: 'request_response',
    });
    const succeeded = await client.call<ExecutionRunStartResponse, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'review',
      modelSelection: null,
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      instructions: 'Review.',
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'bounded',
      ioMode: 'request_response',
    });

    await new Promise((resolve) => setTimeout(resolve, 5));

    const listed = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_LIST, {
      status: 'running',
      backendId: 'claude',
      limit: 1,
    });

    expect(listed.runs).toEqual([
      expect.objectContaining({
        runId: running.runId,
        status: 'running',
      }),
    ]);
    expect(listed.runs).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runId: succeeded.runId,
        }),
      ]),
    );

    await expect(
      client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_STOP, { runId: running.runId }),
    ).resolves.toMatchObject({ ok: true });
  });

  it('runs scm_commit_message.v1 through execution.run.start and projects the commit message result', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'happier-scm-commit-message-'));
    const capture = { lastPrompt: '' };
    const createdBackendOpts: Array<{ backendId: string; permissionMode: string; backendTarget?: unknown }> = [];

    try {
      runGit(repoDir, ['init', '--initial-branch=main']);
      runGit(repoDir, ['config', 'user.email', 'test@example.com']);
      runGit(repoDir, ['config', 'user.name', 'Test User']);
      writeFileSync(join(repoDir, 'a.txt'), 'hello\n', 'utf8');
      runGit(repoDir, ['add', 'a.txt']);
      runGit(repoDir, ['commit', '-m', 'base']);
      writeFileSync(join(repoDir, 'a.txt'), 'hello world\n', 'utf8');

      const client = createEncryptedRpcTestClient({
        scopePrefix: 'sess_1',
        registerHandlers: (rpc) => {
          registerExecutionRunHandlers(rpc, {
            sessionId: 'sess_1',
            cwd: repoDir,
            parentProvider: 'claude',
            createBackend: (opts) => {
              createdBackendOpts.push(opts);
              return createCapturingStaticBackend(
                JSON.stringify({
                  title: 'feat: update a',
                  body: 'Explain change',
                  message: 'feat: update a\n\nExplain change',
                  confidence: 0.8,
                }),
                capture,
              );
            },
            sendAcp: async () => {},
          });
        },
      });

      const started = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
        kind: 'scm_commit_message.v1',
        intent: 'scm_commit_message',
        modelSelection: null,
        backendTarget: {
          kind: 'backend',
          backendId: 'review-bot',
          configuredBackendId: 'review-bot',
          sourceKind: 'configured',
        },
        permissionMode: 'no_tools',
        retentionPolicy: 'ephemeral',
        runClass: 'bounded',
        ioMode: 'request_response',
        intentInput: {
          instructions: 'Use conventional commits.',
          scope: { kind: 'paths', include: ['a.txt'] },
        },
      });

      expect(started).toMatchObject({ runId: expect.stringMatching(/^run_/) });

      const got = await waitForExecutionRunTerminalState(client, started.runId);
      expect(got.run?.status).toBe('succeeded');
      expect(got.latestToolResult).toMatchObject({
        title: 'feat: update a',
        body: 'Explain change',
        message: 'feat: update a\n\nExplain change',
        confidence: 0.8,
      });
      expect(got.structuredMeta).toMatchObject({
        kind: 'scm_commit_message.v1',
        payload: {
          message: 'feat: update a\n\nExplain change',
        },
      });
      expect(createdBackendOpts).toEqual([
        expect.objectContaining({
          backendId: 'review-bot',
          permissionMode: 'no_tools',
          backendTarget: {
            kind: 'configuredAcpBackend',
            backendId: 'review-bot',
          },
        }),
      ]);
      expect(capture.lastPrompt).toContain('Commit message generator.');
      expect(capture.lastPrompt).toContain('Use conventional commits.');
      expect(capture.lastPrompt).toContain('### a.txt');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('runs scm_diff_summary.v1 through execution.run.start and projects the retained summary result', async () => {
    const capture = { lastPrompt: '' };
    const createdBackendOpts: Array<{ backendId: string; permissionMode: string; backendTarget?: unknown }> = [];
    const repoDir = mkdtempSync(join(tmpdir(), 'happier-scm-diff-summary-'));
    const session = createMutableApiSessionClientFixture({ sessionId: 'sess_1' });
    const checkpoints = createRepositoryCheckpointPromptLifecycle({
      session, runtimeDirectory: repoDir, provider: 'codex', source: { protocol: 'native', agent: { pluginId: 'happier.agent.codex', localId: 'codex' } },
    });
    try {
      runGit(repoDir, ['init', '--initial-branch=main']);
      runGit(repoDir, ['config', 'user.name', 'Execution Run Test']);
      runGit(repoDir, ['config', 'user.email', 'execution-run@example.com']);
      mkdirSync(join(repoDir, 'src'));
      writeFileSync(join(repoDir, 'src/a.ts'), 'old\n');
      runGit(repoDir, ['add', 'src/a.ts']);
      runGit(repoDir, ['commit', '-m', 'initial']);
      await checkpoints.onBeforePromptDispatch?.({ messageId: 'message_1', prompt: 'edit' });
      await checkpoints.onTurnStarted?.({ messageId: 'message_1', turnId: 'turn_1', sequence: 1 });
      writeFileSync(join(repoDir, 'src/a.ts'), 'new\n');
      await checkpoints.onTurnFinal?.({ messageId: 'message_1', turnId: 'turn_1', status: 'completed', sequence: 2 });
      const source = { kind: 'turnCheckpoint', sessionId: 'sess_1', turnId: 'turn_1',
        checkpointReceiptId: 'checkpoint.diff_computed' } as const;
      const captured = await captureScmComparison({ cwd: repoDir, source, sessionId: 'sess_1' });
      expect(captured.comparison.inventory.state).toBe('complete');

      const client = createEncryptedRpcTestClient({
        scopePrefix: 'sess_1',
        registerHandlers: (rpc) => {
          registerExecutionRunHandlers(rpc, {
            sessionId: 'sess_1',
            cwd: repoDir,
            parentProvider: 'claude',
            createBackend: (opts) => {
              createdBackendOpts.push(opts);
              return createCapturingStaticBackend(
                JSON.stringify({
                  summaryMarkdown: '## Summary\n\nChanged src/a.ts.',
                  risks: ['Shared worktree attribution.'],
                  testImpact: 'Unit tests.',
                  suggestedPrBody: 'Updated source.',
                }),
                capture,
              );
            },
            sendAcp: async () => {},
          });
        },
      });

      const started = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
        kind: 'scm_diff_summary.v1',
        intent: 'scm_diff_summary',
        modelSelection: null,
        backendTarget: {
          kind: 'backend',
          backendId: 'summary-bot',
          configuredBackendId: 'summary-bot',
          sourceKind: 'configured',
        },
        permissionMode: 'read_only',
        retentionPolicy: 'resumable',
        runClass: 'long_lived',
        ioMode: 'request_response',
        intentInput: {
          cwd: repoDir,
          source,
          comparisonId: captured.comparison.id,
        },
      });
      expect(started, JSON.stringify(started)).toMatchObject({ runId: expect.any(String) });

      const got = await client.call<ExecutionRunGetResponse, unknown>(SESSION_RPC_METHODS.EXECUTION_RUN_GET, {
        runId: started.runId,
        includeStructured: true,
        waitForOutput: { kind: 'scm_diff_summary', output: 'summary', comparisonId: captured.comparison.id },
      });
      expect(got.run?.status).toBe('running');
      expect(got.latestToolResult).toMatchObject({
        success: true,
        summaryMarkdown: '## Summary\n\nChanged src/a.ts.',
        sourceKey: captured.comparison.id,
        metadata: captured.metadata,
      });
      expect(got.structuredMeta).toMatchObject({
        kind: 'scm_diff_summary.v1',
        payload: {
          summaryMarkdown: '## Summary\n\nChanged src/a.ts.',
        },
      });
      expect(createdBackendOpts).toEqual([
        expect.objectContaining({
          backendId: 'summary-bot',
          permissionMode: 'no_tools',
        }),
      ]);
      expect(capture.lastPrompt).toContain('SCM diff summary generator.');
      expect(capture.lastPrompt).toContain('src/a.ts');
      expect(capture.lastPrompt).toContain('@@ -1 +1 @@');
    } finally {
      await checkpoints.onSessionEnd?.();
      await session.close();
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('rejects write-capable scm_commit_message.v1 execution-run starts', async () => {
    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: () => createStaticBackend('should not run'),
          sendAcp: async () => {},
        });
      },
    });

    const res = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      kind: 'scm_commit_message.v1',
      intent: 'scm_commit_message',
      modelSelection: null,
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      permissionMode: 'workspace_write',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });

    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('execution_run_invalid_action_input');
    expect(res).toMatchObject({ details: {
      executionRunStart: { v: 1, runCreation: 'noRunCreated' },
      issues: expect.arrayContaining([expect.objectContaining({ path: ['permissionMode'] })]),
    } });
  });

  it('prefers backendTarget over legacy backendId in execution.run.list filters on the canonical handler path', async () => {
    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: (opts) =>
            opts.backendId === 'codex'
              ? createStaticBackend(JSON.stringify({ findings: [], summary: 'done' }))
              : createPendingBackend(),
          sendAcp: async () => {},
        });
      },
    });

    const running = await client.call<ExecutionRunStartResponse, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'review',
      modelSelection: null,
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Review.',
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'bounded',
      ioMode: 'request_response',
    });
    const succeeded = await client.call<ExecutionRunStartResponse, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'review',
      modelSelection: null,
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      instructions: 'Review.',
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'bounded',
      ioMode: 'request_response',
    });

    await new Promise((resolve) => setTimeout(resolve, 5));

    const listed = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_LIST, {
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      backendId: 'claude',
    });

    expect(listed.runs).toEqual([
      expect.objectContaining({
        runId: succeeded.runId,
      }),
    ]);
    expect(listed.runs).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runId: running.runId,
        }),
      ]),
    );

    await expect(
      client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_STOP, { runId: running.runId }),
    ).resolves.toMatchObject({ ok: true });
  });

  it('applies execution.run.list legacy customAcp filtering to configured ACP runs on the canonical handler path', async () => {
    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: ({ backendId, backendTarget }) => {
            if (backendId === 'review-bot') {
              if (backendTarget?.kind !== 'configuredAcpBackend' || backendTarget.backendId !== 'review-bot') {
                throw new Error('Missing configured ACP backend target');
              }
              return createPendingBackend();
            }
            return createStaticBackend(JSON.stringify({ findings: [], summary: 'done' }));
          },
          sendAcp: async () => {},
        });
      },
    });

    const running = await client.call<ExecutionRunStartResponse, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'review',
      modelSelection: null,
      backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
      instructions: 'Review.',
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'bounded',
      ioMode: 'request_response',
    });
    const succeeded = await client.call<ExecutionRunStartResponse, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'review',
      modelSelection: null,
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      instructions: 'Review.',
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'bounded',
      ioMode: 'request_response',
    });

    await new Promise((resolve) => setTimeout(resolve, 5));

    const listed = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_LIST, {
      status: 'running',
      backendId: 'customAcp',
      limit: 1,
    });

    expect(listed.runs).toEqual([
      expect.objectContaining({
        runId: running.runId,
        status: 'running',
        backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
      }),
    ]);
    expect(listed.runs).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runId: succeeded.runId,
        }),
      ]),
    );

    await expect(
      client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_STOP, { runId: running.runId }),
    ).resolves.toMatchObject({ ok: true });
  });

  it('returns structured review meta when includeStructured is true and supports review actions', async () => {
    const sent: Array<{ body: unknown; meta?: Record<string, unknown> }> = [];

    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: () =>
            createStaticBackend(
              JSON.stringify({
                findings: [
                  { id: 'f1', title: 'Example', severity: 'low', category: 'style', summary: 'One paragraph.' },
                ],
                summary: 'Summary.',
              }),
            ),
          sendAcp: async (_provider: string, body: ACPMessageData, opts?: { meta?: Record<string, unknown> }) => {
            sent.push({ body, meta: opts?.meta });
          },
          streamedTranscriptSession: {
            enqueueAgentMessageCommitted: async (_provider, body, opts) => {
              sent.push({ body, meta: opts.meta });
              return { persisted: true, delivered: false };
            },
          },
        });
      },
    });

    const started = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'review',
      modelSelection: null,
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Review.',
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'bounded',
      ioMode: 'request_response',
    });

    await new Promise((r) => setTimeout(r, 5));

    const got = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_GET, {
      runId: started.runId,
      includeStructured: true,
    });
    expect(got.run?.retentionPolicy).toBe('resumable');
    expect(got.run?.availableActionIds).toEqual(['review.triage', 'review.follow_up', 'approval_profile.set']);
    expect(got.structuredMeta?.kind).toBe('review_findings.v2');
    expect(got.structuredMeta?.payload?.runRef?.runId).toBe(started.runId);
    // review.triage records decisions in ReviewComment (reviewComments.test.ts); it never rewrites this result.
  });

  it('can stop a running execution run via execution.run.stop', async () => {
    const sent: Array<{ body: unknown; meta?: Record<string, unknown> }> = [];

    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: () =>
            createDelayedBackend(JSON.stringify({ findings: [], summary: 'late' }), 50_000),
          sendAcp: async (_provider: string, body: ACPMessageData, opts?: { meta?: Record<string, unknown> }) => {
            sent.push({ body, meta: opts?.meta });
          },
        });
      },
    });

    const started = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'review',
      modelSelection: null,
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Review.',
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'bounded',
      ioMode: 'request_response',
    });

    const stopped = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_STOP, { runId: started.runId });
    expect(stopped.ok).toBe(true);

    // Cancellation emits a tool-result with cancelled status.
    const toolResult = [...sent].reverse().find((m) => (m.body as any)?.type === 'tool-result');
    expect((toolResult?.body as any)?.output?.status).toBe('cancelled');
  });

  it('returns the typed update requirement for the released attached execution.run.send body', async () => {
    const sent: Array<{ body: unknown; meta?: Record<string, unknown> }> = [];

    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: () => createStaticBackend('reply'),
          sendAcp: async (_provider: string, body: ACPMessageData, opts?: { meta?: Record<string, unknown> }) => {
            sent.push({ body, meta: opts?.meta });
          },
        });
      },
    });

    const started = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'delegate',
      modelSelection: null,
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'hello',
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'request_response',
    });

    await expect.poll(
      () => sent.filter((m: any) => m?.body?.type === 'message').length,
    ).toBe(1);

    const sentReply = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_SEND, {
      runId: started.runId,
      message: 'next',
      delivery: 'steer_if_supported',
    });
    expect(sentReply).toMatchObject({
      ok: false,
      errorCode: 'session_input_target_update_required',
    });
    expect(sent.filter((m: any) => m?.body?.type === 'message').length).toBe(1);
  });

  it('returns execution_run_busy for prompt delivery to a detached bounded task already in flight', async () => {
    const { backend, events } = createSequencedBackend({
      responses: [{ text: 'reply', delayMs: null }],
    });

    const client = createDetachedRunRpcTestClient({
      scopePrefix: 'sess_1',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: null,
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: () => backend,
          sendAcp: async () => {},
        });
      },
    });

    const started = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      sessionId: null,
      intent: 'task',
      modelSelection: null,
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Start.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });

    expect(started, JSON.stringify(started)).toMatchObject({ runId: expect.any(String) });
    await expect.poll(() => events.sendPrompts.length).toBe(1);

    const busy = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_SEND, {
      sessionId: null,
      runId: started.runId,
      message: 'second',
      delivery: 'prompt',
    });
    expect(busy.ok).toBe(false);
    expect(busy.errorCode).toBe('execution_run_busy');
    expect(events.sendPrompts).toHaveLength(1);
  });

  it('keeps long-lived runs running when a turn is cancelled by the backend', async () => {
    const { backend } = createSequencedBackend({
      responses: [{ text: 'start', delayMs: 0 }],
      supportsSteer: false,
      completionRejectMessage: 'Turn cancelled',
    });

    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: () => backend,
          sendAcp: async () => {},
        });
      },
    });

    const started = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'delegate',
      modelSelection: null,
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Start.',
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'request_response',
    });

    await new Promise((r) => setTimeout(r, 15));

    const got = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_GET, { runId: started.runId });
    expect(got.run?.status).toBe('running');
    expect(got.run?.error).toBeUndefined();
  });

  it('does not terminalize long-lived runs when the initial prompt fails with an abort-like error', async () => {
    let backend: ReturnType<typeof createTestExecutionRunHostRuntime>;
    backend = createTestExecutionRunHostRuntime({
      onSendPrompt() {
        throw new Error('Turn cancelled');
      },
      onWaitForTurnCompletion() {
        backend.emitMessage({ type: 'status', status: 'idle' } as AgentMessage);
      },
    });

    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: () => backend,
          sendAcp: async () => {},
        });
      },
    });

    const started = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'delegate',
      modelSelection: null,
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Start.',
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'request_response',
    });

    await new Promise((r) => setTimeout(r, 15));

    const got = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_GET, { runId: started.runId });
    expect(got.run?.status).toBe('running');
    expect(got.run?.error).toBeUndefined();
  });

  it('keeps detached bounded replacement delivery healthy across multiple cancellations', async () => {
    const { backend, events } = createSequencedBackend({
      responses: [
        // Only cancellation settles these external turns.
        { text: 'start', delayMs: null },
        { text: 'first', delayMs: null },
        // Second user send: completes quickly.
        { text: 'second', delayMs: 0 },
      ],
      supportsSteer: false,
      cancelRejects: true,
    });

    const client = createDetachedRunRpcTestClient({
      scopePrefix: 'sess_1',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: null,
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: () => backend,
          sendAcp: async () => {},
        });
      },
    });

    const started = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      sessionId: null,
      intent: 'task',
      modelSelection: null,
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Start.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });

    await expect.poll(() => events.sendPrompts.length).toBe(1);

    const first = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_SEND, {
      sessionId: null,
      runId: started.runId,
      message: 'first',
      delivery: 'interrupt',
    });
    expect(first.ok).toBe(true);

    await expect.poll(() => events.sendPrompts.length).toBe(2);

    const second = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_SEND, {
      sessionId: null,
      runId: started.runId,
      message: 'second',
      delivery: 'interrupt',
    });
    expect(second.ok).toBe(true);

    const got = await waitForExecutionRunTerminalState(client, started.runId);
    expect(got.run?.status).toBe('succeeded');
    expect(got.run?.error).toBeUndefined();
  });

  it('supports detached bounded steering while running (cancel+send fallback when steer is unavailable)', async () => {
    const { backend, events } = createSequencedBackend({
      responses: [
        // Initial bounded prompt output (will be cancelled before it emits)
        { text: 'initial', delayMs: null },
        // After interrupt, emit valid output
        { text: 'after', delayMs: 0 },
      ],
      supportsSteer: false,
    });

    const client = createDetachedRunRpcTestClient({
      scopePrefix: 'sess_1',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: null,
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: () => backend,
          sendAcp: async () => {},
        });
      },
    });

    const started = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      sessionId: null,
      intent: 'task',
      modelSelection: null,
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Run a task.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });

    await expect.poll(() => events.sendPrompts.length).toBe(1);

    const steered = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_SEND, {
      sessionId: null,
      runId: started.runId,
      message: 'please focus on X',
      delivery: 'steer_if_supported',
    });
    expect(steered.ok).toBe(true);
    expect(events.cancelCount).toBe(1);

    const got = await waitForExecutionRunTerminalState(client, started.runId);
    expect(got.run?.status).toBe('succeeded');
    expect(got.latestToolResult).toBe('after');
  });

  it('acks detached bounded sends once the replacement turn is adopted, even if the backend never completes it', async () => {
    const client = createDetachedRunRpcTestClient({
      scopePrefix: 'sess_1',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: null,
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: () => createNeverResolvingBackend(),
          sendAcp: async () => {},
        });
      },
    });

    const started = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      sessionId: null,
      intent: 'task',
      modelSelection: null,
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Run a task.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });

    await new Promise((r) => setTimeout(r, 5));

    const sendResult = await Promise.race([
      client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_SEND, {
        sessionId: null,
        runId: started.runId,
        message: 'ping',
        delivery: 'steer_if_supported',
      }),
      new Promise((resolve) => setTimeout(() => resolve('__timeout__'), 250)),
    ]);

    expect(sendResult).not.toBe('__timeout__');
    expect((sendResult as any).ok).toBe(true);

    const got = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_GET, { runId: started.runId });
    expect(got.run?.status).toBe('running');
  });

  it('rejects detached bounded run sends after completion', async () => {
    const client = createDetachedRunRpcTestClient({
      scopePrefix: 'sess_1',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: null,
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: () => createStaticBackend('ok'),
          sendAcp: async () => {},
        });
      },
    });

    const started = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      sessionId: null,
      intent: 'task',
      modelSelection: null,
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Run a task.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });

    await expect.poll(async () => {
      const got = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_GET, { runId: started.runId });
      return got.run?.status;
    }).toBe('succeeded');

    const res = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_SEND, {
      sessionId: null,
      runId: started.runId,
      message: 'late',
      delivery: 'steer_if_supported',
    });
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('execution_run_not_allowed');
  });

  it('streams voice_agent turns via execution.run.stream.*', async () => {
    const createdBackends: Array<{ backendId: string; permissionMode: string; modelId?: string }> = [];
    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      callerAuthority: 'present_user',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: (opts) => {
            createdBackends.push({ backendId: opts.backendId, permissionMode: opts.permissionMode, modelId: opts.modelId });
            return createStaticBackend(
              `Hello.\n\n<voice_actions>${JSON.stringify({ actions: [{ t: 'sendSessionMessage', args: { message: 'hi' } }] })}</voice_actions>`,
            );
          },
          sendAcp: async () => {},
        });
      },
    });

    const started = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'voice_agent',
      modelSelection: null,
      connectedServices: null,
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'streaming',
      // voice_agent-specific config (wired through execution-run start)
      chatModelId: 'chat',
      commitModelId: 'commit',
      idleTtlSeconds: 60,
      initialContext: 'You are a helpful voice agent.',
      verbosity: 'short',
      transcript: { persistenceMode: 'ephemeral', epoch: 0 },
    });
    expect(started.runId, JSON.stringify(started)).toMatch(/^run_/);
    // Start should propagate the chat model ID to the voice agent backend.
    expect(createdBackends.map((b) => b.modelId), JSON.stringify(executionRunTestManagers.at(-1)?.listPublic())).toEqual(expect.arrayContaining(['chat']));

    const streamStart = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START, {
      runId: started.runId,
      message: 'Hi',
    });
    expect(streamStart.streamId, JSON.stringify(streamStart)).toMatch(/^stream_/);

    const read = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_READ, {
      runId: started.runId,
      streamId: streamStart.streamId,
      cursor: 0,
      maxEvents: 128,
    });
    expect(read.done).toBe(true);
    const turnFinal = (read.events as any[]).find(
      (event) => event.t === 'voice_output' && event.output?.kind === 'turn_final',
    ) ?? null;
    const sideEffect = (read.events as any[]).find(
      (event) => event.t === 'voice_output' && event.output?.kind === 'side_effect',
    ) ?? null;
    expect(turnFinal?.output?.text).toBe('I sent that to the coding assistant and am waiting for its update.');
    expect(sideEffect?.output?.action?.t).toBe('sendSessionMessage');
  });

  it('hydrates cached voice replay summaries on the daemon before the first streamed turn', async () => {
    const { readStoredCredentials } = await import('@/persistence');
    const { fetchSessionById } = await import('@/session/transport/http/sessionsHttp');
    const { fetchEncryptedTranscriptMessages } = await import('@/session/replay/fetchEncryptedTranscriptMessages');
    vi.mocked(readStoredCredentials).mockResolvedValue({ token: 'token_1', encryption: null });
    vi.mocked(fetchSessionById).mockImplementation(async ({ sessionId }) => createSessionRecordFixture({
      id: sessionId, seq: 3, encryptionMode: 'plain',
      metadata: JSON.stringify(createTestMetadata({ path: defaultExecutionRunTestCwd, machineId: 'execution-run-machine', flavor: 'claude' })),
    }));
    vi.mocked(fetchEncryptedTranscriptMessages).mockResolvedValue([
      {
        seq: 1,
        createdAt: 100,
        content: {
          t: 'plain',
          v: {
            role: 'user',
            content: { type: 'text', text: 'Old user turn' },
            meta: { happier: { kind: 'voice_agent_turn.v1', payload: { v: 1, epoch: 3, role: 'user', voiceAgentId: 'va_1', ts: 100 } } },
          },
        },
      },
      {
        seq: 2,
        createdAt: 200,
        content: {
          t: 'plain',
          v: {
            role: 'agent',
            content: { type: 'text', text: 'Old assistant turn' },
            meta: { happier: { kind: 'voice_agent_turn.v1', payload: { v: 1, epoch: 3, role: 'assistant', voiceAgentId: 'va_1', ts: 200 } } },
          },
        },
      },
      {
        seq: 3,
        createdAt: 300,
        content: {
          t: 'plain',
          v: {
            role: 'agent',
            content: { type: 'text', text: '[synopsis]' },
            meta: { happier: { kind: 'session_synopsis.v1', payload: { v: 1, seqTo: 2, updatedAtMs: 9, synopsis: 'Cached replay summary' } } },
          },
        },
      },
    ] as any);

    const { backend, events } = createSequencedBackend({
      responses: [{ text: 'Voice reply', delayMs: 0 }],
    });

    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      callerAuthority: 'present_user',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: () => backend,
          sendAcp: async () => {},
        });
      },
    });

    const started = await client.call<ExecutionRunStartResponse, unknown>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'voice_agent',
      modelSelection: null,
      connectedServices: null,
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'streaming',
      chatModelId: 'chat',
      commitModelId: 'commit',
      idleTtlSeconds: 60,
      initialContext: 'Base context',
      verbosity: 'short',
      transcript: { persistenceMode: 'persistent', epoch: 3 },
      replay: {
        kind: 'voice_session.v1',
        previousSessionId: 'sys_voice',
        transcriptEpoch: 3,
        strategy: 'summary_plus_recent',
        recentMessagesCount: 2,
      },
    });

    const replayStream = await client.call(SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START, {
      runId: started.runId,
      message: 'continue',
    });
    expect(replayStream).toMatchObject({ streamId: expect.any(String) });
    await vi.waitFor(() => {
      expect(events.sendPrompts[0]).toContain('Cached replay summary');
      expect(events.sendPrompts[0]).toContain('Old assistant turn');
    });
  });

  it('falls back to on-demand replay summaries for voice runs when no cached synopsis exists', async () => {
    const { readStoredCredentials } = await import('@/persistence');
    const { fetchSessionById } = await import('@/session/transport/http/sessionsHttp');
    const { fetchEncryptedTranscriptMessages } = await import('@/session/replay/fetchEncryptedTranscriptMessages');
    const { runReplaySummaryForDialog } = await import('@/session/replay/summary/runReplaySummaryForDialog');
    vi.mocked(readStoredCredentials).mockResolvedValue({ token: 'token_1', encryption: null });
    vi.mocked(fetchSessionById).mockImplementation(async ({ sessionId }) => createSessionRecordFixture({
      id: sessionId, seq: 2, encryptionMode: 'plain',
      metadata: JSON.stringify(createTestMetadata({ path: defaultExecutionRunTestCwd, machineId: 'execution-run-machine', flavor: 'claude' })),
    }));
    vi.mocked(fetchEncryptedTranscriptMessages).mockResolvedValue([
      {
        seq: 1,
        createdAt: 100,
        content: {
          t: 'plain',
          v: {
            role: 'user',
            content: { type: 'text', text: 'User asked to continue' },
            meta: { happier: { kind: 'voice_agent_turn.v1', payload: { v: 1, epoch: 4, role: 'user', voiceAgentId: 'va_1', ts: 100 } } },
          },
        },
      },
      {
        seq: 2,
        createdAt: 200,
        content: {
          t: 'plain',
          v: {
            role: 'agent',
            content: { type: 'text', text: 'Assistant answered previously' },
            meta: { happier: { kind: 'voice_agent_turn.v1', payload: { v: 1, epoch: 4, role: 'assistant', voiceAgentId: 'va_1', ts: 200 } } },
          },
        },
      },
    ] as any);
    vi.mocked(runReplaySummaryForDialog).mockResolvedValue('Generated replay summary');

    const { backend, events } = createSequencedBackend({
      responses: [{ text: 'Voice reply', delayMs: 0 }],
    });

    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      callerAuthority: 'present_user',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: () => backend,
          sendAcp: async () => {},
        });
      },
    });

    const started = await client.call<ExecutionRunStartResponse, unknown>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'voice_agent',
      modelSelection: null,
      connectedServices: null,
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'streaming',
      chatModelId: 'chat',
      commitModelId: 'commit',
      idleTtlSeconds: 60,
      initialContext: 'Base context',
      verbosity: 'short',
      transcript: { persistenceMode: 'persistent', epoch: 4 },
      replay: {
        kind: 'voice_session.v1',
        previousSessionId: 'sys_voice',
        transcriptEpoch: 4,
        strategy: 'summary_plus_recent',
        recentMessagesCount: 2,
        summaryRunner: {
          v: 1,
          backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
          modelId: 'default',
          permissionMode: 'no_tools',
        },
      },
    });

    const replayStream = await client.call(SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START, {
      runId: started.runId,
      message: 'continue',
    });
    expect(replayStream).toMatchObject({ streamId: expect.any(String) });
    expect(vi.mocked(runReplaySummaryForDialog)).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(events.sendPrompts[0]).toContain('Generated replay summary');
      expect(events.sendPrompts[0]).toContain('Assistant answered previously');
    });
  });

  it('defers replay seed delivery to the first turn when voice prewarm uses a READY handshake', async () => {
    const { readStoredCredentials } = await import('@/persistence');
    const { fetchSessionById } = await import('@/session/transport/http/sessionsHttp');
    const { fetchEncryptedTranscriptMessages } = await import('@/session/replay/fetchEncryptedTranscriptMessages');
    vi.mocked(readStoredCredentials).mockResolvedValue({ token: 'token_1', encryption: null });
    vi.mocked(fetchSessionById).mockImplementation(async ({ sessionId }) => createSessionRecordFixture({
      id: sessionId, seq: 3, encryptionMode: 'plain',
      metadata: JSON.stringify(createTestMetadata({ path: defaultExecutionRunTestCwd, machineId: 'execution-run-machine', flavor: 'claude' })),
    }));
    vi.mocked(fetchEncryptedTranscriptMessages).mockResolvedValue([
      {
        seq: 1,
        createdAt: 100,
        content: {
          t: 'plain',
          v: {
            role: 'user',
            content: { type: 'text', text: 'Old user turn' },
            meta: { happier: { kind: 'voice_agent_turn.v1', payload: { v: 1, epoch: 5, role: 'user', voiceAgentId: 'va_1', ts: 100 } } },
          },
        },
      },
      {
        seq: 2,
        createdAt: 200,
        content: {
          t: 'plain',
          v: {
            role: 'agent',
            content: { type: 'text', text: 'Old assistant turn' },
            meta: { happier: { kind: 'voice_agent_turn.v1', payload: { v: 1, epoch: 5, role: 'assistant', voiceAgentId: 'va_1', ts: 200 } } },
          },
        },
      },
      {
        seq: 3,
        createdAt: 300,
        content: {
          t: 'plain',
          v: {
            role: 'agent',
            content: { type: 'text', text: '[synopsis]' },
            meta: { happier: { kind: 'session_synopsis.v1', payload: { v: 1, seqTo: 2, updatedAtMs: 9, synopsis: 'Cached replay summary' } } },
          },
        },
      },
    ] as any);

    const { backend, events } = createSequencedBackend({
      responses: [{ text: 'READY', delayMs: 0 }, { text: 'Voice reply', delayMs: 0 }],
    });

    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      callerAuthority: 'present_user',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: () => backend,
          sendAcp: async () => {},
        });
      },
    });

    const started = await client.call<ExecutionRunStartResponse, unknown>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'voice_agent',
      modelSelection: null,
      connectedServices: null,
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'streaming',
      chatModelId: 'chat',
      commitModelId: 'commit',
      idleTtlSeconds: 60,
      initialContext: 'Base context',
      verbosity: 'short',
      bootstrapMode: 'ready_handshake',
      transcript: { persistenceMode: 'persistent', epoch: 5 },
      replay: {
        kind: 'voice_session.v1',
        previousSessionId: 'sys_voice',
        transcriptEpoch: 5,
        strategy: 'summary_plus_recent',
        recentMessagesCount: 2,
      },
    });

    expect(events.sendPrompts[0]).toContain('Warm-up step: reply with exactly READY');
    expect(events.sendPrompts[0]).not.toContain('Cached replay summary');
    expect(events.sendPrompts[0]).not.toContain('Old assistant turn');

    const replayStream = await client.call(SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START, {
      runId: started.runId,
      message: 'continue',
    });
    expect(replayStream).toMatchObject({ streamId: expect.any(String) });
    await vi.waitFor(() => {
      expect(events.sendPrompts[1]).toContain('Cached replay summary');
      expect(events.sendPrompts[1]).toContain('Old assistant turn');
    });
  });

  it('commits persistent voice_agent transcript turns durably via the transcript port', async () => {
    const committedUserTurns: Array<{ text: string; meta: Record<string, unknown> }> = [];
    const committedAssistantTurns: Array<{ text: string; meta: Record<string, unknown> }> = [];

    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      callerAuthority: 'present_user',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: () => createStaticBackend('Committed reply'),
          sendAcp: async () => {},
          transcriptWriter: {
            commitVoiceAgentTranscriptTurn: async (turn: Readonly<{
              turnId: string;
              user: Readonly<{ text: string; meta: Record<string, unknown> }>;
              assistant: Readonly<{ text: string; meta: Record<string, unknown> }>;
            }>) => {
              committedUserTurns.push(turn.user);
              committedAssistantTurns.push(turn.assistant);
              return { persisted: true, delivered: true };
            },
          },
        });
      },
    });

    const started = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'voice_agent',
      modelSelection: null,
      connectedServices: null,
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'streaming',
      chatModelId: 'chat',
      commitModelId: 'commit',
      idleTtlSeconds: 60,
      initialContext: 'ctx',
      verbosity: 'short',
      transcript: { persistenceMode: 'persistent', epoch: 4 },
    });
    expect(started.runId, JSON.stringify(started)).toEqual(expect.any(String));

    const streamStart = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START, {
      runId: started.runId,
      message: 'Persist this user turn',
      displayMessage: 'Persist only this clean user turn',
    });
    expect(streamStart.streamId, JSON.stringify(streamStart)).toEqual(expect.any(String));
    const read = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_READ, {
      runId: started.runId,
      streamId: streamStart.streamId,
      cursor: 0,
      maxEvents: 128,
    });

    expect(read.done).toBe(true);
    expect(committedUserTurns).toHaveLength(1);
    expect(committedUserTurns[0]?.text).toBe('Persist only this clean user turn');
    expect(committedUserTurns[0]?.meta).toMatchObject({
      happier: { kind: 'voice_agent_turn.v1', payload: { epoch: 4, role: 'user', voiceAgentId: started.runId } },
    });
    expect(committedAssistantTurns).toHaveLength(1);
    expect(committedAssistantTurns[0]?.text).toBe('Committed reply');
    expect(committedAssistantTurns[0]?.meta).toMatchObject({
      happier: { kind: 'voice_agent_turn.v1', payload: { epoch: 4, role: 'assistant', voiceAgentId: started.runId } },
    });
  });

  it('admits a V2 persisted user transcript through the registered handler before the real voice manager starts its stream', async () => {
    const admissionOrder: string[] = [];
    const committedUserTurns: Array<Readonly<{
      text: string;
      localId: string;
      meta: Record<string, unknown>;
    }>> = [];
    let runtime: ReturnType<typeof createTestExecutionRunHostRuntime>;
    runtime = createTestExecutionRunHostRuntime({
      onSendPrompt(_sessionId, prompt) {
        admissionOrder.push(`manager:${prompt}`);
        runtime.emitMessage({ type: 'model-output', fullText: 'V2 committed reply' } as AgentMessage);
      },
      onWaitForTurnCompletion() {},
    });

    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      callerAuthority: 'present_user',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: () => runtime,
          sendAcp: async () => {},
          transcriptWriter: {
            appendUserTextCommitted: async (text, options) => {
              admissionOrder.push(`persist:${text}`);
              committedUserTurns.push({ text, localId: options.localId, meta: options.meta });
              return { persisted: true, delivered: true };
            },
            appendAssistantTextCommitted: async () => ({ persisted: true, delivered: true }),
            commitVoiceAgentTranscriptTurn: async () => ({ persisted: true, delivered: true }),
          },
        });
      },
    });

    const started = await client.call<ExecutionRunStartResponse, unknown>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'voice_agent',
      modelSelection: null,
      connectedServices: null,
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'streaming',
      chatModelId: 'chat',
      commitModelId: 'commit',
      idleTtlSeconds: 60,
      initialContext: 'ctx',
      verbosity: 'short',
      transcript: { persistenceMode: 'persistent', epoch: 4 },
    });

    const streamStart = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START_V2, {
      runId: started.runId,
      message: 'Provider-bound user text',
      displayMessage: 'Persisted canonical user text',
      userTranscript: { mode: 'persist', localId: 'voice-v2-local-id' },
    });

    expect(streamStart.streamId, JSON.stringify(streamStart)).toEqual(expect.any(String));
    let cursor = 0;
    while (true) {
      const read = await client.call<Readonly<{ streamId: string; done: boolean; nextCursor: number }>, unknown>(SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_READ, {
        runId: started.runId,
        streamId: streamStart.streamId,
        cursor,
        maxEvents: 128,
        waitForEvents: true,
      });
      expect(read, JSON.stringify(read)).toMatchObject({
        streamId: streamStart.streamId,
        done: expect.any(Boolean),
        nextCursor: expect.any(Number),
      });
      if (read.done) break;
      cursor = read.nextCursor;
    }
    expect(admissionOrder).toHaveLength(2);
    expect(admissionOrder[0]).toBe('persist:Persisted canonical user text');
    expect(admissionOrder[1]).toContain('Provider-bound user text');
    expect(committedUserTurns).toEqual([
      expect.objectContaining({
        text: 'Persisted canonical user text',
        localId: 'voice-v2-local-id',
        meta: expect.objectContaining({
          happier: expect.objectContaining({
            kind: 'voice_agent_turn.v1',
            payload: expect.objectContaining({
              epoch: 4,
              role: 'user',
              voiceAgentId: started.runId,
              runId: started.runId,
            }),
          }),
        }),
      }),
    ]);
  });

  it('normalizes the prospective predecessor transcript commit vector once at the RPC seam', async () => {
    transcriptLaunch = await prepareTranscriptCommitLaunch();
    const { credentials } = transcriptLaunch;
    const committedUserTurns: Array<Readonly<{ text: string; localId: string }>> = [];
    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      callerAuthority: 'present_user',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          readPromptCredentials: async () => credentials,
          createBackend: () => createStaticBackend('Unused reply'),
          sendAcp: async () => {},
          transcriptWriter: {
            appendUserTextCommitted: async (text, options) => {
              committedUserTurns.push({ text, localId: options.localId });
              return { persisted: true, delivered: true };
            },
            commitVoiceAgentTranscriptTurn: async () => ({ persisted: true, delivered: true }),
          },
        });
      },
    });

    const started = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'voice_agent',
      modelSelection: null,
      connectedServices: null,
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'streaming',
      chatModelId: 'chat',
      commitModelId: 'commit',
      modelId: 'chat',
      idleTtlSeconds: 60,
      initialContext: 'ctx',
      verbosity: 'short',
      transcript: { persistenceMode: 'persistent', epoch: 4 },
    });
    expect(started.runId, JSON.stringify(started)).toEqual(expect.any(String));

    // New reader consuming ../remote-dev@0649e4de's prospective writer shape.
    await expect(client.call(SESSION_RPC_METHODS.EXECUTION_RUN_USER_TRANSCRIPT_COMMIT_V1, {
      runId: started.runId,
      message: 'Predecessor provider text',
      displayMessage: 'Predecessor display text',
      localId: 'predecessor-local-id',
    })).resolves.toMatchObject({ ok: true });
    await expect(client.call(SESSION_RPC_METHODS.EXECUTION_RUN_USER_TRANSCRIPT_COMMIT_V1, {
      runId: started.runId,
      text: 'Current-dev provider text',
      displayText: 'Current-dev display text',
      localId: 'current-dev-local-id',
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'execution_run_invalid_action_input',
    });

    expect(committedUserTurns).toEqual([
      { text: 'Predecessor display text', localId: 'predecessor-local-id' },
    ]);
  });

  it.each([undefined, 'account_automation'] as const)('rejects %s transcript commit authority before writing Voice user text', async (callerAuthority) => {
    transcriptLaunch = await prepareTranscriptCommitLaunch();
    const { credentials } = transcriptLaunch;
    const committedUserTurns: Array<Readonly<{ text: string; localId: string }>> = [];
    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      ...(callerAuthority ? { callerAuthority } : {}),
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1', cwd: process.cwd(), parentProvider: 'claude',
          readPromptCredentials: async () => credentials,
          createBackend: () => createStaticBackend('Unused reply'),
          sendAcp: async () => {},
          transcriptWriter: {
            appendUserTextCommitted: async (text, options) => {
              committedUserTurns.push({ text, localId: options.localId });
              return { persisted: true, delivered: true };
            },
            commitVoiceAgentTranscriptTurn: async () => ({ persisted: true, delivered: true }),
          },
        });
      },
    });
    const started = await client.call<Readonly<{ runId: string }>, unknown>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'voice_agent', backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming',
      chatModelId: 'chat', commitModelId: 'commit', idleTtlSeconds: 60, initialContext: 'ctx', verbosity: 'short',
      modelId: 'chat', connectedServices: null,
      transcript: { persistenceMode: 'persistent', epoch: 4 },
    });
    expect(started.runId, JSON.stringify(started)).toEqual(expect.any(String));
    await expect(client.call(SESSION_RPC_METHODS.EXECUTION_RUN_USER_TRANSCRIPT_COMMIT_V1, {
      runId: started.runId, message: 'Unadmitted user text', localId: 'unadmitted-local-id',
    })).resolves.toMatchObject({ ok: false, errorCode: 'execution_run_not_allowed' });
    expect(committedUserTurns).toEqual([]);
  });

  it('supports voice_agent stream resume via execution.run.stream.start(resume=true) after stop when backend supports loadSession', async () => {
    const createBackend = createResumableBackendFactory(
      `Hello.\n\n<voice_actions>${JSON.stringify({ actions: [{ t: 'sendSessionMessage', args: { message: 'hi' } }] })}</voice_actions>`,
    );

    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      callerAuthority: 'present_user',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: () => createBackend(),
          sendAcp: async () => {},
        });
      },
    });

    const started = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'voice_agent',
      modelSelection: null,
      connectedServices: null,
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'streaming',
      chatModelId: 'chat',
      commitModelId: 'commit',
      idleTtlSeconds: 60,
      initialContext: 'ctx',
      verbosity: 'short',
      transcript: { persistenceMode: 'ephemeral', epoch: 0 },
    });

    const stream1 = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START, {
      runId: started.runId,
      message: 'Hi',
    });
    const read1 = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_READ, {
      runId: started.runId,
      streamId: stream1.streamId,
      cursor: 0,
      maxEvents: 128,
    });
    expect(read1.done).toBe(true);
    expect((read1.events as any[]).find(
      (event) => event.t === 'voice_output' && event.output?.kind === 'turn_final',
    )?.output?.text).toBe(
      'I sent that to the coding assistant and am waiting for its update.',
    );

    const stopped = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_STOP, { runId: started.runId });
    expect(stopped.ok).toBe(true);

    const retained = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_GET, {
      runId: started.runId,
      includeStructured: false,
    });
    expect(retained?.run?.resumeHandle).toMatchObject({
      kind: 'provider_session.v1',
      providerSessionId: 'provider_session_resumable',
    });

    const stream2 = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START, {
      runId: started.runId,
      message: 'Hi again',
      resume: true,
    });
    expect(stream2.streamId).toMatch(/^stream_/);
    const read2 = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_READ, {
      runId: started.runId,
      streamId: stream2.streamId,
      cursor: 0,
      maxEvents: 128,
    });
    expect(read2.done).toBe(true);
    expect((read2.events as any[]).find(
      (event) => event.t === 'voice_output' && event.output?.kind === 'turn_final',
    )?.output?.text).toBe(
      'I sent that to the coding assistant and am waiting for its update.',
    );
  });

  it('resumes voice_agent streams after commit when the run stores a voice_agent_sessions resume handle', async () => {
    const loadCalls = { chat: [] as string[], commit: [] as string[] };

    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      callerAuthority: 'present_user',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: ({ modelId }) => {
            const modelKey = modelId === 'commit' ? 'commit' : 'chat';
            let runtime: ReturnType<typeof createTestExecutionRunHostRuntime>;
            runtime = createTestExecutionRunHostRuntime({
              runtimeId: modelKey === 'commit' ? 'commit_session_1' : 'chat_session_1',
              providerSessionId: modelKey === 'commit' ? 'commit_provider_session_1' : 'chat_provider_session_1',
              resumeSupported: true,
              onProvisionRuntime(opts) {
                if (opts?.resumeRuntimeId) {
                  loadCalls[modelKey].push(String(opts.resumeRuntimeId));
                }
              },
              onSendPrompt() {
                const responseText =
                  modelKey === 'commit'
                    ? 'COMMIT_TEXT'
                    : `Hello.\n\n<voice_actions>${JSON.stringify({ actions: [{ t: 'sendSessionMessage', args: { message: 'hi' } }] })}</voice_actions>`;
                runtime.emitMessage({ type: 'model-output', fullText: responseText } as AgentMessage);
              },
              onWaitForTurnCompletion() {},
            });
            return runtime;
          },
          sendAcp: async () => {},
        });
      },
    });

    const started = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'voice_agent',
      modelSelection: null,
      connectedServices: null,
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'streaming',
      chatModelId: 'chat',
      commitModelId: 'commit',
      idleTtlSeconds: 60,
      initialContext: 'ctx',
      verbosity: 'short',
      transcript: { persistenceMode: 'ephemeral', epoch: 0 },
    });

    const stream1 = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START, {
      runId: started.runId,
      message: 'Hi',
    });
    const read1 = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_READ, {
      runId: started.runId,
      streamId: stream1.streamId,
      cursor: 0,
      maxEvents: 128,
    });
    expect(read1.done).toBe(true);

    const committed = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_ACTION, {
      runId: started.runId,
      actionId: 'voice_agent.commit',
      input: { maxChars: 1000 },
    });
    expect(committed.ok).toBe(true);
    expect(committed.result?.commitText).toBe('COMMIT_TEXT');

    const beforeStop = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_GET, {
      runId: started.runId,
      includeStructured: false,
    });
    expect(beforeStop?.run?.resumeHandle).toMatchObject({
      kind: 'voice_agent_sessions.v1',
      chatProviderSessionId: 'chat_provider_session_1',
      commitProviderSessionId: 'commit_provider_session_1',
    });

    const stopped = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_STOP, { runId: started.runId });
    expect(stopped.ok).toBe(true);

    const stream2 = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START, {
      runId: started.runId,
      message: 'Hi again',
      resume: true,
    });
    expect(stream2.streamId).toMatch(/^stream_/);

    const read2 = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_READ, {
      runId: started.runId,
      streamId: stream2.streamId,
      cursor: 0,
      maxEvents: 128,
    });
    expect(read2.done).toBe(true);
    expect((read2.events as any[]).find(
      (event) => event.t === 'voice_output' && event.output?.kind === 'turn_final',
    )?.output?.text).toBe(
      'I sent that to the coding assistant and am waiting for its update.',
    );
    expect(loadCalls.chat).toEqual(['chat_provider_session_1']);
    expect(loadCalls.commit).toEqual(['commit_provider_session_1']);
  });

  it('rejects voice_agent runs when voice feature is locally disabled', async () => {
    const prev = process.env.HAPPIER_FEATURE_VOICE__ENABLED;
    process.env.HAPPIER_FEATURE_VOICE__ENABLED = '0';
    try {
      const client = createEncryptedRpcTestClient({
        scopePrefix: 'sess_1',
        registerHandlers: (rpc) => {
          registerExecutionRunHandlers(rpc, {
            sessionId: 'sess_1',
            cwd: process.cwd(),
            parentProvider: 'claude',
            createBackend: () => createStaticBackend('Hello.'),
            sendAcp: async () => {},
          });
        },
      });

      const res = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
        intent: 'voice_agent',
        modelSelection: null,
        connectedServices: null,
        chatModelId: 'default',
        commitModelId: 'default',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        permissionMode: 'read_only',
        retentionPolicy: 'ephemeral',
        runClass: 'long_lived',
        ioMode: 'streaming',
      });

      expect(res.ok).toBe(false);
      expect(res.errorCode).toBe('execution_run_not_allowed');
    } finally {
      if (prev === undefined) delete process.env.HAPPIER_FEATURE_VOICE__ENABLED;
      else process.env.HAPPIER_FEATURE_VOICE__ENABLED = prev;
    }
  });

  it('settles the created Run as failed VOICE_AGENT_UNSUPPORTED when starting a voice_agent run with an unsupported backend', async () => {
    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: ({ backendId }) => {
            if (backendId === 'codex') {
              throw new Error('codex missing');
            }
            return createStaticBackend('ok');
          },
          sendAcp: async () => {},
        });
      },
    });

    const started = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'voice_agent',
      modelSelection: null,
      connectedServices: null,
      chatModelId: 'default',
      commitModelId: 'default',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'streaming',
    });

    // Start acknowledges the created Run; its failed initialization settles on the Run.
    expect(started?.runId).toMatch(/^run_/);
    const got = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_GET, { runId: started.runId });
    expect(got?.run).toMatchObject({ status: 'failed', error: { code: 'VOICE_AGENT_UNSUPPORTED' } });
    expect(String(got?.run?.error?.message ?? '')).toContain('codex');
  });

  it('settles the created Run as failed VOICE_AGENT_UNSUPPORTED when voice_agent backend initialization fails (claude)', async () => {
    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: ({ backendId }) => {
            if (backendId === 'claude') {
              throw new Error('claude missing');
            }
            return createStaticBackend('ok');
          },
          sendAcp: async () => {},
        });
      },
    });

    const started = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'voice_agent',
      modelSelection: null,
      connectedServices: null,
      chatModelId: 'default',
      commitModelId: 'default',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'streaming',
    });

    expect(started?.runId).toMatch(/^run_/);
    const got = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_GET, { runId: started.runId });
    expect(got?.run).toMatchObject({ status: 'failed', error: { code: 'VOICE_AGENT_UNSUPPORTED' } });
    expect(String(got?.run?.error?.message ?? '')).toContain('claude');
  });

  it('passes configured ACP backend targets through to the execution-run backend factory', async () => {
    const seenTargets: unknown[] = [];
    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: ({ backendId, backendTarget }) => {
            seenTargets.push(backendTarget);
            if (backendId !== 'review-bot') {
              throw new Error(`Unexpected backend: ${backendId}`);
            }
            if (backendTarget?.kind !== 'configuredAcpBackend' || backendTarget.backendId !== 'review-bot') {
              throw new Error('Missing configured ACP backend target');
            }
            return createStaticBackend('configured ok');
          },
          sendAcp: async () => {},
        });
      },
    });

    const started = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'review',
      modelSelection: null,
      backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
      instructions: 'Review the changes',
    });

    expect(started?.runId).toEqual(expect.any(String));
    expect(seenTargets).toEqual([{ kind: 'configuredAcpBackend', backendId: 'review-bot' }]);
  });

  it('returns voice_agent.commit results via execution.run.action', async () => {
    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      callerAuthority: 'present_user',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: ({ modelId }) => createStaticBackend(
            modelId === 'commit' ? 'COMMIT_TEXT' : 'Hello.',
            modelId === 'commit' ? 'commit_provider_session_1' : 'chat_provider_session_1',
          ),
          sendAcp: async () => {},
        });
      },
    });

    const started = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'voice_agent',
      modelSelection: null,
      connectedServices: null,
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'streaming',
      chatModelId: 'chat',
      commitModelId: 'commit',
      idleTtlSeconds: 60,
      initialContext: 'ctx',
      verbosity: 'short',
    });

    const acted = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_ACTION, {
      runId: started.runId,
      actionId: 'voice_agent.commit',
      input: { maxChars: 1000 },
    });

    expect(acted.ok).toBe(true);
    expect(acted.result?.commitText).toBe('COMMIT_TEXT');

    const got = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_GET, {
      runId: started.runId,
      includeStructured: false,
    });
    expect(got?.run?.availableActionIds).toEqual(['voice_agent.welcome', 'voice_agent.commit', 'approval_profile.set']);
    expect(got?.run?.resumeHandle).toMatchObject({
      kind: 'voice_agent_sessions.v1',
      chatProviderSessionId: 'chat_provider_session_1',
      commitProviderSessionId: 'commit_provider_session_1',
    });
  });

  it('returns voice_agent.welcome results via execution.run.action', async () => {
    const onExecutionRunVoiceAgentWelcomed = vi.fn();
    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      callerAuthority: 'present_user',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: () => createStaticBackend('Hello! What are we working on today?'),
          sendAcp: async () => {},
          onExecutionRunVoiceAgentWelcomed,
        });
      },
    });

    const started = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'voice_agent',
      modelSelection: null,
      connectedServices: null,
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'streaming',
      chatModelId: 'chat',
      commitModelId: 'commit',
      idleTtlSeconds: 60,
      initialContext: 'ctx',
      verbosity: 'short',
    });

    const acted = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_ACTION, {
      runId: started.runId,
      actionId: 'voice_agent.welcome',
    });

    expect(acted.ok).toBe(true);
    expect(String(acted.result?.assistantText ?? '')).toContain('Hello');
    expect(onExecutionRunVoiceAgentWelcomed).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: started.runId,
        transcript: expect.objectContaining({ epoch: 0 }),
      }),
      0,
    );
  });

  it('does not materialize tool-call transcript messages for voice_agent runs', async () => {
    const sent: Array<{ body: unknown; meta?: Record<string, unknown> }> = [];
    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: () => createStaticBackend('Hello.'),
          sendAcp: async (_provider, body, opts) => {
            sent.push({ body, meta: opts?.meta });
          },
        });
      },
    });

    await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'voice_agent',
      modelSelection: null,
      connectedServices: null,
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'long_lived',
      ioMode: 'streaming',
      chatModelId: 'chat',
      commitModelId: 'commit',
      idleTtlSeconds: 60,
      initialContext: 'ctx',
      verbosity: 'short',
    });

    expect(sent.some((m) => (m.body as any)?.type === 'tool-call')).toBe(false);
  });

  it('releases execution budgets when a created voice_agent Run fails to initialize', async () => {
    const budgetRegistry = new ExecutionBudgetRegistry({
      maxConcurrentExecutionRuns: 1,
      maxConcurrentOneShotTasks: 1,
    });

    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: ({ backendId }) => {
            if (backendId === 'codex') throw new Error('codex missing');
            return createStaticBackend('ok');
          },
          sendAcp: async () => {},
          budgetRegistry,
        });
      },
    });

    const first = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'voice_agent',
      modelSelection: null,
      connectedServices: null,
      chatModelId: 'default',
      commitModelId: 'default',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'streaming',
    });
    expect(first?.runId).toMatch(/^run_/);
    const failed = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_GET, { runId: first.runId });
    expect(failed?.run).toMatchObject({ status: 'failed', error: { code: 'VOICE_AGENT_UNSUPPORTED' } });

    const second = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'voice_agent',
      modelSelection: null,
      connectedServices: null,
      chatModelId: 'default',
      commitModelId: 'default',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'streaming',
    });
    expect(second?.runId).toMatch(/^run_/);
  });

  it('returns canonical execution_run_invalid_action_input when review.triage receives an invalid payload', async () => {
    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: () => createStaticBackend(JSON.stringify({ findings: [], summary: 'ok' })),
          sendAcp: async () => {},
        });
      },
    });

    const started = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'review',
      modelSelection: null,
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Review.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });

    await new Promise((r) => setTimeout(r, 5));

    const acted = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_ACTION, {
      runId: started.runId,
      actionId: 'review.triage',
      input: { findings: 'not-an-array' },
    });
    expect(acted.ok).toBe(false);
    expect(acted.errorCode).toBe('execution_run_invalid_action_input');
  });

  it('returns permission_denied when starting a review run with an unsafe permissionMode', async () => {
    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: () => createStaticBackend(JSON.stringify({ findings: [], summary: 'ok' })),
          sendAcp: async () => {},
        });
      },
    });

    const started = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'review',
      modelSelection: null,
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Review.',
      permissionMode: 'full',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });

    expect(started.ok).toBe(false);
    expect(started.errorCode).toBe('permission_denied');
  });

  it('accepts canonical UI read-only permission tokens when starting a review run', async () => {
    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: () => createStaticBackend(JSON.stringify({ findings: [], summary: 'ok' })),
          sendAcp: async () => {},
        });
      },
    });

    const started = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'review',
      modelSelection: null,
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Review.',
      permissionMode: 'read-only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'streaming',
    });

    expect(typeof started.runId).toBe('string');
    expect(typeof started.callId).toBe('string');
    expect(typeof started.sidechainId).toBe('string');
  });

  it('starts provider-specific review runs through the generic runtimeCore path without registry-backed preflight', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-review-generic-runtime-core-workspace-'));
    const providerSpecificReviewBackendId = ['code', 'rabbit'].join('');
    const createBackend = vi.fn(() => createStaticBackend(JSON.stringify({ findings: [], summary: 'ok' })));

    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: workspace,
          parentProvider: 'claude',
          createBackend,
          sendAcp: async () => {},
        });
      },
    });

    const started = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'review',
      modelSelection: null,
      backendTarget: { kind: 'builtInAgent', agentId: providerSpecificReviewBackendId },
      instructions: 'Review.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'streaming',
      intentInput: {
        engineIds: [providerSpecificReviewBackendId],
        instructions: 'Review.',
        changeType: 'committed',
        base: { kind: 'none' },
      },
    });

    expect(started).toEqual(expect.objectContaining({
      runId: expect.any(String),
      callId: expect.any(String),
      sidechainId: expect.any(String),
    }));
    expect(createBackend).toHaveBeenCalledTimes(1);
  });

  it('rejects plan runs that violate the bounded ephemeral intent matrix before backend creation', async () => {
    const createBackend = vi.fn(() => createStaticBackend('unexpected'));

    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend,
          sendAcp: async () => {},
        });
      },
    });

    const started = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'plan',
      modelSelection: null,
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Plan.',
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'bounded',
      ioMode: 'request_response',
    });

    expect(started).toMatchObject({
      ok: false,
      errorCode: 'execution_run_not_allowed',
      error: 'Unsupported retentionPolicy',
    });
    expect(createBackend).not.toHaveBeenCalled();
  });

  it('rejects voice_agent runs that violate the resumable-only intent matrix before backend creation', async () => {
    const createBackend = vi.fn(() => createStaticBackend('unexpected'));

    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend,
          sendAcp: async () => {},
        });
      },
    });

    const started = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'voice_agent',
      modelSelection: null,
      connectedServices: null,
      chatModelId: 'default',
      commitModelId: 'default',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });

    expect(started).toMatchObject({
      ok: false,
      errorCode: 'execution_run_not_allowed',
      error: 'Unsupported retentionPolicy',
      details: {
        executionRunStart: { v: 1, runCreation: 'noRunCreated' },
        issues: [
          { code: 'invalid_value', path: ['retentionPolicy'], acceptedValues: ['resumable'] },
          { code: 'invalid_value', path: ['runClass'], acceptedValues: ['long_lived'] },
          { code: 'invalid_value', path: ['ioMode'], acceptedValues: ['streaming'] },
        ],
      },
    });
    expect(createBackend).not.toHaveBeenCalled();
  });

  it('allows starting a bounded review run with streaming ioMode (sidechain transcript streaming)', async () => {
    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: () => createStaticBackend(JSON.stringify({ findings: [], summary: 'ok' })),
          sendAcp: async () => {},
        });
      },
    });

    const started = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'review',
      modelSelection: null,
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Review.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'streaming',
    });

    expect(started.runId, JSON.stringify(started)).toMatch(/^run_/);
    expect(started.callId).toMatch(/^subagent_run_/);
    expect(started.sidechainId).toBe(started.callId);
  });

  it('shares the fallback registry across concurrent mixed-intent starts and releases it on Stop', async () => {
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'budget-account' })).toString('base64url')}.signature`;
    const get = vi.spyOn(axios, 'get');
    const priorGet = get.getMockImplementation()!;
    get.mockImplementation(async (url, options) => String(url).endsWith('/v2/account/session-follow-preferences')
      ? { status: 200, data: { ...DEFAULT_SESSION_AUTO_FOLLOW_PREFERENCES_V1,
          ...DEFAULT_SESSION_FOLLOW_CREATION_POLICIES_V1 } }
      : priorGet(url, options));
    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      callerAuthority: 'present_user',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: () => createDelayedBackend(JSON.stringify({ findings: [], summary: 'late' }), 50_000),
          sendAcp: async () => {},
          resolveRunReportPolicy: createSessionRunReportPolicyReader({ serverId: 'budget-home',
            serverHttpBaseUrl: 'https://budget.test', accountId: 'budget-account',
            readCredentials: async () => ({ token, encryption: null }), isCurrent: () => true }),
          policy: { maxConcurrentRuns: 1, boundedTimeoutMs: 60_000 },
        });
      },
    });

    const request = {
      intent: 'review',
      modelSelection: null,
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Review.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    } as const;
    const results = await Promise.all([
      client.call<ExecutionRunStartResponse, unknown>(SESSION_RPC_METHODS.EXECUTION_RUN_START, request),
      client.call<ExecutionRunStartResponse, unknown>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
        ...request, intent: 'delegate', instructions: 'Delegate the task.',
      }),
    ]);
    const started = results.find(result => 'runId' in result);
    expect(started, JSON.stringify(results)).toMatchObject({ runId: expect.stringMatching(/^run_/) });
    expect(results.filter(result => 'errorCode' in result)).toEqual([
      expect.objectContaining({ ok: false, errorCode: 'execution_run_budget_exceeded' }),
    ]);
    if (!started || !('runId' in started)) throw new Error('Missing admitted Run');
    await expect(client.call(SESSION_RPC_METHODS.EXECUTION_RUN_STOP, { runId: started.runId }))
      .resolves.toMatchObject({ ok: true });
    await expect(client.call(SESSION_RPC_METHODS.EXECUTION_RUN_START, { ...request, intent: 'delegate' }))
      .resolves.toMatchObject({ runId: expect.stringMatching(/^run_/) });
  });

  it('does not enforce a fallback concurrent-run cap when maxConcurrentRuns is unset', async () => {
    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: () => createDelayedBackend(JSON.stringify({ findings: [], summary: 'late' }), 50_000),
          sendAcp: async () => {},
          policy: { maxConcurrentRuns: null as number | null, boundedTimeoutMs: null as number | null },
        });
      },
    });

    const first = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'review',
      modelSelection: null,
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Review.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });
    expect(first.runId).toMatch(/^run_/);

    const second = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'review',
      modelSelection: null,
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Review again.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });

    expect(second.runId).toMatch(/^run_/);
  });

  it('uses centralized configuration defaults when no explicit policy override is provided', async () => {
    const previousMaxConcurrentRuns = process.env.HAPPIER_EXECUTION_RUNS_MAX_CONCURRENT_PER_SESSION;
    process.env.HAPPIER_EXECUTION_RUNS_MAX_CONCURRENT_PER_SESSION = '1';
    reloadConfiguration();

    try {
      const client = createEncryptedRpcTestClient({
        scopePrefix: 'sess_1',
        registerHandlers: (rpc) => {
          registerExecutionRunHandlers(rpc, {
            sessionId: 'sess_1',
            cwd: process.cwd(),
            parentProvider: 'claude',
            createBackend: () => createDelayedBackend(JSON.stringify({ findings: [], summary: 'late' }), 50_000),
            sendAcp: async () => {},
          });
        },
      });

      const first = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
        intent: 'review',
        modelSelection: null,
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        instructions: 'Review.',
        permissionMode: 'read_only',
        retentionPolicy: 'ephemeral',
        runClass: 'bounded',
        ioMode: 'request_response',
      });
      expect(first.runId).toMatch(/^run_/);

      const second = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
        intent: 'review',
        modelSelection: null,
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        instructions: 'Review again.',
        permissionMode: 'read_only',
        retentionPolicy: 'ephemeral',
        runClass: 'bounded',
        ioMode: 'request_response',
      });

      expect(second.ok).toBe(false);
      expect(second.errorCode).toBe('execution_run_budget_exceeded');
    } finally {
      if (previousMaxConcurrentRuns === undefined) delete process.env.HAPPIER_EXECUTION_RUNS_MAX_CONCURRENT_PER_SESSION;
      else process.env.HAPPIER_EXECUTION_RUNS_MAX_CONCURRENT_PER_SESSION = previousMaxConcurrentRuns;
      reloadConfiguration();
    }
  });

  it('enforces per-intent budget caps when a budget registry is provided', async () => {
    const budgetRegistry = new ExecutionBudgetRegistry({
      maxConcurrentExecutionRuns: 10,
      maxConcurrentOneShotTasks: 10,
      maxConcurrentByClass: { review: 1 },
    });

    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: () => createDelayedBackend(JSON.stringify({ findings: [], summary: 'late' }), 50_000),
          sendAcp: async () => {},
          policy: { maxConcurrentRuns: 50, boundedTimeoutMs: 60_000 },
          budgetRegistry,
        });
      },
    });

    const first = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'review',
      modelSelection: null,
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Review.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });
    expect(first.runId).toMatch(/^run_/);

    const second = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'review',
      modelSelection: null,
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Review again.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });
    expect(second.ok).toBe(false);
    expect(second.errorCode).toBe('execution_run_budget_exceeded');

    const plan = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'plan',
      modelSelection: null,
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Plan.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });
    expect(plan.runId).toMatch(/^run_/);
  });

  it('does not impose a second depth limit on a human run from raw parent references', async () => {
    const sent: Array<{ body: ACPMessageData; meta?: Record<string, unknown> }> = [];

    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: () =>
            createStaticBackend(
              JSON.stringify({
                findings: [],
                summary: 'Summary.',
              }),
            ),
          sendAcp: async (_provider: string, body: ACPMessageData, opts?: { meta?: Record<string, unknown> }) => {
            sent.push({ body, meta: opts?.meta });
          },
        });
      },
    });

    const parent = await client.call<ExecutionRunStartResponse, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'review',
      modelSelection: null,
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Review.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });

    const child = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'review',
      modelSelection: null,
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Nested review.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
      parentRunId: parent.runId,
    });

    expect(child.runId).toMatch(/^run_/);
  });

  it('times out bounded execution runs deterministically when boundedTimeoutMs elapses', async () => {
    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: () => createDelayedBackend(JSON.stringify({ findings: [], summary: 'late' }), 50_000),
          sendAcp: async () => {},
          policy: { maxConcurrentRuns: 5, boundedTimeoutMs: 10 },
        });
      },
    });

    const started = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'review',
      modelSelection: null,
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Review.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });

    await expect
      .poll(async () => {
        const got = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_GET, { runId: started.runId });
        return {
          runStatus: got.run?.status,
          toolResultStatus: got.latestToolResult?.status,
        };
      }, { timeout: 1_000 })
      .toEqual({
        runStatus: 'timeout',
        toolResultStatus: 'timeout',
      });
  });

  it('uses the review-specific bounded timeout for review runs when provided by policy', async () => {
    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      registerHandlers: (rpc) => {
        const policy = {
          maxConcurrentRuns: 5,
          boundedTimeoutMs: 10,
          reviewBoundedTimeoutMs: 100,
        };
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: () => createDelayedBackend(JSON.stringify({ findings: [], summary: 'late' }), 30),
          sendAcp: async () => {},
          policy,
        });
      },
    });

    const started = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'review',
      modelSelection: null,
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Review.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });

    await expect.poll(async () => {
      const got = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_GET, { runId: started.runId });
      return { runStatus: got.run?.status, toolResultStatus: got.latestToolResult?.status };
    }).toEqual({ runStatus: 'succeeded', toolResultStatus: 'succeeded' });
  });

  it('requires coupled input when execution.run.ensure(resume=true) recovers a bounded run', async () => {
    const sent: Array<{ body: unknown; meta?: Record<string, unknown> }> = [];
    const createBackend = createResumableBackendFactory(JSON.stringify({ findings: [], summary: 'ok' }));

    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: () => createBackend(),
          sendAcp: async (_provider: string, body: ACPMessageData, opts?: { meta?: Record<string, unknown> }) => {
            sent.push({ body, meta: opts?.meta });
          },
          policy: { maxConcurrentRuns: 5, boundedTimeoutMs: 60_000 },
        });
      },
    });

    const started = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'review',
      modelSelection: null,
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Review.',
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'bounded',
      ioMode: 'request_response',
    });

    await expect.poll(() => sent.some((m) => (m.body as any)?.type === 'tool-result' && m.meta)).toBe(true);

    await expect.poll(async () => {
      const current = await client.call<ExecutionRunGetResponse, unknown>(SESSION_RPC_METHODS.EXECUTION_RUN_GET, { runId: started.runId });
      return current.run?.lifecycle.state;
    }).toBe('recoverable_with_input');

    const ensured = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE, {
      runId: started.runId,
      resume: true,
    });
    expect(ensured).toMatchObject({
      ok: false,
      errorCode: 'execution_run_input_required',
    });

    const got = await waitForExecutionRunTerminalState(client, started.runId);
    expect(got.run?.status).toBe('succeeded');
  });

  it('supports execution.run.ensureOrStart to start when runId is missing and ensure when present', async () => {
    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: () => createStaticBackend('reply'),
          sendAcp: async () => {},
          policy: { maxConcurrentRuns: 5, boundedTimeoutMs: 60_000 },
        });
      },
    });

    const first = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START, {
      runId: null,
      start: {
        intent: 'delegate',
        modelSelection: null,
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        instructions: 'Delegate.',
        permissionMode: 'read_only',
        retentionPolicy: 'ephemeral',
        runClass: 'long_lived',
        ioMode: 'request_response',
      },
    });
    expect(first.ok).toBe(true);
    expect(first.created).toBe(true);
    expect(typeof first.runId).toBe('string');

    const second = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START, {
      runId: first.runId,
      start: {
        intent: 'delegate',
        modelSelection: null,
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        instructions: 'ignored',
        permissionMode: 'read_only',
        retentionPolicy: 'ephemeral',
        runClass: 'long_lived',
        ioMode: 'request_response',
      },
    });
    expect(second.ok).toBe(true);
    expect(second.created).toBe(false);
    expect(second.runId).toBe(first.runId);
  });

  it('supports execution.run.start with resumeHandle when backend supports loadSession', async () => {
    const calls: { startSession: number; loadSession: string[] } = { startSession: 0, loadSession: [] };

    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: () => createTestExecutionRunHostRuntime({
            runtimeId: 'child_session_new',
            resumeSupported: true,
            onProvisionRuntime(opts) {
              if (opts?.resumeRuntimeId) {
                calls.loadSession.push(String(opts.resumeRuntimeId));
                return;
              }
              calls.startSession += 1;
            },
            onSendPrompt() {},
          }),
          sendAcp: async () => {},
          policy: { maxConcurrentRuns: 5, boundedTimeoutMs: 60_000 },
        });
      },
    });

    const started = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'delegate',
      modelSelection: null,
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'request_response',
      resumeHandle: { kind: 'provider_session.v1', backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, providerSessionId: 'vendor_1' },
    });
    expect(started.runId, JSON.stringify(started)).toMatch(/^run_/);
    expect(calls.loadSession).toEqual(['vendor_1']);
    expect(calls.startSession).toBe(0);
  });
});
