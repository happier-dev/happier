import React from 'react';

import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';

afterEach(standardCleanup);

describe('DaemonVoiceInferenceExecutionChoice', () => {
    it('offers only the places this surface can run, as one segmented choice', async () => {
        const setExecution = vi.fn();
        const { DaemonVoiceInferenceExecutionChoice } = await import('./DaemonVoiceInferenceExecutionChoice');

        const { tree } = await renderScreen(
            React.createElement(DaemonVoiceInferenceExecutionChoice, {
                execution: 'device',
                allowDeviceSelection: false,
                setExecution,
            }),
        );

        const segmented = tree.root.findByType(SegmentedChoiceItem);
        expect(segmented.props.value).toBe('daemon');
        expect(segmented.props.options.map((option: { id: string }) => option.id)).toEqual(['auto', 'daemon']);

        await act(async () => { segmented.props.onChange('auto'); });
        expect(setExecution).toHaveBeenCalledWith('auto');
    });
});
