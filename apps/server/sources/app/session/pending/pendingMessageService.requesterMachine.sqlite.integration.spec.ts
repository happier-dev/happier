import { randomUUID } from 'node:crypto';
import type { Socket } from 'socket.io';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodeBase64 } from 'privacy-kit';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import tweetnacl from 'tweetnacl';
import { signAccountContentKeyBindingV1 } from '@happier-dev/protocol/crypto/accountContentKeyBindingV1';
import { deriveAccountMachineKeyFromRecoverySecret } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { createMachineDataEncryptionKeyV1 } from '@happier-dev/protocol/machines/machineStoredContent';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER, API_TOKEN_FULL_GRANT_V1,
    SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1, SessionPendingEnqueueByMachineRequestV1Schema,
    SessionPendingEnqueueByMachineResponseV1Schema } from '@happier-dev/protocol';

import { auth } from '@/app/auth/auth';
import { machineUpdateHandler } from '@/app/api/socket/machineUpdateHandler';
import { VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY } from '@/app/api/socket/machineSocketInstallationProof';
import { createAuthenticatedFakeSocket, createSocketRoomDiscoveryHarness, getSocketHandler } from '@/app/api/testkit/socketHarness';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { sessionPendingRoutes } from '@/app/api/routes/session/pendingRoutes';
import { setMachineAccessGrantInTx, removeMachineAccessGrantInTx, resolveMachineAdmissionInTx } from '@/app/machines/machineAccess';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { buildSessionFollowRulePhysicalKeyV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowRuleV1';
import { normalizeSessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { encodeAccountScopedKvJson, decodeAccountScopedKvJson } from '@/app/kv/accountScopedKv';
import { observePendingSessionFollowForDestinationInTx, acknowledgeAdmittedSessionFollowInputInTx, setSessionFollowSource, authorizeSessionFollowSourceKeyPreparer, projectSessionFollowSourceForRunnerInTx } from '@/app/session/follow/sessionFollowEdgeService';
import { setSessionManager } from '@/app/session/follow/sessionManagerService';
import { admitSessionFollowRuleOccurrenceInTx } from '@/app/session/follow/sessionFollowRuleProgress';
import { removeAccountFollowRule, setAccountFollowRule } from '@/app/session/follow/accountFollowRuleService';
import { SessionFollowInputV1Schema, deriveSessionFollowInputLocalIdV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowInputV1';
import { SessionFollowRelationWitnessesV1Schema, SessionFollowSourceOccurrenceWitnessesV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowSourceOccurrenceV1';
import { buildTrustedHostSessionInputAdmissionV1, settleSessionInputRequestV1, settleSessionMessageProvenanceV1,
    withSessionInputAuthority, withSessionInputRequestV1, SESSION_MESSAGE_PROVENANCE_META_KEY } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { sealSessionFollowRuleContentV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowRuleContentCodecV1';
import { SessionFollowAdmittedInputAcknowledgeRequestV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowTransportV1';
import { SessionFollowSourceProjectionRequestV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowSourceProjectionV1';
import { hasCanonicalFollowProviderInputAcceptanceInTx } from '@/app/session/follow/providerInputAcceptance';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { serializePendingMaterializedMessage } from './serializePendingMaterializedMessage';
import { readStoredSessionInputAdmissionReceipt } from '@/app/session/messages/sessionInputAdmission';
import { enqueuePendingMessageByAuthenticatedMachine, resolveAcceptedPendingDelivery, settlePendingInputAdmission } from './pendingMessageService';
import { materializeNextPendingMessage } from './materializeNextPendingMessage';

describe('requester Session input through the custodian Machine socket', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-requester-machine-input-', initAuth: true,
            env: { HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' } });
        await getOrCreateServerIdentityId();
    }, 120_000);
    afterAll(async () => { if (harness) await harness.close(); });

    it('keeps accepted private ready custody readable after rule retirement only through the exact input and current source/pair grants', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const sourceOwner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const viewer = await db.account.create({ data: { encryptionMode: 'plain' } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id, installationId: randomUUID(),
            metadata: encodePlainMachineStoredContent({}), dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER),
            operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1] } }, operationProtocolCapabilitiesRevision: 1 } });
        const source = await db.session.create({ data: { accountId: sourceOwner.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        const destination = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain',
            active: true, lastActiveAt: new Date(1), publisherGeneration: 1n } });
        const grantSource = (accountId: string) => db.sessionShare.create({ data: { sessionId: source.id,
            sharedByUserId: sourceOwner.id, sharedWithUserId: accountId, accessLevel: 'view' } });
        await grantSource(owner.id);
        const homeId = await getOrCreateServerIdentityId();
        await db.accessKey.create({ data: { accountId: owner.id, sessionId: destination.id, machineId: machine.id, data: 'opaque' } });
        await db.session.update({ where: { id: destination.id }, data: { runtimeMachineTarget: { homeId, accountId: owner.id,
            sessionId: destination.id, machineId: machine.id, installationId: machine.installationId! } } });
        const receiver = { kind: 'session' as const, sessionId: destination.id };
        const authentication = createPresentUserSessionAccessAuthentication();
        const ruleId = 'private-retired-ready-rule';
        const content = sealSessionFollowRuleContentV1({ mode: 'plain', receiver, ruleId, material: null,
            definition: { v: 1, enabled: true, filter: normalizeSessionListFilterV1(), policy: { preset: 'important' } } });
        expect(await setAccountFollowRule({ accountId: owner.id, authentication, ruleId,
            mutation: { receiver, content, expectedVersion: -1 } })).toMatchObject({ ok: true });
        const readyContent = { t: 'plain' as const, v: { role: 'agent', content: { type: 'event',
            data: { type: 'ready', completedTurnId: 'source-completed-turn' } } } };
        const finalContent = { t: 'plain' as const, v: { role: 'agent', content: { type: 'text', text: 'Finished private work' } } };
        const sourceTurn = { id: 'source-completed-turn', status: 'completed' as const };
        const terminalAt = BigInt(Date.now());
        await db.sessionTurn.create({ data: { sessionId: source.id, turnId: 'source-completed-turn', status: 'completed',
            startedAt: terminalAt, updatedAt: terminalAt, terminalAt,
            transcriptAnchorsJson: JSON.stringify({ startSeqInclusive: 1, endSeqInclusive: 3, finalAssistantMessageSeq: 2 }) } });
        await db.sessionMessage.create({ data: { sessionId: source.id, localId: 'source-start', seq: 1,
            messageRole: 'user', content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'source work' } } },
            inputAdmissionReceipt: { v: 1, issuer: 'authenticatedAccount', actorAccountId: sourceOwner.id, sessionRelationship: 'owner' },
            acceptedTurnId: 'source-completed-turn', acceptedTurnKind: 'newTurn', turnStartWitnessId: 'source-completed-turn' } });
        await db.sessionMessage.create({ data: { sessionId: source.id, localId: 'private-final-result', seq: 2,
            messageRole: 'agent', content: finalContent } });
        const sourceMessage = { localId: 'private-ready-original', seq: 3 };
        await db.sessionMessage.create({ data: { sessionId: source.id, ...sourceMessage,
            messageRole: 'agent', content: readyContent } });
        await db.session.update({ where: { id: source.id }, data: { seq: 3, latestReadyEventSeq: 3,
            latestTurnId: 'source-completed-turn', latestTurnStatus: 'completed' } });
        const delivery = SessionFollowInputV1Schema.parse({ v: 1, delivery: 'next_turn', event: { kind: 'finished' },
            original: { sourceSessionId: source.id, sourceTurn } });
        const localId = deriveSessionFollowInputLocalIdV1({ destinationSessionId: destination.id, original: delivery.original });
        const host = buildTrustedHostSessionInputAdmissionV1('agent');
        const token = await auth.createToken(owner.id, undefined, { kind: 'account', authority: 'present_user' });
        await withAuthenticatedTestApp(sessionPendingRoutes, async app => {
            const enqueue = await app.inject({ method: 'POST', url: `/v2/sessions/${destination.id}/pending`,
                headers: { authorization: `Bearer ${token}` }, payload: { localId, targetMachineId: machine.id,
                    followDeliveryV1: delivery, followSources: [{ evaluation: 'receiver', selectedDelivery: 'next_turn', destinationSessionId: destination.id,
                        sourceSessionId: source.id, sourceTurn, rule: { ruleId, ruleVersion: 0 } }],
                    content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'finished source' },
                        meta: withSessionInputRequestV1({ [SESSION_MESSAGE_PROVENANCE_META_KEY]: host.provenance },
                            { ...host.request, followDeliveryV1: delivery }) } } } });
            expect(enqueue.statusCode, enqueue.body).toBe(200);
            const publisherAuthority = { accountId: owner.id, sessionId: destination.id, machineId: machine.id, committedFence: new Date(1) };
            const accept = async (inputId: string) => {
                expect(await materializeNextPendingMessage({ actorUserId: owner.id, sessionId: destination.id, publisherAuthority,
                    deliveryState: 'provider', deliveryTiming: 'after_foreground_ready', foregroundState: 'ready' }))
                    .toMatchObject({ ok: true, didMaterialize: true });
                expect(await resolveAcceptedPendingDelivery({ actorUserId: owner.id, sessionId: destination.id, publisherAuthority,
                    localId: inputId, acceptedTurn: { kind: 'followUp', turnId: 'receiver-turn' },
                    acceptedDelivery: { t: 'plain', v: { v: 1, acceptedAtMs: 1, delivery: { kind: 'followUp', turnId: 'receiver-turn' } } } }))
                    .toMatchObject({ ok: true, didResolve: true });
            };
            await accept(localId);
            const unrelatedId = 'unrelated-accepted-input';
            const unrelated = await app.inject({ method: 'POST', url: `/v2/sessions/${destination.id}/pending`,
                headers: { authorization: `Bearer ${token}` }, payload: { localId: unrelatedId,
                    targetMachineId: machine.id, content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'ordinary input' } } } } });
            expect(unrelated.statusCode, unrelated.body).toBe(200);
            await accept(unrelatedId);
            const publicKey = new Uint8Array(32).fill(9);
            const runner = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id, metadata: '{}',
                kind: 'ephemeral_session_runner', installationId: randomUUID(), installationPublicKey: publicKey } });
            await db.accessKey.create({ data: { accountId: owner.id, machineId: runner.id, sessionId: destination.id, data: 'opaque' } });
            const activationId = randomUUID();
            await db.ephemeralRunnerActivation.create({ data: { id: activationId, creatorAccountId: owner.id,
                creatorTokenEpoch: owner.tokenEpoch, draftId: randomUUID(), sessionId: destination.id, machineId: runner.id,
                state: 'materialized', workspacePolicy: 'choose_on_endpoint', homeServerIdentityId: homeId,
                activationSigningPublicKey: 'a'.repeat(43), authoringCommitment: 'b'.repeat(43), artifact: {}, endpointFactsRecipient: {} } });
            const principal = { kind: 'ephemeral_session_runner' as const, authority: 'session_runtime' as const,
                accountId: owner.id, activationId, sessionId: destination.id, machineId: runner.id,
                installationId: runner.installationId!, installationPublicKey: encodeBase64(publicKey, 'base64url'),
                creatorTokenEpoch: owner.tokenEpoch };
            const project = (inputId = localId) => inTx(tx => projectSessionFollowSourceForRunnerInTx(tx, { principal,
                destinationSessionId: destination.id, request: SessionFollowSourceProjectionRequestV1Schema.parse({
                    v: 1, sourceSessionId: source.id, localInputId: inputId,
                    afterTranscriptSeq: 0, observedTranscriptSeq: 0, limit: 1 }) }));
            expect(await project()).toMatchObject({ source: { id: source.id }, messages: [{ seq: 2, content: finalContent }] });
            expect(await removeAccountFollowRule({ accountId: owner.id, authentication, ruleId, receiver, expectedVersion: 0 }))
                .toMatchObject({ ok: true });
            const projected = await project();
            expect(projected).toMatchObject({ source: { id: source.id }, messages: [{ seq: 2, content: finalContent }] });
            expect(JSON.stringify(projected)).not.toContain(ruleId);
            expect(await project(unrelatedId)).toBeNull();
            expect(await project('missing-input')).toBeNull();
            await db.sessionShare.deleteMany({ where: { sessionId: source.id, sharedWithUserId: owner.id } });
            expect(await project()).toBeNull();
            await grantSource(owner.id);
            expect(await project()).not.toBeNull();
            await grantSource(viewer.id);
            await db.sessionShare.create({ data: { sessionId: destination.id, sharedByUserId: owner.id,
                sharedWithUserId: viewer.id, accessLevel: 'view' } });
            expect(await project()).not.toBeNull();
            await db.sessionShare.deleteMany({ where: { sessionId: source.id, sharedWithUserId: viewer.id } });
            expect(await project()).toBeNull();
            await grantSource(viewer.id);
            expect(await project()).not.toBeNull();
        }, { authentication: 'real' });
    });

    it.each(['exact', 'missing_turn', 'changed_turn', 'stale_attachment'] as const)(
        'settles only exact manager waiting custody at native acceptance without an optional ACK (%s)', async scenario => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id, installationId: randomUUID(),
            metadata: encodePlainMachineStoredContent({}), dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER),
            operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1] } }, operationProtocolCapabilitiesRevision: 1 } });
        const source = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        const destination = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain',
            active: true, lastActiveAt: new Date(1), publisherGeneration: 1n } });
        const homeId = await getOrCreateServerIdentityId();
        await db.accessKey.create({ data: { accountId: owner.id, sessionId: destination.id, machineId: machine.id, data: 'opaque' } });
        await db.session.update({ where: { id: destination.id }, data: { runtimeMachineTarget: { homeId, accountId: owner.id,
            sessionId: destination.id, machineId: machine.id, installationId: machine.installationId! } } });
        const authentication = createPresentUserSessionAccessAuthentication();
        expect(await setSessionManager({ accountId: owner.id, sessionId: source.id, managerSessionId: destination.id,
            expectedManagerSessionId: null, authentication })).toMatchObject({ ok: true });
        const manager = await db.sessionFollowEdge.findUniqueOrThrow({ where: { managerSourceSessionId: source.id } });
        await db.sessionTurn.create({ data: { sessionId: source.id, turnId: 'waiting-turn', status: 'waiting', startedAt: 1n, updatedAt: 2n } });
        await db.session.update({ where: { id: source.id }, data: { agentStateVersion: 1, latestTurnId: 'waiting-turn', latestTurnStatus: 'waiting',
            agentState: JSON.stringify({ requests: { q: { createdAt: 3, turnId: 'waiting-turn' } } }) } });
        const original = { sourceSessionId: source.id, sourceRequests: { agentStateVersion: 1,
            requests: [{ requestId: 'q', createdAt: 3, ...(scenario === 'missing_turn' ? {} : { turnId: 'waiting-turn' }) }] } };
        const delivery = SessionFollowInputV1Schema.parse({ v: 1, original, delivery: 'wake',
            requestEvents: [{ requestId: 'q', event: { kind: 'needs_you', type: 'decision' } }] });
        const localId = deriveSessionFollowInputLocalIdV1({ destinationSessionId: destination.id, original });
        const host = buildTrustedHostSessionInputAdmissionV1('agent');
        const token = await auth.createToken(owner.id, undefined, { kind: 'account', authority: 'present_user' });
        await withAuthenticatedTestApp(sessionPendingRoutes, async app => {
            const enqueue = await app.inject({ method: 'POST', url: `/v2/sessions/${destination.id}/pending`,
                headers: { authorization: `Bearer ${token}` }, payload: { localId, targetMachineId: machine.id,
                    followRelations: [{ relation: 'manager', attachedAt: manager.attachedAt.getTime() }], followDeliveryV1: delivery,
                    content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'current question' },
                        meta: withSessionInputRequestV1({ [SESSION_MESSAGE_PROVENANCE_META_KEY]: host.provenance },
                            { ...host.request, followDeliveryV1: delivery }) } } } });
            expect(enqueue.statusCode, enqueue.body).toBe(200);
            const publisherAuthority = { accountId: owner.id, sessionId: destination.id, machineId: machine.id, committedFence: new Date(1) };
            expect(await materializeNextPendingMessage({ actorUserId: owner.id, sessionId: destination.id, publisherAuthority,
                deliveryState: 'provider', deliveryTiming: 'after_foreground_ready', foregroundState: 'ready' }))
                .toMatchObject({ ok: true, didMaterialize: true });
            if (scenario === 'changed_turn') await db.session.update({ where: { id: source.id }, data: { latestTurnId: 'other-turn' } });
            if (scenario === 'stale_attachment') await db.sessionFollowEdge.update({ where: { managerSourceSessionId: source.id },
                data: { attachedAt: new Date(manager.attachedAt.getTime() + 1) } });
            const accepted = await resolveAcceptedPendingDelivery({ actorUserId: owner.id, sessionId: destination.id, publisherAuthority,
                localId, acceptedTurn: { kind: 'followUp', turnId: 'receiver-turn' },
                acceptedDelivery: { t: 'plain', v: { v: 1, acceptedAtMs: 1, delivery: { kind: 'followUp', turnId: 'receiver-turn' } } } });
            if (scenario === 'exact' || scenario === 'missing_turn') expect(accepted).toMatchObject({ ok: true, didResolve: true });
            expect(await db.sessionFollowEdge.findUniqueOrThrow({ where: { managerSourceSessionId: source.id } }))
                .toMatchObject({ deliveredTurnId: scenario === 'exact' ? 'waiting-turn' : null,
                    deliveredTurnStatus: scenario === 'exact' ? 'waiting' : null,
                    deliveredTranscriptSeq: 0, deliveredAgentStateVersion: 0 });
        }, { authentication: 'real' });
    });

    it.each(['message', 'requests'] as const)('admits only rule originals at or after the rule inception (%s)', async kind => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const source = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(),
            metadata: '{}', encryptionMode: 'plain', seq: 2, agentStateVersion: 1 } });
        const destination = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(),
            metadata: '{}', encryptionMode: 'plain' } });
        const receiver = { kind: 'session' as const, sessionId: destination.id };
        const authentication = createPresentUserSessionAccessAuthentication();
        const content = sealSessionFollowRuleContentV1({ mode: 'plain', receiver, ruleId: 'inception-rule',
            material: null, definition: { v: 1, enabled: true, filter: normalizeSessionListFilterV1(),
                policy: { preset: 'important' } } });
        const created = await setAccountFollowRule({ accountId: owner.id, authentication, ruleId: 'inception-rule',
            mutation: { receiver, content, expectedVersion: -1 } });
        expect(created).toMatchObject({ ok: true });
        if (!created.ok || !created.value.rule.inception) throw new Error('Expected server-stamped rule inception');
        const inceptionCreatedAt = created.value.rule.inception.createdAt;
        await db.sessionMessage.create({ data: { sessionId: source.id, localId: 'before-rule', seq: 1,
            createdAt: new Date(1), messageRole: 'agent', content: { t: 'plain', v: { role: 'agent', content: [] } } } });
        await db.sessionMessage.create({ data: { sessionId: source.id, localId: 'after-rule', seq: 2,
            createdAt: new Date(inceptionCreatedAt), messageRole: 'agent', content: { t: 'plain', v: { role: 'agent', content: [] } } } });
        const witness = { evaluation: 'receiver' as const, selectedDelivery: kind === 'message' ? 'next_turn' as const : 'wake' as const, destinationSessionId: destination.id,
            sourceSessionId: source.id, rule: { ruleId: 'inception-rule', ruleVersion: 0 } };
        const admit = (original: { sourceMessage: { localId: string; seq: number } }
            | { sourceRequests: { agentStateVersion: number; requests: { requestId: string; createdAt: number }[] } }) =>
            inTx(tx => admitSessionFollowRuleOccurrenceInTx(tx, { accountId: owner.id,
                authority: { kind: 'account', authentication }, witness: { ...witness, ...original } }));
        expect(await admit(kind === 'message' ? { sourceMessage: { localId: 'before-rule', seq: 1 } }
            : { sourceRequests: { agentStateVersion: 1, requests: [{ requestId: 'old-question', createdAt: 1 }] } })).toBeNull();
        expect(await admit(kind === 'message' ? { sourceMessage: { localId: 'after-rule', seq: 2 } }
            : { sourceRequests: { agentStateVersion: 1, requests: [{ requestId: 'new-question', createdAt: inceptionCreatedAt }] } }))
            .not.toBeNull();
        if (kind === 'requests') expect(await admit({ sourceRequests: { agentStateVersion: 1, requests: [
            { requestId: 'old-question', createdAt: 1 }, { requestId: 'new-question', createdAt: Date.now() },
        ] } })).toBeNull();
    });

    it.each([{ mode: 'plain', preset: 'quiet' }, { mode: 'e2ee', preset: 'quiet' },
        { mode: 'plain', preset: 'important' }] as const)('merges a newly selected stronger private route into the same unaccepted ordinary original ($mode, $preset)', async ({ mode, preset }) => {
        const signing = tweetnacl.sign.keyPair();
        const material = { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) };
        const contentKey = tweetnacl.box.keyPair.fromSecretKey(deriveAccountMachineKeyFromRecoverySecret(material.secret)).publicKey;
        const owner = await db.account.create({ data: { encryptionMode: mode, ...(mode === 'e2ee' ? {
            publicKey: Buffer.from(signing.publicKey).toString('hex'), contentPublicKey: new Uint8Array(contentKey),
            contentPublicKeySig: new Uint8Array(signAccountContentKeyBindingV1({ accountSigningSecretKey: signing.secretKey, contentPublicKey: contentKey })),
        } : {}) } });
        const machineDataKey = mode === 'plain' ? decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER)
            : new Uint8Array(createMachineDataEncryptionKeyV1({ material, randomBytes: tweetnacl.randomBytes }).dataEncryptionKey);
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id, installationId: randomUUID(),
            metadata: mode === 'plain' ? encodePlainMachineStoredContent({}) : 'opaque-encrypted-machine',
            dataEncryptionKey: machineDataKey,
            operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1] } }, operationProtocolCapabilitiesRevision: 1 } });
        const source = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain', seq: 0 } });
        const destination = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: '{}', encryptionMode: mode } });
        const homeId = await getOrCreateServerIdentityId();
        await db.accessKey.create({ data: { accountId: owner.id, sessionId: destination.id, machineId: machine.id, data: 'opaque' } });
        await db.session.update({ where: { id: destination.id }, data: { runtimeMachineTarget: { homeId, accountId: owner.id,
            sessionId: destination.id, machineId: machine.id, installationId: machine.installationId! } } });
        const authentication = createPresentUserSessionAccessAuthentication();
        expect(await setSessionFollowSource({ accountId: owner.id, sourceSessionId: source.id, destinationSessionId: destination.id,
            policy: { preset }, authentication })).toMatchObject({ ok: true });
        const receiver = { kind: 'session' as const, sessionId: destination.id };
        const content = sealSessionFollowRuleContentV1({ mode, receiver, ruleId: 'private-rule-0',
            material: mode === 'plain' ? null : material,
            definition: { v: 1, enabled: true, filter: normalizeSessionListFilterV1(), policy: { preset: 'important' } } });
        const mutation = { receiver, content };
        // The rule predates the original. Only its evaluation is delayed, so
        // this case makes no claim about a first-encounter/history baseline.
        expect(await setAccountFollowRule({ accountId: owner.id, authentication, ruleId: 'private-rule-0',
            mutation: { ...mutation, expectedVersion: -1 } })).toMatchObject({ ok: true });
        expect(await setAccountFollowRule({ accountId: owner.id, authentication, ruleId: 'private-rule-0',
            mutation: { ...mutation, expectedVersion: 0 } })).toMatchObject({ ok: true });
        await db.sessionMessage.create({ data: { sessionId: source.id, localId: 'source-original', seq: 7, messageRole: 'agent',
            content: { t: 'plain', v: { role: 'agent', content: [] } } } });
        await db.session.update({ where: { id: source.id }, data: { seq: 7 } });
        const terminalAt = BigInt(Date.now());
        const sourceTurn = { id: 'source-original-turn', status: 'failed' as const };
        await db.sessionTurn.create({ data: { sessionId: source.id, turnId: sourceTurn.id, status: sourceTurn.status,
            startedAt: terminalAt, updatedAt: terminalAt, terminalAt } });
        const relations = SessionFollowRelationWitnessesV1Schema.parse([{ relation: 'follower' }]);
        const original = { sourceSessionId: source.id, sourceTurn };
        const quiet = SessionFollowInputV1Schema.parse({ v: 1, original, delivery: preset === 'quiet' ? 'next_turn' : 'wake', event: { kind: 'failed_or_stopped' } });
        const important = SessionFollowInputV1Schema.parse({ ...quiet, delivery: 'wake' });
        const localId = deriveSessionFollowInputLocalIdV1({ destinationSessionId: destination.id, original });
        const token = await auth.createToken(owner.id, undefined, { kind: 'account', authority: 'present_user' });
        const host = buildTrustedHostSessionInputAdmissionV1('agent');
        const payload = (delivery: typeof quiet) => ({ localId, targetMachineId: machine.id, followRelations: relations,
            followDeliveryV1: delivery, content: mode === 'e2ee'
                // The paired producer uses the real Session cipher. This Home
                // boundary must preserve, not open or reinterpret, its bytes.
                ? { t: 'encrypted', c: `opaque-follow-${delivery.delivery}` }
                : { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'selected original' },
                meta: withSessionInputRequestV1({ [SESSION_MESSAGE_PROVENANCE_META_KEY]: host.provenance },
                    { ...host.request, followDeliveryV1: delivery }) } } });
        await withAuthenticatedTestApp(sessionPendingRoutes, async app => {
            const initial = await app.inject({ method: 'POST', url: `/v2/sessions/${destination.id}/pending`,
                headers: { authorization: `Bearer ${token}` }, payload: payload(quiet) });
            expect(initial.statusCode).toBe(200);
            const initialPending = await db.sessionPendingMessage.findUniqueOrThrow({ where: { sessionId_localId: {
                sessionId: destination.id, localId } } });
            expect(initialPending.inputAdmissionReceipt).toMatchObject({ followRelations: relations,
                followDeliveryV1: quiet });
            const sources = SessionFollowSourceOccurrenceWitnessesV1Schema.parse([{ evaluation: 'receiver', selectedDelivery: 'wake',
                ...original, destinationSessionId: destination.id, rule: { ruleId: 'private-rule-0', ruleVersion: 1 } }]);
            const late = await app.inject({ method: 'POST', url: `/v2/sessions/${destination.id}/pending`,
                headers: { authorization: `Bearer ${token}` }, payload: { ...payload(important), followSources: sources } });
            expect(late.statusCode, late.body).toBe(200);
            expect(await db.sessionPendingMessage.count({ where: { sessionId: destination.id } })).toBe(1);
            const pending = await db.sessionPendingMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: destination.id, localId } } });
            expect(pending.inputAdmissionReceipt).toMatchObject({ issuer: 'authenticatedAccount', followRelations: relations,
                followSources: sources, followDeliveryV1: important });
            expect(pending).toMatchObject({ localId, position: initialPending.position, createdAt: initialPending.createdAt,
                providerAction: null, deliveryState: initialPending.deliveryState, deliveryBlockedReason: initialPending.deliveryBlockedReason });
            expect(pending.content).toMatchObject(mode === 'e2ee' ? payload(important).content : { t: 'plain', v: { meta: {
                happierInputRequestV1: { followDeliveryV1: important } } } });
            expect(await db.sessionMessage.count({ where: { sessionId: destination.id } })).toBe(0);
            const enqueueLate = (candidate: unknown, candidateToken = token) => app.inject({ method: 'POST',
                url: `/v2/sessions/${destination.id}/pending`, headers: { authorization: `Bearer ${candidateToken}` }, payload: candidate });
            const unchanged = await enqueueLate({ ...payload(important), followSources: sources });
            expect(unchanged.statusCode).toBe(200);
            expect(unchanged.json()).toMatchObject({ didWrite: false });
            expect((await enqueueLate({ ...payload(important), followSources: [{ ...sources[0],
                rule: { ruleId: 'private-rule-0', ruleVersion: 0 } }] })).statusCode).toBe(403);
            const foreign = await db.account.create({ data: { encryptionMode: mode } });
            const foreignToken = await auth.createToken(foreign.id, undefined, { kind: 'account', authority: 'present_user' });
            expect([403, 404]).toContain((await enqueueLate({ ...payload(important), followSources: sources }, foreignToken)).statusCode);
            await db.sessionMessage.create({ data: { sessionId: source.id, localId: 'different-original', seq: 8, messageRole: 'agent',
                content: { t: 'plain', v: { role: 'agent', content: [] } } } });
            await db.session.update({ where: { id: source.id }, data: { seq: 8 } });
            const otherTurn = { id: 'different-original-turn', status: 'failed' as const };
            await db.sessionTurn.create({ data: { sessionId: source.id, turnId: otherTurn.id, status: otherTurn.status,
                startedAt: terminalAt, updatedAt: terminalAt, terminalAt } });
            const otherOriginal = { sourceSessionId: source.id, sourceTurn: otherTurn };
            expect((await enqueueLate({ ...payload(SessionFollowInputV1Schema.parse({ ...important, original: otherOriginal })), followSources: [{ ...sources[0],
                sourceTurn: otherOriginal.sourceTurn }] })).statusCode).toBe(400);
            const publisherAuthority = { accountId: owner.id, sessionId: destination.id, machineId: machine.id, committedFence: new Date(1) };
            await db.session.update({ where: { id: destination.id }, data: { active: true, lastActiveAt: new Date(1), publisherGeneration: 1n } });
            expect(await materializeNextPendingMessage({ actorUserId: owner.id, sessionId: destination.id, publisherAuthority,
                deliveryState: 'provider', deliveryTiming: 'after_foreground_ready', foregroundState: 'ready' }))
                .toMatchObject({ ok: true, didMaterialize: true });
            const claimed = await db.sessionPendingMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: destination.id, localId } } });
            expect(claimed.providerAction).not.toBeNull();
            expect((await enqueueLate(payload(quiet))).statusCode).toBe(400);
            expect(await db.sessionPendingMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: destination.id, localId } } })).toEqual(claimed);
            const request = { ...host.request, followDeliveryV1: important };
            const claimedReceipt = readStoredSessionInputAdmissionReceipt(claimed.inputAdmissionReceipt)!;
            const finalContent = mode === 'e2ee'
                // Home preserves the host's sealed authority without opening it.
                ? { t: 'encrypted' as const, c: 'opaque-host-settled-original' }
                : { t: 'plain' as const, v: { role: 'user', content: { type: 'text', text: 'selected original' }, meta: {
                    ...withSessionInputAuthority(withSessionInputRequestV1({ [SESSION_MESSAGE_PROVENANCE_META_KEY]: host.provenance }, request),
                        settleSessionInputRequestV1({ request, inputAdmissionReceipt: claimedReceipt, currentSessionPermissionCeiling: 'default' })),
                    [SESSION_MESSAGE_PROVENANCE_META_KEY]: settleSessionMessageProvenanceV1({ request,
                        requestedProvenance: host.provenance, inputAdmissionReceipt: claimedReceipt }),
                } } };
            expect(await settlePendingInputAdmission({ actorUserId: owner.id, sessionId: destination.id, localId,
                publisherAuthority, decision: { kind: 'admit', finalContent } })).toMatchObject({ ok: true, result: { status: 'accepted' } });
            const settled = await db.sessionPendingMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: destination.id, localId } } });
            const retry = await enqueueLate({ ...payload(important), followSources: sources });
            expect(retry.statusCode, retry.body).toBe(200);
            expect(retry.json()).toMatchObject({ didWrite: false });
            expect((await enqueueLate({ ...payload(important), followSources: sources,
                content: mode === 'e2ee' ? { t: 'plain', v: { role: 'user' } } : { t: 'encrypted', c: 'wrong-mode' } })).statusCode).toBe(400);
            expect((await enqueueLate({ ...payload(important), followSources: [{ ...sources[0],
                rule: { ruleId: 'private-rule-0', ruleVersion: 0 } }] })).statusCode).toBe(403);
            expect((await enqueueLate(payload(quiet))).statusCode).toBe(400);
            const changedContent = mode === 'e2ee'
                ? { t: 'encrypted', c: 'different-original-content' }
                : { t: 'plain', v: { ...(payload(important).content as { v: object }).v,
                    content: { type: 'text', text: 'different original content' } } };
            const changedRetry = await enqueueLate({ ...payload(important), followSources: sources, content: changedContent });
            expect(await db.sessionPendingMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: destination.id, localId } } })).toEqual(settled);
            if (mode === 'e2ee') {
                // Account Follow retries carry no equality tag. Re-encryption
                // of the same source original rejoins immutable custody only.
                expect(changedRetry.statusCode, changedRetry.body).toBe(200);
                expect(changedRetry.json()).toMatchObject({ didWrite: false });
            } else {
                expect(changedRetry.statusCode, changedRetry.body).toBe(400);
                expect(changedRetry.json()).toMatchObject({ code: 'session_input_idempotency_conflict' });
            }
            expect(await resolveAcceptedPendingDelivery({ actorUserId: owner.id, sessionId: destination.id, publisherAuthority,
                localId, acceptedTurn: { kind: 'followUp', turnId: 'accepted-original' },
                // As with the encrypted input above, Home preserves this
                // producer-owned ciphertext without opening it.
                acceptedDelivery: mode === 'e2ee' ? { t: 'encrypted', c: 'opaque-accepted-original' }
                    : { t: 'plain', v: { v: 1, acceptedAtMs: 1, delivery: { kind: 'followUp', turnId: 'accepted-original' } } } }))
                .toMatchObject({ ok: true, didResolve: true });
            expect((await enqueueLate({ ...payload(important), followSources: sources })).statusCode).toBe(200);
            expect(await db.sessionPendingMessage.count({ where: { sessionId: destination.id } })).toBe(0);
            expect(await db.sessionMessage.count({ where: { sessionId: destination.id } })).toBe(1);
        }, { authentication: 'real' });
    });

    it('binds a prepared Follow input to its original message and authenticated source Machine without fabricating a source turn', async () => {
        const owner = await db.account.create({ data: { publicKey: `follow-${randomUUID()}`, encryptionMode: 'plain' } });
        const createMachine = () => db.machine.create({ data: {
            id: randomUUID(), accountId: owner.id, installationId: randomUUID(), metadata: encodePlainMachineStoredContent({}),
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER),
            operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1] } }, operationProtocolCapabilitiesRevision: 1,
        } });
        const sourceMachine = await createMachine();
        const targetMachine = await createMachine();
        const source = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: '{}',
            encryptionMode: 'plain', seq: 0, publisherGeneration: 1n } });
        const destination = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        const homeId = await getOrCreateServerIdentityId();
        for (const [session, machine] of [[source, sourceMachine], [destination, targetMachine]] as const) {
            await db.accessKey.create({ data: { accountId: owner.id, sessionId: session.id, machineId: machine.id, data: 'opaque' } });
            await db.session.update({ where: { id: session.id }, data: { runtimeMachineTarget: {
                accountId: owner.id, sessionId: session.id, machineId: machine.id, installationId: machine.installationId!, homeId,
            } } });
        }
        await db.userKVStore.create({ data: { accountId: owner.id, key: buildSessionFollowRulePhysicalKeyV1('follow-rule'), version: 0,
            value: decodeBase64(encodeAccountScopedKvJson({ version: 0, receiver: { kind: 'session', sessionId: destination.id },
                content: { t: 'plain', v: { v: 1, enabled: true, filter: normalizeSessionListFilterV1(), policy: { preset: 'important' } } } })!) } });
        const authentication = createPresentUserSessionAccessAuthentication();
        expect(await setSessionManager({ accountId: owner.id, sessionId: source.id, managerSessionId: destination.id,
            expectedManagerSessionId: null, authentication })).toMatchObject({ ok: true });
        expect(await setSessionFollowSource({ accountId: owner.id, sourceSessionId: source.id, destinationSessionId: destination.id,
            policy: { preset: 'important' }, authentication })).toMatchObject({ ok: true });
        const manager = await db.sessionFollowEdge.findUniqueOrThrow({ where: { managerSourceSessionId: source.id } });
        await db.sessionMessage.create({ data: { sessionId: source.id, localId: 'original-finished', seq: 1,
            content: { t: 'plain', v: { role: 'agent', content: [] } }, messageRole: 'agent' } });
        await db.session.update({ where: { id: source.id }, data: { seq: 1 } });
        const token = await auth.createToken(owner.id, undefined, { kind: 'account', authority: 'present_user' });
        const witness = { destinationSessionId: destination.id, selectedDelivery: 'next_turn' as const, rule: { ruleId: 'follow-rule', ruleVersion: 0 },
            sourceSessionId: source.id, expectedSourcePublisherGeneration: '1', sourceMessage: { localId: 'original-finished', seq: 1 },
            machineId: sourceMachine.id, installationId: sourceMachine.installationId! };
        const followDeliveryV1 = { v: 1, delivery: 'next_turn', original: { sourceSessionId: source.id,
            sourceMessage: witness.sourceMessage }, event: { kind: 'update_posted' } };
        const host = buildTrustedHostSessionInputAdmissionV1('agent');
        const enqueue = async (localId: string, followSources: unknown, includeRelations = true, delivery = followDeliveryV1,
            text = 'selected original') => {
            const socket = Object.assign(createAuthenticatedFakeSocket({ nsp: { server: createSocketRoomDiscoveryHarness(async () => []) },
                data: { clientType: 'machine-scoped', machineId: sourceMachine.id,
                [VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY]: sourceMachine.installationId } }), { handshake: { auth: { token } } });
            machineUpdateHandler(owner.id, socket as unknown as Socket, { operationSocketBatchLimits: {
                ok: true, limits: { maxItems: 200, maxSerializedBytes: 524_288 },
            } });
            let response: unknown;
            await getSocketHandler(socket, SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1)({ v: 1, sessionId: destination.id,
                targetMachineId: targetMachine.id, localId, content: { t: 'plain', v: { role: 'user', content: { type: 'text', text },
                    meta: withSessionInputRequestV1({ [SESSION_MESSAGE_PROVENANCE_META_KEY]: host.provenance },
                        { ...host.request, followDeliveryV1: SessionFollowInputV1Schema.parse(delivery) }) } },
                requestedAction: { v: 1, kind: 'enqueue' }, followSources, followDeliveryV1: delivery,
                ...(includeRelations ? { followRelations: [{ relation: 'follower' }, { relation: 'manager', attachedAt: manager.attachedAt.getTime() }] } : {}) }, (value: unknown) => { response = value; });
            return SessionPendingEnqueueByMachineResponseV1Schema.parse(response).result;
        };
        expect(await enqueue('valid-follow', [witness])).toEqual({ status: 'accepted', localId: 'valid-follow' });
        expect((await db.sessionPendingMessage.findUniqueOrThrow({ where: { sessionId_localId: {
            sessionId: destination.id, localId: 'valid-follow' } } })).inputAdmissionReceipt).toMatchObject({
            issuer: 'authenticatedMachine', followSources: [witness],
        });
        const principal = { kind: 'destination_runtime' as const, destinationRuntimeAccountId: owner.id,
            authentication: createPresentUserSessionAccessAuthentication() };
        const observation = await inTx(tx => observePendingSessionFollowForDestinationInTx(tx, {
            principal, destinationSessionId: destination.id, inputLocalIds: ['valid-follow'],
        }));
        expect(observation.observations).toContainEqual(expect.objectContaining({ kind: 'admitted_input',
            localInputId: 'valid-follow', delivery: followDeliveryV1 }));
        expect(JSON.stringify(observation)).not.toContain('follow-rule');
        const pending = await db.sessionPendingMessage.findUniqueOrThrow({ where: { sessionId_localId: {
            sessionId: destination.id, localId: 'valid-follow' } } });
        expect(JSON.stringify(serializePendingMaterializedMessage({ ...pending, id: pending.id, seq: null,
            messageRole: 'user', content: { t: 'plain', v: {} }, providerAction: pending.providerAction ?? undefined,
            requestedAction: pending.requestedAction ?? undefined,
            inputAdmissionReceipt: readStoredSessionInputAdmissionReceipt(pending.inputAdmissionReceipt) }, { nativeAdmission: true })))
            .not.toContain('follow-rule');
        expect(await enqueue('forged-original', [{ ...witness, sourceMessage: { ...witness.sourceMessage, seq: 2 } }])).toMatchObject({ status: 'rejected' });
        expect(await enqueue('forged-source-machine', [{ ...witness, machineId: targetMachine.id }])).toMatchObject({ status: 'rejected' });
        expect(await enqueue('stale-rule', [{ ...witness, rule: { ...witness.rule, ruleVersion: 1 } }])).toMatchObject({ status: 'rejected' });
        expect(await enqueue('duplicate-route', [witness, witness])).toMatchObject({ status: 'rejected' });
        expect(await db.sessionPendingMessage.count({ where: { sessionId: destination.id } })).toBe(1);
        const expected = { transcriptSeq: 0, readyEventSeq: 0, agentStateVersion: 0, turn: null };
        const observed = { ...expected, transcriptSeq: 1 };
        const ack = SessionFollowAdmittedInputAcknowledgeRequestV1Schema.parse({ v: 1, destinationSessionId: destination.id,
            sourceSessionId: source.id, localInputId: 'valid-follow', expectedPublisherGeneration: '1', expected, observed, consumed: observed,
            acceptance: { kind: 'admitted_input', localInputId: 'valid-follow', userMessageSeq: null } });
        await db.session.update({ where: { id: destination.id }, data: { active: true, lastActiveAt: new Date(1), publisherGeneration: 1n } });
        expect(await inTx(tx => acknowledgeAdmittedSessionFollowInputInTx(tx, { principal, request: ack })))
            .toEqual({ ok: false, rejection: 'provider_acceptance_unverified' });
        const publisherAuthority = { accountId: owner.id, sessionId: destination.id, machineId: targetMachine.id, committedFence: new Date(1) };
        expect(await materializeNextPendingMessage({ actorUserId: owner.id, sessionId: destination.id, publisherAuthority,
            deliveryState: 'provider', deliveryTiming: 'after_foreground_ready', foregroundState: 'ready' })).toMatchObject({ ok: true, didMaterialize: true });
        const request = { ...host.request, followDeliveryV1: SessionFollowInputV1Schema.parse(followDeliveryV1) };
        const inputAdmissionReceipt = readStoredSessionInputAdmissionReceipt(pending.inputAdmissionReceipt)!;
        const finalContent = { t: 'plain' as const, v: { role: 'user', content: { type: 'text', text: 'selected original' }, meta: {
            ...withSessionInputAuthority(withSessionInputRequestV1({ [SESSION_MESSAGE_PROVENANCE_META_KEY]: host.provenance }, request),
                settleSessionInputRequestV1({ request, inputAdmissionReceipt, currentSessionPermissionCeiling: 'default' })),
            [SESSION_MESSAGE_PROVENANCE_META_KEY]: settleSessionMessageProvenanceV1({ request,
                requestedProvenance: host.provenance, inputAdmissionReceipt }),
        } } };
        expect(await settlePendingInputAdmission({ actorUserId: owner.id, sessionId: destination.id, localId: 'valid-follow',
            publisherAuthority, decision: { kind: 'admit', finalContent } })).toMatchObject({ ok: true, result: { status: 'accepted' } });
        expect(await enqueue('valid-follow', [witness])).toEqual({ status: 'alreadyAccepted', localId: 'valid-follow' });
        expect(await enqueue('valid-follow', [witness], true, followDeliveryV1, 'different original'))
            .toMatchObject({ status: 'rejected', code: 'session_input_idempotency_conflict' });
        expect((await db.sessionPendingMessage.findUniqueOrThrow({ where: { sessionId_localId: {
            sessionId: destination.id, localId: 'valid-follow' } } })).content).toEqual(finalContent);
        expect(await inTx(tx => hasCanonicalFollowProviderInputAcceptanceInTx(tx, { destinationSessionId: destination.id,
            localInputId: 'valid-follow', userMessageSeq: null, requireProviderAccepted: true }))).toBe(false);
        expect(await inTx(tx => acknowledgeAdmittedSessionFollowInputInTx(tx, { principal, request: ack })))
            .toEqual({ ok: false, rejection: 'provider_acceptance_unverified' });
        expect(await resolveAcceptedPendingDelivery({ actorUserId: owner.id, sessionId: destination.id, publisherAuthority,
            localId: 'valid-follow', acceptedTurn: { kind: 'followUp', turnId: 'accepted-follow' },
            acceptedDelivery: { t: 'plain', v: { v: 1, acceptedAtMs: 1, delivery: { kind: 'followUp', turnId: 'accepted-follow' } } } }))
            .toMatchObject({ ok: true, didResolve: true });
        for (const invalid of [{ ...ack, consumed: { ...observed, transcriptSeq: 2 } },
            { ...ack, expectedPublisherGeneration: '0' }, { ...ack, localInputId: 'unrelated',
                acceptance: { ...ack.acceptance, localInputId: 'unrelated' } },
            { ...ack, acceptance: { ...ack.acceptance, userMessageSeq: 99 } }]) {
            expect(await inTx(tx => acknowledgeAdmittedSessionFollowInputInTx(tx, { principal, request: invalid }))).toMatchObject({ ok: false });
        }
        expect(await inTx(tx => acknowledgeAdmittedSessionFollowInputInTx(tx, { principal, request: ack })))
            .toEqual({ ok: true, delivered: observed });
        expect(await db.sessionFollowEdge.findMany({ where: { destinationSessionId: destination.id },
            select: { relation: true, deliveredTranscriptSeq: true } })).toEqual(expect.arrayContaining([
                { relation: 'follower', deliveredTranscriptSeq: 1 }, { relation: 'manager', deliveredTranscriptSeq: 1 },
            ]));
        const progressed = await db.userKVStore.findUniqueOrThrow({ where: { accountId_key: {
            accountId: owner.id, key: buildSessionFollowRulePhysicalKeyV1('follow-rule') } } });
        expect(decodeAccountScopedKvJson(progressed.value!)).toMatchObject({ sources: [{ sourceSessionId: source.id,
            delivered: { transcriptSeq: 1 } }] });
        await db.sessionMessage.create({ data: { sessionId: source.id, localId: 'second-original', seq: 2, messageRole: 'agent',
            content: { t: 'plain', v: { role: 'agent', content: [] } } } });
        await db.session.update({ where: { id: source.id }, data: { seq: 2 } });
        const nextMessage = { localId: 'second-original', seq: 2 };
        expect(await enqueue('private-only-input', [{ ...witness, sourceMessage: nextMessage }], false,
            { ...followDeliveryV1, original: { sourceSessionId: source.id, sourceMessage: nextMessage } })).toEqual({ status: 'accepted', localId: 'private-only-input' });
        await db.sessionFollowEdge.deleteMany({ where: { destinationSessionId: destination.id } });
        expect(await authorizeSessionFollowSourceKeyPreparer({ accountId: owner.id, sourceSessionId: source.id,
            destinationSessionId: destination.id, authentication, localInputId: 'private-only-input' })).toEqual({
                ok: true, value: { destinationRuntimeAccountId: owner.id },
            });
        const requestCreatedAt = Date.now();
        const sourceRequests = { agentStateVersion: 4, requests: [{ requestId: 'question', createdAt: requestCreatedAt }] };
        await db.session.update({ where: { id: source.id }, data: { agentStateVersion: 4,
            agentState: JSON.stringify({ requests: { question: { createdAt: requestCreatedAt } } }) } });
        const requestInput = { accountId: owner.id, sourceMachineId: sourceMachine.id, targetMachineId: targetMachine.id,
            sessionId: destination.id, content: { t: 'plain' as const, v: { role: 'user', content: { type: 'text', text: 'question notice' } } },
            requestedAction: { v: 1 as const, kind: 'enqueue' as const }, followSources: [{ ...witness, selectedDelivery: 'wake' as const, sourceMessage: undefined, sourceRequests }],
            followDeliveryV1: { v: 1 as const, delivery: 'wake' as const, original: { sourceSessionId: source.id, sourceRequests },
                requestEvents: [{ requestId: 'question', event: { kind: 'needs_you' as const, type: 'decision' as const } }] } };
        expect(await enqueuePendingMessageByAuthenticatedMachine({ ...requestInput, localId: 'request-original' }))
            .toEqual({ status: 'accepted', localId: 'request-original' });
        await db.session.update({ where: { id: source.id }, data: { agentStateVersion: 7 } });
        // Fresh admission must still bind the current snapshot. Retained custody
        // keeps original v4; the native current-request owner checks live identity.
        expect(await enqueuePendingMessageByAuthenticatedMachine({ ...requestInput, localId: 'stale-fresh-request' }))
            .toMatchObject({ status: 'rejected' });
        expect((await inTx(tx => observePendingSessionFollowForDestinationInTx(tx, {
            principal, destinationSessionId: destination.id, inputLocalIds: ['request-original'] }))).observations)
            .toContainEqual(expect.objectContaining({ kind: 'admitted_input', localInputId: 'request-original',
                observed: expect.objectContaining({ agentStateVersion: 4 }) }));
    });

    it('refuses a foreign custodian authoring new private rule witnesses for its hosted requester', async () => {
        const requester = await db.account.create({ data: { encryptionMode: 'plain' } });
        const custodian = await db.account.create({ data: { encryptionMode: 'plain' } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: custodian.id, installationId: randomUUID(),
            metadata: encodePlainMachineStoredContent({ host: 'host', platform: 'linux', happyCliVersion: 'test',
                homeDir: '/home/test', happyHomeDir: '/home/test/.happier' }), dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER),
            operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1] } }, operationProtocolCapabilitiesRevision: 1 } });
        expect(await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: custodian.id, machineId: machine.id,
            principal: { kind: 'account', accountId: requester.id }, level: 'view' }))).toMatchObject({ kind: 'saved' });
        expect(await inTx(tx => resolveMachineAdmissionInTx(tx, { actorAccountId: requester.id, machineId: machine.id })))
            .toMatchObject({ kind: 'admitted' });
        const source = await db.session.create({ data: { accountId: requester.id, tag: randomUUID(), encryptionMode: 'plain', metadata: '{}', seq: 1 } });
        const destination = await db.session.create({ data: { accountId: requester.id, tag: randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        const homeId = await getOrCreateServerIdentityId();
        await db.accessKey.create({ data: { accountId: requester.id, machineId: machine.id, sessionId: destination.id, data: 'opaque' } });
        await db.session.update({ where: { id: destination.id }, data: { runtimeMachineTarget: { homeId,
            accountId: requester.id, sessionId: destination.id, machineId: machine.id, installationId: machine.installationId! } } });
        await db.userKVStore.create({ data: { accountId: requester.id, key: buildSessionFollowRulePhysicalKeyV1('private-rule'), version: 0,
            value: decodeBase64(encodeAccountScopedKvJson({ version: 0, receiver: { kind: 'session', sessionId: destination.id },
                content: { t: 'plain', v: { v: 1, enabled: true, filter: normalizeSessionListFilterV1(), policy: { preset: 'important' } } } })!) } });
        await db.sessionMessage.create({ data: { sessionId: source.id, localId: 'private-report', seq: 1, messageRole: 'agent',
            content: { t: 'plain', v: { role: 'agent', content: [] } } } });
        const token = await auth.createToken(custodian.id, undefined, { kind: 'account', authority: 'present_user' });
        const socket = Object.assign(createAuthenticatedFakeSocket({ nsp: { server: createSocketRoomDiscoveryHarness(async () => []) },
            data: { clientType: 'machine-scoped', machineId: machine.id,
            [VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY]: machine.installationId } }), { handshake: { auth: { token } } });
        machineUpdateHandler(custodian.id, socket as unknown as Socket, { operationSocketBatchLimits: {
            ok: true, limits: { maxItems: 200, maxSerializedBytes: 524_288 },
        } });
        let response: unknown;
        await getSocketHandler(socket, SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1)({ v: 1, sessionId: destination.id,
            targetMachineId: machine.id, localId: 'foreign-private-input', content: { t: 'plain', v: { role: 'user' } },
            requestedAction: { v: 1, kind: 'enqueue' }, followSources: [{ evaluation: 'receiver', selectedDelivery: 'next_turn', rule: { ruleId: 'private-rule', ruleVersion: 0 },
                sourceSessionId: source.id, destinationSessionId: destination.id, sourceMessage: { localId: 'private-report', seq: 1 } }],
            followDeliveryV1: { v: 1, delivery: 'next_turn', original: { sourceSessionId: source.id,
                sourceMessage: { localId: 'private-report', seq: 1 } }, event: { kind: 'update_posted' } },
        }, (value: unknown) => { response = value; });
        expect(SessionPendingEnqueueByMachineResponseV1Schema.parse(response).result).toMatchObject({ status: 'rejected', code: 'session_input_unauthorized' });
        expect(await db.sessionPendingMessage.count({ where: { sessionId: destination.id } })).toBe(0);
        expect(await inTx(tx => admitSessionFollowRuleOccurrenceInTx(tx, { accountId: requester.id,
            authority: { kind: 'account', authentication: { ...createPresentUserSessionAccessAuthentication(), apiTokenGrant: {
                ...API_TOKEN_FULL_GRANT_V1, actions: { families: [], ids: ['session.message.send'] } } } },
            witness: { evaluation: 'receiver', selectedDelivery: 'next_turn', rule: { ruleId: 'private-rule', ruleVersion: 0 },
                sourceSessionId: source.id, destinationSessionId: destination.id, sourceMessage: { localId: 'private-report', seq: 1 } },
        }))).toBeNull();
        const requesterToken = await auth.createToken(requester.id, undefined, { kind: 'account', authority: 'present_user' });
        await withAuthenticatedTestApp(sessionPendingRoutes, async app => {
            const admitted = await app.inject({ method: 'POST', url: `/v2/sessions/${destination.id}/pending`,
                headers: { authorization: `Bearer ${requesterToken}` }, payload: { localId: 'requester-private-input',
                    targetMachineId: machine.id, content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'selected original' } } },
                    followSources: [{ evaluation: 'receiver', selectedDelivery: 'next_turn', rule: { ruleId: 'private-rule', ruleVersion: 0 },
                        sourceSessionId: source.id, destinationSessionId: destination.id, sourceMessage: { localId: 'private-report', seq: 1 } }],
                    followDeliveryV1: { v: 1, delivery: 'next_turn', original: { sourceSessionId: source.id,
                        sourceMessage: { localId: 'private-report', seq: 1 } }, event: { kind: 'update_posted' } } } });
            expect(admitted.statusCode).toBe(200);
            const pending = await db.sessionPendingMessage.findUniqueOrThrow({ where: { sessionId_localId: {
                sessionId: destination.id, localId: 'requester-private-input' } } });
            expect(pending.inputAdmissionReceipt).toMatchObject({ issuer: 'authenticatedAccount', actorAccountId: requester.id,
                followSources: [{ rule: { ruleId: 'private-rule', ruleVersion: 0 } }], admittedTarget: { machineId: machine.id } });
            const principal = { kind: 'destination_runtime' as const, destinationRuntimeAccountId: requester.id,
                authentication: createPresentUserSessionAccessAuthentication() };
            const observed = await inTx(tx => observePendingSessionFollowForDestinationInTx(tx, {
                principal, destinationSessionId: destination.id, inputLocalIds: ['requester-private-input'] }));
            expect(observed.observations).toContainEqual(expect.objectContaining({ kind: 'admitted_input', localInputId: 'requester-private-input' }));
            expect(JSON.stringify(observed)).not.toContain('private-rule');
            expect(JSON.stringify(serializePendingMaterializedMessage({ ...pending, id: pending.id, seq: null,
                messageRole: 'user', content: { t: 'plain', v: {} }, providerAction: pending.providerAction ?? undefined,
                requestedAction: pending.requestedAction ?? undefined,
                inputAdmissionReceipt: readStoredSessionInputAdmissionReceipt(pending.inputAdmissionReceipt) }, { nativeAdmission: true })))
                .not.toContain('private-rule');
            expect(await removeAccountFollowRule({ accountId: requester.id, authentication: createPresentUserSessionAccessAuthentication(),
                ruleId: 'private-rule', receiver: { kind: 'session', sessionId: destination.id }, expectedVersion: 0 })).toMatchObject({ ok: true });
            expect((await inTx(tx => observePendingSessionFollowForDestinationInTx(tx, { principal,
                destinationSessionId: destination.id, inputLocalIds: ['requester-private-input'] }))).observations).toEqual([]);
            expect(await authorizeSessionFollowSourceKeyPreparer({ accountId: requester.id, authentication: createPresentUserSessionAccessAuthentication(),
                sourceSessionId: source.id, destinationSessionId: destination.id, localInputId: 'requester-private-input' }))
                .toMatchObject({ ok: false });
        }, { authentication: 'real' });
    });

    it.each([false, true])('rejoins an accepted terminal original when a private rule arrives late (cross-Account: %s)', async crossAccount => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const sourceOwner = crossAccount ? await db.account.create({ data: { encryptionMode: 'plain' } }) : owner;
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id, installationId: randomUUID(),
            metadata: encodePlainMachineStoredContent({}), dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER),
            operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1] } }, operationProtocolCapabilitiesRevision: 1 } });
        const source = await db.session.create({ data: { accountId: sourceOwner.id, tag: randomUUID(), metadata: '{}',
            encryptionMode: 'plain', publisherGeneration: 1n, seq: 1 } });
        const destination = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: '{}',
            encryptionMode: 'plain', active: true, lastActiveAt: new Date(1), publisherGeneration: 1n } });
        if (crossAccount) await db.sessionShare.create({ data: { sessionId: source.id, sharedByUserId: sourceOwner.id,
            sharedWithUserId: owner.id, accessLevel: 'view' } });
        const homeId = await getOrCreateServerIdentityId();
        await db.accessKey.create({ data: { accountId: owner.id, machineId: machine.id, sessionId: destination.id, data: 'opaque' } });
        await db.session.update({ where: { id: destination.id }, data: { runtimeMachineTarget: {
            homeId, accountId: owner.id, sessionId: destination.id, machineId: machine.id, installationId: machine.installationId! } } });
        if (!crossAccount) {
            await db.accessKey.create({ data: { accountId: owner.id, machineId: machine.id, sessionId: source.id, data: 'opaque' } });
            await db.session.update({ where: { id: source.id }, data: { runtimeMachineTarget: {
                homeId, accountId: owner.id, sessionId: source.id, machineId: machine.id, installationId: machine.installationId! } } });
        }
        // The rule exists before publication; its evaluation arrives only
        // after the ordinary route has already reached provider acceptance.
        await db.userKVStore.create({ data: { accountId: owner.id, key: buildSessionFollowRulePhysicalKeyV1('late-rule'), version: 0,
            value: decodeBase64(encodeAccountScopedKvJson({ version: 0, receiver: { kind: 'session', sessionId: destination.id },
                content: { t: 'plain', v: { v: 1, enabled: true, filter: normalizeSessionListFilterV1(), policy: { preset: 'important' } } } })!) } });
        await db.sessionMessage.create({ data: { sessionId: source.id, localId: 'report', seq: 1, messageRole: 'agent',
            content: { t: 'plain', v: { role: 'agent', content: { type: 'codex', data: { type: 'turn_failed', id: 'native-id' } } } } } });
        const terminalAt = BigInt(Date.now());
        await db.sessionTurn.create({ data: { sessionId: source.id, turnId: 'source-failed-turn', status: 'failed',
            startedAt: terminalAt, updatedAt: terminalAt, terminalAt,
            transcriptAnchorsJson: JSON.stringify({ startSeqInclusive: 1, endSeqInclusive: 1 }) } });
        await db.session.update({ where: { id: source.id }, data: { latestTurnId: 'source-failed-turn', latestTurnStatus: 'failed',
            active: true, lastActiveAt: new Date() } });
        await db.sessionFollowEdge.create({ data: { destinationSessionId: destination.id, sourceSessionId: source.id,
            sourceKey: `session:${source.id}`, relation: 'follower', policyJson: JSON.stringify({ preset: 'important' }),
            // A seeded edge cursor is not an accepted-input fact.
            deliveredTranscriptSeq: 1 } });
        const sourceTurn = { id: 'source-failed-turn', status: 'failed' as const };
        const followDeliveryV1 = { v: 1 as const, delivery: 'wake' as const,
            original: { sourceSessionId: source.id, sourceTurn }, event: { kind: 'failed_or_stopped' as const } };
        const content = { t: 'plain' as const, v: { role: 'user', content: { type: 'text', text: 'original context' } } };
        const input = { accountId: owner.id, sourceMachineId: machine.id, targetMachineId: machine.id,
            sessionId: destination.id, localId: deriveSessionFollowInputLocalIdV1({ destinationSessionId: destination.id,
                original: followDeliveryV1.original }), content, requestedAction: { v: 1 as const, kind: 'enqueue' as const },
            followRelations: [{ relation: 'follower' as const }], followDeliveryV1 };
        expect(await enqueuePendingMessageByAuthenticatedMachine(input)).toEqual({ status: 'accepted', localId: input.localId });
        const publisherAuthority = { accountId: owner.id, sessionId: destination.id, machineId: machine.id, committedFence: new Date(1) };
        expect(await materializeNextPendingMessage({ actorUserId: owner.id, sessionId: destination.id,
            publisherAuthority, deliveryState: 'provider', deliveryTiming: 'after_foreground_ready', foregroundState: 'ready' })).toMatchObject({ ok: true, didMaterialize: true });
        expect((await db.sessionMessage.findUnique({ where: { sessionId_localId: { sessionId: destination.id,
            localId: input.localId } }, select: { acceptedFollowOriginalKey: true } }))?.acceptedFollowOriginalKey ?? null).toBeNull();
        expect(await resolveAcceptedPendingDelivery({ actorUserId: owner.id, sessionId: destination.id, localId: input.localId,
            publisherAuthority, acceptedTurn: { kind: 'followUp', turnId: 'accepted-turn' },
            acceptedDelivery: { t: 'plain', v: { v: 1, acceptedAtMs: 1, delivery: { kind: 'followUp', turnId: 'accepted-turn' } } } })).toMatchObject({ ok: true, didResolve: true });
        if (!crossAccount) {
            // Simulate a route whose original cursor settled but whose legacy
            // Turn cursor did not survive the acceptance/ACK boundary.
            await db.sessionFollowEdge.create({ data: { destinationSessionId: destination.id, sourceSessionId: source.id,
                sourceKey: `session:${source.id}`, relation: 'manager', managerSourceSessionId: source.id,
                policyJson: JSON.stringify({ preset: 'important' }), deliveredTranscriptSeq: 1 } });
            const observe = () => inTx(tx => observePendingSessionFollowForDestinationInTx(tx, {
                principal: { kind: 'destination_runtime', destinationRuntimeAccountId: owner.id,
                    authentication: createPresentUserSessionAccessAuthentication() },
                destinationSessionId: destination.id, includeManager: true,
            }));
            expect((await observe()).observations).toContainEqual(expect.objectContaining({
                sourceSessionId: source.id, relation: 'manager',
                delivered: expect.objectContaining({ transcriptSeq: 1, turn: null }),
                observed: expect.objectContaining({ transcriptSeq: 1, turn: sourceTurn }),
            }));
            await db.sessionMessage.create({ data: { sessionId: source.id, localId: 'different-turn-output', seq: 2,
                messageRole: 'agent', content: { t: 'plain', v: { role: 'agent', content: { type: 'event',
                    data: { type: 'worker-report', summary: 'A later original report' } } } } } });
            await db.session.update({ where: { id: source.id }, data: { seq: 2 } });
            expect((await observe()).observations).toContainEqual(expect.objectContaining({
                sourceSessionId: source.id, relation: 'manager',
                observed: expect.objectContaining({ transcriptSeq: 2, turn: sourceTurn }),
            }));
            await db.sessionFollowEdge.update({ where: { destinationSessionId_sourceSessionId_relation: {
                destinationSessionId: destination.id, sourceSessionId: source.id, relation: 'manager',
            } }, data: { deliveredTranscriptSeq: 2 } });
            await db.sessionTurn.update({ where: { sessionId_turnId: { sessionId: source.id, turnId: 'source-failed-turn' } },
                data: { transcriptAnchorsJson: JSON.stringify({ startSeqInclusive: 2, endSeqInclusive: 2 }) } });
            expect((await observe()).observations).toContainEqual(expect.objectContaining({
                sourceSessionId: source.id, relation: 'manager',
                observed: expect.objectContaining({ turn: { id: 'source-failed-turn', status: 'failed' } }),
            }));
        }
        const acceptedReceipt = (await db.sessionMessage.findUniqueOrThrow({ where: { sessionId_localId: {
            sessionId: destination.id, localId: input.localId } } })).inputAdmissionReceipt;
        // A new source/receiver publisher and a private route reoffer the same
        // canonical original, never another provider input or alias localId.
        await db.session.update({ where: { id: source.id }, data: { publisherGeneration: 2n } });
        await db.session.update({ where: { id: destination.id }, data: {
            publisherGeneration: 2n, lastActiveAt: new Date(2),
        } });
        const witness = { destinationSessionId: destination.id, selectedDelivery: 'wake' as const, rule: { ruleId: 'late-rule', ruleVersion: 0 },
            sourceSessionId: source.id, sourceTurn,
            ...(crossAccount ? { evaluation: 'receiver' as const } : { expectedSourcePublisherGeneration: '2',
                machineId: machine.id, installationId: machine.installationId! }) };
        expect(await enqueuePendingMessageByAuthenticatedMachine({ ...input, localId: 'late-rule-input',
            followSources: [witness], followRelations: undefined })).toMatchObject({ status: 'rejected' });
        expect(await enqueuePendingMessageByAuthenticatedMachine({ ...input,
            followSources: [witness], followRelations: undefined })).toEqual({ status: 'alreadyAccepted', localId: input.localId });
        expect(await db.sessionMessage.count({ where: { sessionId: destination.id } })).toBe(1);
        expect(await db.sessionPendingMessage.count({ where: { sessionId: destination.id } })).toBe(0);
        expect((await db.sessionMessage.findUniqueOrThrow({ where: { sessionId_localId: {
            sessionId: destination.id, localId: input.localId } } })).inputAdmissionReceipt).toEqual(acceptedReceipt);
        const row = await db.userKVStore.findUniqueOrThrow({ where: { accountId_key: {
            accountId: owner.id, key: buildSessionFollowRulePhysicalKeyV1('late-rule') } } });
        expect(decodeAccountScopedKvJson(row.value!)).toMatchObject({ sources: [{ sourceSessionId: source.id,
            delivered: { transcriptSeq: 0, turn: sourceTurn } }] });
    });

    it('admits the hosted requester tuple, refuses another source Machine, and rechecks grant loss', async () => {
        const requester = await db.account.create({ data: { publicKey: `requester-${randomUUID()}` } });
        const custodian = await db.account.create({ data: { publicKey: `custodian-${randomUUID()}`, encryptionMode: 'plain' } });
        const createMachine = () => db.machine.create({ data: {
            id: randomUUID(), accountId: custodian.id, installationId: randomUUID(),
            metadata: encodePlainMachineStoredContent({ host: 'host', platform: 'linux', happyCliVersion: 'test',
                homeDir: '/home/test', happyHomeDir: '/home/test/.happier' }),
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER),
            operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1] } },
            operationProtocolCapabilitiesRevision: 1,
        } });
        const target = await createMachine();
        const wrongSource = await createMachine();
        expect(await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: custodian.id, machineId: target.id,
            principal: { kind: 'account', accountId: requester.id }, level: 'view' }))).toMatchObject({ kind: 'saved' });
        const session = await db.session.create({ data: { accountId: requester.id, tag: randomUUID(), metadata: 'encrypted' } });
        await db.accessKey.create({ data: { accountId: requester.id, machineId: target.id, sessionId: session.id, data: 'encrypted' } });
        const token = await auth.createToken(custodian.id, undefined, { kind: 'account', authority: 'present_user' });
        // Only Socket.IO is substituted. Authentication, C41 grants, exact
        // AccessKey binding, Pending admission and durable SQLite writes are real.
        const enqueue = async (source: typeof target, localId: string) => {
            const socket = Object.assign(createAuthenticatedFakeSocket({ nsp: { server: createSocketRoomDiscoveryHarness(async () => []) },
                data: { clientType: 'machine-scoped', machineId: source.id,
                [VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY]: source.installationId } }), { handshake: { auth: { token } } });
            machineUpdateHandler(custodian.id, socket as unknown as Socket, { operationSocketBatchLimits: {
                ok: true, limits: { maxItems: 200, maxSerializedBytes: 524_288 },
            } });
            const request = SessionPendingEnqueueByMachineRequestV1Schema.parse({ v: 1, sessionId: session.id,
                targetMachineId: target.id, localId, content: { t: 'encrypted', c: 'protected-requester-input' },
                requestedAction: { v: 1, kind: 'enqueue' }, requestEqualityEvidenceV1: { kind: 'e2eeTag', tag: 'A'.repeat(43) } });
            let response: unknown;
            await getSocketHandler(socket, SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1)(request, (value: unknown) => { response = value; });
            return SessionPendingEnqueueByMachineResponseV1Schema.parse(response).result;
        };
        expect(await enqueue(target, 'hosted-input')).toEqual({ status: 'accepted', localId: 'hosted-input' });
        expect(await db.sessionPendingMessage.findUniqueOrThrow({ where: {
            sessionId_localId: { sessionId: session.id, localId: 'hosted-input' } },
            select: { authorAccountId: true, content: true, inputAdmissionReceipt: true } })).toMatchObject({
            authorAccountId: null, content: { t: 'encrypted', c: 'protected-requester-input' },
            inputAdmissionReceipt: { issuer: 'authenticatedMachine', admittedTarget: {
                accountId: requester.id, machineId: target.id, sessionId: session.id, installationId: target.installationId } },
        });
        expect(await enqueue(target, 'hosted-input')).toEqual({ status: 'alreadyAccepted', localId: 'hosted-input' });
        expect(await enqueue(wrongSource, 'wrong-source')).toMatchObject({ status: 'rejected' });
        expect(await inTx(tx => removeMachineAccessGrantInTx(tx, { actorAccountId: custodian.id, machineId: target.id,
            principal: { kind: 'account', accountId: requester.id } }))).toMatchObject({ kind: 'removed' });
        expect(await enqueue(target, 'revoked-input')).toMatchObject({ status: 'rejected' });
        expect(await enqueue(target, 'hosted-input')).toMatchObject({ status: 'rejected' });
        expect(await db.sessionPendingMessage.count({ where: { sessionId: session.id } })).toBe(1);
    });
});
