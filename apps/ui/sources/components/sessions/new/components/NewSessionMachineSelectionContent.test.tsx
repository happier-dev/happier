import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
    SelectionListAccessory,
    SelectionListOption,
    SelectionListProps,
    SelectionListSectionDescriptor,
} from '@/components/ui/selectionList';
import { renderScreen } from '@/dev/testkit';
import type { Machine } from '@/sync/domains/state/storageTypes';
import type { ServerScopedMachine } from '@/components/sessions/new/hooks/machines/useServerScopedMachineOptions';

import { installNewSessionComponentsCommonModuleMocks } from './newSessionComponentsTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const capturedSelectionLists = vi.hoisted(() => [] as SelectionListProps[]);

function renderAccessory(accessory: SelectionListAccessory | undefined): React.ReactNode {
    if (typeof accessory === 'function') return accessory();
    return accessory;
}

vi.mock('@/components/ui/selectionList', () => ({
    SelectionList: (props: SelectionListProps) => {
        capturedSelectionLists.push(props);
        return React.createElement(
            'SelectionList',
            { testID: props.testID, maxHeight: props.maxHeight },
            props.rootStep.sections.flatMap((section) =>
                section.kind === 'static'
                    ? section.options.map((option) => (
                        <SelectionListOptionAlias
                            key={`${section.id}:${option.id}`}
                            option={option}
                            selected={props.selectedOptionId === option.id}
                            onSelect={(selectedOption) => {
                                selectedOption.onSelect?.();
                                props.onSelect(selectedOption.id, selectedOption);
                            }}
                        />
                    ))
                    : [],
            ),
        );
    },
    resolvePopoverSelectionListHeightBehavior: () => 'measuredToMaxHeight',
}));

function SelectionListOptionAlias(props: Readonly<{
    option: SelectionListOption;
    selected: boolean;
    onSelect: (option: SelectionListOption) => void;
}>): React.ReactElement | null {
    if (!props.option.testID) return null;
    return React.createElement(
        'SelectionListOptionAlias',
        {
            testID: props.option.testID,
            accessibilityState: {
                disabled: props.option.disabled === true,
                selected: props.selected,
            },
            onPress: () => {
                if (props.option.disabled === true) return;
                props.onSelect(props.option);
            },
        },
        renderAccessory(props.option.rightAccessory),
    );
}

installNewSessionComponentsCommonModuleMocks({
    icons: () => ({
        Ionicons: (props: Record<string, unknown>) => React.createElement('Ionicons', props),
    }),
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
});

vi.mock('@/components/sessions/new/components/MachineCliGlyphs', () => ({
    MachineCliGlyphs: ({ machineId }: { machineId: string }) =>
        React.createElement('MachineCliGlyphs', { testID: `machine-cli-glyphs:${machineId}` }),
}));

type MachineMetadataOverrides = Partial<NonNullable<Machine['metadata']>>;

function createMachine(
    overrides: Omit<Partial<Machine>, 'metadata'> & Readonly<{
        id: string;
        metadata?: MachineMetadataOverrides;
    }>,
): Machine {
    const { metadata, ...machineOverrides } = overrides;
    return {
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: Date.now(),
        metadata: {
            host: `${overrides.id}.local`,
            platform: 'darwin',
            happyCliVersion: '1.0.0',
            happyHomeDir: '/Users/tester/.happy',
            displayName: overrides.id,
            homeDir: '/Users/tester',
            ...(metadata ?? {}),
        },
        metadataVersion: 1,
        daemonState: null,
        daemonStateVersion: 1,
        ...machineOverrides,
    };
}

function createScopedMachine(
    machine: Machine,
    scope: Readonly<{ serverId: string; serverName: string }>,
): ServerScopedMachine {
    return {
        ...machine,
        serverId: scope.serverId,
        serverName: scope.serverName,
    };
}

function getLastSelectionList(): SelectionListProps {
    expect(capturedSelectionLists).toHaveLength(1);
    return capturedSelectionLists[0]!;
}

