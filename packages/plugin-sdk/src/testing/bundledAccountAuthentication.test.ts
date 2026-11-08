import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { derivePluginAccountContributionRegistrationRights } from '@happier-dev/protocol/plugins/contributions/catalog';
import { parseOauthAuthorizationResponse } from '@happier-dev/protocol/connect/oauthAuthorizationResponse';
import { PluginConnectedAccountDescriptorContributionV2Schema } from '@happier-dev/protocol/connect/plugin-connected-account-authentication-v2';
import { invokeConnectedAccountAuthenticationRuntime, type ConnectedAccountAttemptProviderOperation } from '@happier-dev/cli-common/connectedAccounts';
import { CLAUDE_PLUGIN } from '../../../plugins/claude/src/manifest.js';
import { ANTIGRAVITY_PLUGIN } from '../../../plugins/antigravity/src/manifest.js';
import type { ConnectedAccountPortableAuthenticationContext, ConnectedAccountPortableRuntime } from '../connectedAccounts.js';
import type { PluginAccountApi } from '../activation.js';
import { createPluginRegistrationScope } from '../registration/scope.js';
import { compileUniversalPluginUiCommonJs } from '../ui/build/universalCommonJsCompiler.js';
import { evaluatePortableCommonJs } from '../test-support/evaluatePortableCommonJs.js';
import { packageNameOfSpecifier, readWorkspacePackages, resolveWorkspaceSource } from '../../../cli-common/sourceRuntimeEntries.mjs';
import { createPluginHttpFixture } from './http.js';

const providers = [
    { name: 'claude', plugin: CLAUDE_PLUGIN, serviceId: 'claude-subscription', modeId: 'oauth', unavailableOutcome: 'unavailable' },
    { name: 'antigravity', plugin: ANTIGRAVITY_PLUGIN, serviceId: 'antigravity-account', modeId: 'oauth-personal', unavailableOutcome: 'outcomeUnknown' },
] as const;

