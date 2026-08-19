import * as React from 'react';
import type { View } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import {
    createMockComposerKeyboardScaffoldHarness,
    renderScreen,
    setMockComposerKeyboardLiveHeight,
    standardCleanup,
    type ComposerKeyboardLayout,
    type MockComposerKeyboardScaffoldHarness,
} from '@/dev/testkit';

import { installNewSessionComponentsCommonModuleMocks } from './newSessionComponentsTestHelpers';
import { createNewSessionPromptStore } from '@/components/sessions/new/hooks/screenModel/newSessionPromptStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const testState = vi.hoisted(() => ({
    agentInputProps: [] as Array<Record<string, unknown>>,
    keyboardDismiss: vi.fn(),
    platformOs: 'ios' as 'ios' | 'android' | 'web',
    scaffoldAvailablePanelHeight: 360 as number | undefined,
    scaffoldHarness: undefined as MockComposerKeyboardScaffoldHarness | undefined,
    keyboardLayout: undefined as ComposerKeyboardLayout | undefined,
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

// `react-native-reanimated` is a boundary the testkit already owns (installed globally in
// `dev/vitestSetup.ts`). A hand-rolled subset here previously shadowed it with three exports, so
// any production code that reached for a fourth — `withTiming` for the composer's entrance —
// failed at the mock rather than at an assertion.

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
        // One layout per test: a fresh instance per render would drop the subscription a test
        // uses to raise the keyboard.
        testState.keyboardLayout ??= createMockComposerKeyboardLayout({ availablePanelHeight: 0 });
        return testState.keyboardLayout;
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

function createFloatingPanelProps() {
    // Test harness only verifies prop forwarding; no native View instance is mounted.
    const popoverBoundaryRef = React.createRef<View>() as unknown as React.RefObject<View>;
    return {
        popoverBoundaryRef,
        headerHeight: 0,
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
        agentType: 'codex' as const,
        handleAgentClick: () => {},
        permissionMode: 'default' as const,
        handlePermissionModeChange: () => {},
        modelMode: 'default' as const,
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
    } as unknown as React.ComponentProps<typeof import('./NewSessionSimplePanel').NewSessionSimplePanel>;
}

