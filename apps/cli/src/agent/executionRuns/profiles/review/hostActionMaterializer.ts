import { createHash } from 'node:crypto';

import { evaluatePluginFinalPolicy } from '@happier-dev/protocol/plugins/actions/policy';
import { ReviewCommentProposalsV1Schema } from '@happier-dev/protocol/reviews/comments/proposals';
import { stringifyReviewCommentPrincipalCanonicalJsonV1 } from '@happier-dev/protocol/reviews/comments/actions';
import type { ActionExecuteFailure, ActionExecuteResult, ActionExecutorContext, PluginSourceCustodyV1, ReviewCommentCreateRequestV1, ReviewCommentProposalV1, ReviewCommentSnapshotV1 } from '@happier-dev/protocol';
import { normalizeActionExecutorThrownError } from '@happier-dev/protocol/actions/executor/resultProjection';
import { redactTranscriptSecrets } from '@/api/session/client/transport/transcriptSecretRedaction';

import {
  resolvePluginFinalPolicyAuthorizationFacts,
  type PluginFinalPolicyCurrentRuntime,
} from '@/plugins/runtime/policy/facts';
import { createReviewCommentSnapshotResolver } from '../../../reviews/comments/snapshots';

export type ReviewCommentHostActionCandidate = Readonly<{
  actionId: 'reviews.comments.create';
  sessionId: string;
  runId: string;
  callId: string;
  profileId: string;
  pluginId: string;
  agentId: string;
  proposals: readonly ReviewCommentProposalV1[];
}>;

type ReviewCommentHostWorkspace = Readonly<{
  projectId: string;
  workspaceId: string;
  serverId: string;
}>;

export type ReviewCommentHostPluginAuthority = Readonly<{
  sourceCustody: PluginSourceCustodyV1;
}>;

export function resolveReviewCommentHostPluginAuthority(params: Readonly<{
  pluginId: string;
  current: PluginFinalPolicyCurrentRuntime | null;
  sourceCustody: PluginSourceCustodyV1 | null;
}>): ReviewCommentHostPluginAuthority | null {
  const authorizationFacts = resolvePluginFinalPolicyAuthorizationFacts({
    pluginId: params.pluginId,
    current: params.current,
  });
  const decision = evaluatePluginFinalPolicy({
    ...authorizationFacts,
    serviceAvailability: Object.freeze([]),
    currentIntent: 'currentIntentRequired',
  });
  if (decision.outcome !== 'visible' || !params.current || !params.sourceCustody) return null;
  return Object.freeze({
    sourceCustody: params.sourceCustody,
  });
}

type ReviewCommentHostActionBase = ReviewCommentHostActionCandidate & ReviewCommentHostWorkspace & ReviewCommentHostPluginAuthority;

type ReviewCommentHostActionEffect = Readonly<{
  proposalFingerprint: string;
  effectBodySha256Base64Url: string;
}>;

type ReviewCommentHostActionSubject = ReviewCommentHostActionBase & Readonly<{
  effects: readonly ReviewCommentHostActionEffect[];
  subjectFingerprint: string;
}>;

type CurrentIntentResult =
  | Readonly<{ status: 'approved'; fingerprint: string }>
  | Readonly<{ status: 'rejected' | 'unavailable'; code: string }>;

export type ReviewCommentHostActionMaterializationResult =
  | Readonly<{ ok: false; errorCode: string; error: string }>
  | Readonly<{
    ok: true;
    result: Readonly<{
      status: 'created' | 'partial' | 'failed';
      comments: readonly Readonly<{ findingId?: string; commentId: string; replayed: boolean }>[];
      failures?: readonly Readonly<{ findingId?: string; errorCode: string } & Partial<Omit<ActionExecuteFailure, 'ok'>>>[];
    }>;
  }>;

