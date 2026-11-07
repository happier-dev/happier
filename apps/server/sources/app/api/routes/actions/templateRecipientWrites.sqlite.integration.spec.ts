import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { deriveArtifactStoredKindV1 } from '@happier-dev/protocol/artifacts/artifactKindV1';
import { MCP_SERVER_CATALOG_ROWS_ROUTE_V1, McpServerCatalogRowMutationV1Schema } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { PROMPT_LIBRARY_ROWS_ROUTE_V1 } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createSignedDiscussionHttpFixture as signedFixture } from './discussionExecutionAuthorization.testkit';
import { createExternalActionAuthorizedRequestHeaders } from '../../../../../../cli/src/api/externalActionExecutionAuthorization';

describe('template recipient writes through the admitted requester root', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-template-recipient-writes-', initAuth: true, initEncrypt: true,
            env: { AUTH_REQUIRED_LOGIN_PROVIDERS: '', AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: '0',
                HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED: 'true', HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: 'true',
                HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' } });
    }, 300_000);
    afterAll(async () => { await harness?.close(); });

    async function fixture(actionId: 'template.instantiate' | 'template.updates.apply') {
        const sessionId = 'cmvtemplate-recipient-writes';
        const f = await signedFixture(actionId, [sessionId], false, undefined,
            { artifactReads: true, templateCatalogs: true, publicShares: true });
        const authorization = await f.mint(actionId, actionId === 'template.updates.apply'
            ? { sessionRef: { serverId: 'home', sessionId }, expectedVersion: '1.1.7' }
            : { source: { kind: 'artifact', serverId: 'home', artifactId: randomUUID() }, expectedVersion: '1.1.7',
                expectedRevision: { headerVersion: 1, bodyVersion: 1 },
                creation: { creationKey: randomUUID(), executionTarget: { serverId: 'home', machineId: f.machine.id },
                    directory: { kind: 'path', path: '/work' },
                    agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } } });
        const headers = (method: 'GET' | 'POST', path: string, body?: unknown) => ({
            'content-type': 'application/json',
            'x-happier-account-stored-content-protocol': '2',
            ...createExternalActionAuthorizedRequestHeaders({ authorization, effectActionId: actionId,
                target: authorization.binding.target, installationId: f.machine.installationId!,
                privateKey: f.keyPair.secretKey, method, path, ...(body === undefined ? {} : { body }) }),
        });
        expect(headers('GET', '/v1/account/encryption/currentness')).not.toHaveProperty('authorization');
        return { ...f, authorization, headers };
    }

    it.each(['template.instantiate', 'template.updates.apply'] as const)(
        '%s can create and revise private content while Artifact access and CAS remain authoritative', async actionId => {
        const f = await fixture(actionId);
        try {
            for (const kind of ['prompt_doc.v2', 'memory_doc.v1', 'prompt_bundle.v2', 'bot_template.v1'] as const) {
                const id = randomUUID();
                const original = encodePlainArtifactStoredContent({ body: 'Before' });
                const revised = encodePlainArtifactStoredContent({ body: 'After' });
                const create = { id, kind: deriveArtifactStoredKindV1({ kind }),
                    header: encodePlainArtifactStoredContent({ title: kind }), body: original,
                    dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER };
                const created = await f.app.inject({ method: 'POST', url: '/v1/artifacts', headers: f.headers('POST', '/v1/artifacts', create), payload: create });
                expect(created.statusCode, created.body).toBe(200);
                if (kind === 'memory_doc.v1' && actionId === 'template.instantiate') {
                    const exposurePath = `/v1/public-shares?${new URLSearchParams({ subjectKind: 'artifact', subjectId: id })}`;
                    const exposure = await f.app.inject({ method: 'GET', url: exposurePath,
                        headers: f.headers('GET', exposurePath) });
                    expect(exposure.statusCode, exposure.body).toBe(200);
                    expect(exposure.json()).toMatchObject({ publicShares: [] });
                    const broadExposurePath = `${exposurePath}&extra=1`;
                    expect((await f.app.inject({ method: 'GET', url: broadExposurePath,
                        headers: f.headers('GET', broadExposurePath) })).statusCode).toBe(401);
                }
                const body = { body: revised, expectedBodyVersion: 1 };
                const updated = await f.app.inject({ method: 'POST', url: `/v1/artifacts/${id}`, headers: f.headers('POST', `/v1/artifacts/${id}`, body), payload: body });
                expect(updated.statusCode, updated.body).toBe(200);
                expect(await db.artifact.findUniqueOrThrow({ where: { id } })).toMatchObject({ bodyVersion: 2 });
                const stale = await f.app.inject({ method: 'POST', url: `/v1/artifacts/${id}`, headers: f.headers('POST', `/v1/artifacts/${id}`, body), payload: body });
                expect(stale.statusCode, stale.body).toBe(200);
                expect(stale.json()).toMatchObject({ error: 'version-mismatch' });
                expect(await db.artifact.findUniqueOrThrow({ where: { id } })).toMatchObject({ bodyVersion: 2 });
            }
            const other = await signedFixture();
            try {
                const id = randomUUID();
                // Seed a genuinely foreign Artifact through the same real domain route.
                const created = await f.app.inject({ method: 'POST', url: '/v1/artifacts',
                    headers: { authorization: `Bearer ${other.presentUserToken}` }, payload: { id,
                        header: encodePlainArtifactStoredContent({ title: 'Other Account' }),
                        body: encodePlainArtifactStoredContent({ body: 'Private' }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER } });
                expect(created.statusCode, created.body).toBe(200);
                const overwrite = { body: encodePlainArtifactStoredContent({ body: 'Overwrite' }), expectedBodyVersion: 1 };
                const denied = await f.app.inject({ method: 'POST', url: `/v1/artifacts/${id}`,
                    headers: f.headers('POST', `/v1/artifacts/${id}`, overwrite), payload: overwrite });
                expect(denied.statusCode).toBe(404);
                expect(await db.artifact.findUniqueOrThrow({ where: { id } })).toMatchObject({ bodyVersion: 1 });
            } finally { await other.app.close(); }
            await expect(f.verify(f.authorization, { method: 'POST', path: `/v1/artifacts/${randomUUID()}`,
                body: { body: 'Yg==', expectedBodyVersion: 1, unexpected: true } })).resolves.toBeNull();
        } finally { await f.app.close(); }
    });

    it.each(['template.instantiate', 'template.updates.apply'] as const)(
        '%s can prepare catalogs and publish selected MCP needs without global prompt-library writes', async actionId => {
        const f = await fixture(actionId);
        try {
            for (const url of ['/v1/account/encryption/currentness', MCP_SERVER_CATALOG_ROWS_ROUTE_V1,
                PROMPT_LIBRARY_ROWS_ROUTE_V1, `${PROMPT_LIBRARY_ROWS_ROUTE_V1}/skill-rules`]) {
                const read = await f.app.inject({ method: 'GET', url, headers: f.headers('GET', url) });
                expect(read.statusCode, `${url}: ${read.body}`).toBe(200);
            }
            const body = McpServerCatalogRowMutationV1Schema.parse({ expectedRevision: 'absent', sourceSettingsVersion: 0,
                content: { t: 'plain', v: { v: 1, servers: [], bindings: [] } } });
            const write = await f.app.inject({ method: 'POST', url: MCP_SERVER_CATALOG_ROWS_ROUTE_V1,
                headers: f.headers('POST', MCP_SERVER_CATALOG_ROWS_ROUTE_V1, body), payload: body });
            expect(write.statusCode, write.body).toBe(200);
            expect(write.json()).toMatchObject({ status: 'updated' });
            const stale = await f.app.inject({ method: 'POST', url: MCP_SERVER_CATALOG_ROWS_ROUTE_V1,
                headers: f.headers('POST', MCP_SERVER_CATALOG_ROWS_ROUTE_V1, body), payload: body });
            expect(stale.statusCode, stale.body).toBe(200);
            expect(stale.json()).toMatchObject({ status: 'conflict' });
            const wrongModeBody = McpServerCatalogRowMutationV1Schema.parse({ expectedRevision: 1,
                content: { t: 'encrypted', c: 'unavailable' } });
            const wrongMode = await f.app.inject({ method: 'POST', url: MCP_SERVER_CATALOG_ROWS_ROUTE_V1,
                headers: f.headers('POST', MCP_SERVER_CATALOG_ROWS_ROUTE_V1, wrongModeBody), payload: wrongModeBody });
            expect(wrongMode.statusCode, wrongMode.body).toBe(200);
            expect(wrongMode.json()).toMatchObject({ status: 'account-mode-mismatch' });
            await expect(f.verify(f.authorization, { method: 'POST', path: MCP_SERVER_CATALOG_ROWS_ROUTE_V1,
                body: { ...body, unexpected: true } })).resolves.toBeNull();
            await expect(f.verify(f.authorization, { method: 'POST', path: `${PROMPT_LIBRARY_ROWS_ROUTE_V1}/skill-rules`,
                body: { expectedRevision: 'absent', sourceSettingsVersion: 0,
                    content: { t: 'plain', v: { key: 'skill-rules', value: { v: 1, rules: [] } } } } })).resolves.toBeNull();
            await expect(f.verify(f.authorization, { method: 'POST', path: '/v2/account/settings', body: {} })).resolves.toBeNull();
            await expect(f.verify(f.authorization, { method: 'GET', path: `${MCP_SERVER_CATALOG_ROWS_ROUTE_V1}?extra=1` })).resolves.toBeNull();
        } finally { await f.app.close(); }
    });
});
