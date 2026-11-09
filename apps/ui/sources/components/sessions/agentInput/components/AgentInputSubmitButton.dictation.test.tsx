import * as React from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@expo/vector-icons', () => ({
    Ionicons: (props: Record<string, unknown>) => React.createElement('Ionicons', props),
    Octicons: (props: Record<string, unknown>) => React.createElement('Octicons', props),
}));

vi.mock('expo-image', () => ({
    Image: (props: Record<string, unknown>) => React.createElement('Image', props),
}));

// The canonical boundary mocks. The hand-rolled `{ Platform: { OS: 'web' } }`
// this file used to carry had no `Platform.select`, and the first theme profile
// reached through `RoundButton` threw on it — every case in the file failed
// before it asserted anything.
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
            React.createElement('View', props, props.children),
        Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
            React.createElement('Text', props, props.children),
        Pressable: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
            React.createElement('Pressable', props, props.children),
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

// The mark reaches the generated Agent catalog, which this component harness does
// not install. Stubbing it keeps the subject's own contract — which mark, in
// which slot — the thing under test.
vi.mock('@/agents/registry/AgentIcon', () => ({
    AgentIcon: (props: Record<string, unknown>) => React.createElement('AgentIcon', props),
}));

/**
 * Both submit shapes are held at their prop boundary here, so this file tests the
 * ONE thing it owns: which shape the button becomes and what it hands that shape.
 * How the pill then draws a mark and forwards a hint is the primitive's contract,
 * asserted against the real `RoundButton` in
 * `AgentInput.sendButtonAccessibility.test.tsx`.
 */
vi.mock('@/components/ui/buttons/RoundButton', () => ({
    RoundButton: (props: Record<string, unknown>) => React.createElement('RoundButton', props),
}));

// The armed route's cancel is the shared plain icon button; held at its prop boundary like the shapes.
vi.mock('@/components/ui/buttons/IconButton', () => ({
    IconButton: (props: Record<string, unknown>) => React.createElement('IconButton', props),
}));

vi.mock('@/components/ui/buttons/PrimaryCircleIconButton', () => ({
    PrimaryCircleIconButton: (
        props: Record<string, unknown> & { children?: React.ReactNode | ((foreground: string) => React.ReactNode) },
    // The circle hands its glyph the ink of its fill; the stand-in passes a fixed one.
    ) => React.createElement('PrimaryCircleIconButton', props, typeof props.children === 'function' ? props.children('#ffffff') : props.children),
}));

vi.mock('@/components/ui/theme/haptics', () => ({
    hapticsLight: () => {},
}));

/**
 * Keys by default, so assertions stay independent of copy — but a key names no
 * Agent, and the mark's side is read off the sentence. One case needs a sentence
 * that really interpolates.
 */
const translateOverride = vi.hoisted(() => ({
    fn: null as null | ((key: string, params?: Record<string, unknown>) => string),
}));

vi.mock('@/text', () => ({
    t: (key: string, params?: Record<string, unknown>) => translateOverride.fn?.(key, params) ?? key,
}));

