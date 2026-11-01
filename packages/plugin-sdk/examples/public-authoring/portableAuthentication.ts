import type { PluginAccountApi } from '@happier-dev/plugin-sdk';
import type { ConnectedAccountPortableRuntime } from '@happier-dev/plugin-sdk/connected-accounts';
import { PluginError } from '@happier-dev/plugin-sdk/errors';

/** The ordinary Account artifact ABI; tokens go into host-owned staging. */
export const portableAuthentication: ConnectedAccountPortableRuntime = {
    authentication: {
        modes: {
            manual: {
                kind: 'manual',
                async complete(input, context) {
                    await context.attemptCredentials.set('token', input.fields.token!, { signal: context.signal });
                    return { status: 'connected', accountId: 'example-account', displayName: 'Example account', scopes: [] };
                },
            },
        },
    },
    async materialize(request, context) {
        if (request.kind !== 'httpHeaders') {
            throw new PluginError({ code: 'unsupported', message: 'This account supplies HTTP credentials only.' });
        }
        const token = await context.credentials.get('token', { signal: context.signal });
        if (!token) throw new PluginError({ code: 'credential_unavailable' });
        return { kind: 'httpHeaders', headers: { Authorization: `Bearer ${token}` } };
    },
};

export function activate(api: PluginAccountApi): void {
    api.connectedAccounts.register('example', portableAuthentication);
}
