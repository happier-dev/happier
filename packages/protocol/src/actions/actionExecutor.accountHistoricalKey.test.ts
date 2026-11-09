import { describe, expect, it, vi } from 'vitest';

import type { ActionId } from './actionIds.js';
import { createActionExecutor } from './actionExecutor.js';
import type { ActionExecutorDeps } from './executor/types.js';
import { ActionsSettingsV1Schema } from './actionSettings.js';
import { isApprovalRequiredByActionsSettings } from './actionApprovalPolicy.js';
import { resolveActionApprovalFlow } from './actionApprovalMetadata.js';
import { getActionSpec } from './actionSpecs.js';

function createDeps(): ActionExecutorDeps {
  return {
    executionRunStart: async () => ({}), executionRunList: async () => ({}),
    executionRunGet: async () => ({}), detachedExecutionRunSend: async () => ({}),
    executionRunStop: async () => ({}), executionRunAction: async () => ({}),
    executionRunWait: async () => ({}), sessionOpen: async () => ({}),
    sessionFork: async () => ({}), sessionRollback: async () => ({}),
    sessionSpawnNew: async () => ({}), pathsListRecent: async () => ({ items: [] }),
    machinesList: async () => ({ items: [] }), serversList: async () => ({ items: [] }),
    reviewEnginesList: async () => ({ items: [] }), agentsBackendsList: async () => ({ items: [] }),
    agentsModelsList: async () => ({ items: [] }), sessionSendMessage: async () => ({}),
    sessionPermissionRespond: async () => ({}), sessionUserActionAnswer: async () => ({}),
    sessionModeSet: async () => ({}), sessionModesList: async () => ({}),
    sessionTargetPrimarySet: async () => ({}), sessionTargetTrackedSet: async () => ({}),
    sessionList: async () => ({}), sessionActivityGet: async () => ({}),
    sessionRecentMessagesGet: async () => ({}), resetGlobalVoiceAgent: () => {},
  };
}

const actionId: ActionId = 'account.encryption.historicalKey.forget';
const presentUser = { surface: 'ui' as const, authority: 'present_user' as const, actionCaller: { kind: 'host' as const },
  presentUserConfirmation: { actionId } };

describe('historical Account encryption key Forget Action', () => {
  it('refuses a headless host without a device credential custodian', async () => {
    await expect(createActionExecutor(createDeps()).execute(actionId, {}, presentUser)).resolves.toMatchObject({
      ok: false, errorCode: 'target_unavailable',
    });
  });
  it('exposes the same client-owned destructive contract to Agent, MCP and plugin SDK callers', () => {
    expect(getActionSpec(actionId)).toMatchObject({ requiredAuthority: 'present_user', executionPlacement: 'client',
      safety: 'danger', surfaces: { agent: true, mcp: true, plugin: true, api: false },
      approval: { result: 'required' } });
    expect(resolveActionApprovalFlow(getActionSpec(actionId).approval)).toBe('blocking');
  });
  it.each(['forgotten', 'nothing_retained'] as const)('returns the credential owner’s typed %s outcome', async (status) => {
    // The device credential custodian is the external boundary; admission and dispatch stay real.
    const accountHistoricalEncryptionKeyForgetAction = vi.fn(async () => ({ status }));
    const executor = createActionExecutor(Object.assign(createDeps(), { accountHistoricalEncryptionKeyForgetAction }));
    await expect(executor.execute(actionId, {}, presentUser)).resolves.toEqual({ ok: true, result: { status } });
    await expect(executor.execute(actionId, { accountId: 'other' }, presentUser)).resolves.toMatchObject({
      ok: false, errorCode: 'invalid_parameters',
    });
    expect(accountHistoricalEncryptionKeyForgetAction).toHaveBeenCalledTimes(1);
  });

  it.each(['agent', 'mcp'] as const)('asks %s by default and runs once the user waives that Ask (no present-user floor)', async (surface) => {
    const accountHistoricalEncryptionKeyForgetAction = vi.fn(async () => ({ status: 'forgotten' as const }));
    let settings = ActionsSettingsV1Schema.parse({ v: 1 });
    const executor = createActionExecutor(Object.assign(createDeps(), {
      accountHistoricalEncryptionKeyForgetAction,
      isActionApprovalRequired: (id: ActionId, context: Parameters<typeof isApprovalRequiredByActionsSettings>[2]) =>
        isApprovalRequiredByActionsSettings(id, settings, context),
    }));
    const agent = { surface, authority: 'account_automation', actionCaller: { kind: 'host' } } as const;
    expect(await executor.execute(actionId, {}, agent)).not.toMatchObject({ ok: true });
    expect(accountHistoricalEncryptionKeyForgetAction).not.toHaveBeenCalled();
    settings = ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { [actionId]: [surface] } });
    expect(await executor.execute(actionId, {}, agent)).toEqual({ ok: true, result: { status: 'forgotten' } });
    expect(accountHistoricalEncryptionKeyForgetAction).toHaveBeenCalledOnce();
  });
});

