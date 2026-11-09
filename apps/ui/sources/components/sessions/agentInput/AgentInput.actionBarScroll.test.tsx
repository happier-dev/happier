import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { renderScreen as renderTestScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const scrollEdgeFadesState = vi.hoisted(() => ({
    canScrollX: false,
}));

function flattenStyle(style: any): Record<string, unknown> {
    if (!style) return {};
    if (Array.isArray(style)) {
        return style.reduce((acc, value) => ({ ...acc, ...flattenStyle(value) }), {});
    }
    if (typeof style === 'object') return style;
    return {};
}

function getActionBarScrollViews(tree: renderer.ReactTestRenderer) {
    return tree.findAll(
        (node: any) => node?.type === 'ScrollView' && node?.props?.horizontal === true,
    );
}

function getActionBarScrollView(tree: renderer.ReactTestRenderer, index = 0) {
    const scrollViews = getActionBarScrollViews(tree);
    expect(scrollViews.length).toBeGreaterThan(index);
    return scrollViews[index]!;
}

function getOrderedTestIdsWithin(
    root: renderer.ReactTestInstance,
    testIds: readonly string[],
) {
    // Host nodes only: the react-native stub's `Pressable` is a forwardRef composite that passes
    // its `testID` to a host `Pressable`, so counting composites would list every control twice.
    return root.findAll((node: any) => typeof node?.type === 'string' && typeof node?.props?.testID === 'string')
        .map((node: any) => node.props.testID)
        .filter((testID: string) => testIds.includes(testID));
}

function getActionBarContentView(tree: renderer.ReactTestRenderer, index = 0) {
    const scrollView = getActionBarScrollView(tree, index);
    return scrollView.find((node: any) => node?.type === 'View');
}

async function mockWebPlatform() {
    vi.doMock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                            Platform: {
                                OS: 'web',
                                select: (v: any) => v?.web ?? v?.default ?? v?.default ?? v?.web ?? v?.native ?? v?.ios ?? v?.android,
                            },
                        }
    );
});
}

function mockCommonDeps() {
    vi.doMock('react-native-unistyles', async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });

    vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string) => key,
    });
});

    vi.doMock('@/components/ui/theme/haptics', () => ({
        hapticsLight: () => { },
        hapticsError: () => { },
    }));

    vi.doMock('@/components/ui/forms/MultiTextInput', () => ({
        MultiTextInput: (props: Record<string, unknown>) => React.createElement('MultiTextInput', props, null),
    }));

    vi.doMock('@/components/ui/forms/Switch', () => ({
        Switch: (props: Record<string, unknown>) => React.createElement('Switch', props, null),
    }));

    vi.doMock('@/components/ui/feedback/Shaker', () => ({
        Shaker: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
            React.createElement(React.Fragment, null, props.children),
    }));

    vi.doMock('@/components/ui/popover', async (importOriginal) =>
        (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal));

    vi.doMock('@/components/ui/overlays/FloatingOverlay', () => ({
        FloatingOverlay: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
            React.createElement(React.Fragment, null, props.children),
    }));

    vi.doMock('@/components/ui/scroll/ScrollEdgeFades', () => ({
        ScrollEdgeFades: () => null,
    }));

    vi.doMock('@/components/ui/scroll/ScrollEdgeIndicators', () => ({
        ScrollEdgeIndicators: (props: Record<string, unknown>) => React.createElement('ScrollEdgeIndicators', props, null),
    }));

    vi.doMock('@/components/ui/buttons/PrimaryCircleIconButton', () => ({
        PrimaryCircleIconButton: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
            React.createElement('PrimaryCircleIconButton', props, props.children),
    }));

    vi.doMock('@/components/ui/lists/ActionListSection', () => ({
        ActionListSection: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
            React.createElement('ActionListSection', props, props.children),
    }));

    vi.doMock('@/components/ui/status/StatusDot', () => ({
        StatusDot: () => null,
    }));

    vi.doMock('@/components/ui/text/Text', () => ({
        Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
            React.createElement('Text', props, props.children),
    }));

    vi.doMock('@/components/tools/shell/permissions/PermissionFooter', () => ({
        PermissionFooter: () => null,
    }));

    vi.doMock('@/components/sessions/pickers/OptionPickerOverlay', () => ({
        OptionPickerOverlay: () => null,
    }));

    vi.doMock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

}

let restoreSettings: (() => void) | undefined;
let resetHomeBoundary: (() => Promise<void>) | undefined;

