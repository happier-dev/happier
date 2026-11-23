import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PluginConnectedAccountAuthenticationModeV2Schema, PluginConnectedAccountAuthenticationV2Schema,
    type PluginConnectedAccountAuthenticationModeV2 } from '@happier-dev/protocol/connect/plugin-connected-account-authentication-v2';
import type { ConnectedServiceCredentialKind } from '@happier-dev/protocol/connect/connectedServiceCredentialKind';
import type { ConnectedAccountAttemptProviderOperation } from './authenticationAttemptOwner.js';
import type { ConnectedAccountAuthenticationModeRuntime } from './authenticationTypes.js';
import { invokeConnectedAccountAuthenticationRuntime } from './authenticationRuntimeDispatcher.js';

const bundled = JSON.parse(readFileSync(new URL(
    '../../../../apps/cli/assets/bundled-plugin-manifests/machine-vercel.json', import.meta.url), 'utf8'));
const { modes } = PluginConnectedAccountAuthenticationV2Schema.parse(
    bundled.contributes.connectedAccountDescriptors.find((descriptor: { id: string }) => descriptor.id === 'vercel-account').authentication,
);

/** Stub the plugin callback while keeping the real bundled declaration and host boundary. */
function complete(descriptor: PluginConnectedAccountAuthenticationModeV2, credentialKind?: ConnectedServiceCredentialKind) {
    const connected = async () => ({ status: 'connected' as const, displayName: 'Fixture sign-in', scopes: [],
        ...(credentialKind ? { credentialKind } : {}) });
    let mode: ConnectedAccountAuthenticationModeRuntime<object>;
    let operation: ConnectedAccountAttemptProviderOperation;
    switch (descriptor.kind) {
        case 'manual':
            mode = { kind: 'manual', complete: connected };
            operation = { kind: 'submitManual', fields: { token: 'fixture-token' } };
            break;
        case 'oauthAuthorizationCode':
            mode = { kind: 'oauthAuthorizationCode', complete: connected,
                begin: async () => { throw new Error('Unexpected begin'); }, cancel: async () => {} };
            operation = { kind: 'completeOAuth', completion: { code: 'fixture-code',
                callbackUrl: 'https://example.test/callback', state: 'fixture-state', pkceVerifier: 'v'.repeat(43) } };
            break;
        case 'oauthDeviceCode':
            mode = { kind: 'oauthDeviceCode', poll: connected,
                begin: async () => { throw new Error('Unexpected begin'); }, cancel: async () => {} };
            operation = { kind: 'pollDevice' };
            break;
    }
    return invokeConnectedAccountAuthenticationRuntime({ descriptor, mode, operation, context: {},
        registerRawForRedaction() {}, invokeCallback: async work => work() });
}

describe('authentication result admission', () => {
    it.each(modes)('requires the bundled Vercel $id mode to publish its declared kind', async descriptor => {
        const expected = descriptor.credentialKind;
        if (expected === undefined) throw new Error('The bundled authentication mode must declare its kind');
        const incompatible = expected === 'oauth' ? 'token' : 'oauth';
        const refusal = { status: 'unavailable',
            diagnostic: { code: 'connected_account_authentication_credential_kind_invalid' } };
        await expect(complete(descriptor, expected)).resolves.toMatchObject({ status: 'connected', credentialKind: expected });
        await expect(complete(descriptor)).resolves.toMatchObject(refusal);
        await expect(complete(descriptor, incompatible)).resolves.toMatchObject(refusal);
    });

    it('accepts a kindless result when the mode declares no kind', async () => {
        const descriptor = PluginConnectedAccountAuthenticationModeV2Schema.parse({
            id: 'manual', kind: 'manual', outcomeReconciliation: 'none',
            fields: [{ id: 'token', title: 'Token', schema: { type: 'string' }, secret: true }],
        });
        await expect(complete(descriptor)).resolves.toMatchObject({ status: 'connected' });
    });
});
