import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installVoicePickerCommonModuleMocks } from './voicePickerTestHelpers';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const pathSelectorPropsRef: { current: Record<string, unknown> | null } = { current: null };
let machinesState: any[] = [];
let recentMachinePathsState: Array<{ machineId: string; path: string }> = [];
let favoriteDirectoriesState: string[] = [];
let setFavoriteDirectoriesSpy = vi.fn();

installVoicePickerCommonModuleMocks({
    storage: async (importOriginal) => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            importOriginal,
            useAllMachines: () => machinesState,
            useSessions: () => [],
            useSetting: (key: string) => {
                if (key === 'recentMachinePaths') return recentMachinePathsState;
                if (key === 'useMachinePickerSearch') return false;
                if (key === 'usePathPickerSearch') return false;
                return null;
            },
            useSettingMutable: (key: string) => {
                if (key === 'favoriteMachines') return [[], vi.fn()];
                if (key === 'favoriteDirectories') return [favoriteDirectoriesState, setFavoriteDirectoriesSpy];
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
  RoundButton: (props: any) => React.createElement('RoundButton', props),
}));

vi.mock('@/components/sessions/new/components/MachineSelector', () => ({
  MachineSelector: (props: any) => React.createElement('MachineSelector', props),
}));

vi.mock('@/components/sessions/new/components/PathSelectionList', () => ({
  PathSelectionList: (props: Record<string, unknown>) => {
    pathSelectorPropsRef.current = props;
    return React.createElement('PathSelectionList', props);
  },
}));

vi.mock('@/utils/sessions/recentMachines', () => ({
  getRecentMachinesFromSessions: () => [],
}));

vi.mock('@/components/settings/pickers/resolvePreferredMachineId', () => ({
  resolvePreferredMachineId: () => 'machine-1',
}));

describe('VoiceSessionSpawnPickerModal', () => {
  beforeEach(() => {
    pathSelectorPropsRef.current = null;
    recentMachinePathsState = [];
    favoriteDirectoriesState = [];
    setFavoriteDirectoriesSpy = vi.fn();
    machinesState = [{
      id: 'machine-1',
      active: true,
      activeAt: Date.now(),
      metadata: { homeDir: '/Users/test' },
    }];
  });

    it('passes the machine id and home dir to PathSelectionList after choosing a machine', async () => {
        const { VoiceSessionSpawnPickerModal } = await import('./VoiceSessionSpawnPickerModal');

        const screen = await renderScreen(
            <VoiceSessionSpawnPickerModal
                onClose={() => {}}
                onResolve={() => {}}
            />,
        );

        const machineSelector = screen.findByType('MachineSelector' as any);
        await act(async () => {
            machineSelector.props.onSelect({ id: 'machine-1', metadata: { homeDir: '/Users/test' } });
        });

    expect(pathSelectorPropsRef.current).toMatchObject({
      machineId: 'machine-1',
      machineHomeDir: '/Users/test',
    });
  });

    it('resets the path draft to the selected machine recent path when changing machines', async () => {
        machinesState = [
            {
                id: 'machine-1',
                active: true,
                activeAt: Date.now(),
                metadata: { homeDir: '/Users/test' },
            },
            {
                id: 'machine-2',
                active: true,
                activeAt: Date.now(),
                metadata: { homeDir: '/srv/test' },
            },
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

        const machineSelector = screen.findByType('MachineSelector' as any);
        await act(async () => {
            machineSelector.props.onSelect(machinesState[0]);
        });
        await act(async () => {
            (pathSelectorPropsRef.current?.onCommit as (path: string) => void)('/Users/test/old-repo');
        });
        const backButton = screen.findByType('Pressable' as any);
        await act(async () => {
            backButton.props.onPress();
        });
        const nextMachineSelector = screen.findByType('MachineSelector' as any);
        await act(async () => {
            nextMachineSelector.props.onSelect(machinesState[1]);
        });

        expect(pathSelectorPropsRef.current).toMatchObject({
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

        const machineSelector = screen.findByType('MachineSelector' as any);
        await act(async () => {
            machineSelector.props.onSelect(machinesState[0]);
        });

        const onChangeDraftPath = pathSelectorPropsRef.current?.onChangeDraftPath;
        expect(typeof onChangeDraftPath).toBe('function');
        await act(async () => {
            (onChangeDraftPath as (path: string) => void)('/Users/test/typed-project');
        });

        const lastChrome = setChrome.mock.calls.at(-1)?.[0] as any;
        const createButton = React.Children.toArray(lastChrome.footer.props.children)
            .find((child: any) => child?.props?.title === 'common.create') as React.ReactElement<{ onPress?: () => void }> | undefined;
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

    it('forwards home-aware favorite toggles to PathSelectionList after choosing a machine', async () => {
        favoriteDirectoriesState = ['~/repo'];
        const { VoiceSessionSpawnPickerModal } = await import('./VoiceSessionSpawnPickerModal');

        const screen = await renderScreen(
            <VoiceSessionSpawnPickerModal
                onClose={() => {}}
                onResolve={() => {}}
            />,
        );

        const machineSelector = screen.findByType('MachineSelector' as any);
        await act(async () => {
            machineSelector.props.onSelect({ id: 'machine-1', metadata: { homeDir: '/Users/test' } });
        });

        const isFavorite = pathSelectorPropsRef.current?.isFavorite;
        const onToggleFavorite = pathSelectorPropsRef.current?.onToggleFavorite;
        expect(typeof isFavorite).toBe('function');
        expect(typeof onToggleFavorite).toBe('function');
        expect((isFavorite as (path: string) => boolean)('/Users/test/repo')).toBe(true);

        (onToggleFavorite as (path: string) => void)('/Users/test/repo');

        expect(setFavoriteDirectoriesSpy).toHaveBeenCalledWith([]);
    });

    it('allows create when the selected storage machine is online but exact spawn readiness is unknown', async () => {
        machinesState = [{
            id: 'machine-1',
            active: true,
            activeAt: Date.now(),
            metadata: { homeDir: '/Users/test' },
        }];
        const setChrome = vi.fn();
        const onResolve = vi.fn();
        const onClose = vi.fn();
        const { VoiceSessionSpawnPickerModal } = await import('./VoiceSessionSpawnPickerModal');

        const screen = await renderScreen(
            <VoiceSessionSpawnPickerModal
                onClose={onClose}
                onResolve={onResolve}
                setChrome={setChrome}
            />,
        );

        const machineSelector = screen.findByType('MachineSelector' as any);
        await act(async () => {
            machineSelector.props.onSelect(machinesState[0]);
        });

        const lastChrome = setChrome.mock.calls.at(-1)?.[0] as any;
        const createButton = React.Children.toArray(lastChrome.footer.props.children)
            .find((child: any) => child?.props?.title === 'common.create') as React.ReactElement<{
                disabled?: boolean;
                onPress?: () => void;
            }> | undefined;

        expect(createButton?.props.disabled).toBe(false);
        await act(async () => {
            createButton?.props.onPress?.();
        });
        expect(onResolve).toHaveBeenCalledWith({
            machineId: 'machine-1',
            directory: '/Users/test',
        });
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});
