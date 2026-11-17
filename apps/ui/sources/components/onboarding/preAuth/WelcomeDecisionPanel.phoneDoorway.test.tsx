import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import type { AuthEntryOptions } from '@/components/account/auth/useAuthEntryOptions';

const spies = vi.hoisted(() => ({ show: vi.fn((_config: unknown) => 'modal-id') }));
const viewport = vi.hoisted(() => ({ klass: 'compact' as 'compact' | 'medium' }));

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { show: spies.show } }).module;
});

// The window size is the platform boundary that makes this a phone.
vi.mock('@/utils/platform/useViewportClass', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/utils/platform/useViewportClass')>()),
    useViewportClass: () => viewport.klass,
}));

const firstRunOptions: AuthEntryOptions = {
    homeTarget: null,
    requestedHomeTarget: null,
    homeLabel: null,
    authenticationActions: [],
    serverAvailability: 'ready',
    authEntryUnavailable: false,
    serverUrlForCopy: '',
    showAuthActions: true,
    retryServerCheck: () => {},
} as unknown as AuthEntryOptions;

// Module collection is setup, not part of the phone interaction deadline.
await import('./WelcomeDecisionPanel');

function renderPanel() {
    const onOpenRestore = vi.fn();
    const onConnectHomeDirectly = vi.fn();
    return {
        onOpenRestore,
        onConnectHomeDirectly,
        screenPromise: (async () => {
            const { WelcomeDecisionPanel } = await import('./WelcomeDecisionPanel');
            return await renderScreen(
                <WelcomeDecisionPanel
                    authEntryOptions={firstRunOptions}
                    canScanQr
                    onOpenRestore={onOpenRestore}
                    onChangeRelay={() => {}}
                    onConnectHomeDirectly={onConnectHomeDirectly}
                />,
            );
        })(),
    };
}