function getSection(
    props: SelectionListProps,
    id: string,
): SelectionListSectionDescriptor & Readonly<{ kind: 'static' }> {
    const section = props.rootStep.sections.find((candidate) => candidate.id === id);
    expect(section).toBeTruthy();
    expect(section?.kind).toBe('static');
    return section as SelectionListSectionDescriptor & Readonly<{ kind: 'static' }>;
}

function optionIds(section: SelectionListSectionDescriptor & Readonly<{ kind: 'static' }>): string[] {
    return section.options.map((option) => option.id);
}

function getOption(
    section: SelectionListSectionDescriptor & Readonly<{ kind: 'static' }>,
    id: string,
): SelectionListOption {
    const option = section.options.find((candidate) => candidate.id === id);
    expect(option).toBeTruthy();
    return option!;
}

function readIconName(option: SelectionListOption): unknown {
    if (!React.isValidElement(option.icon)) return undefined;
    return (option.icon.props as Readonly<{ name?: unknown }>).name;
}

describe('NewSessionMachineSelectionContent', () => {
    beforeEach(() => {
        capturedSelectionLists.length = 0;
    });

    it('renders empty machine content through SelectionList with a measured native popover height cap', async () => {
        const { NewSessionMachineSelectionContent } = await import('./NewSessionMachineSelectionContent');

        await renderScreen(<NewSessionMachineSelectionContent
            groups={[]}
            selectedMachine={null}
            selectedServerId={null}
            recentMachines={[]}
            favoriteMachines={[]}
            onSelectMachine={() => {}}
            onSelectScopedMachine={() => {}}
            showSearch={false}
            maxHeight={317}
        />);

        const props = getLastSelectionList();
        expect(props.maxHeight).toBe(317);
        expect(props.heightBehavior).toBe('measuredToMaxHeight');
        expect(props.rootStep.emptyStateLabel).toBe('newSession.noMachinesFound');
        expect(props.rootStep.inputPlaceholder).toBeUndefined();
        expect(props.rootStep.sections).toEqual([]);
    });

    it('builds a single-server SelectionList with recent, favorites, and all machines deduped in launch order', async () => {
        const { NewSessionMachineSelectionContent } = await import('./NewSessionMachineSelectionContent');
        const favorite = createMachine({ id: 'm-fav', metadata: { displayName: 'Favorite', host: 'fav-host', homeDir: '/Users/tester' } });
        const recent = createMachine({ id: 'm-recent', metadata: { displayName: 'Recent', host: 'recent-host', homeDir: '/Users/tester' } });
        const other = createMachine({ id: 'm-other', metadata: { displayName: 'Other', host: 'other-host', homeDir: '/Users/tester' } });
        const offline = createMachine({
            id: 'm-offline',
            active: false,
            activeAt: 0,
            metadata: { displayName: 'Offline', host: 'offline-host', homeDir: '/Users/tester' },
        });

        await renderScreen(<NewSessionMachineSelectionContent
            groups={[{
                serverId: 'server-a',
                serverName: 'Server A',
                loading: false,
                signedOut: false,
                machines: [favorite, recent, other, offline].map((machine) =>
                    createScopedMachine(machine, { serverId: 'server-a', serverName: 'Server A' }),
                ),
            }]}
            selectedMachine={recent}
            selectedServerId="server-a"
            recentMachines={[recent, favorite, offline]}
            favoriteMachines={[favorite]}
            onSelectMachine={() => {}}
            onSelectScopedMachine={() => {}}
            serverId="server-a"
            onToggleFavorite={() => {}}
            testIdPrefix="new-session-machine"
            showCliGlyphs
            autoDetectCliGlyphs={false}
        />);

        const props = getLastSelectionList();
        expect(props.testID).toBe('new-session-machine-list');
        expect(props.rootStep.inputPlaceholder).toBe('newSession.machinePicker.searchPlaceholder');
        expect(props.selectedOptionId).toBe('m-recent');
        expect(props.rootStep.sections.map((section) => section.id)).toEqual(['recent', 'favorites', 'all']);

        const recentSection = getSection(props, 'recent');
        const favoritesSection = getSection(props, 'favorites');
        const allSection = getSection(props, 'all');

        expect(optionIds(recentSection)).toEqual(['m-recent']);
        expect(optionIds(favoritesSection)).toEqual(['m-fav']);
        expect(optionIds(allSection)).toEqual(['m-other', 'm-offline']);

        const recentOption = getOption(recentSection, 'm-recent');
        expect(recentOption.testID).toBe('new-session-machine-option:m-recent');
        expect(readIconName(recentOption)).toBe('clock');

        const favoriteOption = getOption(favoritesSection, 'm-fav');
        expect(readIconName(favoriteOption)).toBe('desktop');

        const offlineOption = getOption(allSection, 'm-offline');
        expect(offlineOption.disabled).toBe(true);
        expect(offlineOption.testID).toBe('new-session-machine-option:m-offline');
    });

    it('renders machine readiness and CLI glyph accessories under legacy testID contracts', async () => {
        const { NewSessionMachineSelectionContent } = await import('./NewSessionMachineSelectionContent');
        const machine = createMachine({ id: 'm-online', metadata: { displayName: 'Online', host: 'host', homeDir: '/Users/tester' } });

        const screen = await renderScreen(<NewSessionMachineSelectionContent
            groups={[{
                serverId: 'server-a',
                serverName: 'Server A',
                loading: false,
                signedOut: false,
                machines: [createScopedMachine(machine, { serverId: 'server-a', serverName: 'Server A' })],
            }]}
            selectedMachine={machine}
            selectedServerId="server-a"
            recentMachines={[]}
            favoriteMachines={[]}
            onSelectMachine={() => {}}
            onSelectScopedMachine={() => {}}
            serverId="server-a"
            testIdPrefix="new-session-machine"
            showCliGlyphs
            autoDetectCliGlyphs={false}
        />);

        const readiness = screen.findByTestId('new-session-machine-readiness:m-online');
        expect(readiness?.props['data-state']).toBe('ready');
        expect(readiness?.props.dataSet).toEqual({ state: 'ready' });
        expect(screen.findByTestId('machine-cli-glyphs:m-online')).not.toBeNull();
    });

    it('routes single-server option activation through the plain machine callback', async () => {
        const { NewSessionMachineSelectionContent } = await import('./NewSessionMachineSelectionContent');
        const machine = createMachine({ id: 'm-select', metadata: { displayName: 'Select', host: 'host', homeDir: '/Users/tester' } });
        const onSelectMachine = vi.fn();
        const onSelectScopedMachine = vi.fn();

        const screen = await renderScreen(<NewSessionMachineSelectionContent
            groups={[{
                serverId: 'server-a',
                serverName: 'Server A',
                loading: false,
                signedOut: false,
                machines: [createScopedMachine(machine, { serverId: 'server-a', serverName: 'Server A' })],
            }]}
            selectedMachine={null}
            selectedServerId="server-a"
            recentMachines={[]}
            favoriteMachines={[]}
            onSelectMachine={onSelectMachine}
            onSelectScopedMachine={onSelectScopedMachine}
            testIdPrefix="new-session-machine"
        />);

        await screen.pressByTestIdAsync('new-session-machine-option:m-select');

        expect(onSelectMachine).toHaveBeenCalledWith(expect.objectContaining({ id: 'm-select' }));
        expect(onSelectScopedMachine).not.toHaveBeenCalled();
    });

    it('builds scoped sections with loading, signed-out, empty, disabled, and selected rows for multi-server selection', async () => {
        const { NewSessionMachineSelectionContent } = await import('./NewSessionMachineSelectionContent');
        const selected = createScopedMachine(
            createMachine({ id: 'm-selected', metadata: { displayName: 'Selected', host: 'selected-host', homeDir: '/Users/tester' } }),
            { serverId: 'server-c', serverName: 'Server C' },
        );
        const offline = createScopedMachine(
            createMachine({
                id: 'm-offline',
                active: false,
                activeAt: 0,
                metadata: { displayName: 'Offline', host: 'offline-host', homeDir: '/Users/tester' },
            }),
            { serverId: 'server-d', serverName: 'Server D' },
        );

        const screen = await renderScreen(<NewSessionMachineSelectionContent
            groups={[
                { serverId: 'server-a', serverName: 'Server A', loading: true, signedOut: false, machines: [] },
                { serverId: 'server-b', serverName: 'Server B', loading: false, signedOut: true, machines: [] },
                { serverId: 'server-c', serverName: 'Server C', loading: false, signedOut: false, machines: [selected] },
                { serverId: 'server-d', serverName: 'Server D', loading: false, signedOut: false, machines: [offline] },
                { serverId: 'server-e', serverName: 'Server E', loading: false, signedOut: false, machines: [] },
            ]}
            selectedMachine={selected}
            selectedServerId="server-c"
            recentMachines={[]}
            favoriteMachines={[]}
            onSelectMachine={() => {}}
            onSelectScopedMachine={() => {}}
            testIdPrefix="new-session-machine"
            showSearch={false}
        />);

        const props = getLastSelectionList();
        expect(props.rootStep.inputPlaceholder).toBeUndefined();
        expect(props.selectedOptionId).toBe('server-c::m-selected');
        expect(props.rootStep.sections.map((section) => [
            section.id,
            section.title,
            section.kind === 'static' ? section.count : undefined,
        ])).toEqual([
            ['server:server-a', 'Server A', 0],
            ['server:server-b', 'Server B', 0],
            ['server:server-c', 'Server C', 1],
            ['server:server-d', 'Server D', 1],
            ['server:server-e', 'Server E', 0],
        ]);

        expect(optionIds(getSection(props, 'server:server-a'))).toEqual(['server:server-a:loading']);
        expect(optionIds(getSection(props, 'server:server-b'))).toEqual(['server:server-b:signed-out']);
        expect(optionIds(getSection(props, 'server:server-e'))).toEqual(['server:server-e:empty']);
        expect(getOption(getSection(props, 'server:server-a'), 'server:server-a:loading').label).toBe('common.loading');
        expect(getOption(getSection(props, 'server:server-b'), 'server:server-b:signed-out').label).toBe('server.signedOut');
        expect(getOption(getSection(props, 'server:server-e'), 'server:server-e:empty').label).toBe('newSession.noMachinesFound');

        const selectedAlias = screen.findByTestId('new-session-machine-option:m-selected');
        expect(selectedAlias?.props.accessibilityState).toEqual({ disabled: false, selected: true });
        const offlineAlias = screen.findByTestId('new-session-machine-option:m-offline');
        expect(offlineAlias?.props.accessibilityState).toEqual({ disabled: true, selected: false });
    });

    it('routes multi-server option activation through the scoped machine callback', async () => {
        const { NewSessionMachineSelectionContent } = await import('./NewSessionMachineSelectionContent');
        const machine = createScopedMachine(
            createMachine({ id: 'm-scoped', metadata: { displayName: 'Scoped', host: 'host', homeDir: '/Users/tester' } }),
            { serverId: 'server-b', serverName: 'Server B' },
        );
        const onSelectMachine = vi.fn();
        const onSelectScopedMachine = vi.fn();

        const screen = await renderScreen(<NewSessionMachineSelectionContent
            groups={[
                { serverId: 'server-a', serverName: 'Server A', loading: false, signedOut: false, machines: [] },
                { serverId: 'server-b', serverName: 'Server B', loading: false, signedOut: false, machines: [machine] },
            ]}
            selectedMachine={null}
            selectedServerId="server-b"
            recentMachines={[]}
            favoriteMachines={[]}
            onSelectMachine={onSelectMachine}
            onSelectScopedMachine={onSelectScopedMachine}
            testIdPrefix="new-session-machine"
        />);

        await screen.pressByTestIdAsync('new-session-machine-option:m-scoped');

        expect(onSelectMachine).not.toHaveBeenCalled();
        expect(onSelectScopedMachine).toHaveBeenCalledWith(machine);
    });
});
