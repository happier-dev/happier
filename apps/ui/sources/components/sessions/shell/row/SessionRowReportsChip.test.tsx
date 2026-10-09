import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SessionReportsV1 } from '@happier-dev/protocol/sessions/relations/sessionReportsToV1';

import { renderScreen, standardCleanup } from '@/dev/testkit';

import {
  SessionRowReportsChip,
  SessionRowReportsDisclosure,
} from './SessionRowReportsChip';

const REPORTS: SessionReportsV1 = { total: 3, needsYou: 1, working: 1, stalled: 0 };

describe('SessionRowReportsChip', () => {
  afterEach(() => {
    standardCleanup();
  });

  it('keeps a folded lead quiet but truthful: the reports count, and the needs-you dot while one waits', async () => {
    const screen = await renderScreen(
      <SessionRowReportsChip
        sessionId="bot"
        reports={REPORTS}
        collapsed
      />,
    );
    expect(screen.getTextContent()).toContain('3');
    const settled = await renderScreen(
      <SessionRowReportsChip
        sessionId="bot"
        reports={{ total: 3, needsYou: 0, working: 0, stalled: 0 }}
        collapsed
      />,
    );
    // Settled reports no longer hide behind an absent chip once they are folded away.
    expect(settled.findByTestId('session-row-reports-chip:bot')).not.toBeNull();
  });

  it('writes the explicit opposite of the current fold for its own list node', async () => {
    const onSetCollapsed = vi.fn();
    const screen = await renderScreen(
      <SessionRowReportsDisclosure
        sessionId="bot"
        nodeId="session:home/bot"
        name="Release captain"
        count={3}
        collapsed
        onSetCollapsed={onSetCollapsed}
      />,
    );
    const control = screen.findByTestId('session-row-reports-disclosure:bot');
    expect(control?.props.accessibilityState).toMatchObject({
      expanded: false,
    });
    screen.pressByTestId('session-row-reports-disclosure:bot');
    expect(onSetCollapsed).toHaveBeenCalledWith('session:home/bot', false);

    const expanded = await renderScreen(
      <SessionRowReportsDisclosure
        sessionId="bot2"
        nodeId="session:home/bot2"
        name="Release captain"
        count={3}
        collapsed={false}
        onSetCollapsed={onSetCollapsed}
      />,
    );
    expanded.pressByTestId('session-row-reports-disclosure:bot2');
    expect(onSetCollapsed).toHaveBeenLastCalledWith('session:home/bot2', true);
  });
});
