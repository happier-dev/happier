import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listAutomationDefinitions, reconcileAutomationDefinition, runAutomationNowReceipt } from './automations';

const { get, post, request } = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  request: vi.fn(),
}));
vi.mock('axios', () => ({ default: { get, post, request } }));
vi.mock('@/session/transport/http/serverHttpBaseUrl', () => ({
  resolveServerHttpBaseUrl: () => 'https://api.example.test',
}));

const admittedRun = {
  id: 'run-1', automationId: 'automation-1', revision: 1, triggerId: null, triggerRetired: false,
  state: 'queued' as const, cause: { kind: 'manual' as const, invokedAt: 1 },
  dueAt: 1, claimedAt: null, startedAt: null, finishedAt: null, claimedByMachineId: null,
  leaseExpiresAt: null, attempt: 0, errorCode: null, producedSessionId: null,
  executionDispatchState: null, executionAttempt: 0, replyHandoffState: 'none' as const,
  replyHandoffAttempt: 0, replyHandoffDueAt: null, createdAt: 1, updatedAt: 1,
};

describe('runAutomationNow', () => {
  beforeEach(() => {
    get.mockReset();
    post.mockReset();
    request.mockReset();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('unexpected_capability_probe')));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('preserves the complete saved-occurrence receipt and rejects mismatched Workflow Run correspondence', async () => {
    const receipt = { run: admittedRun, workflowRun: { recipeKind: 'workflow-v2' as const, workflowRunId: 'run-1' } };
    post.mockResolvedValue({ status: 200, data: receipt });
    await expect(runAutomationNowReceipt({ token: 'token-1', automationId: 'automation-1' })).resolves.toEqual(receipt);
    post.mockResolvedValue({ status: 200, data: { ...receipt,
      workflowRun: { ...receipt.workflowRun, workflowRunId: 'another-run' } } });
    await expect(runAutomationNowReceipt({ token: 'token-1', automationId: 'automation-1' })).rejects.toThrow();
  });
  it('distinguishes a lost or invalid admission reply from a known HTTP refusal without retrying', async () => {
    post.mockRejectedValueOnce(new Error('Reply lost'));
    await expect(runAutomationNowReceipt({ token: 'token-1', automationId: 'automation-1' }))
      .rejects.toMatchObject({ code: 'workflow_outcome_unresolved' });
    expect(post).toHaveBeenCalledTimes(1);
    post.mockResolvedValueOnce({ status: 200, data: { run: admittedRun, workflowRun: { recipeKind: 'workflow-v2', workflowRunId: 'another-run' } } });
    await expect(runAutomationNowReceipt({ token: 'token-1', automationId: 'automation-1' }))
      .rejects.toMatchObject({ code: 'workflow_outcome_unresolved' });
    post.mockResolvedValueOnce({ status: 409, data: { error: 'automation_disabled' } });
    await expect(runAutomationNowReceipt({ token: 'token-1', automationId: 'automation-1' }))
      .rejects.toMatchObject({ code: 'automation_disabled' });
    post.mockResolvedValueOnce({ status: 401, data: { error: 'unauthorized' } });
    await expect(runAutomationNowReceipt({ token: 'token-1', automationId: 'automation-1' }))
      .rejects.toMatchObject({ code: 'not_authenticated' });
  });

  it('preserves the canonical V3 revision conflict at the Workflow transport boundary', async () => {
    request.mockResolvedValue({ status: 409, data: { error: 'automation_template_version_conflict' } });
    await expect(reconcileAutomationDefinition({ token: 'token-1', automationId: 'automation-1', input: {
      expectedTemplateVersion: 1, name: 'Triggers', description: null, enabled: true,
      assignments: [], triggers: [], removedTriggers: [],
    } })).rejects.toMatchObject({ code: 'currentness_conflict' });
  });

  it('uses the authenticated V3 definition-list owner and validates its response', async () => {
    get.mockResolvedValue({
      status: 200,
      data: { automations: [], nextCursor: null },
    });

    await expect(listAutomationDefinitions({ token: 'token-1' })).resolves.toEqual({
      automations: [],
      nextCursor: null,
    });

    expect(get).toHaveBeenCalledWith(
      'https://api.example.test/v3/automations?limit=100',
      expect.objectContaining({
        headers: { Authorization: 'Bearer token-1' },
      }),
    );
  });

  it('forwards canonical trigger filters without probing the Home API epoch', async () => {
    get.mockResolvedValue({ status: 200, data: { automations: [], nextCursor: null } });
    const workflowDefinitionId = '11111111-1111-4111-8111-111111111111';
    await listAutomationDefinitions({ token: 'token-1', workflowDefinitionId, scopeSessionId: 'session-one' });
    expect(get).toHaveBeenLastCalledWith(
      `https://api.example.test/v3/automations?limit=100&workflowDefinitionId=${workflowDefinitionId}&scopeSessionId=session-one`,
      expect.anything());
    await expect(listAutomationDefinitions({ token: 'token-1', scope: 'account_inline' }))
      .resolves.toEqual({ automations: [], nextCursor: null });
    expect(get).toHaveBeenLastCalledWith(
      'https://api.example.test/v3/automations?limit=100&scope=account_inline', expect.anything());
    expect(fetch).not.toHaveBeenCalled();
  });

  it('uses the V3 run-now owner and sends the caller occurrence identity', async () => {
    post.mockResolvedValue({
      status: 200,
      data: { run: admittedRun },
    });

    await expect(runAutomationNowReceipt({
      token: 'token-1',
      automationId: 'automation/1',
      idempotencyKey: 'ci-build-42',
    })).resolves.toMatchObject({ run: { id: 'run-1' } });

    expect(post).toHaveBeenCalledWith(
      'https://api.example.test/v3/automations/automation%2F1/run-now',
      undefined,
      expect.objectContaining({
        headers: {
          Authorization: 'Bearer token-1',
          'Idempotency-Key': 'ci-build-42',
        },
      }),
    );
  });

  it('uses current pagination when the retired Automation API capability is absent', async () => {
    get.mockResolvedValue({
      status: 200,
      data: { automations: [], nextCursor: 'next-page' },
    });

    await expect(listAutomationDefinitions({ token: 'token-1', limit: 20, cursor: 'page-1' })).resolves.toEqual({
      automations: [],
      nextCursor: 'next-page',
    });
    expect(get).toHaveBeenCalledWith(
      'https://api.example.test/v3/automations?limit=20&cursor=page-1',
      expect.objectContaining({ headers: { Authorization: 'Bearer token-1' } }),
    );
  });

  it('preserves authentication rejection from the current Automation list owner', async () => {
    get.mockResolvedValue({ status: 401, data: { error: 'unauthorized' } });

    await expect(listAutomationDefinitions({ token: 'token-1', limit: 20 })).rejects.toMatchObject({
      response: { status: 401 },
      code: 'not_authenticated',
    });
  });

  it('runs an ordinary Automation through V3 without an API epoch advertisement', async () => {
    post.mockResolvedValue({
      status: 200,
      data: { run: { ...admittedRun, id: 'run-ordinary' } },
    });

    await expect(runAutomationNowReceipt({ token: 'token-1', automationId: 'automation-1' }))
      .resolves.toMatchObject({ run: { id: 'run-ordinary' } });
    expect(post).toHaveBeenCalledWith(
      'https://api.example.test/v3/automations/automation-1/run-now',
      undefined,
      expect.any(Object),
    );
  });
});
