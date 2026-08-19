import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { invokeTestInstanceHandler, renderScreen } from '@/dev/testkit';
import { installNewSessionComponentsCommonModuleMocks } from './newSessionComponentsTestHelpers';
import { createNewSessionPromptStore } from '@/components/sessions/new/hooks/screenModel/newSessionPromptStore';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const AgentInputMock = vi.fn((_props: any) => null);
const keyboardDismissMock = vi.fn();
const useKeyboardHandlerMock = vi.fn();
let platformOs: 'ios' | 'android' = 'ios';

installNewSessionComponentsCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                React.createElement('View', props, props.children),
            Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                React.createElement('Text', props, props.children),
            Pressable: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                React.createElement('Pressable', props, props.children),
            AppState: {
                addEventListener: () => ({ remove: () => {} }),
            },
            Keyboard: {
                addListener: () => ({ remove: () => {} }),
                dismiss: keyboardDismissMock,
            },
            Platform: {
                get OS() {
                    return platformOs;
                },
                select: (v: any) => v[platformOs] ?? v.native ?? v.default ?? v.ios ?? v.android,
            },
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
    storage: async (importOriginal) => {
        const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createPartialStorageModuleMock(importOriginal, {
            useSettings: () => ({
                profiles: [],
                agentInputEnterToSend: true,
                agentInputActionBarLayout: 'wrap',
                agentInputChipDensity: 'labels',
                sessionPermissionModeApplyTiming: 'immediate',
            }),
        });
    },
});

vi.mock('react-native-keyboard-controller', () => ({
    useKeyboardHandler: (...args: any[]) => useKeyboardHandlerMock(...args),
    useReanimatedKeyboardAnimation: () => ({
        height: { value: 240 },
        progress: { value: 1 },
    }),
}));

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// `react-native-reanimated` is a boundary the testkit already owns (installed globally in
// `dev/vitestSetup.ts`); a hand-rolled subset here shadowed it with three exports and broke as
// soon as production code reached for a fourth.

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('ItemGroup', props, props.children),
}));

vi.mock('@/components/ui/popover', () => ({
    PopoverBoundaryProvider: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement(React.Fragment, null, props.children),
    PopoverPortalTargetProvider: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement(React.Fragment, null, props.children),
    PopoverScope: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement(React.Fragment, null, props.children),
}));

vi.mock('@/components/sessions/keyboardAvoidance', () => ({
    ComposerKeyboardScaffold: (props: Record<string, unknown> & {
        children?: React.ReactNode;
        composer?: React.ReactNode;
    }) => React.createElement(
        'ComposerKeyboardScaffold',
        props,
        props.children,
        props.composer,
    ),
    useComposerAvailablePanelHeight: () => 480,
    useComposerKeyboardLayoutContext: () => null,
}));

vi.mock('@/components/sessions/agentInput', () => ({
    AgentInput: AgentInputMock,
}));