async function seedSettings() {
    const { createHomeGovernanceHarness, installHomeGovernanceBoundaries } =
        await import('@/dev/testkit/harness/homeGovernanceHarness');
    const home = createHomeGovernanceHarness();
    installHomeGovernanceBoundaries(home);
    resetHomeBoundary = () => home.reset();
    const { getStorage } = await import('@/sync/domains/state/storageStore');
    const previousSettings = getStorage().getState().settings;
    const previousLocalSettings = getStorage().getState().localSettings;
    getStorage().setState({ settings: {
        ...previousSettings,
        agentInputEnterToSend: true,
        agentInputActionBarLayout: 'scroll',
        agentInputChipDensity: 'labels',
        sessionPermissionModeApplyTiming: 'immediate',
    } });
    restoreSettings = () => getStorage().setState({ settings: previousSettings, localSettings: previousLocalSettings });
}

afterEach(async () => {
    restoreSettings?.();
    restoreSettings = undefined;
    await resetHomeBoundary?.();
    resetHomeBoundary = undefined;
});

function seedScrollMeasurements(canScrollX: boolean) {
    scrollEdgeFadesState.canScrollX = canScrollX;
}

async function renderScreen(element: React.ReactElement) {
    const screen = await renderTestScreen(element);
    // Native layout/content-size events drive the real scroll-edge owner.
    await act(async () => {
        for (const scroll of getActionBarScrollViews(screen.tree)) {
            scroll.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 200, height: 32 } } });
            scroll.props.onContentSizeChange(scrollEdgeFadesState.canScrollX ? 400 : 200, 32);
        }
    });
    return screen;
}

// Load the real source graph after its native/network boundaries, outside the
// behavioral test budget; cold transformation time is not a scrolling contract.
await mockWebPlatform();
mockCommonDeps();
await seedSettings();
const { AgentInput } = await import('./AgentInput');
restoreSettings?.();
restoreSettings = undefined;
await resetHomeBoundary?.();
resetHomeBoundary = undefined;

