import type { PluginAccountApi } from '@happier-dev/plugin-sdk';
import type { PluginAccountActionHandler } from '@happier-dev/plugin-sdk/actions';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { QualifiedConnectedAccountRefSchema } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import { portableAuthentication } from '../../../../../../packages/plugin-sdk/examples/public-authoring/portableAuthentication';

export const materializationAuthentication = {
    ...portableAuthentication,
    authentication: { modes: { ...portableAuthentication.authentication.modes,
        configured: portableAuthentication.authentication.modes.manual,
    } },
};

/** Authored fixture deliberately echoes private material to exercise host custody. */
export const inspectAccountMaterial: PluginAccountActionHandler = async (input, context) => {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new PluginError({ code: 'invalid_parameters' });
    const account = QualifiedConnectedAccountRefSchema.parse(Reflect.get(input, 'account'));
    if (Reflect.get(input, 'list') === true) {
        const listing = await context.services.connectedAccounts.listAccounts({ purpose: 'provision' }, { signal: context.signal });
        const material = await context.services.connectedAccounts.materializeListedAccount({ purpose: 'provision', account,
            materialization: { kind: 'httpHeaders', origin: 'https://public-materialization.test', headerNames: ['authorization'] },
        }, { signal: context.signal });
        if (material.kind !== 'httpHeaders') throw new PluginError({ code: 'credential_unavailable' });
        return { listing, headers: material.headers };
    }
    const material = await context.services.connectedAccounts.materialize('provision', {
        kind: 'httpHeaders', origin: 'https://public-materialization.test', headerNames: ['authorization'],
    }, { expectedAccount: account, signal: context.signal });
    if (material.kind !== 'httpHeaders') throw new PluginError({ code: 'credential_unavailable' });
    const saved = await context.services.secrets.readSavedSecret('happier:shared-secret:v1:echo-secret');
    const response = await context.services.http.request({ url: 'https://public-materialization.test/vendor/echo', redirect: 'error',
        credentialBinding: { kind: 'connectedAccountPurpose', purpose: 'provision',
            origin: 'https://public-materialization.test', method: 'GET', headerNames: ['authorization'] } });
    const result = { headers: material.headers, saved, echo: new TextDecoder().decode(response.body) };
    if (Reflect.get(input, 'fail') === true) throw new PluginError({ code: 'account_fixture_failed',
        message: `${material.headers.Authorization} ${saved}`, details: result });
    return result;
};

export function activate(api: PluginAccountApi): void {
    api.connectedAccounts.register('example', materializationAuthentication);
    api.actions.register('inspect', inspectAccountMaterial);
}
