import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it } from 'vitest';

// This geometry owner needs only the canonical renderer; the all-fixture barrel loads unrelated Action catalogs.
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';

import {
    SessionCockpitChromeRegistryProvider,
    useSessionCockpitBottomChromeHeight,
    useSessionCockpitBottomChromeHeightSetter,
    useSessionCockpitComposerBottomChromeHeight,
    useReportSessionCockpitFloatingBottomChromeHeight,
    useSessionCockpitChromeRegister,
    useSessionCockpitChromeRegistration,
    type SessionCockpitChromeRegistration,
} from './SessionCockpitChromeRegistry';
import type { SessionMobileSurface } from './sessionCockpitState';
import type { FrameRect } from '@happier-dev/plugin-ui/presentation';
import {
    useReportSessionCockpitViewerRect,
    useSessionCockpitViewerRect,
    useSessionCockpitVoicePresenceRect,
    useReportSessionCockpitVoicePresenceRect,
    useSessionCockpitPetRect,
    useReportSessionCockpitPetRect,
} from './SessionCockpitChromeRegistry';

function ViewerMeasurement(props: Readonly<{
    sessionId: string; serverId: string; rect: FrameRect | null; enabled: boolean;
    reports: Array<(rect: FrameRect | null) => void>;
}>) {
    const report = useReportSessionCockpitViewerRect({ sessionId: props.sessionId, serverId: props.serverId }, props.enabled);
    React.useEffect(() => { props.reports.push(report); report(props.rect); }, [props.rect, props.reports, report]);
    return null;
}

function PresenceMeasurement(props: Readonly<{ rect: FrameRect | null }>) {
    const report = useReportSessionCockpitVoicePresenceRect(true);
    React.useEffect(() => { report(props.rect); }, [props.rect, report]);
    return null;
}

function PetMeasurement(props: Readonly<{
    rect: FrameRect | null; enabled?: boolean; reports?: Array<(rect: FrameRect | null) => void>;
}>) {
    const report = useReportSessionCockpitPetRect(props.enabled ?? true);
    React.useEffect(() => { props.reports?.push(report); report(props.rect); }, [props.rect, props.reports, report]);
    return null;
}

function MeasuredRectsProbe() {
    return React.createElement('MeasuredRectsProbe', {
        viewerRect: useSessionCockpitViewerRect(), presenceRect: useSessionCockpitVoicePresenceRect(),
        petRect: useSessionCockpitPetRect(),
    });
}

function RegistrationProbe() {
    const registration = useSessionCockpitChromeRegistration();

    return React.createElement('RegistrationProbe', { registration });
}

function FloatingBandProbe(props: Readonly<{ measuredHeight: number; visible: boolean; heights: number[] }>) {
    const report = useReportSessionCockpitFloatingBottomChromeHeight(props.visible);
    const setBarHeight = useSessionCockpitBottomChromeHeightSetter();
    const height = useSessionCockpitComposerBottomChromeHeight();
    props.heights.push(height);
    React.useEffect(() => { setBarHeight(62); }, [setBarHeight]);
    React.useEffect(() => { report(props.measuredHeight); }, [props.measuredHeight, report]);
    return null;
}

function RegisteringBridge(props: Readonly<{
    callbackVersion: string;
    calls: string[];
    serverId?: string;
    activeSurface?: SessionMobileSurface;
}>) {
    const register = useSessionCockpitChromeRegister();
    const switchSurface = React.useCallback((surface: SessionMobileSurface) => {
        props.calls.push(`${props.callbackVersion}:switch:${surface}`);
    }, [props.callbackVersion, props.calls]);

    React.useEffect(() => register({
        sessionId: 'session-1',
        serverId: props.serverId,
        activeSurface: props.activeSurface ?? 'chat',
        terminalTabAvailable: true,
        openDetailsTabCount: 0,
        switchSurface,
    }), [props.activeSurface, props.serverId, register, switchSurface]);

    return null;
}

