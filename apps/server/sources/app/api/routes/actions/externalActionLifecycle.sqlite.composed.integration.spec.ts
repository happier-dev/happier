import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import nacl from 'tweetnacl';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { ArtifactJsonCreateHttpInputV1Schema, ArtifactJsonUpdateHttpInputV1Schema } from '@happier-dev/protocol/artifacts/artifactMutationHttpV1';
import { encodeArtifactKindV1, REVIEW_ARTIFACT_KIND_V1 } from '@happier-dev/protocol/artifacts/artifactKindV1';
import { ArtifactRecipientKeyEnvelopeCommitInputV1Schema } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { SESSION_DATA_KEY_ENVELOPE_BYTES_V1 } from '@happier-dev/protocol/sessions/encryption/sessionDataKeyEnvelopes';
import { ExternalActionExecutionAuthorizationV1Schema, ExternalActionRequestEnvelopeV1Schema,
    EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER, EXTERNAL_ACTION_EFFECT_ACTION_HEADER,
    EXTERNAL_ACTION_RESOLVED_TARGET_HEADER, EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER } from '@happier-dev/protocol/actions/externalActionApi';
import { createCliWorkflowRunStorage } from '../../../../../../cli/src/session/actions/workflowRunStorage';
import { resolveExternalActionServerRequestHeaders } from '../../../../../../cli/src/api/externalActionExecutionAuthorization';
import * as currentMachineInstallation from '../../../../../../cli/src/daemon/identity/currentMachineInstallation';
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

    async function fixture(actionId: 'session.stop' | 'session.archive' | 'session.unarchive' | 'session.open' | 'discussion.second_opinion.start' | 'review.start' | 'review.new_round' | 'review.prepare_round' | 'review.settle_round' | 'usage.recap.compose' | 'usage.recap.export' | 'usage.recap.deliver' | 'usage.coach.dismiss' | 'usage.coach.snooze' | 'usage.coach.apply' | 'usage.coach.undo' | 'artifact.get' | 'action.operations.cancel', installed = true, sessionTarget = false) {
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
        const target = sessionTarget ? { kind: 'session' as const, sessionId: root.id }
            : { kind: 'machine' as const, machineId: machine.id };
        const envelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId,
            target,
            input: actionId === 'discussion.second_opinion.start' ? {
                intent: 'preview', source: { kind: 'session', message: { kind: 'session',
                    session: { serverId: 'home-1', sessionId: root.id }, messageId: 'answer-1' } },
                title: 'Review', question: 'Please check', reviewers: [],
                retry: { creationLocalId: 'create-opinion', quoteLocalId: 'quote-opinion', questionLocalId: 'ask-opinion' },
            } : actionId === 'review.start' ? { sessionId: root.id, cwd: '/repo',
                reviewers: [{ kind: 'session', session: { serverId: 'home-1', sessionId: root.id } }],
                instructions: 'Review source claims.' }
                : { sessionId: grandchild.id, ...(actionId === 'session.open' ? { intent: 'resume' } : {}) } });
        // The production issuer and strict signed consumer use a disposable real
        // database. Only live publisher discovery is a process boundary fixture.
        const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(await auth.mintExternalActionExecutionAuthorization({
            serverIdentityId: await getOrCreateServerIdentityId(), accountId: account.id,
            authentication: { kind: 'account', tokenEpoch: account.tokenEpoch }, actionId,
            machineId: machine.id, target, requestId,
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
        return { account, machine, root, child, grandchild, otherRoot, createSession, attach, verify, observe, verifyRequest, verifyStopRpc, authorization, keys,
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

    it.each(['review.start', 'review.new_round', 'review.prepare_round', 'review.settle_round'] as const)(
        'admits %s requester Review records without granting unrelated Artifact mutations', async actionId => {
        const f = await fixture(actionId, false, true);
        const id = crypto.randomUUID();
        const path = `/v1/artifacts/${id}`;
        const kind = encodeArtifactKindV1({ kind: 'other', kindHint: REVIEW_ARTIFACT_KIND_V1 });
        const reviewMetadata = { projectSourceId: null, workflowId: null, subjectKind: 'repository', sourceKind: 'direct',
            state: 'running', currentRoundOrdinal: 1, startedAt: Date.now(), finishedAt: null };
        // Home verifies signed JSON grammar and non-content Review metadata;
        // the Artifact route owns access and the Account codec owns sealed bytes.
        const create = ArtifactJsonCreateHttpInputV1Schema.parse({ id, kind, reviewMetadata,
            header: 'sealed-header', body: 'sealed-body', dataEncryptionKey: 'sealed-key' });
        const update = ArtifactJsonUpdateHttpInputV1Schema.parse({ kind, reviewMetadata,
            header: 'sealed-header', body: 'sealed-body', expectedHeaderVersion: 0, expectedBodyVersion: 0 });
        expect.soft(await f.verifyRequest('GET', path)).not.toBeNull();
        expect.soft(await f.verifyRequest('POST', '/v1/artifacts', create)).not.toBeNull();
        expect.soft(await f.verifyRequest('POST', path, update)).not.toBeNull();
        const envelopes = ArtifactRecipientKeyEnvelopeCommitInputV1Schema.parse({ artifactId: id,
            expectedDataEncryptionKey: Buffer.alloc(SESSION_DATA_KEY_ENVELOPE_BYTES_V1).toString('base64'),
            recipientKeyEnvelopes: [] });
        expect.soft(await f.verifyRequest('GET', `${path}/access/recipients`)).not.toBeNull();
        expect.soft(await f.verifyRequest('POST', `${path}/access/key-envelopes`, envelopes)).not.toBeNull();
        expect(await f.verifyRequest('GET', `${path}/access/recipients?extra=1`)).toBeNull();
        expect(await f.verifyRequest('POST', `${path}/access/key-envelopes`, { ...envelopes, artifactId: 'other' })).toBeNull();
        expect(await f.verifyRequest('PUT', path, { body: 'changed' })).toBeNull();
        expect(await f.verifyRequest('GET', `${path}/access/grants`)).toBeNull();
        expect(await f.verifyRequest('GET', `${path}?extra=1`)).toBeNull();
        expect(await f.verifyRequest('POST', '/v1/artifacts', { ...create, kind: 'prompt' })).toBeNull();
        const { reviewMetadata: _reviewMetadata, ...unrelatedUpdate } = update;
        expect(await f.verifyRequest('POST', path, unrelatedUpdate)).toBeNull();
        expect(await f.verifyRequest('POST', `${path}/revisions/0/restore`, update)).toBeNull();
        expect(await f.verifyRequest('POST', path, update, undefined,
            actionId === 'review.start' ? 'review.new_round' : 'review.start')).toBeNull();
    });

    it('admits the real Review child Workflow storage adapter under its original Session proof', async () => {
        const f = await fixture('review.start', false, true);
        // Replace HTTP and the local installation lookup; retain storage, signing and server admission.
        const post = vi.spyOn(axios, 'post').mockResolvedValue({ data: null });
        const installation = vi.spyOn(currentMachineInstallation, 'readCurrentMachineInstallation').mockResolvedValue(null);
        try {
            const storage = createCliWorkflowRunStorage({ token: 'unused-daemon-token', serverHttpBaseUrl: 'https://home.test' },
                async () => null, (context, effectActionId, request) => {
                    const resolved = resolveExternalActionServerRequestHeaders({ context, effectActionId, ...request,
                        daemonToken: 'unused-daemon-token', serverIdentityId: f.authorization.binding.serverIdentityId,
                        installationId: f.machine.installationId!, privateKey: f.keys.secretKey });
                    if (!resolved.ok) throw new Error(resolved.reason);
                    return resolved.headers;
                }, value => typeof value === 'string' && value.trim() ? value.trim() : null);
            const execute = async (sessionId: string) => {
                // workflowFamily passes the actual child Action and unchanged context to this factory.
                await storage.createWorkflowRunStorage({ actionId: 'workflow.run.start', context: {
                    surface: 'ui', authority: 'present_user', externalActionExecutionAuthorization: f.authorization,
                    externalActionTarget: { kind: 'session', sessionId },
                } }).execute({ operation: 'get', runId: crypto.randomUUID() }, { publisherMachineId: f.machine.id });
                const call = post.mock.calls.at(-1)!;
                const header = (name: string) => {
                    const value: unknown = call[2]?.headers?.[name];
                    if (typeof value !== 'string') throw new Error(`Missing signed header ${name}`);
                    return value;
                };
                expect(header(EXTERNAL_ACTION_EFFECT_ACTION_HEADER)).toBe('workflow.run.start');
                expect(header(EXTERNAL_ACTION_RESOLVED_TARGET_HEADER)).toBe(encodeExternalActionResolvedTargetV1({ kind: 'session', sessionId }));
                const refusals: string[] = [];
                const verified = await verifyExternalActionDomainExecutionRequest({
                    authorizationToken: header(EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER),
                    effectActionId: header(EXTERNAL_ACTION_EFFECT_ACTION_HEADER),
                    encodedTarget: header(EXTERNAL_ACTION_RESOLVED_TARGET_HEADER),
                    machineSignature: header(EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER),
                    method: 'POST', path: new URL(call[0]).pathname, body: call[1],
                    resolveCurrentSessionMachine: async () => f.machine.id,
                    onRefusal: phase => refusals.push(phase),
                });
                expect(refusals).toEqual(sessionId === f.root.id ? [] : ['resolved_target']);
                return verified;
            };
            expect.soft(await execute(f.root.id)).not.toBeNull();
            expect(await execute(f.otherRoot.id)).toBeNull();
        } finally { post.mockRestore(); installation.mockRestore(); }
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
