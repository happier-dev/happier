import React from 'react';

import { ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) => React.createElement('DropdownMenu', props),
}));

describe('DaemonVoiceInferenceExecutionDropdown', () => {
    it('hides device selection when the surface clamps web execution', async () => {
        const setExecution = vi.fn();
        const { DaemonVoiceInferenceExecutionDropdown } = await import('./DaemonVoiceInferenceExecutionDropdown');

        let tree!: ReactTestRenderer;
        tree = (await renderScreen(
            React.createElement(DaemonVoiceInferenceExecutionDropdown as any, {
                execution: 'device',
                allowDeviceSelection: false,
                setExecution,
                popoverBoundaryRef: null,
            }),
        )).tree;

        const dropdown = tree.root.findByType('DropdownMenu');
        expect(dropdown.props.selectedId).toBe('daemon');
        expect(dropdown.props.items.map((item: { id: string }) => item.id)).toEqual(['auto', 'daemon']);
        expect(dropdown.props.itemTrigger.detailFormatter()).toBe(
            dropdown.props.items.find((item: { id: string }) => item.id === 'daemon')?.title,
        );

        dropdown.props.onSelect('device');

        expect(setExecution).toHaveBeenCalledWith('daemon');
    });
});
