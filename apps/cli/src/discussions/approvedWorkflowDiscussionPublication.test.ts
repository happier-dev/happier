import { createServer } from 'node:http';
import { expect, it, onTestFinished } from 'vitest';
import { accountSettingsParse, API_TOKEN_FULL_GRANT_V1, createWorkflowAccountRunActionOwner,
  materializeWorkflowAcceptedSnapshotV1, sealWorkflowAcceptedSnapshotStoredEnvelopeV1,
  sealWorkflowProgressStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1 } from '@happier-dev/protocol';
import { ApprovalRequestV2Schema, requiresExactDaemonApprovalReplay } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { WorkflowInvocationGetRequestV1Schema } from '@happier-dev/protocol/workflows/actionsV1';
import { projectWorkflowDiscussionProducerV1, projectWorkflowDiscussionResultContentV1 } from '@happier-dev/protocol/workflows/workflowDiscussionPublicationV1';
import type { DiscussionWorkflowPostPublicationV1 } from '@happier-dev/protocol/discussions/api';
import type { StoredCredentials } from '@/persistence';
import { createWorkflowRunStorageTestkit } from '@/daemon/workflows/workflowRunStorage.testkit';
import { DurableWorkflowCoordinatorStore } from '@/daemon/workflows/production';
import { workflowInvocationKey } from '@/daemon/workflows/coordinator';
import { createCredentialedWorkflowAcceptedAuthorizationCurrentness } from '@/daemon/workflows/daemonRuntime';
import { createDaemonApprovalExecutionOriginCurrentnessFromCredentials } from '@/daemon/externalActions/daemonExternalActionTargetResolver';
import { createCliActionExecutorHarness } from '@/session/actions/createCliActionExecutorHarness';
import { createCliApprovalsArtifactStore } from '@/session/actions/approvals/artifactStore';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { setActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createDiscussionReplyReturnPublisher } from './discussionReplyReturnPublisher';
import { readApprovedWorkflowDiscussionPublication } from './approvedDiscussionPublication';

