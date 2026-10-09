import { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import type { TranscriptRowLayoutMutation } from '@/components/sessions/transcript/measurement/TranscriptRowLayoutMutationContext';
import { useTranscriptToolCallsExpansionState } from './useTranscriptToolCallsExpansionState';

describe('tool-call disclosure visibility', () => {
    it('collapses on hide through the viewport seam, then permits explicit local reveal', async () => {
        const mutations: TranscriptRowLayoutMutation[] = [];
        const expandedSizesAtPreparation: number[] = [];
        let readExpandedSize = () => 0;
        const params = { showToolCalls: true,
            prepareExpansionStateChange: (mutation: TranscriptRowLayoutMutation) => {
                mutations.push(mutation);
                expandedSizesAtPreparation.push(readExpandedSize());
            } };
        const hook = await renderHook((input: typeof params) => useTranscriptToolCallsExpansionState(input), { initialProps: params });
        readExpandedSize = () => hook.getCurrent().expandedToolCallsAnchorMessageIds.size;
        await act(async () => { hook.getCurrent().applyToolCallsGroupExpanded({
            toolCallsGroupId: 'tools', toolMessageIds: ['tool-1', 'tool-2'], expanded: true,
        }); });
        expect(hook.getCurrent().expandedToolCallsAnchorMessageIds.size).toBe(1);
        await hook.rerender({ ...params, showToolCalls: false });
        expect(hook.getCurrent().expandedToolCallsAnchorMessageIds.size).toBe(0);
        expect(mutations.some((mutation) => mutation.reason === 'collapse')).toBe(true);
        expect(expandedSizesAtPreparation).toEqual([1]);
        await act(async () => { hook.getCurrent().setToolCallsGroupExpanded({
            toolCallsGroupId: 'tools', toolMessageIds: ['tool-1', 'tool-2'], expanded: true,
        }); });
        await hook.rerender({ ...params, showToolCalls: false });
        expect(hook.getCurrent().expandedToolCallsAnchorMessageIds.has('tool-2')).toBe(true);
        await hook.unmount();
    });
});
