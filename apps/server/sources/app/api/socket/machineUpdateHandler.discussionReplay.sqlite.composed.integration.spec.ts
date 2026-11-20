import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DISCUSSION_AGENT_POST_EVENT_V1, DISCUSSION_HTTP_PATHS_V1, DiscussionAgentPostResponseV1Schema, DiscussionAgentApprovedReplayResponseV1Schema, DiscussionMessagesResponseV1Schema } from '@happier-dev/protocol/discussions/api';
import { auth } from '@/app/auth/auth';
import { APPROVAL_ARTIFACT_KINDS_V1 } from '@happier-dev/protocol/approvals/approvalArtifactKindV1';
import { deriveArtifactStoredKindV1 } from '@happier-dev/protocol/artifacts/artifactKindV1';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { decodeBase64 } from 'privacy-kit';
import { inTx } from '@/storage/inTx';
import { resolveMachineAdmissionInTx } from '@/app/machines/machineAccess';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createFakeSocket, getSocketHandler } from '@/app/api/testkit/socketHarness';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerDiscussionRoutes } from '@/app/api/routes/discussions/registerDiscussionRoutes';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { createDiscussion } from '@/app/discussions/mutations';
import { inviteDiscussionParticipant, removeDiscussionParticipant, setDiscussionParticipantPolicy } from '@/app/discussions/accessService';
import { machineUpdateHandler } from './machineUpdateHandler';
import { sessionUpdateHandler } from './sessionUpdateHandler';
import { VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY } from './machineSocketInstallationProof';
import { createWorkflowDiscussionResultPublisher } from '../../../../../cli/src/daemon/workflows/workflowDiscussionPublication';
import { deriveWorkflowDiscussionReplyLocalIdV1 } from '@happier-dev/protocol/workflows/workflowInvocationIdentityV1';
import { buildDiscussionMutationRequestBodyV1 } from '@happier-dev/protocol/discussions/api';
import { createTestWorkflowCoordinator, createInMemoryWorkflowCoordinatorStore } from '../../../../../cli/src/daemon/workflows/workflowCoordinator.testkit';
import type { WorkflowCoordinatorInvocation } from '../../../../../cli/src/daemon/workflows/coordinator';
import { projectWorkflowRetainedRuntimeSelectionV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';
import { materializeWorkflowAcceptedSnapshotV1 } from '@happier-dev/protocol/workflows/materializeWorkflowAcceptedSnapshotV1';
import { ActionDefinitionV1Schema } from '@happier-dev/protocol/actions/actionDefinitionV1';
import { createActionExecutor } from '@happier-dev/protocol/actions';
import { createTargetActionInvocationRegistry } from '../../../../../cli/src/plugins/runtime/invocation/targetActionRegistry';
import { createTargetActionHostBindingResolver } from '../../../../../cli/src/plugins/runtime/hostAccess/resolve';
import { createUnavailablePluginServicesFactory } from '../../../../../cli/src/plugins/runtime/invocation/services/factory';
import { createManagedPluginSourceCustody } from '../../../../../cli/src/plugins/runtime/lifecycle/contributions/runtimeIdentity.testkit';
import { createPluginRuntimeOccurrenceId } from '../../../../../cli/src/plugins/runtime/runtimeSlots';
import { createCommittedContributedActionSchemaReader } from '../../../../../cli/src/plugins/runtime/invocation/actions/createCommittedContributedActionDeps';
import { createUnavailableActionTransportDeps } from '../../../../../cli/src/testkit/actionTransportDeps';
import { buildWorkflowActionContext } from '../../../../../cli/src/daemon/workflows/daemonRuntime';
import type { PluginJsonSchemaV2 } from '@happier-dev/protocol/plugins/contributions/jsonSchema';
import { createSessionInputReplyProgressInTx } from '@/app/session/messages/sessionMessageReply';
import { deriveWorkflowSessionInputLocalIdV2 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { deriveSessionMessageReplyReturnLocalIdV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageReplyV1';

const authentication = createPresentUserSessionAccessAuthentication();
const options = { operationSocketBatchLimits: { ok: true as const, limits: { maxItems: 200, maxSerializedBytes: 524_288 } } };
const content = (text: string) => ({ t: 'plain' as const, v: { v: 1, parts: [{ t: 'text', text }] } });

describe('installed Machine reviewed Discussion publication (SQLite)', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-discussion-machine-replay-',
        initAuth: true, initEncrypt: false, initFiles: false, env: { HAPPIER_FEATURE_SESSIONS__ENABLED: '1',
            HAPPIER_FEATURE_SESSIONS_CONVERSATIONS__ENABLED: '1', HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' } }); }, 120_000);
    afterAll(async () => { await harness?.close(); });

    it.each(['action', 'detached', 'failed_before_start', 'cancelled_before_start'] as const)('carries a real Workflow result producer through the installed Machine append and Discussion reader without a Session (%s)', async executionKind => {
        const lifecycle = executionKind === 'failed_before_start' ? 'failed' : executionKind === 'cancelled_before_start' ? 'cancelled' : 'completed';
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const reader = await db.account.create({ data: { encryptionMode: 'plain' } });
        await db.userRelationship.create({ data: { fromUserId: owner.id, toUserId: reader.id, status: 'friend' } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id, installationId: randomUUID(),
            metadata: encodePlainMachineStoredContent({}), dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64') } });
        const created = await createDiscussion({ actorAccountId: owner.id, authentication, request: { creationLocalId: randomUUID(),
            titleContent: { t: 'plain', v: { v: 1, title: 'Payments — Workflow result' } },
            participants: [{ kind: 'account', accountId: reader.id }], firstMessage: { localId: randomUUID(),
                content: content('Question'), mentionedAccountIds: [] } } });
        if (!created.ok) throw new Error(created.error);
        const discussionId = created.value.discussion.id;
        const run = await db.automationRun.create({ data: { accountId: owner.id, originKind: 'direct', causeKind: null,
            scheduledAt: new Date(), dueAt: new Date(), claimedByMachineId: machine.id,
            workflowAcceptedSnapshotEnvelope: 'sealed-accepted', workflowCustodyState: 'pending' } });
        const invocation = await db.workflowRunInvocation.create({ data: { runId: run.id, sequence: 1n, memberOrdinal: 0n,
            lifecycle, contentEnvelope: 'sealed-accepted-result' } });
        const token = await auth.createToken(owner.id, undefined, { kind: 'account', authority: 'present_user' });
        const connectPublisher = () => {
            const socket = createFakeSocket({ data: { clientType: 'machine-scoped', machineId: machine.id,
                authAuthority: 'present_user', [VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY]: machine.installationId } });
            machineUpdateHandler(owner.id, socket as never, options);
            return socket;
        };
        let socket = connectPublisher();
        const origin = { discussion: { serverId: 'home', discussionId }, messageId: created.value.firstMessage.id, throughSeq: created.value.firstMessage.seq };
        const acceptedDelivery = await materializeWorkflowAcceptedSnapshotV1({ definition: { version: 1, inputs: [],
            defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'external.agent', localId: 'native' } } },
            blocks: [{ kind: 'step', id: 'check', document: { text: 'Check', references: [], attachments: [] }, input: [], result: { kind: 'text' } }] },
            admission: { kind: 'user' }, effects: { resolveTargetAvailability: async () => true }, context: {
                source: { kind: 'inline' }, inputs: {}, machineId: machine.id, executionTarget: { kind: 'detached_run' },
                workspaceTarget: { project: { machineId: machine.id, directory: '/repo', checkoutRootPath: '/repo' } },
                origin: { kind: 'direct', discussion: origin }, resultDelivery: { kind: 'originating_discussion', ...origin },
                authorization: { principal: { kind: 'host' }, admittedPermissionCeiling: 'default' } } });
        if (!acceptedDelivery.ok || acceptedDelivery.snapshot.resultDelivery?.kind !== 'originating_discussion') throw new Error('Missing accepted Discussion destination');
        let lastMessageId: string | undefined;
        let lastContent: unknown;
        const publish = createWorkflowDiscussionResultPublisher({ credentials: { token, encryption: null }, origin: acceptedDelivery.snapshot.resultDelivery,
            isCurrent: async () => true, publish: async publication => {
                if (!('kind' in publication)) throw new Error('A non-Session result must not fabricate Session custody');
                lastContent = publication.content;
                const packet = { v: 1, operation: 'workflow_result', machineId: machine.id, publication: {
                    discussionId, producer: publication.producer, origin: publication.discussion,
                    request: buildDiscussionMutationRequestBodyV1({ kind: 'post', localId: deriveWorkflowDiscussionReplyLocalIdV1(publication.workflow),
                        content: { t: 'plain', v: publication.content }, authoredContent: publication.content, mentionedAccountIds: [],
                        replyTarget: { kind: 'message', messageId: publication.discussion.messageId } }),
                } };
                let reply: unknown;
                await getSocketHandler(socket, DISCUSSION_AGENT_POST_EVENT_V1)(packet, (value: unknown) => { reply = value; });
                const parsed = DiscussionAgentPostResponseV1Schema.parse(reply);
                if (!lastMessageId) expect(parsed, JSON.stringify({ producer: publication.producer,
                    invocation: await db.workflowRunInvocation.findUnique({ where: { id: publication.workflow.invocationRecordId },
                        select: { id: true, lifecycle: true, attempt: true } }).then(row => row ? { ...row, attempt: row.attempt.toString() } : row) }))
                    .toMatchObject({ ok: true });
                if (parsed.ok) lastMessageId = parsed.value.message.id;
                return parsed;
            } });
        const acceptedInvocation: WorkflowCoordinatorInvocation = { key: 'leaf', recordId: invocation.id, runId: run.id, blockId: 'check',
            path: { blockId: 'check', scope: [] }, attempt: 0, acceptedAtMs: 0, blockKind: executionKind === 'action' ? 'action' : 'step',
            lifecycle };
        let accepted = acceptedInvocation;
        if (executionKind === 'action') {
            const pluginId = 'external.publisher';
            const localId = 'check';
            const actionId = `${pluginId}/actions/${localId}`;
            const inputSchema = { type: 'object', properties: {}, additionalProperties: false } satisfies PluginJsonSchemaV2;
            const outputSchema = { type: 'object', properties: { checked: { type: 'boolean' } }, required: ['checked'], additionalProperties: false };
            const occurrenceId = createPluginRuntimeOccurrenceId(pluginId);
            const registry = createTargetActionInvocationRegistry({ readMachineLocalDatabaseAgentLevel: async () => undefined, actions: [{ pluginId, pluginVersion: '1.0.0', occurrenceId,
                sourceCustody: createManagedPluginSourceCustody('external-publisher'), localId,
                definition: { id: localId, dangerLevel: 'externalSideEffect', scopes: ['global'], surfaces: ['agent'],
                    inputSchema, resultSchema: outputSchema, confirmation: { title: 'Check', body: 'Run check?', confirmLabel: 'Run' } },
                handler: async () => ({ checked: true }) }], readCurrentPluginOccurrenceId: () => occurrenceId,
                resolveAuthorizationFacts: action => ({ generation: { targetGeneration: action.occurrenceId,
                    desiredGeneration: action.occurrenceId, appliedGeneration: action.occurrenceId },
                    resourceSelections: [], scopedGrants: [], operatingSystemAuthorization: [] }),
                createServices: createUnavailablePluginServicesFactory(), resolveHostBinding: createTargetActionHostBindingResolver() });
            const listDefinitions = () => [ActionDefinitionV1Schema.parse({ kindVersion: 1, id: actionId, title: 'Check', description: null,
                safety: 'danger', placements: [], slash: null, bindings: null, examples: null, surfaces: { agent: true },
                inputHints: null, inputSchema, outputSchema })];
            const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), listContributedActionDefinitions: listDefinitions,
                readContributedActionSchemas: createCommittedContributedActionSchemaReader(listDefinitions), invokeContributedAction: async request => {
                    const result = await registry.invoke({ ...request.action, input: request.input, surface: 'agent',
                        initiatingActionCaller: request.context.actionCaller, signal: request.signal,
                        requestCurrentIntent: async confirmation => ({ status: 'approved', fingerprint: confirmation.fingerprint }) });
                    if (result.status === 'executed') return { ok: true, result: result.value };
                    if (result.status === 'deferred') throw new Error('Unexpected deferred target confirmation');
                    return { ok: false, errorCode: result.code, error: result.message };
                } });
            const store = createInMemoryWorkflowCoordinatorStore();
            const workspace = { machineId: machine.id, directory: '/repo', checkoutRootPath: '/repo' };
            const materialized = await materializeWorkflowAcceptedSnapshotV1({ definition: { version: 1, inputs: [],
                blocks: [{ kind: 'action', id: 'check', actionId, input: {} }] }, admission: { kind: 'user' },
                context: { source: { kind: 'inline' }, inputs: {}, machineId: machine.id, executionTarget: { kind: 'session' },
                    workspaceTarget: { project: workspace }, origin: { kind: 'direct' },
                    authorization: { principal: { kind: 'host' }, admittedPermissionCeiling: 'default' } },
                effects: { resolveTargetAvailability: async () => true, readActionContract: async id => id === actionId ? { inputSchema, outputSchema } : null } });
            if (!materialized.ok) throw new Error(materialized.error.code);
            const coordinator = createTestWorkflowCoordinator({ store, allocateInvocationRecordId: () => invocation.id,
                resolveWorkspace: async () => ({ ok: true, workspace }), isAcceptedAuthorizationCurrent: async () => true,
                executeStep: async () => { throw new Error('An Action must not fabricate a Session'); },
                action: { executor, buildContext: async input => buildWorkflowActionContext(input),
                    observeRun: async () => { throw new Error('An immediate Action must not observe a Run'); } },
                onInvocationSettled: async settled => { await publish(settled); } });
            try { expect(await coordinator.run({ ...materialized.snapshot, runId: run.id })).toMatchObject({ state: 'succeeded' }); }
            finally { registry.dispose(); }
            const actual = store.list().find(row => row.blockId === 'check');
            if (!actual) throw new Error('Workflow Action was not persisted');
            accepted = actual;
        } else if (executionKind === 'detached') {
            const store = createInMemoryWorkflowCoordinatorStore();
            const coordinator = createTestWorkflowCoordinator({ store, allocateInvocationRecordId: () => invocation.id,
                isAcceptedAuthorizationCurrent: async () => true,
                resolveWorkspace: async () => ({ ok: true, workspace: { machineId: machine.id, directory: '/repo', checkoutRootPath: '/repo' } }),
                executeStep: async input => {
                    await input.beforeInputAdmission();
                    await input.onInputAccepted({ kind: 'detached_run', runId: 'native-run', localInputId: 'input',
                        runtimeSelection: projectWorkflowRetainedRuntimeSelectionV1(input.execution) });
                    return { kind: 'completed', result: { checked: true }, resultEncoding: 'typed' };
                }, onInvocationSettled: async settled => { await publish(settled); } });
            expect(await coordinator.run({ runId: run.id, inputs: {}, executionTarget: { kind: 'detached_run' },
                authorization: { principal: { kind: 'host' }, admittedPermissionCeiling: 'default' },
                definition: { version: 1, defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'external.agent', localId: 'native' } } },
                    blocks: [{ kind: 'step', id: 'check', document: { text: 'Check', references: [], attachments: [] }, input: [],
                        result: { kind: 'json', schema: { type: 'object', properties: { checked: { type: 'boolean' } }, required: ['checked'], additionalProperties: false } } }] } })).toMatchObject({ state: 'succeeded' });
            const actual = store.list().find(row => row.blockId === 'check');
            if (!actual) throw new Error('Workflow leaf was not persisted');
            accepted = actual;
        } else await publish({ runId: run.id, invocation: accepted });
        if (lifecycle !== 'completed') {
            expect(lastMessageId).toBeUndefined();
            expect(await db.discussionMessage.count({ where: { discussionId } })).toBe(1);
            return;
        }
        const firstId = lastMessageId;
        expect(firstId).toBeDefined();
        socket.connected = false;
        socket = connectPublisher();
        lastMessageId = undefined;
        await publish({ runId: run.id, invocation: accepted });
        expect(lastMessageId).toBe(firstId);
        const readerToken = await auth.createToken(reader.id, undefined, { kind: 'account', authority: 'present_user' });
        await withAuthenticatedTestApp(registerDiscussionRoutes, async app => {
            const response = await app.inject({ method: 'GET',
                url: DISCUSSION_HTTP_PATHS_V1.messages.replace(':discussionId', discussionId), headers: { authorization: `Bearer ${readerToken}` } });
            expect(response.statusCode).toBe(200);
            const page = DiscussionMessagesResponseV1Schema.parse(response.json());
            expect(page.messages).toMatchObject([{ id: origin.messageId }, {
                id: firstId, producerV1: { kind: 'workflow', invocationRecordId: invocation.id },
                content: { t: 'plain', v: lastContent }, replyTarget: { kind: 'message', messageId: origin.messageId },
            }]);
        }, { authentication: 'real' });
        await db.machine.update({ where: { id: machine.id }, data: { revokedAt: new Date() } });
        await expect(publish({ runId: run.id, invocation: accepted })).rejects.toThrow('workflow_discussion_publication_unavailable');
    });

    it('publishes an accepted Workflow Session return through its owning Machine after the receiver exits', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id, installationId: randomUUID(),
            metadata: encodePlainMachineStoredContent({}), dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64') } });
        const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), encryptionMode: 'plain', metadata: '{}', active: false } });
        await db.accessKey.create({ data: { accountId: owner.id, machineId: machine.id, sessionId: session.id, data: 'opaque' } });
        const created = await createDiscussion({ actorAccountId: owner.id, authentication, request: { creationLocalId: randomUUID(),
            titleContent: { t: 'plain', v: { v: 1, title: 'Retained Workflow return' } }, firstMessage: { localId: randomUUID(),
                content: content('Question'), mentionedAccountIds: [] } } });
        if (!created.ok) throw new Error(created.error);
        const discussionId = created.value.discussion.id;
        expect(await inviteDiscussionParticipant({ actorAccountId: owner.id, authentication, discussionId,
            request: { participant: { kind: 'session', sessionId: session.id }, answerPolicy: 'when_addressed' } })).toMatchObject({ ok: true });
        const run = await db.automationRun.create({ data: { accountId: owner.id, originKind: 'direct', causeKind: null,
            scheduledAt: new Date(), dueAt: new Date(), state: 'cancelled', workflowCustodyState: 'pending',
            workflowAcceptedSnapshotEnvelope: 'accepted-by-workflow-owner' } });
        const invocation = await db.workflowRunInvocation.create({ data: { runId: run.id, sequence: 1n, memberOrdinal: 0n,
            lifecycle: 'completed', contentEnvelope: 'accepted-result-owned-by-workflow' } });
        const workflow = { purpose: 'invocation' as const, runId: run.id, invocationRecordId: invocation.id };
        const discussion = { discussionId, messageId: created.value.firstMessage.id,
            throughSeq: created.value.firstMessage.seq, participantSessionId: session.id };
        const progress = await inTx(tx => createSessionInputReplyProgressInTx(tx, { accountId: owner.id, requestSessionId: session.id,
            reply: { mode: 'wait', discussion, workflow } }));
        if (!progress) throw new Error('Expected admitted Workflow original');
        const requestLocalId = deriveWorkflowSessionInputLocalIdV2(workflow), acceptedTurnId = randomUUID();
        await db.sessionMessage.create({ data: { sessionId: session.id, localId: requestLocalId, seq: 1,
            messageRole: 'user', content: content('Admitted input'), replyDisposition: 'observing', replyProgress: { ...progress,
                acceptedTurnId, outcome: { kind: 'answer', result: { sessionId: session.id, messageId: 'accepted-final' } } } } });
        const replyReturn = { serverId: 'home', requestLocalId, acceptedTurnId,
            workflow: { runId: run.id, invocationRecordId: invocation.id, invocationAttempt: '0' } };
        const publication = { v: 1 as const, sessionId: session.id, discussionId, terminalReturn: true as const, replyReturn,
            request: buildDiscussionMutationRequestBodyV1({ kind: 'post',
                localId: deriveSessionMessageReplyReturnLocalIdV1({ sessionId: session.id, localId: requestLocalId, acceptedTurnId }),
                content: content('Accepted answer'), authoredContent: { v: 1, parts: [{ t: 'text', text: 'Accepted answer' }] },
                mentionedAccountIds: [], replyTarget: { kind: 'message', messageId: discussion.messageId } }) };
        const token = await auth.createToken(owner.id, undefined, { kind: 'account', authority: 'present_user' });
        const socket = Object.assign(createFakeSocket({ data: { clientType: 'machine-scoped', machineId: machine.id,
            authAuthority: 'present_user', [VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY]: machine.installationId } }),
            { handshake: { auth: { token } } });
        machineUpdateHandler(owner.id, socket as never, options);
        const publish = async (body: unknown = publication, machineId = machine.id) => {
            let result: unknown;
            await getSocketHandler(socket, DISCUSSION_AGENT_POST_EVENT_V1)({ v: 2, operation: 'terminal_return', machineId, publication: body },
                (value: unknown) => { result = value; });
            return DiscussionAgentApprovedReplayResponseV1Schema.parse(result);
        };
        const first = await publish();
        expect(first).toMatchObject({ ok: true, value: { message: { producerV1: { kind: 'agent', sessionId: session.id,
            replyReturn: { workflow: replyReturn.workflow } } } } });
        expect(await publish()).toEqual(first);
        expect(await db.discussionMessage.count({ where: { discussionId } })).toBe(2);
        expect(await db.sessionMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: session.id, localId: requestLocalId } } }))
            .toMatchObject({ replyDisposition: 'returned' });
        expect(await publish({ ...publication, replyReturn: { ...replyReturn, workflow: { ...replyReturn.workflow, invocationAttempt: '1' } } }))
            .toMatchObject({ ok: false, error: 'discussion_post_denied' });
        expect(await publish({ ...publication, replyReturn: { ...replyReturn, workflow: undefined } })).toMatchObject({ ok: false });
        expect(await publish({ ...publication, replyReturn: { ...replyReturn, requestLocalId: 'missing-original' } }))
            .toMatchObject({ ok: false, error: 'discussion_post_denied' });
        expect(await publish(publication, randomUUID())).toMatchObject({ ok: false, error: 'discussion_machine_identity_mismatch' });
        expect(await setDiscussionParticipantPolicy({ actorAccountId: owner.id, authentication, discussionId,
            request: { participant: { kind: 'session', sessionId: session.id }, answerPolicy: 'drafts_for_approval' } })).toMatchObject({ ok: true });
        expect(await publish()).toMatchObject({ ok: false, error: 'discussion_post_denied' });
        expect(await setDiscussionParticipantPolicy({ actorAccountId: owner.id, authentication, discussionId,
            request: { participant: { kind: 'session', sessionId: session.id }, answerPolicy: 'when_addressed' } })).toMatchObject({ ok: true });
        expect(await db.session.findUniqueOrThrow({ where: { id: session.id } })).toMatchObject({ active: false, publisherGeneration: 0n });
        await db.machine.update({ where: { id: machine.id }, data: { revokedAt: new Date() } });
        expect(await publish()).toMatchObject({ ok: false, error: 'discussion_post_denied' });
    });

    it.each(['drafts_for_approval', 'when_addressed'] as const)('publishes one reviewed %s reply without a receiver process and rechecks its original authority', async answerPolicy => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id, installationId: randomUUID(),
            metadata: encodePlainMachineStoredContent({}), dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64') } });
        expect(await inTx(tx => resolveMachineAdmissionInTx(tx, { actorAccountId: owner.id, machineId: machine.id }))).toMatchObject({ kind: 'admitted' });
        const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), encryptionMode: 'plain', metadata: '{}', active: false } });
        const sourceInputId = randomUUID();
        const turnId = randomUUID();
        await db.sessionMessage.create({ data: { sessionId: session.id, localId: sourceInputId, seq: 1, messageRole: 'user', content: content('Question input') } });
        await db.sessionTurn.create({ data: { sessionId: session.id, turnId, status: 'completed', startedAt: 1n, updatedAt: 2n,
            transcriptAnchorsJson: JSON.stringify({ startUserMessageSeq: 1, userMessageSeqs: [1] }) } });
        await db.accessKey.create({ data: { accountId: owner.id, machineId: machine.id, sessionId: session.id, data: 'opaque' } });
        const created = await createDiscussion({ actorAccountId: owner.id, authentication, request: { creationLocalId: randomUUID(),
            titleContent: { t: 'plain', v: { v: 1, title: 'Reviewed reply' } }, firstMessage: { localId: randomUUID(),
                content: content('The original question'), mentionedAccountIds: [] } } });
        if (!created.ok) throw new Error(created.error);
        const discussionId = created.value.discussion.id;
        expect(await inviteDiscussionParticipant({ actorAccountId: owner.id, authentication, discussionId,
            request: { participant: { kind: 'session', sessionId: session.id }, answerPolicy } })).toMatchObject({ ok: true });
        const token = await auth.createToken(owner.id, undefined, { kind: 'account', authority: 'present_user' });
        // Network boundary starts after the normal handshake has verified the
        // installation proof. Auth, Machine custody, resource policy and SQLite are real.
        const socket = Object.assign(createFakeSocket({ data: { clientType: 'machine-scoped', machineId: machine.id,
            authAuthority: 'present_user', [VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY]: machine.installationId } }),
            { handshake: { auth: { token } } });
        // Socket.IO retains all listeners, unlike the basic testkit's handler
        // lookup. Preserve that network behavior when composing startup's two
        // actual registrars so a rejecting first ACK cannot mask a later commit.
        const events = new EventEmitter();
        const register = socket.on;
        socket.on = (event, listener) => {
            events.on(event, listener);
            register(event, (...args: unknown[]) => Promise.all(events.listeners(event).map(handler => Reflect.apply(handler, socket, args))));
        };
        sessionUpdateHandler(owner.id, socket as never, { connectionType: 'machine-scoped', userId: owner.id, machineId: machine.id, socket } as never);
        machineUpdateHandler(owner.id, socket as never, options);
        const publication = { v: 1 as const, sessionId: session.id, discussionId,
            sourceSession: { sourceSessionId: session.id, sourceInputId, sourceTurnId: turnId, via: 'action' as const },
            request: { localId: `approved-${randomUUID()}`, content: content('The exact privately reviewed answer'),
                mentionedAccountIds: [], replyTarget: { kind: 'message' as const, messageId: created.value.firstMessage.id } },
            draftReview: { artifactId: randomUUID(), decidingAccountId: owner.id } };
        const packet = { v: 1, operation: 'approved_replay', machineId: machine.id, publication };
        const publishRaw = async (value: unknown = packet) => {
            const acknowledgements: unknown[] = [];
            await getSocketHandler(socket, DISCUSSION_AGENT_POST_EVENT_V1)(value, (response: unknown) => { acknowledgements.push(response); });
            expect(acknowledgements).toHaveLength(1);
            return acknowledgements[0];
        };
        const publish = async (value: unknown = packet) => DiscussionAgentPostResponseV1Schema.parse(await publishRaw(value));
        expect(await publish(), 'A signed installed carrier cannot invent its review Artifact').toMatchObject({ ok: false, error: 'discussion_post_denied' });
        expect(await db.discussionMessage.count({ where: { discussionId } })).toBe(1);
        // Opaque Artifact bytes are not opened by the server-side binding;
        // the composed MCP/person-decide harness exercises their real producer.
        await db.artifact.create({ data: { id: publication.draftReview.artifactId, accountId: owner.id,
            kind: deriveArtifactStoredKindV1({ kind: APPROVAL_ARTIFACT_KINDS_V1.builtIn }), approvalSessionId: session.id,
            header: new Uint8Array([0]), body: new Uint8Array([0]), dataEncryptionKey: new Uint8Array([0]) } });
        const first = await publish();
        if (!first.ok) throw new Error(`Reviewed Machine publication refused: ${first.error}`);
        expect(first).toMatchObject({ ok: true, value: { message: { authorAccountId: owner.id,
            producerV1: { v: 1, kind: 'agent', sessionId: session.id }, content: publication.request.content } } });
        expect(await publish()).toEqual(first); // Lost-ACK retry is the same writer/equality identity.
        expect(await db.discussionMessage.count({ where: { discussionId } })).toBe(2);
        expect(await db.session.findUniqueOrThrow({ where: { id: session.id } })).toMatchObject({ active: false, publisherGeneration: 0n });
        expect(socket.handlers.has(`${session.id}:discussion.agentPost.v1`)).toBe(false);
        const sessionSocket = createFakeSocket({ data: { clientType: 'session-scoped', sessionId: session.id, authAuthority: 'present_user' } });
        const sessionEvents = new EventEmitter();
        sessionSocket.on = (event, listener) => { sessionEvents.on(event, listener); };
        sessionUpdateHandler(owner.id, sessionSocket as never, { connectionType: 'session-scoped', userId: owner.id, sessionId: session.id, socket: sessionSocket } as never);
        machineUpdateHandler(owner.id, sessionSocket as never, options);
        const sessionAcks: unknown[] = [];
        await Promise.all(sessionEvents.listeners(DISCUSSION_AGENT_POST_EVENT_V1).map(listener => Reflect.apply(listener, sessionSocket,
            [publication, (ack: unknown) => { sessionAcks.push(ack); }])));
        // The ordinary Session listener must remain the sole owner and retain
        // its actual current-publisher refusal; Machine replay cannot replace it.
        expect(sessionAcks).toEqual([{ v: 1, ok: false, error: 'discussion_post_denied' }]);
        // SQLite itself refuses this insert. The socket owner must acknowledge
        // uncertainty rather than leave an otherwise healthy caller pending.
        await db.$executeRawUnsafe('CREATE TRIGGER "reviewed_post_boundary_failure" BEFORE INSERT ON "DiscussionMessage" WHEN NEW."localId" = \'db-boundary-failure\' BEGIN SELECT RAISE(ABORT, \'reviewed-post-storage-failure\'); END');
        try {
            expect(DiscussionAgentApprovedReplayResponseV1Schema.parse(await publishRaw({ ...packet, publication: { ...publication,
                request: { ...publication.request, localId: 'db-boundary-failure' } } }))).toEqual({ v: 1, ok: false, error: 'outcome_unknown' });
            expect(await db.discussionMessage.count({ where: { discussionId } })).toBe(2);
        } finally { await db.$executeRawUnsafe('DROP TRIGGER "reviewed_post_boundary_failure"'); }
        expect(await publish({ ...packet, publication: { ...publication, sourceSession: undefined } }))
            .toMatchObject({ ok: false, error: 'discussion_machine_publication_invalid' });
        expect(await publish({ ...packet, publication: { ...publication, sourceSession: undefined,
            replyReturn: { serverId: 'home', requestLocalId: 'not-an-admitted-original' } } }))
            .toMatchObject({ ok: false, error: 'discussion_post_denied' });
        expect(await publish(publication)).toMatchObject({ ok: false }); // No raw draft/Agent publication on a Machine socket.
        expect(await publish({ ...packet, publication: { ...publication, draftReview: undefined } })).toMatchObject({ ok: false });
        expect(await publish({ ...packet, machineId: randomUUID() })).toMatchObject({ ok: false, error: 'discussion_machine_identity_mismatch' });
        expect(await publish({ ...packet, publication: { ...publication,
            sourceSession: { ...publication.sourceSession, sourceInputId: 'not-in-that-turn' } } })).toMatchObject({ ok: false, error: 'discussion_post_denied' });
        const outsider = await db.account.create({ data: { encryptionMode: 'plain' } });
        expect(await publish({ ...packet, publication: { ...publication,
            draftReview: { ...publication.draftReview, decidingAccountId: outsider.id } } })).toMatchObject({ ok: false, error: 'discussion_post_denied' });
        const boundMachine = socket.data!.machineId;
        const otherMachine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id, installationId: randomUUID(),
            metadata: encodePlainMachineStoredContent({}), dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64') } });
        socket.data!.machineId = otherMachine.id;
        socket.data![VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY] = otherMachine.installationId;
        expect(await publish({ ...packet, machineId: otherMachine.id })).toMatchObject({ ok: false, error: 'discussion_post_denied' });
        socket.data!.machineId = boundMachine;
        socket.data![VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY] = machine.installationId;
        const installation = socket.data![VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY];
        socket.data![VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY] = randomUUID();
        expect(await publish()).toMatchObject({ ok: false, error: 'discussion_post_denied' });
        socket.data![VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY] = installation;
        socket.data!.clientType = 'user-scoped';
        expect(await publish()).toMatchObject({ ok: false, error: 'discussion_machine_identity_missing' });
        socket.data!.clientType = 'machine-scoped';
        await db.machine.update({ where: { id: machine.id }, data: { revokedAt: new Date() } });
        expect(await publish()).toMatchObject({ ok: false, error: 'discussion_post_denied' });
        await db.machine.update({ where: { id: machine.id }, data: { revokedAt: null } });
        await db.session.update({ where: { id: session.id }, data: { archivedAt: new Date() } });
        expect(await publish()).toMatchObject({ ok: false, error: 'discussion_post_denied' });
        await db.session.update({ where: { id: session.id }, data: { archivedAt: null } });
        await db.accessKey.delete({ where: { accountId_machineId_sessionId: { accountId: owner.id, machineId: machine.id, sessionId: session.id } } });
        expect(await publish()).toMatchObject({ ok: false, error: 'discussion_post_denied' });
        await db.accessKey.create({ data: { accountId: owner.id, machineId: machine.id, sessionId: session.id, data: 'opaque' } });
        const newPacket = () => ({ ...packet, publication: { ...publication, request: { ...publication.request, localId: randomUUID() } } });
        expect(await setDiscussionParticipantPolicy({ actorAccountId: owner.id, authentication, discussionId,
            request: { participant: { kind: 'session', sessionId: session.id }, answerPolicy: 'reads_only' } })).toMatchObject({ ok: true });
        expect(await publish(newPacket())).toMatchObject({ ok: false, error: 'discussion_post_denied' });
        expect(await removeDiscussionParticipant({ actorAccountId: owner.id, authentication, discussionId,
            request: { participant: { kind: 'session', sessionId: session.id } } })).toMatchObject({ ok: true });
        expect(await publish(newPacket())).toMatchObject({ ok: false, error: 'discussion_post_denied' });
        // A handler already dispatched by the socket can observe credential eviction.
        socket.connected = false;
        expect(await publish(newPacket())).toMatchObject({ ok: false, error: 'discussion_machine_credential_not_current' });
        expect(await db.discussionMessage.count({ where: { discussionId } })).toBe(2);
    });
});
