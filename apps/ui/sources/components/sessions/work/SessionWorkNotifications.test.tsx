import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import {
  AutomationStoredWorkflowDefinitionRecipeV2Schema,
  AutomationTriggerIdSchema,
  createActionExecutor,
  createWorkflowTriggerActions,
  type ActionExecutorDeps,
  type AutomationDefinitionDetail,
  type WorkflowTriggerActionsDependencies,
} from '@happier-dev/protocol';

import { renderScreen } from '@/dev/testkit';
import type { SessionTriggersRead } from '@/components/workflows/triggers/useSessionTriggers';

// Load the real Account/Action graph during collection, not inside the assertion
// deadline; no service or catalog beneath the component is replaced.
const { SessionWorkNotifyOperation } =
  await import('./SessionWorkNotifications');
const { RunWorkNotifyOperation } = await import('./RunWorkNotifications');
function ownerFixture(
  options: Readonly<{
    disconnected?: boolean;
    configured?: boolean;
    channelDisconnected?: boolean;
  }> = {},
) {
  const rows = new Map<string, AutomationDefinitionDetail>();
  let id = 0;
  let acceptCreate: () => void = () => undefined;
  let acceptRemove: () => void = () => undefined;
  let source: unknown;
  let removedId: string | undefined;
  const createReady = new Promise<void>((resolve) => {
    acceptCreate = resolve;
  });
  const removeReady = new Promise<void>((resolve) => {
    acceptRemove = resolve;
  });
  const deps: WorkflowTriggerActionsDependencies = {
    newId: (kind) => `${kind}-${++id}`,
    resolveSession: async () => ({
      project: { machineId: 'machine-one', directory: '/workspace' },
      nativeGoalOwner: false,
    }),
    resolveWorkflow: async () => {
      throw new Error('Unexpected workflow read');
    },
    resolveRunSource: async () => ({ terminal: false }),
    // The authenticated Session, content codec and durable Automation operations are
    // the external boundaries. Real Action validation/projection/admission stays below the view.
    openContext: async (row) =>
      row.executionRecipe?.v === 2 && row.executionRecipe.workflow.t === 'plain'
        ? row.executionRecipe.workflow.v
        : null,
    sealContext: async ({ templateVersion, context }) =>
      AutomationStoredWorkflowDefinitionRecipeV2Schema.parse({
        v: 2,
        templateVersion,
        workflow: { t: 'plain', v: context },
        triggerEvidence: null,
      }),
    automations: {
      list: async () => ({
        automations: [...rows.values()].map(
          ({ executionRecipe: _private, ...row }) => row,
        ),
        nextCursor: null,
      }),
      get: async (automationId) => rows.get(automationId) ?? null,
      create: async (input) => {
        if (options.disconnected) throw new Error('disconnected');
        source = input.triggers[0]?.trigger;
        await createReady;
        const row: AutomationDefinitionDetail = {
          id: input.automationId,
          name: input.name,
          description: null,
          enabled: input.enabled,
          targetType: null,
          existingSessionId: null,
          templateVersion: 1,
          lastRunAt: null,
          createdAt: 1,
          updatedAt: 1,
          workflowDefinitionId: input.workflowDefinitionId,
          scopeSessionId: input.scopeSessionId,
          executionRecipe: input.executionRecipe,
          assignments: [
            {
              machineId: 'machine-one',
              enabled: true,
              priority: 0,
              updatedAt: 1,
            },
          ],
          triggers: input.triggers.map((item) => {
            if (
              item.trigger.kind !== 'sessionLifecycle' &&
              item.trigger.kind !== 'runLifecycle'
            )
              throw new Error('Unexpected trigger kind');
            return {
              ...item.trigger,
              id: item.triggerId,
              revision: 0,
              createdAt: 1,
              updatedAt: 1,
              remainingOccurrences: 1,
              status: { state: 'waiting', runId: null },
              triggerDefinitionEnvelope: null,
            };
          }),
        };
        rows.set(row.id, row);
        return row;
      },
      reconcile: async (automationId, input) => {
        const row = rows.get(automationId)!;
        removedId = row.triggers.find(
          (trigger) =>
            !input.triggers.some((item) => item.triggerId === trigger.id),
        )?.id;
        await removeReady;
        const committed = {
          ...row,
          triggers: row.triggers.filter((trigger) =>
            input.triggers.some((item) => item.triggerId === trigger.id),
          ),
        };
        rows.set(row.id, committed);
        return committed;
      },
      delete: async () => {
        throw new Error('Unexpected deletion');
      },
    },
  };
  const actions = createWorkflowTriggerActions(deps);
  const read: SessionTriggersRead = {
    status: 'ready',
    sets: [],
    pullRequestLinks: [],
    machineId: 'machine-one',
    lastRunAtByAutomationId: {},
    retry: () => undefined,
    add: (request) =>
      actions.sessionAdd({ ...request, sessionId: 'session-one' }),
    remove: (triggerId) =>
      actions.sessionRemove({
        sessionId: 'session-one',
        triggerId: AutomationTriggerIdSchema.parse(triggerId),
      }),
    update: (request) =>
      actions.sessionUpdate({ ...request, sessionId: 'session-one' }),
  };
  const executor = createActionExecutor({
    // The Account daemon's channel catalog is a genuine remote boundary.
    notificationChannelsList: async () => {
      if (options.channelDisconnected)
        return {
          ok: false,
          errorCode: 'target_unavailable',
          error: 'target_unavailable',
        };
      return {
        items: [
          {
            value: 'plugin/digest',
            label: 'Digest',
            disabled: options.configured === false,
          },
        ],
      };
    },
  } as unknown as ActionExecutorDeps);
  const runRead = {
    status: 'ready' as const,
    sets: [],
    add: actions.add,
    remove: async (automationId: string, triggerId: string) =>
      actions.remove({
        automationId,
        triggerId: AutomationTriggerIdSchema.parse(triggerId),
      }),
  };
  return {
    read,
    runRead,
    execute: executor.execute,
    acceptCreate,
    acceptRemove,
    rows,
    source: () => source,
    removedId: () => removedId,
  };
}

