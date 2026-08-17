import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { SharedValue } from 'react-native-reanimated';

import { renderScreen } from '@/dev/testkit';

import { ComposerKeyboardProvider, type ComposerKeyboardLayout } from './ComposerKeyboardContext';
import { ComposerKeyboardScrollInset } from './ComposerKeyboardScrollInset';

function isSharedValueUpdater<T>(value: T | ((current: T) => T)): value is (current: T) => T {
    return typeof value === 'function';
}

function sharedValue<T>(initialValue: T): SharedValue<T> {
    let currentValue = initialValue;
    return {
        get value() {
            return currentValue;
        },
        set value(nextValue: T) {
            currentValue = nextValue;
        },
        get: () => currentValue,
        set: (nextValue) => {
            currentValue = isSharedValueUpdater(nextValue)
                ? nextValue(currentValue)
                : nextValue;
        },
        addListener: () => {},
        removeListener: () => {},
        modify: (modifier) => {
            if (modifier) {
                currentValue = modifier(currentValue);
            }
        },
    };
}

type LayoutOptions = Readonly<{
    bottomInset?: number;
    composerHeight?: number;
    keyboardHeightForInset?: number;
    listBottomInset?: number;
    subscribeListBottomInset?: (listener: (height: number) => void) => () => void;
}>;

function createLayout(options: LayoutOptions = {}): ComposerKeyboardLayout {
    return {
        availablePanelHeight: sharedValue(0),
        bottomInset: sharedValue(options.bottomInset ?? 0),
        composerHeight: sharedValue(options.composerHeight ?? 0),
        isKeyboardLiftSuppressed: sharedValue(false),
        keyboardHeightForInset: sharedValue(options.keyboardHeightForInset ?? 0),
        keyboardHeightLive: sharedValue(0),
        keyboardProgress: sharedValue(0),
        listBottomInset: sharedValue(options.listBottomInset ?? 0),
        setComposerMeasuredHeight: vi.fn(),
        subscribeListBottomInset: options.subscribeListBottomInset,
    };
}

function readHeight(style: unknown): number | undefined {
    const styles = Array.isArray(style) ? style : [style];
    return styles.reduce<number | undefined>((height, entry) => (
        entry && typeof entry === 'object' && typeof (entry as Record<string, unknown>).height === 'number'
            ? (entry as { height: number }).height
            : height
    ), undefined);
}

describe('ComposerKeyboardScrollInset', () => {
    it('uses current native composer and keyboard values for subscribed inset changes', async () => {
        const listeners = new Set<(height: number) => void>();
        const layout = createLayout({
            listBottomInset: 0,
            subscribeListBottomInset: (listener) => {
                listeners.add(listener);
                listener(0);
                return () => {
                    listeners.delete(listener);
                };
            },
        });

        const renderTree = () => (
            <ComposerKeyboardProvider layout={layout}>
                <ComposerKeyboardScrollInset testID="transcript-composer-keyboard-inset" />
            </ComposerKeyboardProvider>
        );
        const screen = await renderScreen(renderTree());

        const node = screen.findByTestId('transcript-composer-keyboard-inset');
        expect(readHeight(node?.props.style)).toBe(0);

        await act(async () => {
            layout.composerHeight.value = 120;
            layout.keyboardHeightForInset.value = 72;
            layout.bottomInset.value = 72;
            layout.listBottomInset.value = 192;
            for (const listener of listeners) {
                listener(192);
            }
        });
        // The test Reanimated stub samples animated styles when React renders.
        await screen.update(renderTree());

        expect(readHeight(node?.props.style)).toBe(192);
    });

    it('follows live native keyboard geometry without waiting for an inset notification', async () => {
        const layout = createLayout({
            bottomInset: 291,
            composerHeight: 134,
            keyboardHeightForInset: 291,
            listBottomInset: 425,
            subscribeListBottomInset: (listener) => {
                listener(425);
                return () => {};
            },
        });

        const renderTree = () => (
            <ComposerKeyboardProvider layout={layout}>
                <ComposerKeyboardScrollInset testID="transcript-composer-keyboard-inset" />
            </ComposerKeyboardProvider>
        );
        const screen = await renderScreen(renderTree());
        expect(readHeight(screen.findByTestId('transcript-composer-keyboard-inset')?.props.style)).toBe(425);

        await act(async () => {
            layout.keyboardHeightForInset.value = 145;
            layout.bottomInset.value = 145;
            layout.listBottomInset.value = 279;
        });
        await screen.update(renderTree());

        expect(readHeight(screen.findByTestId('transcript-composer-keyboard-inset')?.props.style)).toBe(279);
    });

    it('applies notified totals even when guest-runtime shared-value reads lag behind', async () => {
        const onHeightChange = vi.fn();
        const listeners = new Set<(height: number) => void>();
        const layout = createLayout({
            bottomInset: 267,
            composerHeight: 153,
            keyboardHeightForInset: 267,
            listBottomInset: 420,
            subscribeListBottomInset: (listener) => {
                listeners.add(listener);
                listener(420);
                return () => {
                    listeners.delete(listener);
                };
            },
        });

        const screen = await renderScreen(
            <ComposerKeyboardProvider layout={layout}>
                <ComposerKeyboardScrollInset
                    testID="transcript-composer-keyboard-inset"
                    onHeightChange={onHeightChange}
                />
            </ComposerKeyboardProvider>,
        );

        const node = screen.findByTestId('transcript-composer-keyboard-inset');
        expect(readHeight(node?.props.style)).toBe(420);
        expect(onHeightChange).toHaveBeenLastCalledWith(420);

        await act(async () => {
            for (const listener of listeners) {
                listener(439);
            }
        });

        // The notification is the canonical settled JS-side total. The rendered spacer
        // keeps following the animated shared values, which can still read one step behind.
        expect(readHeight(node?.props.style)).toBe(420);
        expect(onHeightChange).toHaveBeenLastCalledWith(439);
    });

    it('settles on the last notified total after the composer and keyboard have collapsed', async () => {
        const onHeightChange = vi.fn();
        const listeners = new Set<(height: number) => void>();
        const layout = createLayout({
            bottomInset: 0,
            composerHeight: 134,
            keyboardHeightForInset: 0,
            listBottomInset: 134,
            subscribeListBottomInset: (listener) => {
                listeners.add(listener);
                listener(layout.listBottomInset.value);
                return () => {
                    listeners.delete(listener);
                };
            },
        });

        const screen = await renderScreen(
            <ComposerKeyboardProvider layout={layout}>
                <ComposerKeyboardScrollInset
                    testID="transcript-composer-keyboard-inset"
                    onHeightChange={onHeightChange}
                />
            </ComposerKeyboardProvider>,
        );

        const node = screen.findByTestId('transcript-composer-keyboard-inset');
        expect(readHeight(node?.props.style)).toBe(134);
        expect(onHeightChange).toHaveBeenCalledWith(134);

        await act(async () => {
            for (const listener of listeners) {
                listener(303);
            }
            for (const listener of listeners) {
                listener(134);
            }
        });

        expect(readHeight(node?.props.style)).toBe(134);
        expect(onHeightChange).toHaveBeenLastCalledWith(134);
    });
});
