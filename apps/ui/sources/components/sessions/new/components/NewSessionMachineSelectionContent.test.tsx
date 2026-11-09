import * as React from 'react';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
    SelectionListAccessory,
    SelectionListOption,
    SelectionListProps,
    SelectionListSectionDescriptor,
} from '@/components/ui/selectionList';
import { createMachineFixture, renderScreen } from '@/dev/testkit';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import type { Machine } from '@/sync/domains/state/storageTypes';
import type { ServerScopedMachine } from '@/components/sessions/new/hooks/machines/useServerScopedMachineOptions';
import type { MachinePoolViewV1 } from '@happier-dev/protocol/machines/pools/v1';

import { installNewSessionComponentsCommonModuleMocks } from './newSessionComponentsTestHelpers';
import { buildMachineDestinationModel as buildScopedMachineDestinationModel } from './machineSelection/buildMachineDestinationModel';

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
        // The row's status line leads with the presence dot (K1), the accessory trails it.
        renderAccessory(props.option.subtitleLeading),
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

const network = await installSessionOpsNetworkBoundary();
afterAll(() => network.dispose());

function buildMachineDestinationModel(input: Parameters<typeof buildScopedMachineDestinationModel>[0]) {
    return buildScopedMachineDestinationModel({
        ...input,
        scopesByServerId: new Map(input.groups.map((group) => [group.serverId, {
            serverId: group.serverId, accountId: `account-${group.serverId.slice(-1)}`,
        }])),
    });
}

type MachineMetadataOverrides = Partial<NonNullable<Machine['metadata']>>;

