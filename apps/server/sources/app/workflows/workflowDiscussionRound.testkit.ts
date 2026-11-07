import { randomUUID } from 'node:crypto';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol';
import { afterEach, expect, it } from 'vitest';
import { ActionIdSchema, getActionSpec } from '@happier-dev/protocol/actions';
import { ActionSessionAddressV1Schema } from '@happier-dev/protocol/actions/sessionTargetV1';
import { actionSpecToActionDefinitionV1, freezeWorkflowActionContractV1 } from '@happier-dev/protocol/actions/actionCatalog';
import { getBuiltinWorkflowCatalogV1, materializeWorkflowAcceptedSnapshotV1, sealWorkflowAcceptedSnapshotStoredEnvelopeV1,
    sealWorkflowCheckpointStoredEnvelopeV1, sealWorkflowProgressStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1 } from '@happier-dev/protocol/workflows';
import { db } from '@/storage/db';
import { createDiscussion } from '@/app/discussions/mutations';
import { listDiscussions } from '@/app/discussions/queries';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { automationAccountCurrentnessSelect, deriveAutomationAccountCurrentnessWitness } from '@/app/automations/automationAccountCurrentness';
import { admitWorkflowRun, initializeWorkflowRunExecution, commitWorkflowInvocationFact, transitionWorkflowRun } from './workflowRunService';

