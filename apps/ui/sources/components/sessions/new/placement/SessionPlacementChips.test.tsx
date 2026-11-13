import { describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { act } from 'react-test-renderer';

import { createMachineFixture, renderScreen } from '@/dev/testkit';
import type { Machine } from '@/sync/domains/state/storageTypes';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native-reanimated', async () =>
  (await import('@/dev/testkit/mocks/reanimated')).createReanimatedModuleMock(),
);
// The two popover bodies are New Session's own picker screens, exercised by their own suites; here they
// stand at the module boundary so this suite proves which body each chip opens and what it reports.
vi.mock(
  '@/components/sessions/new/components/NewSessionPathSelectionContent',
  () => ({
    NewSessionPathSelectionContent: () => null,
  }),
);
vi.mock(
  '@/components/sessions/new/components/NewSessionMachineSelectionContent',
  () => ({
    NewSessionMachineSelectionContent: () => null,
  }),
);

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
  it("opens New Session's Machine and folder pickers from two chips and reports each choice (owner 2026-11-12)", async () => {
    const { SessionPlacementChips } = await import('./SessionPlacementChips');
    const { NewSessionMachineSelectionContent } =
      await import('@/components/sessions/new/components/NewSessionMachineSelectionContent');
    const { NewSessionPathSelectionContent } =
      await import('@/components/sessions/new/components/NewSessionPathSelectionContent');
    const current = machine('machine-1', 'Machine 1');
    const other = machine('machine-2', 'Machine 2');
    const onSelectMachine = vi.fn();
    const onSelectPath = vi.fn();
    const screen = await renderScreen(
      <SessionPlacementChips
        serverId="server-a"
        machine={current}
        path="/Users/test/project"
        onSelectMachine={onSelectMachine}
        onSelectPath={onSelectPath}
      />,
    );
    // Closed, neither picker body mounts (no Machine inventory or folder reads).
    expect(
      screen.findAllByType(NewSessionMachineSelectionContent),
    ).toHaveLength(0);
    expect(screen.findAllByType(NewSessionPathSelectionContent)).toHaveLength(
      0,
    );

    await screen.pressByTestIdAsync('agent-input-machine-chip');

    // Only New Session offers a managed one-off Machine; a host without one never lists it (live 2026-11-13).

    expect(screen.findByType(NewSessionMachineSelectionContent).props.onSelectManagedMachine).toBeUndefined();
    await act(async () => {
      screen
        .findByType(NewSessionMachineSelectionContent)
        .props.onSelectMachine(other);
    });
    expect(onSelectMachine).toHaveBeenCalledWith(other, 'server-a');
    expect(
      screen.findAllByType(NewSessionMachineSelectionContent),
    ).toHaveLength(0);

    await screen.pressByTestIdAsync('agent-input-path-chip');
    const folder = screen.findByType(NewSessionPathSelectionContent);
    expect(folder.props).toMatchObject({
      selectedPath: '/Users/test/project',
      machineHomeDir: '/Users/test',
      machineBrowse: {
        enabled: true,
        machineId: 'machine-1',
        serverId: 'server-a',
      },
    });
    await act(async () => {
      folder.props.onSubmitSelectedPath('/Users/test/other');
    });
    expect(onSelectPath).toHaveBeenCalledWith('/Users/test/other');
    expect(screen.findAllByType(NewSessionPathSelectionContent)).toHaveLength(
      0,
    );
    await screen.unmount();
  });

  it('keeps a fixed Machine visible but not choosable when the host offers no Machine move', async () => {
    const { SessionPlacementChips } = await import('./SessionPlacementChips');
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
    expect(
      screen.findByTestId('agent-input-machine-chip')?.props.disabled,
    ).toBe(true);
    // Nothing to press: the chip names the host's Machine and opens no picker.
    expect(
      screen.findByTestId('agent-input-machine-chip')?.props.onPress,
    ).toBeUndefined();
    expect(
      screen.findAllByType(NewSessionMachineSelectionContent),
    ).toHaveLength(0);
    await screen.unmount();
  });
});
