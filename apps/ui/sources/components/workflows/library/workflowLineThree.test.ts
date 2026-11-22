import { describe, expect, it, vi } from 'vitest';
import { WorkflowDefinitionListResultV1Schema } from '@happier-dev/protocol/workflows/actionsV1';
import { WorkflowTriggerSetV1Schema } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';

vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock();
});

const { projectWorkflowLibraryRecords } =
  await import('./workflowLibraryCollection');
const { readWorkflowLibraryRowFacts, readWorkflowLineThree } =
  await import('./workflowLibraryCells');

const NOW = Date.UTC(2026, 10, 20, 12, 0, 0);
const ALL = { steps: true, nextRun: true, lastRun: true };
const schedule = {
  kind: 'schedule',
  enabled: true,
  remainingOccurrences: null,
  schedule: {
    kind: 'interval',
    scheduleExpr: null,
    everyMs: 3_600_000,
    timezone: null,
  },
};
const turnEnds = {
  kind: 'sessionLifecycle',
  enabled: true,
  events: ['parentTurnCompleted'],
};

/** A saved Workflow as the definition list returns it, projected by the library owner. */
function savedRow(
  overrides: Readonly<{
    triggers: readonly unknown[];
    nextRunAt: number | null;
  }>,
) {
  const { definitions } = WorkflowDefinitionListResultV1Schema.parse({
    definitions: [
      {
        kind: 'workflow-definition.v1',
        definitionId: '10000000-0000-4000-8000-000000000039',
        revision: { headerVersion: 1, bodyVersion: 1 },
        metadata: { title: 'Line three' },
        ownerAccountId: 'account-a',
        access: 'owner',
        contentStatus: 'available',
        stepCount: 2,
        ...overrides,
      },
    ],
  });
  const [row] = projectWorkflowLibraryRecords({
    definitions: { library: definitions, sharedWithYou: [] },
    accountTriggers: [],
    summaries: null,
    automationSummaries: null,
  });
  return row!;
}
it('keeps the standalone trigger clause when its Library row is Off', () => {
  const accountTrigger = WorkflowTriggerSetV1Schema.parse({ automationId: 'standalone', revision: 1, enabled: false,
    health: 'available', target: { kind: 'inline', definition: { version: 1, inputs: [], blocks: [
      { kind: 'action', id: 'notify', actionId: 'notifications.notify_me',
        input: { message: { kind: 'literal', value: 'Review ready' } } },
    ] } },
    triggers: [{ kind: 'action', id: 'before', revision: 1, enabled: false, createdAt: 1, updatedAt: 1,
      phase: 'before', mode: 'wait', actionIds: ['machines.command.run'] }],
  });
  const [row] = projectWorkflowLibraryRecords({ definitions: { library: [], sharedWithYou: [] }, accountTriggers: [accountTrigger],
    summaries: null, automationSummaries: null });
  const state = readWorkflowLibraryRowFacts(row!);
  expect(state).toMatchObject({ state: 'off', triggerLine: row!.triggerSummary });
  expect(state.triggerLine).toContain('workflows.triggers.link.beforeAction');
  expect(state.triggerLine).not.toContain('workflows.triggers.row.off');
});

const lineThree = (row: ReturnType<typeof savedRow>, details = ALL) =>
  readWorkflowLineThree(row, readWorkflowLibraryRowFacts(row), details, NOW);

// F-AUDIT row 39 + UI refinements ruling 12:52Z: Lines 3 reads as the lab's scene 8 "Lines × details" copy.
describe("a Workflow row's Lines 3", () => {
  it('says an event-triggered Workflow runs when it happens, and a schedule with no upcoming run has no next run', () => {
    expect(
      lineThree(savedRow({ triggers: [turnEnds], nextRunAt: null })).start,
    ).toBe(
      'workflows.examples.stepCount(count=2) · workflows.destination.runsWhenItHappens',
    );
    expect(
      lineThree(savedRow({ triggers: [schedule], nextRunAt: null })).start,
    ).toBe('workflows.examples.stepCount(count=2) · automations.list.noNextRun');
    expect(
      lineThree(savedRow({ triggers: [schedule], nextRunAt: NOW + 3_600_000 }))
        .start,
    ).toMatch(/^workflows\.examples\.stepCount\(count=2\) · workflows\.triggers\.row\.nextRun\(/);
  });

  it('says nothing about when a manual-only Workflow runs, and drops what its Row details turn off', () => {
    expect(lineThree(savedRow({ triggers: [], nextRunAt: null })).start).toBe(
      'workflows.examples.stepCount(count=2)',
    );
    expect(
      lineThree(savedRow({ triggers: [turnEnds], nextRunAt: null }), {
        steps: false,
        nextRun: false,
        lastRun: true,
      }),
    ).toEqual({ start: null, end: null });
  });

  it('says an Off Workflow has no next run, even when its triggers are on', () => {
    // An Account workflow whose set is off keeps its triggers enabled; its row facts say Off (live repo-dev 11-20).
    const row = savedRow({ triggers: [turnEnds], nextRunAt: null });
    expect(readWorkflowLineThree(row, { ...readWorkflowLibraryRowFacts(row), state: 'off' }, ALL, NOW).start).toBe(
      'workflows.examples.stepCount(count=2) · automations.list.noNextRun',
    );
  });
});
