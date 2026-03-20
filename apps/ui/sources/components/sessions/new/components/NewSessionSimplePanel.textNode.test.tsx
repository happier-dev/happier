import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mockEnv = vi.hoisted(() => ({
    windowWidth: 800,
}));
const agentInputPropsRef: { current: Record<string, unknown> | null } = { current: null };
vi.mock('react-native', () => ({
    View: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('View', props, props.children),
    Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Text', props, props.children),
    Pressable: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Pressable', props, props.children),
    ScrollView: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('ScrollView', props, props.children),
    ActivityIndicator: (props: Record<string, unknown>) =>
        React.createElement('ActivityIndicator', props, null),
    Platform: { OS: 'web', select: (v: any) => v.web ?? v.default ?? v.ios },
    AppState: { addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
    useWindowDimensions: () => ({ width: mockEnv.windowWidth, height: 600 }),
    Dimensions: {
        get: () => ({ width: mockEnv.windowWidth, height: 600, scale: 1, fontScale: 1 }),
    },
}));

vi.mock('react-native-keyboard-controller', () => ({
    KeyboardAvoidingView: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('KeyboardAvoidingView', props, props.children),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: () => <>{'.'}</>,
    Octicons: () => <>{'.'}</>,
}));

vi.mock('expo-image', () => ({
    Image: (props: Record<string, unknown>) => React.createElement('Image', props, null),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('ItemGroup', props, props.children),
}));

vi.mock('@/components/ui/popover', () => ({
    Popover: () => null,
    PopoverBoundaryProvider: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement(React.Fragment, null, props.children),
    PopoverPortalTargetProvider: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement(React.Fragment, null, props.children),
}));

vi.mock('@/components/ui/overlays/FloatingOverlay', () => ({
    FloatingOverlay: () => null,
}));

vi.mock('@/components/ui/forms/MultiTextInput', () => ({
    MultiTextInput: (props: Record<string, unknown>) => React.createElement('MultiTextInput', props, null),
}));

vi.mock('@/components/ui/forms/Switch', () => ({
    Switch: (props: Record<string, unknown>) => React.createElement('Switch', props, null),
}));

vi.mock('@/components/ui/feedback/Shaker', () => ({
    Shaker: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement(React.Fragment, null, props.children),
}));

vi.mock('@/components/ui/status/StatusDot', () => ({
    StatusDot: () => null,
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

vi.mock('@/components/ui/theme/haptics', () => ({
    hapticsLight: () => {},
    hapticsError: () => {},
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: ({ children, ...props }: any) => React.createElement('Text', props, children),
}));

vi.mock('@/components/sessions/agentInput', () => ({
    AgentInput: (props: Record<string, unknown>) => {
        agentInputPropsRef.current = props;
        return React.createElement(
            'AgentInput',
            props,
            React.createElement('Pressable', {
                testID: 'new-session-composer-send',
                onPress: props.onSend,
            }),
        );
    },
}));

vi.mock('@/components/tools/shell/permissions/PermissionFooter', () => ({
    PermissionFooter: () => null,
}));

vi.mock('@/components/model/ModelPickerOverlay', () => ({
    ModelPickerOverlay: () => null,
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

vi.mock('@/components/sessions/sourceControl/status', () => ({
    SourceControlStatusBadge: () => null,
    useHasMeaningfulScmStatus: () => false,
}));

vi.mock('@/hooks/ui/useKeyboardHeight', () => ({
    useKeyboardHeight: () => 0,
}));

vi.mock('@/modal', () => ({
    Modal: { alert: vi.fn() },
}));

vi.mock('@/sync/acp/sessionModeControl', () => ({
    computeSessionModePickerControl: () => null,
}));

vi.mock('@/sync/acp/configOptionsControl', () => ({
    computeAcpConfigOptionControls: () => null,
}));

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/domains/state/storage')>();
    return {
        ...actual,
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
    };
});

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

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/components/sessions/attachments/AttachmentFilePicker', () => ({
    AttachmentFilePicker: () => null,
}));

vi.mock('@/components/sessions/attachments/useAttachmentsUploadConfig', () => ({
    useAttachmentsUploadConfig: () => ({
        maxFileBytes: 25 * 1024 * 1024,
    }),
}));

vi.mock('@/components/sessions/attachments/useAttachmentDraftManager', () => ({
    useAttachmentDraftManager: () => ({
        filePickerRef: { current: null },
        drafts: [],
        hasSendableAttachments: false,
        agentInputAttachments: [],
        addWebFiles: vi.fn(),
        addPickedAttachments: vi.fn(),
        removeDraft: vi.fn(),
        clearDrafts: vi.fn(),
        applyDraftPatch: vi.fn(),
    }),
}));

vi.mock('@/components/sessions/attachments/uploadAttachmentDraftsToSession', () => ({
    uploadAttachmentDraftsToSession: vi.fn(),
    formatAttachmentsBlock: vi.fn(() => ''),
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => false,
}));

vi.mock('@/sync/sync', () => ({
    sync: { sendMessage: vi.fn() },
}));

describe('NewSessionSimplePanel', () => {
    it('does not render the legacy visible session type selector even when the feature flag is enabled', async () => {
        const { NewSessionSimplePanel } = await import('./NewSessionSimplePanel');

        let tree!: renderer.ReactTestRenderer;
        try {
            await act(async () => {
                tree = renderer.create(
                    <NewSessionSimplePanel
                        popoverBoundaryRef={{ current: null } as unknown as React.RefObject<any>}
                        headerHeight={44}
                        safeAreaTop={0}
                        safeAreaBottom={0}
                        newSessionTopPadding={0}
                        newSessionSidePadding={0}
                        newSessionBottomPadding={0}
                        containerStyle={{}}
                        sessionPrompt=""
                        setSessionPrompt={() => {}}
                        handleCreateSession={() => {}}
                        canCreate={true}
                        isCreating={false}
                        emptyAutocompletePrefixes={[]}
                        emptyAutocompleteSuggestions={async () => []}
                        sessionPromptInputMaxHeight={200}
                        agentInputExtraActionChips={[]}
                        agentType="codex"
                        handleAgentClick={() => {}}
                        permissionMode="default"
                        handlePermissionModeChange={() => {}}
                        modelMode="default"
                        setModelMode={() => {}}
                        modelOptions={[{ value: 'default', label: 'Default', description: '' }]}
                        connectionStatus={undefined}
                        machineName={undefined}
                        handleMachineClick={() => {}}
                        selectedPath=""
                        handlePathClick={() => {}}
                        showResumePicker={false}
                        resumeSessionId={null}
                        handleResumeClick={() => {}}
                        isResumeSupportChecking={false}
                        useProfiles={false}
                        selectedProfileId={null}
                        handleProfileClick={() => {}}
                        selectedProfileEnvVarsCount={0}
                        envVarsPopover={undefined}
                    />,
                );
            });

            const textNodes = tree.root.findAllByType('Text' as any).map((node) => node.props.children).flat().filter(Boolean);
            expect(textNodes).not.toContain('newSession.sessionType.title');
            expect(textNodes).not.toContain('newSession.selectSessionTypeTitle');
        } finally {
            act(() => {
                tree?.unmount();
            });
        }
    });

    it('does not emit raw text nodes under non-Text parents when icons render as text on web', async () => {
        const { NewSessionSimplePanel } = await import('./NewSessionSimplePanel');

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <NewSessionSimplePanel
                    popoverBoundaryRef={{ current: null } as unknown as React.RefObject<any>}
                    headerHeight={44}
                    safeAreaTop={0}
                    safeAreaBottom={0}
                    newSessionTopPadding={0}
                    newSessionSidePadding={0}
                    newSessionBottomPadding={0}
                    containerStyle={{}}
                    sessionPrompt=""
                    setSessionPrompt={() => {}}
                    handleCreateSession={() => {}}
                    canCreate={true}
                    isCreating={false}
                    emptyAutocompletePrefixes={[]}
                    emptyAutocompleteSuggestions={async () => []}
                    sessionPromptInputMaxHeight={200}
                    agentInputExtraActionChips={[]}
                    agentType="codex"
                    handleAgentClick={() => {}}
                    permissionMode="default"
                    handlePermissionModeChange={() => {}}
                    modelMode="default"
                    setModelMode={() => {}}
                    modelOptions={[{ value: 'default', label: 'Default', description: '' }]}
                    connectionStatus={undefined}
                    machineName={undefined}
                    handleMachineClick={() => {}}
                    selectedPath=""
                    handlePathClick={() => {}}
                    showResumePicker={false}
                    resumeSessionId={null}
                    handleResumeClick={() => {}}
                    isResumeSupportChecking={false}
                    useProfiles={false}
                    selectedProfileId={null}
                    handleProfileClick={() => {}}
                    selectedProfileEnvVarsCount={0}
                    envVarsPopover={undefined}
                />,
            );
        });

        const badNodes: Array<{ parent: string | null; value: string }> = [];
        const walk = (node: any, parentType: string | null) => {
            if (node == null) return;
            if (typeof node === 'string' || typeof node === 'number') {
                const value = String(node);
                if (parentType !== 'Text' && value.trim().length > 0) badNodes.push({ parent: parentType, value });
                return;
            }
            if (Array.isArray(node)) {
                for (const item of node) walk(item, parentType);
                return;
            }
            const nextParent = typeof node.type === 'string' ? node.type : parentType;
            const children = Array.isArray(node.children) ? node.children : [];
            for (const child of children) walk(child, nextParent);
        };

        walk(tree.toJSON(), null);
        expect(badNodes).toEqual([]);

        act(() => {
            tree.unmount();
        });
    });

    it('renders an inline automation section when provided by the shared composer model', async () => {
        const { NewSessionSimplePanel } = await import('./NewSessionSimplePanel');

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <NewSessionSimplePanel
                    popoverBoundaryRef={{ current: null } as unknown as React.RefObject<any>}
                    headerHeight={44}
                    safeAreaTop={0}
                    safeAreaBottom={0}
                    newSessionTopPadding={0}
                    newSessionSidePadding={0}
                    newSessionBottomPadding={0}
                    containerStyle={{}}
                    sessionPrompt=""
                    setSessionPrompt={() => {}}
                    handleCreateSession={() => {}}
                    canCreate={true}
                    isCreating={false}
                    emptyAutocompletePrefixes={[]}
                    emptyAutocompleteSuggestions={async () => []}
                    sessionPromptInputMaxHeight={200}
                    automationSection={React.createElement('AutomationSection')}
                    agentInputExtraActionChips={[]}
                    agentType="codex"
                    handleAgentClick={() => {}}
                    permissionMode="default"
                    handlePermissionModeChange={() => {}}
                    modelMode="default"
                    setModelMode={() => {}}
                    modelOptions={[{ value: 'default', label: 'Default', description: '' }]}
                    connectionStatus={undefined}
                    machineName={undefined}
                    handleMachineClick={() => {}}
                    selectedPath=""
                    handlePathClick={() => {}}
                    showResumePicker={false}
                    resumeSessionId={null}
                    handleResumeClick={() => {}}
                    isResumeSupportChecking={false}
                    useProfiles={false}
                    selectedProfileId={null}
                    handleProfileClick={() => {}}
                    selectedProfileEnvVarsCount={0}
                    envVarsPopover={undefined}
                />,
            );
        });

        expect(() => tree.root.findByType('AutomationSection' as any)).not.toThrow();
    });

    it('renders the automation section after the agent input', async () => {
        const { NewSessionSimplePanel } = await import('./NewSessionSimplePanel');

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <NewSessionSimplePanel
                    popoverBoundaryRef={{ current: null } as unknown as React.RefObject<any>}
                    headerHeight={44}
                    safeAreaTop={0}
                    safeAreaBottom={0}
                    newSessionTopPadding={0}
                    newSessionSidePadding={0}
                    newSessionBottomPadding={0}
                    containerStyle={{}}
                    sessionPrompt=""
                    setSessionPrompt={() => {}}
                    handleCreateSession={() => {}}
                    canCreate={true}
                    isCreating={false}
                    emptyAutocompletePrefixes={[]}
                    emptyAutocompleteSuggestions={async () => []}
                    sessionPromptInputMaxHeight={200}
                    automationSection={React.createElement('AutomationSection')}
                    agentInputExtraActionChips={[]}
                    agentType="codex"
                    handleAgentClick={() => {}}
                    permissionMode="default"
                    handlePermissionModeChange={() => {}}
                    modelMode="default"
                    setModelMode={() => {}}
                    modelOptions={[{ value: 'default', label: 'Default', description: '' }]}
                    connectionStatus={undefined}
                    machineName={undefined}
                    handleMachineClick={() => {}}
                    selectedPath=""
                    handlePathClick={() => {}}
                    showResumePicker={false}
                    resumeSessionId={null}
                    handleResumeClick={() => {}}
                    isResumeSupportChecking={false}
                    useProfiles={false}
                    selectedProfileId={null}
                    handleProfileClick={() => {}}
                    selectedProfileEnvVarsCount={0}
                    envVarsPopover={undefined}
                />,
            );
        });

        const renderedOrder = tree.root.findAll((node) => (
            String(node.type) === 'AutomationSection' || String(node.type) === 'AgentInput'
        )).map((node) => String(node.type));

        expect(renderedOrder).toEqual(['AgentInput', 'AutomationSection']);
    });

    it('uses the latest handleCreateSession callback after rerendering', async () => {
        const { NewSessionSimplePanel } = await import('./NewSessionSimplePanel');
        const firstHandleCreateSession = vi.fn();
        const secondHandleCreateSession = vi.fn();
        const previousRaf = (globalThis as any).requestAnimationFrame;
        let queuedFrame: null | FrameRequestCallback = null;
        (globalThis as any).requestAnimationFrame = vi.fn((cb: FrameRequestCallback) => {
            queuedFrame = cb;
            return 1;
        });

        let tree!: renderer.ReactTestRenderer;
        const renderPanel = (handleCreateSession: () => void) => (
            <NewSessionSimplePanel
                popoverBoundaryRef={{ current: null } as unknown as React.RefObject<any>}
                headerHeight={44}
                safeAreaTop={0}
                safeAreaBottom={0}
                newSessionTopPadding={0}
                newSessionSidePadding={0}
                newSessionBottomPadding={0}
                containerStyle={{}}
                sessionPrompt="hello"
                setSessionPrompt={() => {}}
                handleCreateSession={handleCreateSession}
                canCreate={true}
                isCreating={false}
                emptyAutocompletePrefixes={[]}
                emptyAutocompleteSuggestions={async () => []}
                sessionPromptInputMaxHeight={200}
                agentInputExtraActionChips={[]}
                agentType="codex"
                handleAgentClick={() => {}}
                permissionMode="default"
                handlePermissionModeChange={() => {}}
                modelMode="default"
                setModelMode={() => {}}
                modelOptions={[{ value: 'default', label: 'Default', description: '' }]}
                connectionStatus={undefined}
                machineName={undefined}
                handleMachineClick={() => {}}
                selectedPath=""
                handlePathClick={() => {}}
                showResumePicker={false}
                resumeSessionId={null}
                handleResumeClick={() => {}}
                isResumeSupportChecking={false}
                useProfiles={false}
                selectedProfileId={null}
                handleProfileClick={() => {}}
                selectedProfileEnvVarsCount={0}
                envVarsPopover={undefined}
            />
        );

        await act(async () => {
            tree = renderer.create(renderPanel(firstHandleCreateSession));
        });

        await act(async () => {
            tree.update(renderPanel(secondHandleCreateSession));
        });

        const send = tree.root.find((node) =>
            node.props?.testID === 'new-session-composer-send'
            && typeof node.props?.onPress === 'function'
        );
        expect(send).toBeTruthy();

        try {
            await act(async () => {
                send.props.onPress();
            });

            expect(firstHandleCreateSession).not.toHaveBeenCalled();
            expect(secondHandleCreateSession).not.toHaveBeenCalled();
            expect(queuedFrame).toBeTypeOf('function');

            await act(async () => {
                queuedFrame?.(16);
            });

            expect(firstHandleCreateSession).not.toHaveBeenCalled();
            expect(secondHandleCreateSession).toHaveBeenCalledTimes(1);
        } finally {
            if (previousRaf === undefined) {
                delete (globalThis as any).requestAnimationFrame;
            } else {
                (globalThis as any).requestAnimationFrame = previousRaf;
            }
            act(() => {
                tree.unmount();
            });
        }
    });

    it('defers web submission by one animation frame before invoking handleCreateSession', async () => {
        const { NewSessionSimplePanel } = await import('./NewSessionSimplePanel');
        const handleCreateSession = vi.fn();
        const previousRaf = (globalThis as any).requestAnimationFrame;
        let queuedFrame: null | FrameRequestCallback = null;
        (globalThis as any).requestAnimationFrame = vi.fn((cb: FrameRequestCallback) => {
            queuedFrame = cb;
            return 1;
        });

        let tree!: renderer.ReactTestRenderer;
        try {
            await act(async () => {
                tree = renderer.create(
                    <NewSessionSimplePanel
                        popoverBoundaryRef={{ current: null } as unknown as React.RefObject<any>}
                        headerHeight={44}
                        safeAreaTop={0}
                        safeAreaBottom={0}
                        newSessionTopPadding={0}
                        newSessionSidePadding={0}
                        newSessionBottomPadding={0}
                        containerStyle={{}}
                        sessionPrompt="hello"
                        setSessionPrompt={() => {}}
                        handleCreateSession={handleCreateSession}
                        canCreate={true}
                        isCreating={false}
                        emptyAutocompletePrefixes={[]}
                        emptyAutocompleteSuggestions={async () => []}
                        sessionPromptInputMaxHeight={200}
                        agentInputExtraActionChips={[]}
                        agentType="codex"
                        handleAgentClick={() => {}}
                        permissionMode="default"
                        handlePermissionModeChange={() => {}}
                        modelMode="default"
                        setModelMode={() => {}}
                        modelOptions={[{ value: 'default', label: 'Default', description: '' }]}
                        connectionStatus={undefined}
                        machineName={undefined}
                        handleMachineClick={() => {}}
                        selectedPath=""
                        handlePathClick={() => {}}
                        showResumePicker={false}
                        resumeSessionId={null}
                        handleResumeClick={() => {}}
                        isResumeSupportChecking={false}
                        useProfiles={false}
                        selectedProfileId={null}
                        handleProfileClick={() => {}}
                        selectedProfileEnvVarsCount={0}
                        envVarsPopover={undefined}
                    />,
                );
            });

            const send = tree.root.find((node) =>
                node.props?.testID === 'new-session-composer-send'
                && typeof node.props?.onPress === 'function'
            );

            await act(async () => {
                send.props.onPress();
            });

            expect(handleCreateSession).not.toHaveBeenCalled();
            expect(queuedFrame).toBeTypeOf('function');

            await act(async () => {
                queuedFrame?.(16);
            });

            expect(handleCreateSession).toHaveBeenCalledTimes(1);
        } finally {
            if (previousRaf === undefined) {
                delete (globalThis as any).requestAnimationFrame;
            } else {
                (globalThis as any).requestAnimationFrame = previousRaf;
            }
            act(() => {
                tree?.unmount();
            });
        }
    });
});
