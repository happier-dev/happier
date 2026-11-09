import { createThemeFixture } from '@/dev/testkit/fixtures/themeFixtures';
import * as React from 'react';
import { createNewSessionPromptStore } from '@/components/sessions/new/hooks/screenModel/newSessionPromptStore';
import { afterEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { renderScreen } from '@/dev/testkit';
import { installNewSessionComponentsCommonModuleMocks } from './newSessionComponentsTestHelpers';
import type { AttachmentDraft } from '@/components/sessions/attachments/attachmentDraftModel';
import { clearAllNewSessionAttachmentDrafts, readNewSessionAttachmentDrafts, writeNewSessionAttachmentDrafts } from '../attachments/newSessionAttachmentDraftStore';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const AgentInputMock = vi.fn((_props: any): React.ReactNode => null);
const uploadAttachmentDraftsToSessionSpy = vi.hoisted(() => vi.fn());
const followUpSpawnedSessionWithServerScopeSpy = vi.hoisted(() => vi.fn());

afterEach(clearAllNewSessionAttachmentDrafts);

installNewSessionComponentsCommonModuleMocks({
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                alert: vi.fn(),
                confirm: vi.fn(),
            },
        }).module;
    },
});

vi.mock('react-native-keyboard-controller', () => ({
    KeyboardAvoidingView: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('KeyboardAvoidingView', props, props.children),
    useKeyboardHandler: () => {},
    useReanimatedKeyboardAnimation: () => ({
        height: { value: 0 },
        progress: { value: 0 },
    }),
}));

vi.mock('expo-linear-gradient', () => ({
    LinearGradient: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('LinearGradient', props, props.children),
}));

vi.mock('@/components/sessions/agentInput', () => ({
    AgentInput: AgentInputMock,
}));

vi.mock('@/components/sessions/attachments/AttachmentFilePicker', () => ({
    AttachmentFilePicker: () => null,
}));

vi.mock('@/components/sessions/attachments/useAttachmentsUploadConfig', () => ({
    useAttachmentsUploadConfig: () => ({
        uploadLocation: 'workspace',
        workspaceRelativeDir: '.happier/uploads',
        vcsIgnoreStrategy: 'git_info_exclude',
        vcsIgnoreWritesEnabled: true,
        maxFileBytes: 25 * 1024 * 1024,
    }),
}));

vi.mock('@/sync/domains/transfers/ops/uploadSessionAttachment', () => ({
    sessionAttachmentsUploadFile: (request: unknown) => uploadAttachmentDraftsToSessionSpy(request),
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

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: { title?: React.ReactNode; subtitle?: React.ReactNode }) =>
        React.createElement('Item', null, React.createElement('Text', null, props.title), React.createElement('Text', null, props.subtitle)),
}));
vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('ItemGroup', props, props.children),
}));
vi.mock('@/components/sessions/new/components/MachineSelector', () => ({
    MachineSelector: () => null,
}));
vi.mock('@/components/sessions/new/components/PathSelectionList', () => ({
    PathSelectionList: () => null,
}));
vi.mock('@/components/profiles/ProfilesList', () => ({
    ProfilesList: () => null,
}));
const { NewSessionWizard } = await import('./NewSessionWizard');

