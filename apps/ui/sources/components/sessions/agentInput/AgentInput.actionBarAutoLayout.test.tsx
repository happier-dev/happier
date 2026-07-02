import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installAgentInputCommonModuleMocks } from './agentInputTestHelpers';
import { settingsDefaults, type Settings } from '@/sync/domains/settings/settings';
import { localSettingsDefaults } from '@/sync/domains/settings/localSettings';
import { createUseSettingMock } from '@/dev/testkit/mocks/storage';

vi.mock('expo-haptics', () => ({
    impactAsync: vi.fn(async () => {}),
    notificationAsync: vi.fn(async () => {}),
    ImpactFeedbackStyle: { Light: 'Light' },
    NotificationFeedbackType: { Error: 'Error' },
}));

const keyboardMockState = vi.hoisted(() => ({
    callCount: 0,
    height: 0,
}));

const layoutMockState = vi.hoisted(() => ({
    platform: 'ios' as 'ios' | 'web',
    width: 700,
    height: 800,
}));

vi.mock('@/hooks/ui/useKeyboardHeight', () => ({
    useKeyboardHeight: () => {
        keyboardMockState.callCount += 1;
        return keyboardMockState.height;
    },
}));

let storageSettings: Settings = {
    ...settingsDefaults,
    profiles: [],
    agentInputEnterToSend: true,
    agentInputActionBarLayout: 'auto',
    agentInputChipDensity: 'labels',
    sessionPermissionModeApplyTiming: 'immediate',
};

function flattenStyle(style: unknown): Record<string, unknown> {
    if (!style) return {};
    if (Array.isArray(style)) {
        return style.reduce<Record<string, unknown>>((merged, entry) => ({
            ...merged,
            ...flattenStyle(entry),
        }), {});
    }
    if (typeof style === 'object') return style as Record<string, unknown>;
    return {};
}

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
                get OS() {
                    return layoutMockState.platform;
                },
                select: (v: any) => v?.[layoutMockState.platform] ?? v?.default ?? v?.ios,
            },
            // 700px should be treated as "mobile-ish" for action bar auto layout.
            useWindowDimensions: () => ({ width: layoutMockState.width, height: layoutMockState.height }),
            Dimensions: {
                get: () => ({ width: layoutMockState.width, height: layoutMockState.height, scale: 1, fontScale: 1 }),
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
        const { createStorageModuleMock, createStorageStoreMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                storage: createStorageStoreMock({
                    settings: storageSettings,
                    sessionMessages: {},
                    localSettings: { ...localSettingsDefaults, uiFontScale: 1 },
                    getSessionProjectScmSnapshot: () => null,
                }),
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
    storageStore: async () => {
        const state = {
            settings: storageSettings,
            sessionMessages: {},
            localSettings: { uiFontScale: 1 },
            getProjectScmSnapshot: () => null,
            getSessionProjectScmSnapshot: () => null,
        };
        const storage = Object.assign(
            (selector?: (nextState: typeof state) => unknown) => (
                typeof selector === 'function' ? selector(state) : state
            ),
            {
                getState: () => state,
                subscribe: () => () => {},
            },
        );
        return { getStorage: () => storage };
    },
    });

