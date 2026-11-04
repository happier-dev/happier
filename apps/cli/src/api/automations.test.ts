import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAutomationDefinition, deleteAutomationDefinition, getAutomationDefinition, listAutomationDefinitionDetails, listAutomationDefinitions, reconcileAutomationDefinition, runAutomationNowReceipt } from './automations';
import { normalizeWorkflowActionThrownError } from '@happier-dev/protocol/actions/executor/workflowAccountActions';

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

  it('patches only the admitted recipe through the existing Automation definition owner', async () => {
    const controller = new AbortController();
    const executionRecipe = { v: 2 as const, templateVersion: 2, triggerEvidence: null,
      managedTarget: null, workflow: { t: 'plain' as const, v: { workspace: { directory: '/repo' },
        executionTarget: { kind: 'session' as const }, inlineDefinition: { version: 1 as const,
          blocks: [{ kind: 'wait' as const, id: 'wait', document: { text: 'Wait', references: [], attachments: [] } }] } } } };
    const row = { id: 'automation-1', name: 'Renamed', description: null, enabled: false,
      workflowDefinitionId: null, scopeSessionId: null, targetType: null, existingSessionId: null,
      templateVersion: 2, lastRunAt: null, createdAt: 1, updatedAt: 1, assignments: [], triggers: [], executionRecipe };
    request.mockResolvedValue({ status: 200, data: row });
    const { updateAutomationDefinition } = await import('./automations');
    await expect(updateAutomationDefinition({ token: 'token-1', automationId: row.id, signal: controller.signal,
      input: { expectedTemplateVersion: 1, executionRecipe } })).resolves.toEqual(row);
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ method: 'PATCH',
      url: 'https://api.example.test/v3/automations/automation-1', signal: controller.signal,
      data: { expectedTemplateVersion: 1, executionRecipe } }));
  });

  it.each([
    { managedTarget: { homeId: 'home-one', managedId: 'managed-one' }, includeUnindexedManagedTargets: true as const },
    { managedTargetUnindexed: true as const },
  ])('sends a managed relationship select through the structured query owner', async query => {
    post.mockResolvedValue({ status: 200, data: { automations: [], nextCursor: null } });
    get.mockResolvedValue({ status: 200, data: { automations: [], nextCursor: null } });
    await listAutomationDefinitions({ token: 'token-1', ...query });
    expect(get).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]?.slice(0, 2)).toEqual(['https://api.example.test/v3/automations/query', expect.objectContaining(query)]);
  });

  it('reads a selected detail page with its cursor and private definition arm in one authenticated request', async () => {
    const controller = new AbortController();
    const row = { id: 'automation-one', name: 'Triggers', description: null, enabled: true,
      workflowDefinitionId: null, scopeSessionId: 'session-one', targetType: null, existingSessionId: null,
      templateVersion: 1, lastRunAt: null, createdAt: 1, updatedAt: 1, assignments: [], triggers: [],
      observationOnly: { kind: 'observationOnly', templateVersion: 1 } };
    post.mockResolvedValue({ status: 200, data: { automations: [row], nextCursor: 'next-page' } });
    const selection = { limit: 70, cursor: 'previous-page', workflowDefinitionIds: ['builtin:review'], scopeSessionId: 'session-one' };
    await expect(listAutomationDefinitionDetails({ token: 'token-1', signal: controller.signal, ...selection }))
      .resolves.toEqual({ automations: [row], nextCursor: 'next-page' });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith('https://api.example.test/v3/automations/query',
      { ...selection, details: true }, expect.objectContaining({ signal: controller.signal,
        headers: expect.objectContaining({ Authorization: 'Bearer token-1' }) }));
    expect(get).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it('rejects a summary-only reply to a detail read without retrying singleton reads', async () => {
    const summary = { id: 'automation-one', name: 'Triggers', description: null, enabled: true,
      workflowDefinitionId: null, scopeSessionId: null, targetType: null, existingSessionId: null,
      templateVersion: 1, lastRunAt: null, createdAt: 1, updatedAt: 1, assignments: [], triggers: [] };
    post.mockResolvedValue({ status: 200, data: { automations: [summary], nextCursor: null } });
    await expect(listAutomationDefinitionDetails({ token: 'token-1' })).rejects.toThrow();
    expect(post).toHaveBeenCalledTimes(1);
    expect(get).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it.each(['list', 'details', 'get', 'reconcile'] as const)('cancels an authenticated %s operation at its HTTP boundary', async operation => {
    const controller = new AbortController();
    controller.abort();
    const aborted = new Error('cancelled');
    const response = { status: 200, data: { automations: [], nextCursor: null } };
    const observeCancellation = (options: { signal?: AbortSignal }) => options.signal?.aborted
      ? Promise.reject(aborted) : Promise.resolve(response);
    post.mockImplementation((_url, _body, options) => observeCancellation(options));
    request.mockImplementation(options => observeCancellation(options));
    const pending = operation === 'list' ? listAutomationDefinitions({ token: 'token-1', managedTargetUnindexed: true, signal: controller.signal })
      : operation === 'details' ? listAutomationDefinitionDetails({ token: 'token-1', signal: controller.signal })
      : operation === 'get' ? getAutomationDefinition({ token: 'token-1', automationId: 'automation-1', signal: controller.signal })
        : reconcileAutomationDefinition({ token: 'token-1', automationId: 'automation-1', signal: controller.signal, input: {
          expectedTemplateVersion: 1, name: 'Triggers', description: null, enabled: true, assignments: [], triggers: [], removedTriggers: [],
        } });
    if (operation === 'reconcile') await expect(pending).rejects.toMatchObject({ code: 'workflow_outcome_unresolved', cause: aborted });
    else await expect(pending).rejects.toBe(aborted);
  });

  it.each(['run', 'list', 'details', 'get', 'create', 'reconcile', 'delete'] as const)(
    'preserves typed HTTP refusal through the Workflow failure consumer for %s without disclosing raw content', async operation => {
      const response = { status: 400, data: { code: 'FST_ERR_VALIDATION', error: 'Bad Request',
        message: 'private validation input', headers: { authorization: 'private credential' } } };
      post.mockResolvedValue(response);
      get.mockResolvedValue(response);
      request.mockResolvedValue(response);
      const input = { automationId: 'automation-1', name: 'Triggers', enabled: true,
        executionRecipe: { v: 2 as const, templateVersion: 1, triggerEvidence: null, workflow: { t: 'plain' as const, v: { inlineDefinition: {
          version: 1 as const, blocks: [{ kind: 'wait' as const, id: 'wait', document: { text: 'Wait', references: [], attachments: [] } }],
        }, executionTarget: { kind: 'session' as const }, workspace: { directory: '/work' } } } }, assignments: [], triggers: [] };
      const invoke = () => {
        switch (operation) {
          case 'run': return runAutomationNowReceipt({ token: 'token-1', automationId: 'automation-1' });
          case 'list': return listAutomationDefinitions({ token: 'token-1' });
          case 'details': return listAutomationDefinitionDetails({ token: 'token-1' });
          case 'get': return getAutomationDefinition({ token: 'token-1', automationId: 'automation-1' });
          case 'create': return createAutomationDefinition({ token: 'token-1', input });
          case 'reconcile': return reconcileAutomationDefinition({ token: 'token-1', automationId: 'automation-1', input: {
            expectedTemplateVersion: 1, name: 'Triggers', description: null, enabled: true, assignments: [], triggers: [], removedTriggers: [],
          } });
          case 'delete': return deleteAutomationDefinition({ token: 'token-1', automationId: 'automation-1' });
        }
      };
      const failure = await invoke().catch(normalizeWorkflowActionThrownError);
      expect(failure).toMatchObject({ ok: false, errorCode: 'workflow_http_error',
        error: expect.stringContaining('FST_ERR_VALIDATION'), details: { status: 400, code: 'FST_ERR_VALIDATION' } });
      expect(JSON.stringify(failure)).not.toContain('private');
    });

  it('keeps unknown HTTP bodies private while preserving the response status', async () => {
    post.mockResolvedValue({ status: 502, data: { error: 'private_token_value', message: 'private response', details: { secret: 'private' } } });
    const failure = await runAutomationNowReceipt({ token: 'token-1', automationId: 'automation-1' }).catch(normalizeWorkflowActionThrownError);
    expect(failure).toEqual({ ok: false, errorCode: 'workflow_outcome_unresolved', error: expect.any(String) });
    expect(JSON.stringify(failure)).not.toContain('private');
  });

  it('returns removed-revision evidence and preserves older success receipts without inventing evidence', async () => {
    request.mockResolvedValue({ status: 200, data: { ok: true, removedRevision: 11 } });
    await expect(deleteAutomationDefinition({ token: 'token-1', automationId: 'automation-1' }))
      .resolves.toEqual({ ok: true, removedRevision: 11 });
    request.mockResolvedValue({ status: 200, data: { ok: true } });
    await expect(deleteAutomationDefinition({ token: 'token-1', automationId: 'automation-1' }))
      .resolves.toEqual({ ok: true });
  });
  it.each(['lost', 'invalid', 'server'] as const)('keeps a %s definition mutation receipt unresolved through the real failure reader', async kind => {
    const input = { expectedTemplateVersion: 1, name: 'Triggers', description: null, enabled: true,
      assignments: [], triggers: [], removedTriggers: [] };
    if (kind === 'lost') request.mockRejectedValueOnce(Object.assign(new Error('timeout'), { code: 'ECONNABORTED' }));
    else request.mockResolvedValueOnce({ status: kind === 'server' ? 500 : 200, data: {} });
    const result = await reconcileAutomationDefinition({ token: 'token-1', automationId: 'automation-1', input })
      .catch(normalizeWorkflowActionThrownError);
    expect(result).toMatchObject({ ok: false, errorCode: 'workflow_outcome_unresolved' });
    expect(request).toHaveBeenCalledTimes(1);
  });

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

  it.each([
    ['automation_template_version_conflict', 409, 'currentness_conflict'],
    ['automation_trigger_revision_conflict', 409, 'currentness_conflict'],
    ['automation_stored_content_unavailable', 409, 'content_unavailable'],
    ['credential_scope_denied', 403, 'run_access_denied'],
  ] as const)('preserves canonical %s semantics at the Workflow transport boundary', async (error, status, code) => {
    request.mockResolvedValue({ status, data: { error } });
    await expect(reconcileAutomationDefinition({ token: 'token-1', automationId: 'automation-1', input: {
      expectedTemplateVersion: 1, name: 'Triggers', description: null, enabled: true,
      assignments: [], triggers: [], removedTriggers: [],
    } })).rejects.toMatchObject({ code });
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
        headers: expect.objectContaining({
          Authorization: 'Bearer token-1',
          'Idempotency-Key': 'ci-build-42',
        }),
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

  it.each([listAutomationDefinitions, listAutomationDefinitionDetails])('preserves authentication rejection from the current Automation list owner', async list => {
    get.mockResolvedValue({ status: 401, data: { error: 'unauthorized' } });
    post.mockResolvedValue({ status: 401, data: { error: 'unauthorized' } });

    await expect(list({ token: 'token-1', limit: 20 })).rejects.toMatchObject({
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
