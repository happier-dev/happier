import React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import renderer from 'react-test-renderer';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installAgentInputCommonModuleMocks } from './agentInputTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mockEnv = vi.hoisted(() => ({
    windowWidth: 800,
    agentInputChipDensity: 'labels' as 'auto' | 'labels' | 'icons',
    iconsRenderAsText: false,
}));

function collectText(node: any, out: string[] = []): string[] {
    if (node === null || node === undefined) return out;
    if (typeof node === 'string' || typeof node === 'number') {
        out.push(String(node));
        return out;
    }
    if (Array.isArray(node)) {
        for (const item of node) collectText(item, out);
        return out;
    }
    if (typeof node === 'object') {
        if (node.children) collectText(node.children, out);
        return out;
    }
    return out;
}

function collectBadRawTextNodes(node: any, parentType: string | null = null, out: Array<{ parent: string | null; value: string }> = []) {
    if (node === null || node === undefined) return out;
    if (typeof node === 'string' || typeof node === 'number') {
        const value = String(node);
        if (parentType !== 'Text' && value.trim().length > 0) out.push({ parent: parentType, value });
        return out;
    }
    if (Array.isArray(node)) {
        for (const item of node) collectBadRawTextNodes(item, parentType, out);
        return out;
    }
    if (typeof node === 'object') {
        const nextParent = typeof node.type === 'string' ? node.type : parentType;
        if (node.children) collectBadRawTextNodes(node.children, nextParent, out);
        return out;
    }
    return out;
}

installAgentInputCommonModuleMocks({
    icons: () => ({
        Ionicons: (props: Record<string, unknown>) => (
            mockEnv.iconsRenderAsText ? <>{'.'}</> : React.createElement('Ionicons', props, null)
        ),
        Octicons: (props: Record<string, unknown>) => (
            mockEnv.iconsRenderAsText ? <>{'.'}</> : React.createElement('Octicons', props, null)
        ),
    }),
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
            ActivityIndicator: (props: Record<string, unknown>) => React.createElement('ActivityIndicator', props, null),
            Platform: {
                OS: 'ios',
                select: (v: any) => v.ios,
            },
            AppState: {
                addEventListener: vi.fn(() => ({ remove: vi.fn() })),
            },
            useWindowDimensions: () => ({ width: mockEnv.windowWidth, height: 600 }),
            Dimensions: {
                get: () => ({ width: mockEnv.windowWidth, height: 600, scale: 1, fontScale: 1 }),
            },
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useSetting: (key: string) => {
                if (key === 'profiles') return [];
                if (key === 'agentInputEnterToSend') return true;
                if (key === 'agentInputActionBarLayout') return 'wrap';
                if (key === 'agentInputChipDensity') return mockEnv.agentInputChipDensity;
                if (key === 'sessionPermissionModeApplyTiming') return 'immediate';
                return null;
            },
            useSettings: () => ({
                profiles: [],
                agentInputEnterToSend: true,
                agentInputActionBarLayout: 'wrap',
                agentInputChipDensity: mockEnv.agentInputChipDensity,
                sessionPermissionModeApplyTiming: 'immediate',
            }),
            useSessionMessages: () => ({ messages: [], isLoaded: true }),
            useSessionTranscriptIds: () => ({ ids: [], isLoaded: true }),
            useSessionMessagesById: () => ({}),
            useSessionMessagesVersion: () => 0,
            useSessionMessagesReducerState: () => null,
        });
    },
});

vi.mock('expo-image', () => ({
    Image: (props: Record<string, unknown>) => React.createElement('Image', props, null),
}));

vi.mock('@/components/tools/shell/permissions/PermissionFooter', () => ({
    PermissionFooter: () => null,
}));

vi.mock('@/sync/domains/state/storageStore', () => ({
    getStorage: () => (selector: any) => selector({ sessionMessages: {} }),
}));

