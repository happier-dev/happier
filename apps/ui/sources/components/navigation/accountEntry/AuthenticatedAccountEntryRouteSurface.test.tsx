import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderScreen } from '@/dev/testkit';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import type { AccountDirectoryAuthMethodDiscovery } from '@/auth/accountDirectory/accountDirectoryAuthClient';

const authClient = vi.hoisted(() => ({
    discoverAuthenticationMethods: vi.fn(),
    startOAuth: vi.fn(async (input: {
        endpointUrl: string;
        endpointServerIdentityId: string;
        canonicalServerUrl: string;
        providerId: string;
        mode: 'keyed' | 'keyless';
        entryIntent: { kind: 'enter'; target: { kind: 'automatic' } };
        returnTo: string;
    }) => ({
        url: 'https://oauth.example.test/start',
        pending: {
            endpoint: input.endpointUrl,
            serverIdentityId: input.endpointServerIdentityId,
            canonicalServerUrl: input.canonicalServerUrl,
            provider: input.providerId,
            purpose: 'account_directory' as const,
            credentialTarget: 'account_directory' as const,
            entryIntent: input.entryIntent,
            mode: input.mode,
            ...(input.mode === 'keyed' ? { secret: 'exact-secret' } : { proof: 'exact-proof' }),
            createdAt: 1,
            expiresAt: 2,
            returnTo: input.returnTo,
        },
    })),
}));
const linking = vi.hoisted(() => ({ openURL: vi.fn(async () => {}) }));
const oauthReturn = vi.hoisted(() => ({ consume: vi.fn() }));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return {
        ...await createReactNativeWebMock(),
        Linking: linking,
    };
});

vi.mock('@/auth/accountDirectory/accountDirectoryAuthClient', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/auth/accountDirectory/accountDirectoryAuthClient')>();
    return {
        ...actual,
        accountDirectoryAuthClient: authClient,
    };
});

vi.mock('@/sync/ops/accountDirectory/consumeAccountServiceOAuthReturn', () => ({
    consumeAccountServiceOAuthReturn: oauthReturn.consume,
}));

vi.mock('@/components/account/auth/AccountServiceContinuation', () => ({
    AccountServiceContinuation: (props: Record<string, unknown>) => React.createElement('AccountServiceContinuation', props),
}));

vi.mock('@/components/account/auth/AccountServiceHomeAuthenticationAdapter', () => ({
    AccountServiceHomeAuthenticationAdapter: (props: Record<string, unknown>) => React.createElement('AccountServiceHomeAuthenticationAdapter', props),
}));

vi.mock('@/components/onboarding/ui/WizardModalShell', () => ({
    WizardModalShell: (props: React.PropsWithChildren<Record<string, unknown>>) =>
        React.createElement('WizardModalShell', props, props.children),
}));


