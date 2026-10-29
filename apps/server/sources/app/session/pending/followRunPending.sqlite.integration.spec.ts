import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { decodeBase64 } from 'privacy-kit';
import { MACHINE_PLAIN_DATA_KEY_MARKER, encodePlainMachineStoredContent } from '@happier-dev/protocol';
import { sealWorkflowAcceptedSnapshotStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1 } from '@happier-dev/protocol';
import { deriveSessionFollowInputLocalIdV1, SessionFollowInputV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowInputV1';
import { sourceKeyForSessionFollowSourceV1 } from '@/app/session/follow/sessionFollowSourceIdentity';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { materializeWorkflowAcceptedSnapshotFixture } from '@/testkit/workflowAcceptedSnapshot';
import { enqueuePendingMessageByAuthenticatedMachine, resolveAcceptedPendingDelivery } from './pendingMessageService';
import { materializeNextPendingMessage } from './materializeNextPendingMessage';

describe('Run original Follow input at Pending admission and provider acceptance', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-follow-run-pending-', initAuth: true,
            env: { HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' } });
    }, 120_000);
    afterAll(async () => { if (harness) await harness.close(); });

    async function fixture() {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: account.id, installationId: randomUUID(),
            metadata: encodePlainMachineStoredContent({}), dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER),
            operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1] } }, operationProtocolCapabilitiesRevision: 1 } });
        const destination = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), metadata: '{}',
            encryptionMode: 'plain', active: true, lastActiveAt: new Date(1), publisherGeneration: 1n } });
        const homeId = await getOrCreateServerIdentityId();
        await db.accessKey.create({ data: { accountId: account.id, machineId: machine.id, sessionId: destination.id, data: 'opaque' } });
        await db.session.update({ where: { id: destination.id }, data: { runtimeMachineTarget: {
            homeId, accountId: account.id, sessionId: destination.id, machineId: machine.id,
            installationId: machine.installationId! } } });
        const publisherAuthority = { accountId: account.id, sessionId: destination.id,
            machineId: machine.id, committedFence: new Date(1) };
        const accept = async (localId: string) => {
            expect(await materializeNextPendingMessage({ actorUserId: account.id, sessionId: destination.id,
                publisherAuthority, deliveryState: 'provider', deliveryTiming: 'after_foreground_ready',
                foregroundState: 'ready' })).toMatchObject({ ok: true, didMaterialize: true });
            expect(await resolveAcceptedPendingDelivery({ actorUserId: account.id, sessionId: destination.id,
                publisherAuthority, localId, acceptedTurn: { kind: 'followUp', turnId: 'receiver-turn' },
                acceptedDelivery: { t: 'plain', v: { v: 1, acceptedAtMs: 1,
                    delivery: { kind: 'followUp', turnId: 'receiver-turn' } } } })).toMatchObject({ ok: true, didResolve: true });
        };
        return { account, machine, destination, homeId, accept };
    }

    it('advances a workflow edge only for an exact accepted original and does not regress a later revision', async () => {
        const f = await fixture();
        const runId = randomUUID();
        const acceptedSnapshot = await materializeWorkflowAcceptedSnapshotFixture({
            definition: { version: 1, inputs: [], defaults: {}, blocks: [{ kind: 'wait', id: 'review',
                document: { text: 'Review', references: [], attachments: [] } }] },
            context: { source: { kind: 'inline' }, inputs: {}, machineId: f.machine.id,
                executionTarget: { kind: 'session' }, workspaceTarget: { project: { machineId: f.machine.id,
                    directory: '/repo', checkoutRootPath: '/repo' } }, origin: { kind: 'direct' },
                authorization: { principal: { kind: 'host' } } },
        });
        const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
            mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId: f.account.id, runId }, acceptedSnapshot,
        }));
        const run = await db.automationRun.create({ data: { id: runId, accountId: f.account.id, originKind: 'direct', causeKind: null,
            state: 'succeeded', revision: 2, scheduledAt: new Date(), dueAt: new Date(), workflowCustodyState: 'settled',
            workflowAcceptedSnapshotEnvelope: acceptedEnvelope } });
        const source = { kind: 'workflow_run' as const, runId: run.id };
        const edge = await db.sessionFollowEdge.create({ data: { destinationSessionId: f.destination.id,
            sourceKey: sourceKeyForSessionFollowSourceV1(source), sourceWorkflowRunId: run.id,
            relation: 'follower', policyJson: JSON.stringify({ preset: 'important' }), deliveredWorkflowRunRevision: 1 } });
        const delivery = SessionFollowInputV1Schema.parse({ v: 1, delivery: 'next_turn', original: { source, revision: 2 },
            event: { kind: 'finished' } });
        const localId = deriveSessionFollowInputLocalIdV1({ destinationSessionId: f.destination.id, original: delivery.original });
        const input = { accountId: f.account.id, sourceMachineId: f.machine.id, targetMachineId: f.machine.id,
            sessionId: f.destination.id, localId, content: { t: 'plain' as const,
                v: { role: 'user', content: { type: 'text', text: 'Workflow finished' } } },
            requestedAction: { v: 1 as const, kind: 'enqueue' as const }, followDeliveryV1: delivery,
            followRelations: [{ relation: 'follower' as const, source, attachedAt: edge.attachedAt.getTime(), expectedRevision: 1 }] };
        expect(await enqueuePendingMessageByAuthenticatedMachine({ ...input, localId: 'wrong-run', followRelations: [
            { ...input.followRelations[0]!, source: { kind: 'workflow_run' as const, runId: randomUUID() } },
        ] })).toMatchObject({ status: 'rejected' });
        expect(await enqueuePendingMessageByAuthenticatedMachine(input)).toEqual({ status: 'accepted', localId });
        expect((await db.sessionFollowEdge.findUniqueOrThrow({ where: { destinationSessionId_sourceKey_relation: {
            destinationSessionId: f.destination.id, sourceKey: edge.sourceKey, relation: 'follower' } } })).deliveredWorkflowRunRevision).toBe(1);
        await f.accept(localId);
        expect(await db.sessionMessage.findUnique({ where: { sessionId_localId: { sessionId: f.destination.id, localId } } }))
            .toMatchObject({ acceptedFollowOriginalKey: expect.any(String), inputAdmissionReceipt: {
                followDeliveryV1: delivery, followRelations: input.followRelations,
            } });
        expect((await db.sessionFollowEdge.findUniqueOrThrow({ where: { destinationSessionId_sourceKey_relation: {
            destinationSessionId: f.destination.id, sourceKey: edge.sourceKey, relation: 'follower' } } })).deliveredWorkflowRunRevision).toBe(2);
        await db.sessionFollowEdge.update({ where: { destinationSessionId_sourceKey_relation: {
            destinationSessionId: f.destination.id, sourceKey: edge.sourceKey, relation: 'follower' } },
            data: { deliveredWorkflowRunRevision: 3 } });
        expect(await enqueuePendingMessageByAuthenticatedMachine(input))
            .toEqual({ status: 'alreadyAccepted', localId });
        expect((await db.sessionFollowEdge.findUniqueOrThrow({ where: { destinationSessionId_sourceKey_relation: {
            destinationSessionId: f.destination.id, sourceKey: edge.sourceKey, relation: 'follower' } } })).deliveredWorkflowRunRevision).toBe(3);
        expect(await db.sessionMessage.count({ where: { sessionId: f.destination.id } })).toBe(1);
    });

    it('requires the exact content-free execution frontier and accepts its terminal once', async () => {
        const f = await fixture();
        const parent = await db.session.create({ data: { accountId: f.account.id, tag: randomUUID(), metadata: '{}',
            encryptionMode: 'plain', publisherGeneration: 1n } });
        await db.accessKey.create({ data: { accountId: f.account.id, machineId: f.machine.id, sessionId: parent.id, data: 'opaque' } });
        await db.session.update({ where: { id: parent.id }, data: { runtimeMachineTarget: {
            homeId: f.homeId, accountId: f.account.id, sessionId: parent.id, machineId: f.machine.id,
            installationId: f.machine.installationId! } } });
        const source = { kind: 'execution_run' as const, sessionId: parent.id, runId: randomUUID() };
        const edge = await db.sessionFollowEdge.create({ data: { destinationSessionId: f.destination.id,
            sourceKey: sourceKeyForSessionFollowSourceV1(source), sourceExecutionRunSessionId: parent.id,
            sourceExecutionRunId: source.runId, relation: 'follower', policyJson: JSON.stringify({ preset: 'important' }) } });
        const terminalEventId = randomUUID();
        const delivery = SessionFollowInputV1Schema.parse({ v: 1, delivery: 'next_turn', original: { source, terminalEventId },
            event: { kind: 'finished' } });
        const localId = deriveSessionFollowInputLocalIdV1({ destinationSessionId: f.destination.id, original: delivery.original });
        const forwardRpcForUser = vi.fn(async () => ({ ok: true as const,
            result: { sessionId: parent.id, runId: source.runId, status: 'succeeded', terminalEventId } }));
        const input = { accountId: f.account.id, sourceMachineId: f.machine.id, targetMachineId: f.machine.id,
            sessionId: f.destination.id, localId, content: { t: 'plain' as const,
                v: { role: 'user', content: { type: 'text', text: 'Run finished' } } },
            requestedAction: { v: 1 as const, kind: 'enqueue' as const }, followDeliveryV1: delivery,
            followRelations: [{ relation: 'follower' as const, source, attachedAt: edge.attachedAt.getTime(),
                expectedTerminalEventId: null }], followSourceApp: { forwardRpcForUser },
            sourceAuthentication: createPresentUserSessionAccessAuthentication() };
        forwardRpcForUser.mockResolvedValueOnce({ ok: true, result: { sessionId: parent.id, runId: randomUUID(),
            status: 'succeeded', terminalEventId } });
        expect(await enqueuePendingMessageByAuthenticatedMachine(input)).toMatchObject({ status: 'rejected',
            code: 'session_input_target_unavailable' });
        expect(await enqueuePendingMessageByAuthenticatedMachine({ ...input, followDeliveryV1: SessionFollowInputV1Schema.parse({
            ...delivery, original: { source, terminalEventId: randomUUID() } }) })).toMatchObject({ status: 'rejected' });
        expect(await enqueuePendingMessageByAuthenticatedMachine(input)).toEqual({ status: 'accepted', localId });
        expect(forwardRpcForUser).toHaveBeenCalledWith(expect.objectContaining({ params: { sessionId: parent.id, runId: source.runId } }));
        expect(JSON.stringify(forwardRpcForUser.mock.calls)).not.toContain('Run finished');
        expect((await db.sessionFollowEdge.findUniqueOrThrow({ where: { destinationSessionId_sourceKey_relation: {
            destinationSessionId: f.destination.id, sourceKey: edge.sourceKey, relation: 'follower' } } })).deliveredExecutionRunTerminalEventId).toBeNull();
        await f.accept(localId);
        expect((await db.sessionFollowEdge.findUniqueOrThrow({ where: { destinationSessionId_sourceKey_relation: {
            destinationSessionId: f.destination.id, sourceKey: edge.sourceKey, relation: 'follower' } } })).deliveredExecutionRunTerminalEventId).toBe(terminalEventId);
    });
});
