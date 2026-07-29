import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

import { useFullscreenDetailsRouteController } from './useFullscreenDetailsRouteController';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function ControllerHarness({
    onUnmount,
}: {
    onUnmount: () => void;
}) {
    useFullscreenDetailsRouteController({
        resetKey: 'scope-1',
        enabled: true,
        isFocused: true,
        hydrated: true,
        detailsIsOpen: true,
        hasDetails: true,
        onDismissRoute: () => {},
        onCloseDetails: () => {},
        onUnmount,
    });
    return null;
}

describe('useFullscreenDetailsRouteController', () => {
    it('does not run unmount cleanup during ordinary rerenders when callback identity changes', async () => {
        const firstUnmount = vi.fn();
        const secondUnmount = vi.fn();
        const screen = await renderScreen(<ControllerHarness onUnmount={firstUnmount} />);

        await screen.update(<ControllerHarness onUnmount={secondUnmount} />);

        expect(firstUnmount).not.toHaveBeenCalled();
        expect(secondUnmount).not.toHaveBeenCalled();

        standardCleanup();

        expect(firstUnmount).not.toHaveBeenCalled();
        expect(secondUnmount).toHaveBeenCalledTimes(1);
    });
});
