import { describe, expect, it, vi } from 'vitest';
import * as React from 'react';

import { createMachineFixture, renderScreen } from '@/dev/testkit';
import type { Machine } from '@/sync/domains/state/storageTypes';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native-reanimated', async () =>
  (await import('@/dev/testkit/mocks/reanimated')).createReanimatedModuleMock(),
);

const { SessionMachineField, SessionPlacementChips } = await import('./SessionPlacementChips');

function machine(id: string, name: string): Machine {
  return createMachineFixture({
    id,
    metadata: {
      host: id,
      displayName: name,
      happyCliVersion: '0.0.0-test',
      happyHomeDir: '/Users/test/.happy-dev',
      homeDir: '/Users/test',
      platform: 'darwin',
    },
  }) as Machine;
}

describe('SessionPlacementChips', () => {
  it('keeps a fixed Machine visible but not choosable when the host offers no Machine move', async () => {
    const { NewSessionMachineSelectionContent } =
      await import('@/components/sessions/new/components/NewSessionMachineSelectionContent');
    const screen = await renderScreen(
      <SessionPlacementChips
        serverId="server-a"
        machine={machine('machine-1', 'Machine 1')}
        path=""
        onSelectPath={vi.fn()}
      />,
    );
    // The disabled chip names the host's Machine and opens no picker.
    expect(screen.findHostByTestId('agent-input-machine-chip')?.props.accessibilityState)
      .toMatchObject({ disabled: true });
    expect(
      screen.findAllByType(NewSessionMachineSelectionContent),
    ).toHaveLength(0);
    await screen.unmount();
  });

  it('keeps the folder chip in place, disabled, until a Machine is chosen (ruling 3)', async () => {
    const screen = await renderScreen(
      <SessionPlacementChips serverId="server-a" machine={null} path="" onSelectMachine={vi.fn()} onSelectPath={vi.fn()} />,
    );
    const folder = screen.findAllByTestId('agent-input-path-chip').find((node) => typeof node.props.accessibilityLabel === 'string');
    expect(folder?.props.accessibilityLabel).toBe((await import('@/text')).t('newSession.folder.chooseMachineFirst'));
    expect(folder?.props.disabled).toBe(true);
    await screen.unmount();
  });

  it('tells a chosen Machine apart from a same-named peer, as the Machine list does', async () => {
    const { getMachineDisplayName } = await import('@/utils/sessions/machineDisplayNames');
    const first = machine('machine-a1', 'Build box');
    const second = machine('machine-b2', 'Build box');
    const screen = await renderScreen(
      <SessionMachineField testID="builder" serverId="server-a" title="Builds on" machines={[first, second]}
        machineId="machine-b2" onSelectMachine={vi.fn()} />,
    );
    const qualified = getMachineDisplayName(second, [first, second]);
    expect(qualified).not.toBe('Build box');
    expect(screen.getTextContent()).toContain(qualified);
    await screen.unmount();
  });

  it('names a chosen Machine the host no longer lists with its fallback, and stays closed while disabled', async () => {
    const { NewSessionMachineSelectionContent } = await import('@/components/sessions/new/components/NewSessionMachineSelectionContent');
    const screen = await renderScreen(
      <SessionMachineField testID="builder" serverId="server-a" title="Builds on" machines={[machine('machine-1', 'Studio')]}
        machineId="gone" machineName="Machine not known" disabled onSelectMachine={vi.fn()} />,
    );
    expect(screen.getTextContent()).toContain('Machine not known');
    // Nothing to press: the row names the Machine and opens no picker.
    expect(screen.findAllByTestId('builder').some((node) => typeof node.props.onPress === 'function')).toBe(false);
    expect(screen.findAllByType(NewSessionMachineSelectionContent)).toHaveLength(0);
    await screen.unmount();
  });

  it("names the default's current Machine or the host's fixed Machine in a header chip", async () => {
    const onDefault = vi.fn();
    const screen = await renderScreen(
      <SessionMachineField presentation="chip" testID="runs-on" serverId="server-a" title="Runs on" machineId={null}
        defaultChoice={{ title: 'Automatic', value: 'Automatic · Studio', onChoose: onDefault }} onSelectMachine={vi.fn()} />,
    );
    expect(screen.getTextContent()).toContain('Automatic · Studio');
    await screen.update(
      <SessionMachineField presentation="chip" testID="runs-on" serverId="server-a" title="Machine" machineId="machine-1"
        machines={[machine('machine-1', 'Studio')]} />,
    );
    expect(screen.getTextContent()).toContain('Studio');
    expect(screen.findHostByTestId('runs-on')?.props.accessibilityState).toMatchObject({ disabled: true });
    await screen.unmount();
  });
});
