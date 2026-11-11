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
    timingFinished: true,
}));

const safeRouterBackSpy = vi.hoisted(() => vi.fn());

vi.mock('@/utils/navigation/safeRouterBack', () => ({
    safeRouterBack: (...args: unknown[]) => safeRouterBackSpy(...args),
}));

// The floating composer's exit reverses its entrance and pops WHEN THE ANIMATION LANDS, so this
// suite opts the canonical reanimated mock into settling `withTiming` completion callbacks.
vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    const mock = createReanimatedModuleMock({ settleTimingCallbacks: true });
    return { ...mock, withTiming: (value: number, config: Parameters<typeof mock.withTiming>[1], callback?: (finished: boolean) => void) =>
        mock.withTiming(value, config, callback ? () => callback(testState.timingFinished) : undefined) };
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

vi.mock('@/components/ui/popover', async importOriginal => ({
    ...(await importOriginal<typeof import('@/components/ui/popover')>()),
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
        // The status row's trailing actions are part of what the composer draws: render them.
        return React.createElement('AgentInput', props, props.statusTrailingActions as React.ReactNode);
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

// Load the real panel graph outside a test's deadline; focused selections otherwise spend their
// entire first test transforming the screen rather than exercising the animation boundary.
await import('./NewSessionSimplePanel');
// App modules load only after the mocks above are installed: `installNewSessionComponentsCommonModuleMocks`
// registers its `react-native` mock when it runs, not hoisted, and a static import of a UI module reaches the
// whole app graph (Text → storage → … → the floating-composer hook), which then binds the real platform and the
// panel stops floating.
const { resolveComposerBottomOffset } = await import('@/components/sessions/keyboardAvoidance/composerKeyboardGeometry');

describe('NewSessionSimplePanel keyboard scaffold integration', () => {
    beforeEach(() => {
        testState.agentInputProps = [];
        testState.scaffoldAvailablePanelHeight = 360;
        testState.scaffoldRender = null;
        testState.platformOs = 'ios';
        testState.timingFinished = true;
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

    it('seats the phone web Modal with the shared band and leaves outside dismissal available', async () => {
        testState.platformOs = 'web';
        const { NewSessionSimplePanel } = await import('./NewSessionSimplePanel');
        let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;

        try {
            screen = await renderScreen(<NewSessionSimplePanel {...createFloatingPanelProps()} />);

            expect(screen.findAllHostsByTestId('new-session-scrim').some(node => node.props.pointerEvents === 'none')).toBe(true);
            await screen.pressByTestIdAsync('new-session-backdrop-dismiss');
            expect(safeRouterBackSpy).toHaveBeenCalled();
            expect(testState.scaffoldRender?.props.surface).toBe('transparent');
            expect(screen.tree.root.findAll(
                (node) => node.props?.testID === 'new-session-scrim',
            ).length).toBeGreaterThan(0);
            expect(screen.tree.root.findAllByProps({ testID: 'new-session-composer-close' }).length).toBeGreaterThan(0);
        } finally {
            act(() => {
                screen?.tree.unmount();
            });
        }
    });

    it('centres a desktop web composer on its backdrop with no capsule: backdrop and Escape close it', async () => {
        testState.platformOs = 'web';
        const { NewSessionSimplePanel } = await import('./NewSessionSimplePanel');
        const props = {
            ...createFloatingPanelProps(),
            shouldBottomAnchor: false,
            containerStyle: { paddingTop: 20 },
        };
        const screen = await renderScreen(<NewSessionSimplePanel {...props} />);
        const scaffoldStyle = testState.scaffoldRender?.props.style;
        const flattened = Object.assign({}, ...(Array.isArray(scaffoldStyle) ? scaffoldStyle : [scaffoldStyle]));

        expect(flattened.justifyContent).toBe('center');
        expect(flattened.paddingTop).toBe(0);
        expect(screen.tree.root.findAllByProps({ testID: 'new-session-composer-close' })).toHaveLength(0);
        await screen.unmount();
    });

    it.each([
        ['ios', 'the home indicator', 0, 12],
        ['ios', 'the app bar it is presented over', 80, 12],
        ['android', 'the app bar it is presented over', 80, 8],
    ] as const)('keeps the %s floating band clear of %s from its padded wrapper', async (platform, _label, bottomChrome, bottomPadding) => {
        testState.platformOs = platform;
        const { NewSessionSimplePanel } = await import('./NewSessionSimplePanel');
        const { SessionCockpitBottomChromeHeightContext } = await import('@/components/workspaceCockpit/session/SessionCockpitChromeRegistry');
        let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;

        try {
            screen = await renderScreen(<SessionCockpitBottomChromeHeightContext.Provider value={bottomChrome}>
                <NewSessionSimplePanel {...createFloatingPanelProps({ newSessionBottomPadding: bottomPadding })} />
            </SessionCockpitBottomChromeHeightContext.Provider>);

            const band = screen.findAllHostsByTestId('new-session-scrim')[0]!;
            const bandBottom = Object.assign({}, ...[band.props.style].flat(Infinity)).bottom as number;
            const safeAreaBottom = testState.scaffoldRender?.props.safeAreaBottom as number;
            // The band is a sibling of the WHOLE padded card wrapper. Its bottom is measured
            // from the scaffold's seat, without adding the card's internal bottom padding again.
            const restingOffset = resolveComposerBottomOffset({ keyboardHeight: 0, safeAreaBottom });
            expect(restingOffset + bandBottom).toBe(bottomChrome);
            const keyboardOffset = resolveComposerBottomOffset({ keyboardHeight: 300, safeAreaBottom });
            expect(keyboardOffset + bandBottom).toBeGreaterThanOrEqual(bottomChrome);
        } finally {
            act(() => { screen?.tree.unmount(); });
        }
    });

    it('rests the web phone floating card at its own side margin', async () => {
        testState.platformOs = 'web';
        const { NewSessionSimplePanel } = await import('./NewSessionSimplePanel');
        let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
        try {
            screen = await renderScreen(<NewSessionSimplePanel {...createFloatingPanelProps({ shouldBottomAnchor: true })} />);
            expect(testState.scaffoldRender?.props.safeAreaBottom).toBe(16 - 12);
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

    it('settles an interrupted exit directly instead of leaving the composer disabled behind a timer', async () => {
        const { NewSessionSimplePanel } = await import('./NewSessionSimplePanel');
        testState.timingFinished = false;
        const screen = await renderScreen(<NewSessionSimplePanel {...createFloatingPanelProps()} />);
        try {
            screen.pressByTestId('new-session-composer-close');
            expect(safeRouterBackSpy).toHaveBeenCalledWith(expect.objectContaining({ fallbackHref: '/' }));
        } finally { await screen.unmount(); }
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
            // The panel reserves only the status bar (0 here). The close and keyboard controls ride the composer's own
            // status row, which AgentInput measures inside this room (2de4e02fd3), so nothing else comes off.
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

            // Same room as above, seeded before the scaffold subscription publishes: only the status bar comes off.
            expect(testState.agentInputProps.at(-1)?.maxPanelHeight).toBe(610);
        } finally {
            act(() => {
                screen?.tree.unmount();
            });
        }
    });
});
