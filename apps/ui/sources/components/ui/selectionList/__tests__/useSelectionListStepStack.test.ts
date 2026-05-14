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

    it('resetTo replaces the stack with a single new root and reports direction = replace', async () => {
        const harness = await renderHook(() => useSelectionListStepStack(root));
        await act(async () => { harness.getCurrent().pushStep(branchStep); });
        await act(async () => { harness.getCurrent().pushStep(leafStep); });
        const replacement: SelectionListStep = { id: 'new-root', sections: [] };
        await act(async () => { harness.getCurrent().resetTo(replacement); });
        const api = harness.getCurrent();
        expect(api.state.stack).toEqual([replacement]);
        expect(api.state.direction).toBe('replace');
        expect(api.canPop).toBe(false);
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
