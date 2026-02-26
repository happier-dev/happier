import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const rn = await import('@/dev/reactNativeStub');
    return {
        ...rn,
        View: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
            React.createElement('View', props, props.children),
        Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
            React.createElement('Text', props, props.children),
        Pressable: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
            React.createElement('Pressable', props, props.children),
        ScrollView: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
            React.createElement('ScrollView', props, props.children),
        ActivityIndicator: (props: Record<string, unknown>) => React.createElement('ActivityIndicator', props, null),
        Platform: { ...rn.Platform, OS: 'ios', select: (v: any) => v.ios },
        useWindowDimensions: () => ({ width: 800, height: 600 }),
        Dimensions: {
            get: () => ({ width: 800, height: 600, scale: 1, fontScale: 1 }),
        },
    };
});

vi.mock('react-native-unistyles', () => ({
    StyleSheet: {
        create: (styles: any) => {
            const theme = {
                colors: {
                    input: { background: '#fff' },
                    button: {
                        primary: { background: '#000', tint: '#fff' },
                        secondary: { tint: '#000', surface: '#fff' },
                    },
                    radio: { active: '#000', inactive: '#ddd' },
                    text: '#000',
                    textSecondary: '#666',
                    divider: '#ddd',
                    success: '#0a0',
                    textDestructive: '#a00',
                    surfacePressed: '#eee',
                    permission: {
                        acceptEdits: '#0a0',
                        bypass: '#0a0',
                        plan: '#0a0',
                        readOnly: '#0a0',
                        safeYolo: '#0a0',
                        yolo: '#0a0',
                    },
                    surfaceHighest: '#fafafa',
                },
            };
            return typeof styles === "function" ? styles(theme) : styles;
        },
    },
    useUnistyles: () => ({
        theme: {
            colors: {
                input: { background: '#fff' },
                button: {
                    primary: { background: '#000', tint: '#fff' },
                    secondary: { tint: '#000', surface: '#fff' },
                },
                radio: { active: '#000', inactive: '#ddd' },
                text: '#000',
                textSecondary: '#666',
                divider: '#ddd',
                success: '#0a0',
                textDestructive: '#a00',
                surfacePressed: '#eee',
                permission: {
                    acceptEdits: '#0a0',
                    bypass: '#0a0',
                    plan: '#0a0',
                    readOnly: '#0a0',
                    safeYolo: '#0a0',
                    yolo: '#0a0',
                },
                surfaceHighest: '#fafafa',
            },
        },
    }),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: (props: Record<string, unknown>) => React.createElement('Ionicons', props, null),
    Octicons: (props: Record<string, unknown>) => React.createElement('Octicons', props, null),
}));

vi.mock('expo-image', () => ({
    Image: (props: Record<string, unknown>) => React.createElement('Image', props, null),
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Text', props, props.children),
}));

vi.mock('@/components/ui/layout/layout', () => ({
    layout: { maxWidth: 800, headerMaxWidth: 800 },
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useSetting: (key: string) => {
        if (key === 'profiles') return [];
        if (key === 'agentInputEnterToSend') return true;
        if (key === 'agentInputActionBarLayout') return 'collapsed';
        if (key === 'agentInputChipDensity') return 'labels';
        if (key === 'sessionPermissionModeApplyTiming') return 'immediate';
        return null;
    },
    useSettings: () => ({
        profiles: [],
        agentInputEnterToSend: true,
        agentInputActionBarLayout: 'collapsed',
        agentInputChipDensity: 'labels',
        sessionPermissionModeApplyTiming: 'immediate',
    }),
    useSessionMessages: () => ({ messages: [], isLoaded: true }),
}));

vi.mock('@/sync/domains/state/storageStore', () => ({
    getStorage: () => (selector: any) => selector({ sessionMessages: {} }),
}));

vi.mock('@/agents/catalog/catalog', () => ({
    AGENT_IDS: ['codex', 'claude', 'opencode', 'gemini'],
    DEFAULT_AGENT_ID: 'codex',
    resolveAgentIdFromFlavor: () => null,
    getAgentCore: () => ({ displayNameKey: 'agents.codex', toolRendering: { hideUnknownToolsByDefault: false } }),
}));

vi.mock('@/sync/domains/models/modelOptions', () => ({
    getModelOptionsForSession: () => [{ value: 'default', label: 'Default' }],
    supportsFreeformModelSelectionForSession: () => false,
}));

vi.mock('@/sync/domains/models/describeEffectiveModelMode', () => ({
    describeEffectiveModelMode: () => ({ effectiveModelId: 'default' }),
}));

vi.mock('@/sync/domains/permissions/permissionModeOptions', () => ({
    getPermissionModeBadgeLabelForAgentType: () => 'Default',
    getPermissionModeLabelForAgentType: () => 'Default',
    getPermissionModeOptionsForSession: () => [{ value: 'default', label: 'Default' }],
    getPermissionModeTitleForAgentType: () => 'Permissions',
}));

vi.mock('@/sync/domains/permissions/describeEffectivePermissionMode', () => ({
    describeEffectivePermissionMode: () => ({ effectiveMode: 'default' }),
}));

