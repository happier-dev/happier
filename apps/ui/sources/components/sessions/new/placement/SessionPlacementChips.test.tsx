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

  it('keeps the folder chip in place, disabled, until a Machine is chosen (ruling 3)', async () => {
    const { SessionPlacementChips } = await import('./SessionPlacementChips');
    const screen = await renderScreen(
      <SessionPlacementChips serverId="server-a" machine={null} path="" onSelectMachine={vi.fn()} onSelectPath={vi.fn()} />,
    );
    const folder = screen.findAllByTestId('agent-input-path-chip').find((node) => typeof node.props.accessibilityLabel === 'string');
    expect(folder?.props.accessibilityLabel).toBe((await import('@/text')).t('newSession.folder.chooseMachineFirst'));
    expect(folder?.props.disabled).toBe(true);
    await screen.unmount();
  });

  it('takes its host row\'s bordered chip look and opens the same pickers (ruling 1)', async () => {
    const { SessionPlacementChips } = await import('./SessionPlacementChips');
    const { SelectionListFilterChip } = await import('@/components/ui/selectionList');
    const onSelectMachine = vi.fn();
    const screen = await renderScreen(
      <SessionPlacementChips chipVariant="bordered" serverId="server-a" machine={machine('machine-1', 'Machine 1')}
        path="/Users/test/project" onSelectMachine={onSelectMachine} onSelectPath={vi.fn()} />,
    );
    const chips = screen.findAllByType(SelectionListFilterChip);
    expect(chips.map((chip) => chip.props.filter.valueLabel)).toEqual(['Machine 1', '~/project']);
    const content = chips[0]!.props.filter.renderPopoverContent({ close: vi.fn(), maxHeight: 400 });
    expect(content).not.toBeNull();
    await screen.unmount();
  });

  it("asks for a Machine alone in a form with New Session's Machine picker: host Machines, an away one choosable, the host's default first", async () => {
    const { SessionMachineField } = await import('./SessionPlacementChips');
    const { NewSessionMachineSelectionContent } = await import('@/components/sessions/new/components/NewSessionMachineSelectionContent');
    const { NewSessionPathSelectionContent } = await import('@/components/sessions/new/components/NewSessionPathSelectionContent');
    const studio = machine('machine-1', 'Studio');
    const away = createMachineFixture({ ...machine('machine-2', 'Away box'), active: false, activeAt: 1 }) as Machine;
    const onChoose = vi.fn();
    const onDefault = vi.fn();
    const screen = await renderScreen(
      <SessionMachineField testID="controller" serverId="server-a" title="Runs on" machines={[studio, away]}
        machineId={null} awayMachinesChoosable defaultChoice={{ title: 'Your usual Machine', onChoose: onDefault }}
        onSelectMachine={onChoose} />,
    );
    // One field, no folder; the value says the default while it holds.
    expect(screen.findAllByTestId('agent-input-path-chip')).toHaveLength(0);
    expect(screen.getTextContent()).toContain('Runs on');
    expect(screen.getTextContent()).toContain('Your usual Machine');
    expect(screen.findAllByType(NewSessionMachineSelectionContent)).toHaveLength(0);

    await screen.pressByTestIdAsync('controller');
    const content = screen.findByType(NewSessionMachineSelectionContent);
    expect(content.props.groups[0].machines.map((row: Machine) => row.id)).toEqual(['machine-1', 'machine-2']);
    expect(content.props.disableOfflineMachines).toBe(false);
    expect(content.props.resolveMachineAvailability(away, 'server-a').selectable).toBe(true);
    expect(content.props.defaultOption).toMatchObject({ title: 'Your usual Machine', selected: true });
    expect(screen.findAllByType(NewSessionPathSelectionContent)).toHaveLength(0);

    await act(async () => { content.props.onSelectMachine(away); });
    expect(onChoose).toHaveBeenCalledWith(away);
    expect(screen.findAllByType(NewSessionMachineSelectionContent)).toHaveLength(0);

    await screen.pressByTestIdAsync('controller');
    await act(async () => { screen.findByType(NewSessionMachineSelectionContent).props.defaultOption.onSelect(); });
    expect(onDefault).toHaveBeenCalledTimes(1);
    await screen.unmount();
  });

  it('tells a chosen Machine apart from a same-named peer, as the Machine list does', async () => {
    const { SessionMachineField } = await import('./SessionPlacementChips');
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
    const { SessionMachineField } = await import('./SessionPlacementChips');
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

  it("asks for a Machine as a header chip with the same picker, saying the default's current Machine, and only names a Machine it cannot change", async () => {
    const { SessionMachineField } = await import('./SessionPlacementChips');
    const { SelectionListFilterChip } = await import('@/components/ui/selectionList');
    const onDefault = vi.fn();
    const screen = await renderScreen(
      <SessionMachineField presentation="chip" testID="runs-on" serverId="server-a" title="Runs on" machineId={null}
        defaultChoice={{ title: 'Automatic', value: 'Automatic · Studio', onChoose: onDefault }} onSelectMachine={vi.fn()} />,
    );
    const chip = screen.findByType(SelectionListFilterChip);
    expect(chip.props.filter).toMatchObject({ label: 'Runs on', valueLabel: 'Automatic · Studio' });
    expect(chip.props.filter.disabled).toBeFalsy();
    expect(chip.props.filter.renderPopoverContent({ close: vi.fn(), maxHeight: 400 })).not.toBeNull();
    await screen.update(
      <SessionMachineField presentation="chip" testID="runs-on" serverId="server-a" title="Machine" machineId="machine-1"
        machines={[machine('machine-1', 'Studio')]} />,
    );
    expect(screen.findByType(SelectionListFilterChip).props.filter).toMatchObject({ valueLabel: 'Studio', disabled: true });
    await screen.unmount();
  });

  it('renders as one form row of Machine and folder fields, as Agent and model does (ruling 2)', async () => {
    const { SessionPlacementChips } = await import('./SessionPlacementChips');
    const { NewSessionMachineSelectionContent } = await import('@/components/sessions/new/components/NewSessionMachineSelectionContent');
    const screen = await renderScreen(
      <SessionPlacementChips presentation="fields" title="Where it runs" rowTestID="where-row" serverId="server-a"
        machine={null} path="" onSelectMachine={vi.fn()} onSelectPath={vi.fn()} />,
    );
    expect(screen.findByTestId('where-row')).not.toBeNull();
    expect(screen.getTextContent()).toContain('Where it runs');
    expect(screen.getTextContent()).toContain((await import('@/text')).t('newSession.folder.chooseMachineFirst'));
    await screen.pressByTestIdAsync('agent-input-machine-chip');
    expect(screen.findAllByType(NewSessionMachineSelectionContent)).toHaveLength(1);
    await screen.unmount();
  });
});
