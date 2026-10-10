import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  normalizeWorkflowIngress,
  type SessionTriggerPullRequestLinksV1,
  type WorkflowTriggerSetV1,
} from '@happier-dev/protocol';

import { renderScreen } from '@/dev/testkit';
import { getStorage } from '@/sync/domains/state/storage';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const executeMock = vi.hoisted(() => vi.fn());
const routeParams = vi.hoisted(() => ({
  current: {} as Record<string, unknown>,
}));
const automationWrites = vi.hoisted(() => ({
  pause: vi.fn(),
  resume: vi.fn(),
}));

// The Action front door is the transport boundary; the trigger client, its schemas, the row
// projection and the section stay real.
vi.mock(
  '@/sync/ops/actions/frontDoorRuntimeActionExecutor',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')
    >()),
    createFrontDoorActionExecute: () => executeMock,
  }),
);

// ORC's Work view is the slot's host; it renders the filled slot and nothing else here.
vi.mock('@/components/sessions/work/SessionWorkView', () => ({
  SessionWorkView: (props: Readonly<{ triggersSection?: React.ReactNode }>) => (
    <>{props.triggersSection}</>
  ),
}));

// The route is a boundary: "When this turn finishes…" arrives as deep-link params.
vi.mock('expo-router', async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  const mock = createExpoRouterMock({ params: {} });
  return {
    ...mock.module,
    useLocalSearchParams: () => routeParams.current,
    useGlobalSearchParams: () => routeParams.current,
  };
});

vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});

vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock();
});

vi.mock(
  '@/sync/domains/scope/activeServerAccountScope',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('@/sync/domains/scope/activeServerAccountScope')
    >()),
    captureActiveServerAccountScopeLifetime: () => ({
      scope: { serverId: 'server-a', accountId: 'account-a' },
      isCurrent: () => true,
      onRetire: () => ({ dispose() {} }),
    }),
  }),
);

vi.mock('@/sync/domains/state/storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/sync/domains/state/storage')>()),
  useAutomations: () => [],
}));

// The session's Machine comes from the persisted session/machine state (a store boundary).
vi.mock('@/sync/ops/sessionMachineTarget', () => ({
  readMachineControlTargetForSession: () => ({
    machineId: 'machine-a',
    basePath: '/repo',
    confidence: 'reachable',
  }),
}));

vi.mock('@/sync/sync', () => ({
  sync: {
    refreshAutomations: async () => undefined,
    pauseAutomation: automationWrites.pause,
    resumeAutomation: automationWrites.resume,
  },
}));

const { SessionWorkViewWithTriggers } =
  await import('./SessionWorkViewWithTriggers');

const inline = normalizeWorkflowIngress({
  version: 1,
  blocks: ['Summarize overnight CI'],
});
if (inline.kind !== 'parsed')
  throw new Error('fixture definition must normalize');

function lifecycleTrigger(id: string, enabled: boolean) {
  return {
    id,
    revision: 1,
    enabled,
    createdAt: 1,
    updatedAt: 1,
    kind: 'sessionLifecycle',
    triggerDefinitionEnvelope: null,
    sourceSessionId: 'session-1',
    events: ['parentTurnCompleted'],
    policy: { kind: 'everyMatch' },
    remainingOccurrences: null,
    status: { state: 'waiting', runId: null },
  };
}

function triggerSet(
  triggers: ReturnType<typeof lifecycleTrigger>[],
): WorkflowTriggerSetV1 {
  return {
    automationId: 'set-1',
    revision: 4,
    enabled: true,
    health: 'available',
    target: {
      kind: 'inline',
      definition:
        inline.kind === 'parsed' ? inline.definition : (undefined as never),
    },
    triggers,
  } as unknown as WorkflowTriggerSetV1;
}