function RegisterOnlyProbe(props: Readonly<{ renderCount: { current: number } }>) {
    useSessionCockpitChromeRegister();
    props.renderCount.current += 1;
    return null;
}

function BottomChromeHeightProbe(props: Readonly<{ heights: number[] }>) {
    const height = useSessionCockpitBottomChromeHeight();
    const setHeight = useSessionCockpitBottomChromeHeightSetter();
    props.heights.push(height);

    React.useEffect(() => {
        setHeight(24.6);
    }, [setHeight]);

    return null;
}

function Harness(props: Readonly<{
    callbackVersion: string;
    calls: string[];
    serverId?: string;
    activeSurface?: SessionMobileSurface;
    registerOnlyRenderCount?: { current: number };
    bottomChromeHeights?: number[];
}>) {
    return (
        <SessionCockpitChromeRegistryProvider>
            <RegisteringBridge serverId={props.serverId} activeSurface={props.activeSurface} callbackVersion={props.callbackVersion} calls={props.calls} />
            {props.registerOnlyRenderCount ? <RegisterOnlyProbe renderCount={props.registerOnlyRenderCount} /> : null}
            {props.bottomChromeHeights ? <BottomChromeHeightProbe heights={props.bottomChromeHeights} /> : null}
            <RegistrationProbe />
        </SessionCockpitChromeRegistryProvider>
    );
}

function ControlledRegistrationHarness(props: Readonly<{
    calls: string[];
    control: { setSurface: ((surface: SessionMobileSurface) => void) | null };
    registerOnlyRenderCount: { current: number };
}>) {
    const register = useSessionCockpitChromeRegister();
    const cleanupRef = React.useRef<(() => void) | null>(null);
    const switchSurface = React.useCallback((surface: SessionMobileSurface) => {
        props.calls.push(`v1:switch:${surface}`);
    }, [props.calls]);

    const registerSurface = React.useCallback((activeSurface: SessionMobileSurface) => {
        cleanupRef.current?.();
        cleanupRef.current = register({
            sessionId: 'session-1',
            activeSurface,
            terminalTabAvailable: true,
            openDetailsTabCount: 0,
            switchSurface,
        });
    }, [register, switchSurface]);

    React.useEffect(() => {
        props.control.setSurface = registerSurface;
        registerSurface('chat');
        return () => {
            props.control.setSurface = null;
            cleanupRef.current?.();
            cleanupRef.current = null;
        };
    }, [props.control, registerSurface]);

    return (
        <RegisterOnlyProbe renderCount={props.registerOnlyRenderCount} />
    );
}

function readRegistration(screen: Awaited<ReturnType<typeof renderScreen>>): SessionCockpitChromeRegistration {
    const registration = screen.findByType('RegistrationProbe' as never).props.registration;
    if (!registration) {
        throw new Error('Expected session cockpit chrome registration');
    }
    return registration as SessionCockpitChromeRegistration;
}

