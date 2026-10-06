// @vitest-environment jsdom
import React from 'react';
import { act, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { storage } from '@/sync/domains/state/storageStore';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { installAgentInputCommonModuleMocks } from './agentInputTestHelpers';
import { settingsDefaults, type Settings } from '@/sync/domains/settings/settings';
import { projectAgentInputAttachmentRowItems } from './agentInputContracts';
import { findAllHostTestInstances } from '@/dev/testkit';

vi.mock('expo-haptics', () => ({
    impactAsync: vi.fn(async () => {}),
    notificationAsync: vi.fn(async () => {}),
    ImpactFeedbackStyle: { Light: 'Light' },
    NotificationFeedbackType: { Error: 'Error' },
}));

const layoutMockState = vi.hoisted(() => ({
    platform: 'ios' as 'ios' | 'web',
    width: 700,
    height: 800,
}));

const createAgentInputReactNativeModule = async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'ios' }, {
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
            select: <T,>(v: Partial<Record<'ios' | 'web' | 'default', T>>) => v[layoutMockState.platform] ?? v.default ?? v.ios,
        },
        useWindowDimensions: () => ({ width: layoutMockState.width, height: layoutMockState.height }),
        Dimensions: {
            get: () => ({ width: layoutMockState.width, height: layoutMockState.height, scale: 1, fontScale: 1 }),
        },
        Keyboard: {
            addListener: () => ({ remove: () => {} }),
        },
    });
};

