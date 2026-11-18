import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import type { BulkSessionChangeRow } from '@/components/sessions/authoring/bulk/executeBulkSessionChanges';
import { BulkSessionResults } from './BulkSessionResults';
import { t } from '@/text';

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
  text: string | null = 'Rebase and rerun the tests.',
) {
  const screen = await renderScreen(
    <BulkSessionResults
      rows={rows}
      text={text}
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

  it('says the rows\' own word in the summary: sent for a message, changed for settings only', async () => {
    const pill = (screen: Awaited<ReturnType<typeof render>>['screen']) =>
      String(screen.findAll((node) => node.props?.testID === 'bulk-compose-results-summary'
        && typeof node.props.label === 'string')[0]?.props.label).toLowerCase();
    const sent = await render([row('a', 'sent'), row('b', 'applying')]);
    expect(pill(sent.screen)).toContain('sent');
    const settings = await render([
      { ...row('c', 'applied'), actionId: 'session.permission_mode.set' },
      { ...row('d', 'applied'), actionId: 'session.permission_mode.set' },
    ], vi.fn(), vi.fn(), null);
    expect(pill(settings.screen)).toContain('changed');
  });

  it('keeps the agent switch in the reason line of a row whose message followed it', async () => {
    const { screen } = await render([{ ...row('a', 'sent'), switchedFrom: 'happier.agent.gemini/gemini',
      switchedTo: 'happier.agent.claude/claude' }]);
    expect(screen.getTextContent()).toMatch(/Gemini.*Claude/);
  });

  it('says why a send was refused when the target gave only a typed code', async () => {
    const { screen } = await render([{ ...row('a', 'failed'), code: 'session_input_target_update_required' }]);
    expect(screen.getTextContent()).toContain(t('session.pendingMessages.admissionRejected.targetUpdateRequired'));
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
