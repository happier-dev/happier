import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

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
    return root.findAll((node: any) => typeof node?.props?.testID === 'string')
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

    vi.doMock('@/hooks/server/useFeatureEnabled', () => ({
        useFeatureEnabled: () => false,
    }));

    vi.doMock('@/hooks/ui/useKeyboardHeight', () => ({
        useKeyboardHeight: () => 0,
    }));

    vi.doMock('@/hooks/session/useUserMessageHistory', () => ({
        useUserMessageHistory: () => ({ reset: () => { }, moveUp: () => { }, moveDown: () => { }, setText: () => { } }),
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

    vi.doMock('@/components/ui/popover', () => ({
        Popover: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
            React.createElement(React.Fragment, null, props.children),
    }));

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

    vi.doMock('@/components/tools/normalization/policy/permissionSummary', () => ({
        formatPermissionRequestSummary: () => '',
    }));

    vi.doMock('@/components/sessions/sourceControl/status', () => ({
        SourceControlStatusBadge: () => null,
        useHasMeaningfulScmStatus: () => false,
    }));

    vi.doMock('@/components/sessions/pickers/OptionPickerOverlay', () => ({
        OptionPickerOverlay: () => null,
    }));

    vi.doMock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

    vi.doMock('@/agents/catalog/catalog', () => ({
        AGENT_IDS: ['codex'],
        DEFAULT_AGENT_ID: 'codex',
        resolveAgentIdFromFlavor: () => null,
        getAgentCore: () => ({ displayNameKey: 'agents.codex', toolRendering: { hideUnknownToolsByDefault: false } }),
    getAgentBehavior: (agentId: string) => ({
        sessionUsage: {
            supportsExactContextUsageBadge: agentId !== 'codex' && agentId !== 'gemini',
        },
    }),
    }));

    vi.doMock('@/sync/domains/models/modelOptions', () => ({
        getModelOptionsForSession: () => [{ value: 'default', label: 'Default' }],
        supportsFreeformModelSelectionForSession: () => false,
    }));

    vi.doMock('@/sync/domains/models/describeEffectiveModelMode', () => ({
        describeEffectiveModelMode: () => ({ effectiveModelId: 'default' }),
    }));

    vi.doMock('@/sync/domains/permissions/permissionModeOptions', () => ({
        getPermissionModeBadgeLabelForAgentType: () => 'Default',
        getPermissionModeLabelForAgentType: () => 'Default',
        getPermissionModeOptionsForSession: () => [{ value: 'default', label: 'Default' }],
        getPermissionModeTitleForAgentType: () => 'Permissions',
    }));

    vi.doMock('@/sync/domains/permissions/describeEffectivePermissionMode', () => ({
        describeEffectivePermissionMode: () => ({ effectiveMode: 'default' }),
    }));

    vi.doMock('./ResumeChip', () => ({
        ResumeChip: (props: Record<string, unknown>) => React.createElement('ResumeChip', props, null),
        formatResumeChipLabel: () => '',
        RESUME_CHIP_ICON_NAME: 'play',
        RESUME_CHIP_ICON_SIZE: 12,
    }));

    vi.doMock('./PathAndResumeRow', () => ({
        PathAndResumeRow: () => null,
    }));

    vi.doMock('./components/AgentInputAutocomplete', () => ({
        AgentInputAutocomplete: () => null,
    }));
}

function mockSettings() {
    vi.doMock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    return createPartialStorageModuleMock(importOriginal, {
    useSetting: (key: string) => {
                if (key === 'profiles') return [];
                if (key === 'agentInputEnterToSend') return true;
                if (key === 'agentInputActionBarLayout') return 'scroll';
                if (key === 'agentInputChipDensity') return 'labels';
                if (key === 'sessionPermissionModeApplyTiming') return 'immediate';
                return null;
            },
});
});
}

function mockScrollEdgeFades(params: { canScrollX: boolean; showRight: boolean }) {
    vi.doMock('@/components/ui/scroll/useScrollEdgeFades', () => ({
        useScrollEdgeFades: () => ({
            canScrollX: params.canScrollX,
            canScrollY: false,
            visibility: { left: false, right: params.showRight, top: false, bottom: false },
            onViewportLayout: () => {},
            onContentSizeChange: () => {},
            onScroll: () => {},
        }),
    }));
}

describe('AgentInput (action bar scroll layout)', () => {
    it('keeps both chip rows horizontally scrollable on web', async () => {
        vi.resetModules();
        vi.clearAllMocks();
        await mockWebPlatform();
        mockCommonDeps();
        mockSettings();
        mockScrollEdgeFades({ canScrollX: false, showRight: false });

        const { AgentInput } = await import('./AgentInput');

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
                    autocompletePrefixes={[]}
                    autocompleteSuggestions={async () => []}
                />)).tree;

        const scrollViews = getActionBarScrollViews(tree!);
        expect(scrollViews).toHaveLength(2);
        for (const scrollView of scrollViews) {
            expect(scrollView.props?.horizontal).toBe(true);
            expect(scrollView.props?.scrollEnabled).toBe(true);
            expect(typeof scrollView.props?.onWheel).toBe('function');
            expect(typeof scrollView.props?.onContentSizeChange).toBe('function');
        }

        act(() => tree!.unmount());
    });

    it('keeps the primary scroll row content padded with the right gutter for fades', async () => {
        vi.resetModules();
        vi.clearAllMocks();
        await mockWebPlatform();
        mockCommonDeps();
        mockSettings();
        mockScrollEdgeFades({ canScrollX: true, showRight: true });

        const { AgentInput } = await import('./AgentInput');

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
                    autocompletePrefixes={[]}
                    autocompleteSuggestions={async () => []}
                />)).tree;

        const scrollView = getActionBarScrollView(tree!, 0);
        expect(typeof scrollView?.props?.onContentSizeChange).toBe('function');

        const contentContainer = getActionBarContentView(tree!, 0);
        expect(typeof contentContainer?.props?.onLayout).toBe('undefined');

        const style = flattenStyle(contentContainer.props.style);
        expect(typeof style.paddingRight).toBe('number');
        expect((style.paddingRight as number) > 6).toBe(true);

        act(() => tree!.unmount());
    });

    it('keeps primary chips in the first scroll row and machine/path/resume in the second', async () => {
        vi.resetModules();
        vi.clearAllMocks();
        await mockWebPlatform();
        mockCommonDeps();
        mockSettings();
        mockScrollEdgeFades({ canScrollX: true, showRight: true });

        const { AgentInput } = await import('./AgentInput');

        let tree: renderer.ReactTestRenderer;
        tree = (await renderScreen(<AgentInput
                    value=""
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
                    autocompletePrefixes={[]}
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
        vi.resetModules();
        vi.clearAllMocks();
        await mockWebPlatform();
        mockCommonDeps();
        mockSettings();
        mockScrollEdgeFades({ canScrollX: true, showRight: true });

        const { AgentInput } = await import('./AgentInput');

        let tree: renderer.ReactTestRenderer;
        tree = (await renderScreen(<AgentInput
                    value=""
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
                        render: () => React.createElement('View', { testID: 'agent-input-delivery-chip' }),
                    }]}
                    autocompletePrefixes={[]}
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
            'agent-input-abort',
            'agent-input-delivery-chip',
        ]);
        expect(secondaryRowIds).toEqual([
            'agent-input-machine-chip',
            'agent-input-path-chip',
        ]);

        act(() => tree!.unmount());
    });
});
