import { randomUUID } from 'node:crypto';
import { decodeBase64 } from 'privacy-kit';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/storage/artifactStoredContent';
import { parseSessionFollowActionResponse, resolveSessionFollowActionRequest } from '@happier-dev/protocol/sessions/follow/actionTransport';
import { normalizeAccountFollowNotificationChoiceV1 } from '@happier-dev/protocol/sessions/follow/accountFollow';
import Fastify, { type FastifyRequest } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FollowDeliveryMuteScopeV1 } from '@happier-dev/protocol/sessions/follow/sessionDeliveryMuteV1';

import type { Fastify as AppFastify } from '@/app/api/types';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { sessionRoutes } from './sessionRoutes';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import tweetnacl from 'tweetnacl';
import { VerifiedEphemeralSessionRunnerPrincipalSchema, type VerifiedEphemeralSessionRunnerPrincipal } from '@happier-dev/protocol/ephemeralRunner/principal';
import { openSessionFollowRuleContentV1, sealSessionFollowRuleContentV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowRuleContentCodecV1';
import { buildSessionFollowRulePhysicalKeyV1,
    SessionFollowRuleDefinitionV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowRuleV1';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { API_TOKEN_FULL_GRANT_V1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import { auth } from '@/app/auth/auth';
import { createAuthenticatedTestApp } from '../../testkit/sqliteFastify';
import { sourceKeyForSessionFollowSourceV1 } from '@/app/session/follow/sessionFollowSourceIdentity';
import { resolveAccountVoiceSelection } from '@/app/session/follow/accountFollowService';

async function buildApp(accountId: string, sessionRuntimePrincipal?: VerifiedEphemeralSessionRunnerPrincipal) {
    const app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate('authenticate', async (request: FastifyRequest) => {
        request.userId = accountId;
        request.authAuthority = 'present_user';
        if (sessionRuntimePrincipal) request.sessionRuntimePrincipal = sessionRuntimePrincipal;
    });
    sessionRoutes(app as AppFastify);
    await app.ready();
    return app;
}

describe('Account Session Follow HTTP resource', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-account-follow-', initAuth: true, initEncrypt: true,
            env: { HAPPIER_FEATURE_SESSIONS_FOLLOWING__ENABLED: 'true' } });
    }, 180_000);
    afterEach(async () => {
        harness.restoreEnv();
        await db.sessionGrant.deleteMany({ where: { principalKind: 'account' } });
        await db.session.deleteMany();
        await db.account.deleteMany();
    });
    afterAll(async () => { await harness?.close(); });

    it('selects source-Session Follows through the canonical generated transport and real list route', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const ids = [randomUUID(), randomUUID()];
        await db.session.createMany({ data: ids.map(id => ({ id, accountId: owner.id, tag: id, metadata: '{}', encryptionMode: 'plain' })) });
        await db.accountSessionFollow.createMany({ data: ids.map(sessionId => ({ accountId: owner.id, sessionId })) });
        const source = { kind: 'session' as const, sessionId: ids[0]! };
        const request = { direction: 'following' as const, receiver: { kind: 'account' as const }, source, limit: 1 };
        const app = await buildApp(owner.id);
        try {
            const response = await app.inject({ method: 'GET', url: resolveSessionFollowActionRequest('follow.list', request).path });
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json()).toMatchObject({ follows: [expect.objectContaining({ sessionId: source.sessionId })] });
            expect(response.json().follows).toHaveLength(1);
            const malformed = new URL('/v2/account/session-follows', 'https://home.test');
            malformed.searchParams.set('source', JSON.stringify({ ...source, accountId: owner.id }));
            expect((await app.inject({ method: 'GET', url: malformed.pathname + malformed.search })).statusCode).toBe(400);
        } finally { await app.close(); }
    });

    it('selects Run kinds through the generated transport and real list query before pagination', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const sessionIds = Array.from({ length: 1_000 }, () => randomUUID());
        await db.session.createMany({ data: sessionIds.map(id => ({ id, accountId: owner.id, tag: id, metadata: '{}', encryptionMode: 'plain' })) });
        await db.accountSessionFollow.createMany({ data: sessionIds.map(sessionId => ({ accountId: owner.id, sessionId })) });
        const source = { kind: 'execution_run' as const, sessionId: sessionIds[0]!, runId: 'selected-run' };
        await db.accountSessionFollow.create({ data: { accountId: owner.id, sourceKey: sourceKeyForSessionFollowSourceV1(source),
            sourceExecutionRunSessionId: source.sessionId, sourceExecutionRunId: source.runId, following: true, followPolicy: '{"preset":"important"}' } });
        const request = { direction: 'following' as const, receiver: { kind: 'account' as const }, sourceKinds: ['execution_run'], limit: 1 };
        const app = await buildApp(owner.id);
        try {
            const response = await app.inject({ method: 'GET', url: resolveSessionFollowActionRequest('follow.list', request).path });
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json()).toEqual({ follows: [expect.objectContaining({ source })] });
            const workflow = await db.automationRun.create({ data: { accountId: owner.id, originKind: 'direct',
                automationId: null, causeKind: null, causeOccurredAt: null, workflowAcceptedSnapshotEnvelope: '{}',
                state: 'running', workflowCustodyState: 'pending', scheduledAt: new Date(), dueAt: new Date(), revision: 1 } });
            const workflowSource = { kind: 'workflow_run' as const, runId: workflow.id };
            await db.accountSessionFollow.create({ data: { accountId: owner.id, sourceKey: sourceKeyForSessionFollowSourceV1(workflowSource),
                sourceWorkflowRunId: workflow.id, following: true, followPolicy: '{"preset":"important"}' } });
            const bothKinds = { ...request, sourceKinds: ['execution_run', 'workflow_run'] };
            const first = await app.inject({ method: 'GET', url: resolveSessionFollowActionRequest('follow.list', bothKinds).path });
            expect(first.statusCode, first.body).toBe(200);
            expect(first.json()).toEqual({ follows: [expect.objectContaining({ source })], continuation: expect.any(String) });
            const next = await app.inject({ method: 'GET', url: resolveSessionFollowActionRequest('follow.list', {
                ...bothKinds, sourceKinds: ['workflow_run', 'execution_run', 'execution_run'], cursor: first.json().continuation,
            }).path });
            expect(next.statusCode, next.body).toBe(200);
            expect(next.json()).toEqual({ follows: [expect.objectContaining({ source: workflowSource })] });
            console.info('FOLLOW_KIND_ROUTE', { unrelatedFollows: sessionIds.length, selectedPages: 2,
                transferredRows: first.json().follows.length + next.json().follows.length });
            expect((await app.inject({ method: 'GET', url: '/v2/account/session-follows?sourceKinds=%5B%22rule%22%5D' })).statusCode).toBe(400);
        } finally { await app.close(); }
    });

    it('keeps a Discussion personal Follow on the Account Follow owner', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const other = await db.account.create({ data: { encryptionMode: 'plain' } });
        const discussion = await db.discussion.create({ data: { ownerAccountId: owner.id,
            encryptionMode: 'plain', dataEncryptionKey: decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER),
            creationLocalId: randomUUID(), creationEqualityEvidenceV1: {},
            titleContent: { t: 'plain', v: 'Discussion' }, lastMessageAt: new Date(), messageSeq: 5,
        } });
        const source = { kind: 'discussion' as const, discussionId: discussion.id };
        const receiver = { kind: 'account' as const };
        const policy = { preset: 'important' as const };
        const path = resolveSessionFollowActionRequest('follow.set', { receiver, source, policy }).path;
        const app = await buildApp(owner.id);
        const otherApp = await buildApp(other.id);
        try {
            const set = await app.inject({ method: 'PUT', url: path, payload: { policy } });
            expect(set.statusCode, set.body).toBe(200);
            expect(parseSessionFollowActionResponse('follow.set', { receiver, source, policy }, set.json()))
                .toMatchObject({ changed: true, follow: { source, following: true, persistent: true, policy } });
            expect(await db.accountSessionFollow.findUnique({ where: { accountId_sourceKey: {
                accountId: owner.id, sourceKey: `discussion:${discussion.id}`,
            } } })).toMatchObject({ sessionId: null, sourceDiscussionId: discussion.id, deliveredDiscussionSeq: 5 });
            const get = await app.inject({ method: 'GET', url: path });
            expect(parseSessionFollowActionResponse('follow.get', { receiver, source }, get.json()))
                .toMatchObject({ follow: { source, policy } });
            expect((await otherApp.inject({ method: 'GET', url: path })).statusCode).toBe(404);
            const listed = await app.inject({ method: 'GET', url: '/v2/account/session-follows' });
            expect(listed.statusCode, listed.body).toBe(200);
            expect(listed.json().follows).toEqual([expect.objectContaining({ source })]);
            const removed = await app.inject({ method: 'DELETE', url: path });
            expect(parseSessionFollowActionResponse('follow.remove', { receiver, source }, removed.json())).toEqual({ changed: true });
            expect((await app.inject({ method: 'GET', url: path })).json()).toMatchObject({ follow: { following: false } });
            await db.discussion.update({ where: { id: discussion.id }, data: { messageSeq: 8 } });
            expect((await app.inject({ method: 'PUT', url: path, payload: { policy } })).statusCode).toBe(200);
            expect(await db.accountSessionFollow.findUnique({ where: { accountId_sourceKey: {
                accountId: owner.id, sourceKey: `discussion:${discussion.id}`,
            } } })).toMatchObject({ following: true, deliveredDiscussionSeq: 8 });
        } finally { await app.close(); await otherApp.close(); }
    });

    it('keeps a Workflow Run personal Follow at its current revision', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const run = await db.automationRun.create({ data: { accountId: owner.id, originKind: 'direct',
            automationId: null, causeKind: null, causeOccurredAt: null,
            workflowAcceptedSnapshotEnvelope: '{}', state: 'running', workflowCustodyState: 'pending',
            scheduledAt: new Date(), dueAt: new Date(), revision: 3 } });
        const app = await buildApp(owner.id);
        const source = { kind: 'workflow_run' as const, runId: run.id };
        const receiver = { kind: 'account' as const };
        const policy = { preset: 'important' as const };
        const path = resolveSessionFollowActionRequest('follow.set', { receiver, source, policy }).path;
        try {
            const saved = await app.inject({ method: 'PUT', url: path, payload: { policy } });
            expect(saved.statusCode, saved.body).toBe(200);
            expect(parseSessionFollowActionResponse('follow.set', { receiver, source, policy }, saved.json()))
                .toMatchObject({ changed: true, follow: { source, policy } });
            expect(await db.accountSessionFollow.findUnique({ where: { accountId_sourceKey: {
                accountId: owner.id, sourceKey: sourceKeyForSessionFollowSourceV1(source),
            } } })).toMatchObject({ sessionId: null, sourceWorkflowRunId: run.id, deliveredWorkflowRunRevision: 3 });
            const get = await app.inject({ method: 'GET', url: path });
            expect(parseSessionFollowActionResponse('follow.get', { receiver, source }, get.json()))
                .toMatchObject({ follow: { source, policy } });
            const listed = await app.inject({ method: 'GET', url: '/v2/account/session-follows' });
            expect(listed.statusCode, listed.body).toBe(200);
            expect(listed.json().follows).toEqual([expect.objectContaining({ source })]);
            expect((await app.inject({ method: 'DELETE', url: path })).json()).toEqual({ changed: true });
            expect((await app.inject({ method: 'GET', url: path })).json()).toMatchObject({ follow: { following: false } });
        } finally { await app.close(); }
    });

    it('continues the admitted personal source list without duplication and refuses another Account cursor', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const other = await db.account.create({ data: { encryptionMode: 'plain' } });
        const app = await buildApp(owner.id);
        const otherApp = await buildApp(other.id);
        try {
            const sessions = await Promise.all(['a', 'b', 'c'].map(id => db.session.create({ data: {
                id: `page-${id}`, accountId: owner.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain',
            } })));
            for (const session of sessions) {
                expect((await app.inject({ method: 'PUT', url: `/v2/sessions/${session.id}/follow`,
                    payload: { policy: { preset: 'important' } } })).statusCode).toBe(200);
            }
            const first = await app.inject({ method: 'GET', url: '/v2/account/session-follows?limit=1' });
            expect(first.statusCode, first.body).toBe(200);
            expect(first.json().follows.map((row: { sessionId: string }) => row.sessionId)).toEqual(['page-a']);
            expect(first.json().continuation).toEqual(expect.any(String));
            const cursor = encodeURIComponent(first.json().continuation);
            const next = await app.inject({ method: 'GET', url: `/v2/account/session-follows?cursor=${cursor}&limit=1` });
            expect(next.statusCode, next.body).toBe(200);
            expect(next.json().follows.map((row: { sessionId: string }) => row.sessionId)).toEqual(['page-b']);
            const last = await app.inject({ method: 'GET', url: `/v2/account/session-follows?cursor=${encodeURIComponent(next.json().continuation)}` });
            expect(last.json().follows.map((row: { sessionId: string }) => row.sessionId)).toEqual(['page-c']);
            expect(last.json().continuation).toBeUndefined();
            expect((await otherApp.inject({ method: 'GET', url: `/v2/account/session-follows?cursor=${cursor}` })).statusCode).toBe(400);
        } finally { await app.close(); await otherApp.close(); }
    });

    it('admits generic Follow grants at both Session operands while keeping private rules Account-scoped', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const source = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        const receiver = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        const createToken = (sessionIds: string[]) => auth.createApiToken({ accountId: owner.id, tokenId: randomUUID(), label: 'Follow only',
            // Routing still requires the incumbent destination input capability;
            // the exact Follow Action and both resource ceilings are checked too.
            grant: { ...API_TOKEN_FULL_GRANT_V1, actions: { families: [], ids: ['follow.get', 'follow.set', 'follow.list', 'follow.remove', 'session.message.send'] },
                targets: { sessions: sessionIds, machines: [] } } });
        const [both, receiverOnly, full] = await Promise.all([createToken([source.id, receiver.id]), createToken([receiver.id]),
            auth.createApiToken({ accountId: owner.id, tokenId: randomUUID(), label: 'Full Account' })]);
        const app = createAuthenticatedTestApp({ authentication: 'real' });
        sessionRoutes(app);
        await app.ready();
        const sourceUrl = `/v2/sessions/${receiver.id}/follows/sessions/${source.id}`;
        const headers = { authorization: `Bearer ${both.token}` };
        try {
            const denied = await app.inject({ method: 'PUT', url: sourceUrl, payload: { policy: { preset: 'important' } },
                headers: { authorization: `Bearer ${receiverOnly.token}` } });
            expect([denied.statusCode, denied.json()]).toEqual([403, { error: 'credential_scope_denied' }]);
            expect(await db.sessionFollowEdge.count()).toBe(0);
            const saved = await app.inject({ method: 'PUT', url: sourceUrl, payload: { policy: { preset: 'important' } }, headers });
            expect(saved.statusCode, saved.body).toBe(200);
            expect(saved.json()).toMatchObject({ changed: true, source: { sourceSessionId: source.id, destinationSessionId: receiver.id } });
            const listed = await app.inject({ method: 'GET', url: `/v2/sessions/${receiver.id}/follows/sessions`, headers });
            expect(listed.statusCode, listed.body).toBe(200);
            expect(listed.json().sources).toHaveLength(1);
            expect((await app.inject({ method: 'DELETE', url: sourceUrl, headers })).json()).toEqual({ changed: true });
            const personalUrl = `/v2/sessions/${source.id}/follow`;
            const followed = await app.inject({ method: 'PUT', url: personalUrl,
                payload: { notificationLevel: 'important', includeInVoice: false }, headers });
            expect(followed.statusCode, followed.body).toBe(200);
            expect((await app.inject({ method: 'GET', url: personalUrl, headers })).json().follow).toMatchObject({ sessionId: source.id, following: true });
            expect((await app.inject({ method: 'DELETE', url: personalUrl, headers })).json()).toEqual({ changed: true });
            const privateDenied = await app.inject({ method: 'GET', url: '/v2/account/session-follow-rules', headers });
            expect([privateDenied.statusCode, privateDenied.json()]).toEqual([403, { error: 'present_user_required' }]);
            const ownRules = await app.inject({ method: 'GET', url: '/v2/account/session-follow-rules',
                headers: { authorization: `Bearer ${full.token}` } });
            expect([ownRules.statusCode, ownRules.json()]).toEqual([200, { rules: [] }]);
        } finally { await app.close(); }
    });

    it('authors private Follow rules for both receiver kinds with versioned own-Account reads', async () => {
        const owner = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
        const stranger = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
        const receiver = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        const app = await buildApp(owner.id);
        const otherApp = await buildApp(stranger.id);
        const content = { t: 'plain', v: { v: 1, enabled: true, filter: { show: 'both', startedBy: ['you'], scope: 'all_accessible',
            attention: 'any', homeServerIds: ['home'], audiences: [], tagIds: [], source: 'all' }, policy: { preset: 'important' } } };
        const url = '/v2/account/session-follow-rules';
        try {
            expect((await app.inject({ method: 'GET', url })).json()).toEqual({ rules: [] });
            for (const [ruleId, target] of [['personal', { kind: 'account' }], ['coordinator', { kind: 'session', sessionId: receiver.id }]] as const) {
                const saved = await app.inject({ method: 'PUT', url: `${url}/${ruleId}`, payload: { receiver: target, content, expectedVersion: -1 } });
                expect([saved.statusCode, saved.json()]).toEqual([200, { rule: { ruleId, receiver: target, content, version: 0,
                    inception: { createdAt: expect.any(Number), accountChangeCursor: expect.any(Number) } } }]);
                expect((await app.inject({ method: 'GET', url: `${url}/${ruleId}` })).json()).toEqual(saved.json());
            }
            expect((await app.inject({ method: 'GET', url })).json().rules).toHaveLength(2);
            expect((await app.inject({ method: 'GET', url: `${url}?sourceSessionId=${receiver.id}` })).statusCode).toBe(400);
            const demand = await app.inject({ method: 'GET',
                url: `${url}?destinationSessionId=${receiver.id}&sourceSessionId=${receiver.id}` });
            expect(demand.statusCode, demand.body).toBe(200);
            expect(demand.json().sourceRanges).toEqual({ status: 'available', sources: [] });
            expect((await otherApp.inject({ method: 'GET', url })).json()).toEqual({ rules: [] });
            expect((await otherApp.inject({ method: 'GET', url: `${url}/personal` })).json()).toEqual({ rule: null });
            expect(await db.accountSessionFollow.count()).toBe(0);
            expect(await db.sessionFollowEdge.count()).toBe(0);
            const stale = await app.inject({ method: 'PUT', url: `${url}/personal`, payload: { receiver: { kind: 'account' }, content, expectedVersion: -1 } });
            expect([stale.statusCode, stale.json()]).toEqual([409, { error: 'version_conflict' }]);
            const wrongMode = await app.inject({ method: 'PUT', url: `${url}/personal`, payload: { receiver: { kind: 'account' }, content: { t: 'encrypted', c: 'opaque' }, expectedVersion: 0 } });
            expect([wrongMode.statusCode, wrongMode.json()]).toEqual([409, { error: 'account_mode_mismatch' }]);
            const foreignReceiver = await otherApp.inject({ method: 'PUT', url: `${url}/foreign`, payload: { receiver: { kind: 'session', sessionId: receiver.id }, content, expectedVersion: -1 } });
            expect([foreignReceiver.statusCode, foreignReceiver.json()]).toEqual([404, { error: 'session_not_found' }]);
            // Content-free progress has its own physical CAS; it does not change the authoring version.
            await db.userKVStore.update({ where: { accountId_key: { accountId: owner.id, key: buildSessionFollowRulePhysicalKeyV1('personal') } }, data: { version: 9 } });
            const beforeWrongReceiver = await db.userKVStore.findMany({ where: { accountId: owner.id } });
            const wrongReceiver = await app.inject({ method: 'DELETE', url: `${url}/personal`, payload: { receiver: { kind: 'session', sessionId: receiver.id }, expectedVersion: 0 } });
            expect([wrongReceiver.statusCode, wrongReceiver.json()]).toEqual([400, { error: 'invalid_parameters' }]);
            expect(await db.userKVStore.findMany({ where: { accountId: owner.id } })).toEqual(beforeWrongReceiver);
            const removed = await app.inject({ method: 'DELETE', url: `${url}/personal`, payload: { receiver: { kind: 'account' }, expectedVersion: 0 } });
            expect([removed.statusCode, removed.json()]).toEqual([200, { changed: true, version: 10 }]);
            expect((await app.inject({ method: 'DELETE', url: `${url}/personal`, payload: { receiver: { kind: 'account' }, expectedVersion: 0 } })).statusCode).toBe(409);
            const restored = await app.inject({ method: 'PUT', url: `${url}/personal`, payload: {
                receiver: { kind: 'account' }, content, expectedVersion: removed.json().version,
            } });
            expect([restored.statusCode, restored.json()]).toEqual([200, {
                rule: { ruleId: 'personal', receiver: { kind: 'account' }, content, version: 11,
                    inception: { createdAt: expect.any(Number), accountChangeCursor: expect.any(Number) } },
            }]);
            expect((await app.inject({ method: 'DELETE', url: `${url}/personal`, payload: {
                receiver: { kind: 'account' }, expectedVersion: 11,
            } })).statusCode).toBe(200);
            expect((await app.inject({ method: 'GET', url })).json().rules.map((rule: { ruleId: string }) => rule.ruleId)).toEqual(['coordinator']);
            await db.session.delete({ where: { id: receiver.id } });
            expect((await app.inject({ method: 'GET', url })).json().rules.map((rule: { ruleId: string }) => rule.ruleId)).toEqual(['coordinator']);
            expect((await app.inject({ method: 'GET', url: `${url}/coordinator` })).json().rule.receiver).toEqual({ kind: 'session', sessionId: receiver.id });
            expect((await app.inject({ method: 'DELETE', url: `${url}/coordinator`, payload: { receiver: { kind: 'session', sessionId: receiver.id }, expectedVersion: 0 } })).statusCode).toBe(200);
        } finally { await app.close(); await otherApp.close(); }
    });

    it('opens encrypted private Follow rules only with matching Account material and denies restricted runtimes', async () => {
        const keys = tweetnacl.box.keyPair();
        const account = await db.account.create({ data: { ...createSignedAccountContentBinding(keys.publicKey), encryptionMode: 'e2ee' } });
        const material = { type: 'dataKey', machineKey: keys.secretKey } as const;
        const receiver = { kind: 'account' } as const;
        const definition = SessionFollowRuleDefinitionV1Schema.parse({ v: 1, enabled: true, policy: { preset: 'important' },
            filter: { show: 'both', startedBy: ['you'], scope: 'all_accessible', attention: 'any', homeServerIds: ['home'], audiences: [], tagIds: [], source: 'all' } });
        const content = sealSessionFollowRuleContentV1({ ruleId: 'private', receiver, definition, mode: 'e2ee', material });
        const session = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        const sessionReceiver = { kind: 'session', sessionId: session.id } as const;
        const sessionContent = sealSessionFollowRuleContentV1({ ruleId: 'coordinator', receiver: sessionReceiver, definition, mode: 'e2ee', material });
        const app = await buildApp(account.id);
        const restricted = await buildApp(account.id, VerifiedEphemeralSessionRunnerPrincipalSchema.parse({ kind: 'ephemeral_session_runner', authority: 'session_runtime',
            accountId: account.id, activationId: randomUUID(), sessionId: 'session', machineId: 'machine', installationId: 'installation',
            installationPublicKey: encodeBase64(tweetnacl.sign.keyPair().publicKey, 'base64url'), creatorTokenEpoch: 0 }));
        const url = '/v2/account/session-follow-rules';
        try {
            const saved = await app.inject({ method: 'PUT', url: `${url}/private`, payload: { receiver, content, expectedVersion: -1 } });
            expect(saved.statusCode, saved.body).toBe(200);
            const sessionSaved = await app.inject({ method: 'PUT', url: `${url}/coordinator`, payload: { receiver: sessionReceiver, content: sessionContent, expectedVersion: -1 } });
            expect(sessionSaved.statusCode, sessionSaved.body).toBe(200);
            const listed = await app.inject({ method: 'GET', url });
            expect(listed.statusCode, listed.body).toBe(200);
            expect(listed.json().rules).toHaveLength(2);
            for (const rule of listed.json().rules) expect(openSessionFollowRuleContentV1({ ...rule, mode: 'e2ee', material })).toEqual({ status: 'opened', definition });
            for (const method of ['GET', 'PUT', 'DELETE'] as const) {
                const response = await restricted.inject({ method, url: method === 'GET' ? url : `${url}/private`,
                    ...(method === 'PUT' ? { payload: { receiver, content, expectedVersion: 0 } } : method === 'DELETE' ? { payload: { receiver, expectedVersion: 0 } } : {}) });
                expect([response.statusCode, response.json()]).toEqual([403, { error: 'credential_scope_denied' }]);
            }
            const plain = sealSessionFollowRuleContentV1({ ruleId: 'private', receiver, definition, mode: 'plain', material: null });
            expect((await app.inject({ method: 'PUT', url: `${url}/private`, payload: { receiver, content: plain, expectedVersion: 0 } })).statusCode).toBe(409);
            await db.userKVStore.update({ where: { accountId_key: { accountId: account.id, key: buildSessionFollowRulePhysicalKeyV1('private') } },
                data: { value: new TextEncoder().encode(JSON.stringify({ version: 0, receiver, content: plain })) } });
            const inconsistent = await app.inject({ method: 'GET', url });
            expect([inconsistent.statusCode, inconsistent.json()]).toEqual([409, { error: 'account_mode_mismatch' }]);
        } finally { await app.close(); await restricted.close(); }
    });

    it('keeps delivery mutes receiver-scoped, private and idempotent without changing Follow', async () => {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const stranger = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const receiver = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        const otherReceiver = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        const source = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        const app = await buildApp(owner.id);
        const otherApp = await buildApp(stranger.id);
        const scope = { kind: 'sender_session', sessionId: source.id };
        try {
            const personal = '/v2/account/session-delivery-mutes';
            const target = `/v2/sessions/${receiver.id}/delivery-mutes`;
            expect((await app.inject({ method: 'GET', url: personal })).json()).toEqual({ scopes: [] });
            for (const url of [personal, target]) {
                const saved = await app.inject({ method: 'PUT', url, payload: { scope } });
                expect([saved.statusCode, saved.json()]).toEqual([200, { changed: true, disposition: 'muted' }]);
                expect((await app.inject({ method: 'PUT', url, payload: { scope } })).json()).toEqual({ changed: false, disposition: 'muted' });
                expect((await app.inject({ method: 'GET', url })).json()).toEqual({ scopes: [scope] });
            }
            expect((await otherApp.inject({ method: 'GET', url: personal })).json()).toEqual({ scopes: [] });
            expect((await otherApp.inject({ method: 'GET', url: target })).statusCode).toBe(404);
            expect((await app.inject({ method: 'GET', url: `/v2/sessions/${otherReceiver.id}/delivery-mutes` })).json()).toEqual({ scopes: [] });
            expect(await db.accountSessionFollow.count()).toBe(0);
            expect(await db.sessionFollowEdge.count()).toBe(0);
            expect((await app.inject({ method: 'DELETE', url: target, payload: { scope } })).json()).toEqual({ changed: true, disposition: 'unmuted' });
            expect((await app.inject({ method: 'DELETE', url: target, payload: { scope } })).json()).toEqual({ changed: false, disposition: 'unmuted' });
            expect((await app.inject({ method: 'GET', url: personal })).json()).toEqual({ scopes: [scope] });
        } finally { await app.close(); await otherApp.close(); }
    });

    it('reads Account mutes through the public client at its exact authenticated Home and fails closed', async () => {
        const owner = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
        const other = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
        const app = createAuthenticatedTestApp({ authentication: 'real' });
        const otherApp = createAuthenticatedTestApp({ authentication: 'real' });
        sessionRoutes(app);
        sessionRoutes(otherApp);
        const [ownerToken, otherToken] = await Promise.all([owner.id, other.id].map(accountId => auth.createToken(accountId,
            undefined, { kind: 'account', authority: 'present_user' })));
        const serverHttpBaseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
        const otherHomeUrl = await otherApp.listen({ host: '127.0.0.1', port: 0 });
        const scope = { kind: 'source', source: { kind: 'session', sessionId: 'overlapping-source-id' } };
        try {
            // Load the real client at the cross-package boundary without making server compilation own CLI sources.
            const cliReaderModuleId = '../../../../../../cli/src/api/sessionDeliveryMuteTransport';
            const { readAccountSessionDeliveryMutedScopes } = await vi.importActual<{
                readAccountSessionDeliveryMutedScopes(input: Readonly<{
                    serverHttpBaseUrl: string; accountId: string; token: string; signal?: AbortSignal;
                }>): Promise<readonly FollowDeliveryMuteScopeV1[] | null>;
            }>(cliReaderModuleId);
            expect((await app.inject({ method: 'PUT', url: '/v2/account/session-delivery-mutes', payload: { scope },
                headers: { authorization: `Bearer ${ownerToken}` } })).statusCode).toBe(200);
            const captured = { serverHttpBaseUrl, token: ownerToken, accountId: owner.id };
            expect(await readAccountSessionDeliveryMutedScopes(captured)).toEqual([scope]);
            expect(await readAccountSessionDeliveryMutedScopes({ serverHttpBaseUrl: otherHomeUrl,
                token: otherToken, accountId: other.id })).toEqual([]);
            expect(await readAccountSessionDeliveryMutedScopes({ ...captured, accountId: other.id })).toBeNull();
            await db.account.update({ where: { id: owner.id }, data: { deliveryMutes: '{invalid' } });
            expect(await readAccountSessionDeliveryMutedScopes(captured)).toBeNull();
        } finally { await app.close(); await otherApp.close(); }
    });

    it('persists only the authenticated reader Follow and makes explicit Unfollow idempotent', async () => {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const viewer = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const session = await db.session.create({ data: {
            accountId: owner.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain', seq: 8,
        } });
        await db.sessionGrant.create({ data: { principalKind: 'account',
            sessionId: session.id, createdByAccountId: owner.id, accountId: viewer.id, accessLevel: 'view',
        } });
        const app = await buildApp(viewer.id);
        try {
            const url = `/v2/sessions/${session.id}/follow`;
            const initial = await app.inject({ method: 'GET', url });
            expect(initial.statusCode).toBe(200);
            expect(initial.json()).toEqual({ follow: null, isSessionOwner: false, capabilities: { manageFollow: true }, voiceInitialSnapshotPending: false });
            const payload = { notificationLevel: 'none', includeInVoice: true };
            const created = await app.inject({ method: 'PUT', url, payload });
            expect(created.statusCode).toBe(200);
            expect(created.json()).toEqual({ changed: true, follow: { sessionId: session.id, following: true, ...payload,
                policy: normalizeAccountFollowNotificationChoiceV1({ notificationLevel: 'none', includeInVoice: true }), once: null }, voiceInitialSnapshotPending: true });
            expect((await app.inject({ method: 'GET', url: '/v2/account/session-follows' })).json()).toEqual({ follows: [created.json().follow] });
            expect(await db.accountSessionReadState.findUnique({ where: {
                accountId_sessionId: { accountId: viewer.id, sessionId: session.id },
            } })).toMatchObject({ lastViewedSessionSeq: 8, unreadSince: null });
            expect(await db.accountSessionFollow.findUnique({ where: {
                accountId_sessionId: { accountId: owner.id, sessionId: session.id },
            } })).toBeNull();
            expect((await app.inject({ method: 'PUT', url, payload })).json().changed).toBe(false);
            const removed = await app.inject({ method: 'DELETE', url });
            expect(removed.json()).toEqual({ changed: true });
            expect((await app.inject({ method: 'DELETE', url })).json()).toEqual({ changed: false });
            expect((await app.inject({ method: 'GET', url })).json().follow).toEqual({
                sessionId: session.id, following: false, notificationLevel: 'none', includeInVoice: false, once: null,
            });
        } finally { await app.close(); }
    });

    it('keeps preferences prospective, private and strict, and conceals inaccessible sessions', async () => {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const stranger = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const session = await db.session.create({ data: {
            accountId: owner.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain',
        } });
        const app = await buildApp(stranger.id);
        try {
            const url = '/v2/account/session-follow-preferences';
            const defaults = await app.inject({ method: 'GET', url });
            expect(defaults.statusCode).toBe(200);
            const creationPolicies = { managerPolicy: { preset: 'important' }, runReportPolicy: { preset: 'important' },
                discussionReceivePolicy: { preset: 'quiet' } };
            expect(defaults.json()).toEqual({ assigned: true, direct: false, team: false, group: false, ...creationPolicies });
            const preferences = { assigned: false, direct: true, team: true, group: true,
                ...creationPolicies, managerPolicy: { preset: 'quiet' }, discussionReceivePolicy: { preset: 'everything' } };
            expect((await app.inject({ method: 'PUT', url, payload: preferences })).json()).toEqual(preferences);
            expect((await app.inject({ method: 'GET', url })).json()).toEqual(preferences);
            const otherAccountApp = await buildApp(owner.id);
            try {
                expect((await otherAccountApp.inject({ method: 'GET', url })).json()).toEqual({
                    assigned: true, direct: false, team: false, group: false, ...creationPolicies,
                });
            } finally { await otherAccountApp.close(); }
            expect(await db.accountSessionFollow.count()).toBe(0);
            expect((await app.inject({ method: 'PUT', url, payload: { ...preferences, accountId: owner.id } })).statusCode).toBe(400);
            for (const method of ['GET', 'DELETE', 'PUT'] as const) {
                const response = await app.inject({ method, url: `/v2/sessions/${session.id}/follow`,
                    ...(method === 'PUT' ? { payload: { notificationLevel: 'important', includeInVoice: false } } : {}) });
                expect([response.statusCode, response.json()]).toEqual([404, { error: 'session_not_found' }]);
            }
            await db.account.update({ where: { id: stranger.id }, data: { status: 'suspended' } });
            expect((await app.inject({ method: 'PUT', url, payload: preferences })).statusCode).toBe(403);
        } finally { await app.close(); }
    });

    it('keeps encrypted Session content and Voice frontiers outside the human resource and fails closed when disabled', async () => {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'e2ee' } });
        const session = await db.session.create({ data: {
            accountId: owner.id, tag: randomUUID(), metadata: 'opaque-encrypted-metadata', encryptionMode: 'e2ee',
        } });
        const app = await buildApp(owner.id);
        try {
            const url = `/v2/sessions/${session.id}/follow`;
            const payload = { notificationLevel: 'important', includeInVoice: true };
            const saved = await app.inject({ method: 'PUT', url, payload });
            expect(saved.statusCode).toBe(200);
            expect(saved.json()).toEqual({ changed: true, follow: { sessionId: session.id, following: true, ...payload, policy: { preset: 'important', voice: true }, once: null },
                voiceInitialSnapshotPending: true });
            const change = await db.accountChange.findUnique({ where: {
                accountId_kind_entityId: { accountId: owner.id, kind: 'account', entityId: 'session-follows' },
            } });
            expect(change?.hint).toEqual({ sessionFollows: true, full: true });
            process.env.HAPPIER_FEATURE_SESSIONS_FOLLOWING__ENABLED = 'false';
            const disabled = await app.inject({ method: 'DELETE', url });
            expect([disabled.statusCode, disabled.json()]).toEqual([404, { error: 'feature_unavailable' }]);
            expect(await db.accountSessionFollow.findUnique({ where: {
                accountId_sessionId: { accountId: owner.id, sessionId: session.id },
            } })).toMatchObject({ following: true, includeInVoice: false, followPolicy: JSON.stringify({ preset: 'important', voice: true }) });
        } finally { await app.close(); }
    });

    it('replaces 101 accessible Voice inclusions and returns the exact canonical set', async () => {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const sessionIds = Array.from({ length: 101 }, () => randomUUID());
        await db.session.createMany({ data: sessionIds.map(id => ({
            id,
            accountId: owner.id,
            tag: randomUUID(),
            metadata: '{}',
            encryptionMode: 'plain' as const,
        })) });
        const app = await buildApp(owner.id);
        try {
            const response = await app.inject({
                method: 'PUT',
                url: '/v2/account/session-follow-voice-inclusions',
                payload: { sessionIds: [...sessionIds].reverse() },
            });
            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({ changed: true, sessionIds: [...sessionIds].sort() });
            expect((await db.accountSessionFollow.findMany({
                where: { accountId: owner.id, following: true },
                select: { sessionId: true, includeInVoice: true, followPolicy: true },
                orderBy: { sessionId: 'asc' },
            })).filter(row => resolveAccountVoiceSelection(row) !== null).map(row => row.sessionId)).toEqual([...sessionIds].sort());
        } finally { await app.close(); }
    });
});
