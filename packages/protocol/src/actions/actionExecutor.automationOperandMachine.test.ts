import { describe, expect, it, vi } from 'vitest';

import { ActionsSettingsV1Schema } from './actionSettings.js';
import {
  createActionExecutor,
  type ActionExecutorDeps,
  type ActionExecutorContext,
} from './actionExecutor.js';
import { listActionSpecs } from './actionSpecs.js';
import { createActionAutomationPortV1 } from './executor/actionAutomationAdmission.js';
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
function setup(actionId: string, onFailure: 'refuse' | 'ask' = 'refuse') {
  const runMachines: (string | undefined)[] = [];
  let seeds = 0;
  const port = createActionAutomationPortV1({
    accountId: 'actor',
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

  it('keeps a Machine already carried by caller context', async () => {
    const { port, executor, runMachines } = setup(TERMINAL_OPEN);
    try {
      await executor.execute(
        TERMINAL_OPEN,
        operands[TERMINAL_OPEN],
        context(TERMINAL_OPEN, 'ui', {
          defaultSessionMachineId: 'session-machine',
        }),
      );
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
