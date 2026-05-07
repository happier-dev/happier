import { describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';
import { useFullscreenDetailsRouteParamSync } from './useFullscreenDetailsRouteParamSync';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type HookInput = Readonly<{
    routeSelectionSignature: string;
    selectedSelectionSignature: string;
    hasRouteSelection: boolean;
    hasSelectedSelection: boolean;
    onApplyRouteSelection: () => void;
    onWriteSelectedSelection: () => void;
}>;

function useHarness(props: HookInput) {
    useFullscreenDetailsRouteParamSync({
        resetKey: 'scope-1',
        enabled: true,
        isFocused: true,
        hydrated: true,
        ...props,
    });
    return null;
}

describe('useFullscreenDetailsRouteParamSync', () => {
    it('applies a route selection before writing selected state back to the route', async () => {
        const applyRouteSelection = vi.fn();
        const writeSelectedSelection = vi.fn();

        const screen = await renderHook(useHarness, {
            initialProps: {
                routeSelectionSignature: 'file|README.md||',
                selectedSelectionSignature: 'file|OTHER.md||',
                hasRouteSelection: true,
                hasSelectedSelection: true,
                onApplyRouteSelection: applyRouteSelection,
                onWriteSelectedSelection: writeSelectedSelection,
            },
        });

        expect(applyRouteSelection).toHaveBeenCalledTimes(1);
        expect(writeSelectedSelection).not.toHaveBeenCalled();

        await screen.rerender({
            routeSelectionSignature: 'file|README.md||',
            selectedSelectionSignature: 'file|README.md||',
            hasRouteSelection: true,
            hasSelectedSelection: true,
            onApplyRouteSelection: applyRouteSelection,
            onWriteSelectedSelection: writeSelectedSelection,
        });

        expect(writeSelectedSelection).not.toHaveBeenCalled();
    });

    it('writes a selected route selection when there is no pending route application', async () => {
        const applyRouteSelection = vi.fn();
        const writeSelectedSelection = vi.fn();

        const screen = await renderHook(useHarness, {
            initialProps: {
                routeSelectionSignature: 'file|README.md||',
                selectedSelectionSignature: 'file|README.md||',
                hasRouteSelection: true,
                hasSelectedSelection: true,
                onApplyRouteSelection: applyRouteSelection,
                onWriteSelectedSelection: writeSelectedSelection,
            },
        });

        expect(applyRouteSelection).not.toHaveBeenCalled();
        expect(writeSelectedSelection).not.toHaveBeenCalled();

        await screen.rerender({
            routeSelectionSignature: 'file|README.md||',
            selectedSelectionSignature: 'commit||abc1234|',
            hasRouteSelection: true,
            hasSelectedSelection: true,
            onApplyRouteSelection: applyRouteSelection,
            onWriteSelectedSelection: writeSelectedSelection,
        });

        expect(applyRouteSelection).not.toHaveBeenCalled();
        expect(writeSelectedSelection).toHaveBeenCalledTimes(1);
    });
});
