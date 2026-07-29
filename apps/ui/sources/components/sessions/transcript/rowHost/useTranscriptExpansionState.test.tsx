import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';

import type { TranscriptRowLayoutMutation } from '@/components/sessions/transcript/measurement/TranscriptRowLayoutMutationContext';

import { useTranscriptExpansionState } from './useTranscriptExpansionState';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

describe('useTranscriptExpansionState', () => {
    it('prepares detached visible-anchor ownership before rendering controlled thinking expanded', async () => {
        const ordering: string[] = [];
        const recordLocalTranscriptInteractionIntent = vi.fn();
        const armVisibleAnchorHold = vi.fn(() => {
            ordering.push('arm-visible-anchor-hold');
        });
        const prepareLocalHeightChange = vi.fn((_mutation: TranscriptRowLayoutMutation) => {
            armVisibleAnchorHold();
            return 'anchor' as const;
        });
        const params = {
            recordLocalTranscriptInteractionIntent,
            prepareLocalHeightChange,
        };
        const hook = await renderHook(() => {
            const expansionState = useTranscriptExpansionState(params);
            ordering.push(
                expansionState.resolveThinkingExpanded('thinking-1')
                    ? 'expanded-state-render'
                    : 'collapsed-state-render',
            );
            return expansionState;
        });
        ordering.length = 0;

        await act(async () => {
            hook.getCurrent().setThinkingExpanded('thinking-1', true);
        });

        expect(prepareLocalHeightChange).toHaveBeenCalledWith({
            reason: 'expand',
            sourceId: 'thinking-1',
        });
        expect(ordering.slice(0, 2)).toEqual([
            'arm-visible-anchor-hold',
            'expanded-state-render',
        ]);
        expect(recordLocalTranscriptInteractionIntent).toHaveBeenCalledTimes(1);

        ordering.length = 0;
        recordLocalTranscriptInteractionIntent.mockClear();
        prepareLocalHeightChange.mockClear();
        await act(async () => {
            hook.getCurrent().setThinkingExpanded('thinking-1', false);
        });

        expect(prepareLocalHeightChange).toHaveBeenCalledWith({
            reason: 'collapse',
            sourceId: 'thinking-1',
        });
        expect(ordering.slice(0, 2)).toEqual([
            'arm-visible-anchor-hold',
            'collapsed-state-render',
        ]);
        expect(recordLocalTranscriptInteractionIntent).toHaveBeenCalledTimes(1);

        await hook.unmount();
    });

    it('keeps pinned-tail ownership across thinking and tool expansion at web bottom', async () => {
        const recordLocalTranscriptInteractionIntent = vi.fn();
        const hook = await renderHook(() => useTranscriptExpansionState({
            recordLocalTranscriptInteractionIntent,
            prepareLocalHeightChange: vi.fn(() => 'bottom' as const),
        }));

        await act(async () => {
            hook.getCurrent().setThinkingExpanded('thinking-1', true);
            hook.getCurrent().setToolCallsGroupExpanded({
                expanded: true,
                toolCallsGroupId: 'tool-group-1',
                toolMessageIds: ['tool-1', 'tool-2'],
            });
        });

        expect(hook.getCurrent().resolveThinkingExpanded('thinking-1')).toBe(true);
        expect(hook.getCurrent().expandedToolCallsAnchorMessageIds.has('tool-2')).toBe(true);
        expect(recordLocalTranscriptInteractionIntent).not.toHaveBeenCalled();

        await hook.unmount();
    });

    it('preserves tool-group expansion through the shared pre-commit preparation seam', async () => {
        const ordering: string[] = [];
        const recordLocalTranscriptInteractionIntent = vi.fn();
        const prepareLocalHeightChange = vi.fn((_mutation: TranscriptRowLayoutMutation) => {
            ordering.push('prepare-local-height-change');
            return 'none' as const;
        });
        const hook = await renderHook(() => {
            const expansionState = useTranscriptExpansionState({
                recordLocalTranscriptInteractionIntent,
                prepareLocalHeightChange,
            });
            if (expansionState.expandedToolCallsAnchorMessageIds.has('tool-2')) {
                ordering.push('expanded-tool-state-render');
            }
            return expansionState;
        });
        ordering.length = 0;

        await act(async () => {
            hook.getCurrent().setToolCallsGroupExpanded({
                expanded: true,
                toolCallsGroupId: 'tool-group-1',
                toolMessageIds: ['tool-1', 'tool-2'],
            });
        });

        expect(prepareLocalHeightChange).toHaveBeenCalledWith({
            reason: 'expand',
            sourceId: 'tool-group-1',
        });
        expect(recordLocalTranscriptInteractionIntent).toHaveBeenCalledTimes(1);
        expect(ordering.slice(0, 2)).toEqual([
            'prepare-local-height-change',
            'expanded-tool-state-render',
        ]);

        await hook.unmount();
    });
});
