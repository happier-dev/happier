import { join, resolve } from 'node:path';
import fastify from 'fastify';
import { ActionsSettingsV1Schema, accountSettingsParse, type QualifiedConnectedAccountRef } from '@happier-dev/protocol';
import { QualifiedConnectedAccountCredentialHealthPatchV4Schema, QualifiedConnectedAccountCredentialMutationSuccessV4Schema,
    QualifiedConnectedAccountCredentialMutationV4Schema, QualifiedConnectedAccountCredentialSnapshotV4Schema } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { QualifiedConnectedAccountCredentialPayloadV1Schema, openQualifiedConnectedAccountContentEnvelope, resolveQualifiedConnectedAccountCredentialValuesV1 } from '@happier-dev/protocol/connect/qualifiedConnectedAccountContentEnvelope';
import { SHARED_SAVED_SECRET_ACTION_PATHS_V1, SharedSavedSecretMutationOutputV1Schema, SharedSavedSecretPromoteInputV1Schema,
    SharedSavedSecretPromoteOutputV1Schema, SharedSavedSecretUpdateInputV1Schema } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import { SavedSecretResourceMaterialsResponseV1Schema } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { openSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { createConnectedAccountAttemptTransactionApiBoundary } from './connectedAccountAttemptTransactionApi';
import { installAxiosFastifyAdapter } from './http/axiosAdapter';
import { registerAccountHomeHttp } from '@/session/actions/widgetApproval.testkit';
import { registerAuthoredAccountActionRelease } from '@/plugins/runtime/accountPluginActions.testkit';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { readQualifiedConnectedAccountCredentialV4 } from '@/api/client/qualifiedConnectedAccountApi';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { QualifiedConnectedAccountListResponseV4Schema, QualifiedConnectedAccountServiceRefSchema } from '@happier-dev/protocol/connect/qualified-connected-account-projections';
import { parseQualifiedConnectedAccountV4StructuredQueryValue } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4QueryCodec';

/** Authored public artifact plus genuine Home HTTP/database boundaries; no runtime or lifecycle mocks. */
export async function createPortableConnectedAccountAuthenticationHttpFixture(origin: string,
    options: Readonly<{ accountId?: string; requireAccountConfiguration?: boolean; includeBundledPluginIds?: readonly string[] }> = {}) {
    const app = fastify();
    const accountId = options.accountId ?? 'portable-authentication-owner';
    const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`, encryption: null };
    const settings = accountSettingsParse({ actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1, actions: {
        'connectedServices.authentication.beginConnect': { approvalRequiredSurfaces: [] },
        'connectedServices.authentication.beginReconnect': { approvalRequiredSurfaces: [] },
        'connectedServices.authentication.submitManual': { approvalRequiredSurfaces: [] },
        'connectedServices.authentication.continueConnect': { approvalRequiredSurfaces: [] },
        'connectedServices.configuration.replace': { approvalRequiredSurfaces: [] },
    }, approvalWaivedSurfaces: {
        'connectedServices.authentication.beginConnect': ['agent', 'cli'],
        'connectedServices.authentication.beginReconnect': ['agent', 'cli'],
        'connectedServices.authentication.submitManual': ['agent', 'cli'],
        'connectedServices.authentication.continueConnect': ['agent', 'cli'],
        'connectedServices.configuration.replace': ['agent', 'cli'],
    } }) });
    const features = registerAccountHomeHttp(app, { accountId, serverId: 'srv_portable_authentication', settings });
    app.get('/v1/features', async () => features);
    const manifest = normalizePluginManifestV2(createPluginManifestV2Fixture({ id: 'acme.portable-authentication', contributes: {
        connectedAccountDescriptors: [{ id: 'example', title: 'Example', authentication: {
            account: { artifactId: 'account-runtime', exportName: 'activate' }, defaultModeId: 'manual', modes: [{
                id: 'manual', kind: 'manual', outcomeReconciliation: 'none',
                fields: [{ id: 'token', title: 'Token', secret: true, schema: { type: 'string' } }],
                credentialFieldKeys: { token: 'token' },
                ...(options.requireAccountConfiguration ? { configuration: { scope: 'account', changeBehavior: 'reconnect',
                    fields: [{ id: 'region', title: 'Region', required: true, schema: { type: 'string' } }] } } : {}),
            }],
        } }],
    } }));
    const projectRoot = resolve(import.meta.dirname, '../../../../packages/plugin-sdk/examples/public-authoring');
    const authored = await registerAuthoredAccountActionRelease(app, accountId, { includeBundledPluginIds: options.includeBundledPluginIds, primary: {
        manifest, projectRoot, entryPath: join(projectRoot, 'portableAuthentication.ts'),
        activateExport: 'activate', manifestExport: null,
    } });
    const transactions = createConnectedAccountAttemptTransactionApiBoundary();
    type TransactionApi = typeof transactions;
    type TransactionParams = Pick<Parameters<TransactionApi['create']>[0], 'kind' | 'attemptId'>;
    const transactionPath = '/v2/connect/connected-account-attempt-transactions';
    app.post<{ Params: TransactionParams; Body: Omit<Parameters<TransactionApi['create']>[0], keyof TransactionParams> }>(
        `${transactionPath}/:kind/:attemptId`, request => transactions.create({ ...request.body, ...request.params }));
    app.patch<{ Params: TransactionParams; Body: Omit<Parameters<TransactionApi['replace']>[0], keyof TransactionParams> }>(
        `${transactionPath}/:kind/:attemptId`, request => transactions.replace({ ...request.body, ...request.params }));
    app.delete<{ Params: TransactionParams; Body: Omit<Parameters<TransactionApi['delete']>[0], keyof TransactionParams> }>(
        `${transactionPath}/:kind/:attemptId`, async request => {
            await transactions.delete({ ...request.body, ...request.params });
            return { status: 'deleted' };
        });
    app.get<{ Querystring: { pluginId: string; localId: string; machineId?: string } }>(`${transactionPath}/pending`, async request => ({
        attempts: await transactions.listPending({ service: { pluginId: request.query.pluginId, localId: request.query.localId },
            ...(request.query.machineId === undefined ? {} : { machineId: request.query.machineId }) }),
    }));
    app.get<{ Params: { attemptId: string } }>(`${transactionPath}/:attemptId`, async (request, reply) => {
        const record = await transactions.read(request.params);
        return record ?? reply.code(404).send({ error: 'connected_account_attempt_transaction_not_found' });
    });
    let credential: ReturnType<typeof QualifiedConnectedAccountCredentialSnapshotV4Schema.parse> | null = null;
    let initialConfiguration: Parameters<typeof openQualifiedConnectedAccountContentEnvelope>[0]['envelope'] | undefined;
    const promotedResources: Pick<ReturnType<typeof SharedSavedSecretPromoteInputV1Schema.parse>,
        'resourceId' | 'encryptionMode' | 'storedContent' | 'displayName' | 'kind'>[] = [];
    const resourceRevisions = new Map<string, number>();
    let credentialWrites = 0;
    let directCredentialWrites = 0;
    const commitCredential = (mutation: ReturnType<typeof QualifiedConnectedAccountCredentialMutationV4Schema.parse>) => {
        if ((credential?.credentialRevision ?? null) !== mutation.expectedCredentialRevision) throw new Error('Credential CAS mismatch');
        initialConfiguration = 'initialConfiguration' in mutation ? mutation.initialConfiguration?.replacementContentEnvelope : initialConfiguration;
        credentialWrites += 1;
        credential = QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({ ref: mutation.ref, authenticationModeId: mutation.authenticationModeId,
            revisionSemantics: 'revisioned', credentialRevision: `csr_${String(credentialWrites).padStart(26, '0')}`,
            configurationRevision: initialConfiguration ? 'csr_1123456789ABCDEFGHJKMNPQRS' : null,
            content: mutation.content, metadata: mutation.metadata });
        return QualifiedConnectedAccountCredentialMutationSuccessV4Schema.parse({ success: true,
            credentialRevision: credential.credentialRevision, configurationRevision: credential.configurationRevision });
    };
    app.get('/v4/connect/qualified/credential', async (_request, reply) => credential ?? reply.code(404).send({ error: 'not_found' }));
    app.get('/v4/connect/qualified/configuration', async (_request, reply) => reply.code(404).send({ error: 'not_found' }));
    app.get<{ Querystring: { service: string } }>('/v4/connect/qualified/accounts', request =>
        QualifiedConnectedAccountListResponseV4Schema.parse({
            service: parseQualifiedConnectedAccountV4StructuredQueryValue(QualifiedConnectedAccountServiceRefSchema, request.query.service),
            accounts: [],
        }));
    app.get('/v1/account/saved-secrets/resources/materials', async () => SavedSecretResourceMaterialsResponseV1Schema.parse({
        resources: promotedResources.map(resource => ({ resourceId: resource.resourceId, encryptionMode: resource.encryptionMode,
            storedContent: resource.storedContent, recipientEnvelope: null, entry: {
                ref: formatSharedSavedSecretRefV1(resource.resourceId), source: 'shared_resource', relationship: 'owner',
                ownerAccountId: accountId, name: resource.displayName, kind: resource.kind,
                revision: resourceRevisions.get(resource.resourceId), materialStatus: 'ready',
                capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true },
            } })),
    }));
    app.post(SHARED_SAVED_SECRET_ACTION_PATHS_V1['secrets.shared.update'], async request => {
        const update = SharedSavedSecretUpdateInputV1Schema.parse(request.body);
        const resource = promotedResources.find(row => row.resourceId === update.resourceId);
        if (!resource || resourceRevisions.get(resource.resourceId) !== update.expectedRevision) throw new Error('Resource CAS mismatch');
        Object.assign(resource, { displayName: update.displayName, kind: update.kind, storedContent: update.storedContent });
        const revision = update.expectedRevision + 1;
        resourceRevisions.set(resource.resourceId, revision);
        return SharedSavedSecretMutationOutputV1Schema.parse({ resourceId: resource.resourceId, revision });
    });
    app.post('/v4/connect/qualified/credential', async request => {
        directCredentialWrites += 1;
        return commitCredential(QualifiedConnectedAccountCredentialMutationV4Schema.parse(request.body));
    });
    app.patch('/v4/connect/qualified/credential/health', async request => {
        const patch = QualifiedConnectedAccountCredentialHealthPatchV4Schema.parse(request.body);
        if (!credential || credential.credentialRevision !== patch.expectedCredentialRevision
            || credential.configurationRevision !== patch.expectedConfigurationRevision) throw new Error('Health CAS mismatch');
        return QualifiedConnectedAccountCredentialMutationSuccessV4Schema.parse({ success: true,
            credentialRevision: credential.credentialRevision, configurationRevision: credential.configurationRevision });
    });
    app.post(SHARED_SAVED_SECRET_ACTION_PATHS_V1['secrets.shared.promote'], async request => {
        const promotion = SharedSavedSecretPromoteInputV1Schema.parse(request.body);
        const mutation = QualifiedConnectedAccountCredentialMutationV4Schema.parse(promotion.connectedAccountCredentialMutation);
        const receipt = commitCredential(mutation);
        const resources = [promotion, ...(promotion.additionalSavedSecretResources ?? [])];
        promotedResources.push(...resources);
        for (const resource of resources) resourceRevisions.set(resource.resourceId, 1);
        return SharedSavedSecretPromoteOutputV1Schema.parse({ resourceId: promotion.resourceId, settingsVersion: 1,
            connectedAccountCredential: { credentialRevision: receipt.credentialRevision, configurationRevision: receipt.configurationRevision } });
    });
    let machineRequests = 0;
    let addressedAttemptReads = 0;
    app.get('/v1/machines', async () => []);
    app.addHook('onRequest', async request => {
        if (/^\/v1\/machines(?:\/|$)/.test(request.url)) machineRequests += 1;
        if (request.method === 'GET' && request.url.startsWith(`${transactionPath}/`)
            && !request.url.startsWith(`${transactionPath}/pending`)) addressedAttemptReads += 1;
    });
    await app.ready();
    const restoreHttp = installAxiosFastifyAdapter({ app, origin });
    return {
        credentials, settings, features, service: { pluginId: authored.pluginId, localId: 'example' },
        get machineRequests() { return machineRequests; },
        get addressedAttemptReads() { return addressedAttemptReads; },
        get directCredentialWrites() { return directCredentialWrites; },
        get promotedResourceCount() { return promotedResources.length; },
        get initialConfiguration() { return initialConfiguration; },
        reopenInitialConfiguration() {
            return initialConfiguration ? openQualifiedConnectedAccountContentEnvelope({
                kind: 'configuration', accountMode: 'plain', envelope: initialConfiguration,
            }) : null;
        },
        readCredential(ref: QualifiedConnectedAccountRef) {
            return runWithServerHttpBaseUrl(origin, () => readQualifiedConnectedAccountCredentialV4({ token: credentials.token, ref }));
        },
        async reopenCredential(stored: NonNullable<Awaited<ReturnType<typeof readQualifiedConnectedAccountCredentialV4>>>) {
            const payload = QualifiedConnectedAccountCredentialPayloadV1Schema.parse(openQualifiedConnectedAccountContentEnvelope({
                kind: 'credential', accountMode: 'plain', envelope: stored.content,
            }));
            return await resolveQualifiedConnectedAccountCredentialValuesV1(payload, async reference => {
                const resource = promotedResources.find(row => formatSharedSavedSecretRefV1(row.resourceId) === reference);
                if (resource?.encryptionMode !== 'plain') return null;
                const content = openSavedSecretResourceStoredContentV1({ resourceId: resource.resourceId,
                    mode: 'plain', storedContent: resource.storedContent });
                return content?.v === 1 ? content.value : null;
            });
        },
        async close() { restoreHttp(); await app.close(); },
    };
}
