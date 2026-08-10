import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

const keyboardMockState = vi.hoisted(() => ({
    callCount: 0,
    height: 0,
}));

const layoutMockState = vi.hoisted(() => ({
    platform: 'ios' as 'ios' | 'web',
    width: 700,
    height: 800,
}));

const multiTextInputMockState = vi.hoisted(() => ({
    renderCount: 0,
}));

vi.mock('@/hooks/ui/useKeyboardHeight', () => ({
    useKeyboardHeight: () => {
        keyboardMockState.callCount += 1;
        return keyboardMockState.height;
    },
}));

vi.mock('@/components/ui/forms/MultiTextInput', () => ({
    MultiTextInput: (props: Record<string, unknown>) => {
        multiTextInputMockState.renderCount += 1;
        return React.createElement('MultiTextInput', props, null);
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
                // Live getter so per-test `layoutMockState.platform` toggles take effect
                // even when the react-native mock factory is reused across `vi.resetModules()`
                // boundaries (a plain snapshot would freeze OS at the first test's value).
                get OS() {
                    return layoutMockState.platform;
                },
                select: (v: any) => v?.[layoutMockState.platform] ?? v?.default,
            },
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
    beforeEach(() => {
        keyboardMockState.callCount = 0;
        keyboardMockState.height = 0;
        layoutMockState.platform = 'ios';
        layoutMockState.width = 700;
        layoutMockState.height = 800;
        storageSettings = {
            ...storageSettings,
            agentInputActionBarLayout: 'auto',
            agentInputChipDensity: 'labels',
        };
        multiTextInputMockState.renderCount = 0;
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
                autocompleteKinds={[]}
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
                autocompleteKinds={[]}
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
        // Issue C: the existing-session maxPanelHeight derives from a value that is
        // `undefined` on the first web/Tauri frame and a measured number ~120ms later
        // (the web composer layout seeds its available-panel-height shared value at 0
        // and only computes the real value in a post-paint effect). The web composer is
        // already flex-bounded (it is not the absolutely-positioned native composer), so
        // it must stay unconstrained instead of flipping unconstrained -> constrained.
        layoutMockState.platform = 'web';
        layoutMockState.width = 900;
        layoutMockState.height = 700;
        vi.resetModules();
        const { AgentInput } = await import('./AgentInput');

        const screen = await renderScreen(
            <AgentInput
                value="Long draft"
                placeholder="Type"
                onChangeText={() => {}}
                onSend={() => {}}
                autocompleteKinds={[]}
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

        const panel = screen.tree.root.findByProps({ testID: 'agent-input-drop-zone' });
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

        const screen = await renderScreen(
            <AgentInput
                value="Long draft"
                placeholder="Type"
                onChangeText={() => {}}
                onSend={() => {}}
                autocompleteKinds={[]}
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

        const panel = screen.tree.root.findByProps({ testID: 'agent-input-drop-zone' });
        const panelStyle = Object.assign(
            {},
            ...(Array.isArray(panel.props.style) ? panel.props.style : [panel.props.style]).filter(Boolean),
        );
        expect(panelStyle.maxHeight).toBe(640);

        const inputContainer = screen.tree.root.findByProps({ testID: 'agent-input-composer-input-container' });
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
            inputContainer.props.onLayout({ nativeEvent: { layout: { height: 520 } } });
            actionFooter?.props.onLayout({ nativeEvent: { layout: { height: 80 } } });
            variableContentBeforeInput?.props.onLayout?.({ nativeEvent: { layout: { height: 70 } } });
        });

        expect(screen.tree.root.findByType('MultiTextInput').props.maxHeight).toBe(468);
    });

    it('honors the host panel max height on native where the absolutely-positioned composer needs the keyboard-driven cap', async () => {
        layoutMockState.platform = 'ios';
        layoutMockState.width = 420;
        layoutMockState.height = 900;
        vi.resetModules();
        const { AgentInput } = await import('./AgentInput');

        const screen = await renderScreen(
            <AgentInput
                value="Long draft"
                placeholder="Type"
                onChangeText={() => {}}
                onSend={() => {}}
                autocompleteKinds={[]}
                autocompleteSuggestions={async () => []}
                maxPanelHeight={300}
            />,
        );

        const panel = screen.tree.root.findByProps({ testID: 'agent-input-drop-zone' });
        const panelStyle = Object.assign(
            {},
            ...(Array.isArray(panel.props.style) ? panel.props.style : [panel.props.style]).filter(Boolean),
        );
        expect(panelStyle.maxHeight).toBe(300);
    });

    it('subtracts measured non-panel chrome from the native host panel budget', async () => {
        layoutMockState.platform = 'ios';
        layoutMockState.width = 420;
        layoutMockState.height = 900;
        vi.resetModules();
        const { act } = await import('react-test-renderer');
        const { AgentInput } = await import('./AgentInput');

        const screen = await renderScreen(
            <AgentInput
                value="Long draft"
                placeholder="Type"
                onChangeText={() => {}}
                onSend={() => {}}
                autocompleteKinds={[]}
                autocompleteSuggestions={async () => []}
                connectionStatus={{ text: 'online', color: 'green', dotColor: 'green' }}
                maxPanelHeight={423}
            />,
        );

        const root = screen.tree.root.findByProps({ testID: 'agent-input-root' });
        const panel = screen.tree.root.findByProps({ testID: 'agent-input-drop-zone' });

        await act(async () => {
            root.props.onLayout({ nativeEvent: { layout: { height: 464 } } });
            panel.props.onLayout({ nativeEvent: { layout: { height: 423 } } });
        });

        const updatedPanel = screen.tree.root.findByProps({ testID: 'agent-input-drop-zone' });
        const panelStyle = Object.assign(
            {},
            ...(Array.isArray(updatedPanel.props.style) ? updatedPanel.props.style : [updatedPanel.props.style]).filter(Boolean),
        );
        expect(panelStyle.maxHeight).toBe(382);
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
                autocompleteKinds={[]}
                autocompleteSuggestions={async () => []}
                inputMaxHeight={245}
                maxPanelHeight={700}
            />,
        );

        const input = screen.tree.root.findByType('MultiTextInput');
        expect(input.props.maxHeight).toBe(245);

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

    it('keeps the provided input max height as a hard cap after native panel measurement', async () => {
        layoutMockState.platform = 'ios';
        layoutMockState.width = 420;
        layoutMockState.height = 900;
        vi.resetModules();
        const { act } = await import('react-test-renderer');
        const { AgentInput } = await import('./AgentInput');

        const screen = await renderScreen(
            <AgentInput
                sessionId="session-1"
                value={'F\n'.repeat(20)}
                placeholder="Type"
                onChangeText={() => {}}
                onSend={() => {}}
                autocompleteKinds={[]}
                autocompleteSuggestions={async () => []}
                inputMaxHeight={245}
                maxPanelHeight={700}
            />,
        );

        const panel = screen.tree.root.findByProps({ testID: 'agent-input-drop-zone' });
        const inputContainer = screen.tree.root.findByProps({ testID: 'agent-input-composer-input-container' });

        await act(async () => {
            panel.props.onLayout({ nativeEvent: { layout: { height: 220 } } });
            inputContainer.props.onLayout({ nativeEvent: { layout: { height: 60 } } });
        });

        expect(screen.tree.root.findByType('MultiTextInput').props.maxHeight).toBe(245);
    });

    it('lets new-session native input grow beyond the heuristic seed after panel measurement', async () => {
        layoutMockState.platform = 'ios';
        layoutMockState.width = 420;
        layoutMockState.height = 900;
        vi.resetModules();
        const { act } = await import('react-test-renderer');
        const { AgentInput } = await import('./AgentInput');

        const screen = await renderScreen(
            <AgentInput
                value={'F\n'.repeat(20)}
                placeholder="Type"
                onChangeText={() => {}}
                onSend={() => {}}
                autocompleteKinds={[]}
                autocompleteSuggestions={async () => []}
                inputMaxHeight={245}
                maxPanelHeight={700}
            />,
        );

        const panel = screen.tree.root.findByProps({ testID: 'agent-input-drop-zone' });
        const inputContainer = screen.tree.root.findByProps({ testID: 'agent-input-composer-input-container' });

        await act(async () => {
            panel.props.onLayout({ nativeEvent: { layout: { height: 436 } } });
            inputContainer.props.onLayout({ nativeEvent: { layout: { height: 358 } } });
        });

        expect(screen.tree.root.findByType('MultiTextInput').props.maxHeight).toBe(614);
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
                autocompleteKinds={[]}
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
                autocompleteKinds={[]}
                autocompleteSuggestions={async () => []}
                inputMaxHeight={200}
                maxPanelHeight={700}
            />,
        );

        const input = screen.tree.root.findByType('MultiTextInput');
        const findExpansionToggleButtons = () => screen.tree.root.findAll((node: any) => (
            node.props?.testID === 'agent-input-expand-toggle'
            && node.props?.accessibilityRole === 'button'
        ));
        expect(input.props.paddingRight).toBe(32);
        expect(findExpansionToggleButtons()).toHaveLength(0);

        await act(async () => {
            input.props.onContentHeightChange(220);
        });

        expect(screen.tree.root.findByType('MultiTextInput').props.paddingRight).toBe(32);
        expect(findExpansionToggleButtons().length).toBeGreaterThan(0);
    });

    it('keeps the composer height reporter stable across web layout-only rerenders', async () => {
        layoutMockState.platform = 'web';
        layoutMockState.width = 900;
        layoutMockState.height = 700;
        vi.resetModules();
        const { act } = await import('react-test-renderer');
        const { AgentInput } = await import('./AgentInput');
        const renderAgentInput = () => (
            <AgentInput
                sessionId="session-1"
                value=""
                placeholder="Type"
                onChangeText={() => {}}
                onSend={() => {}}
                autocompleteKinds={[]}
                autocompleteSuggestions={async () => []}
                inputMaxHeight={200}
                maxPanelHeight={700}
            />
        );

        const screen = await renderScreen(renderAgentInput());

        const firstInput = screen.tree.root.findByType('MultiTextInput');
        const firstHeightReporter = firstInput.props.onContentHeightChange;

        act(() => {
            firstHeightReporter(220);
        });

        const nextInput = screen.tree.root.findByType('MultiTextInput');
        expect(nextInput.props.onContentHeightChange).toBe(firstHeightReporter);
    });

    it('shows the existing-session input expansion toggle only when content exceeds the collapsed cap', async () => {
        layoutMockState.platform = 'ios';
        vi.resetModules();
        const { act } = await import('react-test-renderer');
        const { AgentInput } = await import('./AgentInput');
        const onToggleExpanded = vi.fn();
        const expansionProps = {
            inputExpansion: {
                expanded: false,
                collapsedMaxHeight: 200,
                onToggle: onToggleExpanded,
            },
        };

        const screen = await renderScreen(
            <AgentInput
                {...expansionProps}
                sessionId="session-1"
                value=""
                placeholder="Type"
                onChangeText={() => {}}
                onSend={() => {}}
                autocompleteKinds={[]}
                autocompleteSuggestions={async () => []}
                inputMaxHeight={200}
                maxPanelHeight={700}
            />,
        );

        expect(screen.tree.root.findAllByProps({ testID: 'agent-input-expand-toggle' })).toHaveLength(0);

        const input = screen.tree.root.findByType('MultiTextInput');
        expect(input.props.onContentHeightChange).toEqual(expect.any(Function));
        await act(async () => {
            input.props.onContentHeightChange(220);
        });

        const toggle = screen.tree.root.findByProps({ testID: 'agent-input-expand-toggle' });
        expect(toggle.props.accessibilityRole).toBe('button');
        expect(toggle.parent?.props.testID).toBe('agent-input-composer-input-container');

        await act(async () => {
            toggle.props.onPress();
        });

        expect(onToggleExpanded).toHaveBeenCalledTimes(1);
    });

    it('keeps the existing-session input expansion toggle stable around the collapsed cap', async () => {
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
                autocompleteKinds={[]}
                autocompleteSuggestions={async () => []}
                inputMaxHeight={200}
                maxPanelHeight={700}
            />,
        );

        const input = screen.tree.root.findByType('MultiTextInput');
        const findExpansionToggleButtons = () => screen.tree.root.findAll((node: any) => (
            node.props?.testID === 'agent-input-expand-toggle'
            && node.props?.accessibilityRole === 'button'
        ));

        await act(async () => {
            input.props.onContentHeightChange(220);
        });
        expect(findExpansionToggleButtons().length).toBeGreaterThan(0);

        await act(async () => {
            input.props.onContentHeightChange(198);
        });
        expect(findExpansionToggleButtons().length).toBeGreaterThan(0);

        await act(async () => {
            input.props.onContentHeightChange(180);
        });
        expect(findExpansionToggleButtons()).toHaveLength(0);
    });

    it('keeps mobile action controls in two visible scrollable chip rows without the keyboard', async () => {
        keyboardMockState.height = 0;
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
                autocompleteKinds={[]}
                autocompleteSuggestions={async () => []}
            />,
        );

        const horizontalScrollViews = screen.tree.root.findAll((node: any) => (
            node?.type === 'ScrollView' && node?.props?.horizontal === true
        ));
        expect(horizontalScrollViews).toHaveLength(2);

        let secondScrollWrapper: any = horizontalScrollViews[1]?.parent ?? null;
        while (secondScrollWrapper && secondScrollWrapper.type !== 'View') {
            secondScrollWrapper = secondScrollWrapper.parent;
        }
        const secondScrollWrapperStyle = Array.isArray(secondScrollWrapper?.props?.style)
            ? secondScrollWrapper?.props?.style
            : [secondScrollWrapper?.props?.style];
        expect(secondScrollWrapperStyle).toEqual(expect.arrayContaining([
            expect.objectContaining({
                minHeight: expect.any(Number),
            }),
        ]));
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
                autocompleteKinds={[]}
                autocompleteSuggestions={async () => []}
            />,
        );

        const pathChip = screen.tree.root.findByProps({ testID: 'agent-input-path-chip' });
        const textNodes = pathChip.findAll((node: any) => node?.type === 'Text');
        expect(textNodes.length).toBeGreaterThan(0);
        storageSettings = { ...storageSettings, agentInputChipDensity: 'labels' };
    });

    it('ignores fractional duplicate layout measurements that resolve to the same pixel', async () => {
        keyboardMockState.height = 320;
        vi.resetModules();
        const { act } = await import('react-test-renderer');
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
                autocompleteKinds={[]}
                autocompleteSuggestions={async () => []}
            />,
        );

        const panel = screen.tree.root.findByProps({ testID: 'agent-input-drop-zone' });
        const inputContainer = screen.tree.root.findByProps({ testID: 'agent-input-composer-input-container' });

        await act(async () => {
            panel.props.onLayout({ nativeEvent: { layout: { height: 170.2 } } });
            inputContainer.props.onLayout({ nativeEvent: { layout: { height: 60.2 } } });
        });

        const renderCountAfterInitialMeasurements = multiTextInputMockState.renderCount;

        await act(async () => {
            panel.props.onLayout({ nativeEvent: { layout: { height: 170.8 } } });
            inputContainer.props.onLayout({ nativeEvent: { layout: { height: 60.8 } } });
        });

        expect(multiTextInputMockState.renderCount).toBe(renderCountAfterInitialMeasurements);
    });
});
