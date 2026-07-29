import * as React from 'react';
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@expo/vector-icons', () => ({
    Ionicons: (props: Record<string, unknown>) => React.createElement('Ionicons', props),
    Octicons: (props: Record<string, unknown>) => React.createElement('Octicons', props),
}));

vi.mock('expo-image', () => ({
    Image: (props: Record<string, unknown>) => React.createElement('Image', props),
}));

vi.mock('react-native', () => ({
    Platform: { OS: 'web' },
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                button: {
                    primary: { tint: '#fff' },
                },
            },
        },
    }),
}));

vi.mock('@/components/ui/buttons/PrimaryCircleIconButton', () => ({
    PrimaryCircleIconButton: (
        props: Record<string, unknown> & { children?: React.ReactNode },
    ) => React.createElement('PrimaryCircleIconButton', props, props.children),
}));

vi.mock('@/components/ui/theme/haptics', () => ({
    hapticsLight: () => {},
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

describe('AgentInputSubmitButton Dictation routing', () => {
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
});
