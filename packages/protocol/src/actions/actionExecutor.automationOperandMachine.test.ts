import { describe, expect, it, vi } from 'vitest';

import { ActionsSettingsV1Schema } from './actionSettings.js';
import {
  createActionExecutor,
  type ActionExecutorDeps,
  type ActionExecutorContext,
} from './actionExecutor.js';
import { listActionSpecs } from './actionSpecs.js';
import { createActionAutomationHttpPortV1, createActionAutomationPortV1, notEvaluatedActionAutomationPortV1,
  unavailableActionAutomationMatchingV1 } from './executor/actionAutomationAdmission.js';
import { readActionAutomationExecutionMachineV1 } from './executor/actionSettlement.js';
import { readActionOperandExecutionMachineV1 } from './executor/actionOperandExecutionMachine.js';

type Request = Parameters<
  NonNullable<ActionExecutorDeps['approvalsCreate']>
>[0]['request'];

const BEGIN_CONNECT = 'connectedServices.authentication.beginConnect';
const TERMINAL_OPEN = 'machines.terminal.open';
const operands = {
  [BEGIN_CONNECT]: {
    machineId: 'operand-machine',
    service: { pluginId: 'example.accounts', localId: 'service' },
    modeId: 'password',
  },
  [TERMINAL_OPEN]: {
    serverId: 'home',
    machineId: 'operand-machine',
    terminalKey: 'shell',
  },
} as const;

/** The real executor and admission selector over one real Before row; only the effect and Run transport are boundaries. */
function setup(actionId: string, onFailure: 'refuse' | 'ask' = 'refuse',
  readHomeFeatures?: Parameters<typeof createActionAutomationPortV1>[0]['readHomeFeatures']) {
  const runMachines: (string | undefined)[] = [];
  let seeds = 0;
  const port = createActionAutomationPortV1({
    accountId: 'actor',
    readHomeFeatures,
    seed: async () => {
      seeds++;
      return {
        v: 1,
        rows: [
          {
            automationId: 'guard',
            triggerId: 'before',
            triggerRevision: 1,
            workflowId: 'workflow',
            workflowRevision: 1,
            ownerAccountId: 'actor',
            actionIds: [actionId],
            phase: 'before',
            mode: 'wait',
            onFailure,
          },
        ],
      };
    },
    // Run admission is Home's HTTP boundary; it places the Run on the evidence Machine.
    start: async ({ context }) => {
      runMachines.push(readActionAutomationExecutionMachineV1(context));
      return {
        runs: [{ automationId: 'guard', triggerId: 'before', runId: 'check' }],
        notices: [],
      };
    },
    settle: async () => {},
  });
  let stored: Request | null = null;
  const effect = vi.fn(async () => ({ ok: true }));
  const executor = createActionExecutor({
    actionAutomations: {
      ...port,
      wait: async () => ({ state: 'failed', errorCode: 'command_failed' }),
    },
    approvalsCreate: async ({ request }) => {
      stored = request;
      return { artifactId: 'approval' };
    },
    approvalsGet: async () => stored,
    approvalsUpdate: async ({ request }) => {
      stored = request;
      return { ok: true };
    },
    approvalsWaitForDecision: async (pending) => ({
      decision: 'reject' as const,
      request: pending.request,
    }),
    isApprovalExecutionOriginCurrent: async () => true,
    connectedServiceAction: effect,
    machineTerminalAction: effect,
    homeDomainAction: async () => {
      await effect();
      return { name: 'QA', firstName: 'QA', lastName: null, timestamp: 1 };
    },
  });
  return { port, executor, effect, runMachines, seeds: () => seeds };
}

function context(
  actionId: string,
  front: 'voice' | 'ui',
  extra: Partial<ActionExecutorContext> = {},
): ActionExecutorContext {
  // App and Voice start these Actions with no Machine in caller context.
  return {
    surface: front,
    authority: front === 'voice' ? 'account_automation' : 'present_user',
    actionCaller: { kind: 'host' },
    serverId: 'home',
    serverIdentityId: 'home',
    runtimeAccountId: 'actor',
    actionRequestId: `${front}-${actionId}`,
    actionsSettings: ActionsSettingsV1Schema.parse({
      v: 1,
      approvalWaivedSurfaces: { [actionId]: [front] },
    }),
    ...extra,
  };
}

