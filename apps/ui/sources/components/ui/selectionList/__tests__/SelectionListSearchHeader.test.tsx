import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { t } from '@/text';

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
                border: { strong: '#654321' },
                text: { secondary: '#ABCDEF' },
            },
        },
    });
});

// Cold compilation belongs to collection, outside the per-test interaction timeout.
await import('../SelectionListSearchHeader');

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

    it('exposes the placeholder as the explicit accessible name of the input', async () => {
        const { SelectionListSearchHeader } = await import('../SelectionListSearchHeader');
        const screen = await renderScreen(
            <SelectionListSearchHeader
                value=""
                onChangeText={() => {}}
                placeholder="Search external sessions"
                canPop={false}
                testID="hdr"
            />,
        );
        expect(screen.findByTestId('hdr:input')?.props.accessibilityLabel).toBe('Search external sessions');
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
        const chip = screen.findHostByTestId('hdr:leading:back-chip');
        expect(chip).not.toBeNull();
        expect(screen.findByTestId('hdr:leading:search-icon')).toBeNull();
        // The chip names its destination for sight and for assistive tech.
        expect(screen.getTextContent()).toContain('Worktrees');
        expect(chip?.props.role).toBe('button');
        expect(chip?.props.accessibilityLabel).toBe(t('selectionList.backTo', { label: 'Worktrees' }));
        screen.pressByTestId('hdr:leading:back-chip');
        expect(onPopStep).toHaveBeenCalled();
    });
});
