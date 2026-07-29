import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import type { MachineSelectorProps } from '@/components/sessions/new/components/MachineSelector';
import type { PathSelectionListProps } from '@/components/sessions/new/components/PathSelectionList';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { installVoicePickerCommonModuleMocks } from './voicePickerTestHelpers';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type RoundButtonProps = React.ComponentProps<typeof import('@/components/ui/buttons/RoundButton').RoundButton>;
type ChromeWithFooter = Readonly<{
    footer: React.ReactElement<React.PropsWithChildren>;
}>;

const pathSelectionListPropsRef: { current: PathSelectionListProps | null } = { current: null };
let machinesState: Machine[] = [];
let recentMachinePathsState: Array<{ machineId: string; path: string }> = [];

function createMachine(overrides: Partial<Machine> = {}): Machine {
    const { metadata: metadataOverride, ...machineOverrides } = overrides;
    const metadata: NonNullable<Machine['metadata']> = {
        host: 'machine',
        platform: 'darwin',
        happyCliVersion: '1.0.0',
        happyHomeDir: '/Users/test/.happier',
        homeDir: '/Users/test',
        ...(metadataOverride ?? {}),
    };
    return Object.assign({
        id: 'machine-1',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: Date.now(),
        metadata,
        metadataVersion: 1,
        daemonState: null,
        daemonStateVersion: 1,
    }, machineOverrides, { metadata });
}

function findCreateButton(chrome: ChromeWithFooter): React.ReactElement<RoundButtonProps> | undefined {
    return React.Children.toArray(chrome.footer.props.children)
        .find((child): child is React.ReactElement<RoundButtonProps> => {
            if (!React.isValidElement<RoundButtonProps>(child)) return false;
            return child.props.title === 'common.create';
        });
}

installVoicePickerCommonModuleMocks({
    storage: async (importOriginal) => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            importOriginal,
            useAllMachines: () => machinesState,
            useAllSessionListRenderables: () => [],
            useSetting: (key: string) => {
                if (key === 'recentMachinePaths') return recentMachinePathsState;
                if (key === 'useMachinePickerSearch') return false;
                if (key === 'usePathPickerSearch') return false;
                return null;
            },
            useSettingMutable: (key: string) => {
                if (key === 'favoriteMachines') return [[], vi.fn()];
                if (key === 'favoriteDirectories') return [[], vi.fn()];
                return [null, vi.fn()];
            },
        });
    },
});

vi.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}));

vi.mock('@/components/ui/text/Text', () => ({
  Text: 'Text',
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
  ItemList: ({ children }: React.PropsWithChildren) => React.createElement('ItemList', null, children),
}));

vi.mock('@/components/ui/buttons/RoundButton', () => ({
  RoundButton: (props: RoundButtonProps) => React.createElement('RoundButton', props),
}));

vi.mock('@/components/sessions/new/components/MachineSelector', () => ({
  MachineSelector: (props: MachineSelectorProps) => React.createElement('MachineSelector', props),
}));

vi.mock('@/components/sessions/new/components/PathSelectionList', () => ({
  PathSelectionList: (props: PathSelectionListProps) => {
    pathSelectionListPropsRef.current = props;
    return React.createElement('PathSelectionList', props);
  },
}));

vi.mock('@/utils/sessions/recentMachines', () => ({
  getRecentMachinesFromSessions: () => [],
}));

vi.mock('@/components/settings/pickers/resolvePreferredMachineId', () => ({
  resolvePreferredMachineId: () => 'machine-1',
}));

vi.mock('@/utils/sessions/machineUtils', () => ({
  isMachineOnline: () => true,
}));

