import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

const motionState = vi.hoisted(() => ({
    animatedNumbersEnabled: true,
}));

vi.mock('./motion/useMotionPreferences', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./motion/useMotionPreferences')>();
    return {
        ...actual,
        useMotionPreferences: () => actual.resolveMotionPreferences({
            visualEffectsLevel: motionState.animatedNumbersEnabled ? 'full' : 'minimal',
            animatedNumbers: motionState.animatedNumbersEnabled,
            contextGaugeStyle: 'gauge',
            osReduceMotion: false,
            isWeb: false,
        }),
    };
});

import { AnimatedNumber } from './AnimatedNumber';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const format = (n: number) => `${n}t`;

function render(element: React.ReactElement): ReactTestRenderer {
    let tree: ReactTestRenderer | null = null;
    act(() => {
        tree = create(element);
    });
    if (tree === null) throw new Error('AnimatedNumber test renderer did not mount');
    return tree;
}

function findGlyphs(tree: ReactTestRenderer): ReadonlyArray<{ props: Record<string, unknown> }> {
    return tree.root.findAll((node) => String(node.type) === 'Animated.Text');
}

function findHostByTestId(tree: ReactTestRenderer, testID: string): { props: Record<string, any> } {
    const matches = tree.root.findAll(
        (node) => typeof node.type === 'string' && node.props.testID === testID,
    );
    if (matches.length === 0) throw new Error(`no host node with testID ${testID}`);
    return matches[0]!;
}

describe('AnimatedNumber', () => {
    beforeEach(() => {
        motionState.animatedNumbersEnabled = true;
    });

    it('exposes the full formatted value as the accessibility label and hides digit glyphs', () => {
        const tree = render(<AnimatedNumber value={1234} format={format} testID="an" />);

        const container = findHostByTestId(tree, 'an');
        expect(container.props.accessibilityLabel).toBe('1234t');
        expect(container.props.accessible).toBe(true);

        const hiddenRow = tree.root.findByProps({ accessibilityElementsHidden: true });
        expect(hiddenRow.props.importantForAccessibility).toBe('no-hide-descendants');

        // One incoming glyph per character (5 chars: 1 2 3 4 t).
        const glyphs = findGlyphs(tree);
        expect(glyphs.map((g) => g.props.children).sort()).toEqual(['1', '2', '3', '4', 't']);
    });

    it('renders a plain text swap when animated numbers are disabled', () => {
        motionState.animatedNumbersEnabled = false;
        const tree = render(<AnimatedNumber value={42} format={format} testID="an" />);

        const plain = findHostByTestId(tree, 'an');
        expect(plain.props.accessibilityLabel).toBe('42t');
        expect(findGlyphs(tree)).toHaveLength(0);
    });

    it('starts a roll transition ONLY in the changed digit column', () => {
        const tree = render(<AnimatedNumber value={1234} format={format} testID="an" />);
        expect(findGlyphs(tree)).toHaveLength(5);

        act(() => {
            tree.update(<AnimatedNumber value={1239} format={format} testID="an" />);
        });

        // Exactly one outgoing glyph appears ('4' rolling out) alongside the 5 incoming.
        const glyphs = findGlyphs(tree);
        expect(glyphs).toHaveLength(6);
        const chars = glyphs.map((g) => g.props.children);
        expect(chars.filter((c) => c === '4')).toHaveLength(1);
        expect(chars.filter((c) => c === '9')).toHaveLength(1);
        expect(findHostByTestId(tree, 'an').props.accessibilityLabel).toBe('1239t');
    });

    it('memoized unchanged columns bail out of re-rendering (stable host props identity)', () => {
        const tree = render(<AnimatedNumber value={1234} format={format} testID="an" />);
        const before = findGlyphs(tree).find((g) => g.props.children === '1');
        expect(before).toBeTruthy();
        const beforeProps = before!.props;

        act(() => {
            tree.update(<AnimatedNumber value={1239} format={format} testID="an" />);
        });

        const after = findGlyphs(tree).find((g) => g.props.children === '1');
        expect(after).toBeTruthy();
        // React.memo bail-out leaves the host fiber untouched → identical props object.
        expect(after!.props).toBe(beforeProps);
    });

    it('formatting passthrough uses the provided formatter verbatim', () => {
        const customFormat = vi.fn((n: number) => `~${n.toFixed(1)}k`);
        const tree = render(<AnimatedNumber value={3.14159} format={customFormat} testID="an" />);
        expect(customFormat).toHaveBeenCalledWith(3.14159);
        expect(findHostByTestId(tree, 'an').props.accessibilityLabel).toBe('~3.1k');
    });
});
