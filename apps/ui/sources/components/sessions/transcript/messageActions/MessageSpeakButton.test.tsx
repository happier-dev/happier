import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({ voice: null as unknown, activeKey: null as string | null }));
const toggleReadAloud = vi.hoisted(() => vi.fn());
const alert = vi.hoisted(() => vi.fn());
const iconNames = vi.hoisted(() => [] as string[]);

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
vi.mock('@/sync/store/hooks', () => ({ useSetting: () => state.voice }));
vi.mock('@/voice/local/readAloud', () => ({
    toggleReadAloud,
    useReadAloudActiveKey: () => state.activeKey,
}));
vi.mock('@/modal', () => ({ Modal: { alert } }));
vi.mock('@/components/ui/icons/Icon', () => ({
    ICON_SIZE: { xs: 14 },
    Icon: (props: { name: string }) => {
        iconNames.push(props.name);
        return React.createElement('Icon', props);
    },
}));
vi.mock('./RowActionRevealSlot', () => ({
    RowActionDeferredIcon: (props: { children: React.ReactNode }) => React.createElement(React.Fragment, null, props.children),
}));

const localVoice = { providerId: 'local_conversation', adapters: { local_conversation: { tts: { provider: 'device' } } } };

describe('MessageSpeakButton', () => {
    afterEach(() => {
        state.voice = null;
        state.activeKey = null;
        iconNames.length = 0;
        toggleReadAloud.mockReset();
        alert.mockReset();
        standardCleanup();
    });

    it('is hidden when no local voice provider is selected', async () => {
        const { MessageSpeakButton } = await import('./MessageSpeakButton');
        state.voice = { providerId: 'realtime_elevenlabs' };
        const screen = await renderScreen(<MessageSpeakButton messageKey="m1" text="hi" testID="speak" />);
        expect(screen.findAllByType('Pressable')).toHaveLength(0);
    });

    it('is hidden when there is nothing to read', async () => {
        const { MessageSpeakButton } = await import('./MessageSpeakButton');
        state.voice = localVoice;
        const screen = await renderScreen(<MessageSpeakButton messageKey="m1" text="   " testID="speak" />);
        expect(screen.findAllByType('Pressable')).toHaveLength(0);
    });

    it('reads the message aloud when pressed', async () => {
        const { MessageSpeakButton } = await import('./MessageSpeakButton');
        state.voice = localVoice;
        toggleReadAloud.mockResolvedValue(true);
        const screen = await renderScreen(<MessageSpeakButton messageKey="m1" text="hello" testID="speak" />);

        const button = screen.findByTestId('speak');
        expect(button?.props.accessibilityLabel).toBe('message.readAloudA11y');
        expect(iconNames).toContain('speaker-high');
        screen.pressByTestId('speak');

        expect(toggleReadAloud).toHaveBeenCalledWith({ key: 'm1', text: 'hello', settings: { voice: localVoice } });
        expect(alert).not.toHaveBeenCalled();
    });

    it('shows a stop control while its own message is playing', async () => {
        const { MessageSpeakButton } = await import('./MessageSpeakButton');
        state.voice = localVoice;
        state.activeKey = 'm1';
        const screen = await renderScreen(<MessageSpeakButton messageKey="m1" text="hello" testID="speak" />);
        expect(screen.findByTestId('speak')?.props.accessibilityLabel).toBe('message.stopReadAloudA11y');
        expect(iconNames).toContain('stop');
    });

    it('does not show stop for a different message that is playing', async () => {
        const { MessageSpeakButton } = await import('./MessageSpeakButton');
        state.voice = localVoice;
        state.activeKey = 'other';
        const screen = await renderScreen(<MessageSpeakButton messageKey="m1" text="hello" testID="speak" />);
        expect(screen.findByTestId('speak')?.props.accessibilityLabel).toBe('message.readAloudA11y');
    });

    it('tells the user when the voice provider fails', async () => {
        const { MessageSpeakButton } = await import('./MessageSpeakButton');
        state.voice = localVoice;
        toggleReadAloud.mockResolvedValue(false);
        const screen = await renderScreen(<MessageSpeakButton messageKey="m1" text="hello" testID="speak" />);
        screen.pressByTestId('speak');
        await vi.waitFor(() => expect(alert).toHaveBeenCalledWith('common.error', 'message.readAloudFailed'));
    });
});
