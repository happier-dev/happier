import { describe, expect, it, vi, beforeEach } from 'vitest';
import { DEFAULT_AUTOMATION_V3_MAX_ACTIVE_RUNS_PER_MACHINE } from '@happier-dev/protocol';

const { axiosGet, axiosPost } = vi.hoisted(() => ({
  axiosGet: vi.fn(),
  axiosPost: vi.fn(),
}));

vi.mock('axios', () => ({
  default: {
    get: axiosGet,
    post: axiosPost,
  },
}));

import {
  createAutomationClaimClient,
  isMissingAutomationWorkerEndpointError,
} from './automationClaimClient';

const CLAIM_CURRENTNESS = {
  mode: 'plain' as const,
  version: 7,
  contentKeyFingerprint: null,
};

const START_CURRENTNESS = {
  mode: 'plain' as const,
  version: 8,
  contentKeyFingerprint: null,
};

const DEFAULT_WORKER_SETTINGS = {
  maxActiveRunsPerMachine: DEFAULT_AUTOMATION_V3_MAX_ACTIVE_RUNS_PER_MACHINE,
} as const;

const START_RESPONSE = {
  run: {
    id: 'run/1',
    automationId: 'automation-1',
    state: 'running' as const,
    origin: { kind: 'manual' as const, invokedAt: 1_723_247_201_000 },
    dueAt: 1_723_247_201_000,
    claimedAt: 1_723_247_201_000,
    startedAt: 1_723_247_201_001,
    finishedAt: null,
    claimedByMachineId: 'm1',
    leaseExpiresAt: 1_723_247_231_000,
    attempt: 2,
    errorCode: null,
    producedSessionId: null,
    executionDispatchState: null,
    executionAttempt: 0,
    replyHandoffState: 'none' as const,
    replyHandoffAttempt: 0,
    replyHandoffDueAt: null,
    contentRemovedAt: null,
    createdAt: 1_723_247_201_000,
    updatedAt: 1_723_247_201_001,
  },
  accountCurrentness: START_CURRENTNESS,
};

function createAxios404(url: string) {
  return {
    response: { status: 404 },
    config: { url },
  };
}

