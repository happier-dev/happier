import { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';

import { renderHook } from '@/dev/testkit/hooks/renderHook';

import { useSelectionListStepStack } from '../useSelectionListStepStack';
import type { SelectionListStep } from '../_types';

const root: SelectionListStep = { id: 'root', sections: [] };
const branchStep: SelectionListStep = { id: 'branch', sections: [] };
const leafStep: SelectionListStep = { id: 'leaf', sections: [] };

describe('useSelectionListStepStack', () => {
    it('starts with the root step on the stack and direction = replace', async () => {
        const harness = await renderHook(() => useSelectionListStepStack(root));
        const api = harness.getCurrent();
        expect(api.state.stack).toEqual([root]);
        expect(api.state.direction).toBe('replace');
        expect(api.currentStep).toBe(root);
        expect(api.canPop).toBe(false);
    });

    it('pushStep adds to the stack and reports direction = forward', async () => {
        const harness = await renderHook(() => useSelectionListStepStack(root));
        await act(async () => {
            harness.getCurrent().pushStep(branchStep);
        });
        const api = harness.getCurrent();
        expect(api.state.stack).toEqual([root, branchStep]);
        expect(api.state.direction).toBe('forward');
        expect(api.currentStep).toBe(branchStep);
        expect(api.canPop).toBe(true);
    });

    it('popStep removes the top entry and reports direction = backward', async () => {
        const harness = await renderHook(() => useSelectionListStepStack(root));
        await act(async () => { harness.getCurrent().pushStep(branchStep); });
        await act(async () => { harness.getCurrent().popStep(); });
        const api = harness.getCurrent();
        expect(api.state.stack).toEqual([root]);
        expect(api.state.direction).toBe('backward');
        expect(api.canPop).toBe(false);
    });

    it('popStep is a no-op at the root', async () => {
        const harness = await renderHook(() => useSelectionListStepStack(root));
        await act(async () => { harness.getCurrent().popStep(); });
        const api = harness.getCurrent();
        expect(api.state.stack).toEqual([root]);
        expect(api.state.direction).toBe('replace');
    });

    it('adoptRootStep replaces the stack with a single new root when the root is a different step', async () => {
        const harness = await renderHook(() => useSelectionListStepStack(root));
        await act(async () => { harness.getCurrent().pushStep(branchStep); });
        await act(async () => { harness.getCurrent().pushStep(leafStep); });
        const replacement: SelectionListStep = { id: 'new-root', sections: [] };
        await act(async () => { harness.getCurrent().adoptRootStep(replacement); });
        const api = harness.getCurrent();
        expect(api.state.stack).toEqual([replacement]);
        expect(api.state.direction).toBe('replace');
        expect(api.canPop).toBe(false);
    });

    /**
     * Consumers rebuild their whole step tree whenever any input moves (the worktree
     * picker does it once a minute so relative-time labels stay fresh). That rebuild
     * carries the same root step id because it describes the same destination, so it
     * must refresh the root in place instead of throwing the user out of a pushed step.
     */
    it('adoptRootStep swaps the root entry in place and keeps pushed steps when the root id is unchanged', async () => {
        const harness = await renderHook(() => useSelectionListStepStack(root));
        await act(async () => { harness.getCurrent().pushStep(branchStep); });
        await act(async () => { harness.getCurrent().pushStep(leafStep); });
        const rebuiltRoot: SelectionListStep = { id: root.id, sections: [] };
        await act(async () => { harness.getCurrent().adoptRootStep(rebuiltRoot); });
        const api = harness.getCurrent();
        expect(api.state.stack).toEqual([rebuiltRoot, branchStep, leafStep]);
        expect(api.currentStep).toBe(leafStep);
        expect(api.canPop).toBe(true);
        // Nothing about the visible step changed, so the cross-slide must not be
        // handed a fresh 'replace' to choreograph.
        expect(api.state.direction).toBe('forward');
    });

    it('adoptRootStep is a fixpoint when handed the root the stack already holds', async () => {
        const harness = await renderHook(() => useSelectionListStepStack(root));
        await act(async () => { harness.getCurrent().pushStep(branchStep); });
        const before = harness.getCurrent().state;
        await act(async () => { harness.getCurrent().adoptRootStep(root); });
        expect(harness.getCurrent().state).toBe(before);
    });

    it('chains push → pop → push and reports the latest direction each time', async () => {
        const harness = await renderHook(() => useSelectionListStepStack(root));
        await act(async () => { harness.getCurrent().pushStep(branchStep); });
        expect(harness.getCurrent().state.direction).toBe('forward');
        await act(async () => { harness.getCurrent().popStep(); });
        expect(harness.getCurrent().state.direction).toBe('backward');
        await act(async () => { harness.getCurrent().pushStep(leafStep); });
        expect(harness.getCurrent().state.direction).toBe('forward');
        expect(harness.getCurrent().currentStep).toBe(leafStep);
    });
});
