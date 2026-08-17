import * as React from 'react';
import { createNewSessionPromptStore } from '@/components/sessions/new/hooks/screenModel/newSessionPromptStore';
import type { View } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { AGENT_IDS, type AgentId } from '@/agents/catalog/catalog';
import type { CLIAvailability } from '@/hooks/auth/useCLIDetection';
import type { Machine } from '@/sync/domains/state/storageTypes';

import { installNewSessionComponentsCommonModuleMocks } from './newSessionComponentsTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type ScaffoldRender = Readonly<{
    props: Record<string, unknown>;
}>;

const testState = vi.hoisted(() => ({
    agentInputProps: [] as Array<Record<string, unknown>>,
    retainKeyboardLift: vi.fn(() => () => {}),
    scaffoldAvailablePanelHeight: 512,
    scaffoldRender: null as ScaffoldRender | null,
}));

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
            Platform: {
                OS: 'ios',
                select: (value: Record<string, unknown>) => value.ios ?? value.native ?? value.default ?? null,
            },
            Dimensions: {
                get: () => ({ width: 390, height: 700, scale: 1, fontScale: 1 }),
            },
            useWindowDimensions: () => ({ width: 390, height: 700 }),
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
    icons: async () => ({
        Ionicons: () => React.createElement('Ionicons'),
    }),
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

vi.mock('expo-linear-gradient', () => ({
    LinearGradient: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('LinearGradient', props, props.children),
}));

vi.mock('color', () => ({
    default: () => ({
        alpha: () => ({ rgb: () => ({ string: () => 'rgba(0,0,0,0.08)' }) }),
    }),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: () => null,
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('ItemGroup', props, props.children),
}));

vi.mock('@/components/sessions/keyboardAvoidance', () => ({
    ComposerKeyboardScaffold: (props: Record<string, unknown> & {
        children?: React.ReactNode;
        composer?: React.ReactNode;
    }) => {
        testState.scaffoldRender = { props };
        return React.createElement(
            'MockComposerKeyboardScaffold',
            { testID: props.testID },
            React.createElement('MockComposerKeyboardScaffoldContent', { testID: props.contentTestID }, props.children),
            React.createElement('MockComposerKeyboardScaffoldComposer', { testID: props.composerTestID }, props.composer),
        );
    },
    useComposerAvailablePanelHeight: () => testState.scaffoldAvailablePanelHeight,
    useComposerKeyboardLayoutContext: () => ({
        retainKeyboardLift: testState.retainKeyboardLift,
    }),
}));

vi.mock('@/components/sessions/agentInput', () => ({
    AgentInput: (props: Record<string, unknown>) => {
        testState.agentInputProps.push(props);
        return React.createElement('AgentInput', props);
    },
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
    formatAttachmentsBlock: vi.fn(() => ''),
}));

vi.mock('@/components/machines/InstallableDepInstaller', () => ({
    InstallableDepInstaller: () => null,
}));

vi.mock('@/components/profiles/ProfilesList', () => ({
    ProfilesList: () => null,
}));

vi.mock('@/components/sessions/new/components/MachineSelector', () => ({
    MachineSelector: () => null,
}));

vi.mock('@/components/sessions/new/components/PathSelectionList', () => ({
    PathSelectionList: () => null,
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => false,
}));

vi.mock('@/sync/sync', () => ({
    sync: { sendMessage: vi.fn() },
}));

describe('NewSessionWizard keyboard scaffold integration', () => {
    beforeEach(() => {
        testState.agentInputProps = [];
        testState.retainKeyboardLift.mockClear();
        testState.scaffoldAvailablePanelHeight = 512;
        testState.scaffoldRender = null;
    });

    afterEach(() => {
        standardCleanup();
    });

    it('renders the wizard composer through the shared scaffold and caps its panel height for AgentInput', async () => {
        const { NewSessionWizard } = await import('./NewSessionWizard');
        let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
        const popoverBoundaryRef = React.createRef<View>() as unknown as React.RefObject<View>;

        try {
            screen = await renderScreen(
                <NewSessionWizard
                    {...buildWizardProps()}
                    popoverBoundaryRef={popoverBoundaryRef}
                />,
            );

            expect(testState.scaffoldRender).toBeTruthy();
            expect(testState.scaffoldRender?.props.mode).toBe('newSession');
            expect(testState.scaffoldRender?.props.contentTestID).toBe('new-session-wizard-keyboard-content');
            expect(testState.scaffoldRender?.props.composerTestID).toBe('new-session-wizard-composer-keyboard-host');
            expect(screen.findByType('MockComposerKeyboardScaffoldContent')).toBeTruthy();
            expect(screen.findByType('MockComposerKeyboardScaffoldComposer')).toBeTruthy();
            expect(testState.agentInputProps.at(-1)?.maxPanelHeight).toBe(280);
            expect(testState.agentInputProps.at(-1)?.retainKeyboardLift).toBe(testState.retainKeyboardLift);
        } finally {
            act(() => {
                screen?.tree.unmount();
            });
        }
    });
});