vi.mock('@/components/account/auth/AccountDirectoryKeyLoginForm', () => ({
    AccountDirectoryKeyLoginForm: (props: Record<string, unknown>) => React.createElement('AccountDirectoryKeyLoginForm', props),
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

import { AuthenticatedAccountEntryRouteSurface } from './AuthenticatedAccountEntryRouteSurface';

const request = {
    service: { endpointUrl: 'https://accounts.example.test', serverIdentityId: 'srv_accounts' },
    intent: { kind: 'enter', target: { kind: 'automatic' } },
    returnTo: '/',
} as const;

function discovery(): AccountDirectoryAuthMethodDiscovery & { kind: 'supported_account_service' } {
    const capability = {
        version: 1 as const,
        homeDirectory: true,
        homeEnrollment: true,
        homeLoginAssertion: {
            keyId: 'a'.repeat(64),
            publicKeyBase64Url: 'A'.repeat(43),
        },
    };
    const features = createRootLayoutFeaturesResponse({
        capabilities: {
            accountDirectory: capability,
            server: { canonicalServerUrl: request.service.endpointUrl },
            serverIdentity: { serverIdentityId: request.service.serverIdentityId },
            auth: { keyChallenge: { v2: true } },
        },
    });
    return {
        kind: 'supported_account_service' as const,
        endpointUrl: request.service.endpointUrl,
        serverIdentityId: request.service.serverIdentityId,
        canonicalServerUrl: request.service.endpointUrl,
        capability,
        keyLoginAvailable: true,
        oauthProviderIds: ['github'] as const,
        preferredProvisionProviderId: 'github',
        authenticationCatalog: {
            provenance: 'structured' as const,
            methods: [
                { id: 'github', enabledActions: [{ id: 'login' as const, mode: 'keyless' as const }] },
                { id: 'key_challenge', enabledActions: [{ id: 'login' as const, mode: 'keyed' as const }] },
            ],
        },
        authenticationActions: [
            {
                method: { id: 'github', enabledActions: [{ id: 'login' as const, mode: 'keyless' as const }] },
                action: { id: 'login' as const, mode: 'keyless' as const },
                execution: { kind: 'oauth' as const, providerId: 'github', mode: 'keyless' as const },
            },
            {
                method: { id: 'key_challenge', enabledActions: [{ id: 'login' as const, mode: 'keyed' as const }] },
                action: { id: 'login' as const, mode: 'keyed' as const },
                execution: { kind: 'key_entry' as const },
            },
        ],
        accountServiceDisplayName: 'Acme',
        snapshot: { status: 'ready', features, serverIdentityId: request.service.serverIdentityId },
    };
}

describe('AuthenticatedAccountEntryRouteSurface', () => {
    beforeEach(() => {
        authClient.discoverAuthenticationMethods.mockReset();
        authClient.startOAuth.mockClear();
        linking.openURL.mockClear();
        oauthReturn.consume.mockReset();
        oauthReturn.consume.mockResolvedValue({ kind: 'absent' });
    });

    it('does not infer a continuation from an ordinary retained Account Service credential', async () => {
        authClient.discoverAuthenticationMethods.mockResolvedValue(discovery());
        const screen = await renderScreen(
            <AuthenticatedAccountEntryRouteSurface request={request} routeParams={{ mode: 'account-entry' }} onExit={vi.fn()} />,
        );

        await vi.waitFor(() => expect(screen.findByTestId('account-service-auth-github-login-keyless')).toBeTruthy());
        expect(oauthReturn.consume).toHaveBeenCalledTimes(1);
    });

    it('names the Home-discovery wait instead of showing a silent spinner', async () => {
        let release!: (value: AccountDirectoryAuthMethodDiscovery) => void;
        authClient.discoverAuthenticationMethods.mockReturnValue(new Promise<AccountDirectoryAuthMethodDiscovery>((resolve) => { release = resolve; }));
        const screen = await renderScreen(
            <AuthenticatedAccountEntryRouteSurface request={request} routeParams={{ mode: 'account-entry' }} onExit={vi.fn()} />,
        );

        const loading = screen.findByTestId('authenticated-account-entry-loading');
        expect(loading).toBeTruthy();
        expect(screen.getTextContent()).toContain('settingsAccount.accountServiceOAuth.stages.findingHomes');
        // The slowest leg of the journey has to reach assistive tech too.
        expect(loading!.props.accessibilityLiveRegion).toBe('polite');
        await act(async () => { release(discovery()); });
        await screen.unmount();
    });

    it('re-verifies the exact service and carries enter/automatic into shared key and OAuth owners', async () => {
        authClient.discoverAuthenticationMethods.mockResolvedValue(discovery());
        const screen = await renderScreen(
            <AuthenticatedAccountEntryRouteSurface request={request} routeParams={{ mode: 'account-entry' }} onExit={vi.fn()} />,
        );

        await vi.waitFor(() => expect(authClient.discoverAuthenticationMethods).toHaveBeenCalledWith(expect.objectContaining({
            endpointUrl: request.service.endpointUrl,
            expectedServerIdentityId: request.service.serverIdentityId,
        })));

        const key = screen.findByTestId('account-service-auth-key_challenge-login-keyed');
        if (!key) throw new Error('Expected Account Service key action');
        const pressKey = key.props.onPress;
        await act(async () => pressKey());
        expect(screen.findByType('AccountDirectoryKeyLoginForm')?.props).toMatchObject({
            intent: request.intent,
            service: {
                endpointUrl: request.service.endpointUrl,
                serverIdentityId: request.service.serverIdentityId,
            },
        });

        const keyForm = screen.findByType('AccountDirectoryKeyLoginForm');
        if (!keyForm) throw new Error('Expected Account Service key form');
        await act(async () => keyForm.props.onBack());
        await screen.pressByTestIdAsync('account-service-auth-github-login-keyless');
        expect(authClient.startOAuth).toHaveBeenCalledWith(expect.objectContaining({
            endpointUrl: request.service.endpointUrl,
            endpointServerIdentityId: request.service.serverIdentityId,
            entryIntent: request.intent,
            returnTo: '/homes/sign-in',
            accountEntryReturnTo: request.returnTo,
        }));
        expect(linking.openURL).toHaveBeenCalledWith('https://oauth.example.test/start');
    });

    it('fails closed when exact identity verification does not yield the requested service', async () => {
        const verifiedDiscovery = discovery();
        authClient.discoverAuthenticationMethods.mockResolvedValue({
            kind: 'identity_mismatch',
            endpointUrl: request.service.endpointUrl,
            expectedServerIdentityId: request.service.serverIdentityId,
            observedServerIdentityId: 'srv_other',
            snapshot: verifiedDiscovery.snapshot,
        });
        const screen = await renderScreen(
            <AuthenticatedAccountEntryRouteSurface request={request} routeParams={{ mode: 'account-entry' }} onExit={vi.fn()} />,
        );

        await vi.waitFor(() => expect(screen.findByTestId('authenticated-account-entry-unavailable')).toBeTruthy());
        expect(screen.findByTestId('account-service-another-choice')).toBeFalsy();
    });

    it('consumes a recorded OAuth return through the canonical coordinator instead of redisplaying methods', async () => {
        const input = { intent: request.intent };
        const result = { kind: 'choose_home', homes: [] };
        const onExit = vi.fn();
        oauthReturn.consume.mockResolvedValue({ kind: 'consumed', input, result });
        const screen = await renderScreen(
            <AuthenticatedAccountEntryRouteSurface request={request} routeParams={{ mode: 'account-entry', accountServiceReturn: '1' }} onExit={onExit} />,
        );

        await vi.waitFor(() => expect(screen.findByType('AccountServiceContinuation')).toBeTruthy());
        expect(authClient.discoverAuthenticationMethods).not.toHaveBeenCalled();
        const continuation = screen.findByType('AccountServiceContinuation');
        if (!continuation) throw new Error('Expected Account Service continuation');
        const reportResult = continuation.props.onResult;
        await act(async () => reportResult({ kind: 'home_entered' }));
        expect(onExit).toHaveBeenCalledWith(request.returnTo, { kind: 'home_entered' });
    });

    it.each(['home_entered', 'home_linked'] as const)(
        'exits immediately when a consumed OAuth return is already terminal: %s',
        async (kind) => {
            const onExit = vi.fn();
            oauthReturn.consume.mockResolvedValue({ kind: 'consumed', input: { intent: request.intent }, result: { kind } });
            const screen = await renderScreen(
                <AuthenticatedAccountEntryRouteSurface request={request} routeParams={{ accountServiceReturn: '1' }} onExit={onExit} />,
            );

            await vi.waitFor(() => expect(onExit).toHaveBeenCalledTimes(1));
            expect(onExit).toHaveBeenCalledWith(request.returnTo, { kind });
            expect(screen.findAllByType('AccountServiceContinuation')).toHaveLength(0);
        },
    );

    it.each(['account_connected', 'home_enrolled'] as const)(
        'presents a completed result whose next action still belongs to the invoking surface: %s',
        async (kind) => {
            const onExit = vi.fn();
            oauthReturn.consume.mockResolvedValue({ kind: 'consumed', input: { intent: request.intent }, result: { kind } });
            const screen = await renderScreen(
                <AuthenticatedAccountEntryRouteSurface request={request} routeParams={{ accountServiceReturn: '1' }} onExit={onExit} />,
            );

            await vi.waitFor(() => expect(screen.findByType('AccountServiceContinuation')).toBeTruthy());
            expect(onExit).not.toHaveBeenCalled();
        },
    );

    it('keeps a visible continuation when the host re-renders with a new onExit and equal route params', async () => {
        // Hosts pass an inline onExit and expo-router hands out a fresh params
        // object on every render; neither may abort or re-consume the return.
        const signals: AbortSignal[] = [];
        oauthReturn.consume.mockImplementation(async (_params: unknown, options: { signal: AbortSignal }) => {
            signals.push(options.signal);
            return { kind: 'consumed', input: { intent: request.intent }, result: { kind: 'account_connected' } };
        });
        const firstExit = vi.fn();
        const screen = await renderScreen(
            <AuthenticatedAccountEntryRouteSurface request={request}
                routeParams={{ mode: 'account-entry', accountServiceReturn: '1' }} onExit={firstExit} />,
        );
        await vi.waitFor(() => expect(screen.findByType('AccountServiceContinuation')).toBeTruthy());

        const nextExit = vi.fn();
        await screen.update(
            <AuthenticatedAccountEntryRouteSurface request={request}
                routeParams={{ mode: 'account-entry', accountServiceReturn: '1' }} onExit={nextExit} />,
        );

        expect(oauthReturn.consume).toHaveBeenCalledTimes(1);
        expect(signals[0]?.aborted).toBe(false);
        const continuation = screen.findByType('AccountServiceContinuation');
        if (!continuation) throw new Error('Expected the continuation to survive the host re-render');
        await act(async () => continuation.props.onBack());
        // The latest host callback owns the exit.
        expect(nextExit).toHaveBeenCalledWith(request.returnTo, { kind: 'account_connected' });
        expect(firstExit).not.toHaveBeenCalled();
    });

    it('carries the exact prior continuation result into direct Home authentication', async () => {
        const input = {
            service: {
                endpointUrl: request.service.endpointUrl,
                serverIdentityId: request.service.serverIdentityId,
                canonicalServerUrl: request.service.endpointUrl,
            },
            intent: { kind: 'enter', target: { kind: 'explicit', homeServerIdentityId: 'srv_home_target' } },
        };
        const previous = { kind: 'explicit_target_not_linked', homeServerIdentityId: 'srv_home_target' };
        oauthReturn.consume.mockResolvedValue({ kind: 'consumed', input, result: previous });
        const screen = await renderScreen(
            <AuthenticatedAccountEntryRouteSurface request={request} routeParams={{ mode: 'account-entry', accountServiceReturn: '1' }} onExit={vi.fn()} />,
        );

        await vi.waitFor(() => expect(screen.findByType('AccountServiceContinuation')).toBeTruthy());
        const continuation = screen.findByType('AccountServiceContinuation');
        if (!continuation) throw new Error('Expected Account Service continuation');
        await act(async () => continuation.props.onOpenHomeAuthentication(input, 'srv_home_target', previous));

        expect(screen.findByType('AccountServiceHomeAuthenticationAdapter')?.props).toMatchObject({
            input,
            previous,
            homeServerIdentityId: 'srv_home_target',
        });
    });

    it('reauthenticates against the same exact Account Service without consuming custody twice', async () => {
        const input = {
            service: { endpointUrl: request.service.endpointUrl, serverIdentityId: request.service.serverIdentityId },
            intent: { kind: 'enter', target: { kind: 'explicit', homeServerIdentityId: 'srv_home_target' } },
        };
        oauthReturn.consume.mockResolvedValue({
            kind: 'consumed',
            input,
            result: { kind: 'failure', stage: 'refresh', code: { source: 'directory', code: 'invalid_token' }, recovery: 'reauthenticate_account' },
        });
        authClient.discoverAuthenticationMethods.mockResolvedValue(discovery());
        const screen = await renderScreen(
            <AuthenticatedAccountEntryRouteSurface request={request} routeParams={{ mode: 'account-entry', accountServiceReturn: '1' }} onExit={vi.fn()} />,
        );

        await vi.waitFor(() => expect(screen.findByType('AccountServiceContinuation')).toBeTruthy());
        const continuation = screen.findByType('AccountServiceContinuation');
        if (!continuation) throw new Error('Expected Account Service continuation');
        await act(async () => continuation.props.onReauthenticate(input));

        await vi.waitFor(() => expect(screen.findByTestId('account-service-auth-github-login-keyless')).toBeTruthy());
        expect(authClient.discoverAuthenticationMethods).toHaveBeenCalledWith(expect.objectContaining({
            endpointUrl: request.service.endpointUrl,
            expectedServerIdentityId: request.service.serverIdentityId,
        }));
        expect(oauthReturn.consume).toHaveBeenCalledTimes(1);
    });

    it('falls through to read-only discovery after an already-consumed or invalid OAuth return', async () => {
        // A reload after the one-shot return custody was consumed is `invalid`;
        // it can never become valid again, so Retry would be a dead end. The
        // surface re-verifies the exact service and shows its methods instead,
        // inferring no link, enrollment or focus from the stale params.
        oauthReturn.consume.mockResolvedValue({ kind: 'invalid' });
        authClient.discoverAuthenticationMethods.mockResolvedValue(discovery());
        const screen = await renderScreen(
            <AuthenticatedAccountEntryRouteSurface request={request} routeParams={{ mode: 'account-entry', accountServiceReturn: '1' }} onExit={vi.fn()} />,
        );

        await vi.waitFor(() => expect(authClient.discoverAuthenticationMethods).toHaveBeenCalledWith(expect.objectContaining({
            endpointUrl: request.service.endpointUrl,
            expectedServerIdentityId: request.service.serverIdentityId,
        })));
        await vi.waitFor(() => expect(screen.findAllByTestId('authenticated-account-entry-unavailable')).toHaveLength(0));
        expect(oauthReturn.consume).toHaveBeenCalledTimes(1);
    });

    it('offers retry for a retryable OAuth return without issuing a second discovery', async () => {
        oauthReturn.consume.mockResolvedValue({ kind: 'retryable' });
        const screen = await renderScreen(
            <AuthenticatedAccountEntryRouteSurface request={request} routeParams={{ mode: 'account-entry', accountServiceReturn: '1' }} onExit={vi.fn()} />,
        );

        await vi.waitFor(() => expect(screen.findByTestId('authenticated-account-entry-unavailable')).toBeTruthy());
        expect(authClient.discoverAuthenticationMethods).not.toHaveBeenCalled();
    });
});
