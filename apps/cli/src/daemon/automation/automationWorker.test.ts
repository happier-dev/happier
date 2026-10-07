import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_AUTOMATION_V3_MAX_ACTIVE_RUNS_PER_MACHINE,
  AutomationRunExecutionRecipeV1Schema,
  AutomationV3WorkerStartResponseSchema,
  type SessionServerStartDispatchResultV1,
  type SessionServerStartIngressRequestV1,
  materializeWorkflowAcceptedSnapshotV1,
  serializeWorkflowStoredContentEnvelopeV1,
  sealWorkflowAcceptedSnapshotStoredEnvelopeV1,
  deriveWorkflowSessionInputLocalIdV2,
} from '@happier-dev/protocol';
import { createProductionWorkflowRunCoordinator } from '@/daemon/workflows/production';
import { createWorkflowRunStorageTestkit, createPlainWorkflowRunKeyCensusFixture } from '@/daemon/workflows/workflowRunStorage.testkit';
import type { Update } from '@/api/types';
import { reloadConfiguration as reloadCapacityConfiguration } from '@/configuration';
import { startAutomationWorker as startCapacityAutomationWorker } from './automationWorker';

const { mockGet, mockPost, mockIsAxiosError, mockCreate } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPost: vi.fn(),
  mockIsAxiosError: vi.fn(() => true),
  mockCreate: vi.fn(),
}));

vi.mock('axios', () => {
  const client = {
    get: (url: string, ...args: unknown[]) => url.endsWith('/worker/run-lifecycle')
      ? Promise.resolve({ data: { sources: [] } }) : mockGet(url, ...args),
    post: mockPost,
    isAxiosError: mockIsAxiosError,
  };

  mockCreate.mockImplementation(() => client);

  return {
    default: {
      ...client,
      create: mockCreate,
    },
    isAxiosError: mockIsAxiosError,
  };
});

vi.mock('./automationTelemetry', () => ({
  logAutomationInfo: () => {},
  logAutomationWarn: () => {},
}));

/**
 * The canonical claim client signs a machine-installation publisher proof before
 * every automation request, so an assignment read or claim only reaches Axios
 * after that asynchronous header work settles. Drain those continuations without
 * moving the clock so timer-boundary assertions stay exact.
 */
async function settleRequestDispatch(): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    await Promise.resolve();
  }
}

