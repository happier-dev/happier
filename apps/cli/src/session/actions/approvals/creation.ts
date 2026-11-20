import { createHash, randomUUID } from 'node:crypto';

import type { ActionExecutorDeps, ApprovalRequest, ApprovalRequestV2 } from '@happier-dev/protocol';
import { createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';
import { resolveAccountScopedArtifactIdV1 } from '@happier-dev/protocol/artifacts/idScope';
import { approvalArtifactBodyMatchesHeaderV1, buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { createApprovalRequestArtifact, assertApprovalRequestCreationBinding, ApprovalRequestConflict } from '@happier-dev/protocol/approvals/approvalRequestTransition';
import type { ApprovalRequesterConfirmationV1 } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { isApprovalRequestV2InFlightStatus } from '@happier-dev/protocol/approvals/approvalRequestStatus';
import { readPluginInstallApprovalPendingReview } from '@happier-dev/protocol/actions/actionApprovalPresentation';
import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';
import type { PluginChangePendingReviewResult } from '@happier-dev/protocol/marketplace/internal';
import { projectNativeJsonValueForTransport, sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
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

type PluginInstallReview = Extract<PluginChangePendingReviewResult, { reviewKind: 'installation' }>;
type PluginInstallIntent = Omit<PluginInstallReview, 'pendingChangeId'>;
type PluginInstallMachine = Readonly<{ machineId: string; serverIdentityId: string }>;

function developmentApprovalIdentity(
  pending: PluginInstallIntent,
  origin: PluginInstallApprovalSubject['origin'],
  observationFreshness: 'stale' | 'current' = 'stale',
): string | null {
  const { review, reason, currentVersion, authorityExpansion } = pending;
  if (review.updateChannel.kind !== 'path' || !review.updateChannel.development || !origin.machineId || !origin.serverIdentityId) return null;
  const observation = review.daemonRights?.observation;
  if (observationFreshness === 'current' && !observation) return null;
  // Retained approvals disclose a snapshot. Neither sample time nor transport
  // freshness changes the rights that were observed.
  const rights = observation ? {
    freshness: observationFreshness,
    observation: { ...observation, observedAt: undefined },
  } : review.daemonRights;
  return createCanonicalJsonSigningInput(projectNativeJsonValueForTransport([
    'happier:development-install-approval:v1', origin.serverIdentityId, origin.machineId,
    reason, currentVersion, authorityExpansion, { ...review, daemonRights: rights },
  ]));
}

type PluginInstallApprovalSubjectMismatch = Readonly<{
  field: 'pendingReview' | `origin.${keyof PluginInstallApprovalSubject['origin']}` | 'artifact.access' | 'artifact.family';
  existing: 'present' | 'absent';
  expected: 'present' | 'absent';
}>;

function pluginInstallSubjectMismatch(
  field: PluginInstallApprovalSubjectMismatch['field'], existing: unknown, expected: unknown,
): PluginInstallApprovalSubjectMismatch {
  return { field, existing: existing === undefined || existing === null ? 'absent' : 'present',
    expected: expected === undefined || expected === null ? 'absent' : 'present' };
}

function pluginInstallSubjectMismatchError(mismatches: readonly PluginInstallApprovalSubjectMismatch[]) {
  return createActionExecuteFailureError({
    ok: false, errorCode: 'subject_mismatch', error: 'approval_request_subject_mismatch', details: { mismatches },
  });
}

/** Creation/rejoin and retirement use one comparison of the Account/Home candidate.
 * Host-origin installs may have no Machine; a present Machine must match exactly.
 * Diagnostics contain only fixed field names and presence, never subject values.
 */
function matchPluginInstallApprovalSubject(request: ApprovalRequest, expected: PluginInstallApprovalSubject, developmentIdentity: string | null):
  | Readonly<{ matched: true; request: ApprovalRequestV2 }>
  | Readonly<{ matched: false; mismatches: readonly PluginInstallApprovalSubjectMismatch[] }> {
  if (request.v !== 2 || request.actionId !== 'plugins.install') return { matched: false,
    mismatches: [pluginInstallSubjectMismatch('artifact.family', request, expected)] };
  const origin = request.executionOriginV1;
  const pendingReview = readPluginInstallApprovalPendingReview(request.preview);
  const mismatches: PluginInstallApprovalSubjectMismatch[] = [];
  const sameReview = developmentIdentity && pendingReview
    ? developmentApprovalIdentity(pendingReview, origin) === developmentIdentity
    : sameStrictJsonValue(pendingReview, expected.pendingReview);
  if (!sameReview) {
    mismatches.push(pluginInstallSubjectMismatch('pendingReview', pendingReview, expected.pendingReview));
  }
  for (const field of ['accountId', 'machineId', 'serverIdentityId'] as const) {
    if (origin[field] !== expected.origin[field]) {
      mismatches.push(pluginInstallSubjectMismatch(`origin.${field}`, origin[field], expected.origin[field]));
    }
  }
  if (origin.serverIdentityId === undefined && origin.serverId !== expected.origin.serverId) {
    mismatches.push(pluginInstallSubjectMismatch('origin.serverId', origin.serverId, expected.origin.serverId));
  }
  return mismatches.length > 0 ? { matched: false, mismatches } : { matched: true, request };
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
      throw createActionExecuteFailureError({ ok: false, errorCode: 'subject_mismatch', error: 'approval_request_subject_mismatch' });
    }
    return { identity: workflowDiscussionReplyApprovalIdentity({ serverIdentityId: origin.serverIdentityId,
      accountId: origin.accountId, machineId: origin.machineId, producer: returned.producer }),
      discussionId: input.data.discussionId, replyTarget: input.data.replyTarget,
      producer: returned.producer, origin: returned.origin, workflowAuthorization: origin.caller.authorization,
      requesterConfirmation: request.requesterConfirmation };
  }
  if (!origin.accountId || !origin.machineId || !origin.sessionId
    || (origin.caller.kind !== 'host' && origin.caller.kind !== 'session' && origin.caller.kind !== 'workflowRun') || !input.success) {
    throw createActionExecuteFailureError({ ok: false, errorCode: 'subject_mismatch', error: 'approval_request_subject_mismatch' });
  }
  const localId = deriveSessionMessageReplyReturnLocalIdV1({ sessionId: origin.sessionId,
    localId: returned.requestLocalId, ...(returned.acceptedTurnId ? { acceptedTurnId: returned.acceptedTurnId } : {}) });
  const addressing = origin.sessionInputSource?.discussionAddressing;
  if (input.data.localId !== localId || origin.requestId !== localId || input.data.replyTarget.kind !== 'message'
    || addressing && (addressing.discussionId !== input.data.discussionId
      || addressing.messageId !== input.data.replyTarget.messageId || addressing.participantSessionId !== origin.sessionId)) {
    throw createActionExecuteFailureError({ ok: false, errorCode: 'subject_mismatch', error: 'approval_request_subject_mismatch' });
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
  findOpenPluginDevelopmentApproval(input: PluginInstallMachine & Readonly<{ review: PluginInstallIntent }>): Promise<string | null>;
  readPluginChangeApprovalRetirement(input: Readonly<{
    pendingReview: PluginChangePendingReviewResult; machineId: string; serverIdentityId: string;
  }>): Promise<boolean>;
  findWorkflowDiscussionReplyApproval(subject: WorkflowDiscussionReplyApprovalSubject,
    options?: Readonly<{ signal?: AbortSignal }>): Promise<Readonly<{ artifactId: string }> | null>;
}>;

/** CLI domain identities adapt private Artifact custody to the Protocol creation owner. */
export function createCliApprovalCreation(params: Readonly<{
  accountArtifactStore: Pick<ReturnType<typeof createAccountArtifactStore>, 'read' | 'create' | 'resolvePrivateSourceId'>;
  prepareRequesterRecipient: (artifactId: string, subject: ApprovalRequesterConfirmationV1 | undefined) => Promise<void>;
  getAccountId: () => string | null;
}>): CliApprovalCreation {
  const { accountArtifactStore, prepareRequesterRecipient, getAccountId } = params;
  // Creation rejoins private owner consent. Exclude granted rows before key
  // opening; a foreign legacy preclaim cannot make lookup decrypt its bytes.
  const readOwnedArtifact = (artifactId: string, options?: Readonly<{ signal?: AbortSignal }>) =>
    accountArtifactStore.read(artifactId, { ...options, ownerOnly: true, prepareRecipients: false });

  async function readPluginInstallApprovalChain<T extends Readonly<{ followSuccessor: boolean; retired?: boolean }>>(input: Readonly<{
    accountId: string; sourceId: string; inspect: (artifact: AccountArtifact | null) => T;
  }>) {
    let sourceId = input.sourceId;
    let hasTerminalPredecessor = false;
    while (true) {
      const resolved = await resolveAccountScopedArtifactIdV1({ accountId: input.accountId, sourceId, read: readOwnedArtifact });
      const inspection = input.inspect(resolved.artifact);
      if (!inspection.followSuccessor) return { ...resolved, inspection, hasTerminalPredecessor };
      hasTerminalPredecessor ||= inspection.retired === true;
      sourceId = derivePluginInstallApprovalSuccessorArtifactId(resolved.artifactId);
    }
  }

  async function resolvePluginInstallApprovalChain<T extends Readonly<{ followSuccessor: boolean; retired?: boolean }>>(input: Readonly<{
    accountId: string;
    sourceId: string;
    readLegacyIdentity?: () => string | null;
    inspect: (artifact: AccountArtifact | null) => T;
    hasCandidate: (result: { inspection: T; hasTerminalPredecessor: boolean }) => boolean;
  }>) {
    const canonical = await readPluginInstallApprovalChain(input);
    if (!input.readLegacyIdentity || input.hasCandidate(canonical)) return canonical;
    // Existing 0.3 reviews may already live under the current-observation key.
    const legacyIdentity = input.readLegacyIdentity();
    if (!legacyIdentity) return canonical;
    const legacy = await readPluginInstallApprovalChain({
      ...input, sourceId: await accountArtifactStore.resolvePrivateSourceId(legacyIdentity),
    });
    return input.hasCandidate(legacy) ? legacy : canonical;
  }

  return {
    findOpenPluginDevelopmentApproval: async ({ review, machineId, serverIdentityId }) => {
      const accountId = getAccountId();
      if (!accountId) return null;
      const origin = { accountId, machineId, serverIdentityId, serverId: serverIdentityId };
      const identity = developmentApprovalIdentity(review, origin);
      if (!identity) return null;
      const { inspection } = await resolvePluginInstallApprovalChain({
        accountId, sourceId: await accountArtifactStore.resolvePrivateSourceId(identity),
        readLegacyIdentity: () => developmentApprovalIdentity(review, origin, 'current'),
        hasCandidate: result => result.inspection.pendingChangeId !== null,
        inspect: artifact => {
          if (!artifact || artifact.access !== 'owner') return { followSuccessor: false, pendingChangeId: null };
          const request = readBuiltInApprovalArtifact(artifact.header, artifact.body);
          const pending = request ? readPluginInstallApprovalPendingReview(request.preview) : null;
          if (!request || !pending || !matchPluginInstallApprovalSubject(request, { pendingReview: pending, origin }, identity).matched) {
            return { followSuccessor: false, pendingChangeId: null };
          }
          return request.status === 'open'
            ? { followSuccessor: false, pendingChangeId: pending.pendingChangeId }
            : { followSuccessor: true, pendingChangeId: null };
        },
      });
      return inspection.pendingChangeId;
    },
    readPluginChangeApprovalRetirement: async ({ pendingReview, machineId, serverIdentityId }) => {
      const accountId = getAccountId();
      if (!accountId) return false;
      const origin = { accountId, machineId, serverIdentityId, serverId: serverIdentityId };
      const identity = pendingReview.reviewKind === 'installation' ? developmentApprovalIdentity(pendingReview, origin) : null;
      const { artifact, hasTerminalPredecessor } = await resolvePluginInstallApprovalChain({
        accountId, sourceId: identity ? await accountArtifactStore.resolvePrivateSourceId(identity) : pendingReview.pendingChangeId,
        ...(pendingReview.reviewKind === 'installation' && identity ? {
          readLegacyIdentity: () => developmentApprovalIdentity(pendingReview, origin, 'current'),
        } : {}),
        hasCandidate: result => result.inspection.sameCandidate || result.hasTerminalPredecessor,
        inspect: artifact => {
          const request = artifact?.access === 'owner' ? readBuiltInApprovalArtifact(artifact.header, artifact.body) : null;
          if (!request || !matchPluginInstallApprovalSubject(request, { pendingReview, origin }, identity).matched) {
            return { followSuccessor: false, sameCandidate: false };
          }
          const retained = readPluginInstallApprovalPendingReview(request.preview);
          const sameCandidate = retained?.pendingChangeId === pendingReview.pendingChangeId;
          const retired = !isApprovalRequestV2InFlightStatus(request.status);
          return { followSuccessor: retired || (!sameCandidate && request.status !== 'open'), retired: retired && sameCandidate, sameCandidate };
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
        throw createActionExecuteFailureError({ ok: false, errorCode: 'subject_mismatch', error: 'approval_request_subject_mismatch' });
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
        throw createActionExecuteFailureError({ ok: false, errorCode: 'credential_scope_denied', error: 'credential_scope_denied' });
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
      const developmentIdentity = pendingReview && origin ? developmentApprovalIdentity(pendingReview, origin) : null;
      let readLegacyIdentity = developmentIdentity && pendingReview && origin
        ? () => developmentApprovalIdentity(pendingReview, origin, 'current') : undefined;
      const sourceId = discussionReply
        ? discussionReplyApprovalArtifactId(discussionReply.identity)
        : developmentIdentity ? await accountArtifactStore.resolvePrivateSourceId(developmentIdentity)
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
          if (artifact.access !== 'owner' || existing?.v !== 2 || existing.actionId !== 'discussion.reply'
            || !subject || !sameStrictJsonValue(subject, discussionReply)) {
            throw createActionExecuteFailureError({ ok: false, errorCode: 'subject_mismatch', error: 'approval_request_subject_mismatch' });
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
          const created = await accountArtifactStore.create({ artifactId, idScope, header, body: JSON.stringify(request),
            includeAcknowledgedContent: true });
          const stored = await rejoin(created.acknowledged ?? null);
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
        const parsed = readBuiltInApprovalArtifact(artifact.header, artifact.body);
        const subject = parsed && request.v === 2 && pendingReview
          ? matchPluginInstallApprovalSubject(parsed, { pendingReview, origin: request.executionOriginV1 }, developmentIdentity)
          : { matched: false as const, mismatches: [pluginInstallSubjectMismatch('artifact.family', parsed, request)] };
        if (artifact.access !== 'owner' || !subject.matched) {
          throw pluginInstallSubjectMismatchError([
            ...(artifact.access !== 'owner' ? [pluginInstallSubjectMismatch('artifact.access', artifact.access, 'owner')] : []),
            ...(subject.matched ? [] : subject.mismatches),
          ]);
        }
        const existing = subject.request;
        const sameCandidate = readPluginInstallApprovalPendingReview(existing.preview)?.pendingChangeId === pendingReview?.pendingChangeId;
        if (!sameCandidate && existing.status === 'open') {
          throw pluginInstallSubjectMismatchError([pluginInstallSubjectMismatch('pendingReview', existing.preview, request.preview)]);
        }
        // A matched subject implies a v2 request; the check keeps that narrowing explicit inside this closure.
        const sameRequest = request.v === 2 && existing.executionOriginV1.requestId === request.executionOriginV1.requestId;
        if (sameRequest && request.v === 2) assertApprovalRequestCreationBinding(existing, request);
        return { state: sameCandidate && (sameRequest || isApprovalRequestV2InFlightStatus(existing.status))
          ? 'rejoin' : 'terminal', request: existing };
      };
      // Each retained daemon subject owns a deterministic Artifact chain. A
      // terminal row remains immutable history; every observer follows the
      // same successor id and therefore rejoins the one active lifecycle.
      while (true) {
        const { artifactId, idScope, inspection: existingState } = await resolvePluginInstallApprovalChain({
          accountId: getAccountId() ?? origin?.accountId ?? '', sourceId,
          ...(readLegacyIdentity ? { readLegacyIdentity } : {}),
          hasCandidate: result => result.inspection.state === 'rejoin',
          inspect: artifact => {
            const state = inspectPendingReviewArtifact(artifact);
            return { ...state, followSuccessor: state.state === 'terminal' };
          },
        });
        readLegacyIdentity = undefined;
        if (existingState.state === 'rejoin') {
          await prepareRequesterRecipient(artifactId, request.v === 2 ? request.requesterConfirmation : undefined);
          return { artifactId, request: existingState.request };
        }
        try {
          const created = await accountArtifactStore.create({ artifactId, idScope, header, body: JSON.stringify(request),
            includeAcknowledgedContent: true });
          const stored = inspectPendingReviewArtifact(created.acknowledged ?? null);
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
              throw pluginInstallSubjectMismatchError([pluginInstallSubjectMismatch('artifact.access', undefined, 'owner')]);
            }
            continue;
          }
          throw error;
        }
      }
    },
  };
}