vi.mock('@/components/ui/forms/MultiTextInput', () => ({
    MultiTextInput: (props: Record<string, unknown>) => React.createElement('MultiTextInput', props, null),
}));

vi.mock('@/components/ui/buttons/PrimaryCircleIconButton', () => ({
    PrimaryCircleIconButton: () => null,
}));

vi.mock('@/components/ui/lists/ActionListSection', () => ({
    ActionListSection: () => null,
}));

vi.mock('@/components/ui/forms/Switch', () => ({
    Switch: (props: Record<string, unknown>) => React.createElement('Switch', props, null),
}));

vi.mock('@/components/ui/theme/haptics', () => ({
    hapticsLight: () => {},
    hapticsError: () => {},
}));

vi.mock('@/components/ui/feedback/Shaker', () => ({
    Shaker: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement(React.Fragment, null, props.children),
}));

vi.mock('@/components/ui/status/StatusDot', () => ({
    StatusDot: () => null,
}));

vi.mock('@/components/autocomplete/useActiveWord', () => ({
    useActiveWord: () => ({ word: '', start: 0, end: 0 }),
}));

vi.mock('@/components/autocomplete/useActiveSuggestions', () => ({
    useActiveSuggestions: () => [[], 0, () => {}, () => {}],
}));

vi.mock('@/components/autocomplete/applySuggestion', () => ({
    applySuggestion: (text: string) => ({ text, cursorPosition: text.length }),
}));

type CapturedPopoverProps = Record<string, unknown> & {
    open: boolean;
    anchorRef: React.RefObject<any>;
    maxHeightCap?: number;
    maxWidthCap?: number;
    boundaryRef?: React.RefObject<any> | null;
    portal?: { matchAnchorWidth?: boolean };
};

const captured: { last: CapturedPopoverProps | null } = { last: null };
vi.mock('@/components/ui/popover', () => ({
    Popover: (props: CapturedPopoverProps) => {
        captured.last = props;
        return null;
    },
}));

vi.mock('@/components/ui/overlays/FloatingOverlay', () => ({
    FloatingOverlay: () => null,
}));

vi.mock('@/components/ui/scroll/useScrollEdgeFades', () => ({
    useScrollEdgeFades: () => ({
        canScrollX: false,
        visibility: { left: false, right: false },
        onViewportLayout: () => {},
        onContentSizeChange: () => {},
        onScroll: () => {},
        onMomentumScrollEnd: () => {},
    }),
}));

vi.mock('@/components/ui/scroll/ScrollEdgeFades', () => ({
    ScrollEdgeFades: () => null,
}));

vi.mock('@/components/ui/scroll/ScrollEdgeIndicators', () => ({
    ScrollEdgeIndicators: () => null,
}));

vi.mock('@/components/sessions/sourceControl/status', () => ({
    SourceControlStatusBadge: () => null,
    useHasMeaningfulScmStatus: () => false,
}));

vi.mock('@/components/model/ModelPickerOverlay', () => ({
    ModelPickerOverlay: () => null,
}));

vi.mock('@/hooks/ui/useKeyboardHeight', () => ({
    useKeyboardHeight: () => 0,
}));

vi.mock('@/modal', () => ({
    Modal: { alert: vi.fn() },
}));

vi.mock('@/sync/acp/sessionModeControl', () => ({
    computeAcpPlanModeControl: () => null,
    computeAcpSessionModePickerControl: () => null,
}));

vi.mock('@/sync/acp/configOptionsControl', () => ({
    computeAcpConfigOptionControls: () => null,
}));

vi.mock('./components/PermissionModePicker', () => ({
    PermissionModePicker: () => null,
}));

describe('AgentInput (settings popover props)', () => {
    it('anchors the settings popover to the gear button and sizes relative to the agent input', async () => {
        const { AgentInput } = await import('./AgentInput');

        let tree: renderer.ReactTestRenderer;
        act(() => {
            tree = renderer.create(
                <AgentInput
                    value=""
                    placeholder="Type"
                    onChangeText={() => {}}
                    onSend={() => {}}
                    autocompletePrefixes={[]}
                    autocompleteSuggestions={async () => []}
                />
            );
        });

        const gearPressable = tree!.root
            .findAll((n: any) => n?.type === 'Pressable')
            .find((pressable: any) => {
                const gearIcons = pressable.findAll(
                    (n: any) => n?.type === 'Octicons' && n?.props?.name === 'gear'
                );
                return gearIcons.length > 0;
            });

        expect(gearPressable).toBeTruthy();
        expect(typeof gearPressable!.props.onPress).toBe('function');

        captured.last = null;
        act(() => {
            gearPressable!.props.onPress();
        });

        const popoverProps = captured.last;
        expect(popoverProps?.open).toBe(true);
        expect(popoverProps?.anchorRef).toBe(gearPressable!.props.ref);
        expect(popoverProps?.boundaryRef).toBe(null);
        expect(popoverProps?.maxHeightCap).toBe(400);
        expect(popoverProps?.maxWidthCap).toBe(800);
        expect(popoverProps?.portal?.matchAnchorWidth).toBe(false);

        act(() => tree!.unmount());
    });
});