function createMachine(
    overrides: Omit<Partial<Machine>, 'metadata'> & Readonly<{
        id: string;
        metadata?: MachineMetadataOverrides;
    }>,
): Machine {
    const { metadata, ...machineOverrides } = overrides;
    return createMachineFixture({
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
    });
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

/**
 * The list as the person sees it: the latest render. The shared list model also settles the
 * Account's managed-machine inventory (`useManagedMachineInventory`) after mount, so the content
 * legitimately renders more than once; how many times is not this surface's contract.
 */
function getLastSelectionList(): SelectionListProps {
    expect(capturedSelectionLists.length).toBeGreaterThan(0);
    return capturedSelectionLists.at(-1)!;
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
    const props = option.icon.props as Readonly<{ name?: unknown; machineId?: unknown }>;
    // A machine row draws its own machine's mark (`MachineRowMark`); other rows a named glyph.
    return typeof props.machineId === 'string' ? `machine:${props.machineId}` : props.name;
}

describe('NewSessionMachineSelectionContent', () => {
    beforeEach(async () => {
        capturedSelectionLists.length = 0;
        for (const suffix of ['a', 'b', 'c', 'd', 'e']) {
            await network.addHome(`https://server-${suffix}`, `account-${suffix}`);
        }
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

    it('leaves focus alone and draws page rows when the wizard lays the list out in its page', async () => {
        const { NewSessionMachineSelectionContent } = await import('./NewSessionMachineSelectionContent');
        const base = {
            groups: [],
            selectedMachine: null,
            selectedServerId: null,
            recentMachines: [],
            favoriteMachines: [],
            onSelectMachine: () => {},
            onSelectScopedMachine: () => {},
        } as const;

        await renderScreen(<NewSessionMachineSelectionContent {...base} maxHeight={317} />);
        expect(getLastSelectionList().autoFocusInputOnWeb).toBe(true);

        await renderScreen(<NewSessionMachineSelectionContent {...base} presentation="inline" />);
        const inline = getLastSelectionList();
        // Focusing the search field on open would scroll the wizard page down to the Machine section.
        expect(inline.autoFocusInputOnWeb).toBe(false);
        expect(inline.optionPresentation).toBeUndefined();
        expect(inline.maxHeight).toBeUndefined();
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
        // A recent machine keeps its machine mark; the section title already says it is recent.
        expect(readIconName(recentOption)).toBe('machine:m-recent');

        const favoriteOption = getOption(favoritesSection, 'm-fav');
        expect(readIconName(favoriteOption)).toBe('machine:m-fav');

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

    it('allows a current cached zero-online Pool to perform authoritative resolve after reconnect', async () => {
        const { NewSessionMachineSelectionContent } = await import('./NewSessionMachineSelectionContent');
        const machine = createMachine({ id: 'm-select', metadata: { displayName: 'Select', host: 'host', homeDir: '/Users/tester' } });
        const pool = {
            pool: {
                id: '3a948f0c-bc30-491c-b764-37f0e6744d1f',
                name: 'Development',
                description: null,
                revision: 1,
                createdAt: 1,
                updatedAt: 1,
                members: [{ machineId: machine.id, priorityTier: 0, enabled: true, state: 'offline' }],
            },
            availability: { state: 'known', connectedCount: 0, enabledCount: 1 },
        } satisfies MachinePoolViewV1;
        const onSelectPool = vi.fn();

        const screen = await renderScreen(<NewSessionMachineSelectionContent
            groups={[{
                serverId: 'server-a',
                serverName: 'Server A',
                loading: false,
                signedOut: false,
                machines: [createScopedMachine(machine, { serverId: 'server-a', serverName: 'Server A' })],
            }]}
            poolGroups={[{ serverId: 'server-a', accountId: 'account-a', serverName: 'Server A', pools: [pool] }]}
            selectedMachine={null}
            selectedServerId="server-a"
            recentMachines={[]}
            favoriteMachines={[]}
            onSelectMachine={() => {}}
            onSelectScopedMachine={() => {}}
            onSelectPool={onSelectPool}
            testIdPrefix="new-session-machine"
        />);

        const props = getLastSelectionList();
        expect(props.rootStep.sections.map((section) => section.id)).toEqual(['machine-pools', 'all']);
        const poolOption = getOption(getSection(props, 'machine-pools'), `pool:server-a:${pool.pool.id}`);
        expect(poolOption.label).toBe('Development');
        expect(poolOption.subtitle).toContain('Select');
        expect(poolOption.accessibilityLabel).toContain('Development');
        expect(poolOption.accessibilityLabel).toContain('Select');
        expect(poolOption.disabled).not.toBe(true);

        await screen.pressByTestIdAsync(`new-session-machine-pool-option:server-a:${pool.pool.id}`);
        expect(onSelectPool).toHaveBeenCalledWith({ serverId: 'server-a', accountId: 'account-a', pool });
    });

    it('keeps a retained Pool visible but inert while its Home projection is non-current', async () => {
        const { NewSessionMachineSelectionContent } = await import('./NewSessionMachineSelectionContent');
        const pool = {
            pool: {
                id: '3a948f0c-bc30-491c-b764-37f0e6744d1f',
                name: 'Development',
                description: null,
                revision: 1,
                createdAt: 1,
                updatedAt: 1,
                members: [],
            },
            availability: { state: 'unknown' as const },
        } satisfies MachinePoolViewV1;
        const onSelectPool = vi.fn();
        const screen = await renderScreen(<NewSessionMachineSelectionContent
            groups={[{ serverId: 'server-a', serverName: 'Server A', loading: false, signedOut: false, machines: [] }]}
            poolGroups={[{
                serverId: 'server-a',
                accountId: 'account-a',
                serverName: 'Server A',
                pools: [pool],
                status: 'error',
                projectionReady: false,
            }]}
            selectedMachine={null}
            selectedServerId="server-a"
            recentMachines={[]}
            favoriteMachines={[]}
            onSelectMachine={() => {}}
            onSelectScopedMachine={() => {}}
            onSelectPool={onSelectPool}
            testIdPrefix="new-session-machine"
        />);

        const option = getOption(getSection(getLastSelectionList(), 'machine-pools'), `pool:server-a:${pool.pool.id}`);
        expect(option.disabled).toBe(true);
        await screen.pressByTestIdAsync(`new-session-machine-pool-option:server-a:${pool.pool.id}`);
        expect(onSelectPool).not.toHaveBeenCalled();
    });

    it('leads with machines, not a Pool loading row, while a zero-cached Pool answer is pending', async () => {
        const { NewSessionMachineSelectionContent } = await import('./NewSessionMachineSelectionContent');
        const machine = createMachine({ id: 'm-only', metadata: { displayName: 'Only', host: 'host', homeDir: '/Users/tester' } });
        const scopedMachine = createScopedMachine(machine, { serverId: 'server-a', serverName: 'Server A' });
        const onSelectMachine = vi.fn();
        const onSelectScopedMachine = vi.fn();
        const onSelectPool = vi.fn();

        const screen = await renderScreen(<NewSessionMachineSelectionContent
            groups={[{
                serverId: 'server-a',
                serverName: 'Server A',
                loading: false,
                signedOut: false,
                machines: [scopedMachine],
            }]}
            poolGroups={[{
                serverId: 'server-a',
                accountId: 'account-a',
                serverName: 'Server A',
                pools: [],
                featureStatus: 'loading',
                status: 'loading',
                projectionReady: false,
            }]}
            selectedMachine={null}
            selectedServerId="server-a"
            recentMachines={[]}
            favoriteMachines={[]}
            onSelectMachine={onSelectMachine}
            onSelectScopedMachine={onSelectScopedMachine}
            onSelectPool={onSelectPool}
            testIdPrefix="new-session-machine"
        />);

        // A section whose existence is still unknown never heads the list (it would jump away a moment
        // later for the many Accounts without Pools); Pools appear once they are known, failures say so.
        const sections = capturedSelectionLists.at(-1)!.rootStep.sections.map((section) => section.id);
        expect(sections).not.toContain('machine-pools');
        expect(screen.findByTestId('new-session-machine-pool-status:server-a')).toBeNull();
        expect(onSelectPool).not.toHaveBeenCalled();

        const destinations = buildMachineDestinationModel({
            groups: [{
                serverId: 'server-a',
                loading: false,
                signedOut: false,
                machines: [scopedMachine],
            }],
            poolGroups: [{
                serverId: 'server-a',
                pools: [],
                featureStatus: 'loading',
                status: 'loading',
                projectionReady: false,
            }],
        });
        expect(destinations.destinationRowCount).toBe(1);
        expect(destinations.destinationSetSettled).toBe(false);
        expect(destinations.soleSelectableDestination).toBeNull();
    });

    it('hides the Machine pools section entirely on a settled feature-disabled Home', async () => {
        const { NewSessionMachineSelectionContent } = await import('./NewSessionMachineSelectionContent');
        const machine = createMachine({ id: 'm-only', metadata: { displayName: 'Only', host: 'host', homeDir: '/Users/tester' } });
        const scopedMachine = createScopedMachine(machine, { serverId: 'server-a', serverName: 'Server A' });
        const onSelectMachine = vi.fn();
        const onSelectPool = vi.fn();

        const screen = await renderScreen(<NewSessionMachineSelectionContent
            groups={[{
                serverId: 'server-a',
                serverName: 'Server A',
                loading: false,
                signedOut: false,
                machines: [scopedMachine],
            }]}
            poolGroups={[{
                serverId: 'server-a',
                accountId: 'account-a',
                serverName: 'Server A',
                pools: [],
                featureStatus: 'disabled',
                status: 'idle',
                projectionReady: true,
            }]}
            selectedMachine={null}
            selectedServerId="server-a"
            recentMachines={[]}
            favoriteMachines={[]}
            onSelectMachine={onSelectMachine}
            onSelectScopedMachine={() => {}}
            onSelectPool={onSelectPool}
            testIdPrefix="new-session-machine"
        />);

        // Settings renders nothing for a settled disabled Home, and so does the
        // destination picker: a Home without the feature advertises no dead
        // section telling the person to go update their server.
        const sections = capturedSelectionLists.at(-1)!.rootStep.sections.map((section) => section.id);
        expect(sections).not.toContain('machine-pools');
        expect(screen.findByTestId('new-session-machine-pool-status:server-a')).toBeNull();
        expect(onSelectMachine).not.toHaveBeenCalled();
        expect(onSelectPool).not.toHaveBeenCalled();

        const destinations = buildMachineDestinationModel({
            groups: [{
                serverId: 'server-a',
                loading: false,
                signedOut: false,
                machines: [scopedMachine],
            }],
            poolGroups: [{
                serverId: 'server-a',
                pools: [],
                featureStatus: 'disabled',
                status: 'idle',
                projectionReady: true,
            }],
            // A session's destination set also waits on the managed-machine answer (ee62fef68b);
            // a Home without managed creation settles it as unavailable.
            managedMachineProjection: { state: 'unavailable', rowCount: 0 },
        });
        expect(destinations.destinationRowCount).toBe(1);
        expect(destinations.destinationSetSettled).toBe(true);
        expect(destinations.soleSelectableDestination?.machine.id).toBe('m-only');
    });

    it('shows zero-cached Pool failure with exact-Home Retry without changing destination count', async () => {
        const { NewSessionMachineSelectionContent } = await import('./NewSessionMachineSelectionContent');
        const machine = createMachine({ id: 'm-only', metadata: { displayName: 'Only', host: 'host', homeDir: '/Users/tester' } });
        const scopedMachine = createScopedMachine(machine, { serverId: 'server-a', serverName: 'Server A' });
        const onSelectPool = vi.fn();
        const onRefreshPools = vi.fn();

        const screen = await renderScreen(<NewSessionMachineSelectionContent
            groups={[{
                serverId: 'server-a',
                serverName: 'Server A',
                loading: false,
                signedOut: false,
                machines: [scopedMachine],
            }]}
            poolGroups={[{
                serverId: 'server-a',
                accountId: 'account-a',
                serverName: 'Server A',
                pools: [],
                featureStatus: 'error',
                status: 'error',
                projectionReady: false,
            }]}
            selectedMachine={null}
            selectedServerId="server-a"
            recentMachines={[]}
            favoriteMachines={[]}
            onSelectMachine={() => {}}
            onSelectScopedMachine={() => {}}
            onSelectPool={onSelectPool}
            onRefreshPools={onRefreshPools}
            testIdPrefix="new-session-machine"
        />);

        const poolSection = getSection(capturedSelectionLists.at(-1)!, 'machine-pools');
        const status = getOption(poolSection, 'pool-status:server-a');
        expect(status.label).toBe('machinePools.refreshFailed');
        expect(status.disabled).toBe(true);
        await screen.pressByTestIdAsync('new-session-machine-pool-status:server-a');
        expect(onSelectPool).not.toHaveBeenCalled();
        await screen.pressByTestIdAsync('new-session-machine-pool-refresh:server-a');
        expect(onRefreshPools).toHaveBeenCalledWith('server-a');

        const destinations = buildMachineDestinationModel({
            groups: [{
                serverId: 'server-a',
                loading: false,
                signedOut: false,
                machines: [scopedMachine],
            }],
            poolGroups: [{
                serverId: 'server-a',
                pools: [],
                featureStatus: 'error',
                status: 'error',
                projectionReady: false,
            }],
        });
        expect(destinations.destinationRowCount).toBe(1);
        expect(destinations.destinationSetSettled).toBe(false);
        expect(destinations.soleSelectableDestination).toBeNull();
    });

    it('mounts failed-Home retry through the existing Machine refresh owner', async () => {
        const { NewSessionMachineSelectionContent } = await import('./NewSessionMachineSelectionContent');
        const pool = {
            pool: {
                id: '3a948f0c-bc30-491c-b764-37f0e6744d1f',
                name: 'Development',
                description: null,
                revision: 1,
                createdAt: 1,
                updatedAt: 1,
                members: [],
            },
            availability: { state: 'unknown' as const },
        } satisfies MachinePoolViewV1;
        const onRefreshMachines = vi.fn();
        const onRefreshPools = vi.fn();
        const screen = await renderScreen(<NewSessionMachineSelectionContent
            groups={[{
                serverId: 'server-a',
                serverName: 'Server A',
                loading: false,
                signedOut: false,
                error: true,
                machines: [],
            }]}
            poolGroups={[{
                serverId: 'server-a',
                accountId: 'account-a',
                serverName: 'Server A',
                pools: [pool],
                status: 'idle',
                projectionReady: true,
            }]}
            selectedMachine={null}
            selectedServerId="server-a"
            recentMachines={[]}
            favoriteMachines={[]}
            onSelectMachine={() => {}}
            onSelectScopedMachine={() => {}}
            onSelectPool={() => {}}
            onRefreshMachines={onRefreshMachines}
            onRefreshPools={onRefreshPools}
            testIdPrefix="new-session-machine"
        />);

        await screen.pressByTestIdAsync('new-session-machine-pool-refresh:server-a');

        expect(onRefreshMachines).toHaveBeenCalledOnce();
        expect(onRefreshPools).not.toHaveBeenCalled();
    });

    it('disambiguates duplicate Pool names in both visible and accessible labels', async () => {
        const { NewSessionMachineSelectionContent } = await import('./NewSessionMachineSelectionContent');
        const pool = (id: string) => ({
            pool: {
                id,
                name: 'Development',
                description: null,
                revision: 1,
                createdAt: 1,
                updatedAt: 1,
                members: [],
            },
            availability: { state: 'known' as const, connectedCount: 1, enabledCount: 1 },
        }) satisfies MachinePoolViewV1;
        const first = pool('3a948f0c-bc30-491c-b764-37f0e6744d1f');
        const second = pool('4b948f0c-bc30-491c-b764-37f0e6744d20');

        await renderScreen(<NewSessionMachineSelectionContent
            groups={[{ serverId: 'server-a', serverName: 'Server A', loading: false, signedOut: false, machines: [] }]}
            poolGroups={[{ serverId: 'server-a', accountId: 'account-a', serverName: 'Server A', pools: [first, second] }]}
            selectedMachine={null}
            selectedServerId="server-a"
            recentMachines={[]}
            favoriteMachines={[]}
            onSelectMachine={() => {}}
            onSelectScopedMachine={() => {}}
            onSelectPool={() => {}}
        />);

        const options = getSection(getLastSelectionList(), 'machine-pools').options;
        expect(options.map((option) => option.label)).toEqual(['Development', 'Development']);
        expect(options[0]?.subtitle).toContain(first.pool.id.slice(0, 8));
        expect(options[1]?.subtitle).toContain(second.pool.id.slice(0, 8));
        expect(options[0]?.accessibilityLabel).toContain(first.pool.id);
        expect(options[1]?.accessibilityLabel).toContain(second.pool.id);
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
