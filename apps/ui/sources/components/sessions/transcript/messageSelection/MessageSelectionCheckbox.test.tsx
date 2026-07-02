import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { MessageSelectionCheckbox } from './MessageSelectionCheckbox';
import { TranscriptMessageSelectionProvider, useTranscriptSelectionActions } from './TranscriptMessageSelectionContext';

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

function CheckboxHarness() {
    const actions = useTranscriptSelectionActions();
    return (
        <>
            <ProbeButton testID="enter-other" onPress={() => actions.enter('m2')} />
            <MessageSelectionCheckbox
                messageId="m1"
                role="assistant"
                previewText="Assistant response preview"
                testID="checkbox-m1"
            />
        </>
    );
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

async function pressByTestId(screen: Awaited<ReturnType<typeof renderScreen>>, testID: string): Promise<void> {
    await act(async () => {
        findPressableByTestId(screen, testID).props.onPress();
    });
}

async function renderCheckbox() {
    return renderScreen(
        <TranscriptMessageSelectionProvider sessionId="s1" eligibleMessageIdsInOrder={['m1', 'm2']}>
            <CheckboxHarness />
        </TranscriptMessageSelectionProvider>,
    );
}

describe('MessageSelectionCheckbox', () => {
    it('is hidden outside a selection provider', async () => {
        const screen = await renderScreen(
            <MessageSelectionCheckbox
                messageId="m1"
                role="assistant"
                previewText="Assistant response preview"
                testID="checkbox-m1"
            />,
        );

        expect(findAllPressablesByTestId(screen, 'checkbox-m1')).toHaveLength(0);
    });

    it('is hidden when selection mode is inactive', async () => {
        const screen = await renderCheckbox();

        expect(findAllPressablesByTestId(screen, 'checkbox-m1')).toHaveLength(0);
    });

    it('renders unchecked and toggles to checked when pressed', async () => {
        const screen = await renderCheckbox();

        await pressByTestId(screen, 'enter-other');
        const unchecked = findPressableByTestId(screen, 'checkbox-m1');
        expect(unchecked.props.accessibilityRole).toBe('checkbox');
        expect(unchecked.props.accessibilityState).toEqual({ checked: false });
        expect(resolvePressableStyle(unchecked).backgroundColor).toEqual(expect.any(String));
        expect(screen.findByType('Ionicons').props.name).toBe('square-outline');

        await pressByTestId(screen, 'checkbox-m1');

        expect(findPressableByTestId(screen, 'checkbox-m1').props.accessibilityState).toEqual({ checked: true });
        expect(screen.findByType('Ionicons').props.name).toBe('checkbox-outline');
    });

    it('uses a role and truncated preview in the accessibility label', async () => {
        const screen = await renderCheckbox();

        await pressByTestId(screen, 'enter-other');

        expect(findPressableByTestId(screen, 'checkbox-m1').props.accessibilityLabel).toContain('assistant');
        expect(findPressableByTestId(screen, 'checkbox-m1').props.accessibilityLabel).toContain('Assistant response preview');
    });
});
