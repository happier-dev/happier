import { describe, expect, it, vi } from 'vitest';
import { AutomationTriggerIdSchema } from '@happier-dev/protocol/automations/automationTriggerIdentity';

vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock();
});

const { presentScheduleHold, readTriggerScheduleHold } =
  await import('./scheduleHoldPresentation');
const { formatNextScheduledRun, formatNextScheduledRunTime } =
  await import('./formatTriggerSummary');

const triggerId = AutomationTriggerIdSchema.parse('hourly-trigger');
const reasonOnly = { triggerId, reason: 'open_occurrence' as const };
const running = { ...reasonOnly, runId: 'run-7', runState: 'running' as const };
const interrupted = {
  ...reasonOnly,
  runId: 'run-8',
  runState: 'interrupted' as const,
};

describe('presentScheduleHold', () => {
  it('says a schedule waits for its running previous run and links that run', () => {
    expect(presentScheduleHold(running)).toEqual({
      text: 'workflows.triggers.row.heldByRun',
      short: 'workflows.triggers.row.heldShort',
      interrupted: false,
      runId: 'run-7',
    });
  });

  it('names an interrupted previous run, the case a person must act on', () => {
    expect(presentScheduleHold(interrupted)).toEqual({
      text: 'workflows.triggers.row.heldByInterruptedRun',
      short: 'workflows.triggers.row.heldInterruptedShort',
      interrupted: true,
      runId: 'run-8',
    });
  });

  it('still says it waits when the server withheld the run, without a link', () => {
    expect(presentScheduleHold(reasonOnly)).toEqual({
      text: 'workflows.triggers.row.heldByRun',
      short: 'workflows.triggers.row.heldShort',
      interrupted: false,
      runId: null,
    });
  });

  it('presents nothing without a hold, and only reads the hold of the asked trigger', () => {
    expect(presentScheduleHold(undefined)).toBeNull();
    expect(
      readTriggerScheduleHold({ scheduleHolds: [running] }, 'other-trigger'),
    ).toBeUndefined();
    expect(
      readTriggerScheduleHold({ scheduleHolds: [running] }, triggerId),
    ).toBe(running);
    expect(readTriggerScheduleHold({}, triggerId)).toBeUndefined();
  });
});

describe('next scheduled run with a hold', () => {
  const now = 1_700_000_000_000;
  const hold = presentScheduleHold(interrupted);

  it('replaces Pending with the reason once the occurrence is due', () => {
    expect(formatNextScheduledRun(now - 1, true, now, hold)).toBe(
      'workflows.triggers.row.heldByInterruptedRun',
    );
    expect(formatNextScheduledRun(null, true, now, hold)).toBe(
      'workflows.triggers.row.heldByInterruptedRun',
    );
    expect(formatNextScheduledRunTime(now - 1, true, now, hold)).toBe(
      'workflows.triggers.row.heldInterruptedShort',
    );
  });

  it('keeps Pending, a future time and Off unchanged otherwise', () => {
    expect(formatNextScheduledRun(now - 1, true, now)).toBe(
      'automations.list.nextRunPending',
    );
    expect(
      formatNextScheduledRunTime(now + 5 * 60_000, true, now, hold),
    ).not.toBe('workflows.triggers.row.heldInterruptedShort');
    expect(formatNextScheduledRun(now - 1, false, now, hold)).toBe(
      'automations.list.noNextRun',
    );
  });
});
