import Fastify, { type InjectOptions } from "fastify";
import { randomUUID } from "node:crypto";
import tweetnacl from "tweetnacl";
import * as privacyKit from "privacy-kit";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";

import {
    API_TOKEN_FULL_GRANT_V1,
    ApiTokenGrantV1Schema,
    StoredApiTokenGrantV1Schema,
    AccountApiTokensCreateActionOutputV1Schema,
    AccountApiTokensListActionOutputV1Schema,
    AccountApiTokenSelfV1Schema,
    SessionMessagesPageV1Schema,
    evaluateApiTokenGrantV1,
    isModelRefGrantedV1,
    isPermissionModeGrantedV1,
    parseAccountApiTokenBearerV1,
    signAccountContentKeyBindingV1,
    ACCOUNT_API_TOKEN_ENCRYPTION_ACCESS_HTTP_PATH_V1,
    ACCOUNT_API_TOKENS_CREATE_HTTP_PATH_V1,
    ACCOUNT_API_TOKENS_LIST_HTTP_PATH_V1,
    ACCOUNT_API_TOKENS_REVOKE_ALL_HTTP_PATH_V1,
    ACCOUNT_API_TOKENS_REVOKE_HTTP_PATH_V1,
    ACCOUNT_API_TOKENS_UPDATE_HTTP_PATH_V1,
} from "@happier-dev/protocol";

import { auth } from "@/app/auth/auth";
import { setAccountStatusInTx } from "@/app/home/governance/accountLifecycle";
import { getOrCreateServerIdentityId } from "@/app/serverIdentity/serverIdentity";
import { enableAuthentication } from "@/app/api/utils/enableAuthentication";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { acquireAccountSessionOwnerMetadataFenceInTx } from "@/app/encryption/accountSessionOwnerMetadataFence";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { observeSqliteRequests } from "@/testkit/observeSqliteRequests";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";

import { registerAccountApiTokenManagementRoutes } from "./registerAccountApiTokenManagementRoutes";
import { registerSessionCreateOrLoadRoute } from "../session/registerSessionCreateOrLoadRoute";
import { registerSessionMessageRoutes } from "../session/registerSessionMessageRoutes";
import { createSessionMessage } from "@/app/session/sessionWriteService";
import type { Fastify as AppFastify } from "@/app/api/types";
import { plainPrivateLabel, prepareE2eeAccountApiTokenLabel, preparePlainAccountApiTokenLabel } from "@/testkit/privateLabelFixture";

function createTestApp() {
    const app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as AppFastify;
    enableAuthentication(typed);
    registerAccountApiTokenManagementRoutes(typed);
    registerSessionCreateOrLoadRoute(typed);
    return typed;
}

function bearer(token: string): Readonly<{ authorization: string }> {
    return { authorization: `Bearer ${token}` };
}

