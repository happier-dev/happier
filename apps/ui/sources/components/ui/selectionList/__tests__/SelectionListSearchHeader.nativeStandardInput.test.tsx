import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: {
            OS: 'android',
            select: <T,>(options: { android?: T; default?: T; native?: T; ios?: T; web?: T }) =>
                options.android ?? options.native ?? options.default ?? options.ios ?? options.web,
        },
    });
});

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return Object.assign(
            {} as Record<string, unknown>,
            ...style.flat(Infinity).filter(Boolean).map((entry) => entry as Record<string, unknown>),
        );
    }
    return (style ?? {}) as Record<string, unknown>;
}

describe('SelectionListSearchHeader native input presentation', () => {
    it('uses a standard native TextInput for path-like values even when autocomplete and head ellipsis are available', async () => {
        const { SelectionListSearchHeader } = await import('../SelectionListSearchHeader');
        const screen = await renderScreen(
            <SelectionListSearchHeader
                value="/Users/leeroy/Documents/Development/happier/dev"
                onChangeText={() => {}}
                placeholder="Path"
                canPop={false}
                ghostSuffix="/src"
                inputValueEllipsizeMode="head"
                testID="hdr"
            />,
        );

        expect(screen.findByTestId('hdr:input:mirror')).toBeNull();
        expect(screen.findByTestId('hdr:input:start-ellipsis')).toBeNull();
        expect(screen.findByTestId('hdr:input:ghost')).toBeNull();

        const input = screen.findByTestId('hdr:input');
        expect(input).not.toBeNull();
        const inputStyle = flattenStyle(input!.props.style);
        expect(inputStyle.position).not.toBe('absolute');
        expect(inputStyle.color).not.toBe('transparent');
        expect(inputStyle.flex).toBe(1);
    });
});
