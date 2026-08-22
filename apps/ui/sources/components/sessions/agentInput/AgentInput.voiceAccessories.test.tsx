import React from 'react';
import { act } from 'react-test-renderer';
import type { ReactTestInstance } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, type RenderScreenResult } from '@/dev/testkit';
import { installAgentInputCommonModuleMocks } from './agentInputTestHelpers';

const TRAILING_TEST_ID = 'voice-trailing-accessory';
const FIELD_TEST_ID = 'voice-field-accessory';
const SEND_TEST_ID = 'session-composer-send';
const PLANET_TEST_ID = 'session-composer-voice';
/** The wrapped second chip row — the column's own marker, whatever it holds. */
const SECOND_CHIP_ROW_TEST_ID = 'agentInput-pathResumeRow';

// `AgentInput` renders two structurally distinct panels — a web one and a native
// one — that both have to place these slots identically. A live getter lets one
// file assert both without a second copy of the mock family.
const platformState = vi.hoisted(() => ({ os: 'web' as 'web' | 'ios' }));
const dictationState = vi.hoisted(() => ({
    status: 'idle' as 'idle' | 'starting' | 'listening' | 'transcribing',
    toggle: vi.fn(),
    dismissFailure: vi.fn(),
}));
// The real `voice` setting, so `useVoiceAttemptControl` walks the real provider
// registry rather than being mocked out. `null` is "Voice not configured", which is
// what every test outside the mount block expects.
const voiceSettingState = vi.hoisted(() => ({ current: null as unknown }));

installAgentInputCommonModuleMocks({
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
            ActivityIndicator: (props: Record<string, unknown>) =>
                React.createElement('ActivityIndicator', props, null),
            Platform: {
                get OS() {
                    return platformState.os;
                },
                select: (v: any) => (platformState.os === 'web' ? v.web : v.ios) ?? v.native ?? v.default ?? null,
            },
            useWindowDimensions: () => ({ width: 900, height: 600 }),
            Dimensions: {
                get: () => ({ width: 900, height: 600, scale: 1, fontScale: 1 }),
            },
        });
    },
    icons: async () => ({
        Ionicons: (props: Record<string, unknown>) => React.createElement('Ionicons', props, null),
        Octicons: (props: Record<string, unknown>) => React.createElement('Octicons', props, null),
    }),
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useSetting: (key: string) => {
                if (key === 'voice') return voiceSettingState.current;
                if (key === 'profiles') return [];
                if (key === 'agentInputEnterToSend') return true;
                if (key === 'agentInputActionBarLayout') return 'wrap';
                if (key === 'agentInputChipDensity') return 'labels';
                if (key === 'sessionPermissionModeApplyTiming') return 'immediate';
                return null;
            },
            useSessionMessages: () => ({ messages: [], isLoaded: true }),
            useSessionTranscriptIds: () => ({ ids: [], isLoaded: true }),
            useSessionMessagesById: () => ({}),
            useSessionMessagesVersion: () => 0,
            useSessionMessagesReducerState: () => null,
        });
    },
    storageStore: async () => {
        const state = { sessionMessages: {}, localSettings: { uiFontScale: 1, uiContentWidthMode: null } };
        const store = Object.assign(
            (selector: any) => selector(state),
            {
                getState: () => state,
                getInitialState: () => state,
                subscribe: () => () => {},
            },
        );
        return { getStorage: () => store };
    },
});

vi.mock('expo-image', () => ({
    Image: (props: Record<string, unknown>) => React.createElement('Image', props, null),
}));

vi.mock('@/components/tools/shell/permissions/PermissionFooter', () => ({
    PermissionFooter: () => null,
}));

vi.mock('@/voice/dictation/useVoiceDictation', () => ({
    useVoiceDictation: () => ({
        status: dictationState.status,
        failure: null,
        toggle: dictationState.toggle,
        dismissFailure: dictationState.dismissFailure,
    }),
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => featureId === 'voice',
}));

vi.mock('@/agents/catalog/catalog', () => ({
    getAgentIconSvgXml: () => null,
    getAgentIconSource: () => null,
    getAgentIconTintColor: () => undefined,
    AGENT_IDS: ['codex', 'claude'],
    DEFAULT_AGENT_ID: 'codex',
    resolveAgentIdFromFlavor: () => null,
    getAgentCore: () => ({ displayNameKey: 'agents.codex', toolRendering: { hideUnknownToolsByDefault: false } }),
}));

vi.mock('@/sync/domains/models/modelOptions', () => ({
    findModelOptionForEffectiveModelId: () => null,
    getModelOptionsForSession: () => [{ value: 'default', label: 'Default' }],
    supportsFreeformModelSelectionForSession: () => false,
}));