describe('historical Account automation template recovery Action', () => {
  const recoveryActionId: ActionId = 'account.encryption.automationTemplates.recover';
  const recoveringUser = { ...presentUser, presentUserConfirmation: { actionId: recoveryActionId } };

  it('returns per-template custody outcomes through the same client Action boundary', async () => {
    const result = { templates: [
      { automationId: 'recovered', status: 'recovered' as const },
      { automationId: 'retained', status: 'retained_e2ee' as const },
      { automationId: 'stale', status: 'conflict' as const },
      { automationId: 'locked', status: 'locked' as const },
    ] };
    // The invoking device's credentials and remote template CAS are system boundaries.
    const accountEncryptionAutomationTemplatesRecoverAction = vi.fn(async () => result);
    const executor = createActionExecutor(Object.assign(createDeps(), { accountEncryptionAutomationTemplatesRecoverAction }));
    await expect(executor.execute(recoveryActionId, {}, recoveringUser)).resolves.toEqual({ ok: true, result });
    await expect(executor.execute(recoveryActionId, { accountId: 'other' }, recoveringUser)).resolves.toMatchObject({
      ok: false, errorCode: 'invalid_parameters',
    });
    expect(accountEncryptionAutomationTemplatesRecoverAction).toHaveBeenCalledTimes(1);
  });

  it('refuses a headless host without a genuine historical-key custodian', async () => {
    expect(getActionSpec(recoveryActionId)).toMatchObject({ requiredAuthority: 'present_user', executionPlacement: 'client',
      surfaces: { agent: true, mcp: true, plugin: true, api: false }, approval: { result: 'required' } });
    await expect(createActionExecutor(createDeps()).execute(recoveryActionId, {}, recoveringUser)).resolves.toMatchObject({
      ok: false, errorCode: 'target_unavailable',
    });
  });

  it.each(['agent', 'mcp'] as const)('asks %s by default for recovery and runs once the user waives that Ask', async surface => {
    const accountEncryptionAutomationTemplatesRecoverAction = vi.fn(async () => ({ templates: [] }));
    let settings = ActionsSettingsV1Schema.parse({ v: 1 });
    const executor = createActionExecutor(Object.assign(createDeps(), {
      accountEncryptionAutomationTemplatesRecoverAction,
      isActionApprovalRequired: (id: ActionId, context: Parameters<typeof isApprovalRequiredByActionsSettings>[2]) =>
        isApprovalRequiredByActionsSettings(id, settings, context),
    }));
    const agent = { surface, authority: 'account_automation', actionCaller: { kind: 'host' } } as const;
    expect(await executor.execute(recoveryActionId, {}, agent)).not.toMatchObject({ ok: true });
    expect(accountEncryptionAutomationTemplatesRecoverAction).not.toHaveBeenCalled();
    settings = ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { [recoveryActionId]: [surface] } });
    await expect(executor.execute(recoveryActionId, {}, agent)).resolves.toEqual({ ok: true, result: { templates: [] } });
    expect(accountEncryptionAutomationTemplatesRecoverAction).toHaveBeenCalledOnce();
  });
});
