import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAccountProviderActionExecuteV1 } from '@happier-dev/protocol/providers/connections/accountProviderActionV1';
import { parseProviderActionRequestV1 } from '@happier-dev/protocol/providers/providerActionsV1';
import { CustomProviderTemplateV1Schema } from '@happier-dev/protocol/providers/connections/customTemplateV1';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol/providers/ids';
import { SessionProviderBindingMetadataV1Schema } from '@happier-dev/protocol/providers/sessions/bindingMetadataV1';
import { DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, PROVIDER_CONNECTIONS_ROWS_ROUTE_V1,
    ProviderConnectionsRowMutationV1Schema, ProviderConnectionsRowMutationResponseV1Schema,
    ProviderConnectionsRowReadResponseV1Schema, openProviderConnectionsContentV1,
    listProviderConnectionsCatalogSavedSecretRefsV1,
} from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerProviderConnectionsRoutes } from '@/app/account/providers/registerProviderConnectionsRoutes';
import { createSavedSecretResourceInTx } from '@/app/account/savedSecrets/savedSecretResourceService';
import { db, getDbProviderFromEnv, initDbPostgres } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { initEncrypt } from '@/modules/encrypt';

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('Provider catalog deletion (PostgreSQL)', () => {
    let connected = false;
    beforeAll(async () => {
        // The runner owns the disposable database; no retained stack data is used.
        if (!process.env.HAPPIER_DB_CONTRACT_CONTAINER_ID) throw new Error('Use the disposable PostgreSQL DB-contract harness');
        vi.stubEnv('HANDY_MASTER_SECRET', 'provider-deletion-disposable-contract');
        vi.stubEnv('HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY', 'optional');
        initDbPostgres();
        await db.$connect(); connected = true;
        await initEncrypt();
    });
    afterAll(async () => { if (connected) await db.$disconnect(); vi.unstubAllEnvs(); });

    it.each([false, true])('deletes a custom Responses connection with grants, a manual model, confirmation and a prior Session reference (retained connection: %s)', async retainedConnection => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const resourceId = randomUUID();
        const ref = formatSharedSavedSecretRefV1(resourceId);
        expect(await inTx(tx => createSavedSecretResourceInTx(tx, { accountId: account.id, resourceId,
            displayName: 'Constructed deletion contract', kind: 'token', encryptionMode: 'plain',
            storedContent: { t: 'plain', v: { v: 1, name: 'Constructed deletion contract', kind: 'token', value: 'dummy' } },
        }))).toMatchObject({ ok: true });
        const app = createAuthenticatedTestApp(); registerProviderConnectionsRoutes(app);
        const headers = { 'x-test-user-id': account.id };
        const post = async (payload: unknown) => {
            const response = await app.inject({ method: 'POST', url: PROVIDER_CONNECTIONS_ROWS_ROUTE_V1, headers,
                payload: ProviderConnectionsRowMutationV1Schema.parse(payload) });
            expect(response.statusCode, response.body).toBe(200);
            return ProviderConnectionsRowMutationResponseV1Schema.parse(response.json());
        };
        const read = async () => {
            const response = await app.inject({ method: 'GET', url: PROVIDER_CONNECTIONS_ROWS_ROUTE_V1, headers });
            expect(response.statusCode, response.body).toBe(200);
            const row = ProviderConnectionsRowReadResponseV1Schema.parse(response.json());
            if (row.status !== 'present') throw new Error(`Unexpected catalog status: ${row.status}`);
            const opened = openProviderConnectionsContentV1({ mode: 'plain', material: null, content: row.content });
            if (opened.status !== 'opened') throw new Error(`Unexpected catalog admission: ${opened.status}`);
            return { status: 'ready' as const, revision: row.revision, catalog: opened.catalog };
        };
        const execute = createAccountProviderActionExecuteV1({ assertCurrent() {}, now: () => 10,
            readCatalog: read, readDefinitions: async () => [], writeCatalog: async input => {
                // Row mutations admit unique captures, including when two connections share a Secret.
                const references = [...new Set(listProviderConnectionsCatalogSavedSecretRefsV1(input.catalog).map(item => item.secretId))];
                return post({ expectedRevision: input.expectedRevision, content: { t: 'plain', v: input.catalog },
                    referencedSavedSecretIds: references,
                    savedSecretRevisions: references.length ? [{ resourceId, expectedRevision: 1 }] : [],
                });
            },
        });
        const connectionId = ProviderConnectionIdSchema.parse('pc_deletion_contract');
        try {
            expect(await post({ expectedRevision: 'absent', sourceSettingsVersion: 0,
                content: { t: 'plain', v: DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 },
                referencedSavedSecretIds: [], savedSecretRevisions: [] })).toMatchObject({ status: 'updated' });
            expect(await execute(parseProviderActionRequestV1('providers.connections.create_custom', {
                action: 'createCustom', connectionId,
                template: CustomProviderTemplateV1Schema.parse({ v: 1, name: 'Constructed Responses',
                    endpointTemplates: [{ id: 'responses', protocol: 'openai-responses', baseUrl: 'https://example.test/v1',
                        capabilities: { streaming: 'unknown', toolRoundTrips: 'unknown', statefulResponses: 'unknown', reasoningControls: 'unknown' } }],
                    credential: { kind: 'apiKey', required: true, transports: [{ id: 'key', protocols: ['openai-responses'],
                        uses: ['probe', 'runtime'], destination: { kind: 'httpHeader', name: 'Authorization', format: 'bearer' } }] },
                    catalog: { source: 'manual', manualModelPolicy: 'allowed' } }),
                savedSecretId: ref, manualModels: [{ id: 'gpt-5' }], enable: true,
            }), {})).toMatchObject({ ok: true });
            expect(await execute(parseProviderActionRequestV1('providers.models.experimental.confirm', {
                action: 'confirmExperimental', connectionId, expectedConnectionRevision: 0,
                agentTargetKey: 'agent:happier.agent.codex/codex', modelId: 'gpt-5',
                compatibilityFingerprint: 'compatibility:v1:constructed',
            }), {})).toMatchObject({ ok: true });
            const created = await read();
            const grant = created.catalog.accountGrants[0]!;
            expect(grant.connectionId).toBe(connectionId);
            expect(await post({ expectedRevision: created.revision, content: { t: 'plain', v: {
                ...created.catalog, machineGrants: [{ ...grant, machineId: 'constructed-machine',
                    endpointSetFingerprint: 'endpoint-set:v1:constructed' }],
            } }, referencedSavedSecretIds: [ref], savedSecretRevisions: [{ resourceId, expectedRevision: 1 }] }))
                .toMatchObject({ status: 'updated' });
            if (retainedConnection) {
                const source = created.catalog.connections[0]!.source;
                if (source.kind !== 'custom') throw new Error('Expected the Action-created custom source');
                expect(await execute(parseProviderActionRequestV1('providers.connections.create_custom', {
                    action: 'createCustom', connectionId: 'pc_retained', template: source.template,
                    savedSecretId: ref, manualModels: [], enable: false,
                }), {})).toMatchObject({ ok: true });
            }
            const session = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), active: false,
                encryptionMode: 'plain', metadata: JSON.stringify({ providerBindingV1: SessionProviderBindingMetadataV1Schema.parse({
                    v: 1, connectionId, contributionKey: null, connectionRevision: 0, protocol: 'openai-responses',
                    materialization: 'spawnEnv', compatibilityFingerprint: 'compatibility:v1:constructed',
                    bindingSecurityFingerprint: grant.connectionSecurityFingerprint,
                    displaySnapshot: { providerName: 'Constructed Responses', connectionName: 'Constructed Responses',
                        connectionRole: 'named', connectionDisplayNameMode: 'custom' },
                }) }) } });
            await db.session.delete({ where: { id: session.id } });
            const before = await read();
            expect(before.catalog.manualModelsByConnectionId[connectionId]).toHaveLength(1);
            expect(before.catalog.experimentalBindingConfirmations).toHaveLength(1);
            expect(await execute(parseProviderActionRequestV1('providers.connections.delete', {
                action: 'delete', connectionId,
            }), {})).toMatchObject({ ok: true, result: { deletedConnectionId: connectionId } });
            const after = await read();
            expect(after.revision).toBe(before.revision + 1);
            expect(after.catalog.connections.map(connection => connection.id)).toEqual(retainedConnection ? ['pc_retained'] : []);
            expect(after.catalog.accountGrants).toEqual([]);
            expect(after.catalog.machineGrants).toEqual([]);
            expect(after.catalog.manualModelsByConnectionId).toEqual({});
            expect(after.catalog.experimentalBindingConfirmations).toEqual([]);
            expect(listProviderConnectionsCatalogSavedSecretRefsV1(after.catalog).map(item => item.secretId))
                .toEqual(retainedConnection ? [ref] : []);
            expect(await db.savedSecretResource.count({ where: { id: resourceId } })).toBe(1);
            console.info('C260_CONSTRUCTED_DELETE', { status: 'updated', revision: after.revision,
                connectionCount: after.catalog.connections.length,
                referenceCount: listProviderConnectionsCatalogSavedSecretRefsV1(after.catalog).length });
        } finally { await app.close(); }
    });
});
