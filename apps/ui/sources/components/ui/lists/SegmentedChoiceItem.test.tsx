import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ View: 'View', Pressable: 'Pressable' });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/components/ui/layout/layout', () => ({
    useLayoutMaxWidth: () => 850,
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
}));

afterEach(() => {
    standardCleanup();
    vi.resetModules();
});

const OPTIONS = [
    { id: 'hints', label: 'Light', description: 'Index file names and summaries.' },
    { id: 'deep', label: 'Deep', description: 'Index every message; uses more disk.' },
] as const;

async function renderChoice(props: Readonly<{ value: 'hints' | 'deep'; subtitle?: string; withDescriptions?: boolean }>) {
    const { SegmentedChoiceItem } = await import('./SegmentedChoiceItem');
    const options = props.withDescriptions === false ? OPTIONS.map(({ id, label }) => ({ id, label })) : OPTIONS;
    return renderScreen(
        <SegmentedChoiceItem<'hints' | 'deep'>
            title="Index mode"
            subtitle={props.subtitle}
            options={options}
            value={props.value}
            onChange={() => {}}
        />,
    );
}

function texts(screen: Awaited<ReturnType<typeof renderScreen>>): string[] {
    return screen.findAllByType('Text' as never).map((node) => String(node.props.children));
}

describe('SegmentedChoiceItem', () => {
    it.each([['ios', 44], ['android', 48]] as const)('gives each %s settings choice a non-overlapping platform touch target', async (os, minimum) => {
        const { Platform, StyleSheet } = await import('react-native');
        const previous = Platform.OS;
        Object.defineProperty(Platform, 'OS', { configurable: true, value: os });
        try {
            const { SegmentedChoiceItem } = await import('./SegmentedChoiceItem');
            const screen = await renderScreen(<SegmentedChoiceItem
                title="Index mode" options={OPTIONS} value="hints" onChange={() => {}} testIDPrefix="mode"
            />);
            for (const option of OPTIONS) {
                const frame = screen.findByTestId(`mode:${option.id}`)!;
                const frameStyle = StyleSheet.flatten(frame.props.style);
                const surfaceStyle = StyleSheet.flatten(frame.findAllByType('View' as never)[0]!.props.style);
                expect(frameStyle.minWidth).toBeGreaterThanOrEqual(minimum);
                expect(surfaceStyle.minHeight + frameStyle.paddingVertical * 2).toBeGreaterThanOrEqual(minimum);
            }
        } finally {
            Object.defineProperty(Platform, 'OS', { configurable: true, value: previous });
        }
    });

    it("describes the chosen option under the label, like the dropdown row it replaces", async () => {
        const light = await renderChoice({ value: 'hints', subtitle: 'Fallback' });
        expect(texts(light)).toContain('Index file names and summaries.');
        expect(texts(light)).not.toContain('Index every message; uses more disk.');
        expect(texts(light)).not.toContain('Fallback');
        standardCleanup();

        const deep = await renderChoice({ value: 'deep' });
        expect(texts(deep)).toContain('Index every message; uses more disk.');
    });

    it('keeps its own description when the options carry none', async () => {
        const screen = await renderChoice({ value: 'deep', subtitle: 'How much Happier indexes.', withDescriptions: false });
        expect(texts(screen)).toContain('How much Happier indexes.');
    });

    // A setting's value is a radio choice, not a tab: a tablist promises panels this row never has.
    it('announces its options as a named radio group with the chosen option checked', async () => {
        const { SegmentedChoiceItem } = await import('./SegmentedChoiceItem');
        const screen = await renderScreen(
            <SegmentedChoiceItem<'hints' | 'deep'>
                title="Index mode" options={OPTIONS} value="deep" onChange={() => {}} testIDPrefix="mode"
            />,
        );
        const deep = screen.findByTestId('mode:deep')!;
        const hints = screen.findByTestId('mode:hints')!;
        expect(deep.props.accessibilityRole).toBe('radio');
        expect(deep.props.accessibilityState).toEqual({ checked: true, disabled: false });
        expect(deep.props['aria-checked']).toBe(true);
        expect(deep.props['aria-selected']).toBeUndefined();
        expect(hints.props.accessibilityRole).toBe('radio');
        expect(hints.props.accessibilityState).toEqual({ checked: false, disabled: false });
        expect(hints.props['aria-checked']).toBe(false);

        let group = deep.parent;
        while (group && group.props?.accessibilityRole !== 'radiogroup') group = group.parent;
        expect(group?.props.accessibilityLabel).toBe('Index mode');
        expect(screen.root.findAll((node) => node.props?.accessibilityRole === 'tablist' || node.props?.accessibilityRole === 'tab')).toHaveLength(0);
    });

    it("says why one option can't be chosen: on the segment and in the row", async () => {
        const { SegmentedChoiceItem } = await import('./SegmentedChoiceItem');
        const onChange = vi.fn();
        const screen = await renderScreen(
            <SegmentedChoiceItem<'none' | 'tmux'>
                title="Terminal host"
                options={[
                    { id: 'none', label: 'None' },
                    { id: 'tmux', label: 'tmux', unavailableReason: 'tmux is not detected on this machine.' },
                ]}
                value="none"
                onChange={onChange}
                testIDPrefix="host"
            />,
        );
        const tmux = screen.findByTestId('host:tmux')!;
        expect(tmux.props.accessibilityState).toEqual({ checked: false, disabled: true });
        expect(tmux.props.accessibilityLabel).toBe('tmux, tmux is not detected on this machine.');
        expect(screen.findByTestId('host:none')!.props.accessibilityLabel).toBe('None');
        expect(texts(screen).join(' ')).toContain('tmux is not detected on this machine.');

        screen.pressByTestId('host:tmux');
        expect(onChange).not.toHaveBeenCalled();
    });

    it('shows icon-only segments named by their labels when every option has an icon', async () => {
        const { SegmentedChoiceItem } = await import('./SegmentedChoiceItem');
        const screen = await renderScreen(
            <SegmentedChoiceItem<'light' | 'dark'>
                title="Theme"
                options={[
                    { id: 'light', label: 'Light', icon: React.createElement('Glyph', { name: 'sun' }) },
                    { id: 'dark', label: 'Dark', icon: React.createElement('Glyph', { name: 'moon' }) },
                ]}
                value="light"
                onChange={() => {}}
                testIDPrefix="theme"
            />,
        );
        expect(screen.findAllByType('Glyph' as never).map((node) => node.props.name)).toEqual(['sun', 'moon']);
        expect(texts(screen)).not.toContain('Light');
        expect(screen.findByTestId('theme:dark')?.props.accessibilityLabel).toBe('Dark');
    });

    it('keeps a menu row\'s segmented choice beside its label in a narrow menu, while a narrow page row stacks it', async () => {
        const { SegmentedChoiceItem } = await import('./SegmentedChoiceItem');
        const layout = (width: number) => ({ nativeEvent: { layout: { x: 0, y: 0, width, height: 44 } } });
        const placement = async (rowRole: 'menu' | 'item') => {
            const screen = await renderScreen(<SegmentedChoiceItem title="Width" options={OPTIONS} value="hints" onChange={() => {}} rowRole={rowRole} />);
            const { act } = await import('react-test-renderer');
            const { StyleSheet } = await import('react-native');
            // The row is a narrow 260 pt menu or phone row; the segmented control's natural width is 100 pt.
            await act(async () => {
                for (const node of screen.root.findAll(candidate => typeof candidate.props.onLayout === 'function')) {
                    node.props.onLayout(layout(StyleSheet.flatten(node.props.style)?.flexShrink === 0 ? 100 : 260));
                }
            });
            // The inline accessory keeps its natural width (flexShrink 0); a stacked one spans the row.
            return screen.root.findAll(candidate => typeof candidate.props.onLayout === 'function'
                && StyleSheet.flatten(candidate.props.style)?.flexShrink === 0).length > 0 ? 'inline' : 'stacked';
        };
        expect(await placement('menu')).toBe('inline');
        expect(await placement('item')).toBe('stacked');
    });
});

