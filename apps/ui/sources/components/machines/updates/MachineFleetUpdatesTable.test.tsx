import * as React from 'react';
import { act, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';

import {
  invokeTestInstanceHandler,
  renderScreen,
  standardCleanup,
} from '@/dev/testkit';
import { CoreCollectionScope } from '@/components/ui/lists/collection/CoreCollectionScope';
import { t } from '@/text';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';

import type { FleetUpdatesRow } from './machineFleetUpdates';

// Standing alone the table scrolls itself; the native list boundary must mount its cells.
vi.mock('react-native', async () => {
  const [{ createCapturingFlatListMock }, { createReactNativeWebMock }] =
    await Promise.all([
      import('@/dev/testkit/mocks/virtualizedList'),
      import('@/dev/testkit/mocks/reactNative'),
    ]);
  return createReactNativeWebMock(
    createCapturingFlatListMock({ renderItems: true }).module,
  );
});

const { MachineFleetUpdatesTable } = await import('./MachineFleetUpdatesTable');
afterEach(() => standardCleanup());

const row = (
  machineId: string,
  facts: Partial<FleetUpdatesRow>,
): FleetUpdatesRow => ({
  machineId,
  name: machineId,
  online: true,
  installationId: null,
  platform: 'linux',
  security: null,
  all: null,
  restartNeeded: false,
  checkedAt: null,
  ...facts,
});

function textOf(node: ReactTestInstance | undefined): string {
  if (!node) return '';
  return node.children
    .map((child) => (typeof child === 'string' ? child : textOf(child)))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const CHECKED = Date.UTC(2026, 10, 14, 6, 12);

it('says each Machine’s Security, All, Restart and when it last checked in its own column, and "—" where a Machine can’t say today, never zero', async () => {
  const onOpen = vi.fn();
  const screen = await renderScreen(
    <CoreCollectionScope>
    <MachineFleetUpdatesTable
      testID="fleet"
      onOpen={onOpen}
      rows={[
        row('hetzner', { security: 3, all: 7, checkedAt: CHECKED }),
        row('vps', { security: 0, all: 2, held: 1, restartNeeded: true, checkedAt: CHECKED }),
        row('fresh', {}),
        // Offline: its last answer is not today's count (readFleetUpdatesRow drops it), but when it last checked stays true.
        row('build', { online: false, security: 4, all: 9, checkedAt: CHECKED }),
      ]}
    />
    </CoreCollectionScope>,
  );
  await act(async () => {
    invokeTestInstanceHandler(screen.findByTestId('fleet:stage'), 'onLayout', {
      nativeEvent: { layout: { x: 0, y: 0, width: 944, height: 600 } },
    });
  });
  const rowText = (id: string) =>
    textOf(screen.tree.findAll((node) => node.props.testID === `machines.updates.row.${id}:cell`)[0]);
  const text = screen.getTextContent();
  for (const column of [
    'columnSecurity',
    'columnAll',
    'columnRestart',
    'columnChecked',
  ] as const) {
    expect(text).toContain(t(`machineFleetUpdates.${column}`));
  }
  const notNeeded = t('machineFleetUpdates.restartNotNeeded');
  const needed = t('machineFleetUpdates.restartNeeded');
  // Each row reads the Machine and its system, then Security · All · Restart · Checked, in the columns' order.
  const checked = formatAsOfTime(CHECKED);
  expect(rowText('hetzner')).toContain(`hetzner Linux 3 7 ${notNeeded} ${checked}`);
  expect(rowText('vps')).toContain(`vps Linux · ${t('machineDetailPage.security.heldPackageCount', { count: 1 })} 0 2 ${needed} ${checked}`);
  expect(rowText('fresh')).toContain('fresh Linux — — — —');
  // Offline (lab fUpd build-01): the counts are not today's, the check time is the last one it reported.
  expect(rowText('build')).toContain(`build Linux — — — ${t('machineFleetUpdates.checkedAsOf', { time: checked })}`);
  expect(rowText('build')).not.toMatch(/\b[49]\b/);

  await screen.pressByTestIdAsync('machines.updates.row.hetzner');
  expect(onOpen).toHaveBeenCalledWith('hetzner');
  await screen.unmount();
});