describe('createAutomationClaimClient', () => {
  beforeEach(() => {
    axiosGet.mockReset();
    axiosPost.mockReset();
  });

  it('recognizes a missing worker endpoint beneath the configured API base path only for the exact request URL', () => {
    const expectedUrl = 'https://selfhost.example.test/api/v3/automations/worker/assignments';

    expect(isMissingAutomationWorkerEndpointError(createAxios404(expectedUrl), expectedUrl)).toBe(true);
    expect(isMissingAutomationWorkerEndpointError(
      createAxios404('https://selfhost.example.test/api/v3/automations/runs/claim'),
      expectedUrl,
    )).toBe(false);
    expect(isMissingAutomationWorkerEndpointError(
      createAxios404('https://other.example.test/api/v3/automations/worker/assignments'),
      expectedUrl,
    )).toBe(false);
    expect(isMissingAutomationWorkerEndpointError({
      response: { status: 500 },
      config: { url: expectedUrl },
    }, expectedUrl)).toBe(false);
  });

  it('fetches current V3 worker assignments with auth headers and machine query', async () => {
    axiosGet.mockResolvedValue({
      data: {
        assignments: [],
        settings: DEFAULT_WORKER_SETTINGS,
      },
    });
    const createPublisherHeader = vi.fn(async () => 'signed-machine-proof');

    const client = createAutomationClaimClient({ token: 'token-123', createPublisherHeader });
    await client.fetchAssignments('machine-1');

    expect(createPublisherHeader).toHaveBeenCalledWith({
      method: 'GET',
      path: '/v3/automations/worker/assignments',
      body: null,
    });

    expect(axiosGet).toHaveBeenCalledWith(
      expect.stringMatching(/\/v3\/automations\/worker\/assignments$/),
      expect.objectContaining({
        params: { machineId: 'machine-1' },
        timeout: 15_000,
        headers: expect.objectContaining({
          Authorization: 'Bearer token-123',
          'Content-Type': 'application/json',
          'x-happier-plugin-installation-manifest-publisher': 'signed-machine-proof',
        }),
      }),
    );
  });

  it('rejects a V3 assignment response that omits the server-owned execution setting', async () => {
    axiosGet.mockResolvedValue({ data: { assignments: [] } });

    const client = createAutomationClaimClient({ token: 'token-v3-malformed-settings' });

    await expect(client.fetchAssignments('machine-1')).rejects.toThrow();
  });

  it('projects the server-owned V3 per-machine execution budget without inventing it in the client', async () => {
    axiosGet.mockResolvedValue({
      data: {
        assignments: [{
          machineId: 'machine-1',
          automationId: 'automation-1',
          nextClaimAt: 1_723_247_201_000,
        }],
        settings: { maxActiveRunsPerMachine: 2 },
      },
    });

    const client = createAutomationClaimClient({ token: 'token-settings' });

    await expect(client.fetchAssignments('machine-1')).resolves.toEqual({
      assignments: [{
        machineId: 'machine-1',
        automationId: 'automation-1',
        nextClaimAt: 1_723_247_201_000,
      }],
      settings: { maxActiveRunsPerMachine: 2 },
    });
  });

  it('claims current V3 runs with machine and lease parameters after current assignment negotiation', async () => {
    axiosGet.mockResolvedValue({ data: { assignments: [], settings: DEFAULT_WORKER_SETTINGS } });
    const frozenExecutionInput = JSON.stringify({
      kind: 'happier_automation_run_execution_input_v1',
      targetType: 'new_session',
      templateVersion: 1,
      templateCiphertext: JSON.stringify({
        kind: 'happier_automation_template_plain_v1',
        payload: { directory: '/tmp/frozen-claim' },
      }),
      origin: { kind: 'manual', invokedAt: 1_723_247_201_000 },
    });
    axiosPost.mockResolvedValue({
      data: {
        run: {
          id: 'run-1',
          automationId: 'automation-1',
          attempt: 1,
          origin: { kind: 'manual', invokedAt: 1_723_247_201_000 },
          executionInputEnvelope: frozenExecutionInput,
        },
        automation: { id: 'automation-1', name: 'Frozen', enabled: true },
        accountCurrentness: CLAIM_CURRENTNESS,
      },
    });

    const client = createAutomationClaimClient({ token: 'token-abc' });
    await client.fetchAssignments('machine-2');
    await expect(client.claimRun({ machineId: 'machine-2', leaseDurationMs: 45_000 })).resolves.toEqual({
      protocol: 'v3',
      run: {
        id: 'run-1',
        automationId: 'automation-1',
        attempt: 1,
        origin: { kind: 'manual', invokedAt: 1_723_247_201_000 },
        executionInputEnvelope: frozenExecutionInput,
        resultDelivery: { kind: 'none' },
      },
      automation: { id: 'automation-1', name: 'Frozen', enabled: true },
      accountCurrentness: CLAIM_CURRENTNESS,
    });

    expect(axiosPost).toHaveBeenCalledWith(
      expect.stringMatching(/\/v3\/automations\/runs\/claim$/),
      {
        machineId: 'machine-2',
        leaseDurationMs: 45_000,
      },
      expect.objectContaining({
        timeout: 15_000,
        headers: expect.objectContaining({
          Authorization: 'Bearer token-abc',
          'Content-Type': 'application/json',
        }),
      }),
    );
  });

  it('preserves the server-frozen final-result correspondence on a V3 claim', async () => {
    axiosGet.mockResolvedValue({ data: { assignments: [], settings: DEFAULT_WORKER_SETTINGS } });
    axiosPost.mockResolvedValue({
      data: {
        run: {
          id: 'run-final',
          automationId: 'automation-final',
          attempt: 1,
          origin: {
            kind: 'conversation',
            occurrenceKey: 'occurrence-final',
            occurredAt: 1_723_247_201_000,
          },
          executionInputEnvelope: JSON.stringify({
            kind: 'happier_automation_run_execution_input_v1',
            targetType: 'existing_session',
            templateVersion: 1,
            templateCiphertext: JSON.stringify({
              kind: 'happier_automation_template_plain_v1',
              payload: { sessionId: 'sess-final' },
            }),
            origin: { kind: 'conversation', occurredAt: 1_723_247_201_000 },
          }),
          resultDelivery: {
            kind: 'finalResult',
            accountId: 'account-final',
            handoffId: 'automation-reply-handoff:run-final',
          },
        },
        automation: { id: 'automation-final', name: 'Final', enabled: true },
        accountCurrentness: CLAIM_CURRENTNESS,
      },
    });

    const client = createAutomationClaimClient({ token: 'token-final' });
    await client.fetchAssignments('machine-final');

    await expect(client.claimRun({ machineId: 'machine-final', leaseDurationMs: 45_000 })).resolves.toEqual(
      expect.objectContaining({
        protocol: 'v3',
        run: expect.objectContaining({
          id: 'run-final',
          resultDelivery: {
            kind: 'finalResult',
            accountId: 'account-final',
            handoffId: 'automation-reply-handoff:run-final',
          },
        }),
      }),
    );
  });

  it('sends lifecycle events to current V3 run-scoped endpoints', async () => {
    axiosGet.mockResolvedValue({ data: { assignments: [], settings: DEFAULT_WORKER_SETTINGS } });
    axiosPost
      .mockResolvedValueOnce({ data: START_RESPONSE })
      .mockResolvedValue({ data: undefined });

    const client = createAutomationClaimClient({ token: 'token-z' });
    await client.fetchAssignments('m1');

    await expect(client.startRun({
      runId: 'run/1',
      machineId: 'm1',
      attempt: 2,
      accountCurrentness: CLAIM_CURRENTNESS,
    })).resolves.toEqual(START_CURRENTNESS);
    await client.heartbeatRun({ runId: 'run/1', machineId: 'm1', attempt: 2, leaseDurationMs: 12_000 });
    await client.succeedRun({
      runId: 'run/1',
      machineId: 'm1',
      attempt: 2,
      accountCurrentness: START_CURRENTNESS,
      producedSessionId: 's1',
    });
    await client.failRun({
      runId: 'run/1',
      machineId: 'm1',
      attempt: 2,
      accountCurrentness: START_CURRENTNESS,
      errorCode: 'x',
      errorDetailEnvelope: '{"t":"plain","v":{"v":1,"correspondence":{"automationId":"a1","runId":"run/1"},"detail":"y"}}',
    });

    const calls = axiosPost.mock.calls.map((call) => call[0]);
    expect(calls).toEqual([
      expect.stringMatching(/\/v3\/automations\/runs\/run%2F1\/start$/),
      expect.stringMatching(/\/v3\/automations\/runs\/run%2F1\/heartbeat$/),
      expect.stringMatching(/\/v3\/automations\/runs\/run%2F1\/succeed$/),
      expect.stringMatching(/\/v3\/automations\/runs\/run%2F1\/fail$/),
    ]);
    expect(axiosPost.mock.calls.map((call) => call[1])).toEqual([
      { machineId: 'm1', attempt: 2, accountCurrentness: CLAIM_CURRENTNESS },
      { machineId: 'm1', attempt: 2, leaseDurationMs: 12_000 },
      {
        machineId: 'm1',
        attempt: 2,
        accountCurrentness: START_CURRENTNESS,
        producedSessionId: 's1',
        resultEnvelope: null,
      },
      {
        machineId: 'm1',
        attempt: 2,
        accountCurrentness: START_CURRENTNESS,
        errorCode: 'x',
        errorDetailEnvelope: '{"t":"plain","v":{"v":1,"correspondence":{"automationId":"a1","runId":"run/1"},"detail":"y"}}',
      },
    ]);
  });

  it('falls back to V2 only when the current assignment endpoint is absent, then normalizes schedule wake data', async () => {
    axiosGet
      .mockImplementationOnce((url: unknown) => Promise.reject(createAxios404(String(url))))
      .mockResolvedValueOnce({
        data: {
          assignments: [{
            machineId: 'machine-1',
            automation: { id: 'automation-schedule', nextRunAt: 1234 },
          }],
        },
      });
    axiosPost.mockResolvedValue({ data: { run: null, automation: null } });

    const client = createAutomationClaimClient({ token: 'token-v2' });
    await expect(client.fetchAssignments('machine-1')).resolves.toEqual({
      assignments: [{ machineId: 'machine-1', automationId: 'automation-schedule', nextClaimAt: 1234 }],
      settings: DEFAULT_WORKER_SETTINGS,
    });

    expect(axiosGet.mock.calls.map((call) => call[0])).toEqual([
      expect.stringMatching(/\/v3\/automations\/worker\/assignments$/),
      expect.stringMatching(/\/v2\/automations\/daemon\/assignments$/),
    ]);

    await client.claimRun({ machineId: 'machine-1', leaseDurationMs: 30_000 });
    expect(axiosPost).toHaveBeenCalledWith(
      expect.stringMatching(/\/v2\/automations\/runs\/claim$/),
      { machineId: 'machine-1', leaseDurationMs: 30_000 },
      expect.anything(),
    );
  });

  it('re-probes V3 assignments after a V2 fallback so a server upgrade exposes current work without restarting the daemon', async () => {
    let v3Available = false;
    axiosGet.mockImplementation((url: unknown) => {
      const requestUrl = String(url);
      if (requestUrl.endsWith('/v3/automations/worker/assignments')) {
        if (!v3Available) {
          return Promise.reject(createAxios404(requestUrl));
        }
        return Promise.resolve({
          data: {
            assignments: [{
              machineId: 'machine-1',
              automationId: 'automation-event',
              nextClaimAt: 5678,
            }],
            settings: DEFAULT_WORKER_SETTINGS,
          },
        });
      }
      return Promise.resolve({
        data: {
          assignments: [{
            machineId: 'machine-1',
            automation: { id: 'automation-schedule', nextRunAt: 1234 },
          }],
        },
      });
    });

    const client = createAutomationClaimClient({ token: 'token-upgrade' });
    await expect(client.fetchAssignments('machine-1')).resolves.toEqual({
      assignments: [{ machineId: 'machine-1', automationId: 'automation-schedule', nextClaimAt: 1234 }],
      settings: DEFAULT_WORKER_SETTINGS,
    });

    v3Available = true;
    await expect(client.fetchAssignments('machine-1')).resolves.toEqual({
      assignments: [{ machineId: 'machine-1', automationId: 'automation-event', nextClaimAt: 5678 }],
      settings: DEFAULT_WORKER_SETTINGS,
    });
    expect(axiosGet.mock.calls.map((call) => call[0])).toEqual([
      expect.stringMatching(/\/v3\/automations\/worker\/assignments$/),
      expect.stringMatching(/\/v2\/automations\/daemon\/assignments$/),
      expect.stringMatching(/\/v3\/automations\/worker\/assignments$/),
    ]);
  });

  it('keeps the newest overlapping assignment negotiation authoritative when an older V2 fallback finishes late', async () => {
    let v3RequestCount = 0;
    let markV2Started!: () => void;
    let resolveOlderV2!: (response: {
      data: {
        assignments: Array<{
          machineId: string;
          automation: { id: string; nextRunAt: number };
        }>;
      };
    }) => void;
    const v2Started = new Promise<void>((resolve) => {
      markV2Started = resolve;
    });
    const olderV2Response = new Promise<{
      data: {
        assignments: Array<{
          machineId: string;
          automation: { id: string; nextRunAt: number };
        }>;
      };
    }>((resolve) => {
      resolveOlderV2 = resolve;
    });

    axiosGet.mockImplementation((url: unknown) => {
      const requestUrl = String(url);
      if (requestUrl.endsWith('/v3/automations/worker/assignments')) {
        v3RequestCount += 1;
        if (v3RequestCount === 1) {
          return Promise.reject(createAxios404(requestUrl));
        }
        return Promise.resolve({
          data: {
            assignments: [{
              machineId: 'machine-1',
              automationId: 'automation-event',
              nextClaimAt: 5678,
            }],
            settings: DEFAULT_WORKER_SETTINGS,
          },
        });
      }
      markV2Started();
      return olderV2Response;
    });
    axiosPost.mockResolvedValue({
      data: { run: null, automation: null, accountCurrentness: null },
    });

    const client = createAutomationClaimClient({ token: 'token-overlapping-upgrade' });
    const olderRead = client.fetchAssignments('machine-1');
    await v2Started;

    await expect(client.fetchAssignments('machine-1')).resolves.toEqual({
      assignments: [{ machineId: 'machine-1', automationId: 'automation-event', nextClaimAt: 5678 }],
      settings: DEFAULT_WORKER_SETTINGS,
    });
    resolveOlderV2({
      data: {
        assignments: [{
          machineId: 'machine-1',
          automation: { id: 'automation-schedule', nextRunAt: 1234 },
        }],
      },
    });
    await olderRead;

    await expect(client.claimRun({ machineId: 'machine-1', leaseDurationMs: 30_000 })).resolves.toEqual({
      protocol: 'v3',
      run: null,
      automation: null,
    });
    expect(axiosPost).toHaveBeenCalledWith(
      expect.stringMatching(/\/v3\/automations\/runs\/claim$/),
      expect.anything(),
      expect.anything(),
    );
  });

  it('keeps an active V2 Run on V2 lifecycle endpoints when an overlapping assignment refresh discovers V3', async () => {
    let v3Available = false;
    axiosGet.mockImplementation((url: unknown) => {
      const requestUrl = String(url);
      if (requestUrl.endsWith('/v3/automations/worker/assignments')) {
        if (!v3Available) {
          return Promise.reject(createAxios404(requestUrl));
        }
        return Promise.resolve({
          data: {
            assignments: [{
              machineId: 'machine-1',
              automationId: 'automation-event',
              nextClaimAt: 5678,
            }],
            settings: DEFAULT_WORKER_SETTINGS,
          },
        });
      }
      return Promise.resolve({
        data: {
          assignments: [{
            machineId: 'machine-1',
            automation: { id: 'automation-schedule', nextRunAt: 1234 },
          }],
        },
      });
    });
    axiosPost
      .mockResolvedValueOnce({
        data: {
          run: { id: 'run-v2', automationId: 'automation-schedule', attempt: 1 },
          automation: { id: 'automation-schedule', name: 'Schedule', enabled: true },
        },
      })
      .mockResolvedValue({ data: undefined });

    const client = createAutomationClaimClient({ token: 'token-upgrade-active-v2' });
    await client.fetchAssignments('machine-1');
    await client.claimRun({ machineId: 'machine-1', leaseDurationMs: 30_000 });

    v3Available = true;
    await client.fetchAssignments('machine-1');
    await client.startRun({ runId: 'run-v2', machineId: 'machine-1', attempt: 1 });
    await client.succeedRun({ runId: 'run-v2', machineId: 'machine-1', attempt: 1 });

    expect(axiosPost.mock.calls.map((call) => call[0])).toEqual([
      expect.stringMatching(/\/v2\/automations\/runs\/claim$/),
      expect.stringMatching(/\/v2\/automations\/runs\/run-v2\/start$/),
      expect.stringMatching(/\/v2\/automations\/runs\/run-v2\/succeed$/),
    ]);
  });

  it('keeps an active V3 Run on V3 through a V2 refresh, then uses V2 for the next claim after settlement', async () => {
    let v3Available = true;
    axiosGet.mockImplementation((url: unknown) => {
      const requestUrl = String(url);
      if (requestUrl.endsWith('/v3/automations/worker/assignments')) {
        if (!v3Available) {
          return Promise.reject(createAxios404(requestUrl));
        }
        return Promise.resolve({
          data: {
            assignments: [{
              machineId: 'machine-1',
              automationId: 'automation-event',
              nextClaimAt: 1,
            }],
            settings: DEFAULT_WORKER_SETTINGS,
          },
        });
      }
      return Promise.resolve({
        data: {
          assignments: [{
            machineId: 'machine-1',
            automation: { id: 'automation-schedule', nextRunAt: 1234 },
          }],
        },
      });
    });
    axiosPost
      .mockResolvedValueOnce({
        data: {
          run: {
            id: 'run-v3',
            automationId: 'automation-event',
            attempt: 1,
            origin: {
              kind: 'pluginEvent',
              occurrenceKey: 'github-push-1',
              sourceSelectorId: 'source-selector-1',
              occurredAt: 1_723_247_201_000,
            },
            executionInputEnvelope: '{"kind":"happier_automation_run_execution_recipe_v1"}',
          },
          automation: { id: 'automation-event', name: 'Event', enabled: true },
          accountCurrentness: CLAIM_CURRENTNESS,
        },
      })
      .mockResolvedValueOnce({ data: START_RESPONSE })
      .mockResolvedValueOnce({ data: undefined })
      .mockResolvedValueOnce({ data: { run: null, automation: null } });

    const client = createAutomationClaimClient({ token: 'token-active-v3-downshift' });
    await client.fetchAssignments('machine-1');
    await client.claimRun({ machineId: 'machine-1', leaseDurationMs: 30_000 });

    v3Available = false;
    await client.fetchAssignments('machine-1');
    await client.startRun({
      runId: 'run-v3',
      machineId: 'machine-1',
      attempt: 1,
      accountCurrentness: CLAIM_CURRENTNESS,
    });
    await client.succeedRun({
      runId: 'run-v3',
      machineId: 'machine-1',
      attempt: 1,
      accountCurrentness: START_CURRENTNESS,
    });
    await expect(client.claimRun({ machineId: 'machine-1', leaseDurationMs: 30_000 })).resolves.toEqual({
      protocol: 'v2',
      run: null,
      automation: null,
    });

    expect(axiosPost.mock.calls.map((call) => call[0])).toEqual([
      expect.stringMatching(/\/v3\/automations\/runs\/claim$/),
      expect.stringMatching(/\/v3\/automations\/runs\/run-v3\/start$/),
      expect.stringMatching(/\/v3\/automations\/runs\/run-v3\/succeed$/),
      expect.stringMatching(/\/v2\/automations\/runs\/claim$/),
    ]);
  });

  it('falls back to schedule-only V2 when an older server has V3 reads but no V3 claim endpoint', async () => {
    axiosGet.mockResolvedValue({
      data: {
        assignments: [{
          machineId: 'machine-1',
          automationId: 'event-automation',
          nextClaimAt: 1,
        }],
        settings: DEFAULT_WORKER_SETTINGS,
      },
    });
    axiosPost
      .mockImplementationOnce((url: unknown) => Promise.reject(createAxios404(String(url))))
      .mockResolvedValueOnce({ data: { run: null, automation: null } })
      .mockResolvedValueOnce({ data: undefined });

    const client = createAutomationClaimClient({ token: 'token-v3-read-v2-worker' });
    await client.fetchAssignments('machine-1');
    await expect(client.claimRun({ machineId: 'machine-1', leaseDurationMs: 30_000 })).resolves.toEqual({
      protocol: 'v2',
      run: null,
      automation: null,
    });
    await client.succeedRun({ runId: 'run-1', machineId: 'machine-1', attempt: 1 });

    expect(axiosPost.mock.calls.map((call) => call[0])).toEqual([
      expect.stringMatching(/\/v3\/automations\/runs\/claim$/),
      expect.stringMatching(/\/v2\/automations\/runs\/claim$/),
      expect.stringMatching(/\/v2\/automations\/runs\/run-1\/succeed$/),
    ]);
    expect(axiosPost.mock.calls[1]?.[1]).toEqual({
      machineId: 'machine-1',
      leaseDurationMs: 30_000,
    });
    expect(axiosPost.mock.calls[2]?.[1]).toEqual({
      machineId: 'machine-1',
      attempt: 1,
      producedSessionId: null,
      summaryCiphertext: null,
    });
  });

  it('keeps a fallback V2 Run on V2 without letting its older claim overwrite a newer V3 assignment read', async () => {
    let markV3ClaimStarted!: () => void;
    let rejectOlderV3Claim!: (error: unknown) => void;
    let v3ClaimCount = 0;
    let olderV3ClaimUrl = '';
    const v3ClaimStarted = new Promise<void>((resolve) => {
      markV3ClaimStarted = resolve;
    });
    const olderV3Claim = new Promise<never>((_resolve, reject) => {
      rejectOlderV3Claim = reject;
    });

    axiosGet.mockResolvedValue({
      data: {
        assignments: [{
          machineId: 'machine-1',
          automationId: 'automation-event',
          nextClaimAt: 1,
        }],
        settings: DEFAULT_WORKER_SETTINGS,
      },
    });
    axiosPost.mockImplementation((url: unknown) => {
      const requestUrl = String(url);
      if (requestUrl.endsWith('/v3/automations/runs/claim')) {
        v3ClaimCount += 1;
        if (v3ClaimCount === 1) {
          olderV3ClaimUrl = requestUrl;
          markV3ClaimStarted();
          return olderV3Claim;
        }
        return Promise.resolve({
          data: { run: null, automation: null, accountCurrentness: null },
        });
      }
      if (requestUrl.endsWith('/v2/automations/runs/claim')) {
        return Promise.resolve({
          data: {
            run: { id: 'run-v2', automationId: 'automation-schedule', attempt: 1 },
            automation: { id: 'automation-schedule', name: 'Schedule', enabled: true },
          },
        });
      }
      if (requestUrl.endsWith('/v2/automations/runs/run-v2/succeed')) {
        return Promise.resolve({ data: undefined });
      }
      throw new Error(`Unexpected Automation request: ${requestUrl}`);
    });

    const client = createAutomationClaimClient({ token: 'token-overlapping-claim-upgrade' });
    await client.fetchAssignments('machine-1');
    const olderClaim = client.claimRun({ machineId: 'machine-1', leaseDurationMs: 30_000 });
    await v3ClaimStarted;

    await client.fetchAssignments('machine-1');
    rejectOlderV3Claim(createAxios404(olderV3ClaimUrl));
    await expect(olderClaim).resolves.toEqual({
      protocol: 'v2',
      run: { id: 'run-v2', automationId: 'automation-schedule', attempt: 1 },
      automation: { id: 'automation-schedule', name: 'Schedule', enabled: true },
    });
    await client.succeedRun({ runId: 'run-v2', machineId: 'machine-1', attempt: 1 });

    await expect(client.claimRun({ machineId: 'machine-1', leaseDurationMs: 30_000 })).resolves.toEqual({
      protocol: 'v3',
      run: null,
      automation: null,
    });
    expect(axiosPost.mock.calls.map((call) => call[0])).toEqual([
      expect.stringMatching(/\/v3\/automations\/runs\/claim$/),
      expect.stringMatching(/\/v2\/automations\/runs\/claim$/),
      expect.stringMatching(/\/v2\/automations\/runs\/run-v2\/succeed$/),
      expect.stringMatching(/\/v3\/automations\/runs\/claim$/),
    ]);
  });

  it('carries an authoritative created Session through a V2 input-failure settlement', async () => {
    axiosGet
      .mockImplementationOnce((url: unknown) => Promise.reject(createAxios404(String(url))))
      .mockResolvedValueOnce({ data: { assignments: [] } });
    axiosPost.mockResolvedValue({ data: undefined });

    const client = createAutomationClaimClient({ token: 'token-v2-known-session' });
    await client.fetchAssignments('machine-1');
    await client.failRun({
      runId: 'run-1',
      machineId: 'machine-1',
      attempt: 1,
      producedSessionId: 'session-created-before-input-failure',
      errorCode: 'prompt_delivery_failed',
      errorMessage: 'Machine admission rejected the initial prompt',
    });

    expect(axiosPost).toHaveBeenCalledWith(
      expect.stringMatching(/\/v2\/automations\/runs\/run-1\/fail$/),
      {
        machineId: 'machine-1',
        attempt: 1,
        producedSessionId: 'session-created-before-input-failure',
        errorCode: 'prompt_delivery_failed',
        errorMessage: 'Machine admission rejected the initial prompt',
      },
      expect.anything(),
    );
  });
});
