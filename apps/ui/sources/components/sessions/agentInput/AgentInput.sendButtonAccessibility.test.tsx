import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectUnexpectedRawTextNodes, renderScreen } from '@/dev/testkit';
import { VoiceCaptureBusyError } from '@/voice/runtime/input/VoiceCaptureAdmissionController';
import { installAgentInputCommonModuleMocks } from './agentInputTestHelpers';
import type { AutocompleteSuggestion } from '@/components/autocomplete/autocompleteTypes';
import type { AgentInputAttachmentsRowItem } from './agentInputContracts';

type MultiTextInputSelection = { start: number; end: number };
type MultiTextInputState = { text: string; selection: MultiTextInputSelection };
type ActiveSuggestionsResult = readonly [
    readonly AutocompleteSuggestion[],
    number,
    () => void,
    () => void,
];

const multiTextInputHandleMocks = vi.hoisted(() => ({
    blur: vi.fn(),
    focus: vi.fn(),
    setTextAndSelection: vi.fn(),
}));
const multiTextInputRenderCount = vi.hoisted(() => ({ value: 0 }));
const useActiveSuggestionsMock = vi.hoisted(() => vi.fn<() => ActiveSuggestionsResult>(
    () => [[], -1, () => {}, () => {}],
));
const dictationState = vi.hoisted(() => ({
    status: 'idle' as 'idle' | 'starting' | 'listening' | 'transcribing',
    failure: null as null | Readonly<{
        id: number;
        sessionId: string;
        kind: 'provider_error';
        reason: 'capture_duration_exceeded';
    }>,
    toggle: vi.fn(),
    dismissFailure: vi.fn(),
}));
const modalAlertMock = vi.hoisted(() => vi.fn());
/**
 * The suite renders against keys, which is what keeps its assertions independent
 * of copy — but a key carries no Agent name, so every render lands in the
 * "sentence does not interpolate" branch and the mark can only be trailing. One
 * test needs a sentence that really names the Agent to exercise the other side.
 */
const translateOverride = vi.hoisted(() => ({
    fn: null as null | ((key: string, params?: Record<string, unknown>) => string),
}));

// The Agent mark is a rendering boundary that reaches the generated Agent
// catalog, which this composer harness does not install. Stub it so the send
// button's own contract — the accessible name, and which mark it draws — is
// what the test exercises.
vi.mock('@/agents/registry/AgentIcon', () => ({
    AgentIcon: (props: Record<string, unknown>) => React.createElement('AgentIcon', props),
}));

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
                OS: 'web',
                select: (v: any) => v.web ?? v.default ?? null,
            },
            useWindowDimensions: () => ({ width: 800, height: 600 }),
            Dimensions: {
                get: () => ({ width: 800, height: 600, scale: 1, fontScale: 1 }),
            },
        });
    },
    icons: async () => {
        return {
            Ionicons: (props: Record<string, unknown>) => React.createElement('Ionicons', props, null),
            Octicons: (props: Record<string, unknown>) => React.createElement('Octicons', props, null),
        };
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key, params) => translateOverride.fn?.(key, params) ?? key,
        });
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                alert: (...args) => modalAlertMock(...args),
            },
        }).module;
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useSetting: (key: string) => {
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

// This focused composer graph does not exercise Markdown; the third-party
// patched streaming module is a genuine package boundary and may be absent
// before the UI postinstall lane publishes it.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: () => [],
}));

vi.mock('@/components/tools/shell/permissions/PermissionFooter', () => ({
    PermissionFooter: () => null,
}));

vi.mock('@/voice/dictation/useVoiceDictation', () => ({
    useVoiceDictation: () => ({
        status: dictationState.status,
        failure: dictationState.failure,
        toggle: dictationState.toggle,
        dismissFailure: dictationState.dismissFailure,
    }),
}));

const featureEnabledState: Record<string, boolean> = { voice: true };

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => featureEnabledState[featureId] === true,
}));

vi.mock('@/agents/catalog/catalog', () => ({
    getAgentIconSvgXml: () => null,
    getAgentIconSource: () => null,
    getAgentIconTintColor: () => undefined,
    AGENT_IDS: ['codex', 'claude', 'opencode', 'gemini'],
    DEFAULT_AGENT_ID: 'codex',
    resolveAgentIdFromFlavor: () => null,
    getAgentCore: () => ({ displayNameKey: 'agents.codex', toolRendering: { hideUnknownToolsByDefault: false } }),
}));

