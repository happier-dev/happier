import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_AUTOMATION_V3_MAX_ACTIVE_RUNS_PER_MACHINE,
  type SessionServerStartDispatchResultV1,
  type SessionServerStartIngressRequestV1,
} from '@happier-dev/protocol';

const { mockGet, mockPost, mockIsAxiosError, mockCreate } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPost: vi.fn(),
  mockIsAxiosError: vi.fn(() => true),
  mockCreate: vi.fn(),
}));

vi.mock('axios', () => {
  const client = {
    get: mockGet,
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
    vi.resetModules();

    if (previousServer === undefined) delete process.env.HAPPIER_SERVER_URL;
    else process.env.HAPPIER_SERVER_URL = previousServer;

    if (previousWebapp === undefined) delete process.env.HAPPIER_WEBAPP_URL;
    else process.env.HAPPIER_WEBAPP_URL = previousWebapp;

    if (previousHomeDir === undefined) delete process.env.HAPPIER_HOME_DIR;
    else process.env.HAPPIER_HOME_DIR = previousHomeDir;
  });

  it('disables itself when automation endpoints are missing (404) to avoid repeated polling', async () => {
    process.env.HAPPIER_SERVER_URL = 'https://api.example.test';
    process.env.HAPPIER_WEBAPP_URL = 'https://app.example.test';
    process.env.HAPPIER_HOME_DIR = join(
      os.tmpdir(),
      `happier-automation-worker-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`,
    );

    mockGet
      .mockImplementationOnce((url: unknown) => Promise.reject(createAxios404(String(url))))
      .mockImplementationOnce((url: unknown) => Promise.reject(createAxios404(String(url))));

    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();

    const { startAutomationWorker } = await import('./automationWorker');
    const worker = startAutomationWorker({
      token: 'token-1',
      machineId: 'machine-1',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
      spawnSession: vi.fn(async () => ({ type: 'error' as const, errorCode: 'SPAWN_FAILED' as const, errorMessage: 'noop' })),
      env: {
        HAPPIER_AUTOMATION_CLAIM_POLL_MS: '1000',
        HAPPIER_AUTOMATION_ASSIGNMENT_REFRESH_MS: '5000',
      } as NodeJS.ProcessEnv,
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mockGet).toHaveBeenCalledTimes(2);

    mockGet.mockClear();
    await worker.refreshAssignments();
    expect(mockGet).not.toHaveBeenCalled();

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

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(mockGet).not.toHaveBeenCalled();

    worker.stop();
  }, 60_000);

  it('does not call claim when there are no enabled assignments', async () => {
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
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        spawnSession: vi.fn(async () => ({ type: 'error' as const, errorCode: 'SPAWN_FAILED' as const, errorMessage: 'noop' })),
        env: {
          HAPPIER_AUTOMATION_ASSIGNMENT_REFRESH_MS: '600000',
          HAPPIER_AUTOMATION_CLAIM_POLL_MS: '1000',
        } as NodeJS.ProcessEnv,
      });

      await worker.refreshAssignments();

      await vi.advanceTimersByTimeAsync(120_000);

      expect(mockPost).not.toHaveBeenCalled();

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
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
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
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
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
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
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

  it('authoritatively refreshes an empty assignment cache before dismissing a queued-run wake', async () => {
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
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
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
          automationId: 'automation-1',
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
      expect(mockPost).not.toHaveBeenCalled();

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
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
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

  it('schedules claims near the V3 nextClaimAt instead of polling continuously', async () => {
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
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        spawnSession: vi.fn(async () => ({ type: 'error' as const, errorCode: 'SPAWN_FAILED' as const, errorMessage: 'noop' })),
        env: {
          HAPPIER_AUTOMATION_ASSIGNMENT_REFRESH_MS: '600000',
          HAPPIER_AUTOMATION_CLAIM_POLL_MS: '1000',
          HAPPIER_AUTOMATION_LEASE_MS: '30000',
        } as NodeJS.ProcessEnv,
      });

      await worker.refreshAssignments();

      await vi.advanceTimersByTimeAsync(59_000);
      expect(mockPost).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(2_000);
      expect(mockPost).toHaveBeenCalledTimes(1);

      // Ensure we don't keep firing claims every second after the first attempt.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(mockPost).toHaveBeenCalledTimes(1);

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
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
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
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
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
      template: { t: 'plain', v: { v: 1, prompt: 'create an Automation Session' } },
      triggerEvidence: null,
      target: {
        kind: 'newSession',
        spawn: {
          executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
          directory: '/tmp/happier-automation',
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
    mockPost.mockImplementation(async (url: string) => {
      if (url.endsWith('/v3/automations/runs/claim')) {
        claimCount += 1;
        return {
          data: {
            run: {
              id: `run-${claimCount}`,
              automationId: 'automation-1',
              attempt: 1,
              triggerId: null,
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
