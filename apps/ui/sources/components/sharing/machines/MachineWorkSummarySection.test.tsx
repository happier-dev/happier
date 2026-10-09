import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '@/components/settings/settingsViewTestHelpers';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

installSettingsViewCommonModuleMocks({
  text: async () => vi.importActual<typeof import('@/text')>('@/text'),
});
afterEach(() => standardCleanup());

describe('MachineWorkSummarySection', () => {
  it('counts only what each person has, and never says zero for an unavailable summary', async () => {
    const { MachineWorkSummarySection, describeMachineWorkCounts } =
      await import('./MachineWorkSummarySection');
    expect(
      describeMachineWorkCounts({ sessions: 2, tasks: 1, terminals: 1 }),
    ).toBe('2 sessions · 1 task · 1 terminal');
    expect(
      describeMachineWorkCounts({ sessions: 1, tasks: 0, terminals: 0 }),
    ).toBe('1 session');

    const unavailable = await renderScreen(
      <MachineWorkSummarySection
        testID="work"
        machineName="devbox"
        state={{ kind: 'summary', summary: { kind: 'unavailable' } }}
        onRetry={() => undefined}
      />,
    );
    expect(unavailable.findByTestId('work.unavailable')).not.toBeNull();
    expect(unavailable.findByTestId('work.empty')).toBeNull();
    expect(unavailable.findByTestId('work.retry')).not.toBeNull();
    await act(async () => { unavailable.tree.unmount(); });

    const current = await renderScreen(
      <MachineWorkSummarySection
        testID="work"
        machineName="devbox"
        state={{
          kind: 'summary',
          summary: {
            kind: 'current',
            requesters: [
              {
                accountId: 'ana',
                displayName: 'Ana Ruiz',
                sessions: 2,
                tasks: 1,
                terminals: 1,
              },
              {
                accountId: 'idle',
                displayName: 'Idle',
                sessions: 0,
                tasks: 0,
                terminals: 0,
              },
            ],
          },
        }}
      />,
    );
    expect(current.findByTestId('work.ana')).not.toBeNull();
    expect(current.findByTestId('work.idle')).toBeNull();
  });

  it('keeps last-known rows readable with an explicit freshness line', async () => {
    const { MachineWorkSummarySection } = await import('./MachineWorkSummarySection');
    const screen = await renderScreen(<MachineWorkSummarySection testID="work" machineName="devbox"
      state={{ kind: 'summary', summary: { kind: 'current', requesters: [{ accountId: 'bob', displayName: 'Bob', sessions: 1, tasks: 0, terminals: 0 }] }, stale: 'unavailable', asOf: 1 }}
      onRetry={() => undefined} />);
    expect(screen.findByTestId('work.bob')).not.toBeNull();
    expect(screen.findByTestId('work.stale')).not.toBeNull();
    expect(screen.findByTestId('work.empty')).toBeNull();
  });

  it('does not advertise a retained empty count as current when a refresh is unavailable', async () => {
    const { MachineWorkSummarySection } = await import('./MachineWorkSummarySection');
    const screen = await renderScreen(<MachineWorkSummarySection testID="work" machineName="devbox"
      state={{ kind: 'summary', summary: { kind: 'current', requesters: [] }, stale: 'unavailable', asOf: 1 }} />);
    expect(screen.findByTestId('work.empty') !== null).toBe(false);
    expect(screen.findByTestId('work.unavailable') !== null).toBe(true);
    expect(screen.findByTestId('work.stale') !== null).toBe(false);
  });
});
