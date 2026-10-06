import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen as renderFixtureScreen } from '@/dev/testkit';
import { AuthProvider } from '@/auth/context/AuthContext';
import { initializeTerminalRouteRuntimeForTests } from '@/__tests__/routes/(app)/terminal/terminalRouteTestHelpers';
import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { installLocalStorageMock, installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { disconnectActiveServerConnection } from '@/sync/runtime/orchestration/connectionManager';
import { createDirectoryHttpFixture } from '@/sync/ops/accountDirectory/accountDirectoryTestFixtures';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import {
    adoptHomeProfile,
    resolveServerProfileScopeId,
    setAccountServiceEndpoint,
} from '@/sync/domains/server/serverProfiles';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { AccountDirectorySession } from '@/sync/domains/accountDirectory/accountDirectorySession';
import { completeAccountServicePostAuth, type AccountPostAuthResult } from '@/sync/ops/accountDirectory/completeAccountServicePostAuth';
import { cancelPendingDirectoryHomeEnrollment, getPendingDirectoryHomeEnrollment } from '@/sync/ops/accountDirectory/enrollDirectoryHome';
import { ENROLLMENT_POLL_IDLE_DELAY_MS } from '@/auth/enrollment/enrollmentPollingBackoff';

installTokenStorageWebPlatformMocks();
const boundary = vi.hoisted(() => ({ request: vi.fn<(endpoint: string, path: string, init?: RequestInit) => Promise<Response>>(
    async () => new Response('{}', { status: 404 }),
) }));
vi.mock('@/utils/system/runtimeFetch', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/utils/system/runtimeFetch')>(),
    runtimeFetch: (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        return boundary.request(url.origin, `${url.pathname}${url.search}`, init);
    },
}));
const routerHarness = vi.hoisted(() => ({ replace: null as null | ReturnType<typeof vi.fn> }));
vi.mock('expo-router', async () => {
    const router = (await import('@/dev/testkit/mocks/router')).createExpoRouterMock();
    routerHarness.replace = router.spies.replace;
    return router.module;
});

vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);

import { AccountServiceContinuation } from './AccountServiceContinuation';
import { Modal } from '@/modal';

await initializeTerminalRouteRuntimeForTests();
function renderScreen(children: React.ReactNode) {
    return renderFixtureScreen(<AuthProvider initialCredentials={null}>{children}</AuthProvider>);
}

/** Non-secret binding to the Account credential a continuation was created under. */
const ACCOUNT_CREDENTIAL_TOKEN_DIGEST = 'C0jknAf55a-WIBFlxj8xId4cq00hoNQDzcbt4__9tlM';

let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
/** The visible label of the card action rendered under `testID`. */
function actionTitle(testID: string): string | undefined {
    return screen?.findAll((node) => node.props.testID === testID && typeof node.props.title === 'string')[0]?.props.title;
}