describe('Session Work notification operation', () => {
  it('acknowledges only the committed trigger and keeps cancellation pending until removal is acknowledged', async () => {
    const owner = ownerFixture();
    const screen = await renderScreen(
      <SessionWorkNotifyOperation
        sessionId="session-one"
        sourceTurnId="turn-one"
        read={owner.read}
        execute={owner.execute}
      />,
    );
    await act(async () => {
      screen.pressByTestId('notify-turn:session-one');
    });
    expect(screen.findByTestId('notify-turn-armed:session-one')).toBeNull();
    expect(owner.source()).toMatchObject({
      kind: 'sessionLifecycle',
      sourceSessionId: 'session-one',
      policy: { kind: 'currentTurn', sourceTurnId: 'turn-one' },
    });
    await act(async () => {
      owner.acceptCreate();
    });
    expect(screen.findByTestId('notify-turn-armed:session-one')).not.toBeNull();
    expect(
      [...owner.rows.values()].flatMap((row) => row.triggers),
    ).toHaveLength(1);
    await act(async () => {
      screen.pressByTestId('notify-turn-cancel:session-one');
    });
    expect(screen.findByTestId('notify-turn-armed:session-one')).not.toBeNull();
    expect(owner.removedId()).toBe(
      [...owner.rows.values()][0]?.triggers[0]?.id,
    );
    await act(async () => {
      owner.acceptRemove();
    });
    expect(screen.findByTestId('notify-turn-armed:session-one')).toBeNull();
    expect(screen.findByTestId('notify-turn:session-one')).not.toBeNull();
    expect(
      [...owner.rows.values()].flatMap((row) => row.triggers),
    ).toHaveLength(0);
  });

  it('offers nothing until the trigger owner can answer, rather than a disabled operation that cannot succeed', async () => {
    const owner = ownerFixture();
    const loading: SessionTriggersRead = { ...owner.read, status: 'loading' };
    const screen = await renderScreen(
      <SessionWorkNotifyOperation
        sessionId="session-one"
        sourceTurnId={null}
        read={loading}
        execute={owner.execute}
      />,
    );
    expect(screen.findByTestId('notify-attention:session-one')).toBeNull();
    const failed = await renderScreen(
      <SessionWorkNotifyOperation
        sessionId="session-one"
        sourceTurnId={null}
        read={{ ...owner.read, status: 'failed' }}
        execute={owner.execute}
      />,
    );
    expect(failed.findByTestId('notify-attention:session-one')).toBeNull();
    const ready = await renderScreen(
      <SessionWorkNotifyOperation
        sessionId="session-one"
        sourceTurnId={null}
        read={owner.read}
        execute={owner.execute}
      />,
    );
    expect(ready.findByTestId('notify-attention:session-one')).not.toBeNull();
  });

  it('retains the operation on a refused registration without a success announcement', async () => {
    const owner = ownerFixture({ disconnected: true });
    const screen = await renderScreen(
      <SessionWorkNotifyOperation
        sessionId="session-one"
        sourceTurnId="turn-one"
        read={owner.read}
        execute={owner.execute}
      />,
    );
    await act(async () => {
      screen.pressByTestId('notify-turn:session-one');
    });
    expect(screen.findByTestId('notify-turn-armed:session-one')).toBeNull();
    expect(screen.findByTestId('notify-turn-error:session-one')).not.toBeNull();
  });

  it('offers setup without registering a trigger when the delivery owner has no configured channel', async () => {
    const owner = ownerFixture({ configured: false });
    const screen = await renderScreen(
      <SessionWorkNotifyOperation
        sessionId="session-one"
        sourceTurnId="turn-one"
        read={owner.read}
        execute={owner.execute}
      />,
    );
    await act(async () => {
      screen.pressByTestId('notify-turn:session-one');
    });
    expect(owner.source()).toBeUndefined();
    expect(screen.findByTestId('notify-turn-setup:session-one')).not.toBeNull();
    expect(screen.findByTestId('notify-turn-armed:session-one')).toBeNull();
  });

  it('keeps unavailable delivery observations retryable and never mistakes disconnect for missing configuration', async () => {
    const owner = ownerFixture({ channelDisconnected: true });
    const screen = await renderScreen(
      <SessionWorkNotifyOperation
        sessionId="session-one"
        sourceTurnId="turn-one"
        read={owner.read}
        execute={owner.execute}
      />,
    );
    await act(async () => {
      screen.pressByTestId('notify-turn:session-one');
    });
    expect(owner.source()).toBeUndefined();
    expect(screen.findByTestId('notify-turn-error:session-one')).not.toBeNull();
    expect(screen.findByTestId('notify-turn-setup:session-one')).toBeNull();
  });
});