describe('VoiceSessionSpawnPickerModal', () => {
  beforeEach(() => {
    pathSelectionListPropsRef.current = null;
    recentMachinePathsState = [];
    machinesState = [createMachine()];
  });

    it('passes machine browse config to PathSelectionList after choosing a machine', async () => {
        const { VoiceSessionSpawnPickerModal } = await import('./VoiceSessionSpawnPickerModal');

        const screen = await renderScreen(
            <VoiceSessionSpawnPickerModal
                onClose={() => {}}
                onResolve={() => {}}
            />,
        );

        const machineSelector = screen.findByType('MachineSelector');
        await act(async () => {
            machineSelector.props.onSelect(machinesState[0]);
        });

    expect(pathSelectionListPropsRef.current).toMatchObject({
      machineId: 'machine-1',
      serverId: null,
      machineHomeDir: '/Users/test',
    });
  });

    it('passes the selected machine platform to PathSelectionList after choosing a Windows machine', async () => {
        machinesState = [createMachine({
            id: 'machine-win',
            metadata: {
                host: 'win.local',
                platform: 'win32',
                happyCliVersion: '1.0.0',
                happyHomeDir: 'C:\\Users\\Ada\\.happier',
                homeDir: 'C:\\Users\\Ada',
            },
        })];
        const { VoiceSessionSpawnPickerModal } = await import('./VoiceSessionSpawnPickerModal');

        const screen = await renderScreen(
            <VoiceSessionSpawnPickerModal
                onClose={() => {}}
                onResolve={() => {}}
            />,
        );

        const machineSelector = screen.findByType('MachineSelector');
        await act(async () => {
            machineSelector.props.onSelect(machinesState[0]);
        });

        expect(pathSelectionListPropsRef.current).toMatchObject({
            machineId: 'machine-win',
            machineHomeDir: 'C:\\Users\\Ada',
            machinePlatform: 'windows',
        });
    });

    it('resets the path draft to the selected machine recent path when changing machines', async () => {
        machinesState = [
            createMachine({
                id: 'machine-1',
            }),
            createMachine({
                id: 'machine-2',
                metadata: {
                    host: 'linux.local',
                    platform: 'linux',
                    happyCliVersion: '1.0.0',
                    happyHomeDir: '/srv/test/.happier',
                    homeDir: '/srv/test',
                },
            }),
        ];
        recentMachinePathsState = [
            { machineId: 'machine-1', path: '/Users/test/old-repo' },
            { machineId: 'machine-2', path: '/srv/test/new-repo' },
        ];
        const { VoiceSessionSpawnPickerModal } = await import('./VoiceSessionSpawnPickerModal');

        const screen = await renderScreen(
            <VoiceSessionSpawnPickerModal
                onClose={() => {}}
                onResolve={() => {}}
            />,
        );

        const machineSelector = screen.findByType('MachineSelector');
        await act(async () => {
            machineSelector.props.onSelect(machinesState[0]);
        });
        await act(async () => {
            pathSelectionListPropsRef.current?.onCommit('/Users/test/old-repo');
        });

        const backButton = screen.findByType('Pressable');
        await act(async () => {
            backButton.props.onPress();
        });
        const nextMachineSelector = screen.findByType('MachineSelector');
        await act(async () => {
            nextMachineSelector.props.onSelect(machinesState[1]);
        });

        expect(pathSelectionListPropsRef.current).toMatchObject({
            machineId: 'machine-2',
            machineHomeDir: '/srv/test',
            initialValue: '/srv/test/new-repo',
        });
    });

    it('uses live PathSelectionList draft edits when creating from the footer', async () => {
        const onResolve = vi.fn();
        const onClose = vi.fn();
        const setChrome = vi.fn();
        const { VoiceSessionSpawnPickerModal } = await import('./VoiceSessionSpawnPickerModal');

        const screen = await renderScreen(
            <VoiceSessionSpawnPickerModal
                onClose={onClose}
                onResolve={onResolve}
                setChrome={setChrome}
            />,
        );

        const machineSelector = screen.findByType('MachineSelector');
        await act(async () => {
            machineSelector.props.onSelect(machinesState[0]);
        });

        const onChangeDraftPath = pathSelectionListPropsRef.current?.onChangeDraftPath;
        expect(typeof onChangeDraftPath).toBe('function');
        await act(async () => {
            onChangeDraftPath?.('/Users/test/typed-project');
        });

        const lastChrome = setChrome.mock.calls.at(-1)?.[0] as ChromeWithFooter;
        const createButton = findCreateButton(lastChrome);
        expect(createButton).toBeTruthy();

        await act(async () => {
            createButton?.props.onPress?.();
        });

        expect(onResolve).toHaveBeenCalledWith({
            machineId: 'machine-1',
            directory: '/Users/test/typed-project',
        });
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('uses the committed PathSelectionList value when creating the session', async () => {
        const onResolve = vi.fn();
        const onClose = vi.fn();
        const setChrome = vi.fn();
        const { VoiceSessionSpawnPickerModal } = await import('./VoiceSessionSpawnPickerModal');

        const screen = await renderScreen(
            <VoiceSessionSpawnPickerModal
                onClose={onClose}
                onResolve={onResolve}
                setChrome={setChrome}
            />,
        );

        const machineSelector = screen.findByType('MachineSelector');
        await act(async () => {
            machineSelector.props.onSelect(machinesState[0]);
        });

        const onCommit = pathSelectionListPropsRef.current?.onCommit;
        expect(typeof onCommit).toBe('function');
        await act(async () => {
            onCommit?.('/Users/test/project');
        });

        const lastChrome = setChrome.mock.calls.at(-1)?.[0] as ChromeWithFooter;
        const createButton = findCreateButton(lastChrome);
        expect(createButton).toBeTruthy();

        await act(async () => {
            createButton?.props.onPress?.();
        });

        expect(onResolve).toHaveBeenCalledWith({
            machineId: 'machine-1',
            directory: '/Users/test/project',
        });
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('allows a structurally ready machine without synthetic spawn readiness to reach the spawn operation', async () => {
        machinesState = [createMachine()];
        const setChrome = vi.fn();
        const onResolve = vi.fn();
        const { VoiceSessionSpawnPickerModal } = await import('./VoiceSessionSpawnPickerModal');

        const screen = await renderScreen(
            <VoiceSessionSpawnPickerModal
                onClose={() => {}}
                onResolve={onResolve}
                setChrome={setChrome}
            />,
        );

        const machineSelector = screen.findByType('MachineSelector');
        await act(async () => {
            machineSelector.props.onSelect(machinesState[0]);
        });

        const lastChrome = setChrome.mock.calls.at(-1)?.[0] as ChromeWithFooter;
        const createButton = findCreateButton(lastChrome);

        expect(createButton?.props.disabled).toBe(false);
        await act(async () => {
            createButton?.props.onPress?.();
        });
        expect(onResolve).toHaveBeenCalledWith({
            machineId: 'machine-1',
            directory: '/Users/test',
        });
    });
});
