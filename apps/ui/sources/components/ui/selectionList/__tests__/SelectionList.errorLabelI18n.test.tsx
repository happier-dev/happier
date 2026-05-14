import * as React from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import type {
    SelectionListDynamicSection,
    SelectionListProps,
    SelectionListStep,
} from '../_types';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

function dynamicStep(section: SelectionListDynamicSection): SelectionListStep {
    return {
        id: 'root',
        inputPlaceholder: 'Search',
        sections: [{ kind: 'dynamic', ...section }],
    };
}

function defaultProps(rootStep: SelectionListStep, overrides: Partial<SelectionListProps> = {}): SelectionListProps {
    return {
        rootStep,
        onSelect: vi.fn(),
        onRequestClose: vi.fn(),
        keyboardHintsEnabled: false,
        disableTransitions: true,
        testID: 'sl',
        ...overrides,
    };
}

beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
});

afterEach(() => {
    vi.useRealTimers();
});

/**
 * R9 — Blocker 5: the dynamic-section error fallback label was hardcoded to
 * the English literal "Something went wrong". Move to t('selectionList.dynamicSectionError').
 */
describe('SelectionList dynamic-section error fallback (R9 blocker 5)', () => {
    it('renders the i18n-keyed error label when the resolver rejects without a message', async () => {
        const { act } = await import('react-test-renderer');
        const { t } = await import('@/text');
        const root = dynamicStep({
            id: 'dyn',
            title: 'DYN',
            debounceMs: 0,
            // Throw an Error with empty message — orchestrator falls back to t(...).
            resolve: async () => {
                throw new Error('');
            },
        });
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(
            <SelectionList {...defaultProps(root)} inputValue="x" />,
        );
        await act(async () => {
            vi.advanceTimersByTime(1);
            await Promise.resolve();
            await Promise.resolve();
        });
        const errorRow = screen.findByTestId('sl:section:dyn:error');
        expect(errorRow).not.toBeNull();
        const expected = t('selectionList.dynamicSectionError');
        expect(typeof expected).toBe('string');
        expect(expected.length).toBeGreaterThan(0);
        expect(screen.getTextContent()).toContain(expected);
    });
});
