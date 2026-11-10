import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installPopoverCommonModuleMocks } from '@/components/ui/popover/popoverTestHelpers';

type NativeStyle = Record<string, unknown>;

function flattenNativeStyle(style: unknown): NativeStyle {
    return Object.assign({}, ...[style].flat(Infinity).filter(Boolean));
}

installPopoverCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeNativeMock({ platformOS: 'ios' }, {
            useWindowDimensions: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }),
            Animated: {
                // RN AnimatedProps flattens styles before the native Unistyles View receives them.
                View: (props: Readonly<{ style?: unknown; children?: React.ReactNode }>) => (
                    React.createElement('NativeAnimatedView', { ...props, style: flattenNativeStyle(props.style) })
                ),
            },
        });
    },
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    const runtime = await createUnistylesMock();
    const create = runtime.StyleSheet.create as (input: unknown) => Record<string, unknown>;
    let nextStyleId = 0;
    return {
        ...runtime,
        StyleSheet: {
            ...runtime.StyleSheet,
            create: (input: unknown) => Object.fromEntries(Object.entries(create(input)).map(([name, entry]) => {
                // Native Unistyles entries carry an enumerable hash; Animated's flatten drops NativeState.
                const hash = `unistyles_native_boundary_${nextStyleId++}`;
                const registered = (values: NativeStyle) => ({ ...values, [hash]: { uni__getStyles: () => values } });
                return [name, typeof entry === 'function'
                    ? (...args: unknown[]) => registered((entry as (...args: unknown[]) => NativeStyle)(...args))
                    : registered(entry as NativeStyle)];
            })),
        },
    };
});

const { ModalCardFrame } = await import('./ModalCardFrame');

describe('ModalCardFrame native style linking', () => {
    it.each(['sheet', 'card', 'fullscreen'] as const)('keeps its complete %s frame recoverable after native Animated flattens styles', async presentation => {
        const screen = await renderScreen(<ModalCardFrame presentation={presentation} testID="native-frame" style={{ maxHeight: 700 }}>
            {React.createElement('Child')}
        </ModalCardFrame>);
        const style = screen.findByType('NativeAnimatedView').props.style as NativeStyle;
        // UnistyleWrapper.h recovers only the first registered style when a flattened object has several hashes.
        // A single registered frame preserves the whole frame's native theme-update link.
        const hashes = Object.keys(style).filter(key => key.startsWith('unistyles_'));
        expect(hashes).toHaveLength(1);
        if (presentation === 'sheet') {
            const secret = style[hashes[0]!] as Readonly<{ uni__getStyles: () => NativeStyle }>;
            // Dropping the sheet override would silence the warning while losing its square bottom corners.
            expect(secret.uni__getStyles()).toMatchObject({ borderBottomLeftRadius: 0, borderBottomRightRadius: 0 });
        }
    });
});
