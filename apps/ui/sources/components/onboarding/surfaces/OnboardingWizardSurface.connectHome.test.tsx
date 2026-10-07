import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { installLocalStorageMock, installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import type { AuthEntryOptions } from '@/components/account/auth/useAuthEntryOptions';
import { createRootLayoutFeaturesResponse, createSignInServiceFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

installDisconnectedServerSocketBoundary();

installTokenStorageWebPlatformMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            useWindowDimensions: () => ({ width: 1100, height: 720, scale: 1, fontScale: 1 }),
        });
    },
});

const runtimeFetchMock = vi.hoisted(() => vi.fn(async (input: RequestInfo | URL) => {
    if (String(input) === 'https://unreachable-home.example.test/health') {
        return new Response(null, { status: 404 });
    }
    return new Response(null, { status: 404 });
}));
const modalAlert = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/utils/system/runtimeFetch', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/utils/system/runtimeFetch')>();
    return { ...actual, runtimeFetch: runtimeFetchMock };
});

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: { confirm: async () => true, alert: modalAlert },
    }).module;
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

const authEntryOptions = {
    authenticationCatalog: { provenance: 'structured', methods: [] },
    authenticationActions: [],
    keyChallengeV2Available: false,
    authEntryUnavailable: false,
    serverAvailability: 'ready',
    serverUrlForCopy: '',
    showAuthActions: false,
    retryServerCheck: vi.fn(),
} satisfies AuthEntryOptions;

// Collect the real UI graph before the behavior deadline; no internal owner is mocked.
await import('./OnboardingWizardSurface');

async function enterManualHomeAddress(screen: Awaited<ReturnType<typeof renderScreen>>) {
    const customAddress = screen.findByTestId('onboarding-wizard-relay:customUrl');
    expect(customAddress).toBeTruthy();
    await act(async () => { customAddress!.props.onPress(); });
    const next = screen.findByTestId('onboarding-wizard-primary');
    expect(next).toBeTruthy();
    await act(async () => { await next!.props.onPress(); });
    expect(screen.findByTestId('onboarding-wizard-relay-url-input')).toBeTruthy();
}

function withoutSyntheticTimestamps(items: readonly import('@/sync/domains/server/serverProfiles').ServerProfile[]) {
    return items.map(({ createdAt, updatedAt, ...profile }) => profile);
}

