import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderScreen } from '@/dev/testkit';
import type { AccountServiceEntryOptions } from '@/components/account/auth/useAccountServiceEntryOptions';
import type { AuthEntryOptions } from '@/components/account/auth/useAuthEntryOptions';
import { buildServerFeaturesResponse } from '@/hooks/server/serverFeaturesTestUtils';
import { t } from '@/text';

import { WelcomeDecisionPanel } from './WelcomeDecisionPanel';

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: (props: Record<string, unknown>) => React.createElement('Ionicons', props),
}));

const baseOptions: AuthEntryOptions = {
    homeTarget: { kind: 'saved_profile', profileRef: 'home-a' },
    requestedHomeTarget: { kind: 'saved_profile', profileRef: 'home-a' },
    homeLabel: 'Home A',
    authenticationActions: [{
        method: { id: 'key_challenge', enabledActions: [{ id: 'provision', mode: 'keyed' }] },
        action: { id: 'provision', mode: 'keyed' },
        execution: { kind: 'generated_key' },
    }],
    serverAvailability: 'ready',
    authEntryUnavailable: false,
    serverUrlForCopy: 'https://relay.example.test',
    showAuthActions: true,
    retryServerCheck: () => {},
};

function flattenStyle(style: unknown): Record<string, unknown> {
    if (typeof style === 'function') {
        const resolvePressableStyle = style as (state: { pressed: boolean }) => unknown;
        return flattenStyle(resolvePressableStyle({ pressed: false }));
    }
    if (Array.isArray(style)) {
        return Object.assign({}, ...style.map((entry) => flattenStyle(entry)));
    }
    if (style && typeof style === 'object') {
        return style as Record<string, unknown>;
    }
    return {};
}

function renderPanel(
    overrides: Partial<AuthEntryOptions> = {},
    accountServiceEntry?: AccountServiceEntryOptions,
) {
    const options: AuthEntryOptions = { ...baseOptions, ...overrides };
    const callbacks = {
        onContinueWithHomeAuthentication: vi.fn(),
        onOpenRestore: vi.fn(),
        onChangeRelay: vi.fn(),
        onContinueWithAccountServiceProvider: vi.fn(),
        onContinueWithAccountServiceKey: vi.fn(),
        onChooseAccountService: vi.fn(),
    };

    return {
        callbacks,
        screenPromise: renderScreen(
            <WelcomeDecisionPanel
                authEntryOptions={options}
                accountServiceEntry={accountServiceEntry}
                canScanQr
                {...callbacks}
            />,
        ),
    };
}

