import { createServer } from 'node:http';
import { expect, it, onTestFinished } from 'vitest';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { DiscussionAgentPostRequestV1Schema } from '@happier-dev/protocol/discussions/api';
import { DiscussionReplyInputV1Schema } from '@happier-dev/protocol/discussions/actions';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { readApprovedDiscussionPublication } from './approvedDiscussionPublication';

it('admits an authenticated Workflow starter for an approved Session Discussion return at its verified Home', async () => {
  const accountId = 'account';
  const serverId = 'local-profile';
  const serverIdentityId = 'srv_discussion_home';
  const sessionId = 'session';
  const artifactId = 'approval';
  const runId = 'workflow-run';
  const actionArgs = DiscussionReplyInputV1Schema.parse({ discussionId: 'discussion', localId: 'answer',
    content: { v: 1, parts: [{ t: 'text', text: 'Workflow answer' }] }, replyTarget: { kind: 'message', messageId: 'question' } });
  const replyReturn = { serverId: serverIdentityId, requestLocalId: 'original-input', acceptedTurnId: 'original-turn',
    workflow: { runId, invocationRecordId: 'leaf', invocationAttempt: '0' } };
  const approval = ApprovalRequestV2Schema.parse({ v: 2, status: 'executing', createdAtMs: 1, updatedAtMs: 2,
    createdBy: { surface: 'agent' }, actionId: 'discussion.reply', actionArgs, summary: 'Post the Workflow answer',
    decision: { kind: 'approve', authority: 'present_user', decidedAtMs: 2 }, discussionDraftReview: true,
    executionOriginV1: { v: 1, authority: 'account_automation', surface: 'agent', serverId, serverIdentityId,
      accountId, sessionId, machineId: 'machine', actionId: 'discussion.reply', requestId: 'request', discussionReplyReturn: replyReturn,
      caller: { kind: 'workflowRun', runId, authorization: { principal: { kind: 'host' }, admittedPermissionCeiling: 'default' },
        authenticatedStarterV1: { requestRef: runId, requester: { accountId, serverId: serverIdentityId } } } } });
  const request = DiscussionAgentPostRequestV1Schema.parse({ v: 1, sessionId, discussionId: actionArgs.discussionId, replyReturn,
    request: { localId: actionArgs.localId, content: { t: 'plain', v: actionArgs.content }, mentionedAccountIds: [],
      replyTarget: actionArgs.replyTarget } });
  const contacts: string[] = [];
  const home = createServer((req, res) => {
    const path = req.url?.split('?')[0] ?? '';
    contacts.push(path);
    res.setHeader('content-type', 'application/json');
    res.setHeader('connection', 'close');
    const reply = (value: unknown, status = 200) => { res.statusCode = status; res.end(JSON.stringify(value)); };
    if (path === '/v1/account/encryption') return reply({ mode: 'plain', updatedAt: 1 });
    if (path === '/v1/features') return reply({ features: {}, capabilities: { serverIdentity: { serverIdentityId } } });
    if (path === `/v1/artifacts/${artifactId}`) return reply({ id: artifactId, ownerAccountId: accountId, access: 'owner',
      encryptionMode: 'plain', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 2,
      header: encodePlainArtifactStoredContent(buildApprovalRequestArtifactHeaderV1(approval)),
      body: encodePlainArtifactStoredContent({ body: JSON.stringify(approval) }) });
    if (path === '/v1/discussions/discussion') return reply({ discussion: { id: 'discussion', ownerAccountId: accountId,
      encryptionMode: 'plain', anchor: null, access: 'owner', keyReadiness: true, dataEncryptionKey: null,
      creationLocalId: 'create', titleContent: { t: 'plain', v: { v: 1, title: 'Question' } },
      latestMessage: { id: 'question', localId: 'question', seq: 1, authorAccountId: accountId,
        accountActor: { v: 1, accountId, profile: null }, producerV1: null, createdAt: 1 },
      messageSeq: 1, lastReadSeq: 0, unreadCount: 1, unreadMentionCount: 0, recentAuthorAccountIds: [], archivedAt: null,
      capabilities: { postMessages: true, rename: true, archive: true, restore: false, askAgent: true, sendToSession: true, manageAccess: true, leave: false } } });
    return reply({ error: 'not_found' }, 404);
  });
  await new Promise<void>(resolve => home.listen(0, '127.0.0.1', resolve));
  onTestFinished(() => new Promise<void>((resolve, reject) => home.close(error => error ? reject(error) : resolve())));
  const address = home.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture Home address');
  const token = `fixture.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.fixture`;
  const verify = (callerAuthority: 'present_user' | 'account_automation') => readApprovedDiscussionPublication({ artifactId,
    request, credentials: { token, encryption: null }, sessionId, serverId, serverUrl: `http://127.0.0.1:${address.port}`,
    callerAuthority, isApprovalExecutionOriginCurrent: async ({ origin }) => origin.serverIdentityId === serverIdentityId });
  const admitted = await verify('present_user');
  expect(contacts).toContain('/v1/discussions/discussion');
  expect(admitted).toMatchObject({ serverIdentityId, draftReview: { artifactId, decidingAccountId: accountId }, terminalReturn: true });
  expect(await verify('account_automation')).toBeNull();
});
