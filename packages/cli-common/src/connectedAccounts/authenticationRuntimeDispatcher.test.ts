import { describe, expect, it } from 'vitest';
import { PluginConnectedAccountAuthenticationModeV2Schema } from '@happier-dev/protocol/connect/plugin-connected-account-authentication-v2';
import { invokeConnectedAccountAuthenticationRuntime } from './authenticationRuntimeDispatcher.js';

describe('authentication result projection', () => {
    it.each([undefined, 'token'] as const)('preserves an unknown result kind with mode kind %s', async credentialKind => {
        const descriptor = PluginConnectedAccountAuthenticationModeV2Schema.parse({
            id: 'manual', kind: 'manual', outcomeReconciliation: 'none',
            ...(credentialKind ? { credentialKind } : {}),
            fields: [{ id: 'token', title: 'Token', schema: { type: 'string' }, secret: true }],
        });
        const connected = { status: 'connected' as const, displayName: 'Fixture sign-in', scopes: [] };
        await expect(invokeConnectedAccountAuthenticationRuntime({
            descriptor,
            mode: { kind: 'manual', complete: async () => connected },
            operation: { kind: 'submitManual', fields: { token: 'fixture-token' } },
            context: {},
            registerRawForRedaction() {},
            invokeCallback: async work => work(),
        })).resolves.toEqual(connected);
    });
});
