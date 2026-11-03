import { resolveNativeAppLinkHref } from '@/utils/url/nativeAppLink';
import { parseAuthenticatedAccountEntryRoute } from '@/components/navigation/accountEntry/authenticatedAccountEntryRoute';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installTokenStorageTestIsolation, installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { installLocalStorageMock, installWebLockManagerMock, type LocalStorageMockHandle } from '@/auth/storage/tokenStorage.web.testHelpers';
import {
    ACCOUNT_DIRECTORY_AUTH_CREDENTIALS_STORAGE_KEY,
    PENDING_ACCOUNT_DIRECTORY_AUTH_STORAGE_KEY,
    TokenStorage,
} from '@/auth/storage/tokenStorage';
import { createDeferred } from '@/dev/testkit';
import { buildServerFeaturesResponse } from '@/hooks/server/serverFeaturesTestUtils';
import { adoptHomeProfile, setActiveServerId } from '@/sync/domains/server/serverProfiles';
import { createDirectoryHttpFixture } from '@/sync/ops/accountDirectory/accountDirectoryTestFixtures';
import { checkAccountServiceEndpoint } from '@/sync/ops/accountDirectory/selectAccountServiceEndpoint';

// The network and browser storage are the boundaries. Feature probing and decoding, the auth-entry
// client, the key challenge, the OAuth provider and TokenStorage custody all run their real owners.
installTokenStorageWebPlatformMocks();
installTokenStorageTestIsolation('account_directory_auth_client');
type Route = (endpoint: string, path: string, init?: RequestInit) => Response | Promise<Response>;
const network = vi.hoisted(() => ({
    calls: [] as Array<{ endpoint: string; path: string; init?: RequestInit }>,
    routes: new Map<string, Route>(),
    fallback: null as Route | null,
}));
function routeRequest(endpoint: string, path: string, init?: RequestInit): Promise<Response> {
    network.calls.push({ endpoint, path, init });
    const route = network.routes.get(path.split('?')[0]!) ?? network.fallback;
    if (!route) throw new Error(`Unexpected request ${endpoint}${path}`);
    return Promise.resolve(route(endpoint, path, init));
}
vi.mock('@/utils/system/runtimeFetch', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/utils/system/runtimeFetch')>(),
    runtimeFetch: (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        return routeRequest(url.origin, `${url.pathname}${url.search}`, init);
    },
}));

import { accountDirectoryAuthClient, createVerifiedAccountServiceAuthority } from './accountDirectoryAuthClient';

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
    status, headers: { 'Content-Type': 'application/json' },
});

/** The `/v1/features` payload an Account Service answers with. */
function accountServiceFeatures(serverIdentityId = 'srv_directory_1') {
    const features = buildServerFeaturesResponse();
    return {
        ...features,
        capabilities: {
            ...features.capabilities,
            accountDirectory: {
                version: 1 as const,
                homeDirectory: true,
                homeEnrollment: true,
                homeLoginAssertion: {
                    keyId: 'a'.repeat(64),
                    publicKeyBase64Url: 'A'.repeat(43),
                },
            },
            server: { canonicalServerUrl: 'https://canonical-directory.example.test' },
            serverIdentity: { serverIdentityId },
            auth: {
                ...features.capabilities.auth,
                methods: [
                    { id: 'key_challenge', actions: [
                        { id: 'provision' as const, enabled: true, mode: 'keyed' as const },
                        { id: 'login' as const, enabled: true, mode: 'keyed' as const },
                    ] },
                    { id: 'github', actions: [{ id: 'provision' as const, enabled: true, mode: 'keyed' as const }] },
                    { id: 'email_password', actions: [{ id: 'login' as const, enabled: true, mode: 'keyless' as const }] },
                ],
                keyChallenge: { v2: true },
                signup: { methods: [] },
                login: { methods: [], requiredProviders: [] },
                recovery: { providerReset: { providers: [] } },
                ui: { autoRedirect: { enabled: false, providerId: null } },
                providers: {},
                misconfig: [],
            },
            oauth: { providers: { github: { configured: true, enabled: true } } },
        },
    };
}
type AccountServiceFeatures = ReturnType<typeof accountServiceFeatures>;
function withCapabilities(
    features: AccountServiceFeatures,
    capabilities: Partial<Record<keyof AccountServiceFeatures['capabilities'], unknown>>,
) {
    return { ...features, capabilities: { ...features.capabilities, ...capabilities } };
}
function serveFeatures(features: unknown) {
    network.routes.set('/v1/features', () => json(features));
}
function serveAuthEntry(projection: unknown) {
    network.routes.set('/v1/auth/entry', () => json(projection));
}
function oauthParamsRoute(service: Readonly<{ endpointUrl: string; serverIdentityId: string; canonicalServerUrl: string }>, onUrl?: (path: string) => void): Route {
    return (_endpoint, path) => {
        onUrl?.(path);
        return json({
            url: 'https://oauth.example.test/authorize',
            purpose: 'account_directory',
            credentialTarget: 'account_directory',
            endpointUrl: service.endpointUrl,
            endpointServerIdentityId: service.serverIdentityId,
            canonicalServerUrl: service.canonicalServerUrl,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
        });
    };
}

