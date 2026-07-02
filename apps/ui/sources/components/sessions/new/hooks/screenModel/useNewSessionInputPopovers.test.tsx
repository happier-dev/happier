import { describe, expect, it, vi } from 'vitest';

import { createMachineFixture, renderHook } from '@/dev/testkit';
import type { Machine } from '@/sync/domains/state/storageTypes';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native-reanimated', () => ({ __esModule: true, default: {} }));
vi.mock('react-native-reanimated/lib/module', () => ({ __esModule: true, default: {} }));
vi.mock('react-native-reanimated/lib/module/index.js', () => ({ __esModule: true, default: {} }));
vi.mock('react-native-reanimated/lib/module/index', () => ({ __esModule: true, default: {} }));
vi.mock('react-native-reanimated/lib/module/publicGlobals', () => ({ __esModule: true }));
vi.mock('@/components/sessions/new/components/NewSessionPathSelectionContent', () => ({
    NewSessionPathSelectionContent: () => null,
}));
vi.mock('@/components/sessions/new/components/NewSessionMachineSelectionContent', () => ({
    NewSessionMachineSelectionContent: () => null,
}));
vi.mock('@/components/sessions/new/components/NewSessionResumeSelectionContent', () => ({
    NewSessionResumeSelectionContent: () => null,
}));
vi.mock('@/components/sessions/external/browse/openExternalSessionsResumeIdPickerModal', () => ({
    openExternalSessionsResumeIdPickerModal: vi.fn(async () => null),
}));

type UseNewSessionInputPopovers = typeof import('./useNewSessionInputPopovers').useNewSessionInputPopovers;
type HookParams = Parameters<UseNewSessionInputPopovers>[0];

function createParams(overrides: Partial<HookParams> = {}): HookParams {
    const selectedMachine = createMachineFixture({
        id: 'machine-1',
        metadata: {
            host: 'machine-1',
            displayName: 'Machine 1',
            happyCliVersion: '0.0.0-test',
            happyHomeDir: '/Users/test/.happy-dev',
            homeDir: '/Users/test',
            platform: 'darwin',
        },
    }) as Machine;

    return {
        selectedMachine,
        selectedMachineId: selectedMachine.id,
        selectedPath: '/Users/test/project',
        setSelectedPath: vi.fn(),
        setDraftSelectedPath: vi.fn(),
        recentPaths: [],
        usePathPickerSearch: false,
        pathPickerSearchQuery: '',
        setPathPickerSearchQuery: vi.fn(),
        favoriteDirectories: [],
        setFavoriteDirectories: vi.fn(),
        allowedTargetServerIds: [],
        resolvedSettingsAllowedServerIds: [],
        activeServerId: 'server-a',
        activeServerProfilesSignature: 'server-a\u0000Server A',
        activeMachines: [selectedMachine],
        selectedServerId: 'server-a',
        recentMachines: [],
        favoriteMachineItems: [],
        setSelectedMachineId: vi.fn(),
        getBestPathForMachine: () => '/Users/test/project',
        useMachinePickerSearch: false,
        targetServerId: 'server-a',
        externalSessionsFeatureEnabled: false,
        resumeSessionId: '',
        setResumeSessionId: vi.fn(),
        agentType: 'codex',
        agentLabel: 'Codex',
        agentOptionState: null,
        settings: {},
        ...overrides,
    } as HookParams;
}

describe('useNewSessionInputPopovers', () => {
    it('opens the path popover in history-first suggestion mode', async () => {
        const { useNewSessionInputPopovers } = await import('./useNewSessionInputPopovers');
        const hook = await renderHook((props: HookParams) => useNewSessionInputPopovers(props), {
            initialProps: createParams(),
        });

        const renderContent = hook.getCurrent().pathPopover.renderContent;
        expect(typeof renderContent).toBe('function');
        if (typeof renderContent !== 'function') throw new Error('Expected path popover renderContent');
        const content = renderContent({
            maxHeight: 420,
            requestClose: vi.fn(),
        });
        const element = content as { props?: Readonly<Record<string, unknown>> };

        expect(element.props?.initialSuggestionMode).toBe('history');

        await hook.unmount();
    });

    it('keeps closed machine popover config stable when callback identities churn', async () => {
        const { useNewSessionInputPopovers } = await import('./useNewSessionInputPopovers');
        const initialProps = createParams();
        const hook = await renderHook((props: HookParams) => useNewSessionInputPopovers(props), {
            initialProps,
        });
        const firstMachinePopover = hook.getCurrent().machinePopover;

        await hook.rerender({
            ...initialProps,
            getBestPathForMachine: () => '/Users/test/project',
        });

        expect(hook.getCurrent().machinePopover).toBe(firstMachinePopover);

        await hook.unmount();
    });
});
