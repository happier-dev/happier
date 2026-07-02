import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderScreen } from '@/dev/testkit';
import { installAgentInputCommonModuleMocks } from './agentInputTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const autocompleteMockState = vi.hoisted(() => ({
    suggestions: [] as Array<{ key: string; text: string; component: React.ElementType }>,
    selected: 0,
}));

vi.mock('expo-image', () => ({
    Image: (props: Record<string, unknown>) => React.createElement('Image', props, null),
}));

vi.mock('@/components/tools/shell/permissions/PermissionFooter', () => ({
    PermissionFooter: () => null,
}));

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
            ActivityIndicator: (props: Record<string, unknown>) => React.createElement('ActivityIndicator', props, null),
            Platform: {
                OS: 'ios',
                select: (v: any) => v.ios,
            },
            useWindowDimensions: () => ({ width: 800, height: 600 }),
            Dimensions: {
                get: () => ({ width: 800, height: 600, scale: 1, fontScale: 1 }),
            },
        });
    },
    icons: async () => {
        const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
        const { Ionicons, Octicons } = createExpoVectorIconsMock();
        return {
            Ionicons: (props: Record<string, unknown>) => React.createElement(Ionicons, props, null),
            Octicons: (props: Record<string, unknown>) => React.createElement(Octicons, props, null),
        };
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
                if (key === 'agentInputChipDensity') return 'labels';
                if (key === 'sessionPermissionModeApplyTiming') return 'immediate';
                return null;
            },
            useSettings: () => ({
                profiles: [],
                agentInputEnterToSend: true,
                agentInputActionBarLayout: 'wrap',
                agentInputChipDensity: 'labels',
                sessionPermissionModeApplyTiming: 'immediate',
            }),
            useSessionMessages: () => ({ messages: [], isLoaded: true }),
            useSessionTranscriptIds: () => ({ ids: [], isLoaded: true }),
            useSessionMessagesById: () => ({}),
            useSessionMessagesVersion: () => 0,
            useSessionMessagesReducerState: () => null,
        });
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    },
});

vi.mock('@/sync/domains/state/storageStore', () => ({
    getStorage: () => Object.assign(
        (selector: any) => selector({ sessionMessages: {}, localSettings: { uiFontScale: 1, uiContentWidthMode: 'wide' } }),
        { getState: () => ({ localSettings: { uiFontScale: 1, uiContentWidthMode: 'wide' } }) },
    ),
}));

vi.mock('@/agents/catalog/catalog', () => ({
    AGENT_IDS: ['codex', 'claude', 'opencode', 'gemini'],
    DEFAULT_AGENT_ID: 'codex',
    resolveAgentIdFromFlavor: () => null,
    getAgentCore: () => ({ displayNameKey: 'agents.codex', toolRendering: { hideUnknownToolsByDefault: false } }),
}));

vi.mock('@/sync/domains/models/modelOptions', () => ({
    findModelOptionForEffectiveModelId: (options: any, effectiveModelId: any) =>
        options?.find?.((option: any) => option.value === effectiveModelId)
            ?? options?.find?.((option: any) => option.value === String(effectiveModelId ?? '').replace(/\[[^\]]*\]$/u, ''))
            ?? null,
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
    useActiveSuggestions: () => [autocompleteMockState.suggestions, autocompleteMockState.selected, () => {}, () => {}],
}));

vi.mock('@/components/autocomplete/applySuggestion', () => ({
    applySuggestion: (text: string) => ({ text, cursorPosition: text.length }),
}));