vi.mock('@/sync/domains/models/describeEffectiveModelMode', () => ({
    describeEffectiveModelMode: () => ({ selectedModelId: 'default', appliedModelId: null, effectiveModelId: 'default' }),
}));

vi.mock('@/sync/domains/permissions/permissionModeOptions', () => ({
    getPermissionModeBadgeLabelForAgentType: () => 'Default',
    getPermissionModeLabelForAgentType: () => 'Default',
    getPermissionModeOptionsForSession: () => [{ value: 'default', label: 'Default' }],
    getPermissionModeTitleForAgentType: () => 'Permissions',
}));

vi.mock('@/sync/domains/permissions/describeEffectivePermissionMode', () => ({
    describeEffectivePermissionMode: () => ({ effectiveMode: 'default' }),
}));

vi.mock('@/components/ui/forms/MultiTextInput', () => ({
    MultiTextInput: React.forwardRef((props: Record<string, unknown>, ref) => {
        React.useImperativeHandle(ref, () => ({
            setTextAndSelection: () => {},
            focus: () => {},
            blur: () => {},
        }));
        return React.createElement('MultiTextInput', props, null);
    }),
}));

vi.mock('@/components/ui/forms/Switch', () => ({
    Switch: (props: Record<string, unknown>) => React.createElement('Switch', props, null),
}));

vi.mock('@/components/ui/theme/haptics', () => ({
    hapticsLight: () => {},
    hapticsError: () => {},
}));

vi.mock('@/components/ui/feedback/Shaker', () => ({
    Shaker: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement(React.Fragment, null, props.children),
}));

vi.mock('@/components/ui/status/StatusDot', () => ({
    StatusDot: () => null,
}));

vi.mock('@/components/autocomplete/useActiveSuggestions', () => ({
    useActiveSuggestions: () => [[], -1, () => {}, () => {}] as const,
}));

vi.mock('@/components/autocomplete/applySuggestion', () => ({
    applySuggestion: (text: string) => ({ text, cursorPosition: text.length }),
}));

vi.mock('@/components/ui/popover', () => ({
    Popover: () => null,
    PopoverScope: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/ui/overlays/FloatingOverlay', () => ({
    FloatingOverlay: () => null,
}));

vi.mock('@/components/ui/scroll/useScrollEdgeFades', () => ({
    useScrollEdgeFades: () => ({
        canScrollX: false,
        visibility: { left: false, right: false },
        onViewportLayout: () => {},
        onContentSizeChange: () => {},
        onScroll: () => {},
        onMomentumScrollEnd: () => {},
    }),
}));

vi.mock('@/components/ui/scroll/ScrollEdgeFades', () => ({
    ScrollEdgeFades: () => null,
}));

vi.mock('@/components/ui/scroll/ScrollEdgeIndicators', () => ({
    ScrollEdgeIndicators: () => null,
}));

vi.mock('@/components/sessions/sourceControl/status', () => ({
    SourceControlStatusBadge: () => null,
    useHasMeaningfulScmStatus: () => false,
}));

vi.mock('@/hooks/ui/useKeyboardHeight', () => ({
    useKeyboardHeight: () => 0,
}));

vi.mock('@/sync/domains/sessionControl/sessionModeControl', () => ({
    computeSessionModePickerControl: () => null,
}));

vi.mock('@/sync/domains/sessionControl/configOptionsControl', () => ({
    computeAcpConfigOptionControls: () => null,
}));

function flattenStyle(style: unknown): Record<string, unknown> {
    if (typeof style === 'function') {
        return flattenStyle(style({ pressed: false }));
    }
    if (Array.isArray(style)) {
        return style.reduce<Record<string, unknown>>((acc, entry) => Object.assign(acc, flattenStyle(entry)), {});
    }
    if (style && typeof style === 'object') return style as Record<string, unknown>;
    return {};
}

function readEffectiveTargetSize(node: ReactTestInstance): Readonly<{ width: number; height: number }> {
    const style = flattenStyle(node.props.style);
    const hitSlop = node.props.hitSlop;
    const inset = (edge: 'top' | 'right' | 'bottom' | 'left'): number => (
        typeof hitSlop === 'number' ? hitSlop : Number(hitSlop?.[edge] ?? 0)
    );
    return {
        width: Math.max(Number(style.width ?? 0), Number(style.minWidth ?? 0)) + inset('left') + inset('right'),
        height: Math.max(Number(style.height ?? 0), Number(style.minHeight ?? 0)) + inset('top') + inset('bottom'),
    };
}

