import { describe, expect, it } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { isApprovalRequiredByActionsSettings } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import {
  normalizeActionsSettingsV1,
  type ActionsSettingsV1,
} from '@happier-dev/protocol/actions/actionSettings';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import type {
  ActionExecutorContext,
  ActionExecutorDeps,
} from '@happier-dev/protocol/actions/executor/types';
import { ScmChangeDiscardResponseSchema } from '@happier-dev/protocol/scm';
import { invokeUiScmAction } from './scmActionInvocation';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';

// Discard is irreversible with no confirmation of its own, so it keeps the executor's default.
const ACTION: ActionId = 'scm.change.discard';
const INPUT = { cwd: '/repo', entries: [{ path: 'a.ts', kind: 'modified' }] };
const HOST = { serverId: 'home', externalActionTarget: { kind: 'machine', machineId: 'machine-1' } } as const;
const REMOVED = { success: true };

/**
 * The real Action executor and approval policy run; only the three host boundaries are faked:
 * the person's confirmation dialog, the approval Artifact store, and the Machine SCM RPC.
 */
function fixture(
  options: Readonly<{
    confirm?: (context: ActionExecutorContext) => Promise<boolean>;
    settings?: ActionsSettingsV1;
  }> = {},
) {
  const settings = options.settings ?? normalizeActionsSettingsV1({ v: 1 });
  const record = { confirmations: 0, dispatches: 0, approvals: [] as string[] };
  const executor = createActionExecutor({
    isActionApprovalRequired: (actionId, context, input) =>
      isApprovalRequiredByActionsSettings(
        actionId,
        settings,
        context,
        undefined,
        undefined,
        input,
      ),
    presentUserActionConfirmation: async ({ context }) => {
      record.confirmations += 1;
      return await (options.confirm?.(context) ?? Promise.resolve(true));
    },
    approvalsCreate: async ({ request }) => {
      record.approvals.push(request.actionId);
      return { artifactId: `approval-${record.approvals.length}` };
    },
    scmActionExecute: async () => {
      record.dispatches += 1;
      return REMOVED;
    },
  } as Partial<ActionExecutorDeps> as ActionExecutorDeps);
  return { executor, record };
}

const invoke = (
  executor: ReturnType<typeof fixture>['executor'],
  context: ActionExecutorContext = { ...HOST, authority: 'present_user' },
) =>
  invokeUiScmAction({
    actionId: ACTION,
    input: INPUT,
    schema: ScmChangeDiscardResponseSchema,
    executor: createFrontDoorActionExecute(executor),
    context,
  });