describe('first-run custom Home address connection', () => {
    const originalScope = process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
    let restoreLocalStorage: (() => void) | null = null;
    let restoreWebLocks: (() => void) | null = null;

    beforeEach(async () => {
        await loadSyncSingletonForTests();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = `onboarding_connect_${Date.now()}_${Math.random()}`;
        restoreLocalStorage = installLocalStorageMock().restore;
        restoreWebLocks = installWebLockManagerMock().restore;
        runtimeFetchMock.mockReset().mockImplementation(async () => new Response(null, { status: 404 }));
        modalAlert.mockClear();
        (await import('@/sync/domains/server/serverProfiles')).resetServerProfilesRuntimeForTests();
    });

    afterEach(async () => {
        standardCleanup();
        await (await import('@/sync/runtime/orchestration/connectionManager')).disconnectActiveServerConnection();
        restoreWebLocks?.();
        restoreLocalStorage?.();
        if (originalScope === undefined) delete process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
        else process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = originalScope;
    });

    it('keeps an unreachable typed address and does not adopt or focus it', async () => {
        const { listServerProfiles, getActiveServerSnapshot } = await import('@/sync/domains/server/serverProfiles');
        const beforeProfiles = listServerProfiles();
        const beforeFocus = getActiveServerSnapshot();
        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(React.createElement(OnboardingWizardSurface, {
            layout: 'portrait',
            isDesktopShell: true,
            initialStepId: 'relay_select',
            authEntryOptions,
        }));
        await enterManualHomeAddress(screen);
        const input = screen.findByTestId('onboarding-wizard-relay-url-input');
        expect(input).toBeTruthy();
        await act(async () => {
            input?.props.onChangeText?.('https://unreachable-home.example.test');
        });
        await act(async () => {
            await screen.findByTestId('onboarding-wizard-primary')?.props.onPress?.();
        });
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(runtimeFetchMock.mock.calls.some(([url]) => String(url) === 'https://unreachable-home.example.test/health')).toBe(true);
        expect(screen.findByTestId('onboarding-wizard-relay-url-input')?.props.value).toBe('https://unreachable-home.example.test');
        expect(withoutSyntheticTimestamps(listServerProfiles())).toEqual(withoutSyntheticTimestamps(beforeProfiles));
        expect(getActiveServerSnapshot()).toMatchObject({ serverId: beforeFocus.serverId, serverUrl: beforeFocus.serverUrl });
    });

    it('adopts a reachable entered Home and focuses its returned profile before continuing', async () => {
        runtimeFetchMock.mockImplementation(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.endsWith('/health')) {
                return new Response(JSON.stringify({ status: 'ok' }), { status: 200, headers: { 'content-type': 'application/json' } });
            }
            if (url.endsWith('/v1/features')) {
                return new Response(JSON.stringify(createRootLayoutFeaturesResponse({
                    capabilities: {
                        server: { canonicalServerUrl: 'https://connected-home.example.test' },
                        serverIdentity: { serverIdentityId: 'srv_onboarding_connected' },
                    },
                })), { status: 200, headers: { 'content-type': 'application/json' } });
            }
            return new Response(null, { status: 404 });
        });
        const { listServerProfiles, getActiveServerSnapshot, resolveServerProfileScopeId } = await import('@/sync/domains/server/serverProfiles');
        const beforeProfiles = listServerProfiles();
        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(React.createElement(OnboardingWizardSurface, {
            layout: 'portrait',
            isDesktopShell: true,
            initialStepId: 'relay_select',
            authEntryOptions,
        }));
        await enterManualHomeAddress(screen);
        await act(async () => {
            screen.findByTestId('onboarding-wizard-relay-url-input')?.props.onChangeText?.('https://connected-home.example.test');
        });
        await act(async () => {
            await screen.findByTestId('onboarding-wizard-primary')?.props.onPress?.();
        });
        await flushHookEffects({ cycles: 2, turns: 2 });

        const added = listServerProfiles().filter((profile) => !beforeProfiles.some((existing) => existing.id === profile.id));
        expect(added).toHaveLength(1);
        expect(added[0]).toMatchObject({ serverUrl: 'https://connected-home.example.test', serverIdentityId: 'srv_onboarding_connected' });
        expect(getActiveServerSnapshot().serverId).toBe(resolveServerProfileScopeId(added[0]!));
    });

    it.each(['typed', 'supplied'] as const)('connects a %s Directory-capable Home without selecting it as the sign-in service', async (entry) => {
        const endpointUrl = 'https://accounts.example.test';
        const features = createSignInServiceFeaturesResponse(endpointUrl);
        runtimeFetchMock.mockImplementation(async (input: RequestInfo | URL) => {
            const url = String(input);
            return new Response(JSON.stringify(url.endsWith('/health') ? { status: 'ok' } : features), {
                status: url.endsWith('/health') || url.endsWith('/v1/features') ? 200 : 404,
                headers: { 'content-type': 'application/json' },
            });
        });
        const profiles = await import('@/sync/domains/server/serverProfiles');
        const beforeProfiles = profiles.listServerProfiles();
        const beforeService = profiles.resolveSelectedAccountServiceEndpoint();
        const { selectAccountServiceEndpoint } = await import('@/sync/ops/accountDirectory/selectAccountServiceEndpoint');
        const { useAccountServiceEntryOptions } = await import('@/components/account/auth/useAccountServiceEntryOptions');
        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        function Entry() {
            const accountServiceEntry = useAccountServiceEntryOptions();
            return <OnboardingWizardSurface
                layout="portrait" isDesktopShell initialStepId="relay_select"
                initialServerUrl={entry === 'supplied' ? endpointUrl : undefined}
                authEntryOptions={authEntryOptions} accountServiceEntry={accountServiceEntry}
                onSelectAccountService={selectAccountServiceEndpoint}
                accountContinuationIntent={{ kind: 'enter', target: { kind: 'automatic' } }}
                onAccountDirectoryKeyResult={vi.fn()}
            />;
        }
        const screen = await renderScreen(<Entry />);
        await enterManualHomeAddress(screen);
        if (entry === 'typed') await act(async () => {
            screen.findByTestId('onboarding-wizard-relay-url-input')?.props.onChangeText?.(endpointUrl);
        });
        await act(async () => {
            await screen.findByTestId('onboarding-wizard-primary')?.props.onPress?.();
        });
        await flushHookEffects({ cycles: 3, turns: 3 });

        expect(profiles.resolveSelectedAccountServiceEndpoint()).toEqual(beforeService);
        expect(profiles.listServerProfiles()).toHaveLength(beforeProfiles.length + 1);
        expect(profiles.getActiveServerSnapshot().serverUrl).toBe(endpointUrl);
        expect(modalAlert).not.toHaveBeenCalled();
    });
});
