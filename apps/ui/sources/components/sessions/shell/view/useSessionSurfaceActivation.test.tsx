import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderHook, renderScreen } from '@/dev/testkit';
import {
    getSessionSurfaceVisibilitySnapshot,
    isSessionSurfaceVisible,
    setFocusedSessionId,
    resetSessionSurfaceVisibilityForTests,
    useSessionSurfaceVisibilitySnapshot,
} from '@/sync/domains/session/sessionSurfaceVisibility';

const setLastFocusedSessionId = vi.fn();

vi.mock('@/sync/domains/server/serverProfiles', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/sync/domains/server/serverProfiles')>();
    return {
        ...original,
        areServerProfileIdentifiersEquivalent: (leftRaw: string | null | undefined, rightRaw: string | null | undefined) => {
            const left = String(leftRaw ?? '').trim();
            const right = String(rightRaw ?? '').trim();
            if (!left || !right) return false;
            if (left === right) return true;
            return [left, right].sort().join('\u0000') === ['server-actual', 'server-alias'].sort().join('\u0000');
        },
    };
});

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

    it('treats mounted server aliases as visible for realtime routing', async () => {
        const { useSessionSurfaceActivation } = await import('./useSessionSurfaceActivation');
        const hook = await renderHook((props: {
            sessionId: string;
            serverId: string | null;
            surfaceFocused: boolean;
            surfaceVisible: boolean;
            routeAnchor: boolean;
        }) => useSessionSurfaceActivation({
            sessionId: props.sessionId,
            serverId: props.serverId,
            surfaceFocused: props.surfaceFocused,
            surfaceVisible: props.surfaceVisible,
            routeAnchor: props.routeAnchor,
        }), {
            initialProps: {
                sessionId: 'shared-session',
                serverId: 'server-actual',
                surfaceFocused: true,
                surfaceVisible: true,
                routeAnchor: false,
            },
        });

        expect(isSessionSurfaceVisible('shared-session', 'server-actual')).toBe(true);
        expect(isSessionSurfaceVisible('shared-session', 'server-alias')).toBe(true);
        expect(isSessionSurfaceVisible('shared-session', 'server-unrelated')).toBe(false);

        await hook.unmount();
        expect(isSessionSurfaceVisible('shared-session', 'server-alias')).toBe(false);
    });

    it('scopes visible participation to the mounted server', async () => {
        const { useSessionSurfaceActivation } = await import('./useSessionSurfaceActivation');
        const hook = await renderHook((props: {
            sessionId: string;
            serverId: string | null;
            surfaceFocused: boolean;
            surfaceVisible: boolean;
            routeAnchor: boolean;
        }) => useSessionSurfaceActivation({
            sessionId: props.sessionId,
            serverId: props.serverId,
            surfaceFocused: props.surfaceFocused,
            surfaceVisible: props.surfaceVisible,
            routeAnchor: props.routeAnchor,
        }), {
            initialProps: {
                sessionId: 'shared-session',
                serverId: 'server-a',
                surfaceFocused: true,
                surfaceVisible: true,
                routeAnchor: false,
            },
        });

        expect(isSessionSurfaceVisible('shared-session', 'server-a')).toBe(true);
        expect(isSessionSurfaceVisible('shared-session', 'server-b')).toBe(false);

        await hook.rerender({
            sessionId: 'shared-session',
            serverId: 'server-b',
            surfaceFocused: true,
            surfaceVisible: true,
            routeAnchor: false,
        });

        expect(isSessionSurfaceVisible('shared-session', 'server-a')).toBe(false);
        expect(isSessionSurfaceVisible('shared-session', 'server-b')).toBe(true);

        await hook.unmount();
        expect(isSessionSurfaceVisible('shared-session', 'server-b')).toBe(false);
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

    it('keeps a session visible when one retained surface hides while another remains visible', async () => {
        const { useSessionSurfaceActivation } = await import('./useSessionSurfaceActivation');

        function SurfaceParticipant(props: Readonly<{ surfaceVisible: boolean }>) {
            useSessionSurfaceActivation({
                sessionId: 'session-1',
                surfaceFocused: false,
                surfaceVisible: props.surfaceVisible,
                routeAnchor: false,
            });
            return null;
        }

        function SurfaceHarness(props: Readonly<{
            leftVisible: boolean;
            rightVisible: boolean;
        }>) {
            return (
                <>
                    <SurfaceParticipant surfaceVisible={props.leftVisible} />
                    <SurfaceParticipant surfaceVisible={props.rightVisible} />
                </>
            );
        }

        const screen = await renderScreen(<SurfaceHarness leftVisible={true} rightVisible={true} />);
        expect(getSessionSurfaceVisibilitySnapshot().visibleSessionIds).toEqual(['session-1']);

        await screen.update(<SurfaceHarness leftVisible={false} rightVisible={true} />);
        expect(getSessionSurfaceVisibilitySnapshot().visibleSessionIds).toEqual(['session-1']);

        await screen.unmount();
        expect(getSessionSurfaceVisibilitySnapshot().visibleSessionIds).toEqual([]);
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
