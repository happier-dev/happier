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

type TestKeyboardLayout = {
    keyboardHeight: number;
    listeners: Set<(height: number) => void>;
    subscribeKeyboardHeight: (listener: (height: number) => void) => () => void;
};

const testState = vi.hoisted(() => ({
    agentInputProps: [] as Array<Record<string, unknown>>,
    scaffoldAvailablePanelHeight: 360 as number | undefined,
    scaffoldRender: null as ScaffoldRender | null,
    platformOs: 'ios' as 'ios' | 'android' | 'web',
    keyboardLayout: null as TestKeyboardLayout | null,
}));

function setTestKeyboardHeight(height: number): void {
    const layout = testState.keyboardLayout;
    if (!layout) return;
    layout.keyboardHeight = height;
    for (const listener of layout.listeners) listener(height);
}

const safeRouterBackSpy = vi.hoisted(() => vi.fn());

vi.mock('@/utils/navigation/safeRouterBack', () => ({
    safeRouterBack: (...args: unknown[]) => safeRouterBackSpy(...args),
}));

// The floating composer's exit reverses its entrance and pops WHEN THE ANIMATION LANDS, so this
// suite opts the canonical reanimated mock into settling `withTiming` completion callbacks.
vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    return createReanimatedModuleMock({ settleTimingCallbacks: true });
});

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
                get OS() {
                    return testState.platformOs;
                },
                select: (value: Record<string, unknown>) => {
                    if (testState.platformOs in value) return value[testState.platformOs];
                    if (testState.platformOs !== 'web' && 'native' in value) return value.native;
                    return value.default ?? null;
                },
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
        // One layout per test: a fresh instance per render would drop the subscription a test uses
        // to raise the keyboard.
        useComposerKeyboardLayoutContext: () => {
            testState.keyboardLayout ??= {
                keyboardHeight: 0,
                listeners: new Set<(height: number) => void>(),
                subscribeKeyboardHeight(listener: (height: number) => void) {
                    testState.keyboardLayout!.listeners.add(listener);
                    listener(testState.keyboardLayout!.keyboardHeight);
                    return () => { testState.keyboardLayout!.listeners.delete(listener); };
                },
            };
            return testState.keyboardLayout;
        },
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

function createFloatingPanelProps(
    overrides: Partial<React.ComponentProps<typeof import('./NewSessionSimplePanel').NewSessionSimplePanel>> = {},
) {
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
        ...overrides,
    } as unknown as React.ComponentProps<typeof import('./NewSessionSimplePanel').NewSessionSimplePanel>;
}

