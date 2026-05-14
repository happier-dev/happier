import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

import {
    SessionCockpitChromeRegistryProvider,
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
}>) {
    const register = useSessionCockpitChromeRegister();
    const switchSurface = React.useCallback((surface: SessionMobileSurface) => {
        props.calls.push(`${props.callbackVersion}:switch:${surface}`);
    }, [props.callbackVersion, props.calls]);
    const closeCockpit = React.useCallback(() => {
        props.calls.push(`${props.callbackVersion}:close`);
    }, [props.callbackVersion, props.calls]);

    React.useEffect(() => register({
        sessionId: 'session-1',
        activeSurface: 'chat',
        terminalTabAvailable: true,
        switchSurface,
        closeCockpit,
    }), [closeCockpit, register, switchSurface]);

    return null;
}

function Harness(props: Readonly<{
    callbackVersion: string;
    calls: string[];
}>) {
    return (
        <SessionCockpitChromeRegistryProvider>
            <RegisteringBridge callbackVersion={props.callbackVersion} calls={props.calls} />
            <RegistrationProbe />
        </SessionCockpitChromeRegistryProvider>
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
            firstRegistration.closeCockpit();
        });
        expect(calls).toEqual([
            'v1:switch:git',
            'v2:switch:tabs',
            'v2:close',
        ]);
    });
});
