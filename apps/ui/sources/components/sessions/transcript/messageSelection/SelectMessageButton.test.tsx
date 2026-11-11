import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { TranscriptMessageSelectionProvider, useTranscriptSelectionActions, useTranscriptSelectionRow, useTranscriptSelectionState } from './TranscriptMessageSelectionContext';
import { SelectMessageButton } from './SelectMessageButton';

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
    return screen.find((node) => typeof node.type === 'string' && node.props?.testID === testID && typeof node.props?.onPress === 'function');
}

function findAllPressablesByTestId(screen: Awaited<ReturnType<typeof renderScreen>>, testID: string) {
    return screen.findAllHostsByTestId(testID).filter((node) => typeof node.props.onPress === 'function');
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
        expect(findPressableByTestId(screen, 'select-m1').props.accessibilityState).toMatchObject({ checked: true });
        expect(findPressableByTestId(screen, 'select-m1').props.accessibilityLabel).toBe('assistant: hello from assistant');
        expect(screen.findByType('Icon').props.name).toBe('check-square');
    });

    it('toggles the message when pressed during active selection mode', async () => {
        const screen = await renderButton({ visible: false });

        await act(async () => {
            screen.findByProps({ testID: 'enter-other' }).props.onPress();
        });
        expect(findAllPressablesByTestId(screen, 'select-m1')).toHaveLength(1);
        expect(findPressableByTestId(screen, 'select-m1').props.accessibilityRole).toBe('checkbox');
        const uncheckedSelectionToggle = findPressableByTestId(screen, 'select-m1');
        expect(uncheckedSelectionToggle.props.accessibilityState).toMatchObject({ checked: false });
        expect(uncheckedSelectionToggle.props.accessibilityLabel).toBe('assistant: hello from assistant');
        expect(screen.findByType('Icon').props.name).toBe('square');

        await act(async () => {
            findPressableByTestId(screen, 'select-m1').props.onPress();
        });
        expect(screen.findByType('ProbeRoot').props).toMatchObject({ mode: true, count: 2, selected: true });

        await act(async () => {
            findPressableByTestId(screen, 'select-m1').props.onPress();
        });
        expect(screen.findByType('ProbeRoot').props).toMatchObject({ mode: true, count: 1, selected: false });
    });

    it('keeps the row\'s one glyph size while selecting; selection shows in the glyph, not a bigger one (owner 04)', async () => {
        const { ICON_SIZE } = await import('@/components/ui/icons/Icon');
        const screen = await renderButton();
        expect(screen.findByType('Icon').props).toMatchObject({ name: 'check-circle', size: ICON_SIZE.xs });

        await act(async () => {
            findPressableByTestId(screen, 'select-m1').props.onPress();
        });

        expect(screen.findByType('Icon').props).toMatchObject({ name: 'check-square', size: ICON_SIZE.xs });
    });

    it('names whose message it selects when a thread repeats the action on every message', async () => {
        const screen = await renderButton({ ownerLabel: 'Mei' });
        const label = String(findPressableByTestId(screen, 'select-m1')?.props.accessibilityLabel);
        expect(label).toContain('Mei');
        const plain = await renderButton();
        expect(String(findPressableByTestId(plain, 'select-m1')?.props.accessibilityLabel)).not.toContain('Mei');
    });
});