describe('WelcomeDecisionPanel on a phone (the Homes doorway)', () => {
    beforeEach(() => {
        spies.show.mockClear();
        viewport.klass = 'compact';
    });

    it('offers scan, sign in with the service, and connecting to a Home directly', async () => {
        const { screenPromise, onOpenRestore } = renderPanel();
        const screen = await screenPromise;
        expect(screen.findByTestId('welcome-doorway-scan')).toBeTruthy();
        expect(screen.findByTestId('welcome-doorway-sign-in')).toBeTruthy();
        expect(screen.findByTestId('welcome-doorway-change-service')).toBeTruthy();
        expect(screen.findByTestId('welcome-doorway-direct')).toBeTruthy();

        await screen.pressByTestIdAsync('welcome-doorway-scan');
        expect(onOpenRestore).toHaveBeenCalledOnce();
        await screen.unmount();
    });

    it('continues to a Home directly as a welcome step, and opens the service ways as sheets', async () => {
        const { screenPromise, onConnectHomeDirectly } = renderPanel();
        const screen = await screenPromise;
        // Owner 11-13: connecting to a Home directly is a step of the welcome, not a sheet over it.
        await screen.pressByTestIdAsync('welcome-doorway-direct');
        expect(onConnectHomeDirectly).toHaveBeenCalledOnce();
        expect(spies.show).not.toHaveBeenCalled();
        await screen.pressByTestIdAsync('welcome-doorway-change-service');
        expect(spies.show).toHaveBeenLastCalledWith(expect.objectContaining({ props: { initialPath: 'other_service' },
            chrome: expect.objectContaining({ testID: 'already-use-happier-sheet' }) }));
        await screen.unmount();
    });

    it('leaves out connecting to a Home directly when the build does not allow Home addresses', async () => {
        const { WelcomeDecisionPanel } = await import('./WelcomeDecisionPanel');
        // The host passes no connect step when setup policy denies custom Home addresses.
        const screen = await renderScreen(<WelcomeDecisionPanel authEntryOptions={firstRunOptions} canScanQr
            onOpenRestore={vi.fn()} onChangeRelay={vi.fn()} />);
        expect(screen.findByTestId('welcome-doorway-scan')).toBeTruthy();
        expect(screen.findByTestId('welcome-doorway-direct')).toBeNull();
        viewport.klass = 'medium';
        const wide = await renderScreen(<WelcomeDecisionPanel authEntryOptions={firstRunOptions} canScanQr
            onOpenRestore={vi.fn()} onChangeRelay={vi.fn()} />);
        expect(wide.findByTestId('welcome-doorway-scan')).toBeTruthy();
        expect(wide.findByTestId('welcome-doorway-direct')).toBeNull();
        await screen.unmount();
        await wide.unmount();
    });

    it('shows the same first-run doorway on a wider window (one first run on every width)', async () => {
        // UI refinements 11-13 ruling: wide composes the same steps with more room, not a different first screen.
        viewport.klass = 'medium';
        const { screenPromise, onConnectHomeDirectly } = renderPanel();
        const screen = await screenPromise;
        expect(screen.findByTestId('welcome-doorway-scan')).toBeTruthy();
        expect(screen.findByTestId('welcome-scan-existing-home')).toBeFalsy();
        await screen.pressByTestIdAsync('welcome-doorway-direct');
        expect(onConnectHomeDirectly).toHaveBeenCalledOnce();
        await screen.unmount();
    });

    it('offers direct key recovery on a phone at the same verified Home without account sign-in', async () => {
        const { WelcomeDecisionPanel } = await import('./WelcomeDecisionPanel');
        const target = { kind: 'saved_profile' as const, profileRef: 'qa-home' };
        const url = 'https://qa-home.test';
        const authenticate = vi.fn();
        const screen = await renderScreen(<WelcomeDecisionPanel
            authEntryOptions={{ ...firstRunOptions, homeTarget: target, requestedHomeTarget: undefined, homeLabel: 'QA Home',
                serverUrlForCopy: url, observedHomeServerIdentityId: 'srv_qa_home', authenticationActions: [{
                    method: { id: 'key_challenge', enabledActions: [{ id: 'login', mode: 'keyed' }] },
                    action: { id: 'login', mode: 'keyed' }, execution: { kind: 'key_entry' },
                }] }}
            accountServiceEntry={{ effectiveSignInService: { kind: 'no_target_default', endpoint: url }, endpoint: { url, source: 'default' },
                status: 'unsupported', discovery: null, transport: {}, retry: vi.fn() }}
            onContinueWithHomeAuthentication={authenticate} onOpenRestore={vi.fn()} onChangeRelay={vi.fn()} onConnectHomeDirectly={vi.fn()} />);
        expect(screen.findByTestId('welcome-doorway-scan')).toBeNull();
        await screen.pressByTestIdAsync('welcome-provider-primary');
        expect(authenticate).toHaveBeenCalledWith(expect.objectContaining({ execution: { kind: 'key_entry' },
            authority: { purpose: 'home', target } }));
        await screen.unmount();
    });

    it('gives a first visit to a Home that can create a key the 0.2 doors on every width, not the doorway', async () => {
        const { WelcomeDecisionPanel } = await import('./WelcomeDecisionPanel');
        const target = { kind: 'saved_profile' as const, profileRef: 'qa-home' };
        const url = 'https://qa-home.test';
        for (const klass of ['compact', 'medium'] as const) {
            viewport.klass = klass;
            // No Home was requested (no ?server=): the build's own Home, which can generate a key here.
            const screen = await renderScreen(<WelcomeDecisionPanel
                authEntryOptions={{ ...firstRunOptions, homeTarget: target, requestedHomeTarget: null, homeLabel: 'QA Home',
                    serverUrlForCopy: url, authenticationActions: [{
                        method: { id: 'key_challenge', enabledActions: [{ id: 'provision', mode: 'keyed' }, { id: 'login', mode: 'keyed' }] },
                        action: { id: 'provision', mode: 'keyed' }, execution: { kind: 'generated_key' },
                    }, {
                        method: { id: 'key_challenge', enabledActions: [{ id: 'provision', mode: 'keyed' }, { id: 'login', mode: 'keyed' }] },
                        action: { id: 'login', mode: 'keyed' }, execution: { kind: 'key_entry' },
                    }] }}
                onContinueWithHomeAuthentication={vi.fn()} onOpenRestore={vi.fn()} onChangeRelay={vi.fn()} onConnectHomeDirectly={vi.fn()} />);
            expect(screen.findByTestId('welcome-doorway-scan')).toBeNull();
            expect(screen.findByTestId('welcome-primary-start')).toBeTruthy();
            expect(screen.findByTestId('welcome-scan-existing-home')).toBeTruthy();
            await screen.unmount();
        }
    });
});
