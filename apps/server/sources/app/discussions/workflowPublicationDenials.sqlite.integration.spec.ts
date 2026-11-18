import { randomUUID } from 'node:crypto';
import { auth } from '@/app/auth/auth';
import { createFakeSocket, getSocketHandler } from '@/app/api/testkit/socketHarness';
import { machineUpdateHandler } from '@/app/api/socket/machineUpdateHandler';
import { VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY } from '@/app/api/socket/machineSocketInstallationProof';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { decodeBase64 } from 'privacy-kit';
import { DISCUSSION_AGENT_POST_EVENT_V1, DiscussionAgentApprovedReplayResponseV1Schema } from '@happier-dev/protocol/discussions/api';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { createDiscussion, postPreparedDiscussionMessageInTx, prepareDiscussionPostMutationAccounts } from './mutations';
import { deriveWorkflowDiscussionReplyLocalIdV1 } from '@happier-dev/protocol/workflows/workflowInvocationIdentityV1';
import { projectWorkflowDiscussionProducerV1 } from '@happier-dev/protocol/workflows/workflowDiscussionPublicationV1';
import { MachinePublishedMetadataV1Schema } from '@happier-dev/protocol/machines/machinePublishedContentV1';

let harness: LightSqliteHarness;
beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'workflow-denials-',
    initAuth: true, initEncrypt: false, initFiles: false,
    env: { HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' } }); }, 120_000);
afterAll(async () => { await harness?.close(); });

it.each([
    ['missing_custody', 'discussion_workflow_custody_missing'],
    ['invocation', 'discussion_workflow_invocation_custody_mismatch'],
    ['attempt', 'discussion_workflow_attempt_mismatch'],
    ['lifecycle', 'discussion_workflow_lifecycle_mismatch'],
    ['discussion', 'discussion_workflow_discussion_mismatch'],
    ['question', 'discussion_workflow_question_missing'],
    ['frontier', 'discussion_workflow_frontier_mismatch'],
    ['reply_target', 'discussion_workflow_reply_target_mismatch'],
    ['local_id', 'discussion_workflow_local_id_mismatch'],
    ['producer', 'discussion_workflow_producer_mismatch'],
    ['context', 'discussion_publication_context_unavailable'],
    ['read_only', 'discussion_publication_read_only'],
] as const)('preserves the %s custody denial code without appending', async (branch, code) => {
    const { input, invocation, discussionId } = await createFixture();
    const mutated = structuredClone(input);
    if (branch === 'invocation') mutated.workflowReturn.machineId = randomUUID();
    if (branch === 'attempt') mutated.producer.invocationAttempt = '1';
    if (branch === 'lifecycle') await db.workflowRunInvocation.update({ where: { id: invocation.id }, data: { lifecycle: 'failed' } });
    if (branch === 'discussion') mutated.workflowReturn.origin.discussion.discussionId = randomUUID();
    if (branch === 'question') mutated.workflowReturn.origin.messageId = randomUUID();
    if (branch === 'frontier') mutated.workflowReturn.origin.throughSeq++;
    if (branch === 'reply_target') mutated.request.replyTarget.messageId = randomUUID();
    if (branch === 'local_id') mutated.request.localId = randomUUID();
    if (branch === 'context' || branch === 'read_only') {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        await db.discussion.update({ where: { id: discussionId }, data: { ownerAccountId: owner.id } });
        if (branch === 'read_only') await db.discussionGrant.create({ data: { principalKind: 'account' as const,
            discussionId, accountId: input.actorAccountId, accessLevel: 'view', createdByAccountId: owner.id,
        } });
    }
    const candidate = branch === 'missing_custody' ? { ...mutated, workflowReturn: undefined }
        : branch === 'producer' ? { ...mutated, producer: undefined } : mutated;
    const result = await inTx(tx => postPreparedDiscussionMessageInTx(tx, candidate), {
        prepare: () => prepareDiscussionPostMutationAccounts(candidate),
    });
    expect(result).toEqual({ ok: false, error: code });
    expect(await db.discussionMessage.count({ where: { discussionId } })).toBe(1);
});

async function createFixture() {
    const account = await db.account.create({ data: { encryptionMode: 'plain' } });
    const authentication = createPresentUserSessionAccessAuthentication();
    const content = { t: 'plain' as const, v: { v: 1, parts: [{ t: 'text', text: 'Fixture' }] } };
    const created = await createDiscussion({ actorAccountId: account.id, authentication, request: {
        creationLocalId: randomUUID(), titleContent: { t: 'plain', v: { v: 1, title: 'Fixture' } },
        firstMessage: { localId: randomUUID(), content, mentionedAccountIds: [] },
    } });
    if (!created.ok) throw new Error(created.error);
    const machine = await db.machine.create({ data: { id: randomUUID(), accountId: account.id, installationId: randomUUID(),
        metadata: encodePlainMachineStoredContent({}), dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64') } });
    const machineId = machine.id;
    const run = await db.automationRun.create({ data: { accountId: account.id, originKind: 'direct', causeKind: null,
        scheduledAt: new Date(), dueAt: new Date(), claimedByMachineId: machineId,
        workflowAcceptedSnapshotEnvelope: '{}', workflowCustodyState: 'pending' } });
    const invocation = await db.workflowRunInvocation.create({ data: { runId: run.id, sequence: 1n, memberOrdinal: 0n,
        lifecycle: 'completed', contentEnvelope: '{}' } });
    const identity = { runId: run.id, invocationRecordId: invocation.id, invocationAttempt: '0' };
    const producer = projectWorkflowDiscussionProducerV1({ ...identity, blockKind: 'action', lifecycle: 'completed',
        execution: { kind: 'action', actionId: 'machines.list' }, result: { checked: true } });
    if (!producer) throw new Error('fixture_producer_unavailable');
    const discussionId = created.value.discussion.id;
    const input = { actorAccountId: account.id, authentication, discussionId,
        request: { localId: deriveWorkflowDiscussionReplyLocalIdV1(identity), content, mentionedAccountIds: [],
            replyTarget: { kind: 'message' as const, messageId: created.value.firstMessage.id } },
        producer,
        workflowReturn: { machineId, origin: { discussion: { serverId: 'home', discussionId },
            messageId: created.value.firstMessage.id, throughSeq: created.value.firstMessage.seq } },
    };
    return { input, invocation, discussionId, machine, account };
}

it.each([
    ['schema', 'discussion_machine_publication_invalid'],
    ['identity_missing', 'discussion_machine_identity_missing'],
    ['identity_mismatch', 'discussion_machine_identity_mismatch'],
    ['installation_missing', 'discussion_machine_installation_missing'],
    ['disconnected', 'discussion_machine_credential_not_current'],
    ['admission', 'machine_unavailable'],
    ['installation_mismatch', 'discussion_machine_installation_mismatch'],
    ['custodian', 'discussion_machine_custodian_mismatch'],
] as const)('preserves the %s Machine admission code without appending', async (branch, code) => {
    const { input, machine, account, discussionId } = await createFixture();
    const token = await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' });
    const socket = Object.assign(createFakeSocket({ data: { clientType: 'machine-scoped', machineId: machine.id,
        authAuthority: 'present_user', [VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY]: machine.installationId } }),
        { handshake: { auth: { token } } });
    machineUpdateHandler(account.id, socket as never, {
        operationSocketBatchLimits: { ok: true, limits: { maxItems: 200, maxSerializedBytes: 524_288 } },
    });
    const publication = { discussionId, request: input.request, producer: input.producer, origin: input.workflowReturn.origin };
    const packet = { v: 1, operation: 'workflow_result', machineId: machine.id, publication };
    if (branch === 'identity_missing') Reflect.deleteProperty(socket.data!, 'machineId');
    if (branch === 'identity_mismatch') packet.machineId = randomUUID();
    if (branch === 'installation_missing') Reflect.deleteProperty(socket.data!, VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY);
    // Account credential withdrawal evicts the admitted socket.
    if (branch === 'disconnected') socket.connected = false;
    if (branch === 'admission') await db.machine.update({ where: { id: machine.id }, data: { revokedAt: new Date() } });
    if (branch === 'installation_mismatch') await db.machine.update({ where: { id: machine.id }, data: { installationId: randomUUID() } });
    if (branch === 'custodian') {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        await db.machine.update({ where: { id: machine.id }, data: { accountId: owner.id,
            metadata: encodePlainMachineStoredContent(MachinePublishedMetadataV1Schema.parse({
                host: 'fixture', platform: 'linux', happyCliVersion: '0.3.0', homeDir: '/fixture', happyHomeDir: '/fixture',
            })) } });
        await db.machineGrant.create({ data: { principalKind: 'account', machineId: machine.id, accountId: account.id,
            accessLevel: 'admin', createdByAccountId: owner.id } });
    }
    let response: unknown;
    await getSocketHandler(socket, DISCUSSION_AGENT_POST_EVENT_V1)(branch === 'schema' ? {} : packet,
        (value: unknown) => { response = value; });
    expect(DiscussionAgentApprovedReplayResponseV1Schema.parse(response)).toEqual({ v: 1, ok: false, error: code });
    expect(await db.discussionMessage.count({ where: { discussionId } })).toBe(1);
});