describe('NewSessionSimplePanel keyboard scaffold integration', () => {
    beforeEach(() => {
        testState.agentInputProps = [];
        testState.keyboardDismiss.mockReset();
        testState.platformOs = 'ios';
        testState.scaffoldAvailablePanelHeight = 360;
        testState.scaffoldHarness = createMockComposerKeyboardScaffoldHarness();
        testState.keyboardLayout = undefined;
    });

    afterEach(() => {
        standardCleanup();
    });

    it('hands AgentInput the available panel height less the chrome this host draws in it', async () => {
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

            const scaffoldRender = testState.scaffoldHarness?.getLastRender();
            expect(scaffoldRender).toBeTruthy();
            expect(scaffoldRender?.props.mode).toBe('newSession');
            expect(screen.findByType('MockComposerKeyboardScaffoldContent')).toBeTruthy();
            expect(screen.findByType('MockComposerKeyboardScaffoldComposer')).toBeTruthy();
            // 360 less the close capsule row (42). `safeAreaTop` is 0 here, so only the row comes
            // off: AgentInput sizes its own chrome, but the capsule row is the HOST's, drawn above
            // the card inside the same budget, and nothing else subtracts it.
            expect(testState.agentInputProps.at(-1)?.maxPanelHeight).toBe(360 - 0 - 42);
        } finally {
            act(() => {
                screen?.tree.unmount();
            });
        }
    });

    it('hands the scaffold a transparent surface and seats the composer with its own scrim on native', async () => {
        testState.platformOs = 'ios';
        const { NewSessionSimplePanel } = await import('./NewSessionSimplePanel');
        let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;

        try {
            screen = await renderScreen(<NewSessionSimplePanel {...createFloatingPanelProps()} />);

            const scaffoldRender = testState.scaffoldHarness?.getLastRender();
            // Native /new is presented as a transparent modal, so the scaffold must stop painting
            // `surface.base` over the screen behind it and the panel must supply the scrim itself —
            // react-native-screens ships no dimming view for a transparent presentation.
            expect(scaffoldRender?.props.surface).toBe('transparent');
            // The scrim is a short band that seats the composer, so it rides the composer's own
            // slot rather than a full-screen backdrop — that is what keeps its falloff a fixed
            // height at any composer height.
            expect(screen.tree.root.findAll(
                (node) => node.props?.testID === 'new-session-scrim',
            ).length).toBeGreaterThan(0);
        } finally {
            act(() => {
                screen?.tree.unmount();
            });
        }
    });

    it('leaves the surface opaque on web, where Expo Router owns the drawer and its scrim', async () => {
        testState.platformOs = 'web';
        const { NewSessionSimplePanel } = await import('./NewSessionSimplePanel');
        let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;

        try {
            screen = await renderScreen(<NewSessionSimplePanel {...createFloatingPanelProps()} />);

            const scaffoldRender = testState.scaffoldHarness?.getLastRender();
            // Web keeps the Vaul drawer and its `[data-vaul-overlay]` scrim. Painting a second
            // backdrop inside it would double the wash.
            expect(scaffoldRender?.props.surface).not.toBe('transparent');
            expect(screen.tree.root.findAll(
                (node) => node.props?.testID === 'new-session-scrim',
            )).toHaveLength(0);
        } finally {
            act(() => {
                screen?.tree.unmount();
            });
        }
    });


    it('rests the floating composer at its own side margin, not the home-indicator inset', async () => {
        testState.platformOs = 'ios';
        const { NewSessionSimplePanel } = await import('./NewSessionSimplePanel');
        let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;

        try {
            screen = await renderScreen(<NewSessionSimplePanel {...createFloatingPanelProps()} />);

            // A floating card is not seated against the screen edge, so the home-indicator inset is
            // the wrong resting gap: it leaves the card visibly higher than its own side margin.
            // The scaffold resolves the resting offset as max(keyboardHeight, safeAreaBottom), so
            // handing it the side margin sets the closed-state gap and leaves the keyboard-open
            // position — driven by the taller keyboard height — untouched.
            // 16 - 12: the composer wrapper already pads 12 below the card, so only the remainder
            // of the 16pt side margin belongs to the scaffold. Handing it the whole 16 would stack
            // the two and leave the card floating 28pt up.
            const scaffoldRender = testState.scaffoldHarness?.getLastRender();
            expect(scaffoldRender?.props.safeAreaBottom).toBe(4);
        } finally {
            act(() => { screen?.tree.unmount(); });
        }
    });

    it('keeps the platform bottom inset when the composer is not the floating presentation', async () => {
        testState.platformOs = 'web';
        const { NewSessionSimplePanel } = await import('./NewSessionSimplePanel');
        let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;

        try {
            screen = await renderScreen(<NewSessionSimplePanel {...createFloatingPanelProps()} />);

            const scaffoldRender = testState.scaffoldHarness?.getLastRender();
            expect(scaffoldRender?.props.safeAreaBottom).toBe(34);
        } finally {
            act(() => { screen?.tree.unmount(); });
        }
    });

    it('reserves the top inset and the close row so a long draft cannot grow under the status bar', async () => {
        testState.platformOs = 'ios';
        const { NewSessionSimplePanel } = await import('./NewSessionSimplePanel');
        let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;

        try {
            screen = await renderScreen(
                <NewSessionSimplePanel {...createFloatingPanelProps()} safeAreaTop={59} />,
            );

            // NOT via `headerHeight`: the layout owner drops that to zero the moment the scaffold
            // reports a measured height (a sheet is already measured below its header, so counting
            // it twice would shrink the panel), and this scaffold covers the whole window. So the
            // host takes its own chrome off the budget it hands the input: the 59pt top inset it
            // runs under, plus the 42pt close capsule row it draws above the card.
            const scaffoldRender = testState.scaffoldHarness?.getLastRender();
            expect(scaffoldRender?.props.headerHeight).toBe(0);
            const lastAgentInputProps = testState.agentInputProps.at(-1);
            expect(lastAgentInputProps?.maxPanelHeight).toBe(360 - 59 - 42);
        } finally {
            act(() => { screen?.tree.unmount(); });
        }
    });

    it('offers a keyboard-dismiss control only while the keyboard is up', async () => {
        testState.platformOs = 'ios';
        const { NewSessionSimplePanel } = await import('./NewSessionSimplePanel');
        let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;

        try {
            screen = await renderScreen(<NewSessionSimplePanel {...createFloatingPanelProps()} />);
            const findDismiss = () => screen!.tree.root.findAll(
                (node) => node.props?.testID === 'new-session-composer-dismiss-keyboard',
            );

            // Backdrop-tap dismisses the whole screen here, so with the keyboard up there is no
            // gesture left that retracts only the keyboard. The control exists for exactly that
            // window and must not linger as dead chrome once the keyboard is down.
            expect(findDismiss()).toHaveLength(0);

            act(() => {
                setMockComposerKeyboardLiveHeight(testState.keyboardLayout!, 291);
            });
            expect(findDismiss().length).toBeGreaterThan(0);

            act(() => {
                findDismiss()[0].props.onPress();
            });
            expect(testState.keyboardDismiss).toHaveBeenCalled();

            act(() => {
                setMockComposerKeyboardLiveHeight(testState.keyboardLayout!, 0);
            });
            expect(findDismiss()).toHaveLength(0);
        } finally {
            act(() => { screen?.tree.unmount(); });
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