describe("authRoutes (API-token management) (integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-auth-api-token-management-",
            initAuth: true,
            env: {
                AUTH_REQUIRED_LOGIN_PROVIDERS: "",
                AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: "0",
            },
        });
    }, 120_000);

    afterEach(async () => {
        harness.resetEnv();
        await db.sessionMessage.deleteMany();
        await db.session.deleteMany();
        await db.machine.deleteMany();
        await db.account.deleteMany();
    });

    afterAll(async () => {
        if (harness) await harness.close();
    });

    it("issues a session-scoped credential through HTTP and admits only its stored grant at transcript ingress", async () => {
        harness.resetEnv({ HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' });
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const sessions = await Promise.all([0, 1].map(() => db.session.create({ data: {
            accountId: account.id, tag: randomUUID(), encryptionMode: 'plain', metadata: '{}',
        } })));
        const session = sessions[0]!;
        const appended = await createSessionMessage({ inputAdmission: 'authenticatedAccount', actorUserId: account.id,
            authentication: { env: process.env, authority: 'present_user', authenticationEvidence: [] },
            sessionId: session.id, localId: 'scoped-http-row', messageRole: 'user',
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Only this chat' } } } });
        if (!appended.ok) throw new Error(`Append failed: ${appended.error}`);
        const grant = ApiTokenGrantV1Schema.parse({ ...API_TOKEN_FULL_GRANT_V1,
            actions: { families: [], ids: ['session.transcript.get'] },
            targets: { sessions: [session.id], machines: [] }, approve: false });
        const signed = await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' });
        const app = createTestApp();
        registerSessionMessageRoutes(app);
        const endpoint = await app.listen({ host: '127.0.0.1', port: 0 });
        try {
            const created = await fetch(`${endpoint}${ACCOUNT_API_TOKENS_CREATE_HTTP_PATH_V1}`, {
                method: 'POST', headers: { ...bearer(signed), 'content-type': 'application/json' },
                body: JSON.stringify({ tokenId: randomUUID(), label: await preparePlainAccountApiTokenLabel(account.id, 'Scoped HTTP'), grant }),
            });
            expect(created.status).toBe(200);
            const issued = AccountApiTokensCreateActionOutputV1Schema.parse(await created.json());
            const stored = await db.accountApiToken.findUniqueOrThrow({ where: { id: issued.apiToken.tokenId } });
            expect(StoredApiTokenGrantV1Schema.parse(stored.accessGrant)).toEqual(grant);
            const self = await fetch(`${endpoint}/v1/auth/api-tokens/self`, { headers: bearer(issued.token) });
            expect(self.status).toBe(200);
            expect(AccountApiTokenSelfV1Schema.parse(await self.json())).toMatchObject({
                credentialId: issued.apiToken.tokenId, accountId: account.id, grant,
            });
            const allowed = await fetch(`${endpoint}/v1/sessions/${session.id}/messages?afterSeq=0`, { headers: bearer(issued.token) });
            expect(allowed.status).toBe(200);
            expect(SessionMessagesPageV1Schema.parse(await allowed.json()).messages).toMatchObject([
                { id: appended.message.id, seq: appended.message.seq, content: { t: 'plain', v: {
                    role: 'user', content: { type: 'text', text: 'Only this chat' },
                } } },
            ]);
            const denied = await fetch(`${endpoint}/v1/sessions/${sessions[1]!.id}/messages?afterSeq=0`, { headers: bearer(issued.token) });
            expect(denied.status).toBe(403);
            expect(await denied.json()).toEqual({ error: 'credential_scope_denied' });
            // Same target, different Action: a read-only token cannot append input.
            const send = await fetch(`${endpoint}/v2/sessions/${session.id}/messages`, {
                method: 'POST', headers: { ...bearer(issued.token), 'content-type': 'application/json' },
                body: JSON.stringify({ localId: 'refused-input', content: { t: 'plain', v: {
                    role: 'user', content: { type: 'text', text: 'Forbidden input' },
                } } }),
            });
            expect(send.status).toBe(403);
            expect(await send.json()).toEqual({ error: 'credential_scope_denied' });
            expect(await db.sessionMessage.count({ where: { sessionId: session.id } })).toBe(1);
        } finally { await app.close(); }
    });

    it("refuses forged session creation authorization before creating a Session", async () => {
        harness.resetEnv({ HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' });
        const account = await db.account.create({ data: { publicKey: `pat-creator-${randomUUID()}`, encryptionMode: 'plain' } });
        const signed = await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' });
        const app = createTestApp();
        await app.ready();
        try {
            const response = await app.inject({ method: 'POST', url: '/v1/sessions',
                headers: { ...bearer(signed), 'x-happier-account-stored-content-protocol': '2',
                    'x-happier-session-creation-authorization': 'forged' },
                payload: { tag: randomUUID(), metadataLayoutVersion: 1, sharedMetadata: { ciphertext: '{"v":1}' },
                    ownerMetadata: { t: 'plain', v: { v: 1 } }, encryptionMode: 'plain' } });
            expect(response.statusCode, response.body).toBe(401);
            expect(await db.session.count({ where: { accountId: account.id } })).toBe(0);
        } finally { await app.close(); }
    });

    it("persists a restricted grant, attenuates children, and revokes children only when access changes", async () => {
        const account = await db.account.create({ data: { publicKey: `pat-grant-${randomUUID()}`, encryptionMode: 'plain' } });
        const signed = await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' });
        const grant = {
            v: 1, actions: { families: [], ids: ['session.message.send', 'session.transcript.get'] },
            targets: { sessions: ['S1'], machines: [] }, approve: false, origins: ['https://example.com'],
            models: null, permissionModes: ['default'], create: null,
        };
        const tokenId = randomUUID();
        const expiresAt = new Date(Date.now() + 60_000).toISOString();
        const app = createTestApp();
        await app.ready();
        try {
            const created = await app.inject({ method: 'POST', url: ACCOUNT_API_TOKENS_CREATE_HTTP_PATH_V1,
                headers: bearer(signed), payload: { tokenId, label: await preparePlainAccountApiTokenLabel(account.id, 'Restricted'), grant, expiresAt } });
            expect(created.statusCode, created.body).toBe(200);
            expect(created.json().apiToken.grant).toEqual(grant);
            const parent = created.json().token;
            const childPayload = { tokenId: randomUUID(), label: await preparePlainAccountApiTokenLabel(account.id, 'Child'), expiresAt, grant };
            const mint = (credential: string, payload: InjectOptions['payload'] = childPayload) => app.inject({ method: 'POST',
                url: '/v1/auth/api-tokens/children/create', headers: bearer(credential), payload });
            const wider = await mint(parent, { ...childPayload, grant: { ...grant, targets: null } });
            expect(wider.statusCode, wider.body).toBe(400);
            expect(wider.json()).toEqual({ error: 'api_token_child_invalid' });
            const tooLate = await mint(parent, { ...childPayload, expiresAt: new Date(Date.now() + 120_000).toISOString() });
            expect(tooLate.statusCode).toBe(400);
            const child = await mint(parent);
            expect(child.statusCode, child.body).toBe(200);
            expect(child.json().apiToken.hasEncryptionAccess).toBe(false);
            const childCredential = child.json().token;
            expect((await mint(childCredential, { ...childPayload, tokenId: randomUUID() })).statusCode).toBe(403);
            const self = await app.inject({ method: 'GET', url: '/v1/auth/api-tokens/self', headers: bearer(childCredential) });
            expect(self.statusCode, self.body).toBe(200);
            expect(self.json()).toEqual({ accountId: account.id, accountEncryptionMode: 'plain', credentialId: childPayload.tokenId,
                parentTokenId: tokenId, expiresAt, grant, embedConfig: null });
            const list = await app.inject({ method: 'POST', url: ACCOUNT_API_TOKENS_LIST_HTTP_PATH_V1,
                headers: bearer(signed), payload: {} });
            expect(list.json().tokens).toEqual([expect.objectContaining({ tokenId, grant, activeChildCount: 1 })]);
            const edit = (payload: InjectOptions['payload']) => app.inject({ method: 'POST', url: '/v1/auth/api-tokens/update',
                headers: bearer(signed), payload });
            expect((await edit({ tokenId, label: await preparePlainAccountApiTokenLabel(account.id, 'Renamed') })).statusCode).toBe(200);
            expect((await auth.verifyPat(childCredential)).ok).toBe(true);
            const embedConfig = { v: 1, ui: { attachments: false }, newChat: { enabled: false },
                organization: { folderId: null, tagIds: [] }, style: null };
            expect((await edit({ tokenId, embedConfig })).statusCode).toBe(200);
            const afterPresentationEdit = await app.inject({ method: 'GET', url: '/v1/auth/api-tokens/self', headers: bearer(childCredential) });
            expect(afterPresentationEdit.statusCode).toBe(200);
            expect(afterPresentationEdit.json().embedConfig).toEqual(embedConfig);
            expect((await auth.verifyPat(childCredential)).ok).toBe(true);
            expect((await edit({ tokenId, grant: { ...grant, actions: { families: [], ids: ['session.transcript.get'] } } })).statusCode).toBe(200);
            expect((await auth.verifyPat(childCredential)).ok).toBe(false);
            const fresh = await mint(parent, { ...childPayload, tokenId: randomUUID(),
                grant: { ...grant, actions: { families: [], ids: ['session.transcript.get'] } } });
            expect(fresh.statusCode, fresh.body).toBe(200);
            await app.inject({ method: 'POST', url: ACCOUNT_API_TOKENS_REVOKE_HTTP_PATH_V1,
                headers: bearer(signed), payload: { tokenId } });
            expect((await auth.verifyPat(fresh.json().token)).ok).toBe(false);
        } finally {
            await app.close();
        }
    });

    it("attributes only fresh Session rows to a current execution authorization and confines attribution children", async () => {
        harness.resetEnv({ HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' });
        const account = await db.account.create({ data: { publicKey: `creator-${randomUUID()}`, encryptionMode: 'plain' } });
        const other = await db.account.create({ data: { publicKey: `creator-other-${randomUUID()}`, encryptionMode: 'plain' } });
        const signed = await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' });
        const root = await auth.createApiToken({ accountId: account.id, tokenId: randomUUID(), label: await preparePlainAccountApiTokenLabel(account.id, 'Creator') });
        const app = createTestApp();
        await app.ready();
        try {
            const expiresAt = new Date(Date.now() + 60_000).toISOString();
            const mintChild = async (grant = API_TOKEN_FULL_GRANT_V1, extra = {}) => app.inject({ method: 'POST',
                url: '/v1/auth/api-tokens/children/create', headers: bearer(root.token),
                payload: { tokenId: randomUUID(), label: await preparePlainAccountApiTokenLabel(account.id, 'Creator child'), expiresAt, grant, ...extra } });
            const child = await mintChild();
            expect(child.statusCode, child.body).toBe(200);
            const childId = child.json().apiToken.tokenId;
            const machineId = randomUUID();
            await db.machine.create({ data: {
                id: machineId,
                accountId: account.id,
                metadata: '{}',
                installationId: randomUUID(),
            } });
            const authorization = await auth.mintExternalActionExecutionAuthorization({
                serverIdentityId: await getOrCreateServerIdentityId(), accountId: account.id, principalId: account.id,
                credentialId: childId, grant: API_TOKEN_FULL_GRANT_V1, machineId,
                actionId: 'session.spawn_new', requestId: randomUUID(), requestEnvelopeDigest: 'a'.repeat(43),
                target: { kind: 'machine', machineId },
            });
            const rootAuthorization = await auth.mintExternalActionExecutionAuthorization({
                serverIdentityId: await getOrCreateServerIdentityId(), accountId: account.id, principalId: account.id,
                credentialId: root.tokenId, grant: API_TOKEN_FULL_GRANT_V1, machineId,
                actionId: 'session.spawn_new', requestId: randomUUID(), requestEnvelopeDigest: 'b'.repeat(43),
                target: { kind: 'machine', machineId },
            });
            const create = (tag: string, proof?: string, credential = signed) => app.inject({ method: 'POST', url: '/v1/sessions',
                headers: { ...bearer(credential), 'x-happier-account-stored-content-protocol': '2',
                    ...(proof ? { 'x-happier-session-creation-authorization': proof } : {}) },
                payload: { tag, metadataLayoutVersion: 1, sharedMetadata: { ciphertext: '{"v":1}' },
                    ownerMetadata: { t: 'plain', v: { v: 1 } }, encryptionMode: 'plain' } });
            const tag = randomUUID();
            const attributed = await create(tag, authorization.token);
            expect(attributed.statusCode, attributed.body).toBe(200);
            const created = await db.session.findUniqueOrThrow({ where: { accountId_tag: { accountId: account.id, tag } } });
            expect(created.createdByApiTokenId).toBe(childId);
            expect((await create(tag)).statusCode).toBe(200);
            expect((await db.session.findUniqueOrThrow({ where: { id: created.id } })).createdByApiTokenId).toBe(childId);
            const ordinaryTag = randomUUID();
            expect((await create(ordinaryTag)).statusCode).toBe(200);
            const ordinary = await db.session.findUniqueOrThrow({ where: { accountId_tag: { accountId: account.id, tag: ordinaryTag } } });
            expect(ordinary.createdByApiTokenId).toBeNull();
            const rootCreatedTag = randomUUID();
            expect((await create(rootCreatedTag, rootAuthorization.token)).statusCode).toBe(200);
            const rootCreated = await db.session.findUniqueOrThrow({ where: { accountId_tag: {
                accountId: account.id, tag: rootCreatedTag,
            } } });
            expect(rootCreated.createdByApiTokenId).toBeNull();
            const otherSigned = await auth.createToken(other.id, undefined, { kind: 'account', authority: 'present_user' });
            expect((await create(randomUUID(), authorization.token, otherSigned)).statusCode).toBe(401);
            const explicitGrant = { ...API_TOKEN_FULL_GRANT_V1, actions: { families: [], ids: ['session.message.send'] },
                targets: { sessions: [created.id], machines: [] } };
            expect((await mintChild(explicitGrant, { requireCreatedByChildTokenId: childId })).statusCode).toBe(200);
            expect((await mintChild({ ...explicitGrant, targets: { sessions: [ordinary.id], machines: [] } },
                { requireCreatedByChildTokenId: childId })).statusCode).toBe(400);
            const sibling = await mintChild();
            expect((await mintChild(explicitGrant, { requireCreatedByChildTokenId: sibling.json().apiToken.tokenId })).statusCode).toBe(400);
            const revoked = await app.inject({ method: 'POST', url: ACCOUNT_API_TOKENS_REVOKE_HTTP_PATH_V1,
                headers: bearer(signed), payload: { tokenId: root.tokenId } });
            expect(revoked.statusCode, revoked.body).toBe(200);
            expect(revoked.json()).toEqual({ revoked: true });
            expect((await db.session.findUniqueOrThrow({ where: { id: rootCreated.id } })).createdByApiTokenId).toBeNull();
            expect((await auth.verifyPat(root.token)).ok).toBe(false);
            expect((await auth.verifyPat(child.json().token)).ok).toBe(false);
            expect((await create(randomUUID(), authorization.token)).statusCode).toBe(401);
        } finally { await app.close(); }
    });

    it("admits nullable child constraints only when every effective outcome remains within the parent", async () => {
        const account = await db.account.create({ data: { publicKey: `attenuation-${randomUUID()}` } });
        const modelA = { agentTargetKey: 'agent:happier.agent.claude/claude', providerConnectionId: null, modelId: 'a' };
        const modelB = { ...modelA, modelId: 'b' };
        const creation = { machineId: 'M1', agentTargetKey: modelA.agentTargetKey, directory: 'managed',
            placement: { folderId: 'leads', tagIds: ['inbound'] } };
        const spawn = { executionTarget: { serverId: 'home', machineId: 'M1' },
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
            directory: { kind: 'managed' }, organizationPlacement: creation.placement };
        const bounded = ApiTokenGrantV1Schema.parse({ ...API_TOKEN_FULL_GRANT_V1,
            actions: { families: [], ids: ['session.message.send'] }, targets: { sessions: ['S1'], machines: ['M1'] },
            models: [modelA], permissionModes: ['default'], create: creation });
        const requests = [
            ...['M1', 'M2'].map((machineId) => ({ actionId: 'session.spawn_new', target: { kind: 'machine' as const, machineId },
                spawnInput: { ...spawn, executionTarget: { serverId: 'home', machineId } } })),
            ...[{ ...spawn, directory: { kind: 'path', path: '/tmp' } },
                { ...spawn, organizationPlacement: { folderId: 'other', tagIds: ['inbound'] } },
                { ...spawn, organizationPlacement: { folderId: 'leads', tagIds: ['other'] } },
                { ...spawn, agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } }]
                .map((spawnInput) => ({ actionId: 'session.spawn_new', target: { kind: 'machine' as const, machineId: 'M1' }, spawnInput })),
            ...['S1', 'S2'].flatMap((sessionId) => ['session.message.send', 'approval.request.decide']
                .map((actionId) => ({ actionId, target: { kind: 'session' as const, sessionId } }))),
        ];
        const app = createTestApp();
        await app.ready();
        try {
            const cases = (['actions', 'targets', 'models', 'permissionModes', 'create'] as const).flatMap((field) => [
                { parent: ApiTokenGrantV1Schema.parse({ ...API_TOKEN_FULL_GRANT_V1, [field]: bounded[field] }),
                    child: API_TOKEN_FULL_GRANT_V1, accepted: false },
                { parent: API_TOKEN_FULL_GRANT_V1,
                    child: ApiTokenGrantV1Schema.parse({ ...API_TOKEN_FULL_GRANT_V1, [field]: bounded[field] }), accepted: true },
            ]);
            cases.push({ parent: ApiTokenGrantV1Schema.parse({ ...API_TOKEN_FULL_GRANT_V1, create: creation }),
                child: ApiTokenGrantV1Schema.parse({ ...API_TOKEN_FULL_GRANT_V1, actions: bounded.actions }), accepted: true });
            cases.push({ parent: ApiTokenGrantV1Schema.parse({ ...API_TOKEN_FULL_GRANT_V1, create: creation }),
                child: ApiTokenGrantV1Schema.parse({ ...API_TOKEN_FULL_GRANT_V1, create: { ...creation,
                    agentTargetKey: 'agent:happier.agent.codex/codex' } }), accepted: false });
            for (const testCase of cases) {
                const root = await auth.createApiToken({ accountId: account.id, tokenId: randomUUID(), label: await preparePlainAccountApiTokenLabel(account.id, 'Parent'), grant: testCase.parent });
                const response = await app.inject({ method: 'POST', url: '/v1/auth/api-tokens/children/create', headers: bearer(root.token),
                    payload: { tokenId: randomUUID(), label: await preparePlainAccountApiTokenLabel(account.id, 'Child'), expiresAt: new Date(Date.now() + 60_000).toISOString(), grant: testCase.child } });
                expect(response.statusCode, response.body).toBe(testCase.accepted ? 200 : 400);
                if (!testCase.accepted) continue;
                expect(response.json().apiToken.grant).toEqual(testCase.child);
                for (const request of requests) if (evaluateApiTokenGrantV1({ ...request, grant: testCase.child }).ok) {
                    expect(evaluateApiTokenGrantV1({ ...request, grant: testCase.parent }).ok).toBe(true);
                }
                for (const ref of [modelA, modelB, 'automatic'] as const) if (isModelRefGrantedV1(testCase.child, ref)) {
                    expect(isModelRefGrantedV1(testCase.parent, ref)).toBe(true);
                }
                for (const mode of ['default', 'bypassPermissions'] as const) if (isPermissionModeGrantedV1(testCase.child, mode)) {
                    expect(isPermissionModeGrantedV1(testCase.parent, mode)).toBe(true);
                }
            }
        } finally { await app.close(); }
    });

    it("lists exact child-token summaries only on request and never crosses the authenticated Account", async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID() } });
        const foreignAccount = await db.account.create({ data: { publicKey: randomUUID() } });
        const signed = await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' });
        const root = await auth.createApiToken({ accountId: account.id, tokenId: randomUUID(), label: await preparePlainAccountApiTokenLabel(account.id, 'CI root') });
        await auth.createApiToken({ accountId: foreignAccount.id, tokenId: randomUUID(), label: await preparePlainAccountApiTokenLabel(foreignAccount.id, 'Foreign CI') });
        const verified = await auth.verifyToken(root.token);
        if (!verified?.apiTokenPrincipal) throw new Error('Expected verified root API-token principal');
        const child = await auth.createChildApiToken({ principal: verified.apiTokenPrincipal,
            tokenId: randomUUID(), label: await preparePlainAccountApiTokenLabel(verified.apiTokenPrincipal.accountId, 'CI child'), expiresAt: new Date(Date.now() + 3_600_000),
            grant: API_TOKEN_FULL_GRANT_V1 });
        const app = createTestApp();
        await app.ready();
        try {
            const defaults = await app.inject({ method: 'POST', url: ACCOUNT_API_TOKENS_LIST_HTTP_PATH_V1,
                headers: bearer(signed), payload: {} });
            expect(defaults.statusCode).toBe(200);
            expect(AccountApiTokensListActionOutputV1Schema.parse(defaults.json()).tokens.map(row => row.tokenId)).toEqual([root.tokenId]);
            const all = await app.inject({ method: 'POST', url: ACCOUNT_API_TOKENS_LIST_HTTP_PATH_V1,
                headers: bearer(signed), payload: { includeChildren: true } });
            expect(all.statusCode, all.body).toBe(200);
            const listed = AccountApiTokensListActionOutputV1Schema.parse(all.json());
            expect(listed.tokens).toEqual(expect.arrayContaining([
                expect.objectContaining({ tokenId: root.tokenId, parentTokenId: null, activeChildCount: 1 }),
                expect.objectContaining({ tokenId: child.tokenId, parentTokenId: root.tokenId,
                    grant: child.grant, activeChildCount: 0 }),
            ]));
            expect(listed.tokens).toHaveLength(2);
            const foreign = await app.inject({ method: 'POST', url: ACCOUNT_API_TOKENS_LIST_HTTP_PATH_V1,
                headers: bearer(signed), payload: { includeChildren: true, accountId: foreignAccount.id } });
            expect(foreign.statusCode).toBe(400);
        } finally { await app.close(); }
    });

    it("renews a child's own evidence without permitting child configuration, self approval or foreign Account updates", async () => {
        const account = await db.account.create({ data: { ...createSignedAccountContentBinding(), encryptionMode: "e2ee" } });
        const foreignAccount = await db.account.create({ data: { ...createSignedAccountContentBinding(), encryptionMode: "e2ee" } });
        const evidence = [{ kind: 'home_method' as const, methodId: 'key_challenge' as const }];
        const signed = await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user', authenticationEvidence: evidence });
        const foreignSigned = await auth.createToken(foreignAccount.id, undefined,
            { kind: 'account', authority: 'present_user', authenticationEvidence: evidence });
        const rootTokenId = randomUUID();
        const childTokenId = randomUUID();
        const root = await auth.createApiToken({ accountId: account.id, tokenId: rootTokenId, label: await prepareE2eeAccountApiTokenLabel(account.id, rootTokenId, 'CI root') });
        const principal = (await auth.verifyToken(root.token))?.apiTokenPrincipal;
        if (!principal) throw new Error('Expected verified root API-token principal');
        const child = await auth.createChildApiToken({ principal, tokenId: childTokenId, label: await prepareE2eeAccountApiTokenLabel(principal.accountId, childTokenId, 'CI child'),
            expiresAt: new Date(Date.now() + 3_600_000), grant: API_TOKEN_FULL_GRANT_V1 });
        const app = createTestApp();
        await app.ready();
        try {
            const input = { tokenId: child.tokenId, authorizeUnattendedTeamAccess: true };
            for (const patch of [{ label: await prepareE2eeAccountApiTokenLabel(account.id, childTokenId, 'Changed') }, { grant: API_TOKEN_FULL_GRANT_V1 }, { embedConfig: null }, { deployment: null }]) {
                const mixed = await app.inject({ method: 'POST', url: ACCOUNT_API_TOKENS_UPDATE_HTTP_PATH_V1,
                    headers: bearer(signed), payload: { ...input, ...patch } });
                expect(mixed.statusCode).toBe(401);
            }
            const orphanConsent = await app.inject({ method: 'POST', url: ACCOUNT_API_TOKENS_UPDATE_HTTP_PATH_V1,
                headers: bearer(signed), payload: { ...input, deploymentConsent: null } });
            expect(orphanConsent.statusCode).toBe(400);
            for (const rejected of [foreignSigned, child.token]) {
                const response = await app.inject({ method: 'POST', url: ACCOUNT_API_TOKENS_UPDATE_HTTP_PATH_V1,
                    headers: bearer(rejected), payload: input });
                expect(response.statusCode).toBe(rejected === foreignSigned ? 401 : 403);
            }
            const renewed = await app.inject({ method: 'POST', url: ACCOUNT_API_TOKENS_UPDATE_HTTP_PATH_V1,
                headers: bearer(signed), payload: input });
            expect(renewed.statusCode, renewed.body).toBe(200);
            expect(renewed.json().apiToken).toMatchObject({ tokenId: child.tokenId, parentTokenId: root.tokenId,
                hasUnattendedTeamAccess: true, grant: child.grant, label: child.label });
            expect((await auth.verifyToken(child.token))?.authenticationEvidence).toEqual(evidence);
            expect((await auth.verifyToken(root.token))?.authenticationEvidence ?? []).toEqual([]);
        } finally { await app.close(); }
    });

    it("reapproves an existing token from current person evidence and preserves its bearer and grant", async () => {
        const account = await db.account.create({ data: { ...createSignedAccountContentBinding(), encryptionMode: "e2ee" } });
        const signed = await auth.createToken(account.id, undefined, { kind: "account", authority: "present_user",
            authenticationEvidence: [{ kind: 'home_method', methodId: 'key_challenge' }] });
        const withoutEvidence = await auth.createToken(account.id, undefined, { kind: "account", authority: "present_user" });
        const rootTokenId = randomUUID();
        const childTokenId = randomUUID();
        const unrelatedTokenId = randomUUID();
        const token = await auth.createApiToken({ accountId: account.id, tokenId: rootTokenId, label: await prepareE2eeAccountApiTokenLabel(account.id, rootTokenId, "Deploy from CI") });
        const principal = (await auth.verifyToken(token.token))?.apiTokenPrincipal;
        if (!principal) throw new Error('Expected verified root API-token principal');
        const child = await auth.createChildApiToken({ principal, tokenId: childTokenId, label: await prepareE2eeAccountApiTokenLabel(principal.accountId, childTokenId, 'Independent CI child'),
            expiresAt: new Date(Date.now() + 3_600_000), grant: API_TOKEN_FULL_GRANT_V1 });
        await auth.createApiToken({ accountId: account.id, tokenId: unrelatedTokenId, label: await prepareE2eeAccountApiTokenLabel(account.id, unrelatedTokenId, 'Unrelated token') });
        const tokenCount = await db.accountApiToken.count({ where: { accountId: account.id } });
        const app = createTestApp();
        const disconnected: string[][] = [];
        app.disconnectApiTokenSockets = tokenIds => { disconnected.push([...tokenIds]); };
        await app.ready();
        try {
            let inventoryReads = 0;
            const stopObserving = observeSqliteRequests({ before: query => {
                if (query.model !== 'AccountApiToken' || query.action !== 'findMany') return;
                const args = query.args;
                const where = args && typeof args === 'object' && 'where' in args ? args.where : null;
                if (!where || typeof where !== 'object' || !('id' in where) || where.id !== token.tokenId) inventoryReads++;
            } });
            try {
                const edited = await app.inject({ method: 'POST', url: ACCOUNT_API_TOKENS_UPDATE_HTTP_PATH_V1,
                    headers: bearer(signed), payload: { tokenId: token.tokenId, label: await prepareE2eeAccountApiTokenLabel(account.id, rootTokenId, "Deploy from CI") } });
                expect(edited.statusCode, edited.body).toBe(200);
                expect(edited.json().apiToken.tokenId).toBe(token.tokenId);
            } finally { stopObserving(); }
            expect(inventoryReads).toBe(0);
            const payload = { tokenId: token.tokenId, authorizeUnattendedTeamAccess: true };
            const denied = await app.inject({ method: "POST", url: ACCOUNT_API_TOKENS_UPDATE_HTTP_PATH_V1,
                headers: bearer(withoutEvidence), payload });
            expect(denied.statusCode).toBe(409);
            expect(denied.json()).toEqual({ error: "credential_authentication_evidence_unavailable" });
            expect((await auth.verifyToken(token.token))?.authenticationEvidence ?? []).toEqual([]);
            expect(disconnected).toEqual([]);
            const updated = await app.inject({ method: "POST", url: ACCOUNT_API_TOKENS_UPDATE_HTTP_PATH_V1,
                headers: bearer(signed), payload });
            expect(updated.statusCode, updated.body).toBe(200);
            expect(updated.json().apiToken).toMatchObject({ tokenId: token.tokenId,
                grant: token.grant, hasUnattendedTeamAccess: true });
            expect(updated.json()).not.toHaveProperty('token');
            expect(await db.accountApiToken.count({ where: { accountId: account.id } })).toBe(tokenCount);
            expect(disconnected).toEqual([[token.tokenId]]);
            expect((await auth.verifyToken(token.token))?.authenticationEvidence).toEqual([
                { kind: 'home_method', methodId: 'key_challenge' },
            ]);
            expect((await auth.verifyToken(child.token))?.authenticationEvidence ?? []).toEqual([]);
            const repeated = await app.inject({ method: "POST", url: ACCOUNT_API_TOKENS_UPDATE_HTTP_PATH_V1,
                headers: bearer(signed), payload });
            expect(repeated.statusCode).toBe(200);
            expect(disconnected).toEqual([[token.tokenId]]);
            const delegated = await app.inject({ method: "POST", url: ACCOUNT_API_TOKENS_UPDATE_HTTP_PATH_V1,
                headers: bearer(token.token), payload });
            expect(delegated.statusCode).toBe(403);
            const stored = await db.accountApiToken.findUniqueOrThrow({ where: { id: token.tokenId } });
            await db.account.update({ where: { id: account.id }, data: { publicKey: null } });
            const stale = await app.inject({ method: "POST", url: ACCOUNT_API_TOKENS_UPDATE_HTTP_PATH_V1,
                headers: bearer(signed), payload });
            expect(stale.statusCode).toBe(409);
            expect(stale.json()).toEqual({ error: "credential_authentication_evidence_unavailable" });
            expect(await db.accountApiToken.findUniqueOrThrow({ where: { id: token.tokenId } })).toEqual(stored);
            expect(disconnected).toEqual([[token.tokenId]]);
        } finally { await app.close(); }
    });

    it("rejects explicit unattended delegation when the initiating credential has no evidence", async () => {
        const account = await db.account.create({ data: { publicKey: `pat-no-evidence-${Date.now()}` } });
        const signed = await auth.createToken(account.id, undefined, { kind: "account", authority: "present_user" });
        const app = createTestApp();
        await app.ready();
        const response = await app.inject({
            method: "POST",
            url: ACCOUNT_API_TOKENS_CREATE_HTTP_PATH_V1,
            headers: bearer(signed),
            payload: { tokenId: randomUUID(), label: await preparePlainAccountApiTokenLabel(account.id, "Must not silently downgrade"), authorizeUnattendedTeamAccess: true },
        });
        expect(response.statusCode, response.body).toBe(409);
        expect(response.json()).toEqual({ error: "credential_authentication_evidence_unavailable" });
        expect(await db.accountApiToken.count({ where: { accountId: account.id } })).toBe(0);
        await app.close();
    });

    it("atomically issues sealed access, keeps V1 exact, retrieves only PAT-self and rejects stale bindings", async () => {
        const signing = tweetnacl.sign.keyPair();
        const content = tweetnacl.box.keyPair();
        const account = await db.account.create({ data: {
            publicKey: Buffer.from(signing.publicKey).toString('hex'), encryptionMode: 'e2ee',
            contentPublicKey: new Uint8Array(content.publicKey),
            contentPublicKeySig: new Uint8Array(signAccountContentKeyBindingV1({
                accountSigningSecretKey: signing.secretKey,
                contentPublicKey: content.publicKey,
            })),
        } });
        const tokenId = randomUUID();
        const encryptionAccess = { v: 1, serverIdentityId: await getOrCreateServerIdentityId(),
            contentPublicKey: privacyKit.encodeBase64(new Uint8Array(content.publicKey)),
            wrappedContentPrivateKey: privacyKit.encodeBase64(new Uint8Array(72).fill(7), "base64url") };
        const signed = await auth.createToken(account.id, undefined, {
            kind: 'account',
            authority: 'present_user',
            authenticationEvidence: [{ kind: 'home_method', methodId: 'key_challenge' }],
        });
        const app = createTestApp();
        const tokenLabel = await prepareE2eeAccountApiTokenLabel(account.id, tokenId, "Encrypted SDK");
        await app.ready();
        try {
            const create = () => app.inject({
                method: "POST",
                url: ACCOUNT_API_TOKENS_CREATE_HTTP_PATH_V1,
                headers: bearer(signed),
                payload: {
                    tokenId,
                    label: tokenLabel,
                    authorizeUnattendedTeamAccess: true,
                    encryption: { access: encryptionAccess },
                },
            });
            const created = await create();
            expect(created.statusCode).toBe(200);
            const body = created.json();
            expect(body.apiToken.tokenId).toBe(tokenId);
            expect(body.apiToken.hasEncryptionAccess).toBe(true);
            expect(body.apiToken.hasUnattendedTeamAccess).toBe(true);
            const reapproved = await app.inject({ method: "POST", url: ACCOUNT_API_TOKENS_UPDATE_HTTP_PATH_V1,
                headers: bearer(signed), payload: { tokenId, authorizeUnattendedTeamAccess: true } });
            expect(reapproved.statusCode, reapproved.body).toBe(200);
            expect(reapproved.json().apiToken).toMatchObject({ tokenId, hasEncryptionAccess: true,
                hasUnattendedTeamAccess: true, grant: body.apiToken.grant });
            expect(reapproved.json()).not.toHaveProperty('token');
            expect((await auth.verifyToken(body.token))?.authenticationEvidence).toEqual([
                { kind: 'home_method', methodId: 'key_challenge' },
            ]);
            expect(body.token).toMatch(new RegExp(`^hap_v1_${tokenId}_`));
            const conflict = await create();
            expect(conflict.statusCode).toBe(409);
            expect(conflict.json()).toEqual({ error: 'api_token_id_conflict' });
            expect(await db.accountApiToken.count({ where: { accountId: account.id, id: tokenId } })).toBe(1);
            const list = await app.inject({ method: "POST", url: ACCOUNT_API_TOKENS_LIST_HTTP_PATH_V1, headers: bearer(signed), payload: {} });
            expect(list.json()).toEqual({
                tokens: [{
                    ...body.apiToken,
                    // The preceding PAT verification is a real admitted use and
                    // the canonical token owner records it before list projection.
                    lastUsedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
                }],
            });
            expect((await app.inject({ method: "POST", url: "/v2/auth/api-tokens/create", headers: bearer(signed), payload: { label: "Removed" } })).statusCode).toBe(404);
            expect((await app.inject({ method: "POST", url: `${ACCOUNT_API_TOKENS_LIST_HTTP_PATH_V1}?projectionVersion=2`, headers: bearer(signed), payload: {} })).statusCode).toBe(400);
            for (const payload of [
                { tokenId: randomUUID(), label: "Partial token", encryption: {} },
                { label: "Missing token selector", encryption: { access: encryptionAccess } },
                {
                    tokenId: randomUUID(),
                    label: "Caller-supplied evidence",
                    authenticationEvidence: [{ kind: "home_method", methodId: "key_challenge" }],
                },
            ]) {
                const partial = await app.inject({ method: "POST", url: ACCOUNT_API_TOKENS_CREATE_HTTP_PATH_V1, headers: bearer(signed), payload });
                expect(partial.statusCode).toBe(400);
                expect(partial.json()).toEqual({ error: "invalid_request" });
            }
            const fetch = (token: string, payload = {}) => app.inject({ method: "POST", url: ACCOUNT_API_TOKEN_ENCRYPTION_ACCESS_HTTP_PATH_V1, headers: bearer(token), payload });
            expect((await fetch(body.token)).json()).toEqual({ v: 1, accountId: account.id, tokenId, encryptionAccess });
            expect((await app.inject({ method: "POST", url: ACCOUNT_API_TOKEN_ENCRYPTION_ACCESS_HTTP_PATH_V1, payload: {} })).statusCode).toBe(401);
            expect((await fetch(signed)).json()).toEqual({ error: 'api_token_required' });
            expect((await fetch(body.token, { tokenId: randomUUID() })).statusCode).toBe(400);
            const ordinaryTokenId = randomUUID();
            const ordinary = await auth.createApiToken({ accountId: account.id, tokenId: ordinaryTokenId,
                label: await prepareE2eeAccountApiTokenLabel(account.id, ordinaryTokenId, 'Ordinary') });
            const listed = await app.inject({ method: "POST", url: ACCOUNT_API_TOKENS_LIST_HTTP_PATH_V1, headers: bearer(signed), payload: {} });
            expect(listed.json()).toEqual({
                tokens: [
                    expect.objectContaining({ tokenId: ordinary.tokenId, hasEncryptionAccess: false }),
                    expect.objectContaining({ tokenId, hasEncryptionAccess: true }),
                ],
            });
            expect((await fetch(ordinary.token)).json()).toEqual({ error: 'api_token_encryption_unavailable' });
            const crossAccount = await db.account.create({ data: { publicKey: 'other-api-token-account' } });
            const crossToken = await auth.createApiToken({ accountId: crossAccount.id, tokenId: randomUUID(), label: await preparePlainAccountApiTokenLabel(crossAccount.id, 'Other Account') });
            expect((await fetch(crossToken.token)).json()).toEqual({ error: 'api_token_encryption_unavailable' });
            await auth.signOutEverywhere(account.id);
            expect((await fetch(body.token)).statusCode).toBe(200);
            await db.accountApiToken.update({ where: { id: tokenId }, data: { expiresAt: new Date(0) } });
            expect((await fetch(body.token)).statusCode).toBe(401);
            await db.accountApiToken.update({ where: { id: tokenId }, data: { expiresAt: null } });
            await db.account.update({ where: { id: account.id }, data: { encryptionMode: 'plain' } });
            expect((await fetch(body.token)).json()).toEqual({ error: 'api_token_encryption_stale' });
            await auth.revokeApiToken({ accountId: account.id, tokenId });
            expect((await fetch(body.token)).statusCode).toBe(401);
            await db.account.update({ where: { id: account.id }, data: { encryptionMode: 'e2ee' } });
            const racingEncryptedTokenId = randomUUID();
            const racingOrdinaryTokenId = randomUUID();
            const races = await Promise.allSettled([
                auth.createApiToken({ accountId: account.id, tokenId: racingEncryptedTokenId,
                    label: await prepareE2eeAccountApiTokenLabel(account.id, racingEncryptedTokenId, 'Racing encrypted'), encryption: {
                    access: { ...encryptionAccess, v: 1 },
                } }),
                auth.createApiToken({ accountId: account.id, tokenId: racingOrdinaryTokenId,
                    label: await prepareE2eeAccountApiTokenLabel(account.id, racingOrdinaryTokenId, 'Racing ordinary') }),
                inTx((tx) => setAccountStatusInTx(tx, { actorAccountId: account.id, targetAccountId: account.id, status: 'disabled', authority: 'account_erasure' })),
            ]);
            expect(races[2]?.status).toBe('fulfilled');
            for (const result of races.slice(0, 2)) {
                if (result.status === 'rejected') expect(result.reason).toMatchObject({ code: 'account-disabled' });
            }
            expect(await auth.listApiTokens(account.id)).toEqual([]);
        } finally { await app.close(); }
    });

    it("never repairs missing E2EE bindings or creates encryption access for Plain Accounts", async () => {
        const signing = tweetnacl.sign.keyPair();
        const access = { v: 1 as const, serverIdentityId: await getOrCreateServerIdentityId(),
            contentPublicKey: privacyKit.encodeBase64(new Uint8Array(tweetnacl.box.keyPair().publicKey)),
            wrappedContentPrivateKey: privacyKit.encodeBase64(new Uint8Array(72), "base64url") };
        for (const encryptionMode of ['plain', 'e2ee']) {
            const account = await db.account.create({ data: { encryptionMode,
                publicKey: encryptionMode === 'plain' ? null : Buffer.from(signing.publicKey).toString('hex') } });
            await expect(auth.createApiToken({ accountId: account.id, tokenId: randomUUID(), label: plainPrivateLabel('Unavailable'),
                encryption: { access } })).rejects.toMatchObject({
                code: encryptionMode === 'plain' ? 'api_token_encryption_not_ready' : 'api_token_label_mode_mismatch',
            });
            expect(await db.accountApiToken.count({ where: { accountId: account.id } })).toBe(0);
            expect(await db.account.findUnique({ where: { id: account.id }, select: { contentPublicKey: true, contentPublicKeySig: true } })).toEqual({ contentPublicKey: null, contentPublicKeySig: null });
        }
    });

    it("refuses a mint that was waiting behind a committed Account disable fence", async () => {
        const account = await db.account.create({ data: { publicKey: 'waiting-api-token' } });
        const label = await preparePlainAccountApiTokenLabel(account.id, 'Waiting');
        let releaseFence!: () => void;
        let signalFence!: () => void;
        const held = new Promise<void>((resolve) => { signalFence = resolve; });
        const release = new Promise<void>((resolve) => { releaseFence = resolve; });
        const disabling = inTx(async (tx) => {
            await acquireAccountSessionOwnerMetadataFenceInTx(tx, account.id, "exclusive");
            await setAccountStatusInTx(tx, { actorAccountId: account.id, targetAccountId: account.id, status: 'disabled', authority: 'account_erasure' });
            signalFence();
            await release;
        });
        await held;
        const minting = auth.createApiToken({ accountId: account.id, tokenId: randomUUID(), label });
        releaseFence();
        await disabling;
        await expect(minting).rejects.toMatchObject({ code: 'account-disabled' });
        expect(await db.accountApiToken.count({ where: { accountId: account.id } })).toBe(0);
    });

    it("Disable deletes PATs and refuses late issuance; Re-enable cannot resurrect them", async () => {
        const owner = await db.account.create({ data: { homeRole: 'owner' } });
        const account = await db.account.create({ data: { publicKey: 'disable-api-token' } });
        const minted = await auth.createApiToken({ accountId: account.id, tokenId: randomUUID(), label: await preparePlainAccountApiTokenLabel(account.id, 'Before disable') });
        await inTx((tx) => setAccountStatusInTx(tx, { actorAccountId: owner.id, targetAccountId: account.id, status: 'suspended', authority: 'home_administration' }));
        expect(await auth.listApiTokens(account.id)).toEqual([]);
        await expect(auth.createApiToken({ accountId: account.id, tokenId: randomUUID(), label: await preparePlainAccountApiTokenLabel(account.id, 'Late mint') })).rejects.toThrow();
        await inTx((tx) => setAccountStatusInTx(tx, { actorAccountId: owner.id, targetAccountId: account.id, status: 'active', authority: 'home_administration' }));
        expect(await auth.verifyPat(minted.token)).toEqual({ ok: false, reason: 'invalid_token' });
    });

    it("creates a one-time bearer, permits terminal list, and rejects PATs on every direct management route", async () => {
        const account = await db.account.create({
            data: { publicKey: "api-token-management-owner" },
            select: { id: true },
        });
        const signedToken = await auth.createToken(account.id, undefined, { kind: "account", authority: "present_user" });
        const app = createTestApp();
        await app.ready();

        try {
            const requestedTokenId = randomUUID();
            const created = await app.inject({
                method: "POST",
                url: ACCOUNT_API_TOKENS_CREATE_HTTP_PATH_V1,
                headers: bearer(signedToken),
                payload: { tokenId: requestedTokenId, label: await preparePlainAccountApiTokenLabel(account.id, "CI deploy"), expiresAt: "2030-08-22T12:00:00.000Z" },
            });

            expect(created.statusCode).toBe(200);
            const createdBody = created.json();
            expect(createdBody).toEqual({
                token: expect.stringMatching(/^hap_v1_[0-9a-f-]{36}_[A-Za-z0-9_-]{43}$/u),
                apiToken: {
                    tokenId: requestedTokenId,
                    label: { content: { t: "plain", v: "CI deploy" }, recipientEnvelope: null },
                    displayPrefix: expect.stringMatching(/^hap_v1_[0-9a-f]{8}$/u),
                    createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
                    lastUsedAt: null,
                    expiresAt: "2030-08-22T12:00:00.000Z",
                    hasEncryptionAccess: false,
                    hasUnattendedTeamAccess: false,
                    grant: API_TOKEN_FULL_GRANT_V1,
                    parentTokenId: null,
                    activeChildCount: 0,
                    embedConfig: null,
                },
            });

            const signedList = await app.inject({
                method: "POST",
                url: ACCOUNT_API_TOKENS_LIST_HTTP_PATH_V1,
                headers: bearer(signedToken),
                payload: {},
            });
            expect(signedList.statusCode).toBe(200);
            expect(signedList.json()).toEqual({ tokens: [createdBody.apiToken] });
            expect(signedList.body).not.toContain(createdBody.token);
            const parsedBearer = parseAccountApiTokenBearerV1(createdBody.token);
            expect(parsedBearer).not.toBeNull();
            expect(signedList.body).not.toContain(parsedBearer!.secret);

            const [createWithPat, listWithPat, revokeWithPat, revokeAllWithPat] = await Promise.all([
                app.inject({
                    method: "POST",
                    url: ACCOUNT_API_TOKENS_CREATE_HTTP_PATH_V1,
                    headers: bearer(createdBody.token),
                    payload: { tokenId: randomUUID(), label: await preparePlainAccountApiTokenLabel(account.id, "forbidden replacement") },
                }),
                app.inject({
                    method: "POST",
                    url: ACCOUNT_API_TOKENS_LIST_HTTP_PATH_V1,
                    headers: bearer(createdBody.token),
                    payload: {},
                }),
                app.inject({
                    method: "POST",
                    url: ACCOUNT_API_TOKENS_REVOKE_HTTP_PATH_V1,
                    headers: bearer(createdBody.token),
                    payload: { tokenId: createdBody.apiToken.tokenId },
                }),
                app.inject({
                    method: "POST",
                    url: ACCOUNT_API_TOKENS_REVOKE_ALL_HTTP_PATH_V1,
                    headers: bearer(createdBody.token),
                    payload: {},
                }),
            ]);

            for (const response of [createWithPat, listWithPat, revokeWithPat, revokeAllWithPat]) {
                expect(response.statusCode).toBe(403);
                expect(response.json()).toEqual({ error: "present_user_required" });
            }

            const terminalToken = await auth.createToken(account.id, { session: "api-token-management-terminal" }, { kind: "terminal", authority: "account_automation" });
            const terminalList = await app.inject({
                method: "POST",
                url: ACCOUNT_API_TOKENS_LIST_HTTP_PATH_V1,
                headers: bearer(terminalToken),
                payload: {},
            });
            expect(terminalList.statusCode).toBe(200);
            expect(terminalList.json()).toEqual({
                tokens: [{
                    ...createdBody.apiToken,
                    // Authentication must inspect a PAT before the shared
                    // direct-route deny applies, so the denied attempt can
                    // legitimately advance this activity projection.
                    lastUsedAt: expect.any(String),
                }],
            });
        } finally {
            await app.close();
        }
    });

    it("revokes a PAT through the current-Account route and rejects a past expiry as an invalid request", async () => {
        const account = await db.account.create({
            data: { publicKey: "api-token-management-revocation" },
            select: { id: true },
        });
        const signedToken = await auth.createToken(account.id, undefined, { kind: "account", authority: "present_user" });
        const app = createTestApp();
        await app.ready();

        try {
            const created = await app.inject({
                method: "POST",
                url: ACCOUNT_API_TOKENS_CREATE_HTTP_PATH_V1,
                headers: bearer(signedToken),
                payload: { tokenId: randomUUID(), label: await preparePlainAccountApiTokenLabel(account.id, "Revocable") },
            });
            expect(created.statusCode).toBe(200);
            const createdBody = created.json();

            expect(await auth.verifyToken(createdBody.token)).toMatchObject({
                userId: account.id,
                authTokenKind: "api_token",
                authority: "account_automation",
            });

            const revoked = await app.inject({
                method: "POST",
                url: ACCOUNT_API_TOKENS_REVOKE_HTTP_PATH_V1,
                headers: bearer(signedToken),
                payload: { tokenId: createdBody.apiToken.tokenId },
            });
            expect(revoked.statusCode).toBe(200);
            expect(revoked.json()).toEqual({ revoked: true });

            expect(await auth.verifyToken(createdBody.token)).toBeNull();

            const expired = await app.inject({
                method: "POST",
                url: ACCOUNT_API_TOKENS_CREATE_HTTP_PATH_V1,
                headers: bearer(signedToken),
                payload: { tokenId: randomUUID(), label: await preparePlainAccountApiTokenLabel(account.id, "already expired"), expiresAt: "2020-08-22T12:00:00.000Z" },
            });
            expect(expired.statusCode).toBe(400);
            expect(expired.json()).toEqual({ error: "invalid_request" });
        } finally {
            await app.close();
        }
    });
});
