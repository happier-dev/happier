import { createThemeFixture } from '@/dev/testkit/fixtures/themeFixtures';
import * as React from 'react';
import { createNewSessionPromptStore } from '@/components/sessions/new/hooks/screenModel/newSessionPromptStore';
import renderer from 'react-test-renderer';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';

import { collectRenderedTestIds, collectUnexpectedRawTextNodes, renderScreen } from '@/dev/testkit';
import type { NewSessionLaunchAttempt } from '@/components/sessions/new/modules/newSessionLaunchAttempt';
import { installNewSessionComponentsCommonModuleMocks, resetNewSessionComponentsCommonModuleMocks } from './newSessionComponentsTestHelpers';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockEnv = vi.hoisted(() => ({
    windowWidth: 800,
    keyboardHeight: 0,
}));

const pathSelectorPropsRef: { current: Record<string, unknown> | null } = { current: null };
const modelSelectionPropsRef: { current: Record<string, unknown> | null } = { current: null };
const dropdownPropsRef: { current: Record<string, unknown> | null } = { current: null };
const agentInputPropsRef: { current: Record<string, unknown> | null } = { current: null };
let machineSelectorRenderCount = 0;
installNewSessionComponentsCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            useWindowDimensions: () => ({ width: mockEnv.windowWidth, height: 600 }),
            Dimensions: { get: () => ({ width: mockEnv.windowWidth, height: 600, scale: 1, fontScale: 1 }) },
        });
    },
});

vi.mock('react-native-keyboard-controller', () => ({
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

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement(
        'Item',
        props,
        [
            props.leftElement == null ? null : React.createElement('Text', { key: 'left' }, props.leftElement),
            props.rightElement == null ? null : React.createElement(React.Fragment, { key: 'right' }, props.rightElement),
            props.subtitle == null ? null : React.createElement('Text', { key: 'subtitle' }, props.subtitle),
        ],
    ),
}));
vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroupSelectionContext: React.createContext<{ selectableItemCount: number } | null>(null),
    ItemGroup: (props: Record<string, unknown> & { action?: React.ReactNode; children?: React.ReactNode }) =>
        React.createElement('ItemGroup', props, props.action ?? null, props.children),
}));
vi.mock('@/components/sessions/agentInput', () => ({
    AgentInput: (props: Record<string, unknown>) => {
        agentInputPropsRef.current = props;
        return React.createElement('AgentInput', { testID: 'actual-composer' });
    },
}));
vi.mock('@/components/machines/InstallableDepInstaller', () => ({
    InstallableDepInstaller: () => null,
}));
vi.mock('@/components/sessions/new/components/PathSelectionList', () => ({
    PathSelectionList: (props: Record<string, unknown>) => {
        pathSelectorPropsRef.current = props;
        return null;
    },
}));
vi.mock('@/components/sessions/new/components/NewSessionModelSelectionContent', () => ({
    NewSessionModelSelectionContent: (props: Record<string, unknown>) => {
        modelSelectionPropsRef.current = props;
        return null;
    },
}));
vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: Record<string, unknown>) => {
        dropdownPropsRef.current = props;
        return React.createElement('DropdownMenu', props);
    },
}));
vi.mock('@/components/profiles/ProfilesList', () => ({
    ProfilesList: () => null,
}));
vi.mock('@/components/sessions/attachments/AttachmentFilePicker', () => ({
    AttachmentFilePicker: () => null,
}));
vi.mock('@/components/sessions/attachments/useAttachmentsUploadConfig', () => ({
    useAttachmentsUploadConfig: () => ({ maxFileBytes: 1 }),
}));
vi.mock('@/components/sessions/attachments/useAttachmentDraftManager', () => ({
    useAttachmentDraftManager: () => ({
        filePickerRef: { current: null },
        drafts: [],
        getDraftsSnapshot: () => [],
        hasSendableAttachments: false,
        agentInputAttachments: [],
        addWebFiles: () => {},
        addPickedAttachments: () => {},
        applyDraftPatch: () => {},
        clearDrafts: () => {},
    }),
}));
vi.mock('@/components/sessions/attachments/uploadAttachmentDraftsToSession', () => ({
    uploadAttachmentDraftsToSession: vi.fn(),
}));
vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => false,
}));
vi.mock('@/sync/sync', () => ({
    sync: { sendMessage: vi.fn() },
}));

vi.mock('@/hooks/ui/useKeyboardHeight', () => ({
    useKeyboardHeight: () => mockEnv.keyboardHeight,
}));

