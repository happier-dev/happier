import * as React from 'react';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import type { SessionRouteHydrationState } from '@/sync/domains/session/sessionRouteHydrationState';

const sessionViewSpy = vi.hoisted(() => vi.fn((props: Record<string, unknown>) => React.createElement('SessionView', props)));
const useHydrateSessionForRouteSpy = vi.hoisted(() => vi.fn((
    _sessionId: string,
    _tag: string,
    _options?: { serverId?: string },
): SessionRouteHydrationState => ({ kind: 'available', sessionId: _sessionId })));

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
        useHydrateSessionForRouteSpy.mockImplementation((sessionId: string): SessionRouteHydrationState => ({ kind: 'available', sessionId }));
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
            routeHydrationState: expect.objectContaining({
                kind: 'available',
                sessionId: 'sess_1',
            }),
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

    it('delegates loading route hydration to the session view so cached transcripts can stay painted', async () => {
        useHydrateSessionForRouteSpy.mockReturnValue({
            kind: 'loading',
            sessionId: 'sess_loading',
            reason: 'store-miss',
        });
        const { SessionCanvasLeaf } = await import('./SessionCanvasLeaf');

        const screen = await renderScreen(
            <SessionCanvasLeaf
                sessionId="sess_loading"
                surfaceFocused={false}
                routeAnchor={false}
            />,
        );

        expect(screen.findByTestId('session-canvas-surface-sess_loading')).not.toBeNull();
        expect(screen.findByTestId('session-canvas-loading-sess_loading')).toBeNull();
        expect(sessionViewSpy).toHaveBeenCalledWith(expect.objectContaining({
            id: 'sess_loading',
            routeHydrationState: expect.objectContaining({
                kind: 'loading',
                sessionId: 'sess_loading',
                reason: 'store-miss',
            }),
        }));

        await screen.unmount();
    });

    it('renders the session view for terminal missing route hydration so the shell can show the missing state', async () => {
        useHydrateSessionForRouteSpy.mockReturnValue({
            kind: 'missing',
            sessionId: 'sess_missing',
            cause: 'not_found',
        });
        const { SessionCanvasLeaf } = await import('./SessionCanvasLeaf');

        const screen = await renderScreen(
            <SessionCanvasLeaf
                sessionId="sess_missing"
                surfaceFocused={false}
                routeAnchor={false}
            />,
        );

        expect(screen.findByTestId('session-canvas-loading-sess_missing')).toBeNull();
        expect(sessionViewSpy).toHaveBeenCalledWith(expect.objectContaining({
            id: 'sess_missing',
            routeHydrationState: expect.objectContaining({
                kind: 'missing',
                sessionId: 'sess_missing',
                cause: 'not_found',
            }),
        }));

        await screen.unmount();
    });

    it('renders the session view for retrying route hydration so the shell can show retry status', async () => {
        useHydrateSessionForRouteSpy.mockReturnValue({
            kind: 'retrying',
            sessionId: 'sess_retrying',
            cause: 'server_unavailable',
        });
        const { SessionCanvasLeaf } = await import('./SessionCanvasLeaf');

        const screen = await renderScreen(
            <SessionCanvasLeaf
                sessionId="sess_retrying"
                surfaceFocused
                routeAnchor
            />,
        );

        expect(screen.findByTestId('session-canvas-loading-sess_retrying')).toBeNull();
        expect(sessionViewSpy).toHaveBeenCalledWith(expect.objectContaining({
            id: 'sess_retrying',
            routeHydrationState: expect.objectContaining({
                kind: 'retrying',
                sessionId: 'sess_retrying',
                cause: 'server_unavailable',
            }),
        }));

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
            routeHydrationState: expect.objectContaining({
                kind: 'available',
                sessionId: 'sess_hidden',
            }),
        }));

        await screen.unmount();
    });
});
