import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { SelectionList } from '../SelectionList';
import type { SelectionListStep } from '../_types';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

// A section may close its heading with one quiet destination ("New machine · Presets"): it stays a
// section-owned link beside the title, never a row that competes with the options.
describe('SelectionList section action', () => {
    it('renders the section action on its header and runs it without selecting an option', async () => {
        const onAction = vi.fn();
        const onSelect = vi.fn();
        const step: SelectionListStep = {
            id: 'root',
            inputPlaceholder: 'Search machines',
            emptyStateLabel: 'No matches',
            sections: [{ kind: 'static', id: 'managed', title: 'New machine',
                action: { label: 'Presets', onPress: onAction, testID: 'presets-link' },
                options: [{ id: 'one-off', label: 'One-off machine…' }] }],
        };
        const screen = await renderScreen(
            <SelectionList rootStep={step} onSelect={onSelect} onRequestClose={vi.fn()} disableTransitions testID="sl" />,
        );
        expect(screen.getTextContent()).toContain('Presets');
        const link = screen.tree.findAll(node => node.props?.testID === 'presets-link' && typeof node.props.onPress === 'function')[0]!;
        await act(async () => link.props.onPress());
        expect(onAction).toHaveBeenCalledTimes(1);
        expect(onSelect).not.toHaveBeenCalled();
    });
});