function readyAccountServiceEntry(
    oauthProviderIds: readonly string[],
    options: Readonly<{
        keyLoginAvailable?: boolean;
        oauthAction?: 'login' | 'provision';
        oauthMode?: 'keyed' | 'keyless';
        oauthPresentationName?: string;
    }> = {},
): AccountServiceEntryOptions {
    const features = buildServerFeaturesResponse();
    const oauthAction = options.oauthAction ?? 'login';
    const oauthMode = options.oauthMode ?? 'keyless';
    const oauthMethod = (id: string) => ({
        id,
        enabledActions: [{ id: oauthAction, mode: oauthMode }],
        ...(options.oauthPresentationName ? { presentation: { displayName: options.oauthPresentationName } } : {}),
    });
    return {
        effectiveSignInService: { kind: 'no_target_default', endpoint: 'https://api.happier.dev' },
        endpoint: { url: 'https://api.happier.dev', displayName: 'Happier Cloud', source: 'default' },
        status: 'ready',
        transport: {},
        retry: vi.fn(),
        discovery: {
            endpointUrl: 'https://api.happier.dev',
            serverIdentityId: 'srv_cloud_identity',
            canonicalServerUrl: 'https://api.happier.dev',
            capability: {
                version: 1,
                homeDirectory: true,
                homeEnrollment: true,
                homeLoginAssertion: {
                    keyId: 'a'.repeat(64),
                    publicKeyBase64Url: 'A'.repeat(43),
                },
            },
            keyLoginAvailable: options.keyLoginAvailable ?? false,
            oauthProviderIds,
            preferredProvisionProviderId: oauthProviderIds[0] ?? null,
            authenticationCatalog: {
                provenance: 'structured',
                methods: [
                    ...(options.keyLoginAvailable ? [{ id: 'key_challenge', enabledActions: [{ id: 'login' as const, mode: 'keyed' as const }] }] : []),
                    ...oauthProviderIds.map(oauthMethod),
                ],
            },
            authenticationActions: [
                ...(options.keyLoginAvailable ? [{
                    method: { id: 'key_challenge', enabledActions: [{ id: 'login' as const, mode: 'keyed' as const }] },
                    action: { id: 'login' as const, mode: 'keyed' as const },
                    execution: { kind: 'key_entry' as const },
                }] : []),
                ...oauthProviderIds.map((id) => ({
                    method: oauthMethod(id),
                    action: { id: oauthAction, mode: oauthMode },
                    execution: { kind: 'oauth' as const, providerId: id, mode: oauthMode },
                })),
            ],
            accountServiceDisplayName: 'Happier Cloud',
            snapshot: {
                status: 'ready',
                serverIdentityId: 'srv_cloud_identity',
                features: {
                    ...features,
                    capabilities: {
                        ...features.capabilities,
                        accountDirectory: {
                            version: 1,
                            homeDirectory: true,
                            homeEnrollment: true,
                            homeLoginAssertion: {
                                keyId: 'a'.repeat(64),
                                publicKeyBase64Url: 'A'.repeat(43),
                            },
                        },
                        server: { canonicalServerUrl: 'https://api.happier.dev' },
                        serverIdentity: { serverIdentityId: 'srv_cloud_identity' },
                    },
                },
            },
        },
    };
}