it.each(['publish', 'stable_delivery', 'foreign_delivery', 'unknown_delivery', 'revoked', 'observation'] as const)('rejoins one configured-Ask Workflow approval and reopens its exact accepted typed result (%s)', async mode => {
  const accountId = 'account';
  const machineId = 'machine';
  const serverId = 'profile';
  const serverIdentityId = 'srv_workflow_approval';
  const tokenId = '8f250f0e-4f31-4f7d-8f68-61638b73b526';
  const token = `fixture.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.fixture`;
  const credentials: StoredCredentials = { token, encryption: null };
  const workflow = { runId: 'run', invocationRecordId: 'leaf', invocationAttempt: '0' };
  const authorization = { principal: { kind: 'api' as const, accountId, principalId: accountId, credentialId: tokenId }, admittedPermissionCeiling: 'default' as const };
  const origin = { discussion: { serverId, discussionId: 'discussion' }, messageId: 'question', throughSeq: 1 };
  const delivery = { ...origin, discussion: { ...origin.discussion, serverId: mode === 'stable_delivery' ? serverIdentityId
    : mode === 'foreign_delivery' ? 'srv_foreign_home' : mode === 'unknown_delivery' ? 'unknown-profile' : serverId } };
  const resultValue = { checked: true };
  const content = projectWorkflowDiscussionResultContentV1({ ...workflow, lifecycle: 'completed', result: resultValue });
  const producer = projectWorkflowDiscussionProducerV1({ ...workflow, lifecycle: 'completed', result: resultValue,
    blockKind: 'step', execution: { kind: 'detached_run', runId: 'native-run' } });
  if (!producer) throw new Error('Missing real execution producer');
  const artifacts = new Map<string, Record<string, unknown>>();
  let tokenCurrent = true;
  let resourceWrites = 0;
  const home = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json'); response.setHeader('connection', 'close');
    const path = request.url?.split('?')[0] ?? '';
    const reply = (data: unknown, status = 200) => { response.statusCode = status; response.end(JSON.stringify(data)); };
    if (path === '/v1/features') return reply({ features: { sessions: { enabled: true, conversations: { enabled: true } },
      sharing: { enabled: true, session: { enabled: true } } },
      capabilities: { serverIdentity: { serverIdentityId } } });
    if (path === '/v1/account/profile') return reply({ id: accountId });
    if (path === '/v1/account/encryption') return reply({ mode: 'plain', updatedAt: 1 });
    if (path === '/v1/account/encryption/currentness') return reply({ mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
    if (path.includes('api-tokens')) return reply({ tokens: tokenCurrent ? [{ tokenId, label: 'Workflow', displayPrefix: 'hap_v1_8f250f0e',
      createdAt: '2026-01-01T00:00:00.000Z', lastUsedAt: null, expiresAt: null, hasEncryptionAccess: false,
      hasUnattendedTeamAccess: false, grant: API_TOKEN_FULL_GRANT_V1, parentTokenId: null, activeChildCount: 0, embedConfig: null }] : [] });
    if (path === '/v2/account/settings') return reply({ version: 1, content: { t: 'plain', v: {} } });
    if (path === '/v1/discussions/discussion') return reply({ discussion: { id: 'discussion', ownerAccountId: accountId,
      encryptionMode: 'plain', anchor: null, access: 'owner', keyReadiness: true, dataEncryptionKey: null, creationLocalId: 'create',
      titleContent: { t: 'plain', v: { v: 1, title: 'Question' } },
      latestMessage: { id: 'question', localId: 'question', seq: 1, authorAccountId: accountId,
        accountActor: { v: 1, accountId, profile: null }, producerV1: null, createdAt: 1 }, messageSeq: 1,
      lastReadSeq: 0, unreadCount: 1, unreadMentionCount: 0, recentAuthorAccountIds: [], archivedAt: null,
      capabilities: { postMessages: true, rename: true, archive: true, restore: false, askAgent: true, sendToSession: true, manageAccess: true, leave: false } } });
    if (path === '/v1/discussions/discussion/data-key/recipients') return reply({ discussionId: 'discussion', ownerAccountId: accountId,
      encryptionMode: 'plain', access: 'owner', dataEncryptionKey: null, callerDataEncryptionKey: null, recipients: [] });
    if (path.startsWith('/v1/artifacts')) {
      const id = decodeURIComponent(path.split('/')[3] ?? '');
      if (path.endsWith('/access/recipients')) { const row = artifacts.get(id); return reply({ artifactId: id, ownerAccountId: accountId,
        encryptionMode: 'plain', access: 'owner', dataEncryptionKey: row?.dataEncryptionKey, callerDataEncryptionKey: row?.dataEncryptionKey, recipients: [] }); }
      if (request.method === 'GET') return artifacts.has(id) ? reply(artifacts.get(id)) : reply({ error: 'not_found' }, 404);
      let bytes = ''; for await (const chunk of request) bytes += chunk.toString();
      const body: Record<string, unknown> = JSON.parse(bytes);
      if (path === '/v1/artifacts' && typeof body.id === 'string') {
        if (artifacts.has(body.id)) return reply({ error: 'conflict' }, 409);
        artifacts.set(body.id, { ...body, ownerAccountId: accountId, access: 'owner', encryptionMode: 'plain',
          headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
        return reply({ id: body.id, headerVersion: 1, bodyVersion: 1 });
      }
      const row = artifacts.get(id);
      if (!row) return reply({ error: 'not_found' }, 404);
      if (row.headerVersion !== body.expectedHeaderVersion || row.bodyVersion !== body.expectedBodyVersion) return reply({ success: false, error: 'version-mismatch' });
      Object.assign(row, { header: body.header, body: body.body, headerVersion: Number(row.headerVersion) + 1,
        bodyVersion: Number(row.bodyVersion) + 1, seq: Number(row.seq) + 1, updatedAt: Number(row.updatedAt) + 1 });
      return reply({ success: true, headerVersion: row.headerVersion, bodyVersion: row.bodyVersion });
    }
    if (request.method !== 'GET' && path.startsWith('/v1/discussions')) resourceWrites++;
    return reply({ error: 'not_found' }, 404);
  });
  await new Promise<void>(resolve => home.listen(0, '127.0.0.1', resolve));
  onTestFinished(() => new Promise<void>((resolve, reject) => home.close(error => error ? reject(error) : resolve())));
  const address = home.address(); if (!address || typeof address === 'string') throw new Error('Missing Home address');
  const serverUrl = `http://127.0.0.1:${address.port}`;
  // The daemon normally has its current Account settings loaded before replay.
  // Use the canonical in-memory environment fixture, not a policy mock.
  runWithServerHttpBaseUrl(serverUrl, () => setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}),
    settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) }));
  onTestFinished(() => resetActiveAccountSettingsSnapshotForTests());
  const materialized = await materializeWorkflowAcceptedSnapshotV1({ definition: { version: 1, inputs: [],
    defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'external.agent', localId: 'native' } } },
    blocks: [{ kind: 'step', id: 'check', document: { text: 'Check', references: [], attachments: [] }, input: [],
      result: { kind: 'json', schema: { type: 'object', properties: { checked: { type: 'boolean' } }, required: ['checked'], additionalProperties: false } } }] },
    context: { source: { kind: 'inline' }, inputs: {}, machineId, executionTarget: { kind: 'detached_run' },
      workspaceTarget: { project: { machineId, directory: '/repo', checkoutRootPath: '/repo' } }, origin: { kind: 'direct', discussion: delivery },
      resultDelivery: { kind: 'originating_discussion', ...delivery }, authorization }, admission: { kind: 'user' },
    effects: { resolveTargetAvailability: async () => true } });
  if (!materialized.ok) throw new Error(JSON.stringify(materialized.error));
  const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
    binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId: workflow.runId }, acceptedSnapshot: materialized.snapshot }));
  const storage = createWorkflowRunStorageTestkit({ accountId, machineId, runId: workflow.runId, acceptedEnvelope, origin: { kind: 'direct' } });
  const checkpoint = { kind: 'happier.workflow-checkpoint.v1' as const, rootRecordId: 'root', nextSequence: '1', frontier: { nextBlockOrdinal: 0, paused: false } };
  const root = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ mode: 'plain',
    binding: { v: 1, purpose: 'invocation_progress', accountId, runId: workflow.runId, recordId: 'root', sequence: '0', parentRecordId: null, memberOrdinal: '0', attempt: '0' },
    progress: { kind: 'happier.workflow-progress.v1', invocationPath: { blockId: '$root', scope: [] }, blockKind: 'root', attempt: '0', logicalInvocationRecordId: 'root' } }));
  await storage.execute({ operation: 'initialize', runId: workflow.runId, expectedRevision: 0, checkpointEnvelope: 'unused', rootInvocation: { id: 'root', contentEnvelope: root } });
  const durable = await DurableWorkflowCoordinatorStore.load({ accountId, runId: workflow.runId, parentAttempt: 0, rootRecordId: 'root',
    revision: storage.run().revision, checkpoint, storage, encryption: { witness: { mode: 'plain', version: 1, contentKeyFingerprint: null }, runCrypto: { mode: 'plain' } } });
  const key = workflowInvocationKey({ runId: workflow.runId, blockId: 'check', scope: [], attempt: 0 });
  await durable.ensureIntent({ key, recordId: workflow.invocationRecordId, runId: workflow.runId, blockId: 'check', path: { blockId: 'check', scope: [] },
    blockKind: 'step', memberOrdinal: '0', attempt: 0, acceptedAtMs: 1, lifecycle: 'pending' });
  await durable.commitFact({ key, lifecycle: 'completed', result: resultValue, execution: { kind: 'detached_run', runId: 'native-run', localInputId: 'input',
    runtimeSelection: { agentTarget: { kind: 'agent', identity: { pluginId: 'external.agent', localId: 'native' } } } } });
  if (mode === 'observation') await storage.execute({ operation: 'transition', runId: workflow.runId,
    expectedRevision: storage.run().revision, state: 'interrupted', checkpointEnvelope: 'unused' });
  const observedRevision = storage.run().revision;
  const owner = createWorkflowAccountRunActionOwner({ storage, resolveAccountId: async () => accountId,
    definitions: { get: async () => { throw new Error('No mutable definition read'); } },
    resolveEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
    normalizeAbsolutePath: path => path, randomBytes: () => { throw new Error('No plaintext keys'); } });
  const acceptedCurrent = createCredentialedWorkflowAcceptedAuthorizationCurrentness({ credentials, accountId, serverId, serverHttpBaseUrl: serverUrl });
  const currentness = createDaemonApprovalExecutionOriginCurrentnessFromCredentials({ credentials, machineId, serverId,
    serverApiUrl: serverUrl, isWorkflowRunAuthorizationCurrent: acceptedCurrent });
  if (!currentness) throw new Error('Missing bound approval currentness');
  const store = createCliApprovalsArtifactStore({ credentials, serverId, serverHttpBaseUrl: serverUrl });
  const sent: DiscussionWorkflowPostPublicationV1[] = [];
  const rejectedVariants: (DiscussionWorkflowPostPublicationV1 | null)[] = [];
  let verificationFailure: unknown;
  const verify = async (input: Parameters<typeof readApprovedWorkflowDiscussionPublication>[0]) => {
    try { return await readApprovedWorkflowDiscussionPublication(input); }
    catch (error) { verificationFailure = error; throw error; }
  };
  const publisher = createDiscussionReplyReturnPublisher({ credentials, machineId, serverId, serverHttpBaseUrl: serverUrl,
    signal: new AbortController().signal, workflowAuthorization: authorization, isCurrent: () => acceptedCurrent({ authorization }),
    actionsSettingsProvider: { getAccountSettings: () => accountSettingsParse({}), getActionsSettings: () => normalizeActionsSettingsV1({ v: 1,
      actions: { 'discussion.reply': { approvalRequiredSurfaces: ['agent'] } } }) },
    postWorkflowMessage: async () => { throw new Error('Ask must not publish'); } });
  const publication = { kind: 'workflow_invocation' as const, serverId, workflow, discussion: origin, producer, content,
    ...(mode === 'observation' ? { expectedParentRevision: observedRevision } : {}) };
  expect(await publisher(publication)).toMatchObject({ ok: false, error: 'discussions_unavailable' });
  expect(artifacts.size).toBe(1);
  expect(await publisher(publication)).toMatchObject({ ok: false, error: 'discussions_unavailable' });
  expect(artifacts.size).toBe(1);
  const artifactId = [...artifacts.keys()][0]!;
  const captured = ApprovalRequestV2Schema.parse(await runWithServerHttpBaseUrl(serverUrl, () => store.approvalsGet({ artifactId })));
  expect(requiresExactDaemonApprovalReplay(captured)).toBe(true);
  expect(captured.executionOriginV1).toMatchObject({ accountId, machineId, serverIdentityId,
    caller: { kind: 'workflowRun', runId: workflow.runId, authorization } });
  const approved = ApprovalRequestV2Schema.parse({ ...captured, status: 'approved', updatedAtMs: captured.updatedAtMs + 1,
    decision: { kind: 'approve', authority: 'present_user', decidedAtMs: captured.updatedAtMs + 1 } });
  expect(await runWithServerHttpBaseUrl(serverUrl, () => store.approvalsUpdate({ artifactId, request: approved }))).toEqual({ ok: true });
  if (mode === 'observation') await storage.execute({ operation: 'transition', runId: workflow.runId,
    expectedRevision: observedRevision, state: 'interrupted', checkpointEnvelope: 'refreshed-root-progress' });
  const { executor } = createCliActionExecutorHarness({ token, credentials, sessionId: '', mode: 'plain', ctx: null,
    serverId, serverIdentityId, serverHttpBaseUrl: serverUrl, postWorkflowDiscussionMessage: async (request, options) => {
      const replayArtifactId = options.context.approvedActionReplay?.artifactId;
      if (!replayArtifactId) throw new Error('Expected admitted approval replay');
      const verification = { artifactId: replayArtifactId,
        request, content: options.content, credentials, machineId, serverId, serverUrl,
        // The deciding ingress is present-user; replay context retains the
        // original automation authority, exactly as the daemon composition does.
        callerAuthority: 'present_user', isApprovalExecutionOriginCurrent: currentness,
        executeSourceAction: async (actionId, input, context) => actionId === 'workflow.run.invocations.get'
          ? { ok: true, result: await owner.execute({ actionId, input: WorkflowInvocationGetRequestV1Schema.parse(input), context }) }
          : { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' } } satisfies Parameters<typeof readApprovedWorkflowDiscussionPublication>[0];
      rejectedVariants.push(await verify({ ...verification,
        request: { ...request, request: { ...request.request, localId: 'forged-identity' } } }));
      rejectedVariants.push(await verify({ ...verification,
        request: { ...request, request: { ...request.request, replyTarget: { kind: 'message', messageId: 'another-question' } } } }));
      rejectedVariants.push(await verify({ ...verification,
        request: { ...request, request: { ...request.request, content: { t: 'plain', v: { v: 1, parts: [{ t: 'text', text: 'FORGED' }] } } } } }));
      const accepted = await verify(verification);
      if (!accepted) return { v: 1, ok: false, error: 'discussion_post_denied' };
      sent.push(accepted);
      return { v: 1, ok: true, value: { messageSeq: 2, message: { id: 'answer', discussionId: 'discussion', localId: accepted.request.localId,
        seq: 2, authorAccountId: accountId, accountActor: { v: 1, accountId, profile: null }, producerV1: accepted.producer,
        content: accepted.request.content, mentionedAccountIds: [], replyTarget: accepted.request.replyTarget, createdAt: 2 } } };
    } }, { isApprovalExecutionOriginCurrent: currentness });
  tokenCurrent = mode !== 'revoked';
  const replay = () => runWithServerHttpBaseUrl(serverUrl, () => executor.replayApprovedApprovalRequest({ artifactId, callerAuthority: 'present_user' }));
  const replayed = await replay();
  if (mode === 'revoked') {
    expect(replayed).toMatchObject({ ok: true, result: { status: 'failed', execution: { errorCode: 'approval_stale' } } });
    expect(sent).toEqual([]);
  } else if (mode === 'foreign_delivery' || mode === 'unknown_delivery') {
    expect(replayed).toMatchObject({ ok: true, result: { status: 'failed' } });
    expect(rejectedVariants).toEqual([null, null, null]);
    expect(sent).toEqual([]);
  } else {
    expect(replayed, JSON.stringify({ replayed, verificationFailure: String(verificationFailure) }))
      .toMatchObject({ ok: true, result: { status: 'executed' } });
    expect(rejectedVariants).toEqual([null, null, null]);
    if (mode === 'observation') {
      expect(storage.run().revision).toBeGreaterThan(observedRevision);
      expect(sent[0]?.expectedParentRevision).toBe(storage.run().revision);
    }
    expect(sent).toMatchObject([{ producer, request: { content: { t: 'plain', v: content }, replyTarget: { kind: 'message', messageId: origin.messageId } } }]);
    expect(await replay())
      .toMatchObject({ ok: true, result: { status: 'executed' } });
    expect(sent).toHaveLength(1);
    expect(await publisher(publication)).toMatchObject({ ok: false });
    expect(artifacts.size).toBe(1);
  }
  expect(resourceWrites).toBe(0);
});
