import { createHash, randomUUID } from 'node:crypto';

import type { ActionExecutorDeps, ApprovalRequest, ApprovalRequestV2 } from '@happier-dev/protocol';
import { resolveAccountScopedArtifactIdV1 } from '@happier-dev/protocol';
import { approvalArtifactBodyMatchesHeaderV1, buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { createApprovalRequestArtifact, assertApprovalRequestCreationBinding, ApprovalRequestConflict } from '@happier-dev/protocol/approvals/approvalRequestTransition';
import type { ApprovalRequesterConfirmationV1 } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { readPluginInstallApprovalPendingReview } from '@happier-dev/protocol/actions/actionApprovalPresentation';
import type { PluginChangePendingReviewResult } from '@happier-dev/protocol/marketplace/internal';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { DiscussionReplyInputV1Schema } from '@happier-dev/protocol/discussions/actions';
import type { DiscussionWorkflowPostPublicationV1 } from '@happier-dev/protocol/discussions/api';
import { deriveSessionMessageReplyReturnLocalIdV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageReplyV1';
import type { WorkflowAcceptedAuthorizationV1 } from '@happier-dev/protocol/workflows/workflowDefinitionV1';
import { deriveWorkflowDiscussionReplyLocalIdV1 } from '@happier-dev/protocol/workflows/workflowInvocationIdentityV1';

import type { AccountArtifact, createAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';

function readBuiltInApprovalArtifact(header: Record<string, unknown>, body: unknown): ApprovalRequest | null {
  if (typeof body !== 'string') return null;
  const parsed = approvalArtifactBodyMatchesHeaderV1(header, body);
  return parsed?.family === 'built_in' ? parsed.request : null;
}

function deriveApprovalArtifactId(namespace: string, identity: string): string {
  const bytes = createHash('sha256')
    .update(namespace, 'utf8')
    .update(identity, 'utf8')
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function derivePluginInstallApprovalSuccessorArtifactId(artifactId: string): string {
  return deriveApprovalArtifactId('happier-plugin-install-approval-successor-v1\0', artifactId);
}

type PluginInstallApprovalSubject = Readonly<{
  pendingReview: PluginChangePendingReviewResult;
  origin: Pick<ApprovalRequestV2['executionOriginV1'], 'accountId' | 'machineId' | 'serverIdentityId' | 'serverId'>;
}>;

/** Creation/rejoin and retirement must refer to the same Account/Home/Machine candidate. */
function matchesPluginInstallApprovalSubject(request: ApprovalRequest, expected: PluginInstallApprovalSubject): request is ApprovalRequestV2 {
  if (request.v !== 2 || request.actionId !== 'plugins.install') return false;
  const origin = request.executionOriginV1;
  return sameStrictJsonValue(readPluginInstallApprovalPendingReview(request.preview), expected.pendingReview)
    && origin.accountId === expected.origin.accountId
    && Boolean(origin.machineId) && origin.machineId === expected.origin.machineId
    && origin.serverIdentityId === expected.origin.serverIdentityId
    && (origin.serverIdentityId !== undefined || origin.serverId === expected.origin.serverId);
}

export type WorkflowDiscussionReplyApprovalSubject = Readonly<Pick<DiscussionWorkflowPostPublicationV1, 'producer' | 'origin'> & {
  serverIdentityId: string;
  accountId: string;
  machineId: string;
  authorization: WorkflowAcceptedAuthorizationV1;
}>;

function workflowDiscussionReplyApprovalIdentity(subject: Readonly<{
  serverIdentityId: string | undefined;
  accountId: string;
  machineId: string;
  producer: DiscussionWorkflowPostPublicationV1['producer'];
}>) {
  return [subject.serverIdentityId, subject.accountId, subject.machineId, 'workflow_invocation',
    subject.producer.runId, subject.producer.invocationRecordId, subject.producer.invocationAttempt];
}

function discussionReplyApprovalArtifactId(identity: readonly unknown[]) {
  return deriveApprovalArtifactId('happier-discussion-reply-approval-v1\0', JSON.stringify(identity));
}

function readDiscussionReplyApprovalSubject(request: ApprovalRequest) {
  if (request.v !== 2 || request.actionId !== 'discussion.reply' || !request.executionOriginV1.discussionReplyReturn) return null;
  const origin = request.executionOriginV1;
  const returned = origin.discussionReplyReturn!;
  const input = DiscussionReplyInputV1Schema.safeParse(request.actionArgs);
  if ('kind' in returned) {
    const localId = deriveWorkflowDiscussionReplyLocalIdV1(returned.producer);
    if (!origin.accountId || !origin.machineId || origin.caller.kind !== 'workflowRun' || origin.caller.runId !== returned.producer.runId || !input.success
      || input.data.localId !== localId || origin.requestId !== localId
      || input.data.discussionId !== returned.origin.discussion.discussionId
      || input.data.replyTarget.kind !== 'message' || input.data.replyTarget.messageId !== returned.origin.messageId) {
      throw Object.assign(new Error('approval_request_subject_mismatch'), { code: 'subject_mismatch' });
    }
    return { identity: workflowDiscussionReplyApprovalIdentity({ serverIdentityId: origin.serverIdentityId,
      accountId: origin.accountId, machineId: origin.machineId, producer: returned.producer }),
      discussionId: input.data.discussionId, replyTarget: input.data.replyTarget,
      producer: returned.producer, origin: returned.origin, workflowAuthorization: origin.caller.authorization,
      requesterConfirmation: request.requesterConfirmation };
  }
  if (!origin.accountId || !origin.machineId || !origin.sessionId
    || (origin.caller.kind !== 'host' && origin.caller.kind !== 'session' && origin.caller.kind !== 'workflowRun') || !input.success) {
    throw Object.assign(new Error('approval_request_subject_mismatch'), { code: 'subject_mismatch' });
  }
  const localId = deriveSessionMessageReplyReturnLocalIdV1({ sessionId: origin.sessionId,
    localId: returned.requestLocalId, ...(returned.acceptedTurnId ? { acceptedTurnId: returned.acceptedTurnId } : {}) });
  const addressing = origin.sessionInputSource?.discussionAddressing;
  if (input.data.localId !== localId || origin.requestId !== localId || input.data.replyTarget.kind !== 'message'
    || addressing && (addressing.discussionId !== input.data.discussionId
      || addressing.messageId !== input.data.replyTarget.messageId || addressing.participantSessionId !== origin.sessionId)) {
    throw Object.assign(new Error('approval_request_subject_mismatch'), { code: 'subject_mismatch' });
  }
  return {
    identity: [origin.serverIdentityId ?? origin.serverId, origin.accountId, origin.machineId, origin.sessionId,
      returned.requestLocalId, returned.acceptedTurnId ?? null],
    discussionId: input.data.discussionId,
    replyTarget: input.data.replyTarget,
    sessionInputSource: origin.sessionInputSource,
    ...(origin.caller.kind === 'workflowRun' ? { workflowAuthorization: origin.caller.authorization } : {}),
    requesterConfirmation: request.requesterConfirmation,
  };
}

export type CliApprovalCreation = Readonly<{
  approvalsCreate: NonNullable<ActionExecutorDeps['approvalsCreate']>;
  readPluginChangeApprovalRetirement(input: Readonly<{
    pendingReview: PluginChangePendingReviewResult; machineId: string; serverIdentityId: string;
  }>): Promise<boolean>;
  findWorkflowDiscussionReplyApproval(subject: WorkflowDiscussionReplyApprovalSubject,
    options?: Readonly<{ signal?: AbortSignal }>): Promise<Readonly<{ artifactId: string }> | null>;
}>;

/** CLI domain identities adapt private Artifact custody to the Protocol creation owner. */
export function createCliApprovalCreation(params: Readonly<{
  accountArtifactStore: Pick<ReturnType<typeof createAccountArtifactStore>, 'read' | 'create'>;
  prepareRequesterRecipient: (artifactId: string, subject: ApprovalRequesterConfirmationV1 | undefined) => Promise<void>;
  getAccountId: () => string | null;
}>): CliApprovalCreation {
  const { accountArtifactStore, prepareRequesterRecipient, getAccountId } = params;
  // Creation rejoins private owner consent. Exclude granted rows before key
  // opening; a foreign legacy preclaim cannot make lookup decrypt its bytes.
  const readOwnedArtifact = (artifactId: string, options?: Readonly<{ signal?: AbortSignal }>) =>
    accountArtifactStore.read(artifactId, { ...options, ownerOnly: true, prepareRecipients: false });

  async function readPluginInstallApprovalChain<T extends Readonly<{ followSuccessor: boolean }>>(input: Readonly<{
    accountId: string; sourceId: string; inspect: (artifact: AccountArtifact | null) => T;
  }>) {
    let sourceId = input.sourceId;
    let hasTerminalPredecessor = false;
    while (true) {
      const resolved = await resolveAccountScopedArtifactIdV1({ accountId: input.accountId, sourceId, read: readOwnedArtifact });
      const inspection = input.inspect(resolved.artifact);
      if (!inspection.followSuccessor) return { ...resolved, inspection, hasTerminalPredecessor };
      hasTerminalPredecessor = true;
      sourceId = derivePluginInstallApprovalSuccessorArtifactId(resolved.artifactId);
    }
  }

  return {
    readPluginChangeApprovalRetirement: async ({ pendingReview, machineId, serverIdentityId }) => {
      const accountId = getAccountId();
      if (!accountId) return false;
      const { artifact, hasTerminalPredecessor } = await readPluginInstallApprovalChain({
        accountId, sourceId: pendingReview.pendingChangeId,
        inspect: artifact => {
          const request = artifact?.access === 'owner' ? readBuiltInApprovalArtifact(artifact.header, artifact.body) : null;
          // Follow recorded terminal facts, not a fresh approval-policy or expiry
          // decision. A later open/approved successor is fresh owner consent.
          return { followSuccessor: Boolean(request && matchesPluginInstallApprovalSubject(request, { pendingReview,
            origin: { accountId, machineId, serverIdentityId, serverId: serverIdentityId } })
            && request.status !== 'open' && request.status !== 'approved' && request.status !== 'executing') };
        },
      });
      return !artifact && hasTerminalPredecessor;
    },
    findWorkflowDiscussionReplyApproval: async (expected, options) => {
      const identity = workflowDiscussionReplyApprovalIdentity(expected);
      const { artifactId, artifact } = await resolveAccountScopedArtifactIdV1({ accountId: expected.accountId,
        sourceId: discussionReplyApprovalArtifactId(identity),
        read: artifactId => readOwnedArtifact(artifactId, options),
      });
      if (!artifact) return null;
      const request = readBuiltInApprovalArtifact(artifact.header, artifact.body);
      const subject = request ? readDiscussionReplyApprovalSubject(request) : null;
      if (artifact.access !== 'owner' || !subject || !('producer' in subject)
        || !sameStrictJsonValue(subject.identity, identity)
        || !sameStrictJsonValue(subject.producer, expected.producer)
        || !sameStrictJsonValue(subject.origin, expected.origin)
        || !sameStrictJsonValue(subject.workflowAuthorization, expected.authorization)) {
        throw Object.assign(new Error('approval_request_subject_mismatch'), { code: 'subject_mismatch' });
      }
      return { artifactId };
    },
    approvalsCreate: async ({ request, serverId }) => {
      const origin = request.v === 2 ? request.executionOriginV1 : null;
      const root = origin?.externalActionExecutionAuthorization?.binding;
      // A foreign invocation cannot persist its Ask with the controller's
      // private Artifact custody. Its own Account owner must create that Ask.
      if (root && root.accountId !== root.custodianAccountId
        && (origin?.accountId !== root.accountId || getAccountId() !== root.accountId)) {
        throw Object.assign(new Error('credential_scope_denied'), { code: 'credential_scope_denied' });
      }
      const pendingReview = request.v === 2 && request.actionId === 'plugins.install'
        ? readPluginInstallApprovalPendingReview(request.preview) : null;
      const discussionReply = readDiscussionReplyApprovalSubject(request);
      if (!pendingReview && !discussionReply) {
        const res = await createApprovalRequestArtifact({ request, serverId,
          accountId: getAccountId(), newId: randomUUID,
          read: readOwnedArtifact,
          create: async (artifactId, header, body, idScope) => { await accountArtifactStore.create({ artifactId, header, body, idScope }); },
        });
        await prepareRequesterRecipient(res.artifactId, request.v === 2 ? request.requesterConfirmation : undefined);
        return res;
      }
      const sourceId = discussionReply
        ? discussionReplyApprovalArtifactId(discussionReply.identity)
        : pendingReview?.pendingChangeId ?? randomUUID();

      const header = buildApprovalRequestArtifactHeaderV1(request, { legacyServerId: serverId });

      if (discussionReply) {
        const resolved = await resolveAccountScopedArtifactIdV1({
          accountId: getAccountId() ?? origin?.accountId ?? '', sourceId,
          read: readOwnedArtifact,
        });
        const { artifactId, idScope } = resolved;
        const rejoin = async (artifact: AccountArtifact | null) => {
          if (!artifact) return null;
          const existing = readBuiltInApprovalArtifact(artifact.header, artifact.body);
          const subject = existing ? readDiscussionReplyApprovalSubject(existing) : null;
          if (artifact.access !== 'owner' || existing?.v !== 2 || !subject || !sameStrictJsonValue(subject, discussionReply)) {
            throw Object.assign(new Error('approval_request_subject_mismatch'), { code: 'subject_mismatch' });
          }
          if (existing?.v === 2 && request.v === 2
            && existing.executionOriginV1.requestId === request.executionOriginV1.requestId) {
            assertApprovalRequestCreationBinding(existing, request);
          }
          await prepareRequesterRecipient(artifactId, request.v === 2 ? request.requesterConfirmation : undefined);
          return { artifactId, request: existing };
        };
        // The original answer owns one private intent. A later final message
        // rejoins its captured draft in every lifecycle state, never replacing
        // text the person is reviewing or creating a successor after settlement.
        const existing = await rejoin(resolved.artifact);
        if (existing) return existing;
        try {
          await accountArtifactStore.create({ artifactId, idScope, header, body: JSON.stringify(request) });
          const stored = await rejoin(await readOwnedArtifact(artifactId));
          if (!stored) throw new ApprovalRequestConflict();
          return stored;
        } catch (error) {
          if (error && typeof error === 'object' && Reflect.get(error, 'code') === 'conflict') {
            const stored = await rejoin(await readOwnedArtifact(artifactId));
            if (stored) return stored;
          }
          throw error;
        }
      }

      const inspectPendingReviewArtifact = (artifact: AccountArtifact | null): Readonly<{ state: 'absent' }>
        | Readonly<{ state: 'rejoin' | 'terminal'; request: ApprovalRequestV2 }> => {
        if (!artifact) return { state: 'absent' };
        const existing = readBuiltInApprovalArtifact(artifact.header, artifact.body);
        if (artifact.access !== 'owner' || !existing || request.v !== 2 || !pendingReview
          || !matchesPluginInstallApprovalSubject(existing, { pendingReview, origin: request.executionOriginV1 })) {
          throw Object.assign(new Error('approval_request_subject_mismatch'), { code: 'subject_mismatch' });
        }
        const sameRequest = existing.executionOriginV1.requestId === request.executionOriginV1.requestId;
        if (sameRequest) assertApprovalRequestCreationBinding(existing, request);
        return { state: sameRequest || existing.status === 'open' || existing.status === 'approved' || existing.status === 'executing'
          ? 'rejoin' : 'terminal', request: existing };
      };
      // Each retained daemon subject owns a deterministic Artifact chain. A
      // terminal row remains immutable history; every observer follows the
      // same successor id and therefore rejoins the one active lifecycle.
      while (true) {
        const { artifactId, idScope, inspection: existingState } = await readPluginInstallApprovalChain({
          accountId: getAccountId() ?? origin?.accountId ?? '', sourceId,
          inspect: artifact => {
            const state = inspectPendingReviewArtifact(artifact);
            return { ...state, followSuccessor: state.state === 'terminal' };
          },
        });
        if (existingState.state === 'rejoin') {
          await prepareRequesterRecipient(artifactId, request.v === 2 ? request.requesterConfirmation : undefined);
          return { artifactId, request: existingState.request };
        }
        try {
          await accountArtifactStore.create({ artifactId, idScope, header, body: JSON.stringify(request) });
          const stored = inspectPendingReviewArtifact(await readOwnedArtifact(artifactId));
          if (stored.state === 'absent') throw new ApprovalRequestConflict();
          if (stored.state === 'terminal') {
            continue;
          }
          await prepareRequesterRecipient(artifactId, request.v === 2 ? request.requesterConfirmation : undefined);
          return { artifactId, request: stored.request };
        } catch (error) {
          if (error && typeof error === 'object' && Reflect.get(error, 'code') === 'conflict') {
            // An owner-only read can hide the conflicting row; retrying its
            // create after every 409 would loop forever without a readable winner.
            if (!await readOwnedArtifact(artifactId)) {
              throw Object.assign(new Error('approval_request_subject_mismatch'), { code: 'subject_mismatch' });
            }
            continue;
          }
          throw error;
        }
      }
    },
  };
}
