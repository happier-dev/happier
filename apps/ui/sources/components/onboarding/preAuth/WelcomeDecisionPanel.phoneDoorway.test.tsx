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
    return {
        onOpenRestore,
        screenPromise: (async () => {
            const { WelcomeDecisionPanel } = await import('./WelcomeDecisionPanel');
            return await renderScreen(
                <WelcomeDecisionPanel
                    authEntryOptions={firstRunOptions}
                    canScanQr
                    onOpenRestore={onOpenRestore}
                    onChangeRelay={() => {}}
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

    it('opens each way in as its own sheet', async () => {
        const { screenPromise } = renderPanel();
        const screen = await screenPromise;
        await screen.pressByTestIdAsync('welcome-doorway-direct');
        expect(spies.show).toHaveBeenCalledWith(expect.objectContaining({
            props: { initialPath: 'direct' },
            chrome: expect.objectContaining({ testID: 'already-use-happier-sheet' }),
        }));
        await screen.pressByTestIdAsync('welcome-doorway-change-service');
        expect(spies.show).toHaveBeenLastCalledWith(expect.objectContaining({ props: { initialPath: 'other_service' } }));
        await screen.unmount();
    });

    it('keeps the full welcome on a wider window', async () => {
        viewport.klass = 'medium';
        const { screenPromise } = renderPanel();
        const screen = await screenPromise;
        expect(screen.findByTestId('welcome-doorway-scan')).toBeFalsy();
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
            onContinueWithHomeAuthentication={authenticate} onOpenRestore={vi.fn()} onChangeRelay={vi.fn()} />);
        expect(screen.findByTestId('welcome-doorway-scan')).toBeNull();
        await screen.pressByTestIdAsync('welcome-provider-primary');
        expect(authenticate).toHaveBeenCalledWith(expect.objectContaining({ execution: { kind: 'key_entry' },
            authority: { purpose: 'home', target } }));
        await screen.unmount();
    });
});
