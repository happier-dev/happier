import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function findSendPressable(tree: renderer.ReactTestRenderer) {
    const pressables = tree.root.findAllByType('Pressable' as any);
    const matches = pressables.filter((node) => {
        const hitSlop = node.props?.hitSlop;
        return Boolean(hitSlop && hitSlop.top === 5 && hitSlop.bottom === 10 && typeof node.props?.onPress === 'function');
    });
    expect(matches.length).toBe(1);
    return matches[0]!;
}

vi.mock('react-native', () => ({
    View: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('View', props, props.children),
    Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Text', props, props.children),
    Pressable: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Pressable', props, props.children),
    ScrollView: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('ScrollView', props, props.children),
    ActivityIndicator: (props: Record<string, unknown>) => React.createElement('ActivityIndicator', props, null),
    Platform: { OS: 'web', select: (v: any) => v.web ?? v.default ?? null },
    useWindowDimensions: () => ({ width: 800, height: 600 }),
    Dimensions: {
        get: () => ({ width: 800, height: 600, scale: 1, fontScale: 1 }),
    },
}));

vi.mock('react-native-unistyles', () => ({
    StyleSheet: {
        create: (styles: any) => {
            const theme = {
                colors: {
                    input: { background: '#fff' },
                    button: {
                        primary: { background: '#000', tint: '#fff', disabled: '#999' },
                        secondary: { tint: '#000', surface: '#fff' },
                    },
                    radio: { active: '#000', inactive: '#ddd', dot: '#000' },
                    text: '#000',
                    textSecondary: '#666',
                    divider: '#ddd',
                    success: '#0a0',
                    textDestructive: '#a00',
                    surfacePressed: '#eee',
                },
            };
            return typeof styles === 'function' ? styles(theme) : styles;
        },
    },
    useUnistyles: () => ({
        theme: {
            colors: {
                input: { background: '#fff' },
                button: {
                    primary: { background: '#000', tint: '#fff', disabled: '#999' },
                    secondary: { tint: '#000', surface: '#fff' },
                },
                radio: { active: '#000', inactive: '#ddd', dot: '#000' },
                text: '#000',
                textSecondary: '#666',
                divider: '#ddd',
                success: '#0a0',
                textDestructive: '#a00',
                surfacePressed: '#eee',
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

vi.mock('@/components/tools/shell/permissions/PermissionFooter', () => ({
    PermissionFooter: () => null,
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

const featureEnabledState: Record<string, boolean> = { voice: true };

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => featureEnabledState[featureId] === true,
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useSetting: (key: string) => {
        if (key === 'profiles') return [];
        if (key === 'agentInputEnterToSend') return true;
        if (key === 'agentInputActionBarLayout') return 'wrap';
        if (key === 'agentInputChipDensity') return 'labels';
        if (key === 'sessionPermissionModeApplyTiming') return 'immediate';
        return null;
    },
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

vi.mock('@/components/ui/popover', () => ({
    Popover: () => null,
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

describe('AgentInput (send button accessibility)', () => {
    it('hides the voice icon when voice is disabled (no text)', async () => {
        featureEnabledState.voice = false;
        const { AgentInput } = await import('./AgentInput');

        let tree: renderer.ReactTestRenderer;
        act(() => {
            tree = renderer.create(
                <AgentInput
                    sessionId="session-1"
                    value=""
                    placeholder="Type"
                    onChangeText={() => {}}
                    onSend={() => {}}
                    onMicPress={() => {}}
                    isMicActive={false}
                    autocompletePrefixes={[]}
                    autocompleteSuggestions={async () => []}
                />
            );
        });

        const send = findSendPressable(tree!);
        const images = send.findAllByType('Image' as any);
        expect(images.length).toBe(0);

        const octicons = send.findAllByType('Octicons' as any);
        expect(octicons.some((n) => n.props?.name === 'arrow-up')).toBe(true);

        act(() => tree!.unmount());
        featureEnabledState.voice = true;
    });

    it('sets an accessible label for session creation context (no sessionId)', async () => {
        const { AgentInput } = await import('./AgentInput');

        let tree: renderer.ReactTestRenderer;
        act(() => {
            tree = renderer.create(
                <AgentInput
                    value="hello"
                    placeholder="Type"
                    onChangeText={() => {}}
                    onSend={() => {}}
                    autocompletePrefixes={[]}
                    autocompleteSuggestions={async () => []}
                />
            );
        });

        const send = findSendPressable(tree!);
        expect(send.props.accessibilityRole).toBe('button');
        expect(send.props.accessibilityLabel).toBe('newSession.title');
        act(() => tree!.unmount());
    });

    it('sets an accessibility hint when send is disabled because input is empty (no sessionId, no mic)', async () => {
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

        const send = findSendPressable(tree!);
        expect(send.props.accessibilityHint).toBe('session.inputPlaceholder');
        act(() => tree!.unmount());
    });

    it('does not set the empty-input accessibility hint when there is sendable auxiliary content', async () => {
        const { AgentInput } = await import('./AgentInput');
        const onSend = vi.fn();

        let tree: renderer.ReactTestRenderer;
        act(() => {
            tree = renderer.create(
                <AgentInput
                    sessionId="session-1"
                    value=""
                    placeholder="Type"
                    onChangeText={() => {}}
                    onSend={onSend}
                    hasSendableAttachments={true}
                    autocompletePrefixes={[]}
                    autocompleteSuggestions={async () => []}
                />
            );
        });

        const send = findSendPressable(tree!);
        expect(send.props.accessibilityHint).toBeUndefined();

        act(() => {
            send.props.onPress();
        });
        expect(onSend).toHaveBeenCalledTimes(1);

        act(() => tree!.unmount());
    });

    it('uses the session creation label when value is empty (no sessionId, no mic)', async () => {
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

        const send = findSendPressable(tree!);
        expect(send.props.accessibilityRole).toBe('button');
        expect(send.props.accessibilityLabel).toBe('newSession.title');
        act(() => tree!.unmount());
    });

    it('sets an accessible label for message sending context (sessionId present)', async () => {
        const { AgentInput } = await import('./AgentInput');

        let tree: renderer.ReactTestRenderer;
        act(() => {
            tree = renderer.create(
                <AgentInput
                    sessionId="session-1"
                    value="hello"
                    placeholder="Type"
                    onChangeText={() => {}}
                    onSend={() => {}}
                    autocompletePrefixes={[]}
                    autocompleteSuggestions={async () => []}
                />
            );
        });

        const send = findSendPressable(tree!);
        expect(send.props.accessibilityRole).toBe('button');
        expect(send.props.accessibilityLabel).toBe('common.send');
        act(() => tree!.unmount());
    });

    it('keeps the voice icon visible while mic is enabled and inactive (no text)', async () => {
        const { AgentInput } = await import('./AgentInput');

        let tree: renderer.ReactTestRenderer;
        act(() => {
            tree = renderer.create(
                <AgentInput
                    sessionId="session-1"
                    value=""
                    placeholder="Type"
                    onChangeText={() => {}}
                    onSend={() => {}}
                    onMicPress={() => {}}
                    isMicActive={false}
                    autocompletePrefixes={[]}
                    autocompleteSuggestions={async () => []}
                />
            );
        });

        const send = findSendPressable(tree!);
        const images = send.findAllByType('Image' as any);
        expect(images.length).toBe(1);

        const octicons = send.findAllByType('Octicons' as any);
        expect(octicons.some((n) => n.props?.name === 'arrow-up')).toBe(false);

        act(() => tree!.unmount());
    });

    it('shows a stop control while mic is enabled and active (no text)', async () => {
        const { AgentInput } = await import('./AgentInput');

        let tree: renderer.ReactTestRenderer;
        act(() => {
            tree = renderer.create(
                <AgentInput
                    sessionId="session-1"
                    value=""
                    placeholder="Type"
                    onChangeText={() => {}}
                    onSend={() => {}}
                    onMicPress={() => {}}
                    isMicActive={true}
                    autocompletePrefixes={[]}
                    autocompleteSuggestions={async () => []}
                />
            );
        });

        const send = findSendPressable(tree!);
        const images = send.findAllByType('Image' as any);
        expect(images.length).toBe(0);

        const ionicons = send.findAllByType('Ionicons' as any);
        expect(ionicons.some((n) => n.props?.name === 'stop-circle')).toBe(true);

        const octicons = send.findAllByType('Octicons' as any);
        expect(octicons.some((n) => n.props?.name === 'arrow-up')).toBe(false);

        act(() => tree!.unmount());
    });
});
