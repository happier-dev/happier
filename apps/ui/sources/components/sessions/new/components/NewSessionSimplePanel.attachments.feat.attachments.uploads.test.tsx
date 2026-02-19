import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const AgentInputMock = vi.fn((_props: any) => null);

vi.mock('react-native', () => ({
    View: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('View', props, props.children),
    Platform: { OS: 'web', select: (v: any) => v.web ?? v.default ?? null },
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

vi.mock('@/components/sessions/attachments/AttachmentFilePicker', () => ({
    AttachmentFilePicker: () => null,
}));

const addWebFilesSpy = vi.fn();
const addPickedAttachmentsSpy = vi.fn();

vi.mock('@/components/sessions/attachments/useAttachmentsUploadConfig', () => ({
    useAttachmentsUploadConfig: () => ({
        uploadLocation: 'workspace',
        workspaceRelativeDir: '.happier/uploads',
        vcsIgnoreStrategy: 'git_info_exclude',
        vcsIgnoreWritesEnabled: true,
        maxFileBytes: 25 * 1024 * 1024,
        uploadTtlMs: 5 * 60 * 1000,
        chunkSizeBytes: 256 * 1024,
    }),
}));

vi.mock('@/components/sessions/attachments/useAttachmentDraftManager', () => ({
    useAttachmentDraftManager: () => ({
        filePickerRef: { current: null },
        drafts: [],
        hasSendableAttachments: false,
        agentInputAttachments: [],
        addWebFiles: addWebFilesSpy,
        addPickedAttachments: addPickedAttachmentsSpy,
        removeDraft: vi.fn(),
        clearDrafts: vi.fn(),
        applyDraftPatch: vi.fn(),
    }),
}));

vi.mock('@/components/sessions/attachments/uploadAttachmentDraftsToSession', () => ({
    uploadAttachmentDraftsToSession: vi.fn(),
    formatAttachmentsBlock: vi.fn(() => ''),
}));

vi.mock('@/sync/sync', () => ({
    sync: { sendMessage: vi.fn() },
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => featureId === 'attachments.uploads',
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: (props: Record<string, unknown>) => React.createElement('Ionicons', props, null),
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

describe('NewSessionSimplePanel (attachments.uploads)', () => {
    it('wires AgentInput attachments handlers and attach action when enabled', async () => {
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
                    agentInputExtraActionChips: [],
                    agentType: 'codex',
                    handleAgentClick: () => {},
                    permissionMode: 'default',
                    handlePermissionModeChange: () => {},
                    modelMode: 'default',
                    setModelMode: () => {},
                    modelOptions: [{ value: 'default', label: 'Default', description: '' }],
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
        const props = (AgentInputMock.mock.calls[0]?.[0] ?? {}) as any;

        expect(typeof props.onAttachmentsAdded).toBe('function');
        expect(Array.isArray(props.extraActionChips)).toBe(true);
        expect(props.extraActionChips.some((c: any) => c?.key === 'attachments-add')).toBe(true);
    });
});
