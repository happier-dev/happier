import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { getAgentStaticModels } from '@happier-dev/agents';
import { ScmComparisonSchema } from '@happier-dev/protocol/scm/comparison';

import type { ACPMessageData } from '@/api/session/sessionMessageTypes';
import type { ExecutionRunController } from '@/agent/executionRuns/controllers/types';
import {
  createTestExecutionRunHostRuntime,
  type TestExecutionRunHostRuntime,
} from '@/agent/runtime/bridges/executionRun/testkit';
import { executeBoundedBackendRun } from './bounded/loop';
import { startExecutionRun } from './startExecutionRun';
import { stopExecutionRun } from './executionRunStop';
import { sendBackendLongLivedRun } from './send/backendLongLivedPrompt';
import type { ExecutionRunState } from './executionRunTypes';
import type { ExecutionRunStructuredMeta } from '@/agent/executionRuns/profiles/ExecutionRunIntentProfile';
import { VoiceAgentManager } from '@/agent/voice/agent/VoiceAgentManager';
import { ExecutionBudgetRegistry } from '@/daemon/executionBudget/ExecutionBudgetRegistry';
import { accountSettingsParse, BUILT_IN_ROLES_V1, resolveRoleSelectionV1 } from '@happier-dev/protocol';
import { TaskProfile } from '@/agent/executionRuns/profiles/task/TaskProfile';
import { projectRetainedExecutionRunState, projectExecutionRunHostLoss } from './retainedState';
import { projectExecutionRunPublicState } from './publicState';
import { resumeBackendControllerForResumableRun } from './resumeBackendController';
import { createLocalScmRepositoryFixture } from '@/scm/contracts/scmBackendContractFixtures';
import { removeTempDir } from '@/testkit/fs/tempDir';
import { scmDiffSummaryResultStore } from '@/agent/executionRuns/tasks/scmDiffSummary/results/resultStore';
import { ScmDiffSummaryProfile } from './kinds/scmDiffSummary/ScmDiffSummaryProfile';
import { clearActiveAccountSettingsSnapshot, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { reloadConfiguration } from '@/configuration';
import { listExecutionRunMarkers } from '@/daemon/executionRunRegistry';
import { finishExecutionRun } from './finishExecutionRun';

const TEST_BACKEND_ID = `${'summary'}.${'backend'}` as never;

const SUPPORTED_WORKTREE_SCOPE = {
  kind: 'review_scm_scope.v1',
  status: 'supported',
  scmBackendId: 'git',
  scmMode: 'worktree',
  repositoryRoot: '/repo',
  worktreeRoot: '/repo',
  baseRef: { source: 'default_branch', ref: 'main' },
  selectedPaths: [],
  committedPaths: [],
  uncommittedPaths: [],
  changedPaths: [],
  diff: { committedAvailable: true, uncommittedAvailable: true },
  diagnostics: [],
} as const;

const SELECTED_PULL_REQUEST_REVIEW_SCOPE = {
  kind: 'scm_pull_request_review_scope.v1',
  account: {
    service: { pluginId: 'happier.scm-github', localId: 'github' },
    accountId: 'account-7',
  },
  pullRequest: { number: 42 },
  observed: {
    baseSha: '1111111111111111111111111111111111111111',
    headSha: '2222222222222222222222222222222222222222',
    nativeRevision: 'PR_kwDOABCD',
    observedAtMs: 1_700_000_000_000,
  },
} as const;
type StartExecutionRunArgs = Parameters<typeof startExecutionRun>[0];

function readOfferedSummaryModelId(): string {
  const model = getAgentStaticModels('claude', { catalogOnly: true })[0];
  if (!model) throw new Error('The native Claude offered-model catalog is unavailable');
  return model.id;
}

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const { createBundledPluginPublicationFsFixture } = await import('@/plugins/projection/registry/builtIn/locators.testkit');
  return createBundledPluginPublicationFsFixture(actual);
});

type AcpCommittedMessage = {
  body: Extract<ACPMessageData, { type: 'message' }>;
  localId: string;
  meta?: Record<string, unknown>;
};

function isAcpCommittedMessage(row: {
  body: ACPMessageData;
  localId: string;
  meta?: Record<string, unknown>;
}): row is AcpCommittedMessage {
  return row.body.type === 'message';
}

function createScmDiffSummaryStreamingRuntime(): TestExecutionRunHostRuntime {
  let runtime: TestExecutionRunHostRuntime;
  const finalJson = JSON.stringify({
    summaryMarkdown: '## Summary\n\nChanged src/a.ts.',
    risks: ['Shared worktree attribution.'],
    testImpact: 'Unit tests.',
  });

  runtime = createTestExecutionRunHostRuntime({
    onSendPrompt: async () => {
      runtime.emitMessage({ type: 'model-output', fullText: 'Inspecting checkpoint diff evidence...\n' });
      runtime.emitMessage({ type: 'model-output', fullText: finalJson });
    },
    onWaitForTurnCompletion: async () => {},
  });
  return runtime;
}

function createProvisioningRuntime(): TestExecutionRunHostRuntime {
  return createTestExecutionRunHostRuntime({
    onSendPrompt: async () => {},
    onWaitForTurnCompletion: async () => {},
  });
}

function publishEmptyAccountRoleOverrides(): void {
  setActiveAccountSettingsSnapshot({
    scopeKey: 'start-execution-run-role-fixture', source: 'network',
    settings: accountSettingsParse({}), rawSettings: {}, settingsVersion: 1, loadedAtMs: 1,
    settingsSecretsReadKeys: [],
    promptLibraryCatalog: {
      status: 'ready', tombstones: [], diagnostics: [],
      rows: [{ revision: 1, record: { key: 'role-overrides', value: { v: 1, overrides: {} } } }],
    },
  });
}