describe('AgentInput (action bar auto layout)', () => {
    beforeEach(() => {
        keyboardMockState.callCount = 0;
        keyboardMockState.height = 0;
        layoutMockState.platform = 'ios';
        layoutMockState.width = 700;
        layoutMockState.height = 800;
    });

    it('does not subscribe to passive keyboard height while rendering the native composer', async () => {
        layoutMockState.platform = 'ios';
        keyboardMockState.height = 320;
        vi.resetModules();
        const { AgentInput } = await import('./AgentInput');

        await renderScreen(
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
                maxPanelHeight={360}
            />,
        );

        expect(keyboardMockState.callCount).toBe(0);
    });

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

    it('does not apply the host panel max height on web so the composer never re-constrains from undefined to measured on switch', async () => {
        layoutMockState.platform = 'web';
        layoutMockState.width = 900;
        layoutMockState.height = 700;
        vi.resetModules();
        const { AgentInput } = await import('./AgentInput');
        const { WebDropTargetView } = await import('@/components/workspaces/files/repositoryTree/WebDropTargetView');

        const screen = await renderScreen(
            <AgentInput
                value="Long draft"
                placeholder="Type"
                onChangeText={() => {}}
                onSend={() => {}}
                autocompletePrefixes={[]}
                autocompleteSuggestions={async () => []}
                maxPanelHeight={300}
                attachments={[{
                    key: 'screenshot',
                    label: 'Screenshot.png',
                    onRemove: () => {},
                    preview: { kind: 'image', uri: 'blob:screenshot' },
                }]}
            />,
        );

        const panel = screen.tree.root.findByType(WebDropTargetView as any);
        const panelStyle = Object.assign(
            {},
            ...(Array.isArray(panel.props.style) ? panel.props.style : [panel.props.style]).filter(Boolean),
        );
        expect(panelStyle.maxHeight).toBeUndefined();
    });

    it('uses the host-constrained web panel budget to cap new-session input chrome', async () => {
        layoutMockState.platform = 'web';
        layoutMockState.width = 900;
        layoutMockState.height = 700;
        vi.resetModules();
        const { act } = await import('react-test-renderer');
        const { AgentInput } = await import('./AgentInput');
        const { WebDropTargetView } = await import('@/components/workspaces/files/repositoryTree/WebDropTargetView');

        const screen = await renderScreen(
            <AgentInput
                value="Long draft"
                placeholder="Type"
                onChangeText={() => {}}
                onSend={() => {}}
                autocompletePrefixes={[]}
                autocompleteSuggestions={async () => []}
                maxPanelHeight={640}
                panelMaxHeightMode="host-constrained"
                attachments={[{
                    key: 'screenshot',
                    label: 'Screenshot.png',
                    onRemove: () => {},
                    preview: { kind: 'image', uri: 'blob:screenshot' },
                }]}
            />,
        );

        const panel = screen.tree.root.findByType(WebDropTargetView as any);
        const panelStyle = Object.assign(
            {},
            ...(Array.isArray(panel.props.style) ? panel.props.style : [panel.props.style]).filter(Boolean),
        );
        expect(panelStyle.maxHeight).toBe(640);

        const input = screen.tree.root.findByProps({ testID: 'new-session-composer-input' });
        const inputContainer = input.parent;
        const actionFooter = screen.tree.root.findAll((node: any) => {
            const style = Array.isArray(node?.props?.style)
                ? node.props.style
                : [node?.props?.style];
            return typeof node?.props?.onLayout === 'function'
                && style.some((entry: unknown) => (
                    entry != null
                    && typeof entry === 'object'
                    && 'flexShrink' in entry
                    && (entry as { flexShrink?: number }).flexShrink === 0
                ));
        })[0];
        const variableContentBeforeInput = screen.tree.root.findAllByProps({
            testID: 'agent-input-variable-content-before-input',
        })[0];

        await act(async () => {
            panel.props.onLayout({ nativeEvent: { layout: { height: 640 } } });
            inputContainer?.props.onLayout({ nativeEvent: { layout: { height: 520 } } });
            actionFooter?.props.onLayout({ nativeEvent: { layout: { height: 80 } } });
            variableContentBeforeInput?.props.onLayout?.({ nativeEvent: { layout: { height: 70 } } });
        });

        expect(screen.tree.root.findByProps({ testID: 'new-session-composer-input' }).props.maxHeight).toBe(468);
    });

    it('honors the host panel max height on native where the absolutely-positioned composer needs the keyboard-driven cap', async () => {
        layoutMockState.platform = 'ios';
        layoutMockState.width = 420;
        layoutMockState.height = 900;
        vi.resetModules();
        const { AgentInput } = await import('./AgentInput');
        const { WebDropTargetView } = await import('@/components/workspaces/files/repositoryTree/WebDropTargetView');

        const screen = await renderScreen(
            <AgentInput
                value="Long draft"
                placeholder="Type"
                onChangeText={() => {}}
                onSend={() => {}}
                autocompletePrefixes={[]}
                autocompleteSuggestions={async () => []}
                maxPanelHeight={300}
            />,
        );

        const panel = screen.tree.root.findByType(WebDropTargetView as any);
        const panelStyle = Object.assign(
            {},
            ...(Array.isArray(panel.props.style) ? panel.props.style : [panel.props.style]).filter(Boolean),
        );
        expect(panelStyle.maxHeight).toBe(300);
    });

    it('keeps web composer chrome fixed while capped input content scrolls', async () => {
        layoutMockState.platform = 'web';
        layoutMockState.width = 900;
        layoutMockState.height = 700;
        vi.resetModules();
        const { AgentInput } = await import('./AgentInput');

        const screen = await renderScreen(
            <AgentInput
                sessionId="session-1"
                value={'F\n'.repeat(20)}
                placeholder="Type"
                onChangeText={() => {}}
                onSend={() => {}}
                autocompletePrefixes={[]}
                autocompleteSuggestions={async () => []}
                inputMaxHeight={245}
                maxPanelHeight={700}
            />,
        );

        const verticalScrollViews = screen.tree.root.findAll((node: any) => (
            node?.type === 'ScrollView' && node?.props?.horizontal !== true
        ));
        expect(verticalScrollViews.length).toBeGreaterThan(0);

        const actionFooter = screen.tree.root.findAll((node: any) => {
            const style = Array.isArray(node?.props?.style)
                ? node.props.style
                : [node?.props?.style];
            return style.some((entry: unknown) => (
                entry != null
                && typeof entry === 'object'
                && 'flexShrink' in entry
                && (entry as { flexShrink?: number }).flexShrink === 0
            ));
        });
        expect(actionFooter.length).toBeGreaterThan(0);
    });

    it('does not wrap the native multiline composer input in a competing vertical ScrollView', async () => {
        layoutMockState.platform = 'ios';
        vi.resetModules();
        const { AgentInput } = await import('./AgentInput');

        const screen = await renderScreen(
            <AgentInput
                sessionId="session-1"
                value={'F\n'.repeat(20)}
                placeholder="Type"
                onChangeText={() => {}}
                onSend={() => {}}
                autocompletePrefixes={[]}
                autocompleteSuggestions={async () => []}
                inputMaxHeight={245}
                maxPanelHeight={700}
            />,
        );

        const verticalScrollViews = screen.tree.root.findAll((node: any) => (
            node?.type === 'ScrollView' && node?.props?.horizontal !== true
        ));
        expect(verticalScrollViews).toHaveLength(0);
    });

    it('reserves existing-session input expansion toggle space before the toggle appears', async () => {
        layoutMockState.platform = 'ios';
        vi.resetModules();
        const { act } = await import('react-test-renderer');
        const { AgentInput } = await import('./AgentInput');

        const screen = await renderScreen(
            <AgentInput
                inputExpansion={{
                    expanded: false,
                    collapsedMaxHeight: 200,
                    onToggle: vi.fn(),
                }}
                sessionId="session-1"
                value=""
                placeholder="Type"
                onChangeText={() => {}}
                onSend={() => {}}
                autocompletePrefixes={[]}
                autocompleteSuggestions={async () => []}
                inputMaxHeight={200}
                maxPanelHeight={700}
            />,
        );

        const findExpansionToggleButtons = () => screen.tree.root.findAll((node: any) => (
            node.props?.testID === 'agent-input-expand-toggle'
            && node.props?.accessibilityRole === 'button'
        ));
        const readInputPaddingRight = () => {
            const inputProps = screen.tree.root.findByProps({ testID: 'session-composer-input' }).props;
            return inputProps.paddingRight ?? flattenStyle(inputProps.style).paddingRight;
        };

        expect(readInputPaddingRight()).toBe(32);
        expect(findExpansionToggleButtons()).toHaveLength(0);

        const input = screen.tree.root.findByProps({ testID: 'session-composer-input' });
        await act(async () => {
            if (typeof input.props.onContentHeightChange === 'function') {
                input.props.onContentHeightChange(220);
            } else {
                input.props.onContentSizeChange({ nativeEvent: { contentSize: { height: 220 } } });
            }
        });

        expect(readInputPaddingRight()).toBe(32);
        expect(findExpansionToggleButtons().length).toBeGreaterThan(0);
    });

    it('keeps the provided existing-session input max height as a hard cap after native panel measurement', async () => {
        layoutMockState.platform = 'ios';
        layoutMockState.width = 420;
        layoutMockState.height = 900;
        vi.resetModules();
        const { act } = await import('react-test-renderer');
        const { AgentInput } = await import('./AgentInput');
        const { WebDropTargetView } = await import('@/components/workspaces/files/repositoryTree/WebDropTargetView');

        const screen = await renderScreen(
            <AgentInput
                sessionId="session-1"
                value={'F\n'.repeat(20)}
                placeholder="Type"
                onChangeText={() => {}}
                onSend={() => {}}
                autocompletePrefixes={[]}
                autocompleteSuggestions={async () => []}
                inputMaxHeight={245}
                maxPanelHeight={700}
            />,
        );

        const panel = screen.tree.root.findByType(WebDropTargetView as any);
        const input = screen.tree.root.findByProps({ testID: 'session-composer-input' });
        const inputContainer = input.parent;

        await act(async () => {
            panel.props.onLayout({ nativeEvent: { layout: { height: 220 } } });
            inputContainer?.props.onLayout({ nativeEvent: { layout: { height: 60 } } });
        });

        expect(screen.tree.root.findByProps({ testID: 'session-composer-input' }).props.maxHeight).toBe(245);
    });

    it('lets new-session native input grow beyond the heuristic seed after panel measurement', async () => {
        layoutMockState.platform = 'ios';
        layoutMockState.width = 420;
        layoutMockState.height = 900;
        vi.resetModules();
        const { act } = await import('react-test-renderer');
        const { AgentInput } = await import('./AgentInput');
        const { WebDropTargetView } = await import('@/components/workspaces/files/repositoryTree/WebDropTargetView');

        const screen = await renderScreen(
            <AgentInput
                value={'F\n'.repeat(20)}
                placeholder="Type"
                onChangeText={() => {}}
                onSend={() => {}}
                autocompletePrefixes={[]}
                autocompleteSuggestions={async () => []}
                inputMaxHeight={245}
                maxPanelHeight={700}
            />,
        );

        const panel = screen.tree.root.findByType(WebDropTargetView as any);
        const input = screen.tree.root.findByProps({ testID: 'new-session-composer-input' });
        const inputContainer = input.parent;

        await act(async () => {
            panel.props.onLayout({ nativeEvent: { layout: { height: 436 } } });
            inputContainer?.props.onLayout({ nativeEvent: { layout: { height: 358 } } });
        });

        expect(screen.tree.root.findByProps({ testID: 'new-session-composer-input' }).props.maxHeight).toBe(614);
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