vi.mock('@/sync/store/hooks', () => ({
    useLocalSetting: () => 1,
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
    PopoverScope: ({ children }: any) => React.createElement(React.Fragment, null, children),
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

vi.mock('@/components/sessions/pickers/OptionPickerOverlay', () => ({
    OptionPickerOverlay: () => null,
}));

vi.mock('@/hooks/ui/useKeyboardHeight', () => ({
    useKeyboardHeight: () => 0,
}));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

vi.mock('@/sync/domains/sessionControl/sessionModeControl', () => ({
    computeSessionModePickerControl: () => null,
}));

vi.mock('@/sync/domains/sessionControl/configOptionsControl', () => ({
    computeSessionConfigOptionControls: () => null,
}));

describe('AgentInput (machine chip)', () => {
    let AgentInput: (typeof import('./AgentInput'))['AgentInput'];
    let tree: renderer.ReactTestRenderer | null = null;

    beforeAll(async () => {
        const imported = await import('./AgentInput');
        AgentInput = imported.AgentInput;
    }, 120_000);

    beforeEach(() => {
        mockEnv.windowWidth = 800;
        mockEnv.agentInputChipDensity = 'labels';
        mockEnv.iconsRenderAsText = false;
    });

    afterEach(() => {
        standardCleanup();
    });

    it('renders a select-machine label when machine is not yet selected', async () => {
        tree = (await renderScreen(React.createElement(AgentInput, {
                    value: 'hello',
                    placeholder: 'placeholder',
                    onChangeText: () => {},
                    onSend: () => {},
                    autocompletePrefixes: [],
                    autocompleteSuggestions: async () => [],
                    onMachineClick: () => {},
                    currentPath: '/tmp',
                    onPathClick: () => {},
                }))).tree;

        const text = collectText(tree?.toJSON());
        expect(text.join(' ')).toContain('newSession.selectMachineTitle');
    });

    it('does not emit raw text nodes under non-Text parents when chip icons render as text', async () => {
        mockEnv.iconsRenderAsText = true;

        tree = (await renderScreen(React.createElement(AgentInput, {
                    value: 'hello',
                    placeholder: 'placeholder',
                    onChangeText: () => {},
                    onSend: () => {},
                    onPermissionClick: () => {},
                    agentType: 'codex',
                    onAgentClick: () => {},
                    machineName: 'Machine One',
                    onMachineClick: () => {},
                    currentPath: '/tmp/project',
                    onPathClick: () => {},
                    autocompletePrefixes: [],
                    autocompleteSuggestions: async () => [],
                }))).tree;

        const badNodes = collectBadRawTextNodes(tree?.toJSON());
        expect(badNodes).toEqual([]);
    });

    it('shows labels on narrow screens when chip density is auto', async () => {
        mockEnv.windowWidth = 390;
        mockEnv.agentInputChipDensity = 'auto';
        tree = (await renderScreen(React.createElement(AgentInput, {
                    value: 'hello',
                    placeholder: 'placeholder',
                    onChangeText: () => {},
                    onSend: () => {},
                    autocompletePrefixes: [],
                    autocompleteSuggestions: async () => [],
                    onMachineClick: () => {},
                    currentPath: '/tmp',
                    onPathClick: () => {},
                }))).tree;

        const text = collectText(tree?.toJSON());
        expect(text.join(' ')).toContain('newSession.selectMachineTitle');
    });

    it('renders a select-path label when path is not yet selected (new-session bootstrap)', async () => {
        tree = (await renderScreen(React.createElement(AgentInput, {
                    value: 'hello',
                    placeholder: 'placeholder',
                    onChangeText: () => {},
                    onSend: () => {},
                    autocompletePrefixes: [],
                    autocompleteSuggestions: async () => [],
                    onMachineClick: () => {},
                    currentPath: '',
                    onPathClick: () => {},
                }))).tree;

        const text = collectText(tree?.toJSON());
        expect(text.join(' ')).toContain('newSession.selectPathTitle');
    });

    it('exposes a stable testID for the connection status text (UI e2e locator)', async () => {
        const screen = await renderScreen(React.createElement(AgentInput, {
                    value: '',
                    placeholder: 'placeholder',
                    onChangeText: () => {},
                    onSend: () => {},
                    autocompletePrefixes: [],
                    autocompleteSuggestions: async () => [],
                    connectionStatus: {
                        text: 'online',
                        color: '#0a0',
                        dotColor: '#0a0',
                        isPulsing: false,
                    },
                }));

        const connectionStatus = screen.findByTestId('agent-input-connection-status-text');
        expect(connectionStatus).toBeTruthy();
        expect(collectText(connectionStatus?.props?.children).join(' ')).toContain('online');
    });
});