describe('accountDirectoryAuthClient', () => {
    let storage: LocalStorageMockHandle;
    let restoreLocks: () => void;
    let directory: ReturnType<typeof createDirectoryHttpFixture>;
    const storedDirectoryKeys = () => [...storage.store.keys()].filter((key) => (
        key.includes(ACCOUNT_DIRECTORY_AUTH_CREDENTIALS_STORAGE_KEY) || key.includes(PENDING_ACCOUNT_DIRECTORY_AUTH_STORAGE_KEY)
    ));

    beforeEach(() => {
        storage = installLocalStorageMock();
        restoreLocks = installWebLockManagerMock().restore;
        directory = createDirectoryHttpFixture();
        network.calls.length = 0;
        network.routes.clear();
        network.fallback = directory.request;
        serveFeatures(accountServiceFeatures());
        // Older Account Services have no auth-entry projection; discovery then reads the features catalog.
        network.routes.set('/v1/auth/entry', () => json({ error: 'not_found' }, 404));
    });
    afterEach(() => {
        restoreLocks();
        storage.restore();
        vi.unstubAllGlobals();
    });

    it.each([true, false, undefined])('admits a deep-linked Account service according to the organization lock (%s)', async (locked) => {
        vi.stubGlobal('isTauri', true);
        vi.stubGlobal('document', {});
        vi.stubGlobal('window', { __HAPPIER_WEB_RUNTIME_CONFIG__: locked === undefined ? {} : {
            organizationPolicyJson: JSON.stringify({ schemaVersion: 1, organization: 'Example',
                accountService: { url: 'https://managed.example.test', locked } }),
        } });
        const link = new URL('happier://homes/sign-in');
        link.searchParams.set('accountServiceEndpoint', 'https://foreign.example.test');
        link.searchParams.set('accountServiceIdentity', 'srv_directory_1');
        link.searchParams.set('accountIntent', JSON.stringify({ kind: 'refresh' }));
        link.searchParams.set('accountEntryReturnTo', '/settings/account');
        const href = resolveNativeAppLinkHref(link.href);
        expect(href).not.toBeNull();
        const route = new URL(href!, 'https://app.example.test');
        const request = parseAuthenticatedAccountEntryRoute(Object.fromEntries(route.searchParams));
        expect(request).not.toBeNull();
        const discovery = await accountDirectoryAuthClient.discoverAuthenticationMethods({
            endpointUrl: request!.service.endpointUrl,
            expectedServerIdentityId: request!.service.serverIdentityId,
        });
        expect(discovery.kind).toBe(locked === true ? 'organization_policy_locked' : 'supported_account_service');
        const foreignRequests = network.calls.filter(({ endpoint }) => endpoint === 'https://foreign.example.test');
        if (locked === true) expect(foreignRequests).toEqual([]);
        else expect(foreignRequests.length).toBeGreaterThan(0);

        network.calls.length = 0;
        expect((await checkAccountServiceEndpoint('https://foreign.example.test', { signal: new AbortController().signal })).kind)
            .toBe(locked === true ? 'organization_policy_locked' : 'verified');
        if (locked === true) expect(network.calls).toEqual([]);

        // Locking a service must still allow that service's real discovery path.
        expect((await accountDirectoryAuthClient.discoverAuthenticationMethods({ endpointUrl: 'https://managed.example.test' })).kind)
            .toBe('supported_account_service');
    });

    it('constructs authority only from supported identity-checked discovery fields', async () => {
        const features = accountServiceFeatures('srv_directory_authority');
        serveFeatures(features);
        const discovery = await accountDirectoryAuthClient.discoverAuthenticationMethods({
            endpointUrl: 'https://accounts.example.test',
        });
        expect(discovery.kind).toBe('supported_account_service');
        if (discovery.kind !== 'supported_account_service') return;

        expect(createVerifiedAccountServiceAuthority(discovery)).toEqual({
            endpointUrl: 'https://accounts.example.test',
            serverIdentityId: 'srv_directory_authority',
            canonicalServerUrl: 'https://canonical-directory.example.test',
            capability: features.capabilities.accountDirectory,
            snapshot: discovery.snapshot,
        });
    });

    it('refuses key, password and OAuth sign-in to an unapproved service before sending credentials', async () => {
        const discovery = await accountDirectoryAuthClient.discoverAuthenticationMethods({ endpointUrl: 'https://foreign.example.test' });
        expect(discovery.kind).toBe('supported_account_service');
        if (discovery.kind !== 'supported_account_service') throw new Error('Account-service fixture must be available');
        vi.stubGlobal('isTauri', true);
        vi.stubGlobal('document', {});
        vi.stubGlobal('window', { __HAPPIER_WEB_RUNTIME_CONFIG__: {
            organizationPolicyJson: JSON.stringify({ schemaVersion: 1, organization: 'Example',
                accountService: { url: 'https://managed.example.test', locked: true } }),
        } });
        network.calls.length = 0;
        const target = {
            endpointUrl: discovery.endpointUrl,
            endpointServerIdentityId: discovery.serverIdentityId,
            canonicalServerUrl: discovery.canonicalServerUrl,
            verifiedServerFeaturesSnapshot: discovery.snapshot,
        };
        await expect(accountDirectoryAuthClient.loginWithKey({ ...target, secret: new Uint8Array(32).fill(1) }))
            .rejects.toMatchObject({ code: 'organization_policy_locked' });
        await expect(accountDirectoryAuthClient.loginWithPassword({ ...target, email: 'person@example.test', password: 'test-only' }))
            .rejects.toMatchObject({ code: 'organization_policy_locked' });
        await expect(accountDirectoryAuthClient.startOAuth({ ...target, providerId: 'github', mode: 'keyless',
            entryIntent: { kind: 'refresh' }, returnTo: '/homes/sign-in' }))
            .rejects.toMatchObject({ code: 'organization_policy_locked' });
        expect(network.calls).toEqual([]);
    });

    it('discovers explicit endpoint methods with another Home focused without active credential or focus dependence', async () => {
        const focused = await adoptHomeProfile({
            descriptor: { v: 1, homeServerIdentityId: 'srv_home_a', canonicalServerUrl: 'https://home-a.example.test', revision: 1,
                endpoints: [{ kind: 'https', url: 'https://home-a.example.test' }] },
            source: 'manual', descriptorAuthority: 'current_connection_observation',
        });
        await setActiveServerId(focused.id, { scope: 'device' });
        serveFeatures(accountServiceFeatures('srv_directory_b'));

        await expect(accountDirectoryAuthClient.discoverAuthenticationMethods({
            endpointUrl: 'https://accounts-b.example.test/',
            requestedMethod: { kind: 'oauth', providerId: 'github' },
        })).resolves.toMatchObject({
            kind: 'supported_account_service',
            endpointUrl: 'https://accounts-b.example.test',
            serverIdentityId: 'srv_directory_b',
            canonicalServerUrl: 'https://canonical-directory.example.test',
            keyLoginAvailable: true,
            oauthProviderIds: ['github'],
            preferredProvisionProviderId: 'github',
            authenticationActions: [
                {
                    execution: { kind: 'generated_key' },
                    method: { id: 'key_challenge' },
                    action: { id: 'provision', mode: 'keyed' },
                },
                {
                    execution: { kind: 'key_entry' },
                    method: { id: 'key_challenge' },
                    action: { id: 'login', mode: 'keyed' },
                },
                {
                    execution: { kind: 'oauth', providerId: 'github', mode: 'keyed' },
                    method: { id: 'github' },
                    action: { id: 'provision', mode: 'keyed' },
                },
                {
                    // The service's email sign-in is an account-service way in too.
                    execution: { kind: 'email_password', action: 'login', mode: 'keyless' },
                    method: { id: 'email_password' },
                    action: { id: 'login', mode: 'keyless' },
                },
            ],
        });

        // Only the explicit endpoint is asked, never the focused Home, and nothing is stored.
        expect(network.calls.map(({ endpoint, path }) => `${endpoint}${path}`)).toEqual([
            'https://accounts-b.example.test/v1/features',
            'https://accounts-b.example.test/v1/auth/entry',
        ]);
        expect(storedDirectoryKeys()).toEqual([]);
    });

    it('uses the Account Service auth-entry projection for dynamic methods', async () => {
        serveAuthEntry({
            v: 1,
            state: 'ready',
            scope: { kind: 'home' },
            actions: [{
                kind: 'authenticate',
                methodId: 'acme',
                action: 'provision',
                mode: 'keyed',
                origin: 'home',
                presentation: { displayName: 'Acme Workforce' },
            }],
            autoRedirect: null,
        });

        await expect(accountDirectoryAuthClient.discoverAuthenticationMethods({
            endpointUrl: 'https://accounts.example.test',
        })).resolves.toMatchObject({
            kind: 'supported_account_service',
            oauthProviderIds: ['acme'],
            preferredProvisionProviderId: 'acme',
            authenticationActions: [expect.objectContaining({
                method: expect.objectContaining({ presentation: { displayName: 'Acme Workforce' } }),
                execution: { kind: 'oauth', providerId: 'acme', mode: 'keyed' },
            })],
        });
        const entryRequest = network.calls.find(({ path }) => path === '/v1/auth/entry');
        expect(entryRequest?.endpoint).toBe('https://accounts.example.test');
        expect(JSON.parse(String(entryRequest?.init?.body))).toMatchObject({ purpose: 'account_service' });
    });

    it('offers email and password sign-in and creation on an account service, never attaching it to an existing Account', async () => {
        serveAuthEntry({
            v: 1,
            state: 'ready',
            scope: { kind: 'home' },
            actions: [
                { kind: 'authenticate', methodId: 'email_password', action: 'login', mode: 'either', origin: 'home',
                    passwordReset: 'email', presentation: { displayName: 'Email and password' } },
                { kind: 'authenticate', methodId: 'email_password', action: 'provision', mode: 'keyed', origin: 'home',
                    recommendedProvisionMode: 'e2ee', presentation: { displayName: 'Email and password' } },
                { kind: 'authenticate', methodId: 'email_password', action: 'connect', mode: 'either', origin: 'home',
                    presentation: { displayName: 'Email and password' } },
            ],
            autoRedirect: null,
        });

        const discovered = await accountDirectoryAuthClient.discoverAuthenticationMethods({
            endpointUrl: 'https://accounts.example.test',
        });
        expect(discovered).toMatchObject({ kind: 'supported_account_service' });
        if (discovered.kind !== 'supported_account_service') throw new Error('expected a supported service');
        expect(discovered.authenticationActions.map(({ execution }) => execution)).toEqual([
            { kind: 'email_password', action: 'login', mode: 'either', passwordReset: 'email' },
            { kind: 'email_password', action: 'provision', mode: 'keyed', recommendedProvisionMode: 'e2ee' },
        ]);
    });

    it('threads exact transport and cancellation into discovery without storing them in authority', async () => {
        const viaOrigin = await accountDirectoryAuthClient.discoverAuthenticationMethods({
            endpointUrl: 'https://accounts-b.example.test',
            runtimeOrigin: 'http://127.0.0.1:43123',
        });
        expect(viaOrigin.kind).toBe('supported_account_service');
        expect(viaOrigin).not.toHaveProperty('runtimeOrigin');
        expect(network.calls.map(({ endpoint, path }) => `${endpoint}${path}`)).toEqual([
            'http://127.0.0.1:43123/v1/features',
            'http://127.0.0.1:43123/v1/auth/entry',
        ]);

        network.calls.length = 0;
        const carried: string[] = [];
        const homeCarrier = {
            endpointId: 'iroh-directory',
            readObservedPath: () => 'relay' as const,
            request: async (url: string, init: RequestInit) => {
                const parsed = new URL(url);
                carried.push(`${parsed.origin}${parsed.pathname}`);
                return await network.routes.get(parsed.pathname)!(parsed.origin, parsed.pathname, init);
            },
            createWebSocket: () => ({}),
        };
        const viaCarrier = await accountDirectoryAuthClient.discoverAuthenticationMethods({
            endpointUrl: 'https://accounts-b.example.test',
            homeCarrier,
        });
        expect(viaCarrier.kind).toBe('supported_account_service');
        expect(viaCarrier).not.toHaveProperty('homeCarrier');
        expect(carried).toEqual([
            'https://accounts-b.example.test/v1/features',
            'https://accounts-b.example.test/v1/auth/entry',
        ]);
        expect(network.calls).toEqual([]);

        const pendingFeatures = createDeferred<Response>();
        network.routes.set('/v1/features', () => pendingFeatures.promise);
        const controller = new AbortController();
        const cancelled = accountDirectoryAuthClient.discoverAuthenticationMethods({
            endpointUrl: 'https://accounts-c.example.test',
            signal: controller.signal,
        });
        controller.abort();
        await expect(cancelled).resolves.toMatchObject({ kind: 'endpoint_unavailable' });
        pendingFeatures.resolve(json(accountServiceFeatures()));
    });

    it.each([
        '',
        'not a URL',
        'ftp://accounts.example.test',
        'https://user:pass@accounts.example.test',
        'https://accounts.example.test?tenant=other',
    ])('fails a malformed explicit endpoint closed before probing: %j', async (endpointUrl) => {
        await expect(accountDirectoryAuthClient.discoverAuthenticationMethods({
            endpointUrl,
        })).resolves.toMatchObject({
            kind: 'endpoint_unavailable',
            endpointUrl: '',
            reason: 'invalid_endpoint',
        });
        expect(network.calls).toEqual([]);
    });

    it.each([
        ['endpoint_unavailable', 'network failure', () => { throw new TypeError('network down'); }],
        ['endpoint_unavailable', 'missing features endpoint', () => json({ error: 'not_found' }, 404)],
    ] as const)('returns %s for an unreachable or unsupported endpoint (%s)', async (kind, _label, route) => {
        network.routes.set('/v1/features', route);

        await expect(accountDirectoryAuthClient.discoverAuthenticationMethods({
            endpointUrl: 'https://accounts.example.test',
        })).resolves.toMatchObject({ kind, endpointUrl: 'https://accounts.example.test' });
    });

    it('returns identity_mismatch before exposing methods when a pinned endpoint observes a different identity', async () => {
        serveFeatures(accountServiceFeatures('srv_directory_other'));

        await expect(accountDirectoryAuthClient.discoverAuthenticationMethods({
            endpointUrl: 'https://accounts.example.test',
            expectedServerIdentityId: 'srv_directory_1',
        })).resolves.toMatchObject({
            kind: 'identity_mismatch',
            endpointUrl: 'https://accounts.example.test',
            expectedServerIdentityId: 'srv_directory_1',
            observedServerIdentityId: 'srv_directory_other',
        });
        expect(network.calls.map(({ path }) => path)).toEqual(['/v1/features']);
        expect(storedDirectoryKeys()).toEqual([]);
    });

    it('returns not_account_service when endpoint capabilities lack Account Directory support', async () => {
        serveFeatures(withCapabilities(accountServiceFeatures(), { accountDirectory: undefined }));

        await expect(accountDirectoryAuthClient.discoverAuthenticationMethods({
            endpointUrl: 'https://home-only.example.test',
        })).resolves.toMatchObject({
            kind: 'not_account_service',
            endpointUrl: 'https://home-only.example.test',
            serverIdentityId: 'srv_directory_1',
        });
    });

    it('offers direct Home connection for a verified Home entered as an Account Service', async () => {
        serveFeatures(withCapabilities(accountServiceFeatures('srv_home_only'), { accountDirectory: undefined }));

        await expect(checkAccountServiceEndpoint('https://home-only.example.test', {
            signal: new AbortController().signal,
        })).resolves.toEqual({
            kind: 'home_endpoint',
            homeServerIdentityId: 'srv_home_only',
            homeUrl: 'https://canonical-directory.example.test',
        });
    });

    it('requires an advertised canonical URL for a supported Account Service', async () => {
        serveFeatures(withCapabilities(accountServiceFeatures(), { server: {} }));

        await expect(accountDirectoryAuthClient.discoverAuthenticationMethods({
            endpointUrl: 'https://accounts.example.test',
        })).resolves.toMatchObject({
            kind: 'not_account_service',
            endpointUrl: 'https://accounts.example.test',
        });
    });

    it('projects structured OAuth methods over legacy configured flags and drops methods without a Directory execution', async () => {
        const features = accountServiceFeatures();
        serveFeatures(withCapabilities(features, {
            auth: {
                ...features.capabilities.auth,
                methods: [
                    { id: 'github', actions: [{ id: 'provision', enabled: true, mode: 'keyed' }] },
                    { id: 'gitlab', actions: [{ id: 'provision', enabled: true, mode: 'keyed' }] },
                    { id: 'google', actions: [{ id: 'login', enabled: true, mode: 'keyless' }] },
                    { id: 'oidc', actions: [{ id: 'provision', enabled: true, mode: 'either' }] },
                    { id: 'mtls', actions: [{ id: 'login', enabled: true, mode: 'keyless' }] },
                ],
            },
            oauth: {
                providers: {
                    github: { configured: true, enabled: true },
                    gitlab: { configured: false, enabled: true },
                    google: { configured: true, enabled: true },
                    oidc: { configured: true, enabled: false },
                },
            },
        }));

        const discovered = await accountDirectoryAuthClient.discoverAuthenticationMethods({
            endpointUrl: 'https://accounts.example.test',
        });
        expect(discovered).toMatchObject({
            kind: 'supported_account_service',
            oauthProviderIds: ['github', 'gitlab', 'google', 'oidc'],
            preferredProvisionProviderId: 'github',
        });
        if (discovered.kind !== 'supported_account_service') return;
        expect(discovered.authenticationActions.map(({ method }) => method.id)).not.toContain('mtls');
    });

    it('uses the provenance-bounded legacy adapter when structured methods are absent', async () => {
        serveFeatures(withCapabilities(accountServiceFeatures(), {
            auth: {
                keyChallenge: { v2: false },
                signup: { methods: [{ id: 'github', enabled: true }] },
                login: { methods: [], requiredProviders: [] },
                recovery: { providerReset: { providers: [] } },
                ui: { autoRedirect: { enabled: false, providerId: null } },
                providers: {},
                misconfig: [],
            },
            oauth: { providers: { github: { configured: true, enabled: true } } },
        }));

        await expect(accountDirectoryAuthClient.discoverAuthenticationMethods({
            endpointUrl: 'https://accounts.example.test',
            requestedMethod: { kind: 'oauth', providerId: 'github' },
        })).resolves.toMatchObject({
            kind: 'supported_account_service',
            endpointUrl: 'https://accounts.example.test',
            keyLoginAvailable: false,
            oauthProviderIds: ['github'],
            preferredProvisionProviderId: 'github',
        });
        expect(storedDirectoryKeys()).toEqual([]);
    });

    it('does not resurrect legacy methods from an explicitly empty structured catalog', async () => {
        const features = accountServiceFeatures();
        serveFeatures(withCapabilities(features, {
            auth: {
                ...features.capabilities.auth,
                methods: [],
                keyChallenge: { v2: false },
                signup: { methods: [{ id: 'github', enabled: true }] },
            },
            oauth: { providers: { github: { configured: true, enabled: true } } },
        }));

        await expect(accountDirectoryAuthClient.discoverAuthenticationMethods({
            endpointUrl: 'https://accounts.example.test',
            requestedMethod: { kind: 'oauth', providerId: 'github' },
        })).resolves.toMatchObject({
            kind: 'requested_method_unavailable',
            authenticationCatalog: { provenance: 'structured', methods: [] },
            authenticationActions: [],
            oauthProviderIds: [],
        });
    });

    function serveDirectoryKeyChallenge() {
        const { service } = directory;
        network.routes.set('/v1/auth/account-directory/challenge', () => json({
            challengeId: 'directory-challenge', nonce: 'nonce', issuedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            audience: { origin: service.canonicalServerUrl, serverIdentityId: service.serverIdentityId },
        }));
        network.routes.set('/v1/auth/account-directory', () => json({ token: 'restricted-directory-token' }));
    }

    it('logs in by key through the restricted endpoint routes and stores only Directory credentials', async () => {
        const { service } = directory;
        serveDirectoryKeyChallenge();

        await expect(accountDirectoryAuthClient.loginWithKey({
            endpointUrl: `${service.endpointUrl}/`,
            endpointServerIdentityId: service.serverIdentityId,
            canonicalServerUrl: `${service.canonicalServerUrl}/`,
            secret: new Uint8Array(32).fill(11),
            verifiedServerFeaturesSnapshot: service.snapshot,
        })).resolves.toEqual({ token: 'restricted-directory-token' });

        // The verified discovery snapshot is reused: only the restricted Directory key routes are called.
        expect(network.calls.map(({ endpoint, path }) => `${endpoint}${path}`)).toEqual([
            `${service.endpointUrl}/v1/auth/account-directory/challenge`,
            `${service.endpointUrl}/v1/auth/account-directory`,
        ]);
        const target = { endpoint: service.endpointUrl, serverIdentityId: service.serverIdentityId };
        await expect(TokenStorage.accountDirectoryAuthCredentials.get(target))
            .resolves.toEqual({ token: 'restricted-directory-token' });
        await expect(TokenStorage.getPendingAccountDirectoryAuth(target)).resolves.toBeNull();
    });

    it('fails key login when restricted credential persistence fails', async () => {
        const { service } = directory;
        serveDirectoryKeyChallenge();
        storage.setItemMock.mockImplementation((key, value) => {
            if (key.includes(ACCOUNT_DIRECTORY_AUTH_CREDENTIALS_STORAGE_KEY)) throw new Error('credential storage unavailable');
            storage.store.set(key, value);
        });

        await expect(accountDirectoryAuthClient.loginWithKey({
            endpointUrl: service.endpointUrl,
            endpointServerIdentityId: service.serverIdentityId,
            canonicalServerUrl: service.canonicalServerUrl,
            secret: new Uint8Array(32).fill(12),
            verifiedServerFeaturesSnapshot: service.snapshot,
        })).rejects.toThrow('persist Account Service credentials');
    });

    it('starts OAuth against the explicit known-identity endpoint and persists only Directory pending state', async () => {
        const { service } = directory;
        const paramsPaths: string[] = [];
        network.routes.set('/v1/auth/external/github/params', oauthParamsRoute(service, (path) => paramsPaths.push(path)));

        const result = await accountDirectoryAuthClient.startOAuth({
            endpointUrl: service.endpointUrl,
            endpointServerIdentityId: service.serverIdentityId,
            canonicalServerUrl: service.canonicalServerUrl,
            providerId: 'github',
            mode: 'keyless',
            entryIntent: { kind: 'refresh' },
            returnTo: '/settings/account',
        });
        expect(network.calls.map(({ endpoint }) => endpoint)).toEqual([service.endpointUrl]);
        expect(paramsPaths).toHaveLength(1);
        const params = new URL(`https://params.test${paramsPaths[0]}`).searchParams;
        expect(params.get('mode')).toBe('keyless');
        expect(params.get('proofHash')).toBeTruthy();
        expect(params.get('purpose')).toBe('account_directory');
        expect(params.get('canonicalServerUrl')).toBe(service.canonicalServerUrl);
        expect(result).toMatchObject({
            url: 'https://oauth.example.test/authorize',
            pending: {
                endpoint: service.endpointUrl,
                serverIdentityId: service.serverIdentityId,
                provider: 'github',
                purpose: 'account_directory',
                credentialTarget: 'account_directory',
                entryIntent: { kind: 'refresh' },
                canonicalServerUrl: service.canonicalServerUrl,
                proof: expect.any(String),
                returnTo: '/settings/account',
            },
        });

        const persisted = await TokenStorage.getPendingAccountDirectoryAuth({
            endpoint: service.endpointUrl, serverIdentityId: service.serverIdentityId,
        });
        expect(persisted).toEqual(result.pending);
        expect(persisted).not.toHaveProperty('secret');
        expect(persisted).not.toHaveProperty('pending');
        await expect(TokenStorage.accountDirectoryAuthCredentials.get({
            endpoint: service.endpointUrl, serverIdentityId: service.serverIdentityId,
        })).resolves.toBeNull();
    });

    it('starts keyed Account Directory creation with a bound local signing key', async () => {
        const { service } = directory;
        const paramsPaths: string[] = [];
        network.routes.set('/v1/auth/external/github/params', oauthParamsRoute(service, (path) => paramsPaths.push(path)));

        await expect(accountDirectoryAuthClient.startOAuth({
            endpointUrl: service.endpointUrl,
            endpointServerIdentityId: service.serverIdentityId,
            canonicalServerUrl: service.canonicalServerUrl,
            providerId: 'github',
            mode: 'keyed',
            entryIntent: { kind: 'enter', target: { kind: 'automatic' } },
            returnTo: '/setup/wizard',
        })).resolves.toMatchObject({
            url: 'https://oauth.example.test/authorize',
            pending: {
                mode: 'keyed',
                canonicalServerUrl: service.canonicalServerUrl,
                secret: expect.any(String),
            },
        });
        const params = new URL(`https://params.test${paramsPaths[0]}`).searchParams;
        expect(params.get('mode')).toBe('keyed');
        expect(params.get('publicKey')).toBeTruthy();
        expect(params.get('canonicalServerUrl')).toBe(service.canonicalServerUrl);
        expect(params.has('proofHash')).toBe(false);

        const persisted = await TokenStorage.getPendingAccountDirectoryAuth({
            endpoint: service.endpointUrl, serverIdentityId: service.serverIdentityId,
        });
        expect(persisted).toMatchObject({ mode: 'keyed', canonicalServerUrl: service.canonicalServerUrl, secret: expect.any(String) });
        expect(persisted).not.toHaveProperty('proof');
    });

    it('persists the captured authenticated Home identity intent without credential or descriptor material', async () => {
        const { service } = directory;
        network.routes.set('/v1/auth/external/github/params', oauthParamsRoute(service));

        await expect(accountDirectoryAuthClient.startOAuth({
            endpointUrl: service.endpointUrl,
            endpointServerIdentityId: service.serverIdentityId,
            canonicalServerUrl: service.canonicalServerUrl,
            providerId: 'github',
            mode: 'keyed',
            entryIntent: { kind: 'link', homeServerIdentityId: 'srv_home_a' },
            returnTo: '/setup/wizard',
        })).resolves.toMatchObject({
            url: 'https://oauth.example.test/authorize',
            pending: {
                linkHomeServerIdentityId: 'srv_home_a',
            },
        });

        const persisted = await TokenStorage.getPendingAccountDirectoryAuth({
            endpoint: service.endpointUrl, serverIdentityId: service.serverIdentityId,
        });
        expect(persisted).toMatchObject({
            endpoint: service.endpointUrl,
            serverIdentityId: service.serverIdentityId,
            canonicalServerUrl: service.canonicalServerUrl,
            linkHomeServerIdentityId: 'srv_home_a',
        });
        expect(Object.keys(persisted ?? {})).not.toContain('credentials');
        expect(Object.keys(persisted ?? {})).not.toContain('connectionDescriptor');
    });

    it('refuses to start Account Directory OAuth without a known endpoint identity', async () => {
        const { service } = directory;

        await expect(accountDirectoryAuthClient.startOAuth({
            endpointUrl: service.endpointUrl,
            endpointServerIdentityId: ' ',
            returnTo: '/setup/wizard',
            canonicalServerUrl: service.canonicalServerUrl,
            providerId: 'github',
            mode: 'keyless',
            entryIntent: { kind: 'enter', target: { kind: 'automatic' } },
        })).rejects.toThrow('requires a known endpoint identity');
        expect(network.calls).toEqual([]);
        expect(storedDirectoryKeys()).toEqual([]);
    });
});