describe('NewSessionWizard', () => {
    beforeEach(() => {
        vi.useRealTimers();
        // Other suites in the same shard can update the shared mock override state in
        // `newSessionComponentsTestHelpers`. Re-apply the overrides here so this suite
        // stays deterministic regardless of file execution order.
        installNewSessionComponentsCommonModuleMocks({
            reactNative: async () => {
                const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
                return createReactNativeWebMock({
                    useWindowDimensions: () => ({ width: mockEnv.windowWidth, height: 600 }),
                    Dimensions: { get: () => ({ width: mockEnv.windowWidth, height: 600, scale: 1, fontScale: 1 }) },
                });
            },
        });
        mockEnv.windowWidth = 800;
        mockEnv.keyboardHeight = 0;
        pathSelectorPropsRef.current = null;
        modelSelectionPropsRef.current = null;
        dropdownPropsRef.current = null;
        agentInputPropsRef.current = null;
        machineSelectorRenderCount = 0;
    });

    afterAll(() => {
        resetNewSessionComponentsCommonModuleMocks();
    });

    function flattenStyle(style: any): Record<string, any> {
        if (!style) return {};
        if (Array.isArray(style)) {
            return style.reduce((acc, entry) => ({ ...acc, ...flattenStyle(entry) }), {});
        }
        if (typeof style === 'number') return {};
        if (typeof style === 'object') return style as Record<string, any>;
        return {};
    }

    async function renderWizardForModelRefresh(
        agentOverrides: Record<string, unknown> = {},
        footerOverrides: Record<string, unknown> = {},
        machineOverrides: Record<string, unknown> = {},
    ) {
        const { NewSessionWizard } = await import('./NewSessionWizard');
        return renderScreen(<NewSessionWizard
            popoverBoundaryRef={{ current: null } as any}
            layout={{
                theme: createThemeFixture() as any,
                styles: {} as any,
                safeAreaBottom: 0,
                headerHeight: 44,
                newSessionSidePadding: 0,
                newSessionBottomPadding: 0,
            }}
            profiles={{
                useProfiles: false,
                profiles: [],
                favoriteProfileIds: [],
                setFavoriteProfileIds: () => {},
                selectedProfileId: null,
                onPressDefaultEnvironment: () => {},
                onPressProfile: () => {},
                selectedMachineId: 'machine-1',
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
            } as any}
            agent={{
                cliAvailability: { available: true },
                tmuxRequested: false,
                enabledAgentIds: ['codex'],
                isAgentSelectable: () => true,
                agentType: 'codex',
                setAgentType: () => {},
                selectedIndicatorColor: '#000',
                permissionMode: 'default',
                handlePermissionModeChange: () => {},
                modelOptions: [{ value: 'default', label: 'Use CLI settings', description: 'Use configured model' }],
                modelMode: 'default',
                setModelMode: () => {},
                ...agentOverrides,
            } as any}
            machine={{
                machines: [{
                    id: 'machine-1',
                    seq: 1,
                    createdAt: 0,
                    updatedAt: 0,
                    active: true,
                    activeAt: 0,
                    revokedAt: null,
                    metadata: {
                        host: 'box.local',
                        platform: 'test',
                        happyCliVersion: '0.0.0-test',
                        happyHomeDir: '/tmp/happy-home',
                        homeDir: '/tmp',
                        displayName: 'Box',
                    },
                    metadataVersion: 1,
                    daemonState: null,
                    daemonStateVersion: 0,
                }],
                serverId: 'server-1',
                selectedMachine: null,
                recentMachines: [],
                favoriteMachineItems: [],
                useMachinePickerSearch: false,
                onRefreshMachines: () => {},
                setSelectedMachineId: () => {},
                getBestPathForMachine: () => '/tmp',
                setSelectedPath: () => {},
                favoriteMachines: [],
                selectedPath: '/tmp',
                recentPaths: [],
                usePathPickerSearch: false,
                favoriteDirectories: [],
                setFavoriteDirectories: () => {},
                ...machineOverrides,
            } as any}
            footer={{
                promptStore: createNewSessionPromptStore(''),
                setSessionPrompt: () => {},
                handleCreateSession: () => {},
                canCreate: false,
                isCreating: false,
                emptyAutocompleteKinds: [],
                emptyAutocompleteSuggestions: async () => [],
                agentInputExtraActionChips: [],
                ...footerOverrides,
            }}
        />);
    }

    it('threads the exact Provider-bound ref through the primary wizard selection callback', async () => {
        const setModelSelection = vi.fn();
        await renderWizardForModelRefresh({ setModelSelection });
        const ref = {
            agentTargetKey: 'backend:codex',
            providerConnectionId: 'pc_work',
            modelId: 'shared-model',
        };

        (modelSelectionPropsRef.current?.onSelectSelection as ((value: typeof ref) => void) | undefined)?.(ref);

        expect(setModelSelection).toHaveBeenCalledWith(expect.objectContaining({
            v: 1,
            ref,
            updatedAt: expect.any(Number),
        }));
    });

    it('uses the shared Machine selection surface in the expanded wizard', async () => {
        const selectMachine = vi.fn();
        const screen = await renderWizardForModelRefresh({}, {
            machinePopover: {
                renderContent: () => React.createElement('Pressable', {
                    testID: 'shared-machine-selection',
                    onPress: selectMachine,
                }),
            },
        });
        await screen.pressByTestIdAsync('shared-machine-selection');
        expect(selectMachine).toHaveBeenCalledOnce();
    });

    it('uses the shared Temporary-computer destination count for adaptive Machine presentation', async () => {
        const screen = await renderWizardForModelRefresh({}, {
            machinePopover: { renderContent: () => null },
        }, {
            temporaryComputerProjection: { state: 'available', rowCount: 5 },
        });

        expect(screen.findByTestId('new-session-machine-dropdown-trigger')).toBeTruthy();
    });

    it('passes launch status badges through to the wizard composer input', async () => {
        const statusBadges = [{
            key: 'new-session-launch-starting',
            label: 'newSession.startingSession',
            testID: 'new-session-launch-status',
            tone: 'active' as const,
        }];

        await renderWizardForModelRefresh({}, {
            isCreating: true,
            statusBadges,
        });

        expect(agentInputPropsRef.current?.statusBadges).toBe(statusBadges);
    });

    it('updates prompt presentation without re-rendering wizard selection sections', async () => {
        const promptStore = createNewSessionPromptStore('Initial prompt');
        const screen = await renderWizardForModelRefresh({}, {
            promptStore,
            machinePopover: { renderContent: () => { machineSelectorRenderCount += 1; return null; } },
        });
        const selectionRenderCount = machineSelectorRenderCount;
        expect(selectionRenderCount).toBeGreaterThan(0);

        await renderer.act(async () => {
            promptStore.setPrompt('Updated prompt');
        });

        expect(agentInputPropsRef.current?.value).toBe('Updated prompt');
        expect(machineSelectorRenderCount).toBe(selectionRenderCount);
        await screen.unmount();
    });

    it('renders host notice content before the composer and passes trailing status actions through', async () => {
        const composerTopContent = React.createElement('ComposerNotice', { testID: 'composer-notice' });
        const statusTrailingActions = React.createElement('StatusActions', { testID: 'status-actions' });
        const screen = await renderWizardForModelRefresh({}, {
            composerTopContent,
            statusTrailingActions,
        });

        const relevantRenderedOrder = collectRenderedTestIds(screen.tree.toJSON()).filter(
            (testID) => testID === 'composer-notice' || testID === 'actual-composer',
        );
        expect(relevantRenderedOrder).toEqual(['composer-notice', 'actual-composer']);
        expect(agentInputPropsRef.current?.statusTrailingActions).toBe(statusTrailingActions);
        await screen.unmount();
    });

    it('renders the submitted prompt as pending wizard launch content while creation is unresolved', async () => {
        const pendingLaunchAttempt: NewSessionLaunchAttempt = {
            attemptId: 'attempt-1',
            spawnNonce: 'spawn-1',
            scopeKey: 'scope-1',
            createdSessionId: null,
            firstTurnLocalId: 'first-turn-1',
            attachmentMessageLocalId: 'attachment-1',
            configurationUpdatedAtMs: 0,
            status: 'spawning',
            prompt: {
                prompt: 'Build the wizard pending launch state',
                displayText: 'Build the wizard pending launch state',
                meta: null,
            },
            phaseErrors: {},
        };

        const screen = await renderWizardForModelRefresh({}, {
            promptStore: createNewSessionPromptStore('Build the wizard pending launch state'),
            isCreating: true,
            pendingLaunchAttempt,
            launchPendingPreviewVisible: true,
        });

        expect(screen.findByProps({ testID: 'new-session-launch-pending-preview' })).toBeTruthy();
        expect(screen.findByProps({ testID: 'new-session-launch-pending-preview-prompt' }).props.children)
            .toBe('Build the wizard pending launch state');
    });

    // `resolveNewSessionLaunchPresentation` already decided that this compact card
    // is the active presentation. The Wizard places it and forms no second opinion
    // — the two independent opinions are exactly how a Temporary-computer request
    // ended up with a pending card behind its own blocking waiting surface.
    it('places the resolved pending launch card without re-deciding whether a launch is pending', async () => {
        const pendingLaunchAttempt: NewSessionLaunchAttempt = {
            attemptId: 'attempt-2',
            spawnNonce: 'spawn-2',
            scopeKey: 'scope-2',
            createdSessionId: null,
            firstTurnLocalId: 'first-turn-2',
            attachmentMessageLocalId: 'attachment-2',
            configurationUpdatedAtMs: 0,
            status: 'idle',
            prompt: {
                prompt: 'Resolved upstream',
                displayText: 'Resolved upstream',
                meta: null,
            },
            phaseErrors: {},
        };

        const screen = await renderWizardForModelRefresh({}, {
            promptStore: createNewSessionPromptStore('Resolved upstream'),
            // Deliberately not "creating": the layout must trust the resolved
            // presentation instead of re-deriving it from its own props.
            isCreating: false,
            pendingLaunchAttempt,
            launchPendingPreviewVisible: true,
        });

        expect(screen.findByProps({ testID: 'new-session-launch-pending-preview-prompt' }).props.children)
            .toBe('Resolved upstream');
    });

    it('renders no pending launch card when the resolved presentation is not the machine card', async () => {
        const pendingLaunchAttempt: NewSessionLaunchAttempt = {
            attemptId: 'attempt-3',
            spawnNonce: 'spawn-3',
            scopeKey: 'scope-3',
            createdSessionId: null,
            firstTurnLocalId: 'first-turn-3',
            attachmentMessageLocalId: 'attachment-3',
            configurationUpdatedAtMs: 0,
            status: 'spawning',
            prompt: { prompt: 'Still editing', displayText: 'Still editing', meta: null },
            phaseErrors: {},
        };

        const screen = await renderWizardForModelRefresh({}, {
            promptStore: createNewSessionPromptStore('Still editing'),
            // A Temporary-computer launch looks exactly like this: creating, with a
            // real pending attempt, while its own blocking surface owns the screen.
            isCreating: true,
            pendingLaunchAttempt,
            launchPendingPreviewVisible: false,
        });

        expect(screen.findByTestId('new-session-launch-pending-preview')).toBeNull();
    });

    it('renders the canonical typed Provider launch recovery above the primary wizard composer', async () => {
        const providerLaunchError = createProviderErrorV1('provider_not_enabled_on_machine', {
            connectionId: 'pc_provider',
            machineId: 'machine-1',
        });
        const screen = await renderWizardForModelRefresh({}, {
            ...({ providerLaunchError, retryProviderLaunch: vi.fn() } as Record<string, unknown>),
        });

        expect(screen.findByProps({
            testID: 'provider-error:provider_not_enabled_on_machine',
        })).toBeTruthy();
        expect(screen.findByProps({
            testID: 'provider-error-action:provider_not_enabled_on_machine',
        })).toBeTruthy();
    });

    it('does not force the wizard shell to full-height on wide web layouts', async () => {
        mockEnv.windowWidth = 900;
        try {
            const { NewSessionWizard } = await import('./NewSessionWizard');

            const screen = await renderScreen(<NewSessionWizard
                popoverBoundaryRef={{ current: null } as any}
                layout={{
                    theme: createThemeFixture() as any,
                    styles: {
                        container: { flex: 0 },
                    } as any,
                    safeAreaBottom: 0,
                    headerHeight: 44,
                    newSessionSidePadding: 0,
                    newSessionBottomPadding: 0,
                }}
                profiles={{
                    useProfiles: false,
                    profiles: [],
                    favoriteProfileIds: [],
                    setFavoriteProfileIds: () => {},
                    selectedProfileId: null,
                    onPressDefaultEnvironment: () => {},
                    onPressProfile: () => {},
                    selectedMachineId: 'machine-1',
                    getProfileDisabled: () => false,
                    getProfileSubtitleExtra: () => null,
                    handleAddProfile: () => {},
                    openProfileEdit: () => {},
                    handleDuplicateProfile: () => {},
                    handleDeleteProfile: () => {},
                    openProfileEnvVarsPreview: () => {},
                    suppressNextSecretAutoPromptKeyRef: { current: null },
                    openSecretRequirementModal: () => {},
                    profilesGroupTitles: { favorites: 'Favorites', custom: 'Custom', builtIn: 'Built in' },
                    getSecretOverrideReady: () => true,
                    getSecretSatisfactionForProfile: () => ({ isSatisfied: true }),
                } as any}
                agent={{
                    cliAvailability: { available: {}, isLoaded: true } as any,
                    tmuxRequested: false,
                    enabledAgentIds: ['codex'] as any,
                    isAgentSelectable: () => true,
                    agentType: 'codex' as any,
                    setAgentType: () => {},
                    modelOptions: [{ value: 'default', label: 'Default', description: '' }] as any,
                    setModelMode: () => {},
                    selectedIndicatorColor: '#000',
                    profileMap: new Map(),
                    permissionMode: 'default',
                    handlePermissionModeChange: () => {},
                } as any}
                machine={{
                    machines: [{
                        id: 'machine-1',
                        active: true,
                        activeAt: 0,
                        revokedAt: null,
                        metadata: {
                            host: 'box.local',
                            platform: 'test',
                            happyCliVersion: '0.0.0-test',
                            happyHomeDir: '/tmp/happy-home',
                            homeDir: '/tmp',
                            displayName: 'Box',
                        },
                        metadataVersion: 1,
                        daemonState: null,
                        daemonStateVersion: 0,
                    }],
                    serverId: 'server-1',
                    selectedMachine: null,
                    recentMachines: [],
                    favoriteMachineItems: [],
                    useMachinePickerSearch: false,
                    onRefreshMachines: () => {},
                    setSelectedMachineId: () => {},
                    getBestPathForMachine: () => '/tmp',
                    setSelectedPath: () => {},
                    favoriteMachines: [],
                    selectedPath: '/tmp',
                    recentPaths: [],
                    usePathPickerSearch: false,
                    favoriteDirectories: [],
                    setFavoriteDirectories: () => {},
                } as any}
                footer={{
                    promptStore: createNewSessionPromptStore(''),
                    setSessionPrompt: () => {},
                    handleCreateSession: () => {},
                    canCreate: true,
                    isCreating: false,
                    emptyAutocompleteKinds: [],
                    emptyAutocompleteSuggestions: async () => [],
                    sessionPromptInputMaxHeight: 200,
                    isResumeSupportChecking: false,
                    resumeSessionId: null,
                    connectionStatus: undefined,
                    showResumePicker: false,
                } as any}
            />);

            expect(screen.findByProps({ testID: 'new-session-wizard-composer-keyboard-host' })).toBeTruthy();
            expect(screen.findAllByType('View').some((node) => flattenStyle(node.props.style).flex === 0)).toBe(true);
        } finally {
            mockEnv.windowWidth = 800;
        }
    });

    it('applies the top safe-area inset to the wizard content on iOS', async () => {
        const { NewSessionWizard } = await import('./NewSessionWizard');

        const screen = await renderScreen(<NewSessionWizard
            popoverBoundaryRef={{ current: null } as any}
            layout={{
                theme: createThemeFixture() as any,
                styles: {} as any,
                safeAreaTop: 18,
                safeAreaBottom: 0,
                headerHeight: 44,
                newSessionTopPadding: 14,
                newSessionSidePadding: 0,
                newSessionBottomPadding: 0,
            } as any}
            profiles={{
                useProfiles: true,
                profiles: [],
                favoriteProfileIds: [],
                setFavoriteProfileIds: () => {},
                selectedProfileId: null,
                onPressDefaultEnvironment: () => {},
                onPressProfile: () => {},
                selectedMachineId: 'machine-1',
                getProfileDisabled: () => false,
                getProfileSubtitleExtra: () => null,
                handleAddProfile: () => {},
                openProfileEdit: () => {},
                handleDuplicateProfile: () => {},
                handleDeleteProfile: () => {},
                openProfileEnvVarsPreview: () => {},
                suppressNextSecretAutoPromptKeyRef: { current: null },
                openSecretRequirementModal: () => {},
                profilesGroupTitles: { favorites: 'Favorites', custom: 'Custom', builtIn: 'Built in' },
                getSecretOverrideReady: () => true,
                getSecretSatisfactionForProfile: () => ({ isSatisfied: true }),
            } as any}
            agent={{
                cliAvailability: { available: { codex: true }, isLoaded: true } as any,
                tmuxRequested: false,
                enabledAgentIds: ['codex'] as any,
                isAgentSelectable: () => true,
                agentType: 'codex' as any,
                setAgentType: () => {},
                modelOptions: [] as any,
                setModelMode: () => {},
                selectedIndicatorColor: '#000',
                profileMap: new Map(),
                permissionMode: 'default',
                handlePermissionModeChange: () => {},
            } as any}
            machine={{
                machines: [{
                    id: 'machine-1',
                    active: true,
                    activeAt: Date.now(),
                    revokedAt: null,
                    metadata: {
                        host: 'box.local',
                        platform: 'test',
                        happyCliVersion: '0.0.0-test',
                        happyHomeDir: '/tmp/happy-home',
                        homeDir: '/tmp',
                        displayName: 'Box',
                    },
                    metadataVersion: 1,
                    daemonState: null,
                    daemonStateVersion: 0,
                }],
                serverId: 'server-1',
                selectedMachine: null,
                recentMachines: [],
                favoriteMachineItems: [],
                useMachinePickerSearch: false,
                onRefreshMachines: () => {},
                setSelectedMachineId: () => {},
                getBestPathForMachine: () => '/tmp',
                setSelectedPath: () => {},
                favoriteMachines: [],
                selectedPath: '/tmp',
                recentPaths: [],
                usePathPickerSearch: false,
                favoriteDirectories: [],
                setFavoriteDirectories: () => {},
            } as any}
            footer={{
                promptStore: createNewSessionPromptStore(''),
                setSessionPrompt: () => {},
                handleCreateSession: () => {},
                canCreate: false,
                isCreating: false,
                emptyAutocompleteKinds: [],
                emptyAutocompleteSuggestions: async () => [],
                agentInputExtraActionChips: [],
            }}
        />);

        // The wizard's page list carries the inset on its content (`ItemList` `containerStyle`).
        const contentWrapper = screen.tree.root.findAll((node: any) => (
            typeof node.type === 'string'
            && flattenStyle(node.props?.contentContainerStyle).paddingTop === 18
        ))[0];

        expect(contentWrapper).toBeDefined();
    });

    it('stretches the footer padding wrapper to full width on web (avoids shrink-to-fit collapse)', async () => {
        mockEnv.windowWidth = 1200;
        try {
            const { NewSessionWizard } = await import('./NewSessionWizard');

            const screen = await renderScreen(<NewSessionWizard
                popoverBoundaryRef={{ current: null } as any}
                layout={{
                    theme: createThemeFixture() as any,
                    styles: {} as any,
                    safeAreaBottom: 0,
                    headerHeight: 44,
                    newSessionSidePadding: 123,
                    newSessionBottomPadding: 0,
                }}
                profiles={{
                    useProfiles: false,
                    profiles: [],
                    favoriteProfileIds: [],
                    setFavoriteProfileIds: () => {},
                    selectedProfileId: null,
                    onPressDefaultEnvironment: () => {},
                    onPressProfile: () => {},
                    selectedMachineId: 'machine-1',
                    getProfileDisabled: () => false,
                    getProfileSubtitleExtra: () => null,
                    handleAddProfile: () => {},
                    openProfileEdit: () => {},
                    handleDuplicateProfile: () => {},
                    handleDeleteProfile: () => {},
                    openProfileEnvVarsPreview: () => {},
                    suppressNextSecretAutoPromptKeyRef: { current: null },
                    openSecretRequirementModal: () => {},
                    profilesGroupTitles: { favorites: 'Favorites', custom: 'Custom', builtIn: 'Built in' },
                    getSecretOverrideReady: () => true,
                    getSecretSatisfactionForProfile: () => ({ isSatisfied: true }),
                } as any}
                agent={{
                    cliAvailability: { available: {}, isLoaded: true } as any,
                    tmuxRequested: false,
                    enabledAgentIds: ['codex'] as any,
                    isAgentSelectable: () => true,
                    agentType: 'codex' as any,
                    setAgentType: () => {},
                    modelOptions: [{ value: 'default', label: 'Default', description: '' }] as any,
                    setModelMode: () => {},
                    selectedIndicatorColor: '#000',
                    profileMap: new Map(),
                    permissionMode: 'default',
                    handlePermissionModeChange: () => {},
                } as any}
                machine={{
                    machines: [{
                        id: 'machine-1',
                        active: true,
                        activeAt: 0,
                        revokedAt: null,
                        metadata: {
                            host: 'box.local',
                            platform: 'test',
                            happyCliVersion: '0.0.0-test',
                            happyHomeDir: '/tmp/happy-home',
                            homeDir: '/tmp',
                            displayName: 'Box',
                        },
                        metadataVersion: 1,
                        daemonState: null,
                        daemonStateVersion: 0,
                    }],
                    serverId: 'server-1',
                    selectedMachine: null,
                    recentMachines: [],
                    favoriteMachineItems: [],
                    useMachinePickerSearch: false,
                    onRefreshMachines: () => {},
                    setSelectedMachineId: () => {},
                    getBestPathForMachine: () => '/tmp',
                    setSelectedPath: () => {},
                    favoriteMachines: [],
                    selectedPath: '/tmp',
                    recentPaths: [],
                    usePathPickerSearch: false,
                    favoriteDirectories: [],
                    setFavoriteDirectories: () => {},
                } as any}
                footer={{
                    promptStore: createNewSessionPromptStore(''),
                    setSessionPrompt: () => {},
                    handleCreateSession: () => {},
                    canCreate: true,
                    isCreating: false,
                    emptyAutocompleteKinds: [],
                    emptyAutocompleteSuggestions: async () => [],
                    sessionPromptInputMaxHeight: 200,
                    isResumeSupportChecking: false,
                    resumeSessionId: null,
                    connectionStatus: undefined,
                    showResumePicker: false,
                } as any}
            />);

            const paddedViews = screen
                .findAllByType('View')
                .filter((node) => flattenStyle(node.props.style).paddingHorizontal === 123);
            expect(paddedViews).toHaveLength(1);
            expect(flattenStyle(paddedViews[0].props.style).width).toBe('100%');
            expect(flattenStyle(paddedViews[0].props.style).alignSelf).toBe('stretch');
        } finally {
            mockEnv.windowWidth = 800;
        }
    });

    it('anchors the wizard shell to the bottom on narrow mobile web layouts', async () => {
        mockEnv.windowWidth = 390;
        mockEnv.keyboardHeight = 48;
        try {
            const { NewSessionWizard } = await import('./NewSessionWizard');

            const screen = await renderScreen(<NewSessionWizard
                            popoverBoundaryRef={{ current: null } as any}
                            layout={{
                                theme: createThemeFixture() as any,
                                styles: {} as any,
                                safeAreaBottom: 0,
                                headerHeight: 44,
                                newSessionSidePadding: 0,
                                newSessionBottomPadding: 8,
                            }}
                            profiles={{
                                useProfiles: false,
                                profiles: [],
                                favoriteProfileIds: [],
                                setFavoriteProfileIds: () => {},
                                selectedProfileId: null,
                                onPressDefaultEnvironment: () => {},
                                onPressProfile: () => {},
                                selectedMachineId: 'machine-1',
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
                            } as any}
                            agent={{
                                cliAvailability: { available: true },
                                tmuxRequested: false,
                                enabledAgentIds: ['codex'],
                                isAgentSelectable: () => true,
                                agentType: 'codex',
                                setAgentType: () => {},
                                selectedIndicatorColor: '#000',
                                permissionMode: 'default',
                                handlePermissionModeChange: () => {},
                                modelOptions: [],
                                modelMode: 'default',
                                setModelMode: () => {},
                            } as any}
                            machine={{
                                machines: [{
                                    id: 'machine-1',
                                    seq: 1,
                                    createdAt: 0,
                                    updatedAt: 0,
                                    active: true,
                                    activeAt: 0,
                                    revokedAt: null,
                                    metadata: {
                                        host: 'box.local',
                                        platform: 'test',
                                        happyCliVersion: '0.0.0-test',
                                        happyHomeDir: '/tmp/happy-home',
                                        homeDir: '/tmp',
                                        displayName: 'Box',
                                    },
                                    metadataVersion: 1,
                                    daemonState: null,
                                    daemonStateVersion: 0,
                                }],
                                serverId: 'server-1',
                                selectedMachine: null,
                                recentMachines: [],
                                favoriteMachineItems: [],
                                useMachinePickerSearch: false,
                                onRefreshMachines: () => {},
                                setSelectedMachineId: () => {},
                                getBestPathForMachine: () => '/tmp',
                                setSelectedPath: () => {},
                                favoriteMachines: [],
                                selectedPath: '/tmp',
                                recentPaths: [],
                                usePathPickerSearch: false,
                                favoriteDirectories: [],
                                setFavoriteDirectories: () => {},
                            } as any}
                            footer={{
                                promptStore: createNewSessionPromptStore(''),
                                setSessionPrompt: () => {},
                                handleCreateSession: () => {},
                                canCreate: true,
                                isCreating: false,
                                emptyAutocompleteKinds: [],
                                emptyAutocompleteSuggestions: async () => [],
                                sessionPromptInputMaxHeight: 200,
                                isResumeSupportChecking: false,
                                resumeSessionId: null,
                                connectionStatus: undefined,
                                showResumePicker: false,
                            } as any}
                        />);

            const allViews = screen.findAllByType('View');
            expect(screen.findByProps({ testID: 'new-session-wizard-composer-keyboard-host' })).toBeTruthy();
            expect(allViews.some((node) => flattenStyle(node.props.style).justifyContent === 'flex-end')).toBe(true);
            expect(allViews.some((node) => flattenStyle(node.props.style).paddingTop === 12 && flattenStyle(node.props.style).paddingBottom === 8)).toBe(true);
        } finally {
            mockEnv.windowWidth = 800;
        }
    });

    it('does not render the legacy visible session type section even when the feature flag is enabled', async () => {
        const { NewSessionWizard } = await import('./NewSessionWizard');

        const screen = await renderScreen(<NewSessionWizard
                        popoverBoundaryRef={{ current: null } as any}
                        layout={{
                            theme: createThemeFixture() as any,
                            styles: {} as any,
                            safeAreaBottom: 0,
                            headerHeight: 44,
                            newSessionSidePadding: 0,
                            newSessionBottomPadding: 0,
                        }}
                        profiles={{
                            useProfiles: false,
                            profiles: [],
                            favoriteProfileIds: [],
                            setFavoriteProfileIds: () => {},
                            selectedProfileId: null,
                            onPressDefaultEnvironment: () => {},
                            onPressProfile: () => {},
                            selectedMachineId: 'machine-1',
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
                        } as any}
                        agent={{
                            cliAvailability: { available: true },
                            tmuxRequested: false,
                            enabledAgentIds: ['codex'],
                            isAgentSelectable: () => true,
                            agentType: 'codex',
                            setAgentType: () => {},
                            selectedIndicatorColor: '#000',
                            permissionMode: 'default',
                            handlePermissionModeChange: () => {},
                            modelOptions: [],
                            modelMode: 'default',
                            setModelMode: () => {},
                        } as any}
                        machine={{
                            machines: [{
                                id: 'machine-1',
                                seq: 1,
                                createdAt: 0,
                                updatedAt: 0,
                                active: true,
                                activeAt: 0,
                                revokedAt: null,
                                metadata: {
                                    host: 'box.local',
                                    platform: 'test',
                                    happyCliVersion: '0.0.0-test',
                                    happyHomeDir: '/tmp/happy-home',
                                    homeDir: '/tmp',
                                    displayName: 'Box',
                                },
                                metadataVersion: 1,
                                daemonState: null,
                                daemonStateVersion: 0,
                            }],
                            serverId: 'server-1',
                            selectedMachine: {
                                id: 'machine-1',
                                seq: 1,
                                createdAt: 0,
                                updatedAt: 0,
                                active: true,
                                activeAt: 0,
                                revokedAt: null,
                                metadata: {
                                    host: 'box.local',
                                    platform: 'test',
                                    happyCliVersion: '0.0.0-test',
                                    happyHomeDir: '/tmp/happy-home',
                                    homeDir: '/tmp',
                                    displayName: 'Box',
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
                            getBestPathForMachine: () => '/tmp',
                            setSelectedPath: () => {},
                            favoriteMachines: [],
                            selectedPath: '/tmp',
                            recentPaths: [],
                            usePathPickerSearch: false,
                            favoriteDirectories: [],
                            setFavoriteDirectories: () => {},
                        } as any}
                        footer={{
                            promptStore: createNewSessionPromptStore(''),
                            setSessionPrompt: () => {},
                            handleCreateSession: () => {},
                            canCreate: false,
                            isCreating: false,
                            emptyAutocompleteKinds: [],
                            emptyAutocompleteSuggestions: async () => [],
                            agentInputExtraActionChips: [],
                        }}
                    />);
        try {
            const textContent = screen.getTextContent();
            expect(textContent).not.toContain('newSession.selectSessionTypeTitle');
            expect(textContent).not.toContain('newSession.selectSessionTypeDescription');
        } finally {
            await screen.unmount();
        }
    });

    it('passes machine browsing config through to the shared path selector', async () => {
        pathSelectorPropsRef.current = null;
        const { NewSessionWizard } = await import('./NewSessionWizard');

        await renderScreen(<NewSessionWizard
                        popoverBoundaryRef={{ current: null } as any}
                        layout={{
                            theme: createThemeFixture() as any,
                        styles: {} as any,
                        safeAreaBottom: 0,
                        headerHeight: 44,
                        newSessionSidePadding: 0,
                        newSessionBottomPadding: 0,
                    }}
                    profiles={{
                        useProfiles: false,
                        profiles: [],
                        favoriteProfileIds: [],
                        setFavoriteProfileIds: () => {},
                        selectedProfileId: null,
                        onPressDefaultEnvironment: () => {},
                        onPressProfile: () => {},
                        selectedMachineId: 'machine-1',
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
                    } as any}
                    agent={{
                        cliAvailability: { available: true },
                        tmuxRequested: false,
                        enabledAgentIds: ['codex'],
                        isAgentSelectable: () => true,
                        agentType: 'codex',
                        setAgentType: () => {},
                        selectedIndicatorColor: '#000',
                        permissionMode: 'default',
                        handlePermissionModeChange: () => {},
                        modelOptions: [],
                        modelMode: 'default',
                        setModelMode: () => {},
                    } as any}
                    machine={{
                        machines: [{
                            id: 'machine-1',
                            seq: 1,
                            createdAt: 0,
                            updatedAt: 0,
                            active: true,
                            activeAt: 0,
                            revokedAt: null,
                            metadata: {
                                host: 'box.local',
                                platform: 'test',
                                happyCliVersion: '0.0.0-test',
                                happyHomeDir: '/tmp/happy-home',
                                homeDir: '/tmp',
                                displayName: 'Box',
                            },
                            metadataVersion: 1,
                            daemonState: null,
                            daemonStateVersion: 0,
                        }],
                        serverId: 'server-1',
                        selectedMachine: {
                            id: 'machine-1',
                            seq: 1,
                            createdAt: 0,
                            updatedAt: 0,
                            active: true,
                            activeAt: 0,
                            revokedAt: null,
                            metadata: {
                                host: 'box.local',
                                platform: 'test',
                                happyCliVersion: '0.0.0-test',
                                happyHomeDir: '/tmp/happy-home',
                                homeDir: '/tmp',
                                displayName: 'Box',
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
                        getBestPathForMachine: () => '/tmp',
                        setSelectedPath: () => {},
                        favoriteMachines: [],
                        selectedPath: '/tmp',
                        recentPaths: [],
                        usePathPickerSearch: false,
                        favoriteDirectories: [],
                        setFavoriteDirectories: () => {},
                    } as any}
                    footer={{
                        promptStore: createNewSessionPromptStore(''),
                        setSessionPrompt: () => {},
                        handleCreateSession: () => {},
                        canCreate: false,
                        isCreating: false,
                        emptyAutocompleteKinds: [],
                        emptyAutocompleteSuggestions: async () => [],
                        agentInputExtraActionChips: [],
                    }}
                />);

        expect(pathSelectorPropsRef.current).toMatchObject({
            machineId: 'machine-1',
            serverId: 'server-1',
        });
    });

    it('renders stable wizard model testIDs for inline model options', async () => {
        const { NewSessionWizard } = await import('./NewSessionWizard');

        const screen = await renderScreen(<NewSessionWizard
                        popoverBoundaryRef={{ current: null } as any}
                        layout={{
                            theme: createThemeFixture() as any,
                        styles: {} as any,
                        safeAreaBottom: 0,
                        headerHeight: 44,
                        newSessionSidePadding: 0,
                        newSessionBottomPadding: 0,
                    }}
                    profiles={{
                        useProfiles: false,
                        profiles: [],
                        favoriteProfileIds: [],
                        setFavoriteProfileIds: () => {},
                        selectedProfileId: null,
                        onPressDefaultEnvironment: () => {},
                        onPressProfile: () => {},
                        selectedMachineId: 'machine-1',
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
                    } as any}
                    agent={{
                        cliAvailability: { available: true },
                        tmuxRequested: false,
                        enabledAgentIds: ['codex'],
                        isAgentSelectable: () => true,
                        agentType: 'codex',
                        setAgentType: () => {},
                        selectedIndicatorColor: '#000',
                        permissionMode: 'default',
                        handlePermissionModeChange: () => {},
                        modelOptions: [
                            { value: 'gpt-5.4', label: 'GPT-5.4', description: 'Primary model' },
                            { value: 'gpt-5.4-mini', label: 'GPT-5.4 mini', description: 'Faster model' },
                        ],
                        modelMode: 'gpt-5.4-mini',
                        setModelMode: () => {},
                    } as any}
                    machine={{
                        machines: [{
                            id: 'machine-1',
                            seq: 1,
                            createdAt: 0,
                            updatedAt: 0,
                            active: true,
                            activeAt: 0,
                            revokedAt: null,
                            metadata: {
                                host: 'box.local',
                                platform: 'test',
                                happyCliVersion: '0.0.0-test',
                                happyHomeDir: '/tmp/happy-home',
                                homeDir: '/tmp',
                                displayName: 'Box',
                            },
                            metadataVersion: 1,
                            daemonState: null,
                            daemonStateVersion: 0,
                        }],
                        serverId: 'server-1',
                        selectedMachine: {
                            id: 'machine-1',
                            seq: 1,
                            createdAt: 0,
                            updatedAt: 0,
                            active: true,
                            activeAt: 0,
                            revokedAt: null,
                            metadata: {
                                host: 'box.local',
                                platform: 'test',
                                happyCliVersion: '0.0.0-test',
                                happyHomeDir: '/tmp/happy-home',
                                homeDir: '/tmp',
                                displayName: 'Box',
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
                        getBestPathForMachine: () => '/tmp',
                        setSelectedPath: () => {},
                        favoriteMachines: [],
                        selectedPath: '/tmp',
                        recentPaths: [],
                        usePathPickerSearch: false,
                        favoriteDirectories: [],
                        setFavoriteDirectories: () => {},
                    } as any}
                    footer={{
                        promptStore: createNewSessionPromptStore(''),
                        setSessionPrompt: () => {},
                        handleCreateSession: () => {},
                        canCreate: false,
                        isCreating: false,
                        emptyAutocompleteKinds: [],
                        emptyAutocompleteSuggestions: async () => [],
                        agentInputExtraActionChips: [],
                    }}
                />);

        expect(modelSelectionPropsRef.current?.modelOptions).toEqual([
            { value: 'gpt-5.4', label: 'GPT-5.4', description: 'Primary model' },
            { value: 'gpt-5.4-mini', label: 'GPT-5.4 mini', description: 'Faster model' },
        ]);
        expect(modelSelectionPropsRef.current?.selectedModelId).toBe('gpt-5.4-mini');
    });

    it('renders the wizard model refresh action when model options can be refreshed', async () => {
        const onRefresh = vi.fn();

        const screen = await renderWizardForModelRefresh({
            modelOptionsProbe: { phase: 'idle', onRefresh },
        });

        screen.pressByTestId('new-session-model-refresh');

        expect(onRefresh).toHaveBeenCalledTimes(1);
    });

    it('keeps the wizard model section visible with a loading indicator while models are loading', async () => {
        const onRefresh = vi.fn();

        const screen = await renderWizardForModelRefresh({
            modelOptions: [],
            modelOptionsProbe: { phase: 'loading', onRefresh },
        });

        expect(screen.findByTestId('new-session-model-refresh')).toBeTruthy();
        await screen.pressByTestIdAsync('new-session-model-refresh').catch(() => {});
        expect(onRefresh).not.toHaveBeenCalled();
        expect(modelSelectionPropsRef.current?.modelOptions).toEqual([]);
        expect(screen.tree.root.findAllByProps({ accessibilityRole: 'progressbar' }).length).toBeGreaterThan(0);
    });

    it('applies forced dropdown presentation to wizard machine, path, model, and permission sections', async () => {
        mockEnv.windowWidth = 1200;
        const { NewSessionWizard } = await import('./NewSessionWizard');

        const screen = await renderScreen(<NewSessionWizard
            popoverBoundaryRef={{ current: null } as any}
            sectionPresentation={{
                backends: 'dropdown',
                models: 'dropdown',
                machines: 'dropdown',
                paths: 'dropdown',
                permissions: 'dropdown',
            } as any}
            layout={{
                theme: createThemeFixture() as any,
                styles: {
                    wizardSelectionPair: {},
                    wizardSelectionPairColumn: {},
                } as any,
                safeAreaBottom: 0,
                headerHeight: 44,
                newSessionSidePadding: 0,
                newSessionBottomPadding: 0,
            }}
            profiles={{
                useProfiles: false,
                profiles: [],
                favoriteProfileIds: [],
                setFavoriteProfileIds: () => {},
                selectedProfileId: null,
                onPressDefaultEnvironment: () => {},
                onPressProfile: () => {},
                selectedMachineId: 'machine-1',
                getProfileDisabled: () => false,
                getProfileSubtitleExtra: () => null,
                handleAddProfile: () => {},
                openProfileEdit: () => {},
                handleDuplicateProfile: () => {},
                handleDeleteProfile: () => {},
                suppressNextSecretAutoPromptKeyRef: { current: null },
                openSecretRequirementModal: () => {},
                profilesGroupTitles: { favorites: '', custom: '', builtIn: '' },
                getSecretOverrideReady: () => false,
                getSecretSatisfactionForProfile: () => ({ isSatisfied: true, hasSecretRequirements: false, items: [] }),
                getSecretMachineEnvOverride: () => null,
            } as any}
            agent={{
                cliAvailability: { available: true },
                tmuxRequested: false,
                enabledAgentIds: ['codex'],
                isAgentSelectable: () => true,
                agentType: 'codex',
                setAgentType: () => {},
                selectedIndicatorColor: '#000',
                permissionMode: 'default',
                handlePermissionModeChange: () => {},
                modelOptions: [
                    { value: 'default', label: 'Use CLI settings', description: '' },
                    { value: 'gpt-5.4', label: 'GPT-5.4', description: 'Primary model' },
                ],
                modelMode: 'default',
                setModelMode: () => {},
            } as any}
            machine={{
                machines: [{
                    id: 'machine-1',
                    seq: 1,
                    createdAt: 0,
                    updatedAt: 0,
                    active: true,
                    activeAt: 0,
                    revokedAt: null,
                    metadata: {
                        host: 'box.local',
                        platform: 'test',
                        happyCliVersion: '0.0.0-test',
                        happyHomeDir: '/tmp/happy-home',
                        homeDir: '/tmp',
                        displayName: 'Box',
                    },
                    metadataVersion: 1,
                    daemonState: null,
                    daemonStateVersion: 0,
                }],
                serverId: 'server-1',
                selectedMachine: {
                    id: 'machine-1',
                    seq: 1,
                    createdAt: 0,
                    updatedAt: 0,
                    active: true,
                    activeAt: 0,
                    revokedAt: null,
                    metadata: {
                        host: 'box.local',
                        platform: 'test',
                        happyCliVersion: '0.0.0-test',
                        happyHomeDir: '/tmp/happy-home',
                        homeDir: '/tmp',
                        displayName: 'Box',
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
                getBestPathForMachine: () => '/tmp',
                setSelectedPath: () => {},
                favoriteMachines: [],
                selectedPath: '/tmp',
                recentPaths: ['/tmp', '/repo'],
                usePathPickerSearch: true,
                favoriteDirectories: [],
                setFavoriteDirectories: () => {},
            } as any}
            footer={{
                promptStore: createNewSessionPromptStore(''),
                setSessionPrompt: () => {},
                handleCreateSession: () => {},
                canCreate: false,
                isCreating: false,
                emptyAutocompleteKinds: [],
                emptyAutocompleteSuggestions: async () => [],
                agentInputExtraActionChips: [],
            }}
        />);

        expect(screen.findByTestId('new-session-machine-dropdown-trigger')).toBeTruthy();
        expect(pathSelectorPropsRef.current).toMatchObject({
            initialValue: '/tmp',
            maxHeight: 320,
        });
        expect(modelSelectionPropsRef.current).toMatchObject({
            presentation: 'compact',
        });
        expect(dropdownPropsRef.current).toMatchObject({
            selectedId: 'default',
        });
    });

    it('only uses wizard selector columns on wide web when the column layout preference is enabled', async () => {
        mockEnv.windowWidth = 1200;
        const { NewSessionWizard } = await import('./NewSessionWizard');
        const machine = {
            id: 'machine-1',
            seq: 1,
            createdAt: 0,
            updatedAt: 0,
            active: true,
            activeAt: 0,
            revokedAt: null,
            metadata: {
                host: 'box.local',
                platform: 'test',
                happyCliVersion: '0.0.0-test',
                happyHomeDir: '/tmp/happy-home',
                homeDir: '/tmp',
                displayName: 'Box',
            },
            metadataVersion: 1,
            daemonState: null,
            daemonStateVersion: 0,
        };
        const renderWizard = (useColumnLayout?: boolean) => renderScreen(<NewSessionWizard
            popoverBoundaryRef={{ current: null } as any}
            useColumnLayout={useColumnLayout}
            layout={{
                theme: createThemeFixture() as any,
                styles: {
                    wizardSelectionPair: { testColumnPair: true },
                    wizardSelectionPairColumn: { testColumnPairColumn: true },
                } as any,
                safeAreaBottom: 0,
                headerHeight: 44,
                newSessionSidePadding: 0,
                newSessionBottomPadding: 0,
            }}
            profiles={{
                useProfiles: false,
                profiles: [],
                favoriteProfileIds: [],
                setFavoriteProfileIds: () => {},
                selectedProfileId: null,
                onPressDefaultEnvironment: () => {},
                onPressProfile: () => {},
                selectedMachineId: 'machine-1',
                getProfileDisabled: () => false,
                getProfileSubtitleExtra: () => null,
                handleAddProfile: () => {},
                openProfileEdit: () => {},
                handleDuplicateProfile: () => {},
                handleDeleteProfile: () => {},
                suppressNextSecretAutoPromptKeyRef: { current: null },
                openSecretRequirementModal: () => {},
                profilesGroupTitles: { favorites: '', custom: '', builtIn: '' },
                getSecretOverrideReady: () => false,
                getSecretSatisfactionForProfile: () => ({ isSatisfied: true, hasSecretRequirements: false, items: [] }),
                getSecretMachineEnvOverride: () => null,
            } as any}
            agent={{
                cliAvailability: { available: true },
                tmuxRequested: false,
                enabledAgentIds: ['codex'],
                isAgentSelectable: () => true,
                agentType: 'codex',
                setAgentType: () => {},
                selectedIndicatorColor: '#000',
                permissionMode: 'default',
                handlePermissionModeChange: () => {},
                modelOptions: [
                    { value: 'default', label: 'Use CLI settings', description: 'Use configured model' },
                    { value: 'opus', label: 'Opus', description: 'High capability' },
                ],
                modelMode: 'default',
                setModelMode: () => {},
            } as any}
            machine={{
                machines: [machine],
                serverId: 'server-1',
                selectedMachine: machine,
                recentMachines: [],
                favoriteMachineItems: [],
                useMachinePickerSearch: false,
                onRefreshMachines: () => {},
                setSelectedMachineId: () => {},
                getBestPathForMachine: () => '/tmp',
                setSelectedPath: () => {},
                favoriteMachines: [],
                selectedPath: '/tmp',
                recentPaths: [],
                usePathPickerSearch: false,
                favoriteDirectories: [],
                setFavoriteDirectories: () => {},
            } as any}
            footer={{
                promptStore: createNewSessionPromptStore(''),
                setSessionPrompt: () => {},
                handleCreateSession: () => {},
                canCreate: false,
                isCreating: false,
                emptyAutocompleteKinds: [],
                emptyAutocompleteSuggestions: async () => [],
                agentInputExtraActionChips: [],
            }}
        />);
        const countColumnPairs = (screen: Awaited<ReturnType<typeof renderWizard>>) => screen
            .findAllByType('View')
            .filter((node) => flattenStyle(node.props.style).testColumnPair === true)
            .length;

        const defaultScreen = await renderWizard();
        expect(countColumnPairs(defaultScreen)).toBe(0);

        const enabledScreen = await renderWizard(true);
        expect(countColumnPairs(enabledScreen)).toBeGreaterThan(0);
    });

    it('does not emit raw text nodes under non-Text parents when icons render as text on web', async () => {
        const { NewSessionWizard } = await import('./NewSessionWizard');

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<NewSessionWizard
                        popoverBoundaryRef={{ current: null } as any}
                        layout={{
                            theme: createThemeFixture() as any,
                        styles: {} as any,
                        safeAreaBottom: 0,
                        headerHeight: 44,
                        newSessionSidePadding: 0,
                        newSessionBottomPadding: 0,
                    }}
                    profiles={{
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
                    } as any}
                    agent={{
                        cliAvailability: { available: true },
                        tmuxRequested: true,
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
                    } as any}
                    machine={{
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
                        selectedPath: '',
                        recentPaths: [],
                        usePathPickerSearch: false,
                        favoriteDirectories: [],
                        setFavoriteDirectories: () => {},
                    } as any}
                    footer={{
                        promptStore: createNewSessionPromptStore(''),
                        setSessionPrompt: () => {},
                        handleCreateSession: () => {},
                        canCreate: false,
                        isCreating: false,
                        emptyAutocompleteKinds: [],
                        emptyAutocompleteSuggestions: async () => [],
                        agentInputExtraActionChips: [{
                            key: 'attachments-add',
                            labelPolicy: 'auto-hide',
                            render: () => (
                                <React.Fragment>
                                    .
                                </React.Fragment>
                            ),
                        }],
                    }}
                />)).tree;

        expect(collectUnexpectedRawTextNodes(tree.toJSON())).toEqual([]);
    });

    it('does not emit raw text nodes from the profile header when icons render as text on web', async () => {
        const { NewSessionWizard } = await import('./NewSessionWizard');

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<NewSessionWizard
                        popoverBoundaryRef={{ current: null } as any}
                        layout={{
                            theme: createThemeFixture() as any,
                        styles: {} as any,
                        safeAreaBottom: 0,
                        headerHeight: 44,
                        newSessionSidePadding: 0,
                        newSessionBottomPadding: 0,
                    }}
                    profiles={{
                        useProfiles: true,
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
                    } as any}
                    agent={{
                        cliAvailability: { available: true },
                        tmuxRequested: false,
                        enabledAgentIds: ['codex'],
                        isAgentSelectable: () => true,
                        agentType: 'codex',
                        setAgentType: () => {},
                        selectedIndicatorColor: '#000',
                        permissionMode: 'default',
                        handlePermissionModeChange: () => {},
                        modelOptions: [],
                        modelMode: 'default',
                        setModelMode: () => {},
                    } as any}
                    machine={{
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
                        selectedPath: '',
                        recentPaths: [],
                        usePathPickerSearch: false,
                        favoriteDirectories: [],
                        setFavoriteDirectories: () => {},
                    } as any}
                    footer={{
                        promptStore: createNewSessionPromptStore(''),
                        setSessionPrompt: () => {},
                        handleCreateSession: () => {},
                        canCreate: false,
                        isCreating: false,
                        emptyAutocompleteKinds: [],
                        emptyAutocompleteSuggestions: async () => [],
                        agentInputExtraActionChips: [],
                    }}
                />)).tree;

        expect(collectUnexpectedRawTextNodes(tree.toJSON())).toEqual([]);
    });
});
