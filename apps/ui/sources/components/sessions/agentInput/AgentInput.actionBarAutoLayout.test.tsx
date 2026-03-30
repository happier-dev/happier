import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installAgentInputCommonModuleMocks } from './agentInputTestHelpers';
import { settingsDefaults, type Settings } from '@/sync/domains/settings/settings';
import { createUseSettingMock } from '@/dev/testkit/mocks/storage';

vi.mock('expo-haptics', () => ({
    impactAsync: vi.fn(async () => {}),
    notificationAsync: vi.fn(async () => {}),
    ImpactFeedbackStyle: { Light: 'Light' },
    NotificationFeedbackType: { Error: 'Error' },
}));

let storageSettings: Settings = {
    ...settingsDefaults,
    profiles: [],
    agentInputEnterToSend: true,
    agentInputActionBarLayout: 'auto',
    agentInputChipDensity: 'labels',
    sessionPermissionModeApplyTiming: 'immediate',
};

installAgentInputCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                React.createElement('View', props, props.children),
            Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                React.createElement('Text', props, props.children),
            Pressable: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                React.createElement('Pressable', props, props.children),
            ScrollView: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                React.createElement('ScrollView', props, props.children),
            Platform: {
                OS: 'ios',
                select: (v: any) => v.ios,
            },
            // 700px should be treated as "mobile-ish" for action bar auto layout.
            useWindowDimensions: () => ({ width: 700, height: 800 }),
            Dimensions: {
                get: () => ({ width: 700, height: 800, scale: 1, fontScale: 1 }),
            },
            Keyboard: {
                addListener: () => ({ remove: () => {} }),
            },
        });
    },
    icons: async () => ({
        Ionicons: (props: Record<string, unknown>) => React.createElement('Ionicons', props, null),
        Octicons: (props: Record<string, unknown>) => React.createElement('Octicons', props, null),
    }),
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock();
    },
    storage: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                useSetting: createUseSettingMock({
                    fallback: (key) => storageSettings[key],
                }),
                useSettings: () => storageSettings,
                useSessionMessages: () => ({ messages: [], isLoaded: true }),
                useSessionTranscriptIds: () => ({ ids: [], isLoaded: true }),
                useSessionMessagesById: () => ({}),
                useSessionMessagesVersion: () => 0,
            },
        });
    },
    });

describe('AgentInput (action bar auto layout)', () => {
    it('uses the scrollable action bar layout in auto mode on sub-tablet widths', async () => {
        storageSettings = { ...storageSettings, agentInputChipDensity: 'labels' };
        vi.resetModules();
        const { AgentInput } = await import('./AgentInput');

        const screen = await renderScreen(
            <AgentInput
                value=""
                placeholder="Type"
                onChangeText={() => {}}
                onSend={() => {}}
                onPermissionClick={() => {}}
                onMachineClick={() => {}}
                machineName="Builder"
                onPathClick={() => {}}
                currentPath="/tmp"
                autocompletePrefixes={[]}
                autocompleteSuggestions={async () => []}
            />,
        );

        const scrollViews = screen.tree.root.findAll((node: any) => (
            node?.type === 'ScrollView' && node?.props?.horizontal === true
        ));
        expect(scrollViews.length).toBeGreaterThan(0);
        expect(scrollViews[0]?.props?.scrollEnabled).toBe(true);
    });

    it('keeps the path chip label visible even when chip density is icons', async () => {
        storageSettings = { ...storageSettings, agentInputChipDensity: 'icons' };
        vi.resetModules();
        const { AgentInput } = await import('./AgentInput');

        const screen = await renderScreen(
            <AgentInput
                value=""
                placeholder="Type"
                onChangeText={() => {}}
                onSend={() => {}}
                onPermissionClick={() => {}}
                onMachineClick={() => {}}
                machineName="Builder"
                onPathClick={() => {}}
                currentPath="/tmp/my-repo"
                autocompletePrefixes={[]}
                autocompleteSuggestions={async () => []}
            />,
        );

        const pathChip = screen.tree.root.findByProps({ testID: 'agent-input-path-chip' });
        const textNodes = pathChip.findAll((node: any) => node?.type === 'Text');
        expect(textNodes.length).toBeGreaterThan(0);
        storageSettings = { ...storageSettings, agentInputChipDensity: 'labels' };
    });
});
