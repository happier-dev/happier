import * as React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ScmStatusSummary } from '@/components/sessions/sourceControl/status/statusSummary';

vi.mock('@expo/vector-icons', () => ({
    Octicons: (props: Record<string, unknown>) => React.createElement('Octicons', props, null),
}));
vi.mock('@/components/ui/rendering/normalizeNodeForView', () => ({
    normalizeNodeForView: (node: React.ReactNode) => node,
}));
vi.mock('@/components/ui/theme/haptics', () => ({ hapticsLight: vi.fn() }));
vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Text', props, props.children),
}));
// Focus on the git component's own logic; represent AnimatedNumber by its formatted output.
vi.mock('@/components/instrument', () => ({
    AnimatedNumber: (props: { value: number; format: (n: number) => string; emphasisColor?: string }) =>
        React.createElement('AnimatedNumber', {
            testID: 'animated-number',
            'data-text': props.format(props.value),
            'data-emphasis-color': props.emphasisColor,
        }),
}));
const THEME = vi.hoisted(() => ({
    colors: {
        text: { primary: '#111', secondary: '#888', tertiary: '#aaa' },
        surface: { pressedOverlay: '#eee' },
        border: { default: '#ccc' },
        versionControl: {
            added: { foreground: '#0a0' },
            removed: { foreground: '#a00' },
        },
    },
}));
vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({ theme: THEME }),
    StyleSheet: { create: (factory: (theme: typeof THEME) => unknown) => factory(THEME) },
}));
vi.mock('@/text', () => ({ t: (key: string, params?: Record<string, unknown>) => `${key}:${JSON.stringify(params ?? {})}` }));

import { GitDeltaInstrument } from './GitDeltaInstrument';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function git(overrides: Partial<ScmStatusSummary>): ScmStatusSummary {
    return {
        branch: 'main', upstream: null, ahead: 0, behind: 0,
        changedFiles: 2, linesAdded: 12, linesRemoved: 3,
        hasLineChanges: true, hasAnyChanges: true, ...overrides,
    };
}

function numbers(tree: ReactTestRenderer): Array<{ text: string; color?: string }> {
    return tree.root.findAll((n) => n.props.testID === 'animated-number')
        .map((n) => ({ text: n.props['data-text'], color: n.props['data-emphasis-color'] }));
}

describe('GitDeltaInstrument', () => {
    let tree: ReactTestRenderer | null = null;
    afterEach(() => { act(() => tree?.unmount()); tree = null; });

    it('renders +added and −removed with distinct version-control emphasis colors', () => {
        act(() => { tree = create(<GitDeltaInstrument git={git({})} compact={false} />); });
        const nums = numbers(tree!);
        expect(nums.map((n) => n.text)).toEqual(['+12', '−3']);
        // Added and removed pulse tints come from the distinct versionControl tokens.
        expect(typeof nums[0]!.color).toBe('string');
        expect(typeof nums[1]!.color).toBe('string');
        expect(nums[0]!.color).not.toBe(nums[1]!.color);
    });

    it('renders added-only when there are no removals', () => {
        act(() => { tree = create(<GitDeltaInstrument git={git({ linesRemoved: 0 })} compact={false} />); });
        expect(numbers(tree!).map((n) => n.text)).toEqual(['+12']);
    });

    it('renders the changed-files fallback when there are no line changes', () => {
        act(() => {
            tree = create(
                <GitDeltaInstrument
                    git={git({ linesAdded: 0, linesRemoved: 0, hasLineChanges: false, changedFiles: 4 })}
                    compact={false}
                />,
            );
        });
        expect(numbers(tree!)).toHaveLength(0);
        const texts = tree!.root.findAll((n) => String(n.type) === 'Text');
        expect(texts.some((n) => String(n.props.children).includes('changedFilesLabel'))).toBe(true);
    });

    it('drops the branch icon in compact mode', () => {
        act(() => { tree = create(<GitDeltaInstrument git={git({})} compact />); });
        expect(tree!.root.findAll((n) => String(n.type) === 'Octicons')).toHaveLength(0);
        act(() => { tree!.unmount(); tree = create(<GitDeltaInstrument git={git({})} compact={false} />); });
        expect(tree!.root.findAll((n) => String(n.type) === 'Octicons')).toHaveLength(1);
    });

    it('renders the branch icon alone in a clean repo (no numbers, no files label)', () => {
        // Spec T3.1: visibility gate is useHasMeaningfulScmStatus ("is a repo"),
        // matching the old composer chip which showed a lone branch icon when clean.
        act(() => {
            tree = create(
                <GitDeltaInstrument
                    git={git({ linesAdded: 0, linesRemoved: 0, hasLineChanges: false, changedFiles: 0, hasAnyChanges: false })}
                    compact={false}
                />,
            );
        });
        expect(tree!.root.findAll((n) => String(n.type) === 'Octicons')).toHaveLength(1);
        expect(numbers(tree!)).toHaveLength(0);
        const texts = tree!.root.findAll((n) => String(n.type) === 'Text');
        expect(texts.some((n) => String(n.props.children).includes('changedFilesLabel'))).toBe(false);
    });

    it('keeps the branch icon in a clean repo even in compact mode (never renders empty)', () => {
        act(() => {
            tree = create(
                <GitDeltaInstrument
                    git={git({ linesAdded: 0, linesRemoved: 0, hasLineChanges: false, changedFiles: 0, hasAnyChanges: false })}
                    compact
                />,
            );
        });
        expect(tree!.root.findAll((n) => String(n.type) === 'Octicons')).toHaveLength(1);
    });

    it('invokes onPress when pressed', () => {
        const onPress = vi.fn();
        act(() => { tree = create(<GitDeltaInstrument git={git({})} compact={false} onPress={onPress} />); });
        const pressable = tree!.root.findAll((n) => n.props.testID === 'session-instrument-git')[0];
        act(() => pressable!.props.onPress());
        expect(onPress).toHaveBeenCalledTimes(1);
    });
});
