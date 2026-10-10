import { describe, expect, it, vi } from 'vitest';
import { captureConsoleText, captureStdout } from '@/testkit/logger/captureOutput';
import { handleAutomationCommand } from './automation';
import { createActionExecutor, createWorkflowActionExecutor, createWorkflowDefinitionActions, createWorkflowTriggerActions } from '@happier-dev/protocol/actions';
import type { ActionExecutorDeps } from '@happier-dev/protocol';
import { ActionsSettingsV1Schema, isApprovalRequiredByActionsSettings, isActionEnabledByActionsSettings } from '@happier-dev/protocol';

// Configuration is the process/environment Home boundary; the Action owner stays real.
vi.mock('@/configuration', () => ({ configuration: { activeServerId: 'manual-home', apiServerUrl: 'https://manual-home.example' } }));

function runExecutor(runNow: NonNullable<Parameters<typeof createWorkflowTriggerActions>[0]['automations']['runNow']>, ports: Partial<ActionExecutorDeps> = {}) {
  const unavailable = async (): Promise<never> => { throw new Error('Unexpected persistence operation'); };
  const definitions = createWorkflowDefinitionActions({ artifactStore: { read: unavailable, list: unavailable,
    create: unavailable, update: unavailable, delete: unavailable }, encodeListCursor: (row) => row.artifactId });
  const triggers = createWorkflowTriggerActions({ automations: { list: unavailable, get: unavailable, create: unavailable,
    reconcile: unavailable, delete: unavailable, runNow }, newId: () => 'unused', openContext: unavailable,
    sealContext: unavailable, resolveWorkflow: unavailable });
  const settings = ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { 'workflow.trigger.run_now': ['cli'] } });
  return createActionExecutor({ isActionApprovalRequired: (id, ctx) => isApprovalRequiredByActionsSettings(id, settings, ctx),
    ...ports, workflowAction: createWorkflowActionExecutor({ definitions, triggers,
    isWorkflowFeatureEnabled: () => true, runs: { execute: unavailable } }) });
}