function fingerprint(value: unknown, domain: string): string {
  return createHash('sha256')
    .update(`${domain}\0${stringifyReviewCommentPrincipalCanonicalJsonV1(value)}`)
    .digest('hex');
}

function buildBase(
  candidate: ReviewCommentHostActionCandidate,
  workspace: ReviewCommentHostWorkspace,
  authority: ReviewCommentHostPluginAuthority,
): ReviewCommentHostActionBase | null {
  const proposals = ReviewCommentProposalsV1Schema.safeParse(candidate.proposals);
  if (!proposals.success || proposals.data.length === 0) return null;
  return Object.freeze({
    ...candidate,
    ...workspace,
    ...authority,
    proposals: proposals.data,
  });
}

function readCreatedCommentResult(value: unknown): Readonly<{ commentId: string; replayed: boolean }> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Readonly<Record<string, unknown>>;
  if (!record.comment || typeof record.comment !== 'object' || Array.isArray(record.comment)) return null;
  const commentId = (record.comment as Readonly<Record<string, unknown>>).id;
  if (typeof commentId !== 'string' || commentId.trim().length === 0 || commentId.trim().length > 512) return null;
  if (typeof record.replayed !== 'undefined' && typeof record.replayed !== 'boolean') return null;
  return { commentId: commentId.trim(), replayed: record.replayed === true };
}

function snapshotFileSha(snapshot: ReviewCommentSnapshotV1): string | undefined {
  if (snapshot.kind === 'text') return snapshot.contextWindowHash;
  if (snapshot.kind === 'binary') return snapshot.sha256;
  if (snapshot.kind === 'too_large') return snapshot.sha256;
  return undefined;
}

function proposalLineRange(proposal: ReviewCommentProposalV1): Readonly<{ startLine: number; endLine: number }> | undefined {
  if (proposal.anchor.kind === 'line') {
    return { startLine: proposal.anchor.line, endLine: proposal.anchor.line };
  }
  if (proposal.anchor.kind === 'range') {
    return { startLine: proposal.anchor.startLine, endLine: proposal.anchor.endLine };
  }
  return undefined;
}

function buildCreateRequest(params: Readonly<{
  subject: ReviewCommentHostActionBase;
  proposal: ReviewCommentProposalV1;
  proposalIndex: number;
  snapshot: ReviewCommentSnapshotV1;
}>): ReviewCommentCreateRequestV1 {
  const mutationIdentity = {
    actionId: params.subject.actionId,
    sessionId: params.subject.sessionId,
    runId: params.subject.runId,
    callId: params.subject.callId,
    profileId: params.subject.profileId,
    pluginId: params.subject.pluginId,
    projectId: params.subject.projectId,
    workspaceId: params.subject.workspaceId,
    proposalIndex: params.proposalIndex,
    proposal: params.proposal,
  };
  const clientMutationId = `review-run:${fingerprint(mutationIdentity, 'happier.reviewComment.materialization.v1')}`;
  const lineRange = proposalLineRange(params.proposal);
  const fileSha = snapshotFileSha(params.snapshot);
  return {
    projectId: params.subject.projectId,
    workspaceId: params.subject.workspaceId,
    sessionId: params.subject.sessionId,
    runId: params.subject.runId,
    engineId: params.subject.pluginId,
    ...(params.proposal.findingId ? { findingId: params.proposal.findingId } : {}),
    anchor: params.proposal.anchor,
    snapshot: params.snapshot,
    body: params.proposal.body,
    ...(params.proposal.extensions === undefined ? {} : { extensions: params.proposal.extensions }),
    authorIntent: 'propose',
    fingerprint: {
      ...(params.proposal.findingId ? { ruleId: params.proposal.findingId } : {}),
      ...(fileSha ? { fileSha } : {}),
      ...(lineRange ? { lineRange } : {}),
      normalizedMessageHash: fingerprint(params.proposal.body.trim(), 'happier.reviewComment.body.v1'),
      engineId: params.subject.pluginId,
    },
    linkedRefs: [
      { kind: 'executionRun', id: params.subject.runId },
      { kind: 'session', id: params.subject.sessionId },
    ],
    clientMutationId,
    ...(
      params.proposal.severity || params.proposal.taxonomyIds?.length || params.proposal.tags?.length
        ? {
          metadata: {
            ...(params.proposal.severity ? { severity: params.proposal.severity } : {}),
            ...(params.proposal.taxonomyIds?.length ? { taxonomyIds: params.proposal.taxonomyIds } : {}),
            ...(params.proposal.tags?.length ? { tags: params.proposal.tags } : {}),
          },
        }
        : {}
    ),
  };
}

