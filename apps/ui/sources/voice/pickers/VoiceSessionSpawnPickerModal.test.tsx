import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const pathSelectorPropsRef: { current: Record<string, unknown> | null } = { current: null };

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                    View: 'View',
                    Pressable: 'Pressable',
                    ScrollView: 'ScrollView',
                    Platform: {
                        OS: 'web',
                        select: (options: { web?: unknown; default?: unknown }) => options.web ?? options.default,
                    },
                }
    );
});

vi.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}));

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
      colors: {
        surface: '#fff',
        text: '#111',
        textSecondary: '#666',
        divider: '#ddd',
        header: { tint: '#111' },
        shadow: { color: '#000' },
      },
    },
    });
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string) => key,
    });
});

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

vi.mock('@/components/sessions/new/components/PathSelector', () => ({
  PathSelector: (props: Record<string, unknown>) => {
    pathSelectorPropsRef.current = props;
    return React.createElement('PathSelector', props);
  },
}));

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
    useAllMachines: () => [{ id: 'machine-1', metadata: { homeDir: '/Users/test' } }],
    useSessions: () => [],
    useSetting: (key: string) => {
    if (key === 'recentMachinePaths') return [];
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
});

vi.mock('@/utils/sessions/recentMachines', () => ({
  getRecentMachinesFromSessions: () => [],
}));

vi.mock('@/utils/sessions/recentPaths', () => ({
  getRecentPathsForMachine: () => [],
}));

vi.mock('@/components/settings/pickers/resolvePreferredMachineId', () => ({
  resolvePreferredMachineId: () => 'machine-1',
}));

vi.mock('@/utils/sessions/machineUtils', () => ({
  isMachineOnline: () => true,
}));

describe('VoiceSessionSpawnPickerModal', () => {
  beforeEach(() => {
    pathSelectorPropsRef.current = null;
  });

    it('passes machine browse config to PathSelector after choosing a machine', async () => {
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
      machineBrowse: {
        enabled: true,
        machineId: 'machine-1',
      },
    });
  });
});
