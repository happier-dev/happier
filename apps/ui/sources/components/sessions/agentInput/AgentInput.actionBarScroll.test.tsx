import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function flattenStyle(style: any): Record<string, unknown> {
    if (!style) return {};
    if (Array.isArray(style)) {
        return style.reduce((acc, s) => ({ ...acc, ...flattenStyle(s) }), {});
    }
    if (typeof style === 'object') return style;
    return {};
}

async function mockWebPlatform() {
    vi.doMock('react-native', async () => {
        const actual = await vi.importActual<any>('react-native');
        return {
            ...actual,
            Platform: {
                ...actual.Platform,
                OS: 'web',
                select: (v: any) => v?.web ?? v?.default ?? actual.Platform.select(v),
            },
        };
    });
}

function mockCommonDeps() {
    vi.doMock('@/text', () => ({
        t: (key: string) => key,
    }));

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

    vi.doMock('@/components/model/ModelPickerOverlay', () => ({
        ModelPickerOverlay: () => null,
    }));

    vi.doMock('@/modal', () => ({
        Modal: { alert: vi.fn() },
    }));

    vi.doMock('@/agents/catalog/catalog', () => ({
        AGENT_IDS: ['codex'],
        DEFAULT_AGENT_ID: 'codex',
        resolveAgentIdFromFlavor: () => null,
        getAgentCore: () => ({ displayNameKey: 'agents.codex', toolRendering: { hideUnknownToolsByDefault: false } }),
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
    vi.doMock('@/sync/domains/state/storage', () => ({
        useSetting: (key: string) => {
            if (key === 'profiles') return [];
            if (key === 'agentInputEnterToSend') return true;
            if (key === 'agentInputActionBarLayout') return 'scroll';
            if (key === 'agentInputChipDensity') return 'labels';
            if (key === 'sessionPermissionModeApplyTiming') return 'immediate';
            return null;
        },
    }));
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
    it('enables horizontal scrolling on web even when fades cannot measure overflow', async () => {
        vi.resetModules();
        vi.clearAllMocks();
        await mockWebPlatform();
        mockCommonDeps();
        mockSettings();
        mockScrollEdgeFades({ canScrollX: false, showRight: false });

        const { AgentInput } = await import('./AgentInput');

        let tree: renderer.ReactTestRenderer;
        act(() => {
            tree = renderer.create(
                <AgentInput
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
                />
            );
        });

        const scrollViews = tree!.root.findAll((n: any) => n?.type === 'ScrollView');
        expect(scrollViews).toHaveLength(1);
        expect(scrollViews[0]?.props?.horizontal).toBe(true);
        expect(scrollViews[0]?.props?.scrollEnabled).toBe(true);
        expect(typeof scrollViews[0]?.props?.onWheel).toBe('function');
        expect(typeof scrollViews[0]?.props?.onContentSizeChange).toBe('function');

        act(() => tree!.unmount());
    });

    it('measures scroll content via onContentSizeChange and includes right gutter padding', async () => {
        vi.resetModules();
        vi.clearAllMocks();
        await mockWebPlatform();
        mockCommonDeps();
        mockSettings();
        mockScrollEdgeFades({ canScrollX: true, showRight: true });

        const { AgentInput } = await import('./AgentInput');

        let tree: renderer.ReactTestRenderer;
        act(() => {
            tree = renderer.create(
                <AgentInput
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
                />
            );
        });

        const scrollView = tree!.root.find((n: any) => n?.type === 'ScrollView');
        expect(typeof scrollView?.props?.onContentSizeChange).toBe('function');

        const contentContainer = scrollView.find((n: any) => n?.type === 'View');
        expect(typeof contentContainer?.props?.onLayout).toBe('undefined');

        const style = flattenStyle(contentContainer.props.style);
        expect(typeof style.paddingRight).toBe('number');
        expect((style.paddingRight as number) > 6).toBe(true);

        act(() => tree!.unmount());
    });
});