function effectBodySha256Base64Url(input: ReviewCommentCreateRequestV1): string {
  return createHash('sha256')
    .update(stringifyReviewCommentPrincipalCanonicalJsonV1(input))
    .digest('base64url');
}

async function prepareSubject(params: Readonly<{
  cwd: string;
  base: ReviewCommentHostActionBase;
}>): Promise<Readonly<{
  subject: ReviewCommentHostActionSubject;
  prepared: readonly Readonly<{
    proposal: ReviewCommentProposalV1;
    request: ReviewCommentCreateRequestV1;
    effect: ReviewCommentHostActionEffect;
  }>[];
}> | null> {
  const resolveSnapshot = createReviewCommentSnapshotResolver();
  const snapshots = await Promise.all(params.base.proposals.map(proposal => resolveSnapshot({ cwd: params.cwd, anchor: proposal.anchor })));
  const prepared = params.base.proposals.flatMap((proposal, proposalIndex) => {
    const snapshot = snapshots[proposalIndex];
    if (!snapshot) return [];
    const request = buildCreateRequest({ subject: params.base, proposal, proposalIndex, snapshot });
    return [{
      proposal,
      request,
      effect: Object.freeze({
        proposalFingerprint: fingerprint(proposal, 'happier.reviewComment.proposal.v1'),
        effectBodySha256Base64Url: effectBodySha256Base64Url(request),
      }),
    }];
  });
  if (prepared.length !== params.base.proposals.length) return null;
  const effects = Object.freeze(prepared.map((item) => item.effect));
  const subjectWithoutFingerprint = { ...params.base, effects };
  return Object.freeze({
    subject: Object.freeze({
      ...subjectWithoutFingerprint,
      subjectFingerprint: fingerprint(subjectWithoutFingerprint, 'happier.executionRunHostAction.subject.v1'),
    }),
    prepared: Object.freeze(prepared),
  });
}

