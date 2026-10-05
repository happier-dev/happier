import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { setPreferredLanguageFromSettings } from '@/text';
import { DesktopWindowControlsButtons } from './DesktopWindowControlsButtons';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

afterEach(() => setPreferredLanguageFromSettings(null));

describe('DesktopWindowControlsButtons', () => {
    it('names each action in the selected language and changes maximize to restore', async () => {
        setPreferredLanguageFromSettings('fr');
        const onMinimize = vi.fn();
        const onToggleMaximize = vi.fn();
        const onClose = vi.fn();
        const props = { onMinimize, onToggleMaximize, onClose };
        const screen = await renderScreen(<DesktopWindowControlsButtons {...props} />);

        for (const [testId, label] of [
            ['desktop-window-controls-minimize', 'Réduire la fenêtre'],
            ['desktop-window-controls-toggle-maximize', 'Agrandir la fenêtre'],
            ['desktop-window-controls-close', 'Fermer la fenêtre'],
        ]) {
            const button = screen.findByTestId(testId);
            expect(button?.props.accessibilityRole).toBe('button');
            expect(button?.props.accessibilityLabel).toBe(label);
            await screen.pressByTestIdAsync(testId);
        }
        expect(onMinimize).toHaveBeenCalledOnce();
        expect(onToggleMaximize).toHaveBeenCalledOnce();
        expect(onClose).toHaveBeenCalledOnce();

        await act(async () => screen.update(<DesktopWindowControlsButtons {...props} isMaximized />));
        expect(screen.findByTestId('desktop-window-controls-toggle-maximize')?.props.accessibilityLabel)
            .toBe('Restaurer la fenêtre');
    });
});
