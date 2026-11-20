import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

// These sign-in scenarios use the Cloud distributor's configured defaults.
vi.hoisted(() => vi.stubEnv('EXPO_PUBLIC_HAPPIER_BUILD_DEFAULT_PROFILE_JSON', JSON.stringify({
    home: { url: 'https://api.happier.dev' },
    accountService: { url: 'https://api.happier.dev' },
})));
import { act } from 'react-test-renderer';
import { Dimensions } from 'react-native';

import { renderScreen } from '@/dev/testkit';
import type { AccountServiceEntryOptions } from '@/components/account/auth/useAccountServiceEntryOptions';
import type { AuthEntryOptions } from '@/components/account/auth/useAuthEntryOptions';
import { buildServerFeaturesResponse } from '@/hooks/server/serverFeaturesTestUtils';
import { lastSignInMethodState, onboardingAuthHistoryState } from '@/sync/domains/state/onboardingUiState';
import { t } from '@/text';
import { FirstOpenWelcomeModelContext } from '@/components/onboarding/firstOpen/FirstOpenWelcomeModelContext';

import { WelcomeDecisionPanel } from './WelcomeDecisionPanel';
import { WelcomeEntryView, type WelcomeEntryViewModel } from './WelcomeEntryView';

it('renders the same display model live and in an inert opening replica', async () => {
    const publish = vi.fn<(model: WelcomeEntryViewModel) => void>();
    const screen = await renderScreen(
        <FirstOpenWelcomeModelContext.Provider value={publish}>
            <WelcomeDecisionPanel authEntryOptions={baseOptions} onOpenRestore={vi.fn()}
                onOpenSecretKeyLogin={vi.fn()} onChangeRelay={vi.fn()} onConnectHomeDirectly={vi.fn()}
                onContinueWithHomeAuthentication={vi.fn()} />
        </FirstOpenWelcomeModelContext.Provider>,
    );
    const [published] = publish.mock.calls[0] ?? [];
    expect(published).toBeDefined();
    const serialized = JSON.stringify(published);
    expect(serialized).not.toMatch(/home-a|relay\.example\.test|authority|execution|profileRef/);
    const replica = await renderScreen(<WelcomeEntryView
        model={JSON.parse(serialized)} compact={false}
    />);
    expect(replica.findByTestId('welcome-decision-panel')?.props.pointerEvents).toBe('none');
    expect(replica.findByTestId('welcome-primary-start-title')).not.toBeNull();
    expect(replica.findByTestId('welcome-primary-start-title')?.props.children).toEqual(
        screen.findByTestId('welcome-primary-start-title')?.props.children,
    );
});

// The controller supplies the camera affordance to the panel as a fact.
let cameraAvailable = false;

/** Runs a case on a computer-sized or phone-sized window (the window is a platform boundary). */
async function onDevice(device: 'computer' | 'phone', hasCamera: boolean, run: () => Promise<void>) {
    const window = device === 'phone'
        ? { width: 390, height: 844, scale: 1, fontScale: 1 }
        : { width: 1440, height: 900, scale: 1, fontScale: 1 };
    const get = vi.spyOn(Dimensions, 'get').mockReturnValue(window);
    cameraAvailable = hasCamera;
    try { await run(); } finally { get.mockRestore(); cameraAvailable = false; }
}

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
    canScanQr = true,
    restoreWays = false,
) {
    const options: AuthEntryOptions = { ...baseOptions, ...overrides };
    const callbacks = {
        onContinueWithHomeAuthentication: vi.fn(),
        onOpenRestore: vi.fn(),
        onChangeRelay: vi.fn(),
        onConnectHomeDirectly: vi.fn(),
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
                canScanQr={canScanQr}
                restoreWays={restoreWays}
                {...callbacks}
            />,
        ),
    };
}

