import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderScreen } from '@/dev/testkit';
import { installPopoverCommonModuleMocks } from './popoverTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installPopoverCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            StyleSheet: {
                absoluteFill: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
            },
            View: (props: any) => React.createElement('View', props, props.children),
        });
    },
});

describe('OverlayPortalProvider', () => {
    it('does not re-render its children when portal nodes change', async () => {
        const { OverlayPortalHost, OverlayPortalProvider, useOverlayPortal } = await import('./OverlayPortal');

        let renderCount = 0;
        let dispatch: ReturnType<typeof useOverlayPortal> | null = null;
        const portalTestId = 'overlay-portal-node';

        function RenderCountChild() {
            renderCount += 1;
            return React.createElement('RenderCountChild');
        }

        function CaptureDispatch() {
            dispatch = useOverlayPortal();
            return React.createElement('CaptureDispatch');
        }

        const screen = await renderScreen(React.createElement(
            OverlayPortalProvider,
            null,
            React.createElement(RenderCountChild),
            React.createElement(CaptureDispatch),
            React.createElement(OverlayPortalHost),
        ));

        expect(renderCount).toBe(1);
        expect(dispatch).toBeTruthy();

        act(() => {
            dispatch?.setPortalNode('test-node', React.createElement('PortalContent', { testID: portalTestId }));
        });

        expect(screen.findByTestId(portalTestId)).toBeTruthy();
        expect(renderCount).toBe(1);
    });

    it('replaces and removes portal nodes without re-rendering provider children', async () => {
        const { OverlayPortalHost, OverlayPortalProvider, useOverlayPortal } = await import('./OverlayPortal');

        let renderCount = 0;
        let dispatch: ReturnType<typeof useOverlayPortal> | null = null;
        const portalTestIdA = 'overlay-portal-node-a';
        const portalTestIdB = 'overlay-portal-node-b';

        function RenderCountChild() {
            renderCount += 1;
            return React.createElement('RenderCountChild');
        }

        function CaptureDispatch() {
            dispatch = useOverlayPortal();
            return React.createElement('CaptureDispatch');
        }

        const screen = await renderScreen(React.createElement(
            OverlayPortalProvider,
            null,
            React.createElement(RenderCountChild),
            React.createElement(CaptureDispatch),
            React.createElement(OverlayPortalHost),
        ));

        expect(renderCount).toBe(1);
        expect(dispatch).toBeTruthy();

        act(() => {
            dispatch?.setPortalNode('test-node', React.createElement('PortalContentA', { testID: portalTestIdA }));
        });
        expect(screen.findByTestId(portalTestIdA)).toBeTruthy();
        expect(renderCount).toBe(1);

        act(() => {
            dispatch?.setPortalNode('test-node', React.createElement('PortalContentB', { testID: portalTestIdB }));
        });
        expect(screen.findByTestId(portalTestIdA)).toBeNull();
        expect(screen.findByTestId(portalTestIdB)).toBeTruthy();
        expect(renderCount).toBe(1);

        act(() => {
            dispatch?.removePortalNode('test-node');
            dispatch?.removePortalNode('missing-node');
        });
        expect(screen.findByTestId(portalTestIdB)).toBeNull();
        expect(renderCount).toBe(1);
    });
});