describe('AgentInputSubmitButton Dictation routing', () => {
    afterEach(() => {
        translateOverride.fn = null;
    });

    it('keeps a disabled send visually inactive and exposes its disabled accessibility state', async () => {
        const { AgentInputSubmitButton } = await import('./AgentInputSubmitButton');
        let renderer: ReturnType<typeof create>;

        await act(async () => {
            renderer = create(<AgentInputSubmitButton
                testID="composer-send"
                sessionId="session-1"
                disabled
                hasSendableContent
                dictationStatus="idle"
                onSend={() => {}}
            />);
        });
        const button = renderer!.root.findByType('PrimaryCircleIconButton' as any);

        expect(button.props.active).toBe(false);
        expect(button.props.disabled).toBe(true);
        expect(button.props.accessibilityState).toMatchObject({ disabled: true });
    });

    it('ends active Dictation instead of sending composer text as a coding turn', async () => {
        const { AgentInputSubmitButton } = await import('./AgentInputSubmitButton');
        const onDictationPress = vi.fn();
        const onSend = vi.fn();
        let renderer: ReturnType<typeof create>;

        await act(async () => {
            renderer = create(<AgentInputSubmitButton
                testID="composer-send"
                sessionId="session-1"
                disabled={false}
                hasSendableContent={true}
                dictationPressHandler={onDictationPress}
                dictationStatus="listening"
                onSend={onSend}
            />);
        });
        const button = renderer!.root.findByType('PrimaryCircleIconButton' as any);

        expect(button.props.accessibilityLabel).toBe('voiceAssistant.endDictation');
        act(() => {
            button.props.onPress();
        });

        expect(onDictationPress).toHaveBeenCalledTimes(1);
        expect(onSend).not.toHaveBeenCalled();
    });

    it('announces transcription as busy and does not expose it as recording', async () => {
        const { AgentInputSubmitButton } = await import('./AgentInputSubmitButton');
        const onDictationPress = vi.fn();
        let renderer: ReturnType<typeof create>;

        await act(async () => {
            renderer = create(<AgentInputSubmitButton
                testID="composer-send"
                sessionId="session-1"
                disabled={true}
                hasSendableContent={false}
                dictationPressHandler={onDictationPress}
                dictationStatus="transcribing"
                onSend={() => {}}
            />);
        });
        const button = renderer!.root.findByType('PrimaryCircleIconButton' as any);

        expect(button.props.accessibilityLabel).toBe('voiceAssistant.transcribing');
        expect(button.props.accessibilityState).toMatchObject({ busy: true, disabled: true });
        expect(button.props.loading).toBe(true);
        act(() => {
            button.props.onPress();
        });
        expect(onDictationPress).not.toHaveBeenCalled();
    });

    it('renders the Stop the composer placed here instead of starting Dictation', async () => {
        const { AgentInputSubmitButton } = await import('./AgentInputSubmitButton');
        const onDictationPress = vi.fn();
        const onStop = vi.fn();
        const onSend = vi.fn();
        let renderer: ReturnType<typeof create>;

        await act(async () => {
            renderer = create(<AgentInputSubmitButton
                testID="composer-send"
                sessionId="session-1"
                disabled={false}
                hasSendableContent={false}
                holdsStop={true}
                dictationPressHandler={onDictationPress}
                dictationStatus="idle"
                onSend={onSend}
                onStop={onStop}
            />);
        });
        const button = renderer!.root.findByType('PrimaryCircleIconButton' as any);

        expect(button.props.accessibilityLabel).toBe('agentInput.stopCodingTurn');
        expect(renderer!.root.findAllByType('Image' as any)).toHaveLength(0);
        expect(renderer!.root.findAllByType('Icon' as any).some((n) => n.props?.name === 'stop')).toBe(true);

        act(() => {
            button.props.onPress();
        });

        expect(onStop).toHaveBeenCalledTimes(1);
        expect(onDictationPress).not.toHaveBeenCalled();
        expect(onSend).not.toHaveBeenCalled();
    });

    it('keeps an in-flight Dictation on the button while the turn can also be stopped', async () => {
        const { AgentInputSubmitButton } = await import('./AgentInputSubmitButton');
        const onDictationPress = vi.fn();
        const onStop = vi.fn();
        let renderer: ReturnType<typeof create>;

        await act(async () => {
            renderer = create(<AgentInputSubmitButton
                testID="composer-send"
                sessionId="session-1"
                disabled={false}
                hasSendableContent={false}
                holdsStop={true}
                dictationPressHandler={onDictationPress}
                dictationStatus="listening"
                onSend={() => {}}
                onStop={onStop}
            />);
        });
        const button = renderer!.root.findByType('PrimaryCircleIconButton' as any);

        expect(button.props.accessibilityLabel).toBe('voiceAssistant.endDictation');
        expect(renderer!.root.findAllByType('Icon' as any).some((n) => n.props?.name === 'stop-circle')).toBe(true);

        act(() => {
            button.props.onPress();
        });

        expect(onDictationPress).toHaveBeenCalledTimes(1);
        expect(onStop).not.toHaveBeenCalled();
    });
    it('submits an armed switch on an empty composer', async () => {
        const { AgentInputSubmitButton } = await import('./AgentInputSubmitButton');
        const onSend = vi.fn();
        let renderer: ReturnType<typeof create>;

        await act(async () => {
            renderer = create(<AgentInputSubmitButton
                testID="composer-send"
                sessionId="session-1"
                disabled={false}
                hasSendableContent={false}
                dictationStatus="idle"
                armedContinuationTarget={{ agentId: 'codex', label: 'Codex' }}
                onSend={onSend}
            />);
        });

        const button = renderer!.root.findByType('RoundButton' as any);
        expect(button.props.accessibilityLabel).toBe('session.agentContinuation.sendLabel');
        expect(button.props.disabled).toBe(false);
        expect(button.props.accessibilityHint).toBeUndefined();
        expect(renderer!.root.findAllByType('PrimaryCircleIconButton' as any)).toHaveLength(0);

        act(() => {
            button.props.onPress();
        });
        expect(onSend).toHaveBeenCalledTimes(1);
    });

    it('drops the empty-composer hint once there is something to send', async () => {
        const { AgentInputSubmitButton } = await import('./AgentInputSubmitButton');
        const onSend = vi.fn();
        let renderer: ReturnType<typeof create>;

        await act(async () => {
            renderer = create(<AgentInputSubmitButton
                testID="composer-send"
                sessionId="session-1"
                disabled={false}
                hasSendableContent={true}
                dictationStatus="idle"
                armedContinuationTarget={{ agentId: 'codex', label: 'Codex' }}
                onSend={onSend}
            />);
        });

        const button = renderer!.root.findByType('RoundButton' as any);
        expect(button.props.accessibilityHint).toBeUndefined();
        expect(button.props.disabled).toBe(false);

        act(() => {
            button.props.onPress();
        });
        expect(onSend).toHaveBeenCalledTimes(1);
    });

    it('submits the armed continuation instead of idle Dictation', async () => {
        const { AgentInputSubmitButton } = await import('./AgentInputSubmitButton');
        const onDictationPress = vi.fn();
        let renderer: ReturnType<typeof create>;

        await act(async () => {
            renderer = create(<AgentInputSubmitButton
                testID="composer-send"
                sessionId="session-1"
                disabled={false}
                hasSendableContent={false}
                dictationPressHandler={onDictationPress}
                dictationStatus="idle"
                armedContinuationTarget={{ agentId: 'codex', label: 'Codex' }}
                onSend={() => {}}
            />);
        });

        const button = renderer!.root.findByType('RoundButton' as any);
        expect(button.props.accessibilityLabel).toBe('session.agentContinuation.sendLabel');

        act(() => {
            button.props.onPress();
        });
        expect(onDictationPress).not.toHaveBeenCalled();
    });

    it('puts the mark on the side the sentence names the Agent on', async () => {
        // English closes with the Agent, Japanese opens with it. Both slots have to
        // stay wired, or half the languages the app ships read as broken grammar.
        const { AgentInputSubmitButton } = await import('./AgentInputSubmitButton');

        let english: ReturnType<typeof create>;
        translateOverride.fn = (key, params) => (
            key === 'session.agentContinuation.sendLabel'
                ? `Continue with ${String(params?.agent ?? '')}`
                : key
        );
        await act(async () => {
            english = create(<AgentInputSubmitButton
                testID="composer-send"
                sessionId="session-1"
                disabled={false}
                hasSendableContent={true}
                dictationStatus="idle"
                armedContinuationTarget={{ agentId: 'codex', label: 'Codex' }}
                onSend={() => {}}
            />);
        });
        const englishButton = english!.root.findByType('RoundButton' as any);
        expect(englishButton.props.title).toBe('Continue with');
        expect(englishButton.props.trailing).toBeTruthy();
        expect(englishButton.props.leading).toBeUndefined();

        let japanese: ReturnType<typeof create>;
        translateOverride.fn = (key, params) => (
            key === 'session.agentContinuation.sendLabel'
                ? `${String(params?.agent ?? '')} \u3067\u7d9a\u3051\u308b`
                : key
        );
        await act(async () => {
            japanese = create(<AgentInputSubmitButton
                testID="composer-send"
                sessionId="session-1"
                disabled={false}
                hasSendableContent={true}
                dictationStatus="idle"
                armedContinuationTarget={{ agentId: 'codex', label: 'Codex' }}
                onSend={() => {}}
            />);
        });
        const japaneseButton = japanese!.root.findByType('RoundButton' as any);
        expect(japaneseButton.props.title).toBe('\u3067\u7d9a\u3051\u308b');
        expect(japaneseButton.props.leading).toBeTruthy();
        expect(japaneseButton.props.trailing).toBeUndefined();
    });

    it('offers the armed route\'s cancel beside the send, whichever shape it has, and never for an armed Agent', async () => {
        const { AgentInputSubmitButton } = await import('./AgentInputSubmitButton');
        const onUnarmRoute = vi.fn();
        const render = (props: Partial<React.ComponentProps<typeof AgentInputSubmitButton>>) => create(<AgentInputSubmitButton
            testID="composer-send"
            sessionId="session-1"
            disabled={false}
            hasSendableContent
            dictationStatus="idle"
            armedRouteContinuation={{ sourceLabel: 'OpenRouter' }}
            onUnarmRoute={onUnarmRoute}
            onSend={() => {}}
            {...props}
        />);
        const unarm = (renderer: ReturnType<typeof create>) => renderer.root.findAll((node) => node.props.testID === 'agent-input-route-unarm');
        let armedPill!: ReturnType<typeof create>;
        let emptyComposer!: ReturnType<typeof create>;
        let armedAgent!: ReturnType<typeof create>;
        let unarmed!: ReturnType<typeof create>;
        await act(async () => {
            armedPill = render({});
            emptyComposer = render({ hasSendableContent: false, dictationPressHandler: () => {} });
            armedAgent = render({ armedContinuationTarget: { agentId: 'codex', label: 'Codex' } });
            unarmed = render({ armedRouteContinuation: null });
        });
        expect(unarm(armedPill).length).toBeGreaterThan(0);
        expect(unarm(emptyComposer).length).toBeGreaterThan(0);
        expect(unarm(armedAgent)).toHaveLength(0);
        expect(unarm(unarmed)).toHaveLength(0);
        act(() => { unarm(armedPill)[0]!.props.onPress(); });
        expect(onUnarmRoute).toHaveBeenCalledTimes(1);
    });
});