describe('SessionCockpitChromeRegistry', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('withdraws a viewer obstacle on dock and retires late measurements from the previous Home or Session', async () => {
        const rect = { x: 700, y: 460, width: 286, height: 226 };
        const next = { ...rect, x: 400 };
        const reports: Array<(rect: FrameRect | null) => void> = [];
        const scene = (sessionId: string, serverId: string, enabled: boolean, measured: FrameRect | null) => (
            <SessionCockpitChromeRegistryProvider>
                <ViewerMeasurement sessionId={sessionId} serverId={serverId} enabled={enabled} rect={measured} reports={reports} />
                <MeasuredRectsProbe />
            </SessionCockpitChromeRegistryProvider>
        );
        const screen = await renderScreen(scene('session-a', 'home-a', true, rect));
        try {
            expect(screen.findByType('MeasuredRectsProbe' as never).props.viewerRect).toEqual(rect);
            const retiredReport = reports.at(-1)!;
            await screen.update(scene('session-a', 'home-b', true, next));
            await act(async () => { retiredReport(rect); });
            expect(screen.findByType('MeasuredRectsProbe' as never).props.viewerRect).toEqual(next);
            await screen.update(scene('session-b', 'home-b', true, rect));
            expect(screen.findByType('MeasuredRectsProbe' as never).props.viewerRect).toEqual(rect);
            await screen.update(scene('session-b', 'home-b', false, rect));
            await act(async () => { reports.at(-1)!(next); });
            expect(screen.findByType('MeasuredRectsProbe' as never).props.viewerRect).toBeNull();
        } finally { await screen.unmount(); }
    });

    it('keeps the current measured pair when an outgoing viewer unmounts and clears presence when its shell leaves', async () => {
        const viewer = { x: 700, y: 460, width: 286, height: 226 };
        const presence = { x: 16, y: 600, width: 84, height: 84 };
        const reports: Array<(rect: FrameRect | null) => void> = [];
        const scene = (outgoing: boolean, incoming: boolean, voice: boolean) => <SessionCockpitChromeRegistryProvider>
            {outgoing ? <ViewerMeasurement key="outgoing" sessionId="session-a" serverId="home-a" enabled rect={viewer} reports={reports} /> : null}
            {incoming ? <ViewerMeasurement key="incoming" sessionId="session-b" serverId="home-b" enabled rect={{ ...viewer, x: 400 }} reports={reports} /> : null}
            {voice ? <PresenceMeasurement rect={presence} /> : null}
            <MeasuredRectsProbe />
        </SessionCockpitChromeRegistryProvider>;
        const screen = await renderScreen(scene(true, false, true));
        try {
            const outgoingReport = reports.at(-1)!;
            await screen.update(scene(true, true, true));
            await act(async () => { outgoingReport(viewer); });
            await screen.update(scene(false, true, true));
            expect(screen.findByType('MeasuredRectsProbe' as never).props.viewerRect.x).toBe(400);
            expect(screen.findByType('MeasuredRectsProbe' as never).props.presenceRect).toEqual(presence);
            await screen.update(scene(false, false, false));
            expect(screen.findByType('MeasuredRectsProbe' as never).props.viewerRect).toBeNull();
            expect(screen.findByType('MeasuredRectsProbe' as never).props.presenceRect).toBeNull();
        } finally { await screen.unmount(); }
    });

    it('updates the in-app pet obstacle after settled movement and withdraws it when disabled', async () => {
        const rect = { x: 260, y: 620, width: 92, height: 100 };
        const scene = (pet: FrameRect | null, enabled: boolean) => <SessionCockpitChromeRegistryProvider>
            {enabled ? <PetMeasurement rect={pet} /> : null}
            <MeasuredRectsProbe />
        </SessionCockpitChromeRegistryProvider>;
        const screen = await renderScreen(scene(rect, true));
        try {
            expect(screen.findByType('MeasuredRectsProbe' as never).props.petRect).toEqual(rect);
            await screen.update(scene({ ...rect, x: 24, y: 100 }, true));
            expect(screen.findByType('MeasuredRectsProbe' as never).props.petRect).toEqual({ ...rect, x: 24, y: 100 });
            await screen.update(scene(null, false));
            expect(screen.findByType('MeasuredRectsProbe' as never).props.petRect).toBeNull();
        } finally { await screen.unmount(); }
    });

    it('rejects a retired callback after the same mounted pet publisher is re-enabled', async () => {
        const previous = { x: 260, y: 620, width: 92, height: 100 };
        const fresh = { ...previous, x: 24, y: 100 };
        const reports: Array<(rect: FrameRect | null) => void> = [];
        const scene = (enabled: boolean, rect: FrameRect) => <SessionCockpitChromeRegistryProvider>
            <PetMeasurement enabled={enabled} rect={rect} reports={reports} /><MeasuredRectsProbe />
        </SessionCockpitChromeRegistryProvider>;
        const screen = await renderScreen(scene(true, previous));
        try {
            const retiredReport = reports.at(-1)!;
            await screen.update(scene(false, previous));
            expect(screen.findByType('MeasuredRectsProbe' as never).props.petRect).toBeNull();
            await screen.update(scene(true, fresh));
            expect(screen.findByType('MeasuredRectsProbe' as never).props.petRect).toEqual(fresh);
            await act(async () => { retiredReport(previous); });
            expect(screen.findByType('MeasuredRectsProbe' as never).props.petRect).toEqual(fresh);
        } finally { await screen.unmount(); }
    });

    it('lifts composers by the measured floating band above the bar and releases it when hidden', async () => {
        const heights: number[] = [];
        const scene = (measuredHeight: number, visible: boolean) => (
            <SessionCockpitChromeRegistryProvider>
                <FloatingBandProbe measuredHeight={measuredHeight} visible={visible} heights={heights} />
            </SessionCockpitChromeRegistryProvider>
        );
        const screen = await renderScreen(scene(70, true));
        expect(heights.at(-1)).toBe(132);
        await screen.update(scene(94, true));
        expect(heights.at(-1)).toBe(156);
        await screen.update(scene(94, false));
        expect(heights.at(-1)).toBe(62);
        await screen.unmount();
    });

    it('projects and updates the Home identity when the same session id moves between Homes', async () => {
        const calls: string[] = [];
        const screen = await renderScreen(<Harness serverId="home-a" callbackVersion="a" calls={calls} />);
        const previousHomeRegistration = readRegistration(screen);
        expect(previousHomeRegistration.serverId).toBe('home-a');
        await screen.update(<Harness serverId="home-b" callbackVersion="b" calls={calls} />);
        expect(readRegistration(screen).serverId).toBe('home-b');
        previousHomeRegistration.switchSurface('terminal');
        expect(calls).toEqual([]);
    });

    it('keeps a stable registration object while dispatching to the latest callbacks', async () => {
        const calls: string[] = [];
        const screen = await renderScreen(<Harness callbackVersion="v1" calls={calls} />);
        const firstRegistration = readRegistration(screen);

        await act(async () => {
            firstRegistration.switchSurface('git');
        });
        expect(calls).toEqual(['v1:switch:git']);

        await screen.update(<Harness callbackVersion="v2" calls={calls} />);
        const secondRegistration = readRegistration(screen);

        expect(secondRegistration).toBe(firstRegistration);

        await act(async () => {
            firstRegistration.switchSurface('tabs');
        });
        expect(calls).toEqual([
            'v1:switch:git',
            'v2:switch:tabs',
        ]);
    });

    it('keeps register-only consumers stable when active registration changes', async () => {
        const calls: string[] = [];
        const renderCount = { current: 0 };
        const control: { setSurface: ((surface: SessionMobileSurface) => void) | null } = { setSurface: null };
        const screen = await renderScreen(
            <SessionCockpitChromeRegistryProvider>
                <ControlledRegistrationHarness calls={calls} control={control} registerOnlyRenderCount={renderCount} />
                <RegistrationProbe />
            </SessionCockpitChromeRegistryProvider>,
        );
        const baselineRenderCount = renderCount.current;

        await act(async () => {
            control.setSurface?.('git');
        });

        expect(readRegistration(screen).activeSurface).toBe('git');
        expect(renderCount.current).toBe(baselineRenderCount);
    });

    it('exposes normalized bottom chrome height separately from registration updates', async () => {
        const calls: string[] = [];
        const heights: number[] = [];
        const screen = await renderScreen(<Harness callbackVersion="v1" calls={calls} bottomChromeHeights={heights} />);

        expect(heights).toEqual([0, 25]);

        await screen.update(<Harness activeSurface="git" callbackVersion="v1" calls={calls} bottomChromeHeights={heights} />);
        expect(readRegistration(screen).activeSurface).toBe('git');
        expect(heights).toEqual([0, 25, 25]);
    });

});