vi.mock('@/components/ui/popover', () => ({
    Popover: () => null,
    PopoverScope: ({ children }: any) => React.createElement(React.Fragment, null, children),
    MODAL_AWARE_FLOATING_POPOVER_PORTAL_OPTIONS: { web: { target: 'body' }, native: true },
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

vi.mock('@/sync/domains/sessionControl/sessionModeControl', () => ({
    computeSessionModePickerControl: () => null,
}));

vi.mock('@/sync/domains/sessionControl/configOptionsControl', () => ({
    computeSessionConfigOptionControls: () => null,
}));

const agentInputModulePromise = import('./AgentInput');

function findMultiTextInput(screen: Awaited<ReturnType<typeof renderScreen>>) {
    const nodes = screen.findAll((node) => (node.type as any) === 'MultiTextInput');
    expect(nodes.length).toBe(1);
    return nodes[0]!;
}

describe('AgentInput (abort button visibility)', () => {
    afterEach(() => {
        autocompleteMockState.suggestions = [];
        autocompleteMockState.selected = 0;
        vi.useRealTimers();
    });

    it('does not render the stop button when showAbortButton is false (even if onAbort exists)', async () => {
        const { AgentInput } = await agentInputModulePromise;
        const screen = await renderScreen(<AgentInput
                    value=""
                    placeholder="Type"
                    onChangeText={() => {}}
                    onSend={() => {}}
                    onAbort={vi.fn()}
                    showAbortButton={false}
                    autocompletePrefixes={[]}
                    autocompleteSuggestions={async () => []}
                />);

        expect(screen.findByTestId('agent-input-abort')).toBeNull();
    });

    it('renders the stop button when showAbortButton is true and onAbort exists', async () => {
        const { AgentInput } = await agentInputModulePromise;
        const screen = await renderScreen(<AgentInput
                    value=""
                    placeholder="Type"
                    onChangeText={() => {}}
                    onSend={() => {}}
                    onAbort={vi.fn()}
                    showAbortButton={true}
                    autocompletePrefixes={[]}
                    autocompleteSuggestions={async () => []}
                />);

        expect(screen.findByTestId('agent-input-abort')).toBeTruthy();
    });

    it('does not abort from plain Escape', async () => {
        const { AgentInput } = await agentInputModulePromise;
        const onAbort = vi.fn();
        const screen = await renderScreen(<AgentInput
                    value=""
                    placeholder="Type"
                    onChangeText={() => {}}
                    onSend={() => {}}
                    onAbort={onAbort}
                    showAbortButton={true}
                    autocompletePrefixes={[]}
                    autocompleteSuggestions={async () => []}
                />);
        const input = findMultiTextInput(screen);

        let handled: any = null;
        await act(async () => {
            handled = input.props.onKeyPress?.({ key: 'Escape', shiftKey: false });
        });

        expect(handled).toBe(false);
        expect(onAbort).not.toHaveBeenCalled();
    });

    it('selects visible autocomplete suggestion before plain Enter can send', async () => {
        autocompleteMockState.suggestions = [{
            key: 'path',
            text: '@/components',
            component: () => null,
        }];
        const { AgentInput } = await agentInputModulePromise;
        const onSend = vi.fn();
        const screen = await renderScreen(<AgentInput
                    value="@comp"
                    placeholder="Type"
                    onChangeText={() => {}}
                    onSend={onSend}
                    showAbortButton={false}
                    autocompletePrefixes={['@']}
                    autocompleteSuggestions={async () => []}
                />);
        const input = findMultiTextInput(screen);

        let handled: any = null;
        await act(async () => {
            handled = input.props.onKeyPress?.({ key: 'Enter', shiftKey: false });
        });

        expect(handled).toBe(true);
        expect(onSend).not.toHaveBeenCalled();
    });

    it('confirms abort with Shift+Escape when autocomplete suggestions are visible', async () => {
        autocompleteMockState.suggestions = [{
            key: 'path',
            text: '@/components',
            component: () => null,
        }];
        const { AgentInput } = await agentInputModulePromise;
        const onAbort = vi.fn();
        const screen = await renderScreen(<AgentInput
                    value="@comp"
                    placeholder="Type"
                    onChangeText={() => {}}
                    onSend={() => {}}
                    onAbort={onAbort}
                    showAbortButton={true}
                    autocompletePrefixes={['@']}
                    autocompleteSuggestions={async () => []}
                />);
        const input = findMultiTextInput(screen);

        await act(async () => {
            expect(input.props.onKeyPress?.({ key: 'Escape', shiftKey: true })).toBe(true);
        });
        expect(onAbort).not.toHaveBeenCalled();

        await act(async () => {
            expect(input.props.onKeyPress?.({ key: 'Escape', shiftKey: true })).toBe(true);
        });

        expect(onAbort).toHaveBeenCalledTimes(1);
    });

    it('requires a second Shift+Escape within the confirmation window before aborting', async () => {
        const { AgentInput } = await agentInputModulePromise;
        const onAbort = vi.fn();
        const screen = await renderScreen(<AgentInput
                    value=""
                    placeholder="Type"
                    onChangeText={() => {}}
                    onSend={() => {}}
                    onAbort={onAbort}
                    showAbortButton={true}
                    autocompletePrefixes={[]}
                    autocompleteSuggestions={async () => []}
                />);
        const input = findMultiTextInput(screen);

        await act(async () => {
            expect(input.props.onKeyPress?.({ key: 'Escape', shiftKey: true })).toBe(true);
        });
        expect(onAbort).not.toHaveBeenCalled();

        await act(async () => {
            expect(input.props.onKeyPress?.({ key: 'Escape', shiftKey: true })).toBe(true);
        });

        expect(onAbort).toHaveBeenCalledTimes(1);
    });

    it('expires the Shift+Escape abort confirmation window', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const { AgentInput } = await agentInputModulePromise;
        const onAbort = vi.fn();
        const screen = await renderScreen(<AgentInput
                    value=""
                    placeholder="Type"
                    onChangeText={() => {}}
                    onSend={() => {}}
                    onAbort={onAbort}
                    showAbortButton={true}
                    autocompletePrefixes={[]}
                    autocompleteSuggestions={async () => []}
                />);
        const input = findMultiTextInput(screen);

        await act(async () => {
            expect(input.props.onKeyPress?.({ key: 'Escape', shiftKey: true })).toBe(true);
        });
        vi.setSystemTime(2_501);
        await act(async () => {
            expect(input.props.onKeyPress?.({ key: 'Escape', shiftKey: true })).toBe(true);
        });
        expect(onAbort).not.toHaveBeenCalled();

        await act(async () => {
            expect(input.props.onKeyPress?.({ key: 'Escape', shiftKey: true })).toBe(true);
        });

        expect(onAbort).toHaveBeenCalledTimes(1);
    });
});
