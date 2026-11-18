import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import type { BulkSessionChangeRow } from '@/components/sessions/authoring/bulk/executeBulkSessionChanges';
import { BulkSessionResults } from './BulkSessionResults';

afterEach(standardCleanup);

const row = (
  sessionId: string,
  state: BulkSessionChangeRow['state'],
  reason?: string,
): BulkSessionChangeRow => ({
  target: { serverId: 'home', sessionId },
  actionId: 'session.message.send',
  state,
  ...(reason ? { reason, code: reason } : {}),
});

async function render(
  rows: readonly BulkSessionChangeRow[],
  onRetry = vi.fn(),
  onRetryFailed = vi.fn(),
) {
  const screen = await renderScreen(
    <BulkSessionResults
      rows={rows}
      text="Rebase and rerun the tests."
      submitting={false}
      compact={false}
      onRetry={onRetry}
      onRetryFailed={onRetryFailed}
      onDone={() => {}}
      onOpenSession={() => {}}
    />,
  );
  return { screen, onRetry, onRetryFailed };
}

describe('BulkSessionResults', () => {
  it('offers a per-row Retry and Retry failed only once two or more sessions failed', async () => {
    const { screen, onRetry, onRetryFailed } = await render([
      row('a', 'failed', 'nl3 stopped answering'),
      row('b', 'failed'),
      row('c', 'sent'),
    ]);
    screen.pressByTestId('bulk-compose-retry:a');
    expect(onRetry).toHaveBeenCalledWith({ serverId: 'home', sessionId: 'a' });
    screen.pressByTestId('bulk-compose-retry-failed');
    expect(onRetryFailed).toHaveBeenCalledTimes(1);
    expect(screen.findByTestId('bulk-compose-retry:c')).toBeFalsy();
    expect(screen.getTextContent()).toContain('nl3 stopped answering');
  });

  it('keeps one failure to its own row and lists skipped sessions in their own group', async () => {
    const { screen } = await render([
      row('a', 'failed'),
      row('b', 'sent'),
      row('z', 'skipped', 'archived'),
    ]);
    expect(screen.findByTestId('bulk-compose-retry-failed')).toBeFalsy();
    expect(screen.findByTestId('bulk-compose-retry:a')).toBeTruthy();
    expect(screen.findByTestId('bulk-compose-results-skipped')).toBeTruthy();
    expect(screen.findByTestId('bulk-compose-retry:z')).toBeFalsy();
  });

  it('offers Review for a session whose send waits for an approval', async () => {
    const { screen } = await render([
      row('w', 'approval_pending'),
      row('b', 'sent'),
    ]);
    expect(screen.findByTestId('bulk-compose-review:w')).toBeTruthy();
  });

  it('rules only rows with a reason line, and never after the last row (owner 2026-11-17 23:52Z)', async () => {
    const rules = (screen: Awaited<ReturnType<typeof render>>['screen']) =>
      screen.findAllByTestId('happier-list-row-rule').length;
    const twoLine = await render([
      row('a', 'failed', 'nl3 stopped answering'),
      row('b', 'failed', 'ci-runner is offline'),
    ]);
    expect(rules(twoLine.screen)).toBe(1);
    const oneLine = await render([row('c', 'sent'), row('d', 'sent')]);
    expect(rules(oneLine.screen)).toBe(0);
  });
});
