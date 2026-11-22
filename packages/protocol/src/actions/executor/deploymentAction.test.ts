import { createDeploymentEnvironmentHeaderV1, createDeploymentReceiptHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { describe, expect, it, vi } from 'vitest';
import { createActionExecutor } from '../actionExecutor.js';
import { normalizeActionsSettingsV1, setActionApprovalOverride, setScopedActionApprovalPreference } from '../actionSettings.js';
import { createDeploymentApprovalScopeResolverV1 } from '../../deployments/deploymentApprovalScopeV1.js';
import type { ActionExecutorDeps } from './types.js';

describe('deployment receipt list Action', () => {
  it('projects header-based recovery without opening retained content', async () => {
    const failed = createDeploymentReceiptHeaderV1({ id: 'failed', state: 'failed' });
    const succeeded = createDeploymentReceiptHeaderV1({ id: 'succeeded' });
    const input = { serverId: 'home', environmentId: failed.environmentId };
    const environment = createDeploymentEnvironmentHeaderV1({ id: input.environmentId, serverId: input.serverId });
    // The Home metadata transport is the boundary. Both callers use the real Action executor.
    const deploymentAction: NonNullable<ActionExecutorDeps['deploymentAction']> = async actionId =>
      actionId === 'deployments.environments.get' ? { ok: true, environment, targetLinks: [] }
        : { ok: true, items: [failed, succeeded], nextCursor: 'next-page' };
    const executor = createActionExecutor({
      deploymentAction,
      resolveEnvironmentApprovalScope: createDeploymentApprovalScopeResolverV1(deploymentAction),
    });
    const ui = await executor.execute('deployments.receipts.list', input, {
      surface: 'ui', authority: 'present_user', serverId: input.serverId,
    });
    const cli = await executor.execute('deployments.receipts.list', input, {
      surface: 'cli', authority: 'present_user', serverId: input.serverId,
    });
    expect(ui).toEqual({ ok: true, result: { ok: true, items: [
      { ...failed, requiredFact: 'deploymentActionResult', remedy: expect.any(String) },
      succeeded,
    ], nextCursor: 'next-page' } });
    expect(cli).toEqual(ui);
  });
});

describe('present-user deployment read approval', () => {
  it.each([
    { scope: 'Account', nativeConfirmation: true },
    { scope: 'Account', nativeConfirmation: false },
    { scope: 'Environment', nativeConfirmation: true },
    { scope: 'Preview template', nativeConfirmation: true },
  ])('honors an explicit $scope Ask before listing Domains (native confirmation: $nativeConfirmation)', async ({ scope: selectedScope, nativeConfirmation }) => {
    const environment = selectedScope === 'Preview template'
      ? createDeploymentEnvironmentHeaderV1({ purpose: 'preview', previewTemplateEnvironmentId: 'template',
        previewRepositoryId: 'source-app', previewPullRequestId: '17', previewTargetLinkId: 'template-runtime' })
      : createDeploymentEnvironmentHeaderV1();
    const scope = { kind: 'environment' as const,
      environmentId: environment.previewTemplateEnvironmentId ?? environment.id };
    const actionId = 'deployments.domains.list';
    const input = { serverId: environment.serverId, environmentId: environment.id };
    const baseSettings = normalizeActionsSettingsV1({ v: 1 });
    const settings = selectedScope === 'Account'
      ? setActionApprovalOverride({ settings: baseSettings, actionId, surface: 'ui', approvalRequired: true })
      : setScopedActionApprovalPreference({ settings: baseSettings, scope, actionId, surface: 'ui', mode: 'required' });
    const requests: string[] = [];
    const deploymentAction: NonNullable<ActionExecutorDeps['deploymentAction']> = async id => {
      requests.push(id);
      return id === 'deployments.environments.get' ? { ok: true, environment, targetLinks: [] }
        : { ok: true, environmentId: environment.id, revision: environment.revision, domains: [], nextCursor: null };
    };
    const reviewed: unknown[] = [];
    const approvalsCreate = vi.fn<NonNullable<ActionExecutorDeps['approvalsCreate']>>();
    const executor = createActionExecutor({
      deploymentAction, readActionsSettings: () => settings, approvalsCreate,
      resolveEnvironmentApprovalScope: createDeploymentApprovalScopeResolverV1(deploymentAction),
      ...(nativeConfirmation ? { presentUserActionConfirmation: async ({ actionId, input }) => {
        reviewed.push({ actionId, input });
        return false;
      } } : {}),
    });
    const result = await executor.execute(actionId, input, { surface: 'ui', authority: 'present_user', serverId: input.serverId });
    expect(result).toMatchObject(nativeConfirmation ? { ok: false, errorCode: 'approval_canceled' }
      : { ok: false, errorCode: 'action_interactive_review_required', details: { review: { actionArgs: input } } });
    expect(reviewed).toEqual(nativeConfirmation ? [{ actionId, input }] : []);
    expect(approvalsCreate).not.toHaveBeenCalled();
    expect(requests).toEqual(['deployments.environments.get']);
  });
});
