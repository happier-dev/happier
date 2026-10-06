import { describe, expect, it, vi, beforeEach } from 'vitest';
import { DEFAULT_AUTOMATION_V3_MAX_ACTIVE_RUNS_PER_MACHINE } from '@happier-dev/protocol';

const { axiosGet, axiosPost, axiosLifecycleGet } = vi.hoisted(() => ({
  axiosGet: vi.fn(),
  axiosPost: vi.fn(),
  axiosLifecycleGet: vi.fn(),
}));

vi.mock('axios', async (importOriginal) => ({
  ...await importOriginal<typeof import('axios')>(),
  default: {
    ...((await importOriginal<typeof import('axios')>()).default),
    // This HTTP owner serves both assignment and native Run-source inventories.
    get: (url: string, ...args: unknown[]) => url.endsWith('/worker/run-lifecycle')
      ? axiosLifecycleGet(url, ...args) : axiosGet(url, ...args),
    post: axiosPost,
  },
}));

import type { CreatePluginInstallationPublisherHeader } from '@/plugins/installations/publisherProof';

import {
  createAutomationClaimClient,
} from './automationClaimClient';
import { executeClaimedRun } from './automationRunExecutor';

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
    triggerId: null,
    cause: { kind: 'manual' as const, invokedAt: 1_723_247_201_000 },
    dueAt: 1_723_247_201_000,
    claimedAt: 1_723_247_201_000,
    startedAt: 1_723_247_201_001,
    finishedAt: null,
    claimedByMachineId: 'm1',
    leaseExpiresAt: 1_723_247_231_000,
    attempt: 2,
    revision: 1,
    triggerRetired: false,
    errorCode: null,
    producedSessionId: null,
    executionDispatchState: null,
    executionAttempt: 0,
    replyHandoffState: 'none' as const,
    replyHandoffAttempt: 0,
    replyHandoffDueAt: null,
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
    axiosLifecycleGet.mockReset().mockResolvedValue({ data: { sources: [] } });
  });

  it.each(['assignments', 'run-lifecycle'] as const)('propagates a %s transport timeout and recovers on the next refresh', async source => {
    const timeout = Object.assign(new Error('private transport message'), { name: 'AxiosError', code: 'ECONNABORTED' });
    axiosGet.mockResolvedValue({ data: { assignments: [{ machineId: 'machine-1', automationId: 'automation-1',
      nextClaimAt: 1_723_247_201_000 }], settings: DEFAULT_WORKER_SETTINGS } });
    (source === 'assignments' ? axiosGet : axiosLifecycleGet).mockRejectedValueOnce(timeout);
    const client = createAutomationClaimClient({ token: 'token', createPublisherHeader: async () => null });
    await expect(client.fetchAssignments('machine-1')).rejects.toBe(timeout);
    await expect(client.fetchAssignments('machine-1')).resolves.toMatchObject({ assignments: [{ automationId: 'automation-1' }],
      settings: DEFAULT_WORKER_SETTINGS, runLifecycleSources: [] });
  });

  it.each(['direct', 'automation'] as const)('retains consumed Resume intent from a %s V3 claim', async origin => {
    // HTTP is the system boundary; the strict parser and private worker
    // normalization remain real so neither can silently discard the intent.
    const common = { id: 'resumed-run', attempt: 2, revision: 3, recipeKind: 'workflow-v2',
      triggerId: null, triggerRetired: false, workflowResumeRequestedRevision: 2 };
    axiosGet.mockResolvedValue({ data: { assignments: [], settings: DEFAULT_WORKER_SETTINGS } });
    axiosPost.mockResolvedValue({ data: {
      run: origin === 'direct'
        ? { ...common, automationId: null, origin: { kind: 'direct' }, workflowAcceptedSnapshotEnvelope: 'accepted' }
        : { ...common, automationId: 'automation-1', executionInputEnvelope: 'definition', automationEvidenceEnvelope: null,
          workflowAcceptedSnapshotEnvelope: 'accepted',
          cause: { kind: 'manual', invokedAt: 1_723_247_201_000 } },
      automation: origin === 'direct' ? null : { id: 'automation-1', name: 'Resumed', enabled: true },
      accountCurrentness: CLAIM_CURRENTNESS,
    } });
    const client = createAutomationClaimClient({ token: 'token' });
    await client.fetchAssignments('machine-1');
    expect(await client.claimRun({ machineId: 'machine-1', leaseDurationMs: 30_000 }))
      .toMatchObject({ run: { id: 'resumed-run', workflowResumeRequestedRevision: 2,
        workflowAcceptedSnapshotEnvelope: 'accepted' } });
  });

  it('claims only session-scoped work and preserves its scope and previous review checkpoint', async () => {
    axiosGet.mockResolvedValue({ data: { assignments: [], settings: DEFAULT_WORKER_SETTINGS } });
    axiosPost.mockResolvedValue({ data: {
      run: {
        id: 'scoped-run', automationId: 'scoped-automation', attempt: 1, revision: 0,
        recipeKind: 'legacy', triggerId: null, triggerRetired: false,
        cause: { kind: 'manual', invokedAt: 1_723_247_201_000 },
        executionInputEnvelope: 'frozen-input',
        lastSucceededRun: { runId: 'last-review', checkpointEnvelope: 'final-panel-checkpoint' },
      },
      automation: { id: 'scoped-automation', name: 'Review', enabled: true, scopeSessionId: 'origin-session' },
      accountCurrentness: CLAIM_CURRENTNESS,
    } });
    const client = createAutomationClaimClient({ token: 'scoped-token' });
    await client.fetchAssignments('machine-1');
    const claimed = await client.claimRun({ machineId: 'machine-1', leaseDurationMs: 30_000, scope: 'session_scoped' });
    expect(axiosPost).toHaveBeenCalledWith(expect.stringMatching(/\/v3\/automations\/runs\/claim$/), {
      machineId: 'machine-1', leaseDurationMs: 30_000, scope: 'session_scoped',
    }, expect.anything());
    expect(claimed).toMatchObject({
      automation: { scopeSessionId: 'origin-session' },
      run: { lastSucceededRun: { runId: 'last-review', checkpointEnvelope: 'final-panel-checkpoint' } },
    });
  });

  it('surfaces a missing current assignment endpoint without falling back to V2', async () => {
    axiosGet.mockImplementationOnce(async (url: string) => { throw createAxios404(url); });
    const client = createAutomationClaimClient({ token: 'v2-scoped-token' });
    await expect(client.fetchAssignments('machine-1')).rejects.toMatchObject({ response: { status: 404 } });
    expect(axiosGet).toHaveBeenCalledTimes(1);
    expect(axiosPost).not.toHaveBeenCalled();
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
      runLifecycleSources: [],
    });
  });

  it('claims and executes current frozen input containing retained 0.2 template data', async () => {
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
    const claimResponse = {
      run: {
        id: 'run-1',
        automationId: 'automation-1',
        attempt: 1,
        revision: 0,
        recipeKind: 'legacy',
        triggerId: null,
        triggerRetired: false,
        cause: { kind: 'manual' as const, invokedAt: 1_723_247_201_000 },
        executionInputEnvelope: frozenExecutionInput,
      },
      automation: { id: 'automation-1', name: 'Frozen', enabled: true },
      accountCurrentness: CLAIM_CURRENTNESS,
    };
    axiosPost.mockImplementation(async (url: string) => {
      if (url.endsWith('/v3/automations/runs/claim')) return { data: claimResponse };
      if (url.endsWith('/v3/automations/runs/run-1/start')) {
        return {
          data: {
            ...START_RESPONSE,
            run: {
              ...START_RESPONSE.run,
              id: 'run-1',
              automationId: 'automation-1',
              attempt: 1,
              revision: 1,
              triggerRetired: false,
            },
          },
        };
      }
      if (url.endsWith('/v3/automations/runs/run-1/succeed')) return { data: { ok: true } };
      throw new Error(`Unexpected POST ${url}`);
    });

    const client = createAutomationClaimClient({ token: 'token-abc' });
    await client.fetchAssignments('machine-2');
    const claimed = await client.claimRun({ machineId: 'machine-2', leaseDurationMs: 45_000 });
    expect(claimed).toEqual({
      protocol: 'v3',
      run: {
        id: 'run-1',
        automationId: 'automation-1',
        attempt: 1,
        revision: 0,
        recipeKind: 'legacy',
        triggerId: null,
        cause: { kind: 'manual', invokedAt: 1_723_247_201_000 },
        executionInputEnvelope: frozenExecutionInput,
        resultDelivery: { kind: 'none' },
      },
      automation: { id: 'automation-1', name: 'Frozen', enabled: true },
      accountCurrentness: CLAIM_CURRENTNESS,
    });

    if (claimed.run === null) throw new Error('Expected an exact claimed Run');
    const spawnSession = vi.fn(async () => ({
      type: 'success' as const,
      sessionId: 'session-frozen-v2',
    }));
    await executeClaimedRun({
      token: 'token-abc',
      machineId: 'machine-2',
      claimClient: client,
      spawnSession,
      heartbeatMs: 60_000,
      leaseDurationMs: 45_000,
      resolveAutomationAccountEncryption: vi.fn()
        .mockResolvedValueOnce({ kind: 'available', witness: CLAIM_CURRENTNESS })
        .mockResolvedValueOnce({ kind: 'available', witness: START_CURRENTNESS })
        .mockResolvedValueOnce({ kind: 'available', witness: START_CURRENTNESS }),
      claimed,
    });

    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
      directory: '/tmp/frozen-claim',
    }));
    expect(axiosPost).toHaveBeenCalledWith(
      expect.stringMatching(/\/v3\/automations\/runs\/run-1\/start$/),
      expect.objectContaining({ accountCurrentness: CLAIM_CURRENTNESS }),
      expect.anything(),
    );
    expect(axiosPost).toHaveBeenCalledWith(
      expect.stringMatching(/\/v3\/automations\/runs\/run-1\/succeed$/),
      expect.objectContaining({
        accountCurrentness: START_CURRENTNESS,
        producedSessionId: 'session-frozen-v2',
      }),
      expect.anything(),
    );

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

  it('retries one ambiguous V3 claim response with the exact signed request', async () => {
    axiosGet.mockResolvedValue({ data: { assignments: [], settings: DEFAULT_WORKER_SETTINGS } });
    const createPublisherHeader = vi.fn<CreatePluginInstallationPublisherHeader>(async () => 'signed-machine-proof');
    axiosPost
      .mockRejectedValueOnce({ request: {} })
      .mockResolvedValueOnce({ data: { run: null, automation: null, accountCurrentness: null } });

    const client = createAutomationClaimClient({ token: 'token-claim-retry', createPublisherHeader });
    await client.fetchAssignments('machine-claim-retry');

    await expect(client.claimRun({ machineId: 'machine-claim-retry', leaseDurationMs: 45_000 })).resolves.toEqual({
      protocol: 'v3',
      run: null,
      automation: null,
    });
    expect(axiosPost).toHaveBeenCalledTimes(2);
    expect(axiosPost.mock.calls[0]?.[1]).toBe(axiosPost.mock.calls[1]?.[1]);
    expect(axiosPost.mock.calls[0]?.[2]?.headers).toBe(axiosPost.mock.calls[1]?.[2]?.headers);
    expect(createPublisherHeader.mock.calls.filter(([request]) => request.method === 'POST')).toHaveLength(1);
  });

  it('does not retry a V3 claim after receiving an HTTP response', async () => {
    axiosGet.mockResolvedValue({ data: { assignments: [], settings: DEFAULT_WORKER_SETTINGS } });
    axiosPost.mockRejectedValue({ response: { status: 503 } });

    const client = createAutomationClaimClient({ token: 'token-claim-http-failure' });
    await client.fetchAssignments('machine-claim-http-failure');

    await expect(client.claimRun({ machineId: 'machine-claim-http-failure', leaseDurationMs: 45_000 })).rejects.toEqual({
      response: { status: 503 },
    });
    expect(axiosPost).toHaveBeenCalledTimes(1);
  });

  it('does not retry a cancelled V3 claim request', async () => {
    axiosGet.mockResolvedValue({ data: { assignments: [], settings: DEFAULT_WORKER_SETTINGS } });
    const cancelled = Object.assign(new Error('cancelled'), { code: 'ERR_CANCELED' });
    axiosPost.mockRejectedValue(cancelled);

    const client = createAutomationClaimClient({ token: 'token-claim-cancelled' });
    await client.fetchAssignments('machine-claim-cancelled');

    await expect(client.claimRun({ machineId: 'machine-claim-cancelled', leaseDurationMs: 45_000 })).rejects.toBe(cancelled);
    expect(axiosPost).toHaveBeenCalledTimes(1);
  });

  it('preserves one server-admitted session-lifecycle trigger cause without re-evaluating it in the worker', async () => {
    axiosGet.mockResolvedValue({ data: { assignments: [], settings: DEFAULT_WORKER_SETTINGS } });
    const cause = {
      kind: 'trigger' as const,
      triggerId: 'trigger-parent-turn',
      triggerRevision: 7,
      triggerKind: 'sessionLifecycle' as const,
      occurrenceKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      occurredAt: 1_723_247_201_000,
      evidence: {
        event: 'parentTurnCompleted' as const,
        sourceSessionId: 'session-1',
        sourceTurnId: 'turn-1',
        policy: { kind: 'currentTurn' as const },
      },
    };
    axiosPost.mockResolvedValue({
      data: {
        run: {
          id: 'run-parent-turn',
          automationId: 'automation-parent-turn',
          attempt: 1,
          revision: 0,
          recipeKind: 'legacy',
          triggerId: 'trigger-parent-turn',
          triggerRetired: false,
          cause,
          executionInputEnvelope: JSON.stringify({ v: 1 }),
        },
        automation: { id: 'automation-parent-turn', name: 'After parent turn', enabled: true },
        accountCurrentness: CLAIM_CURRENTNESS,
      },
    });

    const client = createAutomationClaimClient({ token: 'token-parent-turn' });
    await client.fetchAssignments('machine-parent-turn');

    await expect(client.claimRun({ machineId: 'machine-parent-turn', leaseDurationMs: 45_000 })).resolves.toEqual({
      protocol: 'v3',
      run: {
        id: 'run-parent-turn',
        automationId: 'automation-parent-turn',
        attempt: 1,
        revision: 0,
        recipeKind: 'legacy',
        triggerId: 'trigger-parent-turn',
        cause,
        executionInputEnvelope: JSON.stringify({ v: 1 }),
        resultDelivery: { kind: 'none' },
      },
      automation: { id: 'automation-parent-turn', name: 'After parent turn', enabled: true },
      accountCurrentness: CLAIM_CURRENTNESS,
    });
  });

  it('rejects a V3 legacy origin instead of deciding that a cause-free automatic Run is safe to retry through V2', async () => {
    axiosGet.mockResolvedValue({ data: { assignments: [], settings: DEFAULT_WORKER_SETTINGS } });
    axiosPost.mockResolvedValue({
      data: {
        run: {
          id: 'run-legacy-origin',
          automationId: 'automation-legacy-origin',
          attempt: 1,
          origin: { kind: 'scheduled', scheduledFor: 1_723_247_201_000 },
          executionInputEnvelope: JSON.stringify({ v: 1 }),
        },
        automation: { id: 'automation-legacy-origin', name: 'Legacy', enabled: true },
        accountCurrentness: CLAIM_CURRENTNESS,
      },
    });

    const client = createAutomationClaimClient({ token: 'token-legacy-origin' });
    await client.fetchAssignments('machine-legacy-origin');

    await expect(client.claimRun({ machineId: 'machine-legacy-origin', leaseDurationMs: 45_000 })).rejects.toThrow();
    expect(axiosPost).toHaveBeenCalledTimes(1);
    expect(axiosPost.mock.calls[0]?.[0]).toMatch(/\/v3\/automations\/runs\/claim$/);
  });

  it('preserves the server-frozen final-result correspondence on a V3 claim', async () => {
    axiosGet.mockResolvedValue({ data: { assignments: [], settings: DEFAULT_WORKER_SETTINGS } });
    axiosPost.mockResolvedValue({
      data: {
        run: {
          id: 'run-final',
          automationId: 'automation-final',
          attempt: 1,
          revision: 0,
          recipeKind: 'legacy',
          triggerId: null,
          triggerRetired: false,
          cause: {
            kind: 'conversation',
            occurrenceKey: 'A'.repeat(43),
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
            cause: {
              kind: 'conversation',
              occurrenceKey: 'A'.repeat(43),
              occurredAt: 1_723_247_201_000,
            },
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
      protocol: 'v3',
      runId: 'run/1',
      machineId: 'm1',
      attempt: 2,
      accountCurrentness: CLAIM_CURRENTNESS,
    })).resolves.toEqual(START_CURRENTNESS);
    await client.heartbeatRun({ protocol: 'v3', runId: 'run/1', machineId: 'm1', attempt: 2, leaseDurationMs: 12_000 });
    await client.succeedRun({
      protocol: 'v3',
      runId: 'run/1',
      machineId: 'm1',
      attempt: 2,
      accountCurrentness: START_CURRENTNESS,
      producedSessionId: 's1',
    });
    await client.failRun({
      protocol: 'v3',
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

  it('surfaces a current assignment endpoint becoming unavailable after a successful read', async () => {
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
            revision: 0,
            recipeKind: 'legacy',
            triggerId: 'trigger-event',
            triggerRetired: false,
            cause: {
              kind: 'trigger',
              triggerId: 'trigger-event',
              triggerRevision: 1,
              triggerKind: 'pluginEvent',
              occurrenceKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
              occurredAt: 1_723_247_201_000,
              evidence: {
                eventRef: { pluginId: 'com.example.event', localId: 'issue-opened' },
                sourceSelectorId: '9d5af559-2c82-4c22-b6a0-ecabce38a631',
              },
            },
            executionInputEnvelope: '{"kind":"happier_automation_run_execution_recipe_v1"}',
          },
          automation: { id: 'automation-event', name: 'Event', enabled: true },
          accountCurrentness: CLAIM_CURRENTNESS,
        },
      })
      .mockResolvedValueOnce({ data: START_RESPONSE })
      .mockResolvedValueOnce({ data: undefined })
      .mockResolvedValueOnce({
        data: { run: null, automation: null, accountCurrentness: null },
      });

    const client = createAutomationClaimClient({ token: 'token-active-v3-sticky' });
    await client.fetchAssignments('machine-1');
    await client.claimRun({ machineId: 'machine-1', leaseDurationMs: 30_000 });

    v3Available = false;
    await expect(client.fetchAssignments('machine-1')).rejects.toMatchObject({
      response: { status: 404 },
    });
    await client.startRun({
      protocol: 'v3',
      runId: 'run-v3',
      machineId: 'machine-1',
      attempt: 1,
      accountCurrentness: CLAIM_CURRENTNESS,
    });
    await client.succeedRun({
      protocol: 'v3',
      runId: 'run-v3',
      machineId: 'machine-1',
      attempt: 1,
      accountCurrentness: START_CURRENTNESS,
    });
    await expect(client.claimRun({ machineId: 'machine-1', leaseDurationMs: 30_000 })).resolves.toEqual({
      protocol: 'v3',
      run: null,
      automation: null,
    });

    expect(axiosPost.mock.calls.map((call) => call[0])).toEqual([
      expect.stringMatching(/\/v3\/automations\/runs\/claim$/),
      expect.stringMatching(/\/v3\/automations\/runs\/run-v3\/start$/),
      expect.stringMatching(/\/v3\/automations\/runs\/run-v3\/succeed$/),
      expect.stringMatching(/\/v3\/automations\/runs\/claim$/),
    ]);
  });

  it('surfaces a missing V3 claim endpoint after V3 assignments select the current protocol', async () => {
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
    axiosPost.mockImplementationOnce((url: unknown) => Promise.reject(createAxios404(String(url))));

    const client = createAutomationClaimClient({ token: 'token-v3-claim-required' });
    await client.fetchAssignments('machine-1');
    await expect(client.claimRun({ machineId: 'machine-1', leaseDurationMs: 30_000 })).rejects.toMatchObject({
      response: { status: 404 },
    });

    expect(axiosPost.mock.calls.map((call) => call[0])).toEqual([
      expect.stringMatching(/\/v3\/automations\/runs\/claim$/),
    ]);
  });

  it('keeps V3 selected when an overlapping older V3 claim fails after a newer V3 assignment read', async () => {
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
      throw new Error(`Unexpected Automation request: ${requestUrl}`);
    });

    const client = createAutomationClaimClient({ token: 'token-overlapping-v3-claim' });
    await client.fetchAssignments('machine-1');
    const olderClaim = client.claimRun({ machineId: 'machine-1', leaseDurationMs: 30_000 });
    await v3ClaimStarted;

    await client.fetchAssignments('machine-1');
    rejectOlderV3Claim(createAxios404(olderV3ClaimUrl));
    await expect(olderClaim).rejects.toMatchObject({ response: { status: 404 } });

    await expect(client.claimRun({ machineId: 'machine-1', leaseDurationMs: 30_000 })).resolves.toEqual({
      protocol: 'v3',
      run: null,
      automation: null,
    });
    expect(axiosPost.mock.calls.map((call) => call[0])).toEqual([
      expect.stringMatching(/\/v3\/automations\/runs\/claim$/),
      expect.stringMatching(/\/v3\/automations\/runs\/claim$/),
    ]);
  });


});
