import { adoptServerProfileHomeConnectionDescriptor } from '@/server/serverProfiles';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { openWorkflowProgressStoredEnvelopeV1, parseWorkflowStoredContentEnvelopeV1 } from '@happier-dev/protocol';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, onTestFinished } from 'vitest';
import { fetchServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { createAccountScopedCryptoMaterialSnapshotV1 } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { prepareWorkflowRunDataKeyV1 } from '@happier-dev/protocol/workflows/workflowRunDataKeyV1';
import type { AvailableAutomationAccountEncryptionV1 } from '@happier-dev/protocol/automations/automationAccountCurrentnessV1';
import { createPlainWorkflowRunKeyCensusFixture } from '@/daemon/workflows/workflowRunStorage.testkit';
import { getRandomBytes } from '@/api/encryption';
import { createResourceDataKey } from '@/api/encryption/resourceDataKey';
import { openSessionStoredContent, sealSessionStoredContent } from '@/session/transport/encryption/sessionStoredContentCodec';
import { accountSettingsParse, API_TOKEN_FULL_GRANT_V1, createWorkflowAccountRunActionOwner,
  materializeWorkflowAcceptedSnapshotV1, sealWorkflowAcceptedSnapshotStoredEnvelopeV1,
  sealWorkflowProgressStoredEnvelopeV1, sealWorkflowCheckpointStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1 } from '@happier-dev/protocol';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { ApprovalRequestV1Schema, ApprovalRequestV2Schema, resolveApprovalExecutor } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { WorkflowInvocationGetRequestV1Schema, WorkflowInvocationGetResultV1Schema } from '@happier-dev/protocol/workflows/actionsV1';
import { projectWorkflowDiscussionProducerV1, projectWorkflowDiscussionResultContentV1 } from '@happier-dev/protocol/workflows/workflowDiscussionPublicationV1';
import { DiscussionMachinePublicationV2Schema, type DiscussionWorkflowPostPublicationV1 } from '@happier-dev/protocol/discussions/api';
import type { StoredCredentials } from '@/persistence';
import { createWorkflowRunStorageTestkit } from '@/daemon/workflows/workflowRunStorage.testkit';
import { DurableWorkflowCoordinatorStore, createProductionWorkflowRunCoordinator } from '@/daemon/workflows/production';
import { createWorkflowCoordinator, workflowInvocationKey } from '@/daemon/workflows/coordinator';
import { createDaemonApprovalExecutionOriginCurrentnessFromCredentials } from '@/daemon/externalActions/daemonExternalActionTargetResolver';
import { createCliActionExecutorHarness } from '@/session/actions/createCliActionExecutorHarness';
import { createCliApprovalsArtifactStore } from '@/session/actions/approvals/artifactStore';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { setActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createDiscussionReplyReturnPublisher } from './discussionReplyReturnPublisher';
import { createApprovedWorkflowDiscussionPublisher } from './approvedWorkflowDiscussionPublisher';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createCurrentMachineExecutionOriginContextResolver } from '@/api/machine/resolveCurrentMachineExecutionOriginContext';
import { readApprovedWorkflowDiscussionPublication } from './approvedDiscussionPublication';
import { buildWorkflowActionContext, createCredentialedWorkflowAcceptedAuthorizationCurrentness } from '@/daemon/workflows/daemonRuntime';
import type { WorkflowStep } from '@happier-dev/protocol/workflows/workflowV1';
import { SessionMessageReplyAccountMutationV1Schema, SessionMessageReplyProgressV1Schema } from '@happier-dev/protocol/sessions/messages/sessionMessageReplyV1';
import type { DiscussionReplyReturnPublication } from '@/session/services/sessionMessageReply';
import { WORKFLOW_ATTENTION_INVOCATION_LIFECYCLES_V1, WorkflowProgressEnvelopeV1Schema } from '@happier-dev/protocol/workflows/workflowProgressV1';
import { freezeWorkflowActionContractV1, actionSpecToActionDefinitionV1 } from '@happier-dev/protocol/actions/actionCatalog';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { DiscussionParticipantsListResponseV1Schema } from '@happier-dev/protocol/discussions/participants';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';

it.each([undefined, {}])('refuses Workflow publication without a persisted approval Artifact (%j)', async approvedActionReplay => {
  const content = { v: 1 as const, parts: [{ t: 'text' as const, text: 'answer' }] };
  const publish = createApprovedWorkflowDiscussionPublisher({
    credentials: { token: 'fixture', encryption: null }, machineId: 'machine', serverId: 'profile', serverUrl: 'https://home.invalid',
    callerAuthority: 'present_user', executeSourceAction: createActionExecutor(createUnavailableActionTransportDeps()).execute, getClient: () => null,
  });
  expect(await publish({ discussionId: 'discussion', request: { localId: 'reply', content: { t: 'plain', v: content }, mentionedAccountIds: [] } },
    { context: { approvedActionReplay }, content })).toMatchObject({ ok: false, errorCode: 'discussion_replay_approval_missing' });
});

const readerDenials = [
  ['adapter_context', 'discussion_action_session_missing'],
  ['approval_invalid', 'approval_invalid'],
  ['approval_version', 'discussion_replay_approval_version_unsupported'],
  ['approval_status', 'discussion_replay_approval_not_executing'],
  ['approval_action', 'discussion_replay_action_mismatch'],
  ['approval_decision', 'discussion_replay_decision_authority_mismatch'],
  ['approval_marker', 'discussion_replay_return_missing'],
  ['approval_session_marker', 'discussion_replay_return_invalid'],
  ['approval_server', 'discussion_replay_server_mismatch'],
  ['approval_machine', 'discussion_replay_machine_mismatch'],
  ['approval_account', 'discussion_replay_account_mismatch'],
  ['approval_input', 'discussion_replay_approved_input_invalid'],
  ['caller', 'present_user_required'],
  ['currentness', 'approval_stale'],
  ['source_read', 'run_not_found'],
  ['source_shape', 'discussion_replay_source_invalid'],
  ['source_invocation', 'discussion_replay_invocation_mismatch'],
  ['source_attempt', 'discussion_replay_attempt_mismatch'],
  ['source_review', 'discussion_replay_review_pending'],
  ['source_delivery_missing', 'discussion_replay_delivery_missing'],
  ['source_delivery_mismatch', 'discussion_replay_delivery_mismatch'],
  ['source_result', 'discussion_replay_result_mismatch'],
  ['request_local_id', 'discussion_replay_local_id_mismatch'],
  ['request_discussion', 'discussion_replay_discussion_mismatch'],
  ['request_target', 'discussion_replay_reply_target_mismatch'],
  ['request_mentions', 'discussion_replay_mentions_not_empty'],
  ['request_content', 'discussion_replay_content_mismatch'],
  ['resource_status', 'discussion_replay_resource_unavailable'],
  ['resource_readiness', 'discussion_replay_resource_not_ready'],
  ['sealed_envelope', 'discussion_replay_envelope_invalid'],
  ['sealed_content', 'discussion_replay_sealed_content_mismatch'],
] as const;
type ReaderDenial = typeof readerDenials[number];
const daemonDenials = [
  ['approval', 'discussion_replay_approval_missing'],
  ['caller', 'present_user_required'],
  ['marker', 'discussion_replay_context_return_missing'],
  ['marker_kind', 'discussion_replay_context_return_invalid'],
  ['currentness', 'discussion_replay_approval_context_missing'],
  ['machine_context', 'discussion_replay_machine_context_unavailable'],
  ['machine', 'discussion_replay_current_machine_mismatch'],
  ['home', 'discussion_replay_current_home_mismatch'],
  ['client', 'discussion_replay_machine_client_unavailable'],
] as const;
type DaemonDenial = typeof daemonDenials[number];
const transportDenials = ['recipient_key_pending', 'discussion_workflow_frontier_mismatch'] as const;
const publicationModes = ['publish', 'settlement', 'settlement_restart', 'settlement_restart_e2ee', 'settlement_restart_transient', 'settlement_restart_deleted', 'settlement_restart_claim_lost', 'settlement_restart_paused', 'settlement_restart_misbound', 'settlement_rejected', 'settlement_canceled', 'settlement_session', 'settlement_session_retry', 'settlement_session_rejected', 'settlement_session_canceled', 'settlement_parallel', 'settlement_parallel_reject_first', 'settlement_parallel_approve_first', 'settlement_parallel_reject_both', 'settlement_provenance_entry', 'settlement_provenance_resolution', 'settled_parent', 'stable_replay_home', 'stable_delivery', 'foreign_delivery', 'unknown_delivery', 'revoked', 'observation', 'no_person', 'wrong_run', 'causal'] as const;
it.each(publicationModes)('rejoins one configured-Ask Workflow approval and reopens its exact accepted typed result (%s)', mode => runPublicationCase(mode));
it.each(readerDenials)('records reader %s as %s in the Artifact', (...denial: ReaderDenial) =>
  runPublicationCase(denial[0].startsWith('approval_') || denial[0].startsWith('source_') || denial[0].startsWith('adapter_')
    ? 'starter' : 'settlement_restart', denial));

it.each(daemonDenials)('records daemon %s as %s in the Artifact', (...denial: DaemonDenial) =>
  runPublicationCase(denial[0] === 'currentness' ? 'settlement_restart' : 'starter', undefined, denial));

it.each(transportDenials)('records the Machine/custody transport code %s in the Artifact', code =>
  runPublicationCase('starter', undefined, undefined, code));