/** The same real admission/fact/transition/list journey exercises each supported database owner. */
export function workflowDiscussionRoundPersistenceContracts() {
    const accountIds: string[] = [];
    afterEach(async () => {
        const ids = accountIds.splice(0);
        if (ids.length === 0) return;
        await db.automationRun.deleteMany({ where: { accountId: { in: ids } } });
        await db.session.deleteMany({ where: { accountId: { in: ids } } });
        await db.machine.deleteMany({ where: { accountId: { in: ids } } });
        await db.account.deleteMany({ where: { id: { in: ids } } });
    });

    it.each(['succeeded', 'failed'] as const)('projects protected Workflow round writes into Discussion lists and preserves a newer round on retry (%s)', async state => {
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' }, select: { id: true } });
        accountIds.push(account.id);
        const accountId = account.id, machineId = randomUUID();
        await db.machine.create({ data: { id: machineId, accountId, installationId: randomUUID(),
            metadata: encodePlainMachineStoredContent({ host: 'workflow-test', platform: 'linux', happyCliVersion: 'test',
                homeDir: '/home/test', happyHomeDir: '/home/test/.happier' }),
            dataEncryptionKey: new Uint8Array(Buffer.from(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64')) } });
        const sessionIds = [randomUUID(), randomUUID()];
        await db.session.createMany({ data: sessionIds.map(id => ({ id, accountId, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain' })) });
        const authentication = createPresentUserSessionAccessAuthentication();
        const created = await createDiscussion({ actorAccountId: accountId, authentication, request: {
            creationLocalId: randomUUID(), titleContent: { t: 'plain', v: { v: 1, title: 'Private round' } },
            firstMessage: { localId: randomUUID(), content: { t: 'plain', v: { v: 1, parts: [{ t: 'text', text: 'Private question' }] } }, mentionedAccountIds: [] },
        } });
        if (!created.ok) throw new Error(created.error);
        const discussionId = created.value.discussion.id;
        const occurrence = { discussion: { serverId: 'home', discussionId }, messageId: created.value.firstMessage.id, throughSeq: 1 };
        const origin = { kind: 'direct' as const, discussion: occurrence };
        const accountCurrentness = deriveAutomationAccountCurrentnessWitness(await db.account.findUniqueOrThrow({
            where: { id: accountId }, select: automationAccountCurrentnessSelect }));
        if (!accountCurrentness) throw new Error('workflow_account_unavailable');
        const base = { accountId, machineId, accountCurrentness };
        const definition = getBuiltinWorkflowCatalogV1().find(entry => entry.id === 'builtin:fresh-opinions')!.definition;
        const accepted = await materializeWorkflowAcceptedSnapshotV1({ definition, admission: { kind: 'user' }, context: {
            source: { kind: 'catalog', ref: 'builtin:fresh-opinions', version: 1 },
            inputs: { question: 'Private question', participants: sessionIds.map(sessionId => ({ kind: 'session', session: { serverId: 'home', sessionId } })) },
            machineId, executionTarget: { kind: 'session' }, workspaceTarget: { project: { machineId, directory: '/repo', checkoutRootPath: '/repo' } },
            origin, resultDelivery: { kind: 'originating_discussion', ...occurrence }, authorization: { principal: { kind: 'host' } },
        }, effects: { resolveTargetAvailability: async () => true,
            resolveSessionTarget: async address => ({ address: ActionSessionAddressV1Schema.parse(address), machineId }),
            readActionContract: async id => freezeWorkflowActionContractV1(actionSpecToActionDefinitionV1(getActionSpec(ActionIdSchema.parse(id)))),
        } });
        if (!accepted.ok) throw new Error(accepted.error.code);
        const admit = async (runId: string) => {
            const params = { ...base, runId, origin, acceptedEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
                mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId }, acceptedSnapshot: accepted.snapshot })),
                discussionRoundPattern: 'fresh_opinions' as const, resultDelivery: { kind: 'originating_discussion' as const },
                discussionAuthentication: authentication };
            await admitWorkflowRun(params);
            return params;
        };
        const checkpoint = (runId: string, rootId: string) => serializeWorkflowStoredContentEnvelopeV1(sealWorkflowCheckpointStoredEnvelopeV1({
            mode: 'plain', binding: { v: 1, purpose: 'checkpoint', accountId, runId }, checkpoint: {
                kind: 'happier.workflow-checkpoint.v1', rootRecordId: rootId, nextSequence: '1', frontier: { nextBlockOrdinal: 0, paused: false } } }));
        const rootProgress = (runId: string, rootId: string) => serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
            mode: 'plain', binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: rootId,
                sequence: '0', parentRecordId: null, memberOrdinal: '0', attempt: '0' }, progress: {
                kind: 'happier.workflow-progress.v1', blockKind: 'root', invocationPath: { blockId: '$root', scope: [] },
                attempt: '0', logicalInvocationRecordId: rootId } }));
        const initialize = async (runId: string, rootId: string) => {
            // The real worker claim is a system boundary; fixture its exact durable custody without executing native agents.
            await db.automationRun.update({ where: { id: runId }, data: { state: 'claimed', claimedByMachineId: machineId, attempt: 1 } });
            return initializeWorkflowRunExecution({ ...base, runId, parentAttempt: 1, expectedRevision: 0,
                checkpointEnvelope: checkpoint(runId, rootId), rootInvocation: { id: rootId, contentEnvelope: rootProgress(runId, rootId) } });
        };
        const read = () => db.discussion.findUniqueOrThrow({ where: { id: discussionId }, select: { roundOutcomeV1: true } });
        const firstId = randomUUID(), firstRoot = randomUUID();
        const first = await admit(firstId);
        await initialize(firstId, firstRoot);
        const fact = { ...base, runId: firstId, parentAttempt: 1, invocationId: firstRoot, invocationAttempt: 0n, expectedContentRevision: 0n,
            expectedLifecycle: 'pending' as const, lifecycle: 'running' as const, contentEnvelope: rootProgress(firstId, firstRoot),
            discussionRound: { discussionId, answerCount: 1, synthesized: false } };
        const updated = await commitWorkflowInvocationFact(fact);
        expect((await read()).roundOutcomeV1).toEqual({ runId: firstId, pattern: 'fresh_opinions', answerCount: 1, synthesized: false, settled: false });
        const nextId = randomUUID(), nextRoot = randomUUID();
        await admit(nextId);
        await admitWorkflowRun(first);
        await commitWorkflowInvocationFact({ ...fact, expectedContentRevision: BigInt(updated.contentRevision), expectedLifecycle: 'running',
            discussionRound: { ...fact.discussionRound, answerCount: 99 } });
        expect((await read()).roundOutcomeV1).toEqual({ runId: nextId, pattern: 'fresh_opinions', answerCount: 0, synthesized: false, settled: false });
        await initialize(nextId, nextRoot);
        await transitionWorkflowRun({ ...base, runId: nextId, parentAttempt: 1, expectedRevision: 1, state, custodyState: 'settled',
            checkpointEnvelope: checkpoint(nextId, nextRoot), discussionRound: { discussionId, answerCount: 2, synthesized: true },
            invocationTransitions: [{ id: nextRoot, expectedLifecycle: 'pending', lifecycle: state === 'succeeded' ? 'completed' : 'failed', expectedContentRevision: 0n }] });
        expect(await listDiscussions({ actorAccountId: accountId, authentication })).toMatchObject({ ok: true, value: { discussions: [{
            id: discussionId, roundOutcomeV1: { runId: nextId, pattern: 'fresh_opinions', answerCount: 2, synthesized: true, settled: state === 'succeeded' },
        }] } });
    });
}
