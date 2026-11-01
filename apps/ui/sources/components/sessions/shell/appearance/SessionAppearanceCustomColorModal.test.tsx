import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import type { CustomModalChromeConfig } from '@/modal/types';

vi.mock('@/components/ui/text/Text', async () => {
    const { createUiTextModuleMock } = await import('@/dev/testkit/mocks/uiText');
    return createUiTextModuleMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});
vi.mock('reanimated-color-picker', async () => {
    const { createReanimatedColorPickerMock } = await import('@/dev/testkit/mocks/reanimatedColorPicker');
    return createReanimatedColorPickerMock();
});

async function renderModal(initialColor: Parameters<typeof import('./SessionAppearanceCustomColorModal')['SessionAppearanceCustomColorModal']>[0]['initialColor']) {
    const { SessionAppearanceCustomColorModal } = await import('./SessionAppearanceCustomColorModal');
    const setChrome = vi.fn<(value: CustomModalChromeConfig | null) => void>();
    const onResolve = vi.fn();
    const onClose = vi.fn();
    const screen = await renderScreen(<SessionAppearanceCustomColorModal
        initialColor={initialColor}
        onResolve={onResolve}
        onClose={onClose}
        setChrome={setChrome}
    />);
    const footerButtons = async () => {
        const footer = await renderScreen(<>{setChrome.mock.lastCall?.[0]?.footer}</>);
        return footer.findAll((node) => typeof node.type === 'string' && node.props.accessibilityRole === 'button');
    };
    return { screen, onResolve, onClose, footerButtons };
}

describe('SessionAppearanceCustomColorModal', () => {
    it('starts from the current custom colour and only saves a different one', async () => {
        const { screen, footerButtons } = await renderModal({ kind: 'custom', hex: '#123456' });

        expect((screen.findByTestId('session-appearance-custom-color-input') as any).props.value).toBe('#123456');
        expect((await footerButtons())[1].props.disabled).toBe(true);

        await act(async () => screen.changeTextByTestId('session-appearance-custom-color-input', '#654321'));
        expect((await footerButtons())[1].props.disabled).toBe(false);
    });

    it('starts from a preset\'s paint but will not save that preset as a fixed custom copy', async () => {
        const { screen, footerButtons } = await renderModal({ kind: 'accent', key: 'green' });

        const seeded = (screen.findByTestId('session-appearance-custom-color-input') as any).props.value as string;
        expect(seeded).toMatch(/^#[0-9A-Fa-f]{6}$/);
        expect((await footerButtons())[1].props.disabled).toBe(true);

        await act(async () => screen.changeTextByTestId('session-appearance-custom-color-input', seeded.toLowerCase()));
        expect((await footerButtons())[1].props.disabled).toBe(true);
    });

    it('saves the entered opaque hex as a custom colour', async () => {
        const { screen, onResolve, onClose, footerButtons } = await renderModal({ kind: 'custom', hex: '#123456' });

        await act(async () => screen.changeTextByTestId('session-appearance-custom-color-input', '#a1b2c3'));
        const buttons = await footerButtons();
        await act(async () => buttons[1].props.onPress());

        expect(onResolve).toHaveBeenCalledWith({ kind: 'custom', hex: '#A1B2C3' });
        expect(onClose).toHaveBeenCalledOnce();
    });

    it('refuses translucent values and preserves cancellation', async () => {
        const { screen, onResolve, onClose, footerButtons } = await renderModal(null);

        await act(async () => screen.changeTextByTestId('session-appearance-custom-color-input', 'rgba(0, 0, 0, 0.4)'));
        const buttons = await footerButtons();
        expect(buttons[1].props.disabled).toBe(true);
        await act(async () => buttons[0].props.onPress());

        expect(onResolve).toHaveBeenCalledWith(null);
        expect(onClose).toHaveBeenCalledOnce();
    });
});
