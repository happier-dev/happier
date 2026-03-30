import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import { join } from 'node:path';
import type { SpawnSessionResult } from '@/rpc/handlers/registerSessionHandlers';

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

function createAxios404(url: string) {
  return {
    message: 'Request failed with status code 404',
    response: { status: 404 },
    config: { url },
  };
}

function buildQueuedRun(params: { id: string; automationId: string; at: number }) {
  return {
    id: params.id,
    automationId: params.automationId,
    state: 'queued',
    scheduledAt: params.at,
    dueAt: params.at,
    claimedAt: null,
    startedAt: null,
    finishedAt: null,
    claimedByMachineId: null,
    leaseExpiresAt: null,
    attempt: 0,
    summaryCiphertext: null,
    errorCode: null,
    errorMessage: null,
    producedSessionId: null,
    createdAt: params.at,
    updatedAt: params.at,
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

    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

    mockGet.mockRejectedValue(createAxios404('https://api.example.test/v2/automations/daemon/assignments'));
    mockPost.mockRejectedValue(createAxios404('https://api.example.test/v2/automations/runs/claim'));

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

    // Drive a refresh directly to avoid relying on timers (and to surface any hangs deterministically).
    await worker.refreshAssignments();

    expect(mockGet).toHaveBeenCalled();
    expect(clearIntervalSpy).toHaveBeenCalled();

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

      mockGet.mockResolvedValue({ data: { assignments: [] } });
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

  it('suppresses assignment refresh while paused and resumes it afterwards', async () => {
    process.env.HAPPIER_SERVER_URL = 'https://api.example.test';
    process.env.HAPPIER_WEBAPP_URL = 'https://app.example.test';
    process.env.HAPPIER_HOME_DIR = join(
      os.tmpdir(),
      `happier-automation-worker-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`,
    );

    mockGet.mockResolvedValue({ data: { assignments: [] } });
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

    worker.pause();
    await worker.refreshAssignments();
    expect(mockGet).not.toHaveBeenCalled();

    worker.resume();
    await worker.refreshAssignments();
    expect(mockGet).toHaveBeenCalledTimes(1);

    worker.stop();
  });

  it('schedules claims near the nextRunAt instead of polling continuously', async () => {
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
        .mockResolvedValueOnce({ data: { assignments: [] } })
        .mockResolvedValueOnce({
          data: {
            assignments: [{
              machineId: 'machine-1',
              enabled: true,
              priority: 0,
              updatedAt: now,
              automation: {
                id: 'automation-1',
                name: 'A1',
                enabled: true,
                schedule: { kind: 'interval', scheduleExpr: null, everyMs: 60_000, timezone: null },
                targetType: 'new_session',
                templateCiphertext: 'ciphertext',
                templateVersion: 1,
                nextRunAt: now + 60_000,
                lastRunAt: null,
                updatedAt: now,
              },
            }],
          },
        })
        .mockResolvedValue({
          data: {
            assignments: [{
              machineId: 'machine-1',
              enabled: true,
              priority: 0,
              updatedAt: now,
              automation: {
                id: 'automation-1',
                name: 'A1',
                enabled: true,
                schedule: { kind: 'interval', scheduleExpr: null, everyMs: 60_000, timezone: null },
                targetType: 'new_session',
                templateCiphertext: 'ciphertext',
                templateVersion: 1,
                nextRunAt: now + 120_000,
                lastRunAt: null,
                updatedAt: now,
              },
            }],
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

      mockGet.mockResolvedValue({ data: { assignments: [] } });
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
        .mockResolvedValueOnce({ data: { assignments: [] } })
        .mockResolvedValueOnce({
          data: {
            assignments: [{
              machineId: 'machine-1',
              enabled: true,
              priority: 0,
              updatedAt: now,
              automation: {
                id: 'automation-1',
                name: 'A1',
                enabled: true,
                schedule: { kind: 'interval', scheduleExpr: null, everyMs: 60_000, timezone: null },
                targetType: 'new_session',
                templateCiphertext: 'ciphertext',
                templateVersion: 1,
                nextRunAt: now + 60_000,
                lastRunAt: null,
                updatedAt: now,
              },
            }],
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

      expect(mockGet).toHaveBeenCalledTimes(2);
      expect(mockPost).toHaveBeenCalledTimes(1);

      worker.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('claims again when another queued wake arrives while a run is already in flight', async () => {
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

      const { encodeBase64, encryptLegacy } = await import('@/api/encryption');
      const secret = new Uint8Array(32).fill(1);
      const templateCiphertext = JSON.stringify({
        kind: 'happier_automation_template_encrypted_v1',
        payloadCiphertext: encodeBase64(encryptLegacy({ directory: '/tmp/happier-automation' }, secret)),
      });

      const assignment = {
        machineId: 'machine-1',
        enabled: true,
        priority: 0,
        updatedAt: now,
        automation: {
          id: 'automation-1',
          name: 'A1',
          enabled: true,
          schedule: { kind: 'interval', scheduleExpr: null, everyMs: 60_000, timezone: null },
          targetType: 'new_session',
          templateCiphertext,
          templateVersion: 1,
          nextRunAt: now + 60_000,
          lastRunAt: null,
          updatedAt: now,
        },
      };

      mockGet.mockResolvedValue({ data: { assignments: [assignment] } });

      let claimCount = 0;
      mockPost.mockImplementation(async (url: string) => {
        if (url.endsWith('/v2/automations/runs/claim')) {
          claimCount += 1;
          if (claimCount === 1) {
            return {
              data: {
                run: buildQueuedRun({ id: 'run-1', automationId: 'automation-1', at: now }),
                automation: assignment.automation,
              },
            };
          }
          if (claimCount === 2) {
            return {
              data: {
                run: buildQueuedRun({ id: 'run-2', automationId: 'automation-1', at: now + 1 }),
                automation: assignment.automation,
              },
            };
          }
          return { data: { run: null, automation: null } };
        }
        if (/\/v2\/automations\/runs\/.+\/(start|heartbeat|succeed|fail)$/.test(url)) {
          return { data: { ok: true } };
        }
        throw new Error(`Unexpected POST ${url}`);
      });

      const { reloadConfiguration } = await import('@/configuration');
      reloadConfiguration();

      let resolveFirstSpawn!: (value: SpawnSessionResult) => void;
      let firstSpawnPending = true;
      const spawnSession: (options: unknown) => Promise<SpawnSessionResult> = vi.fn(() => {
        if (firstSpawnPending) {
          firstSpawnPending = false;
          return new Promise<SpawnSessionResult>((resolve) => {
            resolveFirstSpawn = resolve;
          });
        }
        return Promise.resolve({ type: 'success' as const, sessionId: 'session-2' });
      });

      const { startAutomationWorker } = await import('./automationWorker');
      const worker = startAutomationWorker({
        token: 'token-1',
        machineId: 'machine-1',
        encryption: { type: 'legacy', secret },
        spawnSession,
        env: {
          HAPPIER_AUTOMATION_ASSIGNMENT_REFRESH_MS: '600000',
          HAPPIER_AUTOMATION_CLAIM_POLL_MS: '1000',
          HAPPIER_AUTOMATION_LEASE_MS: '30000',
          HAPPIER_AUTOMATION_HEARTBEAT_MS: '10000',
        } as NodeJS.ProcessEnv,
      });

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

      await vi.advanceTimersByTimeAsync(0);
      expect(claimCount).toBe(1);

      worker.handleServerUpdate({
        id: 'u-run-2',
        seq: 2,
        createdAt: now + 1,
        body: {
          t: 'automation-run-updated',
          runId: 'run-2',
          automationId: 'automation-1',
          state: 'queued',
          scheduledAt: now + 1,
          startedAt: null,
          finishedAt: null,
          updatedAt: now + 1,
          machineId: null,
          targetMachineId: 'machine-1',
        },
      } as any);

      await vi.advanceTimersByTimeAsync(0);
      expect(claimCount).toBe(1);

      resolveFirstSpawn({ type: 'success', sessionId: 'session-1' });
      await vi.advanceTimersByTimeAsync(0);

      expect(claimCount).toBe(2);

      worker.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