function answer(
  sets: readonly WorkflowTriggerSetV1[],
  pullRequestLinks: SessionTriggerPullRequestLinksV1 = [],
) {
  executeMock.mockImplementation(async (actionId: string) => {
    if (actionId === 'session.trigger.list')
      return {
        ok: true,
        result: { sessionId: 'session-1', sets, pullRequestLinks },
      };
    if (actionId === 'session.trigger.update')
      return { ok: true, result: { set: sets[0], triggerId: 'trig-1' } };
    if (actionId === 'workflow.trigger.list')
      return { ok: true, result: { sets: [] } };
    if (actionId === 'workflow.run.list')
      return { ok: true, result: { runs: [], metadataByRunId: {} } };
    return { ok: false, error: 'unexpected', errorCode: 'unexpected' };
  });
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

const previousProfileScope = getStorage().getState().profileScope;
beforeEach(() => {
  getStorage().setState({
    profileScope: { serverId: 'server-a', accountId: 'account-a' },
  });
});
afterEach(() => {
  getStorage().setState({ profileScope: previousProfileScope });
  routeParams.current = {};
  executeMock.mockReset();
  automationWrites.pause.mockReset();
  automationWrites.resume.mockReset();
});

describe('the Work tab Triggers section', () => {
  it('keeps ordinary rows usable and shows a separate PR-link retry state', async () => {
    answer([triggerSet([lifecycleTrigger('trig-1', true)])], {
      status: 'unavailable',
      code: 'target_unavailable',
    });
    const screen = await renderScreen(
      <SessionWorkViewWithTriggers sessionId="session-1" scopeId="scope-1" />,
    );
    await settle();
    expect(
      screen.findByTestId('session-work-trigger:set-1:trig-1-switch')?.props
        .value,
    ).toBe(true);
    expect(screen.findByTestId('session-work-triggers-failed')).toBeNull();
    expect(
      screen.findByTestId('session-work-trigger-links-unavailable'),
    ).not.toBeNull();
  });
  it('turns one trigger on or off through session.trigger.update, never by pausing its Automation', async () => {
    // trig-1 is off at trigger level inside an enabled set; trig-2 shares the set.
    answer([
      triggerSet([
        lifecycleTrigger('trig-1', false),
        lifecycleTrigger('trig-2', true),
      ]),
    ]);
    const screen = await renderScreen(
      <SessionWorkViewWithTriggers sessionId="session-1" scopeId="scope-1" />,
    );
    await settle();

    // Read and written on the session's own Machine, whose host owns the session lookup and policy.
    const onSessionMachine = expect.objectContaining({
      externalActionTarget: { kind: 'machine', machineId: 'machine-a' },
    });
    expect(executeMock).toHaveBeenCalledWith(
      'session.trigger.list',
      { sessionId: 'session-1' },
      onSessionMachine,
    );
    const offSwitch = screen.findByTestId(
      'session-work-trigger:set-1:trig-1-switch',
    );
    expect(offSwitch?.props.value).toBe(false);
    await act(async () => {
      offSwitch?.props.onValueChange(true);
    });
    await settle();

    expect(executeMock).toHaveBeenCalledWith(
      'session.trigger.update',
      {
        sessionId: 'session-1',
        triggerId: 'trig-1',
        expectedRevision: 4,
        patch: { enabled: true },
      },
      onSessionMachine,
    );
    expect(automationWrites.pause).not.toHaveBeenCalled();
    expect(automationWrites.resume).not.toHaveBeenCalled();
  });

  it('stays in the Work tab with its empty state and a way to add the first trigger', async () => {
    answer([]);
    const screen = await renderScreen(
      <SessionWorkViewWithTriggers sessionId="session-1" scopeId="scope-1" />,
    );
    await settle();

    expect(screen.findByTestId('session-work-triggers')).not.toBeNull();
    expect(screen.findByTestId('session-work-triggers-empty')).not.toBeNull();
    expect(screen.findByTestId('session-work-triggers-add')).not.toBeNull();
  });

  it('draws no "Writes here" heading while nothing writes into this session, loading or loaded', async () => {
    const { resetWorkflowLibraryReadsForTests } = await import(
      '@/components/workflows/library/workflowLibraryReads'
    );
    resetWorkflowLibraryReadsForTests();
    const runList: { finish: (() => void) | null } = { finish: null };
    executeMock.mockImplementation(async (actionId: string) => {
      if (actionId === 'workflow.trigger.list')
        return { ok: true, result: { sets: [] } };
      if (actionId === 'session.trigger.list')
        return {
          ok: true,
          result: { sessionId: 'session-1', sets: [], pullRequestLinks: [] },
        };
      if (actionId === 'workflow.run.list') {
        await new Promise<void>((resolve) => {
          runList.finish = resolve;
        });
        return { ok: true, result: { runs: [], metadataByRunId: {} } };
      }
      return { ok: false, error: 'unexpected', errorCode: 'unexpected' };
    });
    const screen = await renderScreen(
      <SessionWorkViewWithTriggers sessionId="session-1" scopeId="scope-1" />,
    );
    await settle();
    // Still reading: a section that may not exist holds no skeleton that later collapses.
    expect(screen.findByTestId('session-work-writes-here')).toBeNull();

    await act(async () => {
      runList.finish?.();
    });
    await settle();
    expect(screen.findByTestId('session-work-writes-here')).toBeNull();
  });

  it('opens "When this turn finishes…" bound to that turn and adds it through session.trigger.add', async () => {
    answer([]);
    executeMock.mockImplementation(async (actionId: string) => {
      if (actionId === 'workflow.trigger.list')
        return { ok: true, result: { sets: [] } };
      if (actionId === 'workflow.run.list')
        return { ok: true, result: { runs: [], metadataByRunId: {} } };
      if (actionId === 'session.trigger.list')
        return {
          ok: true,
          result: { sessionId: 'session-1', sets: [], pullRequestLinks: [] },
        };
      if (actionId === 'session.trigger.add')
        return {
          ok: true,
          result: {
            set: triggerSet([lifecycleTrigger('trig-new', true)]),
            triggerId: 'trig-new',
          },
        };
      return { ok: false, error: 'unexpected', errorCode: 'unexpected' };
    });
    routeParams.current = {
      sourceSessionId: 'session-1',
      sourceTurnId: 'turn-7',
      sourceServerId: 'server-a',
      sessionLifecycleEvents: 'parentTurnCompleted',
    };
    const screen = await renderScreen(
      <SessionWorkViewWithTriggers sessionId="session-1" scopeId="scope-1" />,
    );
    await settle();

    expect(screen.findByTestId('session-work-trigger-popover')).not.toBeNull();
    await act(async () => {
      screen.changeTextByTestId(
        'session-work-trigger-popover-prompt',
        'Review what changed',
      );
    });
    await act(async () => {
      screen.pressByTestId('session-work-trigger-popover-submit');
    });
    await settle();

    const add = executeMock.mock.calls.find(
      ([actionId]) => actionId === 'session.trigger.add',
    );
    expect(add?.[1]).toMatchObject({
      sessionId: 'session-1',
      trigger: {
        kind: 'sessionLifecycle',
        sourceSessionId: 'session-1',
        policy: { kind: 'currentTurn', sourceTurnId: 'turn-7' },
      },
      target: { kind: 'inline' },
    });
  });
});
