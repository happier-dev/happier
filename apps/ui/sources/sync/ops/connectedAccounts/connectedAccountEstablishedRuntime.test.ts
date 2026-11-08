import { afterEach, expect, it } from 'vitest';
import { PluginConnectedAccountDescriptorContributionV2Schema } from '@happier-dev/protocol/connect/plugin-connected-account-authentication-v2';
import { QualifiedConnectedAccountCredentialSnapshotV4Schema } from '@happier-dev/protocol/connect/qualified-connected-account-projections';
import { createConnectedAccountConfigurationOwner } from '@happier-dev/cli-common/connectedAccounts';
import { createPluginSurfaceAccountNetworkServices } from '@/components/plugins/surfaces/pluginSurfaceAccountNetworkServices';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { createUiConnectedAccountEstablishedMaterializer } from './connectedAccountEstablishedRuntime';

afterEach(resetRuntimeFetch);

it('preserves admitted endpoint attestations in HTTP responses while redacting foreign URL credentials and tokens', async () => {
    const endpoint = 'https://configured.example.test';
    const foreign = 'https://credential.example.test/private';
    const token = 'private-provider-token';
    const account = { service: { pluginId: 'acme.cloud', localId: 'cloud' }, accountId: 'selected' };
    const credentialRevision = 'csr_0123456789ABCDEFGHJKMNPQRS';
    const configurationRevision = 'configuration-1';
    const descriptor = PluginConnectedAccountDescriptorContributionV2Schema.parse({
        id: account.service.localId, title: 'Cloud', authentication: { defaultModeId: 'token', modes: [{
            id: 'token', kind: 'manual', outcomeReconciliation: 'none', fields: [{
                id: 'token', title: 'Token', secret: true, schema: { type: 'string' },
            }], configuration: { scope: 'account', changeBehavior: 'reconnect', fields: [
                { id: 'endpoint', title: 'Endpoint', schema: { type: 'string', minLength: 1 }, semantic: 'connectedAccountOrigin', required: true },
                { id: 'label', title: 'Label', schema: { type: 'string' } },
            ] },
        }] },
    });
    const configurationContent = { values: { endpoint, label: foreign }, secretRefs: {} };
    const credential = QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({ ref: account, authenticationModeId: 'token',
        revisionSemantics: 'revisioned', credentialRevision, configurationRevision, metadata: { scopes: [] },
        content: { t: 'plain', v: { v: 1, values: { marker: endpoint, foreign, token } } },
    });
    const configurationPorts = { read: async () => ({ revision: configurationRevision, ...configurationContent }),
        secrets: { admit: async () => undefined, read: async () => null, has: async () => false } };
    const configurationOwner = createConnectedAccountConfigurationOwner({ ...configurationPorts,
        replace: async () => ({ status: 'unavailable' }), destroyAttempt() {}, isRuntimeCurrent: () => true });
    const signal = new AbortController().signal;
    const lifetime = { scope: { serverId: 'fixture-home', accountId: 'fixture-owner' }, isCurrent: () => true,
        onRetire: () => ({ dispose() {} }) };
    type Input = Parameters<typeof createUiConnectedAccountEstablishedMaterializer>[0];
    const runtime: Input['selected']['runtime'] = {
        authentication: { modes: {} },
        async materialize(_request, context) {
            await context.credentials.get('marker');
            await context.credentials.get('foreign');
            return { kind: 'httpHeaders', headers: { authorization: `Bearer ${await context.credentials.get('token')}` } };
        },
    };
    // Physical Account persistence and the external Fetch response are the only
    // substituted boundaries; unused persistence/registration ports are omitted.
    const materializer = createUiConnectedAccountEstablishedMaterializer({
        selected: { runtime, registration: { pluginVersion: '1.0.0', accountLifetime: lifetime,
            lifecycle: { signal, isCurrent: () => true } } },
        declaration: { service: account.service, descriptor, occurrenceId: 'redaction-fixture', sourceCustody: { kind: 'host' } },
        account: { assertCurrent() {} }, configuration: configurationPorts, configurationOwner,
        persistence: { readCredential: async () => credential, readConfiguration: async () => ({
            target: { kind: 'account', ref: account }, authenticationModeId: 'token', revisionSemantics: 'revisioned',
            credentialRevision, configurationRevision, configurationContent: { t: 'plain', v: configurationContent },
        }), content: { resolveAccountMode: async () => 'plain',
            open: (_kind: unknown, _mode: unknown, envelope: { v: unknown }) => envelope.v } },
    } as unknown as Input);
    const network = createPluginSurfaceAccountNetworkServices({ pluginId: account.service.pluginId,
        accountLifetime: lifetime, signal, isCurrent: () => true });
    setRuntimeFetch(async () => Response.json({ endpoint, foreign, token }));
    try {
        expect(await materializer.materialize({ account, signal,
            request: { kind: 'httpHeaders', origin: endpoint, headerNames: ['authorization'] },
            registerRawForRedaction: network.registerRawForRedaction,
        })).toEqual({ kind: 'httpHeaders', headers: { authorization: `Bearer ${token}` } });
        const response = await network.http.request({ url: `${endpoint}/echo`, redirect: 'error' });
        expect(JSON.parse(new TextDecoder().decode(response.body))).toEqual({ endpoint, foreign: '[REDACTED]', token: '[REDACTED]' });
        setRuntimeFetch(async () => { throw new TypeError(`${endpoint} ${foreign} ${token}`); });
        let failure: unknown;
        try { await network.http.request({ url: `${endpoint}/failure`, redirect: 'error' }); }
        catch (error) { failure = error; }
        expect(failure).toMatchObject({ code: 'plugin_fetch_adapter_unavailable', data: {
            failureCause: { phase: 'plugin.http.execute', errorClass: 'TypeError', errorCode: null, httpStatus: null },
        } });
        expect(JSON.stringify(failure)).not.toContain(token);
        expect(JSON.stringify(failure)).not.toContain(foreign);
    } finally { network.dispose(); }
});
