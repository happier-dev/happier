import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentMessage } from '@/agent/core/AgentMessage';
import type {
  ExecutionRunHostRuntime,
  ExecutionRunHostRuntimeMessageHandler,
} from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';
import { createTestExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/testkit';
import type { ACPMessageData } from '@/api/session/sessionMessageTypes';
import {
  createScmCapabilities,
  FeaturesResponseSchema,
  SCM_OPERATION_ERROR_CODES,
  type ActionId,
  type ActionExecutorDeps,
  type ApprovalRequestV1,
  type BackendTargetRefV1,
  type ExecutionRunPublicState,
  type ExecutionRunStartResponse,
  type TurnChangeSet,
} from '@happier-dev/protocol';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { createExecutionRunRpcApprovalDeps } from './executionRuns/createExecutionRunRpcApprovalDeps';
import type { Credentials } from '@/persistence';

import { createEncryptedRpcTestClient } from './encryptedRpc.testkit';
import { registerExecutionRunHandlers as registerExecutionRunHandlersBase } from './executionRuns';
import type { RpcActionExecutor } from './_actionDispatchAdapter';
import { buildExecutionRunProfileCatalog } from '@/agent/executionRuns/profiles/intentRegistry';
import { ExecutionBudgetRegistry } from '@/daemon/executionBudget/ExecutionBudgetRegistry';
import { reloadConfiguration } from '@/configuration';
import { runGit } from '@/scm/rpc/__tests__/testRpcHarness';
import { createScmBackendRegistry, type ScmBackendRegistry } from '@/scm/registry';
import type { ScmBackend, ScmRepoDetection } from '@/scm/types';

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

vi.mock('@/persistence', () => ({
  readCredentials: vi.fn(),
  readStoredCredentials: vi.fn(async () => null),
}));

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
    ...baseCtx,
    cwd,
    getServerFeaturesSnapshot: baseCtx.getServerFeaturesSnapshot ?? (() => voiceEnabledServerSnapshot),
    executionRunProfileCatalog: baseCtx.executionRunProfileCatalog ?? buildExecutionRunProfileCatalog(),
  });
};

beforeAll(() => {
  defaultExecutionRunTestCwd = mkdtempSync(join(tmpdir(), 'happier-execution-runs-default-workspace-'));
  runGit(defaultExecutionRunTestCwd, ['init', '--initial-branch=main']);
});

afterAll(() => {
  if (defaultExecutionRunTestCwd) {
    rmSync(defaultExecutionRunTestCwd, { recursive: true, force: true });
    defaultExecutionRunTestCwd = '';
  }
});

