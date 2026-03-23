import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderSettingsView, standardCleanup } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const shared = vi.hoisted(() => ({
    routerPushSpy: vi.fn(),
    settingsState: {
        sessionsRightPaneDefaultOpen: false,
        uiMultiPanePanelsEnabled: false,
    } as Record<string, unknown>,
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({
        router: {
            push: shared.routerPushSpy,
            back: vi.fn(),
            replace: vi.fn(),
            setParams: vi.fn(),
        },
    }).module;
});

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: (props: any) => React.createElement('ItemList', props, props.children),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: any) => React.createElement('ItemGroup', props, props.children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props),
}));

vi.mock('@/components/ui/forms/Switch', () => ({
    Switch: 'Switch',
}));

vi.mock('@/components/settings/llmTasks/LlmTaskRunnerConfigV1BackendModelPicker', () => ({
    LlmTaskRunnerConfigV1BackendModelPicker: (props: any) =>
        React.createElement('LlmTaskRunnerConfigV1BackendModelPicker', props),
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) => React.createElement('DropdownMenu', props),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
    TextInput: 'TextInput',
}));

vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
    },
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleMock({
        importOriginal,
        overrides: {
            useSettingMutable: ((key: string) => [
                key in shared.settingsState ? shared.settingsState[key] : null,
                (next: unknown) => {
                    shared.settingsState[key] = next;
                },
            ]) as any,
            useLocalSettingMutable: ((key: string) => [
                key in shared.settingsState ? shared.settingsState[key] : null,
                (next: unknown) => {
                    shared.settingsState[key] = next;
                },
            ]) as any,
        },
    });
});

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => false,
}));

vi.mock('@/utils/platform/responsive', () => ({
    useDeviceType: () => 'desktop',
}));

afterEach(() => {
    standardCleanup();
    shared.routerPushSpy.mockClear();
});

describe('Session settings (Actions entry)', () => {
    it('does not include an Actions entry', async () => {
        const mod = await import('@/app/(app)/settings/session');
        const SessionSettingsScreen = mod.default;
        const screen = await renderSettingsView(React.createElement(SessionSettingsScreen));

        const titles = screen.findAllByType('Item' as any).map((item) => item.props.title);

        expect(titles).not.toContain('common.actions');
    });
});