type NewSessionWizardTestProps = Omit<
    React.ComponentProps<typeof import('./NewSessionWizard').NewSessionWizard>,
    'popoverBoundaryRef'
>;

function buildWizardProps(): NewSessionWizardTestProps {
    const machine: Machine = {
        id: 'machine-1',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadataVersion: 1,
        daemonState: null,
        daemonStateVersion: 1,
        metadata: {
            displayName: 'Machine 1',
            host: 'machine-1.local',
            happyCliVersion: '1.0.0',
            happyHomeDir: '/Users/alice/.happier',
            homeDir: '/Users/alice',
            platform: 'darwin',
        },
    };

    return {
        layout: {
            theme: {
                colors: {
                    background: { canvas: '#fff' },
                    border: { default: '#ddd' },
                    box: { warning: { background: '#fff8e1', border: '#f5d38f' } },
                    button: { secondary: { tint: '#000' } },
                    divider: '#ddd',
                    groupped: { background: '#fff' },
                    input: { background: '#fff' },
                    shadow: { color: '#000' },
                    state: {
                        danger: { foreground: '#b91c1c' },
                        neutral: { foreground: '#666' },
                        warning: { background: '#fff8e1', border: '#f5d38f' },
                    },
                    status: { connected: '#22c55e' },
                    text: { primary: '#000', secondary: '#666', tertiary: '#999' },
                    textSecondary: '#666',
                    warning: '#d97706',
                },
            },
            styles: {},
            safeAreaTop: 0,
            safeAreaBottom: 34,
            headerHeight: 44,
            newSessionSidePadding: 16,
            newSessionBottomPadding: 12,
            shouldBottomAnchor: true,
        },
        profiles: {
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
            getSecretSatisfactionForProfile: () => ({ isSatisfied: true }),
            getSecretMachineEnvOverride: () => null,
        },
        agent: {
            cliAvailability: buildCliAvailability(),
            tmuxRequested: false,
            enabledAgentIds: ['codex'],
            isAgentSelectable: () => true,
            isCliBannerDismissed: () => false,
            dismissCliBanner: () => {},
            agentType: 'codex',
            setAgentType: () => {},
            selectedIndicatorColor: '#000',
            profileMap: new Map(),
            permissionMode: 'default',
            handlePermissionModeChange: () => {},
            modelOptions: [{ value: 'default', label: 'Default', description: '' }],
            modelMode: 'default',
            setModelMode: () => {},
        },
        machine: {
            machines: [machine],
            serverId: null,
            selectedMachine: machine,
            recentMachines: [],
            favoriteMachineItems: [],
            useMachinePickerSearch: false,
            onRefreshMachines: () => {},
            setSelectedMachineId: () => {},
            getBestPathForMachine: () => '/Users/alice/repo',
            setSelectedPath: () => {},
            favoriteMachines: [],
            setFavoriteMachines: () => {},
            selectedPath: '/Users/alice/repo',
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
            submitAccessibilityLabel: 'Create',
        },
    };
}

function buildCliAvailability(): CLIAvailability {
    return {
        available: buildAgentRecord<boolean | null>(true),
        login: buildAgentRecord<boolean | null>(null),
        authStatus: buildAgentRecord(null),
        resolvedPath: buildAgentRecord<string | null>(null),
        resolutionSource: buildAgentRecord<CLIAvailability['resolutionSource'][AgentId]>(null),
        tmux: null,
        isDetecting: false,
        timestamp: 1,
        refresh: () => {},
    };
}

function buildAgentRecord<TValue>(value: TValue): Record<AgentId, TValue> {
    return Object.fromEntries(AGENT_IDS.map((agentId) => [agentId, value])) as Record<AgentId, TValue>;
}