describe('Before checks on the Action operand Machine', () => {
  it.each(['empty', 'unavailable'] as const)('opens an unkeyed native terminal approval with an %s Automation index', async index => {
    const reads: string[] = [];
    const port = createActionAutomationHttpPortV1({ accountId: 'actor', request: async (path, request) => {
      expect(request.method).toBe('GET');
      reads.push(path);
      if (index === 'unavailable') throw Object.assign(new Error('Home unreachable'), { code: 'server_unreachable' });
      return { v: 1, rows: [] };
    } });
    const approvals: Request[] = [];
    const effect = vi.fn(async () => ({ ok: true }));
    const executor = createActionExecutor({ actionAutomations: port, machineTerminalAction: effect,
      approvalsCreate: async ({ request }) => { approvals.push(request); return { artifactId: 'approval' }; } });
    const caller = context(TERMINAL_OPEN, 'ui', { surface: 'agent', authority: 'account_automation',
      actionCaller: undefined, actionRequestId: undefined, actionsSettings: ActionsSettingsV1Schema.parse({ v: 1 }) });
    const notices = index === 'unavailable' ? [{ code: 'action_automations_not_checked', reason: 'server_unreachable' }] : [];
    try {
      const result = await executor.execute(TERMINAL_OPEN, operands[TERMINAL_OPEN], caller);
      expect(result).toMatchObject({ ok: true, result: { kind: 'approval_request_created', artifactId: 'approval' } });
      expect(result.automationNotices ?? []).toEqual(notices);
      expect(approvals).toEqual([expect.objectContaining({ status: 'open',
        executionOriginV1: expect.objectContaining({ requestId: expect.stringMatching(/\S/), machineId: 'operand-machine' }),
        automaticChecks: expect.objectContaining({ selectionStatus: index === 'empty' ? 'ready' : 'unavailable', notices }),
      })]);
      expect(reads).toEqual(['/v1/automations/actions/index']);
      expect(effect).not.toHaveBeenCalled();
    } finally { port.dispose(); }
  });

  it.each(['no Account credentials', 'lost matching', 'unreadable content'] as const)('decides a terminal approval with %s', async capability => {
    const port = createActionAutomationHttpPortV1({
      accountId: 'actor',
      request: async (_path, request) => {
        if (request.method !== 'GET') throw new Error('An unreadable check cannot be admitted');
        return { v: 1, rows: [{ automationId: 'guard', triggerId: 'before',
          triggerRevision: 1, workflowId: 'workflow', workflowRevision: 1,
          ownerAccountId: 'actor', actionIds: [TERMINAL_OPEN], phase: 'before',
          mode: 'wait', onFailure: 'refuse' }] };
      },
    });
    let stored: Request | null = null;
    const effect = vi.fn(async () => ({ ok: true }));
    const withMatching = { ...port,
      prepareMatching: async () => unavailableActionAutomationMatchingV1('content_unavailable'),
    };
    const createExecutor = (actionAutomations: ActionExecutorDeps['actionAutomations']) => createActionExecutor({
      actionAutomations,
      approvalsCreate: async ({ request }) => {
        stored = request;
        return { artifactId: 'approval' };
      },
      approvalsGet: async () => stored,
      approvalsUpdate: async ({ request }) => {
        stored = request;
        return { ok: true };
      },
      isApprovalExecutionOriginCurrent: async () => true,
      machineTerminalAction: effect,
    });
    const caller = context(TERMINAL_OPEN, 'ui', { surface: 'cli', actionsSettings: ActionsSettingsV1Schema.parse({
      v: 1, actions: { [TERMINAL_OPEN]: { approvalRequiredSurfaces: ['cli'] } },
    }) });
    try {
      const requested = await createExecutor(withMatching).execute(TERMINAL_OPEN, operands[TERMINAL_OPEN], caller);
      expect(requested).toMatchObject({
        ok: true, result: { kind: 'approval_request_created', artifactId: 'approval' },
      });
      expect(stored).toMatchObject({ automaticChecks: { selected: [{ triggerId: 'before' }], consents: [] } });
      const decidingPort = capability === 'no Account credentials' ? notEvaluatedActionAutomationPortV1
        : capability === 'lost matching' ? port : withMatching;
      const result = await createExecutor(decidingPort).execute('approval.request.decide', { artifactId: 'approval', decision: 'approve' }, caller);
      if (capability === 'no Account credentials') {
        expect(result).toMatchObject({ ok: true,
          automationNotices: [{ code: 'action_automations_not_checked', reason: 'matching_unavailable' }],
        });
        expect(effect).toHaveBeenCalledTimes(1);
      } else {
        const refused = { ok: false, errorCode: 'target_unavailable', effectAttempted: false,
          failureCause: { nativeErrorReason: 'action_automation_selection_unavailable' },
          details: { kind: 'automatic_check_start_refusal', automationId: 'guard', triggerId: 'before', reason: 'content_unavailable' },
        };
        expect(result).toMatchObject({ ok: true, result: { status: 'failed', execution: refused },
        });
        expect(result.automationNotices).toBeUndefined();
        expect(stored).toMatchObject({ status: 'failed', execution: refused, automaticChecks: { phase: 'refused', runs: [], notices: [] } });
        expect(effect).not.toHaveBeenCalled();
      }
    } finally {
      port.dispose();
    }
  });

  it('runs the Before check from a usable index when Home features are unknown and retains the index', async () => {
    const { port, executor, effect, runMachines, seeds } = setup(TERMINAL_OPEN, 'refuse', async () => null);
    try {
      for (const front of ['ui', 'voice'] as const) {
        const result = await executor.execute(TERMINAL_OPEN, operands[TERMINAL_OPEN], context(TERMINAL_OPEN, front));
        expect(result).toMatchObject({ ok: false });
      }
      expect(runMachines).toEqual(['operand-machine', 'operand-machine']);
      expect(effect).not.toHaveBeenCalled();
      expect(seeds()).toBe(1);
    } finally {
      port.dispose();
    }
  });

  it.each(
    [BEGIN_CONNECT, TERMINAL_OPEN].flatMap((actionId) =>
      (['voice', 'ui'] as const).map((front) => ({ actionId, front })),
    ),
  )(
    'runs and refuses $actionId from $front with no caller Machine',
    async ({ actionId, front }) => {
      const { port, executor, effect, runMachines, seeds } = setup(actionId);
      try {
        const result = await executor.execute(
          actionId as typeof BEGIN_CONNECT,
          operands[actionId as typeof BEGIN_CONNECT],
          context(actionId, front),
        );
        expect(result, JSON.stringify(result)).toMatchObject({ ok: false });
        expect(runMachines).toEqual(['operand-machine']);
        expect(effect).not.toHaveBeenCalled();
        // One index read per Account serves every admission; the operand Machine adds no request.
        expect(seeds()).toBe(1);
      } finally {
        port.dispose();
      }
    },
  );

  it.each(['ui', 'cli'] as const)(
    'runs the check on the operand Machine, as the approval origin does, when a %s Session is on another Machine',
    async (surface) => {
      const { port, executor, effect, runMachines } = setup(TERMINAL_OPEN);
      try {
        await executor.execute(TERMINAL_OPEN, operands[TERMINAL_OPEN], context(TERMINAL_OPEN, 'ui', {
          surface,
          defaultSessionMachineId: 'session-machine',
          actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { [TERMINAL_OPEN]: [surface] } }),
        }));
        expect(runMachines).toEqual(['operand-machine']);
        expect(effect).not.toHaveBeenCalled();
      } finally {
        port.dispose();
      }
    },
  );

  it('keeps the caller Session Machine for an Action with no Machine-placed operand', async () => {
    const { port, executor, runMachines } = setup('account.name.set');
    try {
      await executor.execute('account.name.set', { name: 'QA' },
        context('account.name.set', 'ui', { defaultSessionMachineId: 'session-machine' }));
      expect(runMachines).toEqual(['session-machine']);
    } finally {
      port.dispose();
    }
  });

  it.each([
    {
      name: 'an Account-placed Action from the App',
      actionId: 'account.name.set',
      input: { name: 'QA' },
      front: 'ui' as const,
    },
    {
      name: 'sign-in without a Machine from Voice',
      actionId: BEGIN_CONNECT,
      input: {
        service: { pluginId: 'example.accounts', localId: 'service' },
        modeId: 'password',
      },
      front: 'voice' as const,
    },
  ])(
    'visibly skips each check for $name that has no Machine and keeps the effect',
    async ({ actionId, input, front }) => {
      const { port, executor, effect, runMachines } = setup(actionId);
      try {
        const result = await executor.execute(
          actionId as typeof BEGIN_CONNECT,
          input as never,
          context(actionId, front),
        );
        // The effect boundary's own output is not under test; the Skip and the effect are.
        expect(result, JSON.stringify(result)).toMatchObject({
          automationNotices: [
            {
              code: 'action_automation_skipped',
              reason: 'machineRequired',
              automationId: 'guard',
              triggerId: 'before',
            },
          ],
        });
        expect(runMachines).toEqual([]);
        expect(effect).toHaveBeenCalledOnce();
      } finally {
        port.dispose();
      }
    },
  );

  it('reads the Machine from every Machine-placed spec declaration, not an Action list', () => {
    const machinePlaced = listActionSpecs().filter(
      (spec) =>
        spec.executionPlacement === 'machine' &&
        !spec.executionPlacementForInput,
    );
    expect(machinePlaced.length).toBeGreaterThan(50);
    for (const spec of machinePlaced) {
      expect(
        readActionOperandExecutionMachineV1({
          actionId: spec.id,
          input: { machineId: 'operand-machine' },
          caller: { kind: 'host' },
          surface: 'ui',
        }),
        spec.id,
      ).toBe('operand-machine');
    }
    const accountPlaced = listActionSpecs().filter(
      (spec) =>
        spec.executionPlacement === 'account' &&
        !spec.executionPlacementForInput,
    );
    for (const spec of accountPlaced) {
      expect(
        readActionOperandExecutionMachineV1({
          actionId: spec.id,
          input: { machineId: 'operand-machine' },
          caller: { kind: 'host' },
          surface: 'ui',
        }),
        spec.id,
      ).toBeUndefined();
    }
  });
});