vi.mock('@/sync/domains/models/modelOptions', () => ({
    findModelOptionForEffectiveModelId: (options: any, effectiveModelId: any) =>
        options?.find?.((option: any) => option.value === effectiveModelId)
            ?? options?.find?.((option: any) => option.value === String(effectiveModelId ?? '').replace(/\[[^\]]*\]$/u, ''))
            ?? null,
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
        multiTextInputRenderCount.value += 1;
        React.useImperativeHandle(ref, () => ({
            setTextAndSelection: (
                text: string,
                selection: MultiTextInputSelection,
            ) => {
                multiTextInputHandleMocks.setTextAndSelection(text, selection);
                const onChangeText = props.onChangeText as ((value: string) => void) | undefined;
                const onStateChange = props.onStateChange as ((state: MultiTextInputState) => void) | undefined;
                onChangeText?.(text);
                onStateChange?.({ text, selection });
            },
            focus: multiTextInputHandleMocks.focus,
            blur: multiTextInputHandleMocks.blur,
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
    useActiveSuggestions: useActiveSuggestionsMock,
}));

vi.mock('@/components/autocomplete/applySuggestion', () => ({
    applySuggestion: (text: string) => ({ text, cursorPosition: text.length }),
}));

vi.mock('@/components/ui/popover', () => ({
    Popover: () => null,
    PopoverScope: ({ children }: any) => React.createElement(React.Fragment, null, children),
    MODAL_AWARE_FLOATING_POPOVER_PORTAL_OPTIONS: {},
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

/** Stands in for a host that owns the field's top-right corner (§2.3). */
function HostFieldAccessory() {
    return React.createElement('View', { testID: 'host-field-accessory' });
}

describe('AgentInput (send button accessibility)', () => {
    afterEach(() => {
        translateOverride.fn = null;
        featureEnabledState.voice = true;
        dictationState.status = 'idle';
        dictationState.failure = null;
        vi.clearAllMocks();
    });

    it('does not request autocomplete suggestions before focus, then follows focused text state', async () => {
        const { AgentInput } = await import('./AgentInput');
        const autocompleteSuggestions = vi.fn(async () => []);

        const screen = await renderScreen(<AgentInput
            sessionId="session-1"
            value="@src"
            placeholder="Type"
            onChangeText={() => {}}
            onSend={() => {}}
            autocompleteKinds={['file', 'vendorPlugin']}
            autocompleteSuggestions={autocompleteSuggestions}
        />);

        expect(useActiveSuggestionsMock).toHaveBeenLastCalledWith(
            null,
            autocompleteSuggestions,
            expect.objectContaining({ wrapAround: true }),
        );

        const input = screen.root.findByType('MultiTextInput' as any);
        expect(input.props.accessibilityRole).toBe('combobox');
        expect(input.props.accessibilityState).toEqual({ expanded: false });
        expect(input.props['aria-controls']).toBe('agent-input-command-menu:list:listbox');
        expect(input.props['aria-activedescendant']).toBeUndefined();
        await act(async () => {
            input.props.onFocus?.();
        });

        expect(useActiveSuggestionsMock).toHaveBeenLastCalledWith(
            '@src',
            autocompleteSuggestions,
            expect.objectContaining({ wrapAround: true }),
        );

        await act(async () => {
            input.props.onStateChange?.({ text: '@/src', selection: { start: 5, end: 5 } });
        });

        expect(useActiveSuggestionsMock).toHaveBeenLastCalledWith(
            '@/src',
            autocompleteSuggestions,
            expect.objectContaining({ wrapAround: true }),
        );

        await act(async () => {
            input.props.onChangeText?.('@/src');
            input.props.onStateChange?.({ text: '@/src', selection: { start: 5, end: 5 } });
        });

        expect(useActiveSuggestionsMock).toHaveBeenLastCalledWith(
            '@/src',
            autocompleteSuggestions,
            expect.objectContaining({ wrapAround: true }),
        );

        await screen.unmount();
    });

    it('publishes one real combobox relationship for the active suggestion identity', async () => {
        useActiveSuggestionsMock.mockReturnValueOnce([
            [
                { kind: 'slashCommand', key: 'goal', text: '/goal' },
                { kind: 'slashCommand', key: 'help', text: '/help' },
            ],
            1,
            () => {},
            () => {},
        ] as const);
        const { AgentInput } = await import('./AgentInput');

        const screen = await renderScreen(<AgentInput
            sessionId="session-1"
            value="/h"
            placeholder="Type"
            onChangeText={() => {}}
            onSend={() => {}}
            autocompleteKinds={['slashCommand']}
            autocompleteSuggestions={async () => []}
        />);

        const input = screen.root.findByType('MultiTextInput' as any);
        expect(input.props.accessibilityRole).toBe('combobox');
        expect(input.props.accessibilityState).toEqual({ expanded: true });
        expect(input.props['aria-haspopup']).toBe('listbox');
        expect(input.props['aria-autocomplete']).toBe('list');
        expect(input.props['aria-controls']).toBe('agent-input-command-menu:list:listbox');
        expect(input.props['aria-activedescendant']).toBe(
            'agent-input-command-menu:list:command-menu-root:option:slashCommand:help',
        );

        await screen.unmount();
    });

    it('keeps a mounted attachment surface update local to its subtree', async () => {
        let publishSurfaceRevision: ((revision: number) => void) | null = null;
        function DynamicAttachmentSurface() {
            const [revision, setRevision] = React.useState(0);
            publishSurfaceRevision = setRevision;
            return React.createElement(
                'Text',
                { testID: 'dynamic-attachment-surface' },
                'Surface revision ',
                revision,
            );
        }
        const attachmentRowItems = [{
            kind: 'surface',
            key: 'dynamic-surface',
            label: 'Dynamic surface',
            sizing: 'content',
            renderedContent: <DynamicAttachmentSurface />,
        }] satisfies readonly AgentInputAttachmentsRowItem[];
        const { AgentInput } = await import('./AgentInput');
        multiTextInputRenderCount.value = 0;

        const screen = await renderScreen(<AgentInput
            sessionId="session-1"
            value="draft text"
            placeholder="Type"
            onChangeText={() => {}}
            onSend={() => {}}
            autocompleteKinds={[]}
            autocompleteSuggestions={async () => []}
            attachmentRowItems={attachmentRowItems}
        />);
        const inputRendersBeforeSurfaceUpdate = multiTextInputRenderCount.value;

        await act(async () => {
            publishSurfaceRevision?.(1);
        });

        expect(screen.findByTestId('dynamic-attachment-surface')?.props.children).toEqual([
            'Surface revision ',
            1,
        ]);
        expect(multiTextInputRenderCount.value).toBe(inputRendersBeforeSurfaceUpdate);
        await screen.unmount();
    });

    it('names the armed Agent switch on the control that commits it', async () => {
        // Pressing send with a target armed does not only send: it stops the
        // current runtime and continues this Session with that Agent. The words
        // live on the send control, at the moment of consequence, and they live
        // there whether or not the Agent's mark is drawn — a glyph reads as
        // nothing to a screen reader.
        const { AgentInput } = await import('./AgentInput');

        const screen = await renderScreen(<AgentInput
                    sessionId="session-1"
                    value="ship it"
                    placeholder="Type"
                    onChangeText={() => {}}
                    onSend={() => {}}
                    armedContinuationTarget={{ agentId: 'codex', label: 'Codex' }}
                    autocompleteKinds={[]}
                    autocompleteSuggestions={async () => []}
                />);

        const send = screen.findByTestId('session-composer-send');
        if (!send) throw new Error('session-composer-send not found');
        // `t` is stubbed to its key here; the rendered words are asserted against
        // the real catalog in agentContinuationSubmitPresentation.test.ts.
        expect(send.props.accessibilityLabel).toBe('session.agentContinuation.sendLabel');

        await screen.unmount();
    });

    it('keeps the ordinary send name when no Agent switch is armed', async () => {
        const { AgentInput } = await import('./AgentInput');

        const screen = await renderScreen(<AgentInput
                    sessionId="session-1"
                    value="ship it"
                    placeholder="Type"
                    onChangeText={() => {}}
                    onSend={() => {}}
                    autocompleteKinds={[]}
                    autocompleteSuggestions={async () => []}
                />);

        const send = screen.findByTestId('session-composer-send');
        if (!send) throw new Error('session-composer-send not found');
        expect(send.props.accessibilityLabel).toBe('common.send');

        await screen.unmount();
    });

    it('draws every armed Agent\u2019s own mark, with no per-Agent exception', async () => {
        // A mixed treatment would silently rank Agents as recognisable or not.
        // The reader has just seen this exact mark beside the Agent’s name in
        // the rail, so it is never met cold.
        const { AgentInput } = await import('./AgentInput');

        const screen = await renderScreen(<AgentInput
                    sessionId="session-1"
                    value="ship it"
                    placeholder="Type"
                    onChangeText={() => {}}
                    onSend={() => {}}
                    armedContinuationTarget={{ agentId: 'kimi', label: 'Kimi' }}
                    autocompleteKinds={[]}
                    autocompleteSuggestions={async () => []}
                />);

        const send = screen.findByTestId('session-composer-send');
        if (!send) throw new Error('session-composer-send not found');
        expect(send.props.accessibilityLabel).toBe('session.agentContinuation.sendLabel');
        const marks = send.findAllByType('AgentIcon' as any);
        expect(marks.map((node) => node.props?.agentId)).toEqual(['kimi']);
        expect(send.findAllByType('Icon' as any).some((node) => node.props?.name === 'arrow-up'))
            .toBe(false);

        await screen.unmount();
    });

    it('becomes a button that names the switch, not a circle with a glyph in it', async () => {
        // The armed control is the app's standard rounded button growing around its
        // logo and label, not a bespoke pill: it renders the words as well as the
        // mark, so the consequence is legible without a screen reader.
        const { AgentInput } = await import('./AgentInput');

        const screen = await renderScreen(<AgentInput
                    sessionId="session-1"
                    value="ship it"
                    placeholder="Type"
                    onChangeText={() => {}}
                    onSend={() => {}}
                    armedContinuationTarget={{ agentId: 'codex', label: 'Codex' }}
                    autocompleteKinds={[]}
                    autocompleteSuggestions={async () => []}
                />);

        const send = screen.findByTestId('session-composer-send');
        if (!send) throw new Error('session-composer-send not found');
        const texts = send.findAllByType('Text' as any)
            .flatMap((node) => (typeof node.props?.children === 'string' ? [node.props.children] : []));
        expect(texts).toContain('session.agentContinuation.sendLabel');
        expect(send.findAllByType('AgentIcon' as any).map((node) => node.props?.agentId)).toEqual(['codex']);

        await screen.unmount();
    });

    it('closes the armed label with the mark instead of spelling the Agent after it', async () => {
        // "Continue with [mark]", not "[mark] Continue with Claude". The mark
        // stands where the sentence names the Agent, so the identity is carried
        // once — by the logo — and the button stays as narrow as the switch is.
        const { AgentInput } = await import('./AgentInput');

        const screen = await renderScreen(<AgentInput
                    sessionId="session-1"
                    value="ship it"
                    placeholder="Type"
                    onChangeText={() => {}}
                    onSend={() => {}}
                    armedContinuationTarget={{ agentId: 'codex', label: 'Codex' }}
                    autocompleteKinds={[]}
                    autocompleteSuggestions={async () => []}
                />);

        const send = screen.findByTestId('session-composer-send');
        if (!send) throw new Error('session-composer-send not found');
        // The spoken sentence still names the Agent in words — a glyph reads as
        // nothing to a screen reader, and this press commits an Agent switch.
        expect(send.props.accessibilityLabel).toBe('session.agentContinuation.sendLabel');
        // English closes with the Agent, so the mark follows the words.
        const hostType = (node: { type: unknown }) => String(node.type);
        const drawnOrder = send.findAll(
            (node) => hostType(node) === 'AgentIcon'
                || (hostType(node) === 'Text' && typeof node.props?.children === 'string'),
        );
        expect(drawnOrder.map(hostType)).toEqual(['Text', 'AgentIcon']);

        await screen.unmount();
    });

    it('opens the armed label with the mark in a language that opens with the Agent', async () => {
        // Japanese is "{Agent} で続ける" — the name leads, so the mark that
        // stands in for it must lead too. Pinned to the trailing slot this reads
        // as broken grammar, and with only the English case above the placement
        // logic could be replaced by the constant 'trailing' and stay green.
        translateOverride.fn = (key, params) => (
            key === 'session.agentContinuation.sendLabel'
                ? `${String(params?.agent ?? '')} \u3067\u7d9a\u3051\u308b`
                : key
        );
        const { AgentInput } = await import('./AgentInput');

        const screen = await renderScreen(<AgentInput
                    sessionId="session-1"
                    value="ship it"
                    placeholder="Type"
                    onChangeText={() => {}}
                    onSend={() => {}}
                    armedContinuationTarget={{ agentId: 'codex', label: 'Codex' }}
                    autocompleteKinds={[]}
                    autocompleteSuggestions={async () => []}
                />);

        const send = screen.findByTestId('session-composer-send');
        if (!send) throw new Error('session-composer-send not found');
        expect(send.props.accessibilityLabel).toBe('Codex \u3067\u7d9a\u3051\u308b');
        const hostType = (node: { type: unknown }) => String(node.type);
        const drawnOrder = send.findAll(
            (node) => hostType(node) === 'AgentIcon'
                || (hostType(node) === 'Text' && typeof node.props?.children === 'string'),
        );
        expect(drawnOrder.map(hostType)).toEqual(['AgentIcon', 'Text']);
        // The name is lifted out of the drawn words — the mark carries it.
        expect(drawnOrder
            .flatMap((node) => (typeof node.props?.children === 'string' ? [node.props.children] : [])))
            .toEqual(['\u3067\u7d9a\u3051\u308b']);

        await screen.unmount();
    });

    it('names the armed switch on an untouched composer, and leaves the press inert', async () => {
        // Arming IS the confirmation. The control the reader is about to press
        // reports which Agent it would continue with from the moment the rail is
        // used — requiring a keystroke first reinstates a confirm step made of
        // typing. What an empty composer withholds is the PRESS, not the name: the
        // same inert send it has always been, now saying what pressing it does.
        const { AgentInput } = await import('./AgentInput');
        const onSend = vi.fn();

        const screen = await renderScreen(<AgentInput
                    sessionId="session-1"
                    value=""
                    placeholder="Type"
                    onChangeText={() => {}}
                    onSend={onSend}
                    armedContinuationTarget={{ agentId: 'codex', label: 'Codex' }}
                    autocompleteKinds={[]}
                    autocompleteSuggestions={async () => []}
                />);

        const send = screen.findByTestId('session-composer-send');
        if (!send) throw new Error('session-composer-send not found');
        expect(send.props.accessibilityLabel).toBe('session.agentContinuation.sendLabel');
        expect(send.findAllByType('AgentIcon' as any).map((node) => node.props?.agentId)).toEqual(['codex']);
        // Inert, exactly as the empty composer's send has always been — and it
        // still explains why, the way the circular send does.
        expect(send.props.disabled).toBe(true);
        expect(send.props.accessibilityState?.disabled).toBe(true);
        expect(send.props.accessibilityHint).toBe('session.inputPlaceholder');

        await screen.pressByTestIdAsync('session-composer-send');
        expect(onSend).not.toHaveBeenCalled();

        await screen.unmount();
    });

    it('leaves the empty-composer Stop saying Stop, and stopping when pressed', async () => {
        // The name follows the arm, but only onto the control the arm would use. A
        // running turn takes this button for Stop, and "Continue with Codex" on it
        // would name a switch that press aborts instead of taking.
        featureEnabledState.voice = false;
        const { AgentInput } = await import('./AgentInput');
        const onAbort = vi.fn();
        const onSend = vi.fn();

        const screen = await renderScreen(<AgentInput
                    sessionId="session-1"
                    value=""
                    placeholder="Type"
                    onChangeText={() => {}}
                    onSend={onSend}
                    onAbort={onAbort}
                    showAbortButton={true}
                    armedContinuationTarget={{ agentId: 'codex', label: 'Codex' }}
                    autocompleteKinds={[]}
                    autocompleteSuggestions={async () => []}
                />);

        const send = screen.findByTestId('session-composer-send');
        if (!send) throw new Error('session-composer-send not found');
        expect(send.props.accessibilityLabel).toBe('agentInput.stopCodingTurn');
        expect(send.findAllByType('AgentIcon' as any).length).toBe(0);

        await screen.pressByTestIdAsync('session-composer-send');
        expect(onAbort).toHaveBeenCalledTimes(1);
        expect(onSend).not.toHaveBeenCalled();

        await screen.unmount();
    });

    it('names the armed engine on the chip before anything has been typed', async () => {
        // Selection IS the arming: there is no confirm step, so the chip reports the
        // choice the moment the rail is used. Requiring a keystroke first reinstates
        // a confirm step made of typing — the reader picks another Agent, the rail
        // ticks it, and the composer goes on naming the one that is running.
        //
        // The send control answers the same question here — it is still the send,
        // just an inert one — so it names the same Agent. Only Dictation or Stop
        // taking the button changes that answer.
        const { AgentInput } = await import('./AgentInput');

        const screen = await renderScreen(<AgentInput
                    sessionId="session-1"
                    value=""
                    placeholder="Type"
                    onChangeText={() => {}}
                    onSend={() => {}}
                    agentType="codex"
                    onAgentClick={() => {}}
                    armedContinuationTarget={{ agentId: 'claude', label: 'Claude', modelLabel: 'Sonnet 4.6' }}
                    autocompleteKinds={[]}
                    autocompleteSuggestions={async () => []}
                />);

        const chip = screen.findByTestId('agent-input-agent-chip');
        if (!chip) throw new Error('agent-input-agent-chip not found');
        expect(chip.findAllByType('AgentIcon' as any).map((node) => node.props?.agentId)).toEqual(['claude']);
        expect(chip.findAllByType('Text' as any)
            .flatMap((node) => (typeof node.props?.children === 'string' ? [node.props.children] : [])))
            .toContain('Sonnet 4.6');
        expect(screen.findByTestId('session-composer-send')?.props.accessibilityLabel)
            .toBe('session.agentContinuation.sendLabel');

        await screen.unmount();
    });

    it('names the armed engine and model on the chip, and agrees with the send control', async () => {
        // Selection IS the selection. A picker showing a checkmark on Sonnet 4.6
        // while the chip still read GPT 5.6 Sol was telling the reader two different
        // things about one decision.
        const { AgentInput } = await import('./AgentInput');

        const screen = await renderScreen(<AgentInput
                    sessionId="session-1"
                    value="ship it"
                    placeholder="Type"
                    onChangeText={() => {}}
                    onSend={() => {}}
                    agentType="codex"
                    onAgentClick={() => {}}
                    armedContinuationTarget={{ agentId: 'claude', label: 'Claude', modelLabel: 'Sonnet 4.6' }}
                    autocompleteKinds={[]}
                    autocompleteSuggestions={async () => []}
                />);

        const chip = screen.findByTestId('agent-input-agent-chip');
        if (!chip) throw new Error('agent-input-agent-chip not found');
        expect(chip.findAllByType('AgentIcon' as any).map((node) => node.props?.agentId)).toEqual(['claude']);
        expect(chip.findAllByType('Text' as any)
            .flatMap((node) => (typeof node.props?.children === 'string' ? [node.props.children] : [])))
            .toContain('Sonnet 4.6');
        // The pair must hold: a chip claiming an armed target while the button does
        // not announce it would be the same contradiction in the other direction.
        expect(screen.findByTestId('session-composer-send')?.props.accessibilityLabel)
            .toBe('session.agentContinuation.sendLabel');

        await screen.unmount();
    });

    it('names the armed Agent while it is still on that Agent\u2019s own model settings', async () => {
        const { AgentInput } = await import('./AgentInput');

        const screen = await renderScreen(<AgentInput
                    sessionId="session-1"
                    value="ship it"
                    placeholder="Type"
                    onChangeText={() => {}}
                    onSend={() => {}}
                    agentType="codex"
                    onAgentClick={() => {}}
                    armedContinuationTarget={{ agentId: 'claude', label: 'Claude', modelLabel: null }}
                    autocompleteKinds={[]}
                    autocompleteSuggestions={async () => []}
                />);

        const chip = screen.findByTestId('agent-input-agent-chip');
        expect(chip?.findAllByType('Text' as any)
            .flatMap((node) => (typeof node.props?.children === 'string' ? [node.props.children] : [])))
            .toContain('Claude');

        await screen.unmount();
    });

    it('returns the chip to the running engine when the switch is disarmed', async () => {
        const { AgentInput } = await import('./AgentInput');

        const screen = await renderScreen(<AgentInput
                    sessionId="session-1"
                    value="ship it"
                    placeholder="Type"
                    onChangeText={() => {}}
                    onSend={() => {}}
                    agentType="codex"
                    onAgentClick={() => {}}
                    armedContinuationTarget={null}
                    autocompleteKinds={[]}
                    autocompleteSuggestions={async () => []}
                />);

        const chip = screen.findByTestId('agent-input-agent-chip');
        if (!chip) throw new Error('agent-input-agent-chip not found');
        expect(chip.findAllByType('AgentIcon' as any).map((node) => node.props?.agentId)).toEqual(['codex']);
        const labels = chip.findAllByType('Text' as any)
            .flatMap((node) => (typeof node.props?.children === 'string' ? [node.props.children] : []));
        expect(labels).not.toContain('Sonnet 4.6');
        expect(labels).not.toContain('Claude');

        await screen.unmount();
    });

    it('hides the voice icon when voice is disabled (no text)', async () => {
        featureEnabledState.voice = false;
        const { AgentInput } = await import('./AgentInput');

        const screen = await renderScreen(<AgentInput
                    sessionId="session-1"
                    value=""
                    placeholder="Type"
                    onChangeText={() => {}}
                    onSend={() => {}}
                    autocompleteKinds={[]}
                    autocompleteSuggestions={async () => []}
                />);

        const send = screen.findByTestId('session-composer-send');
        expect(send).toBeTruthy();
        if (!send) throw new Error('session-composer-send not found');

        const images = send.findAllByType('Image' as any);
        expect(images.length).toBe(0);

        const octicons = send.findAllByType('Icon' as any);
        expect(octicons.some((n) => n.props?.name === 'arrow-up')).toBe(true);

        await screen.unmount();
    });

    it('shows a stop icon when the session can be aborted and the composer is empty', async () => {
        featureEnabledState.voice = false;
        const { AgentInput } = await import('./AgentInput');

        const screen = await renderScreen(<AgentInput
                    sessionId="session-1"
                    value=""
                    placeholder="Type"
                    onChangeText={() => {}}
                    onSend={() => {}}
                    onAbort={() => {}}
                    showAbortButton={true}
                    autocompleteKinds={[]}
                    autocompleteSuggestions={async () => []}
                />);

        const send = screen.findByTestId('session-composer-send');
        expect(send).toBeTruthy();
        if (!send) throw new Error('session-composer-send not found');

        // Both icon families now render as a single `Icon` type, so the original
        // pair of family-scoped queries collapsed into one. Asserting the same
        // query is both true and false for 'stop' is unsatisfiable — what the
        // test actually guarantees is that the button shows Stop and does NOT
        // still offer Send.
        const icons = send.findAllByType('Icon' as any);
        expect(icons.some((n) => n.props?.name === 'stop')).toBe(true);
        expect(icons.some((n) => n.props?.name === 'arrow-up')).toBe(false);
        expect(send.props.accessibilityLabel).toBe('agentInput.stopCodingTurn');

        await screen.unmount();
    });

    it('runs abort from the empty composer stop button', async () => {
        featureEnabledState.voice = false;
        const { AgentInput } = await import('./AgentInput');
        const onAbort = vi.fn();
        const onSend = vi.fn();

        const screen = await renderScreen(<AgentInput
                    sessionId="session-1"
                    value=""
                    placeholder="Type"
                    onChangeText={() => {}}
                    onSend={onSend}
                    onAbort={onAbort}
                    showAbortButton={true}
                    autocompleteKinds={[]}
                    autocompleteSuggestions={async () => []}
                />);

        const send = screen.findByTestId('session-composer-send');
        expect(send).toBeTruthy();
        if (!send) throw new Error('session-composer-send not found');
        expect(send.props.accessibilityState?.disabled).toBe(false);

        await screen.pressByTestIdAsync('session-composer-send');

        expect(onAbort).toHaveBeenCalledTimes(1);
        expect(onSend).not.toHaveBeenCalled();

        await screen.unmount();
    });

    it('sets an accessible label for session creation context (no sessionId)', async () => {
        const { AgentInput } = await import('./AgentInput');

        const screen = await renderScreen(<AgentInput
                    value="hello"
                    placeholder="Type"
                    onChangeText={() => {}}
                    onSend={() => {}}
                    autocompleteKinds={[]}
                    autocompleteSuggestions={async () => []}
                />);

        const send = screen.findByTestId('new-session-composer-send');
        expect(send).toBeTruthy();
        if (!send) throw new Error('new-session-composer-send not found');
        expect(send.props.accessibilityRole).toBe('button');
        expect(send.props.accessibilityLabel).toBe('newSession.title');
        await screen.unmount();
    });

    it('prefers an explicit submit accessibility label override when provided', async () => {
        const { AgentInput } = await import('./AgentInput');

        const screen = await renderScreen(<AgentInput
                    value="hello"
                    placeholder="Type"
                    onChangeText={() => {}}
                    onSend={() => {}}
                    submitAccessibilityLabel="automations.create.createButtonTitle"
                    autocompleteKinds={[]}
                    autocompleteSuggestions={async () => []}
                />);

        const send = screen.findByTestId('new-session-composer-send');
        expect(send).toBeTruthy();
        if (!send) throw new Error('new-session-composer-send not found');
        expect(send.props.accessibilityRole).toBe('button');
        expect(send.props.accessibilityLabel).toBe('automations.create.createButtonTitle');
        await screen.unmount();
    });

    it('sets an accessibility hint when send is disabled because input is empty (no sessionId, no mic)', async () => {
        const { AgentInput } = await import('./AgentInput');

        const screen = await renderScreen(<AgentInput
                    value=""
                    placeholder="Type"
                    onChangeText={() => {}}
                    onSend={() => {}}
                    autocompleteKinds={[]}
                    autocompleteSuggestions={async () => []}
                />);

        const send = screen.findByTestId('new-session-composer-send');
        expect(send).toBeTruthy();
        if (!send) throw new Error('new-session-composer-send not found');
        expect(send.props.accessibilityHint).toBe('session.inputPlaceholder');
        await screen.unmount();
    });

    it('does not set the empty-input accessibility hint when there is sendable auxiliary content', async () => {
        const { AgentInput } = await import('./AgentInput');
        const onSend = vi.fn();

        const screen = await renderScreen(<AgentInput
                    sessionId="session-1"
                    value=""
                    placeholder="Type"
                    onChangeText={() => {}}
                    onSend={onSend}
                    hasSendableAttachments={true}
                    autocompleteKinds={[]}
                    autocompleteSuggestions={async () => []}
                />);

        const send = screen.findByTestId('session-composer-send');
        expect(send).toBeTruthy();
        if (!send) throw new Error('session-composer-send not found');
        expect(send.props.accessibilityHint).toBeUndefined();

        await screen.pressByTestIdAsync('session-composer-send');
        expect(onSend).toHaveBeenCalledTimes(1);

        await screen.unmount();
    });

    it('uses the latest onSend callback after rerendering', async () => {
        const { AgentInput } = await import('./AgentInput');
        const firstOnSend = vi.fn();
        const secondOnSend = vi.fn();

        const screen = await renderScreen(<AgentInput
                    sessionId="session-1"
                    value="hello"
                    placeholder="Type"
                    onChangeText={() => {}}
                    onSend={firstOnSend}
                    autocompleteKinds={[]}
                    autocompleteSuggestions={async () => []}
                />);

        await screen.update(
            <AgentInput
                sessionId="session-1"
                value="hello"
                placeholder="Type"
                onChangeText={() => {}}
                onSend={secondOnSend}
                autocompleteKinds={[]}
                autocompleteSuggestions={async () => []}
            />,
        );

        await screen.pressByTestIdAsync('session-composer-send');

        expect(firstOnSend).not.toHaveBeenCalled();
        expect(secondOnSend).toHaveBeenCalledTimes(1);

        await screen.unmount();
    });

    it('uses the session creation label when value is empty (no sessionId, no mic)', async () => {
        const { AgentInput } = await import('./AgentInput');

        const screen = await renderScreen(<AgentInput
                    value=""
                    placeholder="Type"
                    onChangeText={() => {}}
                    onSend={() => {}}
                    autocompleteKinds={[]}
                    autocompleteSuggestions={async () => []}
                />);

        const send = screen.findByTestId('new-session-composer-send');
        expect(send).toBeTruthy();
        if (!send) throw new Error('new-session-composer-send not found');
        expect(send.props.accessibilityRole).toBe('button');
        expect(send.props.accessibilityLabel).toBe('newSession.title');
        await screen.unmount();
    });

    it('sets an accessible label for message sending context (sessionId present)', async () => {
        const { AgentInput } = await import('./AgentInput');

        const screen = await renderScreen(<AgentInput
                    sessionId="session-1"
                    value="hello"
                    placeholder="Type"
                    onChangeText={() => {}}
                    onSend={() => {}}
                    autocompleteKinds={[]}
                    autocompleteSuggestions={async () => []}
                />);

        const send = screen.findByTestId('session-composer-send');
        expect(send).toBeTruthy();
        if (!send) throw new Error('session-composer-send not found');
        expect(send.props.accessibilityRole).toBe('button');
        expect(send.props.accessibilityLabel).toBe('common.send');
        await screen.unmount();
    });

    it('keeps the voice icon visible while mic is enabled and inactive (no text)', async () => {
        const { AgentInput } = await import('./AgentInput');

        const screen = await renderScreen(<AgentInput
                    sessionId="session-1"
                    value=""
                    placeholder="Type"
                    onChangeText={() => {}}
                    onSend={() => {}}
                    // §2.3: a composer that owns the field's top-right corner moves
                    // dictation into it. This one hands the corner to the host, which is
                    // what keeps the microphone on the submit button.
                    fieldAccessory={<HostFieldAccessory />}
                    autocompleteKinds={[]}
                    autocompleteSuggestions={async () => []}
                />);

        const send = screen.findByTestId('session-composer-send');
        expect(send).toBeTruthy();
        if (!send) throw new Error('session-composer-send not found');
        const images = send.findAllByType('Image' as any);
        expect(images.length).toBe(1);

        const octicons = send.findAllByType('Icon' as any);
        expect(octicons.some((n) => n.props?.name === 'arrow-up')).toBe(false);

        await screen.unmount();
    });

    it('shows a stop control while mic is enabled and active (no text)', async () => {
        const { AgentInput } = await import('./AgentInput');
        dictationState.status = 'listening';

        const screen = await renderScreen(<AgentInput
                    sessionId="session-1"
                    value=""
                    placeholder="Type"
                    onChangeText={() => {}}
                    onSend={() => {}}
                    // §2.3: a composer that owns the field's top-right corner moves
                    // dictation into it. This one hands the corner to the host, which is
                    // what keeps the microphone on the submit button.
                    fieldAccessory={<HostFieldAccessory />}
                    autocompleteKinds={[]}
                    autocompleteSuggestions={async () => []}
                />);

        const send = screen.findByTestId('session-composer-send');
        expect(send).toBeTruthy();
        if (!send) throw new Error('session-composer-send not found');
        const images = send.findAllByType('Image' as any);
        expect(images.length).toBe(0);

        const ionicons = send.findAllByType('Icon' as any);
        expect(ionicons.some((n) => n.props?.name === 'stop-circle')).toBe(true);

        const octicons = send.findAllByType('Icon' as any);
        expect(octicons.some((n) => n.props?.name === 'arrow-up')).toBe(false);

        await screen.unmount();
    });

    it('inserts one dictated utterance at the live selection without sending or starting conversational Voice', async () => {
        const { AgentInput } = await import('./AgentInput');
        const onChangeText = vi.fn();
        const onSend = vi.fn();
        dictationState.toggle
            .mockResolvedValueOnce({ kind: 'started' })
            .mockResolvedValueOnce({ kind: 'completed', text: 'dictated' });

        const screen = await renderScreen(<AgentInput
            sessionId="session-1"
            value=""
            placeholder="Type"
            onChangeText={onChangeText}
            onSend={onSend}
            autocompleteKinds={[]}
            autocompleteSuggestions={async () => []}
        />);
        await screen.pressByTestIdAsync('agent-input-dictation');
        dictationState.status = 'listening';
        await screen.update(<AgentInput
            sessionId="session-1"
            value="before selected after"
            placeholder="Type"
            onChangeText={onChangeText}
            onSend={onSend}
            autocompleteKinds={[]}
            autocompleteSuggestions={async () => []}
        />);
        const input = screen.root.findByType('MultiTextInput' as any);

        await act(async () => {
            input.props.onStateChange?.({
                text: 'before selected after',
                selection: { start: 7, end: 15 },
            });
        });
        await screen.pressByTestIdAsync('agent-input-dictation');

        expect(dictationState.toggle).toHaveBeenCalledTimes(2);
        expect(multiTextInputHandleMocks.setTextAndSelection).toHaveBeenLastCalledWith(
            'before dictated after',
            { start: 15, end: 15 },
        );
        expect(multiTextInputHandleMocks.focus).toHaveBeenCalled();
        expect(onChangeText).toHaveBeenLastCalledWith('before dictated after');
        expect(onSend).not.toHaveBeenCalled();

        await screen.unmount();
    });

    it('reports a completed Dictation attempt when no speech was detected', async () => {
        const { AgentInput } = await import('./AgentInput');
        dictationState.status = 'listening';
        dictationState.toggle.mockResolvedValueOnce({ kind: 'completed', text: null });

        const screen = await renderScreen(<AgentInput
            sessionId="session-1"
            value="existing"
            placeholder="Type"
            onChangeText={() => {}}
            onSend={() => {}}
            autocompleteKinds={[]}
            autocompleteSuggestions={async () => []}
        />);
        await screen.pressByTestIdAsync('agent-input-dictation');

        expect(modalAlertMock).toHaveBeenCalledWith('voiceAssistant.dictationNoSpeech');
        expect(multiTextInputHandleMocks.setTextAndSelection).not.toHaveBeenCalled();

        await screen.unmount();
    });

    it('does not stack a generic Dictation alert over the microphone permission prompt', async () => {
        const { AgentInput } = await import('./AgentInput');
        dictationState.toggle.mockRejectedValueOnce(new Error('mic_permission_denied'));

        const screen = await renderScreen(<AgentInput
            sessionId="session-1"
            value=""
            placeholder="Type"
            onChangeText={() => {}}
            onSend={() => {}}
            autocompleteKinds={[]}
            autocompleteSuggestions={async () => []}
        />);
        await screen.pressByTestIdAsync('agent-input-dictation');

        expect(modalAlertMock).not.toHaveBeenCalled();

        await screen.unmount();
    });

    it('explains that conversational Voice must end before Dictation can start', async () => {
        const { AgentInput } = await import('./AgentInput');
        dictationState.toggle.mockRejectedValueOnce(
            new VoiceCaptureBusyError('conversation'),
        );

        const screen = await renderScreen(<AgentInput
            sessionId="session-1"
            value=""
            placeholder="Type"
            onChangeText={() => {}}
            onSend={() => {}}
            autocompleteKinds={[]}
            autocompleteSuggestions={async () => []}
        />);
        await screen.pressByTestIdAsync('agent-input-dictation');

        expect(modalAlertMock).toHaveBeenCalledWith(
            'common.error',
            'voiceAssistant.dictationErrors.microphoneOwnedByVoice',
        );

        await screen.unmount();
    });

    it('presents and consumes an asynchronous Dictation capture failure', async () => {
        const { AgentInput } = await import('./AgentInput');
        dictationState.failure = {
            id: 7,
            sessionId: 'session-1',
            kind: 'provider_error',
            reason: 'capture_duration_exceeded',
        };

        const screen = await renderScreen(<AgentInput
            sessionId="session-1"
            value=""
            placeholder="Type"
            onChangeText={() => {}}
            onSend={() => {}}
            autocompleteKinds={[]}
            autocompleteSuggestions={async () => []}
        />);

        expect(modalAlertMock).toHaveBeenCalledWith(
            'common.error',
            'voiceAssistant.dictationErrors.captureDurationExceeded',
        );
        expect(dictationState.dismissFailure).toHaveBeenCalledWith(7);

        await screen.unmount();
    });

    it('keeps existing-session text visible until send acknowledgement', async () => {
        const { AgentInput } = await import('./AgentInput');

        const onChangeText = vi.fn();
        const onSend = vi.fn();

        const screen = await renderScreen(<AgentInput
            sessionId="session-1"
            value="Hello world"
            placeholder="Type"
            onChangeText={onChangeText}
            onSend={onSend}
            autocompleteKinds={[]}
            autocompleteSuggestions={async () => []}
        />);

        screen.pressByTestId('session-composer-send');

        expect(onSend).toHaveBeenCalledTimes(1);
        expect(onChangeText).not.toHaveBeenCalledWith('');

        await screen.unmount();
    });

    it('does not clear the session composer immediately when sending attachments', async () => {
        const { AgentInput } = await import('./AgentInput');

        const onChangeText = vi.fn();
        const onSend = vi.fn();

        const screen = await renderScreen(<AgentInput
            sessionId="session-1"
            value="Describe this image"
            placeholder="Type"
            onChangeText={onChangeText}
            onSend={onSend}
            hasSendableAttachments={true}
            autocompleteKinds={[]}
            autocompleteSuggestions={async () => []}
        />);

        screen.pressByTestId('session-composer-send');

        expect(onSend).toHaveBeenCalledTimes(1);
        expect(onChangeText).not.toHaveBeenCalledWith('');

        await screen.unmount();
    });

    it('blurs the existing-session composer when sending with text', async () => {
        const { AgentInput } = await import('./AgentInput');

        const screen = await renderScreen(<AgentInput
            sessionId="session-1"
            value="Hello world"
            placeholder="Type"
            onChangeText={() => {}}
            onSend={() => {}}
            autocompleteKinds={[]}
            autocompleteSuggestions={async () => []}
        />);

        screen.pressByTestId('session-composer-send');

        expect(multiTextInputHandleMocks.blur).toHaveBeenCalledTimes(1);

        await screen.unmount();
    });

    it('does not blur the new-session composer when sending with text', async () => {
        const { AgentInput } = await import('./AgentInput');

        const screen = await renderScreen(<AgentInput
            value="Hello world"
            placeholder="Type"
            onChangeText={() => {}}
            onSend={() => {}}
            autocompleteKinds={[]}
            autocompleteSuggestions={async () => []}
        />);

        screen.pressByTestId('new-session-composer-send');

        expect(multiTextInputHandleMocks.blur).not.toHaveBeenCalled();

        await screen.unmount();
    });

    it('does not leave raw string children under non-Text host views on web', async () => {
        const { AgentInput } = await import('./AgentInput');

        const screen = await renderScreen(<AgentInput
                    value=""
                    placeholder="Type"
                    onChangeText={() => {}}
                    onSend={() => {}}
                    autocompleteKinds={[]}
                    autocompleteSuggestions={async () => []}
                    machineName="Machine"
                    currentPath="/tmp/project"
                    permissionMode="default"
                    onPermissionModeChange={() => {}}
                    agentType="codex"
                    onAgentClick={() => {}}
                />);

        expect(collectUnexpectedRawTextNodes(screen.tree.toJSON())).toEqual([]);
        await screen.unmount();
    });
});