function findSlotContainer(screen: RenderScreenResult, ...testIDs: readonly string[]): ReactTestInstance {
    const candidates = screen.root.findAll((node) => (
        typeof node.type === 'string'
        && !testIDs.includes(node.props?.testID)
        && testIDs.every((testID) => node.findAllByProps({ testID }).length > 0)
    ));
    const deepest = candidates.at(-1);
    if (!deepest) throw new Error(`No container holds all of ${testIDs.join(', ')}`);
    return deepest;
}

function readSlotOrder(container: ReactTestInstance, ...testIDs: readonly string[]): string[] {
    const seen: string[] = [];
    for (const node of container.findAll((n) => typeof n.type === 'string')) {
        const testID = node.props?.testID;
        if (typeof testID === 'string' && testIDs.includes(testID) && !seen.includes(testID)) {
            seen.push(testID);
        }
    }
    return seen;
}

async function renderComposer(overrides: Record<string, unknown> = {}): Promise<RenderScreenResult> {
    const { AgentInput } = await import('./AgentInput');
    return renderScreen(<AgentInput
        sessionId="session-1"
        value=""
        placeholder="Type"
        onChangeText={() => {}}
        onSend={() => {}}
        autocompleteKinds={[]}
        autocompleteSuggestions={async () => []}
        {...overrides}
    />);
}

/**
 * The New Session composer's identifying props.
 *
 * The two-row action bar is **not** a property of having a machine or a path to
 * show: `shouldShowSecondaryControlRow` reads `hasMachine || hasPath ||
 * hasResume`, and each of those is a *handler or popover*, never a label
 * (`AgentInput.tsx:2424-2426`). The in-session composer displays the same
 * machine and path and stays one row — which is why the stacked trailing cluster
 * is reachable only from `NewSessionSimplePanel.tsx:328-336` and
 * `NewSessionWizard.tsx:670-678`, and why a fixture that passes labels alone
 * would silently test the one-row case while claiming to test two rows.
 */
const NEW_SESSION_LABELS = {
    machineName: 'leeroy-mbp',
    currentPath: 'happier/dev',
    resumeSessionId: 'resume-1',
} as const;

const NEW_SESSION_HANDLERS = {
    onMachineClick: () => {},
    onPathClick: () => {},
    onResumeClick: () => {},
} as const;

/**
 * The real composer planet, in the real trailing slot.
 *
 * A `View` fixture proves placement but not composition: the planet is a memo
 * leaf that reads the energy context, and mounting it here is what proves it
 * survives the composer's own mock family and lands in the cluster.
 */
async function renderComposerWithPlanet(
    overrides: Record<string, unknown> = {},
): Promise<RenderScreenResult> {
    const { AgentInput } = await import('./AgentInput');
    const { VoiceComposerPlanet } = await import('@/components/voice/composer/VoiceComposerPlanet');
    const { VoiceEnergyProvider } = await import('@/components/voice/light/useVoiceEnergy');
    return renderScreen(
        <VoiceEnergyProvider
            state={{ luminosity: 0.62, energized: true, direction: 'inward' }}
            activation={{ providerReady: true, attemptActive: true, micCaptureActive: true }}
        >
            <AgentInput
                sessionId="session-1"
                value=""
                placeholder="Type"
                onChangeText={() => {}}
                onSend={() => {}}
                autocompleteKinds={[]}
                autocompleteSuggestions={async () => []}
                submitDictation={false}
                trailingAccessory={(
                    <VoiceComposerPlanet
                        live
                        muted={false}
                        stop="cool"
                        accessibilityLabel="End the conversation"
                        accessibilityHint="Stops the spoken conversation"
                        onPress={() => {}}
                    />
                )}
                {...overrides}
            />
        </VoiceEnergyProvider>,
    );
}

