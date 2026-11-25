import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { t } from '@/text';

import { readScheduleWhen } from './sessionTriggerForm';
import { presentSpentOnceSchedule } from './triggerSchedule';
import { WorkflowTriggerBlock } from './WorkflowTriggerBlock';

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
it('says a spent one-time trigger already ran, with no switch, when its outcome is not loaded', async () => {
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
    t('workflows.triggers.once.alreadyRan'),
  );
  expect(screen.getTextContent()).toContain(
    t('workflows.triggers.once.runAgain'),
  );
  await screen.unmount();
});

it('leaves the outcome to an open History and keeps only the way to run it again', async () => {
  const screen = await renderScreen(
    block(
      { ...once, remainingOccurrences: 0, nextRunAt: null },
      readScheduleWhen(once.schedule),
      null,
      <></>,
    ),
  );
  expect(screen.getTextContent()).not.toContain(
    t('workflows.triggers.once.alreadyRan'),
  );
  expect(screen.getTextContent()).toContain(
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
