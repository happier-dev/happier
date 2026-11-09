import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { SharedValue } from 'react-native-reanimated';
import { View } from 'react-native';

import { renderScreen } from '@/dev/testkit';

import {
    ComposerKeyboardFloatingInset,
    ComposerKeyboardProvider,
    useReportComposerOverlayOpen,
    type ComposerKeyboardLayout,
} from './index';

function ComposerOverlay(props: Readonly<{ open: boolean }>) {
    useReportComposerOverlayOpen(props.open);
    return null;
}

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

function createLayout(listBottomInset: number): ComposerKeyboardLayout {
    return {
        availablePanelHeight: sharedValue(0),
        bottomInset: sharedValue(0),
        composerHeight: sharedValue(0),
        isKeyboardLiftSuppressed: sharedValue(false),
        keyboardHeightForInset: sharedValue(0),
        keyboardHeightLive: sharedValue(0),
        keyboardProgress: sharedValue(0),
        listBottomInset: sharedValue(listBottomInset),
        setComposerMeasuredHeight: vi.fn(),
    };
}

function flattenStyle(style: unknown): Record<string, unknown> {
    const styles = Array.isArray(style) ? style : [style];
    return styles.reduce<Record<string, unknown>>((merged, entry) => {
        if (entry && typeof entry === 'object') {
            return { ...merged, ...(entry as Record<string, unknown>) };
        }
        return merged;
    }, {});
}

function readTranslateY(style: unknown): number | undefined {
    const transform = flattenStyle(style).transform;
    if (!Array.isArray(transform)) return undefined;
    for (const entry of transform) {
        if (entry && typeof entry === 'object' && typeof (entry as Record<string, unknown>).translateY === 'number') {
            return (entry as { translateY: number }).translateY;
        }
    }
    return undefined;
}

describe('ComposerKeyboardFloatingInset', () => {
    it('lifts floating controls with a transform while keeping the base bottom static', async () => {
        const screen = await renderScreen(
            <ComposerKeyboardProvider layout={createLayout(168)}>
                <ComposerKeyboardFloatingInset testID="floating-inset" baseBottom={12}>
                    <React.Fragment />
                </ComposerKeyboardFloatingInset>
            </ComposerKeyboardProvider>,
        );

        const node = screen.findByTestId('floating-inset');
        expect(node).toBeTruthy();
        expect(readTranslateY(node?.props.style)).toBe(-168);
        expect(flattenStyle(node?.props.style).bottom).toBe(12);
    });

    it('steps a transcript control aside while a composer overlay covers the bottom of the transcript', async () => {
        const tree = (open: boolean) => (
            <ComposerKeyboardProvider layout={createLayout(0)}>
                <ComposerKeyboardFloatingInset baseBottom={12} hideUnderComposerOverlay>
                    <View testID="jump-pill" />
                </ComposerKeyboardFloatingInset>
                <ComposerKeyboardFloatingInset baseBottom={0}>
                    <View testID="find-bar" />
                </ComposerKeyboardFloatingInset>
                <ComposerOverlay open={open} />
            </ComposerKeyboardProvider>
        );
        const screen = await renderScreen(tree(false));
        expect(screen.findByTestId('jump-pill')).toBeTruthy();

        await screen.update(tree(true));
        // The prompt picker spans the composer card; the jump pill would stick out beside it (accept-r333 P2).
        expect(screen.findByTestId('jump-pill')).toBeNull();
        expect(screen.findByTestId('find-bar')).toBeTruthy();

        await screen.update(tree(false));
        expect(screen.findByTestId('jump-pill')).toBeTruthy();
    });
});
