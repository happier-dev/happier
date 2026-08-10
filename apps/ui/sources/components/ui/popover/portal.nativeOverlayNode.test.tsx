import React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { installPopoverCommonModuleMocks } from './popoverTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installPopoverCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: { OS: 'ios', select: (value: any) => value.ios ?? value.default ?? null },
            View: (props: any) => React.createElement('View', props, props.children),
        });
    },
});

type OverlayPortalDispatch = Readonly<{
    setPortalNode: (id: string, node: React.ReactNode) => void;
    removePortalNode: (id: string) => void;
}>;

/**
 * Mirrors `OverlayPortalProvider` + `OverlayPortalHost`: the registered node lives in host STATE,
 * and the registrar sits in a subtree React can bail out of (as `Popover` does, since the provider
 * renders `props.children`). So a registration costs a host render, but a host render does not by
 * itself re-render the registrar.
 */
function createOverlayPortalHarness(params: Readonly<{
    setPortalNodeSpy: (id: string, node: React.ReactNode) => void;
    removePortalNodeSpy: (id: string) => void;
    renderRegistrar: (overlayPortal: OverlayPortalDispatch) => React.ReactElement;
}>) {
    return function Harness() {
        const [node, setNode] = React.useState<React.ReactNode>(null);
        const overlayPortal = React.useMemo<OverlayPortalDispatch>(() => ({
            setPortalNode: (id, next) => {
                params.setPortalNodeSpy(id, next);
                setNode(() => next);
            },
            removePortalNode: (id) => {
                params.removePortalNodeSpy(id);
                setNode(null);
            },
        }), []);
        const registrar = React.useMemo(() => params.renderRegistrar(overlayPortal), [overlayPortal]);

        return React.createElement('HostRoot', null, registrar, node);
    };
}

describe('useNativeOverlayPortalNode', () => {
    it('registers one stable node per popover and streams new content without re-registering', async () => {
        const { useNativeOverlayPortalNode } = await import('./portal');

        const setPortalNodeSpy = vi.fn();
        const removePortalNodeSpy = vi.fn();
        let setLabel: ((value: string) => void) | null = null;

        function Registrar(props: Readonly<{ overlayPortal: OverlayPortalDispatch }>) {
            const [label, setLabelState] = React.useState('a');
            setLabel = setLabelState;
            useNativeOverlayPortalNode({
                overlayPortal: props.overlayPortal,
                portalId: 'popover-test',
                enabled: true,
                // A brand-new element on every render — exactly what `Popover` produces.
                content: React.createElement('PopoverContent', { label }),
            });
            return null;
        }

        const Harness = createOverlayPortalHarness({
            setPortalNodeSpy,
            removePortalNodeSpy,
            renderRegistrar: (overlayPortal) => React.createElement(Registrar, { overlayPortal }),
        });

        const screen = await renderScreen(React.createElement(Harness));
        await flushHookEffects({ cycles: 2, turns: 4 });

        expect(setPortalNodeSpy).toHaveBeenCalledTimes(1);
        expect(removePortalNodeSpy).not.toHaveBeenCalled();
        expect(screen.tree.root.findByType('PopoverContent' as never).props.label).toBe('a');

        await act(async () => {
            setLabel?.('b');
        });
        await flushHookEffects({ cycles: 2, turns: 4 });

        // The popover re-rendered with new content. Registering that fresh element directly tears the
        // node out of the host's map and puts it back, cloning the map and republishing the
        // overlay-portal context twice for every single popover render.
        expect(setPortalNodeSpy).toHaveBeenCalledTimes(1);
        expect(removePortalNodeSpy).not.toHaveBeenCalled();
        // ...and the host must still show the latest content.
        expect(screen.tree.root.findByType('PopoverContent' as never).props.label).toBe('b');
    });

    it('removes the node when the popover stops portaling', async () => {
        const { useNativeOverlayPortalNode } = await import('./portal');

        const setPortalNodeSpy = vi.fn();
        const removePortalNodeSpy = vi.fn();
        let setEnabled: ((value: boolean) => void) | null = null;

        function Registrar(props: Readonly<{ overlayPortal: OverlayPortalDispatch }>) {
            const [enabled, setEnabledState] = React.useState(true);
            setEnabled = setEnabledState;
            useNativeOverlayPortalNode({
                overlayPortal: props.overlayPortal,
                portalId: 'popover-test',
                enabled,
                content: enabled ? React.createElement('PopoverContent') : null,
            });
            return null;
        }

        const Harness = createOverlayPortalHarness({
            setPortalNodeSpy,
            removePortalNodeSpy,
            renderRegistrar: (overlayPortal) => React.createElement(Registrar, { overlayPortal }),
        });

        const screen = await renderScreen(React.createElement(Harness));
        await flushHookEffects({ cycles: 2, turns: 4 });
        expect(setPortalNodeSpy).toHaveBeenCalledTimes(1);
        expect(screen.tree.root.findAllByType('PopoverContent' as never).length).toBe(1);

        await act(async () => {
            setEnabled?.(false);
        });
        await flushHookEffects({ cycles: 2, turns: 4 });

        expect(removePortalNodeSpy).toHaveBeenCalledWith('popover-test');
        expect(screen.tree.root.findAllByType('PopoverContent' as never).length).toBe(0);
    });
});