export function createReviewCommentHostActionMaterializer(deps: Readonly<{
  cwd: string;
  readCurrentCandidate: () => ReviewCommentHostActionCandidate | null;
  isRunActive: () => boolean;
  readCurrentPluginAuthority: (pluginId: string) => Promise<ReviewCommentHostPluginAuthority | null>;
  resolveWorkspace: () => Promise<ReviewCommentHostWorkspace | null>;
  requestCurrentIntent: (subject: ReviewCommentHostActionSubject) => Promise<CurrentIntentResult>;
  executeHostAction: (
    actionId: 'reviews.comments.create',
    input: ReviewCommentCreateRequestV1,
    context: ActionExecutorContext,
  ) => Promise<ActionExecuteResult>;
}>): () => Promise<ReviewCommentHostActionMaterializationResult> {
  const readBase = async (): Promise<ReviewCommentHostActionBase | null> => {
    const candidate = deps.readCurrentCandidate();
    if (!candidate) return null;
    const [workspace, authority] = await Promise.all([
      deps.resolveWorkspace(),
      deps.readCurrentPluginAuthority(candidate.pluginId),
    ]);
    return workspace && authority ? buildBase(candidate, workspace, authority) : null;
  };

  return async () => {
    const initialBase = await readBase();
    if (!initialBase) {
      return { ok: false, errorCode: 'execution_run_host_action_context_unavailable', error: 'Review host-action context is unavailable' };
    }
    const initialPrepared = await prepareSubject({ cwd: deps.cwd, base: initialBase });
    if (!initialPrepared) {
      return { ok: false, errorCode: 'review_comment_snapshot_unavailable', error: 'A current review-comment snapshot is unavailable' };
    }
    const initial = initialPrepared.subject;

    const intent = await deps.requestCurrentIntent(initial);
    if (intent.status !== 'approved') {
      return { ok: false, errorCode: intent.code, error: intent.code };
    }
    if (intent.fingerprint !== initial.subjectFingerprint) {
      return { ok: false, errorCode: 'execution_run_host_action_current_intent_mismatch', error: 'Approved subject fingerprint does not match' };
    }

    const approved = initial;
    const prepared = initialPrepared.prepared;

    const comments: Array<Readonly<{ findingId?: string; commentId: string; replayed: boolean }>> = [];
    const failures: Array<Readonly<{ findingId?: string; errorCode: string } & Partial<Omit<ActionExecuteFailure, 'ok'>>>> = [];
    for (const [itemIndex, item] of prepared.entries()) {
      if (!deps.isRunActive()) {
        for (const remaining of prepared.slice(itemIndex)) {
          failures.push({
            ...(remaining.proposal.findingId ? { findingId: remaining.proposal.findingId } : {}),
            errorCode: 'execution_run_host_action_stale',
          });
        }
        break;
      }
      const context: ActionExecutorContext = {
        surface: 'rpc',
        defaultSessionId: approved.sessionId,
        serverId: approved.serverId,
        bypassApprovals: true,
        reviewCommentPrincipal: {
          actor: { kind: 'agent', agentId: approved.agentId, sessionId: approved.sessionId },
          currentIntent: {
            v: 1,
            kind: 'execution_run_host_action',
            actionId: approved.actionId,
            subjectFingerprint: approved.subjectFingerprint,
            effectBodySha256Base64Url: item.effect.effectBodySha256Base64Url,
            sessionId: approved.sessionId,
            runId: approved.runId,
            callId: approved.callId,
            profileId: approved.profileId,
            pluginId: approved.pluginId,
            agentId: approved.agentId,
            projectId: approved.projectId,
            workspaceId: approved.workspaceId,
            sourceCustody: approved.sourceCustody,
          },
        },
      };
      let result: ActionExecuteResult;
      try {
        result = await deps.executeHostAction('reviews.comments.create', item.request, context);
      } catch (error) {
        const failure = normalizeActionExecutorThrownError(error, 'review.comments.create');
        failures.push({
          ...(item.proposal.findingId ? { findingId: item.proposal.findingId } : {}),
          ...failure,
          error: redactTranscriptSecrets(failure.error),
        });
        continue;
      }
      if (!result.ok) {
        const { ok: _ok, ...failure } = result;
        failures.push({
          ...(item.proposal.findingId ? { findingId: item.proposal.findingId } : {}),
          ...failure,
          error: redactTranscriptSecrets(failure.error),
        });
        continue;
      }
      const parsed = readCreatedCommentResult(result.result);
      if (!parsed) {
        failures.push({
          ...(item.proposal.findingId ? { findingId: item.proposal.findingId } : {}),
          errorCode: 'review_comment_invalid_response',
        });
        continue;
      }
      comments.push({
        ...(item.proposal.findingId ? { findingId: item.proposal.findingId } : {}),
        commentId: parsed.commentId,
        replayed: parsed.replayed,
      });
    }

    return {
      ok: true,
      result: {
        status: failures.length === 0 ? 'created' : comments.length === 0 ? 'failed' : 'partial',
        comments: Object.freeze(comments),
        ...(failures.length > 0 ? { failures: Object.freeze(failures) } : {}),
      },
    };
  };
}