describe('invokeUiScmAction approval custody', () => {
  it('present_user_default_confirms_in_place_then_dispatches_without_an_approval_artifact', async () => {
    const { executor, record } = fixture();
    expect(await invoke(executor)).toMatchObject({ success: true });
    expect(record).toEqual({ confirmations: 1, dispatches: 1, approvals: [] });
  });

  it('explicit_ask_first_forces_an_approval_artifact_without_confirmation_or_dispatch', async () => {
    const settings = normalizeActionsSettingsV1({
      v: 1,
      actions: { [ACTION]: { approvalRequiredSurfaces: ['ui'] } },
    });
    const { executor, record } = fixture({ settings });
    expect(await invoke(executor)).toMatchObject({
      success: false,
      errorCode: 'approval_required',
      approvalArtifactId: 'approval-1',
    });
    expect(record).toEqual({
      confirmations: 0,
      dispatches: 0,
      approvals: [ACTION],
    });
  });

  it('declined_confirmation_returns_approval_canceled_and_does_not_dispatch', async () => {
    const { executor, record } = fixture({ confirm: async () => false });
    expect(await invoke(executor)).toMatchObject({
      success: false,
      errorCode: 'approval_canceled',
    });
    expect(record).toEqual({ confirmations: 1, dispatches: 0, approvals: [] });
  });

  it('signal_cancelled_during_confirmation_does_not_dispatch', async () => {
    const controller = new AbortController();
    const { executor, record } = fixture({
      confirm: async () => {
        controller.abort();
        return true;
      },
    });
    expect(
      await invoke(executor, {
        ...HOST,
        authority: 'present_user',
        signal: controller.signal,
      }),
    ).toMatchObject({ success: false, errorCode: 'cancelled' });
    expect(record.dispatches).toBe(0);
  });

  it('signal_cancelled_before_entry_neither_confirms_nor_dispatches', async () => {
    const controller = new AbortController();
    controller.abort();
    const { executor, record } = fixture();
    expect(
      await invoke(executor, {
        ...HOST,
        authority: 'present_user',
        signal: controller.signal,
      }),
    ).toMatchObject({ success: false, errorCode: 'result_unavailable' });
    expect(record).toEqual({ confirmations: 0, dispatches: 0, approvals: [] });
  });

  it.each([
    {
      name: 'agent',
      context: { surface: 'agent', authority: 'account_automation' },
    },
    {
      name: 'mcp_automation',
      context: { surface: 'mcp', authority: 'account_automation' },
    },
    {
      name: 'cli',
      context: { surface: 'cli', authority: 'account_automation' },
    },
    {
      name: 'cli_present_user',
      context: { surface: 'cli', authority: 'present_user' },
    },
  ] as const)(
    '$name_caller_keeps_an_approval_artifact_and_is_never_offered_the_ui_confirmation',
    async ({ context }) => {
      const { executor, record } = fixture();
      // Blocking approvals also wait for a decision, which this fixture does not wire; the
      // approval Artifact being created and nothing dispatching is the contract here.
      await executor.execute(
        ACTION,
        INPUT,
        { ...HOST, actionRequestId: 'request-1', ...context } as ActionExecutorContext,
      );
      expect(record).toEqual({
        confirmations: 0,
        dispatches: 0,
        approvals: [ACTION],
      });
    },
  );

  it('plugin_caller_is_never_offered_the_ui_confirmation_and_never_dispatches', async () => {
    const { executor, record } = fixture();
    const result = await executor.execute(ACTION, INPUT, {
      ...HOST,
      actionRequestId: 'request-1',
      surface: 'plugin',
      authority: 'account_automation',
      actionCaller: {
        kind: 'plugin',
        pluginId: 'example.plugin',
        contributionLocalId: 'page',
        occurrenceId: 'occurrence',
      },
    });
    // Without source custody this caller cannot even open approval custody; what matters here
    // is that the host's present-user confirmation is never offered to a plugin caller.
    expect(result.ok).toBe(false);
    expect(record.confirmations).toBe(0);
    expect(record.dispatches).toBe(0);
  });
});

// Reversible SCM writes, and those whose surface owns its confirmation, are direct for the
// present person only; every other caller keeps the dangerous-Action approval.
describe.each([
  ['scm.change.include', { cwd: '/repo', paths: ['a.ts'] }],
  ['scm.commit.create', { cwd: '/repo', message: 'fix: a' }],
  ['scm.remote.push', { cwd: '/repo' }],
  ['scm.branch.create', { cwd: '/repo', name: 'topic' }],
] as const)('%s', (actionId, input) => {
  it('dispatches for the present person without the generic confirmation', async () => {
    const { executor, record } = fixture();
    const result = await executor.execute(actionId, input, {
      ...HOST, actionRequestId: 'request-1', surface: 'ui', authority: 'present_user',
    });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(record).toEqual({ confirmations: 0, dispatches: 1, approvals: [] });
  });

  it.each(['agent', 'mcp', 'cli'] as const)('keeps the approval Artifact for the %s caller', async (surface) => {
    const { executor, record } = fixture();
    // Agent and MCP blocking approvals also wait for a decision, which this fixture does not
    // wire; the approval Artifact being created and nothing dispatching is the contract here.
    await executor.execute(actionId, input, {
      ...HOST, actionRequestId: 'request-1', surface, authority: 'account_automation',
    });
    expect(record).toEqual({ confirmations: 0, dispatches: 0, approvals: [actionId] });
  });

  it('still asks for an Artifact under explicit Ask-first', async () => {
    const settings = normalizeActionsSettingsV1({
      v: 1, actions: { [actionId]: { approvalRequiredSurfaces: ['ui'] } },
    });
    const { executor, record } = fixture({ settings });
    const result = await executor.execute(actionId, input, {
      ...HOST, actionRequestId: 'request-1', surface: 'ui', authority: 'present_user',
    });
    expect(result).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    expect(record).toEqual({ confirmations: 0, dispatches: 0, approvals: [actionId] });
  });
});