describe('AgentInput voice accessory slots', () => {
    afterEach(() => {
        platformState.os = 'web';
        dictationState.status = 'idle';
        vi.clearAllMocks();
    });

    it('leaves the submit button meaning Send when the host owns dictation', async () => {
        const screen = await renderComposer({ submitDictation: false });

        const send = screen.findByTestId(SEND_TEST_ID);
        if (!send) throw new Error(`${SEND_TEST_ID} not found`);
        expect(send.props.accessibilityLabel).toBe('common.send');
        expect(send.findAllByType('Image' as any)).toHaveLength(0);

        await screen.unmount();
    });

    it('keeps the microphone when Stop is already reachable from the abort chip', async () => {
        // The regression this pins: an earlier fix let the empty-composer Stop take
        // the submit button unconditionally. On the default action bar that buys a
        // *duplicate* Stop — `buildCoreAgentInputControlNodes.tsx:184` already
        // renders a dedicated abort chip — and pays for it with the microphone.
        // Here dictation IS available on the button, so Stop must yield. The host
        // owns the field corner, which is what keeps the microphone on the submit
        // button now that a composer owning that corner moves dictation into it.
        const onAbort = vi.fn();
        const screen = await renderComposer({
            onAbort,
            showAbortButton: true,
            fieldAccessory: <FieldAccessoryFixture />,
        });

        const send = screen.findByTestId(SEND_TEST_ID);
        if (!send) throw new Error(`${SEND_TEST_ID} not found`);
        expect(send.findAllByType('Icon' as any).some((n) => n.props?.name === 'stop')).toBe(false);
        expect(send.props.accessibilityLabel).not.toBe('agentInput.stopCodingTurn');

        await screen.unmount();
    });

    it('leaves the microphone alone when an Agent switch is armed but nothing is typed', async () => {
        // The armed label follows the arm onto the SEND, not onto whatever this
        // button happens to be. Here the host owns the field corner, so the
        // microphone owns the submit button — and "Continue with Codex" on it
        // would name a switch that press starts dictating into instead of taking.
        const screen = await renderComposer({
            fieldAccessory: <FieldAccessoryFixture />,
            armedContinuationTarget: { agentId: 'codex', label: 'Codex' },
        });

        const send = screen.findByTestId(SEND_TEST_ID);
        if (!send) throw new Error(`${SEND_TEST_ID} not found`);
        expect(send.props.accessibilityLabel).toBe('voiceAssistant.startDictation');
        expect(send.findAllByType('Image' as any)).toHaveLength(1);

        await screen.unmount();
    });

    it('names the armed switch on the submit button once the host stops taking it', async () => {
        // The counterpart: with dictation moved off this control there is nothing
        // else holding it, so the empty composer's inert send says what pressing it
        // would do. Without this pair the narrowing above could be "never show the
        // arm on an empty composer" and both tests would still pass.
        const screen = await renderComposer({
            submitDictation: false,
            armedContinuationTarget: { agentId: 'codex', label: 'Codex' },
        });

        const send = screen.findByTestId(SEND_TEST_ID);
        if (!send) throw new Error(`${SEND_TEST_ID} not found`);
        expect(send.props.accessibilityLabel).toBe('session.agentContinuation.sendLabel');
        expect(send.findAllByType('Image' as any)).toHaveLength(0);
        expect(send.props.disabled).toBe(true);

        await screen.unmount();
    });

    it('lets the submit button stop the coding turn when the host owns dictation', async () => {
        const onAbort = vi.fn();
        const screen = await renderComposer({
            submitDictation: false,
            onAbort,
            showAbortButton: true,
        });

        const send = screen.findByTestId(SEND_TEST_ID);
        if (!send) throw new Error(`${SEND_TEST_ID} not found`);
        expect(send.props.accessibilityLabel).toBe('agentInput.stopCodingTurn');
        expect(send.findAllByType('Image' as any)).toHaveLength(0);
        expect(send.findAllByType('Icon' as any).some((n) => n.props?.name === 'stop')).toBe(true);

        await screen.pressByTestIdAsync(SEND_TEST_ID);
        expect(onAbort).toHaveBeenCalledTimes(1);

        await screen.unmount();
    });

    it('pins the field accessory to the field corner and drops it below the expand toggle', async () => {
        const screen = await renderComposer({
            fieldAccessory: <FieldAccessoryFixture />,
            inputExpansion: { expanded: false, collapsedMaxHeight: 100, onToggle: () => {} },
        });

        expect(screen.findByTestId('agent-input-expand-toggle')).toBeNull();
        expect(flattenStyle(findSlotContainer(screen, FIELD_TEST_ID).props.style)).toMatchObject({
            position: 'absolute',
            top: 2,
            right: -4,
            width: 44,
            height: 44,
            paddingTop: 4,
        });

        const input = screen.root.findByType('MultiTextInput' as any);
        await act(async () => {
            input.props.onContentHeightChange?.(240);
        });

        const toggle = screen.findByTestId('agent-input-expand-toggle');
        expect(toggle).not.toBeNull();
        expect(readEffectiveTargetSize(toggle!)).toEqual({ width: 44, height: 44 });
        const fieldTargetStyle = flattenStyle(findSlotContainer(screen, FIELD_TEST_ID).props.style);
        expect(fieldTargetStyle).toMatchObject({
            position: 'absolute',
            top: 30,
            right: -4,
            width: 44,
            height: 44,
            paddingTop: 4,
        });
        const toggleStyle = flattenStyle(toggle!.props.style);
        const toggleTargetBottom = Number(toggleStyle.top)
            + Number(toggleStyle.height)
            + Number(toggle!.props.hitSlop.bottom);
        expect(toggleTargetBottom).toBe(fieldTargetStyle.top);

        await screen.unmount();
    });

    it.each([
        ['web', 'web'] as const,
        ['native', 'ios'] as const,
    ])('renders the trailing accessory before the submit button on the %s panel', async (_label, os) => {
        platformState.os = os;
        const screen = await renderComposer({ trailingAccessory: <TrailingAccessoryFixture /> });

        const cluster = findSlotContainer(screen, TRAILING_TEST_ID, SEND_TEST_ID);
        expect(readSlotOrder(cluster, TRAILING_TEST_ID, SEND_TEST_ID)).toEqual([TRAILING_TEST_ID, SEND_TEST_ID]);
        expect(flattenStyle(cluster.props.style)).toMatchObject({ flexDirection: 'row' });

        await screen.unmount();
    });

    it.each([
        ['web', 'web'] as const,
        ['native', 'ios'] as const,
    ])('keeps that reading order on the %s panel when the row stacks', async (_label, os) => {
        platformState.os = os;
        const screen = await renderComposer({
            trailingAccessory: <TrailingAccessoryFixture />,
            machineName: 'Machine',
            onMachineClick: () => {},
        });

        const { NATIVE_ACTION_BAR_SECTION_GAP_Y } = await import('./AgentInput');
        const cluster = findSlotContainer(screen, TRAILING_TEST_ID, SEND_TEST_ID);
        // column-reverse paints the accessory *under* Send while the tree — and so
        // the screen-reader order — still reads accessory first.
        const clusterStyle = flattenStyle(cluster.props.style);
        expect(clusterStyle).toMatchObject({ flexDirection: 'column-reverse' });
        expect(readSlotOrder(cluster, TRAILING_TEST_ID, SEND_TEST_ID)).toEqual([TRAILING_TEST_ID, SEND_TEST_ID]);

        // The cluster is the chip column's **sibling**, never a passenger inside
        // chip row 1. Nested there it was centred against the chips, so every
        // point it stood taller than a 32pt chip was paid twice — once above the
        // row and once below — as the dead band under the input.
        const bar = findSlotContainer(screen, TRAILING_TEST_ID, SECOND_CHIP_ROW_TEST_ID);
        expect(flattenStyle(bar.props.style)).toMatchObject({
            flexDirection: 'row',
            alignItems: 'flex-end',
            justifyContent: 'space-between',
        });

        // And it rides the column's own row rhythm, so two stacked 32pt controls
        // measure exactly the two 32pt chip rows beside them.
        const column = findSlotContainer(screen, SECOND_CHIP_ROW_TEST_ID);
        expect(clusterStyle.gap)
            .toBe(flattenStyle(column.props.style).gap ?? NATIVE_ACTION_BAR_SECTION_GAP_Y);

        await screen.unmount();
    });
});

