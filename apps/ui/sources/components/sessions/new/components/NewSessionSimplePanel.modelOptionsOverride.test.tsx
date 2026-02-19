import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const AgentInputMock = vi.fn((_props: any) => null);

vi.mock('react-native', () => ({
    View: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('View', props, props.children),
    Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Text', props, props.children),
    Pressable: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Pressable', props, props.children),
    AppState: {
        addEventListener: () => ({ remove: () => {} }),
    },
    Platform: { OS: 'ios', select: (v: any) => v.ios },
}));

vi.mock('react-native-keyboard-controller', () => ({
    KeyboardAvoidingView: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('KeyboardAvoidingView', props, props.children),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('ItemGroup', props, props.children),
}));

vi.mock('@/components/ui/forms/SessionTypeSelector', () => ({
    SessionTypeSelectorRows: () => null,
}));

vi.mock('@/components/ui/popover', () => ({
    PopoverBoundaryProvider: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement(React.Fragment, null, props.children),
    PopoverPortalTargetProvider: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement(React.Fragment, null, props.children),
}));

vi.mock('@/components/sessions/agentInput', () => ({
    AgentInput: AgentInputMock,
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

describe('NewSessionSimplePanel (modelOptionsOverride)', () => {
    it('passes modelOptions to AgentInput as modelOptionsOverride', async () => {
        const { NewSessionSimplePanel } = await import('./NewSessionSimplePanel');

        AgentInputMock.mockClear();

        await act(async () => {
            renderer.create(
                React.createElement(NewSessionSimplePanel, {
                    // Test harness: the implementation only forwards this ref to a View.
                    popoverBoundaryRef: { current: null } as unknown as React.RefObject<any>,
                    headerHeight: 44,
                    safeAreaTop: 0,
                    safeAreaBottom: 0,
                    newSessionTopPadding: 0,
                    newSessionSidePadding: 0,
                    newSessionBottomPadding: 0,
                    containerStyle: {},
                    showSessionTypeSelector: false,
                    sessionType: 'simple',
                    setSessionType: () => {},
                    sessionPrompt: '',
                    setSessionPrompt: () => {},
                    handleCreateSession: () => {},
                    canCreate: true,
                    isCreating: false,
                    emptyAutocompletePrefixes: [],
                    emptyAutocompleteSuggestions: async () => [],
                    sessionPromptInputMaxHeight: 200,
                    agentType: 'codex',
                    handleAgentClick: () => {},
                    permissionMode: 'default',
                    handlePermissionModeChange: () => {},
                    modelMode: 'default',
                    setModelMode: () => {},
                    modelOptions: [
                        { value: 'default', label: 'Default', description: '' },
                        { value: 'm1', label: 'Model 1', description: '' },
                    ],
                    connectionStatus: undefined,
                    machineName: undefined,
                    handleMachineClick: () => {},
                    selectedPath: '',
                    handlePathClick: () => {},
                    showResumePicker: false,
                    resumeSessionId: null,
                    handleResumeClick: () => {},
                    isResumeSupportChecking: false,
                    useProfiles: false,
                    selectedProfileId: null,
                    handleProfileClick: () => {},
                    selectedProfileEnvVarsCount: 0,
                    handleEnvVarsClick: () => {},
                }),
            );
        });

        expect(AgentInputMock).toHaveBeenCalled();
        const firstCall = AgentInputMock.mock.calls[0];
        expect(firstCall).toBeTruthy();
        const props = (firstCall?.[0] ?? {}) as any;
        expect(props.modelOptionsOverride).toEqual([
            { value: 'default', label: 'Default', description: '' },
            { value: 'm1', label: 'Model 1', description: '' },
        ]);
    });

    it('passes ACP session mode overrides through to AgentInput when provided', async () => {
        const { NewSessionSimplePanel } = await import('./NewSessionSimplePanel');

        AgentInputMock.mockClear();

        await act(async () => {
            renderer.create(
                React.createElement(NewSessionSimplePanel, {
                    popoverBoundaryRef: { current: null } as unknown as React.RefObject<any>,
                    headerHeight: 44,
                    safeAreaTop: 0,
                    safeAreaBottom: 0,
                    newSessionTopPadding: 0,
                    newSessionSidePadding: 0,
                    newSessionBottomPadding: 0,
                    containerStyle: {},
                    showSessionTypeSelector: false,
                    sessionType: 'simple',
                    setSessionType: () => {},
                    sessionPrompt: '',
                    setSessionPrompt: () => {},
                    handleCreateSession: () => {},
                    canCreate: true,
                    isCreating: false,
                    emptyAutocompletePrefixes: [],
                    emptyAutocompleteSuggestions: async () => [],
                    sessionPromptInputMaxHeight: 200,
                    agentType: 'opencode',
                    handleAgentClick: () => {},
                    permissionMode: 'default',
                    handlePermissionModeChange: () => {},
                    modelMode: 'default',
                    setModelMode: () => {},
                    modelOptions: [{ value: 'default', label: 'Default', description: '' }],
                    modelOptionsProbe: { phase: 'idle', onRefresh: () => {} },
                    acpSessionModeOptions: [
                        { id: 'default', name: 'Default' },
                        { id: 'plan', name: 'Plan' },
                    ],
                    acpSessionModeProbe: { phase: 'loading', onRefresh: () => {} },
                    acpSessionModeId: null,
                    setAcpSessionModeId: () => {},
                    connectionStatus: undefined,
                    machineName: undefined,
                    handleMachineClick: () => {},
                    selectedPath: '',
                    handlePathClick: () => {},
                    showResumePicker: false,
                    resumeSessionId: null,
                    handleResumeClick: () => {},
                    isResumeSupportChecking: false,
                    useProfiles: false,
                    selectedProfileId: null,
                    handleProfileClick: () => {},
                    selectedProfileEnvVarsCount: 0,
                    handleEnvVarsClick: () => {},
                } as any),
            );
        });

        expect(AgentInputMock).toHaveBeenCalled();
        const props = (AgentInputMock.mock.calls[0]?.[0] ?? {}) as any;
        expect(props.acpSessionModeOptionsOverride).toEqual([
            { id: 'default', name: 'Default' },
            { id: 'plan', name: 'Plan' },
        ]);
        expect(props.acpSessionModeSelectedIdOverride).toBeNull();
        expect(props.acpSessionModeOptionsOverrideProbe?.phase).toBe('loading');
        expect(typeof props.onAcpSessionModeChange).toBe('function');
    });
});
