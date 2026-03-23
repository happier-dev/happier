import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    renderSettingsView,
    standardCleanup,
} from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;

const shared = vi.hoisted(() => ({
    useServerFeaturesMainSelectionSnapshotMock: vi.fn(),
    useEffectiveServerSelectionMock: vi.fn(),
    useSettingMutableMock: vi.fn(),
    useLocalSettingMutableMock: vi.fn(),
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                                Text: 'Text',
                                Platform: {
                                    OS: 'web',
                                    select: (spec: Record<string, unknown>) => (
                                        spec && Object.prototype.hasOwnProperty.call(spec, 'ios')
                                            ? (spec as { ios?: unknown }).ios
                                            : (spec as { default?: unknown }).default
                                    ),
                                },
                            }
    );
});

vi.mock('@expo/vector-icons', async () => {
    const Ionicons = Object.assign(
        (props: any) => React.createElement('Ionicons', props),
        { glyphMap: {} },
    );
    return { Ionicons };
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: any) => React.createElement('ItemList', null, children),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: any) => React.createElement('ItemGroup', props, props.children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props),
}));

vi.mock('@/components/ui/forms/Switch', () => ({
    Switch: (props: any) => React.createElement('Switch', props),
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) => React.createElement('DropdownMenu', props),
}));

vi.mock('@/components/settings/features/FeatureDiagnosticsPanel', () => ({
    FeatureDiagnosticsPanel: () => null,
}));

vi.mock('@/sync/domains/features/featureDecisionRuntime', async (importOriginal) => {
    const actual = await importOriginal<any>();
    return {
        ...actual,
        useServerFeaturesMainSelectionSnapshot: (...args: any[]) => shared.useServerFeaturesMainSelectionSnapshotMock(...args),
    };
});

vi.mock('@/hooks/server/useEffectiveServerSelection', () => ({
    useEffectiveServerSelection: () => shared.useEffectiveServerSelectionMock(),
}));

type MutableHookResult<T> = readonly [T, (next: T) => void];

function createNoopMutable<T>(value: T): MutableHookResult<T> {
    return [value, vi.fn()] as const;
}

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleMock({
        importOriginal,
        overrides: {
            useSettingMutable: (key: string) => shared.useSettingMutableMock(key),
            useLocalSettingMutable: (key: string) => shared.useLocalSettingMutableMock(key),
        },
    });
});

beforeEach(() => {
    standardCleanup();
    shared.useEffectiveServerSelectionMock.mockReturnValue({ serverIds: [] });
    shared.useServerFeaturesMainSelectionSnapshotMock.mockReturnValue({ status: 'ready', serverIds: [], snapshotsByServerId: {} });

    shared.useSettingMutableMock.mockImplementation((key: string) => {
        if (key === 'experiments') return createNoopMutable(false);
        if (key === 'featureToggles') return createNoopMutable({});
        if (key === 'useProfiles') return createNoopMutable(false);
        if (key === 'agentInputEnterToSend') return createNoopMutable(false);
        if (key === 'agentInputHistoryScope') return createNoopMutable('perSession');
        if (key === 'showEnvironmentBadge') return createNoopMutable(false);
        if (key === 'useEnhancedSessionWizard') return createNoopMutable(false);
        if (key === 'useMachinePickerSearch') return createNoopMutable(false);
        if (key === 'usePathPickerSearch') return createNoopMutable(false);
        return createNoopMutable(null);
    });

    shared.useLocalSettingMutableMock.mockImplementation((key: string) => {
        if (key === 'commandPaletteEnabled') return createNoopMutable(false);
        if (key === 'devModeEnabled') return createNoopMutable(false);
        return createNoopMutable(false);
    });
});

describe('FeaturesSettingsScreen (web settings moved)', () => {
    it('does not show Enter-to-send or Message history (moved to Session settings)', async () => {
        const { default: FeaturesSettingsScreen } = await import('@/app/(app)/settings/features');
        const screen = await renderSettingsView(React.createElement(FeaturesSettingsScreen));
        const titles = screen.findAllByType('Item' as any).map((item) => item.props.title);

        expect(titles).not.toContain('settingsFeatures.enterToSend');
        expect(titles).not.toContain('settingsFeatures.historyScope');
    });
});