describe('startExecutionRun', () => {
  beforeEach(() => {
    vi.stubEnv('HAPPIER_CLAUDE_PATH', process.execPath);
    vi.stubEnv('HAPPIER_CLAUDE_DYNAMIC_MODEL_PROBE_ENABLED', '0');
  });
  afterEach(() => vi.unstubAllEnvs());
  it('refuses unsupported inherited Team Voice custody before publishing a Run', async () => {
    const runs = new Map<string, ExecutionRunState>();
    const controllers = new Map<string, ExecutionRunController>();
    const createRuntime = () => createProvisioningRuntime();
    const voiceAgentManager = new VoiceAgentManager({ createRuntime });
    try {
      await expect(startExecutionRun({
        params: { sessionId: 'parent_session_1', intent: 'voice_agent', backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
          permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming' },
        childSelectionContext: { lifecycle: 'attached', readAppliedParentSelection: () => ({
          status: 'applied', backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, modelId: 'team-model', connectedServices: null,
          teamCredentialModel: { kind: 'team_credential_provider_model', resourceId: 'resource', teamId: 'team',
            expectedResourceRevision: 2, agentTargetKey: 'agent:happier.agent.codex/codex', modelId: 'team-model', deliveryMode: 'brokered' },
        }) },
        parentProvider: 'codex', sendAcp: async () => {}, streamedTranscriptSession: null, createRuntime,
        getNowMs: () => 1, budgetRegistry: null, runs, controllers, enqueueMarkerWrite: async () => {},
        writeActivityMarker: async () => {}, finishRun: async () => {}, executeBoundedRun: async () => {},
        send: async () => ({ ok: true }), voiceAgentManager,
      })).rejects.toMatchObject({ code: 'execution_run_child_choice_required' });
      expect(runs.size).toBe(0);
    } finally { await voiceAgentManager.dispose(); }
  });
  it('admits an attached child from applied parent route and retains it independently of later parent changes', async () => {
    const markerDirectory = await mkdtemp(join(tmpdir(), 'happier-child-summary-'));
    vi.stubEnv('HAPPIER_HOME_DIR', markerDirectory);
    reloadConfiguration();
    const runs = new Map<string, ExecutionRunState>();
    const controllers = new Map<string, ExecutionRunController>();
    const createRuntime = () => createProvisioningRuntime();
    const voiceAgentManager = new VoiceAgentManager({ createRuntime });
    const applied = {
      status: 'applied' as const,
      backendTarget: { kind: 'builtInAgent' as const, agentId: 'claude' },
      modelId: 'parent-model',
      modelSelection: { agentTargetKey: 'agent:happier.agent.claude/claude', providerConnectionId: 'parent-provider', modelId: 'parent-model' },
      connectedServices: null,
    };
    try {
      const started = await startExecutionRun({
        params: { sessionId: 'parent_session_1', intent: 'delegate', backendTarget: applied.backendTarget,
          permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'bounded', ioMode: 'request_response' },
        childSelectionContext: { lifecycle: 'attached', readAppliedParentSelection: () => applied },
        parentProvider: 'claude', sendAcp: async () => {}, streamedTranscriptSession: null,
        createRuntime, getNowMs: () => 1, budgetRegistry: null, runs, controllers,
        enqueueMarkerWrite: async (_runId, write) => write(), writeActivityMarker: async () => {}, finishRun: async () => {},
        executeBoundedRun: async () => {}, send: async () => ({ ok: true }), voiceAgentManager,
      });
      const retained = projectRetainedExecutionRunState(runs.get(started.runId)!);
      applied.modelId = 'later-parent-model';
      applied.modelSelection = { ...applied.modelSelection, providerConnectionId: 'later-parent-provider', modelId: 'later-parent-model' };
      expect(retained.launch).toMatchObject({
        modelId: 'parent-model', selectionSource: 'inherited', connectedServicesSelection: null,
        modelSelection: { providerConnectionId: 'parent-provider', modelId: 'parent-model' },
      });
      expect(projectExecutionRunPublicState(runs.get(started.runId)!)).toMatchObject({
        resolvedSelection: { source: 'inherited', modelId: 'parent-model', modelSelection: { providerConnectionId: 'parent-provider' } },
      });
      const resolvedSelection = projectExecutionRunPublicState(runs.get(started.runId)!).resolvedSelection;
      expect.soft((await listExecutionRunMarkers()).find((marker) => marker.runId === started.runId))
        .toHaveProperty('resolvedSelection', resolvedSelection);
      await finishExecutionRun({ runId: started.runId, next: { status: 'succeeded', finishedAtMs: 2 },
        toolResult: { output: 'complete' }, runs, controllers, budgetRegistry: null, parentProvider: 'claude',
        sendAcp: async () => {}, enqueueMarkerWrite: async (_runId, write) => write(), terminalMarkerWritePromises: new Map() });
      expect((await listExecutionRunMarkers()).find((marker) => marker.runId === started.runId))
        .toMatchObject({ status: 'succeeded', resolvedSelection });
    } finally {
      await Promise.all([...controllers.values()].flatMap((controller) => controller.kind === 'backend' ? [controller.backend.dispose()] : []));
      await voiceAgentManager.dispose();
      vi.unstubAllEnvs();
      reloadConfiguration();
      await removeTempDir(markerDirectory);
    }
  });

  it('refuses attached omission when applied parent state is unavailable before creating or materializing a run', async () => {
    const runs = new Map<string, ExecutionRunState>();
    const voiceAgentManager = new VoiceAgentManager({ createRuntime: () => { throw new Error('unused'); } });
    try {
      await expect(startExecutionRun({
        params: { sessionId: 'parent_session_1', intent: 'delegate', backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
          permissionMode: 'read_only', retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response' },
        childSelectionContext: { lifecycle: 'attached', readAppliedParentSelection: () => ({ status: 'unavailable' }) },
        parentProvider: 'claude', sendAcp: async () => {}, streamedTranscriptSession: null,
        createRuntime: () => { throw new Error('Materialization reached'); }, getNowMs: () => 1, budgetRegistry: null,
        runs, controllers: new Map(), enqueueMarkerWrite: async () => {}, writeActivityMarker: async () => {},
        finishRun: async () => {}, executeBoundedRun: async () => {}, send: async () => ({ ok: true }), voiceAgentManager,
      })).rejects.toMatchObject({ code: 'execution_run_parent_selection_unavailable' });
      expect(runs.size).toBe(0);
    } finally { await voiceAgentManager.dispose(); }
  });
  it.each(['ephemeral', 'resumable'] as const)('publishes provisioning, idle, active and resumed work for a %s backend handle', async (retentionPolicy) => {
    let releaseProvision!: () => void;
    let releaseTurn!: () => void;
    const provisionGate = new Promise<void>((resolve) => { releaseProvision = resolve; });
    const turnGate = new Promise<void>((resolve) => { releaseTurn = resolve; });
    const runs = new Map<string, ExecutionRunState>();
    const controllers = new Map<string, ExecutionRunController>();
    const publicStates: Array<Readonly<{ status: string; turnInFlight?: boolean }>> = [];
    const runtimes: TestExecutionRunHostRuntime[] = [];
    const createRuntime = () => {
      const runtime = createTestExecutionRunHostRuntime({
        replayResumeSupported: true, providerSessionId: 'retained-vendor-session',
        onProvisionRuntime: async (options) => { if (!options?.resumeRuntimeId) await provisionGate; },
        onWaitForTurnCompletion: async () => { await turnGate; },
      });
      runtimes.push(runtime);
      return runtime;
    };
    const voiceAgentManager = new VoiceAgentManager({ createRuntime });
    const common = {
      parentProvider: TEST_BACKEND_ID, sendAcp: async () => {}, streamedTranscriptSession: null,
      createRuntime, getNowMs: () => 1, budgetRegistry: null, runs, controllers,
      writeActivityMarker: async () => {},
      onPublicStateUpdated: (id: string) => publicStates.push(projectExecutionRunPublicState(runs.get(id)!, controllers.get(id) ?? null)),
    };
    try {
      const started = await startExecutionRun({ ...common,
        params: { sessionId: 'parent_session_1', intent: 'delegate',
          backendTarget: { kind: 'builtInAgent', agentId: TEST_BACKEND_ID },
          permissionMode: 'read_only', retentionPolicy, runClass: 'long_lived', ioMode: 'streaming' },
        enqueueMarkerWrite: async () => {}, finishRun: async () => {}, executeBoundedRun: async () => {},
        send: async () => ({ ok: true }), voiceAgentManager,
      });
      expect.soft(projectExecutionRunPublicState(runs.get(started.runId)!, controllers.get(started.runId))).not.toHaveProperty('turnInFlight');
      releaseProvision();
      const controller = controllers.get(started.runId);
      if (controller?.kind !== 'backend') throw new Error('Expected backend controller');
      await controller.provisioningPromise;
      expect(publicStates.at(-1)).toMatchObject({ status: 'running', turnInFlight: false });
      expect(await sendBackendLongLivedRun({ ...common, runId: started.runId, params: { message: 'continue' },
        maxTurns: null, finishRun: async () => {} })).toEqual({ ok: true });
      expect.soft(publicStates.at(-1)).toMatchObject({ status: 'running', turnInFlight: true });
      releaseTurn();
      await vi.waitFor(() => expect(publicStates.at(-1)).toMatchObject({ status: 'running', turnInFlight: false }));
      expect(runs.get(started.runId)?.status).toBe('running');
      expect(await stopExecutionRun({ runId: started.runId, runs, controllers, getNowMs: common.getNowMs, voiceAgentManager,
        finishRun: async (id, next) => { runs.set(id, { ...runs.get(id)!, ...next }); },
        onPublicStateUpdated: common.onPublicStateUpdated })).toEqual({ ok: true });
      expect(publicStates.at(-1)?.status).toBe('cancelled');
      if (retentionPolicy === 'resumable') {
        expect(await resumeBackendControllerForResumableRun({ ...common, runId: started.runId,
          run: runs.get(started.runId)!, requireReplayCapture: true })).toEqual({ ok: true });
        expect(publicStates.at(-1)).toMatchObject({ status: 'running', turnInFlight: false });
      }
    } finally {
      releaseProvision(); releaseTurn(); await Promise.all(runtimes.map((runtime) => runtime.dispose())); await voiceAgentManager.dispose();
    }
  });

  it('retains an admitted Workflow origin through host loss and public terminal observation', async () => {
    const runs = new Map<string, ExecutionRunState>();
    const voiceAgentManager = new VoiceAgentManager({ createRuntime: () => { throw new Error('unused'); } });
    try {
      const started = await startExecutionRun({
        params: { sessionId: 'parent_session_1', workflowRunId: 'origin-workflow', intent: 'task',
          backendTarget: { kind: 'builtInAgent', agentId: TEST_BACKEND_ID }, instructions: 'Continue.',
          permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'bounded', ioMode: 'request_response' },
        parentProvider: TEST_BACKEND_ID, sendAcp: async () => {}, streamedTranscriptSession: null,
        createRuntime: () => createProvisioningRuntime(), getNowMs: () => 1, budgetRegistry: null,
        runs, controllers: new Map(), enqueueMarkerWrite: async () => {}, writeActivityMarker: async () => {},
        finishRun: async () => {}, executeBoundedRun: async () => {}, send: async () => ({ ok: true }), voiceAgentManager,
      });
      const retained = projectRetainedExecutionRunState(runs.get(started.runId)!);
      const terminal = projectExecutionRunHostLoss({ ownerPid: 1, state: retained }, 2);
      expect(projectExecutionRunPublicState(terminal.state)).toMatchObject({
        runId: started.runId, status: 'failed', originWorkflowRunId: 'origin-workflow',
      });
    } finally { await voiceAgentManager.dispose(); }
  });
  it('refuses a role start without Account role-override authority before creating a run', async () => {
    clearActiveAccountSettingsSnapshot();
    const runs = new Map<string, ExecutionRunState>();
    const voiceAgentManager = new VoiceAgentManager({ createRuntime: () => { throw new Error('unused'); } });
    try {
      await expect(startExecutionRun({
        params: { sessionId: 'parent_session_1', intent: 'task', roleId: 'second_opinion',
          backendTarget: { kind: 'builtInAgent', agentId: TEST_BACKEND_ID }, instructions: 'Assess this change.',
          accountSettings: {}, permissionMode: 'yolo', retentionPolicy: 'resumable', runClass: 'bounded', ioMode: 'request_response' },
        parentProvider: TEST_BACKEND_ID, sendAcp: async () => {}, streamedTranscriptSession: null,
        createRuntime: () => { throw new Error('Runtime must not be reached before admission'); },
        getNowMs: () => 1, budgetRegistry: null, runs, controllers: new Map(),
        enqueueMarkerWrite: async () => {}, writeActivityMarker: async () => {}, finishRun: async () => {},
        executeBoundedRun: async () => {}, send: async () => ({ ok: true }), voiceAgentManager,
      })).rejects.toMatchObject({ code: 'account_role_overrides_unavailable' });
      expect(runs.size).toBe(0);
    } finally { await voiceAgentManager.dispose(); }
  });

  it('starts Second opinion with its canonical role plan, read-only ceiling and strict verdict contract', async () => {
    const role = resolveRoleSelectionV1({ roleId: 'second_opinion', defaultEngine: { agentTargetKey: 'agent:happier.agent.codex/codex' } });
    if (!role.ok) throw new Error('Fixture role must resolve');
    const runs = new Map<string, ExecutionRunState>();
    const createRuntime = vi.fn<StartExecutionRunArgs['createRuntime']>(() => createProvisioningRuntime());
    const executeBoundedRun = vi.fn<StartExecutionRunArgs['executeBoundedRun']>(async () => {});
    const voiceAgentManager = new VoiceAgentManager({ createRuntime: () => { throw new Error('unused'); } });
    try {
      const started = await startExecutionRun({
        params: { sessionId: 'parent_session_1', intent: 'task', roleId: 'second_opinion', resolvedRole: role.selection,
          promptCredentials: { token: 'synthetic-account-token', encryption: null },
          backendTarget: { kind: 'builtInAgent', agentId: TEST_BACKEND_ID }, instructions: 'Assess this change.',
          cwd: tmpdir(), accountSettings: {}, permissionMode: 'yolo', retentionPolicy: 'resumable', runClass: 'bounded', ioMode: 'request_response' },
        parentProvider: TEST_BACKEND_ID, sendAcp: async () => {}, streamedTranscriptSession: null,
        createRuntime, getNowMs: () => 1, budgetRegistry: null, runs, controllers: new Map(),
        enqueueMarkerWrite: async () => {}, writeActivityMarker: async () => {}, finishRun: async () => {}, executeBoundedRun,
        send: async () => ({ ok: true }), voiceAgentManager,
      });
      const run = runs.get(started.runId)!;
      expect(run.instructions).toContain(BUILT_IN_ROLES_V1.second_opinion.instructions);
      expect(run.instructions).toContain('<happier_role');
      expect(run.instructions.match(/<happier_role\b/g)).toHaveLength(1);
      expect(run.instructions).toContain('Assess this change.');
      expect(run.intentInput).toMatchObject({ input: { question: 'Assess this change.', changeFingerprint: null,
        diff: null, diffUnavailable: 'scm_unavailable', transcriptPointer: { sessionId: 'parent_session_1' } } });
      await vi.waitFor(() => expect(createRuntime.mock.calls[0]?.[0]).toMatchObject({ workspaceWrites: 'deny' }));
      expect(createRuntime.mock.calls[0]?.[0].start).not.toHaveProperty('promptCredentials');
      expect(createRuntime.mock.calls[0]?.[0].start).not.toHaveProperty('resolvedRole');
      await vi.waitFor(() => expect(executeBoundedRun.mock.calls[0]?.[0].params).toBeDefined());
      expect(executeBoundedRun.mock.calls[0]?.[0].params).not.toHaveProperty('promptCredentials');
      const start = { ...run, instructions: run.instructions, backendTarget: run.backendTarget, startedAtMs: 1 };
      const verdict = { verdict: 'uncertain', confidence: 0.6, risks: [{ title: 'Untested path', severity: 'high', evidence: 'Missing integration check' }], missingEvidence: ['Runtime check'], nextStep: 'Validate' };
      expect(TaskProfile.onBoundedComplete({ start, rawText: JSON.stringify(verdict), finishedAtMs: 2 }))
        .toMatchObject({ status: 'succeeded', toolResultOutput: verdict });
      expect(TaskProfile.onBoundedComplete({ start, rawText: '{"verdict":"agree"}', finishedAtMs: 2 }))
        .toMatchObject({ status: 'failed' });
    } finally { await voiceAgentManager.dispose(); }
  });

  it.each([
    ['review', 'bounded', undefined, true],
    ['plan', 'bounded', undefined, true],
    ['delegate', 'bounded', undefined, true],
    ['agent', 'long_lived', undefined, false],
    ['delegate', 'long_lived', undefined, false],
    ['review', 'bounded', false, false],
    ['agent', 'long_lived', true, true],
  ] as const)('resolves report defaults for %s/%s with override %s', async (intent, runClass, notifyParentOnCompletion, expected) => {
    const runs = new Map<string, ExecutionRunState>();
    const voiceAgentManager = new VoiceAgentManager({
      createRuntime: () => { throw new Error('voice runtime is unused'); },
    });
    if (intent === 'review') publishEmptyAccountRoleOverrides();
    try {
      const result = await startExecutionRun({
        params: {
          sessionId: 'parent_session_1', intent, runClass, notifyParentOnCompletion,
          backendTarget: { kind: 'builtInAgent', agentId: TEST_BACKEND_ID },
          instructions: '', permissionMode: 'read_only', retentionPolicy: 'resumable', ioMode: 'request_response',
          accountSettings: { executionRunsNotifyParentOnCompletionDefault: false },
        },
        parentProvider: TEST_BACKEND_ID, sendAcp: async () => {}, streamedTranscriptSession: null,
        createRuntime: createProvisioningRuntime, getNowMs: () => 1_700_000_000_000,
        budgetRegistry: null, runs, controllers: new Map(), enqueueMarkerWrite: async () => {},
        writeActivityMarker: async () => {}, finishRun: async () => {}, executeBoundedRun: async () => {},
        send: async () => ({ ok: true }), voiceAgentManager,
      });
      expect(runs.get(result.runId)?.notifyParentOnCompletion).toBe(expected);
    } finally {
      await voiceAgentManager.dispose();
      if (intent === 'review') clearActiveAccountSettingsSnapshot();
    }
  });

  it('keeps admitted absolute depth and never derives depth from caller-supplied parent refs', async () => {
    const runs = new Map<string, ExecutionRunState>();
    const controllers = new Map<string, ExecutionRunController>();
    const voiceAgentManager = new VoiceAgentManager({
      createRuntime: () => { throw new Error('voice runtime is unused'); },
    });
    const args = {
      params: {
        sessionId: null,
        intent: 'agent' as const,
        backendTarget: { kind: 'builtInAgent' as const, agentId: TEST_BACKEND_ID },
        instructions: '',
        permissionMode: 'read_only',
        retentionPolicy: 'resumable' as const,
        runClass: 'long_lived' as const,
        ioMode: 'request_response' as const,
        workDepth: 4,
      },
      parentProvider: TEST_BACKEND_ID,
      sendAcp: async () => {},
      streamedTranscriptSession: null,
      createRuntime: () => createProvisioningRuntime(),
      getNowMs: () => 1_700_000_000_000,
      budgetRegistry: null,
      runs,
      controllers,
      enqueueMarkerWrite: async () => {},
      writeActivityMarker: async () => {},
      finishRun: async () => { throw new Error('empty initial input does not settle the run'); },
      executeBoundedRun: async () => { throw new Error('long-lived creation does not execute a bounded run'); },
      send: async () => { throw new Error('empty initial input does not send a prompt'); },
      voiceAgentManager,
    } satisfies StartExecutionRunArgs;
    try {
      const admitted = await startExecutionRun(args);
      expect(runs.get(admitted.runId)?.depth).toBe(4);
      const human = await startExecutionRun({
        ...args,
        params: { ...args.params, workDepth: undefined, parentRunId: admitted.runId, parentCallId: admitted.callId },
      });
      expect(runs.get(human.runId)?.depth).toBe(0);
    } finally {
      await voiceAgentManager.dispose();
    }
  });

  it('rejoins the Run allocated for one host-stamped Action request without repeating start effects', async () => {
    const runs = new Map<string, ExecutionRunState>();
    const controllers = new Map<string, ExecutionRunController>();
    const runtime = createProvisioningRuntime();
    const createRuntime = vi.fn(() => runtime);
    const enqueueMarkerWrite = vi.fn(async () => {});
    const sendAcp = vi.fn(async () => {});
    const send = vi.fn(async () => ({ ok: true as const }));
    const voiceAgentManager = new VoiceAgentManager({
      createRuntime: () => {
        throw new Error('voice runtime should not be used by agent runs');
      },
    });
    const args = {
      params: {
        sessionId: null,
        actionRequestId: 'workflow-input-v2:stable:execution-run-start',
        intent: 'agent' as const,
        backendTarget: { kind: 'builtInAgent' as const, agentId: TEST_BACKEND_ID },
        instructions: 'Implement once.',
        permissionMode: 'read_only',
        retentionPolicy: 'resumable' as const,
        runClass: 'long_lived' as const,
        ioMode: 'request_response' as const,
      },
      parentProvider: TEST_BACKEND_ID,
      sendAcp,
      streamedTranscriptSession: null,
      createRuntime,
      getNowMs: () => 1_700_000_000_000,
      budgetRegistry: null,
      runs,
      controllers,
      enqueueMarkerWrite,
      writeActivityMarker: async () => {},
      finishRun: async () => {},
      executeBoundedRun: async () => {},
      send,
      voiceAgentManager,
    } satisfies StartExecutionRunArgs;

    try {
      const first = await startExecutionRun(args);
      const second = await startExecutionRun(args);
      await (controllers.get(first.runId) as (ExecutionRunController & {
        provisioningPromise?: Promise<void>;
      }) | undefined)?.provisioningPromise;

      expect(second).toEqual(first);
      expect(first.runId).toMatch(/^run_request_/);
      expect(runs.size).toBe(1);
      expect(createRuntime).toHaveBeenCalledTimes(1);
      expect(enqueueMarkerWrite).toHaveBeenCalledTimes(1);
      expect(sendAcp).not.toHaveBeenCalled();
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      await voiceAgentManager.dispose();
    }
  });

  it('rejects failed Saved Secret admission before every Run creation effect', async () => {
    const runs = new Map<string, ExecutionRunState>();
    const controllers = new Map<string, ExecutionRunController>();
    const enqueueMarkerWrite = vi.fn(async () => {});
    const sendAcp = vi.fn(async () => {});
    const createRuntime = vi.fn(() => createProvisioningRuntime());
    const onPublicStateUpdated = vi.fn();
    const finishRun = vi.fn(async () => {});
    const budgetRegistry = new ExecutionBudgetRegistry({ maxConcurrentExecutionRuns: null, maxConcurrentOneShotTasks: null });
    let preparing!: () => void;
    let releasePreparation!: () => void;
    const enteredPreparation = new Promise<void>(resolve => { preparing = resolve; });
    const preparation = new Promise<void>(resolve => { releasePreparation = resolve; });
    const voiceAgentManager = new VoiceAgentManager({
      createRuntime: () => {
        throw new Error('voice runtime should not be used by delegate runs');
      },
    });

    try {
      const rejected = expect(startExecutionRun({
        params: {
          sessionId: 'session_1',
          intent: 'delegate',
          backendTarget: { kind: 'builtInAgent', agentId: TEST_BACKEND_ID },
          instructions: 'Use the selected shared credential.',
          secretReferenceOverlay: {
            v: 1,
            bindings: {
              ANTHROPIC_API_KEY: {
                ref: 'happier:shared-secret:v1:shared-key',
                revision: 6,
              },
            },
          },
          permissionMode: 'read_only',
          retentionPolicy: 'ephemeral',
          runClass: 'bounded',
          ioMode: 'request_response',
        },
        parentProvider: TEST_BACKEND_ID,
        sendAcp,
        streamedTranscriptSession: null,
        createRuntime,
        admitSecretReferenceOverlay: async () => {
          // The Saved Secret service is the credential/network boundary; all
          // admission and budget custody beneath it remains the real owner.
          preparing();
          await preparation;
          throw Object.assign(new Error('Saved Secret reference changed'), {
            code: 'provider_binding_changed',
          });
        },
        getNowMs: () => 1_700_000_000_000,
        budgetRegistry,
        runs,
        controllers,
        enqueueMarkerWrite,
        writeActivityMarker: async () => {},
        finishRun,
        executeBoundedRun: async () => {},
        send: async () => ({ ok: true }),
        voiceAgentManager,
        onPublicStateUpdated,
      })).rejects.toMatchObject({
        code: 'provider_binding_changed',
        details: {
          executionRunStart: { v: 1, runCreation: 'noRunCreated' },
        },
      });

      await enteredPreparation;
      expect(runs.size).toBe(0);
      expect(budgetRegistry.getLiveWorkProducer().read()).toMatchObject({ items: [{ category: 'execution_run', state: 'active' }] });
      expect(budgetRegistry.getInFlightSnapshot()).toEqual({ executionRuns: 0, oneShotTasks: 0 });
      releasePreparation();
      await rejected;
      expect(budgetRegistry.getLiveWorkProducer().read()).toEqual({ coverage: 'complete', items: [] });

      expect(runs.size).toBe(0);
      expect(controllers.size).toBe(0);
      expect(enqueueMarkerWrite).not.toHaveBeenCalled();
      expect(sendAcp).not.toHaveBeenCalled();
      expect(createRuntime).not.toHaveBeenCalled();
      expect(onPublicStateUpdated).not.toHaveBeenCalled();
      expect(finishRun).not.toHaveBeenCalled();
    } finally {
      releasePreparation();
      await voiceAgentManager.dispose();
    }
  });

  it('preserves canonical Voice lifecycle fields when Voice supplies its runtime-specific start override', async () => {
    const runtime = createProvisioningRuntime();
    const createRuntime = vi.fn(() => runtime);
    const voiceAgentManager = {
      async start(params: { voiceAgentId: string }, options: { createRuntime: (input: Record<string, unknown>) => unknown }) {
        options.createRuntime({
          backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
          backendId: 'claude',
          modelId: 'default',
          permissionIntent: 'default',
          start: { intent: 'voice_agent' },
        });
        return { voiceAgentId: params.voiceAgentId };
      },
      getResumeHandle() { return null; },
    } as unknown as VoiceAgentManager;

    await startExecutionRun({
      params: {
        sessionId: 'session_voice',
        intent: 'voice_agent',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        permissionMode: 'default',
        retentionPolicy: 'resumable',
        runClass: 'long_lived',
        ioMode: 'streaming',
      },
      parentProvider: TEST_BACKEND_ID,
      sendAcp: async () => {},
      streamedTranscriptSession: null,
      createRuntime,
      getNowMs: () => 1_700_000_000_000,
      budgetRegistry: null,
      runs: new Map(),
      controllers: new Map(),
      enqueueMarkerWrite: async () => {},
      writeActivityMarker: async () => {},
      finishRun: async () => {},
      executeBoundedRun: async () => {},
      send: async () => ({ ok: true }),
      voiceAgentManager,
    });

    expect(createRuntime).toHaveBeenCalledWith(expect.objectContaining({
      start: expect.objectContaining({
        intent: 'voice_agent',
        retentionPolicy: 'resumable',
        runClass: 'long_lived',
        ioMode: 'streaming',
      }),
    }));
  });

  it('rejects unsupported review SCM scope before materializing a SubAgentRun tool call', async () => {
    const runs = new Map<string, ExecutionRunState>();
    const controllers = new Map<string, ExecutionRunController>();
    const sent: Array<{ provider: string; body: unknown; meta?: Record<string, unknown> }> = [];
    const voiceAgentManager = new VoiceAgentManager({
      createRuntime: () => {
        throw new Error('voice runtime should not be used by review runs');
      },
    });

    try {
      const createRuntime = vi.fn(() => createProvisioningRuntime());
      const finishRun = vi.fn();
      await expect(startExecutionRun({
        params: {
          sessionId: 'session_1',
          intent: 'review',
          backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
          instructions: '',
          intentInput: {
            scmReviewScope: {
              kind: 'review_scm_scope.v1',
              status: 'unsupported',
              scmBackendId: null,
              scmMode: null,
              repositoryRoot: null,
              worktreeRoot: null,
              baseRef: { source: 'unavailable', ref: null },
              selectedPaths: [],
              committedPaths: [],
              uncommittedPaths: [],
              changedPaths: [],
              diff: { committedAvailable: false, uncommittedAvailable: false },
              diagnostics: [
                {
                  code: 'not_repository',
                  severity: 'error',
                  message: 'Review scope requires a source-control repository in the current session directory.',
                },
              ],
            },
          },
          permissionMode: 'read_only',
          retentionPolicy: 'ephemeral',
          runClass: 'bounded',
          ioMode: 'request_response',
        },
        parentProvider: TEST_BACKEND_ID,
        sendAcp: async (provider: string, body: ACPMessageData, opts?: { meta?: Record<string, unknown> }) => {
          sent.push({ provider, body, meta: opts?.meta });
        },
        streamedTranscriptSession: null,
        createRuntime,
        getNowMs: () => 1_700_000_000_000,
        budgetRegistry: null,
        runs,
        controllers,
        enqueueMarkerWrite: async () => {},
        writeActivityMarker: async () => {},
        finishRun,
        executeBoundedRun: async () => {},
        send: async () => ({ ok: true }),
        voiceAgentManager,
      })).rejects.toMatchObject({
        code: 'execution_run_not_allowed',
      });

      expect(sent.some((message) => (message.body as any)?.type === 'tool-call')).toBe(false);
      expect(createRuntime).not.toHaveBeenCalled();
      expect(finishRun).not.toHaveBeenCalled();
      expect(runs.size).toBe(0);
    } finally {
      await voiceAgentManager.dispose();
    }
  });

  it('refuses a selected pull request review whose own scope is unreadable, never falling back to the worktree scope beside it', async () => {
    const runs = new Map<string, ExecutionRunState>();
    const controllers = new Map<string, ExecutionRunController>();
    const voiceAgentManager = new VoiceAgentManager({
      createRuntime: () => {
        throw new Error('voice runtime should not be used by review runs');
      },
    });

    try {
      const createRuntime = vi.fn(() => createProvisioningRuntime());
      const finishRun = vi.fn();
      await expect(startExecutionRun({
        params: {
          sessionId: 'session_1',
          intent: 'review',
          backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
          // A usable worktree scope and real instructions: everything the
          // incumbent admission looks at says this run is fine.
          instructions: 'Review the selected pull request.',
          intentInput: {
            scmReviewScope: SUPPORTED_WORKTREE_SCOPE,
            scmPullRequestReviewScope: {
              ...SELECTED_PULL_REQUEST_REVIEW_SCOPE,
              observed: {
                baseSha: SELECTED_PULL_REQUEST_REVIEW_SCOPE.observed.baseSha,
                headSha: SELECTED_PULL_REQUEST_REVIEW_SCOPE.observed.headSha,
              },
            },
          },
          permissionMode: 'read_only',
          retentionPolicy: 'ephemeral',
          runClass: 'bounded',
          ioMode: 'request_response',
        },
        parentProvider: TEST_BACKEND_ID,
        sendAcp: async () => {},
        streamedTranscriptSession: null,
        createRuntime,
        getNowMs: () => 1_700_000_000_000,
        budgetRegistry: null,
        runs,
        controllers,
        enqueueMarkerWrite: async () => {},
        writeActivityMarker: async () => {},
        finishRun,
        executeBoundedRun: async () => {},
        send: async () => ({ ok: true }),
        voiceAgentManager,
      })).rejects.toMatchObject({
        code: 'execution_run_not_allowed',
        details: { executionRunStart: { v: 1, runCreation: 'noRunCreated' } },
      });

      expect(createRuntime).not.toHaveBeenCalled();
      expect(finishRun).not.toHaveBeenCalled();
      expect(runs.size).toBe(0);
    } finally {
      await voiceAgentManager.dispose();
    }
  });

  it('starts a review scoped to the selected pull request, and one scoped only to the worktree', async () => {
    const runs = new Map<string, ExecutionRunState>();
    const controllers = new Map<string, ExecutionRunController>();
    const voiceAgentManager = new VoiceAgentManager({
      createRuntime: () => {
        throw new Error('voice runtime should not be used by review runs');
      },
    });
    publishEmptyAccountRoleOverrides();

    try {
      const createRuntime = vi.fn(() => createProvisioningRuntime());
      const startWith = async (intentInput: Record<string, unknown>) => await startExecutionRun({
        params: {
          sessionId: 'session_1',
          intent: 'review',
          backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
          instructions: 'Review the selected pull request.',
          intentInput,
          permissionMode: 'read_only',
          retentionPolicy: 'ephemeral',
          runClass: 'bounded',
          ioMode: 'request_response',
        },
        parentProvider: TEST_BACKEND_ID,
        sendAcp: async () => {},
        streamedTranscriptSession: null,
        createRuntime,
        getNowMs: () => 1_700_000_000_000,
        budgetRegistry: null,
        runs,
        controllers,
        enqueueMarkerWrite: async () => {},
        writeActivityMarker: async () => {},
        finishRun: async () => {},
        executeBoundedRun: async () => {},
        send: async () => ({ ok: true }),
        voiceAgentManager,
      });

      await startWith({
        scmReviewScope: SUPPORTED_WORKTREE_SCOPE,
        scmPullRequestReviewScope: SELECTED_PULL_REQUEST_REVIEW_SCOPE,
      });
      await startWith({ scmReviewScope: SUPPORTED_WORKTREE_SCOPE });

      expect(createRuntime).toHaveBeenCalledTimes(2);
      expect(runs.size).toBe(2);
    } finally {
      await voiceAgentManager.dispose();
      clearActiveAccountSettingsSnapshot();
    }
  });

  it('rejects a Session-required profile before creating a detached run or transcript fact', async () => {
    const runs = new Map<string, ExecutionRunState>();
    const controllers = new Map<string, ExecutionRunController>();
    const sendAcp = vi.fn(async () => {});
    const enqueueMarkerWrite = vi.fn(async () => {});
    const createRuntime = vi.fn(() => createProvisioningRuntime());
    const voiceAgentManager = new VoiceAgentManager({
      createRuntime: () => {
        throw new Error('voice runtime should not be used by review runs');
      },
    });

    try {
      await expect(startExecutionRun({
        params: {
          sessionId: null,
          intent: 'memory_hints',
          backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
          instructions: 'Explain this captured change.',
          permissionMode: 'read_only',
          retentionPolicy: 'resumable',
          runClass: 'long_lived',
          ioMode: 'request_response',
        },
        parentProvider: TEST_BACKEND_ID,
        sendAcp,
        streamedTranscriptSession: null,
        createRuntime,
        getNowMs: () => 1_700_000_000_000,
        budgetRegistry: null,
        runs,
        controllers,
        enqueueMarkerWrite,
        writeActivityMarker: async () => {},
        finishRun: async () => {},
        executeBoundedRun: async () => {},
        send: async () => ({ ok: true }),
        voiceAgentManager,
      })).rejects.toMatchObject({
        code: 'execution_run_not_allowed',
        details: { executionRunStart: { v: 1, runCreation: 'noRunCreated' } },
      });

      expect(runs.size).toBe(0);
      expect(controllers.size).toBe(0);
      expect(createRuntime).not.toHaveBeenCalled();
      expect(sendAcp).not.toHaveBeenCalled();
      expect(enqueueMarkerWrite).not.toHaveBeenCalled();
    } finally {
      await voiceAgentManager.dispose();
    }
  });

  it('prepares a workspace-native saved comparison through the real detached diff-summary Run profile', async () => {
    const fixture = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'happier-detached-summary-start-' });
    const runs = new Map<string, ExecutionRunState>();
    const controllers = new Map<string, ExecutionRunController>();
    const runtime = createProvisioningRuntime();
    const voiceAgentManager = new VoiceAgentManager({ createRuntime: () => runtime });
    try {
      const request = {
        sessionId: null, cwd: fixture.rootPath, intent: 'scm_diff_summary',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, modelId: readOfferedSummaryModelId(),
        instructions: 'Explain the captured workspace.', intentInput: { cwd: fixture.rootPath,
          source: { kind: 'workingTree' }, outputs: ['summary'] },
        permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming',
      } satisfies StartExecutionRunArgs['params'];
      // HostBridge prepares the profile before invoking the shared Run start owner.
      const preparation = await ScmDiffSummaryProfile.prepareStartParams!({
        request, cwd: fixture.rootPath, sessionId: null,
      });
      const result = await startExecutionRun({
        params: { ...request, ...preparation },
        parentProvider: TEST_BACKEND_ID, sendAcp: async () => {}, streamedTranscriptSession: null,
        // Only the native Agent process is replaced by the incumbent runtime testkit.
        createRuntime: () => runtime, getNowMs: () => 1_700_000_000_000,
        budgetRegistry: null, runs, controllers, enqueueMarkerWrite: async (_runId, write) => await write(),
        writeActivityMarker: async () => {}, finishRun: async () => {}, executeBoundedRun: async () => {},
        send: async () => ({ ok: true }), voiceAgentManager,
      });
      const prepared = runs.get(result.runId)!;
      expect(prepared.sessionId).toBeNull();
      const intentInput = prepared.intentInput as { resultId: string; comparison: { id: string } };
      expect(await scmDiffSummaryResultStore.readStoredScope({ cwd: fixture.rootPath, resultId: intentInput.resultId }))
        .toEqual({ cwd: fixture.rootPath });
      expect(await scmDiffSummaryResultStore.read({ cwd: fixture.rootPath, resultId: intentInput.resultId }))
        .toMatchObject({ success: true, result: { output: { comparison: { id: intentInput.comparison.id } } } });
    } finally {
      await runtime.dispose();
      await voiceAgentManager.dispose();
      await removeTempDir(fixture.rootPath);
    }
  });

  it('finishes cached SCM diff-summary runs without creating a backend runtime', async () => {
    const comparison = ScmComparisonSchema.parse({
      id: 'turnCheckpoint:turn_1:checkpoint.diff_computed',
      source: { kind: 'turnCheckpoint' },
      repository: { rootPath: tmpdir() },
      endpoints: {},
      inventory: { state: 'complete', reasons: [], files: [] },
    });
    const metadata = {
      source: comparison.source,
      sourceKey: comparison.id,
      checkpointReceiptId: 'checkpoint.diff_computed',
    };
    const runs = new Map<string, ExecutionRunState>();
    const controllers = new Map<string, ExecutionRunController>();
    let resolveFinishAdmission!: () => void;
    const finishAdmission = new Promise<void>((resolve) => {
      resolveFinishAdmission = resolve;
    });
    const finishRun = vi.fn(async (runId: string, next, toolResult, structuredMeta?: ExecutionRunStructuredMeta) => {
      await finishAdmission;
      const current = runs.get(runId);
      if (!current) return;
      runs.set(runId, {
        ...current,
        ...next,
        latestToolResult: toolResult.output,
        ...(structuredMeta ? { structuredMeta } : {}),
      });
    });
    const voiceAgentManager = new VoiceAgentManager({
      createRuntime: () => {
        throw new Error('voice runtime should not be used by scm_diff_summary runs');
      },
    });

    try {
      const createRuntime = vi.fn(() => createProvisioningRuntime());
      const startPromise = startExecutionRun({
        params: {
          sessionId: 'session_1',
          intent: 'scm_diff_summary',
          backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
          instructions: 'SCM diff summary cache hit; no generation required.',
          modelId: readOfferedSummaryModelId(),
          intentInput: {
            comparison,
            metadata,
            outputs: ['summary'],
            cachedOutput: {
              success: true,
              summaryMarkdown: '## Summary\n\nCached checkpoint.',
              sourceKey: comparison.id,
              checkpointReceiptId: 'checkpoint.diff_computed',
              comparison,
              metadata,
              requestedOutputs: ['summary'],
              outputs: { summary: { state: 'complete', value: { summaryMarkdown: '## Summary\n\nCached checkpoint.' } } },
              analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: [] },
            },
          },
          permissionMode: 'read_only',
          retentionPolicy: 'ephemeral',
          runClass: 'bounded',
          ioMode: 'streaming',
        },
        parentProvider: TEST_BACKEND_ID,
        sendAcp: async () => {},
        streamedTranscriptSession: null,
        createRuntime,
        getNowMs: () => 1_700_000_000_000,
        budgetRegistry: null,
        runs,
        controllers,
        enqueueMarkerWrite: async () => {},
        writeActivityMarker: async () => {},
        finishRun,
        executeBoundedRun: async () => {
          throw new Error('cached diff summary should not execute bounded generation');
        },
        send: async () => ({ ok: true }),
        voiceAgentManager,
      });

      let startSettled = false;
      void startPromise.then(() => {
        startSettled = true;
      });
      await vi.waitFor(() => {
        expect(finishRun).toHaveBeenCalledOnce();
      });
      expect(startSettled).toBe(false);

      resolveFinishAdmission();
      const started = await startPromise;

      expect(createRuntime).not.toHaveBeenCalled();
      expect(finishRun).toHaveBeenCalledTimes(1);
      expect(runs.get(started.runId)).toMatchObject({
        status: 'succeeded',
        latestToolResult: {
          success: true,
          summaryMarkdown: '## Summary\n\nCached checkpoint.',
        },
        structuredMeta: {
          kind: 'scm_diff_summary.v1',
          payload: {
            success: true,
            summaryMarkdown: '## Summary\n\nCached checkpoint.',
          },
        },
      });
    } finally {
      await voiceAgentManager.dispose();
    }
  });

  it('starts fresh SCM diff-summary generation when cache bypass is requested', async () => {
    const runs = new Map<string, ExecutionRunState>();
    const controllers = new Map<string, ExecutionRunController>();
    const voiceAgentManager = new VoiceAgentManager({
      createRuntime: () => {
        throw new Error('voice runtime should not be used by scm_diff_summary runs');
      },
    });

    try {
      const createRuntime = vi.fn(() => createProvisioningRuntime());
      const executeBoundedRun = vi.fn<StartExecutionRunArgs['executeBoundedRun']>(async () => {});
      await startExecutionRun({
        params: {
          sessionId: 'session_1',
          intent: 'scm_diff_summary',
          backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
          instructions: 'Regenerate the checkpoint summary.',
          modelId: readOfferedSummaryModelId(),
          intentInput: {
            cachePolicy: { mode: 'bypass' },
            cachedOutput: {
              success: true,
              summaryMarkdown: '## Summary\n\nStale cached checkpoint.',
              sourceKey: 'turnCheckpoint:turn_1:checkpoint.diff_computed',
              checkpointReceiptId: 'checkpoint.diff_computed',
              metadata: {
                source: { kind: 'turnCheckpoint' },
                sourceKey: 'turnCheckpoint:turn_1:checkpoint.diff_computed',
                checkpointReceiptId: 'checkpoint.diff_computed',
              },
            },
          },
          permissionMode: 'read_only',
          retentionPolicy: 'ephemeral',
          runClass: 'bounded',
          ioMode: 'streaming',
        },
        parentProvider: TEST_BACKEND_ID,
        sendAcp: async () => {},
        streamedTranscriptSession: null,
        createRuntime,
        getNowMs: () => 1_700_000_000_000,
        budgetRegistry: null,
        runs,
        controllers,
        enqueueMarkerWrite: async () => {},
        writeActivityMarker: async () => {},
        finishRun: async () => {},
        executeBoundedRun,
        send: async () => ({ ok: true }),
        voiceAgentManager,
      });

      expect(createRuntime).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => {
        expect(executeBoundedRun).toHaveBeenCalledTimes(1);
      });
    } finally {
      await voiceAgentManager.dispose();
    }
  });

  it('uses the applied per-start contribution snapshot for structured output recovery instead of the stale manifest singleton', async () => {
    const runs = new Map<string, ExecutionRunState>();
    const controllers = new Map<string, ExecutionRunController>();
    const voiceAgentManager = new VoiceAgentManager({
      createRuntime: () => {
        throw new Error('voice runtime should not be used by plan runs');
      },
    });

    try {
      const executeBoundedRun = vi.fn<StartExecutionRunArgs['executeBoundedRun']>(async () => {});
      await startExecutionRun({
        params: {
          sessionId: 'session_1',
          intent: 'plan',
          backendTarget: { kind: 'builtInAgent', agentId: TEST_BACKEND_ID },
          instructions: 'Plan the implementation.',
          permissionMode: 'read_only',
          retentionPolicy: 'ephemeral',
          runClass: 'bounded',
          ioMode: 'request_response',
        },
        parentProvider: TEST_BACKEND_ID,
        sendAcp: async () => {},
        streamedTranscriptSession: null,
        contributions: {
          agentDefinitionsById: new Map(),
        },
        createRuntime: () => createProvisioningRuntime(),
        getNowMs: () => 1_700_000_000_000,
        budgetRegistry: null,
        runs,
        controllers,
        enqueueMarkerWrite: async () => {},
        writeActivityMarker: async () => {},
        finishRun: async () => {},
        executeBoundedRun,
        send: async () => ({ ok: true }),
        voiceAgentManager,
      });

      await vi.waitFor(() => {
        expect(executeBoundedRun).toHaveBeenCalledTimes(1);
      });
      expect(executeBoundedRun.mock.calls[0]?.[0].params).not.toHaveProperty('structuredOutputRecovery');
    } finally {
      await voiceAgentManager.dispose();
    }
  });

  it('does not retain structured output recovery after the applied generation disables or uninstalls the Agent', async () => {
    const runs = new Map<string, ExecutionRunState>();
    const controllers = new Map<string, ExecutionRunController>();
    const voiceAgentManager = new VoiceAgentManager({
      createRuntime: () => {
        throw new Error('voice runtime should not be used by plan runs');
      },
    });

    try {
      const executeBoundedRun = vi.fn<StartExecutionRunArgs['executeBoundedRun']>(async () => {});
      await startExecutionRun({
        params: {
          sessionId: 'session_1',
          intent: 'plan',
          backendTarget: { kind: 'builtInAgent', agentId: TEST_BACKEND_ID },
          instructions: 'Plan the implementation.',
          permissionMode: 'read_only',
          retentionPolicy: 'ephemeral',
          runClass: 'bounded',
          ioMode: 'request_response',
        },
        parentProvider: TEST_BACKEND_ID,
        sendAcp: async () => {},
        streamedTranscriptSession: null,
        contributions: {
          agentDefinitionsById: new Map(),
                  },
        createRuntime: () => createProvisioningRuntime(),
        getNowMs: () => 1_700_000_000_000,
        budgetRegistry: null,
        runs,
        controllers,
        enqueueMarkerWrite: async () => {},
        writeActivityMarker: async () => {},
        finishRun: async () => {},
        executeBoundedRun,
        send: async () => ({ ok: true }),
        voiceAgentManager,
      });

      await vi.waitFor(() => {
        expect(executeBoundedRun).toHaveBeenCalledTimes(1);
      });
      expect(executeBoundedRun.mock.calls[0]?.[0].params).not.toHaveProperty(
        'structuredOutputRecovery',
      );
    } finally {
      await voiceAgentManager.dispose();
    }
  });

  it('charges scm_commit_message execution runs to the shared one-shot budget', async () => {
    const budgetRegistry = new ExecutionBudgetRegistry({
      maxConcurrentExecutionRuns: null,
      maxConcurrentOneShotTasks: 1,
    });
    const runs = new Map<string, ExecutionRunState>();
    const controllers = new Map<string, ExecutionRunController>();
    const voiceAgentManager = new VoiceAgentManager({
      createRuntime: () => {
        throw new Error('voice runtime should not be used by scm_commit_message runs');
      },
    });

    const startArgs = {
      params: {
        sessionId: 'parent_session_1',
        intent: 'scm_commit_message',
        backendTarget: { kind: 'builtInAgent', agentId: TEST_BACKEND_ID },
        permissionMode: 'no_tools',
        retentionPolicy: 'ephemeral',
        runClass: 'bounded',
        ioMode: 'request_response',
      },
      parentProvider: TEST_BACKEND_ID,
      sendAcp: async () => {},
      streamedTranscriptSession: null,
      createRuntime: () => createProvisioningRuntime(),
      getNowMs: () => 1_700_000_000_000,
      budgetRegistry,
      runs,
      controllers,
      enqueueMarkerWrite: async () => {},
      writeActivityMarker: async () => {},
      finishRun: async () => {},
      executeBoundedRun: async () => {},
      send: async () => ({ ok: true }),
      voiceAgentManager,
    } as const;

    try {
      const first = await startExecutionRun(startArgs);
      expect(first.runId).toMatch(/^run_/);
      expect(budgetRegistry.getInFlightSnapshot()).toEqual({
        executionRuns: 0,
        oneShotTasks: 1,
      });

      await expect(startExecutionRun(startArgs)).rejects.toMatchObject({
        code: 'execution_run_budget_exceeded',
      });
    } finally {
      for (const runId of runs.keys()) {
        budgetRegistry.releaseExecutionRun(runId);
      }
      await voiceAgentManager.dispose();
    }
  });

  it('releases the acquired execution budget when runtime creation fails before controller registration', async () => {
    const budgetRegistry = new ExecutionBudgetRegistry({
      maxConcurrentExecutionRuns: 1,
      maxConcurrentOneShotTasks: null,
    });
    const runs = new Map<string, ExecutionRunState>();
    const controllers = new Map<string, ExecutionRunController>();
    const voiceAgentManager = new VoiceAgentManager({
      createRuntime: () => {
        throw new Error('voice runtime should not be used by delegate runs');
      },
    });

    try {
      await expect(startExecutionRun({
        params: {
          sessionId: 'parent_session_1',
          intent: 'delegate',
          backendTarget: { kind: 'builtInAgent', agentId: TEST_BACKEND_ID },
          permissionMode: 'read_only',
          retentionPolicy: 'ephemeral',
          runClass: 'long_lived',
          ioMode: 'request_response',
        },
        parentProvider: TEST_BACKEND_ID,
        sendAcp: async () => {},
        streamedTranscriptSession: null,
        createRuntime: () => {
          throw new Error('runtime creation failed');
        },
        getNowMs: () => 1_700_000_000_000,
        budgetRegistry,
        runs,
        controllers,
        enqueueMarkerWrite: async () => {},
        writeActivityMarker: async () => {},
        finishRun: async () => {},
        executeBoundedRun: async () => {},
        send: async () => ({ ok: true }),
        voiceAgentManager,
      })).rejects.toThrow('runtime creation failed');

      expect(budgetRegistry.getInFlightSnapshot()).toEqual({
        executionRuns: 0,
        oneShotTasks: 0,
      });
      expect(controllers.size).toBe(0);
    } finally {
      await voiceAgentManager.dispose();
    }
  });

  it('returns the accepted handle, then releases capacity when asynchronous resume support inspection fails', async () => {
    const budgetRegistry = new ExecutionBudgetRegistry({
      maxConcurrentExecutionRuns: 1,
      maxConcurrentOneShotTasks: null,
    });
    const runs = new Map<string, ExecutionRunState>();
    const controllers = new Map<string, ExecutionRunController>();
    const finishRun = vi.fn(async (runId: string, next) => {
      const current = runs.get(runId);
      if (current) runs.set(runId, { ...current, ...next });
      budgetRegistry.releaseExecutionRun(runId);
    });
    const runtime = {
      ...createProvisioningRuntime(),
      readResumeSupport: async () => {
        throw new Error('resume support inspection failed');
      },
    } satisfies TestExecutionRunHostRuntime;
    const voiceAgentManager = new VoiceAgentManager({
      createRuntime: () => {
        throw new Error('voice runtime should not be used by delegate runs');
      },
    });

    try {
      const started = await startExecutionRun({
        params: {
          sessionId: 'parent_session_1',
          intent: 'delegate',
          backendTarget: { kind: 'builtInAgent', agentId: TEST_BACKEND_ID },
          permissionMode: 'read_only',
          retentionPolicy: 'ephemeral',
          runClass: 'long_lived',
          ioMode: 'request_response',
        },
        parentProvider: TEST_BACKEND_ID,
        sendAcp: async () => {},
        streamedTranscriptSession: null,
        createRuntime: () => runtime,
        getNowMs: () => 1_700_000_000_000,
        budgetRegistry,
        runs,
        controllers,
        enqueueMarkerWrite: async () => {},
        writeActivityMarker: async () => {},
        finishRun,
        executeBoundedRun: async () => {},
        send: async () => ({ ok: true }),
        voiceAgentManager,
      });

      await vi.waitFor(() => expect(finishRun).toHaveBeenCalledOnce());

      expect(budgetRegistry.getInFlightSnapshot()).toEqual({
        executionRuns: 0,
        oneShotTasks: 0,
      });
      expect(runs.get(started.runId)).toMatchObject({
        status: 'failed',
        error: { code: 'execution_run_failed', message: 'resume support inspection failed' },
      });
      // Host terminal truth precedes detached provider cleanup. Observe the
      // fixture's real disposal lifetime instead of its scheduling turn.
      await vi.waitFor(() => {
        expect(controllers.size).toBe(0);
        expect(runtime.getRuntimeLifetimeSignal().aborted).toBe(true);
      });
    } finally {
      await voiceAgentManager.dispose();
    }
  });

  it('streams scm_diff_summary progress while keeping summaryMarkdown buffered as final output', async () => {
    const runs = new Map<string, ExecutionRunState>();
    const controllers = new Map<string, ExecutionRunController>();
    const sent: Array<{ body: ACPMessageData; meta?: Record<string, unknown> }> = [];
    const commits: Array<{ body: ACPMessageData; localId: string; meta?: Record<string, unknown> }> = [];
    const voiceAgentManager = new VoiceAgentManager({
      createRuntime: () => {
        throw new Error('voice runtime should not be used by scm_diff_summary runs');
      },
    });
    let finishResolve!: () => void;
    const finished = new Promise<void>((resolve) => {
      finishResolve = resolve;
    });

    try {
      const started = await startExecutionRun({
        params: {
          sessionId: 'parent_session_1',
          intent: 'scm_diff_summary',
          backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
          modelId: readOfferedSummaryModelId(),
          instructions: 'Summarize the checkpoint.',
          intentInput: {
            cwd: '/repo',
            source: { kind: 'turnCheckpoint' },
            sourceKey: 'turnCheckpoint:turn_1:checkpoint.diff_computed',
            checkpointReceiptId: 'checkpoint.diff_computed',
            metadata: {
              source: { kind: 'turnCheckpoint' },
              sourceKey: 'turnCheckpoint:turn_1:checkpoint.diff_computed',
              turnId: 'turn_1',
              checkpointReceiptId: 'checkpoint.diff_computed',
              contentConfidence: 'exact',
              attributionScope: 'shared_worktree',
            },
          },
          permissionMode: 'read_only',
          retentionPolicy: 'ephemeral',
          runClass: 'bounded',
          ioMode: 'streaming',
        },
        parentProvider: TEST_BACKEND_ID,
        sendAcp: async (_provider, body, opts) => {
          sent.push({ body, meta: opts?.meta });
        },
        streamedTranscriptSession: {
          enqueueAgentMessageCommitted: async (_provider, body, opts) => {
            commits.push({ body, localId: opts.localId, meta: opts.meta });
            return { persisted: true, delivered: false };
          },
        },
        createRuntime: () => createScmDiffSummaryStreamingRuntime(),
        getNowMs: () => 1_700_000_000_000,
        budgetRegistry: null,
        runs,
        controllers,
        enqueueMarkerWrite: async () => {},
        writeActivityMarker: async () => {},
        finishRun: async (runId, next, toolResult, structuredMeta?: ExecutionRunStructuredMeta) => {
          const current = runs.get(runId);
          if (current) {
            runs.set(runId, {
              ...current,
              ...next,
              latestToolResult: toolResult.output,
              ...(structuredMeta ? { structuredMeta } : {}),
            });
          }
          finishResolve();
        },
        executeBoundedRun: (args) =>
          executeBoundedBackendRun({
            ...args,
            controllers,
            sendAcp: async (_provider, body, opts) => {
              sent.push({ body, meta: opts?.meta });
            },
            parentProvider: TEST_BACKEND_ID,
            getNowMs: () => 1_700_000_000_001,
            boundedTimeoutMs: null,
            finishRun: async (runId, next, toolResult, structuredMeta) => {
              const current = runs.get(runId);
              if (current) {
                runs.set(runId, {
                  ...current,
                  ...next,
                  latestToolResult: toolResult.output,
                  ...(structuredMeta ? { structuredMeta } : {}),
                });
              }
              finishResolve();
            },
          }),
        send: async () => ({ ok: true }),
        voiceAgentManager,
      });

      await finished;

      const finalRun = runs.get(started.runId);
      expect(finalRun?.status).toBe('succeeded');
      expect(finalRun?.latestToolResult).toMatchObject({
        success: true,
        summaryMarkdown: '## Summary\n\nChanged src/a.ts.',
      });

      const sidechainCommits = commits.filter(
        (row): row is AcpCommittedMessage => isAcpCommittedMessage(row) && row.body.sidechainId === started.sidechainId,
      );
      expect(sidechainCommits.length).toBeGreaterThanOrEqual(1);
      const streamedText = sidechainCommits
        .map((row) => row.body.message)
        .join('');
      expect(streamedText).toContain('Inspecting checkpoint diff evidence');
      expect(streamedText).not.toContain('## Summary');
      expect(sidechainCommits[0]?.meta?.happierStreamSegmentV1).toMatchObject({ segmentState: 'streaming' });
      expect(sidechainCommits.at(-1)?.meta?.happierStreamSegmentV1).toMatchObject({ segmentState: 'complete' });

      const nonStreamingMessages = sent.filter(
        (row) => row.body.type === 'message' && row.body.sidechainId === started.sidechainId,
      );
      expect(nonStreamingMessages).toHaveLength(0);
    } finally {
      await voiceAgentManager.dispose();
    }
  });

  it('returns a long-lived run handle before lazy resume-capability discovery without imposing an environment deadline', async () => {
    const previousTimeout = process.env.HAPPIER_EXECUTION_RUN_BACKEND_PROVISION_TIMEOUT_MS;
    process.env.HAPPIER_EXECUTION_RUN_BACKEND_PROVISION_TIMEOUT_MS = '10';
    const runs = new Map<string, ExecutionRunState>();
    const controllers = new Map<string, ExecutionRunController>();
    const finishRun = vi.fn(async (runId: string, next) => {
      const current = runs.get(runId);
      if (!current) return;
      runs.set(runId, { ...current, ...next });
    });
    const voiceAgentManager = new VoiceAgentManager({
      createRuntime: () => {
        throw new Error('voice runtime should not be used by delegate runs');
      },
    });

    try {
      let resolveResumeSupport!: () => void;
      const resumeSupportReady = new Promise<void>((resolve) => {
        resolveResumeSupport = resolve;
      });
      const baseRuntime = createTestExecutionRunHostRuntime({
        onSendPrompt: async () => {},
        onWaitForTurnCompletion: async () => {},
      });
      const delayedRuntime = Object.freeze({
        ...baseRuntime,
        async readResumeSupport() {
          await resumeSupportReady;
          return true;
        },
      });
      const createRuntime = vi.fn(() => delayedRuntime);

      const startPromise = startExecutionRun({
        params: {
          sessionId: 'session_1',
          intent: 'delegate',
          backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
          instructions: 'Long-lived run with a hanging backend.',
          permissionMode: 'workspace_write',
          retentionPolicy: 'resumable',
          runClass: 'long_lived',
          ioMode: 'streaming',
        },
        parentProvider: TEST_BACKEND_ID,
        sendAcp: async () => {},
        streamedTranscriptSession: null,
        createRuntime,
        getNowMs: () => 1_700_000_000_000,
        budgetRegistry: null,
        runs,
        controllers,
        enqueueMarkerWrite: async () => {},
        writeActivityMarker: async () => {},
        finishRun,
        executeBoundedRun: async () => {},
        send: async () => ({ ok: true }),
        voiceAgentManager,
      });

      const startOutcome = await Promise.race([
        startPromise.then((started) => ({ kind: 'started' as const, started })),
        new Promise<{ kind: 'still_waiting' }>((resolve) => {
          setTimeout(() => resolve({ kind: 'still_waiting' }), 30);
        }),
      ]);
      resolveResumeSupport();
      expect(startOutcome).toMatchObject({ kind: 'started' });
      expect(controllers.size).toBe(1);
      expect(finishRun).not.toHaveBeenCalled();
      if (startOutcome.kind === 'started') {
        const controller = controllers.get(startOutcome.started.runId);
        if (controller?.kind === 'backend') {
          await (controller as typeof controller & { provisioningPromise?: Promise<void> }).provisioningPromise;
        }
      }
    } finally {
      if (previousTimeout === undefined) {
        delete process.env.HAPPIER_EXECUTION_RUN_BACKEND_PROVISION_TIMEOUT_MS;
      } else {
        process.env.HAPPIER_EXECUTION_RUN_BACKEND_PROVISION_TIMEOUT_MS = previousTimeout;
      }
      await voiceAgentManager.dispose();
    }
  });

  it('keeps initial detached work busy after provisioning and orders a follow-up after completion', async () => {
    let releaseProvision!: () => void;
    let markProvisionStarted!: () => void;
    let releaseInitialTurn!: () => void;
    const initialTurnGate = new Promise<void>((resolve) => {
      releaseInitialTurn = resolve;
    });
    const provisionGate = new Promise<void>((resolve) => {
      releaseProvision = resolve;
    });
    const provisionStarted = new Promise<void>((resolve) => {
      markProvisionStarted = resolve;
    });
    const prompts: string[] = [];
    const runtime = createTestExecutionRunHostRuntime({
      runtimeId: 'provider-session-1',
      resumeSupported: true,
      onProvisionRuntime: async () => {
        markProvisionStarted();
        await provisionGate;
      },
      onSendPrompt: async (_sessionId, prompt) => {
        prompts.push(prompt);
      },
      onWaitForTurnCompletion: async () => {
        if (prompts.length === 1) await initialTurnGate;
      },
    });
    const runs = new Map<string, ExecutionRunState>();
    const controllers = new Map<string, ExecutionRunController>();
    const finishRun = vi.fn(async (runId: string, next) => {
      const current = runs.get(runId);
      if (current) runs.set(runId, { ...current, ...next });
    });
    const send = async (
      runId: string,
      params: Parameters<typeof sendBackendLongLivedRun>[0]['params'],
    ) => await sendBackendLongLivedRun({
      runId,
      params,
      runs,
      controllers,
      budgetRegistry: null,
      createRuntime: () => runtime,
      maxTurns: null,
      getNowMs: () => 1_700_000_000_001,
      finishRun,
      sendAcp: async () => {},
      parentProvider: TEST_BACKEND_ID,
      streamedTranscriptSession: null,
      writeActivityMarker: async () => {},
    });
    const voiceAgentManager = new VoiceAgentManager({
      createRuntime: () => {
        throw new Error('voice runtime should not be used by detached agent runs');
      },
    });
    const startPromise = startExecutionRun({
      params: {
        sessionId: null,
        intent: 'agent',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        instructions: 'Initial work.',
        permissionMode: 'read_only',
        retentionPolicy: 'resumable',
        runClass: 'long_lived',
        ioMode: 'request_response',
      },
      parentProvider: TEST_BACKEND_ID,
      sendAcp: async () => {},
      streamedTranscriptSession: null,
      createRuntime: () => runtime,
      getNowMs: () => 1_700_000_000_000,
      budgetRegistry: null,
      runs,
      controllers,
      enqueueMarkerWrite: async () => {},
      writeActivityMarker: async () => {},
      finishRun,
      executeBoundedRun: async () => {},
      send,
      voiceAgentManager,
    });

    try {
      await provisionStarted;
      const startOutcome = await Promise.race([
        startPromise.then((started) => ({ kind: 'started' as const, started })),
        new Promise<{ kind: 'still_waiting' }>((resolve) => {
          setTimeout(() => resolve({ kind: 'still_waiting' }), 30);
        }),
      ]);
      const followUp = startOutcome.kind === 'started'
        ? send(startOutcome.started.runId, { message: 'Follow-up work.' })
        : Promise.resolve({ ok: false });
      expect(prompts).toEqual([]);

      releaseProvision();
      const started = await startPromise;
      await expect(followUp).resolves.toMatchObject({ ok: false, errorCode: 'execution_run_busy' });
      expect(startOutcome).toMatchObject({ kind: 'started', started: { runId: started.runId } });
      expect(prompts).toHaveLength(1);
      releaseInitialTurn();
      await vi.waitFor(() => {
        const controller = controllers.get(started.runId);
        expect(controller?.kind).toBe('backend');
        if (controller?.kind === 'backend') expect(controller.turnInFlight).toBe(false);
      });
      await expect(send(started.runId, { message: 'Follow-up work.' })).resolves.toEqual({ ok: true });
      await vi.waitFor(() => expect(prompts).toHaveLength(2));
      expect(prompts[0]).toContain('Initial work.');
      expect(prompts[1]).toBe('Follow-up work.');
      await stopExecutionRun({
        runId: started.runId,
        runs,
        controllers,
        voiceAgentManager,
        getNowMs: () => 1_700_000_000_002,
        finishRun,
      });
    } finally {
      releaseProvision();
      releaseInitialTurn();
      await voiceAgentManager.dispose();
    }
  });

  it('does not let a rejected bounded controller occurrence dispose or delete its successor', async () => {
    let rejectProvision!: (error: Error) => void;
    let markProvisionStarted!: () => void;
    const provisionStarted = new Promise<void>((resolve) => {
      markProvisionStarted = resolve;
    });
    const provisioning = new Promise<never>((_resolve, reject) => {
      rejectProvision = reject;
    });
    const oldRuntime = createTestExecutionRunHostRuntime({
      onProvisionRuntime: async () => {
        markProvisionStarted();
        await provisioning;
      },
      onSendPrompt: async () => {},
      onWaitForTurnCompletion: async () => {},
    });
    const successorDispose = vi.fn();
    const successorRuntime = createTestExecutionRunHostRuntime({
      onSendPrompt: async () => {},
      onWaitForTurnCompletion: async () => {},
      onDispose: successorDispose,
    });
    const controllers = new Map<string, ExecutionRunController>();
    const runs = new Map<string, ExecutionRunState>();
    const finishRun = vi.fn();
    const voiceAgentManager = new VoiceAgentManager({
      createRuntime: () => {
        throw new Error('voice runtime should not be used by bounded delegate runs');
      },
    });

    try {
      const started = await startExecutionRun({
        params: {
          sessionId: 'session_1',
          intent: 'delegate',
          backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
          permissionMode: 'workspace_write',
          retentionPolicy: 'ephemeral',
          runClass: 'bounded',
          ioMode: 'request_response',
        },
        parentProvider: TEST_BACKEND_ID,
        sendAcp: async () => {},
        streamedTranscriptSession: null,
        createRuntime: () => oldRuntime,
        getNowMs: () => 1_700_000_000_000,
        budgetRegistry: null,
        runs,
        controllers,
        enqueueMarkerWrite: async () => {},
        writeActivityMarker: async () => {},
        finishRun,
        executeBoundedRun: async () => {},
        send: async () => ({ ok: true }),
        voiceAgentManager,
      });
      const oldController = controllers.get(started.runId);
      if (!oldController || oldController.kind !== 'backend') {
        throw new Error('expected old backend controller occurrence');
      }
      await provisionStarted;
      const successorResolveTerminal = vi.fn();
      const successor = {
        ...oldController,
        backend: successorRuntime,
        resolveTerminal: successorResolveTerminal,
      } satisfies typeof oldController;
      controllers.set(started.runId, successor);

      rejectProvision(new Error('old provisioning rejected'));
      await vi.waitFor(() => expect(finishRun).toHaveBeenCalledOnce());

      expect(controllers.get(started.runId)).toBe(successor);
      expect(successorDispose).not.toHaveBeenCalled();
      expect(successorResolveTerminal).not.toHaveBeenCalled();
    } finally {
      await voiceAgentManager.dispose();
    }
  });

  it('cancels a bounded child that finishes provisioning after the run was stopped', async () => {
    let resolveProvision!: () => void;
    let markProvisionStarted!: () => void;
    const provisionStarted = new Promise<void>((resolve) => {
      markProvisionStarted = resolve;
    });
    const provisioning = new Promise<void>((resolve) => {
      resolveProvision = resolve;
    });
    const cancel = vi.fn();
    const dispose = vi.fn();
    const executeBoundedRun = vi.fn();
    const runtime = createTestExecutionRunHostRuntime({
      runtimeId: 'late_child_session',
      onProvisionRuntime: async () => {
        markProvisionStarted();
        await provisioning;
      },
      onCancel: cancel,
      onDispose: dispose,
    });
    const controllers = new Map<string, ExecutionRunController>();
    const runs = new Map<string, ExecutionRunState>();
    const finishRun = vi.fn(async (runId: string, next) => {
      const current = runs.get(runId);
      if (current) runs.set(runId, { ...current, ...next });
    });
    const voiceAgentManager = new VoiceAgentManager({
      createRuntime: () => {
        throw new Error('voice runtime should not be used by bounded delegate runs');
      },
    });

    try {
      const started = await startExecutionRun({
        params: {
          sessionId: 'session_1',
          intent: 'delegate',
          backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
          permissionMode: 'workspace_write',
          retentionPolicy: 'ephemeral',
          runClass: 'bounded',
          ioMode: 'request_response',
        },
        parentProvider: TEST_BACKEND_ID,
        sendAcp: async () => {},
        streamedTranscriptSession: null,
        createRuntime: () => runtime,
        getNowMs: () => 1_700_000_000_000,
        budgetRegistry: null,
        runs,
        controllers,
        enqueueMarkerWrite: async () => {},
        writeActivityMarker: async () => {},
        finishRun,
        executeBoundedRun,
        send: async () => ({ ok: true }),
        voiceAgentManager,
      });

      await provisionStarted;
      await expect(stopExecutionRun({
        runId: started.runId,
        runs,
        controllers,
        voiceAgentManager,
        getNowMs: () => 1_700_000_000_001,
        finishRun,
      })).resolves.toEqual({ ok: true });
      resolveProvision();

      await vi.waitFor(() => expect(cancel).toHaveBeenCalledWith('late_child_session'));
      expect(executeBoundedRun).not.toHaveBeenCalled();
      expect(dispose).toHaveBeenCalled();
      expect(runs.get(started.runId)?.status).toBe('cancelled');
    } finally {
      await voiceAgentManager.dispose();
    }
  });

  it('registers Voice control before provisioning so stop retires the provisional runtime immediately', async () => {
    let releaseProvision!: () => void;
    let provisionStarted!: () => void;
    const provisionGate = new Promise<void>((resolve) => {
      releaseProvision = resolve;
    });
    const provisionStartedPromise = new Promise<void>((resolve) => {
      provisionStarted = resolve;
    });
    const dispose = vi.fn(async () => {});
    const runtime = createTestExecutionRunHostRuntime({
      runtimeId: 'voice-provisioning',
      onProvisionRuntime: async () => {
        provisionStarted();
        await provisionGate;
      },
      onDispose: dispose,
    });
    const controllers = new Map<string, ExecutionRunController>();
    const runs = new Map<string, ExecutionRunState>();
    const finishRun = vi.fn(async (runId: string, next) => {
      const current = runs.get(runId);
      if (current) runs.set(runId, { ...current, ...next });
    });
    const voiceAgentManager = new VoiceAgentManager({ createRuntime: () => runtime });

    try {
      const startPromise = startExecutionRun({
        params: {
          sessionId: 'session_1',
          intent: 'voice_agent',
          backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
          permissionMode: 'read_only',
          retentionPolicy: 'resumable',
          runClass: 'long_lived',
          ioMode: 'streaming',
        },
        parentProvider: TEST_BACKEND_ID,
        sendAcp: async () => {},
        streamedTranscriptSession: null,
        createRuntime: () => runtime,
        getNowMs: () => 1_700_000_000_000,
        budgetRegistry: null,
        runs,
        controllers,
        enqueueMarkerWrite: async () => {},
        writeActivityMarker: async () => {},
        finishRun,
        executeBoundedRun: async () => {},
        send: async () => ({ ok: true }),
        voiceAgentManager,
      });

      await provisionStartedPromise;
      const runId = [...runs.keys()][0]!;
      expect(controllers.get(runId)).toMatchObject({ kind: 'voice_agent', voiceAgentId: runId });

      await expect(stopExecutionRun({
        runId,
        runs,
        controllers,
        voiceAgentManager,
        getNowMs: () => 1_700_000_000_001,
        finishRun,
      })).resolves.toEqual({ ok: true });
      await vi.waitFor(() => expect(dispose).toHaveBeenCalledTimes(1));
      expect(runs.get(runId)?.status).toBe('cancelled');

      releaseProvision();
      await expect(startPromise).resolves.toMatchObject({ runId });
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(finishRun).toHaveBeenCalledTimes(1);
    } finally {
      releaseProvision();
      await voiceAgentManager.dispose();
    }
  });

  it('registers Voice control before READY so stop retires the provisional runtime without waiting for READY', async () => {
    let releaseReady!: () => void;
    let readyWaitStarted!: () => void;
    const readyGate = new Promise<void>((resolve) => {
      releaseReady = resolve;
    });
    const readyWaitStartedPromise = new Promise<void>((resolve) => {
      readyWaitStarted = resolve;
    });
    const dispose = vi.fn(async () => {});
    let runtime: TestExecutionRunHostRuntime;
    runtime = createTestExecutionRunHostRuntime({
      runtimeId: 'voice-ready',
      onSendPrompt: async () => {
        runtime.emitMessage({ type: 'model-output', fullText: 'READY' });
      },
      onWaitForTurnCompletion: async () => {
        readyWaitStarted();
        await readyGate;
      },
      onDispose: dispose,
    });
    const controllers = new Map<string, ExecutionRunController>();
    const runs = new Map<string, ExecutionRunState>();
    const finishRun = vi.fn(async (runId: string, next) => {
      const current = runs.get(runId);
      if (current) runs.set(runId, { ...current, ...next });
    });
    const voiceAgentManager = new VoiceAgentManager({ createRuntime: () => runtime });

    try {
      const startPromise = startExecutionRun({
        params: {
          sessionId: 'session_1',
          intent: 'voice_agent',
          backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
          permissionMode: 'read_only',
          retentionPolicy: 'resumable',
          runClass: 'long_lived',
          ioMode: 'streaming',
          bootstrapMode: 'ready_handshake',
        },
        parentProvider: TEST_BACKEND_ID,
        sendAcp: async () => {},
        streamedTranscriptSession: null,
        createRuntime: () => runtime,
        getNowMs: () => 1_700_000_000_000,
        budgetRegistry: null,
        runs,
        controllers,
        enqueueMarkerWrite: async () => {},
        writeActivityMarker: async () => {},
        finishRun,
        executeBoundedRun: async () => {},
        send: async () => ({ ok: true }),
        voiceAgentManager,
      });

      await readyWaitStartedPromise;
      const runId = [...runs.keys()][0]!;
      expect(controllers.get(runId)).toMatchObject({ kind: 'voice_agent', voiceAgentId: runId });

      await expect(stopExecutionRun({
        runId,
        runs,
        controllers,
        voiceAgentManager,
        getNowMs: () => 1_700_000_000_001,
        finishRun,
      })).resolves.toEqual({ ok: true });
      await vi.waitFor(() => expect(dispose).toHaveBeenCalledTimes(1));
      expect(runs.get(runId)?.status).toBe('cancelled');

      releaseReady();
      await expect(startPromise).resolves.toMatchObject({ runId });
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(finishRun).toHaveBeenCalledTimes(1);
    } finally {
      releaseReady();
      await voiceAgentManager.dispose();
    }
  });

  it('cancels a long-lived child that finishes provisioning after the run was stopped', async () => {
    let resolveProvision!: () => void;
    const provisioning = new Promise<void>((resolve) => {
      resolveProvision = resolve;
    });
    const cancel = vi.fn();
    const dispose = vi.fn();
    const send = vi.fn(async () => ({ ok: true }));
    const runtime = createTestExecutionRunHostRuntime({
      runtimeId: 'late_long_lived_child_session',
      onProvisionRuntime: async () => await provisioning,
      onCancel: cancel,
      onDispose: dispose,
    });
    const controllers = new Map<string, ExecutionRunController>();
    const runs = new Map<string, ExecutionRunState>();
    const finishRun = vi.fn(async (runId: string, next) => {
      const current = runs.get(runId);
      if (current) runs.set(runId, { ...current, ...next });
    });
    const voiceAgentManager = new VoiceAgentManager({
      createRuntime: () => {
        throw new Error('voice runtime should not be used by long-lived delegate runs');
      },
    });

    try {
      const startPromise = startExecutionRun({
        params: {
          sessionId: 'session_1',
          intent: 'delegate',
          backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
          instructions: 'Do not dispatch this after cancellation.',
          permissionMode: 'workspace_write',
          retentionPolicy: 'resumable',
          runClass: 'long_lived',
          ioMode: 'request_response',
        },
        parentProvider: TEST_BACKEND_ID,
        sendAcp: async () => {},
        streamedTranscriptSession: null,
        createRuntime: () => runtime,
        getNowMs: () => 1_700_000_000_000,
        budgetRegistry: null,
        runs,
        controllers,
        enqueueMarkerWrite: async () => {},
        writeActivityMarker: async () => {},
        finishRun,
        executeBoundedRun: async () => {},
        send,
        voiceAgentManager,
      });

      await vi.waitFor(() => expect(controllers.size).toBe(1));
      const runId = [...runs.keys()][0]!;
      await expect(stopExecutionRun({
        runId,
        runs,
        controllers,
        voiceAgentManager,
        getNowMs: () => 1_700_000_000_001,
        finishRun,
      })).resolves.toEqual({ ok: true });
      resolveProvision();

      await expect(startPromise).resolves.toMatchObject({ runId });
      expect(cancel).toHaveBeenCalledWith('late_long_lived_child_session');
      expect(dispose).toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
      expect(runs.get(runId)?.status).toBe('cancelled');
      expect(runs.get(runId)?.resumeHandle).toBeNull();
    } finally {
      resolveProvision();
      await voiceAgentManager.dispose();
    }
  });

  it('stops an accepted bounded run while backend resume support is still loading', async () => {
    let resolveResumeSupport!: () => void;
    let resolveResumeSupportStarted!: () => void;
    const resumeSupport = new Promise<void>((resolve) => {
      resolveResumeSupport = resolve;
    });
    const resumeSupportStarted = new Promise<void>((resolve) => {
      resolveResumeSupportStarted = resolve;
    });
    const dispose = vi.fn();
    const executeBoundedRun = vi.fn();
    const baseRuntime = createTestExecutionRunHostRuntime({ onDispose: dispose });
    const runtime = {
      ...baseRuntime,
      async readResumeSupport() {
        resolveResumeSupportStarted();
        await resumeSupport;
        return false;
      },
    } satisfies TestExecutionRunHostRuntime;
    const controllers = new Map<string, ExecutionRunController>();
    const runs = new Map<string, ExecutionRunState>();
    const finishRun = vi.fn(async (runId: string, next) => {
      const current = runs.get(runId);
      if (current) runs.set(runId, { ...current, ...next });
    });
    const voiceAgentManager = new VoiceAgentManager({
      createRuntime: () => {
        throw new Error('voice runtime should not be used by bounded delegate runs');
      },
    });

    try {
      const startPromise = startExecutionRun({
        params: {
          sessionId: 'session_1',
          intent: 'delegate',
          backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
          permissionMode: 'workspace_write',
          retentionPolicy: 'ephemeral',
          runClass: 'bounded',
          ioMode: 'request_response',
        },
        parentProvider: TEST_BACKEND_ID,
        sendAcp: async () => {},
        streamedTranscriptSession: null,
        createRuntime: () => runtime,
        getNowMs: () => 1_700_000_000_000,
        budgetRegistry: null,
        runs,
        controllers,
        enqueueMarkerWrite: async () => {},
        writeActivityMarker: async () => {},
        finishRun,
        executeBoundedRun,
        send: async () => ({ ok: true }),
        voiceAgentManager,
      });

      await resumeSupportStarted;
      const runId = [...runs.keys()][0]!;
      const stopResult = await stopExecutionRun({
        runId,
        runs,
        controllers,
        voiceAgentManager,
        getNowMs: () => 1_700_000_000_001,
        finishRun,
      });
      resolveResumeSupport();
      await startPromise;

      expect(stopResult).toEqual({ ok: true });
      expect(executeBoundedRun).not.toHaveBeenCalled();
      expect(dispose).toHaveBeenCalled();
      expect(runs.get(runId)?.status).toBe('cancelled');
    } finally {
      resolveResumeSupport();
      await voiceAgentManager.dispose();
    }
  });

  it('stops an accepted bounded run while its transcript start is still publishing', async () => {
    let resolveTranscript!: () => void;
    let resolveTranscriptStarted!: () => void;
    const transcript = new Promise<void>((resolve) => {
      resolveTranscript = resolve;
    });
    const transcriptStarted = new Promise<void>((resolve) => {
      resolveTranscriptStarted = resolve;
    });
    const createRuntime = vi.fn(() => createTestExecutionRunHostRuntime());
    const controllers = new Map<string, ExecutionRunController>();
    const runs = new Map<string, ExecutionRunState>();
    const finishRun = vi.fn(async (runId: string, next) => {
      const current = runs.get(runId);
      if (current) runs.set(runId, { ...current, ...next });
    });
    const voiceAgentManager = new VoiceAgentManager({
      createRuntime: () => {
        throw new Error('voice runtime should not be used by bounded delegate runs');
      },
    });

    try {
      const startPromise = startExecutionRun({
        params: {
          sessionId: 'session_1',
          intent: 'delegate',
          backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
          permissionMode: 'workspace_write',
          retentionPolicy: 'ephemeral',
          runClass: 'bounded',
          ioMode: 'request_response',
        },
        parentProvider: TEST_BACKEND_ID,
        sendAcp: async () => {
          resolveTranscriptStarted();
          await transcript;
        },
        streamedTranscriptSession: null,
        createRuntime,
        getNowMs: () => 1_700_000_000_000,
        budgetRegistry: null,
        runs,
        controllers,
        enqueueMarkerWrite: async () => {},
        writeActivityMarker: async () => {},
        finishRun,
        executeBoundedRun: async () => {},
        send: async () => ({ ok: true }),
        voiceAgentManager,
      });

      await transcriptStarted;
      const runId = [...runs.keys()][0]!;
      const stopResult = await stopExecutionRun({
        runId,
        runs,
        controllers,
        voiceAgentManager,
        getNowMs: () => 1_700_000_000_001,
        finishRun,
      });
      resolveTranscript();
      await startPromise;

      expect(stopResult).toEqual({ ok: true });
      expect(createRuntime).not.toHaveBeenCalled();
      expect(runs.get(runId)?.status).toBe('cancelled');
    } finally {
      resolveTranscript();
      await voiceAgentManager.dispose();
    }
  });
});