describe('WelcomeDecisionPanel', () => {
    it('leaves the heading to its authentication parent while keeping sign-in actions usable', async () => {
        const onAuthenticate = vi.fn();
        const screen = await renderScreen(
            <WelcomeDecisionPanel
                authEntryOptions={baseOptions}
                showGreeting={false}
                onContinueWithHomeAuthentication={onAuthenticate}
                onOpenRestore={vi.fn()}
                onChangeRelay={vi.fn()}
            />,
        );

        const greetings = screen.findAll(node => typeof node.type === 'string'
            && node.props.accessibilityRole === 'header'
            && (node.props.children === t('welcome.welcomeQuestionTitle')
                || node.props.children === t('welcome.welcomeQuestionSubtitle')));
        expect(greetings).toHaveLength(0);
        await screen.pressByTestIdAsync('welcome-primary-start');
        expect(onAuthenticate).toHaveBeenCalledWith(expect.objectContaining({
            authority: { purpose: 'home', target: baseOptions.homeTarget },
        }));
    });

    it.each(['ready', 'unavailable'] as const)('shows only the chosen service methods when the unrelated Home is %s', async (availability) => {
        const baseService = readyAccountServiceEntry(['github'], { oauthAction: 'provision' });
        const url = 'https://signin.example.test';
        const service: AccountServiceEntryOptions = {
            ...baseService,
            endpoint: { url, source: 'user' },
            discovery: { ...baseService.discovery!, endpointUrl: url, accountServiceDisplayName: null },
        };
        const { screenPromise, callbacks } = renderPanel({
            requestedHomeTarget: undefined,
            serverAvailability: availability,
            authEntryUnavailable: true,
        }, service);
        const screen = await screenPromise;
        expect(screen.findAllByTestId('welcome-primary-start')).toHaveLength(0);
        expect(screen.findAllByTestId('welcome-auth-blocked')).toHaveLength(0);
        expect(screen.findAllByTestId('welcome-auth-entry-degraded')).toHaveLength(0);
        expect(screen.findAllByTestId('welcome-signup-disabled')).toHaveLength(0);
        expect(screen.findByTestId('welcome-account-service-provider-github')?.props.accessibilityHint).toContain('signin.example.test');
        await screen.pressByTestIdAsync('welcome-account-service-provider-github');
        expect(callbacks.onContinueWithAccountServiceProvider).toHaveBeenCalledWith(expect.objectContaining({
            authority: { purpose: 'account_service', service: expect.objectContaining({ endpointUrl: url }) }, intendedHome: null,
        }));
        expect(callbacks.onContinueWithHomeAuthentication).not.toHaveBeenCalled();
    });
    it('keeps a true no-target entry free of Home methods and offers service selection', async () => {
        const noTargetOptions = { ...baseOptions };
        delete noTargetOptions.homeTarget;
        delete noTargetOptions.requestedHomeTarget;
        delete noTargetOptions.homeLabel;
        const screen = await renderScreen(
            <WelcomeDecisionPanel
                authEntryOptions={noTargetOptions}
                onChooseAccountService={vi.fn()}
                onOpenRestore={vi.fn()}
                onChangeRelay={vi.fn()}
            />,
        );

        expect(screen.findAllByTestId('welcome-primary-start')).toHaveLength(0);
        expect(screen.findByTestId('welcome-account-service-choose')).toBeTruthy();
    });

    it('targets the default sign-in service without duplicating the unrelated seeded Home methods', async () => {
        const fallbackOptions = { ...baseOptions };
        delete fallbackOptions.requestedHomeTarget;
        const onContinueWithAccountServiceProvider = vi.fn();
        const screen = await renderScreen(
            <WelcomeDecisionPanel
                authEntryOptions={fallbackOptions}
                accountServiceEntry={readyAccountServiceEntry(['github'])}
                onContinueWithHomeAuthentication={vi.fn()}
                onContinueWithAccountServiceProvider={onContinueWithAccountServiceProvider}
                onChooseAccountService={vi.fn()}
                onOpenRestore={vi.fn()}
                onChangeRelay={vi.fn()}
            />,
        );

        expect(screen.findAllByTestId('welcome-primary-start')).toHaveLength(0);
        await screen.pressByTestIdAsync('welcome-account-service-provider-github');
        expect(onContinueWithAccountServiceProvider).toHaveBeenCalledWith(expect.objectContaining({ intendedHome: null }));
    });

    it('routes anonymous start and restore actions from stable controls', async () => {
        const { callbacks, screenPromise } = renderPanel();
        const screen = await screenPromise;

        expect(screen.findByTestId('welcome-decision-panel')).toBeTruthy();
        expect(screen.findAllByTestId('welcome-private-key-copy')).toHaveLength(0);
        expect(screen.findByTestId('welcome-primary-start-title')).toBeTruthy();
        expect(screen.findByTestId('welcome-primary-start-subtitle')).toBeTruthy();
        expect(screen.findByTestId('welcome-primary-start-icon')).toBeTruthy();
        expect(screen.findByTestId('welcome-scan-existing-home-title')).toBeTruthy();
        expect(screen.findByTestId('welcome-scan-existing-home-icon')).toBeTruthy();
        expect(screen.findByTestId('welcome-use-different-home-title')).toBeTruthy();
        expect(screen.findByTestId('welcome-primary-start-title')?.props.children).toBe('New here?');
        expect(screen.findByTestId('welcome-scan-existing-home-title')?.props.children).toBe('Scan a QR or paste a Home link');
        expect(screen.findByTestId('welcome-use-different-home-title')?.props.children).toBe('Use a different Home');
        // The card chrome is the animated frame inside the pressable hit area.
        const primaryStyle = flattenStyle(screen.findByTestId('welcome-primary-start-text')?.parent?.props.style);
        const textBlockStyle = flattenStyle(screen.findByTestId('welcome-primary-start-text')?.props.style);
        expect(primaryStyle.minHeight).toBe(66);
        expect(primaryStyle.paddingHorizontal).toBe(18);
        expect(primaryStyle.paddingVertical).toBe(10);
        expect(textBlockStyle.gap).toBe(0);
        expect(screen.findByTestId('welcome-primary-start')?.props.accessibilityHint)
            .toBe('Create a private account on Home A.');

        await screen.pressByTestIdAsync('welcome-primary-start');
        await screen.pressByTestIdAsync('welcome-scan-existing-home');
        await screen.pressByTestIdAsync('welcome-use-different-home');

        expect(callbacks.onContinueWithHomeAuthentication).toHaveBeenCalledWith(expect.objectContaining({
            action: { id: 'provision', mode: 'keyed' },
            authority: { purpose: 'home', target: { kind: 'saved_profile', profileRef: 'home-a' } },
            execution: { kind: 'generated_key' },
            method: expect.objectContaining({ id: 'key_challenge' }),
        }));
        expect(callbacks.onOpenRestore).toHaveBeenCalledTimes(1);
        expect(callbacks.onChangeRelay).toHaveBeenCalledTimes(1);
    });

    it('uses provider signup without rendering anonymous private-key copy', async () => {
        const { callbacks, screenPromise } = renderPanel({
            authenticationActions: [{
                method: { id: 'github', enabledActions: [{ id: 'provision', mode: 'keyed' }] },
                action: { id: 'provision', mode: 'keyed' },
                execution: { kind: 'oauth', providerId: 'github', mode: 'keyed' },
            }],
        });
        const screen = await screenPromise;

        expect(screen.findAllByTestId('welcome-private-key-copy')).toHaveLength(0);
        expect(screen.findByTestId('welcome-primary-start')).toBeTruthy();

        await screen.pressByTestIdAsync('welcome-primary-start');

        expect(callbacks.onContinueWithHomeAuthentication).toHaveBeenCalledWith(expect.objectContaining({
            execution: { kind: 'oauth', providerId: 'github', mode: 'keyed' },
        }));
    });

    it('uses keyless provider login without rendering anonymous private-key copy', async () => {
        const { callbacks, screenPromise } = renderPanel({
            authenticationActions: [{
                method: { id: 'github', enabledActions: [{ id: 'login', mode: 'keyless' }] },
                action: { id: 'login', mode: 'keyless' },
                execution: { kind: 'oauth', providerId: 'github', mode: 'keyless' },
            }],
        });
        const screen = await screenPromise;

        expect(screen.findAllByTestId('welcome-private-key-copy')).toHaveLength(0);
        expect(screen.findAllByTestId('welcome-primary-start')).toHaveLength(0);

        await screen.pressByTestIdAsync('welcome-provider-primary');

        expect(callbacks.onContinueWithHomeAuthentication).toHaveBeenCalledWith(expect.objectContaining({
            execution: { kind: 'oauth', providerId: 'github', mode: 'keyless' },
        }));
    });

    it('keeps a visible secondary keyless provider login when anonymous signup remains primary', async () => {
        const { callbacks, screenPromise } = renderPanel({
            authenticationActions: [...baseOptions.authenticationActions!, { method: { id: 'github', enabledActions: [{ id: 'login', mode: 'keyless' }] }, action: { id: 'login', mode: 'keyless' }, execution: { kind: 'oauth', providerId: 'github', mode: 'keyless' } }],
        });
        const screen = await screenPromise;

        expect(screen.findByTestId('welcome-primary-start')).toBeTruthy();
        expect(screen.findByTestId('welcome-login-provider')).toBeTruthy();

        await screen.pressByTestIdAsync('welcome-login-provider');

        expect(callbacks.onContinueWithHomeAuthentication).toHaveBeenCalledWith(expect.objectContaining({
            execution: { kind: 'oauth', providerId: 'github', mode: 'keyless' },
        }));
    });

    it('uses mTLS login without rendering anonymous private-key copy', async () => {
        const { callbacks, screenPromise } = renderPanel({
            authenticationActions: [{
                method: { id: 'mtls', enabledActions: [{ id: 'login', mode: 'keyless' }] },
                action: { id: 'login', mode: 'keyless' },
                execution: { kind: 'mtls' },
            }],
        });
        const screen = await screenPromise;

        expect(screen.findAllByTestId('welcome-private-key-copy')).toHaveLength(0);
        expect(screen.findAllByTestId('welcome-primary-start')).toHaveLength(0);

        await screen.pressByTestIdAsync('welcome-mtls-primary');

        expect(callbacks.onContinueWithHomeAuthentication).toHaveBeenCalledWith(expect.objectContaining({ execution: { kind: 'mtls' } }));
    });

    it('shows Home loading inline while keeping independent recovery navigation available', async () => {
        const { callbacks, screenPromise } = renderPanel({
            authenticationActions: [],
            serverAvailability: 'loading',
            showAuthActions: false,
        });
        const screen = await screenPromise;

        expect(screen.findByTestId('welcome-auth-loading')).toBeTruthy();
        expect(screen.findAllByTestId('welcome-primary-start')).toHaveLength(0);
        expect(screen.findByTestId('welcome-scan-existing-home')).toBeTruthy();
        expect(screen.findByTestId('welcome-use-different-home')).toBeTruthy();
        expect(screen.findAllByTestId('welcome-private-key-copy')).toHaveLength(0);

        await screen.pressByTestIdAsync('welcome-scan-existing-home');
        expect(callbacks.onOpenRestore).toHaveBeenCalledTimes(1);
    });

    it('keeps retry and relay-change actions available when the server is unavailable', async () => {
        const retryServerCheck = vi.fn();
        const { callbacks, screenPromise } = renderPanel({
            authenticationActions: [],
            serverAvailability: 'unavailable',
            showAuthActions: false,
            retryServerCheck,
        });
        const screen = await screenPromise;

        expect(screen.findByTestId('welcome-auth-blocked')).toBeTruthy();
        expect(screen.findByTestId('welcome-scan-existing-home')).toBeTruthy();
        expect(screen.findAllByTestId('welcome-private-key-copy')).toHaveLength(0);

        await screen.pressByTestIdAsync('welcome-use-different-home');
        await screen.pressByTestIdAsync('welcome-auth-blocked-retry');

        expect(callbacks.onChangeRelay).toHaveBeenCalledTimes(1);
        expect(retryServerCheck).toHaveBeenCalledTimes(1);
    });

    it('keeps Home actions usable and offers a retry notice when only the live auth-entry probe failed', async () => {
        const retryServerCheck = vi.fn();
        const { screenPromise } = renderPanel({ authEntryUnavailable: true, retryServerCheck });
        const screen = await screenPromise;

        expect(screen.findByTestId('welcome-primary-start')).toBeTruthy();
        expect(screen.findAllByTestId('welcome-auth-blocked')).toHaveLength(0);
        expect(screen.findByTestId('welcome-auth-entry-degraded')).toBeTruthy();

        await screen.pressByTestIdAsync('welcome-auth-entry-degraded-retry');

        expect(retryServerCheck).toHaveBeenCalledTimes(1);
    });

    it('routes scan-capable devices through the canonical restore surface with paste fallback', async () => {
        const callbacks = {
            onContinueWithHomeAuthentication: vi.fn(),
            onOpenRestore: vi.fn(),
            onChangeRelay: vi.fn(),
        };
        const rerendered = await renderScreen(<WelcomeDecisionPanel
            authEntryOptions={baseOptions}
            {...callbacks}
            canScanQr
        />);
        await rerendered.pressByTestIdAsync('welcome-scan-existing-home');

        expect(callbacks.onOpenRestore).toHaveBeenCalledTimes(1);
    });

    it('keeps paste-based Home entry available when camera capability is not reported', async () => {
        const callbacks = {
            onContinueWithHomeAuthentication: vi.fn(),
            onOpenRestore: vi.fn(),
            onChangeRelay: vi.fn(),
        };
        const screen = await renderScreen(<WelcomeDecisionPanel authEntryOptions={baseOptions} {...callbacks} />);

        expect(screen.findByTestId('welcome-scan-existing-home')).toBeTruthy();
    });

    it('keeps paste-based Home entry available when the caller cannot scan', async () => {
        const callbacks = {
            onContinueWithHomeAuthentication: vi.fn(),
            onOpenRestore: vi.fn(),
            onChangeRelay: vi.fn(),
        };
        const screen = await renderScreen(<WelcomeDecisionPanel
            authEntryOptions={baseOptions}
            {...callbacks}
            canScanQr={false}
        />);

        expect(screen.findByTestId('welcome-scan-existing-home')).toBeTruthy();
        expect(screen.findByTestId('welcome-scan-existing-home-title')?.props.children)
            .toBe('Enter URL manually');
        expect(screen.findByTestId('welcome-scan-existing-home-subtitle')?.props.children)
            .toBe('Paste the pairing link shown on the other device.');
        expect(screen.findByTestId('welcome-use-different-home')).toBeTruthy();
    });

    it('uses semantic action identity for accessibility descriptions and pending state', async () => {
        let resolveAction: (() => void) | null = null;
        const pending = new Promise<void>((resolve) => { resolveAction = resolve; });
        const callbacks = {
            onContinueWithHomeAuthentication: vi.fn(() => pending),
            onOpenRestore: vi.fn(),
            onChangeRelay: vi.fn(),
        };
        const screen = await renderScreen(<WelcomeDecisionPanel authEntryOptions={baseOptions} {...callbacks} canScanQr />);
        const primary = screen.findByTestId('welcome-primary-start');
        const subtitle = screen.findByTestId('welcome-primary-start-subtitle');
        expect(primary?.props['aria-describedby']).toBe(subtitle?.props.nativeID);

        let pressPromise: Promise<void> | null = null;
        act(() => { pressPromise = screen.pressByTestIdAsync('welcome-primary-start'); });
        await vi.waitFor(() => expect(screen.findByTestId('welcome-primary-start')?.props.accessibilityState.busy).toBe(true));
        expect(screen.findByTestId('welcome-scan-existing-home')?.props.accessibilityState.busy).toBe(false);
        await act(async () => {
            resolveAction?.();
            await pressPromise;
        });
    });

    it('offers the selected sign-in service methods as familiar provider actions and keeps QR entry', async () => {
        const { callbacks, screenPromise } = renderPanel(
            { authenticationActions: [...baseOptions.authenticationActions!, { method: { id: 'github', enabledActions: [{ id: 'provision', mode: 'keyed' }] }, action: { id: 'provision', mode: 'keyed' }, execution: { kind: 'oauth', providerId: 'github', mode: 'keyed' } }] },
            readyAccountServiceEntry(['github', 'google']),
        );
        const screen = await screenPromise;

        expect(screen.findByTestId('welcome-account-service-provider-github-title')?.props.children)
            .toBe('Continue with GitHub');
        expect(screen.findByTestId('welcome-account-service-provider-google')).toBeTruthy();
        // Named-account methods augment the exact Home methods instead of replacing them.
        expect(screen.findByTestId('welcome-primary-start')).toBeTruthy();
        expect(screen.findByTestId('welcome-login-provider')).toBeTruthy();
        expect(screen.findAllByTestId('welcome-private-key-copy')).toHaveLength(0);
        // Direct QR entry stays available.
        expect(screen.findByTestId('welcome-scan-existing-home')).toBeTruthy();
        expect(screen.findByTestId('welcome-use-different-home')).toBeTruthy();

        await screen.pressByTestIdAsync('welcome-account-service-provider-google');
        await screen.pressByTestIdAsync('welcome-scan-existing-home');

        expect(callbacks.onContinueWithAccountServiceProvider).toHaveBeenCalledWith(expect.objectContaining({
            method: expect.objectContaining({ id: 'google' }),
            authority: expect.objectContaining({ purpose: 'account_service' }),
        }));
        expect(callbacks.onOpenRestore).toHaveBeenCalledTimes(1);
    });

    it('uses exact verified method presentation ahead of the local provider fallback', async () => {
        const { callbacks, screenPromise } = renderPanel(
            {},
            readyAccountServiceEntry(['github'], { oauthPresentationName: 'Company Identity' }),
        );
        const screen = await screenPromise;
        const action = screen.findByTestId('welcome-account-service-provider-github');

        expect(action?.props.accessibilityLabel).toBe('Continue with Company Identity');
        await screen.pressByTestIdAsync('welcome-account-service-provider-github');
        expect(callbacks.onContinueWithAccountServiceProvider).toHaveBeenCalledWith(expect.objectContaining({
            method: expect.objectContaining({ presentation: { displayName: 'Company Identity' } }),
        }));
    });

    it('keeps provider provisioning new-here while presenting its keyless execution truthfully', async () => {
        const { callbacks, screenPromise } = renderPanel(
            { requestedHomeTarget: undefined },
            readyAccountServiceEntry(['github'], {
                oauthAction: 'provision',
                oauthMode: 'keyless',
                oauthPresentationName: 'Company Identity',
            }),
        );
        const screen = await screenPromise;
        const action = screen.findByTestId('welcome-account-service-provider-github');

        expect(action?.props.accessibilityLabel).toBe('New here?');
        expect(action?.props.accessibilityHint).toBe('Create an account with Happier Cloud, then find or add your Home.');
        await screen.pressByTestIdAsync('welcome-account-service-provider-github');
        expect(callbacks.onContinueWithAccountServiceProvider).toHaveBeenCalledWith(expect.objectContaining({
            action: { id: 'provision', mode: 'keyless' },
            execution: { kind: 'oauth', providerId: 'github', mode: 'keyless' },
        }));
    });

    it('offers the advertised key method for a key-only selected sign-in service', async () => {
        const { callbacks, screenPromise } = renderPanel(
            {},
            readyAccountServiceEntry([], { keyLoginAvailable: true }),
        );
        const screen = await screenPromise;

        expect(screen.findByTestId('welcome-account-service-key')?.props.accessibilityLabel)
            .toBe('Use a key');
        expect(screen.findByTestId('welcome-primary-start')).toBeTruthy();
        expect(screen.findAllByTestId('welcome-private-key-copy')).toHaveLength(0);
        // Direct QR entry stays available.
        expect(screen.findByTestId('welcome-scan-existing-home')).toBeTruthy();
        expect(screen.findByTestId('welcome-use-different-home')).toBeTruthy();

        await screen.pressByTestIdAsync('welcome-account-service-key');

        expect(callbacks.onContinueWithAccountServiceKey).toHaveBeenCalledTimes(1);
        expect(callbacks.onContinueWithAccountServiceProvider).not.toHaveBeenCalled();
    });

    it('keeps Home authentication usable when the optional service is methodless', async () => {
        const { screenPromise } = renderPanel(
            {},
            readyAccountServiceEntry([], { keyLoginAvailable: false }),
        );
        const screen = await screenPromise;

        expect(screen.findAllByTestId('welcome-account-service-key')).toHaveLength(0);
        expect(screen.findByTestId('welcome-account-service-recovery')).toBeTruthy();
        expect(screen.findAllByTestId('welcome-account-service-choose')).toHaveLength(0);
        expect(screen.findByTestId('welcome-primary-start')).toBeTruthy();
    });

    it('keeps Home authentication usable while the optional service is loading', async () => {
        const { screenPromise } = renderPanel({}, {
            effectiveSignInService: {
                kind: 'no_target_default',
                endpoint: 'https://api.happier.dev',
            },
            endpoint: { url: 'https://api.happier.dev', source: 'default' },
            status: 'loading',
            discovery: null,
            transport: {},
            retry: vi.fn(),
        });
        const screen = await screenPromise;

        expect(screen.findByTestId('welcome-account-service-loading')).toBeTruthy();
        expect(screen.findByTestId('welcome-primary-start')).toBeTruthy();
    });

    it('keeps Home authentication usable when the optional service is unavailable', async () => {
        const retry = vi.fn();
        const { callbacks, screenPromise } = renderPanel({}, {
            effectiveSignInService: { kind: 'no_target_default', endpoint: 'https://accounts.company.test' },
            endpoint: { url: 'https://accounts.company.test', source: 'user' },
            status: 'unavailable',
            discovery: null,
            transport: {},
            retry,
        });
        const screen = await screenPromise;

        expect(screen.findAllByTestId('welcome-account-service-provider-github')).toHaveLength(0);
        expect(screen.findByTestId('welcome-primary-start')).toBeTruthy();
        expect(screen.findByTestId('welcome-account-service-recovery')).toBeTruthy();
        expect(screen.findAllByTestId('welcome-account-service-choose')).toHaveLength(0);
        expect(screen.findByTestId('welcome-scan-existing-home')).toBeTruthy();
        expect(screen.findByTestId('welcome-use-different-home')).toBeTruthy();

        await screen.pressByTestIdAsync('welcome-account-service-retry');

        expect(retry).toHaveBeenCalledTimes(1);
        expect(callbacks.onChooseAccountService).not.toHaveBeenCalled();
        expect(callbacks.onContinueWithAccountServiceProvider).not.toHaveBeenCalled();
    });

    it('explains and announces a failed sign-in service instead of showing a bare title', async () => {
        const { screenPromise } = renderPanel({}, {
            effectiveSignInService: { kind: 'no_target_default', endpoint: 'https://accounts.company.test' },
            endpoint: { url: 'https://accounts.company.test', displayName: 'Acme ID', source: 'user' },
            status: 'unavailable',
            discovery: null,
            transport: {},
            retry: vi.fn(),
        });
        const screen = await screenPromise;

        const notice = screen.findByTestId('welcome-account-service-recovery');
        expect(notice?.props.accessibilityLiveRegion).toBe('polite');
        expect(screen.getTextContent()).toContain('Acme ID');
        expect(screen.getTextContent()).toContain('You can still use this Home');
    });

    it('shows one Loading block while both first-paint probes are in flight', async () => {
        const { screenPromise } = renderPanel({ serverAvailability: 'loading' }, {
            effectiveSignInService: { kind: 'no_target_default', endpoint: 'https://api.happier.dev' },
            endpoint: { url: 'https://api.happier.dev', source: 'default' },
            status: 'loading',
            discovery: null,
            transport: {},
            retry: vi.fn(),
        });
        const screen = await screenPromise;

        expect(screen.findAllByTestId('welcome-auth-loading')).toHaveLength(1);
        expect(screen.findAllByTestId('welcome-account-service-loading')).toHaveLength(0);
    });

    it('keeps Home authentication usable when the optional service is unsupported', async () => {
        const { screenPromise } = renderPanel({}, {
            effectiveSignInService: { kind: 'no_target_default', endpoint: 'https://ordinary-home.test' },
            endpoint: { url: 'https://ordinary-home.test', source: 'user' },
            status: 'unsupported',
            discovery: null,
            transport: {},
            retry: vi.fn(),
        });
        const screen = await screenPromise;

        expect(screen.findByTestId('welcome-account-service-recovery')).toBeTruthy();
        expect(screen.findByTestId('welcome-primary-start')).toBeTruthy();
    });

    it('promotes login and explains the policy when the server exposes no signup action', async () => {
        const { callbacks, screenPromise } = renderPanel({
            authenticationActions: [],
        });
        const screen = await screenPromise;

        expect(screen.findByTestId('welcome-signup-disabled')).toBeTruthy();
        expect(screen.findAllByTestId('welcome-primary-start')).toHaveLength(0);
        expect(screen.findAllByTestId('welcome-provider-primary')).toHaveLength(0);
        expect(screen.findByTestId('welcome-scan-existing-home')).toBeTruthy();
        expect(screen.findByTestId('welcome-use-different-home')).toBeTruthy();

        await screen.pressByTestIdAsync('welcome-scan-existing-home');

        expect(callbacks.onOpenRestore).toHaveBeenCalledTimes(1);
    });

    it('explains closed signup as an intentional Personal Home policy without redirecting the owner to an admin', async () => {
        const { screenPromise } = renderPanel({
            authenticationActions: [],
            isPersonalHome: true,
        });
        const screen = await screenPromise;
        const notice = screen.findByTestId('welcome-signup-disabled');

        expect(notice?.props.children).toBe(t('personalHome.auth.signupClosed'));
        expect(notice?.props.children).not.toBe(t('errors.signupDisabled'));
    });
});
