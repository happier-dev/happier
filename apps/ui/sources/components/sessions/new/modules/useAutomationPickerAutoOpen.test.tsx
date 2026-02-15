import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { useAutomationPickerAutoOpen } from '@/components/sessions/new/modules/useAutomationPickerAutoOpen';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function TestHarness(props: { enabled: boolean; openParam?: string }) {
    const onOpen = (TestHarness as any).onOpen as () => void;
    const setParams = (TestHarness as any).setParams as (next: Record<string, unknown>) => void;

    useAutomationPickerAutoOpen({
        automationsEnabled: props.enabled,
        openPickerParam: props.openParam,
        onOpenPicker: onOpen,
        clearOpenPickerParam: () => setParams({ automationPicker: undefined }),
    });

    return null;
}

describe('useAutomationPickerAutoOpen', () => {
    it('opens picker once and clears param when requested', async () => {
        const onOpen = vi.fn();
        const setParams = vi.fn();
        (TestHarness as any).onOpen = onOpen;
        (TestHarness as any).setParams = setParams;

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<TestHarness enabled={true} openParam="1" />);
        });

        expect(onOpen).toHaveBeenCalledTimes(1);
        expect(setParams).toHaveBeenCalledWith({ automationPicker: undefined });

        // Re-render should not reopen.
        await act(async () => {
            tree!.update(<TestHarness enabled={true} openParam="1" />);
        });
        expect(onOpen).toHaveBeenCalledTimes(1);
    });

    it('does nothing when feature is disabled', async () => {
        const onOpen = vi.fn();
        const setParams = vi.fn();
        (TestHarness as any).onOpen = onOpen;
        (TestHarness as any).setParams = setParams;

        await act(async () => {
            renderer.create(<TestHarness enabled={false} openParam="1" />);
        });

        expect(onOpen).toHaveBeenCalledTimes(0);
        expect(setParams).toHaveBeenCalledTimes(0);
    });
});