describe('handleAutomationCommand', () => {
  it('lists automations with stable ids in human and JSON output', async () => {
    const listAutomationDefinitionsFn = vi.fn(async () => ({
      automations: [{
        id: 'automation-2',
        name: 'Nightly review',
        description: null,
        enabled: false,
        targetType: 'newSession' as const,
        existingSessionId: null,
        templateVersion: 1,
        lastRunAt: null,
        createdAt: 1,
        updatedAt: 2,
        assignments: [],
        triggers: [],
      }],
      nextCursor: null,
    }));
    const deps = {
      readCredentialsFn: async () => ({ token: 'token-1' } as never),
      listAutomationDefinitionsFn,
      createExecutorFn: vi.fn(),
    };

    const humanOutput = captureConsoleText();
    try {
      await handleAutomationCommand(['list'], deps);
      expect(humanOutput.text()).toContain('automation-2');
      expect(humanOutput.text()).toContain('Nightly review');
      expect(humanOutput.text()).toContain('paused');
    } finally {
      humanOutput.restore();
    }

    const jsonOutput = captureStdout();
    try {
      await handleAutomationCommand(['list', '--json'], deps);
      expect(JSON.parse(jsonOutput.text())).toMatchObject({
        ok: true,
        kind: 'automation_list',
        data: {
          automations: [{ id: 'automation-2', name: 'Nightly review', enabled: false }],
          nextCursor: null,
        },
      });
    } finally {
      jsonOutput.restore();
    }

    expect(listAutomationDefinitionsFn).toHaveBeenNthCalledWith(1, { token: 'token-1' });
    expect(listAutomationDefinitionsFn).toHaveBeenNthCalledWith(2, { token: 'token-1' });
  });

  it('forwards the opaque list cursor and prints the exact continuation command', async () => {
    const listAutomationDefinitionsFn = vi.fn(async () => ({
      automations: [],
      nextCursor: 'opaque_cursor-3',
    }));
    const deps = {
      readCredentialsFn: async () => ({ token: 'token-1' } as never),
      listAutomationDefinitionsFn,
      createExecutorFn: vi.fn(),
    };

    const humanOutput = captureConsoleText();
    try {
      await handleAutomationCommand(['list', '--cursor', 'opaque_cursor-2'], deps);
      expect(humanOutput.text()).toContain(
        'happier automation list --cursor opaque_cursor-3',
      );
    } finally {
      humanOutput.restore();
    }

    expect(listAutomationDefinitionsFn).toHaveBeenCalledWith({
      token: 'token-1',
      cursor: 'opaque_cursor-2',
    });
  });

  it.each([
    ['an unknown option', ['list', '--definitely-invalid']],
    ['a missing cursor', ['list', '--cursor']],
    ['a flag token used as the cursor', ['list', '--cursor', '--json']],
  ])('rejects %s before reading credentials', async (_label, args) => {
    const readCredentialsFn = vi.fn();
    await expect(handleAutomationCommand(args, {
      readCredentialsFn,
      listAutomationDefinitionsFn: vi.fn(),
      createExecutorFn: vi.fn(),
    })).rejects.toThrow();
    expect(readCredentialsFn).not.toHaveBeenCalled();
  });

  it('runs through Action admission and preserves the complete receipt and occurrence key', async () => {
    const receipt = { run: { id: '11111111-1111-4111-8111-111111111111', automationId: 'automation-1', revision: 1,
      triggerId: null, triggerRetired: false, state: 'queued' as const, cause: { kind: 'manual' as const, invokedAt: 1 },
      dueAt: 1, claimedAt: null, startedAt: null, finishedAt: null, claimedByMachineId: null, leaseExpiresAt: null,
      attempt: 0, errorCode: null, producedSessionId: null, executionDispatchState: null, executionAttempt: 0,
      replyHandoffState: 'none' as const, replyHandoffAttempt: 0, replyHandoffDueAt: null, createdAt: 1, updatedAt: 1 },
      workflowRun: { recipeKind: 'workflow-v2' as const, workflowRunId: '11111111-1111-4111-8111-111111111111' } };
    const runNow = vi.fn(async () => receipt);
    const executor = runExecutor(runNow);
    const deps = {
      readCredentialsFn: async () => ({ token: 'token-1' } as never),
      listAutomationDefinitionsFn: vi.fn(),
      createExecutorFn: () => executor,
    };
    const output = captureStdout();
    try {
      await handleAutomationCommand(
        ['run', 'automation-1', '--idempotency-key', 'ci-build-42', '--json'],
        deps,
      );
      expect(runNow).toHaveBeenCalledWith('automation-1', { idempotencyKey: 'ci-build-42' });
      expect(JSON.parse(output.text())).toMatchObject({
        ok: true,
        kind: 'automation_run',
        data: receipt,
      });
    } finally {
      output.restore();
    }
  });

  it('retains an approval receipt without submitting the manual occurrence', async () => {
    const runNow = vi.fn();
    const settings = ActionsSettingsV1Schema.parse({ v: 1, actions: { 'workflow.trigger.run_now': { approvalRequiredSurfaces: ['cli'] } } });
    const executor = runExecutor(runNow, {
      isActionApprovalRequired: (id, ctx) => isApprovalRequiredByActionsSettings(id, settings, ctx),
      approvalsCreate: async () => ({ artifactId: 'manual-approval' }),
    });
    const output = captureStdout();
    try {
      await handleAutomationCommand(['run', 'automation-1', '--json'], {
        readCredentialsFn: async () => ({ token: 'token-1' } as never), listAutomationDefinitionsFn: vi.fn(), createExecutorFn: () => executor,
      });
      expect(JSON.parse(output.text())).toMatchObject({ ok: true, kind: 'automation_run', data: { kind: 'approval_request_created', artifactId: 'manual-approval' } });
      expect(runNow).not.toHaveBeenCalled();
    } finally { output.restore(); }
  });

  it('refuses a disabled Action before the occurrence transport and preserves uncertain failures', async () => {
    const runNow = vi.fn(async (): Promise<never> => { throw Object.assign(new Error('Reply lost'), { code: 'workflow_outcome_unresolved' }); });
    const settings = ActionsSettingsV1Schema.parse({ v: 1, actions: { 'workflow.trigger.run_now': { enabled: false } } });
    const deps = { readCredentialsFn: async () => ({ token: 'token-1' } as never), listAutomationDefinitionsFn: vi.fn(),
      createExecutorFn: () => runExecutor(runNow, { isActionEnabled: (id, ctx) => isActionEnabledByActionsSettings(id, settings, ctx) }) };
    await expect(handleAutomationCommand(['run', 'automation-1'], deps)).rejects.toMatchObject({ code: 'action_disabled' });
    expect(runNow).not.toHaveBeenCalled();
    await expect(handleAutomationCommand(['run', 'automation-1'], { ...deps, createExecutorFn: () => runExecutor(runNow) }))
      .rejects.toMatchObject({ code: 'workflow_outcome_unresolved' });
    expect(runNow).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed run arguments before reading credentials', async () => {
    const readCredentialsFn = vi.fn();
    await expect(handleAutomationCommand(
      ['run', 'automation-1', '--idempotency-key'],
      { readCredentialsFn, listAutomationDefinitionsFn: vi.fn(), createExecutorFn: vi.fn() },
    )).rejects.toThrow(/idempotency-key/i);
    await expect(handleAutomationCommand(
      ['run', 'automation-1', '--idempotency-key', 'é'.repeat(96)],
      { readCredentialsFn, listAutomationDefinitionsFn: vi.fn(), createExecutorFn: vi.fn() },
    )).rejects.toThrow(/idempotency-key/i);
    expect(readCredentialsFn).not.toHaveBeenCalled();
  });
});
