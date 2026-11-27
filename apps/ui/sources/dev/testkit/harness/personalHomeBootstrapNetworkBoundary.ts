import { vi } from 'vitest';
import { createKeyChallengeV2SigningInput, KeyChallengeV2AuthRequestSchema } from '@happier-dev/protocol/auth/keyChallenge';

import type { ServerCredentialLookupOptions } from '@/auth/storage/tokenStorage';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { createRootLayoutFeaturesResponse } from '../fixtures/featureFixtures';
import { installBrowserRuntimeForTests } from './browserRuntimeHarness';

type FeatureProbe = Readonly<{
    status: 'ready';
    serverIdentityId: string | null;
    features: Readonly<{
        capabilities: Readonly<{
            auth: Readonly<{ signup: Readonly<{ methods: readonly Readonly<{ id: string; enabled: boolean }>[] }> }>;
            encryption: Readonly<{ storagePolicy: string }>;
        }>;
        homeConnectionDescriptor?: unknown;
    }>;
}> | Readonly<{ status: 'error'; reason: string }>;

/** Actual auth, credential custody and feature parsing, with only HTTP and native storage replaced. */
export async function installPersonalHomeBootstrapNetworkBoundary(options: Readonly<{
    serverUrl: string;
    serverIdentityId: string;
    readFeatures: () => Promise<FeatureProbe>;
    authenticate: (params: Readonly<{
        endpointUrl: string;
        canonicalServerUrl: string;
        serverIdentityId: string;
        secret?: Uint8Array;
    }>) => Promise<Readonly<{ token: string }>>;
    authPing: (params: Readonly<{ endpoint: string; token: string }>) => Promise<Readonly<{ status: string }>>;
    request?: (params: Readonly<{ endpointUrl: string; serverId: string; path: string; authorization: string | null }>) => Promise<Response>;
    credentialPersisted?: (url: string, scope: ServerCredentialLookupOptions, credential: Readonly<{ token: string }>) => Promise<unknown>;
    seedWriteFails?: () => boolean;
    seedReadbackFails?: () => boolean;
}>) {
    // Model the desktop webview's local origin so HTTPS mixed-content rules do not reject the loopback Home.
    const browser = await installBrowserRuntimeForTests({ url: 'http://tauri.localhost/' });
    const secureStorage = new Map<string, string>();
    const nativeBridge = {
        invoke: async (command: string, args: Record<string, unknown> = {}) => {
            const key = String(args.key);
            const pendingSeed = key.startsWith('pending_personal_home_bootstrap_seed');
            if (command === 'desktop_secure_storage_read') {
                if (pendingSeed && options.seedReadbackFails?.()) return null;
                return secureStorage.get(key) ?? null;
            }
            if (command === 'desktop_secure_storage_write') {
                if (pendingSeed && options.seedWriteFails?.()) throw new Error('Native secure storage write refused');
                secureStorage.set(key, String(args.value));
                return null;
            }
            if (command === 'desktop_secure_storage_remove') {
                secureStorage.delete(key);
                return null;
            }
            throw new Error(`Unexpected native bootstrap command: ${command}`);
        },
    };
    const browserUserAgent = browser.window.navigator.userAgent;
    const setDesktopHostKind = (kind: 'tauri' | 'electron' | null) => {
        Object.defineProperty(browser.window.navigator, 'userAgent', {
            configurable: true,
            value: kind === 'electron' ? `${browserUserAgent} Electron/1.0` : browserUserAgent,
        });
        vi.stubGlobal('__TAURI_INTERNALS__', kind ? nativeBridge : undefined);
    };
    setDesktopHostKind('tauri');
    const pendingSeeds = () => [...secureStorage.entries()].flatMap(([key, value]) => {
        if (!key.startsWith('pending_personal_home_bootstrap_seed')) return [];
        const record: unknown = JSON.parse(value);
        if (!record || typeof record !== 'object' || !('seedBase64Url' in record) || typeof record.seedBase64Url !== 'string') return [];
        return [{ key, seed: decodeBase64(record.seedBase64Url, 'base64url') }];
    });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const { resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
    resetServerFeaturesClientForTests();
    const originalSetCredentials = TokenStorage.setCredentialsForServerUrl.bind(TokenStorage);
    const persistence = vi.spyOn(TokenStorage, 'setCredentialsForServerUrl').mockImplementation(async (url, scope, credentials) => {
        const persisted = await originalSetCredentials(url, scope, credentials);
        if (persisted) await options.credentialPersisted?.(url, scope, credentials);
        return persisted;
    });
    const { setRuntimeFetch, resetRuntimeFetch } = await import('@/utils/system/runtimeFetch');
    const requests: Array<Readonly<{ url: string; path: string }>> = [];
    setRuntimeFetch(async (input, init) => {
        const url = new URL(String(input));
        requests.push({ url: url.href, path: url.pathname });
        if (url.origin !== new URL(options.serverUrl).origin) return new Response(null, { status: 503 });
        const path = url.pathname;
        if (path === '/health') return Response.json({ status: 'ok' });
        if (path === '/v1/features') {
            const probe = await options.readFeatures();
            if (probe.status !== 'ready') return new Response(null, { status: 503 });
            const base = createRootLayoutFeaturesResponse();
            return Response.json({
                ...base,
                ...probe.features,
                capabilities: {
                    ...base.capabilities,
                    ...probe.features.capabilities,
                    serverIdentity: probe.serverIdentityId ? { serverIdentityId: probe.serverIdentityId } : undefined,
                    auth: {
                        ...base.capabilities.auth,
                        ...probe.features.capabilities.auth,
                        keyChallenge: { v2: true },
                    },
                    encryption: { ...base.capabilities.encryption, ...probe.features.capabilities.encryption },
                },
            });
        }
        const challenge = {
            challengeId: 'bootstrap-fixture-challenge',
            nonce: encodeBase64(new Uint8Array(32).fill(3), 'base64url'),
            issuedAt: new Date(0).toISOString(),
            expiresAt: new Date(60_000).toISOString(),
            audience: { origin: url.origin, serverIdentityId: options.serverIdentityId },
        };
        if (path === '/v1/auth/challenge') return Response.json(challenge);
        if (path === '/v1/auth') {
            const body = KeyChallengeV2AuthRequestSchema.parse(JSON.parse(String(init?.body)));
            const { default: sodium } = await import('@/encryption/libsodium.lib');
            const signingInput = createKeyChallengeV2SigningInput({
                ...challenge,
                ...(body.expectedAccountId ? { expectedAccountId: body.expectedAccountId } : {}),
                ...(body.requireExistingAccount ? { requireExistingAccount: true as const } : {}),
            });
            if (body.challengeId !== challenge.challengeId || !sodium.crypto_sign_verify_detached(
                decodeBase64(body.signature), signingInput, decodeBase64(body.publicKey),
            )) return Response.json({ error: 'invalid-signature' }, { status: 401 });
            const probe = await options.readFeatures();
            const signupOpen = probe.status === 'ready' && probe.features.capabilities.auth.signup.methods.some(method => method.id === 'anonymous' && method.enabled);
            const seed = pendingSeeds()[0]?.seed;
            if (signupOpen) {
                const { deriveAccountSigningPublicKey } = await import('@/auth/flows/challenge');
                if (!seed || body.publicKey !== encodeBase64(deriveAccountSigningPublicKey(seed))) {
                    throw new Error('Account-creating proof did not match native pending seed custody');
                }
            }
            try {
                return Response.json(await options.authenticate({
                    endpointUrl: options.serverUrl,
                    canonicalServerUrl: options.serverUrl,
                    serverIdentityId: options.serverIdentityId,
                    ...(signupOpen ? { secret: seed } : {}),
                }));
            } catch (error) {
                if (error && typeof error === 'object' && 'code' in error && error.code === 'signup-disabled') {
                    return Response.json({ error: 'signup-disabled' }, { status: 403 });
                }
                throw error;
            }
        }
        const authorization = new Headers(init?.headers).get('Authorization');
        if (path === '/v1/auth/ping') {
            const result = await options.authPing({ endpoint: options.serverUrl, token: authorization?.replace(/^Bearer /u, '') ?? '' });
            return Response.json({}, { status: result.status === 'ready' ? 200 : 401 });
        }
        if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
        if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 0 });
        return await options.request?.({ endpointUrl: options.serverUrl, serverId: options.serverIdentityId, path, authorization })
            ?? new Response(null, { status: 404 });
    });
    return {
        requests,
        setDesktopHostKind,
        pendingSeeds,
        seedCredentials: (scope: Readonly<{ serverId?: string }>, credentials: Readonly<{ token: string }>) => originalSetCredentials(options.serverUrl, scope, credentials),
        dispose() {
            persistence.mockRestore();
            resetRuntimeFetch();
            browser.restore();
            vi.unstubAllGlobals();
        },
    };
}