describe('AgentInput two-row trailing cluster', () => {
    afterEach(() => {
        platformState.os = 'web';
        vi.clearAllMocks();
    });

    it.each([
        ['web', 'web'] as const,
        ['native', 'ios'] as const,
    ])('keeps Voice inline beside Send on the %s panel while the labels are only labels', async (_label, os) => {
        platformState.os = os;
        const screen = await renderComposerWithPlanet(NEW_SESSION_LABELS);

        const cluster = findSlotContainer(screen, PLANET_TEST_ID, SEND_TEST_ID);
        expect(flattenStyle(cluster.props.style)).toMatchObject({ flexDirection: 'row' });
        expect(readSlotOrder(cluster, PLANET_TEST_ID, SEND_TEST_ID))
            .toEqual([PLANET_TEST_ID, SEND_TEST_ID]);

        await screen.unmount();
    });

    it.each([
        ['web', 'web'] as const,
        ['native', 'ios'] as const,
    ])('stacks Voice under Send on the %s panel once the New Session handlers arrive', async (_label, os) => {
        platformState.os = os;
        const screen = await renderComposerWithPlanet({
            ...NEW_SESSION_LABELS,
            ...NEW_SESSION_HANDLERS,
        });

        const cluster = findSlotContainer(screen, PLANET_TEST_ID, SEND_TEST_ID);
        // `column-reverse` paints the first child last: Send on top, the planet
        // beneath it, while the tree — and the screen reader — still reads
        // "Voice, then Send". Reversing the JSX to "fix" the stack breaks the row.
        expect(flattenStyle(cluster.props.style)).toMatchObject({ flexDirection: 'column-reverse' });
        expect(readSlotOrder(cluster, PLANET_TEST_ID, SEND_TEST_ID))
            .toEqual([PLANET_TEST_ID, SEND_TEST_ID]);

        await screen.unmount();
    });

    it.each([
        ['web', 'web'] as const,
        ['native', 'ios'] as const,
    ])('draws the planet at the submit button’s own weight on the %s panel', async (_label, os) => {
        platformState.os = os;
        const { VOICE_COMPOSER_PLANET_SLOT } = await import('@/components/voice/composer/VoiceComposerPlanet');
        const screen = await renderComposerWithPlanet({
            ...NEW_SESSION_LABELS,
            ...NEW_SESSION_HANDLERS,
        });

        const planets = screen.root.findAll((node) => (
            typeof node.type === 'string' && node.props?.testID === PLANET_TEST_ID
        ));
        expect(planets).toHaveLength(1);
        const planet = planets[0]!;
        const discs = planet.findAllByType('Svg' as never);
        expect(discs).toHaveLength(1);
        expect({ width: discs[0]!.props.width, height: discs[0]!.props.height }).toEqual({
            width: VOICE_COMPOSER_PLANET_SLOT,
            height: VOICE_COMPOSER_PLANET_SLOT,
        });

        // Nothing between the planet and the cluster may clip: a 12% inhale
        // overshoots ~2pt per edge and the row's 8pt gap is what absorbs it.
        const cluster = findSlotContainer(screen, PLANET_TEST_ID, SEND_TEST_ID);
        for (let node: ReactTestInstance | null = planet; node && node !== cluster; node = node.parent) {
            expect(flattenStyle(node.props?.style).overflow).not.toBe('hidden');
        }
        expect(flattenStyle(cluster.props.style).overflow).not.toBe('hidden');

        await screen.unmount();
    });
});

