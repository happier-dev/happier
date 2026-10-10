// @vitest-environment jsdom
import React from 'react';
import { act, type ReactTestInstance } from 'react-test-renderer';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { storage } from '@/sync/domains/state/storageStore';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { installAgentInputCommonModuleMocks } from './agentInputTestHelpers';
import { settingsDefaults, type Settings } from '@/sync/domains/settings/settings';
import { projectAgentInputAttachmentRowItems } from './agentInputContracts';
import { findAllHostTestInstances, flattenTestStyle as flattenStyle } from '@/dev/testkit';
import { createLayoutChangeEvent } from '@/dev/testkit/fixtures/nativeEventFixtures';

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
const originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks');
beforeAll(() => {
    // jsdom has no Web Locks; this serial suite retains the real Home mutation owner.
    Object.defineProperty(navigator, 'locks', { configurable: true, value: {
        request: async (_name: string, run: () => unknown) => await run(),
    } });
});
afterAll(() => {
    if (originalLocks) Object.defineProperty(navigator, 'locks', originalLocks);
    else Reflect.deleteProperty(navigator, 'locks');
});
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

    it('separates the real Send and Voice targets in the 430px narrow web stack', async () => {
        // Unistyles creates platform styles at module load. Load the actual web
        // owner first, rather than relabeling a stylesheet created for native.
        layoutMockState.platform = 'web';
        layoutMockState.width = 430;
        storageSettings = { ...storageSettings, agentInputActionBarLayout: 'wrap' };
        const { AgentInput } = await import('./AgentInput');
        const { VoiceComposerPlanet } = await import('@/components/voice/composer/VoiceComposerPlanet');
        const screen = await renderAgentInput(<AgentInput
            value="Ready" placeholder="Type" onChangeText={() => {}} onSend={() => {}}
            onPathClick={() => {}} currentPath="/repo" autocompleteKinds={[]}
            autocompleteSuggestions={async () => []}
            trailingAccessory={<VoiceComposerPlanet pose="mic" muted={false} accessibilityLabel="Start Voice"
                accessibilityHint="Start a spoken conversation" onPress={() => {}} />}
        />);
        const submit = findAllHostTestInstances(screen.tree.root, node => (
            node.props.testID === 'new-session-composer-send'
        ))[0];
        if (!submit) throw new Error('Expected the real submit target');
        const circle = findNearestHostParent(submit);
        const shape = findNearestHostParent(circle);
        if (!shape) throw new Error('Expected the real submit shape');
        const geometry = flattenStyle(shape.props.style);
        const hitSlop = submit.props.hitSlop as { top: number; bottom: number };
        // The shape clips the native target: its padding must contain the reach,
        // and its flow footprint must include that space rather than spending it
        // again through a negative margin into the neighboring control.
        const reservedTop = Number(geometry.paddingTop ?? 0) + Number(geometry.marginTop ?? 0);
        const reservedBottom = Number(geometry.paddingBottom ?? 0) + Number(geometry.marginBottom ?? 0);
        expect(reservedTop).toBeGreaterThanOrEqual(hitSlop.top);
        expect(reservedBottom).toBeGreaterThanOrEqual(hitSlop.bottom);
        const stack = findNearestHostParent(shape);
        const stackGeometry = flattenStyle(stack?.props.style);
        expect(stackGeometry.flexDirection).toBe('column-reverse');
        const voice = findAllHostTestInstances(screen.tree.root, node => node.props.testID === 'session-composer-voice')[0];
        if (!voice) throw new Error('Expected the real Voice target');
        const voiceGeometry = flattenStyle(voice.props.style);
        // Voice's declared 8px INLINE row gap must not be spent against the narrower stack gap (web: 1px).
        // Include the neighbor's real target margin and any Send reach not allocated in flow, not only its glyph.
        const gap = Number(stackGeometry.rowGap ?? stackGeometry.gap ?? 0);
        expect(gap).toBe(1);
        const voiceTopMargin = Number(voiceGeometry.marginTop ?? voiceGeometry.marginVertical ?? 0);
        const targetSeparation = gap + voiceTopMargin + Math.min(0, reservedBottom - hitSlop.bottom);
        expect(targetSeparation).toBeGreaterThanOrEqual(0);
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

    it.each(['ios', 'web'] as const)('keeps automatic phone Session controls on one scroll track on %s', async (platform) => {
        layoutMockState.platform = platform;
        layoutMockState.width = 390;
        storageSettings = { ...storageSettings, agentInputChipDensity: 'labels' };
        const { AgentInput } = await import('./AgentInput');
        const onComposerActionBarLayoutChange = vi.fn();

        const screen = await renderAgentInput(
            <AgentInput
                sessionId="session-1"
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
                onComposerActionBarLayoutChange={onComposerActionBarLayoutChange}
            />,
        );

        const scrollViews = findAllHostTestInstances(screen.tree.root, (node) => (
            node?.type === 'ScrollView' && node?.props?.horizontal === true
        ));
        expect(onComposerActionBarLayoutChange).toHaveBeenLastCalledWith('scroll');
        expect(scrollViews).toHaveLength(1);
        expect(findAllHostTestInstances(scrollViews[0], node => (
            node.type === 'Text' && node.props.children === 'Builder'
        ))).toHaveLength(1);
        expect(findAllHostTestInstances(scrollViews[0], node => (
            node.props.testID === 'agent-input-path-chip'
        ))).toHaveLength(1);
    });

    it.each(['ios', 'web'] as const)('keeps the embedded Home collapsed controls on one reachable scroll track on %s', async (platform) => {
        layoutMockState.platform = platform;
        layoutMockState.width = 390;
        const { AgentInput } = await import('./AgentInput');
        const input = <AgentInput
            value="" placeholder="Type" onChangeText={() => {}} onSend={() => {}}
            autoActionBarLayout="collapsed"
            barControlIds={['machine', 'engine', 'actionMenu']}
            onMachineClick={() => {}} machineName="Unnamed machine"
            onAgentClick={() => {}} agentType="claude" agentLabel="Claude" engineLabel="Sonnet 4.6"
            onPermissionClick={() => {}}
            onPathClick={() => {}} currentPath="/repo"
            autocompleteKinds={[]} autocompleteSuggestions={async () => []}
        />;
        const screen = await renderAgentInput(input);

        const tracks = findAllHostTestInstances(screen.tree.root, node => (
            node.type === 'ScrollView' && node.props.horizontal === true
        ));
        expect(tracks).toHaveLength(1);
        const track = tracks[0];
        expect(findAllHostTestInstances(track, node => (
            node.type === 'Text' && node.props.children === 'Unnamed machine'
        ))).toHaveLength(1);
        expect(findAllHostTestInstances(track, node => (
            node.type === 'Text' && node.props.children === 'Sonnet 4.6'
        ))).toHaveLength(1);
        expect(findAllHostTestInstances(track, node => (
            node.props.testID === 'agent-input-action-menu-button'
        ))).toHaveLength(1);
        // Sending remains fixed beside the overflow, not scrolled off with chips.
        expect(findAllHostTestInstances(track, node => (
            node.props.testID === 'new-session-composer-send'
        ))).toHaveLength(0);

        // The person's explicit Wrap preference continues to override Home's
        // automatic collapsed presentation.
        storageSettings = { ...storageSettings, agentInputActionBarLayout: 'wrap' };
        await act(async () => { storage.setState({ settings: storageSettings }); });
        await screen.update(React.cloneElement(input, { value: 'Updated draft' }));
        expect(findAllHostTestInstances(screen.tree.root, node => (
            node.type === 'ScrollView' && node.props.horizontal === true
        ))).toHaveLength(0);
    });

    it('publishes the mounted action-bar layout when the resolved mode changes', async () => {
        layoutMockState.width = 900;
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

        expect(onComposerActionBarLayoutChange).toHaveBeenLastCalledWith('wrap');

        storageSettings = { ...storageSettings, agentInputActionBarLayout: 'scroll' };
        await act(async () => { storage.setState({ settings: storageSettings }); });
        renderRevision += 1;
        await screen.update(render());
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
        const onPanelLayout = panel.props.onLayout;
        if (!onPanelLayout) throw new Error('Expected the composer panel to report its layout');

        await act(async () => {
            onPanelLayout(createLayoutChangeEvent({ x: 0, y: 0, width: layoutMockState.width, height: 640 }));
            inputContainer?.props.onLayout(createLayoutChangeEvent({ x: 0, y: 0, width: layoutMockState.width, height: 520 }));
            actionFooter?.props.onLayout(createLayoutChangeEvent({ x: 0, y: 0, width: layoutMockState.width, height: 80 }));
            variableContentBeforeInput?.props.onLayout?.(createLayoutChangeEvent({ x: 0, y: 0, width: layoutMockState.width, height: 70 }));
        });

        expect(screen.tree.root.findByProps({ testID: 'new-session-composer-input' }).props.maxHeight).toBe(468);
    });

    it('caps native input to the measured space remaining in the host panel', async () => {
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
        const input = screen.tree.root.findByProps({ testID: 'new-session-composer-input' });
        const onPanelLayout = panel.props.onLayout;
        expect(onPanelLayout).toEqual(expect.any(Function));
        if (!onPanelLayout) throw new Error('Expected the composer panel to report its layout');
        await act(async () => {
            onPanelLayout(createLayoutChangeEvent({ x: 0, y: 0, width: 420, height: 300 }));
            input.parent?.props.onLayout(createLayoutChangeEvent({ x: 0, y: 0, width: 420, height: 200 }));
        });
        const availableInputHeight = screen.tree.root.findByProps({ testID: 'new-session-composer-input' }).props.maxHeight;
        expect(availableInputHeight).toBeGreaterThan(0);
        expect(availableInputHeight).toBeLessThanOrEqual(200);
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
        storageSettings = { ...storageSettings, composerPromptLibraryButtonEnabled: false };
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
        const onPanelLayout = panel.props.onLayout;
        if (!onPanelLayout) throw new Error('Expected the composer panel to report its layout');

        await act(async () => {
            onPanelLayout(createLayoutChangeEvent({ x: 0, y: 0, width: layoutMockState.width, height: 220 }));
            inputContainer?.props.onLayout(createLayoutChangeEvent({ x: 0, y: 0, width: layoutMockState.width, height: 60 }));
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
        const onPanelLayout = panel.props.onLayout;
        if (!onPanelLayout) throw new Error('Expected the composer panel to report its layout');

        await act(async () => {
            onPanelLayout(createLayoutChangeEvent({ x: 0, y: 0, width: layoutMockState.width, height: 436 }));
            inputContainer?.props.onLayout(createLayoutChangeEvent({ x: 0, y: 0, width: layoutMockState.width, height: 358 }));
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
