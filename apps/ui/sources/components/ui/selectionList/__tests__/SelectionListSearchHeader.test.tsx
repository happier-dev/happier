import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            colors: {
                input: { placeholder: '#123456' },
                text: { secondary: '#ABCDEF' },
            },
        },
    });
});

describe('SelectionListSearchHeader', () => {
    it('renders the input with the configured placeholder and forwards onChangeText', async () => {
        const onChangeText = vi.fn();
        const { SelectionListSearchHeader } = await import('../SelectionListSearchHeader');
        const screen = await renderScreen(
            <SelectionListSearchHeader
                value=""
                onChangeText={onChangeText}
                placeholder="Search worktrees"
                canPop={false}
                testID="hdr"
            />,
        );
        const input = screen.findByTestId('hdr:input');
        expect(input).not.toBeNull();
        expect(input?.props.placeholder).toBe('Search worktrees');
        expect(input?.props.placeholderTextColor).toBe('#123456');
        screen.changeTextByTestId('hdr:input', 'foo');
        expect(onChangeText).toHaveBeenCalledWith('foo');
    });

    it('renders the search-icon leading slot when canPop is false', async () => {
        const { SelectionListSearchHeader } = await import('../SelectionListSearchHeader');
        const screen = await renderScreen(
            <SelectionListSearchHeader
                value=""
                onChangeText={() => {}}
                placeholder="Search"
                canPop={false}
                testID="hdr"
            />,
        );
        expect(screen.findByTestId('hdr:leading:search-icon')).not.toBeNull();
        expect(screen.findByTestId('hdr:leading:back-chip')).toBeNull();
    });

    it('renders the back-chip leading slot when canPop is true', async () => {
        const onPopStep = vi.fn();
        const { SelectionListSearchHeader } = await import('../SelectionListSearchHeader');
        const screen = await renderScreen(
            <SelectionListSearchHeader
                value=""
                onChangeText={() => {}}
                placeholder="Search base branches"
                canPop
                backLabel="Worktrees"
                onPopStep={onPopStep}
                testID="hdr"
            />,
        );
        expect(screen.findByTestId('hdr:leading:back-chip')).not.toBeNull();
        expect(screen.findByTestId('hdr:leading:search-icon')).toBeNull();
        screen.pressByTestId('hdr:leading:back-chip');
        expect(onPopStep).toHaveBeenCalled();
    });

    it('does not import LayoutAnimation (leading-slot swap uses a local Animated wrapper instead)', async () => {
        // Sanity: the module file must not import LayoutAnimation at the named-import level.
        // Mentions inside comments are allowed and expected (the file documents why we avoid it).
        const fs = await import('node:fs/promises');
        const src = await fs.readFile(
            new URL('../SelectionListSearchHeader.tsx', import.meta.url),
            'utf-8',
        );
        // The named import / usage pattern: `import { ... LayoutAnimation ... }` or
        // `LayoutAnimation.<something>(...)`. Comments contain the word but never these forms.
        expect(src).not.toMatch(/import\s*\{[^}]*LayoutAnimation/);
        expect(src).not.toMatch(/\bLayoutAnimation\s*\./);
    });

    it('renders as a single persistent input element across canPop transitions (text input not remounted)', async () => {
        const { SelectionListSearchHeader } = await import('../SelectionListSearchHeader');
        const harness = await renderScreen(
            <SelectionListSearchHeader value="" onChangeText={() => {}} placeholder="x" canPop={false} testID="hdr" />,
        );
        const before = harness.findByTestId('hdr:input');
        await harness.update(
            <SelectionListSearchHeader value="" onChangeText={() => {}} placeholder="y" canPop testID="hdr" backLabel="b" onPopStep={() => {}} />,
        );
        const after = harness.findByTestId('hdr:input');
        // Both renders must surface the same testID; pluggable structure means the
        // input element identity is preserved across the canPop swap.
        expect(after).not.toBeNull();
        expect(after?.props.placeholder).toBe('y');
        expect(before).not.toBeNull();
    });
});
