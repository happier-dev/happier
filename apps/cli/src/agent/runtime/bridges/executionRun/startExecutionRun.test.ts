import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ACPMessageData } from '@/api/session/sessionMessageTypes';
import type { ExecutionRunController } from '@/agent/executionRuns/controllers/types';
import {
  createTestExecutionRunHostRuntime,
  type TestExecutionRunHostRuntime,
} from '@/agent/runtime/bridges/executionRun/testkit';
import { executeBoundedBackendRun } from './bounded/loop';
import { createLazyExecutionRunHostRuntime } from './hostRuntime/lazy';
import { startExecutionRun } from './startExecutionRun';
import type { ExecutionRunState } from './executionRunTypes';
import type { ExecutionRunStructuredMeta } from '@/agent/executionRuns/profiles/ExecutionRunIntentProfile';
import { VoiceAgentManager } from '@/agent/voice/agent/VoiceAgentManager';
import { ExecutionBudgetRegistry } from '@/daemon/executionBudget/ExecutionBudgetRegistry';

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

const contributionRegistryMock = vi.hoisted(() => ({
  getResolvedContributionRegistry: vi.fn(() => ({
    agentDefinitionsById: new Map(),
      })),
}));

vi.mock('@/plugins/projection/registry/createResolvedContributionRegistry', () => ({
  getResolvedContributionRegistry: contributionRegistryMock.getResolvedContributionRegistry,
}));

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

describe('startExecutionRun', () => {
  beforeEach(() => {
    contributionRegistryMock.getResolvedContributionRegistry.mockReturnValue({
      agentDefinitionsById: new Map(),
          });
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
        getDepthByCallId: () => null,
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
        getDepthByCallId: () => null,
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
        getDepthByCallId: () => null,
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
          intent: 'review',
          backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
          instructions: 'Review this change.',
          permissionMode: 'read_only',
          retentionPolicy: 'ephemeral',
          runClass: 'bounded',
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
        getDepthByCallId: () => null,
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

  it('finishes cached SCM diff-summary runs without creating a backend runtime', async () => {
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
          intentInput: {
            cachedOutput: {
              success: true,
              summaryMarkdown: '## Summary\n\nCached checkpoint.',
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
        finishRun,
        executeBoundedRun: async () => {
          throw new Error('cached diff summary should not execute bounded generation');
        },
        send: async () => ({ ok: true }),
        voiceAgentManager,
        getDepthByCallId: () => null,
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
        getDepthByCallId: () => null,
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

    contributionRegistryMock.getResolvedContributionRegistry.mockReturnValue({
      agentDefinitionsById: new Map(),
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
        getDepthByCallId: () => null,
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

    contributionRegistryMock.getResolvedContributionRegistry.mockReturnValue({
      agentDefinitionsById: new Map(),
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
        getDepthByCallId: () => null,
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
      getDepthByCallId: () => null,
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
        getDepthByCallId: () => null,
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

  it('releases the acquired execution budget and disposes the runtime when resume support inspection fails', async () => {
    const budgetRegistry = new ExecutionBudgetRegistry({
      maxConcurrentExecutionRuns: 1,
      maxConcurrentOneShotTasks: null,
    });
    const runs = new Map<string, ExecutionRunState>();
    const controllers = new Map<string, ExecutionRunController>();
    const dispose = vi.fn(async () => {});
    const runtime = {
      ...createProvisioningRuntime(),
      readResumeSupport: async () => {
        throw new Error('resume support inspection failed');
      },
      dispose,
    } satisfies TestExecutionRunHostRuntime;
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
        createRuntime: () => runtime,
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
        getDepthByCallId: () => null,
      })).rejects.toThrow('resume support inspection failed');

      expect(budgetRegistry.getInFlightSnapshot()).toEqual({
        executionRuns: 0,
        oneShotTasks: 0,
      });
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(controllers.size).toBe(0);
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
          backendTarget: { kind: 'builtInAgent', agentId: TEST_BACKEND_ID },
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
        getDepthByCallId: () => null,
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

  it('QA2-F04: bounds backend session provisioning — a never-settling provision fails the run terminally', async () => {
    const previousTimeout = process.env.HAPPIER_EXECUTION_RUN_BACKEND_PROVISION_TIMEOUT_MS;
    process.env.HAPPIER_EXECUTION_RUN_BACKEND_PROVISION_TIMEOUT_MS = '50';
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
      const hangingRuntime = createLazyExecutionRunHostRuntime({
        resolveRuntime: async () => {
          // Never settles: simulates lazy runtime creation whose process spawn /
          // vendor handshake cannot cooperate with cleanup after host timeout.
          return await new Promise<never>(() => {});
        },
      });
      const createRuntime = vi.fn(() => hangingRuntime);

      await expect(startExecutionRun({
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
        getDepthByCallId: () => null,
      })).rejects.toMatchObject({
        code: 'execution_run_backend_provision_timeout',
        details: { executionRunStart: { v: 1, runCreation: 'outcomeUnknown' } },
      });

      // The run must land terminal-FAILED (not linger "running" with no process).
      expect(finishRun).toHaveBeenCalledTimes(1);
      const failedRun = [...runs.values()][0];
      expect(failedRun).toMatchObject({ status: 'failed' });
      expect(controllers.size).toBe(0);
    } finally {
      if (previousTimeout === undefined) {
        delete process.env.HAPPIER_EXECUTION_RUN_BACKEND_PROVISION_TIMEOUT_MS;
      } else {
        process.env.HAPPIER_EXECUTION_RUN_BACKEND_PROVISION_TIMEOUT_MS = previousTimeout;
      }
      await voiceAgentManager.dispose();
    }
  });

  it('does not let a rejected bounded controller occurrence dispose or delete its successor', async () => {
    let rejectProvision!: (error: Error) => void;
    const provisioning = new Promise<never>((_resolve, reject) => {
      rejectProvision = reject;
    });
    const oldRuntime = createTestExecutionRunHostRuntime({
      onProvisionSession: async () => await provisioning,
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
        getDepthByCallId: () => null,
      });
      const oldController = controllers.get(started.runId);
      if (!oldController || oldController.kind !== 'backend') {
        throw new Error('expected old backend controller occurrence');
      }
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
});