describe('AgentInput (action bar scroll layout)', () => {
    it('keeps both chip rows horizontally scrollable on web', async () => {
        vi.clearAllMocks();
        await mockWebPlatform();
        mockCommonDeps();
        await seedSettings();
        seedScrollMeasurements(false);

        let tree: renderer.ReactTestRenderer;
        tree = (await renderScreen(<AgentInput
                    value=""
                    placeholder="Type"
                    onChangeText={() => {}}
                    onSend={() => {}}
                    onPermissionClick={() => {}}
                    onPathClick={() => {}}
                    onResumeClick={() => {}}
                    currentPath="/tmp"
                    resumeSessionId="s2"
                    autocompleteKinds={[]}
                    autocompleteSuggestions={async () => []}
                />)).tree;

        const scrollViews = getActionBarScrollViews(tree!);
        expect(scrollViews).toHaveLength(2);
        for (const scrollView of scrollViews) {
            expect(scrollView.props?.horizontal).toBe(true);
            expect(scrollView.props?.scrollEnabled).toBe(true);
            expect(scrollView.props?.accessibilityRole).toBe('toolbar');
            expect(scrollView.props?.accessibilityLabel).toBe('agentInput.chipRail.accessibilityLabel');
            expect(typeof scrollView.props?.onKeyDown).toBe('function');
            expect(typeof scrollView.props?.onWheel).toBe('function');
            expect(typeof scrollView.props?.onContentSizeChange).toBe('function');
        }

        act(() => tree!.unmount());
    });

    it('keeps the primary scroll row content padded with the right gutter for fades', async () => {
        vi.clearAllMocks();
        await mockWebPlatform();
        mockCommonDeps();
        await seedSettings();
        seedScrollMeasurements(true);

        let tree: renderer.ReactTestRenderer;
        tree = (await renderScreen(<AgentInput
                    value=""
                    placeholder="Type"
                    onChangeText={() => {}}
                    onSend={() => {}}
                    onPermissionClick={() => {}}
                    onPathClick={() => {}}
                    onResumeClick={() => {}}
                    currentPath="/tmp"
                    resumeSessionId="s2"
                    autocompleteKinds={[]}
                    autocompleteSuggestions={async () => []}
                />)).tree;

        const scrollView = getActionBarScrollView(tree!, 0);
        expect(scrollView.props?.accessibilityHint).toBe('agentInput.chipRail.moreControlsHint');
        expect(typeof scrollView?.props?.onContentSizeChange).toBe('function');

        const contentContainer = getActionBarContentView(tree!, 0);
        expect(typeof contentContainer?.props?.onLayout).toBe('undefined');

        const style = flattenStyle(contentContainer.props.style);
        expect(typeof style.paddingRight).toBe('number');
        expect((style.paddingRight as number) > 6).toBe(true);

        act(() => tree!.unmount());
    });

    it('keeps primary chips in the first scroll row and pinned machine/path/resume in the second', async () => {
        vi.clearAllMocks();
        await mockWebPlatform();
        mockCommonDeps();
        await seedSettings();
        seedScrollMeasurements(true);

        // P3 §3.4 defaults Resume to +; explicit placement opts it into this rail.
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        getStorage().getState().applyLocalSettings({ navigationSurfacePlacementsV1: {
            composer: { orderedIds: [], placements: { resume: 'pinned' } },
        } }, { persist: false });
        let tree: renderer.ReactTestRenderer;
        tree = (await renderScreen(<AgentInput
                    value="Queue this next" // The rail carries Stop once the disc would send (P3 §3.3).
                    placeholder="Type"
                    onChangeText={() => {}}
                    onSend={() => {}}
                    onPermissionClick={() => {}}
                    onAgentClick={() => {}}
                    agentType="codex"
                    onMachineClick={() => {}}
                    machineName="Builder"
                    onPathClick={() => {}}
                    currentPath="/tmp"
                    onResumeClick={() => {}}
                    resumeSessionId="session-1"
                    onAbort={() => {}}
                    showAbortButton
                    autocompleteKinds={[]}
                    autocompleteSuggestions={async () => []}
                />)).tree;

        const primaryRowIds = getOrderedTestIdsWithin(getActionBarScrollView(tree!, 0), [
            'agent-input-permission-chip',
            'agent-input-agent-chip',
            'agent-input-abort',
            'agent-input-machine-chip',
            'agent-input-path-chip',
            'agent-input-resume-chip',
        ]);
        const secondaryRowIds = getOrderedTestIdsWithin(getActionBarScrollView(tree!, 1), [
            'agent-input-permission-chip',
            'agent-input-agent-chip',
            'agent-input-abort',
            'agent-input-machine-chip',
            'agent-input-path-chip',
            'agent-input-resume-chip',
        ]);

        expect(primaryRowIds).toEqual([
            'agent-input-agent-chip',
            'agent-input-permission-chip',
            'agent-input-abort',
        ]);
        expect(secondaryRowIds).toEqual([
            'agent-input-machine-chip',
            'agent-input-path-chip',
            'agent-input-resume-chip',
        ]);

        act(() => tree!.unmount());
    });

    it('keeps extra primary chips in the first scroll row while the secondary row stays dedicated to location controls', async () => {
        vi.clearAllMocks();
        await mockWebPlatform();
        mockCommonDeps();
        await seedSettings();
        seedScrollMeasurements(true);

        let tree: renderer.ReactTestRenderer;
        tree = (await renderScreen(<AgentInput
                    value="Queue this next" // The rail carries Stop once the disc would send (P3 §3.3).
                    placeholder="Type"
                    onChangeText={() => {}}
                    onSend={() => {}}
                    onPermissionClick={() => {}}
                    onAgentClick={() => {}}
                    agentType="codex"
                    onMachineClick={() => {}}
                    machineName="Builder"
                    onPathClick={() => {}}
                    currentPath="/tmp"
                    onAbort={() => {}}
                    showAbortButton
                    extraActionChips={[{
                        key: 'execution-run-delivery',
                        controlId: 'delivery',
                        placement: { id: 'delivery:execution-run-delivery', title: 'Delivery', pending: true },
                        render: () => React.createElement('View', { testID: 'agent-input-delivery-chip' }),
                    }]}
                    autocompleteKinds={[]}
                    autocompleteSuggestions={async () => []}
                />)).tree;

        const primaryRowIds = getOrderedTestIdsWithin(getActionBarScrollView(tree!, 0), [
            'agent-input-agent-chip',
            'agent-input-permission-chip',
            'agent-input-abort',
            'agent-input-delivery-chip',
            'agent-input-machine-chip',
            'agent-input-path-chip',
        ]);
        const secondaryRowIds = getOrderedTestIdsWithin(getActionBarScrollView(tree!, 1), [
            'agent-input-delivery-chip',
            'agent-input-machine-chip',
            'agent-input-path-chip',
        ]);

        expect(primaryRowIds).toEqual([
            'agent-input-agent-chip',
            'agent-input-permission-chip',
            'agent-input-delivery-chip',
            'agent-input-abort',
        ]);
        expect(secondaryRowIds).toEqual([
            'agent-input-machine-chip',
            'agent-input-path-chip',
        ]);

        act(() => tree!.unmount());
    });
});
