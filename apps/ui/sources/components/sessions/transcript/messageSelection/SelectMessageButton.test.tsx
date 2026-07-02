import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { TranscriptMessageSelectionProvider, useTranscriptSelectionActions, useTranscriptSelectionRow, useTranscriptSelectionState } from './TranscriptMessageSelectionContext';
import { SelectMessageButton } from './SelectMessageButton';

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

function Probe() {
    const state = useTranscriptSelectionState();
    const row = useTranscriptSelectionRow('m1');
    return <ProbeRoot mode={state.isSelectionMode} count={state.count} selected={row.isSelected} />;
}

function ExternalSelectionControl() {
    const actions = useTranscriptSelectionActions();
    return <ProbeButton testID="enter-other" onPress={() => actions.enter('m2')} />;
}

function ProbeRoot(props: Record<string, unknown>) {
    return React.createElement('ProbeRoot', props);
}

function ProbeButton(props: { testID: string; onPress: () => void }) {
    return React.createElement('ProbeButton', props);
}

function findPressableByTestId(screen: Awaited<ReturnType<typeof renderScreen>>, testID: string) {
    return screen.find((node) => node.props?.testID === testID && typeof node.props?.onPress === 'function');
}

function findAllPressablesByTestId(screen: Awaited<ReturnType<typeof renderScreen>>, testID: string) {
    return screen.findAll((node) => node.props?.testID === testID && typeof node.props?.onPress === 'function');
}

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return Object.assign({}, ...style.filter(Boolean).map(flattenStyle));
    }
    return style && typeof style === 'object' ? style as Record<string, unknown> : {};
}

function resolvePressableStyle(node: { props: { style?: unknown } }): Record<string, unknown> {
    const style = node.props.style;
    if (typeof style === 'function') {
        return flattenStyle(style({ pressed: false }));
    }
    return flattenStyle(style);
}

function renderButton(props: Partial<React.ComponentProps<typeof SelectMessageButton>> = {}) {
    return renderScreen(
        <TranscriptMessageSelectionProvider sessionId="s1" eligibleMessageIdsInOrder={['m1', 'm2']}>
            <ExternalSelectionControl />
            <SelectMessageButton
                messageId="m1"
                enabled
                visible
                testID="select-m1"
                role="assistant"
                previewText="hello from assistant"
                {...props}
            />
            <Probe />
        </TranscriptMessageSelectionProvider>,
    );
}

describe('SelectMessageButton', () => {
    it('does not render outside a selection provider', async () => {
        const screen = await renderScreen(
            <SelectMessageButton
                messageId="m1"
                enabled
                visible
                testID="select-m1"
            />,
        );

        expect(findAllPressablesByTestId(screen, 'select-m1')).toHaveLength(0);
    });

    it('does not render when disabled', async () => {
        const screen = await renderButton({ enabled: false });

        expect(findAllPressablesByTestId(screen, 'select-m1')).toHaveLength(0);
    });

    it('does not render when the message action row is hidden', async () => {
        const screen = await renderButton({ visible: false });

        expect(findAllPressablesByTestId(screen, 'select-m1')).toHaveLength(0);
    });

    it('enters selection mode with the message preselected when pressed', async () => {
        const screen = await renderButton();

        await act(async () => {
            findPressableByTestId(screen, 'select-m1').props.onPress();
        });

        expect(screen.findByType('ProbeRoot').props).toMatchObject({ mode: true, count: 1, selected: true });
        expect(findPressableByTestId(screen, 'select-m1').props.accessibilityRole).toBe('checkbox');
        expect(findPressableByTestId(screen, 'select-m1').props.accessibilityState).toEqual({ checked: true });
        expect(findPressableByTestId(screen, 'select-m1').props.accessibilityLabel).toBe('assistant: hello from assistant');
        expect(screen.findByType('Ionicons').props.name).toBe('checkbox-outline');
    });

    it('toggles the message when pressed during active selection mode', async () => {
        const screen = await renderButton({ visible: false });

        await act(async () => {
            screen.findByProps({ testID: 'enter-other' }).props.onPress();
        });
        expect(findAllPressablesByTestId(screen, 'select-m1')).toHaveLength(1);
        expect(findPressableByTestId(screen, 'select-m1').props.accessibilityRole).toBe('checkbox');
        const uncheckedSelectionToggle = findPressableByTestId(screen, 'select-m1');
        expect(uncheckedSelectionToggle.props.accessibilityState).toEqual({ checked: false });
        expect(uncheckedSelectionToggle.props.accessibilityLabel).toBe('assistant: hello from assistant');
        expect(resolvePressableStyle(uncheckedSelectionToggle).backgroundColor).toEqual(expect.any(String));
        expect(screen.findByType('Ionicons').props.name).toBe('square-outline');

        await act(async () => {
            findPressableByTestId(screen, 'select-m1').props.onPress();
        });
        expect(screen.findByType('ProbeRoot').props).toMatchObject({ mode: true, count: 2, selected: true });

        await act(async () => {
            findPressableByTestId(screen, 'select-m1').props.onPress();
        });
        expect(screen.findByType('ProbeRoot').props).toMatchObject({ mode: true, count: 1, selected: false });
    });

    it('uses the same native hitSlop contract as transcript action buttons', async () => {
        const screen = await renderButton();

        expect(findPressableByTestId(screen, 'select-m1').props.hitSlop).toBe(15);
    });

    it('enlarges the bottom action affordance only while selection mode is active', async () => {
        const screen = await renderButton();

        expect(findPressableByTestId(screen, 'select-m1').props.hitSlop).toBe(15);
        expect(screen.findByType('Ionicons').props.size).toBe(12);

        await act(async () => {
            findPressableByTestId(screen, 'select-m1').props.onPress();
        });

        const selectionToggle = findPressableByTestId(screen, 'select-m1');
        expect(selectionToggle.props.hitSlop).toBe(22);
        expect(screen.findByType('Ionicons').props.size).toBe(18);
        expect(resolvePressableStyle(selectionToggle)).toMatchObject({
            minHeight: 32,
            minWidth: 32,
        });
    });
});
