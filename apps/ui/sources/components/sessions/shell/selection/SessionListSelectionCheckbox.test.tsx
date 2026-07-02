import * as React from 'react';
import { StyleSheet, View } from 'react-native';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { SessionListSelectionProvider } from './SessionListSelectionContext';
import { SessionListSelectionCheckbox } from './SessionListSelectionCheckbox';

describe('SessionListSelectionCheckbox', () => {
    it('uses the stable e2e checkbox test id based on the session id and toggles selection', async () => {
        const screen = await renderScreen(
            <SessionListSelectionProvider scopeKey="scope-a" visibleOrderedKeys={['server-a:session-a']}>
                <SessionListSelectionCheckbox sessionId="session-a" selectionKey="server-a:session-a" />
            </SessionListSelectionProvider>,
        );

        const checkbox = screen.findByProps({ testID: 'session-list-selection-checkbox-session-a' });
        expect(checkbox.props.accessibilityState).toMatchObject({ checked: false });
        expect(checkbox.props.accessibilityLabel).toBeTruthy();

        await act(async () => {
            checkbox.props.onPress();
        });

        expect(screen.findByProps({ testID: 'session-list-selection-checkbox-session-a' }).props.accessibilityState)
            .toMatchObject({ checked: true });
    });

    it('does not also run the default toggle when a custom press handler is provided', async () => {
        const onPress = vi.fn();
        const screen = await renderScreen(
            <SessionListSelectionProvider scopeKey="scope-a" visibleOrderedKeys={['server-a:session-a']}>
                <SessionListSelectionCheckbox
                    sessionId="session-a"
                    selectionKey="server-a:session-a"
                    onPress={onPress}
                />
            </SessionListSelectionProvider>,
        );

        const checkbox = screen.findByProps({ testID: 'session-list-selection-checkbox-session-a' });

        await act(async () => {
            checkbox.props.onPress();
        });

        expect(onPress).toHaveBeenCalledTimes(1);
        expect(screen.findByProps({ testID: 'session-list-selection-checkbox-session-a' }).props.accessibilityState)
            .toMatchObject({ checked: false });
    });

    it('keeps a stable hit target while using a smaller visible selection control', async () => {
        const screen = await renderScreen(
            <SessionListSelectionProvider scopeKey="scope-a" visibleOrderedKeys={['server-a:session-a']}>
                <SessionListSelectionCheckbox sessionId="session-a" selectionKey="server-a:session-a" />
            </SessionListSelectionProvider>,
        );

        const checkbox = screen.findByProps({ testID: 'session-list-selection-checkbox-session-a' });
        const rootStyle = StyleSheet.flatten(checkbox.props.style);
        const visibleBox = checkbox.findByType(View);
        const boxStyle = StyleSheet.flatten(visibleBox.props.style);

        expect(rootStyle.width).toBeGreaterThanOrEqual(40);
        expect(rootStyle.height).toBeGreaterThanOrEqual(40);
        expect(boxStyle.width).toBeLessThan(24);
        expect(boxStyle.height).toBeLessThan(24);
    });

    it('keeps the checked fill optically aligned to the unchecked inner circle', async () => {
        const screen = await renderScreen(
            <SessionListSelectionProvider scopeKey="scope-a" visibleOrderedKeys={['server-a:session-a']}>
                <SessionListSelectionCheckbox sessionId="session-a" selectionKey="server-a:session-a" />
            </SessionListSelectionProvider>,
        );

        const checkbox = screen.findByProps({ testID: 'session-list-selection-checkbox-session-a' });
        const uncheckedBox = checkbox.findByType(View);
        const uncheckedBoxStyle = StyleSheet.flatten(uncheckedBox.props.style);

        await act(async () => {
            checkbox.props.onPress();
        });

        const selectedInner = screen.findByProps({ testID: 'session-list-selection-checkbox-inner-session-a' });
        const selectedInnerStyle = StyleSheet.flatten(selectedInner.props.style);

        expect(selectedInnerStyle.width).toBe(
            Number(uncheckedBoxStyle.width) - Number(uncheckedBoxStyle.borderWidth) * 2,
        );
        expect(selectedInnerStyle.height).toBe(
            Number(uncheckedBoxStyle.height) - Number(uncheckedBoxStyle.borderWidth) * 2,
        );
    });
});
