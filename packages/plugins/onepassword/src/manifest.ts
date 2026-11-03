import { definePlugin, type PluginInvocationContext, type PluginSecretSourceFailureV1, type PluginSecretSourceRuntimeV1 } from '@happier-dev/plugin-sdk';
import { listOnePasswordFields, readOnePasswordField, storeOnePasswordField } from './read.js';

const SERVICE_ACCOUNT_TOKEN = 'service-account-token';

async function withNative<Result>(context: PluginInvocationContext,
    run: (serviceAccountToken?: string) => Promise<Result>): Promise<Result | PluginSecretSourceFailureV1> {
    let serviceAccountToken: string | undefined;
    try {
        const status = await context.services.secrets.status(SERVICE_ACCOUNT_TOKEN);
        if (status.state === 'configured') {
            serviceAccountToken = await context.services.secrets.get(SERVICE_ACCOUNT_TOKEN, {
                sourceKind: 'inline', signal: context.signal,
            });
        } else if (status.state !== 'missing') {
            return { ok: false, code: 'source_unavailable', repair: 'configure' };
        }
    } catch {
        return context.signal.aborted ? { ok: false, code: 'cancelled' }
            : { ok: false, code: 'source_unavailable', repair: 'configure' };
    }
    return run(serviceAccountToken);
}

export const onePasswordSecretSource: PluginSecretSourceRuntimeV1 = {
    acquire(input, context) {
        return withNative(context, serviceAccountToken => readOnePasswordField(input, { exec: context.services.exec, serviceAccountToken }, context.signal));
    },
    list(input, context) {
        return withNative(context, serviceAccountToken => listOnePasswordFields(input, { exec: context.services.exec, serviceAccountToken }, context.signal));
    },
    store(input, context) {
        return withNative(context, serviceAccountToken => storeOnePasswordField(input, { exec: context.services.exec, serviceAccountToken }, context.signal));
    },
};

export const ONEPASSWORD_PLUGIN = definePlugin({
    id: 'happier.secret-source.onepassword', version: '0.0.0', displayName: '1Password',
    description: 'Link, read and store Saved Secret fields using 1Password CLI on this Machine.',
    entrypoints: { daemon: './.happier-plugin/daemon.js' },
    hostAccess: { required: [{
        id: 'onepassword-read', capability: 'process', reason: 'List, read and store selected 1Password fields.',
        scope: { envKeys: ['OP_SERVICE_ACCOUNT_TOKEN'], executables: [{ kind: 'systemTool', id: 'op' }] },
    }], optional: [] },
    systemTools: { op: { title: '1Password CLI', executableNames: ['op'] } },
    settings: { credentials: {
        version: 1, title: '1Password', target: { kind: 'plugin' }, scope: 'account',
        fields: [{ id: SERVICE_ACCOUNT_TOKEN, title: 'Service account token',
            description: 'Link an inline Saved Secret for unattended 1Password access on this Machine.',
            schema: { type: 'string' }, secret: true }],
    } },
    secretSources: { onepassword: { declaration: { title: '1Password' }, runtime: onePasswordSecretSource } },
});
export const PLUGIN_MANIFEST = ONEPASSWORD_PLUGIN.manifest;
export const manifest = PLUGIN_MANIFEST;
