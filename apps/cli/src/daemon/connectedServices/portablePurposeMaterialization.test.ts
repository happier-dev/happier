import { describe, expect, it } from 'vitest';
import { PluginConnectedAccountDescriptorContributionV2Schema } from '@happier-dev/protocol/connect/plugin-connected-account-authentication-v2';
import { QualifiedConnectedAccountCredentialSnapshotV4Schema, QualifiedConnectedAccountProfileV4Schema } from '@happier-dev/protocol/connect/qualified-connected-account-projections';
import { openQualifiedConnectedAccountContentEnvelope, sealQualifiedConnectedAccountContentEnvelope } from '@happier-dev/protocol/connect/qualifiedConnectedAccountContentEnvelope';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import {
    createConnectedAccountEstablishedRuntimeOwner,
    createConnectedAccountPurposeMaterializer,
    createConnectedAccountPurposePort,
    type ConnectedAccountMaterialization,
} from '@happier-dev/cli-common/connectedAccounts';
import { createConnectedAccountHostRuntimeInvoker } from '@/plugins/runtime/connectedAccounts/runtimeInvoker';
import type { HostConnectedAccountRuntime } from '@/plugins/runtime/connectedAccounts/hostRuntime';
import { createPluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';
import { createEstablishedAccountReadScope } from './establishedAccountRead';
import { createProductionPluginInvocationServiceOwners } from '@/plugins/runtime/invocation/services/production';
import type { ConnectedAccountRuntimeLease, ConnectedAccountPortableRuntimeLease } from '@/plugins/runtime/connectedAccounts/contributionRegistry';

const service = { pluginId: 'acme.cloud', localId: 'cloud-account' };
const account = { service, accountId: 'selected' };
const purpose = { consumer: { pluginId: 'acme.compute', localId: 'create' }, purpose: 'cloud-api' };
const revision = 'csr_0123456789ABCDEFGHJKMNPQRS';
const descriptor = PluginConnectedAccountDescriptorContributionV2Schema.parse({ id: service.localId, title: 'Cloud',
    authentication: { defaultModeId: 'token', modes: [{ id: 'token', kind: 'manual', outcomeReconciliation: 'none', fields: [
        { id: 'token', title: 'Token', secret: true, schema: { type: 'string', minLength: 1 } },
    ] }] },
});
const profile = QualifiedConnectedAccountProfileV4Schema.parse({ ref: account, authenticationModeId: 'token',
    status: 'connected', revisionSemantics: 'revisioned', credentialRevision: revision,
    configurationReady: true, configurationRevision: null, kind: 'token', expiresAt: null, displayName: 'Cloud', scopes: [] });
const material = { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) };
const randomBytes = (length: number) => new Uint8Array(length).fill(3);

