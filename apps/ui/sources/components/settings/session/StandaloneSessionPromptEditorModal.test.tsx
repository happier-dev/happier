import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

describe('StandaloneSessionPromptEditorModal', () => {
    it('saves edited text and permits clearing the standalone prompt', async () => {
        const { StandaloneSessionPromptEditorModal } = await import('./StandaloneSessionPromptEditorModal');
        const { RoundButton } = await import('@/components/ui/buttons/RoundButton');
        const { t } = await import('@/text');
        const onResolve = vi.fn();
        const onClose = vi.fn();
        let chrome: { footer?: React.ReactNode; title?: string } | null = null;
        const setChrome = vi.fn((next: typeof chrome) => { chrome = next; });
        const screen = await renderScreen(
            <StandaloneSessionPromptEditorModal
                initialText="Initial standalone instructions."
                onResolve={onResolve}
                onClose={onClose}
                setChrome={setChrome as never}
            />,
        );

        expect((chrome as { title?: string } | null)?.title).toBe(
            t('settingsSession.promptPersonalization.standalonePromptTitle'),
        );
        const input = screen.findByTestId('standalone-session-prompt-input');
        expect(input?.props.value).toBe('Initial standalone instructions.');
        await React.act(async () => { input?.props.onChangeText(''); });

        const footer = await renderScreen(<>{(chrome as { footer?: React.ReactNode } | null)?.footer}</>);
        const save = footer.findAllByType(RoundButton).find((node) => node.props.title === t('common.save'));
        expect(save?.props.disabled).not.toBe(true);
        await React.act(async () => { save?.props.onPress(); });

        expect(onResolve).toHaveBeenCalledWith('');
        expect(onClose).toHaveBeenCalledOnce();
    });
});