/** A sign-in service the person chose themselves (Change): the Welcome lists its methods instead of the first-run doorway. */
function chosenAccountServiceEntry(entry: AccountServiceEntryOptions): AccountServiceEntryOptions {
    return { ...entry, endpoint: { ...entry.endpoint, source: 'user' } } as AccountServiceEntryOptions;
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

/** A door's promise: its subtitle line, or for a pill or a way on the ways row (no second line) its accessible hint. */
function promiseOf(screen: { findByTestId: (id: string) => { props: Record<string, unknown> } | null | undefined }, testID: string): unknown {
    return screen.findByTestId(`${testID}-subtitle`)?.props.children ?? screen.findByTestId(testID)?.props.accessibilityHint;
}

describe('WelcomeDecisionPanel', () => {
    it.each(['incompatible', 'unavailable'] as const)('names the selected Home in the %s status instead of its address', async (serverAvailability) => {
        const { screenPromise } = renderPanel({ serverAvailability });
        const screen = await screenPromise;
        const copy = serverAvailability === 'incompatible'
            ? t('welcome.serverIncompatibleBody', { serverUrl: 'Home A' })
            : t('welcome.serverUnavailableBody', { serverUrl: 'Home A' });
        expect(screen.getTextContent()).toContain(copy);
        await screen.unmount();
    });
    it('offers direct key recovery for the same verified Home mistaken for a sign-in service', async () => {
        const onAuthenticate = vi.fn();
        const onRestore = vi.fn();
        const homeTarget = baseOptions.homeTarget!;
        const screen = await renderScreen(<WelcomeDecisionPanel
            authEntryOptions={{ ...baseOptions, requestedHomeTarget: undefined, observedHomeServerIdentityId: 'srv_home_a',
                authenticationActions: [{ method: { id: 'key_challenge', enabledActions: [{ id: 'login', mode: 'keyed' }] },
                    action: { id: 'login', mode: 'keyed' }, execution: { kind: 'key_entry' } }] }}
            accountServiceEntry={{ effectiveSignInService: { kind: 'no_target_default', endpoint: baseOptions.serverUrlForCopy },
                endpoint: { url: baseOptions.serverUrlForCopy, source: 'user' }, status: 'unsupported', discovery: null, transport: {}, retry: vi.fn() }}
            onContinueWithHomeAuthentication={onAuthenticate} onOpenRestore={onRestore} onChangeRelay={vi.fn()} onConnectHomeDirectly={vi.fn()} onChooseAccountService={vi.fn()} />);
        await screen.pressByTestIdAsync('welcome-provider-primary');
        expect(onAuthenticate).toHaveBeenCalledWith(expect.objectContaining({ execution: { kind: 'key_entry' },
            authority: { purpose: 'home', target: homeTarget }, intendedHome: homeTarget }));
        await screen.pressByTestIdAsync('welcome-scan-existing-home');
        expect(onRestore).toHaveBeenCalledOnce();
    });

    it('does not substitute an unrelated Home when the chosen sign-in service is unsupported', async () => {
        const { screenPromise } = renderPanel({ requestedHomeTarget: undefined, observedHomeServerIdentityId: 'srv_home_a' }, {
            effectiveSignInService: { kind: 'no_target_default', endpoint: 'https://other-service.test' },
            endpoint: { url: 'https://other-service.test', source: 'user' }, status: 'unsupported', discovery: null, transport: {}, retry: vi.fn(),
        });
        const screen = await screenPromise;
        expect(screen.findAllByTestId('welcome-primary-start')).toHaveLength(0);
        expect(screen.findByTestId('welcome-account-service-choose')).toBeTruthy();
    });

    it.each([
        { state: 'live', expiresInMs: 60_000, title: 'welcome.terminalContinuationTitle', subtitle: 'welcome.terminalContinuationSubtitle' },
        { state: 'expired', expiresInMs: -1, title: 'welcome.brandTaglineLine1', subtitle: 'welcome.brandTaglineLine2' },
    ] as const)('greets a person sent here by a $state terminal link', async ({ expiresInMs, title, subtitle }) => {
        const { setPendingTerminalConnect, clearPendingTerminalConnect } = await import('@/sync/domains/pending/pendingTerminalConnect');
        const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        setPendingTerminalConnect({
            publicKeyB64Url: 'A'.repeat(43),
            serverUrl: getActiveServerSnapshot().serverUrl,
            serverIdentityId: 'srv_terminal_home',
            pairing: { secretB64Url: 'B'.repeat(43), createdAtMs: Date.now() - 60_000, expiresAtMs: Date.now() + expiresInMs },
        });
        try {
            const screen = await renderScreen(
                <WelcomeDecisionPanel authEntryOptions={baseOptions} onContinueWithHomeAuthentication={vi.fn()} onOpenRestore={vi.fn()} onChangeRelay={vi.fn()} onConnectHomeDirectly={vi.fn()} />,
            );
            const headers = screen.findAll(node => typeof node.type === 'string' && node.props.accessibilityRole === 'header')
                .map(node => node.props.children);
            // The greeting leads; the quiet "Already use Happier?" group heading follows it.
            expect(headers.slice(0, 2)).toEqual([t(title), t(subtitle)]);
            await screen.unmount();
        } finally {
            clearPendingTerminalConnect();
        }
    });

    it('leaves the heading to its authentication parent while keeping sign-in actions usable', async () => {
        const onAuthenticate = vi.fn();
        const screen = await renderScreen(
            <WelcomeDecisionPanel
                authEntryOptions={baseOptions}
                showGreeting={false}
                onContinueWithHomeAuthentication={onAuthenticate}
                onOpenRestore={vi.fn()}
                onChangeRelay={vi.fn()} onConnectHomeDirectly={vi.fn()}
            />,
        );

        const greetings = screen.findAll(node => typeof node.type === 'string'
            && node.props.accessibilityRole === 'header'
            && (node.props.children === t('welcome.brandTaglineLine1')
                || node.props.children === t('welcome.brandTaglineLine2')));
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
    it('keeps a true no-target first run free of Home methods and offers the sign-in service with a way to change it', async () => {
        const noTargetOptions = { ...baseOptions };
        delete noTargetOptions.homeTarget;
        delete noTargetOptions.requestedHomeTarget;
        delete noTargetOptions.homeLabel;
        const screen = await renderScreen(
            <WelcomeDecisionPanel
                authEntryOptions={noTargetOptions}
                onChooseAccountService={vi.fn()}
                onOpenRestore={vi.fn()}
                onChangeRelay={vi.fn()} onConnectHomeDirectly={vi.fn()}
            />,
        );

        expect(screen.findAllByTestId('welcome-primary-start')).toHaveLength(0);
        expect(screen.findByTestId('welcome-scan-existing-home')).toBeTruthy();
        expect(screen.findByTestId('welcome-account-service-choose')).toBeTruthy();
    });

    it('keeps the unrelated seeded Home methods out of a default-service first run', async () => {
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
                onChangeRelay={vi.fn()} onConnectHomeDirectly={vi.fn()}
            />,
        );

        expect(screen.findAllByTestId('welcome-primary-start')).toHaveLength(0);
        expect(screen.findAllByTestId('welcome-provider-primary')).toHaveLength(0);
        await screen.pressByTestIdAsync('welcome-account-service-provider-github');
        expect(onContinueWithAccountServiceProvider).toHaveBeenCalledOnce();
    });

    it('says what each Home sign-in way does instead of repeating the Home on every card', async () => {
        const { screenPromise } = renderPanel({
            authenticationActions: [
                ...baseOptions.authenticationActions!,
                {
                    method: { id: 'key_challenge', enabledActions: [{ id: 'login', mode: 'keyed' }] },
                    action: { id: 'login', mode: 'keyed' },
                    execution: { kind: 'key_entry' },
                },
                {
                    method: { id: 'email_password', enabledActions: [{ id: 'login', mode: 'either' }] },
                    action: { id: 'login', mode: 'either' },
                    execution: { kind: 'email_password', action: 'login', mode: 'either' },
                },
            ],
        });
        const screen = await screenPromise;
        const subtitleByCard = new Map<string, string>();
        for (const node of screen.findAll((candidate) => typeof candidate.props.testID === 'string'
            && candidate.props.testID.endsWith('-subtitle') && typeof candidate.props.children === 'string')) {
            subtitleByCard.set(node.props.testID as string, node.props.children as string);
        }
        const subtitles = [...subtitleByCard.values()];

        // Quiet rows carry their description as the accessible hint, so only the cards show one.
        expect(subtitles.length).toBeGreaterThanOrEqual(1);
        // One message per card: no two sibling cards describe themselves with the same words,
        // and the Home's bare name never stands in for what a card does.
        expect(new Set(subtitles).size).toBe(subtitles.length);
        expect(subtitles).not.toContain('Home A');
    });

    it('shows a Home fixed by organization policy as managed, leaving out the ways to pick another', async () => {
        vi.stubGlobal('isTauri', true);
        vi.stubGlobal('document', {});
        vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn(), __HAPPIER_WEB_RUNTIME_CONFIG__: {
            organizationPolicyJson: JSON.stringify({ schemaVersion: 1, organization: 'Example Co',
                home: { url: 'https://home.example.test', locked: true } }),
        } });
        try {
            const screen = await renderPanel().screenPromise;
            expect(screen.findByTestId('organization-policy-home')).toBeTruthy();
            expect(screen.findByTestId('welcome-use-different-home')).toBeNull();
            expect(screen.findByTestId('welcome-scan-existing-home')).toBeNull();
            expect(screen.findByTestId('welcome-primary-start')).toBeTruthy();
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('gives an unreadable organization policy one way forward instead of an empty panel', async () => {
        vi.stubGlobal('isTauri', true);
        vi.stubGlobal('document', {});
        vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn(), __HAPPIER_WEB_RUNTIME_CONFIG__: {
            organizationPolicyError: { path: 'home.url', code: 'invalid_format' },
        } });
        try {
            const screen = await renderPanel().screenPromise;
            expect(screen.findByTestId('organization-policy-invalid-next-step')).toBeTruthy();
            expect(screen.findByTestId('organization-policy-invalid-next-step-guide')).toBeTruthy();
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('routes anonymous start and restore actions from stable controls', async () => {
        const { callbacks, screenPromise } = renderPanel();
        const screen = await screenPromise;

        expect(screen.findByTestId('welcome-decision-panel')).toBeTruthy();
        expect(screen.findByTestId('welcome-primary-start-title')).toBeTruthy();
        expect(screen.findByTestId('welcome-primary-start-subtitle')).toBeTruthy();
        expect(screen.findByTestId('welcome-primary-start-icon')).toBeTruthy();
        expect(screen.findByTestId('welcome-scan-existing-home-title')).toBeTruthy();
        expect(screen.findByTestId('welcome-scan-existing-home-icon')).toBeTruthy();
        expect(screen.findByTestId('welcome-use-different-home-title')).toBeNull();
        expect(screen.findByTestId('welcome-primary-start-title')?.props.children).toBe(t('welcome.welcomePrimaryButton'));
        expect(screen.findByTestId('welcome-scan-existing-home-title')?.props.children).toBe(t('welcome.welcomeSecondaryButton'));
        // The card chrome is the animated frame inside the pressable hit area.
        const primaryStyle = flattenStyle(screen.findByTestId('welcome-primary-start-text')?.parent?.props.style);
        const textBlockStyle = flattenStyle(screen.findByTestId('welcome-primary-start-text')?.props.style);
        expect(primaryStyle.minHeight).toBe(66);
        expect(primaryStyle.paddingHorizontal).toBe(18);
        expect(primaryStyle.paddingVertical).toBe(10);
        expect(textBlockStyle.gap).toBe(0);
        expect(screen.findByTestId('welcome-primary-start')?.props.accessibilityHint)
            .toBe(t('welcome.welcomePrimarySubtitle'));

        await screen.pressByTestIdAsync('welcome-primary-start');
        await screen.pressByTestIdAsync('welcome-scan-existing-home');

        expect(callbacks.onContinueWithHomeAuthentication).toHaveBeenCalledWith(expect.objectContaining({
            action: { id: 'provision', mode: 'keyed' },
            authority: { purpose: 'home', target: { kind: 'saved_profile', profileRef: 'home-a' } },
            execution: { kind: 'generated_key' },
            method: expect.objectContaining({ id: 'key_challenge' }),
        }));
        expect(callbacks.onOpenRestore).toHaveBeenCalledTimes(1);
    });

    it('uses provider signup as the New here action', async () => {
        const { callbacks, screenPromise } = renderPanel({
            authenticationActions: [{
                method: { id: 'github', enabledActions: [{ id: 'provision', mode: 'keyed' }] },
                action: { id: 'provision', mode: 'keyed' },
                execution: { kind: 'oauth', providerId: 'github', mode: 'keyed' },
            }],
        });
        const screen = await screenPromise;

        expect(screen.findByTestId('welcome-primary-start')).toBeTruthy();

        await screen.pressByTestIdAsync('welcome-primary-start');

        expect(callbacks.onContinueWithHomeAuthentication).toHaveBeenCalledWith(expect.objectContaining({
            execution: { kind: 'oauth', providerId: 'github', mode: 'keyed' },
        }));
    });

    it('makes keyless provider login the primary action without a New here entry', async () => {
        const { callbacks, screenPromise } = renderPanel({
            authenticationActions: [{
                method: { id: 'github', enabledActions: [{ id: 'login', mode: 'keyless' }] },
                action: { id: 'login', mode: 'keyless' },
                execution: { kind: 'oauth', providerId: 'github', mode: 'keyless' },
            }],
        });
        const screen = await screenPromise;

        expect(screen.findAllByTestId('welcome-primary-start')).toHaveLength(0);

        await screen.pressByTestIdAsync('welcome-provider-primary');

        expect(callbacks.onContinueWithHomeAuthentication).toHaveBeenCalledWith(expect.objectContaining({
            execution: { kind: 'oauth', providerId: 'github', mode: 'keyless' },
        }));
    });

    it('offers the Home provider and Home switch on the Login step after one-tap Welcome', async () => {
        const options: Partial<AuthEntryOptions> = {
            authenticationActions: [...baseOptions.authenticationActions!, { method: { id: 'github', enabledActions: [{ id: 'login', mode: 'keyless' }] }, action: { id: 'login', mode: 'keyless' }, execution: { kind: 'oauth', providerId: 'github', mode: 'keyless' } }],
        };
        const welcome = await renderPanel(options).screenPromise;
        expect(welcome.findByTestId('welcome-primary-start')).toBeTruthy();
        expect(welcome.findByTestId('welcome-login-provider')).toBeNull();
        await welcome.unmount();

        const { callbacks, screenPromise } = renderPanel(options, undefined, true, true);
        const login = await screenPromise;
        await login.pressByTestIdAsync('welcome-provider-primary');

        expect(callbacks.onContinueWithHomeAuthentication).toHaveBeenCalledWith(expect.objectContaining({
            execution: { kind: 'oauth', providerId: 'github', mode: 'keyless' },
        }));
        await login.pressByTestIdAsync('welcome-use-different-home');
        expect(callbacks.onChangeRelay).toHaveBeenCalledOnce();
    });

    it('makes mTLS login the primary action without a New here entry', async () => {
        const { callbacks, screenPromise } = renderPanel({
            authenticationActions: [{
                method: { id: 'mtls', enabledActions: [{ id: 'login', mode: 'keyless' }] },
                action: { id: 'login', mode: 'keyless' },
                execution: { kind: 'mtls' },
            }],
        });
        const screen = await screenPromise;

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

        await screen.pressByTestIdAsync('welcome-scan-existing-home');
        expect(callbacks.onOpenRestore).toHaveBeenCalledTimes(1);
    });

    it('connects to a Home directly through the welcome step on every width, not the Home chooser', async () => {
        // No Home yet, with a sign-in service the person chose: the action is "Connect to a Home directly" (owner 11-13: one flow).
        const { callbacks, screenPromise } = renderPanel({ homeTarget: undefined, requestedHomeTarget: undefined, homeLabel: undefined, serverUrlForCopy: '' },
            chosenAccountServiceEntry(readyAccountServiceEntry(['github'])));
        const screen = await screenPromise;
        expect(screen.findByTestId('welcome-use-different-home')?.props.accessibilityLabel).toBe('Connect to a Home directly');

        await screen.pressByTestIdAsync('welcome-use-different-home');
        expect(callbacks.onConnectHomeDirectly).toHaveBeenCalledTimes(1);
        expect(callbacks.onChangeRelay).not.toHaveBeenCalled();
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

    it('keeps paste-based Home entry available when camera capability is not reported', async () => {
        const callbacks = {
            onContinueWithHomeAuthentication: vi.fn(),
            onOpenRestore: vi.fn(),
            onChangeRelay: vi.fn(),
            onConnectHomeDirectly: vi.fn(),
        };
        const screen = await renderScreen(<WelcomeDecisionPanel authEntryOptions={baseOptions} {...callbacks} />);

        await screen.pressByTestIdAsync('welcome-scan-existing-home');
        expect(callbacks.onOpenRestore).toHaveBeenCalledTimes(1);
    });

    it('keeps paste-based Home entry available when the caller cannot scan', async () => {
        const callbacks = {
            onContinueWithHomeAuthentication: vi.fn(),
            onOpenRestore: vi.fn(),
            onChangeRelay: vi.fn(),
            onConnectHomeDirectly: vi.fn(),
        };
        const screen = await renderScreen(<WelcomeDecisionPanel
            authEntryOptions={baseOptions}
            {...callbacks}
            canScanQr={false}
        />);

        // The Login door opens the same restore surface, which starts on its pairing-link field here.
        expect(screen.findByTestId('welcome-scan-existing-home-title')?.props.children).toBe(t('welcome.welcomeSecondaryButton'));
        await screen.pressByTestIdAsync('welcome-scan-existing-home');
        expect(callbacks.onOpenRestore).toHaveBeenCalledTimes(1);
        expect(screen.findByTestId('welcome-use-different-home')).toBeNull();
    });

    it('uses semantic action identity for accessibility descriptions and pending state', async () => {
        let resolveAction: (() => void) | null = null;
        const pending = new Promise<void>((resolve) => { resolveAction = resolve; });
        const callbacks = {
            onContinueWithHomeAuthentication: vi.fn(() => pending),
            onOpenRestore: vi.fn(),
            onChangeRelay: vi.fn(),
            onConnectHomeDirectly: vi.fn(),
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

    it('keeps the Home GitHub way on Login and opens the service selector for external providers', async () => {
        const options: Partial<AuthEntryOptions> = {
            authenticationActions: [...baseOptions.authenticationActions!, { method: { id: 'github', enabledActions: [{ id: 'provision', mode: 'keyed' }] }, action: { id: 'provision', mode: 'keyed' }, execution: { kind: 'oauth', providerId: 'github', mode: 'keyed' } }],
        };
        const service = readyAccountServiceEntry(['github', 'google']);
        const welcome = renderPanel(options, service);
        const first = await welcome.screenPromise;
        expect(first.findByTestId('welcome-primary-start')).toBeTruthy();
        expect(first.findByTestId('welcome-account-service-provider-github')).toBeNull();
        await first.pressByTestIdAsync('welcome-scan-existing-home');
        expect(welcome.callbacks.onOpenRestore).toHaveBeenCalledTimes(1);
        await first.unmount();

        const { callbacks, screenPromise } = renderPanel(options, service, true, true);
        const screen = await screenPromise;

        expect(screen.findByTestId('welcome-provider-primary')?.props.accessibilityLabel)
            .toBe('Continue with GitHub');
        expect(screen.findByTestId('welcome-account-service-provider-github')).toBeNull();
        expect(screen.findByTestId('welcome-account-service-provider-google')).toBeNull();
        expect(screen.findByTestId('restore-new-account')).toBeTruthy();
        expect(screen.findByTestId('welcome-use-different-home')).toBeTruthy();

        await screen.pressByTestIdAsync('welcome-provider-primary');
        expect(callbacks.onContinueWithHomeAuthentication).toHaveBeenCalledWith(expect.objectContaining({
            method: expect.objectContaining({ id: 'github' }),
            authority: expect.objectContaining({ purpose: 'home' }),
        }));
        await screen.pressByTestIdAsync('welcome-account-service-choose');
        expect(callbacks.onChooseAccountService).toHaveBeenCalledTimes(1);
    });

    it('uses exact verified method presentation ahead of the local provider fallback', async () => {
        const { callbacks, screenPromise } = renderPanel(
            { requestedHomeTarget: undefined },
            chosenAccountServiceEntry(readyAccountServiceEntry(['github'], { oauthPresentationName: 'Company Identity' })),
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
            chosenAccountServiceEntry(readyAccountServiceEntry(['github'], {
                oauthAction: 'provision',
                oauthMode: 'keyless',
                oauthPresentationName: 'Company Identity',
            })),
        );
        const screen = await screenPromise;
        const action = screen.findByTestId('welcome-account-service-provider-github');

        expect(action?.props.accessibilityLabel).toBe(t('welcome.welcomePrimaryButton'));
        expect(action?.props.accessibilityHint).toBe('Create an account with Happier Cloud, then find or add your Home.');
        await screen.pressByTestIdAsync('welcome-account-service-provider-github');
        expect(callbacks.onContinueWithAccountServiceProvider).toHaveBeenCalledWith(expect.objectContaining({
            action: { id: 'provision', mode: 'keyless' },
            execution: { kind: 'oauth', providerId: 'github', mode: 'keyless' },
        }));
    });

    it('offers the advertised key method for a key-only selected sign-in service', async () => {
        const { callbacks, screenPromise } = renderPanel(
            { requestedHomeTarget: undefined },
            chosenAccountServiceEntry(readyAccountServiceEntry([], { keyLoginAvailable: true })),
        );
        const screen = await screenPromise;

        expect(screen.findByTestId('welcome-account-service-key')?.props.accessibilityLabel)
            .toBe('Use a key');

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
        expect(screen.findByTestId('welcome-use-different-home')).toBeNull();

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

        const notice = screen.findHostByTestId('welcome-account-service-recovery');
        expect(notice).toBeTruthy();
        // The notice announces itself once, politely, through the shared state line's live region.
        expect(screen.findAll((node) => node.props?.accessibilityLiveRegion === 'polite' || node.props?.['aria-live'] === 'polite').length).toBeGreaterThan(0);
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

        expect(screen.findAllHostsByTestId('welcome-auth-loading')).toHaveLength(1);
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

    // Owner decisions 11-15 (WF-BUILD-1115): 0.2's Welcome behaviours on the 0.3 layout.
    describe('0.2 doors and device history', () => {
        const keyAndEmail: AuthEntryOptions['authenticationActions'] = [
            ...baseOptions.authenticationActions!,
            {
                method: { id: 'key_challenge', enabledActions: [{ id: 'login', mode: 'keyed' }] },
                action: { id: 'login', mode: 'keyed' },
                execution: { kind: 'key_entry' },
            },
            {
                method: { id: 'email_password', enabledActions: [{ id: 'login', mode: 'either' }] },
                action: { id: 'login', mode: 'either' },
                execution: { kind: 'email_password', action: 'login', mode: 'either' },
            },
        ];
        const withHistory = async (history: Readonly<{ returning: boolean; method?: string }>, run: () => Promise<void>) => {
            onboardingAuthHistoryState.set('completed', history.returning);
            if (history.method) lastSignInMethodState.set('method', history.method);
            else lastSignInMethodState.remove('method');
            try { await run(); } finally {
                onboardingAuthHistoryState.remove('completed');
                lastSignInMethodState.remove('method');
            }
        };
        // Doors carry a title line; a way on the ways row is a round mark named by its tooltip.
        const titles = (screen: Awaited<ReturnType<typeof renderPanel>['screenPromise']>) => screen
            .findAll((node) => (typeof node.props.testID === 'string' && node.props.testID.endsWith('-title')
                && typeof node.props.children === 'string')
                || (typeof node.props.tooltip === 'string' && node.props.tooltip === node.props.accessibilityLabel))
            .map((node) => (typeof node.props.tooltip === 'string' ? node.props.tooltip : node.props.children) as string)
            .filter((title, index, all) => all.indexOf(title) === index);

        it('first time: the intro line, First time here and its Login peer, with no email needed for a generated key', async () => {
            await onDevice('computer', false, () => withHistory({ returning: false }, async () => {
                const { callbacks, screenPromise } = renderPanel({ authenticationActions: keyAndEmail });
                const screen = await screenPromise;
                const text = screen.getTextContent();
                expect(text).toContain(t('welcome.brandSubTagline'));
                expect(titles(screen).slice(0, 2)).toEqual([t('welcome.welcomePrimaryButton'), t('welcome.welcomeSecondaryButton')]);
                expect(screen.findByTestId('welcome-primary-start-subtitle')?.props.children).toBe(t('welcome.welcomePrimarySubtitle'));
                // A computer's Login leads with the recovery key, so its door promises that first.
                expect(promiseOf(screen, 'welcome-scan-existing-home')).toBe(t('welcome.loginSubtitleKeyFirst'));
                // Login is the door for the key; "Already use Happier?" is its title now, not a label over rows.
                expect(titles(screen)).not.toContain(t('welcome.continueWithKey'));
                expect(text).not.toContain(t('homesJourneys.alreadyUseTitle'));
                await screen.pressByTestIdAsync('welcome-scan-existing-home');
                expect(callbacks.onOpenRestore).toHaveBeenCalledTimes(1);
                await screen.unmount();
            }));
        });

        it('the Login door promises only what Login offers on this device', async () => {
            const doorSubtitle = async () => {
                const { screenPromise } = renderPanel({ authenticationActions: keyAndEmail }, undefined, cameraAvailable);
                const screen = await screenPromise;
                const subtitle = promiseOf(screen, 'welcome-scan-existing-home');
                await screen.unmount();
                return subtitle;
            };
            await withHistory({ returning: false }, async () => {
                // A phone leads with the link: with a camera the QR code comes first, without one the paste does.
                await onDevice('phone', true, async () => {
                    expect(await doorSubtitle()).toBe(t('welcome.welcomeSecondarySubtitle'));
                });
                await onDevice('phone', false, async () => {
                    expect(await doorSubtitle()).toBe(t('welcome.loginSubtitleLinkFirst'));
                });
                // A computer never promises a QR code it leads away from, camera or not.
                await onDevice('computer', true, async () => {
                    expect(await doorSubtitle()).toBe(t('welcome.loginSubtitleKeyFirst'));
                });
            });
        });

        it('first time on a Home whose new account needs an email: the intro never says no email is needed', async () => {
            await withHistory({ returning: false }, async () => {
                const { screenPromise } = renderPanel({
                    authenticationActions: [{
                        method: { id: 'email_password', enabledActions: [{ id: 'provision', mode: 'either' }] },
                        action: { id: 'provision', mode: 'either' },
                        execution: { kind: 'email_password', action: 'provision', mode: 'either' },
                    }],
                });
                const screen = await screenPromise;
                expect(screen.getTextContent()).toContain(t('welcome.brandSubTagline'));
                expect(screen.findByTestId('welcome-primary-start-subtitle')?.props.children)
                    .toBe(t('welcome.newHereHomeSubtitle', { home: 'Home A' }));
                await screen.unmount();
            });
        });

        it('returning with email last time: Login leads with email, then Start fresh with a new key', async () => {
            await withHistory({ returning: true, method: 'email_password' }, async () => {
                const { callbacks, screenPromise } = renderPanel({ authenticationActions: keyAndEmail });
                const screen = await screenPromise;
                const text = screen.getTextContent();
                expect(titles(screen).slice(0, 2)).toEqual([t('welcome.welcomeReturningLoginButton'), t('welcome.welcomeReturningStartFreshButton')]);
                expect(text).toContain(t('welcome.lastTimeEmail'));
                expect(promiseOf(screen, 'welcome-primary-start')).toBe(t('welcome.welcomeReturningStartFreshSubtitle'));
                expect(titles(screen)).toContain(t('welcome.continueWithKey'));
                await screen.pressByTestIdAsync('welcome-email-password-login');
                expect(callbacks.onContinueWithHomeAuthentication).toHaveBeenCalledWith(expect.objectContaining({
                    execution: expect.objectContaining({ kind: 'email_password', action: 'login' }),
                }));
                await screen.unmount();
            });
        });

        it('returning with a key last time names the key', async () => {
            await withHistory({ returning: true, method: 'key_challenge' }, async () => {
                const { screenPromise } = renderPanel({ authenticationActions: keyAndEmail });
                const screen = await screenPromise;
                expect(titles(screen)[0]).toBe(t('welcome.welcomeReturningLoginButton'));
                expect(screen.getTextContent()).toContain(t('welcome.lastTimeKey'));
                await screen.unmount();
            });
        });

        it('never repeats the Login door in the returning greeting', async () => {
            // Randomness is the greeting pool's boundary: pick the pool's first subtitle.
            const random = vi.spyOn(Math, 'random').mockReturnValue(0);
            try {
                await withHistory({ returning: true, method: 'key_challenge' }, async () => {
                    const { screenPromise } = renderPanel({ authenticationActions: keyAndEmail });
                    const screen = await screenPromise;
                    const text = screen.getTextContent();
                    expect(text).toContain(t('welcome.welcomeReturningLoginButton'));
                    expect(text).not.toContain(t('welcome.welcomeReturningSubtitle1'));
                    expect(text).toContain(t('welcome.welcomeReturningSubtitle3'));
                    await screen.unmount();
                });
            } finally {
                random.mockRestore();
            }
        });

        it('returning with nothing recorded: Login is the QR or key door', async () => {
            await onDevice('computer', false, () => withHistory({ returning: true }, async () => {
                const { callbacks, screenPromise } = renderPanel({ authenticationActions: keyAndEmail });
                const screen = await screenPromise;
                expect(screen.findByTestId('welcome-scan-existing-home-title')?.props.children).toBe(t('welcome.welcomeReturningLoginButton'));
                expect(promiseOf(screen, 'welcome-scan-existing-home')).toBe(t('welcome.loginSubtitleKeyFirst'));
                await screen.pressByTestIdAsync('welcome-scan-existing-home');
                expect(callbacks.onOpenRestore).toHaveBeenCalledTimes(1);
                await screen.unmount();
            }));
        });

        it('offers self-hosting on the build\'s own Home and the Home switch on a chosen one', async () => {
            await withHistory({ returning: true }, async () => {
                const { callbacks, screenPromise } = renderPanel({ requestedHomeTarget: undefined });
                const screen = await screenPromise;
                expect(screen.getTextContent()).toContain(t('welcome.welcomeRunYourOwnHome'));
                expect(screen.findByTestId('welcome-use-different-home')).toBeFalsy();
                await screen.pressByTestIdAsync('welcome-self-hosting');
                expect(callbacks.onChangeRelay).toHaveBeenCalledTimes(1);
                await screen.unmount();

                const chosen = await renderPanel().screenPromise;
                expect(chosen.getTextContent()).not.toContain(t('welcome.welcomeRunYourOwnHome'));
                expect(chosen.findByTestId('welcome-use-different-home')).toBeTruthy();
                await chosen.unmount();
            });
        });
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
