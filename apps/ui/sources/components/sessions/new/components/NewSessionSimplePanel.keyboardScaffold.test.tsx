import * as React from 'react';
import { createNewSessionPromptStore } from '@/components/sessions/new/hooks/screenModel/newSessionPromptStore';
import type { View } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderScreen, standardCleanup } from '@/dev/testkit';

import { installNewSessionComponentsCommonModuleMocks } from './newSessionComponentsTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type ScaffoldRender = Readonly<{
    props: Record<string, unknown>;
}>;

const testState = vi.hoisted(() => ({
    agentInputProps: [] as Array<Record<string, unknown>>,
    scaffoldAvailablePanelHeight: 360 as number | undefined,
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
            Platform: {
                OS: 'ios',
                select: (value: Record<string, unknown>) => value.ios ?? value.native ?? value.default ?? null,
            },
            Keyboard: {
                dismiss: vi.fn(),
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
});

vi.mock('@/components/ui/popover', () => ({
    PopoverBoundaryProvider: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement(React.Fragment, null, props.children),
}));

vi.mock('@/components/sessions/keyboardAvoidance', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/components/sessions/keyboardAvoidance')>();
    return {
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
        resolveAvailablePanelHeight: actual.resolveAvailablePanelHeight,
    };
});

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

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => false,
}));

vi.mock('@/sync/sync', () => ({
    sync: { sendMessage: vi.fn() },
}));

describe('NewSessionSimplePanel keyboard scaffold integration', () => {
    beforeEach(() => {
        testState.agentInputProps = [];
        testState.scaffoldAvailablePanelHeight = 360;
        testState.scaffoldRender = null;
    });

    afterEach(() => {
        standardCleanup();
    });

    it('passes a modal-bounded panel height to AgentInput', async () => {
        const { NewSessionSimplePanel } = await import('./NewSessionSimplePanel');
        let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
        const popoverBoundaryRef = React.createRef<View>() as unknown as React.RefObject<View>;

        try {
            screen = await renderScreen(
                <NewSessionSimplePanel
                    popoverBoundaryRef={popoverBoundaryRef}
                    headerHeight={44}
                    safeAreaTop={0}
                    safeAreaBottom={34}
                    newSessionTopPadding={20}
                    newSessionSidePadding={16}
                    newSessionBottomPadding={12}
                    shouldBottomAnchor
                    containerStyle={{}}
                    promptStore={createNewSessionPromptStore('')}
                    setSessionPrompt={() => {}}
                    handleCreateSession={() => {}}
                    canCreate
                    isCreating={false}
                    emptyAutocompleteKinds={[]}
                    emptyAutocompleteSuggestions={async () => []}
                    sessionPromptInputMaxHeight={200}
                    agentType="codex"
                    handleAgentClick={() => {}}
                    permissionMode="default"
                    handlePermissionModeChange={() => {}}
                    modelMode="default"
                    setModelMode={() => {}}
                    modelOptions={[{ value: 'default', label: 'Default', description: '' }]}
                    connectionStatus={undefined}
                    machineName="Builder"
                    selectedMachineId="machine-1"
                    selectedMachineHomeDir="/Users/alice"
                    selectedPath="/repo"
                    showResumePicker={false}
                    resumeSessionId={null}
                    isResumeSupportChecking={false}
                    useProfiles={false}
                    selectedProfileId={null}
                />,
            );

            expect(testState.scaffoldRender?.props.mode).toBe('newSession');
            expect(screen.findByType('MockComposerKeyboardScaffoldContent')).toBeTruthy();
            expect(screen.findByType('MockComposerKeyboardScaffoldComposer')).toBeTruthy();
            expect(testState.agentInputProps.at(-1)?.maxPanelHeight).toBe(348);
        } finally {
            act(() => {
                screen?.tree.unmount();
            });
        }
    });

    it('seeds AgentInput panel height before the scaffold subscription publishes', async () => {
        testState.scaffoldAvailablePanelHeight = undefined;
        const { NewSessionSimplePanel } = await import('./NewSessionSimplePanel');
        let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
        const popoverBoundaryRef = React.createRef<View>() as unknown as React.RefObject<View>;

        try {
            screen = await renderScreen(
                <NewSessionSimplePanel
                    popoverBoundaryRef={popoverBoundaryRef}
                    headerHeight={44}
                    safeAreaTop={0}
                    safeAreaBottom={34}
                    newSessionTopPadding={20}
                    newSessionSidePadding={16}
                    newSessionBottomPadding={12}
                    shouldBottomAnchor
                    containerStyle={{}}
                    promptStore={createNewSessionPromptStore('')}
                    setSessionPrompt={() => {}}
                    handleCreateSession={() => {}}
                    canCreate
                    isCreating={false}
                    emptyAutocompleteKinds={[]}
                    emptyAutocompleteSuggestions={async () => []}
                    sessionPromptInputMaxHeight={200}
                    agentType="codex"
                    handleAgentClick={() => {}}
                    permissionMode="default"
                    handlePermissionModeChange={() => {}}
                    modelMode="default"
                    setModelMode={() => {}}
                    modelOptions={[{ value: 'default', label: 'Default', description: '' }]}
                    connectionStatus={undefined}
                    machineName="Builder"
                    selectedMachineId="machine-1"
                    selectedMachineHomeDir="/Users/alice"
                    selectedPath="/repo"
                    showResumePicker={false}
                    resumeSessionId={null}
                    isResumeSupportChecking={false}
                    useProfiles={false}
                    selectedProfileId={null}
                />,
            );

            expect(testState.agentInputProps.at(-1)?.maxPanelHeight).toBe(610);
        } finally {
            act(() => {
                screen?.tree.unmount();
            });
        }
    });
});
