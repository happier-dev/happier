import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import nacl from 'tweetnacl';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { ExternalActionExecutionAuthorizationV1Schema, ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1, encodeExternalActionResolvedTargetV1, signExternalActionMachineRequestV1, signExternalActionMachineRpcRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { SessionMetadataTuplePatchV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { FollowPolicyV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowPolicyV1';
import { SessionListQueryV1Schema } from '@happier-dev/protocol/sessions/listing/query';
import { auth } from '@/app/auth/auth';
import { verifyExternalActionDomainExecutionRequest, verifyExternalActionMachineRpcExecution } from '@/app/auth/externalActionExecutionAuthorization';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { sourceKeyForSessionFollowSourceV1 } from '@/app/session/follow/sessionFollowSourceIdentity';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';

describe('installed Session signed lifecycle scope', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-lifecycle-scope-', initAuth: true,
            env: { AUTH_REQUIRED_LOGIN_PROVIDERS: '' } });
    }, 300_000);
    afterAll(async () => { await harness?.close(); });

    async function fixture(actionId: 'session.stop' | 'session.archive' | 'session.unarchive' | 'session.open' | 'discussion.second_opinion.start' | 'usage.recap.compose' | 'usage.recap.export' | 'usage.recap.deliver' | 'usage.coach.dismiss' | 'usage.coach.snooze' | 'usage.coach.apply' | 'usage.coach.undo' | 'artifact.get' | 'action.operations.cancel', installed = true) {
        const account = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
        const keys = nacl.sign.keyPair();
        const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: account.id,
            metadata: encodePlainMachineStoredContent({}), dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64'),
            installationId: crypto.randomUUID(), installationPublicKey: keys.publicKey } });
        const createSession = (accountId = account.id) => db.session.create({ data: { accountId,
            tag: crypto.randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        const root = await createSession();
        const child = await createSession();
        const grandchild = await createSession();
        const otherRoot = await createSession();
        await db.accessKey.create({ data: { accountId: account.id, machineId: machine.id, sessionId: root.id, data: 'source' } });
        const attach = async (sourceSessionId: string, destinationSessionId: string) => db.sessionFollowEdge.create({ data: {
            sourceKey: sourceKeyForSessionFollowSourceV1({ kind: 'session', sessionId: sourceSessionId }),
            sourceSessionId, managerSourceSessionId: sourceSessionId, destinationSessionId, relation: 'manager',
            policyJson: JSON.stringify(FollowPolicyV1Schema.parse({ preset: 'important' })),
        } });
        await attach(child.id, root.id);
        await attach(grandchild.id, child.id);
        let publisherCurrent = true;
        const resolveCurrentSessionMachine = async () => publisherCurrent ? machine.id : null;
        const requestId = crypto.randomUUID();
        const envelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId,
            target: { kind: 'machine', machineId: machine.id },
            input: actionId === 'discussion.second_opinion.start' ? {
                intent: 'preview', source: { kind: 'session', message: { kind: 'session',
                    session: { serverId: 'home-1', sessionId: root.id }, messageId: 'answer-1' } },
                title: 'Review', question: 'Please check', reviewers: [],
                retry: { creationLocalId: 'create-opinion', quoteLocalId: 'quote-opinion', questionLocalId: 'ask-opinion' },
            } : { sessionId: grandchild.id, ...(actionId === 'session.open' ? { intent: 'resume' } : {}) } });
        // The production issuer and strict signed consumer use a disposable real
        // database. Only live publisher discovery is a process boundary fixture.
        const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(await auth.mintExternalActionExecutionAuthorization({
            serverIdentityId: await getOrCreateServerIdentityId(), accountId: account.id,
            authentication: { kind: 'account', tokenEpoch: account.tokenEpoch }, actionId,
            machineId: machine.id, target: { kind: 'machine', machineId: machine.id }, requestId,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
            ...(installed ? { sessionActionOrigin: { v: 1 as const,
                caller: { kind: 'session' as const, sessionId: root.id, starterDepth: 0, turnDepth: 0 },
                sourceTurnId: 'turn', callerPermissionMode: null, requestId },
                sessionActionSource: { machineId: machine.id, installationId: machine.installationId! } } : {}),
        }, { resolveCurrentSessionMachine }));
        const verifyRequest = async (method: string, path: string, body?: unknown, sessionId?: string, effectActionId = actionId, sessionRouteActionId?: 'session.transcript.get') => {
            return verifyExternalActionDomainExecutionRequest({ authorizationToken: authorization.token,
                effectActionId, encodedTarget: encodeExternalActionResolvedTargetV1(authorization.binding.target),
                method, path, body, ...(sessionId ? { sessionRouteTarget: { kind: 'session' as const, sessionId, ...(sessionRouteActionId ? { actionId: sessionRouteActionId } : {}) } } : {}), resolveCurrentSessionMachine,
                machineSignature: signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                    effectActionId, target: authorization.binding.target, installationId: machine.installationId!,
                    requestId: authorization.binding.requestId, method, path, body, privateKey: keys.secretKey }),
            });
        };
        const verify = (sessionId: string, method = 'GET', body?: unknown, suffix = '', effectActionId = actionId) =>
            verifyRequest(method, `/v2/sessions/${encodeURIComponent(sessionId)}${suffix}`, body, sessionId, effectActionId);
        const observe = (underSessionId?: string) => verifyRequest('POST', '/v2/sessions/query', SessionListQueryV1Schema.parse({
            v: 1, storage: 'active', includeInactive: true, scope: 'all_accessible', attention: 'any', audiences: [], tagIds: [], ...(underSessionId ? { underSessionId } : {}),
        }));
        const verifyStopRpc = (effectActionId: 'session.stop' | 'session.archive' = 'session.stop') => {
            const method = `${machine.id}:${RPC_METHODS.STOP_SESSION}`;
            const requestId = crypto.randomUUID();
            const params = { sessionId: grandchild.id };
            return verifyExternalActionMachineRpcExecution({ v: 1, authorization, effectActionId,
                target: authorization.binding.target, installationId: machine.installationId!,
                machineSignature: signExternalActionMachineRpcRequestV1({ authorizationToken: authorization.token,
                    effectActionId, target: authorization.binding.target, installationId: machine.installationId!,
                    method, requestId, params, privateKey: keys.secretKey }),
            }, { method, requestId, params, resolveCurrentSessionMachine });
        };
        return { account, machine, root, child, grandchild, otherRoot, createSession, attach, verify, observe, verifyRequest, verifyStopRpc,
            retirePublisher: () => { publisherCurrent = false; } };
    }

    it.each(['usage.recap.compose', 'usage.recap.export', 'usage.recap.deliver',
        'usage.coach.dismiss', 'usage.coach.snooze', 'usage.coach.apply', 'usage.coach.undo', 'artifact.get', 'action.operations.cancel'] as const)(
        'admits shared feature discovery before the specialized Account purpose for %s', async actionId => {
            const f = await fixture(actionId);
            expect(await f.verifyRequest('GET', '/v1/features/authenticated')).not.toBeNull();
            expect(await f.verifyRequest('GET', '/v1/features/authenticated?extra=1')).toBeNull();
        });

    it.each(['session.stop', 'session.archive', 'session.unarchive'] as const)(
        'admits a recursive descendant for %s and rejects removed or reparented membership', async actionId => {
            const f = await fixture(actionId);
            const mutation = () => actionId === 'session.stop'
                ? f.verify(f.grandchild.id, 'PATCH', SessionMetadataTuplePatchV1Schema.parse({ mode: 'owner', metadataLayoutVersion: 1,
                    expectedOwnerMetadata: { t: 'plain', v: { v: 1 } }, ownerMetadata: { t: 'plain', v: { v: 1 } },
                    sharedMetadata: { ciphertext: '{}', expectedVersion: 0 }, agentState: { ciphertext: null, expectedVersion: 0 } }))
                : f.verify(f.grandchild.id, 'POST', {}, actionId === 'session.archive' ? '/archive' : '/unarchive');
            expect(await f.verify(f.grandchild.id)).not.toBeNull();
            expect(await mutation()).not.toBeNull();
            expect(await f.verify(f.root.id)).not.toBeNull();
            expect(await f.verify(f.otherRoot.id)).toBeNull();
            expect(await f.verify(f.grandchild.id, 'GET', undefined, '?unexpected=1')).toBeNull();

            // Losing an intermediate edge revokes the entire branch, even
            // though the grandchild's immediate manager is unchanged.
            await db.sessionFollowEdge.deleteMany({ where: { sourceSessionId: f.child.id, relation: 'manager' } });
            await f.attach(f.child.id, f.otherRoot.id);
            expect(await f.verify(f.grandchild.id)).toBeNull();
            expect(await mutation()).toBeNull();
            await db.sessionFollowEdge.deleteMany({ where: { sourceSessionId: f.child.id, relation: 'manager' } });
            expect(await f.verify(f.grandchild.id)).toBeNull();
            expect(await mutation()).toBeNull();
            await f.attach(f.child.id, f.root.id);
            expect(await f.verify(f.grandchild.id)).not.toBeNull();

            const foreignAccount = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
            const foreign = await f.createSession(foreignAccount.id);
            await f.attach(foreign.id, f.root.id);
            expect(await f.verify(foreign.id)).toBeNull();
            f.retirePublisher();
            expect(await f.verify(f.grandchild.id)).toBeNull();
        });

    it('keeps signed Session Open bound to the caller even while the child remains led', async () => {
        const f = await fixture('session.open');
        expect(await f.verify(f.child.id)).toBeNull();
        expect(await f.verify(f.root.id)).not.toBeNull();
        expect(await f.observe(f.root.id)).not.toBeNull();
    });

    it('admits lifecycle observation under a nested selected lead only while it remains in the readable subtree', async () => {
        const f = await fixture('session.archive');
        // Keep cross-Account isolation observable even if a later subtree assertion fails.
        const foreignAccount = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
        const foreign = await f.createSession(foreignAccount.id);
        await f.attach(foreign.id, f.root.id);
        expect(await f.observe(foreign.id)).toBeNull();
        expect(await f.observe(f.root.id)).not.toBeNull();
        expect(await f.observe(f.child.id)).not.toBeNull();
        expect.soft(await f.observe(f.otherRoot.id)).toBeNull();
        expect.soft(await f.observe()).toBeNull();
        expect.soft(await f.verifyRequest('POST', '/v2/sessions/read-batch', {
            sessionIds: [f.otherRoot.id], underSessionId: f.otherRoot.id,
            includeSnapshot: true, includeTurns: false, includeMessages: false,
        })).toBeNull();
        await db.sessionFollowEdge.deleteMany({ where: { sourceSessionId: f.child.id, relation: 'manager' } });
        await f.attach(f.child.id, f.otherRoot.id);
        expect(await f.observe(f.child.id)).toBeNull();
        await db.sessionFollowEdge.deleteMany({ where: { sourceSessionId: f.child.id, relation: 'manager' } });
        expect(await f.observe(f.child.id)).toBeNull();
        await f.attach(f.child.id, f.root.id);
        expect(await f.observe(f.child.id)).not.toBeNull();
        f.retirePublisher();
        expect(await f.observe(f.child.id)).toBeNull();
    });

    it('keeps Second opinion source transcript reads from admitting other caller Session GETs', async () => {
        const f = await fixture('discussion.second_opinion.start');
        expect(await f.verifyRequest('GET', `/v1/sessions/${f.root.id}/messages`, undefined,
            f.root.id, 'discussion.second_opinion.start', 'session.transcript.get')).not.toBeNull();
        expect(await f.verifyRequest('GET', `/v2/sessions/${f.root.id}/messages/replies/pending`, undefined,
            f.root.id, 'discussion.second_opinion.start', 'session.transcript.get')).toBeNull();
    });

    it('retains the Archive root while admitting only its led Stop preparation effect', async () => {
        const f = await fixture('session.archive');
        const effect = 'session.stop';
        expect(await f.verify(f.grandchild.id, 'GET', undefined, '', effect)).toMatchObject({
            binding: { actionId: 'session.archive' }, effectActionId: effect,
        });
        const patch = SessionMetadataTuplePatchV1Schema.parse({ mode: 'owner', metadataLayoutVersion: 1,
            expectedOwnerMetadata: { t: 'plain', v: { v: 1 } }, ownerMetadata: { t: 'plain', v: { v: 1 } },
            sharedMetadata: { ciphertext: '{}', expectedVersion: 0 }, agentState: { ciphertext: null, expectedVersion: 0 } });
        expect(await f.verify(f.grandchild.id, 'PATCH', patch, '', effect)).not.toBeNull();
        expect(await f.verifyRequest('GET', '/v1/account/encryption/currentness', undefined, undefined, effect)).not.toBeNull();
        expect(await f.verifyRequest('GET', `/v1/machines/${f.machine.id}`, undefined, undefined, effect)).not.toBeNull();
        expect(await f.verify(f.otherRoot.id, 'GET', undefined, '', effect)).toBeNull();
        expect(await f.verify(f.grandchild.id, 'POST', {}, '/unarchive', 'session.unarchive')).toBeNull();
        await db.sessionFollowEdge.deleteMany({ where: { sourceSessionId: f.child.id, relation: 'manager' } });
        expect(await f.verify(f.grandchild.id, 'GET', undefined, '', effect)).toBeNull();
        expect(await f.verify(f.grandchild.id, 'PATCH', patch, '', effect)).toBeNull();
    });

    it.each(['session.stop', 'session.open'] as const)('preserves owned %s preparation for a present user without an installed origin', async actionId => {
        const f = await fixture(actionId, false);
        expect(await f.verify(f.otherRoot.id)).not.toBeNull();
        const foreignAccount = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
        const foreign = await f.createSession(foreignAccount.id);
        expect(await f.verify(foreign.id)).toBeNull();
    });

    it('preserves the signed present-user Archive Stop phase without an installed Session origin', async () => {
        const f = await fixture('session.archive', false);
        expect(await f.verifyStopRpc()).toMatchObject({ binding: { actionId: 'session.archive' }, effectActionId: 'session.stop' });
        expect(await f.verifyStopRpc('session.archive')).toBeNull();
        // The original Archive owner keeps its HTTP purpose; only the native
        // Stop packet changes its effect identity, never its signed root.
        expect(await f.verifyRequest('GET', '/v1/account/encryption/currentness')).not.toBeNull();
    });
});
