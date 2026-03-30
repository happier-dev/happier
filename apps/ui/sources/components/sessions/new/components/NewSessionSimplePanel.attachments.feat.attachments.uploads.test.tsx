import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installNewSessionComponentsCommonModuleMocks } from './newSessionComponentsTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const AgentInputMock = vi.fn((_props: any) => null);
const mockEnv = vi.hoisted(() => ({
    iconsRenderAsText: false,
}));
const attachmentDraftState = vi.hoisted(() => ({
    drafts: [] as Array<{ id: string }>,
    hasSendableAttachments: false,
    agentInputAttachments: [] as Array<unknown>,
    clearDrafts: vi.fn(),
    applyDraftPatch: vi.fn(),
}));
const uploadAttachmentDraftsToSessionSpy = vi.hoisted(() => vi.fn());
const formatAttachmentsBlockSpy = vi.hoisted(() => vi.fn(() => ''));
const followUpSpawnedSessionWithServerScopeSpy = vi.hoisted(() => vi.fn());

installNewSessionComponentsCommonModuleMocks({
    icons: () => ({
        Ionicons: (props: Record<string, unknown>) => (
            mockEnv.iconsRenderAsText ? <>{'.'}</> : React.createElement('Ionicons', props, null)
        ),
    }),
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                React.createElement('View', props, props.children),
            Pressable: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                React.createElement('Pressable', props, props.children),
            Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                React.createElement('Text', props, props.children),
            Platform: {
                OS: 'web',
                select: (v: any) => v.web ?? v.default ?? null,
            },
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
});

vi.mock('react-native-keyboard-controller', () => ({
    KeyboardAvoidingView: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('KeyboardAvoidingView', props, props.children),
}));

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
    }),
}));

vi.mock('@/components/sessions/attachments/useAttachmentDraftManager', () => ({
    useAttachmentDraftManager: () => ({
        filePickerRef: { current: null },
        drafts: attachmentDraftState.drafts,
        hasSendableAttachments: attachmentDraftState.hasSendableAttachments,
        agentInputAttachments: attachmentDraftState.agentInputAttachments,
        addWebFiles: addWebFilesSpy,
        addPickedAttachments: addPickedAttachmentsSpy,
        removeDraft: vi.fn(),
        clearDrafts: attachmentDraftState.clearDrafts,
        applyDraftPatch: attachmentDraftState.applyDraftPatch,
    }),
}));

vi.mock('@/components/sessions/attachments/uploadAttachmentDraftsToSession', () => ({
    uploadAttachmentDraftsToSession: uploadAttachmentDraftsToSessionSpy,
    formatAttachmentsBlock: formatAttachmentsBlockSpy,
}));

vi.mock('@/sync/sync', () => ({
    sync: { sendMessage: vi.fn() },
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/followUpSpawnedSession', () => ({
    followUpSpawnedSessionWithServerScope: followUpSpawnedSessionWithServerScopeSpy,
}));

vi.mock('@/utils/platform/deferOnWeb', () => ({
    blurActiveElementOnWeb: vi.fn(),
    deferOnWeb: (callback: () => void) => callback(),
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => featureId === 'attachments.uploads',
}));

afterEach(() => {
    standardCleanup();
});

