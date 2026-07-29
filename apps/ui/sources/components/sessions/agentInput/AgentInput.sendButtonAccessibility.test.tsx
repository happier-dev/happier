import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectUnexpectedRawTextNodes, renderScreen } from '@/dev/testkit';
import { VoiceCaptureBusyError } from '@/voice/runtime/input/VoiceCaptureAdmissionController';
import { installAgentInputCommonModuleMocks } from './agentInputTestHelpers';

type MultiTextInputSelection = { start: number; end: number };
type MultiTextInputState = { text: string; selection: MultiTextInputSelection };

const multiTextInputHandleMocks = vi.hoisted(() => ({
    blur: vi.fn(),
    focus: vi.fn(),
    setTextAndSelection: vi.fn(),
}));
const useActiveSuggestionsMock = vi.hoisted(() => vi.fn(() => [[], -1, () => {}, () => {}] as const));
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
        return createTextModuleMock({ translate: (key) => key });
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

vi.mock('@/components/autocomplete/useActiveWord', () => ({
    useActiveWord: () => ({ word: '', start: 0, end: 0 }),
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

describe('AgentInput (send button accessibility)', () => {
    afterEach(() => {
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
            autocompletePrefixes={['@']}
            autocompleteSuggestions={autocompleteSuggestions}
        />);

        expect(useActiveSuggestionsMock).toHaveBeenLastCalledWith(
            null,
            autocompleteSuggestions,
            expect.objectContaining({ clampSelection: true, wrapAround: true }),
        );

        const input = screen.root.findByType('MultiTextInput' as any);
        await act(async () => {
            input.props.onFocus?.();
        });

        expect(useActiveSuggestionsMock).toHaveBeenLastCalledWith(
            '@src',
            autocompleteSuggestions,
            expect.objectContaining({ clampSelection: true, wrapAround: true }),
        );

        await act(async () => {
            input.props.onStateChange?.({ text: '@/src', selection: { start: 5, end: 5 } });
        });

        expect(useActiveSuggestionsMock).toHaveBeenLastCalledWith(
            '@/src',
            autocompleteSuggestions,
            expect.objectContaining({ clampSelection: true, wrapAround: true }),
        );

        await act(async () => {
            input.props.onChangeText?.('@/src');
            input.props.onStateChange?.({ text: '@/src', selection: { start: 5, end: 5 } });
        });

        expect(useActiveSuggestionsMock).toHaveBeenLastCalledWith(
            '@/src',
            autocompleteSuggestions,
            expect.objectContaining({ clampSelection: true, wrapAround: true }),
        );

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
                    autocompletePrefixes={[]}
                    autocompleteSuggestions={async () => []}
                />);

        const send = screen.findByTestId('session-composer-send');
        expect(send).toBeTruthy();
        if (!send) throw new Error('session-composer-send not found');

        const images = send.findAllByType('Image' as any);
        expect(images.length).toBe(0);

        const octicons = send.findAllByType('Octicons' as any);
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
                    autocompletePrefixes={[]}
                    autocompleteSuggestions={async () => []}
                />);

        const send = screen.findByTestId('session-composer-send');
        expect(send).toBeTruthy();
        if (!send) throw new Error('session-composer-send not found');

        const ionicons = send.findAllByType('Ionicons' as any);
        expect(ionicons.some((n) => n.props?.name === 'stop')).toBe(true);
        expect(send.props.accessibilityLabel).toBe('agentInput.stopCodingTurn');

        const octicons = send.findAllByType('Octicons' as any);
        expect(octicons.some((n) => n.props?.name === 'stop')).toBe(false);
        expect(octicons.some((n) => n.props?.name === 'arrow-up')).toBe(false);

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
                    autocompletePrefixes={[]}
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
                    autocompletePrefixes={[]}
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
                    autocompletePrefixes={[]}
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
                    autocompletePrefixes={[]}
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
                    autocompletePrefixes={[]}
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
                    autocompletePrefixes={[]}
                    autocompleteSuggestions={async () => []}
                />);

        await screen.update(
            <AgentInput
                sessionId="session-1"
                value="hello"
                placeholder="Type"
                onChangeText={() => {}}
                onSend={secondOnSend}
                autocompletePrefixes={[]}
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
                    autocompletePrefixes={[]}
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
                    autocompletePrefixes={[]}
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
                    autocompletePrefixes={[]}
                    autocompleteSuggestions={async () => []}
                />);

        const send = screen.findByTestId('session-composer-send');
        expect(send).toBeTruthy();
        if (!send) throw new Error('session-composer-send not found');
        const images = send.findAllByType('Image' as any);
        expect(images.length).toBe(1);

        const octicons = send.findAllByType('Octicons' as any);
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
                    autocompletePrefixes={[]}
                    autocompleteSuggestions={async () => []}
                />);

        const send = screen.findByTestId('session-composer-send');
        expect(send).toBeTruthy();
        if (!send) throw new Error('session-composer-send not found');
        const images = send.findAllByType('Image' as any);
        expect(images.length).toBe(0);

        const ionicons = send.findAllByType('Ionicons' as any);
        expect(ionicons.some((n) => n.props?.name === 'stop-circle')).toBe(true);

        const octicons = send.findAllByType('Octicons' as any);
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
            autocompletePrefixes={[]}
            autocompleteSuggestions={async () => []}
        />);
        await screen.pressByTestIdAsync('session-composer-send');
        dictationState.status = 'listening';
        await screen.update(<AgentInput
            sessionId="session-1"
            value="before selected after"
            placeholder="Type"
            onChangeText={onChangeText}
            onSend={onSend}
            autocompletePrefixes={[]}
            autocompleteSuggestions={async () => []}
        />);
        const input = screen.root.findByType('MultiTextInput' as any);

        await act(async () => {
            input.props.onStateChange?.({
                text: 'before selected after',
                selection: { start: 7, end: 15 },
            });
        });
        await screen.pressByTestIdAsync('session-composer-send');

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
            autocompletePrefixes={[]}
            autocompleteSuggestions={async () => []}
        />);
        await screen.pressByTestIdAsync('session-composer-send');

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
            autocompletePrefixes={[]}
            autocompleteSuggestions={async () => []}
        />);
        await screen.pressByTestIdAsync('session-composer-send');

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
            autocompletePrefixes={[]}
            autocompleteSuggestions={async () => []}
        />);
        await screen.pressByTestIdAsync('session-composer-send');

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
            autocompletePrefixes={[]}
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
            autocompletePrefixes={[]}
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
            autocompletePrefixes={[]}
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
            autocompletePrefixes={[]}
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
            autocompletePrefixes={[]}
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
                    autocompletePrefixes={[]}
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
