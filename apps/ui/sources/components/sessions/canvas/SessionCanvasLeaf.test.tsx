import * as React from 'react';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

const sessionViewSpy = vi.hoisted(() => vi.fn((props: Record<string, unknown>) => React.createElement('SessionView', props)));
const useHydrateSessionForRouteSpy = vi.hoisted(() => vi.fn((
    _sessionId: string,
    _tag: string,
    _options?: { serverId?: string },
) => true));

vi.mock('@/components/sessions/shell/SessionView', () => ({
    SessionView: (props: Record<string, unknown>) => sessionViewSpy(props),
}));

vi.mock('@/hooks/session/useHydrateSessionForRoute', () => ({
    useHydrateSessionForRoute: (sessionId: string, tag: string, options?: { serverId?: string }) =>
        useHydrateSessionForRouteSpy(sessionId, tag, options),
}));

describe('SessionCanvasLeaf', () => {
    afterEach(() => {
        standardCleanup();
        sessionViewSpy.mockClear();
        useHydrateSessionForRouteSpy.mockReset();
        useHydrateSessionForRouteSpy.mockReturnValue(true);
    });

    it('promotes surface interaction back to the owning split leaf', async () => {
        const onSurfaceInteract = vi.fn();
        const { SessionCanvasLeaf } = await import('./SessionCanvasLeaf');

        const screen = await renderScreen(
            <SessionCanvasLeaf
                sessionId="sess_1"
                surfaceFocused={false}
                routeAnchor={false}
                onSurfaceInteract={onSurfaceInteract}
            />,
        );

        const surface = screen.findByTestId('session-canvas-surface-sess_1');
        expect(surface).not.toBeNull();
        expect(surface?.props.accessibilityState).toEqual({ selected: false });
        expect(surface?.props['aria-selected']).toBe(false);

        surface?.props.onPointerDownCapture?.({});
        surface?.props.onTouchStart?.({});
        surface?.props.onFocus?.({});

        expect(onSurfaceInteract).toHaveBeenCalledTimes(3);
        expect(sessionViewSpy).toHaveBeenCalledWith(expect.objectContaining({
            id: 'sess_1',
            surfaceFocusedOverride: false,
            surfaceVisibleOverride: true,
            routeAnchorOverride: false,
        }));
        expect(useHydrateSessionForRouteSpy).toHaveBeenCalledWith(
            'sess_1',
            'SessionCanvasLeaf.ensureSessionVisible',
            undefined,
        );

        await screen.unmount();
    });

    it('exposes an explicit selected aria state for focused leaves', async () => {
        const { SessionCanvasLeaf } = await import('./SessionCanvasLeaf');

        const screen = await renderScreen(
            <SessionCanvasLeaf
                sessionId="sess_2"
                surfaceFocused
                routeAnchor
            />,
        );

        const surface = screen.findByTestId('session-canvas-surface-sess_2');
        expect(surface?.props.accessibilityState).toEqual({ selected: true });
        expect(surface?.props['aria-selected']).toBe(true);
        expect(useHydrateSessionForRouteSpy).toHaveBeenCalledWith(
            'sess_2',
            'SessionCanvasLeaf.ensureSessionVisible',
            undefined,
        );

        await screen.unmount();
    });

    it('passes an explicit route server id into the shared session hydration path', async () => {
        const { SessionCanvasLeaf } = await import('./SessionCanvasLeaf');

        const screen = await renderScreen(
            <SessionCanvasLeaf
                sessionId="sess_3"
                routeServerId="server-route"
                routeAnchor
            />,
        );

        expect(useHydrateSessionForRouteSpy).toHaveBeenCalledWith(
            'sess_3',
            'SessionCanvasLeaf.ensureSessionVisible',
            { serverId: 'server-route' },
        );

        await screen.unmount();
    });

    it('shows a leaf-local loading surface until the session hydration path is ready', async () => {
        useHydrateSessionForRouteSpy.mockReturnValue(false);
        const { SessionCanvasLeaf } = await import('./SessionCanvasLeaf');

        const screen = await renderScreen(
            <SessionCanvasLeaf
                sessionId="sess_loading"
                surfaceFocused={false}
                routeAnchor={false}
            />,
        );

        expect(screen.findByTestId('session-canvas-surface-sess_loading')).not.toBeNull();
        expect(screen.findByTestId('session-canvas-loading-sess_loading')).not.toBeNull();
        expect(sessionViewSpy).not.toHaveBeenCalled();

        await screen.unmount();
    });

    it('passes hidden retained-leaf visibility through to the canonical session view runtime path', async () => {
        const { SessionCanvasLeaf } = await import('./SessionCanvasLeaf');

        const screen = await renderScreen(
            <SessionCanvasLeaf
                sessionId="sess_hidden"
                surfaceFocused={false}
                surfaceVisible={false}
                routeAnchor={false}
            />,
        );

        expect(sessionViewSpy).toHaveBeenCalledWith(expect.objectContaining({
            id: 'sess_hidden',
            surfaceFocusedOverride: false,
            surfaceVisibleOverride: false,
            routeAnchorOverride: false,
        }));

        await screen.unmount();
    });
});