async function waitForCondition(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out while waiting for automation worker condition');
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

function createAxios404(url: string) {
  return {
    message: 'Request failed with status code 404',
    response: { status: 404 },
    config: { url },
  };
}

const V3_CLAIM_CURRENTNESS = {
  mode: 'plain' as const,
  version: 7,
  contentKeyFingerprint: null,
};

const V3_START_CURRENTNESS = {
  mode: 'plain' as const,
  version: 8,
  contentKeyFingerprint: null,
};

const DEFAULT_WORKER_SETTINGS = {
  maxActiveRunsPerMachine: DEFAULT_AUTOMATION_V3_MAX_ACTIVE_RUNS_PER_MACHINE,
} as const;

function createAccountCurrentnessResponse(
  witness: typeof V3_CLAIM_CURRENTNESS | typeof V3_START_CURRENTNESS,
  updatedAt: number,
) {
  return {
    ...witness,
    signingKeyFingerprint: null,
    updatedAt,
  };
}

function createV3StartResponse(params: { runId: string; now: number; attempt: number }) {
  return {
    run: {
      id: params.runId,
      automationId: 'automation-1',
      revision: 1,
      triggerId: null,
      triggerRetired: false,
      state: 'running' as const,
      cause: { kind: 'manual' as const, invokedAt: params.now },
      dueAt: params.now,
      claimedAt: params.now,
      startedAt: params.now,
      finishedAt: null,
      claimedByMachineId: 'machine-1',
      leaseExpiresAt: params.now + 30_000,
      attempt: params.attempt,
      errorCode: null,
      producedSessionId: null,
      executionDispatchState: null,
      executionAttempt: 0,
      replyHandoffState: 'none' as const,
      replyHandoffAttempt: 0,
      replyHandoffDueAt: null,
      createdAt: params.now,
      updatedAt: params.now,
    },
    accountCurrentness: V3_START_CURRENTNESS,
  };
}

describe('automationWorker', () => {
  const previousServer = process.env.HAPPIER_SERVER_URL;
  const previousWebapp = process.env.HAPPIER_WEBAPP_URL;
  const previousHomeDir = process.env.HAPPIER_HOME_DIR;

  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();

    if (previousServer === undefined) delete process.env.HAPPIER_SERVER_URL;
    else process.env.HAPPIER_SERVER_URL = previousServer;

    if (previousWebapp === undefined) delete process.env.HAPPIER_WEBAPP_URL;
    else process.env.HAPPIER_WEBAPP_URL = previousWebapp;

    if (previousHomeDir === undefined) delete process.env.HAPPIER_HOME_DIR;
    else process.env.HAPPIER_HOME_DIR = previousHomeDir;
  });

  it('keeps current assignment reads available after a missing endpoint response', async () => {
    process.env.HAPPIER_SERVER_URL = 'https://api.example.test';
    process.env.HAPPIER_WEBAPP_URL = 'https://app.example.test';
    process.env.HAPPIER_HOME_DIR = join(
      os.tmpdir(),
      `happier-automation-worker-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`,
    );

    mockGet.mockImplementation(async (url: string) => { throw createAxios404(url); });
    mockPost.mockResolvedValue({ data: { run: null, automation: null } });

    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();

    const { startAutomationWorker } = await import('./automationWorker');
    const worker = startAutomationWorker({
      token: 'token-1',
      machineId: 'machine-1',
      spawnSession: vi.fn(async () => ({ type: 'error' as const, errorCode: 'SPAWN_FAILED' as const, errorMessage: 'noop' })),
      env: {
        HAPPIER_AUTOMATION_CLAIM_POLL_MS: '1000',
        HAPPIER_AUTOMATION_ASSIGNMENT_REFRESH_MS: '5000',
      } as NodeJS.ProcessEnv,
    });

    await waitForCondition(() => mockGet.mock.calls.length >= 1);
    const previousReads = mockGet.mock.calls.length;
    await worker.refreshAssignments();
    expect(mockGet.mock.calls.length).toBeGreaterThan(previousReads);
    expect(mockGet.mock.calls.map((call) => call[0])).not.toEqual(expect.arrayContaining([
      expect.stringMatching(/\/v2\/automations\//),
    ]));
    worker.stop();
  }, 60_000);

  it('drives exact-row Workflow cancellation recovery from the existing machine update when no live claim owns it', async () => {
    mockGet.mockReset();
    mockPost.mockReset();
    process.env.HAPPIER_SERVER_URL = 'https://api.example.test';
    process.env.HAPPIER_WEBAPP_URL = 'https://app.example.test';
    process.env.HAPPIER_HOME_DIR = join(
      os.tmpdir(),
      `happier-automation-worker-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`,
    );
    mockGet
      .mockImplementationOnce((url: unknown) => Promise.reject(createAxios404(String(url))))
      .mockImplementationOnce((url: unknown) => Promise.reject(createAxios404(String(url))));
    const recoverWorkflowRuns = vi.fn(async () => {});

    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();
    const { startAutomationWorker } = await import('./automationWorker');
    const worker = startAutomationWorker({
      token: 'token-1',
      machineId: 'machine-1',
      recoverWorkflowRuns,
      spawnSession: vi.fn(async () => ({ type: 'error' as const, errorCode: 'SPAWN_FAILED' as const, errorMessage: 'noop' })),
      env: {
        HAPPIER_AUTOMATION_CLAIM_POLL_MS: '1000',
        HAPPIER_AUTOMATION_ASSIGNMENT_REFRESH_MS: '5000',
      } as NodeJS.ProcessEnv,
    });

    try {
      worker.handleServerUpdate({
        id: 'u-workflow-cancel',
        seq: 1,
        createdAt: Date.now(),
        body: {
          t: 'automation-run-updated',
          runId: 'workflow-run-1',
          automationId: null,
          state: 'running',
          scheduledAt: Date.now(),
          startedAt: Date.now(),
          finishedAt: null,
          updatedAt: Date.now(),
          machineId: 'machine-1',
          targetMachineId: 'machine-1',
          workflowControl: 'cancel_requested',
        },
      } satisfies Update);
      await vi.waitFor(() => expect(recoverWorkflowRuns).toHaveBeenCalledOnce());
    } finally {
      worker.stop();
    }
  });

  it('reconciles claimable direct runs even when there are no Automation assignments', async () => {
    vi.useFakeTimers();
    try {
      process.env.HAPPIER_SERVER_URL = 'https://api.example.test';
      process.env.HAPPIER_WEBAPP_URL = 'https://app.example.test';
      process.env.HAPPIER_HOME_DIR = join(
        os.tmpdir(),
        `happier-automation-worker-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`,
      );

      mockGet.mockResolvedValue({ data: { assignments: [], settings: DEFAULT_WORKER_SETTINGS } });
      mockPost.mockResolvedValue({ data: { run: null, automation: null } });

      const { reloadConfiguration } = await import('@/configuration');
      reloadConfiguration();

      const { startAutomationWorker } = await import('./automationWorker');
      const worker = startAutomationWorker({
        token: 'token-1',
        machineId: 'machine-1',
        spawnSession: vi.fn(async () => ({ type: 'error' as const, errorCode: 'SPAWN_FAILED' as const, errorMessage: 'noop' })),
        env: {
          HAPPIER_AUTOMATION_ASSIGNMENT_REFRESH_MS: '600000',
          HAPPIER_AUTOMATION_CLAIM_POLL_MS: '1000',
        } as NodeJS.ProcessEnv,
      });

      await worker.refreshAssignments();

      await vi.advanceTimersByTimeAsync(44_999);
      expect(mockPost).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(60_001);
      expect(mockPost).toHaveBeenCalledWith(
        expect.stringContaining('/automations/runs/claim'),
        expect.objectContaining({ machineId: 'machine-1' }),
        expect.anything(),
      );

      worker.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('suppresses assignment refresh while paused and authoritatively refreshes when it resumes', async () => {
    process.env.HAPPIER_SERVER_URL = 'https://api.example.test';
    process.env.HAPPIER_WEBAPP_URL = 'https://app.example.test';
    process.env.HAPPIER_HOME_DIR = join(
      os.tmpdir(),
      `happier-automation-worker-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`,
    );

    mockGet.mockResolvedValue({ data: { assignments: [], settings: DEFAULT_WORKER_SETTINGS } });
    mockPost.mockResolvedValue({ data: { run: null, automation: null } });

    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();

    const { startAutomationWorker } = await import('./automationWorker');
    const worker = startAutomationWorker({
      token: 'token-1',
      machineId: 'machine-1',
      spawnSession: vi.fn(async () => ({ type: 'error' as const, errorCode: 'SPAWN_FAILED' as const, errorMessage: 'noop' })),
      env: {
        HAPPIER_AUTOMATION_ASSIGNMENT_REFRESH_MS: '600000',
        HAPPIER_AUTOMATION_CLAIM_POLL_MS: '1000',
      } as NodeJS.ProcessEnv,
    });

    await worker.refreshAssignments();
    // The worker also fires one unawaited startup refresh. Drain it before the
    // baseline, or a slow cold start lets its request land after the clear and
    // masks a missing resume refresh.
    await settleRequestDispatch();
    mockGet.mockClear();

    worker.pause();
    await worker.refreshAssignments();
    expect(mockGet).not.toHaveBeenCalled();

    worker.resume();
    await settleRequestDispatch();
    expect(mockGet).toHaveBeenCalledTimes(1);

    worker.stop();
  });

  it('reconciles assignments within the 60-second jittered ceiling after an empty successful read', async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(Math, 'random').mockReturnValue(1 - Number.EPSILON);
      process.env.HAPPIER_SERVER_URL = 'https://api.example.test';
      process.env.HAPPIER_WEBAPP_URL = 'https://app.example.test';
      process.env.HAPPIER_HOME_DIR = join(
        os.tmpdir(),
        `happier-automation-worker-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`,
      );

      mockGet.mockResolvedValue({ data: { assignments: [], settings: DEFAULT_WORKER_SETTINGS } });
      mockPost.mockResolvedValue({ data: { run: null, automation: null } });

      const { reloadConfiguration } = await import('@/configuration');
      reloadConfiguration();

      const { startAutomationWorker } = await import('./automationWorker');
      const worker = startAutomationWorker({
        token: 'token-1',
        machineId: 'machine-1',
        spawnSession: vi.fn(async () => ({ type: 'error' as const, errorCode: 'SPAWN_FAILED' as const, errorMessage: 'noop' })),
        env: {
          HAPPIER_AUTOMATION_ASSIGNMENT_REFRESH_MS: '5000',
          HAPPIER_AUTOMATION_CLAIM_POLL_MS: '1000',
        } as NodeJS.ProcessEnv,
      });

      await settleRequestDispatch();
      expect(mockGet).toHaveBeenCalledTimes(1);

      // Advance the clock synchronously so each assertion measures only the timer
      // boundary, then drain the request dispatch that the tick started.
      vi.advanceTimersByTime(59_999);
      await settleRequestDispatch();
      expect(mockGet).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(1);
      await settleRequestDispatch();
      expect(mockGet).toHaveBeenCalledTimes(2);

      worker.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries a failed initial assignment read within the reconciliation window', async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(Math, 'random').mockReturnValue(0);
      process.env.HAPPIER_SERVER_URL = 'https://api.example.test';
      process.env.HAPPIER_WEBAPP_URL = 'https://app.example.test';
      process.env.HAPPIER_HOME_DIR = join(
        os.tmpdir(),
        `happier-automation-worker-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`,
      );

      mockGet
        .mockRejectedValueOnce(new Error('initial assignments read failed'))
        .mockResolvedValue({ data: { assignments: [], settings: DEFAULT_WORKER_SETTINGS } });
      mockPost.mockResolvedValue({ data: { run: null, automation: null } });

      const { reloadConfiguration } = await import('@/configuration');
      reloadConfiguration();

      const { startAutomationWorker } = await import('./automationWorker');
      const worker = startAutomationWorker({
        token: 'token-1',
        machineId: 'machine-1',
        spawnSession: vi.fn(async () => ({ type: 'error' as const, errorCode: 'SPAWN_FAILED' as const, errorMessage: 'noop' })),
        env: {
          HAPPIER_AUTOMATION_ASSIGNMENT_REFRESH_MS: '600000',
          HAPPIER_AUTOMATION_CLAIM_POLL_MS: '1000',
        } as NodeJS.ProcessEnv,
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(mockGet).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(45_000);
      expect(mockGet).toHaveBeenCalledTimes(2);

      worker.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('claims after a queued direct-run wake with an empty Automation assignment cache', async () => {
    vi.useFakeTimers();
    try {
      process.env.HAPPIER_SERVER_URL = 'https://api.example.test';
      process.env.HAPPIER_WEBAPP_URL = 'https://app.example.test';
      process.env.HAPPIER_HOME_DIR = join(
        os.tmpdir(),
        `happier-automation-worker-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`,
      );

      mockGet.mockResolvedValue({ data: { assignments: [], settings: DEFAULT_WORKER_SETTINGS } });
      mockPost.mockResolvedValue({ data: { run: null, automation: null } });

      const { reloadConfiguration } = await import('@/configuration');
      reloadConfiguration();

      const { startAutomationWorker } = await import('./automationWorker');
      const worker = startAutomationWorker({
        token: 'token-1',
        machineId: 'machine-1',
        spawnSession: vi.fn(async () => ({ type: 'error' as const, errorCode: 'SPAWN_FAILED' as const, errorMessage: 'noop' })),
        env: {
          HAPPIER_AUTOMATION_ASSIGNMENT_REFRESH_MS: '600000',
          HAPPIER_AUTOMATION_CLAIM_POLL_MS: '1000',
        } as NodeJS.ProcessEnv,
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(mockGet).toHaveBeenCalledTimes(1);

      worker.handleServerUpdate({
        id: 'u-run',
        seq: 1,
        createdAt: Date.now(),
        body: {
          t: 'automation-run-updated',
          runId: 'run-1',
          automationId: null,
          state: 'queued',
          scheduledAt: Date.now(),
          startedAt: null,
          finishedAt: null,
          updatedAt: Date.now(),
          machineId: null,
          targetMachineId: 'machine-1',
        },
      } as any);

      await vi.advanceTimersByTimeAsync(0);
      expect(mockGet).toHaveBeenCalledTimes(2);
      expect(mockPost).toHaveBeenCalledWith(
        expect.stringContaining('/automations/runs/claim'),
        expect.objectContaining({ machineId: 'machine-1' }),
        expect.anything(),
      );

      worker.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not let an older empty assignment response erase a newer queued-wake assignment', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-02-01T00:00:00.000Z'));
      const now = Date.now();
      process.env.HAPPIER_SERVER_URL = 'https://api.example.test';
      process.env.HAPPIER_WEBAPP_URL = 'https://app.example.test';
      process.env.HAPPIER_HOME_DIR = join(
        os.tmpdir(),
        `happier-automation-worker-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`,
      );

      let resolveOlderAssignments!: (value: {
        data: { assignments: never[]; settings: typeof DEFAULT_WORKER_SETTINGS };
      }) => void;
      let resolveNewerAssignments!: (value: {
        data: {
          assignments: Array<{
            machineId: string;
            automationId: string;
            nextClaimAt: number;
          }>;
          settings: typeof DEFAULT_WORKER_SETTINGS;
        };
      }) => void;
      mockGet
        .mockImplementationOnce(() => new Promise((resolve) => {
          resolveOlderAssignments = resolve;
        }))
        .mockImplementationOnce(() => new Promise((resolve) => {
          resolveNewerAssignments = resolve;
        }));
      mockPost.mockResolvedValue({ data: { run: null, automation: null, accountCurrentness: null } });

      const { reloadConfiguration } = await import('@/configuration');
      reloadConfiguration();

      const { startAutomationWorker } = await import('./automationWorker');
      const worker = startAutomationWorker({
        token: 'token-1',
        machineId: 'machine-1',
        spawnSession: vi.fn(async () => ({ type: 'error' as const, errorCode: 'SPAWN_FAILED' as const, errorMessage: 'noop' })),
        env: {
          HAPPIER_AUTOMATION_ASSIGNMENT_REFRESH_MS: '600000',
          HAPPIER_AUTOMATION_CLAIM_POLL_MS: '1000',
          HAPPIER_AUTOMATION_LEASE_MS: '30000',
        } as NodeJS.ProcessEnv,
      });

      await settleRequestDispatch();
      expect(mockGet).toHaveBeenCalledTimes(1);
      worker.handleServerUpdate({
        id: 'u-run',
        seq: 1,
        createdAt: now,
        body: {
          t: 'automation-run-updated',
          runId: 'run-1',
          automationId: 'automation-1',
          state: 'queued',
          scheduledAt: now,
          startedAt: null,
          finishedAt: null,
          updatedAt: now,
          machineId: null,
          targetMachineId: 'machine-1',
        },
      } as any);
      await vi.advanceTimersByTimeAsync(0);
      await settleRequestDispatch();
      expect(mockGet).toHaveBeenCalledTimes(2);

      resolveNewerAssignments({
        data: {
          assignments: [{
            machineId: 'machine-1',
            automationId: 'automation-1',
            nextClaimAt: now + 60_000,
          }],
          settings: DEFAULT_WORKER_SETTINGS,
        },
      });
      await settleRequestDispatch();

      // Let the stale response settle BEFORE the queued-wake claim timer fires, so
      // the assertion fails if a late older snapshot is allowed to erase the cache.
      resolveOlderAssignments({ data: { assignments: [], settings: DEFAULT_WORKER_SETTINGS } });
      await settleRequestDispatch();

      vi.advanceTimersByTime(0);
      await settleRequestDispatch();

      expect(mockPost).toHaveBeenCalledTimes(1);

      worker.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('checks for direct runs at reconciliation and scheduled runs at V3 nextClaimAt without continuous polling', async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(Math, 'random').mockReturnValue(0);
      vi.setSystemTime(new Date('2026-02-01T00:00:00.000Z'));
      const now = Date.now();

      process.env.HAPPIER_SERVER_URL = 'https://api.example.test';
      process.env.HAPPIER_WEBAPP_URL = 'https://app.example.test';
      process.env.HAPPIER_HOME_DIR = join(
        os.tmpdir(),
        `happier-automation-worker-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`,
      );

      mockGet
        .mockResolvedValueOnce({ data: { assignments: [], settings: DEFAULT_WORKER_SETTINGS } })
        .mockResolvedValueOnce({
          data: {
            assignments: [{
              machineId: 'machine-1',
              automationId: 'automation-1',
              nextClaimAt: now + 60_000,
            }],
            settings: DEFAULT_WORKER_SETTINGS,
          },
        })
        .mockResolvedValue({
          data: {
            assignments: [{
              machineId: 'machine-1',
              automationId: 'automation-1',
              nextClaimAt: now + 60_000,
            }],
            settings: DEFAULT_WORKER_SETTINGS,
          },
        });

      mockPost.mockResolvedValue({ data: { run: null, automation: null, accountCurrentness: null } });

      const { reloadConfiguration } = await import('@/configuration');
      reloadConfiguration();

      const { startAutomationWorker } = await import('./automationWorker');
      const worker = startAutomationWorker({
        token: 'token-1',
        machineId: 'machine-1',
        spawnSession: vi.fn(async () => ({ type: 'error' as const, errorCode: 'SPAWN_FAILED' as const, errorMessage: 'noop' })),
        env: {
          HAPPIER_AUTOMATION_ASSIGNMENT_REFRESH_MS: '600000',
          HAPPIER_AUTOMATION_CLAIM_POLL_MS: '1000',
          HAPPIER_AUTOMATION_LEASE_MS: '30000',
        } as NodeJS.ProcessEnv,
      });

      await worker.refreshAssignments();

      await vi.advanceTimersByTimeAsync(44_999);
      expect(mockPost).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(mockPost).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(16_000);
      expect(mockPost).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(mockPost).toHaveBeenCalledTimes(2);

      worker.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reacts to automation-assignment updates from the server by refreshing assignments', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-02-01T00:00:00.000Z'));

      process.env.HAPPIER_SERVER_URL = 'https://api.example.test';
      process.env.HAPPIER_WEBAPP_URL = 'https://app.example.test';
      process.env.HAPPIER_HOME_DIR = join(
        os.tmpdir(),
        `happier-automation-worker-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`,
      );

      mockGet.mockResolvedValue({ data: { assignments: [], settings: DEFAULT_WORKER_SETTINGS } });
      mockPost.mockResolvedValue({ data: { run: null, automation: null } });

      const { reloadConfiguration } = await import('@/configuration');
      reloadConfiguration();

      const { startAutomationWorker } = await import('./automationWorker');
      const worker = startAutomationWorker({
        token: 'token-1',
        machineId: 'machine-1',
        spawnSession: vi.fn(async () => ({ type: 'error' as const, errorCode: 'SPAWN_FAILED' as const, errorMessage: 'noop' })),
        env: {
          HAPPIER_AUTOMATION_ASSIGNMENT_REFRESH_MS: '600000',
          HAPPIER_AUTOMATION_CLAIM_POLL_MS: '1000',
        } as NodeJS.ProcessEnv,
      });

      // Allow any initial background refresh to complete.
      await vi.advanceTimersByTimeAsync(0);
      const callsBefore = mockGet.mock.calls.length;

      worker.handleServerUpdate({
        id: 'u-1',
        seq: 1,
        createdAt: Date.now(),
        body: {
          t: 'automation-assignment-updated',
          machineId: 'machine-1',
          automationId: 'automation-1',
          enabled: true,
          updatedAt: Date.now(),
        },
      } as any);

      await vi.advanceTimersByTimeAsync(300);
      expect(mockGet.mock.calls.length).toBeGreaterThan(callsBefore);

      worker.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('claims after a queued run wake arrives before assignments refresh catches up', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-02-01T00:00:00.000Z'));
      const now = Date.now();

      process.env.HAPPIER_SERVER_URL = 'https://api.example.test';
      process.env.HAPPIER_WEBAPP_URL = 'https://app.example.test';
      process.env.HAPPIER_HOME_DIR = join(
        os.tmpdir(),
        `happier-automation-worker-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`,
      );

      mockGet
        .mockResolvedValueOnce({ data: { assignments: [], settings: DEFAULT_WORKER_SETTINGS } })
        .mockResolvedValueOnce({
          data: {
            assignments: [{
              machineId: 'machine-1',
              automationId: 'automation-1',
              nextClaimAt: now + 60_000,
            }],
            settings: DEFAULT_WORKER_SETTINGS,
          },
        });
      mockPost.mockResolvedValue({ data: { run: null, automation: null } });

      const { reloadConfiguration } = await import('@/configuration');
      reloadConfiguration();

      const { startAutomationWorker } = await import('./automationWorker');
      const worker = startAutomationWorker({
        token: 'token-1',
        machineId: 'machine-1',
        spawnSession: vi.fn(async () => ({ type: 'error' as const, errorCode: 'SPAWN_FAILED' as const, errorMessage: 'noop' })),
        env: {
          HAPPIER_AUTOMATION_ASSIGNMENT_REFRESH_MS: '600000',
          HAPPIER_AUTOMATION_CLAIM_POLL_MS: '1000',
          HAPPIER_AUTOMATION_LEASE_MS: '30000',
        } as NodeJS.ProcessEnv,
      });

      await vi.advanceTimersByTimeAsync(0);
      mockPost.mockClear();

      worker.handleServerUpdate({
        id: 'u-run',
        seq: 1,
        createdAt: now,
        body: {
          t: 'automation-run-updated',
          runId: 'run-1',
          automationId: 'automation-1',
          state: 'queued',
          scheduledAt: now,
          startedAt: null,
          finishedAt: null,
          updatedAt: now,
          machineId: null,
          targetMachineId: 'machine-1',
        },
      } as any);

      worker.handleServerUpdate({
        id: 'u-assignment',
        seq: 2,
        createdAt: now,
        body: {
          t: 'automation-assignment-updated',
          machineId: 'machine-1',
          automationId: 'automation-1',
          enabled: true,
          updatedAt: now,
        },
      } as any);

      await vi.advanceTimersByTimeAsync(300);

      expect(mockGet.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(mockPost).toHaveBeenCalledTimes(1);

      worker.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps one ordinary admission when queued wakes overlap asynchronous assignment preparation', async () => {
    const now = Date.now();
    process.env.HAPPIER_SERVER_URL = 'https://api.example.test';
    process.env.HAPPIER_WEBAPP_URL = 'https://app.example.test';
    process.env.HAPPIER_HOME_DIR = join(os.tmpdir(), `happier-claim-preparation-${now}-${Math.random()}`);
    const executionInputEnvelope = JSON.stringify({
      v: 1, templateVersion: 1, assignmentMachineIds: ['machine-1'],
      template: { t: 'plain', v: { v: 1, prompt: 'Ordinary work' } }, triggerEvidence: null,
      target: { kind: 'newSession', spawn: { executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
        directory: { kind: 'path', path: '/tmp/claim-preparation' }, agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } } },
    });
    const assignmentSnapshot = { data: { assignments: [], settings: { maxActiveRunsPerMachine: 1 } } };
    let holdReads = false;
    const releaseAssignmentReads: Array<() => void> = [];
    mockGet.mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/encryption/currentness')) {
        return { status: 200, data: createAccountCurrentnessResponse(V3_CLAIM_CURRENTNESS, now) };
      }
      if (holdReads) await new Promise<void>((resolve) => releaseAssignmentReads.push(resolve));
      return assignmentSnapshot;
    });
    const scopes: Array<string | undefined> = [];
    const releaseOrdinaryClaims: Array<() => void> = [];
    mockPost.mockImplementation(async (url: string, body: { scope?: string }) => {
      if (url.endsWith('/v3/automations/runs/claim')) {
        scopes.push(body.scope);
        if (body.scope || releaseOrdinaryClaims.length === 2) return { data: { run: null, automation: null, accountCurrentness: null } };
        const ordinal = releaseOrdinaryClaims.length + 1;
        await new Promise<void>((resolve) => releaseOrdinaryClaims.push(resolve));
        return { data: { run: { id: `preparation-${ordinal}`, automationId: 'automation-1', attempt: 1, revision: 0,
          recipeKind: 'legacy', triggerId: null, triggerRetired: false, cause: { kind: 'manual', invokedAt: now }, executionInputEnvelope },
          automation: { id: 'automation-1', name: 'Ordinary', enabled: true }, accountCurrentness: V3_CLAIM_CURRENTNESS } };
      }
      if (url.endsWith('/start')) return { data: {
        ...createV3StartResponse({ runId: url.split('/').at(-2)!, now, attempt: 1 }), accountCurrentness: V3_CLAIM_CURRENTNESS,
      } };
      return { data: { ok: true } };
    });
    reloadCapacityConfiguration();
    const ingressResolvers: Array<(value: SessionServerStartDispatchResultV1) => void> = [];
    const dispatchSessionServerStart = vi.fn(() => new Promise<SessionServerStartDispatchResultV1>((resolve) => ingressResolvers.push(resolve)));
    const worker = startCapacityAutomationWorker({ token: 'preparation-token', machineId: 'machine-1', dispatchSessionServerStart,
      spawnSession: async () => ({ type: 'error', errorCode: 'SPAWN_FAILED', errorMessage: 'Use canonical ingress' }) });
    const wake = () => worker.handleServerUpdate({ id: 'preparation-wake', seq: 1, createdAt: now,
      body: { t: 'automation-run-updated', runId: 'preparation-1', automationId: 'automation-1', state: 'queued',
        scheduledAt: now, startedAt: null, finishedAt: null, updatedAt: now, machineId: null, targetMachineId: 'machine-1' },
    } satisfies Update);
    try {
      await worker.refreshAssignments();
      holdReads = true;
      wake();
      await waitForCondition(() => releaseAssignmentReads.length === 1);
      wake();
      await waitForCondition(() => releaseAssignmentReads.length === 2);
      releaseAssignmentReads[0]!();
      await waitForCondition(() => releaseOrdinaryClaims.length === 1);
      releaseAssignmentReads[1]!();
      await settleRequestDispatch();
      releaseOrdinaryClaims[0]!();
      await waitForCondition(() => ingressResolvers.length === 1);
      // Any second ordinary HTTP claim already passed the same empty-map
      // capacity decision. Let its real executor reach the native boundary.
      if (releaseOrdinaryClaims[1]) {
        releaseOrdinaryClaims[1]();
        await waitForCondition(() => ingressResolvers.length === 2);
      }
      expect(ingressResolvers).toHaveLength(1);
      expect(scopes.filter((scope) => scope === undefined)).toHaveLength(1);
    } finally {
      worker.stop();
      holdReads = false;
      for (const release of releaseAssignmentReads) release();
      for (const release of releaseOrdinaryClaims) release();
      for (const resolve of ingressResolvers) resolve({ type: 'error', code: 'spawn_failed', retryable: false });
    }
  });

  it.each(['settle', 'cancel_waiter'] as const)('admits Account and Session destination writes at full start capacity (%s)', async ending => {
    const now = Date.now();
    process.env.HAPPIER_SERVER_URL = 'https://api.example.test';
    process.env.HAPPIER_WEBAPP_URL = 'https://app.example.test';
    process.env.HAPPIER_HOME_DIR = join(os.tmpdir(), `happier-destination-capacity-${now}-${Math.random()}`);
    reloadCapacityConfiguration();
    const machineId = 'machine-1';
    const accountId = 'account-1';
    const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444'];
    const kinds = ['fresh', 'origin_session', 'existing_session', 'fresh'] as const;
    const accepted = await Promise.all(kinds.map(async (kind, index) => {
      const result = await materializeWorkflowAcceptedSnapshotV1({
        definition: { version: 1, defaults: {
          agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
          conversation: kind === 'existing_session' ? { kind, sessionId: 'destination', machineId } : { kind },
        }, blocks: [{ kind: 'step', id: 'write', document: { text: 'Write', references: [], attachments: [] } }] },
        context: { source: { kind: 'automation', automationId: `automation-${index}` }, inputs: {}, machineId,
          executionTarget: { kind: 'session' },
          workspaceTarget: { project: { machineId, directory: '/repo', checkoutRootPath: '/repo' } },
          ...(kind === 'origin_session' ? { origin: { kind: 'direct', originSessionId: 'destination' } } : {}),
          authorization: { principal: { kind: 'host' } } },
        admission: { kind: 'user' }, effects: { resolveTargetAvailability: async () => true },
      });
      if (!result.ok) throw new Error(result.error.code);
      return serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
        mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId: ids[index]! }, acceptedSnapshot: result.snapshot,
      }));
    }));
    const stores = ids.map((id, index) => createWorkflowRunStorageTestkit({ runId: id, machineId,
      origin: { kind: 'automation', automationId: `automation-${index}` }, acceptedEnvelope: accepted[index], state: 'claimed',
      keyCensus: { ...createPlainWorkflowRunKeyCensusFixture({ runId: id, accountId }), ownerAccountCurrentness: V3_CLAIM_CURRENTNESS } }));
    const claims: Array<string | undefined> = [];
    let ordinal = 0;
    mockGet.mockImplementation(async (url: string) => url.endsWith('/v1/account/encryption/currentness')
      ? { status: 200, data: createAccountCurrentnessResponse(V3_CLAIM_CURRENTNESS, now) }
      : { data: { assignments: [{ machineId, automationId: 'automation-0', nextClaimAt: now + 60_000 }],
        settings: { maxActiveRunsPerMachine: 1 } } });
    mockPost.mockImplementation(async (url: string, body: { scope?: string }) => {
      if (url.endsWith('/start')) return { data: { ...createV3StartResponse({ runId: ids[0]!, now, attempt: 1 }), accountCurrentness: V3_CLAIM_CURRENTNESS } };
      if (!url.endsWith('/v3/automations/runs/claim')) return { data: { ok: true } };
      claims.push(body.scope);
      const index = ordinal++;
      const legacyEnvelope = JSON.stringify({ v: 1, templateVersion: 1, assignmentMachineIds: [machineId],
        template: { t: 'plain', v: { v: 1, prompt: 'Start' } }, triggerEvidence: null,
        target: { kind: 'newSession', spawn: { executionTarget: { serverId: 'server-1', machineId },
          directory: { kind: 'path', path: '/repo' },
          agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } } } });
      return { data: index >= ids.length ? { run: null, automation: null, accountCurrentness: null } : {
        run: { id: ids[index], automationId: `automation-${index}`, attempt: 1, revision: 0, recipeKind: index === 0 ? 'legacy' : 'workflow-v2',
          triggerId: null, triggerRetired: false, cause: { kind: 'manual', invokedAt: now },
          ...(index === 0 ? { executionInputEnvelope: legacyEnvelope }
            : { executionInputEnvelope: '{}', automationEvidenceEnvelope: null, workflowAcceptedSnapshotEnvelope: accepted[index] }) },
        automation: { id: `automation-${index}`, name: 'Capacity', enabled: true,
          ...(index === 1 ? { scopeSessionId: 'destination' } : {}) }, accountCurrentness: V3_CLAIM_CURRENTNESS,
      } };
    });
    const starts: Array<() => void> = [];
    const writes: string[] = [];
    const coordinationErrors: unknown[] = [];
    const coordinationResults: unknown[] = [];
    const coordinators = stores.map((storage, index) => createProductionWorkflowRunCoordinator({
      token: 'token', accountId, machineId, storage,
      resolveControllerContext: async () => ({ surface: 'cli', authority: 'account_automation', callerPermissionMode: 'yolo' }),
      resolveAccountEncryption: async () => ({ kind: 'available', witness: V3_CLAIM_CURRENTNESS }),
      isAcceptedAuthorizationCurrent: async () => true,
      workspaceScm: { realizeWorktree: async () => { throw new Error('unexpected_worktree'); },
        inspectLocation: async () => null, verifyRecordedWorkspace: async () => 'available' },
      execution: { credentials: { token: 'token', encryption: null }, serverId: 'server-1',
        machineAdmissionTransport: async () => {
          await new Promise<void>(resolve => starts.push(resolve));
          throw new Error('start_boundary_stopped');
        },
        resolveExistingSessionConversation: async () => ({ sessionId: 'destination', machineId, directory: '/repo' }),
        sessionInput: { enqueue: async request => ({ status: 'accepted', localId: deriveWorkflowSessionInputLocalIdV2(request.workflow) }),
          observe: async ({ sessionId, localId }) => { writes.push(ids[index]!);
            return { ok: true, sessionId, localId, result: { kind: 'final_text', text: 'Written' } }; } },
        detachedRun: { actionExecutor: { execute: async () => { throw new Error('unexpected_detached'); } },
          buildActionContext: () => ({ surface: 'cli', authority: 'account_automation' }) },
      },
    }));
    const worker = startCapacityAutomationWorker({ token: 'token', machineId,
      spawnSession: async () => { throw new Error('unexpected_legacy_start'); },
      dispatchSessionServerStart: async () => {
        await new Promise<void>(resolve => starts.push(resolve));
        return { type: 'error', code: 'spawn_failed', retryable: false };
      },
      coordinateWorkflowRun: async claim => {
        try { const result = await coordinators[ids.indexOf(claim.runId)]!(claim); coordinationResults.push(result); return result; }
        catch (error) { coordinationErrors.push(error); throw error; }
      },
    });
    try {
      await worker.refreshAssignments();
      worker.handleServerUpdate({ id: 'wake', seq: 1, createdAt: now, body: { t: 'automation-run-updated',
        runId: ids[0]!, automationId: 'automation-0', state: 'queued', scheduledAt: now, startedAt: null,
        finishedAt: null, updatedAt: now, machineId: null, targetMachineId: machineId } } satisfies Update);
      await waitForCondition(() => (starts.length === 1 && writes.length === 2 && ordinal >= 5 && stores[3]!.rows().length > 0) || coordinationErrors.length > 0 || coordinationResults.length >= 4).catch(error => {
        throw new Error(JSON.stringify({ claims, ordinal, starts: starts.length, writes, coordinationResults,
          states: stores.map(store => store.run().state), operations: stores.map(store => store.operations()) }), { cause: error });
      });
      expect(coordinationErrors).toEqual([]);
      expect({ starts: starts.length, writes: writes.length }).toEqual({ starts: 1, writes: 2 });
      expect(new Set(writes)).toEqual(new Set([ids[1], ids[2]]));
      expect(claims).toContain('workflow');
      expect(stores[1]!.run().state).toBe('succeeded');
      expect(stores[2]!.run().state).toBe('succeeded');
      expect(stores[3]!.rows()).toHaveLength(1); // Accepted root, no Agent leaf admitted while full.
      if (ending === 'settle') {
        starts[0]!();
        await waitForCondition(() => stores[3]!.rows().length > 1);
      } else {
        worker.stop();
        await waitForCondition(() => coordinationErrors.length === 1);
        starts[0]!();
        expect(stores[3]!.rows()).toHaveLength(1);
      }
    } finally {
      worker.stop();
      for (const release of starts) release();
    }
  });

  it('charges new Agents even when their trigger has Session scope', async () => {
    const now = Date.now();
    process.env.HAPPIER_SERVER_URL = 'https://api.example.test';
    process.env.HAPPIER_WEBAPP_URL = 'https://app.example.test';
    process.env.HAPPIER_HOME_DIR = join(os.tmpdir(), `happier-scoped-capacity-${now}-${Math.random()}`);
    const executionInputEnvelope = JSON.stringify({
      v: 1, templateVersion: 1, assignmentMachineIds: ['machine-1'], template: { t: 'plain', v: { v: 1, prompt: 'Scoped capacity' } },
      triggerEvidence: null,
      target: { kind: 'newSession', spawn: {
        executionTarget: { serverId: 'server-1', machineId: 'machine-1' }, directory: { kind: 'path', path: '/tmp/scoped-capacity' },
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
      } },
    });
    AutomationRunExecutionRecipeV1Schema.parse(JSON.parse(executionInputEnvelope));
    AutomationV3WorkerStartResponseSchema.parse(createV3StartResponse({ runId: 'run-fixture', now, attempt: 1 }));
    mockGet.mockImplementation(async (url: string) => ({
      ...(url.endsWith('/v1/account/encryption/currentness') ? { status: 200 } : {}),
      data: url.endsWith('/v1/account/encryption/currentness')
        ? createAccountCurrentnessResponse(V3_CLAIM_CURRENTNESS, now)
        : { assignments: [{ machineId: 'machine-1', automationId: 'automation-1', nextClaimAt: now + 60_000 }],
          settings: { maxActiveRunsPerMachine: 1 } },
    }));
    const claims: Array<{ scope?: string }> = [];
    let ordinaryRefillReady = false;
    mockPost.mockImplementation(async (url: string, body: { scope?: string }) => {
      if (url.endsWith('/v3/automations/runs/claim')) {
        claims.push(body);
        if (body.scope === 'workflow') return { data: { run: null, automation: null, accountCurrentness: null } };
        const ordinal = claims.length;
        if (ordinal > 3 && !(ordinaryRefillReady && body.scope === undefined)) {
          return { data: { run: null, automation: null, accountCurrentness: null } };
        }
        ordinaryRefillReady = false;
        return { data: {
          run: { id: `run-${ordinal}`, automationId: 'automation-1', attempt: 1, revision: 0,
            recipeKind: 'legacy', triggerId: null, triggerRetired: false,
            cause: { kind: 'manual', invokedAt: now }, executionInputEnvelope },
          automation: { id: 'automation-1', name: 'Capacity', enabled: true,
            ...(ordinal === 1 || ordinal === 3 ? { scopeSessionId: 'origin-session' } : {}) },
          accountCurrentness: V3_CLAIM_CURRENTNESS,
        } };
      }
      if (url.endsWith('/start')) return { data: {
        ...createV3StartResponse({ runId: url.split('/').at(-2)!, now, attempt: 1 }), accountCurrentness: V3_CLAIM_CURRENTNESS,
      } };
      return { data: { ok: true } };
    });
    reloadCapacityConfiguration();
    const ingressResolvers: Array<(value: SessionServerStartDispatchResultV1) => void> = [];
    const dispatchSessionServerStart = vi.fn(() => new Promise<SessionServerStartDispatchResultV1>((resolve) => ingressResolvers.push(resolve)));
    const worker = startCapacityAutomationWorker({
      token: 'capacity-token', machineId: 'machine-1', dispatchSessionServerStart,
      spawnSession: async () => ({ type: 'error', errorCode: 'SPAWN_FAILED', errorMessage: 'Use Session ingress' }),
    });
    const wake = () => worker.handleServerUpdate({ id: 'capacity-wake', seq: 1, createdAt: now,
      body: { t: 'automation-run-updated', runId: 'run-1', automationId: 'automation-1', state: 'queued',
        scheduledAt: now, startedAt: null, finishedAt: null, updatedAt: now, machineId: null, targetMachineId: 'machine-1' },
    } satisfies Update);
    try {
      await worker.refreshAssignments();
      wake();
      await waitForCondition(() => ingressResolvers.length === 1 && claims.length >= 2);
      expect(claims.slice(0, 2).map((claim) => claim.scope)).toEqual([undefined, 'workflow']);
      expect(dispatchSessionServerStart).toHaveBeenCalledTimes(1);
      ordinaryRefillReady = true;
      ingressResolvers[0]!({ type: 'error', code: 'spawn_failed', retryable: false });
      await waitForCondition(() => ingressResolvers.length === 2);
      expect(claims.slice(2).some((claim) => claim.scope === undefined)).toBe(true);
    } finally {
      worker.stop();
    }
  });

  it('fills the default four-slot Automation budget and claims again when a slot settles', async () => {
    const now = Date.now();

    process.env.HAPPIER_SERVER_URL = 'https://api.example.test';
    process.env.HAPPIER_WEBAPP_URL = 'https://app.example.test';
    process.env.HAPPIER_HOME_DIR = join(
      os.tmpdir(),
      `happier-automation-worker-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`,
    );

    const executionInputEnvelope = JSON.stringify({
      v: 1,
      templateVersion: 1,
      assignmentMachineIds: ['machine-1'],
      template: { t: 'plain', v: { v: 1, prompt: 'create an Automation Session' } },
      triggerEvidence: null,
      target: {
        kind: 'newSession',
        spawn: {
          executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
          directory: { kind: 'path', path: '/tmp/happier-automation' },
          agentTarget: {
            kind: 'agent',
            identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
          },
        },
      },
    });

    const assignment = {
      machineId: 'machine-1',
      automationId: 'automation-1',
      nextClaimAt: now + 60_000,
    };
    const claimedAutomation = {
      id: 'automation-1',
      name: 'A1',
      enabled: true,
    };
    let projectedSettings = {
      maxActiveRunsPerMachine: DEFAULT_AUTOMATION_V3_MAX_ACTIVE_RUNS_PER_MACHINE,
    };

    mockGet.mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/encryption/currentness')) {
        return {
          status: 200,
          data: createAccountCurrentnessResponse(V3_CLAIM_CURRENTNESS, now),
        };
      }
      return {
        data: {
          assignments: [assignment],
          settings: projectedSettings,
        },
      };
    });

    let claimCount = 0;
    mockPost.mockImplementation(async (url: string, body?: { scope?: string }) => {
      if (url.endsWith('/v3/automations/runs/claim')) {
        if (body?.scope === 'workflow') return { data: { run: null, automation: null, accountCurrentness: null } };
        claimCount += 1;
        return {
          data: {
            run: {
              id: `run-${claimCount}`,
              automationId: 'automation-1',
              attempt: 1,
              revision: 0,
              recipeKind: 'legacy',
              triggerId: null,
              triggerRetired: false,
              cause: { kind: 'manual', invokedAt: now },
              executionInputEnvelope,
            },
            automation: claimedAutomation,
            accountCurrentness: V3_CLAIM_CURRENTNESS,
          },
        };
      }
      if (/\/v3\/automations\/runs\/.+\/start$/.test(url)) {
        const runId = url.split('/').at(-2) ?? 'run-1';
        return {
          data: {
            ...createV3StartResponse({ runId, now, attempt: 1 }),
            accountCurrentness: V3_CLAIM_CURRENTNESS,
          },
        };
      }
      if (/\/v3\/automations\/runs\/.+\/(heartbeat|succeed|fail)$/.test(url)) {
        return { data: { ok: true } };
      }
      throw new Error(`Unexpected POST ${url}`);
    });

    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();

    const ingressResolvers: Array<(value: SessionServerStartDispatchResultV1) => void> = [];
    const ingressSignals: AbortSignal[] = [];
    const dispatchSessionServerStart = vi.fn((
      _request: SessionServerStartIngressRequestV1,
      options?: Readonly<{ signal?: AbortSignal }>,
    ) => new Promise<SessionServerStartDispatchResultV1>((resolve) => {
      if (options?.signal) ingressSignals.push(options.signal);
      ingressResolvers.push(resolve);
    }));
    const sessionStartSuccess = (runId: string): SessionServerStartDispatchResultV1 => ({
      type: 'success',
      disposition: 'created',
      sessionId: `session-${runId}`,
      executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
      organizationPlacement: { folderId: null, tagIds: [] },
      initialInput: { status: 'accepted', localId: `automation:run:${runId}` },
    });

    const { startAutomationWorker } = await import('./automationWorker');
    const worker = startAutomationWorker({
      token: 'token-1',
      machineId: 'machine-1',
      spawnSession: vi.fn(async () => ({
        type: 'error' as const,
        errorCode: 'SPAWN_FAILED' as const,
        errorMessage: 'Strict V3 Runs must use the Session ingress owner',
      })),
      dispatchSessionServerStart,
      env: {
        HAPPIER_AUTOMATION_ASSIGNMENT_REFRESH_MS: '600000',
        HAPPIER_AUTOMATION_CLAIM_POLL_MS: '1000',
        HAPPIER_AUTOMATION_LEASE_MS: '30000',
        HAPPIER_AUTOMATION_HEARTBEAT_MS: '10000',
      } as NodeJS.ProcessEnv,
    });

    try {
      await worker.refreshAssignments();

      worker.handleServerUpdate({
        id: 'u-run-1',
        seq: 1,
        createdAt: now,
        body: {
          t: 'automation-run-updated',
          runId: 'run-1',
          automationId: 'automation-1',
          state: 'queued',
          scheduledAt: now,
          startedAt: null,
          finishedAt: null,
          updatedAt: now,
          machineId: null,
          targetMachineId: 'machine-1',
        },
      } as any);

      await waitForCondition(() => ingressResolvers.length >= 4);
      expect(claimCount).toBe(4);
      expect(ingressResolvers).toHaveLength(4);

      ingressResolvers[0]!(sessionStartSuccess('run-1'));
      await waitForCondition(() => ingressResolvers.length >= 5);

      expect(claimCount).toBe(5);
      expect(ingressResolvers).toHaveLength(5);

      // The current server projects its canonical default above. A later
      // setting may lower the budget, but it must not abort the four already-
      // owned local effects.
      projectedSettings = { maxActiveRunsPerMachine: 2 };
      await worker.refreshAssignments();
      expect(ingressSignals).toHaveLength(5);
      expect(ingressSignals.every((signal) => !signal.aborted)).toBe(true);

      ingressResolvers[1]!(sessionStartSuccess('run-2'));
      ingressResolvers[2]!(sessionStartSuccess('run-3'));
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      expect(claimCount).toBe(5);

      ingressResolvers[3]!(sessionStartSuccess('run-4'));
      await waitForCondition(() => ingressResolvers.length >= 6);
      expect(claimCount).toBe(6);

    } finally {
      worker.stop();
      for (const [index, resolve] of ingressResolvers.entries()) {
        resolve(sessionStartSuccess(`run-${index + 1}`));
      }
      await settleRequestDispatch();
    }
  });

});