describe('NewSessionWizard (attachments.uploads)', () => {
    it('wires AgentInput attachments and its semantic Composer document when enabled', async () => {
        const onSelectionChangePersist = vi.fn();
        const onStructuredInputMentionsChange = vi.fn();
        const composerDocument = {
            ref: { kind: 'newSession', instanceId: 'new-session-composer-scope' },
            readScope: () => null,
            revision: 1,
            attachments: [{
                v: 1,
                instanceId: 'issue-42',
                attachment: { pluginId: 'acme.issues', localId: 'issue' },
                key: '42',
                value: { issueId: 42 },
                presentation: { label: 'Issue #42', typeLabel: 'Issue' },
            }],
            structuredInputMentions: [],
            onStructuredInputMentionsChange,
            attachmentRowItems: [{
                kind: 'badge',
                key: 'issue-42',
                label: 'Issue #42',
                availability: 'ready',
            }],
            hasSendableAttachments: true,
            captureSubmissionSnapshot: () => null,
            clearAcceptedSnapshot: () => false,
            inputPersistence: { restoreToken: 'new-session-composer-scope', onSelectionChangePersist },
        };

        AgentInputMock.mockClear();

        await renderScreen(React.createElement(NewSessionWizard, {
                    popoverBoundaryRef: { current: null } as any,
                    layout: {
                        theme: createThemeFixture(),
                        styles: {},
                        safeAreaBottom: 0,
                        headerHeight: 44,
                        newSessionSidePadding: 0,
                        newSessionBottomPadding: 0,
                    },
                    profiles: {
                        useProfiles: false,
                        profiles: [],
                        favoriteProfileIds: [],
                        setFavoriteProfileIds: () => {},
                        selectedProfileId: null,
                        onPressDefaultEnvironment: () => {},
                        onPressProfile: () => {},
                        selectedMachineId: null,
                        getProfileDisabled: () => false,
                        getProfileSubtitleExtra: () => null,
                        handleAddProfile: () => {},
                        openProfileEdit: () => {},
                        handleDuplicateProfile: () => {},
                        handleDeleteProfile: () => {},
                        openProfileEnvVarsPreview: () => {},
                        suppressNextSecretAutoPromptKeyRef: { current: null },
                        openSecretRequirementModal: () => {},
                        profilesGroupTitles: { favorites: '', custom: '', builtIn: '' },
                        getSecretOverrideReady: () => false,
                        getSecretSatisfactionForProfile: () => ({ isSatisfied: true, hasSecretRequirements: false, items: [] }),
                        getSecretMachineEnvOverride: () => null,
                        secretBindingsByProfileId: {},
                        selectedSecretIdByProfileIdByEnvVarName: {},
                        setSecretBindingChoice: () => {},
                        setSessionOnlySecretValueEnc: () => {},
                    } as any,
                    agent: {
                        cliAvailability: { available: true },
                        tmuxRequested: false,
                        enabledAgentIds: ['codex'],
                        isAgentSelectable: () => true,
                        agentType: 'codex',
                        setAgentType: () => {},
                        selectedIndicatorColor: '#000',
                        permissionMode: 'default',
                        handlePermissionModeChange: () => {},
                        modelOptions: [{ value: 'default', label: 'Default', description: '' }],
                        modelMode: 'default',
                        setModelMode: () => {},
                    } as any,
                    machine: {
                        machines: [],
                        serverId: null,
                        selectedMachine: null,
                        recentMachines: [],
                        favoriteMachineItems: [],
                        useMachinePickerSearch: false,
                        onRefreshMachines: () => {},
                        setSelectedMachineId: () => {},
                        getBestPathForMachine: () => '',
                        setSelectedPath: () => {},
                        favoriteMachines: [],
                        setFavoriteMachines: () => {},
                        selectedPath: '',
                        recentPaths: [],
                        usePathPickerSearch: false,
                        favoriteDirectories: [],
                        setFavoriteDirectories: () => {},
                    },
                    footer: {
                        promptStore: createNewSessionPromptStore(''),
                        composerDocument: composerDocument as any,
                        setSessionPrompt: () => {},
                        handleCreateSession: () => {},
                        canCreate: true,
                        isCreating: false,
                        emptyAutocompleteKinds: [],
                        emptyAutocompleteSuggestions: async () => [],
                        agentInputExtraActionChips: [],
                    },
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
        expect(props.structuredInputMentions).toEqual([]);
        expect(props.onStructuredInputMentionsChange).toBe(onStructuredInputMentionsChange);
        expect(props.hasSendableAttachments).toBe(true);
        // The input reports its caret through the document's own persistence seam,
        // so the Automation handoff reads the caret that is actually on screen.
        props.inputPersistence.onSelectionChangePersist({ start: 2, end: 2 }, 0);
        expect(onSelectionChangePersist).toHaveBeenCalledWith({ start: 2, end: 2 }, 0);
        expect(props.attachmentRowItems).toContainEqual(expect.objectContaining({
            key: 'issue-42',
            label: 'Issue #42',
        }));
    });

    it('does not render an inline automation section (automation is controlled via the action chip popover)', async () => {
        const { NewSessionWizard } = await import('./NewSessionWizard');

        const screen = await renderScreen(React.createElement(NewSessionWizard, {
            popoverBoundaryRef: { current: null } as any,
            layout: {
                theme: createThemeFixture(),
                styles: {},
                safeAreaBottom: 0,
                headerHeight: 44,
                newSessionSidePadding: 0,
                newSessionBottomPadding: 0,
            },
            profiles: {
                useProfiles: false,
                profiles: [],
                favoriteProfileIds: [],
                setFavoriteProfileIds: () => {},
                selectedProfileId: null,
                onPressDefaultEnvironment: () => {},
                onPressProfile: () => {},
                selectedMachineId: null,
                getProfileDisabled: () => false,
                getProfileSubtitleExtra: () => null,
                handleAddProfile: () => {},
                openProfileEdit: () => {},
                handleDuplicateProfile: () => {},
                handleDeleteProfile: () => {},
                openProfileEnvVarsPreview: () => {},
                suppressNextSecretAutoPromptKeyRef: { current: null },
                openSecretRequirementModal: () => {},
                profilesGroupTitles: { favorites: '', custom: '', builtIn: '' },
                getSecretOverrideReady: () => false,
                getSecretSatisfactionForProfile: () => ({ isSatisfied: true, hasSecretRequirements: false, items: [] }),
                getSecretMachineEnvOverride: () => null,
                secretBindingsByProfileId: {},
                selectedSecretIdByProfileIdByEnvVarName: {},
                setSecretBindingChoice: () => {},
                setSessionOnlySecretValueEnc: () => {},
            } as any,
            agent: {
                cliAvailability: { available: true },
                tmuxRequested: false,
                enabledAgentIds: ['codex'],
                isAgentSelectable: () => true,
                agentType: 'codex',
                setAgentType: () => {},
                selectedIndicatorColor: '#000',
                permissionMode: 'default',
                handlePermissionModeChange: () => {},
                modelOptions: [{ value: 'default', label: 'Default', description: '' }],
                modelMode: 'default',
                setModelMode: () => {},
            } as any,
            machine: {
                machines: [],
                serverId: null,
                selectedMachine: null,
                recentMachines: [],
                favoriteMachineItems: [],
                useMachinePickerSearch: false,
                onRefreshMachines: () => {},
                setSelectedMachineId: () => {},
                getBestPathForMachine: () => '',
                setSelectedPath: () => {},
                favoriteMachines: [],
                setFavoriteMachines: () => {},
                selectedPath: '',
                recentPaths: [],
                usePathPickerSearch: false,
                favoriteDirectories: [],
                setFavoriteDirectories: () => {},
            },
            footer: {
                promptStore: createNewSessionPromptStore(''),
                setSessionPrompt: () => {},
                handleCreateSession: () => {},
                canCreate: true,
                isCreating: false,
                emptyAutocompleteKinds: [],
                emptyAutocompleteSuggestions: async () => [],
                agentInputExtraActionChips: [],
            },
        }));

        expect(screen.findAllByType('AutomationSection' as any)).toHaveLength(0);
    });

    it('does not infer an offline warning from a retained machine without a Home scope', async () => {
        const { NewSessionWizard } = await import('./NewSessionWizard');

        const screen = await renderScreen(React.createElement(NewSessionWizard, {
                    popoverBoundaryRef: { current: null } as any,
                    layout: {
                        theme: createThemeFixture(),
                        styles: {},
                        safeAreaBottom: 0,
                        headerHeight: 44,
                        newSessionSidePadding: 0,
                        newSessionBottomPadding: 0,
                    },
                    profiles: {
                        useProfiles: false,
                        profiles: [],
                        favoriteProfileIds: [],
                        setFavoriteProfileIds: () => {},
                        selectedProfileId: null,
                        onPressDefaultEnvironment: () => {},
                        onPressProfile: () => {},
                        selectedMachineId: 'machine-offline',
                        getProfileDisabled: () => false,
                        getProfileSubtitleExtra: () => null,
                        handleAddProfile: () => {},
                        openProfileEdit: () => {},
                        handleDuplicateProfile: () => {},
                        handleDeleteProfile: () => {},
                        openProfileEnvVarsPreview: () => {},
                        suppressNextSecretAutoPromptKeyRef: { current: null },
                        openSecretRequirementModal: () => {},
                        profilesGroupTitles: { favorites: '', custom: '', builtIn: '' },
                        getSecretOverrideReady: () => false,
                        getSecretSatisfactionForProfile: () => ({ isSatisfied: true, hasSecretRequirements: false, items: [] }),
                        getSecretMachineEnvOverride: () => null,
                        secretBindingsByProfileId: {},
                        selectedSecretIdByProfileIdByEnvVarName: {},
                        setSecretBindingChoice: () => {},
                        setSessionOnlySecretValueEnc: () => {},
                    } as any,
                    agent: {
                        cliAvailability: { available: true },
                        tmuxRequested: false,
                        enabledAgentIds: ['codex'],
                        isAgentSelectable: () => true,
                        agentType: 'codex',
                        setAgentType: () => {},
                        selectedIndicatorColor: '#000',
                        permissionMode: 'default',
                        handlePermissionModeChange: () => {},
                        modelOptions: [{ value: 'default', label: 'Default', description: '' }],
                        modelMode: 'default',
                        setModelMode: () => {},
                    } as any,
	                    machine: {
		                        machines: [{
		                            id: 'machine-offline',
		                            seq: 1,
		                            createdAt: 0,
		                            updatedAt: 0,
		                            active: false,
		                            activeAt: 0,
		                            revokedAt: null,
		                            metadata: {
		                                host: 'offline-box',
		                                platform: 'test',
		                                happyCliVersion: '0.0.0-test',
		                                happyHomeDir: '/tmp/happy-home',
		                                homeDir: '/tmp',
		                                displayName: 'Offline Box',
		                            },
		                            metadataVersion: 1,
		                            daemonState: null,
		                            daemonStateVersion: 0,
		                        }],
	                        serverId: null,
		                        selectedMachine: {
		                            id: 'machine-offline',
		                            seq: 1,
		                            createdAt: 0,
		                            updatedAt: 0,
		                            active: false,
		                            activeAt: 0,
		                            revokedAt: null,
		                            metadata: {
		                                host: 'offline-box',
		                                platform: 'test',
		                                happyCliVersion: '0.0.0-test',
		                                happyHomeDir: '/tmp/happy-home',
		                                homeDir: '/tmp',
		                                displayName: 'Offline Box',
		                            },
		                            metadataVersion: 1,
		                            daemonState: null,
		                            daemonStateVersion: 0,
		                        },
	                        recentMachines: [],
	                        favoriteMachineItems: [],
	                        useMachinePickerSearch: false,
                        onRefreshMachines: () => {},
                        setSelectedMachineId: () => {},
                        getBestPathForMachine: () => '',
                        setSelectedPath: () => {},
                        favoriteMachines: [],
                        setFavoriteMachines: () => {},
                        selectedPath: '',
                        recentPaths: [],
                        usePathPickerSearch: false,
                        favoriteDirectories: [],
                        setFavoriteDirectories: () => {},
                    },
                    footer: {
                        promptStore: createNewSessionPromptStore(''),
                        setSessionPrompt: () => {},
                        handleCreateSession: () => {},
                        canCreate: false,
                        isCreating: false,
                        emptyAutocompleteKinds: [],
                        emptyAutocompleteSuggestions: async () => [],
                        agentInputExtraActionChips: [],
                    },
                }));

        const textValues = screen.getTextContent();

        // serverId is null: canonical reachability is Unknown, even for an inactive retained row.
        // The real-scope expiry/withdrawal/re-observation flow lives in agentInputChips.test.tsx.
        expect(textValues).not.toContain('newSession.machineOfflineInlineTitle');
        expect(textValues).not.toContain('newSession.machineOfflineInlineBody');
    });

    it('does not leave raw string children under non-Text host views', async () => {
        const { NewSessionWizard } = await import('./NewSessionWizard');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(React.createElement(NewSessionWizard, {
                    popoverBoundaryRef: { current: null } as any,
                    layout: {
                        theme: createThemeFixture(),
                        styles: {},
                        safeAreaBottom: 0,
                        headerHeight: 44,
                        newSessionSidePadding: 0,
                        newSessionBottomPadding: 0,
                    },
                    profiles: {
                        useProfiles: false,
                        profiles: [],
                        favoriteProfileIds: [],
                        setFavoriteProfileIds: () => {},
                        selectedProfileId: null,
                        onPressDefaultEnvironment: () => {},
                        onPressProfile: () => {},
                        selectedMachineId: null,
                        getProfileDisabled: () => false,
                        getProfileSubtitleExtra: () => null,
                        handleAddProfile: () => {},
                        openProfileEdit: () => {},
                        handleDuplicateProfile: () => {},
                        handleDeleteProfile: () => {},
                        openProfileEnvVarsPreview: () => {},
                        suppressNextSecretAutoPromptKeyRef: { current: null },
                        openSecretRequirementModal: () => {},
                        profilesGroupTitles: { favorites: '', custom: '', builtIn: '' },
                        getSecretOverrideReady: () => false,
                        getSecretSatisfactionForProfile: () => ({ isSatisfied: true, hasSecretRequirements: false, items: [] }),
                        getSecretMachineEnvOverride: () => null,
                        secretBindingsByProfileId: {},
                        selectedSecretIdByProfileIdByEnvVarName: {},
                        setSecretBindingChoice: () => {},
                        setSessionOnlySecretValueEnc: () => {},
                    } as any,
                    agent: {
                        cliAvailability: { available: true },
                        tmuxRequested: false,
                        enabledAgentIds: ['codex'],
                        isAgentSelectable: () => true,
                        agentType: 'codex',
                        setAgentType: () => {},
                        selectedIndicatorColor: '#000',
                        permissionMode: 'default',
                        handlePermissionModeChange: () => {},
                        modelOptions: [{ value: 'default', label: 'Default', description: '' }],
                        modelMode: 'default',
                        setModelMode: () => {},
                    } as any,
                    machine: {
                        machines: [],
                        serverId: null,
                        selectedMachine: null,
                        recentMachines: [],
                        favoriteMachineItems: [],
                        useMachinePickerSearch: false,
                        onRefreshMachines: () => {},
                        setSelectedMachineId: () => {},
                        getBestPathForMachine: () => '',
                        setSelectedPath: () => {},
                        favoriteMachines: [],
                        setFavoriteMachines: () => {},
                        selectedPath: '',
                        recentPaths: [],
                        usePathPickerSearch: false,
                        favoriteDirectories: [],
                        setFavoriteDirectories: () => {},
                    },
                    footer: {
                        promptStore: createNewSessionPromptStore(''),
                        setSessionPrompt: () => {},
                        handleCreateSession: () => {},
                        canCreate: true,
                        isCreating: false,
                        emptyAutocompleteKinds: [],
                        emptyAutocompleteSuggestions: async () => [],
                        agentInputExtraActionChips: [],
                    },
                }))).tree;

        const invalidStrings: Array<{ parentType: string | null; value: string }> = [];
        const walk = (node: any, parentType: string | null) => {
            if (node == null) return;
            if (typeof node === 'string') {
                if (parentType !== 'Text') {
                    invalidStrings.push({ parentType, value: node });
                }
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

        walk(tree!.toJSON(), null);

        expect(invalidStrings).toEqual([]);
    });

    it('routes first attachment follow-up through the server-scoped spawned-session helper', async () => {
        const { NewSessionWizard } = await import('./NewSessionWizard');

        AgentInputMock.mockClear();
        const drafts: AttachmentDraft[] = [{ id: 'draft-1', status: 'pending', source: {
            kind: 'memory', bytes: new Uint8Array(12), name: 'notes.txt', mimeType: 'text/plain',
        } }];
        writeNewSessionAttachmentDrafts('wizard-follow-up', drafts);
        uploadAttachmentDraftsToSessionSpy.mockReset();
        followUpSpawnedSessionWithServerScopeSpy.mockReset();

        uploadAttachmentDraftsToSessionSpy.mockResolvedValue({
            success: true, path: '.happier/uploads/notes.txt', sizeBytes: 12, sha256: 'a'.repeat(64),
            attachmentHandle: { v: 1, sessionId: 'sess_target', id: 'issued-notes' },
        });

        const handleCreateSession = vi.fn();

        await renderScreen(React.createElement(NewSessionWizard, {
                    popoverBoundaryRef: { current: null } as any,
                    layout: {
                        theme: createThemeFixture(),
                        styles: {},
                        safeAreaBottom: 0,
                        headerHeight: 44,
                        newSessionSidePadding: 0,
                        newSessionBottomPadding: 0,
                    },
                    profiles: {
                        useProfiles: true,
                        profiles: [],
                        favoriteProfileIds: [],
                        setFavoriteProfileIds: () => {},
                        selectedProfileId: 'profile-work',
                        onPressDefaultEnvironment: () => {},
                        onPressProfile: () => {},
                        selectedMachineId: null,
                        getProfileDisabled: () => false,
                        getProfileSubtitleExtra: () => null,
                        handleAddProfile: () => {},
                        openProfileEdit: () => {},
                        handleDuplicateProfile: () => {},
                        handleDeleteProfile: () => {},
                        openProfileEnvVarsPreview: () => {},
                        suppressNextSecretAutoPromptKeyRef: { current: null },
                        openSecretRequirementModal: () => {},
                        profilesGroupTitles: { favorites: '', custom: '', builtIn: '' },
                        getSecretOverrideReady: () => false,
                        getSecretSatisfactionForProfile: () => ({ isSatisfied: true, hasSecretRequirements: false, items: [] }),
                        getSecretMachineEnvOverride: () => null,
                        secretBindingsByProfileId: {},
                        selectedSecretIdByProfileIdByEnvVarName: {},
                        setSecretBindingChoice: () => {},
                        setSessionOnlySecretValueEnc: () => {},
                    } as any,
                    agent: {
                        cliAvailability: { available: true },
                        tmuxRequested: false,
                        enabledAgentIds: ['codex'],
                        isAgentSelectable: () => true,
                        agentType: 'codex',
                        setAgentType: () => {},
                        selectedIndicatorColor: '#000',
                        permissionMode: 'default',
                        handlePermissionModeChange: () => {},
                        modelOptions: [{ value: 'default', label: 'Default', description: '' }],
                        modelMode: 'default',
                        setModelMode: () => {},
                    } as any,
                    machine: {
                        machines: [],
                        serverId: 'server-b',
                        selectedMachine: null,
                        recentMachines: [],
                        favoriteMachineItems: [],
                        useMachinePickerSearch: false,
                        onRefreshMachines: () => {},
                        setSelectedMachineId: () => {},
                        getBestPathForMachine: () => '',
                        setSelectedPath: () => {},
                        favoriteMachines: [],
                        setFavoriteMachines: () => {},
                        selectedPath: '',
                        recentPaths: [],
                        usePathPickerSearch: false,
                        favoriteDirectories: [],
                        setFavoriteDirectories: () => {},
                    },
                    footer: {
                        promptStore: createNewSessionPromptStore('Investigate this bug'),
                        attachmentFlowId: 'wizard-follow-up',
                        setSessionPrompt: () => {},
                        handleCreateSession,
                        canCreate: true,
                        isCreating: false,
                        emptyAutocompleteKinds: [],
                        emptyAutocompleteSuggestions: async () => [],
                        agentInputExtraActionChips: [],
                    },
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
                sessionTarget: { serverId: 'server-a', accountId: 'created-account', sessionId: 'sess_target' },
                effectiveSpawnServerId: 'server-a',
                launchAttempt: {
                    attachmentMessageLocalId: 'new-session-attachment-local-1',
                },
            });
        });

        expect(followUpSpawnedSessionWithServerScopeSpy).toHaveBeenCalledWith({
            sessionId: 'sess_target',
            targetServerId: 'server-a',
            initialMessageText: 'Investigate this bug',
            displayText: undefined,
            profileId: 'profile-work',
            messageLocalId: 'new-session-attachment-local-1',
            metaOverrides: {
                happierStructuredInputV1: { v: 1, sessionAttachments: [{ v: 1, sessionId: 'sess_target', id: 'issued-notes' }] },
            },
        });
        expect(readNewSessionAttachmentDrafts('wizard-follow-up')).toEqual([]);
    });
});
