import { afterEach, describe, expect, it } from 'vitest';
import * as React from 'react';

import { flushHookEffects, renderScreen } from '@/dev/testkit';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';

const { CoordinationStatesSpecimen } =
  await import('./CoordinationStatesSpecimen');
afterEach(standardCleanup);

const label = (screen: Awaited<ReturnType<typeof renderScreen>>, id: string) =>
  screen.findHostByTestId(`${id}:label`)?.children.join('') ?? null;

describe('Coordination states specimen', () => {
  it('draws each Ask target in its settled state from the fixture transcript, with no live reads', async () => {
    const screen = await renderScreen(
      <CoordinationStatesSpecimen scene="ask" />,
    );
    await flushHookEffects({ cycles: 5 });
    expect(label(screen, 'session-ask-record-target-state:checkout')).toBe(
      'Answered',
    );
    expect(label(screen, 'session-ask-record-target-state:runbook')).toBe(
      'Passed',
    );
    expect(
      label(screen, 'session-ask-record-target-state:review'),
    ).not.toBeNull();
    expect(label(screen, 'session-ask-record-target-state:ledger')).toBe(
      'Answered',
    );
    expect(screen.getTextContent()).toContain(
      'No banner change; replays read as confirmed',
    );
    expect(screen.getTextContent()).toContain('Checkout UI retry states');
    await screen.unmount();
  });

  it('draws the populated Followers census: you, each follower Session by name, and the other people', async () => {
    const screen = await renderScreen(
      <CoordinationStatesSpecimen scene="followers" />,
    );
    await flushHookEffects({ cycles: 5 });
    expect(
      screen.findHostByTestId('session-people-follower-you'),
    ).not.toBeNull();
    for (const id of ['coordinator', 'runbook', 'rollout']) {
      expect(
        screen.findHostByTestId(`session-people-follower-session-${id}`),
      ).not.toBeNull();
    }
    // The census only counts the other people, so their row is plain information that promises no list.
    const people = screen.findHostByTestId('session-people-followers-people');
    expect(people).not.toBeNull();
    expect(people?.props.accessibilityRole ?? people?.props.role ?? null).toBeNull();
    expect(people?.props.onPress ?? people?.props.onClick ?? null).toBeNull();
    expect(screen.getTextContent()).toContain('Daily coordinator');
    await screen.unmount();
  });
});
