import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as privacyKit from 'privacy-kit';
import tweetnacl from 'tweetnacl';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
    computeContentPublicKeyFingerprint, encodePlainArtifactStoredContent, sealEncryptedDataKeyEnvelopeV1,
    sealPublicShareDataKeyV1, openPublicShareDataKeyV1, sealSessionDataKeyBundleV0 } from '@happier-dev/protocol';
import { projectBotTemplateArtifactHeaderV1, type BotTemplateArtifactV1 } from '@happier-dev/protocol/bots/templates/botTemplateV1';
import { deriveArtifactStoredKindV1 } from '@happier-dev/protocol/artifacts/artifactKindV1';
import { ArtifactHttpReadV1Schema } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { ArtifactHeaderMetadataV1Schema, ArtifactSignedInLinkJoinReadV1Schema } from '@happier-dev/protocol/artifacts/artifactActionsV1';
import { ArtifactBodyEnvelopeV1StoredSchema } from '@happier-dev/protocol/artifacts/artifactBinaryV1';
import { decodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import type { HomeHubArtifactTransportV1 } from '@happier-dev/protocol/home/homeHubArtifactV1';
import { createBotTemplateActionExecuteV1 } from '@happier-dev/protocol/bots/templates/botTemplateOperations';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { createArtifactPublicLinkActionsV1, type ArtifactPublicLinkIssuedV1 } from '@happier-dev/protocol/actions/executor/artifactPublicLinkActions';
import { db } from '@/storage/db';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { publicShareRoutes } from './publicShareRoutes';
import { artifactsRoutes } from '../artifacts/artifactsRoutes';

describe('signed-in Artifact links through authenticated HTTP', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-template-links-', initEncrypt: true,
            env: { HAPPIER_PUBLIC_SERVER_URL: 'https://home.example.test', HAPPIER_WEBAPP_URL: 'https://home.example.test' } });
    }, 180_000);
    afterAll(async () => { if (harness) await harness.close(); });

    it('preserves the original bearer through later reviewed releases while explicit rotation and revocation stop joins', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const recipient = await db.account.create({ data: { encryptionMode: 'plain' } });
        const headers = (accountId: string) => ({ 'x-test-user-id': accountId,
            'x-happier-account-stored-content-protocol': String(CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION) });
        await withAuthenticatedTestApp(app => { publicShareRoutes(app); artifactsRoutes(app); }, async app => {
            // The Fastify fixture exposes untyped JSON; canonical schemas narrow each response below.
            const parseJson = (body: string): unknown => JSON.parse(body);
            const request = async (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) => {
                const response = await app.inject({ method, url, headers: headers(owner.id),
                    ...(payload === undefined ? {} : { payload: JSON.stringify(payload),
                        headers: { ...headers(owner.id), 'content-type': 'application/json' } }) });
                expect(response.statusCode, response.body).toBe(200);
                return parseJson(response.body);
            };
            const open = (value: unknown) => {
                const row = ArtifactHttpReadV1Schema.parse(value);
                return { artifactId: row.id, ownerAccountId: row.ownerAccountId, access: row.access, shared: false,
                    header: ArtifactHeaderMetadataV1Schema.parse(decodePlainArtifactStoredContent(row.header)),
                    body: ArtifactBodyEnvelopeV1StoredSchema.parse(decodePlainArtifactStoredContent(row.body)).body,
                    revision: { headerVersion: row.headerVersion, bodyVersion: row.bodyVersion } };
            };
            // Only HTTP and Session-metadata persistence are boundaries; release, child admission and link ownership stay real.
            const artifacts: HomeHubArtifactTransportV1 = {
                read: async artifactId => {
                    const response = await app.inject({ method: 'GET', url: `/v1/artifacts/${artifactId}`, headers: headers(owner.id) });
                    if (response.statusCode === 404) return null;
                    expect(response.statusCode, response.body).toBe(200);
                    return open(parseJson(response.body));
                },
                create: async input => open(await request('POST', '/v1/artifacts', { id: input.artifactId,
                    kind: deriveArtifactStoredKindV1(input.header), header: encodePlainArtifactStoredContent(input.header),
                    body: encodePlainArtifactStoredContent({ body: input.body }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER })),
                update: async input => {
                    await request('POST', `/v1/artifacts/${input.artifactId}`, {
                        kind: deriveArtifactStoredKindV1(input.header), header: encodePlainArtifactStoredContent(input.header),
                        body: encodePlainArtifactStoredContent({ body: input.body }),
                        expectedHeaderVersion: input.expectedRevision.headerVersion, expectedBodyVersion: input.expectedRevision.bodyVersion });
                    const current = await artifacts.read(input.artifactId);
                    if (!current) throw new Error('Updated Artifact missing');
                    return { ok: true, revision: current.revision };
                },
            };
            const issued: ArtifactPublicLinkIssuedV1[] = [];
            const links = createArtifactPublicLinkActionsV1({ randomBytes: tweetnacl.randomBytes,
                onPublicLinkIssued: link => { issued.push(link); },
                request: input => request(input.method, input.path, input.body),
                read: async artifactId => {
                    const artifact = await artifacts.read(artifactId);
                    return artifact ? { ...artifact, encryptionMode: 'plain', dataKey: null } : null;
                } });
            let draftRef: { serverId: string; artifactId: string } | null = null;
            const operations = createBotTemplateActionExecuteV1({ artifacts, randomId: () => crypto.randomUUID(),
                readSourceDraftRef: async () => draftRef, writeSourceDraftRef: async (_source, ref) => { draftRef = ref; },
                grant: async () => { throw new Error('No named grants selected'); },
                signedInLink: async (input, context) => {
                    if (!context.hostReviewedChild) throw new Error('Missing reviewed child');
                    const result = await context.hostReviewedChild.invoke({ action: 'artifact.public_link.create', role: 'signed_in_link',
                        input });
                    expect(result).toMatchObject({ ok: true });
                } });
            const executor = createActionExecutor({ botTemplateAction: args => operations(args),
                prepareBotTemplateRelease: operations.prepareRelease,
                artifactAction: args => {
                    if (args.actionId !== 'artifact.public_link.create' && args.actionId !== 'artifact.public_link.revoke')
                        throw new Error(`Unexpected Artifact Action: ${args.actionId}`);
                    return links({ actionId: args.actionId, input: args.input, signal: args.signal });
                } });
            const run = (actionId: 'template.draft' | 'template.release' | 'artifact.public_link.create' | 'artifact.public_link.revoke', input: unknown) =>
                executor.execute(actionId, input, { surface: 'ui', serverId: 'home', authority: 'present_user',
                    actionsSettings: normalizeActionsSettingsV1({ v: 1, actions: {} }), presentUserConfirmation: { actionId } });
            const draftArtifactId = crypto.randomUUID();
            for (const version of ['1.0.0', '1.1.0']) {
                const current = await artifacts.read(draftArtifactId);
                const drafted = await run('template.draft', { draftArtifactId, sourceSessionRef: { serverId: 'home', sessionId: 'author-session' },
                    ...(current ? { expectedRevision: current.revision } : {}),
                    content: { v: 1, identity: { name: 'Garden', description: '' }, instructions: { markdown: `Grow herbs ${version}` },
                        skills: [], memoryRules: [], needs: { software: [], connectedAccounts: [], mcpServers: [] } } });
                expect(drafted, JSON.stringify(drafted)).toMatchObject({ ok: true });
                const draft = await artifacts.read(draftArtifactId);
                if (!draft) throw new Error('Draft missing');
                expect(await run('template.release', { draftArtifactId, expectedRevision: draft.revision, version, changelog: '',
                    share: { recipients: [], signedInLink: true } })).toMatchObject({ ok: true });
                const original = issued[0];
                if (!original) throw new Error('First release did not issue link');
                const joined = await app.inject({ method: 'GET', url: `/v1/artifact-signed-in-links/${original.lookupId}/join`,
                    headers: headers(recipient.id) });
                expect(joined.statusCode, `${version}: ${joined.body}`).toBe(200);
                const prepared = ArtifactSignedInLinkJoinReadV1Schema.parse(parseJson(joined.body));
                if (prepared.content.kind !== 'artifact') throw new Error('Join returned non-Artifact content');
                expect(decodePlainArtifactStoredContent(prepared.content.body)).toEqual({ body: expect.stringContaining(`Grow herbs ${version}`) });
                expect(issued).toHaveLength(1);
            }
            const artifactId = issued[0]!.shareId;
            expect(await run('artifact.public_link.create', { artifactId, audience: 'signed_in' })).toMatchObject({ ok: true });
            expect(issued).toHaveLength(2);
            const join = (lookupId: string) => app.inject({ method: 'GET', url: `/v1/artifact-signed-in-links/${lookupId}/join`,
                headers: headers(recipient.id) });
            expect((await join(issued[0]!.lookupId)).statusCode).toBe(404);
            expect((await join(issued[1]!.lookupId)).statusCode).toBe(200);
            expect(await run('artifact.public_link.revoke', { artifactId, audience: 'signed_in', shareId: artifactId }))
                .toMatchObject({ ok: true });
            expect((await join(issued[1]!.lookupId)).statusCode).toBe(404);
        });
    });

    it.each(['plain', 'e2ee'] as const)('joins %s links only as self, isolates anonymous routes and separates link from grant revocation', async mode => {
        const account = (accountMode = mode) => db.account.create({ data: { encryptionMode: accountMode,
            ...(accountMode === 'e2ee' ? createSignedAccountContentBinding() : {}) } });
        const owner = await account();
        const recipient = await account();
        const peer = await account();
        const plainRecipient = await account('plain');
        const dataKey = tweetnacl.randomBytes(32);
        const wrap = (publicKey: Uint8Array) => privacyKit.encodeBase64(new Uint8Array(sealEncryptedDataKeyEnvelopeV1({
            dataKey, recipientPublicKey: publicKey, randomBytes: tweetnacl.randomBytes,
        })));
        const released: BotTemplateArtifactV1 = { v: 1, state: 'released', release: { v: 1, version: '1.0.0', releasedAtMs: 1,
            changelog: '', content: { v: 1, identity: { name: 'Garden', description: 'A reusable Bot', madeFromName: 'Garden' },
                instructions: { markdown: 'Help with plants' }, memoryRules: [], skills: [],
                needs: { software: [], connectedAccounts: [], mcpServers: [] } } } };
        const encode = async (value: unknown) => mode === 'plain' ? privacyKit.decodeBase64(encodePlainArtifactStoredContent(value))
            : new Uint8Array(await sealSessionDataKeyBundleV0(value, dataKey));
        const artifact = await db.artifact.create({ data: { id: crypto.randomUUID(), accountId: owner.id,
            kind: deriveArtifactStoredKindV1({ kind: 'bot_template.v1' }), headerVersion: 1, bodyVersion: 1,
            header: await encode(projectBotTemplateArtifactHeaderV1(released)), body: await encode({ body: JSON.stringify(released) }),
            dataEncryptionKey: privacyKit.decodeBase64(mode === 'plain' ? ARTIFACT_PLAIN_DATA_KEY_MARKER : wrap(owner.contentPublicKey!)),
        } });
        const lookupId = crypto.randomUUID();
        const keyEnvelope = { recipientAccountId: recipient.id, encryptedDataKey: mode === 'e2ee' ? wrap(recipient.contentPublicKey!) : '',
            recipientContentPublicKeyFingerprint: mode === 'e2ee' ? computeContentPublicKeyFingerprint(recipient.contentPublicKey!) : '' };
        const headers = (accountId: string) => ({ 'x-test-user-id': accountId,
            'x-happier-account-stored-content-protocol': String(CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION) });
        await withAuthenticatedTestApp(app => { publicShareRoutes(app); artifactsRoutes(app); }, async app => {
            const create = { method: 'POST' as const, url: '/v1/artifact-signed-in-links', headers: headers(owner.id), payload: {
                artifactId: artifact.id, lookupId,
                ...(mode === 'e2ee' ? { encryptedDataKey: sealPublicShareDataKeyV1({ dataKey, secret: 'A'.repeat(43), randomBytes: tweetnacl.randomBytes }) } : {}),
            } };
            const created = await app.inject(create);
            expect(created.statusCode, created.body).toBe(200);
            expect(created.json()).toMatchObject({ publicShare: { id: artifact.id, audience: 'signed_in', subject: { kind: 'artifact', id: artifact.id } } });
            const originalLink = await db.artifactSignedInLink.findUniqueOrThrow({ where: { artifactId: artifact.id } });
            const preserved = await app.inject({ ...create, payload: { ...create.payload, lookupId: crypto.randomUUID(), preserveExisting: true,
                ...(mode === 'e2ee' ? { encryptedDataKey: sealPublicShareDataKeyV1({ dataKey, secret: 'B'.repeat(43), randomBytes: tweetnacl.randomBytes }) } : {}) } });
            expect(preserved.statusCode, preserved.body).toBe(200);
            expect(preserved.json()).toMatchObject({ created: false, publicShare: { id: artifact.id, audience: 'signed_in' } });
            expect(await db.artifactSignedInLink.findUniqueOrThrow({ where: { artifactId: artifact.id } })).toEqual(originalLink);
            const listed = await app.inject({ method: 'GET', url: `/v1/artifact-signed-in-links?artifactId=${artifact.id}`, headers: headers(owner.id) });
            expect(listed.json()).toMatchObject({ publicShares: [{ id: artifact.id, audience: 'signed_in' }] });
            expect((await app.inject({ method: 'GET', url: `/v1/artifact-signed-in-links?artifactId=${artifact.id}`, headers: headers(peer.id) })).statusCode).toBe(403);
            const exposed = await app.inject({ method: 'GET', url: `/v1/artifacts/${artifact.id}`, headers: headers(owner.id) });
            expect(exposed.statusCode, exposed.body).toBe(200);
            expect(exposed.json().publicAudience).toBe('retained');
            expect((await app.inject({ ...create, headers: headers(peer.id) })).statusCode).toBe(403);
            for (const url of [`/v1/public-shares/${lookupId}/content`, `/s/${lookupId}`, `/v1/public-shares/${lookupId}`]) {
                expect((await app.inject({ method: 'GET', url })).statusCode).toBe(404);
            }
            const joinUrl = `/v1/artifact-signed-in-links/${lookupId}/join`;
            expect((await app.inject({ method: 'GET', url: joinUrl })).statusCode).toBe(401);
            const prepared = await app.inject({ method: 'GET', url: joinUrl, headers: headers(recipient.id) });
            expect(prepared.statusCode, prepared.body).toBe(200);
            expect(prepared.json()).toMatchObject({ artifactId: artifact.id, authorAccountId: owner.id, encryptionMode: mode });
            if (mode === 'e2ee') expect(openPublicShareDataKeyV1({ encryptedDataKey: prepared.json().encryptedDataKey, secret: 'A'.repeat(43) })).toEqual(dataKey);
            expect(prepared.body).not.toMatch(/provenance|revisions|grants|sourceSession/);
            if (mode === 'e2ee') {
                const refused = await app.inject({ method: 'POST', url: joinUrl, headers: headers(plainRecipient.id), payload: {} });
                expect(refused.statusCode, refused.body).toBe(409);
                expect(refused.json()).toMatchObject({ error: 'recipient_key_unavailable', reason: 'plain_account' });
                expect(await db.artifactAccountGrant.count({ where: { artifactId: artifact.id, accountId: plainRecipient.id } })).toBe(0);
                expect((await app.inject({ method: 'POST', url: joinUrl, headers: headers(peer.id), payload: { keyEnvelope } })).statusCode).toBe(403);
            }
            const joined = await app.inject({ method: 'POST', url: joinUrl, headers: headers(recipient.id), payload: mode === 'e2ee' ? { keyEnvelope } : {} });
            expect(joined.statusCode, joined.body).toBe(200);
            expect(joined.json()).toEqual({ artifactId: artifact.id, ownerAccountId: owner.id, access: 'view' });
            await db.artifactAccountGrant.update({ where: { artifactId_accountId: { artifactId: artifact.id, accountId: recipient.id } }, data: { accessLevel: 'edit' } });
            const rejoined = await app.inject({ method: 'POST', url: joinUrl, headers: headers(recipient.id), payload: mode === 'e2ee' ? { keyEnvelope } : {} });
            expect(rejoined.json()).toMatchObject({ access: 'edit' });
            expect((await app.inject({ method: 'GET', url: `/v1/artifacts/${artifact.id}`, headers: headers(recipient.id) })).statusCode).toBe(200);
            expect((await app.inject({ method: 'DELETE', url: `/v1/artifact-signed-in-links/${artifact.id}`, headers: headers(owner.id) })).statusCode).toBe(200);
            expect((await app.inject({ method: 'POST', url: joinUrl, headers: headers(peer.id), payload: {} })).statusCode).toBe(404);
            expect((await app.inject({ method: 'GET', url: `/v1/artifacts/${artifact.id}`, headers: headers(recipient.id) })).statusCode).toBe(200);
            expect((await app.inject({ method: 'DELETE', url: `/v1/artifacts/${artifact.id}/access/grants`, headers: headers(owner.id), payload: {
                artifactId: artifact.id, principal: { kind: 'account', accountId: recipient.id },
            } })).statusCode).toBe(200);
            expect((await app.inject({ method: 'GET', url: `/v1/artifacts/${artifact.id}`, headers: headers(recipient.id) })).statusCode).toBe(404);
        });
    });
});
