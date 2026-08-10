import * as React from 'react';
import type { View } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import {
    createMockComposerKeyboardScaffoldHarness,
    renderScreen,
    standardCleanup,
    type MockComposerKeyboardScaffoldHarness,
} from '@/dev/testkit';

import { installNewSessionComponentsCommonModuleMocks } from './newSessionComponentsTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const testState = vi.hoisted(() => ({
    agentInputProps: [] as Array<Record<string, unknown>>,
    keyboardDismiss: vi.fn(),
    platformOs: 'ios' as 'ios' | 'android' | 'web',
    scaffoldAvailablePanelHeight: 360 as number | undefined,
    scaffoldHarness: undefined as MockComposerKeyboardScaffoldHarness | undefined,
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
            AppState: {
                addEventListener: () => ({ remove: () => {} }),
            },
            Keyboard: {
                addListener: () => ({ remove: () => {} }),
                dismiss: testState.keyboardDismiss,
            },
            Platform: {
                get OS() {
                    return testState.platformOs;
                },
                select: (value: Record<string, unknown>) =>
                    value[testState.platformOs] ?? value.native ?? value.default ?? value.ios ?? value.android,
            },
            useWindowDimensions: () => ({ width: 390, height: 700 }),
            Dimensions: {
                get: () => ({ width: 390, height: 700, scale: 1, fontScale: 1 }),
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
    useKeyboardHandler: () => {},
    useReanimatedKeyboardAnimation: () => ({
        height: { value: -240 },
        progress: { value: 1 },
    }),
}));

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('react-native-reanimated', async () => {
    const ReactModule = await import('react');
    return {
        __esModule: true,
        default: {
            View: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                ReactModule.createElement('AnimatedView', props, props.children),
        },
        useAnimatedStyle: (resolveStyle: () => unknown) => resolveStyle(),
        useSharedValue: (initial: unknown) => ({ value: initial }),
    };
});

vi.mock('@/components/ui/popover', () => ({
    PopoverBoundaryProvider: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement(React.Fragment, null, props.children),
    PopoverPortalTargetProvider: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement(React.Fragment, null, props.children),
    PopoverScope: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement(React.Fragment, null, props.children),
}));

vi.mock('@/components/sessions/keyboardAvoidance', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/components/sessions/keyboardAvoidance')>();
    const ReactModule = await import('react');
    const {
        MockComposerKeyboardScaffold,
        createMockComposerKeyboardLayout,
    } = await import('@/dev/testkit');
    type MockScaffoldProps = React.ComponentProps<typeof MockComposerKeyboardScaffold>;

    return {
        ComposerKeyboardScaffold: (props: MockScaffoldProps) =>
            ReactModule.createElement(MockComposerKeyboardScaffold, {
                ...props,
                harness: testState.scaffoldHarness,
                layout: createLayout(),
            }),
        useComposerKeyboardLayoutContext: () => createLayout(),
        useComposerAvailablePanelHeight: () => testState.scaffoldAvailablePanelHeight,
        resolveAvailablePanelHeight: actual.resolveAvailablePanelHeight,
    };

    function createLayout() {
        return createMockComposerKeyboardLayout({
            availablePanelHeight: 0,
        });
    }
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

describe('NewSessionSimplePanel keyboard scaffold integration', () => {
    beforeEach(() => {
        testState.agentInputProps = [];
        testState.keyboardDismiss.mockReset();
        testState.platformOs = 'ios';
        testState.scaffoldAvailablePanelHeight = 360;
        testState.scaffoldHarness = createMockComposerKeyboardScaffoldHarness();
    });

    afterEach(() => {
        standardCleanup();
    });

    it('passes the composer available panel height straight through to AgentInput', async () => {
        const { NewSessionSimplePanel } = await import('./NewSessionSimplePanel');
        let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
        // Test harness only verifies ref forwarding; no native View instance is mounted.
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
                    sessionPrompt=""
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

            const scaffoldRender = testState.scaffoldHarness?.getLastRender();
            expect(scaffoldRender).toBeTruthy();
            expect(scaffoldRender?.props.mode).toBe('newSession');
            expect(screen.findByType('MockComposerKeyboardScaffoldContent')).toBeTruthy();
            expect(screen.findByType('MockComposerKeyboardScaffoldComposer')).toBeTruthy();
            // maxPanelHeight is the composer scaffold's available panel height verbatim;
            // the panel is the bottom-anchored host and AgentInput sizes its own chrome.
            expect(testState.agentInputProps.at(-1)?.maxPanelHeight).toBe(360);
        } finally {
            act(() => {
                screen?.tree.unmount();
            });
        }
    });

    it('skips rerendering the composer subtree when panel props are stable', async () => {
        const { NewSessionSimplePanel } = await import('./NewSessionSimplePanel');
        let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
        const popoverBoundaryRef = React.createRef<View>() as unknown as React.RefObject<View>;
        const props = {
            popoverBoundaryRef,
            headerHeight: 44,
            safeAreaTop: 0,
            safeAreaBottom: 34,
            newSessionTopPadding: 20,
            newSessionSidePadding: 16,
            newSessionBottomPadding: 12,
            shouldBottomAnchor: true,
            containerStyle: {},
            sessionPrompt: '',
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
            selectedMachineId: 'machine-1',
            selectedMachineHomeDir: '/Users/alice',
            selectedPath: '/repo',
            showResumePicker: false,
            resumeSessionId: null,
            isResumeSupportChecking: false,
            useProfiles: false,
            selectedProfileId: null,
        } satisfies React.ComponentProps<typeof NewSessionSimplePanel>;

        try {
            screen = await renderScreen(<NewSessionSimplePanel {...props} />);
            const firstAgentInputRenderCount = testState.agentInputProps.length;

            await act(async () => {
                screen?.tree.update(<NewSessionSimplePanel {...props} />);
            });

            expect(testState.agentInputProps.length).toBe(firstAgentInputRenderCount);
        } finally {
            act(() => {
                screen?.tree.unmount();
            });
        }
    });
});