describe('NewSessionSimplePanel (attachments.uploads)', () => {
    it('wires AgentInput attachments handlers and attach action when enabled', async () => {
        const { NewSessionSimplePanel } = await import('./NewSessionSimplePanel');

        AgentInputMock.mockClear();

        await renderScreen(React.createElement(NewSessionSimplePanel, {
                    popoverBoundaryRef: { current: null } as unknown as React.RefObject<any>,
                    headerHeight: 44,
                    safeAreaTop: 0,
                    safeAreaBottom: 0,
                    newSessionTopPadding: 0,
                    newSessionSidePadding: 0,
                    newSessionBottomPadding: 0,
                    containerStyle: {},
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
                    selectedPath: '',
                    showResumePicker: false,
                    resumeSessionId: null,
                    isResumeSupportChecking: false,
                    useProfiles: false,
                    selectedProfileId: null,
                }));

        expect(AgentInputMock).toHaveBeenCalled();
        const props = (AgentInputMock.mock.calls[0]?.[0] ?? {}) as any;
        const attachmentChip = props.extraActionChips.find((c: any) => c?.key === 'attachments-add');

        expect(typeof props.onAttachmentsAdded).toBe('function');
        expect(Array.isArray(props.extraActionChips)).toBe(true);
        expect(attachmentChip).toMatchObject({
            key: 'attachments-add',
            controlId: 'attachments',
        });
        expect(typeof attachmentChip?.collapsedAction).toBe('function');
    });

    it('does not emit raw text nodes under View when the attachment icon renders as text on web', async () => {
        const { NewSessionSimplePanel } = await import('./NewSessionSimplePanel');

        AgentInputMock.mockClear();
        mockEnv.iconsRenderAsText = true;

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
                        selectedPath: '',
                        showResumePicker: false,
                        resumeSessionId: null,
                        isResumeSupportChecking: false,
                        useProfiles: false,
                        selectedProfileId: null,
                    }))).tree;

            const props = (AgentInputMock.mock.calls[0]?.[0] ?? {}) as any;
            const attachmentChip = props.extraActionChips.find((chip: any) => chip?.key === 'attachments-add');
            expect(attachmentChip).toBeTruthy();

            tree = (await renderScreen(attachmentChip.render({
                        chipStyle: () => ({}),
                        iconColor: '#000',
                        showLabel: false,
                        textStyle: {},
                    }))).tree;

            const badNodes: Array<{ parent: string | null; value: string }> = [];
            const walk = (node: any, parentType: string | null) => {
                if (node == null) return;
                if (typeof node === 'string') {
                    if (parentType !== 'Text' && node.trim().length > 0) badNodes.push({ parent: parentType, value: node });
                    return;
                }
                if (Array.isArray(node)) {
                    for (const child of node) walk(child, parentType);
                    return;
                }
                const nextParent = typeof node.type === 'string' ? node.type : parentType;
                const children = Array.isArray(node.children) ? node.children : [];
                for (const child of children) walk(child, nextParent);
            };

            if (!tree) throw new Error('Expected attachment panel tree');
            walk(tree.toJSON(), null);
            expect(badNodes).toEqual([]);
        } finally {
            mockEnv.iconsRenderAsText = false;
            await act(async () => {
                tree?.unmount();
            });
        }
    });

    it('routes first attachment follow-up through the server-scoped spawned-session helper', async () => {
        const { NewSessionSimplePanel } = await import('./NewSessionSimplePanel');

        AgentInputMock.mockClear();
        attachmentDraftState.drafts = [{ id: 'draft-1' }];
        attachmentDraftState.hasSendableAttachments = true;
        attachmentDraftState.agentInputAttachments = [{ key: 'draft-1', label: 'notes.txt' }];
        attachmentDraftState.clearDrafts.mockReset();
        attachmentDraftState.applyDraftPatch.mockReset();
        uploadAttachmentDraftsToSessionSpy.mockReset();
        formatAttachmentsBlockSpy.mockReset();
        followUpSpawnedSessionWithServerScopeSpy.mockReset();

        uploadAttachmentDraftsToSessionSpy.mockResolvedValue({
            uploaded: [{
                name: 'notes.txt',
                path: '.happier/uploads/notes.txt',
                mimeType: 'text/plain',
                sizeBytes: 12,
                sha256: 'abc123',
            }],
        });
        formatAttachmentsBlockSpy.mockReturnValue('[attachments block]');

        const handleCreateSession = vi.fn();

        await renderScreen(React.createElement(NewSessionSimplePanel, {
                    popoverBoundaryRef: { current: null } as unknown as React.RefObject<any>,
                    headerHeight: 44,
                    safeAreaTop: 0,
                    safeAreaBottom: 0,
                    newSessionTopPadding: 0,
                    newSessionSidePadding: 0,
                    newSessionBottomPadding: 0,
                    containerStyle: {},
                    sessionPrompt: 'Investigate this bug',
                    setSessionPrompt: () => {},
                    handleCreateSession,
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
                    selectedPath: '',
                    showResumePicker: false,
                    resumeSessionId: null,
                    isResumeSupportChecking: false,
                    useProfiles: true,
                    selectedProfileId: 'profile-work',
                    targetServerId: 'server-b',
                }));

        const props = (AgentInputMock.mock.calls[0]?.[0] ?? {}) as any;
        await act(async () => {
            props.onSend();
        });

        expect(handleCreateSession).toHaveBeenCalledWith(expect.objectContaining({ initialMessage: 'skip' }));

        const afterCreated = handleCreateSession.mock.calls[0]?.[0]?.afterCreated;
        expect(typeof afterCreated).toBe('function');

        await act(async () => {
            await afterCreated({
                sessionId: 'sess_target',
                effectiveSpawnServerId: 'server-a',
            });
        });

        expect(uploadAttachmentDraftsToSessionSpy).toHaveBeenCalledWith({
            sessionId: 'sess_target',
            drafts: attachmentDraftState.drafts,
            config: expect.any(Object),
            applyDraftPatch: attachmentDraftState.applyDraftPatch,
        });
        expect(followUpSpawnedSessionWithServerScopeSpy).toHaveBeenCalledWith({
            sessionId: 'sess_target',
            targetServerId: 'server-a',
            initialMessageText: 'Investigate this bug\n\n[attachments block]',
            displayText: 'Investigate this bug',
            profileId: 'profile-work',
            metaOverrides: {
                happier: {
                    kind: 'attachments.v1',
                    payload: {
                        attachments: [{
                            name: 'notes.txt',
                            path: '.happier/uploads/notes.txt',
                            mimeType: 'text/plain',
                            sizeBytes: 12,
                            sha256: 'abc123',
                        }],
                    },
                },
            },
        });
        expect(attachmentDraftState.clearDrafts).toHaveBeenCalledTimes(1);
    });
});