describe('portable Account-purpose materialization through the established runtime', () => {
    it.each(['host', 'plugin', 'portable'] as const)('keeps admitted endpoint attestations public while protecting foreign URL credentials (%s)', async realm => {
        const endpoint = 'https://configured.example.test';
        const foreign = 'https://credential.example.test/private';
        const token = 'private-provider-token';
        const configurationRevision = 'configuration-1';
        const configuredDescriptor = PluginConnectedAccountDescriptorContributionV2Schema.parse({
            ...descriptor, authentication: { defaultModeId: 'token', modes: [{ ...descriptor.authentication.modes[0], credentialFieldKeys: { token: 'token' },
                configuration: { scope: 'account', changeBehavior: 'reconnect', fields: [
                    { id: 'endpoint', title: 'Endpoint', schema: { type: 'string', minLength: 1 }, semantic: 'connectedAccountOrigin', required: true },
                    { id: 'label', title: 'Label', schema: { type: 'string' } },
                ] },
            }] },
        });
        const configurationContent = { values: { endpoint, label: foreign }, secretRefs: {} };
        let snapshot = QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({ ref: account, authenticationModeId: 'token',
            revisionSemantics: 'revisioned', credentialRevision: revision, configurationRevision, metadata: { scopes: [] },
            content: sealQualifiedConnectedAccountContentEnvelope({ kind: 'credential', accountMode: 'plain', randomBytes,
                payload: { v: 1, values: { marker: endpoint, foreign, token } } }),
        });
        const runtime: HostConnectedAccountRuntime = {
            authentication: { modes: {} }, revoke: async () => ({ status: 'remoteUnsupported' }),
            async refresh(context) {
                await context.stagedCredentials.set('marker', endpoint);
                await context.stagedCredentials.set('foreign', foreign);
                await context.stagedCredentials.set('token', token);
                return { status: 'rejected', diagnostic: { code: 'provider-refused', message: `${endpoint} ${foreign} ${token}` } };
            },
            async status(context) {
                const values = await Promise.all(['marker', 'foreign', 'token', 'held'].map(key => context.credentials.get(key)));
                return { status: 'rejected', diagnostic: { code: 'provider-refused', message: values.filter(value => value !== null).join(' ') } };
            },
            async materialize(_request, context) {
                await context.credentials.get('marker');
                await context.credentials.get('foreign');
                await context.credentials.get('held');
                return { kind: 'httpHeaders', headers: { authorization: `Bearer ${await context.credentials.get('token')}` } };
            },
        };
        const identity = { ref: service, descriptor: configuredDescriptor, runtime,
            occurrenceId: createPluginRuntimeOccurrenceId('redaction-account-host'), isCurrent: () => true };
        const pluginCustody = { kind: 'managed' as const, immutableGenerationId: 'redaction-fixture', installSource: 'archive' as const };
        const lease: ConnectedAccountRuntimeLease | ConnectedAccountPortableRuntimeLease = realm === 'host'
            ? { ...identity, owner: 'host', sourceCustody: { kind: 'host' } }
            : realm === 'portable'
                ? { ...identity, realm: 'account', sourceCustody: pluginCustody, authentication: { acquire: create => create() } }
                : { ...identity, sourceCustody: pluginCustody };
        const owners = createProductionPluginInvocationServiceOwners({ loggerSink: { write() {} } });
        const invoker = createConnectedAccountHostRuntimeInvoker({ resolveRuntime: async () => lease,
            resolvePlugin: () => ({ version: '1.0.0', hostAccessRequests: [] }),
            resolveHostPolicy: () => ({ hostAccess: [], serviceBinding: owners.createOrdinaryServiceBinding(identity.occurrenceId, 'redaction-fixture') }),
            createServices: owners.createServices, registerRawForRedaction: owners.registerRawForRedaction,
            redactDiagnosticText: (seed, value) => owners.redactDiagnosticText({ pluginId: seed.plugin.id, occurrenceId: seed.occurrenceId, correlationId: seed.correlationId }, value),
        });
        const registry = { resolveConnectedAccountRuntime: async () => lease, connectedAccountRuntimeInvoker: invoker };
        const owner = createConnectedAccountEstablishedRuntimeOwner({
            reloadController: { acquireRuntimeRegistry: async () => ({ registry, async release() {} }), isRuntimeRegistryCurrent: candidate => candidate === registry },
            readScope: createEstablishedAccountReadScope({}), getAccountEncryptionMode: async () => 'plain', readCredential: async () => snapshot,
            readConfiguration: async () => ({ target: { kind: 'account', ref: account }, authenticationModeId: 'token',
                revisionSemantics: 'revisioned', credentialRevision: revision, configurationRevision,
                configurationContent: sealQualifiedConnectedAccountContentEnvelope({ kind: 'configuration', accountMode: 'plain', randomBytes, payload: configurationContent }) }),
            configuration: { read: async () => ({ revision: configurationRevision, ...configurationContent }),
                secrets: { admit: async () => undefined, read: async () => endpoint, has: async () => true } },
            openContent: input => openQualifiedConnectedAccountContentEnvelope({ ...input, accountMode: 'plain' }),
            sealCredentialContent: (_mode, payload) => sealQualifiedConnectedAccountContentEnvelope({ kind: 'credential', accountMode: 'plain', payload, randomBytes }),
        });
        const receipt = await owner.invokeWithReceipt({ account, operation: { kind: 'materialize',
            request: { kind: 'httpHeaders', origin: endpoint, headerNames: ['authorization'] } } });
        expect(receipt.result).toEqual({ kind: 'httpHeaders', headers: { authorization: `Bearer ${token}` } });
        expect(receipt.basis.materializationPublicValues).toEqual([endpoint]);
        expect(await owner.invokeWithReceipt({ account, operation: { kind: 'status' } })).toMatchObject({
            result: { status: 'rejected', diagnostic: { code: 'provider-refused', message: `${endpoint} [REDACTED] [REDACTED]` } },
        });
        const staged = new Map<string, string>();
        expect(await owner.invokeWithReceipt({ account, operation: { kind: 'refresh', operationId: 'refresh-1', stagedCredentials: {
            get: async key => staged.get(key) ?? null, set: async (key, value) => { staged.set(key, value); },
            delete: async key => { staged.delete(key); },
        } } })).toMatchObject({ result: { status: 'rejected', diagnostic: {
            code: 'provider-refused', message: `${endpoint} [REDACTED] [REDACTED]`,
        } } });
        snapshot = QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({ ...snapshot,
            content: sealQualifiedConnectedAccountContentEnvelope({ kind: 'credential', accountMode: 'plain', randomBytes,
                payload: { v: 1, values: { marker: endpoint, foreign, token }, secretRefs: { held: formatSharedSavedSecretRefV1('held-endpoint') } } }),
        });
        const heldReceipt = await owner.invokeWithReceipt({ account, operation: { kind: 'materialize',
            request: { kind: 'httpHeaders', origin: endpoint, headerNames: ['authorization'] } } });
        expect(heldReceipt.basis.materializationPublicValues).toEqual([]);
        expect(await owner.invokeWithReceipt({ account, operation: { kind: 'status' } })).toMatchObject({
            result: { status: 'rejected', diagnostic: { code: 'provider-refused', message: '[REDACTED] [REDACTED] [REDACTED] [REDACTED]' } },
        });
        snapshot = QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({ ...snapshot,
            content: sealQualifiedConnectedAccountContentEnvelope({ kind: 'credential', accountMode: 'plain', randomBytes,
                payload: { v: 1, values: { marker: endpoint, foreign, token: endpoint } } }),
        });
        const secretCollisionReceipt = await owner.invokeWithReceipt({ account, operation: { kind: 'materialize',
            request: { kind: 'httpHeaders', origin: endpoint, headerNames: ['authorization'] } } });
        expect(secretCollisionReceipt.basis.materializationPublicValues).toEqual([]);
        expect(await owner.invokeWithReceipt({ account, operation: { kind: 'status' } })).toMatchObject({
            result: { status: 'rejected', diagnostic: { code: 'provider-refused', message: '[REDACTED] [REDACTED] [REDACTED]' } },
        });
    });

    it.each(['plain', 'e2ee'] as const)('formats the selected %s held key through runtime.materialize and observes rotation', async mode => {
        const reference = formatSharedSavedSecretRefV1('selected-key');
        const values = new Map([[reference, 'first-key']]);
        const reads: string[] = [];
        const payload = { v: 1 as const, values: {}, secretRefs: { token: reference } };
        const content = mode === 'plain'
            ? sealQualifiedConnectedAccountContentEnvelope({ kind: 'credential', accountMode: 'plain', payload, randomBytes })
            : sealQualifiedConnectedAccountContentEnvelope({ kind: 'credential', accountMode: 'e2ee', material, payload, randomBytes });
        const snapshot = QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({ ref: account, authenticationModeId: 'token',
            revisionSemantics: 'revisioned', credentialRevision: revision, configurationRevision: null, metadata: { scopes: [] }, content });
        // A contributed external provider implements formatting. The host must execute this implementation,
        // rather than reinterpret its persisted token fields as a materialization result.
        const runtime: HostConnectedAccountRuntime = {
            authentication: { modes: {} },
            async status() { return { status: 'connected' }; },
            async refresh() { return { status: 'connected' }; },
            async revoke() { return { status: 'remoteUnsupported' }; },
            async materialize(request, context): Promise<ConnectedAccountMaterialization> {
                expect(context.account).toEqual(account);
                expect(request).toEqual({ kind: 'httpHeaders', origin: 'https://cloud.example.test', headerNames: ['authorization'] });
                return { kind: 'httpHeaders', headers: { authorization: `Bearer ${await context.credentials.get('token')}` } };
            },
        };
        const lease = { owner: 'host' as const, ref: service, descriptor, runtime,
            occurrenceId: createPluginRuntimeOccurrenceId('portable-account-host'), sourceCustody: { kind: 'host' as const }, isCurrent: () => true };
        const invoker = createConnectedAccountHostRuntimeInvoker({ resolveRuntime: async () => lease,
            resolvePlugin: () => null, resolveHostPolicy: () => { throw new Error('Host runtime has no plugin policy'); },
            createServices: () => { throw new Error('Host runtime has no plugin services'); }, registerRawForRedaction() {},
        });
        const registry = { resolveConnectedAccountRuntime: async () => lease, connectedAccountRuntimeInvoker: invoker };
        const owner = createConnectedAccountEstablishedRuntimeOwner({
            reloadController: { acquireRuntimeRegistry: async () => ({ registry, async release() {} }), isRuntimeRegistryCurrent: candidate => candidate === registry },
            // Account operation scope is a host port. Exercise the incumbent scope implementation here.
            readScope: createEstablishedAccountReadScope({}), getAccountEncryptionMode: async () => mode,
            readCredential: async ({ ref }) => { expect(ref).toEqual(account); return snapshot; },
            readConfiguration: async () => null,
            configuration: { read: async () => null, secrets: {
                async admit(references) { expect(references).toEqual([reference]); }, has: async () => true,
                async read(ref) { reads.push(ref); return values.get(ref) ?? null; },
            } },
            openContent: input => input.accountMode === 'plain'
                ? openQualifiedConnectedAccountContentEnvelope({ ...input, accountMode: 'plain' })
                : openQualifiedConnectedAccountContentEnvelope({ ...input, accountMode: 'e2ee', material }),
            sealCredentialContent: (accountMode, replacement) => accountMode === 'plain'
                ? sealQualifiedConnectedAccountContentEnvelope({ kind: 'credential', accountMode: 'plain', payload: replacement, randomBytes })
                : sealQualifiedConnectedAccountContentEnvelope({ kind: 'credential', accountMode: 'e2ee', material, payload: replacement, randomBytes }),
        });
        const port = createConnectedAccountPurposePort({ available: true,
            resolveService: async () => ({ service, authentication: descriptor.authentication }), listAccounts: async () => [profile],
            materializeAccount: createConnectedAccountPurposeMaterializer(owner),
        });
        const selection = { purpose, serviceRefs: [service], expectedAccount: account,
            purposeBindings: { v: 1 as const, bindings: [{ purpose, target: { kind: 'account' as const, account } }] },
            signal: new AbortController().signal };
        expect(await port.listActionFormConnectedAccountOptions({ serviceRefs: [service], signal: selection.signal })).toEqual([{ value: account, label: 'Cloud' }]);
        expect(reads).toEqual([]);
        const request = { kind: 'httpHeaders' as const, origin: 'https://cloud.example.test', headerNames: ['authorization'] };
        expect(await (await port.bind(selection)).materialize(request)).toEqual({ kind: 'httpHeaders', headers: { authorization: 'Bearer first-key' } });
        values.set(reference, 'rotated-key');
        expect(await (await port.bind(selection)).materialize(request)).toEqual({ kind: 'httpHeaders', headers: { authorization: 'Bearer rotated-key' } });
        expect(reads).toEqual([reference, reference]);
        expect(snapshot.content).toEqual(content);
        await expect(port.bind({ ...selection, expectedAccount: { service, accountId: 'other-account' } }))
            .rejects.toMatchObject({ code: 'plugin_connected_account_binding_out_of_scope' });
        expect(reads).toEqual([reference, reference]);
    });
});