async function runPublicationCase(mode: typeof publicationModes[number] | 'starter', denial?: ReaderDenial, daemonDenial?: DaemonDenial,
  transportDenial?: typeof transportDenials[number]) {
  const settlement = mode.startsWith('settlement');
  const restart = mode.startsWith('settlement_restart');
  const decidedBeforeReclaim = mode === 'settlement_restart_claim_lost' || mode === 'settlement_restart_paused';
  let discussionUnavailable = false;
  let discussionDeleted = false;
  let discussionKeyReady = true;
  let sourceDeliveryMissing = false;
  const retainedSession = mode.startsWith('settlement_session');
  const parallel = mode.startsWith('settlement_parallel');
  const parallelRefusal = parallel && mode !== 'settlement_parallel';
  const provenanceRace = mode === 'settlement_provenance_entry' || mode === 'settlement_provenance_resolution';
  const rejected = mode.endsWith('_rejected');
  const canceled = mode.endsWith('_canceled');
  const directory = retainedSession ? await mkdtemp(join(tmpdir(), 'workflow-publication-')) : '/repo';
  if (retainedSession) onTestFinished(() => rm(directory, { recursive: true, force: true }));
  if (retainedSession) {
    const admitted = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController, runtimeOptions: { pluginIds: [] } });
    onTestFinished(() => admitted.dispose());
  }
  const accountId = 'account';
  const machineId = 'machine';
  const sessionRecord = createSessionRecordFixture({ id: 'session', encryptionMode: 'plain',
    metadata: JSON.stringify({ path: directory, host: 'host', machineId }) });
  const serverIdentityId = 'srv_workflow_approval';
  // Person decisions use a portable Home identity at the real Account port.
  // A fabricated local alias has no saved Home binding in this fixture.
  const serverId = retainedSession || parallelRefusal || decidedBeforeReclaim ? serverIdentityId : 'profile';
  const tokenId = '8f250f0e-4f31-4f7d-8f68-61638b73b526';
  const token = `fixture.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.fixture`;
  const encrypted = mode === 'settlement_restart_e2ee';
  const secret = new Uint8Array(32).fill(7);
  const credentials: StoredCredentials = { token, encryption: encrypted ? { type: 'legacy', secret } : null };
  const material = encrypted ? createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material: { type: 'legacy', secret } }) : null;
  const accountEncryption: AvailableAutomationAccountEncryptionV1 = material
    ? { kind: 'available', material, witness: { mode: 'e2ee', version: 1,
      contentKeyFingerprint: convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(material.contentPublicKeyFingerprint) } }
    : { kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } };
  const { witness } = accountEncryption;
  const runKeys = prepareWorkflowRunDataKeyV1({ accountId, encryption: accountEncryption, randomBytes: getRandomBytes });
  const sealMode = runKeys.runCrypto.mode === 'plain' ? { mode: 'plain' as const }
    : { mode: 'e2ee' as const, runDataKey: runKeys.runCrypto.runDataKey, randomBytes: getRandomBytes };
  const resourceKey = await createResourceDataKey({ credentials, mode: witness.mode });
  const resourceCrypto = resourceKey.mode === 'plain' ? { mode: 'plain' as const, ctx: null }
    : { mode: 'e2ee' as const, ctx: { encryptionKey: resourceKey.dataKey, encryptionVariant: 'dataKey' as const } };
  const workflow = { runId: 'run', invocationRecordId: 'leaf', invocationAttempt: '0' };
  const authorization = { principal: { kind: 'api' as const, accountId, principalId: accountId, credentialId: tokenId }, admittedPermissionCeiling: 'default' as const };
  const origin = { discussion: { serverId, discussionId: 'discussion' }, messageId: 'question', throughSeq: 1 };
  const delivery = { ...origin, discussion: { ...origin.discussion, serverId: mode === 'stable_delivery' ? serverIdentityId
    : mode === 'foreign_delivery' ? 'srv_foreign_home' : mode === 'unknown_delivery' ? 'unknown-profile' : serverId } };
  const resultValue = provenanceRace ? '' : { checked: true };
  let original = SessionMessageReplyProgressV1Schema.parse({ v: 1, mode: 'wait',
    workflow: { purpose: 'invocation', runId: workflow.runId, invocationRecordId: workflow.invocationRecordId },
    disposition: 'return_pending', discussion: { discussionId: origin.discussion.discussionId,
      messageId: origin.messageId, throughSeq: origin.throughSeq, participantSessionId: 'session' },
    outcome: { kind: 'answer', result: { sessionId: 'session', messageId: 'native-answer' } } });
  let retainedOriginalReads = 0;
  let originalDecisionWrites = 0;
  let invalidOriginalMutations = 0;
  const originalMutationCodes: string[] = [];
  let sessionAppends = 0;
  let directTailAppends = 0;
  let tailDeliveries = 0;
  const homeReads: string[] = [];
  const content = projectWorkflowDiscussionResultContentV1({ ...workflow, lifecycle: 'completed', result: resultValue });
  const producer = projectWorkflowDiscussionProducerV1({ ...workflow, lifecycle: 'completed', result: resultValue,
    blockKind: 'step', execution: { kind: 'detached_run', runId: 'native-run' } });
  if (!producer) throw new Error('Missing real execution producer');
  if (!content) throw new Error('Expected completed Workflow content');
  const artifacts = new Map<string, Record<string, unknown>>();
  const approvalChangeWaiters = new Set<() => void>();
  let approvalObservationStarted = () => {};
  let observingApproval = new Promise<void>(resolve => { approvalObservationStarted = resolve; });
  const observedArtifacts = new Set<string>();
  let approvalsObserved = () => {};
  const observingAllApprovals = new Promise<void>(resolve => { approvalsObserved = resolve; });
  const coordinationController = new AbortController();
  onTestFinished(() => coordinationController.abort());
  const starter = { requestRef: workflow.runId,
    requester: { serverId: serverIdentityId, accountId: mode === 'causal' ? machineId : accountId } };
  const causal = { requestRef: workflow.invocationRecordId, requester: { serverId: serverIdentityId, accountId },
    persona: { serverId: serverIdentityId, sessionId: workflow.runId }, origin: null };
  let tokenCurrent = true;
  let resourceWrites = 0;
  const home = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json'); response.setHeader('connection', 'close');
    const path = request.url?.split('?')[0] ?? '';
    const reply = (data: unknown, status = 200) => { response.statusCode = status; response.end(JSON.stringify(data)); };
    homeReads.push(`${request.method} ${path}`);
    if (path === '/v2/sessions/session') return reply({ session: sessionRecord });
    if (path === '/v2/sessions') return reply({ sessions: [sessionRecord], hasNext: false, nextCursor: null });
    if (path === '/v1/discussions/discussion/participants') return reply(DiscussionParticipantsListResponseV1Schema.parse({
      discussionId: origin.discussion.discussionId, ownerAccountId: accountId, access: 'owner', grants: [],
      participants: [{ participant: { kind: 'session', sessionId: 'session' }, answerPolicy: 'when_addressed', createdAt: 1 }],
    }));
    if (path === '/v2/sessions/session/messages/by-local-id/input/reply') {
      if (request.method === 'GET') { retainedOriginalReads++; return reply({ v: 1, status: 'available', progress: original }); }
      let bytes = ''; for await (const chunk of request) bytes += chunk.toString();
      // This HTTP boundary uses the real route's strict mutation admission.
      const parsed = SessionMessageReplyAccountMutationV1Schema.safeParse(JSON.parse(bytes));
      if (!parsed.success) { invalidOriginalMutations++; originalMutationCodes.push('invalid_request'); return reply({ error: 'invalid_request' }, 400); }
      const body = parsed.data;
      if (body.kind !== 'discussion_publication') { originalMutationCodes.push(body.kind); return reply({ error: 'conflict' }, 409); }
      if (body.approvalArtifactId !== undefined) {
        if (original.returnPublication?.kind !== 'approval_pending'
          || original.returnPublication.artifactId !== body.approvalArtifactId) { originalMutationCodes.push('artifact_mismatch'); return reply({ error: 'conflict' }, 409); }
        originalDecisionWrites++;
      }
      original = SessionMessageReplyProgressV1Schema.parse({ ...original, returnPublication: body.publication,
        ...(body.publication.kind === 'failed' && !body.publication.failure.retryable ? { disposition: 'released' } : {}) });
      return reply({ v: 1, ok: true, progress: original });
    }
    if (path === '/v3/automations/runs/workflow-storage') {
      let bytes = ''; for await (const chunk of request) bytes += chunk.toString();
      // Substitute only opaque HTTP storage; the cold replay uses the real CLI Action family.
      const operation: Parameters<typeof storage.execute>[0] = JSON.parse(bytes);
      let stored;
      try { stored = await storage.execute(operation); }
      catch (error) {
        // Mirror the HTTP storage owner's exact missing-record response.
        if (error && typeof error === 'object' && 'response' in error && error.response
          && typeof error.response === 'object' && 'status' in error.response && error.response.status === 404) {
          return reply({ error: 'run_not_found' }, 404);
        }
        throw error;
      }
      return reply(stored);
    }
    if (path === '/v1/features') return reply({ features: { automations: { enabled: true }, workflows: { enabled: true }, sessions: { enabled: true, conversations: { enabled: true } },
      sharing: { enabled: true, session: { enabled: true } } },
      capabilities: { serverIdentity: { serverIdentityId } } });
    if (path === '/v1/account/profile') return reply({ id: accountId });
    if (path === '/v1/account/encryption') return reply({ mode: witness.mode, updatedAt: 1 });
    if (path === '/v1/account/encryption/currentness') return reply({ ...witness, signingKeyFingerprint: encrypted ? 'a'.repeat(64) : null, updatedAt: 1,
      ...(encrypted ? { recipientEnvelopeReadiness: { status: 'available' } } : {}) });
    if (path.includes('api-tokens')) return reply({ tokens: tokenCurrent ? [{ tokenId, label: 'Workflow', displayPrefix: 'hap_v1_8f250f0e',
      createdAt: '2026-01-01T00:00:00.000Z', lastUsedAt: null, expiresAt: null, hasEncryptionAccess: encrypted,
      hasUnattendedTeamAccess: false, grant: API_TOKEN_FULL_GRANT_V1, parentTokenId: null, activeChildCount: 0, embedConfig: null }] : [] });
    if (path === '/v2/account/settings') return reply({ version: 1, content: { t: 'plain', v: {} } });
    if (path === '/v1/discussions/discussion' && discussionUnavailable) return reply({ error: 'discussions_unavailable' }, 503);
    if (path === '/v1/discussions/discussion' && discussionDeleted) return reply({ error: 'discussion_not_found' }, 404);
    if (path === '/v1/discussions/discussion') return reply({ discussion: { id: 'discussion', ownerAccountId: accountId,
      encryptionMode: witness.mode, anchor: null, access: 'owner', keyReadiness: discussionKeyReady, dataEncryptionKey: resourceKey.dataEncryptionKey, creationLocalId: 'create',
      titleContent: sealSessionStoredContent({ ...resourceCrypto, payload: { v: 1, title: 'Question' } }),
      latestMessage: { id: 'question', localId: 'question', seq: 1, authorAccountId: accountId,
        accountActor: { v: 1, accountId, profile: null }, producerV1: null, createdAt: 1 }, messageSeq: 1,
      lastReadSeq: 0, unreadCount: 1, unreadMentionCount: 0, recentAuthorAccountIds: [], archivedAt: null,
      capabilities: { postMessages: true, rename: true, archive: true, restore: false, askAgent: true, sendToSession: true, manageAccess: true, leave: false } } });
    if (path === '/v1/discussions/discussion/data-key/recipients') return reply({ discussionId: 'discussion', ownerAccountId: accountId,
      encryptionMode: witness.mode, access: 'owner', dataEncryptionKey: resourceKey.dataEncryptionKey, callerDataEncryptionKey: resourceKey.dataEncryptionKey, recipients: [] });
    if (path.startsWith('/v1/artifacts')) {
      const id = decodeURIComponent(path.split('/')[3] ?? '');
      if (path.endsWith('/access/recipients')) { const row = artifacts.get(id); return reply({ artifactId: id, ownerAccountId: accountId,
        encryptionMode: witness.mode, access: 'owner', dataEncryptionKey: row?.dataEncryptionKey, callerDataEncryptionKey: row?.dataEncryptionKey, recipients: [] }); }
      if (request.method === 'GET') return artifacts.has(id) ? reply(artifacts.get(id)) : reply({ error: 'not_found' }, 404);
      let bytes = ''; for await (const chunk of request) bytes += chunk.toString();
      const body: Record<string, unknown> = JSON.parse(bytes);
      if (path === '/v1/artifacts' && typeof body.id === 'string') {
        if (artifacts.has(body.id)) return reply({ error: 'conflict' }, 409);
        artifacts.set(body.id, { ...body, ownerAccountId: accountId, access: 'owner', encryptionMode: witness.mode,
          headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
        return reply(artifacts.get(body.id));
      }
      const row = artifacts.get(id);
      if (!row) return reply({ error: 'not_found' }, 404);
      if (row.headerVersion !== body.expectedHeaderVersion || row.bodyVersion !== body.expectedBodyVersion) return reply({ success: false, error: 'version-mismatch' });
      Object.assign(row, { header: body.header, body: body.body, headerVersion: Number(row.headerVersion) + 1,
        bodyVersion: Number(row.bodyVersion) + 1, seq: Number(row.seq) + 1, updatedAt: Number(row.updatedAt) + 1 });
      for (const wake of approvalChangeWaiters) wake();
      return reply({ success: true, headerVersion: row.headerVersion, bodyVersion: row.bodyVersion });
    }
    if (request.method !== 'GET' && path.startsWith('/v1/discussions')) resourceWrites++;
    return reply({ error: 'not_found' }, 404);
  });
  await new Promise<void>(resolve => home.listen(0, '127.0.0.1', resolve));
  onTestFinished(() => new Promise<void>((resolve, reject) => home.close(error => error ? reject(error) : resolve())));
  const address = home.address(); if (!address || typeof address === 'string') throw new Error('Missing Home address');
  const serverUrl = `http://127.0.0.1:${address.port}`;
  const serverFeaturesSnapshot = await fetchServerFeaturesSnapshot({ serverUrl, token });
  if (mode === 'stable_replay_home') await adoptServerProfileHomeConnectionDescriptor({ expectedProfileId: serverId, createIfMissing: true,
    observation: 'exact', descriptor: { v: 1, homeServerIdentityId: serverIdentityId, canonicalServerUrl: serverUrl,
      revision: 1, endpoints: [{ kind: 'https', url: serverUrl }] } });
  // The daemon normally has its current Account settings loaded before replay.
  // Use the canonical in-memory environment fixture, not a policy mock.
  runWithServerHttpBaseUrl(serverUrl, () => setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({
    actionsSettingsV1: normalizeActionsSettingsV1({ v: 1, actions: { 'discussion.reply': { approvalRequiredSurfaces: ['agent'] } } }),
  }),
    settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) }));
  onTestFinished(() => resetActiveAccountSettingsSnapshotForTests());
  const loadDefaultAccountSettings = () => runWithServerHttpBaseUrl(serverUrl,
    () => setActiveAccountSettingsSnapshot({ source: 'network',
      settings: accountSettingsParse({ actionsSettingsV1: normalizeActionsSettingsV1({ v: 1, actions: {} }) }),
      settingsVersion: 2, loadedAtMs: 2, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) }));
  const check: WorkflowStep = { kind: 'step', id: 'check', document: { text: 'Check', references: [], attachments: [] }, input: [],
    // The completed source's separate shared-conversation repair would wait
    // on the root queue before the notification could capture stale state.
    ...(provenanceRace ? { execution: { conversation: { kind: 'fresh' } } }
      : retainedSession ? { execution: { executionTarget: { kind: 'session' } } } : {}),
    result: provenanceRace ? { kind: 'text' }
      : { kind: 'json', schema: { type: 'object', properties: { checked: { type: 'boolean' } }, required: ['checked'], additionalProperties: false } } };
  const notification = { kind: 'action' as const, id: 'quiet', actionId: 'notifications.notify_me',
    input: { message: { kind: 'result' as const, producer: { blockId: 'check', scope: { kind: 'current' as const } }, path: [] } },
    onlyWhen: { kind: 'compare' as const, operator: 'neq' as const,
      left: { kind: 'result' as const, producer: { blockId: 'check', scope: { kind: 'current' as const } }, path: [] },
      right: { kind: 'literal' as const, value: '' } } };
  const materialized = await materializeWorkflowAcceptedSnapshotV1({ definition: { version: 1, inputs: [],
    defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'external.agent', localId: 'native' } } },
    blocks: provenanceRace ? [check, notification] : parallel ? [{ kind: 'parallel', id: 'pair', failurePolicy: parallelRefusal ? 'collect_outcomes' : 'fail_stop', branches: [
      { id: 'a', blocks: [check] }, { id: 'b', blocks: [{ ...check, id: 'second' }] },
    ] }] : [check, ...(retainedSession ? [{ kind: 'action' as const, id: 'tail', actionId: 'notifications.notify_me',
      input: { message: { kind: 'literal' as const, value: 'Tail complete' } } }] : [])] },
    context: { source: { kind: 'inline' }, inputs: {}, machineId, executionTarget: { kind: 'detached_run' },
      workspaceTarget: { project: { machineId, directory, checkoutRootPath: directory } }, origin: { kind: 'direct', discussion: delivery,
        ...(mode === 'no_person' ? {} : { authenticatedStarterV1: starter }),
        ...(mode === 'causal' ? { actionRequestAttributionV1: causal } : {}) },
      resultDelivery: { kind: 'originating_discussion', ...delivery }, authorization }, admission: { kind: 'user' },
    effects: { resolveTargetAvailability: async () => true,
      readActionContract: async () => freezeWorkflowActionContractV1(actionSpecToActionDefinitionV1(getActionSpec('notifications.notify_me'))) } });
  if (!materialized.ok) throw new Error(JSON.stringify(materialized.error));
  const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ ...sealMode,
    binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId: workflow.runId }, acceptedSnapshot: materialized.snapshot }));
  const acceptedWithoutDeliveryEnvelope = denial?.[0] !== 'source_delivery_missing' ? acceptedEnvelope
    : serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ ...sealMode,
    binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId: workflow.runId },
    acceptedSnapshot: (({ resultDelivery: _resultDelivery, ...snapshot }) => snapshot)(materialized.snapshot) }));
  const keyCensus = { ...createPlainWorkflowRunKeyCensusFixture({ accountId, runId: workflow.runId }),
    ownerAccountCurrentness: witness, encryptionMode: witness.mode,
    dataEncryptionKey: runKeys.recipientKeyEnvelopes[0]?.encryptedDataKey ?? null,
    callerDataEncryptionKey: runKeys.recipientKeyEnvelopes[0]?.encryptedDataKey ?? null };
  const storageBoundary = createWorkflowRunStorageTestkit({ accountId, machineId, runId: workflow.runId,
    acceptedEnvelope, keyCensus, origin: { kind: 'direct' } });
  let holdRootControl = false;
  let releaseRootControl = () => {};
  const rootControlGate = new Promise<void>(resolve => { releaseRootControl = resolve; });
  onTestFinished(() => releaseRootControl());
  let rootControlStarted = () => {};
  const rootControlRead = new Promise<void>(resolve => { rootControlStarted = resolve; });
  let observeSourceFrontier = false;
  let sourceFrontierCommitted = () => {};
  const sourceFrontier = new Promise<void>(resolve => { sourceFrontierCommitted = resolve; });
  let terminalSettlements = 0;
  const storage = { ...storageBoundary, execute: async (request: Parameters<typeof storageBoundary.execute>[0]) => {
    if (request.operation === 'transition' && (request.state === 'failed' || request.state === 'succeeded')) terminalSettlements++;
    const response = await storageBoundary.execute(request);
    if (holdRootControl && request.operation === 'get') {
      holdRootControl = false;
      rootControlStarted();
      await rootControlGate;
    }
    if (observeSourceFrontier && request.operation === 'transition') sourceFrontierCommitted();
    return sourceDeliveryMissing && request.operation === 'get' && response && typeof response === 'object'
      ? { ...response, acceptedEnvelope: acceptedWithoutDeliveryEnvelope } : response;
  } };
  const checkpoint = { kind: 'happier.workflow-checkpoint.v1' as const, rootRecordId: 'root', nextSequence: '1', frontier: { nextBlockOrdinal: 0, paused: false } };
  const checkpointEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowCheckpointStoredEnvelopeV1({ ...sealMode,
    binding: { v: 1, purpose: 'checkpoint', accountId, runId: workflow.runId }, checkpoint }));
  const root = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ ...sealMode,
    binding: { v: 1, purpose: 'invocation_progress', accountId, runId: workflow.runId, recordId: 'root', sequence: '0', parentRecordId: null, memberOrdinal: '0', attempt: '0' },
    progress: { kind: 'happier.workflow-progress.v1', invocationPath: { blockId: '$root', scope: [] }, blockKind: 'root', attempt: '0', logicalInvocationRecordId: 'root' } }));
  await storage.execute({ operation: 'initialize', runId: workflow.runId, expectedRevision: 0, checkpointEnvelope, rootInvocation: { id: 'root', contentEnvelope: root } });
  const durable = await DurableWorkflowCoordinatorStore.load({ accountId, runId: workflow.runId, parentAttempt: 0, rootRecordId: 'root',
    revision: storage.run().revision, checkpoint, storage, encryption: { witness, runCrypto: runKeys.runCrypto } });
  const scope = parallel ? [{ kind: 'branch' as const, blockId: 'pair', branchId: 'a' }] : [];
  const pairKey = workflowInvocationKey({ runId: workflow.runId, blockId: 'pair', scope: [], attempt: 0 });
  const branchKey = workflowInvocationKey({ runId: workflow.runId, blockId: 'pair', scope, attempt: 0 });
  if (parallel) {
    await durable.ensureIntent({ key: pairKey, recordId: 'pair', runId: workflow.runId, blockId: 'pair',
      path: { blockId: 'pair', scope: [] }, blockKind: 'parallel', attempt: 0, acceptedAtMs: 0, lifecycle: 'running',
      memberOrdinal: '0', container: { kind: 'parallel', nextBranchOrdinal: '0' } });
    for (const [index, branchId] of ['a', 'b'].entries()) {
      const branchScope = [{ kind: 'branch' as const, blockId: 'pair', branchId }];
      await durable.ensureIntent({ key: workflowInvocationKey({ runId: workflow.runId, blockId: 'pair', scope: branchScope, attempt: 0 }),
        recordId: `branch-${branchId}`, runId: workflow.runId, blockId: 'pair', path: { blockId: 'pair', scope: branchScope },
        blockKind: 'parallel', parentKey: pairKey, memberOrdinal: String(index), attempt: 0, acceptedAtMs: 0, lifecycle: 'running',
        frame: { ownerBlockId: 'pair', source: { kind: 'branch', branchId } }, container: { kind: 'body', nextBlockOrdinal: '0' } });
    }
  }
  const key = workflowInvocationKey({ runId: workflow.runId, blockId: 'check', scope, attempt: 0 });
  await durable.ensureIntent({ key, recordId: workflow.invocationRecordId, runId: workflow.runId, blockId: 'check', path: { blockId: 'check', scope },
    ...(parallel ? { parentKey: branchKey } : {}),
    blockKind: 'step', memberOrdinal: '0', attempt: 0, acceptedAtMs: 1, lifecycle: 'pending' });
  await durable.commitFact({ key, lifecycle: 'completed', result: resultValue, execution: retainedSession
    ? { kind: 'session', sessionId: 'session', localInputId: 'input' }
    : { kind: 'detached_run', runId: 'native-run', localInputId: 'input',
      runtimeSelection: { agentTarget: { kind: 'agent', identity: { pluginId: 'external.agent', localId: 'native' } } } } });
  const secondWorkflow = { ...workflow, invocationRecordId: 'second-leaf' };
  const secondProducer = projectWorkflowDiscussionProducerV1({ ...secondWorkflow, lifecycle: 'completed', result: resultValue,
    blockKind: 'step', execution: { kind: 'detached_run', runId: 'second-native' } });
  if (!secondProducer) throw new Error('Missing second producer');
  if (parallel) {
    const secondScope = [{ kind: 'branch' as const, blockId: 'pair', branchId: 'b' }];
    const secondKey = workflowInvocationKey({ runId: workflow.runId, blockId: 'second', scope: secondScope, attempt: 0 });
    await durable.ensureIntent({ key: secondKey, recordId: secondWorkflow.invocationRecordId, runId: workflow.runId, blockId: 'second',
      path: { blockId: 'second', scope: secondScope }, blockKind: 'step',
      parentKey: workflowInvocationKey({ runId: workflow.runId, blockId: 'pair', scope: secondScope, attempt: 0 }),
      memberOrdinal: '0', attempt: 0, acceptedAtMs: 0, lifecycle: 'pending' });
    await durable.commitFact({ key: secondKey, lifecycle: 'completed', result: resultValue,
      execution: { kind: 'detached_run', runId: 'second-native', localInputId: 'input',
        runtimeSelection: { agentTarget: { kind: 'agent', identity: { pluginId: 'external.agent', localId: 'native' } } } } });
  }
  if (mode === 'observation') await storage.execute({ operation: 'transition', runId: workflow.runId,
    expectedRevision: storage.run().revision, state: 'interrupted', checkpointEnvelope: 'unused' });
  const observedRevision = storage.run().revision;
  const owner = createWorkflowAccountRunActionOwner({ storage, resolveAccountId: async () => accountId,
    definitions: { get: async () => { throw new Error('No mutable definition read'); } },
    resolveEncryption: async () => accountEncryption,
    normalizeAbsolutePath: path => path, randomBytes: () => { throw new Error('No plaintext keys'); } });
  const acceptedCurrent = createCredentialedWorkflowAcceptedAuthorizationCurrentness({ credentials, accountId, serverId, serverHttpBaseUrl: serverUrl });
  const currentness = createDaemonApprovalExecutionOriginCurrentnessFromCredentials({ credentials, machineId, serverId,
    serverApiUrl: serverUrl });
  if (!currentness) throw new Error('Missing bound approval currentness');
  const store = createCliApprovalsArtifactStore({ credentials, serverId, serverHttpBaseUrl: serverUrl });
  const sent: DiscussionWorkflowPostPublicationV1[] = [];
  const rejectedVariants: Awaited<ReturnType<typeof readApprovedWorkflowDiscussionPublication>>[] = [];
  let verificationFailure: unknown;
  const verify = async (input: Parameters<typeof readApprovedWorkflowDiscussionPublication>[0]) => {
    try { return await readApprovedWorkflowDiscussionPublication(input); }
    catch (error) { verificationFailure = error; throw error; }
  };
  const publisher = createDiscussionReplyReturnPublisher({ credentials, machineId, serverId, serverHttpBaseUrl: serverUrl,
    signal: new AbortController().signal, workflowActionContext: buildWorkflowActionContext({ ...materialized.snapshot,
      runId: mode === 'wrong_run' ? workflow.invocationRecordId : workflow.runId }), isCurrent: () => acceptedCurrent({ authorization }),
    actionsSettingsProvider: { getAccountSettings: () => accountSettingsParse({}), getActionsSettings: () => normalizeActionsSettingsV1({ v: 1,
      actions: { 'discussion.reply': { approvalRequiredSurfaces: ['agent'] } } }) },
    postWorkflowMessage: async () => { throw new Error('Ask must not publish'); } });
  const publication: DiscussionReplyReturnPublication = retainedSession ? { serverId, workflow, requestSessionId: 'session', requestLocalId: 'input',
    discussion: original.discussion!, outcome: original.outcome!, message: 'Accepted result', content }
    : { kind: 'workflow_invocation', serverId, workflow, discussion: origin, producer, content,
      ...(mode === 'observation' ? { expectedParentRevision: observedRevision } : {}) };
  const pendingPublication = await publisher(publication);
  if (mode === 'no_person' || mode === 'wrong_run') {
    expect(pendingPublication).toMatchObject({ ok: false });
    expect(pendingPublication).not.toHaveProperty('pending');
    expect(await publisher(publication)).toMatchObject({ ok: false });
    expect(artifacts.size).toBe(0);
    expect(sent).toEqual([]);
    expect(resourceWrites).toBe(0);
    return;
  }
  expect(pendingPublication, JSON.stringify({ homeReads, publicationCode: !pendingPublication.ok ? pendingPublication.error : undefined,
    failure: 'failure' in pendingPublication ? pendingPublication.failure : undefined })).toMatchObject({ ok: false, error: 'discussions_unavailable',
    pending: { kind: 'approval', artifactId: [...artifacts.keys()][0] } });
  expect(artifacts.size).toBe(1);
  expect(await publisher(publication)).toMatchObject({ ok: false, error: 'discussions_unavailable' });
  expect(artifacts.size).toBe(1);
  const artifactId = [...artifacts.keys()][0]!;
  if (retainedSession) original = SessionMessageReplyProgressV1Schema.parse({ ...original,
    returnPublication: mode === 'settlement_session_retry'
      ? { kind: 'failed', failure: { code: 'discussions_unavailable', phase: 'machine_publisher', retryable: true } }
      : { kind: 'approval_pending', artifactId } });
  let secondArtifactId: string | undefined;
  if (parallel) {
    const secondContent = projectWorkflowDiscussionResultContentV1({ ...secondWorkflow, lifecycle: 'completed', result: resultValue });
    if (!secondContent) throw new Error('Missing second content');
    expect(await publisher({ kind: 'workflow_invocation', serverId, workflow: secondWorkflow, discussion: origin,
      producer: secondProducer, content: secondContent })).toMatchObject({ ok: false, pending: { kind: 'approval' } });
    secondArtifactId = [...artifacts.keys()].find(id => id !== artifactId);
    expect(secondArtifactId).toBeDefined();
  }
  const captured = ApprovalRequestV2Schema.parse(await runWithServerHttpBaseUrl(serverUrl, () => store.approvalsGet({ artifactId })));
  if (mode === 'settled_parent') await storage.execute({ operation: 'transition', runId: workflow.runId,
    expectedRevision: storage.run().revision, state: 'succeeded', custodyState: 'settled', checkpointEnvelope: 'unused' });
  expect(resolveApprovalExecutor(captured)).toMatchObject({ kind: 'daemon' });
  if (captured.executionOriginV1?.caller.kind !== 'workflowRun') throw new Error('Missing Workflow approval caller');
  expect(captured.executionOriginV1.caller.authenticatedStarterV1).toEqual(mode === 'causal' ? undefined : starter);
  expect(captured.executionOriginV1.actionRequestAttributionV1).toEqual(mode === 'causal' ? causal : undefined);
  expect(captured.executionOriginV1).toMatchObject({ accountId, machineId, serverIdentityId,
    caller: { kind: 'workflowRun', runId: workflow.runId, authorization } });
  const approved = ApprovalRequestV2Schema.parse({ ...captured, status: 'approved', updatedAtMs: captured.updatedAtMs + 1,
    decision: { kind: 'approve', authority: 'present_user', decidedAtMs: captured.updatedAtMs + 1 } });
  if (!settlement) {
    expect(await runWithServerHttpBaseUrl(serverUrl, () => store.approvalsUpdate({ artifactId, request: approved }))).toEqual({ ok: true });
  }
  if (mode === 'observation') await storage.execute({ operation: 'transition', runId: workflow.runId,
    expectedRevision: observedRevision, state: 'interrupted', checkpointEnvelope: 'refreshed-root-progress' });
  const { executor, observeRecordedApprovalExecution } = createCliActionExecutorHarness({ token, credentials, sessionId: '', mode: 'plain', ctx: null,
    resolveServerFeaturesSnapshot: () => serverFeaturesSnapshot,
    postAgentDiscussionMessage: async request => {
      if ('operation' in request) throw new Error('Unexpected Session mutation');
      expect(request.sessionId).toBe('session');
      expect(request.discussionId).toBe(origin.discussion.discussionId);
      sessionAppends++;
      original = SessionMessageReplyProgressV1Schema.parse({ ...original, disposition: 'returned',
        outcome: { kind: 'answer', publicationRef: { kind: 'discussion', discussion: origin.discussion, messageId: 'answer' } } });
      return { v: 1, ok: true, value: { messageSeq: 2, message: { id: 'answer', discussionId: 'discussion', localId: request.request.localId,
        seq: 2, authorAccountId: accountId, accountActor: { v: 1, accountId, profile: null }, producerV1: null,
        content: request.request.content, mentionedAccountIds: [], replyTarget: request.request.replyTarget, createdAt: 2 } } };
    },
    serverId, serverIdentityId, serverHttpBaseUrl: serverUrl, postWorkflowDiscussionMessage: async (request, options) => {
      try {
      const replayArtifactId = options.context.approvedActionReplay?.artifactId;
      if (!replayArtifactId) throw new Error('Expected admitted approval replay');
      let verification: Parameters<typeof readApprovedWorkflowDiscussionPublication>[0] = { artifactId: replayArtifactId,
        request, content: options.content, credentials, machineId, serverId: mode === 'stable_replay_home' ? serverIdentityId : serverId, serverUrl,
        // The deciding ingress is present-user; replay context retains the
        // original automation authority, exactly as the daemon composition does.
        callerAuthority: 'present_user', isApprovalExecutionOriginCurrent: currentness,
        executeSourceAction: async (actionId, input, context) => restart ? (async () => {
          const result = await executor.execute(actionId, input, context);
          verificationFailure = result.ok
            ? WorkflowInvocationGetResultV1Schema.safeParse(result.result).success ? 'source_read_ok' : 'source_shape_invalid'
            : result.errorCode;
          return result;
        })() : actionId === 'workflow.run.invocations.get'
          ? { ok: true, result: await owner.execute({ actionId, input: WorkflowInvocationGetRequestV1Schema.parse(input), context }) }
          : { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' } } satisfies Parameters<typeof readApprovedWorkflowDiscussionPublication>[0];
      rejectedVariants.push(await verify({ ...verification,
        request: { ...request, request: { ...request.request, localId: 'forged-identity' } } }));
      rejectedVariants.push(await verify({ ...verification,
        request: { ...request, request: { ...request.request, replyTarget: { kind: 'message', messageId: 'another-question' } } } }));
      rejectedVariants.push(await verify({ ...verification,
        request: { ...request, request: { ...request.request, content: { t: 'plain', v: { v: 1, parts: [{ t: 'text', text: 'FORGED' }] } } } } }));
      if (denial) {
        const [branch] = denial;
        verification = { ...verification,
          ...(branch === 'caller' ? { callerAuthority: 'account_automation' as const } : {}),
          // Deliberately mis-bind real read Actions: no internal owner is mocked.
          ...(branch === 'source_read' ? { executeSourceAction: async (_actionId, _input, context) =>
            executor.execute('workflow.run.invocations.get', { runId: workflow.runId, invocationId: randomUUID() }, context) } : {}),
          ...(branch === 'source_shape' ? { executeSourceAction: async (_actionId, _input, context) =>
            executor.execute('approval.request.get', { artifactId }, context) } : {}),
          ...(branch === 'request_content' ? { content: { v: 1 as const, parts: [] } } : {}),
          request: { ...request,
            ...(branch === 'request_discussion' ? { discussionId: randomUUID() } : {}),
            request: { ...request.request,
              ...(branch === 'sealed_envelope' ? { content: { t: 'encrypted' as const, c: 'invalid-envelope' } } : {}),
              ...(branch === 'sealed_content' ? { content: { t: 'plain' as const, v: {} } } : {}),
              ...(branch === 'request_local_id' ? { localId: randomUUID() } : {}),
              ...(branch === 'request_target' ? { replyTarget: { kind: 'message' as const, messageId: randomUUID() } } : {}),
              ...(branch === 'request_mentions' ? { mentionedAccountIds: [accountId] } : {}),
            },
          },
        };
      }
      const currentToken = tokenCurrent;
      const sourceRow = storage.rowById(workflow.invocationRecordId)!;
      const retainedSourceRow = structuredClone(sourceRow);
      const sourceFault = denial && ['source_invocation', 'source_attempt', 'source_review',
        'source_delivery_missing', 'source_delivery_mismatch', 'source_result'].includes(denial[0]);
      if (sourceFault) {
        const originalIndex = sourceRow.index;
        const binding = { v: 1 as const, purpose: 'invocation_progress' as const, accountId, runId: workflow.runId,
          recordId: originalIndex.id, sequence: originalIndex.sequence, parentRecordId: originalIndex.parentRecordId,
          memberOrdinal: originalIndex.memberOrdinal, attempt: originalIndex.attempt };
        const opened = openWorkflowProgressStoredEnvelopeV1({ ...sealMode, binding,
          envelope: parseWorkflowStoredContentEnvelopeV1(sourceRow.contentEnvelope)! });
        if (opened.kind !== 'available') throw new Error('fixture_source_unavailable');
        const progress = WorkflowProgressEnvelopeV1Schema.parse(opened.content);
        const index = { ...originalIndex };
        if (denial[0] === 'source_invocation') { index.id = randomUUID(); progress.logicalInvocationRecordId = index.id; }
        if (denial[0] === 'source_attempt') {
          index.attempt = '1'; progress.attempt = '1';
          progress.previousAttemptRecordId = randomUUID();
          progress.logicalInvocationRecordId = progress.previousAttemptRecordId;
        }
        if (denial[0] === 'source_review') { index.lifecycle = 'needs_attention'; progress.review = {}; }
        if (denial[0] === 'source_delivery_missing') { delete progress.discussionReplyTo; sourceDeliveryMissing = true; }
        if (denial[0] === 'source_delivery_mismatch') progress.discussionReplyTo = { ...origin, throughSeq: origin.throughSeq + 1 };
        if (denial[0] === 'source_result') progress.result = 'different';
        sourceRow.index = index;
        sourceRow.contentEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ ...sealMode,
          binding: { ...binding, recordId: index.id, attempt: index.attempt }, progress }));
      }
      if (denial?.[0] === 'currentness') tokenCurrent = false;
      if (denial?.[0] === 'resource_status') discussionUnavailable = true;
      if (denial?.[0] === 'resource_readiness') discussionKeyReady = false;
      // Simulate a valid retained record at the opaque HTTP persistence boundary.
      // Immutable subject changes cannot be created through an approval transition;
      // use its real envelope/header producers and restore before settlement.
      const retainedArtifactRow = structuredClone(artifacts.get(artifactId)!);
      if (denial?.[0].startsWith('approval_')) {
        const [branch] = denial;
        const executing = ApprovalRequestV2Schema.parse(await runWithServerHttpBaseUrl(serverUrl,
          () => store.approvalsGet({ artifactId })));
        const approvedInput = typeof executing.actionArgs === 'object' && executing.actionArgs !== null ? executing.actionArgs : {};
        const expectedAccount = randomUUID();
        const modified = ApprovalRequestV2Schema.parse({ ...executing,
          ...(branch === 'approval_status' ? { status: 'approved' } : {}),
          ...(branch === 'approval_action' ? { actionId: 'machines.list' } : {}),
          ...(branch === 'approval_decision' ? { decision: { ...executing.decision, authority: undefined } } : {}),
          ...(branch === 'approval_input' ? { actionArgs: {} } : { actionArgs: approvedInput }),
          executionOriginV1: { ...executing.executionOriginV1,
            ...(branch === 'approval_action' ? { actionId: 'machines.list', discussionReplyReturn: undefined } : {}),
            ...(branch === 'approval_marker' ? { discussionReplyReturn: undefined } : {}),
            ...(branch === 'approval_session_marker' ? { caller: { kind: 'host' }, sessionId: 'session',
              discussionReplyReturn: { serverId: serverIdentityId, requestLocalId: randomUUID() } } : {}),
            ...(branch === 'approval_server' ? { serverId: 'other-profile' } : {}),
            ...(branch === 'approval_machine' ? { machineId: randomUUID() } : {}),
            ...(branch === 'approval_account' ? { accountId: expectedAccount,
              caller: { ...executing.executionOriginV1.caller, authenticatedStarterV1: { ...starter,
                requester: { serverId: serverIdentityId, accountId: expectedAccount } } } } : {}),
          },
        });
        const row = artifacts.get(artifactId)!;
        const retained = branch === 'approval_version' ? ApprovalRequestV1Schema.parse({ ...modified, v: 1, status: 'approved' }) : modified;
        row.header = encodePlainArtifactStoredContent(buildApprovalRequestArtifactHeaderV1(retained));
        row.body = encodePlainArtifactStoredContent({ body: JSON.stringify(branch === 'approval_invalid' ? {} : retained) });
      }
      try {
        const publish = createApprovedWorkflowDiscussionPublisher({
          credentials, machineId, serverId: mode === 'stable_replay_home' ? serverIdentityId : serverId, serverUrl,
          callerAuthority: daemonDenial?.[0] === 'caller' ? 'account_automation' : verification.callerAuthority,
          isApprovalExecutionOriginCurrent: daemonDenial?.[0] === 'currentness' ? undefined : verification.isApprovalExecutionOriginCurrent,
          resolveCurrentMachineExecutionOriginContext: createCurrentMachineExecutionOriginContextResolver({
            serverUrl,
            resolveCurrentMachineId: () => daemonDenial?.[0] === 'machine_context' ? null
              : daemonDenial?.[0] === 'machine' ? randomUUID() : machineId,
            resolveCurrentServerIdentityId: () => daemonDenial?.[0] === 'home' ? randomUUID() : serverIdentityId,
          }),
          executeSourceAction: verification.executeSourceAction,
          getClient: () => daemonDenial?.[0] === 'client' ? null : { postAgentDiscussionMessage: async publication => {
            if (!('producer' in publication)) throw new Error('workflow_publication_required');
            if (transportDenial) return { v: 1, ok: false, error: transportDenial };
            const accepted = publication;
            const machinePublication = DiscussionMachinePublicationV2Schema.safeParse({
              v: 1, operation: 'workflow_result', machineId, publication: accepted,
            });
            if (!machinePublication.success) {
              verificationFailure = JSON.stringify(machinePublication.error.issues.map(issue => ({ code: issue.code, path: issue.path })));
              return { v: 1, ok: false, error: 'discussion_post_denied' };
            }
            sent.push(accepted);
            return { v: 1, ok: true, value: { messageSeq: 2, message: { id: 'answer', discussionId: 'discussion', localId: accepted.request.localId,
              seq: 2, authorAccountId: accountId, accountActor: { v: 1, accountId, profile: null }, producerV1: accepted.producer,
              content: accepted.request.content, mentionedAccountIds: [], replyTarget: accepted.request.replyTarget, createdAt: 2 } } };
          } },
        });
        return await publish(verification.request, { ...options, content: verification.content, context: {
          ...options.context,
          ...(daemonDenial?.[0] === 'approval' ? { approvedActionReplay: undefined } : {}),
          ...(daemonDenial?.[0] === 'marker' ? { discussionReplyReturn: undefined } : {}),
          ...(daemonDenial?.[0] === 'marker_kind' ? { discussionReplyReturn: { serverId: serverIdentityId, requestLocalId: randomUUID() } } : {}),
        } });
      } finally {
        tokenCurrent = currentToken;
        discussionUnavailable = false;
        discussionKeyReady = true;
        sourceDeliveryMissing = false;
        if (sourceFault) Object.assign(sourceRow, retainedSourceRow);
        if (denial?.[0].startsWith('approval_')) artifacts.set(artifactId, retainedArtifactRow);
      }
      } catch (error) {
        verificationFailure = error && typeof error === 'object' ? {
          name: 'name' in error ? error.name : undefined,
          issues: 'issues' in error && Array.isArray(error.issues) ? error.issues.map(issue => ({ code: issue.code, path: issue.path })) : undefined,
        } : { type: typeof error };
        throw error;
      }
    } }, { isApprovalExecutionOriginCurrent: currentness,
      // The remote notification delivery adapter is the tail's effect boundary.
      notificationsNotifyMe: async () => { tailDeliveries++; return { attemptedChannels: 1, deliveredChannels: 1 }; },
      // Replace the Account change-feed transport only. Artifact CAS, the
      // execution observer's durable reads and approval replay remain real.
      approvalsWaitForDecision: async ({ signal, artifactId }) => {
        await new Promise<void>((resolve, reject) => {
          const release = () => { approvalChangeWaiters.delete(wake); signal?.removeEventListener('abort', abort); };
          const wake = () => { release(); resolve(); };
          const abort = () => { release(); reject(signal?.reason); };
          if (signal?.aborted) { reject(signal.reason); return; }
          approvalChangeWaiters.add(wake);
          signal?.addEventListener('abort', abort, { once: true });
          observedArtifacts.add(artifactId);
          if (observedArtifacts.size === 2) approvalsObserved();
          approvalObservationStarted();
        });
        const changed = ApprovalRequestV2Schema.parse(await runWithServerHttpBaseUrl(serverUrl, () => store.approvalsGet({ artifactId })));
        if (changed.status === 'rejected') return { decision: 'reject', request: changed };
        if (changed.status === 'canceled') return { decision: 'canceled', request: changed };
        return { decision: 'approve', request: changed };
      } });
  const coordinateSettlement = async (signal = coordinationController.signal) => {
    const coordinate = createProductionWorkflowRunCoordinator({ token, accountId, machineId, storage,
      resolveAccountEncryption: async () => accountEncryption,
      isAcceptedAuthorizationCurrent: acceptedCurrent,
      resolveControllerContext: async () => ({ surface: 'cli', authority: 'present_user', callerPermissionMode: 'default' }),
      prepareAcceptedWorkspaceTarget: async () => ({ ok: true, workspaceTarget: materialized.snapshot.workspaceTarget }),
      onCommittedTransition: () => {}, onReviewEntered: () => {},
      execution: { credentials, serverId, serverIdentityId,
        machineAdmissionTransport: async () => { throw new Error('completed_effect_must_not_repeat'); },
        resolveExistingSessionConversation: async () => { throw new Error('completed_effect_must_not_repeat'); },
        detachedRun: { actionExecutor: executor, buildActionContext: () => ({ surface: 'cli', authority: 'account_automation' }) },
        action: { executor, buildContext: async () => buildWorkflowActionContext({ ...materialized.snapshot, runId: workflow.runId }),
          observeApproval: async ({ artifactId, actionRequestId, actionId, authorization, signal }) => {
            if (!authorization) throw new Error('Expected the accepted Workflow authorization');
            const expectedOrigin = { actionId: actionId ?? 'discussion.invite', requestId: actionRequestId,
              accountId, serverIdentityId, machineId };
            const origin = ApprovalRequestV2Schema.parse(await store.approvalsGet({ artifactId })).executionOriginV1;
            expect({ actionId: origin.actionId, requestId: origin.requestId, accountId: origin.accountId,
              serverIdentityId: origin.serverIdentityId, machineId: origin.machineId }).toEqual(expectedOrigin);
            expect(await acceptedCurrent({ authorization, signal })).toBe(true);
            return await observeRecordedApprovalExecution({ artifactId, signal, expectedOrigin,
              isCurrent: () => acceptedCurrent({ authorization, signal }) });
          },
          observeRun: async () => { throw new Error('completed_effect_must_not_repeat'); } },
        postWorkflowMessage: async request => {
          if (!retainedSession || !('producer' in request) || request.producer.invocationRecordId === workflow.invocationRecordId) {
            throw new Error('approved_publication_must_not_repeat');
          }
          directTailAppends++;
          return { v: 1, ok: true, value: { messageSeq: 3, message: { id: 'tail-answer', discussionId: 'discussion', localId: request.request.localId,
            seq: 3, authorAccountId: accountId, accountActor: { v: 1, accountId, profile: null }, producerV1: request.producer,
            content: request.request.content, mentionedAccountIds: [], replyTarget: request.request.replyTarget, createdAt: 3 } } };
        } } });
    return await runWithServerHttpBaseUrl(serverUrl, () => coordinate({ runId: workflow.runId,
      attempt: 0, expectedRevision: storage.run().revision, accountCurrentness: witness, acceptedEnvelope,
      signal }));
  };
  if (provenanceRace) {
    const rootKey = workflowInvocationKey({ runId: workflow.runId, blockId: '$root', scope: [], attempt: 0 });
    await durable.commitFact({ key: rootKey, lifecycle: 'running' });
    const pending = mode === 'settlement_provenance_entry';
    if (!pending) {
      await durable.reconcilePublicationApprovalAttention(() => true);
      expect(await runWithServerHttpBaseUrl(serverUrl, () => store.approvalsUpdate({ artifactId, request: approved }))).toEqual({ ok: true });
      expect(await runWithServerHttpBaseUrl(serverUrl, () => executor.replayApprovedApprovalRequest({ artifactId,
        callerAuthority: 'present_user', currentAccount: { accountId, serverId, serverIdentityId } })))
        .toMatchObject({ ok: true, result: { status: 'executed' } });
    }
    holdRootControl = true;
    const attention = durable.reconcilePublicationApprovalAttention(() => pending);
    await rootControlRead;
    observeSourceFrontier = true;
    // Run the actual false-condition notification interpreter against the
    // same durable root queue while its exact publication Artifact is retained.
    const coordinator = createWorkflowCoordinator({ store: durable, rootInvocationRecordId: 'root',
      resolveWorkspace: async () => ({ ok: true, workspace: { machineId, directory, checkoutRootPath: directory } }),
      executeStep: async () => { throw new Error('completed_source_must_not_execute'); } });
    const coordination = coordinator.run({ ...materialized.snapshot, runId: workflow.runId, inputs: {} });
    await sourceFrontier;
    await new Promise<void>(resolve => setImmediate(resolve));
    releaseRootControl();
    await attention;
    expect(await coordination).toMatchObject({ state: 'succeeded' });
    expect(durable.read(rootKey)).toMatchObject({ lifecycle: pending ? 'needs_attention' : 'running',
      resultProvenance: { [workflow.invocationRecordId]: { notificationCondition: 'suppressed' } } });
    expect(durable.read(rootKey)?.reason).toBe(pending ? 'approval_required' : undefined);
    expect(storage.rows().some(row => WORKFLOW_ATTENTION_INVOCATION_LIFECYCLES_V1.some(lifecycle => lifecycle === row.index.lifecycle))).toBe(pending);
    expect(ApprovalRequestV2Schema.parse(await runWithServerHttpBaseUrl(serverUrl, () => store.approvalsGet({ artifactId }))).status)
      .toBe(pending ? 'open' : 'executed');
    expect(artifacts.size).toBe(1);
    expect(sent).toHaveLength(pending ? 0 : 1);
    expect(tailDeliveries).toBe(0);
    return;
  }
  let coordination = settlement ? coordinateSettlement() : undefined;
  if (restart && coordination) {
    await Promise.race([observingApproval, coordination]);
    expect(observedArtifacts.has(artifactId)).toBe(true);
    coordinationController.abort();
    await expect(coordination).rejects.toBeDefined();
    expect(approvalChangeWaiters.size).toBe(0);
    expect(sent).toHaveLength(0);
    resetActiveAccountSettingsSnapshotForTests();
    observedArtifacts.clear();
    observingApproval = new Promise<void>(resolve => { approvalObservationStarted = resolve; });
    const reclaimedController = new AbortController();
    onTestFinished(() => reclaimedController.abort());
    discussionUnavailable = mode === 'settlement_restart_transient';
    if (mode === 'settlement_restart_misbound') {
      // A real producer created this row; simulate a retained row whose
      // subject no longer matches the exact publication being reclaimed.
      const row = artifacts.get(artifactId)!;
      const request = ApprovalRequestV2Schema.parse(await runWithServerHttpBaseUrl(serverUrl,
        () => store.approvalsGet({ artifactId })));
      request.executionOriginV1.machineId = workflow.runId;
      row.body = encodePlainArtifactStoredContent({ body: JSON.stringify(request) });
    }
    if (decidedBeforeReclaim) {
      // The decision owner needs a current policy. Unlike the first claim's
      // Ask setting, the ordinary reloaded Account policy is the default.
      loadDefaultAccountSettings();
      if (mode === 'settlement_restart_paused') {
        await storage.execute({ operation: 'transition', runId: workflow.runId,
          expectedRevision: storage.run().revision, state: 'paused', checkpointEnvelope: storage.checkpointEnvelope()! });
      }
      // The ordinary decision executes while no coordinator is observing.
      const decided = await runWithServerHttpBaseUrl(serverUrl, () => executor.execute('approval.request.decide',
        { artifactId, decision: 'approve' }, { surface: 'cli', authority: 'present_user', serverId,
          expectedAccountId: accountId }));
      expect(decided).toMatchObject({ ok: true });
      const decidedRequest = ApprovalRequestV2Schema.parse(await runWithServerHttpBaseUrl(serverUrl,
        () => store.approvalsGet({ artifactId })));
      expect(decidedRequest.status, JSON.stringify({ status: decidedRequest.status,
        code: decidedRequest.execution?.errorCode })).toBe('executed');
      expect(sent).toHaveLength(1);
      expect(approvalChangeWaiters.size).toBe(0);
      expect(terminalSettlements).toBe(0);
      if (mode === 'settlement_restart_paused') {
        expect(storage.run()).toMatchObject({ state: 'paused', workflowCustodyState: 'pending' });
        // A paused Run is not lease-claimable. Only the normal Resume intent
        // permits the next coordinator used below.
        await owner.execute({ actionId: 'workflow.run.resume',
          input: { mode: 'boundary', runId: workflow.runId, expectedRevision: storage.run().revision },
          context: { surface: 'cli', authority: 'present_user', serverId } });
        expect(storage.run().state).toBe('running');
      }
    }
    coordination = coordinateSettlement(reclaimedController.signal);
    if (mode === 'settlement_restart_misbound') {
      expect(await coordination).toMatchObject({ state: 'interrupted' });
      expect(storage.run()).toMatchObject({ state: 'interrupted', workflowCustodyState: 'pending' });
      expect(observedArtifacts.size).toBe(0);
      expect(sent).toHaveLength(0);
      expect(resourceWrites).toBe(0);
      return;
    }
  }
  if (coordination && !decidedBeforeReclaim) {
    const boundary = await Promise.race([observingApproval, coordination]);
    expect(storage.run().workflowCustodyState, JSON.stringify({ state: storage.run().state,
      code: boundary && 'reason' in boundary ? boundary.reason : undefined })).toBe('pending');
    expect(storage.rowById('root')?.index.lifecycle).toBe('needs_attention');
    if (restart) {
      expect(observedArtifacts.has(artifactId)).toBe(true);
      discussionUnavailable = false;
      discussionDeleted = mode === 'settlement_restart_deleted';
    }
    if (retainedSession) expect(observedArtifacts.has(artifactId)).toBe(true);
    if (parallel) await Promise.race([observingAllApprovals, coordination]);
    if (parallelRefusal) {
      const decide = async (id: string, decision: 'approve' | 'reject') => {
        const decided = await runWithServerHttpBaseUrl(serverUrl, () => executor.execute('approval.request.decide',
          { artifactId: id, decision }, { surface: 'cli', authority: 'present_user', serverId, expectedAccountId: accountId }));
        expect(decided).toMatchObject({ ok: true });
        if (decision === 'approve') expect(decided).toMatchObject({ result: { status: 'executed' } });
      };
      if (mode === 'settlement_parallel_approve_first') {
        await decide(secondArtifactId!, 'approve');
        expect(sent).toHaveLength(1);
        expect(storage.run().workflowCustodyState).toBe('pending');
        await decide(artifactId, 'reject');
      } else {
        await decide(artifactId, 'reject');
        expect(sent).toHaveLength(0);
        expect(storage.run().workflowCustodyState).toBe('pending');
        expect(ApprovalRequestV2Schema.parse(await runWithServerHttpBaseUrl(serverUrl,
          () => store.approvalsGet({ artifactId: secondArtifactId! }))).status).toBe('open');
        await decide(secondArtifactId!, mode === 'settlement_parallel_reject_both' ? 'reject' : 'approve');
      }
      expect(await coordination).toMatchObject({ state: 'failed', reason: 'approval_rejected' });
      expect(storage.run()).toMatchObject({ state: 'failed', workflowCustodyState: 'settled' });
      expect(storage.rowById(workflow.invocationRecordId)?.index.lifecycle).toBe('completed');
      expect(storage.rowById(secondWorkflow.invocationRecordId)?.index.lifecycle).toBe('completed');
      expect(storage.rows().filter(row => row.index.id !== 'root' && row.index.id !== workflow.invocationRecordId
        && row.index.id !== secondWorkflow.invocationRecordId).map(row => row.index.lifecycle)).toEqual(
        mode === 'settlement_parallel_reject_both' ? ['failed', 'failed', 'failed'] : ['failed', 'failed', 'completed']);
      expect(terminalSettlements).toBe(1);
      expect(sent).toHaveLength(mode === 'settlement_parallel_reject_both' ? 0 : 1);
      if (mode !== 'settlement_parallel_reject_both') {
        expect(sent[0]?.producer).toEqual(secondProducer);
        await decide(secondArtifactId!, 'approve');
        expect(sent).toHaveLength(1);
      }
      expect(artifacts.size).toBe(2);
      expect(approvalChangeWaiters.size).toBe(0);
      expect(resourceWrites).toBe(0);
      return;
    }
    if (rejected || canceled) {
      if (retainedSession) {
        const decided = await runWithServerHttpBaseUrl(serverUrl, () => executor.execute('approval.request.decide',
          { artifactId, decision: rejected ? 'reject' : 'cancel' },
          { surface: 'cli', authority: 'present_user', serverId, expectedAccountId: accountId }));
        expect(decided, JSON.stringify({ ok: decided.ok, code: !decided.ok ? decided.errorCode : undefined,
          originalDecisionWrites, invalidOriginalMutations, originalMutationCodes })).toMatchObject({ ok: true });
      } else {
        const decidedAtMs = captured.updatedAtMs + 1;
        const refused = ApprovalRequestV2Schema.parse({ ...captured,
          status: rejected ? 'rejected' : 'canceled', updatedAtMs: decidedAtMs,
          ...(rejected ? { decision: { kind: 'reject', authority: 'present_user', decidedAtMs } } : {}) });
        expect(await runWithServerHttpBaseUrl(serverUrl, () => store.approvalsUpdate({ artifactId, request: refused }))).toEqual({ ok: true });
      }
      expect(await coordination).toMatchObject({ state: 'failed',
        reason: rejected ? 'approval_rejected' : 'approval_canceled' });
      expect(storage.run()).toMatchObject({ state: 'failed', workflowCustodyState: 'settled' });
      expect(storage.rowById(workflow.invocationRecordId)?.index.lifecycle).toBe('completed');
      expect(sent).toEqual([]);
      expect(sessionAppends).toBe(0);
      expect(directTailAppends).toBe(0);
      expect(tailDeliveries).toBe(0);
      if (retainedSession) {
        expect(originalDecisionWrites).toBe(1);
        expect(invalidOriginalMutations).toBe(0);
        expect(original).toMatchObject({ disposition: 'released', returnPublication: { kind: 'failed',
          failure: { code: rejected ? 'approval_rejected' : 'approval_canceled', phase: 'action_admission', retryable: false } } });
      }
      expect(await publisher(publication)).toMatchObject({ ok: false });
      expect(artifacts.size).toBe(1);
      expect(sent).toEqual([]);
      expect(resourceWrites).toBe(0);
      return;
    }
    expect(await runWithServerHttpBaseUrl(serverUrl, () => store.approvalsUpdate({ artifactId, request: approved }))).toEqual({ ok: true });
  }
  tokenCurrent = mode !== 'revoked';
  if (retainedSession || restart) loadDefaultAccountSettings();
  if (denial?.[0] === 'adapter_context') {
    // Retained, valid approval whose host return marker was lost before replay.
    // Exercise the actual Action context reconstruction, not the later publisher port.
    const retained = ApprovalRequestV2Schema.parse(await runWithServerHttpBaseUrl(serverUrl,
      () => store.approvalsGet({ artifactId })));
    const withoutReturn = ApprovalRequestV2Schema.parse({ ...retained,
      executionOriginV1: { ...retained.executionOriginV1, discussionReplyReturn: undefined } });
    const row = artifacts.get(artifactId)!;
    row.header = encodePlainArtifactStoredContent(buildApprovalRequestArtifactHeaderV1(withoutReturn));
    row.body = encodePlainArtifactStoredContent({ body: JSON.stringify(withoutReturn) });
  }
  const replay = () => runWithServerHttpBaseUrl(serverUrl, () => executor.replayApprovedApprovalRequest({ artifactId, callerAuthority: 'present_user',
    currentAccount: { accountId, serverId, serverIdentityId } }));
  const replayed = await replay();
  if (denial || daemonDenial || transportDenial) {
    const expectedCode = denial?.[1] ?? daemonDenial?.[1] ?? transportDenial!;
    expect(replayed, JSON.stringify(verificationFailure)).toMatchObject({ ok: true, result: { status: 'failed', execution: { errorCode: expectedCode } } });
    if (coordination) expect(await coordination).toMatchObject({ state: 'failed', reason: expectedCode });
    expect(sent).toHaveLength(0);
    expect(approvalChangeWaiters.size).toBe(0);
    return;
  }
  if (mode === 'settlement_restart_deleted') {
    expect(replayed).toMatchObject({ ok: true, result: { status: 'failed', execution: { errorCode: 'discussion_not_found' } } });
    expect(await coordination).toMatchObject({ state: 'failed', reason: 'discussion_not_found' });
    expect(storage.run()).toMatchObject({ state: 'failed', workflowCustodyState: 'settled' });
    expect(storage.rowById(workflow.invocationRecordId)?.index.lifecycle).toBe('completed');
    expect(terminalSettlements).toBe(1);
    expect(sent).toHaveLength(0);
    expect(artifacts.size).toBe(1);
    expect(approvalChangeWaiters.size).toBe(0);
    return;
  }
  if (retainedSession) {
    expect(replayed).toMatchObject({ ok: true, result: { status: 'executed' } });
    const coordinated = await coordination;
    expect(coordinated, JSON.stringify({ state: coordinated?.state,
      code: coordinated && 'reason' in coordinated ? coordinated.reason : undefined, homeReads })).toMatchObject({ state: 'succeeded' });
    expect(retainedOriginalReads).toBeGreaterThan(0);
    expect(sessionAppends).toBe(1);
    expect(directTailAppends).toBe(1);
    expect(tailDeliveries).toBe(1);
    const tail = storage.rows().filter(row => row.index.id !== 'root' && row.index.id !== workflow.invocationRecordId);
    expect(tail).toHaveLength(1);
    expect(tail[0]?.index.lifecycle).toBe('completed');
    expect(storage.run()).toMatchObject({ state: 'succeeded', workflowCustodyState: 'settled' });
    expect(await replay()).toMatchObject({ ok: true, result: { status: 'executed' } });
    expect(sessionAppends).toBe(1);
    expect(directTailAppends).toBe(1);
    expect(artifacts.size).toBe(1);
    expect(approvalChangeWaiters.size).toBe(0);
    expect(tailDeliveries).toBe(1);
    return;
  }
  if (parallel) {
    expect(replayed).toMatchObject({ ok: true, result: { status: 'executed' } });
    await Promise.race([new Promise<void>(resolve => {
      const changed = () => { if (storage.rowById('branch-a')?.index.lifecycle === 'completed') { void subscription.dispose(); resolve(); } };
      const subscription = storage.observeChanges(workflow.runId, changed, error => { throw error; });
      onTestFinished(() => subscription.dispose());
      changed();
    }), coordination]);
    expect(storage.rowById('root')?.index.lifecycle).toBe('needs_attention');
    expect(storage.rows().some(row => WORKFLOW_ATTENTION_INVOCATION_LIFECYCLES_V1.some(lifecycle => lifecycle === row.index.lifecycle))).toBe(true);
    expect(storage.run().workflowCustodyState).toBe('pending');
    expect(sent).toHaveLength(1);
    const second = ApprovalRequestV2Schema.parse(await runWithServerHttpBaseUrl(serverUrl, () => store.approvalsGet({ artifactId: secondArtifactId! })));
    expect(await runWithServerHttpBaseUrl(serverUrl, () => store.approvalsUpdate({ artifactId: secondArtifactId!, request: ApprovalRequestV2Schema.parse({ ...second,
      status: 'approved', updatedAtMs: second.updatedAtMs + 1,
      decision: { kind: 'approve', authority: 'present_user', decidedAtMs: second.updatedAtMs + 1 } }) }))).toEqual({ ok: true });
    const replaySecond = () => runWithServerHttpBaseUrl(serverUrl, () => executor.replayApprovedApprovalRequest({ artifactId: secondArtifactId!, callerAuthority: 'present_user',
      currentAccount: { accountId, serverId, serverIdentityId } }));
    expect(await replaySecond()).toMatchObject({ ok: true, result: { status: 'executed' } });
    expect(await coordination).toMatchObject({ state: 'succeeded' });
    expect(storage.run()).toMatchObject({ state: 'succeeded', workflowCustodyState: 'settled' });
    expect(await replaySecond()).toMatchObject({ ok: true, result: { status: 'executed' } });
    expect(await replay()).toMatchObject({ ok: true, result: { status: 'executed' } });
    expect(sent).toHaveLength(2);
    expect(new Set(sent.map(value => value.request.localId)).size).toBe(2);
    expect(artifacts.size).toBe(2);
    expect(approvalChangeWaiters.size).toBe(0);
    return;
  }
  if (mode === 'revoked') {
    expect(replayed).toMatchObject({ ok: false, errorCode: 'approval_stale' });
    const retained = await runWithServerHttpBaseUrl(serverUrl, () => store.approvalsGet({ artifactId }));
    expect(retained).toMatchObject({ status: 'approved' });
    expect(retained).not.toHaveProperty('execution');
    expect(sent).toEqual([]);
  } else if (mode === 'foreign_delivery' || mode === 'unknown_delivery') {
    expect(replayed).toMatchObject({ ok: true, result: { status: 'failed' } });
    expect(rejectedVariants).toHaveLength(3);
    expect(rejectedVariants.every(result => !result.ok)).toBe(true);
    expect(sent).toEqual([]);
  } else {
    expect(replayed, JSON.stringify({ replayed, verificationFailure: String(verificationFailure) }))
      .toMatchObject({ ok: true, result: { status: 'executed' } });
    expect(rejectedVariants).toHaveLength(3);
    expect(rejectedVariants.every(result => !result.ok)).toBe(true);
    if (mode === 'observation') {
      expect(storage.run().revision).toBeGreaterThan(observedRevision);
      expect(sent[0]?.expectedParentRevision).toBe(storage.run().revision);
    }
    expect(sent).toMatchObject([{ producer, request: { replyTarget: { kind: 'message', messageId: origin.messageId } } }]);
    expect(openSessionStoredContent({ ...resourceCrypto, content: sent[0]!.request.content })).toEqual(content);
    expect(await replay())
      .toMatchObject({ ok: true, result: { status: 'executed' } });
    expect(sent).toHaveLength(1);
    expect(await publisher(publication)).toMatchObject({ ok: false });
    expect(artifacts.size).toBe(1);
    if (mode === 'settlement' || restart) {
      const coordinated = await coordination;
      expect({ state: coordinated?.state, code: coordinated && 'reason' in coordinated ? coordinated.reason : undefined },
        JSON.stringify({ state: coordinated?.state, code: coordinated && 'reason' in coordinated ? coordinated.reason : undefined }))
        .toMatchObject({ state: 'succeeded' });
      expect(storage.run()).toMatchObject({ state: 'succeeded', workflowCustodyState: 'settled' });
      expect(storage.rowById('root')?.index.lifecycle).toBe('completed');
      if (restart) {
        const root = WorkflowInvocationGetResultV1Schema.parse(await owner.execute({ actionId: 'workflow.run.invocations.get',
          input: { runId: workflow.runId, invocationId: 'root' },
          context: { surface: 'cli', authority: 'account_automation', serverId } }));
        expect(root.invocation.progress.reason).toBeUndefined();
        expect(terminalSettlements).toBe(1);
      }
      expect(await replay()).toMatchObject({ ok: true, result: { status: 'executed' } });
      expect(storage.run()).toMatchObject({ state: 'succeeded', workflowCustodyState: 'settled' });
      expect(sent).toHaveLength(1);
      expect(artifacts.size).toBe(1);
    }
  }
  expect(resourceWrites).toBe(0);
}
