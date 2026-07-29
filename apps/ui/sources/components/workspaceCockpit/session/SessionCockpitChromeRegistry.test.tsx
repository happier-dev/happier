import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

import {
    SessionCockpitChromeRegistryProvider,
    useSessionCockpitBottomChromeHeight,
    useSessionCockpitBottomChromeHeightSetter,
    useSessionCockpitChromeRegister,
    useSessionCockpitChromeRegistration,
    type SessionCockpitChromeRegistration,
} from './SessionCockpitChromeRegistry';
import type { SessionMobileSurface } from './sessionCockpitState';

function RegistrationProbe() {
    const registration = useSessionCockpitChromeRegistration();

    return React.createElement('RegistrationProbe', { registration });
}

function RegisteringBridge(props: Readonly<{
    callbackVersion: string;
    calls: string[];
    activeSurface?: SessionMobileSurface;
}>) {
    const register = useSessionCockpitChromeRegister();
    const switchSurface = React.useCallback((surface: SessionMobileSurface) => {
        props.calls.push(`${props.callbackVersion}:switch:${surface}`);
    }, [props.callbackVersion, props.calls]);

    React.useEffect(() => register({
        sessionId: 'session-1',
        activeSurface: props.activeSurface ?? 'chat',
        terminalTabAvailable: true,
        openDetailsTabCount: 0,
        switchSurface,
    }), [props.activeSurface, register, switchSurface]);

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
    activeSurface?: SessionMobileSurface;
    registerOnlyRenderCount?: { current: number };
    bottomChromeHeights?: number[];
}>) {
    return (
        <SessionCockpitChromeRegistryProvider>
            <RegisteringBridge activeSurface={props.activeSurface} callbackVersion={props.callbackVersion} calls={props.calls} />
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
