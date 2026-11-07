import * as React from 'react';
import type { TextInput } from 'react-native';
import { describe, expect, it, vi } from 'vitest';
import { act, renderScreen } from '@/dev/testkit';
import { useBrowserSoftKeyboard } from '@/components/browser/streamed/useBrowserSoftKeyboard';
import { RemoteViewerControlBar } from './RemoteViewerControlBar';
import { useRemoteViewerActions } from '@happier-dev/plugin-ui/presentation';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

// The browser's hardware media queries are the platform boundary; the shared primary-pointer owner
// classifies them for real underneath.
const pointer = vi.hoisted(() => ({ coarse: true }));
Object.defineProperty(globalThis, 'matchMedia', { configurable: true, value: (query: string) => ({
    matches: query === '(pointer: coarse)' || query === '(hover: none)' ? pointer.coarse
        : query === '(pointer: fine)' || query === '(hover: hover)' ? !pointer.coarse : false,
    media: query, onchange: null, addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true,
}) });

function Bar() {
    const actions = useRemoteViewerActions({ enabled: true, sendGesture: () => {} });
    return <RemoteViewerControlBar enabled actions={actions} testID="controls" controls={{
        mode: 'direct', setMode: () => {}, resetZoom: () => {},
    }} />;
}

describe('remote viewer control bar', () => {
    it('stands over the picture only for a finger; a mouse and keyboard drive the picture directly', async () => {
        pointer.coarse = false;
        const precise = await renderScreen(<Bar />);
        try { expect(precise.findHostByTestId('controls')).toBeFalsy(); } finally { await precise.unmount(); }
        pointer.coarse = true;
        const touch = await renderScreen(<Bar />);
        try { expect(touch.findHostByTestId('controls')).toBeTruthy(); } finally { await touch.unmount(); }
    });
});

describe('remote viewer keyboard toggle', () => {
    it('hides on a second pointer click even when the browser would blur the sentinel before click', async () => {
        let keyboard!: ReturnType<typeof useBrowserSoftKeyboard>;
        let nativeFocused = false;
        function Host() {
            const actions = useRemoteViewerActions({ enabled: true, sendGesture: () => {} });
            keyboard = useBrowserSoftKeyboard({ enabled: true, manual: true, target: null,
                sendText: actions.sendText, sendKey: actions.sendKey });
            return <RemoteViewerControlBar enabled actions={{ ...actions, keyboard }} testID="controls" controls={{
                mode: 'direct', setMode: () => {}, resetZoom: () => {},
            }} />;
        }
        const screen = await renderScreen(<Host />);
        // TextInput and the browser's default focus transfer are the platform boundary.
        const host = {
            focus: () => { nativeFocused = true; keyboard.sentinelProps.onFocus?.({} as Parameters<NonNullable<typeof keyboard.sentinelProps.onFocus>>[0]); },
            blur: () => { nativeFocused = false; keyboard.sentinelProps.onBlur?.({} as Parameters<NonNullable<typeof keyboard.sentinelProps.onBlur>>[0]); },
            setNativeProps: () => {},
        };
        Object.assign(keyboard.inputRef, { current: host as unknown as TextInput });
        const click = async () => {
            let prevented = false;
            const control = screen.findHostByTestId('controls-keyboard')!;
            await act(async () => { control.props.onPointerDown?.({ preventDefault: () => { prevented = true; } }); });
            if (!prevented) await act(async () => { host.blur(); });
            // RNW delays press-in until after the browser's default focus transfer.
            await act(async () => { control.props.onPressIn?.({ preventDefault: () => {} }); });
            await act(async () => { screen.findByTestId('controls-keyboard')?.props.onPress(); });
        };
        try {
            await click();
            expect(nativeFocused).toBe(true);
            expect(keyboard.focused).toBe(true);
            await click();
            expect(nativeFocused).toBe(false);
            expect(keyboard.focused).toBe(false);
            await click();
            expect(nativeFocused).toBe(true);
        } finally { await screen.unmount(); }
    });
});
