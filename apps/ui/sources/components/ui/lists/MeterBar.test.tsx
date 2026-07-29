import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { lightTheme } from '@/theme';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return style.reduce<Record<string, unknown>>(
            (accumulator, entry) => Object.assign(accumulator, flattenStyle(entry)),
            {},
        );
    }
    if (style && typeof style === 'object') {
        return style as Record<string, unknown>;
    }
    return {};
}

describe('MeterBar', () => {
    it.each([
        ['success' as const, lightTheme.colors.state.success.foreground],
        ['warning' as const, lightTheme.colors.state.warning.foreground],
        ['danger' as const, lightTheme.colors.state.danger.foreground],
        ['neutral' as const, lightTheme.colors.state.neutral.foreground],
    ])('paints the fill with state[%s].foreground (no opacity transform)', async (tone, expectedColor) => {
        const { MeterBar } = await import('./MeterBar');
        const screen = await renderScreen(<MeterBar testID="meter" tone={tone} fillFraction={0.5} />);

        const fill = screen.findByTestId('meter:fill');
        const style = flattenStyle(fill?.props.style);
        expect(style.backgroundColor).toBe(expectedColor);
        // The remaining-fraction fill must read the token directly — no rgba/opacity
        // transform of a theme token (web var-ification trap).
        expect(String(style.backgroundColor)).not.toMatch(/rgba/i);
    });

    it('maps the remaining fraction to the fill width percentage', async () => {
        const { MeterBar } = await import('./MeterBar');
        const screen = await renderScreen(<MeterBar testID="meter" tone="success" fillFraction={0.42} />);

        const fill = screen.findByTestId('meter:fill');
        const style = flattenStyle(fill?.props.style);
        expect(style.width).toBe('42%');
    });

    it('clamps value into the 0..1 range', async () => {
        const { MeterBar } = await import('./MeterBar');

        const over = await renderScreen(<MeterBar testID="over" tone="success" fillFraction={1.8} />);
        expect(flattenStyle(over.findByTestId('over:fill')?.props.style).width).toBe('100%');

        const under = await renderScreen(<MeterBar testID="under" tone="danger" fillFraction={-0.3} />);
        expect(flattenStyle(under.findByTestId('under:fill')?.props.style).width).toBe('0%');

        const nan = await renderScreen(<MeterBar testID="nan" tone="neutral" fillFraction={Number.NaN} />);
        expect(flattenStyle(nan.findByTestId('nan:fill')?.props.style).width).toBe('0%');
    });

    it('renders the track with the default surface overlay token and honors trackColor override', async () => {
        const { MeterBar } = await import('./MeterBar');

        const defaulted = await renderScreen(<MeterBar testID="meter" tone="success" fillFraction={0.5} />);
        expect(flattenStyle(defaulted.findByTestId('meter:track')?.props.style).backgroundColor)
            .toBe(lightTheme.colors.surface.pressedOverlay);

        const overridden = await renderScreen(
            <MeterBar testID="meter2" tone="success" fillFraction={0.5} trackColor="#123456" />,
        );
        expect(flattenStyle(overridden.findByTestId('meter2:track')?.props.style).backgroundColor)
            .toBe('#123456');
    });

    it('renders an optional caption', async () => {
        const { MeterBar } = await import('./MeterBar');
        const screen = await renderScreen(
            <MeterBar testID="meter" tone="warning" fillFraction={0.2} caption="18% left" />,
        );
        expect(screen.getTextContent()).toContain('18% left');
    });
});