let storageSettings: Settings = {
    ...settingsDefaults,
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

function findNearestHostParent(node: ReactTestInstance | null | undefined): ReactTestInstance | null {
    let parent = node?.parent ?? null;
    while (parent && typeof parent.type !== 'string') {
        parent = parent.parent;
    }
    return parent;
}

async function renderAgentInput(element: React.ReactElement) {
    const { renderScreen } = await import('@/dev/testkit/render/renderScreen');
    storage.setState({ settings: storageSettings });
    return renderScreen(element, { wrapper: runtime.Wrapper });
}

installAgentInputCommonModuleMocks({ reactNative: createAgentInputReactNativeModule });
const runtime = installSessionPaneRuntimeTestHarness({ sessionId: 'session-1' });

let restoreViewport: (() => void) | undefined;
afterEach(() => { restoreViewport?.(); restoreViewport = undefined; });

describe('AgentInput (action bar auto layout)', () => {
    beforeEach(() => {
        storageSettings = { ...settingsDefaults, agentInputEnterToSend: true,
            agentInputActionBarLayout: 'auto', agentInputChipDensity: 'labels',
            sessionPermissionModeApplyTiming: 'immediate' };
        layoutMockState.platform = 'ios';
        layoutMockState.width = 700;
        layoutMockState.height = 800;
    });

    it('does not subscribe to passive keyboard height while rendering the native composer', async () => {
        layoutMockState.platform = 'ios';
        const viewport = Object.assign(new EventTarget(), {
            width: 420, height: 480, offsetTop: 0,
        });
        const previous = Object.getOwnPropertyDescriptor(window, 'visualViewport');
        Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
        restoreViewport = () => {
            if (previous) Object.defineProperty(window, 'visualViewport', previous);
            else Reflect.deleteProperty(window, 'visualViewport');
        };
        const subscribe = vi.spyOn(viewport, 'addEventListener');
        const { AgentInput } = await import('./AgentInput');

        await renderAgentInput(
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

        expect(subscribe.mock.calls.filter(([event]) => event === 'resize' || event === 'scroll')).toEqual([]);
    });

    it('uses the scrollable action bar layout in auto mode on sub-tablet widths', async () => {
        storageSettings = { ...storageSettings, agentInputChipDensity: 'labels' };
        const { AgentInput } = await import('./AgentInput');

        const screen = await renderAgentInput(
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

        const scrollViews = findAllHostTestInstances(screen.tree.root, (node) => (
            node?.type === 'ScrollView' && node?.props?.horizontal === true
        ));
        expect(scrollViews.length).toBeGreaterThan(0);
        expect(scrollViews[0]?.props?.scrollEnabled).toBe(true);
    });

    it('publishes the mounted action-bar layout when the resolved mode changes', async () => {
        storageSettings = {
            ...storageSettings,
            agentInputActionBarLayout: 'auto',
        };
        const { AgentInput } = await import('./AgentInput');
        const onComposerActionBarLayoutChange = vi.fn();
        const inputProps = {
            value: '',
            placeholder: 'Type',
            onChangeText: () => {},
            onSend: () => {},
            autocompleteKinds: [],
            autocompleteSuggestions: async () => [],
            onComposerActionBarLayoutChange,
        } satisfies React.ComponentProps<typeof AgentInput> & Readonly<{
            onComposerActionBarLayoutChange: (layout: 'wrap' | 'scroll' | 'collapsed') => void;
        }>;
        let renderRevision = 0;
        const render = () => <AgentInput {...inputProps} value={`${renderRevision}`} />;

        const screen = await renderAgentInput(render());

        expect(onComposerActionBarLayoutChange).toHaveBeenLastCalledWith('scroll');

        storageSettings = {
            ...storageSettings,
            agentInputActionBarLayout: 'collapsed',
        };
        await act(async () => { storage.setState({ settings: storageSettings }); });
        renderRevision += 1;
        await screen.update(render());

        expect(onComposerActionBarLayoutChange).toHaveBeenLastCalledWith('collapsed');
    });

    it('does not apply the host panel max height on web so the composer never re-constrains from undefined to measured on switch', async () => {
        layoutMockState.platform = 'web';
        layoutMockState.width = 900;
        layoutMockState.height = 700;
        const { AgentInput } = await import('./AgentInput');
        const { WebDropTargetView } = await import('@/components/workspaces/files/repositoryTree/WebDropTargetView');

        const screen = await renderAgentInput(
            <AgentInput
                value="Long draft"
                placeholder="Type"
                onChangeText={() => {}}
                onSend={() => {}}
                autocompleteKinds={[]}
                autocompleteSuggestions={async () => []}
                maxPanelHeight={300}
                attachmentRowItems={projectAgentInputAttachmentRowItems({
                    transferAttachments: [{
                        key: 'screenshot',
                        label: 'Screenshot.png',
                        onRemove: () => {},
                        preview: { kind: 'image', uri: 'blob:screenshot' },
                    }],
                })}
            />,
        );

        const panel = screen.tree.root.findByType(WebDropTargetView);
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
        const { act } = await import('react-test-renderer');
        const { AgentInput } = await import('./AgentInput');
        const { WebDropTargetView } = await import('@/components/workspaces/files/repositoryTree/WebDropTargetView');

        const screen = await renderAgentInput(
            <AgentInput
                value="Long draft"
                placeholder="Type"
                onChangeText={() => {}}
                onSend={() => {}}
                autocompleteKinds={[]}
                autocompleteSuggestions={async () => []}
                maxPanelHeight={640}
                panelMaxHeightMode="host-constrained"
                attachmentRowItems={projectAgentInputAttachmentRowItems({
                    transferAttachments: [{
                        key: 'screenshot',
                        label: 'Screenshot.png',
                        onRemove: () => {},
                        preview: { kind: 'image', uri: 'blob:screenshot' },
                    }],
                })}
            />,
        );

        const panel = screen.tree.root.findByType(WebDropTargetView);
        const panelStyle = Object.assign(
            {},
            ...(Array.isArray(panel.props.style) ? panel.props.style : [panel.props.style]).filter(Boolean),
        );
        expect(panelStyle.maxHeight).toBe(640);

        const input = screen.tree.root.findByProps({ testID: 'new-session-composer-input' });
        const inputContainer = input.parent;
        const actionFooter = screen.tree.root.findAll((node) => {
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
        const { AgentInput } = await import('./AgentInput');
        const { WebDropTargetView } = await import('@/components/workspaces/files/repositoryTree/WebDropTargetView');

        const screen = await renderAgentInput(
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

        const panel = screen.tree.root.findByType(WebDropTargetView);
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
        const { AgentInput } = await import('./AgentInput');

        const screen = await renderAgentInput(
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

        const verticalScrollViews = findAllHostTestInstances(screen.tree.root, (node) => (
            node?.type === 'ScrollView' && node?.props?.horizontal !== true
        ));
        expect(verticalScrollViews.length).toBeGreaterThan(0);

        const actionFooter = screen.tree.root.findAll((node) => {
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
        const { AgentInput } = await import('./AgentInput');

        const screen = await renderAgentInput(
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

        const verticalScrollViews = findAllHostTestInstances(screen.tree.root, (node) => (
            node?.type === 'ScrollView' && node?.props?.horizontal !== true
        ));
        expect(verticalScrollViews).toHaveLength(0);
    });

    it('keeps many native attachment surfaces lazy and reachable through one bounded viewport while the multiline input remains its sibling', async () => {
        layoutMockState.platform = 'ios';
        const { AgentInput } = await import('./AgentInput');
        const attachmentRowItems = projectAgentInputAttachmentRowItems({
            items: Array.from({ length: 64 }, (_value, index) => ({
                kind: 'surface' as const,
                key: `native-content-${index}`,
                label: `Native content ${index}`,
                sizing: 'content' as const,
                renderedContent: React.createElement('View', { testID: `native-content-body:${index}` }),
                testID: `native-content-surface:${index}`,
            })),
        });
        const screen = await renderAgentInput(
            <AgentInput
                sessionId="session-1"
                value=""
                placeholder="Type"
                onChangeText={() => {}}
                onSend={() => {}}
                autocompleteKinds={[]}
                autocompleteSuggestions={async () => []}
                inputMaxHeight={245}
                maxPanelHeight={700}
                attachmentRowItems={attachmentRowItems}
            />,
        );
        const mountedBodies = screen.tree.root.findAll((node) => (
            typeof node?.props?.testID === 'string'
            && node.props.testID.startsWith('native-content-body:')
        ));
        const verticalScrollViews = findAllHostTestInstances(screen.tree.root, (node) => (
            node?.type === 'ScrollView' && node?.props?.horizontal !== true
        ));

        expect(mountedBodies).toHaveLength(0);
        expect(verticalScrollViews).toHaveLength(1);

        const attachmentViewport = screen.findByTestId('agent-input-native-attachment-viewport');
        const contentBand = screen.findByTestId('agent-input-attachment-content-surface-band');
        const firstSurface = screen.findByTestId('native-content-surface:0');
        const lastSurface = screen.findByTestId('native-content-surface:63');
        const attachmentRow = findNearestHostParent(contentBand);
        expect(attachmentViewport).toBeTruthy();
        expect(contentBand).toBeTruthy();
        expect(firstSurface).toBeTruthy();
        expect(lastSurface).toBeTruthy();
        expect(attachmentViewport?.findAllByProps({ testID: 'session-composer-input' })).toHaveLength(0);

        act(() => {
            attachmentViewport?.props.onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 320, height: 48 } } });
            attachmentRow?.props.onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 320, height: 64 * 48 } } });
            contentBand?.props.onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 320, height: 64 * 48 } } });
            firstSurface?.props.onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 320, height: 48 } } });
            lastSurface?.props.onLayout?.({ nativeEvent: { layout: { x: 0, y: 63 * 48, width: 320, height: 48 } } });
        });

        expect(screen.findAllByTestId('native-content-body:0')).toHaveLength(1);
        expect(screen.findAllByTestId('native-content-body:63')).toHaveLength(0);

        act(() => {
            attachmentViewport?.props.onScroll?.({ nativeEvent: { contentOffset: { x: 0, y: 63 * 48 } } });
        });

        expect(screen.findAllByTestId('native-content-body:0')).toHaveLength(0);
        expect(screen.findAllByTestId('native-content-body:63')).toHaveLength(1);
    });

    it('translates the native viewport from scroll-content coordinates into the attachment row coordinate space', async () => {
        layoutMockState.platform = 'ios';
        const { AgentInput } = await import('./AgentInput');
        const attachmentRowItems = projectAgentInputAttachmentRowItems({
            items: [{
                kind: 'surface' as const,
                key: 'native-offset-content',
                label: 'Native offset content',
                sizing: 'content' as const,
                renderedContent: React.createElement('View', { testID: 'native-offset-content-body' }),
                testID: 'native-offset-content-surface',
            }],
        });
        const screen = await renderAgentInput(
            <AgentInput
                sessionId="session-1"
                value=""
                placeholder="Type"
                onChangeText={() => {}}
                onSend={() => {}}
                autocompleteKinds={[]}
                autocompleteSuggestions={async () => []}
                inputMaxHeight={245}
                maxPanelHeight={700}
                composerInputLock={{ mode: 'editAndSubmit', reasons: ['Review required'] }}
                attachmentRowItems={attachmentRowItems}
            />,
        );
        const attachmentViewport = screen.findByTestId('agent-input-native-attachment-viewport');
        const contentBand = screen.findByTestId('agent-input-attachment-content-surface-band');
        const surface = screen.findByTestId('native-offset-content-surface');
        const attachmentRow = findNearestHostParent(contentBand);

        act(() => {
            attachmentViewport?.props.onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 320, height: 48 } } });
            attachmentRow?.props.onLayout?.({ nativeEvent: { layout: { x: 0, y: 48, width: 320, height: 48 } } });
            contentBand?.props.onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 320, height: 48 } } });
            surface?.props.onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 320, height: 48 } } });
        });

        expect(screen.findAllByTestId('native-offset-content-body')).toHaveLength(0);

        act(() => {
            attachmentViewport?.props.onScroll?.({ nativeEvent: { contentOffset: { x: 0, y: 48 } } });
        });

        expect(screen.findAllByTestId('native-offset-content-body')).toHaveLength(1);
    });

    it('reserves existing-session input expansion toggle space before the toggle appears', async () => {
        layoutMockState.platform = 'ios';
        const { act } = await import('react-test-renderer');
        const { AgentInput } = await import('./AgentInput');

        const screen = await renderAgentInput(
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

        const findExpansionToggleButtons = () => screen.tree.root.findAll((node) => (
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

    it('keeps the composer height reporter stable across web layout-only rerenders', async () => {
        layoutMockState.platform = 'web';
        layoutMockState.width = 900;
        layoutMockState.height = 700;
        const { act } = await import('react-test-renderer');
        const { AgentInput } = await import('./AgentInput');

        const screen = await renderAgentInput(
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
            />,
        );

        const firstInput = screen.tree.root.findByProps({ testID: 'session-composer-input' });
        const firstHeightReporter = firstInput.props.onContentHeightChange;

        act(() => {
            firstHeightReporter(220);
        });

        const nextInput = screen.tree.root.findByProps({ testID: 'session-composer-input' });
        expect(nextInput.props.onContentHeightChange).toBe(firstHeightReporter);
    });

    it('keeps the provided existing-session input max height as a hard cap after native panel measurement', async () => {
        layoutMockState.platform = 'ios';
        layoutMockState.width = 420;
        layoutMockState.height = 900;
        const { act } = await import('react-test-renderer');
        const { AgentInput } = await import('./AgentInput');
        const { WebDropTargetView } = await import('@/components/workspaces/files/repositoryTree/WebDropTargetView');

        const screen = await renderAgentInput(
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

        const panel = screen.tree.root.findByType(WebDropTargetView);
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
        const { act } = await import('react-test-renderer');
        const { AgentInput } = await import('./AgentInput');
        const { WebDropTargetView } = await import('@/components/workspaces/files/repositoryTree/WebDropTargetView');

        const screen = await renderAgentInput(
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

        const panel = screen.tree.root.findByType(WebDropTargetView);
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
        const { AgentInput } = await import('./AgentInput');

        const screen = await renderAgentInput(
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
        const textNodes = findAllHostTestInstances(pathChip, (node) => node?.type === 'Text');
        expect(textNodes.length).toBeGreaterThan(0);
        storageSettings = { ...storageSettings, agentInputChipDensity: 'labels' };
    });
});
