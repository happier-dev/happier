import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { WorkflowTriggerSetV1Schema } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { t } from '@/text';

import { readScheduleWhen } from './sessionTriggerForm';
import { formatOnceScheduleInstant, presentSpentOnceSchedule } from './triggerSchedule';
import { WorkflowTriggerBlock } from './WorkflowTriggerBlock';
import { WorkflowTriggerSection } from './WorkflowTriggerSection';

afterEach(standardCleanup);

const scheduledAt = Date.UTC(2026, 10, 24, 15, 0);
const once = {
  kind: 'schedule',
  schedule: { kind: 'once', scheduledAt },
} as const;
const daily = {
  kind: 'schedule',
  schedule: {
    kind: 'cron',
    scheduleExpr: '0 9 * * *',
    everyMs: null,
    timezone: null,
  },
} as const;

it.each(['sentence', 'card'] as const)('says a missed occurrence in the resting editor (%s) without opening History', async presentation => {
  const saved = WorkflowTriggerSetV1Schema.parse({ automationId: 'once', revision: 1, enabled: true, health: 'available', triggers: [
    { ...once, id: 'one', revision: 1, enabled: true, createdAt: 1, updatedAt: 1,
      nextRunAt: null, remainingOccurrences: 0, triggerDefinitionEnvelope: null },
  ] });
  const triggers = saved.triggers.map(trigger => ({ ...trigger, spentOnceRun: { runState: 'missed' as const, startedAt: null } }));
  const screen = await renderScreen(<WorkflowTriggerSection
    testIDPrefix="spent" presentation={presentation} set={{ ...saved, triggers }}
    status="ready" draft={{ adds: [], updates: {}, removes: [] }} onChangeDraft={vi.fn()} onRetry={vi.fn()}
    stepsUnsaved={false} whereTarget={null} whereSummary={null} inputs={[]} />);
  try {
    const text = screen.getTextContent();
    expect(text).toContain(t('workflows.triggers.once.missedOn', { time: formatOnceScheduleInstant(scheduledAt) }));
    expect(text).not.toContain('Already ran');
  } finally {
    await screen.unmount();
  }
});

// The saved trigger as the set read returns it; the block reads only the presenter's result.
function block(
  trigger: Parameters<typeof presentSpentOnceSchedule>[0],
  when: ReturnType<typeof readScheduleWhen>,
  nextRunAt: number | null,
  history?: React.ReactNode,
) {
  return (
    <WorkflowTriggerBlock
      testID="t"
      title="Once at Nov 24, 3:00 PM"
      when={when}
      enabled
      incomplete={false}
      startOptions={[]}
      onSelectStart={vi.fn()}
      onChangeWhen={vi.fn()}
      onRemove={vi.fn()}
      onToggleEnabled={vi.fn()}
      machineId={null}
      serverId={null}
      savedNextRunAt={nextRunAt}
      spentOnce={presentSpentOnceSchedule(trigger)}
      history={history}
    />
  );
}

// R12 M12: a consumed one-time trigger stays enabled on the server. It reads as finished, offers no switch that
// would read as armed, and its At field is the way to schedule it again.
it('states that no occurrences remain and shows no switch when the outcome is unavailable', async () => {
  const screen = await renderScreen(
    block(
      { ...once, remainingOccurrences: 0, nextRunAt: null },
      readScheduleWhen(once.schedule),
      null,
    ),
  );
  expect(screen.findByTestId('t-toggle')).toBeNull();
  const note = screen.findByTestId('t-spent');
  expect(note).not.toBeNull();
  expect(screen.getTextContent()).toContain(
    t('workflows.triggers.once.noMoreOccurrences'),
  );
  expect(screen.getTextContent()).toContain(
    t('workflows.triggers.once.runAgain'),
  );
  await screen.unmount();
});

it('leaves the outcome and the way to run it again to an open History, which states them in that order (R12 M12)', async () => {
  const screen = await renderScreen(
    block(
      { ...once, remainingOccurrences: 0, nextRunAt: null },
      readScheduleWhen(once.schedule),
      null,
      <></>,
    ),
  );
  expect(screen.getTextContent()).not.toContain(
    t('workflows.triggers.once.noMoreOccurrences'),
  );
  expect(screen.getTextContent()).not.toContain(
    t('workflows.triggers.once.runAgain'),
  );
  await screen.unmount();
});

it('keeps an armed one-time trigger and a recurring one as they are', async () => {
  const armed = await renderScreen(
    block(
      { ...once, remainingOccurrences: 1, nextRunAt: scheduledAt },
      readScheduleWhen(once.schedule),
      scheduledAt,
    ),
  );
  expect(armed.findByTestId('t-toggle')).not.toBeNull();
  expect(armed.findByTestId('t-spent')).toBeNull();
  await armed.unmount();
  const recurring = await renderScreen(
    block(
      {
        ...daily,
        remainingOccurrences: null,
        nextRunAt: Date.now() + 3_600_000,
      },
      readScheduleWhen(daily.schedule),
      Date.now() + 3_600_000,
    ),
  );
  expect(recurring.findByTestId('t-toggle')).not.toBeNull();
  expect(recurring.findByTestId('t-spent')).toBeNull();
  await recurring.unmount();
});