describe('NewSessionSimplePanel (modelOptionsOverride)', () => {
    beforeEach(() => {
        keyboardDismissMock.mockReset();
        useKeyboardHandlerMock.mockReset();
        platformOs = 'ios';
    });

    function flattenStyle(style: unknown): Record<string, unknown> {
        if (!style) return {};
        if (Array.isArray(style)) {
            return style.reduce<Record<string, unknown>>((acc, entry) => ({ ...acc, ...flattenStyle(entry) }), {});
        }
        if (typeof style === 'number') return {};
        if (typeof style === 'object') return style as Record<string, unknown>;
        return {};
    }

    it('passes modelOptions to AgentInput as modelOptionsOverride', async () => {
        const { NewSessionSimplePanel } = await import('./NewSessionSimplePanel');

        AgentInputMock.mockClear();
        let tree: renderer.ReactTestRenderer | undefined;
        try {
            tree = (await renderScreen(React.createElement(NewSessionSimplePanel, {
                        // Test harness: the implementation only forwards this ref to a View.
                        popoverBoundaryRef: { current: null } as unknown as React.RefObject<any>,
                        headerHeight: 44,
                        safeAreaTop: 0,
                        safeAreaBottom: 0,
                        newSessionTopPadding: 0,
                        newSessionSidePadding: 0,
                        newSessionBottomPadding: 0,
                        containerStyle: {},
                        promptStore: createNewSessionPromptStore(''),
                        setSessionPrompt: () => {},
                        handleCreateSession: () => {},
                        canCreate: true,
                        isCreating: false,
                        emptyAutocompleteKinds: [],
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
                        machinePopover: {
                            renderContent: () => null,
                        },
                        selectedPath: '',
                        showResumePicker: false,
                        resumeSessionId: null,
                        isResumeSupportChecking: false,
                        useProfiles: false,
                        selectedProfileId: null,
                    }))).tree;

            expect(AgentInputMock).toHaveBeenCalled();
            const firstCall = AgentInputMock.mock.calls[0];
            expect(firstCall).toBeTruthy();
            const props = (firstCall?.[0] ?? {}) as any;
            expect(props.modelOptionsOverride).toEqual([
                { value: 'default', label: 'Default', description: '' },
                { value: 'm1', label: 'Model 1', description: '' },
            ]);
            expect(typeof props.machinePopover?.renderContent).toBe('function');
        } finally {
            act(() => {
                tree?.unmount();
            });
        }
    });

    it('renders through the shared keyboard scaffold so the whole composer can move above the keyboard', async () => {
        const { NewSessionSimplePanel } = await import('./NewSessionSimplePanel');

        AgentInputMock.mockClear();
        let tree: renderer.ReactTestRenderer | undefined;
        try {
            tree = (await renderScreen(React.createElement(NewSessionSimplePanel, {
                        popoverBoundaryRef: { current: null } as unknown as React.RefObject<any>,
                        headerHeight: 44,
                        safeAreaTop: 32,
                        safeAreaBottom: 34,
                        newSessionTopPadding: 20,
                        newSessionSidePadding: 0,
                        newSessionBottomPadding: 8,
                        containerStyle: {},
                        promptStore: createNewSessionPromptStore(''),
                        setSessionPrompt: () => {},
                        handleCreateSession: () => {},
                        canCreate: true,
                        isCreating: false,
                        emptyAutocompleteKinds: [],
                        emptyAutocompleteSuggestions: async () => [],
                        sessionPromptInputMaxHeight: 200,
                        agentType: 'codex',
                        handleAgentClick: () => {},
                        permissionMode: 'default',
                        handlePermissionModeChange: () => {},
                        modelMode: 'default',
                        setModelMode: () => {},
                        modelOptions: [{ value: 'default', label: 'Default', description: '' }],
                        connectionStatus: undefined,
                        machineName: undefined,
                        selectedPath: '',
                        showResumePicker: false,
                        resumeSessionId: null,
                        isResumeSupportChecking: false,
                        useProfiles: false,
                        selectedProfileId: null,
                    } as any))).tree;

            const scaffold = tree.root.findByType('ComposerKeyboardScaffold');
            expect(scaffold.props.mode).toBe('newSession');
            // Zero, not the 44 the caller passes: `useHeaderHeight()` is a platform constant rather
            // than a measurement, and this presentation draws no header at all. Forwarding it would
            // subtract phantom chrome from the keyboard layout's bootstrap viewport. The top
            // reservation travels on `availablePanelMaxHeight` instead.
            expect(scaffold.props.headerHeight).toBe(0);
            // The resting offset is the card's own side margin rather than the home-indicator
            // inset, so the gap under a floating card matches the gap beside it.
            expect(scaffold.props.safeAreaBottom).toBe(0);

            const dismissSpacer = tree.root.findAllByType('Pressable').find((node) => {
                return flattenStyle(node.props.style).flex === 1;
            });

            expect(dismissSpacer).toBeTruthy();
            expect(flattenStyle(dismissSpacer?.props.style).minHeight).toBe(8);
        } finally {
            act(() => {
                tree?.unmount();
            });
        }
    });

    it('passes the host-constrained scaffold panel height to AgentInput on simple mobile layouts', async () => {
        const { NewSessionSimplePanel } = await import('./NewSessionSimplePanel');

        AgentInputMock.mockClear();
        let tree: renderer.ReactTestRenderer | undefined;
        try {
            tree = (await renderScreen(React.createElement(NewSessionSimplePanel, {
                        popoverBoundaryRef: { current: null } as unknown as React.RefObject<any>,
                        headerHeight: 44,
                        safeAreaTop: 0,
                        safeAreaBottom: 34,
                        newSessionTopPadding: 20,
                        newSessionSidePadding: 16,
                        newSessionBottomPadding: 12,
                        containerStyle: {},
                        promptStore: createNewSessionPromptStore(''),
                        setSessionPrompt: () => {},
                        handleCreateSession: () => {},
                        canCreate: true,
                        isCreating: false,
                        emptyAutocompleteKinds: [],
                        emptyAutocompleteSuggestions: async () => [],
                        sessionPromptInputMaxHeight: 200,
                        agentType: 'codex',
                        handleAgentClick: () => {},
                        permissionMode: 'default',
                        handlePermissionModeChange: () => {},
                        modelMode: 'default',
                        setModelMode: () => {},
                        modelOptions: [{ value: 'default', label: 'Default', description: '' }],
                        connectionStatus: undefined,
                        machineName: undefined,
                        selectedPath: '',
                        showResumePicker: false,
                        resumeSessionId: null,
                        isResumeSupportChecking: false,
                        useProfiles: false,
                        selectedProfileId: null,
                    } as any))).tree;

            const latestCall = AgentInputMock.mock.calls.at(-1);
            const latestProps = (latestCall?.[0] ?? {}) as any;
            // 480 less the 42pt close capsule row this host draws above the card (safeAreaTop is 0
            // here). The row lives inside the same budget and nothing else subtracts it, so without
            // this a long draft grows up past the capsule and off the top of the screen.
            expect(latestProps.maxPanelHeight).toBe(480 - 0 - 42);
            expect(latestProps.panelMaxHeightMode).toBe('host-constrained');
        } finally {
            act(() => {
                tree?.unmount();
            });
        }
    });

    // On native this empty area is the visible backdrop of a transparent modal, so pressing it
    // starts the dismissal. It deliberately does NOT call `Keyboard.dismiss()`: retracting the
    // keyboard drags the composer — and the scrim's stacked blur layers — down with it over the
    // keyboard's own curve, which tore the frost into horizontal bands. The keyboard goes down
    // when the input unmounts instead. What IS asserted is that the target disarms itself, so a
    // second press cannot land on a backdrop that outlived the tap which closed it.
    it('dismisses the screen on a backdrop press instead of eagerly retracting the keyboard on iOS', async () => {
        const { NewSessionSimplePanel } = await import('./NewSessionSimplePanel');

        AgentInputMock.mockClear();
        let tree: renderer.ReactTestRenderer | undefined;
        try {
            tree = (await renderScreen(React.createElement(NewSessionSimplePanel, {
                        popoverBoundaryRef: { current: null } as unknown as React.RefObject<any>,
                        headerHeight: 44,
                        safeAreaTop: 0,
                        safeAreaBottom: 34,
                        newSessionTopPadding: 20,
                        newSessionSidePadding: 16,
                        newSessionBottomPadding: 8,
                        containerStyle: {},
                        promptStore: createNewSessionPromptStore(''),
                        setSessionPrompt: () => {},
                        handleCreateSession: () => {},
                        canCreate: true,
                        isCreating: false,
                        emptyAutocompleteKinds: [],
                        emptyAutocompleteSuggestions: async () => [],
                        sessionPromptInputMaxHeight: 200,
                        agentType: 'codex',
                        handleAgentClick: () => {},
                        permissionMode: 'default',
                        handlePermissionModeChange: () => {},
                        modelMode: 'default',
                        setModelMode: () => {},
                        modelOptions: [{ value: 'default', label: 'Default', description: '' }],
                        connectionStatus: undefined,
                        machineName: undefined,
                        selectedPath: '',
                        showResumePicker: false,
                        resumeSessionId: null,
                        isResumeSupportChecking: false,
                        useProfiles: false,
                        selectedProfileId: null,
                    } as any))).tree;

            const dismissPressable = tree.root.findAllByType('Pressable').find((node) => {
                return typeof node.props.onPress === 'function' && flattenStyle(node.props.style).flex === 1;
            });

            expect(dismissPressable).toBeTruthy();

            act(() => {
                invokeTestInstanceHandler(dismissPressable!, 'onPress', undefined, 'new-session-dismiss-background');
            });

            // Retracting the keyboard here would drag the composer — and the scrim's blur layers —
            // down the keyboard's own curve while the card is still on screen. It goes down anyway
            // when the input unmounts, so the dismissal owns the ordering instead.
            expect(keyboardDismissMock).not.toHaveBeenCalled();
        } finally {
            act(() => {
                tree?.unmount();
            });
        }
    });

    it('uses the same shared keyboard scaffold on Android so the whole composer can move above the keyboard', async () => {
        const { NewSessionSimplePanel } = await import('./NewSessionSimplePanel');
        platformOs = 'android';

        let tree: renderer.ReactTestRenderer | undefined;
        try {
            tree = (await renderScreen(React.createElement(NewSessionSimplePanel, {
                        popoverBoundaryRef: { current: null } as unknown as React.RefObject<any>,
                        headerHeight: 44,
                        safeAreaTop: 0,
                        safeAreaBottom: 0,
                        newSessionTopPadding: 20,
                        newSessionSidePadding: 16,
                        newSessionBottomPadding: 8,
                        containerStyle: {},
                        promptStore: createNewSessionPromptStore(''),
                        setSessionPrompt: () => {},
                        handleCreateSession: () => {},
                        canCreate: true,
                        isCreating: false,
                        emptyAutocompleteKinds: [],
                        emptyAutocompleteSuggestions: async () => [],
                        sessionPromptInputMaxHeight: 200,
                        agentType: 'codex',
                        handleAgentClick: () => {},
                        permissionMode: 'default',
                        handlePermissionModeChange: () => {},
                        modelMode: 'default',
                        setModelMode: () => {},
                        modelOptions: [{ value: 'default', label: 'Default', description: '' }],
                        connectionStatus: undefined,
                        machineName: undefined,
                        selectedPath: '',
                        showResumePicker: false,
                        resumeSessionId: null,
                        isResumeSupportChecking: false,
                        useProfiles: false,
                        selectedProfileId: null,
                    } as any))).tree;

            const scaffold = tree.root.findByType('ComposerKeyboardScaffold');
            expect(scaffold.props.mode).toBe('newSession');
        } finally {
            act(() => {
                tree?.unmount();
            });
        }
    });

    it('passes the shared profile popover to AgentInput and suppresses separate env/profile click handlers', async () => {
        const { NewSessionSimplePanel } = await import('./NewSessionSimplePanel');

        AgentInputMock.mockClear();
        let tree: renderer.ReactTestRenderer | undefined;
        try {
            tree = (await renderScreen(React.createElement(NewSessionSimplePanel, {
                        popoverBoundaryRef: { current: null } as unknown as React.RefObject<any>,
                        headerHeight: 44,
                        safeAreaTop: 0,
                        safeAreaBottom: 0,
                        newSessionTopPadding: 0,
                        newSessionSidePadding: 0,
                        newSessionBottomPadding: 0,
                        containerStyle: {},
                        promptStore: createNewSessionPromptStore(''),
                        setSessionPrompt: () => {},
                        handleCreateSession: () => {},
                        canCreate: true,
                        isCreating: false,
                        emptyAutocompleteKinds: [],
                        emptyAutocompleteSuggestions: async () => [],
                        sessionPromptInputMaxHeight: 200,
                        agentType: 'codex',
                        handleAgentClick: () => {},
                        permissionMode: 'default',
                        handlePermissionModeChange: () => {},
                        modelMode: 'default',
                        setModelMode: () => {},
                        modelOptions: [{ value: 'default', label: 'Default', description: '' }],
                        connectionStatus: undefined,
                        machineName: undefined,
                        selectedPath: '',
                        showResumePicker: false,
                        resumeSessionId: null,
                        isResumeSupportChecking: false,
                        useProfiles: true,
                        selectedProfileId: 'profile-1',
                        profilePopover: {
                            renderContent: () => null,
                        },
                    } as any))).tree;

            expect(AgentInputMock).toHaveBeenCalled();
            const props = (AgentInputMock.mock.calls[0]?.[0] ?? {}) as any;
            expect(props.profileId).toBe('profile-1');
            expect(typeof props.profilePopover?.renderContent).toBe('function');
            expect(props.onProfileClick).toBeUndefined();
            expect(props.envVarsCount).toBeUndefined();
            expect(props.envVarsPopover).toBeUndefined();
            expect(props.onEnvVarsClick).toBeUndefined();
        } finally {
            act(() => {
                tree?.unmount();
            });
        }
    });

    it('passes the core machine, path, and resume popover configs through to AgentInput when provided', async () => {
        const { NewSessionSimplePanel } = await import('./NewSessionSimplePanel');

        AgentInputMock.mockClear();
        let tree: renderer.ReactTestRenderer | undefined;
        try {
            tree = (await renderScreen(React.createElement(NewSessionSimplePanel, {
                        popoverBoundaryRef: { current: null } as unknown as React.RefObject<any>,
                        headerHeight: 44,
                        safeAreaTop: 0,
                        safeAreaBottom: 0,
                        newSessionTopPadding: 0,
                        newSessionSidePadding: 0,
                        newSessionBottomPadding: 0,
                        containerStyle: {},
                        promptStore: createNewSessionPromptStore(''),
                        setSessionPrompt: () => {},
                        handleCreateSession: () => {},
                        canCreate: true,
                        isCreating: false,
                        emptyAutocompleteKinds: [],
                        emptyAutocompleteSuggestions: async () => [],
                        sessionPromptInputMaxHeight: 200,
                        agentType: 'codex',
                        handleAgentClick: () => {},
                        permissionMode: 'default',
                        handlePermissionModeChange: () => {},
                        modelMode: 'default',
                        setModelMode: () => {},
                        modelOptions: [{ value: 'default', label: 'Default', description: '' }],
                        connectionStatus: undefined,
                        machineName: 'Builder',
                        machinePopover: { renderContent: () => null },
                        selectedPath: '/repo',
                        pathPopover: { renderContent: () => null },
                        showResumePicker: true,
                        resumeSessionId: 'resume-1',
                        resumePopover: { renderContent: () => null },
                        isResumeSupportChecking: false,
                        useProfiles: false,
                        selectedProfileId: null,
                    } as any))).tree;

            const props = (AgentInputMock.mock.calls[0]?.[0] ?? {}) as any;
            expect(typeof props.machinePopover?.renderContent).toBe('function');
            expect(typeof props.pathPopover?.renderContent).toBe('function');
            expect(typeof props.resumePopover?.renderContent).toBe('function');
        } finally {
            act(() => {
                tree?.unmount();
            });
        }
    });

    it('passes the resume popover config through to AgentInput when resume selection is available', async () => {
        const { NewSessionSimplePanel } = await import('./NewSessionSimplePanel');

        AgentInputMock.mockClear();
        let tree: renderer.ReactTestRenderer | undefined;
        try {
            tree = (await renderScreen(React.createElement(NewSessionSimplePanel, {
                        popoverBoundaryRef: { current: null } as unknown as React.RefObject<any>,
                        headerHeight: 44,
                        safeAreaTop: 0,
                        safeAreaBottom: 0,
                        newSessionTopPadding: 0,
                        newSessionSidePadding: 0,
                        newSessionBottomPadding: 0,
                        containerStyle: {},
                        promptStore: createNewSessionPromptStore(''),
                        setSessionPrompt: () => {},
                        handleCreateSession: () => {},
                        canCreate: true,
                        isCreating: false,
                        emptyAutocompleteKinds: [],
                        emptyAutocompleteSuggestions: async () => [],
                        sessionPromptInputMaxHeight: 200,
                        agentType: 'codex',
                        handleAgentClick: () => {},
                        permissionMode: 'default',
                        handlePermissionModeChange: () => {},
                        modelMode: 'default',
                        setModelMode: () => {},
                        modelOptions: [{ value: 'default', label: 'Default', description: '' }],
                        connectionStatus: undefined,
                        machineName: undefined,
                        selectedPath: '',
                        showResumePicker: true,
                        resumeSessionId: 'resume-42',
                        resumePopover: {
                            renderContent: () => null,
                        },
                        isResumeSupportChecking: false,
                        useProfiles: false,
                        selectedProfileId: null,
                    } as any))).tree;

            expect(AgentInputMock).toHaveBeenCalled();
            const props = (AgentInputMock.mock.calls[0]?.[0] ?? {}) as any;
            expect(props.resumeSessionId).toBe('resume-42');
            expect(props.resumePopover).toBeTruthy();
            expect(typeof props.resumePopover?.renderContent).toBe('function');
            expect(props.onResumeClick).toBeUndefined();
        } finally {
            act(() => {
                tree?.unmount();
            });
        }
    });

    it('passes ACP session mode overrides through to AgentInput when provided', async () => {
        const { NewSessionSimplePanel } = await import('./NewSessionSimplePanel');

        AgentInputMock.mockClear();
        let tree: renderer.ReactTestRenderer | undefined;
        try {
            tree = (await renderScreen(React.createElement(NewSessionSimplePanel, {
                        popoverBoundaryRef: { current: null } as unknown as React.RefObject<any>,
                        headerHeight: 44,
                        safeAreaTop: 0,
                        safeAreaBottom: 0,
                        newSessionTopPadding: 0,
                        newSessionSidePadding: 0,
                        newSessionBottomPadding: 0,
                        containerStyle: {},
                        promptStore: createNewSessionPromptStore(''),
                        setSessionPrompt: () => {},
                        handleCreateSession: () => {},
                        canCreate: true,
                        isCreating: false,
                        emptyAutocompleteKinds: [],
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
                        selectedPath: '',
                        showResumePicker: false,
                        resumeSessionId: null,
                        isResumeSupportChecking: false,
                        useProfiles: false,
                        selectedProfileId: null,
                    } as any))).tree;

            expect(AgentInputMock).toHaveBeenCalled();
            const props = (AgentInputMock.mock.calls[0]?.[0] ?? {}) as any;
            expect(props.acpSessionModeOptionsOverride).toEqual([
                { id: 'default', name: 'Default' },
                { id: 'plan', name: 'Plan' },
            ]);
            expect(props.acpSessionModeSelectedIdOverride).toBeNull();
            expect(props.acpSessionModeOptionsOverrideProbe?.phase).toBe('loading');
            expect(typeof props.onAcpSessionModeChange).toBe('function');
        } finally {
            act(() => {
                tree?.unmount();
            });
        }
    });

    it('passes ACP config option overrides through to AgentInput when provided', async () => {
        const { NewSessionSimplePanel } = await import('./NewSessionSimplePanel');

        AgentInputMock.mockClear();
        let tree: renderer.ReactTestRenderer | undefined;
        const onConfigChange = vi.fn();
        try {
            tree = (await renderScreen(React.createElement(NewSessionSimplePanel, {
                        popoverBoundaryRef: { current: null } as unknown as React.RefObject<any>,
                        headerHeight: 44,
                        safeAreaTop: 0,
                        safeAreaBottom: 0,
                        newSessionTopPadding: 0,
                        newSessionSidePadding: 0,
                        newSessionBottomPadding: 0,
                        containerStyle: {},
                        promptStore: createNewSessionPromptStore(''),
                        setSessionPrompt: () => {},
                        handleCreateSession: () => {},
                        canCreate: true,
                        isCreating: false,
                        emptyAutocompleteKinds: [],
                        emptyAutocompleteSuggestions: async () => [],
                        sessionPromptInputMaxHeight: 200,
                        agentType: 'codex',
                        handleAgentClick: () => {},
                        permissionMode: 'default',
                        handlePermissionModeChange: () => {},
                        modelMode: 'default',
                        setModelMode: () => {},
                        modelOptions: [{ value: 'default', label: 'Default', description: '' }],
                        acpConfigOptions: [
                            {
                                id: 'speed',
                                name: 'Speed',
                                type: 'select',
                                currentValue: 'standard',
                                options: [
                                    { value: 'standard', name: 'Standard' },
                                    { value: 'fast', name: 'Fast' },
                                ],
                            },
                        ],
                        acpConfigOptionsProbe: { phase: 'idle', onRefresh: () => {} },
                        acpConfigOptionOverrides: {
                            v: 1,
                            updatedAt: 123,
                            overrides: {
                                speed: { updatedAt: 123, value: 'fast' },
                            },
                        },
                        setSessionConfigOptionOverride: onConfigChange,
                        connectionStatus: undefined,
                        machineName: undefined,
                        selectedPath: '',
                        showResumePicker: false,
                        resumeSessionId: null,
                        isResumeSupportChecking: false,
                        useProfiles: false,
                        selectedProfileId: null,
                    } as any))).tree;

            expect(AgentInputMock).toHaveBeenCalled();
            const props = (AgentInputMock.mock.calls[0]?.[0] ?? {}) as any;
            expect(props.acpConfigOptionsOverride).toEqual([
                {
                    id: 'speed',
                    name: 'Speed',
                    type: 'select',
                    currentValue: 'standard',
                    options: [
                        { value: 'standard', name: 'Standard' },
                        { value: 'fast', name: 'Fast' },
                    ],
                },
            ]);
            expect(props.acpConfigOptionOverridesOverride).toEqual({
                v: 1,
                updatedAt: 123,
                overrides: {
                    speed: { updatedAt: 123, value: 'fast' },
                },
            });
            expect(props.acpConfigOptionsOverrideProbe).toEqual({ phase: 'idle', onRefresh: expect.any(Function) });
            expect(typeof props.onSessionConfigOptionChange).toBe('function');

            props.onSessionConfigOptionChange('speed', 'standard');
            expect(onConfigChange).toHaveBeenCalledWith('speed', 'standard');
        } finally {
            act(() => {
                tree?.unmount();
            });
        }
    });

    it('passes engine picker popover props through to AgentInput when provided', async () => {
        const { NewSessionSimplePanel } = await import('./NewSessionSimplePanel');

        AgentInputMock.mockClear();
        let tree: renderer.ReactTestRenderer | undefined;
        const onAgentPickerSelect = vi.fn();
        try {
            tree = (await renderScreen(React.createElement(NewSessionSimplePanel, {
                        popoverBoundaryRef: { current: null } as unknown as React.RefObject<any>,
                        headerHeight: 44,
                        safeAreaTop: 0,
                        safeAreaBottom: 0,
                        newSessionTopPadding: 0,
                        newSessionSidePadding: 0,
                        newSessionBottomPadding: 0,
                        containerStyle: {},
                        promptStore: createNewSessionPromptStore(''),
                        setSessionPrompt: () => {},
                        handleCreateSession: () => {},
                        canCreate: true,
                        isCreating: false,
                        emptyAutocompleteKinds: [],
                        emptyAutocompleteSuggestions: async () => [],
                        sessionPromptInputMaxHeight: 200,
                        agentType: 'claude',
                        agentPickerOptions: [
                            { id: 'agent:claude', label: 'Claude' },
                            { id: 'agent:codex', label: 'Codex' },
                        ],
                        agentPickerSelectedOptionId: 'agent:claude',
                        onAgentPickerSelect,
                        handleAgentClick: () => {},
                        permissionMode: 'default',
                        handlePermissionModeChange: () => {},
                        modelMode: 'default',
                        setModelMode: () => {},
                        modelOptions: [{ value: 'default', label: 'Default', description: '' }],
                        connectionStatus: undefined,
                        machineName: undefined,
                        selectedPath: '',
                        showResumePicker: false,
                        resumeSessionId: null,
                        isResumeSupportChecking: false,
                        useProfiles: false,
                        selectedProfileId: null,
                    } as any))).tree;

            expect(AgentInputMock).toHaveBeenCalled();
            const props = (AgentInputMock.mock.calls[0]?.[0] ?? {}) as any;
            expect(props.agentPickerTitle).toBeUndefined();
            expect(props.agentPickerSelectedOptionId).toBe('agent:claude');
            expect(props.agentPickerOptions).toEqual([
                { id: 'agent:claude', label: 'Claude' },
                { id: 'agent:codex', label: 'Codex' },
            ]);
            expect(props.onAgentPickerSelect).toBe(onAgentPickerSelect);
        } finally {
            act(() => {
                tree?.unmount();
            });
        }
    });

});
