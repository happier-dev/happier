import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderSettingsView } from '@/dev/testkit';
import { installSessionSettingsCommonModuleMocks } from '@/components/settings/session/sessionSettingsViewTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const detailResumeControlsLoaded = vi.hoisted(() => vi.fn());

installSessionSettingsCommonModuleMocks();

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: { children?: React.ReactNode }) => React.createElement('ItemList', null, children),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children, title }: { children?: React.ReactNode; title?: string }) =>
        React.createElement('ItemGroup', { title }, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: Record<string, unknown>) => React.createElement('Item', props),
}));

vi.mock('@/components/ui/forms/Switch', () => ({
    Switch: (props: Record<string, unknown>) => React.createElement('Switch', props),
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: Record<string, unknown>) => React.createElement('DropdownMenu', props),
}));

vi.mock('@/components/settings/llmTasks/LlmTaskRunnerConfigV1BackendModelPicker', () => {
    detailResumeControlsLoaded();
    return {
        LlmTaskRunnerConfigV1BackendModelPicker: (props: Record<string, unknown>) =>
            React.createElement('LlmTaskRunnerConfigV1BackendModelPicker', props),
    };
});

describe('SessionSettingsScreen', () => {
    it('renders split session behavior entries', async () => {
        const { default: SessionSettingsScreen } = await import('@/app/(app)/settings/session');

        const screen = await renderSettingsView(React.createElement(SessionSettingsScreen));

        expect(screen.findRowByTitle('settingsSession.composer.title')).toBeTruthy();
        expect(screen.findRowByTitle('settingsSession.providerLimits.title')).toBeTruthy();
        expect(screen.findRowByTitle('settingsSession.resume.title')).toBeTruthy();
        expect(screen.findRowByTitle('settingsSession.runtime.title')).toBeTruthy();
        expect(detailResumeControlsLoaded).not.toHaveBeenCalled();
    });
});
