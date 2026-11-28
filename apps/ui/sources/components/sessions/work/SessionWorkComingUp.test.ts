import { describe, expect, it, vi } from 'vitest';

import { createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import type { AccountTriggerRow } from '@/components/workflows/triggers/accountTriggerRows';

vi.mock('@/text', async () =>
  (await import('@/dev/testkit/mocks/text')).createTextModuleMock(),
);

const { projectComingUp } = await import('./SessionWorkComingUp');

/** A trigger row as the Automations owner projects it, with its last Run as the attachment carries it. */
function row(
  id: string,
  overrides: Partial<AccountTriggerRow> = {},
  lastRunState?: 'failed' | 'succeeded',
): AccountTriggerRow {
  const run =
    lastRunState === undefined
      ? null
      : createWorkflowRunSummaryFixture({
          id: `run-${id}`,
          state: lastRunState,
          finishedAt: '2026-09-08T10:10:00.000Z',
        });
  return {
    automationId: id,
    triggerId: null,
    title: `When ${id}`,
    glyph: 'timer',
    subtitle: `Runs ${id}`,
    off: false,
    ...(run
      ? {
          attachment: {
            lastRun: {
              id: run.id,
              state: run.state,
              workflowCustodyState: run.workflowCustodyState,
              attentionRequired: run.attentionRequired,
              failureUnseen: run.failureUnseen,
              invocationAttentionRequired: run.invocationAttentionRequired,
              createdAt: run.createdAt,
              startedAt: run.createdAt,
            },
          } as never,
        }
      : {}),
    ...overrides,
  };
}

describe('Work › Coming up (read-only automations preview)', () => {
  it('keeps a failed automation listed while healthy ones are cut, pointing it at the failed Run', () => {
    const preview = projectComingUp([
      row('a'),
      row('b', {}, 'succeeded'),
      row('c'),
      row('d'),
      row('e'),
      row('broken', { off: true }, 'failed'),
    ]);
    expect(preview.listed.map((entry) => entry.row.automationId)).toEqual([
      'broken',
      'a',
      'b',
      'c',
    ]);
    expect(preview.listed[0]!.failedRunId).toBe('run-broken');
    expect(
      preview.listed.slice(1).every((entry) => entry.failedRunId === null),
    ).toBe(true);
    expect(preview.hidden).toBe(2);
  });

  it('lists only automations that will run: off and gone ones stay in Info', () => {
    const preview = projectComingUp([
      row('off', { off: true }),
      row('gone', { sourceGone: true }),
      row('on'),
    ]);
    expect(preview.listed.map((entry) => entry.row.automationId)).toEqual([
      'on',
    ]);
    expect(preview.hidden).toBe(0);
  });
});
