import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Boundaries only: device speech, the web audio unlock, the modal, the settings store and the
// platform/theme/text shells. The button, readAloud and speakAssistantText are real.
type SpeakOptions = { onDone?: () => void; onStopped?: () => void };
const expoSpeech = vi.hoisted(() => ({
    speak: vi.fn<(text: string, options: SpeakOptions) => void>(),
    stop: vi.fn(),
}));
const settingsState = vi.hoisted(() => ({ voice: null as unknown }));
const modal = vi.hoisted(() => ({ spies: null as null | { alert: ReturnType<typeof vi.fn> } }));
const primeWebAudioPlayback = vi.hoisted(() => vi.fn());

vi.mock('expo-speech', () => expoSpeech);
vi.mock('@/voice/output/webAudioContext', () => ({ primeWebAudioPlayback }));
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'web', select: (v: Record<string, unknown>) => v.web ?? v.default } });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({ theme: { colors: { text: { secondary: '#666666' }, state: { active: { foreground: '#0a7a4b' } } } } });
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    const mock = createModalModuleMock();
    modal.spies = mock.spies;
    return mock.module;
});
vi.mock('@/sync/store/hooks', async (importOriginal) => {
    const { createStoreHooksModuleMock, createUseSettingMock } = await import('@/dev/testkit/mocks/storage');
    return createStoreHooksModuleMock({
        importOriginal,
        overrides: { useSetting: createUseSettingMock({ values: settingsState as never }) },
    });
});

const localVoice = voiceSettingsParse({
    providerId: 'local_conversation',
    adapters: { local_conversation: { tts: { provider: 'device' } } },
});

let utterances: SpeakOptions[] = [];

describe('MessageSpeakButton', () => {
    afterEach(() => {
        settingsState.voice = null;
        utterances = [];
        expoSpeech.speak.mockReset();
        expoSpeech.stop.mockReset();
        primeWebAudioPlayback.mockReset();
        standardCleanup();
    });

    function setup() {
        settingsState.voice = localVoice;
        expoSpeech.speak.mockImplementation((_text, options) => { utterances.push(options); });
    }

    it('is hidden when no local voice provider is selected', async () => {
        const { MessageSpeakButton } = await import('./MessageSpeakButton');
        settingsState.voice = voiceSettingsParse({ providerId: 'realtime_elevenlabs' });
        const screen = await renderScreen(<MessageSpeakButton messageKey="m1" text="hi" testID="speak" />);
        expect(screen.findAllByType('Pressable')).toHaveLength(0);
    });

    it('is hidden when there is nothing to read', async () => {
        const { MessageSpeakButton } = await import('./MessageSpeakButton');
        setup();
        const screen = await renderScreen(<MessageSpeakButton messageKey="m1" text="   " testID="speak" />);
        expect(screen.findAllByType('Pressable')).toHaveLength(0);
    });

    it('unlocks web audio from the press, reads the message, and offers Stop while it plays', async () => {
        const { MessageSpeakButton } = await import('./MessageSpeakButton');
        setup();
        const screen = await renderScreen(<MessageSpeakButton messageKey="m1" text="hello" testID="speak" />);
        expect(screen.findByTestId('speak')?.props.accessibilityLabel).toBe('message.readAloudA11y');

        await act(async () => { screen.pressByTestId('speak'); });
        expect(primeWebAudioPlayback).toHaveBeenCalledTimes(1);
        expect(expoSpeech.speak).toHaveBeenCalledWith('hello', expect.any(Object));
        await vi.waitFor(() => expect(screen.findByTestId('speak')?.props.accessibilityLabel).toBe('message.stopReadAloudA11y'));

        await act(async () => { screen.pressByTestId('speak'); });
        expect(expoSpeech.stop).toHaveBeenCalledTimes(1);
        await vi.waitFor(() => expect(screen.findByTestId('speak')?.props.accessibilityLabel).toBe('message.readAloudA11y'));
        utterances[0].onStopped?.();
    });

    it('does not offer Stop on a different message that is not playing', async () => {
        const { MessageSpeakButton } = await import('./MessageSpeakButton');
        setup();
        const screen = await renderScreen(
            <>
                <MessageSpeakButton messageKey="m1" text="one" testID="speak-1" />
                <MessageSpeakButton messageKey="m2" text="two" testID="speak-2" />
            </>,
        );

        await act(async () => { screen.pressByTestId('speak-1'); });
        await vi.waitFor(() => expect(screen.findByTestId('speak-1')?.props.accessibilityLabel).toBe('message.stopReadAloudA11y'));
        expect(screen.findByTestId('speak-2')?.props.accessibilityLabel).toBe('message.readAloudA11y');
        utterances[0].onDone?.();
    });

    it('tells the user when the voice provider fails', async () => {
        const { MessageSpeakButton } = await import('./MessageSpeakButton');
        setup();
        expoSpeech.speak.mockImplementation(() => { throw new Error('no voice'); });
        const screen = await renderScreen(<MessageSpeakButton messageKey="m1" text="hello" testID="speak" />);

        await act(async () => { screen.pressByTestId('speak'); });
        await vi.waitFor(() => expect(modal.spies?.alert).toHaveBeenCalledWith('common.error', 'message.readAloudFailed'));
    });
});