describe.each(providers)('$name public Account authentication artifact', ({ name, plugin, serviceId, modeId, unavailableOutcome }) => {
    const descriptor = PluginConnectedAccountDescriptorContributionV2Schema.parse(
        plugin.manifest.contributes.connectedAccountDescriptors!.find(value => value.id === serviceId),
    );
    const mode = descriptor.authentication.modes.find(value => value.id === modeId)!;
    if (mode.kind !== 'oauthAuthorizationCode' || !mode.callbackUrl) throw new Error('Expected a registered OAuth callback');
    const callbackUrl = mode.callbackUrl;
    let runtime: ConnectedAccountPortableRuntime;

    beforeAll(async () => {
        const target = descriptor.authentication.account;
        expect(target, 'The app must discover the provider through its public Account auth declaration').toBeDefined();
        if (!target) throw new Error('Missing Account authentication declaration');
        const root = resolve(import.meta.dirname, '../../../..');
        const packages = await readWorkspacePackages(root);
        const compiled = await compileUniversalPluginUiCommonJs({
            projectRoot: resolve(root, 'packages/plugins', name),
            entryPath: resolve(root, 'packages/plugins', name, 'src/connectedAccounts/account.ts'),
            artifactId: target.artifactId, requestedExports: [target.exportName], exportConditions: ['happier-source'],
            resolveSourceImport: specifier => packages.has(packageNameOfSpecifier(specifier))
                ? resolveWorkspaceSource(packages, specifier, { conditions: ['react-native', 'browser'] }) : undefined,
        });
        const module = { exports: {} as Record<string, unknown> };
        evaluatePortableCommonJs(new TextDecoder().decode(compiled.bytes), module);
        const activate = module.exports[target.exportName];
        if (typeof activate !== 'function') throw new Error('Missing portable activation export');
        const scope = createPluginRegistrationScope({ pluginId: plugin.manifest.id,
            target: { realm: 'account', ...target },
            rights: derivePluginAccountContributionRegistrationRights(plugin.manifest.contributes, target) });
        (activate as (api: PluginAccountApi) => void)(scope.api);
        const registration = scope.commit().find(value => value.family === 'connectedAccountDescriptors' && value.localId === serviceId);
        if (registration?.family !== 'connectedAccountDescriptors') throw new Error('Missing public auth registration');
        runtime = registration.value;
    });

    function fixture(status = 200, abortExchange = false, missingIdentity = false, selectedModeId: string = modeId) {
        const selectedMode = descriptor.authentication.modes.find(value => value.id === selectedModeId)!;
        const controller = new AbortController();
        const values = new Map<string, string>();
        const requests: Array<{ url: string; body: unknown }> = [];
        const context = {
            plugin: { id: plugin.manifest.id, version: plugin.manifest.version },
            contribution: { id: serviceId, qualifiedId: `${plugin.manifest.id}/${serviceId}` },
            surface: 'ui', invokedAtMs: 1, signal: controller.signal,
            service: { pluginId: plugin.manifest.id, localId: serviceId },
            attempt: { kind: 'connect', attemptId: 'portable-attempt' },
            configuration: { target: { kind: 'service', service: { pluginId: plugin.manifest.id, localId: serviceId }, modeId: selectedModeId },
                revision: '1', values: {}, async getSecret() { return null; } },
            attemptCredentials: {
                async get(key: string) { return values.get(key) ?? null; },
                async set(key: string, value: string) { values.set(key, value); },
                async delete(key: string) { values.delete(key); },
            },
            services: { http: createPluginHttpFixture({ async request(input) {
                const text = input.body ? new TextDecoder().decode(input.body) : '';
                requests.push({ url: input.url, body: input.headers?.['Content-Type'] === 'application/json'
                    ? JSON.parse(text) : Object.fromEntries(new URLSearchParams(text)) });
                if (abortExchange) { controller.abort(); controller.signal.throwIfAborted(); }
                const body = input.method === 'GET'
                    ? { sub: 'fixture-account', email: 'fixture@example.test' }
                    : { access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_in: 3600,
                        scope: mode.kind === 'oauthAuthorizationCode' ? mode.scopes?.join(' ') : '',
                        account: { uuid: 'fixture-account', email_address: 'fixture@example.test' } };
                return { status: missingIdentity && input.method === 'GET' ? 503 : status,
                    headers: {}, body: new TextEncoder().encode(JSON.stringify(body)) };
            } }) },
        } satisfies ConnectedAccountPortableAuthenticationContext;
        const invoke = (operation: ConnectedAccountAttemptProviderOperation) => invokeConnectedAccountAuthenticationRuntime({
            mode: runtime.authentication.modes[selectedModeId], descriptor: selectedMode, context, operation,
            signal: controller.signal, registerRawForRedaction() {}, invokeCallback: async work => work(),
        });
        return { values, requests, invoke };
    }

    const completion = () => {
        if (mode.kind !== 'oauthAuthorizationCode') throw new Error('Expected OAuth');
        return { kind: 'completeOAuth' as const, completion: {
            code: 'fixture-code', state: 'fixture-state', callbackUrl, pkceVerifier: 'v'.repeat(43),
        } };
    };

    it('uses the registered redirect and declared callback/paste grammar', async () => {
        if (mode.kind !== 'oauthAuthorizationCode') throw new Error('Expected OAuth');
        const f = fixture();
        const begin = await f.invoke({ kind: 'beginOAuth', request: { callbackUrl, state: 'fixture-state',
            pkce: { challenge: 'fixture-challenge', method: 'S256' } } });
        expect(begin).toMatchObject({ status: 'awaitingOAuthRedirect' });
        const authorization = new URL((begin as { authorizationUrl: string }).authorizationUrl);
        expect(authorization.searchParams.get('redirect_uri')).toBe(mode.callbackUrl);
        expect(authorization.searchParams.get('state')).toBe('fixture-state');
        expect(authorization.searchParams.get('code_challenge')).toBe('fixture-challenge');
        expect(parseOauthAuthorizationResponse({ input: `${mode.callbackUrl}?code=fixture-code&state=fixture-state`,
            redirectUri: mode.callbackUrl })).toEqual({ kind: 'callback', code: 'fixture-code', state: 'fixture-state' });
        expect(parseOauthAuthorizationResponse({ input: 'fixture-code#fixture-state', redirectUri: mode.callbackUrl }))
            .toEqual({ kind: 'codeState', code: 'fixture-code', state: 'fixture-state' });
        expect(parseOauthAuthorizationResponse({ input: 'fixture-code', redirectUri: mode.callbackUrl,
            allowRawAuthorizationCode: mode.allowRawAuthorizationCode }).kind)
            .toBe(mode.allowRawAuthorizationCode ? 'rawAuthorizationCode' : 'invalid');
        expect(parseOauthAuthorizationResponse({ input: 'https://foreign.test/callback?code=x&state=y',
            redirectUri: mode.callbackUrl, allowRawAuthorizationCode: mode.allowRawAuthorizationCode })).toEqual({ kind: 'invalid' });
    });

    it('exchanges once through the real shared dispatcher and stages the same token set without Machine services', async () => {
        const f = fixture();
        expect(await f.invoke(completion())).toMatchObject({ status: 'connected' });
        expect(f.values.get('accessToken')).toBe('fixture-access');
        expect(f.values.get('refreshToken')).toBe('fixture-refresh');
        expect(f.requests.filter(request => new URL(request.url).pathname.endsWith('/token'))).toHaveLength(1);
        expect(f.requests[0]?.body).toMatchObject({ code: 'fixture-code', redirect_uri: completion().completion.callbackUrl,
            code_verifier: 'v'.repeat(43) });
        expect(runtime.authentication.modes['native-import']).toBeUndefined();
    });

    it.each([[400, 'rejected'], [503, unavailableOutcome]] as const)('preserves the provider %s outcome without staging credentials', async (status, expected) => {
        const f = fixture(status);
        expect(await f.invoke(completion())).toMatchObject({ status: expected });
        expect(f.values.size).toBe(0);
        expect(f.requests).toHaveLength(1);
    });

    it('cancels locally without redeeming a code and preserves cancellation during HTTP', async () => {
        const idle = fixture();
        await idle.invoke({ kind: 'cancel' });
        expect(idle.requests).toHaveLength(0);
        const running = fixture(200, true);
        await expect(running.invoke(completion())).rejects.toMatchObject({ name: 'AbortError' });
        expect(running.values.size).toBe(0);
        expect(running.requests).toHaveLength(1);
    });

    if (name === 'claude') it('stages its declared setup token through the same public Account registration without HTTP', async () => {
        const f = fixture(200, false, false, 'setup-token');
        expect(await f.invoke({ kind: 'submitManual', fields: { token: '  fixture-setup-token  ' } }))
            .toMatchObject({ status: 'connected', displayName: 'Claude setup token' });
        expect(f.values.get('setupToken')).toBe('fixture-setup-token');
        expect(f.requests).toHaveLength(0);
    });

    if (name === 'antigravity') it('keeps successful tokens when optional provider identity is unavailable with portable HTTP services', async () => {
        const f = fixture(200, false, true);
        expect(await f.invoke(completion())).toMatchObject({ status: 'connected' });
        expect(f.values.get('accessToken')).toBe('fixture-access');
    });
});
