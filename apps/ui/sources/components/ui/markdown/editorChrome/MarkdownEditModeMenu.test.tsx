import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import type { DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

// Capture the items/onSelect the menu hands to the DropdownMenu so we can assert
// the Raw/Rich options + disabled-reason wiring without booting the popover.
const dropdownSpy = vi.hoisted(() => ({
    items: null as DropdownMenuItem[] | null,
    selectedId: undefined as string | undefined,
    onSelect: null as ((id: string) => void) | null,
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', async () => {
    const React = await import('react');
    return {
        DropdownMenu: (props: any) => {
            dropdownSpy.items = props.items;
            dropdownSpy.selectedId = props.selectedId;
            dropdownSpy.onSelect = props.onSelect;
            return props.trigger({ toggle: () => {} });
        },
    };
});

import { MarkdownEditModeMenu } from './MarkdownEditModeMenu';

function itemById(id: string): DropdownMenuItem | undefined {
    return dropdownSpy.items?.find((item) => item.id === id);
}

describe('MarkdownEditModeMenu', () => {
    it('offers raw and rich options with stable testIDs', async () => {
        await renderScreen(
            <MarkdownEditModeMenu mode="raw" onChange={vi.fn()} richEligible={true} />,
        );
        expect(itemById('raw')?.testID).toBe('dropdown-option-raw');
        expect(itemById('rich')?.testID).toBe('dropdown-option-rich');
    });

    it('enables the rich option when eligible', async () => {
        await renderScreen(
            <MarkdownEditModeMenu mode="raw" onChange={vi.fn()} richEligible={true} />,
        );
        expect(itemById('rich')?.disabled).not.toBe(true);
        expect(itemById('rich')?.subtitle).toBeUndefined();
    });

    it('disables the rich option and surfaces the reason copy when ineligible', async () => {
        await renderScreen(
            <MarkdownEditModeMenu
                mode="raw"
                onChange={vi.fn()}
                richEligible={false}
                richDisabledReason="footnotes"
            />,
        );
        expect(itemById('rich')?.disabled).toBe(true);
        expect(itemById('rich')?.subtitle).toBe(
            'settingsSourceControl.markdownEditMode.disabledReason.footnotes',
        );
    });

    it('reports the active mode as the selected id', async () => {
        await renderScreen(
            <MarkdownEditModeMenu mode="rich" onChange={vi.fn()} richEligible={true} />,
        );
        expect(dropdownSpy.selectedId).toBe('rich');
    });

    it('reports the EFFECTIVE mode (raw) as selected when rich is the preference but ineligible', async () => {
        await renderScreen(
            <MarkdownEditModeMenu mode="rich" onChange={vi.fn()} richEligible={false} richDisabledReason="html-or-jsx" />,
        );
        // The editor renders Raw when rich is ineligible, so the trigger/selection
        // must read Raw — not the stored 'rich' preference.
        expect(dropdownSpy.selectedId).toBe('raw');
    });

    it('invokes onChange with the chosen mode', async () => {
        const onChange = vi.fn();
        await renderScreen(
            <MarkdownEditModeMenu mode="raw" onChange={onChange} richEligible={true} />,
        );
        dropdownSpy.onSelect?.('rich');
        expect(onChange).toHaveBeenCalledWith('rich');
    });
});
