import { describe, expect, it, vi } from 'vitest';

import { buildApprovalPreviewSummary, createActionExecutor } from './actionExecutor.js';
import { getActionSpec } from './actionSpecs.js';
import { normalizeActionsSettingsV1 } from './actionSettings.js';
import type { ActionExecutorDeps } from './executor/types.js';

const input = { controllerMachineId: 'machine-a', relationshipId: 'relationship-a' };
const result = { v: 1 as const, relationshipId: 'relationship-a', terminated: true as const };

function executorWith(deps: Record<string, unknown>) {
  return createActionExecutor({
    ...deps,
  } as unknown as ActionExecutorDeps);
}

describe('workspace.sync.relationship.terminate Action', () => {
  it('publishes a strict destructive Agent Action and delegates the admitted subject once', async () => {
    const terminate = vi.fn(async () => result);
    const actionId = 'workspace.sync.relationship.terminate' as never;
    const spec = getActionSpec(actionId);
    expect(spec).toMatchObject({ safety: 'danger', surfaces: { ui: true, agent: true, mcp: true } });
    expect(buildApprovalPreviewSummary(spec, input)).toBe(
      'Sync will stop and the link between these folders will be removed. Files in both workspaces stay in place.',
    );
    expect(spec.inputSchema.safeParse({ ...input, extra: true }).success).toBe(false);
    expect(spec.outputSchema?.safeParse({ ...result, extra: true }).success).toBe(false);

    const response = await executorWith({ workspaceSyncRelationshipTerminate: terminate }).execute(actionId, input, {
      surface: 'ui', authority: 'present_user', serverId: 'home-a', actionRequestId: 'terminate-a',
      actionsSettings: normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { [actionId]: ['ui'] } }),
    });
    expect(response).toEqual({ ok: true, result });
    expect(terminate).toHaveBeenCalledWith({ input, serverId: 'home-a', context: expect.objectContaining({ surface: 'ui', authority: 'present_user' }) });
  });

  it('fails closed when the relationship termination dependency is disconnected', async () => {
    const actionId = 'workspace.sync.relationship.terminate' as never;
    await expect(executorWith({}).execute(actionId, input, {
      surface: 'ui', authority: 'present_user', serverId: 'home-a', actionRequestId: 'terminate-a',
      actionsSettings: normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { [actionId]: ['ui'] } }),
    })).resolves.toMatchObject({ ok: false, errorCode: 'unsupported_action' });
  });
});

describe('workspace Sync relationship reversible lifecycle Actions', () => {
  const cases = [
    ['workspace.sync.relationship.disable', 'workspaceSyncRelationshipDisable', { v: 1, relationshipId: 'relationship-a', enabled: false }],
    ['workspace.sync.relationship.enable', 'workspaceSyncRelationshipEnable', { v: 1, relationshipId: 'relationship-a', enabled: true }],
    ['workspace.sync.relationship.flush', 'workspaceSyncRelationshipFlush', { v: 1, relationshipId: 'relationship-a', status: {
      relationshipId: 'relationship-a', controllerMachineId: 'machine-a', state: 'watching', alphaPath: '/alpha', betaPath: '/beta',
      mode: 'keep_both_in_sync', endpointStates: { alpha: null, beta: null }, conflictCount: 0, lastCycleObservedAtMs: 1,
    } }],
  ] as const;

  it.each(cases)('%s publishes a strict UI/Agent/MCP contract and delegates through the real executor', async (actionId, dependency, output) => {
    const effect = vi.fn(async () => output);
    const spec = getActionSpec(actionId as never);
    expect(spec).toMatchObject({ approvalPolicy: { uiConfirmation: 'direct' }, surfaces: { ui: true, agent: true, mcp: true } });
    expect(spec.inputSchema.safeParse({ ...input, extra: true }).success).toBe(false);
    expect(spec.outputSchema?.safeParse({ ...output, extra: true }).success).toBe(false);

    await expect(executorWith({ [dependency]: effect }).execute(actionId as never, input, {
      surface: 'ui', authority: 'present_user', serverId: 'home-a',
    })).resolves.toEqual({ ok: true, result: output });
    expect(effect).toHaveBeenCalledWith({ input, serverId: 'home-a', context: expect.objectContaining({
      surface: 'ui', authority: 'present_user', serverId: 'home-a', executeHostReviewedChildAction: expect.any(Function),
    }) });
  });

  it.each(cases)('%s fails closed when its executor dependency is disconnected', async (actionId) => {
    await expect(executorWith({}).execute(actionId as never, input, {
      surface: 'ui', authority: 'present_user', serverId: 'home-a',
    })).resolves.toMatchObject({ ok: false, errorCode: 'unsupported_action' });
  });

  it.each(cases)('%s composes UI-direct policy while Settings Ask and Agent retain approval', async (actionId, dependency, output) => {
    const effect = vi.fn(async () => output);
    const executor = createActionExecutor({ [dependency]: effect } as unknown as ActionExecutorDeps);
    await expect(executor.execute(actionId as never, input, {
      surface: 'ui', authority: 'present_user', serverId: 'home-a',
    })).resolves.toEqual({ ok: true, result: output });

    const settings = normalizeActionsSettingsV1({ v: 1, actions: {
      [actionId]: { approvalRequiredSurfaces: ['ui'] },
    } });
    await expect(executor.execute(actionId as never, input, {
      surface: 'ui', authority: 'present_user', serverId: 'home-a', actionsSettings: settings,
    })).resolves.toMatchObject({ ok: false, errorCode: 'action_interactive_review_required' });
    await expect(executor.execute(actionId as never, input, {
      surface: 'agent', authority: 'account_automation', serverId: 'home-a',
    })).resolves.toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
    expect(effect).toHaveBeenCalledTimes(1);
  });
});
