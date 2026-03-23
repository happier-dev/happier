import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectUnexpectedRawTextNodes, invokeTestInstanceHandler, renderScreen, standardCleanup } from '@/dev/testkit';
import { installNewSessionComponentsCommonModuleMocks } from './newSessionComponentsTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mockEnv = vi.hoisted(() => ({
    windowWidth: 800,
}));
const agentInputPropsRef: { current: Record<string, unknown> | null } = { current: null };

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
            ScrollView: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                React.createElement('ScrollView', props, props.children),
            ActivityIndicator: (props: Record<string, unknown>) =>
                React.createElement('ActivityIndicator', props, null),
            Platform: {
                OS: 'web',
                select: (v: any) => v.web ?? v.default ?? v.ios,
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
    icons: async () => ({
        Ionicons: () => <>{'.'}</>,
        Octicons: () => <>{'.'}</>,
    }),
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    },
    storage: async (importOriginal) => {
        const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createPartialStorageModuleMock(importOriginal, {
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
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
});

afterEach(() => {
    standardCleanup();
    vi.unstubAllGlobals();
    agentInputPropsRef.current = null;
});

vi.mock('react-native-keyboard-controller', () => ({
    KeyboardAvoidingView: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('KeyboardAvoidingView', props, props.children),
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

vi.mock('@/sync/acp/sessionModeControl', () => ({
    computeSessionModePickerControl: () => null,
}));

vi.mock('@/sync/acp/configOptionsControl', () => ({
    computeAcpConfigOptionControls: () => null,
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

vi.mock('@/utils/platform/deferOnWeb', async () => {
    const mod = await import('@/utils/platform/deferOnWeb');
    return {
        ...mod,
        deferOnWeb: (callback: () => void) => callback(),
    };
});

describe('NewSessionSimplePanel', () => {
    it('does not render the legacy visible session type selector even when the feature flag is enabled', async () => {
        const { NewSessionSimplePanel } = await import('./NewSessionSimplePanel');

        const screen = await renderScreen(
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
                selectedPath=""
                showResumePicker={false}
                resumeSessionId={null}
                isResumeSupportChecking={false}
                useProfiles={false}
                selectedProfileId={null}
            />,
        );

        const textContent = screen.getTextContent();
        expect(textContent).not.toContain('newSession.sessionType.title');
        expect(textContent).not.toContain('newSession.selectSessionTypeTitle');
    });

    it('does not emit raw text nodes under non-Text parents when icons render as text on web', async () => {
        const { NewSessionSimplePanel } = await import('./NewSessionSimplePanel');

        const screen = await renderScreen(
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
                selectedPath=""
                showResumePicker={false}
                resumeSessionId={null}
                isResumeSupportChecking={false}
                useProfiles={false}
                selectedProfileId={null}
            />,
        );

        expect(collectUnexpectedRawTextNodes(screen.tree.toJSON())).toEqual([]);
    });

    it('renders an inline automation section when provided by the shared composer model', async () => {
        const { NewSessionSimplePanel } = await import('./NewSessionSimplePanel');

        const screen = await renderScreen(
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
                selectedPath=""
                showResumePicker={false}
                resumeSessionId={null}
                isResumeSupportChecking={false}
                useProfiles={false}
                selectedProfileId={null}
            />,
        );

        expect(screen.findByType('AutomationSection' as any)).toBeTruthy();
    });

    it('renders the automation section after the agent input', async () => {
        const { NewSessionSimplePanel } = await import('./NewSessionSimplePanel');

        const screen = await renderScreen(
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
                selectedPath=""
                showResumePicker={false}
                resumeSessionId={null}
                isResumeSupportChecking={false}
                useProfiles={false}
                selectedProfileId={null}
            />,
        );

        const agentInput = screen.findByType('AgentInput' as any);
        const automationSection = screen.findByType('AutomationSection' as any);

        expect(agentInput).toBeTruthy();
        expect(automationSection).toBeTruthy();
        expect(agentInput?.parent?.children.indexOf(agentInput)).toBeLessThan(
            automationSection?.parent?.children.indexOf(automationSection) ?? -1,
        );
    });

    it('uses the latest handleCreateSession callback after rerendering', async () => {
        const { NewSessionSimplePanel } = await import('./NewSessionSimplePanel');
        const firstHandleCreateSession = vi.fn();
        const secondHandleCreateSession = vi.fn();
        agentInputPropsRef.current = null;

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
                selectedPath=""
                showResumePicker={false}
                resumeSessionId={null}
                isResumeSupportChecking={false}
                useProfiles={false}
                selectedProfileId={null}
            />
        );

        const screen = await renderScreen(renderPanel(firstHandleCreateSession));

        act(() => {
            screen.tree.update(renderPanel(secondHandleCreateSession));
        });

        const sendButton = screen.findByTestId('new-session-composer-send');
        expect(sendButton).toBeTruthy();

        act(() => {
            invokeTestInstanceHandler(sendButton, 'onPress', undefined, 'new-session-composer-send');
        });

        expect(firstHandleCreateSession).not.toHaveBeenCalled();
        expect(secondHandleCreateSession).toHaveBeenCalledTimes(1);
    });

    it('submits through the shared composer controller when send is pressed', async () => {
        const { NewSessionSimplePanel } = await import('./NewSessionSimplePanel');
        const handleCreateSession = vi.fn();
        agentInputPropsRef.current = null;

        const screen = await renderScreen(<NewSessionSimplePanel
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
                    selectedPath=""
                    showResumePicker={false}
                    resumeSessionId={null}
                    isResumeSupportChecking={false}
                    useProfiles={false}
                    selectedProfileId={null}
        />);

        const sendButton = screen.findByTestId('new-session-composer-send');
        expect(sendButton).toBeTruthy();

        act(() => {
            invokeTestInstanceHandler(sendButton, 'onPress', undefined, 'new-session-composer-send');
        });

        expect(handleCreateSession).toHaveBeenCalledTimes(1);
    });
});
