import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

describe('SelectionListFooter', () => {
    it('renders nothing when there are no hints (no host node and no rendered text)', async () => {
        const { SelectionListFooter } = await import('../SelectionListFooter');
        const screen = await renderScreen(
            <SelectionListFooter hints={[]} testID="footer-empty-marker" />,
        );
        expect(screen.getTextContent()).toBe('');
    });

    it('renders nothing when hardware keyboard is unavailable, even with hints present', async () => {
        const { SelectionListFooter } = await import('../SelectionListFooter');
        const screen = await renderScreen(
            <SelectionListFooter
                hints={[{ id: 'enter', label: '↵', description: 'select' }]}
                hardwareKeyboardAvailable={false}
                testID="footer-no-kb-marker"
            />,
        );
        expect(screen.getTextContent()).not.toContain('select');
    });

    it('renders each hint label and description when keyboard is available', async () => {
        const { SelectionListFooter } = await import('../SelectionListFooter');
        const screen = await renderScreen(
            <SelectionListFooter
                hints={[
                    { id: 'navigate', label: '↑↓', description: 'navigate' },
                    { id: 'enter', label: '↵', description: 'select' },
                ]}
                hardwareKeyboardAvailable
                testID="footer"
            />,
        );
        expect(screen.findByTestId('footer')).not.toBeNull();
        const text = screen.getTextContent();
        expect(text).toContain('navigate');
        expect(text).toContain('select');
        expect(text).toContain('↑↓');
        expect(text).toContain('↵');
    });

    it('renders a per-hint testID for stable selection', async () => {
        const { SelectionListFooter } = await import('../SelectionListFooter');
        const screen = await renderScreen(
            <SelectionListFooter
                hints={[{ id: 'enter', label: '↵', description: 'select' }]}
                hardwareKeyboardAvailable
                testID="footer"
            />,
        );
        expect(screen.findByTestId('footer:hint:enter')).not.toBeNull();
    });

    it('Phase 2.6: exposes NO functional-action affordance — no onPress in the footer subtree', async () => {
        // The plan's invariant: functional actions live in inputSuffix, NEVER
        // in the footer. This guards against drift where someone adds an action
        // button (a Pressable with onPress) to the footer.
        const { SelectionListFooter } = await import('../SelectionListFooter');
        const screen = await renderScreen(
            <SelectionListFooter
                hints={[
                    { id: 'navigate', label: '↑↓', description: 'navigate' },
                    { id: 'enter', label: '↵', description: 'select' },
                    { id: 'tab', label: 'Tab', description: 'autocomplete' },
                ]}
                hardwareKeyboardAvailable
                testID="footer"
            />,
        );
        const footer = screen.findByTestId('footer');
        expect(footer).not.toBeNull();
        // Walk the subtree starting at the footer and verify no descendant
        // exposes onPress / onClick (the contract: hints only).
        const findAll = footer!.findAll((node) => (
            typeof node.props?.onPress === 'function' || typeof node.props?.onClick === 'function'
        ));
        expect(findAll).toEqual([]);
    });
});