describe('NewSessionSimplePanel keyboard scaffold integration', () => {
    beforeEach(() => {
        testState.agentInputProps = [];
        testState.scaffoldAvailablePanelHeight = 360;
        testState.scaffoldRender = null;
        testState.platformOs = 'ios';
        safeRouterBackSpy.mockReset();
    });

    afterEach(() => {
        standardCleanup();
    });

    it('hands the scaffold a transparent surface and seats the composer with its own scrim on native', async () => {
        const { NewSessionSimplePanel } = await import('./NewSessionSimplePanel');
        let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;

        try {
            screen = await renderScreen(<NewSessionSimplePanel {...createFloatingPanelProps()} />);

            // Native `/new` is presented as a transparent modal, so the scaffold must stop painting
            // `surface.base` over the screen behind it and the panel must supply the scrim itself —
            // react-native-screens ships no dimming view for a transparent presentation.
            expect(testState.scaffoldRender?.props.surface).toBe('transparent');
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

    it('leaves the surface opaque on web, where the router owns the drawer and its scrim', async () => {
        testState.platformOs = 'web';
        const { NewSessionSimplePanel } = await import('./NewSessionSimplePanel');
        let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;

        try {
            screen = await renderScreen(<NewSessionSimplePanel {...createFloatingPanelProps()} />);

            // Web keeps the router's drawer and its own scrim. Painting a second backdrop inside it
            // would double the wash.
            expect(testState.scaffoldRender?.props.surface).not.toBe('transparent');
            expect(screen.tree.root.findAll(
                (node) => node.props?.testID === 'new-session-scrim',
            )).toHaveLength(0);
            expect(screen.tree.root.findAllByProps({ testID: 'new-session-composer-close' })).toHaveLength(0);
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
            // the wrong resting gap — it leaves the card visibly higher than its own side margin.
            // 16 - 12: the composer wrapper already pads 12 below the card, so only the remainder
            // belongs to the scaffold. The scaffold resolves the resting offset as
            // max(keyboardHeight, safeAreaBottom), and the keyboard is always taller than this
            // remainder, so keyboard-open positioning is untouched.
            expect(testState.scaffoldRender?.props.safeAreaBottom).toBe(4);
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

            // A backdrop tap dismisses the whole screen here, so with the keyboard up no gesture
            // retracts only the keyboard. The control exists for exactly that window and must not
            // linger as dead chrome once the keyboard is down.
            expect(findDismiss()).toHaveLength(0);

            act(() => { setTestKeyboardHeight(291); });
            expect(findDismiss().length).toBeGreaterThan(0);

            act(() => { setTestKeyboardHeight(0); });
            expect(findDismiss()).toHaveLength(0);
        } finally {
            act(() => { screen?.tree.unmount(); });
        }
    });

    it('leaves the floating composer through its own close control', async () => {
        const { NewSessionSimplePanel } = await import('./NewSessionSimplePanel');
        let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;

        try {
            screen = await renderScreen(<NewSessionSimplePanel {...createFloatingPanelProps()} />);

            // Dropping the navigator header removes the only guaranteed exit, so the screen owns
            // an explicit one; a backdrop tap alone is not an accessible substitute.
            screen.pressByTestId('new-session-composer-close');

            expect(safeRouterBackSpy).toHaveBeenCalledWith(expect.objectContaining({ fallbackHref: '/' }));
        } finally {
            act(() => {
                screen?.tree.unmount();
            });
        }
    });

    it('dismisses the floating composer when the visible backdrop region is tapped', async () => {
        const { NewSessionSimplePanel } = await import('./NewSessionSimplePanel');
        let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;

        try {
            screen = await renderScreen(<NewSessionSimplePanel {...createFloatingPanelProps()} />);

            // In the floating presentation the empty region above the composer IS the backdrop, and
            // tapping it closes — the modal contract, and the only dismiss target on Android, where
            // a transparent presentation catches nothing by default.
            const backdropPress = screen.tree.root
                .findAllByType('Pressable' as never)
                .find((node) => node.props.accessible === false);
            expect(backdropPress).toBeTruthy();
            act(() => {
                backdropPress!.props.onPress();
            });

            expect(safeRouterBackSpy).toHaveBeenCalledWith(expect.objectContaining({ fallbackHref: '/' }));
        } finally {
            act(() => {
                screen?.tree.unmount();
            });
        }
    });

    it('keeps a pending launch on screen when the backdrop is tapped', async () => {
        const { NewSessionSimplePanel } = await import('./NewSessionSimplePanel');
        let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;

        try {
            screen = await renderScreen(
                <NewSessionSimplePanel {...createFloatingPanelProps({ isCreating: true })} />,
            );

            // While a launch is in flight the backdrop region hosts the pending preview: a stray
            // tap there must not throw away the feedback the user is waiting on.
            const backdropPress = screen.tree.root
                .findAllByType('Pressable' as never)
                .find((node) => node.props.accessible === false);
            act(() => {
                backdropPress!.props.onPress();
            });

            expect(safeRouterBackSpy).not.toHaveBeenCalled();
        } finally {
            act(() => {
                screen?.tree.unmount();
            });
        }
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
            // 348 less the 46pt capsule row (36 + 10) this host draws above the card. The row lives
            // inside the same bottom-anchored slot and nothing else subtracts it, so without the
            // reservation a long draft grows up past the capsule and off the top of the screen.
            // `safeAreaTop` is 0 here, so only the row comes off.
            expect(testState.agentInputProps.at(-1)?.maxPanelHeight).toBe(348 - 46);
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

            // Same 46pt capsule-row reservation as above, applied to the seeded first-frame height.
            expect(testState.agentInputProps.at(-1)?.maxPanelHeight).toBe(610 - 46);
        } finally {
            act(() => {
                screen?.tree.unmount();
            });
        }
    });
});