/**
 * A provider whose settings projection is `ready`, so `useVoiceAttemptControl`
 * reports a startable attempt. Same shape `VoiceSurface.test.tsx` drives the real
 * surface with — nothing about the provider registry is mocked.
 */
const READY_VOICE_SETTING = {
    providerId: 'local_conversation',
    ui: { activityFeedEnabled: false, scopeDefault: 'global', surfaceLocation: 'auto' },
    providers: {
        local_conversation: { schemaVersion: 1, config: { conversationMode: 'agent' } },
    },
} as const;

const DICTATION_TEST_ID = 'agent-input-dictation';

/**
 * A voice adapter is a genuine runtime boundary — the provider controller the
 * registry projects surface capabilities from. Everything beneath it (the
 * projection, the availability ladder, the light stop) runs for real.
 */
async function registerLocalConversationAdapter(): Promise<void> {
    const { registerVoiceAdapters } = await import('@/voice/session/voiceAdapterRegistry');
    registerVoiceAdapters([{
        id: 'local_conversation',
        engineKind: 'realtime',
        start: async () => undefined,
        stop: async () => undefined,
        toggle: async () => undefined,
        interrupt: async () => undefined,
        bargeIn: async () => undefined,
        setMuted: async () => undefined,
        sendContextUpdate: () => undefined,
        getSnapshot: () => ({
            adapterId: 'local_conversation',
            sessionId: null,
            status: 'disconnected',
            mode: 'idle',
            canStop: false,
        }),
        resolveSurfaceCapabilities: () => ({
            allowsGlobalStart: true,
            controlSessionScope: 'global',
            requiresVoiceAgentFeature: false,
            bargeInEnabled: false,
            cancelResponse: 'unsupported',
        }),
    } as never]);
}

async function renderSessionComposer(
    overrides: Record<string, unknown> = {},
): Promise<RenderScreenResult> {
    const { AgentInput } = await import('./AgentInput');
    const { VoiceEnergyProvider } = await import('@/components/voice/light/useVoiceEnergy');
    await registerLocalConversationAdapter();
    return renderScreen(
        <VoiceEnergyProvider
            state={{ luminosity: 0.4, energized: false, direction: 'none' }}
            activation={{ providerReady: true, attemptActive: false, micCaptureActive: false }}
        >
            <AgentInput
                sessionId="session-1"
                value=""
                placeholder="Type"
                onChangeText={() => {}}
                onSend={() => {}}
                autocompleteKinds={[]}
                autocompleteSuggestions={async () => []}
                {...overrides}
            />
        </VoiceEnergyProvider>,
    );
}

/**
 * §2.3 in the *real* composer.
 *
 * The slots landed first and stayed empty: the only `trailingAccessory` producer in
 * the tree was the design lab, so the planet reached no user. These tests are about
 * the production default — the composer that owns a session mounts both accessories
 * itself, and that is what takes dictation off the submit button.
 */