beforeEach(async () => {
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

function createStaticBackend(responseText: string): ExecutionRunHostRuntime {
  let runtime: ReturnType<typeof createTestExecutionRunHostRuntime>;
  runtime = createTestExecutionRunHostRuntime({
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
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const got = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_GET, {
      runId,
      includeStructured: true,
    });
    if (got?.run?.status && got.run.status !== 'running') {
      return got;
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('Execution run did not reach a terminal state');
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
    sessionId: 'child_session_stuck',
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

function createThrowingBackend(params: { throwAtSendCount: number; message: string }): ExecutionRunHostRuntime {
  let sendCount = 0;
  let runtime: ReturnType<typeof createTestExecutionRunHostRuntime>;
  runtime = createTestExecutionRunHostRuntime({
    onSendPrompt() {
      sendCount += 1;
      if (sendCount >= params.throwAtSendCount) {
        throw new Error(params.message);
      }
      runtime.emitMessage({ type: 'model-output', fullText: 'ok' } as AgentMessage);
    },
    onWaitForTurnCompletion() {},
  });
  return runtime;
}

function createResumableBackendFactory(responseText: string): () => ExecutionRunHostRuntime {
  return () => {
    let runtime: ReturnType<typeof createTestExecutionRunHostRuntime>;
    runtime = createTestExecutionRunHostRuntime({
      sessionId: 'child_session_resumable',
      resumeSupported: true,
      onSendPrompt() {
        runtime.emitMessage({ type: 'model-output', fullText: responseText } as AgentMessage);
      },
    });
    return runtime;
  };
}

function createSequencedBackend(params: {
  responses: ReadonlyArray<{ text: string; delayMs: number }>;
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

function createCancelRaceBackend(params: Readonly<{
  longDelayMs: number;
}>): { backend: ExecutionRunHostRuntime; events: { sendPrompts: string[]; cancelCount: number } } {
  const events = { sendPrompts: [] as string[], cancelCount: 0 };

  let timer: ReturnType<typeof setTimeout> | null = null;
  let done: Promise<void> | null = null;
  let resolveDone: (() => void) | null = null;
  let rejectDone: ((e: Error) => void) | null = null;
  let rejectNextSendPrompts = 0;

  let backend: ReturnType<typeof createTestExecutionRunHostRuntime>;
  backend = createTestExecutionRunHostRuntime({
    onSendPrompt(_sessionId, prompt) {
      events.sendPrompts.push(prompt);
      if (rejectNextSendPrompts > 0) {
        rejectNextSendPrompts -= 1;
        throw new Error('Turn cancelled');
      }

      done = new Promise((resolve, reject) => {
        resolveDone = resolve;
        rejectDone = reject;
        timer = setTimeout(() => {
          backend.emitMessage({ type: 'model-output', fullText: `reply:${prompt}` } as AgentMessage);
          resolve();
        }, params.longDelayMs);
      });
    },
    onCancel() {
      events.cancelCount += 1;
      rejectNextSendPrompts = 1;
      if (timer) clearTimeout(timer);
      rejectDone?.(new Error('Turn cancelled'));
    },
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
        });
      },
    });

    for (const [method, actionId] of executionRunRpcActionBindings) {
      const input = { marker: actionId };
      await expect(client.call<unknown, unknown>(method, input)).resolves.toEqual({ handledActionId: actionId });
    }

    expect(calls).toEqual(executionRunRpcActionBindings.map(([, actionId]) => ({
      actionId,
      input: { marker: actionId },
      context: {
        defaultSessionId: 'sess_1',
        signal: expect.any(AbortSignal),
        surface: 'rpc',
      },
    })));
  });

  it('keeps execution-run RPC method binding delegated to the generic action-spec registrar', () => {
    const source = readFileSync(
      new URL('./executionRuns/registerExecutionRunRpcHandlers.ts', import.meta.url),
      'utf8',
    );

    expect(source.match(/registerActionSpecRpcHandlers\(/g) ?? []).toHaveLength(1);
    expect(source).not.toContain('dispatchPublicAction(');
    expect(source).not.toContain('EXECUTION_RUN_RPC_METHODS');
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

  it('returns approved result-bearing execution-run RPC reads through blocking approval storage', async () => {
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
            cwd: process.cwd(),
            parentProvider: 'claude',
            createBackend: () => createStaticBackend('unused'),
            sendAcp: async () => {},
            actionApprovalDeps: {
              approvalsCreate,
              approvalsUpdate,
              approvalsWaitForDecision,
              approvalsResolveBlockingDecision,
            },
          });
        },
      });

      const listed = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_LIST, { limit: 1 });

      expect(listed).toEqual({ runs: [] });
      expect(approvalsCreate).toHaveBeenCalledOnce();
      expect(approvalsWaitForDecision).toHaveBeenCalledWith(expect.objectContaining({
        artifactId: 'approval_1',
        serverId: null,
      }));
      expect(approvalsUpdate).toHaveBeenCalledWith(expect.objectContaining({
        artifactId: 'approval_1',
        request: expect.objectContaining({
          status: 'executed',
          execution: expect.objectContaining({
            ok: true,
            result: { runs: [] },
          }),
        }),
      }));
    } finally {
      if (previousActionsSettings === undefined) {
        delete process.env.HAPPIER_ACTIONS_SETTINGS_V1;
      } else {
        process.env.HAPPIER_ACTIONS_SETTINGS_V1 = previousActionsSettings;
      }
    }
  });

  it('keeps execution-run RPC approved approval updates claimed by the explicit decision seam', async () => {
    const deps = createExecutionRunRpcApprovalDeps({
      readCredentials: async () => createApprovalCredentials(),
    });
    const pending = deps.approvalsWaitForDecision?.({
      artifactId: 'approval_execution_run_intermediate',
      request: createApprovalRequest(),
    });
    if (!pending || !deps.approvalsUpdate || !deps.approvalsResolveBlockingDecision) {
      throw new Error('expected execution-run approval deps');
    }

    const approvedRequest = createApprovalRequest({
      status: 'approved',
      updatedAtMs: 2,
      decision: { kind: 'approve', decidedAtMs: 2 },
    });
    await deps.approvalsUpdate({
      artifactId: 'approval_execution_run_intermediate',
      request: approvedRequest,
      serverId: null,
    });

    await expectPromisePending(pending);

    await expect(deps.approvalsResolveBlockingDecision({
      artifactId: 'approval_execution_run_intermediate',
      decision: 'approve',
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
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Review.',
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'bounded',
      ioMode: 'request_response',
    });
    expect(started.runId).toMatch(/^run_/);

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
	          },
	        });
	      },
	    });

    const started = await client.call<ExecutionRunStartResponse, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Review.',
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'bounded',
      ioMode: 'request_response',
    });

    expect(updates.some((run) => run.runId === started.runId && run.status === 'running')).toBe(true);

    let terminalStatus: string | null = null;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const got = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_GET, { runId: started.runId });
      if (got?.run?.status && got.run.status !== 'running') {
        terminalStatus = got.run.status;
        break;
      }
      await new Promise((r) => setTimeout(r, 5));
    }

    expect(terminalStatus).not.toBeNull();
    expect(updates.some((run) => run.runId === started.runId && run.status === terminalStatus)).toBe(true);
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
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Review.',
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'bounded',
      ioMode: 'request_response',
    });
    const succeeded = await client.call<ExecutionRunStartResponse, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'review',
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

  it('runs scm_diff_summary.v1 through execution.run.start and projects the buffered summary result', async () => {
    const capture = { lastPrompt: '' };
    const createdBackendOpts: Array<{ backendId: string; permissionMode: string; backendTarget?: unknown }> = [];
    const turnChangeSet: TurnChangeSet = {
      sessionId: 'sess_1',
      turnId: 'turn_1',
      seqRange: { startSeqInclusive: 1, endSeqInclusive: 2 },
      status: 'completed',
      files: [{
        filePath: 'src/a.ts',
        changeKind: 'modified',
        source: 'scm_checkpoint',
        confidence: 'exact',
        provider: 'codex',
        unifiedDiff: '@@ -1 +1 @@\n-old\n+new\n',
      }],
      provider: 'codex',
      derivedAt: 1,
      repositoryCheckpoint: {
        version: 1,
        scopeId: 'scope_1',
        baseRefSource: 'turn_start',
        contentConfidence: 'exact',
        attributionScope: 'shared_worktree',
        receipts: [{ id: 'checkpoint.diff_computed', ref: 'refs/happier/checkpoints/1' }],
      },
    };

    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: '/repo',
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
      backendTarget: {
        kind: 'backend',
        backendId: 'summary-bot',
        configuredBackendId: 'summary-bot',
        sourceKind: 'configured',
      },
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
      intentInput: {
        cwd: '/repo',
        source: { kind: 'turnCheckpoint' },
        turnId: 'turn_1',
        checkpointReceiptId: 'checkpoint.diff_computed',
        turnChangeSet,
      },
    });

    const got = await waitForExecutionRunTerminalState(client, started.runId);
    expect(got.run?.status).toBe('succeeded');
    expect(got.latestToolResult).toMatchObject({
      success: true,
      summaryMarkdown: '## Summary\n\nChanged src/a.ts.',
      sourceKey: 'turnCheckpoint:turn_1:checkpoint.diff_computed',
      checkpointReceiptId: 'checkpoint.diff_computed',
      metadata: {
        contentConfidence: 'exact',
        attributionScope: 'shared_worktree',
      },
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
        permissionMode: 'read_only',
      }),
    ]);
    expect(capture.lastPrompt).toContain('SCM diff summary generator.');
    expect(capture.lastPrompt).toContain('src/a.ts');
    expect(capture.lastPrompt).toContain('@@ -1 +1 @@');
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
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      permissionMode: 'workspace_write',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });

    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('execution_run_invalid_action_input');
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
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Review.',
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'bounded',
      ioMode: 'request_response',
    });
    const succeeded = await client.call<ExecutionRunStartResponse, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'review',
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
      backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
      instructions: 'Review.',
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'bounded',
      ioMode: 'request_response',
    });
    const succeeded = await client.call<ExecutionRunStartResponse, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'review',
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
        });
      },
    });

    const started = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'review',
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
    expect(got.run?.availableActionIds).toEqual(['review.triage', 'review.follow_up']);
    expect(got.structuredMeta?.kind).toBe('review_findings.v2');
    expect(got.structuredMeta?.payload?.runRef?.runId).toBe(started.runId);

    const acted = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_ACTION, {
      runId: started.runId,
      actionId: 'review.triage',
      input: {
        findings: [{ id: 'f1', status: 'accept' }],
      },
    });
    expect(acted.ok).toBe(true);

    // The action should re-emit a tool-result meta update.
    const metaToolResult = [...sent].reverse().find((m) => (m.body as any)?.type === 'tool-result' && m.meta);
    expect((metaToolResult?.meta as any)?.happier?.kind).toBe('review_findings.v2');
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

  it('supports execution.run.send for long-lived runs', async () => {
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
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'hello',
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'request_response',
    });

    expect(sent.filter((m: any) => m?.body?.type === 'message').length).toBe(1);

    const sentReply = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_SEND, {
      runId: started.runId,
      message: 'next',
    });
    expect(sentReply.ok).toBe(true);
    await expect
      .poll(() => sent.filter((m: any) => m?.body?.type === 'message').length, { timeout: 1_000 })
      .toBe(2);
  });

  it('returns execution_run_busy when delivery=prompt and a long-lived run already has a turn in flight', async () => {
    const sent: Array<{ body: unknown; meta?: Record<string, unknown> }> = [];
    const { backend, events } = createSequencedBackend({
      responses: [
        { text: 'start', delayMs: 0 },
        { text: 'reply', delayMs: 50 },
      ],
    });

    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: () => backend,
          sendAcp: async (_provider: string, body: ACPMessageData, opts?: { meta?: Record<string, unknown> }) => {
            sent.push({ body, meta: opts?.meta });
          },
        });
      },
    });

    const started = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Start.',
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'request_response',
    });

    // Long-lived runs execute their first turn asynchronously; wait a tick so subsequent send() calls
    // deterministically test in-flight behavior for a later turn.
    await new Promise((r) => setTimeout(r, 5));

    const p1 = client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_SEND, {
      runId: started.runId,
      message: 'first',
      delivery: 'prompt',
    });
    await new Promise((r) => setTimeout(r, 5));

    const p2 = client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_SEND, {
      runId: started.runId,
      message: 'second',
      delivery: 'prompt',
    });

    const busy = await p2;
    expect(busy.ok).toBe(false);
    expect(busy.errorCode).toBe('execution_run_busy');

    await p1;
    expect(events.sendPrompts.length).toBeGreaterThanOrEqual(2);
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

  it('does not terminalize long-lived runs when sendPrompt fails with an abort-like error', async () => {
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
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Start.',
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'request_response',
    });

    await new Promise((r) => setTimeout(r, 15));

    const sent = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_SEND, {
      runId: started.runId,
      message: 'hi',
      delivery: 'prompt',
    });
    expect(sent.ok).toBe(false);

    const got = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_GET, { runId: started.runId });
    expect(got.run?.status).toBe('running');
    expect(got.run?.error).toBeUndefined();
  });

  it('steers an in-flight long-lived run when delivery=steer_if_supported and backend supports sendSteerPrompt', async () => {
    const { backend, events } = createSequencedBackend({
      responses: [
        { text: 'start', delayMs: 0 },
        { text: 'reply', delayMs: 50 },
      ],
      supportsSteer: true,
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
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Start.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'long_lived',
      ioMode: 'request_response',
    });

    await new Promise((r) => setTimeout(r, 5));

    const p1 = client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_SEND, {
      runId: started.runId,
      message: 'first',
      delivery: 'prompt',
    });
    await new Promise((r) => setTimeout(r, 5));

    const steered = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_SEND, {
      runId: started.runId,
      message: 'steer text',
      delivery: 'steer_if_supported',
    });
    expect(steered.ok).toBe(true);
    expect(events.steerPrompts).toEqual(['steer text']);

    await p1;
  });

  it('interrupts an in-flight long-lived run when delivery=interrupt by cancelling then sending a new prompt', async () => {
    const { backend, events } = createSequencedBackend({
      responses: [
        { text: 'start', delayMs: 0 },
        { text: 'reply', delayMs: 50 },
        { text: 'after', delayMs: 0 },
      ],
      supportsSteer: false,
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
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Start.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'long_lived',
      ioMode: 'request_response',
    });

    await new Promise((r) => setTimeout(r, 5));

    const p1 = client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_SEND, {
      runId: started.runId,
      message: 'first',
      delivery: 'prompt',
    });
    await new Promise((r) => setTimeout(r, 5));

    const interrupted = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_SEND, {
      runId: started.runId,
      message: 'second',
      delivery: 'interrupt',
    });
    expect(interrupted.ok).toBe(true);
    expect(events.cancelCount).toBe(1);
    expect(events.sendPrompts.some((p) => p === 'second')).toBe(true);

    await p1;
  });

	  it('retries cancel+send when the backend transiently rejects the next prompt after cancel', async () => {
	    const { backend, events } = createCancelRaceBackend({ longDelayMs: 200 });

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
	      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
	      instructions: 'Start.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'long_lived',
	      ioMode: 'request_response',
	    });

	    // Wait until the initial prompt is actually in-flight before issuing an interrupt.
	    // Under high CI load, a fixed sleep can race and cause the interrupt path to be exercised without a cancel.
	    for (let attempt = 0; attempt < 200; attempt += 1) {
	      if (events.sendPrompts.length > 0) break;
	      await new Promise((r) => setTimeout(r, 5));
	    }
	    expect(events.sendPrompts.length).toBeGreaterThan(0);

	    const interrupted = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_SEND, {
	      runId: started.runId,
	      message: 'second',
      delivery: 'interrupt',
    });
	    expect(interrupted.ok).toBe(true);
	    expect(events.cancelCount).toBe(1);

	    for (let attempt = 0; attempt < 200; attempt += 1) {
	      if (events.sendPrompts.some((p) => p === 'second')) break;
	      await new Promise((r) => setTimeout(r, 5));
	    }

	    const got = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_GET, { runId: started.runId });
	    expect(got.run?.status).toBe('running');
	    expect(events.sendPrompts.some((p) => p === 'second')).toBe(true);
	  });

  it('does not terminalize long-lived runs when multiple in-flight turns are cancelled for steering', async () => {
    const { backend } = createSequencedBackend({
      responses: [
        // Start turn: long enough that the first send interrupts it.
        { text: 'start', delayMs: 50 },
        // First user send: long enough that the second send interrupts it.
        { text: 'first', delayMs: 50 },
        // Second user send: completes quickly.
        { text: 'second', delayMs: 0 },
      ],
      supportsSteer: false,
      cancelRejects: true,
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
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Start.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'long_lived',
      ioMode: 'request_response',
    });

    await new Promise((r) => setTimeout(r, 5));

    const first = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_SEND, {
      runId: started.runId,
      message: 'first',
      delivery: 'interrupt',
    });
    expect(first.ok).toBe(true);

    await new Promise((r) => setTimeout(r, 5));

    const second = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_SEND, {
      runId: started.runId,
      message: 'second',
      delivery: 'interrupt',
    });
    expect(second.ok).toBe(true);

    await new Promise((r) => setTimeout(r, 75));

    const got = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_GET, { runId: started.runId });
    expect(got.run?.status).toBe('running');
    expect(got.run?.error).toBeUndefined();
  });

  it('supports steering bounded runs while running (cancel+send fallback when steer is unavailable)', async () => {
    const sent: Array<{ body: unknown; meta?: Record<string, unknown> }> = [];
    const { backend, events } = createSequencedBackend({
      responses: [
        // Initial bounded prompt output (will be cancelled before it emits)
        { text: JSON.stringify({ findings: [], summary: 'initial' }), delayMs: 50 },
        // After interrupt, emit valid output
        { text: JSON.stringify({ findings: [], summary: 'after' }), delayMs: 0 },
      ],
      supportsSteer: false,
    });

    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: () => backend,
          sendAcp: async (_provider: string, body: ACPMessageData, opts?: { meta?: Record<string, unknown> }) => {
            sent.push({ body, meta: opts?.meta });
          },
        });
      },
    });

    const started = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Review.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });

    await new Promise((r) => setTimeout(r, 5));

    const steered = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_SEND, {
      runId: started.runId,
      message: 'please focus on X',
      delivery: 'steer_if_supported',
    });
    expect(steered.ok).toBe(true);
    expect(events.cancelCount).toBe(1);

    // Wait for bounded completion.
    await new Promise((r) => setTimeout(r, 30));
    const got = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_GET, { runId: started.runId });
    expect(got.run?.status).toBe('succeeded');
    expect(got.latestToolResult?.summary).toBe('after');
  });

  it('acks bounded external sends once the replacement turn is adopted, even if the backend never completes it', async () => {
    const previousAckTimeout = process.env.HAPPIER_EXECUTION_RUN_BOUNDED_SEND_ACK_TIMEOUT_MS;
    process.env.HAPPIER_EXECUTION_RUN_BOUNDED_SEND_ACK_TIMEOUT_MS = '20';
    try {
      const client = createEncryptedRpcTestClient({
        scopePrefix: 'sess_1',
        registerHandlers: (rpc) => {
          registerExecutionRunHandlers(rpc, {
            sessionId: 'sess_1',
            cwd: process.cwd(),
            parentProvider: 'claude',
            createBackend: () => createNeverResolvingBackend(),
            sendAcp: async () => {},
          });
        },
      });

      const started = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
        intent: 'review',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        instructions: 'Review.',
        permissionMode: 'read_only',
        retentionPolicy: 'ephemeral',
        runClass: 'bounded',
        ioMode: 'request_response',
      });

      await new Promise((r) => setTimeout(r, 5));

      const sendResult = await Promise.race([
        client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_SEND, {
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
    } finally {
      if (previousAckTimeout === undefined) {
        delete process.env.HAPPIER_EXECUTION_RUN_BOUNDED_SEND_ACK_TIMEOUT_MS;
      } else {
        process.env.HAPPIER_EXECUTION_RUN_BOUNDED_SEND_ACK_TIMEOUT_MS = previousAckTimeout;
      }
    }
  });

  it('rejects bounded run sends after completion', async () => {
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
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Review.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });

    await new Promise((r) => setTimeout(r, 10));

    const res = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_SEND, {
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
    expect(started.runId).toMatch(/^run_/);
    // Start should propagate the chat model ID to the voice agent backend.
    expect(createdBackends.map((b) => b.modelId)).toEqual(expect.arrayContaining(['chat']));

    const streamStart = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START, {
      runId: started.runId,
      message: 'Hi',
    });
    expect(streamStart.streamId).toMatch(/^stream_/);

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
    const { readCredentials } = await import('@/persistence');
    const { fetchSessionById } = await import('@/session/transport/http/sessionsHttp');
    const { fetchEncryptedTranscriptMessages } = await import('@/session/replay/fetchEncryptedTranscriptMessages');
    vi.mocked(readCredentials).mockResolvedValue({
      token: 'token_1',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
    } as any);
    vi.mocked(fetchSessionById).mockResolvedValue({
      id: 'sys_voice',
      seq: 3,
      encryptionMode: 'plain',
      metadata: JSON.stringify({ path: '/repo', flavor: 'claude' }),
      dataEncryptionKey: null,
    } as any);
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

    await client.call(SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START, {
      runId: started.runId,
      message: 'continue',
    });

    expect(events.sendPrompts[0]).toContain('Cached replay summary');
    expect(events.sendPrompts[0]).toContain('Old assistant turn');
  });

  it('falls back to on-demand replay summaries for voice runs when no cached synopsis exists', async () => {
    const { readCredentials } = await import('@/persistence');
    const { fetchSessionById } = await import('@/session/transport/http/sessionsHttp');
    const { fetchEncryptedTranscriptMessages } = await import('@/session/replay/fetchEncryptedTranscriptMessages');
    const { runReplaySummaryForDialog } = await import('@/session/replay/summary/runReplaySummaryForDialog');
    vi.mocked(readCredentials).mockResolvedValue({
      token: 'token_1',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
    } as any);
    vi.mocked(fetchSessionById).mockResolvedValue({
      id: 'sys_voice',
      seq: 2,
      encryptionMode: 'plain',
      metadata: JSON.stringify({ path: '/repo', flavor: 'claude' }),
      dataEncryptionKey: null,
    } as any);
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

    await client.call(SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START, {
      runId: started.runId,
      message: 'continue',
    });

    expect(vi.mocked(runReplaySummaryForDialog)).toHaveBeenCalledTimes(1);
    expect(events.sendPrompts[0]).toContain('Generated replay summary');
    expect(events.sendPrompts[0]).toContain('Assistant answered previously');
  });

  it('defers replay seed delivery to the first turn when voice prewarm uses a READY handshake', async () => {
    const { readCredentials } = await import('@/persistence');
    const { fetchSessionById } = await import('@/session/transport/http/sessionsHttp');
    const { fetchEncryptedTranscriptMessages } = await import('@/session/replay/fetchEncryptedTranscriptMessages');
    vi.mocked(readCredentials).mockResolvedValue({
      token: 'token_1',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
    } as any);
    vi.mocked(fetchSessionById).mockResolvedValue({
      id: 'sys_voice',
      seq: 3,
      encryptionMode: 'plain',
      metadata: JSON.stringify({ path: '/repo', flavor: 'claude' }),
      dataEncryptionKey: null,
    } as any);
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

    await client.call(SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START, {
      runId: started.runId,
      message: 'continue',
    });

    expect(events.sendPrompts[1]).toContain('Cached replay summary');
    expect(events.sendPrompts[1]).toContain('Old assistant turn');
  });

  it('commits persistent voice_agent transcript turns durably via the transcript port', async () => {
    const committedUserTurns: Array<{ text: string; meta: Record<string, unknown> }> = [];
    const committedAssistantTurns: Array<{ text: string; meta: Record<string, unknown> }> = [];

    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
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
    expect(started.runId).toEqual(expect.any(String));

    const streamStart = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START, {
      runId: started.runId,
      message: 'Persist this user turn',
      displayMessage: 'Persist only this clean user turn',
    });
    expect(streamStart.streamId).toEqual(expect.any(String));
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

    expect(streamStart.streamId).toEqual(expect.any(String));
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

    await expect(client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_READ, {
      runId: started.runId,
      streamId: streamStart.streamId,
      cursor: 0,
      maxEvents: 128,
    })).resolves.toMatchObject({ done: true });
  });

  it('normalizes the prospective predecessor transcript commit vector once at the RPC seam', async () => {
    const committedUserTurns: Array<Readonly<{ text: string; localId: string }>> = [];
    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
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
    expect(started.runId).toEqual(expect.any(String));

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

  it('supports voice_agent stream resume via execution.run.stream.start(resume=true) after stop when backend supports loadSession', async () => {
    const createBackend = createResumableBackendFactory(
      `Hello.\n\n<voice_actions>${JSON.stringify({ actions: [{ t: 'sendSessionMessage', args: { message: 'hi' } }] })}</voice_actions>`,
    );

    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
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
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: ({ modelId }) => {
            const modelKey = modelId === 'commit' ? 'commit' : 'chat';
            let runtime: ReturnType<typeof createTestExecutionRunHostRuntime>;
            runtime = createTestExecutionRunHostRuntime({
              sessionId: modelKey === 'commit' ? 'commit_session_1' : 'chat_session_1',
              resumeSupported: true,
              onProvisionSession(opts) {
                if (opts?.resumeSessionId) {
                  loadCalls[modelKey].push(String(opts.resumeSessionId));
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
    expect(beforeStop?.run?.resumeHandle?.kind).toBe('voice_agent_sessions.v1');

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
    expect(loadCalls.chat).toEqual(['chat_session_1']);
    expect(loadCalls.commit).toEqual(['commit_session_1']);
  });

  it('fails closed for long-lived resumable runs via execution.run.send(resume=true) when backend lacks loadSessionWithReplayCapture', async () => {
    const createBackend = createResumableBackendFactory('reply');

    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
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
      intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Start.',
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'request_response',
    });

    const stopped = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_STOP, { runId: started.runId });
    expect(stopped.ok).toBe(true);

    const resumed = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_SEND, {
      runId: started.runId,
      message: 'after',
      resume: true,
    });
    expect(resumed.ok).toBe(false);
    expect(resumed.errorCode).toBe('execution_run_not_allowed');
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

  it('returns ok:false VOICE_AGENT_UNSUPPORTED when starting a voice_agent run with an unsupported backend', async () => {
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
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'streaming',
    });

    expect(started?.ok).toBe(false);
    expect(started?.errorCode).toBe('VOICE_AGENT_UNSUPPORTED');
    expect(String(started?.error ?? '')).toContain('codex');
  });

  it('returns ok:false VOICE_AGENT_UNSUPPORTED when starting a voice_agent run and backend initialization fails (claude)', async () => {
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
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'streaming',
    });

    expect(started?.ok).toBe(false);
    expect(started?.errorCode).toBe('VOICE_AGENT_UNSUPPORTED');
    expect(String(started?.error ?? '')).toContain('claude');
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
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: ({ modelId }) => createStaticBackend(modelId === 'commit' ? 'COMMIT_TEXT' : 'Hello.'),
          sendAcp: async () => {},
        });
      },
    });

    const started = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'voice_agent',
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
    expect(got?.run?.availableActionIds).toEqual(['voice_agent.welcome', 'voice_agent.commit']);
    expect(got?.run?.resumeHandle?.kind).toBe('voice_agent_sessions.v1');
  });

  it('returns voice_agent.welcome results via execution.run.action', async () => {
    const onExecutionRunVoiceAgentWelcomed = vi.fn();
    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
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

  it('releases execution budgets when voice_agent start fails', async () => {
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
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'streaming',
    });
    expect(first?.ok).toBe(false);
    expect(first?.errorCode).toBe('VOICE_AGENT_UNSUPPORTED');

    const second = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'voice_agent',
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

  it('returns canonical execution_run_failed when execution.run.send fails mid-run', async () => {
    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: () => createThrowingBackend({ throwAtSendCount: 2, message: 'boom' }),
          sendAcp: async () => {},
        });
      },
    });

    const started = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'hello',
      permissionMode: 'default',
      retentionPolicy: 'ephemeral',
      runClass: 'long_lived',
      ioMode: 'request_response',
    });

    const res = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_SEND, {
      runId: started.runId,
      message: 'next',
    });
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('execution_run_failed');
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
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'long_lived',
      ioMode: 'streaming',
    });

    expect(started).toMatchObject({
      ok: false,
      errorCode: 'execution_run_not_allowed',
      error: 'Unsupported retentionPolicy',
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
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Review.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'streaming',
    });

    expect(started.runId).toMatch(/^run_/);
    expect(started.callId).toMatch(/^subagent_run_/);
    expect(started.sidechainId).toBe(started.callId);
  });

  it('returns execution_run_budget_exceeded when max concurrent runs is reached', async () => {
    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: () => createDelayedBackend(JSON.stringify({ findings: [], summary: 'late' }), 50_000),
          sendAcp: async () => {},
          policy: { maxConcurrentRuns: 1, boundedTimeoutMs: 60_000 },
        });
      },
    });

    const first = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'review',
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
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Review again.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });

    expect(second.ok).toBe(false);
    expect(second.errorCode).toBe('execution_run_budget_exceeded');
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
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Plan.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });
    expect(plan.runId).toMatch(/^run_/);
  });

  it('returns run_depth_exceeded when maxDepth is exceeded via parentRunId nesting', async () => {
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
          policy: {
            maxDepth: 0,
          },
        });
      },
    });

    const parent = await client.call<ExecutionRunStartResponse, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Review.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });

    const child = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Nested review.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
      parentRunId: parent.runId,
    });

    expect(child.ok).toBe(false);
    expect(child.errorCode).toBe('run_depth_exceeded');
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
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Review.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });

    await new Promise((r) => setTimeout(r, 50));

    const got = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_GET, { runId: started.runId });
    expect(got.run?.status).toBe('succeeded');
    expect(got.latestToolResult?.status).toBe('succeeded');
  });

  it('enforces maxTurns for long-lived runs deterministically', async () => {
    const client = createEncryptedRpcTestClient({
      scopePrefix: 'sess_1',
      registerHandlers: (rpc) => {
        registerExecutionRunHandlers(rpc, {
          sessionId: 'sess_1',
          cwd: process.cwd(),
          parentProvider: 'claude',
          createBackend: () => createStaticBackend('reply'),
          sendAcp: async () => {},
          policy: { maxConcurrentRuns: 5, boundedTimeoutMs: 60_000, maxTurns: 1 },
        });
      },
    });

    const started = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
      intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'hello',
      permissionMode: 'default',
      retentionPolicy: 'ephemeral',
      runClass: 'long_lived',
      ioMode: 'request_response',
    });

    const sentReply = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_SEND, {
      runId: started.runId,
      message: 'next',
    });

    expect(sentReply.ok).toBe(false);
    expect(sentReply.errorCode).toBe('execution_run_not_allowed');
  });

  it('supports resumable bounded runs via execution.run.send(resume=true) when backend supports loadSession', async () => {
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
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Review.',
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'bounded',
      ioMode: 'request_response',
    });

    await new Promise((r) => setTimeout(r, 10));
    const completionToolResult = sent.find((m: any) => (m.body as any)?.type === 'tool-result' && m.meta);
    expect((completionToolResult?.meta as any)?.happierExecutionRun?.resumeHandle?.kind).toBe('provider_session.v1');
    expect((completionToolResult?.meta as any)?.happierExecutionRun?.resumeHandle?.providerSessionId).toBeTruthy();

    const resumed = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_SEND, {
      runId: started.runId,
      message: 'follow-up',
      resume: true,
    });
    expect(resumed.ok).toBe(true);
    await expect
      .poll(() => sent.filter((m: any) => (m.body as any)?.type === 'message').length, { timeout: 3_000 })
      .toBeGreaterThanOrEqual(2);
  });

  it('supports execution.run.ensure(resume=true) for resumable runs', async () => {
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
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Review.',
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'bounded',
      ioMode: 'request_response',
    });

    await new Promise((r) => setTimeout(r, 10));

    const ensured = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE, {
      runId: started.runId,
      resume: true,
    });
    expect(ensured.ok).toBe(true);

    const got = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_GET, { runId: started.runId });
    expect(got.run?.status).toBe('running');
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
            sessionId: 'child_session_new',
            resumeSupported: true,
            onProvisionSession(opts) {
              if (opts?.resumeSessionId) {
                calls.loadSession.push(String(opts.resumeSessionId));
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
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'request_response',
      resumeHandle: { kind: 'provider_session.v1', backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, providerSessionId: 'vendor_1' },
    });
    expect(started.runId).toMatch(/^run_/);
    expect(calls.loadSession).toEqual(['vendor_1']);
    expect(calls.startSession).toBe(0);
  });
});