describe('Run Work notification operation', () => {
  it('registers the exact workflow terminal source and only acknowledges committed registration/removal', async () => {
    const owner = ownerFixture();
    const screen = await renderScreen(
      <RunWorkNotifyOperation
        source={{ kind: 'workflow_run', runId: 'workflow-one' }}
        project={{ machineId: 'machine-one', directory: '/workspace' }}
        read={owner.runRead}
        execute={owner.execute}
      />,
    );
    const { Switch } = await import('@/components/ui/forms/Switch');
    expect(screen.root.findAllByType(Switch).map(control => control.props.value)).toEqual([false, false]);
    await act(async () => {
      screen.root.findAllByType(Switch)[0]!.props.onValueChange(true);
    });
    expect(screen.root.findAllByType(Switch)[0]!.props.disabled).toBe(true);
    expect(screen.root.findAllByType(Switch)[0]!.props.value).toBe(false);
    expect(owner.source()).toEqual({
      kind: 'runLifecycle',
      enabled: true,
      source: { kind: 'workflow_run', runId: 'workflow-one' },
      condition: 'terminal',
    });
    expect(
      screen.findByTestId('notify-run-terminal-armed:workflow-one'),
    ).toBeNull();
    await act(async () => {
      owner.acceptCreate();
    });
    expect(screen.root.findAllByType(Switch).map(control => control.props.value)).toEqual([true, false]);
    expect(screen.root.findAllByType(Switch)[0]!.props.disabled).toBe(false);
    expect(
      screen.findByTestId('notify-run-terminal-armed:workflow-one'),
    ).not.toBeNull();
    await act(async () => {
      screen.root.findAllByType(Switch)[0]!.props.onValueChange(false);
    });
    expect(screen.root.findAllByType(Switch)[0]!.props.disabled).toBe(true);
    expect(screen.root.findAllByType(Switch)[0]!.props.value).toBe(true);
    expect(
      screen.findByTestId('notify-run-terminal-armed:workflow-one'),
    ).not.toBeNull();
    await act(async () => {
      owner.acceptRemove();
    });
    expect(
      screen.findByTestId('notify-run-terminal-armed:workflow-one'),
    ).toBeNull();
    expect(
      [...owner.rows.values()].flatMap((row) => row.triggers),
    ).toHaveLength(0);
    expect(screen.root.findAllByType(Switch)[0]!.props.value).toBe(false);
  });

  it('binds workflow needs-me to its supported predicate but never offers synthesized execution attention', async () => {
    const workflow = ownerFixture();
    workflow.acceptCreate();
    const workflowScreen = await renderScreen(
      <RunWorkNotifyOperation
        source={{ kind: 'workflow_run', runId: 'workflow-one' }}
        project={{ machineId: 'machine-one', directory: '/workspace' }}
        read={workflow.runRead}
        execute={workflow.execute}
      />,
    );
    await act(async () => {
      workflowScreen.pressByTestId('notify-run-needs_attention:workflow-one');
    });
    expect(workflow.source()).toMatchObject({
      source: { kind: 'workflow_run', runId: 'workflow-one' },
      condition: 'needs_attention',
    });
    const execution = ownerFixture();
    const executionScreen = await renderScreen(
      <RunWorkNotifyOperation
        source={{
          kind: 'execution_run',
          machineId: 'machine-one',
          runId: 'execution-one',
        }}
        project={{ machineId: 'machine-one', directory: '/workspace' }}
        read={execution.runRead}
        execute={execution.execute}
      />,
    );
    expect(
      executionScreen.findByTestId('notify-run-needs_attention:execution-one'),
    ).toBeNull();
    expect(
      executionScreen.findByTestId('notify-run-terminal:execution-one'),
    ).not.toBeNull();
  });
});