describe('AgentInput mounts the Voice composer', () => {
    afterEach(() => {
        platformState.os = 'web';
        dictationState.status = 'idle';
        voiceSettingState.current = null;
        vi.clearAllMocks();
    });

    it.each([
        ['web', 'web'] as const,
        ['native', 'ios'] as const,
    ])('puts Voice in the trailing slot before Send on the %s panel with no host accessory', async (_label, os) => {
        platformState.os = os;
        voiceSettingState.current = READY_VOICE_SETTING;

        const screen = await renderSessionComposer();

        const cluster = findSlotContainer(screen, PLANET_TEST_ID, SEND_TEST_ID);
        expect(readSlotOrder(cluster, PLANET_TEST_ID, SEND_TEST_ID))
            .toEqual([PLANET_TEST_ID, SEND_TEST_ID]);

        await screen.unmount();
    });

    it('moves dictation to the field corner and leaves the submit button meaning Send', async () => {
        voiceSettingState.current = READY_VOICE_SETTING;

        const screen = await renderSessionComposer();

        const mic = screen.findByTestId(DICTATION_TEST_ID);
        expect(mic).not.toBeNull();
        expect(mic!.props.accessibilityLabel).toBe('voiceAssistant.startDictation');
        expect(readEffectiveTargetSize(mic!)).toEqual({ width: 44, height: 44 });
        const icons = mic!.findAll((node) => (
            typeof node.type === 'string' && (node.type as string) === 'Ionicons'
        ));
        expect(icons).toHaveLength(1);
        expect(icons[0]!.props.name).toBe('mic-outline');
        expect(flattenStyle(findSlotContainer(screen, DICTATION_TEST_ID).props.style))
            .toMatchObject({ position: 'absolute', top: 2, right: -4, paddingTop: 4 });

        const send = screen.findByTestId(SEND_TEST_ID);
        expect(send!.props.accessibilityLabel).toBe('common.send');

        await screen.pressByTestIdAsync(DICTATION_TEST_ID);
        expect(dictationState.toggle).toHaveBeenCalledTimes(1);

        await screen.unmount();
    });

    it('uses the specified mic-off glyph while field dictation is active', async () => {
        voiceSettingState.current = READY_VOICE_SETTING;
        dictationState.status = 'listening';

        const screen = await renderSessionComposer();

        const mic = screen.findByTestId(DICTATION_TEST_ID);
        expect(mic).not.toBeNull();
        expect(mic!.props.accessibilityLabel).toBe('voiceAssistant.endDictation');
        const icons = mic!.findAll((node) => (
            typeof node.type === 'string' && (node.type as string) === 'Ionicons'
        ));
        expect(icons).toHaveLength(1);
        expect(icons[0]!.props.name).toBe('mic-off-outline');

        await screen.unmount();
    });

    it('keeps a host-supplied accessory in charge of both slots', async () => {
        voiceSettingState.current = READY_VOICE_SETTING;

        const screen = await renderSessionComposer({
            trailingAccessory: <TrailingAccessoryFixture />,
            fieldAccessory: <FieldAccessoryFixture />,
        });

        // The props are the seam; the mount is only the default. A host that owns the
        // slots keeps them, and keeps the submit-button microphone with them.
        expect(screen.findByTestId(TRAILING_TEST_ID)).not.toBeNull();
        expect(screen.findByTestId(PLANET_TEST_ID)).toBeNull();
        expect(screen.findByTestId(FIELD_TEST_ID)).not.toBeNull();
        expect(screen.findByTestId(DICTATION_TEST_ID)).toBeNull();
        expect(screen.findByTestId(SEND_TEST_ID)!.props.accessibilityLabel)
            .toBe('voiceAssistant.startDictation');

        await screen.unmount();
    });

    it('renders no planet while Voice has no usable provider, and still moves dictation', async () => {
        voiceSettingState.current = null;

        const screen = await renderSessionComposer();

        // Placement must not flicker with provider readiness: the field mic is where
        // dictation lives, whether or not a conversation could start right now.
        expect(screen.findByTestId(PLANET_TEST_ID)).toBeNull();
        expect(screen.findByTestId(DICTATION_TEST_ID)).not.toBeNull();

        await screen.unmount();
    });
});

/**
 * §2.5 — which conversation each composer's planet starts.
 *
 * Both directions were wrong at once. The New Session composer mounted no planet at all, because
 * the mount was gated on `props.sessionId`; and the planet that did mount hardcoded a **Global**
 * start, so pressing it inside a session opened a conversation bound to nothing.
 *
 * The target is stated by the composer, never inferred by the projection: an existing session ⇒
 * that exact session, New Session ⇒ Global with the unsent draft intact.
 */