describe('exact invoking-surface continuation', () => {
    let fixture: ReturnType<typeof createDirectoryHttpFixture>;
    let restore: () => void;
    let locks: ReturnType<typeof installWebLockManagerMock>;
    beforeEach(() => {
        restore = installLocalStorageMock().restore;
        locks = installWebLockManagerMock();
        resetServerFeaturesClientForTests();
        fixture = createDirectoryHttpFixture();
        boundary.request.mockImplementation(fixture.request);
    });
    afterEach(async () => {
        await screen?.unmount();
        screen = undefined;
        await cancelPendingDirectoryHomeEnrollment();
        await disconnectActiveServerConnection();
        resetServerFeaturesClientForTests();
        locks.restore();
        restore();
        vi.unstubAllGlobals();
    });

    it('requests exact service reauthentication rather than treating recovery as Back', async () => {
        const input = { service: fixture.service,
            credentialTokenDigest: ACCOUNT_CREDENTIAL_TOKEN_DIGEST,
            session: new AccountDirectorySession({ endpoint: fixture.service.endpointUrl, serverIdentityId: fixture.service.serverIdentityId }, { capability: fixture.service.capability }),
            intent: { kind: 'enroll' as const, homeServerIdentityId: fixture.home.homeServerIdentityId } };
        let received: unknown;
        screen = await renderScreen(<AccountServiceContinuation input={input}
            result={{ kind: 'failure', stage: 'refresh', code: { source: 'directory', code: 'invalid_token' }, recovery: 'reauthenticate_account', accountCredentialCommitted: true, homeCredentialCommitted: false }}
            onResult={() => {}} onBack={() => {}} onReauthenticate={(value) => { received = value; }} />);
        await screen.pressByTestIdAsync('account-service-continuation-failure-action');
        expect(received).toBe(input);
    });

    it('explains each typed continuation failure with its own copy instead of one enrollment body', async () => {
        const input = { service: fixture.service,
            credentialTokenDigest: ACCOUNT_CREDENTIAL_TOKEN_DIGEST,
            session: new AccountDirectorySession({ endpoint: fixture.service.endpointUrl, serverIdentityId: fixture.service.serverIdentityId }, { capability: fixture.service.capability }),
            intent: { kind: 'enroll' as const, homeServerIdentityId: fixture.home.homeServerIdentityId } };
        screen = await renderScreen(<AccountServiceContinuation input={input}
            result={{ kind: 'failure', stage: 'enroll', code: { source: 'home', code: 'rejected' }, recovery: 'stop', accountCredentialCommitted: true, homeCredentialCommitted: false }}
            onResult={() => {}} onBack={() => {}} />);
        expect(screen.getTextContent()).toContain('A trusted device rejected this request');
        expect(screen.getTextContent()).not.toContain('Open Account settings to continue connecting the Home');
        await screen.unmount();

        screen = await renderScreen(<AccountServiceContinuation input={input}
            result={{ kind: 'failure', stage: 'refresh', code: { source: 'directory', code: 'account-disabled' }, recovery: 'stop', accountCredentialCommitted: true, homeCredentialCommitted: false }}
            onResult={() => {}} onBack={() => {}} />);
        expect(screen.getTextContent()).toContain('This account is disabled');
        expect(screen.getTextContent()).not.toContain('Open Account settings to continue connecting the Home');
    });

    it('offers a rejected approval the same fresh attempt expiry already gets', async () => {
        const input = { service: fixture.service,
            credentialTokenDigest: ACCOUNT_CREDENTIAL_TOKEN_DIGEST,
            session: new AccountDirectorySession({ endpoint: fixture.service.endpointUrl, serverIdentityId: fixture.service.serverIdentityId }, { capability: fixture.service.capability }),
            intent: { kind: 'enroll' as const, homeServerIdentityId: fixture.home.homeServerIdentityId } };
        screen = await renderScreen(<AccountServiceContinuation input={input}
            result={{ kind: 'failure', stage: 'enroll', code: { source: 'home', code: 'rejected' }, recovery: 'stop', accountCredentialCommitted: true, homeCredentialCommitted: false }}
            onResult={() => {}} onBack={() => {}} />);
        expect(screen.getTextContent()).toContain('Start again');
    });

    it('keeps a rejected approval on the fresh-attempt action even when the stage is retryable', async () => {
        const input = { service: fixture.service,
            credentialTokenDigest: ACCOUNT_CREDENTIAL_TOKEN_DIGEST,
            session: new AccountDirectorySession({ endpoint: fixture.service.endpointUrl, serverIdentityId: fixture.service.serverIdentityId }, { capability: fixture.service.capability }),
            intent: { kind: 'enroll' as const, homeServerIdentityId: fixture.home.homeServerIdentityId } };
        screen = await renderScreen(<AccountServiceContinuation input={input}
            result={{ kind: 'failure', stage: 'enroll', code: { source: 'home', code: 'rejected' }, recovery: 'retry_stage', accountCredentialCommitted: true, homeCredentialCommitted: false }}
            onResult={() => {}} onBack={() => {}} />);

        expect(screen.getTextContent()).toContain('Start again');
        expect(screen.getTextContent()).not.toContain('Retry');
    });

    it('presents a completed account connection as success rather than warning', async () => {
        const input = { service: fixture.service,
            credentialTokenDigest: ACCOUNT_CREDENTIAL_TOKEN_DIGEST,
            session: new AccountDirectorySession({ endpoint: fixture.service.endpointUrl, serverIdentityId: fixture.service.serverIdentityId }, { capability: fixture.service.capability }),
            intent: { kind: 'refresh' as const } };
        const onBack = vi.fn();
        screen = await renderScreen(<AccountServiceContinuation input={input}
            result={{ kind: 'account_connected' }} onResult={() => {}} onBack={onBack} />);

        expect(screen.findByTestId('account-service-continuation-account_connected-icon')
            ?.findByType('Icon').props.name).toBe('check-circle');
        expect(screen.getTextContent()).toContain('Signed in to https://directory.test');
        expect(screen.getTextContent()).toContain('Your focused Home won’t change.');
        expect(screen.getTextContent()).not.toContain('your Personal Home was not added');
        expect(screen.getTextContent()).not.toContain('Open Home');

        await screen.pressByTestIdAsync('account-service-continuation-account_connected-action');
        expect(onBack).toHaveBeenCalledOnce();
    });

    it('opens an enrolled Home through the canonical focus owner and lands on it', async () => {
        // Web focuses a Home per tab, so the tab store is part of the real path.
        const tabStorage = installLocalStorageMock();
        vi.stubGlobal('sessionStorage', globalThis.localStorage);
        tabStorage.restore();
        vi.stubGlobal('window', { localStorage: globalThis.localStorage, sessionStorage: globalThis.sessionStorage,
            location: { origin: 'https://app.happier.dev' }, addEventListener: vi.fn(), removeEventListener: vi.fn() });
        vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: vi.fn(), removeEventListener: vi.fn() });
        const profile = await adoptHomeProfile({
            descriptor: fixture.home.connectionDescriptor,
            source: 'account-directory',
            descriptorAuthority: 'current_connection_observation',
            suggestedName: fixture.home.label,
        });
        const input = { service: fixture.service,
            credentialTokenDigest: ACCOUNT_CREDENTIAL_TOKEN_DIGEST,
            session: new AccountDirectorySession({ endpoint: fixture.service.endpointUrl, serverIdentityId: fixture.service.serverIdentityId }, { capability: fixture.service.capability }),
            intent: { kind: 'enroll' as const, homeServerIdentityId: fixture.home.homeServerIdentityId } };
        const onBack = vi.fn();
        routerHarness.replace?.mockClear();
        vi.mocked(Modal.alertAsync).mockClear();
        screen = await renderScreen(<AccountServiceContinuation input={input}
            result={{ kind: 'home_enrolled', homeServerIdentityId: fixture.home.homeServerIdentityId }}
            onResult={() => {}} onBack={onBack} />);

        // Open is the card's primary; keeping the current focus is its quieter secondary.
        expect(actionTitle('account-service-continuation-home_enrolled-action')).toBe('Open Home B');
        expect(actionTitle('account-service-continuation-home_enrolled-secondary-action')).toBe('Back');
        await screen.pressByTestIdAsync('account-service-continuation-home_enrolled-action');

        // The canonical owner focused the enrolled Home in this tab and landed on the shell.
        expect(getActiveServerSnapshot().serverId).toBe(resolveServerProfileScopeId(profile));
        expect(Modal.alertAsync).not.toHaveBeenCalledWith(fixture.home.label, expect.anything(), expect.anything());
        expect(routerHarness.replace).toHaveBeenCalledWith('/');
        expect(onBack).not.toHaveBeenCalled();

        await screen.pressByTestIdAsync('account-service-continuation-home_enrolled-secondary-action');
        expect(onBack).toHaveBeenCalledOnce();
    });

    it('keeps the enrolled-Home card when the user declines to retry a failed open', async () => {
        await adoptHomeProfile({
            descriptor: fixture.home.connectionDescriptor,
            source: 'account-directory',
            descriptorAuthority: 'current_connection_observation',
            suggestedName: fixture.home.label,
        });
        const input = { service: fixture.service,
            credentialTokenDigest: ACCOUNT_CREDENTIAL_TOKEN_DIGEST,
            session: new AccountDirectorySession({ endpoint: fixture.service.endpointUrl, serverIdentityId: fixture.service.serverIdentityId }, { capability: fixture.service.capability }),
            intent: { kind: 'enroll' as const, homeServerIdentityId: fixture.home.homeServerIdentityId } };
        const onBack = vi.fn();
        routerHarness.replace?.mockClear();
        vi.mocked(Modal.alertAsync).mockClear();
        const readCredentials = TokenStorage.getCredentialsForServerUrl;
        // Credential persistence is external to the focus owner. Its failed
        // target read exercises the real switch/rollback and recovery card.
        const credentialRead = vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockImplementation(async (serverUrl, options) => {
            if (serverUrl === fixture.home.canonicalServerUrl) throw new Error('secure storage read failed');
            return readCredentials(serverUrl, options);
        });
        try {
            screen = await renderScreen(<AccountServiceContinuation input={input}
                result={{ kind: 'home_enrolled', homeServerIdentityId: fixture.home.homeServerIdentityId }}
                onResult={() => {}} onBack={onBack} />);
            await screen.pressByTestIdAsync('account-service-continuation-home_enrolled-action');
        } finally {
            credentialRead.mockRestore();
        }

        // The owner asked whether to retry and the user cancelled: nothing moved and
        // the card still offers Open and Back rather than silently leaving the host.
        expect(Modal.alertAsync).toHaveBeenCalledWith('Home B', expect.anything(), expect.anything());
        expect(onBack).not.toHaveBeenCalled();
        expect(routerHarness.replace).not.toHaveBeenCalled();
        expect(actionTitle('account-service-continuation-home_enrolled-action')).toBe('Open Home B');
    });

    it('stops offering Open when the enrolled Home has no saved profile to open', async () => {
        const input = { service: fixture.service,
            credentialTokenDigest: ACCOUNT_CREDENTIAL_TOKEN_DIGEST,
            session: new AccountDirectorySession({ endpoint: fixture.service.endpointUrl, serverIdentityId: fixture.service.serverIdentityId }, { capability: fixture.service.capability }),
            intent: { kind: 'enroll' as const, homeServerIdentityId: 'srv_unsaved_home' } };
        const onBack = vi.fn();
        screen = await renderScreen(<AccountServiceContinuation input={input}
            result={{ kind: 'home_enrolled', homeServerIdentityId: 'srv_unsaved_home' }}
            onResult={() => {}} onBack={onBack} />);

        expect(actionTitle('account-service-continuation-home_enrolled-action')).toBe('Done');
        await screen.pressByTestIdAsync('account-service-continuation-home_enrolled-action');
        expect(onBack).toHaveBeenCalledOnce();
    });

    it('offers a Homeless account its refresh first and scanning second, with a body that names both', async () => {
        const input = { service: fixture.service,
            credentialTokenDigest: ACCOUNT_CREDENTIAL_TOKEN_DIGEST,
            session: new AccountDirectorySession({ endpoint: fixture.service.endpointUrl, serverIdentityId: fixture.service.serverIdentityId }, { capability: fixture.service.capability }),
            intent: { kind: 'enter' as const, target: { kind: 'automatic' as const } } };
        screen = await renderScreen(<AccountServiceContinuation input={input}
            result={{ kind: 'account_connected_no_homes' }} onResult={() => {}} onBack={() => {}} />);

        expect(actionTitle('account-service-continuation-account_connected_no_homes-action')).toBe('Refresh');
        expect(actionTitle('account-service-continuation-account_connected_no_homes-secondary-action'))
            .toBe('Scan a QR or paste a Home link');
        expect(screen.getTextContent()).not.toContain('Open Account settings');
        // Refresh and scan are the card's own pair; no escape or bare button competes.
        expect(screen.getTextContent()).not.toContain('Back');
    });

    it('tells the waiting user what to do and confirms the sign-in survived stop-waiting', async () => {
        const input = { service: fixture.service,
            credentialTokenDigest: ACCOUNT_CREDENTIAL_TOKEN_DIGEST,
            session: new AccountDirectorySession({ endpoint: fixture.service.endpointUrl, serverIdentityId: fixture.service.serverIdentityId }, { capability: fixture.service.capability }),
            intent: { kind: 'enroll' as const, homeServerIdentityId: fixture.home.homeServerIdentityId } };
        let backs = 0;
        screen = await renderScreen(<AccountServiceContinuation input={input}
            result={{ kind: 'approval_required', homeServerIdentityId: fixture.home.homeServerIdentityId, expiresAtMs: Date.now() + 300_000 }}
            onResult={() => {}} onBack={() => { backs += 1; }} />);
        expect(screen.getTextContent()).toContain('Approve this sign-in from your other signed-in device');
        // The Home name and the expiry stay as the secondary line they already were.
        expect(screen.getTextContent()).toContain('·');

        await screen.pressByTestIdAsync('account-service-continuation-approval_required-action');
        expect(backs).toBe(0);
        expect(screen.getTextContent()).toContain('Stopped waiting for approval');
        expect(screen.getTextContent()).toContain('Your sign-in is still saved');

        await screen.pressByTestIdAsync('account-service-approval-stopped-action');
        expect(backs).toBe(1);
    });

    it('names each choosable Home by address and marks the preferred one', async () => {
        const { service } = fixture;
        const input = { service, session: new AccountDirectorySession({ endpoint: service.endpointUrl, serverIdentityId: service.serverIdentityId }, { capability: service.capability }),
            credentialTokenDigest: ACCOUNT_CREDENTIAL_TOKEN_DIGEST,
            intent: { kind: 'enter' as const, target: { kind: 'automatic' as const } } };
        const other = { ...fixture.home, homeServerIdentityId: 'srv_other', label: 'Other Home', canonicalServerUrl: 'https://other.example.test', preferred: false };
        screen = await renderScreen(<AccountServiceContinuation input={input}
            result={{ kind: 'choose_home', homes: [{ ...fixture.home, preferred: true }, other] }}
            onResult={() => {}} onBack={() => {}} />);
        const text = screen.getTextContent();
        expect(text).toContain(fixture.home.canonicalServerUrl);
        expect(text).toContain('https://other.example.test');
        expect(text).toContain('Preferred');
    });

    it('reports an unlinked Home as a status with direct sign-in first and scan-or-paste second', async () => {
        const input = { service: fixture.service,
            credentialTokenDigest: ACCOUNT_CREDENTIAL_TOKEN_DIGEST,
            session: new AccountDirectorySession({ endpoint: fixture.service.endpointUrl, serverIdentityId: fixture.service.serverIdentityId }, { capability: fixture.service.capability }),
            intent: { kind: 'enter' as const, target: { kind: 'explicit' as const, homeServerIdentityId: fixture.home.homeServerIdentityId } } };
        const previous = { kind: 'explicit_target_not_linked' as const, homeServerIdentityId: fixture.home.homeServerIdentityId };
        const onOpenHomeAuthentication = vi.fn();
        screen = await renderScreen(<AccountServiceContinuation input={input} result={previous}
            onResult={() => {}} onBack={() => {}} onOpenHomeAuthentication={onOpenHomeAuthentication} />);

        // The sign-in succeeded; an unlinked Home is a state to act on, not a failure.
        const card = screen.findByTestId('account-service-continuation-explicit_target_not_linked');
        expect(card?.props.accessibilityLiveRegion).toBe('polite');
        expect(screen.getTextContent()).not.toContain('Connection failed');
        expect(screen.getTextContent()).toContain('isn’t linked to this account yet');
        // The body explains both ways forward in the order of the card's actions, without repeating the title.
        expect(screen.findByTestId('account-service-continuation-explicit_target_not_linked-reason')?.props.children)
            .toBe('Sign in to Home directly, or scan its QR code or paste its Home link.');
        expect(screen.getTextContent()).not.toContain('is not linked to your sign-in service on this device');
        expect(screen.getTextContent()).not.toContain('Signed in to');
        // One card, one primary: no escape-as-primary and no anonymous bare Continue below it.
        expect(screen.getTextContent()).not.toContain('Back');
        expect(screen.getTextContent()).not.toContain('Continue');
        expect(screen.findAllByTestId('account-service-direct-home-auth')).toHaveLength(0);

        await screen.pressByTestIdAsync('account-service-continuation-explicit_target_not_linked-action');
        expect(onOpenHomeAuthentication).toHaveBeenCalledWith(input, fixture.home.homeServerIdentityId, previous);
        expect(actionTitle('account-service-continuation-explicit_target_not_linked-secondary-action'))
            .toBe('Scan a QR or paste a Home link');
        await screen.unmount();

        screen = await renderScreen(<AccountServiceContinuation input={input} result={previous}
            onResult={() => {}} onBack={() => {}} />);
        // Without a direct Home sign-in host, scan-or-paste is the one way forward.
        expect(actionTitle('account-service-continuation-explicit_target_not_linked-action'))
            .toBe('Scan a QR or paste a Home link');
        expect(screen.findByTestId('account-service-continuation-explicit_target_not_linked-reason')?.props.children)
            .toBe('Scan the QR code of Home or paste its Home link to connect it.');
        expect(screen.findAllByTestId('account-service-continuation-explicit_target_not_linked-secondary-action')).toHaveLength(0);
    });

    it('leads a Home-auth recovery with signing in to that Home inside the card, scan second', async () => {
        const input = { service: fixture.service,
            credentialTokenDigest: ACCOUNT_CREDENTIAL_TOKEN_DIGEST,
            session: new AccountDirectorySession({ endpoint: fixture.service.endpointUrl, serverIdentityId: fixture.service.serverIdentityId }, { capability: fixture.service.capability }),
            intent: { kind: 'enroll' as const, homeServerIdentityId: fixture.home.homeServerIdentityId } };
        const previous: AccountPostAuthResult = { kind: 'failure', stage: 'material', code: { source: 'local', code: 'account_mode_unavailable' },
            recovery: 'use_home_auth', accountCredentialCommitted: true, homeCredentialCommitted: false,
            targetHomeServerIdentityId: fixture.home.homeServerIdentityId };
        const onOpenHomeAuthentication = vi.fn();
        screen = await renderScreen(<AccountServiceContinuation input={input} result={previous}
            onResult={() => {}} onBack={() => {}} onOpenHomeAuthentication={onOpenHomeAuthentication} />);

        // One card, one primary: direct sign-in is the card's own action, never a heavier bare button beneath it.
        // No saved profile or directory entry names this Home, so the product noun stands in.
        expect(actionTitle('account-service-continuation-failure-action')).toBe('Sign in to Home');
        expect(actionTitle('account-service-continuation-failure-secondary-action')).toBe('Scan a QR or paste a Home link');
        expect(screen.findAllByTestId('account-service-direct-home-auth')).toHaveLength(0);
        expect(screen.findByTestId('account-service-continuation-failure-reason')?.props.children)
            .toBe('Sign in to Home directly, or scan its QR code or paste its Home link.');
        await screen.pressByTestIdAsync('account-service-continuation-failure-action');
        expect(onOpenHomeAuthentication).toHaveBeenCalledWith(input, fixture.home.homeServerIdentityId, previous);
    });

    it('offers scanning as the key form\'s own secondary choice when Home material is missing', async () => {
        const input = { service: fixture.service,
            credentialTokenDigest: ACCOUNT_CREDENTIAL_TOKEN_DIGEST,
            session: new AccountDirectorySession({ endpoint: fixture.service.endpointUrl, serverIdentityId: fixture.service.serverIdentityId }, { capability: fixture.service.capability }),
            intent: { kind: 'enroll' as const, homeServerIdentityId: fixture.home.homeServerIdentityId } };
        screen = await renderScreen(<AccountServiceContinuation input={input}
            result={{ kind: 'home_material_required', homeServerIdentityId: fixture.home.homeServerIdentityId, homeAccountId: 'account-home', intent: input.intent, reason: 'missing_material' }}
            onResult={() => {}} onBack={() => {}} />);

        const scanButtons = screen.findAll((node) => node.props.title === 'Scan a QR or paste a Home link' && typeof node.props.testID === 'string');
        expect(scanButtons.map((node) => node.props.testID)).toEqual(['restore-manual-secondary']);
        expect(scanButtons[0]?.props.display).toBe('inverted');
    });

    it('admits only one Home choice while the shared coordinator is refreshing', async () => {
        const { service } = fixture;
        await TokenStorage.accountDirectoryAuthCredentials.set({ endpoint: service.endpointUrl, serverIdentityId: service.serverIdentityId }, { token: 'directory-token' });
        const input = { service, session: new AccountDirectorySession({ endpoint: service.endpointUrl, serverIdentityId: service.serverIdentityId }, { capability: service.capability }),
            credentialTokenDigest: ACCOUNT_CREDENTIAL_TOKEN_DIGEST,
            intent: { kind: 'enter' as const, target: { kind: 'automatic' as const } } };
        const other = { ...fixture.home, homeServerIdentityId: 'srv_other', label: 'Other Home' };
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        let homeReads = 0;
        boundary.request.mockImplementation(async (endpoint: string, path: string, init?: RequestInit) => {
            if (path === '/v1/account-directory/homes') { homeReads += 1; await gate; }
            return fixture.request(endpoint, path, init);
        });
        const outcomes: AccountPostAuthResult[] = [];
        screen = await renderScreen(<AccountServiceContinuation input={input} result={{ kind: 'choose_home', homes: [fixture.home, other] }} onResult={(result) => { outcomes.push(result); }} onBack={() => {}} />);
        let first!: Promise<void>;
        act(() => { first = screen!.findByTestId(`account-service-choose-home-${fixture.home.homeServerIdentityId}`)!.props.onPress(); });
        await vi.waitFor(() => expect(homeReads).toBe(1));
        let second!: Promise<void>;
        act(() => { second = screen!.findByTestId('account-service-choose-home-srv_other')!.props.onPress(); });
        try {
            await act(async () => { await Promise.resolve(); });
            expect(homeReads).toBe(1);
        } finally {
            await act(async () => { release(); await Promise.all([first, second]); });
        }
        expect(outcomes).toHaveLength(1);
    });

    it('resumes retained authority even when device service selection changes', async () => {
        const { service } = fixture;
        const controller = new AbortController();
        await TokenStorage.accountDirectoryAuthCredentials.set({ endpoint: service.endpointUrl, serverIdentityId: service.serverIdentityId }, { token: 'directory-token' });
        const input = { service,
            credentialTokenDigest: ACCOUNT_CREDENTIAL_TOKEN_DIGEST,
            session: new AccountDirectorySession({ endpoint: service.endpointUrl, serverIdentityId: service.serverIdentityId }, { capability: service.capability }),
            intent: { kind: 'enroll' as const, homeServerIdentityId: fixture.home.homeServerIdentityId },
            signal: controller.signal,
        };
        const initial = await completeAccountServicePostAuth(input);
        expect(initial.kind).toBe('approval_required');
        controller.abort();
        let outcome: AccountPostAuthResult = initial;
        function Invoker() {
            const [result, setResult] = React.useState(initial);
            return <AccountServiceContinuation input={input} result={result} onResult={(next) => { outcome = next; setResult(next); }} onBack={() => {}} />;
        }
        screen = await renderScreen(<Invoker />);
        await setAccountServiceEndpoint({ url: 'https://unrelated.test', serverIdentityId: 'srv_unrelated', source: 'user' });
        fixture.state.approval = 'approved';
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, ENROLLMENT_POLL_IDLE_DELAY_MS + 100)); });
        await vi.waitFor(() => expect(outcome).toEqual({ kind: 'home_enrolled', homeServerIdentityId: fixture.home.homeServerIdentityId }));
        expect(getPendingDirectoryHomeEnrollment()).toBeNull();
        expect(fixture.state.calls.some(({ endpoint }) => endpoint === 'ambient' || endpoint === 'https://unrelated.test')).toBe(false);
        expect(fixture.state.calls.filter(({ path }) => path.includes('login-assertion'))).toHaveLength(1);
    });
});
