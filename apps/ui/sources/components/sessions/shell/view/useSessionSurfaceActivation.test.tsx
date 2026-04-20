import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderHook, renderScreen } from '@/dev/testkit';
import {
    getSessionSurfaceVisibilitySnapshot,
    setFocusedSessionId,
    resetSessionSurfaceVisibilityForTests,
    useSessionSurfaceVisibilitySnapshot,
} from '@/sync/domains/session/sessionSurfaceVisibility';

const setLastFocusedSessionId = vi.fn();

vi.mock('@/voice/runtime/voiceTargetStore', () => ({
    useVoiceTargetStore: {
        getState: () => ({
            setLastFocusedSessionId,
        }),
    },
}));

describe('useSessionSurfaceActivation', () => {
    beforeEach(() => {
        resetSessionSurfaceVisibilityForTests();
        setLastFocusedSessionId.mockClear();
    });

    afterEach(() => {
        resetSessionSurfaceVisibilityForTests();
    });

    it('registers visible sessions and updates focus and route-anchor state from the surface inputs', async () => {
        const { useSessionSurfaceActivation } = await import('./useSessionSurfaceActivation');
        const hook = await renderHook((props: {
            sessionId: string;
            surfaceFocused: boolean;
            surfaceVisible: boolean;
            routeAnchor: boolean;
        }) => useSessionSurfaceActivation({
            sessionId: props.sessionId,
            surfaceFocused: props.surfaceFocused,
            surfaceVisible: props.surfaceVisible,
            routeAnchor: props.routeAnchor,
        }), {
            initialProps: {
                sessionId: 'session-1',
                surfaceFocused: true,
                surfaceVisible: true,
                routeAnchor: true,
            },
        });

        expect(getSessionSurfaceVisibilitySnapshot()).toEqual({
            focusedSessionId: 'session-1',
            routeAnchorSessionId: 'session-1',
            visibleSessionIds: ['session-1'],
        });
        expect(setLastFocusedSessionId).toHaveBeenCalledWith('session-1');
        expect(hook.getCurrent().isSurfaceFocused).toBe(true);

        await hook.rerender({
            sessionId: 'session-1',
            surfaceFocused: false,
            surfaceVisible: true,
            routeAnchor: false,
        });

        expect(getSessionSurfaceVisibilitySnapshot()).toEqual({
            focusedSessionId: null,
            routeAnchorSessionId: null,
            visibleSessionIds: ['session-1'],
        });
        expect(hook.getCurrent().isSurfaceFocused).toBe(false);

        await hook.unmount();

        expect(getSessionSurfaceVisibilitySnapshot()).toEqual({
            focusedSessionId: null,
            routeAnchorSessionId: null,
            visibleSessionIds: [],
        });
    });

    it('keeps the returned focus state tied to the surface inputs instead of unrelated global focus churn', async () => {
        const { useSessionSurfaceActivation } = await import('./useSessionSurfaceActivation');
        let renderCount = 0;
        const hook = await renderHook((props: {
            sessionId: string;
            surfaceFocused: boolean;
            surfaceVisible: boolean;
            routeAnchor: boolean;
        }) => {
            renderCount += 1;
            return useSessionSurfaceActivation({
                sessionId: props.sessionId,
                surfaceFocused: props.surfaceFocused,
                surfaceVisible: props.surfaceVisible,
                routeAnchor: props.routeAnchor,
            });
        }, {
            initialProps: {
                sessionId: 'session-1',
                surfaceFocused: true,
                surfaceVisible: true,
                routeAnchor: false,
            },
        });

        expect(renderCount).toBe(1);
        expect(hook.getCurrent().isSurfaceFocused).toBe(true);

        await act(async () => {
            setFocusedSessionId('session-2');
        });

        expect(getSessionSurfaceVisibilitySnapshot().focusedSessionId).toBe('session-2');
        expect(hook.getCurrent().isSurfaceFocused).toBe(true);
        expect(renderCount).toBe(1);

        await hook.unmount();
    });

    it('clears visible participation for retained surfaces that become hidden without unmounting', async () => {
        const { useSessionSurfaceActivation } = await import('./useSessionSurfaceActivation');
        const hook = await renderHook((props: {
            sessionId: string;
            surfaceFocused: boolean;
            surfaceVisible: boolean;
            routeAnchor: boolean;
        }) => useSessionSurfaceActivation({
            sessionId: props.sessionId,
            surfaceFocused: props.surfaceFocused,
            surfaceVisible: props.surfaceVisible,
            routeAnchor: props.routeAnchor,
        }), {
            initialProps: {
                sessionId: 'session-1',
                surfaceFocused: true,
                surfaceVisible: true,
                routeAnchor: false,
            },
        });

        expect(hook.getCurrent().isVisible).toBe(true);
        expect(getSessionSurfaceVisibilitySnapshot().visibleSessionIds).toEqual(['session-1']);

        await hook.rerender({
            sessionId: 'session-1',
            surfaceFocused: false,
            surfaceVisible: false,
            routeAnchor: false,
        });

        expect(hook.getCurrent().isVisible).toBe(false);
        expect(getSessionSurfaceVisibilitySnapshot()).toEqual({
            focusedSessionId: null,
            routeAnchorSessionId: null,
            visibleSessionIds: [],
        });

        await hook.unmount();
    });

    it('can unmount a visible surface while a visibility subscriber is mounted', async () => {
        const { useSessionSurfaceActivation } = await import('./useSessionSurfaceActivation');

        function SurfaceParticipant() {
            useSessionSurfaceActivation({
                sessionId: 'session-1',
                surfaceFocused: true,
                surfaceVisible: true,
                routeAnchor: true,
            });
            return null;
        }

        function SurfaceHarness(props: Readonly<{
            mounted: boolean;
        }>) {
            useSessionSurfaceVisibilitySnapshot();
            if (!props.mounted) {
                return null;
            }
            return <SurfaceParticipant />;
        }

        const screen = await renderScreen(<SurfaceHarness mounted={true} />);
        expect(getSessionSurfaceVisibilitySnapshot()).toEqual({
            focusedSessionId: 'session-1',
            routeAnchorSessionId: 'session-1',
            visibleSessionIds: ['session-1'],
        });

        await expect(screen.update(<SurfaceHarness mounted={false} />)).resolves.toBeUndefined();
        expect(getSessionSurfaceVisibilitySnapshot()).toEqual({
            focusedSessionId: null,
            routeAnchorSessionId: null,
            visibleSessionIds: [],
        });

        await screen.unmount();
    });
});
