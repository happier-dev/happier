import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDeferred, createRootLayoutFeaturesResponse, renderScreen, standardCleanup } from '@/dev/testkit';
import type { AuthEntryOptions } from '@/components/account/auth/useAuthEntryOptions';

const network = vi.hoisted(() => ({ request: vi.fn() }));

vi.mock('@/sync/http/client', async () => {
    const actual = await vi.importActual<typeof import('@/sync/http/client')>('@/sync/http/client');
    return {
        ...actual,
        createServerFetchAtEndpoint: ({ endpointUrl }: { endpointUrl: string }) => (
            path: string,
            init?: RequestInit,
            options?: unknown,
        ) => network.request(endpointUrl, path, init, options),
    };
});

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

describe('AccountServiceSelectionForm', () => {
    afterEach(() => {
        network.request.mockReset();
        standardCleanup();
    });

    function supportedAccountService(serverIdentityId: string) {
        return createRootLayoutFeaturesResponse({
            capabilities: {
                serverIdentity: { serverIdentityId },
                server: { canonicalServerUrl: 'https://canonical-directory.example.test' },
                accountDirectory: {
                    version: 1,
                    homeDirectory: true,
                    homeEnrollment: true,
                    homeLoginAssertion: {
                        keyId: 'a'.repeat(64),
                        publicKeyBase64Url: 'A'.repeat(43),
                    },
                },
                auth: {
                    methods: [
                        {
                            id: 'key_challenge',
                            actions: [
                                { id: 'provision', enabled: true, mode: 'keyed' },
                                { id: 'login', enabled: true, mode: 'keyed' },
                            ],
                        },
                    ],
                    keyChallenge: { v2: true },
                },
            },
        });
    }

    function supportedAuthEntry() {
        return {
            v: 1,
            state: 'ready',
            scope: { kind: 'home' },
            actions: [{
                kind: 'authenticate',
                methodId: 'key_challenge',
                action: 'login',
                mode: 'keyed',
                origin: 'home',
                presentation: { displayName: 'Recovery key' },
            }],
            autoRedirect: null,
        } as const;
    }

    function authEntryResponse(): Response {
        return new Response(JSON.stringify(supportedAuthEntry()), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    }

    const authEntryOptions = {
        authenticationCatalog: { provenance: 'structured' as const, methods: [] },
        authenticationActions: [],
        keyChallengeV2Available: true,
        serverAvailability: 'ready' as const,
        authEntryUnavailable: false,
        serverUrlForCopy: 'https://home.example.test',
        showAuthActions: false,
        retryServerCheck: () => {},
    } satisfies AuthEntryOptions;

    it('retains an unsupported URL and reports the semantic result inline', async () => {
        const onSelect = vi.fn(async () => ({ kind: 'unsupported' as const }));
        const { AccountServiceSelectionForm } = await import('./AccountServiceSelectionForm');
        const screen = await renderScreen(
            <AccountServiceSelectionForm currentEndpoint={null} onBack={vi.fn()} onSelect={onSelect} />,
        );
        const input = screen.findByTestId('account-service-url-input');
        const submit = screen.findByTestId('account-service-url-submit');
        if (!input || !submit) throw new Error('Expected service URL form');

        await act(async () => {
            input.props.onChangeText('https://home.example.test');
        });
        await screen.pressByTestIdAsync('account-service-url-submit');

        expect(onSelect).toHaveBeenCalledWith(
            'https://home.example.test',
            expect.objectContaining({
                signal: expect.any(Object),
            }),
        );
        expect(screen.findByTestId('account-service-url-input')?.props.value).toBe('https://home.example.test');
        expect(screen.findByTestId('account-service-url-error')?.props.children).toBe('welcome.signInServiceUnsupportedBody');
    });

    it('opens URL entry without discovery when the source build has no default service', async () => {
        const { AccountServiceSelectionForm } = await import('./AccountServiceSelectionForm');
        const screen = await renderScreen(<AccountServiceSelectionForm
            currentEndpoint={{ url: '', source: 'default' }} onBack={vi.fn()} onSelect={vi.fn()}
        />);
        expect(screen.findByTestId('account-service-url-input')).toBeTruthy();
        expect(screen.findByTestId('account-service-current-choice')).toBeNull();
        expect(network.request).not.toHaveBeenCalled();
    });

    it('selects the current service from its own choice without opening the address form', async () => {
        const selection = createDeferred<{ kind: 'selected' }>();
        const onSelect = vi.fn(async () => await selection.promise);
        const currentEndpoint = {
            url: 'https://current.example.test',
            serverIdentityId: 'srv_current_service',
            source: 'user' as const,
        };
        const { AccountServiceSelectionForm } = await import('./AccountServiceSelectionForm');
        const screen = await renderScreen(
            <AccountServiceSelectionForm
                currentEndpoint={currentEndpoint}
                onBack={vi.fn()}
                onSelect={onSelect}
            />,
        );
        await act(async () => {
            screen.findByTestId('account-service-current-choice')?.props.onPress();
        });

        expect(onSelect).toHaveBeenCalledWith('https://current.example.test', expect.objectContaining({ signal: expect.any(Object) }));
        await act(async () => {
            selection.resolve({ kind: 'selected' });
            await selection.promise;
        });
        expect(screen.findByTestId('account-service-url-input')).toBeNull();
        expect(screen.findByTestId('account-service-url-error')).toBeNull();
    });

    it('deduplicates sibling controls and prevents an older selection from overwriting its successor', async () => {
        const priorEndpoint = {
            url: 'https://prior.example.test',
            serverIdentityId: 'srv_prior_service',
            displayName: 'Prior Service',
            source: 'user' as const,
        };
        const olderResponse = createDeferred<Response>();
        const newerResponse = createDeferred<Response>();
        network.request.mockImplementation(async (endpointUrl: string, path: string) => {
            if (path === '/v1/auth/entry') return authEntryResponse();
            if (endpointUrl === 'https://next.example.test') return await olderResponse.promise;
            if (endpointUrl === 'https://newest.example.test') return await newerResponse.promise;
            throw new Error(`Unexpected endpoint ${endpointUrl}`);
        });
        const { setAccountServiceEndpoint, resolveSelectedAccountServiceEndpoint } = await import('@/sync/domains/server/serverProfiles');
        const { selectAccountServiceEndpoint } = await import('@/sync/ops/accountDirectory/selectAccountServiceEndpoint');
        const { AccountServiceSelectionForm } = await import('./AccountServiceSelectionForm');
        await setAccountServiceEndpoint(priorEndpoint);
        const screen = await renderScreen(
            <AccountServiceSelectionForm
                currentEndpoint={priorEndpoint}
                onBack={vi.fn()}
                onSelect={selectAccountServiceEndpoint}
            />,
        );
        const input = screen.findByTestId('account-service-url-input');
        if (!input) {
            await screen.pressByTestIdAsync('account-service-another-choice');
        }
        const visibleInput = screen.findByTestId('account-service-url-input');
        const submit = screen.findByTestId('account-service-url-submit');
        if (!visibleInput || !submit) throw new Error('Expected all service selection controls');

        await act(async () => {
            visibleInput.props.onChangeText('https://next.example.test');
        });
        act(() => {
            submit.props.onPress();
            visibleInput.props.onSubmitEditing();
        });

        await vi.waitFor(() => expect(network.request).toHaveBeenCalledTimes(1));
        await act(async () => {
            visibleInput.props.onChangeText('https://newest.example.test');
        });
        const updatedInput = screen.findByTestId('account-service-url-input');
        expect(updatedInput?.props.value).toBe('https://newest.example.test');
        act(() => {
            updatedInput?.props.onSubmitEditing();
        });
        await vi.waitFor(() => expect(network.request).toHaveBeenCalledTimes(2));
        newerResponse.resolve(new Response(JSON.stringify(supportedAccountService('srv_newest_service')), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        }));
        await act(async () => {
            await newerResponse.promise;
        });
        await vi.waitFor(() => expect(resolveSelectedAccountServiceEndpoint()).toMatchObject({
            url: 'https://newest.example.test',
            serverIdentityId: 'srv_newest_service',
        }));
        olderResponse.resolve(new Response(JSON.stringify(supportedAccountService('srv_next_service')), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        }));
        await act(async () => {
            await olderResponse.promise;
        });
        expect(resolveSelectedAccountServiceEndpoint()).toMatchObject({
            url: 'https://newest.example.test',
            serverIdentityId: 'srv_newest_service',
        });
    });

    it('does not persist an abandoned selection after Back', async () => {
        const priorEndpoint = {
            url: 'https://retained.example.test',
            serverIdentityId: 'srv_retained_service',
            displayName: 'Retained Service',
            source: 'user' as const,
        };
        const response = createDeferred<Response>();
        network.request.mockImplementation(async (_endpointUrl: string, path: string) => (
            path === '/v1/auth/entry' ? authEntryResponse() : await response.promise
        ));
        const { setAccountServiceEndpoint, resolveSelectedAccountServiceEndpoint } = await import('@/sync/domains/server/serverProfiles');
        const { selectAccountServiceEndpoint } = await import('@/sync/ops/accountDirectory/selectAccountServiceEndpoint');
        const { AccountServiceSelectionForm } = await import('./AccountServiceSelectionForm');
        await setAccountServiceEndpoint(priorEndpoint);
        const onBack = vi.fn();
        // Await the abandoned operation itself, so a selection that Back failed to cancel has time to persist.
        let abandoned: Promise<unknown> | undefined;
        const screen = await renderScreen(
            <AccountServiceSelectionForm
                currentEndpoint={priorEndpoint}
                onBack={onBack}
                onSelect={(url, options) => (abandoned = selectAccountServiceEndpoint(url, options))}
            />,
        );
        await screen.pressByTestIdAsync('account-service-another-choice');
        const input = screen.findByTestId('account-service-url-input');
        const submit = screen.findByTestId('account-service-url-submit');
        if (!input || !submit) throw new Error('Expected service URL form');
        await act(async () => {
            input.props.onChangeText('https://abandoned.example.test');
        });
        act(() => {
            submit.props.onPress();
        });
        await vi.waitFor(() => expect(network.request).toHaveBeenCalledTimes(1));

        await screen.pressByTestIdAsync('account-service-selection-back');
        response.resolve(new Response(JSON.stringify(supportedAccountService('srv_abandoned_service')), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        }));
        await act(async () => {
            await abandoned;
        });

        expect(onBack).toHaveBeenCalledTimes(1);
        expect(resolveSelectedAccountServiceEndpoint()).toEqual(priorEndpoint);
    });

    it('persists a verified selection through the real onboarding surface and controller', async () => {
        network.request.mockImplementation(async (_endpointUrl: string, path: string) => (
            path === '/v1/auth/entry'
                ? authEntryResponse()
                : new Response(JSON.stringify(supportedAccountService('srv_composed_service')), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                })
        ));
        const { OnboardingWizardSurface } = await import('@/components/onboarding/surfaces/OnboardingWizardSurface');
        const { selectAccountServiceEndpoint } = await import('@/sync/ops/accountDirectory/selectAccountServiceEndpoint');
        const { resolveSelectedAccountServiceEndpoint } = await import('@/sync/domains/server/serverProfiles');
        const screen = await renderScreen(
            <OnboardingWizardSurface
                layout="portrait"
                isDesktopShell={false}
                wizardChromeMode="bare"
                initialStepId="auth_service_select"
                authEntryOptions={authEntryOptions}
                onSelectAccountService={selectAccountServiceEndpoint}
            />,
        );
        const input = screen.findByTestId('account-service-url-input');
        if (!input) throw new Error('Expected composed service URL form');
        await act(async () => {
            input.props.onChangeText('https://composed.example.test');
        });
        await screen.pressByTestIdAsync('account-service-url-submit');

        expect(resolveSelectedAccountServiceEndpoint()).toMatchObject({
            url: 'https://composed.example.test',
            serverIdentityId: 'srv_composed_service',
        });
    });
});
