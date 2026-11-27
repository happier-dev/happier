import axios from 'axios';
import { afterEach, onTestFinished, vi } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import type { HttpService } from '@happier-dev/plugin-sdk/http';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { deriveSettingsSecretsReadKeysForCredentials } from '@/settings/secrets/settingsSecretsKey';
import { createAccountPluginSecretCustodyRouter } from '../context/accountPluginSecretCustody';
import { createStableDeclaredPluginSecretsHost } from '../context/secrets';
import { createPluginInvocationSecretRedactor } from '../invocation/services/logger';
import { createPluginInvocationServiceBinding } from '../invocation/services/factory';
import type { PluginInvocationServiceBinding, PluginInvocationServicesSeed } from '../invocation/services/types';
import { createStablePluginHttpHost } from './service';
import { createSecretUseMaterialFixture } from './secretUseMaterial.testkit';

// Genuine authenticated Home HTTP, provider HTTP and credential persistence
// boundaries only; catalog admission, crypto, raw reads and policy stay real.
vi.mock('axios', async original => {
    const actual = await original<typeof import('axios')>();
    return { ...actual, default: { ...actual.default, get: vi.fn() } };
});
const persistence = vi.hoisted(() => ({ read: vi.fn() }));
export { persistence };
vi.mock('@/persistence', async original => ({ ...await original<typeof import('@/persistence')>(), readStoredCredentials: persistence.read }));

export const origin = 'https://secret-provider.example';
export const sentinel = 'custodied-provider-sentinel-42';
export const ref = 'happier:shared-secret:v1:provider-secret';
export type Request = Parameters<HttpService['request']>[0];
export type Response = Awaited<ReturnType<HttpService['request']>>;

afterEach(() => { resetActiveAccountSettingsSnapshotForTests(); vi.resetAllMocks(); vi.unstubAllGlobals(); });

export function fixture(mode: 'plain' | 'e2ee', options: Readonly<{ keyless?: boolean; use?: boolean; revision?: number; modeMismatch?: boolean; value?: string; onCatalogRead?(): void }> = {}) {
    const { credentials, content, resources } = createSecretUseMaterialFixture(mode, { accountId: 'http-secret-owner',
        resourceId: 'provider-secret', value: options.value ?? sentinel, revision: options.revision ?? 3, keyless: options.keyless, use: options.use });
    const token = credentials.token;
    persistence.read.mockResolvedValue(credentials);
    vi.mocked(axios.get).mockImplementation(async url => {
        if (new URL(String(url)).pathname === '/v1/account/saved-secrets/resources/materials') {
            options.onCatalogRead?.();
            return { status: 200,
                // Malformed stored mode enters only through the real HTTP ingress.
                data: options.modeMismatch ? { ...resources, resources: resources.resources.map(row => ({ ...row, storedContent: { t: 'plain', v: content } })) } : resources };
        }
        throw new Error('Unexpected authenticated Home read');
    });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ features: {}, capabilities: {} })));
    setActiveAccountSettingsSnapshot({ source: 'network', scopeKey: resolveAccountSettingsScopeKeyForToken(token), settings: accountSettingsParse({}),
        rawSettings: {}, settingsVersion: 4, loadedAtMs: 1, settingsSecretsReadKeys: deriveSettingsSecretsReadKeysForCredentials(credentials),
        savedSecretResources: [], savedSecretCatalogState: 'ready' });
    const controller = new AbortController();
    onTestFinished(() => controller.abort());
    const authority = { current: true };
    const seed: PluginInvocationServicesSeed = { plugin: { id: 'example.secret-use', version: '1.0.0' },
        contribution: { id: 'sync', qualifiedId: 'example.secret-use/actions/sync' }, occurrenceId: 'secret-use-occurrence', correlationId: 'secret-use-invocation',
        surface: 'agent', signal: controller.signal, isOccurrenceCurrent: () => authority.current };
    const binding = createPluginInvocationServiceBinding('secret-use-occurrence', 'secret-use-grant');
    const redactor = createPluginInvocationSecretRedactor();
    const scope = { pluginId: seed.plugin.id, occurrenceId: seed.occurrenceId, correlationId: seed.correlationId };
    redactor.beginInvocation(scope, controller.signal);
    const secrets = createStableDeclaredPluginSecretsHost({ declarations: [], resolveCustody: createAccountPluginSecretCustodyRouter().resolve }).bind({
        pluginId: seed.plugin.id, signal: controller.signal, isOccurrenceCurrent: seed.isOccurrenceCurrent,
        registerRawForRedaction: value => redactor.registerRaw(scope, value),
    });
    const makeService = (effect: (input: Request) => Promise<Response>, overrides: Partial<Parameters<typeof createStablePluginHttpHost>[0]> = {},
        bindingOverrides: Partial<PluginInvocationServiceBinding> = {}) => {
        const effectSpy = vi.fn(effect);
        const host = createStablePluginHttpHost({ adapter: { request: effectSpy, openWebSocket: async () => { throw new Error('Unexpected WebSocket'); } },
            containsRegisteredSecret: ({ value }) => redactor.containsRegisteredValue(scope, value), ...overrides });
        return { service: host.bind(seed, { ...binding, ...bindingOverrides }), effect: effectSpy };
    };
    return { secrets, makeService, controller, authority, credentials, seed, binding, resources };
}

export const safeResponse = (): Response => ({ status: 200, finalUrl: `${origin}/variables`, headers: {}, body: new TextEncoder().encode('plain provider output') });