describe('AgentInput states the Voice planet’s target', () => {
    afterEach(async () => {
        platformState.os = 'web';
        dictationState.status = 'idle';
        voiceSettingState.current = null;
        const { registerVoiceAdapters } = await import('@/voice/session/voiceAdapterRegistry');
        registerVoiceAdapters([]);
        vi.restoreAllMocks();
        vi.clearAllMocks();
    });

    async function spyOnLifecycleRouting() {
        const { voiceSessionManager } = await import('@/voice/session/voiceSession');
        return {
            toggle: vi.spyOn(voiceSessionManager, 'toggle').mockResolvedValue(undefined),
            stop: vi.spyOn(voiceSessionManager, 'stop').mockResolvedValue(undefined),
        };
    }

    /**
     * The New Session composer, by its identifying props: no session exists yet, and the
     * machine/path/resume **handlers** are what put it in its two-row layout.
     */
    async function renderNewSessionComposer(
        overrides: Record<string, unknown> = {},
    ): Promise<RenderScreenResult> {
        const { AgentInput } = await import('./AgentInput');
        const { VoiceEnergyProvider } = await import('@/components/voice/light/useVoiceEnergy');
        await registerLocalConversationAdapter();
        return renderScreen(
            <VoiceEnergyProvider
                state={{ luminosity: 0.4, energized: false, direction: 'none' }}
                activation={{ providerReady: true, attemptActive: false, micCaptureActive: false }}
            >
                <AgentInput
                    value=""
                    placeholder="Type"
                    onChangeText={() => {}}
                    onSend={() => {}}
                    autocompleteKinds={[]}
                    autocompleteSuggestions={async () => []}
                    {...NEW_SESSION_LABELS}
                    {...NEW_SESSION_HANDLERS}
                    {...overrides}
                />
            </VoiceEnergyProvider>,
        );
    }

    it('starts the composer’s own session from an existing-session composer', async () => {
        voiceSettingState.current = READY_VOICE_SETTING;
        const routing = await spyOnLifecycleRouting();

        const screen = await renderSessionComposer({ sessionId: 'session-7' });

        const planet = screen.findByTestId(PLANET_TEST_ID);
        expect(planet).not.toBeNull();
        expect(planet!.props.accessibilityLabel).toBe('voiceAssistant.startVoice');

        await screen.pressByTestIdAsync(PLANET_TEST_ID);
        expect(routing.toggle).toHaveBeenCalledWith('session-7');

        await screen.unmount();
    });

    it('mounts a Global planet in the New Session composer and keeps the unsent draft', async () => {
        voiceSettingState.current = READY_VOICE_SETTING;
        const routing = await spyOnLifecycleRouting();
        const onChangeText = vi.fn();

        const screen = await renderNewSessionComposer({
            value: 'unsent draft',
            onChangeText,
        });

        const planet = screen.findByTestId(PLANET_TEST_ID);
        expect(planet).not.toBeNull();
        // A screen-reader user cannot see which composer they are in, so the label says which
        // conversation this starts.
        expect(planet!.props.accessibilityLabel).toBe('voiceAssistant.startGlobalVoice');

        await screen.pressByTestIdAsync(PLANET_TEST_ID);
        // The empty session id is the canonical global/hidden-owner start.
        expect(routing.toggle).toHaveBeenCalledWith('');

        // Starting Voice is not sending, discarding, or re-mounting the prompt being written.
        expect(screen.root.findByType('MultiTextInput' as any).props.value).toBe('unsent draft');
        expect(onChangeText).not.toHaveBeenCalled();

        await screen.unmount();
    });

    it('leaves dictation session-scoped in the New Session composer', async () => {
        voiceSettingState.current = READY_VOICE_SETTING;

        const screen = await renderNewSessionComposer();

        // Dictation appends to *this* field through a session-bound transcriber; the planet's
        // arrival in New Session must not drag it along. The two halves of §2.3 are gated on
        // different facts, and one flag for both is what hid the planet here in the first place.
        expect(screen.findByTestId(PLANET_TEST_ID)).not.toBeNull();
        expect(screen.findByTestId(DICTATION_TEST_ID)).toBeNull();

        await screen.unmount();
    });
});

function FieldAccessoryFixture() {
    return React.createElement('View', { testID: FIELD_TEST_ID });
}

function TrailingAccessoryFixture() {
    return React.createElement('View', { testID: TRAILING_TEST_ID });
}
